-- 0016_r6a3_final5_review.sql — R6A.3, review humaine du premier message final
-- sur 5 prospects seulement (mission « Hermes R6A.3 — Final
-- First-Touch Calibration »).
--
-- Nouvelles tables plutôt qu'une réutilisation de 0014/0015 : R6A.3 n'est pas
-- un nouveau vote sur le même lot de 12, c'est un sous-corpus de 5 prospects
-- avec un prompt qui ne reçoit plus l'angle commercial (§8). Les verdicts de
-- R6A.2b (0 SEND / 11 EDIT / 1 REJECT) et R6A.2c doivent rester lisibles tels
-- quels une fois R6A.3 voté (§15 : « ne supprime pas les pages historiques »).
--
-- Le texte édité est stocké tel quel (`edited_body`), jamais recalculé ni
-- re-validé par un garde-fou : c'est la dernière main humaine avant un envoi
-- qui n'existe toujours pas (`OUTBOUND_ALLOW_SENDING` reste à 0 — CLAUDE.md).

create table r6a3_review_items (
  id            uuid primary key default gen_random_uuid(),
  corpus_hash   text not null,
  prospect_ref  text not null,
  -- Ordre d'affichage stable (« Prospect N/5 »), attribué à la génération à
  -- partir de l'ordre du corpus gelé — jamais recalculé à la volée.
  item_index    integer not null,
  created_at    timestamptz not null default now(),
  unique (corpus_hash, prospect_ref),
  unique (corpus_hash, item_index)
);

-- Un journal append-only, comme 0012–0015 : une seconde soumission sur le
-- même item est une correction journalisée, jamais un écrasement silencieux.
create table r6a3_review_votes (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references r6a3_review_items(id) on delete cascade,
  prospect_ref  text not null,
  verdict       text not null check (verdict in ('SEND', 'EDIT', 'REJECT')),
  -- Le texte final tel que un opérateur l'a laissé dans le champ d'édition.
  -- Rempli pour SEND (texte inchangé) et EDIT (texte corrigé) ; nul pour
  -- REJECT, où aucun texte final n'existe.
  edited_body   text,
  note          text,
  is_correction boolean not null default false,
  created_at    timestamptz not null default now(),
  constraint r6a3_edited_body_present check (
    (verdict in ('SEND', 'EDIT') and edited_body is not null and length(trim(edited_body)) > 0)
    or (verdict = 'REJECT' and edited_body is null)
  )
);

create index r6a3_review_votes_item_idx on r6a3_review_votes (item_id, created_at desc);
