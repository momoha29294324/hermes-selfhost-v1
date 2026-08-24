-- 0012_r6a1_copy_review.sql — R6A.1, review humaine aveugle A/B/C du premier
-- message (mission "Hermes R6A.1 — First-touch Copy Calibration").
--
-- Même principe que 0011 (`human_blind_review_pairs` / `_votes`, l'A/B de
-- R5.1b), étendu à trois styles au lieu de deux modèles : le mapping réel
-- (quel style se cache derrière l'étiquette A/B/C affichée à un opérateur) vit
-- dans une table que l'écran de vote ne lit jamais ; les votes sont un
-- journal append-only, jamais un écrasement.
--
-- Différence avec 0011 : ici les trois messages viennent du MÊME modèle
-- (`gpt-5.6-sol`/`medium`, tâche `message`, non modifié) — la variable
-- comparée est le style de prompt, pas le modèle. Le mapping stocke donc une
-- clé de style ('style_a' | 'style_b' | 'style_c'), pas une clé de modèle.

-- ---------------------------------------------------------------------------
-- 1. Le mapping A/B/C, un par prospect du corpus gelé R6A.1 (12 prospects).
-- ---------------------------------------------------------------------------
create table r6a1_review_items (
  id              uuid primary key default gen_random_uuid(),
  corpus_hash     text not null,
  prospect_ref    text not null,
  -- Ordre d'affichage stable : « Prospect N/12 ». Attribué à la génération, à
  -- partir de l'ordre du corpus gelé — jamais recalculé à la volée.
  item_index      integer not null,
  seed            text not null,
  -- Style réel assigné à chaque étiquette d'affichage. Jamais sélectionnée
  -- par le chemin de lecture du vote — seulement par le chemin de reveal,
  -- gardé côté serveur derrière la vérification des 12 votes (mission §13).
  display_a_style text not null check (display_a_style in ('style_a', 'style_b', 'style_c')),
  display_b_style text not null check (display_b_style in ('style_a', 'style_b', 'style_c')),
  display_c_style text not null check (display_c_style in ('style_a', 'style_b', 'style_c')),
  created_at      timestamptz not null default now(),
  unique (corpus_hash, prospect_ref),
  unique (corpus_hash, item_index)
);

-- ---------------------------------------------------------------------------
-- 2. Les votes, un journal append-only.
-- ---------------------------------------------------------------------------
-- 'NONE' couvre le bouton unique « ÉGALITÉ / AUCUN » du mockup (mission §12) :
-- aucun des trois ne se distingue nettement, ou aucun ne convient. Le verdict
-- SEND/EDIT/REJECT et la note portent sur le message préféré, comme dans
-- 0011 ; ils restent nuls quand la préférence est 'NONE'.
create table r6a1_review_votes (
  id                  uuid primary key default gen_random_uuid(),
  item_id             uuid not null references r6a1_review_items(id) on delete cascade,
  prospect_ref        text not null,
  randomization_seed  text not null,
  display_order       integer not null,
  preference          text not null check (preference in ('A', 'B', 'C', 'NONE')),
  verdict             text check (verdict in ('SEND', 'EDIT', 'REJECT')),
  note                text,
  is_correction       boolean not null default false,
  created_at          timestamptz not null default now()
);

create index r6a1_review_votes_item_idx on r6a1_review_votes (item_id, created_at desc);
