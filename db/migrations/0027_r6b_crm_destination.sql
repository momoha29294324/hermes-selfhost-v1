-- 0027_r6b_crm_destination.sql — R6B-D2.1, la destination CRM (mission
-- « Hermes CRM Configuration + Safe Projection »).
--
-- 0026 a posé la FRONTIÈRE : une charge utile exacte, figée, auditable, et une
-- ligne `r6b_crm_projections` qui dit pourquoi elle n'est pas partie. Ce qui
-- manquait était la destination — et 0026 disait explicitement pourquoi elle
-- manquait : « le seul CRM que la machine d'un opérateur connaît appartient à
-- un projet isole, et la documentation d’installation interdit d'y toucher ».
--
-- Cette migration ne résout pas ce problème en nommant un sous-compte. Elle le
-- résout en rendant IMPOSSIBLE d'en écrire un par accident, puis en laissant un
-- humain en confirmer un, une fois, explicitement.
--
-- ---------------------------------------------------------------------------
-- La garde centrale : deux faits indépendants doivent concorder
-- ---------------------------------------------------------------------------
--
-- Une variable d'environnement seule n'autorise RIEN. Écrire chez un tiers
-- exige que DEUX faits, écrits à deux moments différents par deux chemins
-- différents, désignent la même destination :
--
--   1. l'environnement d'exécution nomme un fournisseur et un `locationId`
--      (`OUTBOUND_CRM_PROVIDER`, `OUTBOUND_CRM_LOCATION_ID`) ;
--   2. une ligne `r6b_crm_destinations` porte ce même `location_id` en statut
--      `CONFIRMED`, avec le nom rendu par le fournisseur lui-même et le nom de
--      l'humain qui a confirmé qu'il s'agit bien de Hermes.
--
-- Une clé qui traîne dans un `.env` ne suffit donc pas ; un `export` maladroit
-- pointant sur le sous-compte d'un autre projet ne suffit pas non plus — sans
-- confirmation persistée pour CE `location_id` précis, la projection est
-- refusée (`BLOCKED_CONFIG`) et rien ne part. C'est la traduction structurelle
-- de « Do not write anything into un projet isole by accident » : il n'existe aucun
-- chemin de code menant d'une variable d'environnement seule à une écriture.
--
-- ---------------------------------------------------------------------------
-- Ce que cette migration ne fait pas
-- ---------------------------------------------------------------------------
--
--   * elle ne confirme aucune destination : les tables naissent VIDES, et le
--     dépôt reste donc dans l'état « aucune destination CRM » après elle ;
--   * elle n'envoie rien et n'ouvre aucun canal sortant. Aucune table d'ici
--     ne porte de message, de destinataire ni de statut d'envoi ;
--   * elle ne crée ni contact, ni opportunité, ni note chez un fournisseur.

-- ---------------------------------------------------------------------------
-- 1. r6b_crm_destinations — le sous-compte, confirmé par un humain
-- ---------------------------------------------------------------------------
--
-- `provider` n'est pas contraint à une liste fermée : c'est le registre
-- d'adapters du code (`src/lib/crm/registry.ts`) qui décide quels noms savent
-- réellement parler à quelque chose. Figer la liste ici obligerait à une
-- migration pour ajouter un faux fournisseur de test, ce qui pousserait les
-- tests à contourner cette table — c'est-à-dire à ne plus tester la garde.
create table r6b_crm_destinations (
  id             uuid primary key default gen_random_uuid(),

  provider       text not null check (length(provider) between 1 and 64),

  -- L'identifiant de sous-compte CHEZ LE FOURNISSEUR. Ce n'est pas un secret
  -- (il figure dans chaque URL de l'interface), et il doit rester lisible :
  -- c'est lui que `r6b:crm:status` affiche pour qu'un humain vérifie d'un
  -- coup d'œil qu'il ne s'agit pas du sous-compte d'un autre projet.
  location_id    text not null check (length(location_id) between 1 and 128),
  -- Le nom RENDU PAR LE FOURNISSEUR lors de la vérification en lecture seule,
  -- jamais saisi à la main. C'est ce qui permet de dire « Hermes » ou « ce
  -- n'est pas Hermes » sur autre chose qu'une chaîne d'identifiants opaque.
  location_name  text,

  pipeline_id    text check (pipeline_id is null or length(pipeline_id) between 1 and 128),
  pipeline_name  text,

  -- Correspondance entre les champs de la charge utile et les champs
  -- personnalisés du sous-compte, telle que la vérification l'a OBSERVÉE :
  -- {"prospectScore": {"id": "...", "key": "..."}}. Vide tant que rien n'a été
  -- observé — un identifiant de champ personnalisé ne se devine pas, et un
  -- champ absent de cette table n'est simplement pas envoyé (il reste porté
  -- par la note, qui existe toujours).
  field_map      jsonb not null default '{}'::jsonb,

  --   UNCONFIRMED — observée en lecture seule, jamais autorisée à recevoir.
  --   CONFIRMED   — un humain a nommément confirmé qu'il s'agit de Hermes.
  --   REVOKED     — retirée. Ne redevient jamais CONFIRMED sans nouvelle ligne.
  status         text not null default 'UNCONFIRMED'
                   check (status in ('UNCONFIRMED', 'CONFIRMED', 'REVOKED')),
  confirmed_by   text check (confirmed_by is null or length(confirmed_by) between 1 and 120),
  confirmed_at   timestamptz,
  note           text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- Une confirmation sans confirmant est une confirmation que personne n'a
  -- faite. Le schéma refuse de la porter.
  constraint r6b_crm_destination_confirmed_has_author check (
    status <> 'CONFIRMED' or (confirmed_by is not null and confirmed_at is not null)
  ),
  -- Une destination confirmée doit porter un pipeline : sans lui, aucune étape
  -- ne peut être désignée, et une projection « appliquée » ne voudrait rien
  -- dire commercialement.
  constraint r6b_crm_destination_confirmed_has_pipeline check (
    status <> 'CONFIRMED' or pipeline_id is not null
  )
);

create unique index r6b_crm_destinations_provider_location_idx
  on r6b_crm_destinations (provider, location_id);

-- UNE seule destination confirmée par fournisseur. Deux sous-comptes confirmés
-- en même temps rendraient la question « où va ce prospect ? » ambiguë, et une
-- ambiguïté sur cette question-là est exactement ce qui écrit chez le mauvais
-- destinataire.
create unique index r6b_crm_destinations_one_confirmed_idx
  on r6b_crm_destinations (provider)
  where status = 'CONFIRMED';

-- ---------------------------------------------------------------------------
-- 2. r6b_crm_pipeline_stages — les identifiants d'étape, tels que rendus
-- ---------------------------------------------------------------------------
--
-- §3 de la mission : « Do not infer stage IDs from names at runtime after
-- initial configuration if the API provides stable IDs ». Cette table est la
-- raison pour laquelle ce n'est pas nécessaire — les identifiants sont lus une
-- fois, à la vérification, et relus ici ensuite. Un renommage d'étape côté
-- fournisseur ne casse donc rien, et une étape renommée en « Perdu » par
-- quelqu'un d'autre ne capture pas nos prospects.
create table r6b_crm_pipeline_stages (
  id             uuid primary key default gen_random_uuid(),
  destination_id uuid not null references r6b_crm_destinations(id) on delete cascade,

  stage_id       text not null check (length(stage_id) between 1 and 128),
  stage_name     text not null check (length(stage_name) between 1 and 200),
  position       integer,

  observed_at    timestamptz not null default now(),

  unique (destination_id, stage_id)
);

create index r6b_crm_pipeline_stages_destination_idx
  on r6b_crm_pipeline_stages (destination_id, position);

-- ---------------------------------------------------------------------------
-- 3. r6b_crm_stage_map — état commercial → étape, explicitement
-- ---------------------------------------------------------------------------
--
-- `REVIEW_REQUIRED` est ABSENT de la liste autorisée, et c'est le point de la
-- table : §6 de la mission interdit toute évolution d'étape automatique sur une
-- conclusion que le système n'a pas tranchée. Ne pas pouvoir l'inscrire vaut
-- mieux qu'une règle applicative qui l'éviterait — une règle s'oublie, une
-- contrainte non.
--
-- `CONTACTED` y figure alors qu'aucun chemin de R6B ne projette sur l'envoi :
-- la correspondance doit exister pour qu'une mission ultérieure n'ait pas à
-- l'inventer, et la table de correspondance est le bon endroit pour dire quelle
-- étape lui reviendrait.
create table r6b_crm_stage_map (
  destination_id uuid not null references r6b_crm_destinations(id) on delete cascade,
  outreach_state text not null
                   check (outreach_state in ('CONTACTED', 'REPLIED', 'INTERESTED', 'NOT_NOW',
                                             'NOT_INTERESTED', 'BOUNCED', 'SUPPRESSED')),
  stage_id       text not null,
  created_at     timestamptz not null default now(),

  primary key (destination_id, outreach_state),
  -- L'étape désignée doit être une étape RÉELLEMENT observée sur ce pipeline.
  -- Sans cette clé, une correspondance pourrait désigner un identifiant
  -- inventé, et l'erreur ne se verrait qu'au moment de l'écriture chez le tiers.
  foreign key (destination_id, stage_id)
    references r6b_crm_pipeline_stages (destination_id, stage_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- 4. r6b_crm_contact_links — un prospect local, un contact chez le fournisseur
-- ---------------------------------------------------------------------------
--
-- §4 : « A prospect must never create duplicate CRM contacts on every
-- reply/poll. » Cette table est ce qui le garantit, et les deux index uniques
-- disent chacun une moitié de la garantie :
--
--   * (destination_id, prospect_id) — un prospect ne peut pas avoir deux
--     contacts. C'est la protection contre le doublon par rejeu ;
--   * (destination_id, external_contact_id) — deux prospects ne peuvent pas
--     partager un contact. C'est la protection contre la FUSION : si une
--     recherche par email rendait le contact déjà lié à un autre prospect,
--     l'insertion échoue plutôt que d'écrire le dossier d'une entreprise dans
--     celui d'une autre.
--
-- `match_kind` conserve COMMENT le lien a été établi. « created » et
-- « email » ne se relisent pas de la même façon six mois plus tard, et aucun
-- `match_kind` fondé sur une ressemblance de nom n'existe : la liste est
-- fermée, et aucun de ses membres n'est un nom.
create table r6b_crm_contact_links (
  id                      uuid primary key default gen_random_uuid(),
  destination_id          uuid not null references r6b_crm_destinations(id) on delete cascade,
  prospect_id             uuid not null references prospects(id) on delete cascade,

  external_contact_id     text not null check (length(external_contact_id) between 1 and 128),
  external_opportunity_id text check (external_opportunity_id is null
                                      or length(external_opportunity_id) between 1 and 128),

  match_kind              text not null
                            check (match_kind in ('created', 'email', 'phone', 'provider_contact_id', 'link')),
  -- La valeur normalisée qui a produit la correspondance (email en minuscules,
  -- téléphone en chiffres). Ni un secret, ni une déduction : c'est la donnée
  -- déjà présente sur le prospect, conservée pour qu'un audit puisse refaire
  -- le raisonnement.
  match_value             text,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  unique (destination_id, prospect_id),
  unique (destination_id, external_contact_id)
);

-- ---------------------------------------------------------------------------
-- 5. r6b_crm_notes — l'historique chez le fournisseur, sans doublon
-- ---------------------------------------------------------------------------
--
-- §8 : retraiter la même réponse ne doit pas produire une seconde note. La
-- garde est l'empreinte du corps : deux traitements de la même analyse
-- produisent le même texte, donc la même empreinte, donc un `on conflict do
-- nothing` qui ne rend aucune ligne — et le fournisseur n'est même pas appelé.
--
-- Le corps de la note n'est PAS recopié ici. Il se recompose depuis l'analyse
-- et le contexte, tous deux immuables, et le dupliquer ferait exister deux
-- vérités sur ce qui a été écrit chez le tiers.
create table r6b_crm_notes (
  id               uuid primary key default gen_random_uuid(),
  destination_id   uuid not null references r6b_crm_destinations(id) on delete cascade,
  prospect_id      uuid not null references prospects(id) on delete cascade,
  analysis_id      uuid references r6b_reply_analyses(id) on delete set null,

  body_sha256      text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  external_note_id text,

  created_at       timestamptz not null default now(),

  unique (destination_id, prospect_id, body_sha256)
);

-- ---------------------------------------------------------------------------
-- 6. r6b_crm_projections — deux états de plus, et la destination écrite
-- ---------------------------------------------------------------------------
--
-- 0026 connaissait cinq états. Il en manque deux, et chacun répond à une
-- question que l'opérateur pose réellement :
--
--   BLOCKED_CONFIG    — une destination est NOMMÉE mais refusée : sous-compte
--                       non confirmé, `location_id` qui ne correspond pas à la
--                       confirmation, pipeline absent, étape non cartographiée.
--                       Distinct de `SKIPPED_NOT_CONFIGURED` (« rien n'a été
--                       demandé »), parce que la correction n'est pas la même :
--                       l'un attend une décision, l'autre attend une commande.
--   FAILED_PERMANENT  — le fournisseur a refusé pour une raison que rejouer ne
--                       changera pas (authentification, sous-compte inconnu,
--                       charge utile invalide). Sans cet état, `r6b:crm:sync`
--                       retenterait indéfiniment une erreur définitive, et le
--                       compteur d'échecs cesserait de vouloir dire quelque
--                       chose.
--
-- `FAILED` conserve son sens de 0026 et devient l'échec RETENTABLE (réseau,
-- 429, 5xx) — c'est le `FAILED_RETRYABLE` de la mission, sous le nom que la
-- table porte déjà et que le code de 0026 écrit.
alter table r6b_crm_projections drop constraint r6b_crm_projections_status_check;
alter table r6b_crm_projections add constraint r6b_crm_projections_status_check
  check (status in ('PENDING', 'SKIPPED_NOT_CONFIGURED', 'BLOCKED_POLICY', 'BLOCKED_CONFIG',
                    'APPLIED', 'FAILED', 'FAILED_PERMANENT'));

-- Un échec définitif doit dire pourquoi, comme un échec retentable.
alter table r6b_crm_projections drop constraint r6b_crm_projection_failed_has_error;
alter table r6b_crm_projections add constraint r6b_crm_projection_failed_has_error
  check (status not in ('FAILED', 'FAILED_PERMANENT') or last_error is not null);

-- OÙ la projection a été appliquée. Sans cette colonne, une projection
-- `APPLIED` ne dirait pas dans quel sous-compte elle a écrit — et le jour où
-- une destination changerait, plus rien ne distinguerait ce qui a été écrit
-- avant de ce qui a été écrit après.
alter table r6b_crm_projections
  add column destination_id uuid references r6b_crm_destinations(id) on delete set null;

alter table r6b_crm_projections add constraint r6b_crm_projection_applied_has_destination
  check (status <> 'APPLIED' or destination_id is not null);

-- ---------------------------------------------------------------------------
-- 7. UNE projection par prospect, et non une par (prospect, fournisseur)
-- ---------------------------------------------------------------------------
--
-- 0026 indexait `(prospect_id, provider)`. C'était juste tant qu'aucune
-- destination n'existait, et c'est devenu faux dès qu'il est devenu possible
-- d'en configurer une : `provider` vaut `'unconfigured'` tant que rien n'est
-- nommé, et `'gohighlevel'` ensuite. Ces deux valeurs ne désignent pas deux
-- fournisseurs — elles désignent le même prospect à deux moments. Sous
-- l'ancien index, configurer un CRM après coup produisait donc DEUX lignes pour
-- le même prospect : une périmée bloquée en `SKIPPED_NOT_CONFIGURED`, que
-- `r6b:crm:sync` aurait reprise indéfiniment, et une réelle.
--
-- Le fournisseur reste une COLONNE (elle dit où la dernière tentative est
-- allée), il cesse d'être une clé. Un prospect a un dossier CRM, pas un par
-- fournisseur : l'application ne résout qu'une destination à la fois
-- (`OUTBOUND_CRM_PROVIDER` est une valeur unique), et `destination_id` conserve
-- l'audit de celle qui a réellement reçu.
--
-- La déduplication préalable est inutile en pratique — la table est vide — mais
-- elle est écrite quand même : une migration qui suppose l'état de la base au
-- lieu de le garantir échoue chez le seul qui n'avait pas cet état. La ligne
-- CONSERVÉE est celle qui a réellement écrit (`APPLIED` d'abord), puis la plus
-- récente : jamais l'inverse, qui effacerait la trace d'une écriture faite.
delete from r6b_crm_projections
 where id in (
   select id
     from (
       select id,
              row_number() over (
                partition by prospect_id
                order by (status = 'APPLIED') desc, updated_at desc, id desc
              ) as rank
         from r6b_crm_projections
     ) ranked
    where ranked.rank > 1
 );

drop index r6b_crm_projections_prospect_provider_idx;
create unique index r6b_crm_projections_prospect_idx on r6b_crm_projections (prospect_id);

comment on table r6b_crm_destinations is
  'Sous-compte CRM confirmé par un humain. Une variable d''environnement seule n''autorise aucune '
  'écriture : la projection exige que le location_id de l''environnement corresponde à une ligne '
  'CONFIRMED de cette table. Aucune ligne n''est créée par une migration.';
