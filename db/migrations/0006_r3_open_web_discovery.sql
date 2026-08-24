-- 0006_r3_open_web_discovery.sql — R3: la découverte cesse de dépendre d'un
-- fournisseur unique.
--
-- R2.1 s'est arrêté sur un constat simple : sur 60 prospects `in_niche`, 5
-- seulement sont à la fois joignables et lisibles. Le crawler marchait, le
-- scoring marchait ; ce qui manquait était en amont — une seule source
-- commerciale, refusée pour des raisons de conditions d'utilisation, et un
-- registre qui ne connaît aucun site web.
--
-- R3 ajoute des rails gratuits et officiels. Ce fichier leur donne la mémoire
-- dont ils ont besoin, sur quatre idées :
--
--   1. Un domaine candidat n'est pas un domaine. Il traverse une chaîne
--      (génération → DNS → HTTP → redirection → HTML → identité) et **chaque
--      étage est écrit**, y compris quand il rejette. Un rail dont on ne sait
--      pas où il fuit ne peut pas être amélioré, et un benchmark qui ne compte
--      que ses succès n'est pas un benchmark.
--   2. Une origine est plurielle et neutre. `prospect_discovery_origins`
--      existe depuis R2 ; R3 se contente d'élargir le vocabulaire des rails.
--      Aucune origine n'entre dans le score — voir tests/sourceNeutrality.
--   3. L'attribution par fournisseur est une mesure, pas une déduction. Le
--      §23 du gate demande « quelle source mérite d'être gardée » : on ne peut
--      y répondre qu'avec un compteur écrit par le code qui appelle.
--   4. L'accès à une source externe est un fait daté. « Facebook Pages Search
--      est bloqué » doit être une ligne consultable, pas une phrase dans un
--      document.

-- ---------------------------------------------------------------------------
-- 1. Élargissement du vocabulaire des rails
-- ---------------------------------------------------------------------------
-- R2 connaissait deux stratégies. R3 en ajoute deux :
--   open_web : le domaine de l'entreprise retrouvé par nos propres moyens
--              (génération de candidats, Common Crawl, SearXNG)
--   social   : enrichissement à partir d'un compte social déjà connu
--              (Instagram Business Discovery, qui EXIGE un username connu)
--
-- Un rail reste une stratégie, jamais une qualité. Rien ne le lit dans le
-- scoring, et `tests/sourceNeutrality.test.ts` en fait une propriété testée.
alter table prospects drop constraint if exists prospects_discovery_rail_check;
alter table prospects add constraint prospects_discovery_rail_check
  check (discovery_rail in ('commercial', 'long_tail', 'open_web', 'social'));

alter table prospect_discovery_origins drop constraint if exists prospect_discovery_origins_rail_check;
alter table prospect_discovery_origins add constraint prospect_discovery_origins_rail_check
  check (rail in ('commercial', 'long_tail', 'open_web', 'social'));

-- ---------------------------------------------------------------------------
-- 2. Domaines candidats : la chaîne de vérification, étage par étage
-- ---------------------------------------------------------------------------
-- Un domaine attribué à tort empoisonne tout ce qui suit : la recherche,
-- l'angle, le message. Le prix d'une erreur est donc asymétrique, et la table
-- l'est aussi — elle garde autant de traces des refus que des acceptations.
--
-- `identity_verdict` est le seul champ qui autorise un rattachement, et seul
-- `confirmed` le fait sans condition. `probable` demande en plus l'absence de
-- risque d'homonymie ; c'est `homonym_risk` qui l'exprime.
create table discovery_domain_candidates (
  id                  uuid primary key default gen_random_uuid(),
  campaign_id         uuid not null references campaigns(id) on delete cascade,
  prospect_id         uuid references prospects(id) on delete cascade,

  -- Le candidat lui-même, déjà normalisé (minuscules, sans www.).
  candidate_domain    text not null,
  -- Comment il a été obtenu. `generated` = fabriqué à partir du nom ;
  -- les autres viennent d'une observation.
  origin              text not null
                        check (origin in ('generated', 'common_crawl', 'searx',
                                          'website', 'registry', 'social', 'manual')),
  -- Quelle règle de génération l'a produit (concat, hyphen, prefix…). Null
  -- pour un candidat observé plutôt que fabriqué.
  generation_form     text,

  -- --- étage DNS
  dns_checked_at      timestamptz,
  dns_resolved        boolean,
  dns_error           text,

  -- --- étage Common Crawl (existence sur le web ouvert, sans toucher au site)
  cc_checked_at       timestamptz,
  cc_captures         integer,
  cc_first_capture    text,      -- horodatage CC brut (YYYYMMDDhhmmss)
  cc_last_capture     text,
  cc_index            text,      -- identifiant de l'index interrogé

  -- --- étage HTTP
  http_checked_at     timestamptz,
  http_status         integer,
  final_url           text,
  -- Domaine réellement atteint après redirections. Différent de
  -- `candidate_domain` quand le site redirige ailleurs — cas fréquent et
  -- décisif : une redirection vers une plateforme ou vers un concurrent
  -- disqualifie le candidat.
  final_domain        text,
  http_error          text,
  robots_disallowed   boolean not null default false,

  -- --- étage identité
  identity_verdict    text
                        check (identity_verdict in ('confirmed', 'probable', 'uncertain', 'rejected')),
  identity_confidence double precision
                        check (identity_confidence >= 0 and identity_confidence <= 1),
  -- Les signaux observés, un par un, avec ce qui a été comparé. Le dashboard
  -- et le rapport en dépendent : « pourquoi ce domaine » doit être lisible.
  identity_signals    jsonb not null default '{}'::jsonb,
  -- Vrai quand deux entreprises pourraient légitimement porter ce nom :
  -- enseigne générique, chaîne nationale, homonyme dans une autre ville.
  homonym_risk        boolean not null default false,

  -- Résultat final.
  attached            boolean not null default false,
  reject_reason       text,

  first_seen_at       timestamptz not null default now(),
  last_checked_at     timestamptz not null default now(),

  unique (campaign_id, prospect_id, candidate_domain)
);

create index discovery_domain_candidates_prospect_idx
  on discovery_domain_candidates (prospect_id);
create index discovery_domain_candidates_verdict_idx
  on discovery_domain_candidates (campaign_id, identity_verdict);
create index discovery_domain_candidates_domain_idx
  on discovery_domain_candidates (candidate_domain);

-- ---------------------------------------------------------------------------
-- 3. Journal Common Crawl
-- ---------------------------------------------------------------------------
-- Common Crawl est un index d'URL, pas un moteur de recherche plein texte. Ce
-- journal existe pour que le rapport R3 puisse dire exactement combien de
-- requêtes ont été posées, combien ont répondu, et combien de faux candidats
-- l'index a permis d'éliminer avant qu'on ne dérange un serveur.
create table common_crawl_lookups (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid references campaign_runs(id) on delete set null,
  queried_domain  text not null,
  index_id        text not null,
  match_type      text not null default 'domain',
  http_status     integer,
  captures        integer not null default 0,
  distinct_urls   integer not null default 0,
  first_capture   text,
  last_capture    text,
  from_cache      boolean not null default false,
  duration_ms     integer,
  error           text,
  queried_at      timestamptz not null default now()
);

create index common_crawl_lookups_domain_idx on common_crawl_lookups (queried_domain, queried_at desc);
create index common_crawl_lookups_run_idx on common_crawl_lookups (run_id);

-- ---------------------------------------------------------------------------
-- 4. Attribution par fournisseur
-- ---------------------------------------------------------------------------
-- « Quelle source mérite d'être gardée » ne se déduit pas des prospects : deux
-- rails peuvent trouver la même entreprise, et celui qui est arrivé second n'a
-- pas rien fait. Chaque étage est donc compté par le code qui l'exécute.
--
-- `false_positives` a un sens précis ici : un candidat que la source a proposé
-- et que la vérification d'identité a rejeté. Ce n'est pas un jugement sur la
-- source, c'est le coût de vérification qu'elle impose.
create table discovery_provider_stats (
  id                        uuid primary key default gen_random_uuid(),
  run_id                    uuid references campaign_runs(id) on delete cascade,
  campaign_id               uuid not null references campaigns(id) on delete cascade,
  provider                  text not null,
  rail                      text not null
                              check (rail in ('commercial', 'long_tail', 'open_web', 'social')),

  candidates_generated      integer not null default 0,
  calls_issued              integer not null default 0,
  calls_failed              integer not null default 0,
  domains_found             integer not null default 0,
  independent_confirmations integer not null default 0,
  false_positives           integer not null default 0,
  contactables              integer not null default 0,
  funnel_observable         integer not null default 0,
  instagram_resolved        integer not null default 0,

  latency_ms_total          integer not null default 0,
  -- En euros. R3 impose 0 partout ; la colonne existe pour que « gratuit »
  -- soit une valeur mesurée plutôt qu'une affirmation.
  external_cost_eur         numeric(10, 4) not null default 0,

  notes                     jsonb not null default '{}'::jsonb,
  created_at                timestamptz not null default now(),

  unique (run_id, provider)
);

create index discovery_provider_stats_campaign_idx
  on discovery_provider_stats (campaign_id, provider);

-- ---------------------------------------------------------------------------
-- 5. État d'accès aux sources externes
-- ---------------------------------------------------------------------------
-- « Facebook Pages Search est bloqué en attente d'App Review » est un fait
-- daté, vérifiable, et susceptible de changer. Le laisser uniquement dans un
-- document en fait une rumeur au bout de trois mois.
--
-- Aucun secret n'entre ici : `detail` décrit des permissions et des états, pas
-- des jetons. La colonne est relue par `gate:report` et par le dashboard.
create table external_source_access (
  source        text primary key,
  status        text not null
                  check (status in ('available', 'blocked_pending_app_review',
                                    'not_viable', 'not_configured', 'disabled')),
  -- Ce qu'il faudrait obtenir pour débloquer, en clair.
  requirement   text,
  detail        jsonb not null default '{}'::jsonb,
  checked_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table external_source_access is
  'État d''accès à chaque source externe. Jamais de secret : des permissions et des états, pas des jetons.';
