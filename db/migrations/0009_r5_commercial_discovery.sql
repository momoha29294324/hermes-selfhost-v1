-- 0009_r5_commercial_discovery.sql — R5 : arrêter de chercher des entreprises
-- qui n'existent pas sur le web, et aller chercher celles qui y vendent.
--
-- ---------------------------------------------------------------------------
-- Ce que les quatre rails précédents ont établi
-- ---------------------------------------------------------------------------
-- R3 (gratuit), R4 (Brave), R4-S (Serper) ont tous posé la même question :
-- « voici une société du registre, où est son site ? ». Les trois ont buté sur
-- le même mur, et R4-S l'a mesuré assez précisément pour qu'on puisse arrêter :
-- 60 requêtes Serper sur les cinquante entreprises que Brave n'avait pas
-- résolues, 121 candidats, 98,1 % rejetés à juste titre par le vérificateur,
-- **zéro site supplémentaire**. 1,7 % seulement des requêtes revenaient vides.
--
-- L'index n'est donc pas en cause. Ces entreprises-là n'ont pas de présence web
-- à trouver. Continuer à payer pour les chercher aurait été acheter le même
-- résultat une quatrième fois.
--
-- ---------------------------------------------------------------------------
-- Le renversement, et ce qu'il oblige à écrire
-- ---------------------------------------------------------------------------
-- R5 pose la question du client : « qui fait ce métier ici ? ». Une entreprise
-- qui répond à cette requête est, par construction, commercialement active —
-- c'est le biais recherché, pas un défaut d'échantillonnage.
--
-- Trois conséquences structurelles, une par bloc de ce fichier :
--
--   1. un résultat n'est plus « le site du prospect X » : c'est une entreprise
--      inconnue, qu'il faut d'abord identifier. `commercial_business_candidates`
--      garde la chaîne complète — regroupement, sondage, identité, verdict —
--      y compris pour ce qui est refusé, parce qu'un rail dont on ignore où il
--      fuit ne peut pas être amélioré ;
--   2. le parcours commercial devient le signal principal. Il est écrit comme
--      une synthèse relisible (`prospects.funnel_summary`), pas seulement comme
--      un booléen ;
--   3. le système a désormais un avis sur ce qu'il faut faire de chaque
--      prospect. Il l'écrit, il ne l'exécute pas.
--
-- ---------------------------------------------------------------------------
-- Ce que cette migration N'AJOUTE PAS : un cache de résultats de recherche
-- ---------------------------------------------------------------------------
-- Aucune colonne `title`, `snippet` ni `description`. La règle établie en R4
-- vaut ici quelle que soit la permission du fournisseur : ce que nous écrivons
-- est notre côté de l'échange — notre requête, notre regroupement, ce que NOUS
-- avons lu en ouvrant la page. `assertNoSearchResultContent` garde le chemin
-- d'écriture et refuse en levant.
--
-- Le domaine candidat, lui, s'écrit : c'est une note de travail à nous
-- (« nous avons l'intention de regarder ici »), au même titre que les domaines
-- fabriqués que `discovery_domain_candidates` conserve depuis R3.

-- ---------------------------------------------------------------------------
-- 1. Un rail de plus dans le vocabulaire des origines
-- ---------------------------------------------------------------------------
-- Comme les cinq autres, c'est une stratégie et jamais une qualité : rien dans
-- le scoring ne lit cette colonne, et `tests/sourceNeutrality.test.ts` en fait
-- une propriété testée. Les valeurs existantes sont reprises telles quelles —
-- 257 prospects portent `long_tail`, et une contrainte qui les rejetterait
-- ferait échouer la migration sur un corpus qu'elle n'a pas le droit de toucher.
alter table prospects drop constraint if exists prospects_discovery_rail_check;
alter table prospects add constraint prospects_discovery_rail_check
  check (discovery_rail in ('commercial', 'long_tail', 'open_web', 'social', 'search',
                            'commercial_web_discovery'));

alter table prospect_discovery_origins drop constraint if exists prospect_discovery_origins_rail_check;
alter table prospect_discovery_origins add constraint prospect_discovery_origins_rail_check
  check (rail in ('commercial', 'long_tail', 'open_web', 'social', 'search',
                  'commercial_web_discovery'));

alter table discovery_provider_stats drop constraint if exists discovery_provider_stats_rail_check;
alter table discovery_provider_stats add constraint discovery_provider_stats_rail_check
  check (rail in ('commercial', 'long_tail', 'open_web', 'social', 'search',
                  'commercial_web_discovery'));

-- ---------------------------------------------------------------------------
-- 2. Les entreprises candidates
-- ---------------------------------------------------------------------------
-- Une ligne par **entreprise**, pas par URL. C'est la distinction que le §6 du
-- gate impose et que cette table rend structurelle : `grouping_key` est unique
-- par campagne, et plusieurs résultats — site, Instagram, Facebook, fiche
-- d'annuaire — convergent dessus.
--
-- `classification` porte les sept catégories du §5. Un annuaire n'atteint
-- jamais cette table : il n'existe que comme piste rattachée, dans `leads`.
create table commercial_business_candidates (
  id                    uuid primary key default gen_random_uuid(),
  campaign_id           uuid not null references campaigns(id) on delete cascade,
  run_id                uuid references campaign_runs(id) on delete set null,
  -- Renseigné seulement quand le candidat est devenu un prospect. Un candidat
  -- écarté reste une mesure : « sondé et refusé » et « jamais vu » ne sont pas
  -- le même nombre.
  prospect_id           uuid references prospects(id) on delete set null,

  -- La clé canonique de regroupement (`site:x.fr`, `social:instagram:x`).
  grouping_key          text not null,
  form                  text not null check (form in ('site', 'social', 'hosted_page')),
  -- Le nom provisoire dérivé du domaine ou du handle. Explicitement provisoire :
  -- il est remplacé par le nom déclaré dès que le site a été lu.
  provisional_name      text not null,
  domain                text,
  site_url              text,
  instagram_handle      text,
  facebook_url          text,

  -- Notre côté de l'échange avec le moteur : combien de fois vu, par quels
  -- termes, dans quelles zones, à quel rang. Aucun contenu de résultat.
  sightings             integer not null default 0,
  best_rank             integer,
  zones                 jsonb not null default '[]'::jsonb,
  terms                 jsonb not null default '[]'::jsonb,
  -- Pistes de tiers (annuaire, article, place de marché) citant cette
  -- entreprise. Une piste, jamais une preuve — §5.
  leads                 jsonb not null default '[]'::jsonb,

  -- --- étage sondage (ce que NOUS avons lu)
  probed_at             timestamptz,
  http_status           integer,
  final_domain          text,
  robots_disallowed     boolean not null default false,
  probe_error           text,

  -- --- étage identité
  declared_name         text,
  declared_city         text,
  declared_postal_code  text,
  registry_id_on_site   text,
  identity_verdict      text check (identity_verdict in ('confirmed', 'probable', 'uncertain', 'rejected')),
  identity_confidence   double precision check (identity_confidence >= 0 and identity_confidence <= 1),
  homonym_risk          boolean not null default false,
  -- Vrai quand le site ne déclare presque rien sur lui-même : la machine
  -- s'arrête, un humain tranche.
  needs_manual_identity boolean not null default false,

  -- --- étage niche
  niche_terms_found     jsonb not null default '[]'::jsonb,
  in_zone               boolean,

  status                text not null default 'discovered'
                          check (status in ('discovered', 'probed', 'promoted', 'rejected')),
  reject_reason         text,

  first_seen_at         timestamptz not null default now(),
  last_checked_at       timestamptz not null default now(),

  unique (campaign_id, grouping_key)
);

create index commercial_business_candidates_campaign_idx
  on commercial_business_candidates (campaign_id, status);
create index commercial_business_candidates_domain_idx
  on commercial_business_candidates (domain);
create index commercial_business_candidates_prospect_idx
  on commercial_business_candidates (prospect_id);

comment on table commercial_business_candidates is
  'Une ligne par entreprise candidate du rail R5, pas par URL. Ne contient aucun '
  'résultat de recherche : ni titre, ni description, ni classement comme contenu. '
  'Voir src/lib/discovery/search/terms.ts.';

comment on column commercial_business_candidates.provisional_name is
  'Nom dérivé du domaine ou du handle, en attendant la lecture du site. Jamais '
  'présenté comme le nom réel de l''entreprise.';

comment on column commercial_business_candidates.leads is
  'Annuaires, articles et places de marché citant cette entreprise. Une piste, '
  'jamais une preuve d''appartenance (§5 du gate R5).';

-- ---------------------------------------------------------------------------
-- 3. Le parcours commercial, relisible
-- ---------------------------------------------------------------------------
-- `funnel_observable` (R2) répond « avons-nous lu le site ? ». Il ne dit pas ce
-- que nous y avons vu, et c'est pourtant ce dont un message part.
--
-- La synthèse complète vit dans `prospect_evidence.funnel_synthesis`, avec sa
-- provenance et son URL source — c'est là qu'elle doit être. Ces deux colonnes
-- sont une projection destinée à la revue : trier trente prospects par marge de
-- progression sans ouvrir trente fiches. Elles sont **dérivées**, jamais
-- saisies, et recalculables depuis l'evidence.
alter table prospects add column if not exists funnel_summary text;
alter table prospects add column if not exists funnel_opportunity_count integer not null default 0;

comment on column prospects.funnel_summary is
  'Projection lisible de prospect_evidence.funnel_synthesis. Dérivée, jamais saisie. '
  'Null = parcours non observé, ce qui ne veut pas dire « pas de parcours ».';

-- ---------------------------------------------------------------------------
-- 4. L'avis du système, et la revue humaine
-- ---------------------------------------------------------------------------
-- Le §19 demande une recommandation SEND / EDIT / REJECT par prospect. C'est
-- un avis, il est écrit comme tel, et il ne déclenche rien : `OUTBOUND_ALLOW_SENDING`
-- reste à 0 et aucun code d'envoi n'existe dans ce dépôt.
--
-- La décision humaine, elle, continue de vivre sur `outreach_messages.state`
-- (draft / approved / rejected), là où elle est depuis V1. Dupliquer un statut
-- de revue sur le prospect créerait deux vérités pour une seule décision.
alter table prospects add column if not exists outreach_recommendation text
  check (outreach_recommendation in ('send', 'edit', 'reject'));
alter table prospects add column if not exists outreach_recommendation_reason text;

-- Ce que nous savons de l'identité d'une entreprise découverte par le web.
-- Distinct de `niche_confidence` : l'une dit « c'est bien un artisan », l'autre
-- « nous savons qui c'est ». Une entreprise peut être manifestement du métier et
-- ne rien déclarer sur elle-même.
alter table prospects add column if not exists identity_review text
  check (identity_review in ('confirmed', 'manual_review', 'uncertain'));

comment on column prospects.outreach_recommendation is
  'Avis du système : send / edit / reject. Un avis, jamais une action — rien ne '
  's''envoie dans ce dépôt.';

comment on column prospects.identity_review is
  'Ce que nous savons de l''identité de l''entreprise, indépendamment de son métier. '
  '« manual_review » = le site ne déclare pas assez pour trancher sans un humain.';

-- ---------------------------------------------------------------------------
-- 5. Le registre de dépense accueille une requête sans prospect
-- ---------------------------------------------------------------------------
-- `search_provider_usage.prospect_id` est déjà nullable, et c'est exactement ce
-- qu'il fallait : une requête R5 ne cherche personne en particulier. Rien à
-- modifier ici — la colonne `query_variant` porte désormais le palier et la
-- zone (`core@Lyon`), qui sont notre façon de nommer la question posée.
comment on column search_provider_usage.query_variant is
  'Ce que la requête cherchait. R4 : la variante (name_city, …). R5 : le palier '
  'et la zone (core@Lyon), une requête de découverte ne visant aucun prospect.';
