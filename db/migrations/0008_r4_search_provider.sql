-- 0008_r4_search_provider.sql — R4 : mesurer ce qu'une vraie API de recherche
-- apporte, et borner ce qu'elle coûte.
--
-- R3 a levé le blocage avec des moyens gratuits et l'a mesuré honnêtement : sur
-- 60 prospects `in_niche`, le KPI combiné est passé de 5 à 7. Sept. Cinquante-
-- trois prospects restent sans parcours commercial observable, et aucun rail
-- gratuit supplémentaire ne changera cet ordre de grandeur — le registre
-- français ne connaît aucun site web, et fabriquer des domaines à partir d'un
-- nom ne résout que les entreprises dont le nom EST le domaine.
--
-- R4 pose donc une question de nature différente : est-ce que payer un index
-- web résout le problème ? Ce fichier donne au rail de quoi y répondre sans
-- jamais pouvoir se tromper sur deux points.
--
-- ---------------------------------------------------------------------------
-- Ce que cette table N'EST PAS : un cache de résultats de recherche
-- ---------------------------------------------------------------------------
-- Les conditions de Brave Search API interdisent de « store, cache, or create a
-- database of Search Results, in whole or in part, other than transient storage
-- required for operation ». La conséquence architecturale est la même qu'en
-- R2.1 pour Places : **le moteur est un pointeur, pas un magasin.**
--
-- Il n'y a donc, volontairement, aucune colonne `title`, `snippet`,
-- `description` ni `result_url` ici. Ce qui est écrit est notre côté de
-- l'échange :
--
--   - la requête, que nous avons composée nous-mêmes ;
--   - combien de résultats sont revenus — un entier, pas leur contenu ;
--   - combien ont survécu au filtre annuaire ;
--   - ce que l'appel a coûté, et s'il a été évité.
--
-- Un domaine, lui, n'entre en base que par `discovery_domain_candidates`
-- (R3) — après que NOUS ayons résolu son DNS, ouvert la page et vérifié à qui
-- elle appartient. À ce stade ce n'est plus un résultat de recherche, c'est une
-- observation à nous, et sa source est le site lui-même.
--
-- `src/lib/discovery/search/terms.ts` porte la règle en code, et
-- `assertNoSearchResultContent` refuse en levant si un champ du moteur
-- s'approche d'un chemin d'écriture.
--
-- ---------------------------------------------------------------------------
-- Ce que cette table EST : un registre de dépense qui survit au crash
-- ---------------------------------------------------------------------------
-- Brave a supprimé son palier gratuit en février 2026. Il n'y a plus 2 000
-- requêtes offertes par mois : il y a 5 $ de crédit mensuel — environ mille
-- requêtes — puis un débit sur la carte enregistrée. Un compteur en mémoire
-- serait donc un garde-fou qu'un simple redémarrage désarme, au moment précis
-- où une boucle mal écrite recommence à zéro.
--
-- Les portées jour et mois se lisent ici. La portée run reste en mémoire, parce
-- qu'un run est justement ce qui ne survit pas au processus.

create table if not exists search_provider_usage (
  id             uuid primary key default gen_random_uuid(),
  provider       text        not null,
  campaign_slug  text,
  run_id         uuid        references campaign_runs(id) on delete set null,
  prospect_id    uuid        references prospects(id) on delete set null,

  -- Notre requête. Nous l'avons écrite ; elle n'est pas un résultat.
  query          text        not null,
  query_variant  text        not null,

  -- Des entiers, jamais du contenu.
  results_count  integer     not null default 0,
  candidates_kept integer    not null default 0,

  -- Une requête évitée est une requête mesurée : c'est le nombre qui justifie
  -- la stratégie progressive, et il doit sortir du même registre que la dépense
  -- pour être crédible.
  avoided        boolean     not null default false,
  avoided_reason text,

  -- Seul ce drapeau compte pour les plafonds. Une requête évitée ou en échec
  -- d'authentification n'a rien consommé.
  billable       boolean     not null default true,

  http_status    integer,
  latency_ms     integer,
  error          text,

  occurred_at    timestamptz not null default now(),
  -- Colonne dérivée et indexée : les plafonds jour/mois sont des `count(*)` sur
  -- une date, et une fonction sur `occurred_at` empêcherait l'index de servir.
  occurred_on    date        not null default (now() at time zone 'utc')::date
);

-- L'index porte exactement la question posée par `assertCanSpend` : combien
-- d'appels facturés pour ce fournisseur depuis telle date.
create index if not exists search_provider_usage_scope_idx
  on search_provider_usage (provider, occurred_on)
  where billable = true;

create index if not exists search_provider_usage_prospect_idx
  on search_provider_usage (prospect_id, query_variant);

comment on table search_provider_usage is
  'Registre de dépense et de mesure des moteurs de recherche payants. '
  'Ne contient AUCUN résultat de recherche : les conditions Brave l''interdisent. '
  'Voir src/lib/discovery/search/terms.ts et la documentation d’installation.';

comment on column search_provider_usage.query is
  'La requête que nous avons composée. Jamais un résultat renvoyé par le moteur.';

comment on column search_provider_usage.results_count is
  'Combien de résultats sont revenus. Un entier — leur contenu n''est pas stocké.';

comment on column search_provider_usage.avoided is
  'Vrai quand la requête n''a pas été émise : déjà posée, ou rendue inutile par '
  'un candidat suffisant trouvé en amont. Sert à mesurer ce que l''escalade épargne.';

-- ---------------------------------------------------------------------------
-- Le rail `search` rejoint le vocabulaire des origines
-- ---------------------------------------------------------------------------
-- R3 a ajouté `open_web` et `social` à `prospects.discovery_rail`. R4 ajoute
-- `search` : un prospect dont le site a été trouvé grâce à un index payant.
--
-- Comme les autres, c'est une stratégie, jamais une qualité. Rien ne le lit
-- dans le scoring, et `tests/sourceNeutrality.test.ts` en fait une propriété
-- testée plutôt qu'une intention.
-- Les quatre valeurs existantes sont reprises telles quelles : 257 prospects
-- portent déjà `long_tail`, et une contrainte qui les rejetterait ferait échouer
-- la migration sur un corpus qu'elle n'a pas le droit de toucher (§17).
alter table prospects drop constraint if exists prospects_discovery_rail_check;
alter table prospects add constraint prospects_discovery_rail_check
  check (discovery_rail in ('commercial', 'long_tail', 'open_web', 'social', 'search'));

-- `recordDiscoveryOrigin` écrit dans cette table à chaque rattachement : sans le
-- même élargissement, le rail lèverait au moment d'écrire son origine.
alter table prospect_discovery_origins drop constraint if exists prospect_discovery_origins_rail_check;
alter table prospect_discovery_origins add constraint prospect_discovery_origins_rail_check
  check (rail in ('commercial', 'long_tail', 'open_web', 'social', 'search'));

-- Un candidat de domaine peut désormais venir d'un moteur payant. La valeur
-- reste dans la famille « observé » : quelqu'un l'a vu associé à cette
-- entreprise, contrairement à un domaine que nous aurions fabriqué depuis le
-- nom — la distinction que `identityVerify.ts` traite via `domainOrigin`.
alter table discovery_domain_candidates
  drop constraint if exists discovery_domain_candidates_origin_check;

alter table discovery_domain_candidates
  add constraint discovery_domain_candidates_origin_check
  check (origin in ('generated', 'observed', 'common_crawl', 'searx', 'search',
                    'website', 'registry', 'social', 'manual'));
