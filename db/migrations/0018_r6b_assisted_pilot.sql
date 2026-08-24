-- 0018_r6b_assisted_pilot.sql — R6B-A, premier vrai mini-batch commercial
-- (mission « Hermes R6B-A — First Real Assisted Batch »).
--
-- R6A a fermé l'architecture (research → angle → message guidé par le gold
-- set → review humaine). R6B-A ne change rien à cette architecture : elle
-- l'applique à cinq vrais prospects, pour la première fois, et a besoin d'un
-- batch identifiable et persistant plutôt que d'un corpus figé de benchmark.
--
-- Nouvelles tables plutôt que réutilisation de `outreach_messages` seule :
-- `outreach_messages` porte déjà `state`/`reviewed_by`/`review_note`, mais pas
-- de notion de batch, ni la trace explicite « draft d'origine jamais perdu +
-- texte approuvé exact » que le §16 de la mission exige. Le patron retenu est
-- celui, déjà éprouvé, de 0016/0017 (`r6a3_review_items`/`r6a4_review_items` +
-- vote append-only) : un item immuable une fois généré, un journal de votes
-- qui ne remplace jamais silencieusement un vote précédent.
--
-- Sémantique du §16 : SEND et EDIT approuvent tous les deux un texte final
-- (`approved = true`, `approved_text`, `approved_at`) ; REJECT n'approuve rien
-- (`approved = false`, `approved_text` et `approved_at` nuls). Le brouillon
-- original reste sur l'item (`original_draft`), jamais recalculé, jamais
-- écrasé par une correction ultérieure.

create table r6b_batches (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  campaign_id   uuid not null references campaigns(id),
  created_at    timestamptz not null default now()
);

-- Un item par prospect du batch, généré une seule fois. `unique (batch_id,
-- prospect_id)` empêche un prospect d'apparaître deux fois dans le même
-- batch ; `unique (batch_id, item_index)` fixe un ordre d'affichage stable
-- (« Prospect N/5 »), attribué à la génération, jamais recalculé à la volée.
create table r6b_batch_items (
  id                  uuid primary key default gen_random_uuid(),
  batch_id            uuid not null references r6b_batches(id) on delete cascade,
  prospect_id         uuid not null references prospects(id),
  item_index          integer not null,

  research_id         uuid references prospect_research(id),
  angle_id            uuid references prospect_angles(id),
  model_run_id        uuid,

  -- Le brouillon exact produit par le pipeline de production (gpt-5.6-sol,
  -- gold set R6A). Jamais réécrit après coup : c'est la référence par rapport
  -- à laquelle un EDIT humain se mesure.
  original_draft      text not null,

  -- evidence_ids du hook de personnalisation utilisé (angle.personalization_evidence)
  -- — traçabilité du fait vérifié qui a produit l'accroche.
  hook_evidence_ids    jsonb not null default '[]'::jsonb,

  -- Canaux de contact réellement observés au moment de la génération (§7) —
  -- pas une politique d'envoi, une photographie du joignable.
  contact_channels     jsonb not null default '[]'::jsonb,

  -- §6 : jamais d'affirmation "not_contacted" non vérifiable. `not_contacted`
  -- n'est écrit que lorsque `outreach_events` est structurellement vide pour
  -- ce prospect au moment de la génération ; sinon `unknown`, jamais supposé.
  contact_history      text not null default 'unknown'
                          check (contact_history in ('not_contacted', 'unknown')),

  guardrail_flags      jsonb not null default '[]'::jsonb,

  created_at           timestamptz not null default now(),
  unique (batch_id, prospect_id),
  unique (batch_id, item_index)
);

create index r6b_batch_items_batch_idx on r6b_batch_items (batch_id, item_index);

-- Journal de review append-only (patron 0011–0017) : une seconde soumission
-- sur le même item est une correction journalisée (`is_correction = true`),
-- jamais un écrasement silencieux du vote précédent. La ligne la plus récente
-- par `item_id` est le statut courant.
create table r6b_batch_votes (
  id             uuid primary key default gen_random_uuid(),
  item_id        uuid not null references r6b_batch_items(id) on delete cascade,
  verdict        text not null check (verdict in ('SEND', 'EDIT', 'REJECT')),

  -- §16 : SEND et EDIT approuvent un texte ("approuvé pour un futur envoi",
  -- jamais "envoyé maintenant" — voir §15/§17). REJECT n'approuve rien.
  approved       boolean not null,
  approved_text  text,
  approved_at    timestamptz,

  note           text,
  is_correction  boolean not null default false,
  created_at     timestamptz not null default now(),

  constraint r6b_vote_verdict_matches_approved check (
    (verdict in ('SEND', 'EDIT') and approved = true)
    or (verdict = 'REJECT' and approved = false)
  ),
  constraint r6b_vote_approved_text_present check (
    (approved = true and approved_text is not null and length(trim(approved_text)) > 0
       and approved_at is not null)
    or (approved = false and approved_text is null and approved_at is null)
  )
);

create index r6b_batch_votes_item_idx on r6b_batch_votes (item_id, created_at desc);
