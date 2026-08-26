-- 0019_r6b_dispatch_manifest.sql — R6B-B, dispatch manifest + learning telemetry
-- (mission « Hermes R6B-B — Dispatch Manifest + Learning Telemetry »).
--
-- R6B-A a produit un batch approuvé (5/5 SEND, migration 0018). R6B-B ne
-- décide rien à la place de un opérateur : elle fige, une fois qu'il a choisi un
-- canal et une destination dans `/pilot/r6b-dispatch`, exactement ce qu'un
-- futur envoi devra reproduire — prospect, texte, canal, destinataire — sous
-- une forme qu'un sender ne pourra pas réinterpréter au moment d'envoyer.
--
-- §9 de la mission reste l'invariant qui prime sur tout le reste : cette
-- migration ne crée ni sender ni transport réseau. `OUTBOUND_ALLOW_SENDING`
-- reste à 0 et `outreach_events` reste vide (§20 test).

-- ---------------------------------------------------------------------------
-- r6b_dispatch_manifests — le manifeste immuable (§8)
-- ---------------------------------------------------------------------------
--
-- Append-only : verrouiller un manifeste n'écrase jamais un précédent. Un
-- nouveau lock sur le même `batch_item_id` (texte, canal ou destinataire
-- différent) marque l'ancien `SUPERSEDED` — jamais UPDATE sur ses colonnes de
-- contenu (texte/canal/destinataire), seulement sur son statut et
-- `superseded_at`/`superseded_by`, exactement le patron déjà en place pour
-- les votes r6b (0018 : is_correction) et r6a3/r6a4. L'index partiel ci-dessous
-- garantit qu'au plus un manifeste `LOCKED` existe à la fois par item — c'est
-- ce qu'un futur sender consommera, jamais une sélection dynamique (§3).
create table r6b_dispatch_manifests (
  id                     uuid primary key default gen_random_uuid(),

  batch_id               uuid not null references r6b_batches(id),
  batch_item_id          uuid not null references r6b_batch_items(id),
  prospect_id            uuid not null references prospects(id),
  approval_vote_id        uuid not null references r6b_batch_votes(id),

  -- Nom destiné à l'humain (§7 : « afficher clairement le nom commercial »).
  -- Peut différer de `prospects.display_name` — cas VTC LYONNAIS 69800 / site
  -- "Prestation Auto Lyon" (§6) — donc capturé explicitement plutôt que rejoint à
  -- la volée sur une valeur qui peut changer.
  business_name          text not null,
  legal_name             text,

  channel                text not null
                           check (channel in ('email', 'phone', 'website', 'instagram', 'facebook')),
  recipient              text not null,
  -- Provenance figée au moment du lock : {field, provider, method, source_url,
  -- confidence, observed_at} lue depuis prospect_evidence (§5 : « une
  -- destination doit garder sa provenance »).
  recipient_provenance   jsonb not null,

  -- §6 : statut d'identité au moment du lock, jamais recalculé après coup.
  identity_review        text not null
                           check (identity_review in ('confirmed', 'manual_review', 'uncertain')),

  -- Texte exact voté SEND/EDIT sur `r6b_batch_votes.approved_text` — jamais
  -- retouché ici. Le hash permet à un futur sender de vérifier qu'il envoie
  -- verbatim ce qui a été approuvé, sans avoir à faire confiance au texte
  -- qu'on lui passe.
  approved_text           text not null,
  approved_text_sha256    text not null,

  hook_type               text,
  hook_evidence_ids       jsonb not null default '[]'::jsonb,

  status                  text not null default 'LOCKED'
                           check (status in ('LOCKED', 'SUPERSEDED')),
  -- `deferrable initially deferred` : un relock met à jour l'ancienne ligne
  -- (superseded_by = <id de la nouvelle>) avant que la nouvelle ligne
  -- n'existe — nécessaire pour que l'UPDATE précède l'INSERT et que l'index
  -- partiel `r6b_dispatch_manifests_one_locked_idx` ne voie jamais deux
  -- lignes LOCKED du même item en même temps (voir `lockManifestForItem`).
  superseded_by           uuid references r6b_dispatch_manifests(id) deferrable initially deferred,
  superseded_at           timestamptz,

  locked_at                timestamptz not null default now(),
  created_at               timestamptz not null default now(),

  constraint r6b_manifest_superseded_fields check (
    (status = 'LOCKED' and superseded_by is null and superseded_at is null)
    or (status = 'SUPERSEDED' and superseded_by is not null and superseded_at is not null)
  )
);

create index r6b_dispatch_manifests_batch_idx on r6b_dispatch_manifests (batch_id, locked_at desc);
create index r6b_dispatch_manifests_item_idx on r6b_dispatch_manifests (batch_item_id, locked_at desc);

-- Au plus un manifeste LOCKED par item à la fois : c'est la garantie qu'un
-- futur sender qui demande "le manifeste courant de cet item" ne trouve
-- jamais deux réponses possibles.
create unique index r6b_dispatch_manifests_one_locked_idx
  on r6b_dispatch_manifests (batch_item_id)
  where status = 'LOCKED';

-- ---------------------------------------------------------------------------
-- Learning telemetry (§10–§17) — schéma minimal, événements bruts d'abord.
-- ---------------------------------------------------------------------------
--
-- Réutilise `outreach_events` / `conversations` / `conversation_messages` /
-- `reply_classifications` (0001, « future outreach lifecycle, unused in V1 »)
-- plutôt que de dupliquer des colonnes — ces tables existent déjà pour
-- exactement cet usage et sont vides en production à ce jour.

-- Un futur envoi réel devra référencer le manifeste verrouillé dont il est
-- l'exécution — c'est la seule façon pour un sender de prouver qu'il a
-- respecté §3 (rien de dynamique) plutôt que de reconstruire canal/texte.
alter table outreach_events
  add column manifest_id uuid references r6b_dispatch_manifests(id);

create index outreach_events_manifest_idx on outreach_events (manifest_id) where manifest_id is not null;

-- Stage conversationnel (§13) — représentation simple, pas de state machine :
-- une seule valeur courante par conversation, jamais recalculée en dehors
-- d'une mise à jour explicite d'un futur outil de suivi.
alter table conversations
  add column stage text not null default 'FIRST_TOUCH_SENT'
    check (stage in (
      'FIRST_TOUCH_SENT', 'REPLIED', 'DISCOVERY', 'INTEREST_CONFIRMED',
      'MEETING_PROPOSED', 'MEETING_BOOKED', 'PROPOSAL', 'WON', 'LOST'
    )),
  add column manifest_id uuid references r6b_dispatch_manifests(id);

-- Taxonomie de réponse (§12) — remplace l'énumération générique posée en
-- 0001 (`interested/not_interested/later/question/unsubscribe/spam/other`,
-- jamais utilisée en production : la table est vide, voir ci-dessus) par la
-- taxonomie explicitement demandée. Évolutive par construction (§12 : « elle
-- doit pouvoir évoluer ») — un futur ALTER ajoutera des valeurs sans migration
-- de données puisqu'aucune ligne n'existe encore.
alter table reply_classifications drop constraint reply_classifications_label_check;
alter table reply_classifications add constraint reply_classifications_label_check
  check (label in (
    'NO_REPLY', 'NEUTRAL_REPLY', 'POSITIVE_REPLY', 'NEGATIVE_REPLY',
    'NOT_INTERESTED', 'ALREADY_HAS_PROVIDER', 'FULL_CAPACITY', 'ASKED_FOR_INFO',
    'INTERESTED', 'MEETING_INTENT', 'UNSUBSCRIBE', 'WRONG_PERSON'
  ));

-- Edits humains sur un futur brouillon de réponse (§15) : la transformation
-- IA → un opérateur est une donnée d'apprentissage de première classe, jamais
-- écrasée. `ai_draft` ne bouge jamais après insertion — même patron que
-- `r6b_batch_items.original_draft` (0018). Distinct de `r6b_batch_votes`,
-- qui couvre le premier message sortant : ceci couvre les réponses à une
-- conversation entrante, qui n'existent qu'une fois qu'une réponse est reçue.
create table reply_drafts (
  id                       uuid primary key default gen_random_uuid(),
  conversation_id          uuid not null references conversations(id) on delete cascade,
  conversation_message_id  uuid references conversation_messages(id) on delete set null,

  ai_draft                 text not null,
  human_edited_text        text,
  sent_text                text,

  created_at               timestamptz not null default now()
);

create index reply_drafts_conversation_idx on reply_drafts (conversation_id, created_at desc);

-- Jalons de résultat commercial (§11 : qualified/meeting_booked/proposal_sent
-- /won/lost) — journal append-only plutôt que des booléens mutables sur
-- `prospects`, pour ne perdre aucun historique (ex. meeting_booked puis lost)
-- et parce que §14 demande de stocker les événements bruts avant tout
-- coefficient. Le statut courant d'un jalon = sa ligne la plus récente ;
-- `outcome_updated_at` (§11) = `max(created_at)` sur ce prospect, dérivé,
-- jamais stocké séparément.
create table prospect_milestones (
  id             uuid primary key default gen_random_uuid(),
  prospect_id    uuid not null references prospects(id) on delete cascade,
  milestone      text not null
                   check (milestone in ('qualified', 'meeting_booked', 'proposal_sent', 'won', 'lost')),
  occurred_at    timestamptz not null default now(),
  note           text,
  created_at     timestamptz not null default now()
);

create index prospect_milestones_prospect_idx on prospect_milestones (prospect_id, created_at desc);
