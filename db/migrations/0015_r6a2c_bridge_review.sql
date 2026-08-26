-- 0015_r6a2c_bridge_review.sql — R6A.2c, review humaine du premier message
-- avec micro-bridge conversationnel (mission « Hermes R6A.2c —
-- Conversational Bridge »).
--
-- Pourquoi de nouvelles tables plutôt qu'une réutilisation de 0014 (R6A.2b) :
-- le corpus gelé est le même, et `r6a2b_review_items` porte un
-- `unique (corpus_hash, prospect_ref)`. Réutiliser la table ferait entrer les
-- douze items de R6A.2c en collision avec ceux de R6A.2b, ou pire, les ferait
-- passer pour les mêmes. Ce sont deux rounds distincts sur le même corpus :
-- les verdicts de R6A.2b (0 SEND / 11 EDIT / 1 REJECT) doivent rester lisibles
-- tels quels une fois R6A.2c voté.
--
-- Le texte édité est stocké tel quel (`edited_body`), jamais recalculé ni
-- re-validé par un garde-fou : c'est la dernière main humaine avant un envoi
-- qui n'existe toujours pas (`OUTBOUND_ALLOW_SENDING` reste à 0 — CLAUDE.md).

create table r6a2c_review_items (
  id            uuid primary key default gen_random_uuid(),
  corpus_hash   text not null,
  prospect_ref  text not null,
  -- Ordre d'affichage stable (« Prospect N/12 »), attribué à la génération à
  -- partir de l'ordre du corpus gelé — jamais recalculé à la volée.
  item_index    integer not null,
  created_at    timestamptz not null default now(),
  unique (corpus_hash, prospect_ref),
  unique (corpus_hash, item_index)
);

-- Un journal append-only, comme 0012/0013/0014 : une seconde soumission sur le
-- même item est une correction journalisée, jamais un écrasement silencieux.
create table r6a2c_review_votes (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references r6a2c_review_items(id) on delete cascade,
  prospect_ref  text not null,
  verdict       text not null check (verdict in ('SEND', 'EDIT', 'REJECT')),
  -- Le texte final tel qu'un opérateur l'a laissé dans le champ d'édition.
  -- Rempli pour SEND (texte inchangé) et EDIT (texte corrigé) ; nul pour
  -- REJECT, où aucun texte final n'existe.
  edited_body   text,
  note          text,
  is_correction boolean not null default false,
  created_at    timestamptz not null default now(),
  constraint r6a2c_edited_body_present check (
    (verdict in ('SEND', 'EDIT') and edited_body is not null and length(trim(edited_body)) > 0)
    or (verdict = 'REJECT' and edited_body is null)
  )
);

create index r6a2c_review_votes_item_idx on r6a2c_review_votes (item_id, created_at desc);
