-- 0011_human_blind_review.sql — R5.1b, review humaine aveugle A/B du message.
--
-- Le juge aveugle de R5.1b (la documentation d’installation, section "Évaluation aveugle")
-- était un sous-agent en contexte froid. Cette migration porte le même test,
-- mais pour un humain (un opérateur), avec un mapping A/B qui doit rester caché
-- jusqu'à la fin des 18 votes plutôt que révélé une fois par un rapport texte.
--
-- Deux tables, pour que le mapping réel et le vote humain vivent à des
-- endroits différents (mission §6 : « le mapping réel doit être stocké
-- séparément »). Le mapping (`human_blind_review_pairs`) n'est jamais lu par
-- l'écran de vote lui-même ; il n'est projeté vers l'UI qu'après que le
-- serveur a vérifié que les 18 votes existent.

-- ---------------------------------------------------------------------------
-- 1. Le mapping A/B, un par prospect du corpus gelé.
-- ---------------------------------------------------------------------------
-- `seed` et la parité qui en dérive sont recalculés au moment de la génération
-- (voir `src/lib/bench/humanReview.ts`) à partir du hash du corpus : même
-- corpus, même seed, même mapping — reproductible sans dépendre d'un aléa non
-- rejouable.
create table human_blind_review_pairs (
  id              uuid primary key default gen_random_uuid(),
  corpus_hash     text not null,
  prospect_ref    text not null,
  -- Ordre d'affichage stable : « Prospect N/18 ». Attribué à la génération, à
  -- partir de l'ordre du corpus gelé — jamais recalculé à la volée.
  pair_index      integer not null,
  seed            text not null,
  -- Modèle réel assigné à chaque étiquette. Colonne jamais sélectionnée par le
  -- chemin de lecture du vote — seulement par le chemin de reveal, gardé côté
  -- serveur derrière la vérification des 18 votes.
  variant_a       text not null,
  variant_b       text not null,
  created_at      timestamptz not null default now(),
  unique (corpus_hash, prospect_ref),
  unique (corpus_hash, pair_index)
);

-- ---------------------------------------------------------------------------
-- 2. Les votes, un journal append-only.
-- ---------------------------------------------------------------------------
-- Un vote n'écrase jamais le précédent : la ligne la plus récente par
-- `pair_id` est le vote courant, et toute ligne antérieure reste lisible comme
-- journal (mission §7 : une modification, si elle a lieu, doit être
-- explicitement journalisée plutôt que remplacer silencieusement l'original).
create table human_blind_review_votes (
  id                  uuid primary key default gen_random_uuid(),
  pair_id             uuid not null references human_blind_review_pairs(id) on delete cascade,
  prospect_ref        text not null,
  randomization_seed  text not null,
  display_order       integer not null,
  preference          text not null check (preference in ('A', 'B', 'TIE')),
  verdict             text check (verdict in ('SEND', 'EDIT', 'REJECT')),
  note                text,
  is_correction       boolean not null default false,
  created_at          timestamptz not null default now()
);

create index human_blind_review_votes_pair_idx on human_blind_review_votes (pair_id, created_at desc);
