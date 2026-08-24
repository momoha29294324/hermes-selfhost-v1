-- 0030_icp_eligibility.sql — ICP-R1, le gate d'éligibilité commerciale
-- (mission « ICP ELIGIBILITY R1 »).
--
-- Ce que cette migration corrige, et ce qu'elle n'invente pas
-- -----------------------------------------------------------
-- Le 2026-08-10, `DEMO PROSPECT A` a été découvert, classé `in_niche` à 0,99, scoré
-- 74/A, sélectionné pour le premier batch R6B et verrouillé en manifeste
-- Instagram. Son site portait, le même jour et dans la même collecte, un titre
-- de section « Devenez franchisé DetailCar » et deux pages parlant de « la
-- franchise DetailCar ». Les trois preuves sont en base depuis le premier
-- crawl, avec leur URL source et leur horodatage : rien n'a manqué à la
-- collecte.
--
-- Ce qui manquait était une QUESTION. Le pipeline savait demander quel métier,
-- quel canal, quelle identité, quel message — jamais quel TYPE d'entreprise.
-- Cette table est l'endroit où cette question reçoit une réponse datée,
-- sourcée, et contestable.
--
-- Elle ne modifie aucune donnée existante : aucun `alter table`, aucun
-- `update`, aucun `delete`. Les 286 prospects, leurs preuves, leurs scores et
-- leurs manifestes sont exactement dans l'état où ils étaient — la mission
-- demande explicitement de ne pas muter l'historique en silence, et un verdict
-- d'éligibilité est une observation NOUVELLE, pas une correction rétroactive
-- des anciennes.

-- ---------------------------------------------------------------------------
-- prospect_icp_assessments — le journal des verdicts, append-only
-- ---------------------------------------------------------------------------
--
-- Une ligne = un verdict rendu à un instant, par un profil donné, sur les
-- preuves disponibles à ce moment-là. Jamais mise à jour, jamais supprimée.
--
-- Pourquoi un JOURNAL plutôt qu'une colonne `prospects.icp_verdict` :
--
--   * un verdict dépend du vocabulaire du profil, qui évoluera. Une colonne
--     écraserait l'ancien verdict et rendrait impossible de répondre à « qu'est-ce
--     que nous savions le jour où nous avons verrouillé ce manifeste ? » —
--     exactement la question que ce post-mortem a dû poser ;
--   * un humain qui lève un `REVIEW_REQUIRED` doit laisser une trace À CÔTÉ du
--     verdict automatique, pas à sa place. Deux lignes, deux auteurs, deux
--     dates : la décision humaine est visible comme telle ;
--   * `prospect_evidence` fonctionne déjà ainsi, et pour la même raison.
--
-- Le verdict courant se lit donc par « la ligne la plus récente », jamais par
-- un champ mutable — voir `loadLatestIcpAssessments`.
create table prospect_icp_assessments (
  id                  uuid primary key default gen_random_uuid(),

  prospect_id         uuid not null references prospects(id) on delete cascade,

  -- Les trois verdicts du gate. `REVIEW_REQUIRED` est le verdict de
  -- l'incertitude honnête : il couvre aussi bien « un signal fort isolé » que
  -- « nous n'avons rien lu », et `reason` dit lequel des deux.
  verdict             text not null check (verdict in ('GOOD_ICP', 'REVIEW_REQUIRED', 'NOT_TARGET')),

  -- La phrase que lit un opérateur, et tous les motifs retenus derrière.
  reason              text not null check (length(btrim(reason)) between 1 and 1000),
  reasons             jsonb not null default '[]'::jsonb,

  -- Chaque signal avec sa provenance : [{groupKey, severity, kind, matched,
  -- excerpt, field, evidenceId, provider, sourceUrl}]. C'est ce qui rend un
  -- refus contestable point par point plutôt qu'à prendre ou à laisser.
  signals             jsonb not null default '[]'::jsonb,

  -- Les identifiants `prospect_evidence` cités. Redondant avec `signals`, et
  -- volontairement : c'est la colonne qu'on interroge pour remonter d'une
  -- preuve à tous les verdicts qui s'en sont servis.
  evidence_ids        jsonb not null default '[]'::jsonb,

  -- `none` = aucun contenu d'entreprise n'a été lu. La distinction est le cœur
  -- de la règle « absence de preuve ≠ franchise » : un prospect jamais crawlé
  -- ne peut pas être déclaré éligible, et ne peut pas non plus être rejeté.
  coverage            text not null check (coverage in ('none', 'read')),

  -- Nombre de SOURCES distinctes portant un signal fort. Deux occurrences
  -- d'une même page ne valent pas deux preuves ; cette colonne dit ce qui a
  -- réellement corroboré.
  strong_source_count int not null default 0 check (strong_source_count >= 0),

  -- Quel vocabulaire a rendu ce verdict. Sans la version, un verdict archivé
  -- serait ininterprétable après la première évolution du profil.
  profile_key         text not null check (length(btrim(profile_key)) between 1 and 120),
  profile_version     int not null check (profile_version >= 1),

  -- `deterministic` : le code a tranché. `human` : quelqu'un a relu et décidé,
  -- et son nom est dans `assessed_by`. Aucun LLM n'est autorisé à rendre ce
  -- verdict — la règle est du code testé (CLAUDE.md), pas un prompt.
  decided_by          text not null check (decided_by in ('deterministic', 'human')),
  assessed_by         text not null check (length(btrim(assessed_by)) between 1 and 200),

  created_at          timestamptz not null default now(),

  -- Un rejet nomme ce qu'il a vu. Sans cette contrainte, « NOT_TARGET » pourrait
  -- s'écrire sans un seul signal — c'est-à-dire une affirmation sans preuve,
  -- exactement ce que l'interdit n°2 de CLAUDE.md refuse.
  constraint icp_not_target_names_its_signals check (
    verdict <> 'NOT_TARGET' or jsonb_array_length(signals) > 0
  ),

  -- On ne déclare pas éligible ce qu'on n'a pas lu. La garde est ici, en base,
  -- et pas seulement dans la fonction qui calcule : une insertion faite à la
  -- main ou par un futur script ne pourra pas non plus promouvoir un prospect
  -- dont le site n'a jamais été ouvert.
  constraint icp_good_requires_coverage check (
    verdict <> 'GOOD_ICP' or coverage = 'read'
  ),

  -- Une décision humaine porte un nom d'humain. Même exigence que
  -- `ig_kill_switch.set_by` (0029) et `r6b_crm_destinations` (0027) : « system »
  -- et « agent » ne sont pas des auteurs.
  constraint icp_human_decision_is_named check (
    decided_by <> 'human' or assessed_by not in ('system', 'agent', 'automation', 'claude', 'hermes', 'codex')
  )
);

-- La lecture dominante : « quel est le verdict courant de ce prospect ? ».
create index prospect_icp_assessments_latest_idx
  on prospect_icp_assessments (prospect_id, created_at desc);

-- La lecture d'audit : « qui est écarté, et depuis quand ? ».
create index prospect_icp_assessments_verdict_idx
  on prospect_icp_assessments (verdict, created_at desc)
  where verdict <> 'GOOD_ICP';

-- ---------------------------------------------------------------------------
-- Ce que cette migration ne fait pas
-- ---------------------------------------------------------------------------
--
-- Elle n'insère aucun verdict. Le corpus sera évalué par `npm run icp:audit`,
-- qui écrit des lignes datées et signées — pas par un `insert` caché dans une
-- migration, où personne ne relirait la règle appliquée.
--
-- Elle ne modifie ni `prospects.stage`, ni `prospects.score`, ni
-- `r6b_dispatch_manifests`. Un manifeste déjà verrouillé sur un prospect
-- devenu `NOT_TARGET` reste verrouillé et visible : le supprimer effacerait la
-- preuve de l'erreur. C'est le code de verrouillage qui refuse d'en créer un
-- NOUVEAU (`lockManifestForItem`, code `icp_not_target`).
--
-- Elle ne touche à aucune table Instagram. Le rail LIVE reste inexistant et
-- l'arrêt global reste armé.
