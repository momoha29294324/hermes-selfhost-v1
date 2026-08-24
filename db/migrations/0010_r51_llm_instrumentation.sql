-- 0010_r51_llm_instrumentation.sql — R5.1 : mesurer avant d'optimiser.
--
-- ---------------------------------------------------------------------------
-- Ce que R5 ne permettait pas de voir, et pourquoi ça a coûté cher
-- ---------------------------------------------------------------------------
-- `model_runs` porte une ligne par *appel logique* : une tâche, un prospect, un
-- verdict. C'était le bon grain pour R1–R5, et c'est le mauvais grain pour la
-- question de R5.1.
--
-- La preuve tient en une requête sur le corpus R5 :
--
--     select status, count(*) from model_runs;      -- ok 219, timeout 2
--     select count(*) from model_runs
--      where task = 'research' and duration_ms > 180000;   -- 15
--
-- Deux `timeout` déclarés, quinze runs dont la durée dépasse le timeout d'un
-- seul appel. L'écart n'est pas une contradiction : le routeur réessaie, et un
-- run « réussi au second essai après un premier expiré » s'enregistre `ok`. Le
-- premier essai — 180 secondes payées pour rien — n'existe nulle part.
--
-- Autrement dit, R5 a rapporté 2 timeouts là où le pipeline en a subi ~16, et
-- toute décision prise sur ce chiffre aurait porté sur le mauvais problème.
-- Une ligne par essai est donc la condition d'honnêteté du benchmark, pas un
-- raffinement d'observabilité.
--
-- ---------------------------------------------------------------------------
-- Les tokens : arrêter de deviner
-- ---------------------------------------------------------------------------
-- `tokens_input` / `tokens_output` sont restés `null` sur les 221 lignes de R5.
-- La cause est dans le provider : il lisait le pied de page humain de
-- `codex exec` (« tokens used \n 6 630 »), qui est un total agrégé et non une
-- ventilation — et que le mode non interactif n'imprime pas toujours.
--
-- `codex exec --json` publie, lui, un événement `turn.completed` avec la
-- ventilation réelle : input, input mis en cache, écriture de cache, output,
-- output de raisonnement. C'est cette source que R5.1 enregistre, parce qu'un
-- benchmark de coût qui estime ses tokens ne mesure rien.
--
-- Ce que cette migration N'AJOUTE PAS : une colonne « crédits ». Le CLI Codex
-- authentifié par abonnement n'expose aucun coût par appel, et inventer un
-- tarif pour remplir une colonne serait exactement la donnée fabriquée que le
-- §2 des règles du dépôt interdit. Le coût est rapporté en tokens observés.

-- ---------------------------------------------------------------------------
-- 1. Une ligne par essai
-- ---------------------------------------------------------------------------
create table llm_attempts (
  id                    uuid primary key default gen_random_uuid(),
  -- Le run logique auquel cet essai appartient. Nullable : l'essai est écrit
  -- même quand le run échoue avant d'avoir sa ligne `model_runs`.
  model_run_id          uuid references model_runs(id) on delete set null,
  task                  text not null,
  provider              text not null,
  model                 text not null,
  effort                text,
  input_ref             text,
  input_hash            text not null,
  attempt               integer not null check (attempt >= 1),
  -- `timeout` est distinct de `error` : c'est la seule catégorie dont R5.1
  -- doit faire baisser le compte, et l'agréger aux autres échecs la cacherait.
  status                text not null
                          check (status in ('ok', 'timeout', 'invalid_output',
                                            'provider_error', 'unavailable')),
  -- La limite réellement appliquée à CET essai, pas celle de la config au
  -- moment de la lecture : une stratégie de repli change le timeout entre deux
  -- essais, et comparer un essai à un plafond qu'il n'a pas subi n'a pas de sens.
  timeout_ms            integer not null,
  duration_ms           integer not null,
  -- Le schéma a-t-il été respecté ? `null` quand aucun schéma n'était demandé.
  schema_valid          boolean,
  prompt_chars          integer,
  tokens_input          integer,
  tokens_cached_input   integer,
  tokens_cache_write    integer,
  tokens_output         integer,
  tokens_reasoning      integer,
  error_kind            text,
  error                 text,
  started_at            timestamptz not null,
  finished_at           timestamptz not null,
  created_at            timestamptz not null default now()
);

create index llm_attempts_run_idx on llm_attempts (model_run_id);
create index llm_attempts_task_idx on llm_attempts (task, model, effort, created_at desc);
create index llm_attempts_status_idx on llm_attempts (status) where status <> 'ok';

-- ---------------------------------------------------------------------------
-- 2. Ce que le run logique doit désormais résumer
-- ---------------------------------------------------------------------------
-- `attempts` et `timeouts` sont dénormalisés à dessein : la question « combien
-- de runs ont payé au moins un timeout » est celle qu'on pose en permanence, et
-- elle ne doit pas dépendre d'une jointure qu'on peut oublier d'écrire.
alter table model_runs add column tokens_cached_input integer;
alter table model_runs add column tokens_cache_write  integer;
alter table model_runs add column tokens_reasoning    integer;
alter table model_runs add column attempts            integer not null default 0;
alter table model_runs add column timeouts            integer not null default 0;

-- ---------------------------------------------------------------------------
-- 3. Le corpus gelé
-- ---------------------------------------------------------------------------
-- Un benchmark n'est reproductible que si l'entrée l'est. `bench_corpora` ne
-- stocke pas le corpus (il vit dans un fichier versionnable sous var/) mais son
-- empreinte, sa composition et la date du gel — de sorte qu'un résultat ne
-- puisse jamais être rattaché à un corpus qui aurait bougé entre-temps.
create table bench_corpora (
  hash            text primary key,           -- sha256 du fichier gelé
  label           text not null,
  campaign_slug   text not null,
  prospect_count  integer not null,
  -- {send: n, edit: n, reject: n} — la répartition au moment du gel.
  composition     jsonb not null default '{}'::jsonb,
  source_path     text not null,
  frozen_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. Les résultats, et la clé qui permet de reprendre
-- ---------------------------------------------------------------------------
-- La contrainte d'unicité EST le mécanisme de reprise (§19). Elle porte sur
-- tout ce qui peut changer le résultat :
--
--   corpus_hash      l'entrée gelée
--   variant_key      modèle + effort + architecture + politique de timeout
--   prospect_ref     l'unité de travail
--   task             l'étape
--   input_hash       le prompt réellement envoyé (donc la version du prompt,
--                    la partition du contexte, et l'amont dont il dépend)
--
-- Deux exécutions qui partagent ces cinq valeurs ne peuvent pas produire des
-- résultats différents pour une raison qui nous intéresse — donc réutiliser la
-- première est légitime. Changer n'importe laquelle invalide la ligne, et le
-- travail est refait. C'est la seule façon d'avoir un cache qui ne ment pas.
create table bench_results (
  id              uuid primary key default gen_random_uuid(),
  bench_run_id    uuid,                       -- le run qui a produit la ligne
  corpus_hash     text not null,
  phase           text not null,              -- a | b | arch | concurrency | timeout
  variant_key     text not null,
  prospect_ref    text not null,
  task            text not null,
  provider        text not null,
  model           text not null,
  effort          text,
  prompt_version  text not null,
  input_hash      text not null,
  architecture    text not null default 'monolithic'
                    check (architecture in ('monolithic', 'workers')),
  status          text not null check (status in ('ok', 'error', 'timeout', 'skipped')),
  latency_ms      integer not null,
  attempts        integer not null default 0,
  timeouts        integer not null default 0,
  schema_valid    boolean,
  tokens_input          integer,
  tokens_cached_input   integer,
  tokens_output         integer,
  tokens_reasoning      integer,
  output          jsonb,
  error           text,
  created_at      timestamptz not null default now(),
  unique (corpus_hash, variant_key, prospect_ref, task, input_hash)
);

create index bench_results_run_idx on bench_results (bench_run_id);
create index bench_results_variant_idx on bench_results (corpus_hash, phase, variant_key);

-- ---------------------------------------------------------------------------
-- 5. Les vérifications déterministes de qualité
-- ---------------------------------------------------------------------------
-- Le §9 de la mission interdit de faire reposer le verdict qualité sur un seul
-- juge LLM. Les invariants vérifiables par le code — provenance citée, aucune
-- affirmation d'absence, aucun chiffre non autorisé — sont donc calculés ici,
-- par variante et par prospect, et gardés à côté des notes qualitatives pour
-- qu'un désaccord entre les deux soit visible plutôt que moyenné.
create table bench_quality (
  id                    uuid primary key default gen_random_uuid(),
  bench_result_id       uuid not null references bench_results(id) on delete cascade,
  -- Déterministe
  claims_total          integer not null default 0,
  claims_grounded       integer not null default 0,
  provenance_violations integer not null default 0,
  absence_violations    integer not null default 0,
  forbidden_numbers     integer not null default 0,
  unknowns_count        integer not null default 0,
  -- Qualitatif, renseigné après l'évaluation aveugle (§9). Nullable tant
  -- qu'elle n'a pas eu lieu : une note absente doit se lire comme absente.
  commercial_score      numeric(4, 2),
  specificity_score     numeric(4, 2),
  judge_notes           text,
  created_at            timestamptz not null default now(),
  unique (bench_result_id)
);

-- ---------------------------------------------------------------------------
-- 6. Le run de benchmark lui-même
-- ---------------------------------------------------------------------------
create table bench_runs (
  id            uuid primary key default gen_random_uuid(),
  phase         text not null,
  label         text not null,
  corpus_hash   text not null,
  config        jsonb not null default '{}'::jsonb,
  concurrency   integer not null default 1,
  status        text not null default 'running'
                  check (status in ('running', 'succeeded', 'failed', 'cancelled')),
  -- Le mur : ce que l'utilisateur attend réellement, distinct de la somme des
  -- latences dès que la concurrence dépasse 1.
  wall_clock_ms integer,
  reused        integer not null default 0,   -- lignes réutilisées par la reprise
  executed      integer not null default 0,   -- appels réellement émis
  notes         jsonb not null default '[]'::jsonb,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create index bench_runs_phase_idx on bench_runs (phase, started_at desc);
