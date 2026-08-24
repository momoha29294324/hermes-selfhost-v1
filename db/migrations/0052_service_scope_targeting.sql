-- 0052_in_scope_only_targeting.sql — HERMES-CLEANING-ONLY-ICP-R1.
--
-- Ce que cette migration fait, et ce qu'elle refuse de faire
-- ---------------------------------------------------------
-- Elle ajoute DEUX choses, toutes deux additives :
--
--   1. deux motifs de refus de plus dans le vocabulaire fermé de la file —
--      `service_scope_not_in_scope_only` et `market_scope_unknown` ;
--   2. l'ENTITÉ MÉTIER, qui regroupe des lignes `prospects` appartenant au même
--      commerce à travers les campagnes, sans en fusionner ni en supprimer une
--      seule.
--
-- Elle n'insère aucune ligne, ne modifie aucune ligne existante, ne touche ni
-- `ig_kill_switch` (qui reste armé), ni `ig_dispatch_jobs`, ni
-- `r6b_dispatch_manifests`, ni `outreach_events`, ni `prospect_evidence`. Une
-- base qui vient de la subir est exactement aussi incapable d'envoyer qu'avant.
--
-- Elle ne touche PAS non plus à `prospects.dedupe_status`, et c'est un choix
-- explicite : cette colonne répond depuis toujours à « au sein de SA campagne,
-- cette ligne est-elle un doublon ? », et la réponse `unique` portée par les
-- deux lignes DEMOJULIET y est JUSTE. Réécrire ces valeurs ferait mentir tout
-- l'historique — y compris les manifestes verrouillés qui les ont lues — pour
-- répondre à une question qu'on n'avait jamais posée à cette colonne. La
-- réponse à la nouvelle question vit donc dans une nouvelle structure.

-- ---------------------------------------------------------------------------
-- 1. Deux motifs de refus de plus
-- ---------------------------------------------------------------------------
--
-- `service_scope_not_in_scope_only` — TERMINAL. Ce commerce commercialise une
--   prestation non-prestation standard (REVENTE, boutique en ligne, revente, vente de produits, mécanique,
--   formation, …). Distinct d'`icp_not_target`, qui dit « ce n'est pas le bon
--   TYPE d'entreprise » : ici, c'est la bonne famille d'entreprise et la
--   mauvaise OFFRE. Deux refus différents sous un seul mot se reliraient de
--   travers six mois plus tard, et empêcheraient de compter l'un sans l'autre.
--
-- `market_scope_unknown` — TEMPORAIRE. Aucune ancre observée ne place ce
--   commerce sur le marché français. Ce n'est PAS `icp_not_target` : nous ne
--   savons pas qu'il est hors marché, nous savons que nous ne savons pas. Une
--   mention légale lue plus tard, un SIREN retrouvé, et le prospect revient
--   seul. Le classer TERMINAL le condamnerait sur une absence d'observation —
--   exactement ce que CLAUDE.md §2 interdit.
--
-- La contrainte est redéfinie en entier plutôt qu'étendue : PostgreSQL n'a pas
-- d'`alter constraint add value`, et réécrire la liste complète la rend lisible
-- d'un seul regard, sans avoir à recomposer mentalement 0039 + 0046 + 0047.
alter table ig_dispatch_jobs drop constraint ig_dispatch_jobs_last_skip_reason_check;
alter table ig_dispatch_jobs add constraint ig_dispatch_jobs_last_skip_reason_check
  check (last_skip_reason is null or last_skip_reason in (
    'not_due_yet', 'outside_window', 'hourly_cap', 'daily_cap', 'cooldown', 'kill_switch',
    'consecutive_failures', 'session_failures', 'login_required', 'session_unavailable',
    'challenge', 'target_unreachable', 'composer_unavailable', 'manifest_drift', 'rail_failure',
    'identity_failure', 'duplicate', 'already_contacted', 'review_required', 'opt_out',
    'icp_not_target', 'prospect_inactive', 'payload_unavailable', 'identity_provenance_missing',
    'audience_out_of_scope', 'audience_borderline',
    'service_scope_not_in_scope_only', 'market_scope_unknown'
  ));

alter table ig_job_events drop constraint ig_job_events_skip_reason_check;
alter table ig_job_events add constraint ig_job_events_skip_reason_check
  check (skip_reason is null or skip_reason in (
    'not_due_yet', 'outside_window', 'hourly_cap', 'daily_cap', 'cooldown', 'kill_switch',
    'consecutive_failures', 'session_failures', 'login_required', 'session_unavailable',
    'challenge', 'target_unreachable', 'composer_unavailable', 'manifest_drift', 'rail_failure',
    'identity_failure', 'duplicate', 'already_contacted', 'review_required', 'opt_out',
    'icp_not_target', 'prospect_inactive', 'payload_unavailable', 'identity_provenance_missing',
    'audience_out_of_scope', 'audience_borderline',
    'service_scope_not_in_scope_only', 'market_scope_unknown'
  ));

-- ---------------------------------------------------------------------------
-- 2. L'entité métier — une mémoire, pas une fusion
-- ---------------------------------------------------------------------------
--
-- Une ligne = un COMMERCE réel, reconnu à travers les campagnes par une clé
-- décisive : SIREN, domaine, identifiant de lieu, compte Instagram, adresse
-- e-mail. Ni le téléphone (un standard se partage) ni le nom (« ATELIER CAR »
-- est un nom de métier que plusieurs sociétés portent) — §13 l'exige, et
-- `businessContactGuard` avait déjà établi la même liste pour la même raison.
--
-- Ce que cette table N'EST PAS : une file, un doublon de `prospects`, ni un
-- endroit où l'on écrirait des faits sur l'entreprise. Elle ne porte ni nom, ni
-- adresse, ni score — uniquement de quoi RECONNAÎTRE. Y mettre un nom créerait
-- une seconde vérité sur l'identité, et l'une des deux finirait par mentir.
create table business_entities (
  id             uuid primary key default gen_random_uuid(),

  -- La meilleure clé décisive du groupe, préfixée de son genre :
  -- `registry_id:484122452`, `domain:demo-56-exemple.fr`, `instagram:demo_account_18`.
  -- Une seule, et pas leur concaténation : une entité dont on apprendrait
  -- demain le compte Instagram changerait de clé si celle-ci les listait
  -- toutes, et se dédoublerait au lieu de s'enrichir.
  canonical_key  text not null unique check (canonical_key ~ '^(registry_id|domain|google_place_id|instagram|email):.+$'),

  -- Quand ce commerce est entré dans la base pour la première fois, toutes
  -- campagnes confondues. C'est la réponse à « le connaît-on depuis quand ? »,
  -- que ni `prospects.first_seen_at` (par ligne) ni `campaigns.created_at`
  -- (par lot) ne donnent.
  first_linked_at timestamptz not null default now(),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- L'appartenance, portée par la ligne de campagne elle-même.
--
-- Une colonne plutôt qu'une table de liaison : un prospect appartient à
-- exactement UNE entité — c'est ce que « même commerce » veut dire — et une
-- table de liaison laisserait exister l'état « appartient à deux entités », qui
-- n'a pas de sens et qu'il faudrait ensuite interdire par une contrainte.
--
-- NULLABLE, et cela compte : une ligne sans aucune clé décisive (ni SIREN, ni
-- domaine, ni compte) n'appartient à aucune entité reconnaissable. `null` dit
-- « on ne sait pas », jamais « elle est seule » — et la politique autonome
-- traite les deux différemment.
alter table prospects add column business_entity_id uuid references business_entities(id);

create index prospects_business_entity_idx on prospects (business_entity_id)
  where business_entity_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Ce que cette migration ne fait pas
-- ---------------------------------------------------------------------------
--
-- Elle ne lie aucune ligne : la table naît vide et la colonne naît `null`
-- partout. Le rattachement est une PASSE explicite (`npm run business:link`),
-- rejouable, journalisée, et qui se contente d'écrire ce qu'une résolution
-- d'identité a établi. Le faire ici, dans une migration, rendrait le résultat
-- non rejouable et non contestable.
--
-- Elle ne supprime aucune ligne, n'en fusionne aucune, ne touche à aucun
-- manifeste verrouillé, et ne modifie ni `dedupe_status` ni `merged_into_id`.
--
-- Elle ne lève pas l'arrêt global et n'arme aucune autorisation.
