-- 0002_case_studies.sql — structured social proof.
-- V1 ships exactly one claim, worded conservatively, with no invented metrics.
-- The table is shaped so future case studies can carry real, sourced metrics.

create table case_studies (
  id                uuid primary key default gen_random_uuid(),
  key               text not null unique,
  client_label      text not null,           -- may be anonymised
  niche_key         text,
  claim             text not null,           -- the exact sentence the agent is allowed to write
  metrics           jsonb not null default '[]'::jsonb,  -- [{name, value, unit, period, source}]
  proof_url         text,
  is_approved       boolean not null default false,
  usable_from       timestamptz not null default now(),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

insert into case_studies (key, client_label, niche_key, claim, metrics, is_approved, notes)
values (
  'hermes_client_3500',
  'client accompagné par Hermes',
  null,
  'Nous avons déjà généré environ 3 500 € pour un client que nous accompagnons.',
  '[]'::jsonb,
  true,
  'Seule affirmation autorisée en V1. Aucune métrique complémentaire (ROAS, leads, période, budget, marge, attribution) n''est connue : ne rien ajouter tant qu''une métrique sourcée n''est pas enregistrée dans metrics.'
);
