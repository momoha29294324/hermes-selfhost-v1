-- 0017_r6a4_final_human_review.sql — R6A.4, DERNIÈRE review humaine du premier
-- message (mission « Hermes R6A.4 — Final Human Voice »).
--
-- Nouvelles tables plutôt qu'une réutilisation de 0016 : R6A.3 a été voté
-- (2 SEND / 3 EDIT / 0 REJECT = PARTIAL) et ce verdict doit rester lisible tel
-- quel. R6A.4 rejuge les mêmes 5 prospects et les mêmes hooks (§17), mais sur
-- des messages produits par un autre prompt — écraser 0016 effacerait la
-- comparaison qui justifie l'existence de ce tour.
--
-- Le texte édité est stocké tel quel (`edited_body`), jamais recalculé ni
-- re-validé par un garde-fou : c'est la dernière main humaine avant un envoi
-- qui n'existe toujours pas (`OUTBOUND_ALLOW_SENDING` reste à 0 — CLAUDE.md,
-- §27).

create table r6a4_review_items (
  id            uuid primary key default gen_random_uuid(),
  corpus_hash   text not null,
  prospect_ref  text not null,
  -- Ordre d'affichage stable (« Prospect N/5 »), attribué depuis l'ordre du
  -- sous-corpus §17 — jamais recalculé à la volée. C'est aussi l'index que la
  -- passe de relecture du lot (§16) manipule, donc les deux doivent coïncider.
  item_index    integer not null,
  created_at    timestamptz not null default now(),
  unique (corpus_hash, prospect_ref),
  unique (corpus_hash, item_index)
);

-- Journal append-only, comme 0012–0016 : une seconde soumission sur le même
-- item est une correction journalisée, jamais un écrasement silencieux.
create table r6a4_review_votes (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references r6a4_review_items(id) on delete cascade,
  prospect_ref  text not null,
  verdict       text not null check (verdict in ('SEND', 'EDIT', 'REJECT')),
  -- Rempli pour SEND (texte inchangé) et EDIT (texte corrigé) ; nul pour
  -- REJECT, où aucun texte final n'existe.
  edited_body   text,
  note          text,
  is_correction boolean not null default false,
  created_at    timestamptz not null default now(),
  constraint r6a4_edited_body_present check (
    (verdict in ('SEND', 'EDIT') and edited_body is not null and length(trim(edited_body)) > 0)
    or (verdict = 'REJECT' and edited_body is null)
  )
);

create index r6a4_review_votes_item_idx on r6a4_review_votes (item_id, created_at desc);
