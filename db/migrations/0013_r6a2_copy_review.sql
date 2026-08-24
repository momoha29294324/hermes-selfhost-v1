-- 0013_r6a2_copy_review.sql — R6A.2, review humaine aveugle du premier message
-- personnalisé (mission « Hermes R6A.2 — Personalized First-Touch
-- Calibration »).
--
-- Suite de 0012 (R6A.1), avec une différence structurelle qui justifie de
-- nouvelles tables plutôt qu'une réutilisation :
--
--   R6A.1 comparait TOUJOURS trois messages. Trois colonnes `display_x_style`
--   NOT NULL exprimaient exactement cela.
--
--   R6A.2 compare le nombre de variantes réellement disponibles pour CE
--   prospect — parfois trois, parfois deux, parfois une. Le §10 de la mission
--   l'impose : « si un prospect n'a pas trois catégories de hooks réellement
--   disponibles, ne fabrique PAS artificiellement trois messages ». Un schéma
--   qui exige trois colonnes remplies rendrait cette règle impossible à
--   respecter — il faudrait inventer un message pour satisfaire une contrainte
--   NOT NULL, ce qui est précisément l'erreur que la mission interdit.
--
-- Une seconde raison, moins évidente, de ne pas réutiliser 0012 : un même
-- message peut représenter PLUSIEURS stratégies. P2 (« réputation ») et P3
-- (« meilleur hook ») retiennent le même hook dès qu'un prospect affiche ses
-- avis — même hook, même prompt, donc un seul message, qui compte pour les
-- deux. Un mapping « une colonne = une stratégie » ne sait pas exprimer cela ;
-- il faudrait générer deux tirages du même prompt et les présenter comme deux
-- approches, ce qui est le faux benchmark que §10 interdit.
--
-- Les emplacements sont donc du JSON ordonné : `display_slots->0` est ce que
-- un opérateur voit sous « MESSAGE A », `->1` sous « MESSAGE B », etc. Chacun porte
-- les stratégies qu'il représente et le hook sur lequel il repose :
--   [{"variants": ["style_p2", "style_p3"], "hookId": "reputation:…"}, …]

-- ---------------------------------------------------------------------------
-- 1. Le mapping aveugle, un par prospect du corpus gelé.
-- ---------------------------------------------------------------------------
create table r6a2_review_items (
  id            uuid primary key default gen_random_uuid(),
  corpus_hash   text not null,
  prospect_ref  text not null,
  -- Ordre d'affichage stable (« Prospect N/12 »), attribué à la génération à
  -- partir de l'ordre du corpus gelé — jamais recalculé à la volée.
  item_index    integer not null,
  seed          text not null,
  -- Jamais lu par le chemin de vote : seulement par le chemin de reveal, gardé
  -- derrière la vérification que tous les prospects ont été votés (§11).
  display_slots jsonb not null check (
    jsonb_typeof(display_slots) = 'array'
    and jsonb_array_length(display_slots) between 1 and 3
  ),
  created_at    timestamptz not null default now(),
  unique (corpus_hash, prospect_ref),
  unique (corpus_hash, item_index)
);

-- ---------------------------------------------------------------------------
-- 2. Les votes, un journal append-only.
-- ---------------------------------------------------------------------------
-- 'NONE' est le chiffre qui décide de R6A.2 (§12) : R6A.1 a produit 11 NONE
-- sur 12, et le critère de réussite est la chute de ce nombre — pas la victoire
-- d'un style. Il a donc son propre sens ici, distinct d'une simple égalité :
-- « aucun de ces messages ne me convient ».
create table r6a2_review_votes (
  id                 uuid primary key default gen_random_uuid(),
  item_id            uuid not null references r6a2_review_items(id) on delete cascade,
  prospect_ref       text not null,
  randomization_seed text not null,
  display_order      integer not null,
  preference         text not null check (preference in ('A', 'B', 'C', 'NONE')),
  verdict            text check (verdict in ('SEND', 'EDIT', 'REJECT')),
  note               text,
  is_correction      boolean not null default false,
  created_at         timestamptz not null default now()
);

create index r6a2_review_votes_item_idx on r6a2_review_votes (item_id, created_at desc);
