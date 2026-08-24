-- 0001_init.sql — Hermes core schema.
-- Dialect: PostgreSQL 15+. Runs unchanged on PGlite (local) and Supabase (later).
-- Design rules:
--   * every externally-observed fact lands in prospect_evidence with a provenance
--   * prospects is the canonical entity; identity resolution keeps it 1 row / business
--   * nothing in here sends anything: outreach tables exist but V1 only writes drafts

-- ---------------------------------------------------------------------------
-- campaigns
-- ---------------------------------------------------------------------------
create table campaigns (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  niche_key     text not null,
  status        text not null default 'draft'
                  check (status in ('draft', 'running', 'paused', 'done', 'failed')),
  config        jsonb not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table campaign_runs (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references campaigns(id) on delete cascade,
  status        text not null default 'running'
                  check (status in ('running', 'succeeded', 'failed', 'cancelled')),
  stages        jsonb not null default '[]'::jsonb,
  stats         jsonb not null default '{}'::jsonb,
  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create index campaign_runs_campaign_idx on campaign_runs (campaign_id, started_at desc);

-- ---------------------------------------------------------------------------
-- prospects — the canonical business entity
-- ---------------------------------------------------------------------------
create table prospects (
  id                 uuid primary key default gen_random_uuid(),
  campaign_id        uuid not null references campaigns(id) on delete cascade,

  -- identity
  canonical_key      text not null,          -- strongest available identity key
  display_name       text not null,
  legal_name         text,
  brand_name         text,                   -- enseigne
  registry_id        text,                   -- SIREN (FR)
  registry_source    text,

  -- location
  country            text not null default 'FR',
  address_line       text,
  postal_code        text,
  city               text,
  department         text,
  region             text,
  latitude           double precision,
  longitude          double precision,

  -- contact / digital footprint (nullable on purpose: absence is not a fact)
  domain             text,
  website_url        text,
  instagram_handle   text,
  facebook_url       text,
  email              text,
  phone              text,
  google_place_id    text,
  google_rating      numeric(2, 1),
  google_review_count integer,

  -- pipeline
  stage              text not null default 'discovered'
                       check (stage in ('discovered', 'enriched', 'qualified', 'researched',
                                        'message_ready', 'approved', 'rejected', 'excluded')),
  niche_verdict      text check (niche_verdict in ('in_niche', 'adjacent', 'out_of_niche', 'uncertain')),
  niche_confidence   numeric(3, 2),
  score              integer check (score between 0 and 100),
  score_band         text check (score_band in ('A', 'B', 'C', 'D')),

  -- deduplication
  dedupe_status      text not null default 'unique'
                       check (dedupe_status in ('unique', 'merged', 'needs_review')),
  merged_into_id     uuid references prospects(id) on delete set null,

  first_seen_at      timestamptz not null default now(),
  last_enriched_at   timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (campaign_id, canonical_key)
);

create index prospects_campaign_stage_idx on prospects (campaign_id, stage);
create index prospects_score_idx on prospects (campaign_id, score desc nulls last);
create index prospects_registry_idx on prospects (registry_id) where registry_id is not null;
create index prospects_domain_idx on prospects (domain) where domain is not null;

-- Identity keys extracted from a prospect, used for cross-source dedup.
create table prospect_identities (
  id            uuid primary key default gen_random_uuid(),
  prospect_id   uuid not null references prospects(id) on delete cascade,
  campaign_id   uuid not null references campaigns(id) on delete cascade,
  kind          text not null
                  check (kind in ('registry_id', 'domain', 'email', 'phone', 'instagram',
                                  'facebook', 'google_place_id', 'name_city', 'geo_name')),
  value         text not null,               -- already normalised
  weight        numeric(3, 2) not null default 1.0,
  created_at    timestamptz not null default now(),
  unique (campaign_id, kind, value, prospect_id)
);

create index prospect_identities_lookup_idx on prospect_identities (campaign_id, kind, value);

-- Uncertain merges stay here for human arbitration instead of silently merging.
create table prospect_merge_candidates (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references campaigns(id) on delete cascade,
  left_id       uuid not null references prospects(id) on delete cascade,
  right_id      uuid not null references prospects(id) on delete cascade,
  similarity    numeric(3, 2) not null,
  signals       jsonb not null default '{}'::jsonb,
  status        text not null default 'pending'
                  check (status in ('pending', 'merged', 'rejected')),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  unique (campaign_id, left_id, right_id)
);

-- ---------------------------------------------------------------------------
-- provenance
-- ---------------------------------------------------------------------------
create table prospect_sources (
  id            uuid primary key default gen_random_uuid(),
  prospect_id   uuid not null references prospects(id) on delete cascade,
  role          text not null check (role in ('discovery', 'enrichment')),
  provider      text not null,               -- sirene | overpass | website | google_places | ...
  external_id   text,                        -- provider-native id when it exists
  url           text,
  payload       jsonb,                       -- raw provider record, kept verbatim
  collected_at  timestamptz not null default now(),
  unique (prospect_id, provider, external_id)
);

create index prospect_sources_prospect_idx on prospect_sources (prospect_id);

-- One row per observed fact. Never write a row you did not actually observe.
create table prospect_evidence (
  id            uuid primary key default gen_random_uuid(),
  prospect_id   uuid not null references prospects(id) on delete cascade,
  field         text not null,               -- website_url | instagram_handle | services | ...
  value_text    text,
  value_json    jsonb,
  provider      text not null,
  method        text not null check (method in ('api', 'crawl', 'derived', 'llm', 'manual')),
  source_url    text,
  confidence    numeric(3, 2) not null default 1.0,
  observed_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index prospect_evidence_prospect_idx on prospect_evidence (prospect_id, field);

-- ---------------------------------------------------------------------------
-- qualification
-- ---------------------------------------------------------------------------
create table prospect_classifications (
  id                uuid primary key default gen_random_uuid(),
  prospect_id       uuid not null references prospects(id) on delete cascade,
  verdict           text not null check (verdict in ('in_niche', 'adjacent', 'out_of_niche', 'uncertain')),
  confidence        numeric(3, 2) not null,
  decided_by        text not null check (decided_by in ('deterministic', 'llm', 'human')),
  reasons           jsonb not null default '[]'::jsonb,
  evidence_refs     jsonb not null default '[]'::jsonb,
  model_run_id      uuid,
  created_at        timestamptz not null default now()
);

create index prospect_classifications_prospect_idx on prospect_classifications (prospect_id, created_at desc);

create table prospect_scores (
  id                uuid primary key default gen_random_uuid(),
  prospect_id       uuid not null references prospects(id) on delete cascade,
  campaign_id       uuid not null references campaigns(id) on delete cascade,
  profile_key       text not null,           -- scoring profile used
  profile_version   text not null,
  total             integer not null check (total between 0 and 100),
  band              text not null check (band in ('A', 'B', 'C', 'D')),
  deterministic     jsonb not null default '{}'::jsonb,  -- signal -> {value, points, max, evidence}
  llm_observations  jsonb not null default '{}'::jsonb,  -- qualitative, clearly separated
  weights           jsonb not null default '{}'::jsonb,
  missing_signals   jsonb not null default '[]'::jsonb,  -- what could not be observed
  model_run_id      uuid,
  created_at        timestamptz not null default now()
);

create index prospect_scores_prospect_idx on prospect_scores (prospect_id, created_at desc);

-- ---------------------------------------------------------------------------
-- research / angle / message
-- ---------------------------------------------------------------------------
create table prospect_research (
  id                uuid primary key default gen_random_uuid(),
  prospect_id       uuid not null references prospects(id) on delete cascade,
  summary           text not null,
  observations      jsonb not null default '[]'::jsonb,  -- [{text, evidence_id, source_url, confidence}]
  opportunities     jsonb not null default '[]'::jsonb,
  unknowns          jsonb not null default '[]'::jsonb,  -- explicitly "not observed"
  confidence        numeric(3, 2) not null default 0.5,
  model_run_id      uuid,
  created_at        timestamptz not null default now()
);

create index prospect_research_prospect_idx on prospect_research (prospect_id, created_at desc);

create table prospect_angles (
  id                uuid primary key default gen_random_uuid(),
  prospect_id       uuid not null references prospects(id) on delete cascade,
  research_id       uuid references prospect_research(id) on delete set null,
  pain_point        text not null,
  opportunity       text not null,
  approach          text not null,
  personalization   text not null,           -- the concrete, grounded hook
  personalization_evidence jsonb not null default '[]'::jsonb,
  use_case_study    boolean not null default false,
  case_study_key    text,
  confidence        numeric(3, 2) not null default 0.5,
  model_run_id      uuid,
  created_at        timestamptz not null default now()
);

create index prospect_angles_prospect_idx on prospect_angles (prospect_id, created_at desc);

create table outreach_messages (
  id                  uuid primary key default gen_random_uuid(),
  prospect_id         uuid not null references prospects(id) on delete cascade,
  campaign_id         uuid not null references campaigns(id) on delete cascade,
  angle_id            uuid references prospect_angles(id) on delete set null,
  channel             text not null default 'instagram_dm'
                        check (channel in ('instagram_dm', 'email', 'sms', 'phone', 'other')),
  variant             text not null default 'A' check (variant in ('A', 'B')),
  is_primary          boolean not null default true,
  subject             text,
  body                text not null,
  state               text not null default 'draft'
                        check (state in ('draft', 'approved', 'rejected')),
  personalization_level text not null default 'low'
                        check (personalization_level in ('none', 'low', 'medium', 'high')),
  rationale           text,
  used_facts          jsonb not null default '[]'::jsonb,   -- evidence ids actually referenced
  guardrail_flags     jsonb not null default '[]'::jsonb,   -- automated checks that fired
  reviewed_by         text,
  reviewed_at         timestamptz,
  review_note         text,
  model_run_id        uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index outreach_messages_prospect_idx on outreach_messages (prospect_id, created_at desc);
create index outreach_messages_state_idx on outreach_messages (campaign_id, state);

-- ---------------------------------------------------------------------------
-- future outreach lifecycle (created now, unused in V1)
-- ---------------------------------------------------------------------------
create table outreach_events (
  id            uuid primary key default gen_random_uuid(),
  prospect_id   uuid not null references prospects(id) on delete cascade,
  message_id    uuid references outreach_messages(id) on delete set null,
  kind          text not null
                  check (kind in ('sent', 'delivered', 'failed', 'opened', 'replied',
                                  'follow_up', 'stopped', 'bounced')),
  channel       text not null,
  payload       jsonb not null default '{}'::jsonb,
  occurred_at   timestamptz not null default now()
);

create index outreach_events_prospect_idx on outreach_events (prospect_id, occurred_at desc);

create table conversations (
  id            uuid primary key default gen_random_uuid(),
  prospect_id   uuid not null references prospects(id) on delete cascade,
  channel       text not null,
  external_ref  text,
  status        text not null default 'open' check (status in ('open', 'closed', 'stopped')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table conversation_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  direction        text not null check (direction in ('inbound', 'outbound')),
  body             text not null,
  occurred_at      timestamptz not null default now()
);

create table reply_classifications (
  id                       uuid primary key default gen_random_uuid(),
  conversation_message_id  uuid not null references conversation_messages(id) on delete cascade,
  label                    text not null
                             check (label in ('interested', 'not_interested', 'later',
                                              'question', 'unsubscribe', 'spam', 'other')),
  confidence               numeric(3, 2) not null,
  model_run_id             uuid,
  created_at               timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- exclusion list — exists from day one
-- ---------------------------------------------------------------------------
create table do_not_contact (
  id            uuid primary key default gen_random_uuid(),
  match_kind    text not null
                  check (match_kind in ('registry_id', 'domain', 'email', 'phone', 'instagram', 'name_city')),
  value         text not null,               -- normalised
  reason        text not null,
  added_by      text not null default 'system',
  created_at    timestamptz not null default now(),
  unique (match_kind, value)
);

-- ---------------------------------------------------------------------------
-- observability
-- ---------------------------------------------------------------------------
create table model_runs (
  id             uuid primary key default gen_random_uuid(),
  task           text not null,              -- classification | research | angle | message | ...
  provider       text not null,              -- codex | openai_compatible | none
  model          text not null,
  effort         text,
  input_ref      text,                       -- e.g. prospect:<uuid>
  input_hash     text not null,
  prompt_chars   integer,
  status         text not null check (status in ('ok', 'error', 'skipped', 'timeout')),
  output         jsonb,
  error          text,
  duration_ms    integer,
  tokens_input   integer,
  tokens_output  integer,
  cost_usd       numeric(10, 6),
  created_at     timestamptz not null default now()
);

create index model_runs_task_idx on model_runs (task, created_at desc);
create index model_runs_input_ref_idx on model_runs (input_ref);

-- Result of probing what the installed providers actually support.
create table model_capabilities (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,
  model         text not null,
  effort        text,
  supported     boolean not null,
  latency_ms    integer,
  error         text,
  checked_at    timestamptz not null default now(),
  unique (provider, model, effort)
);

create table audit_events (
  id            uuid primary key default gen_random_uuid(),
  actor         text not null default 'system',
  action        text not null,
  entity_type   text,
  entity_id     text,
  data          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index audit_events_created_idx on audit_events (created_at desc);

-- Cache for outbound HTTP so re-runs are cheap and idempotent.
create table http_cache (
  cache_key     text primary key,
  url           text not null,
  status        integer not null,
  body          text,
  content_type  text,
  fetched_at    timestamptz not null default now()
);
