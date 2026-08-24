-- 0003_places_first_discovery.sql — R2: multi-source discovery, cost control,
-- and the two measurements that decide whether a prospect is worth anything:
-- can we reach them, and can we see their funnel.
--
-- Three ideas, in order of importance:
--   1. A prospect has ORIGINS (plural). Being found on Google Maps and being
--      found in the company registry are two observations of one business, not
--      two prospects, and neither origin is worth more than the other.
--   2. Every paid call is written down BEFORE it is judged affordable, so a bug
--      cannot spend money faster than the ledger can refuse it.
--   3. Provider content that we are only allowed to hold temporarily gets an
--      explicit expiry, enforced in SQL, not in a comment.

-- ---------------------------------------------------------------------------
-- 1. Discovery provenance
-- ---------------------------------------------------------------------------
-- prospect_sources already records every provider that saw a business. This
-- table answers the cheaper question the dashboard and the benchmark ask
-- constantly: "which rails found this prospect, and which one got there first?"
create table prospect_discovery_origins (
  id            uuid primary key default gen_random_uuid(),
  prospect_id   uuid not null references prospects(id) on delete cascade,
  campaign_id   uuid not null references campaigns(id) on delete cascade,
  -- google_places | registry | osm | seed | web_search | manual | social
  provider      text not null,
  -- 'commercial' (rail A) or 'long_tail' (rail B). A rail is a strategy, not a
  -- quality: a long-tail prospect is not a worse prospect.
  rail          text not null check (rail in ('commercial', 'long_tail')),
  external_id   text,
  first_seen_at timestamptz not null default now(),
  unique (prospect_id, provider)
);

create index prospect_discovery_origins_campaign_idx
  on prospect_discovery_origins (campaign_id, provider);

alter table prospects
  -- The rail that created the row. Kept for ordering and reporting only; the
  -- scorer must never read it. A prospect found by both rails keeps the first.
  add column discovery_rail text
    check (discovery_rail in ('commercial', 'long_tail')),
  add column discovery_provider text,

  -- Commercial visibility is NOT business quality. It answers "how observable
  -- is this business from the outside right now" — a small excellent artisan
  -- who only posts on Instagram scores low here and may still be a top prospect.
  add column commercial_visibility integer
    check (commercial_visibility between 0 and 100),

  -- The two R2 measurements. Both are derived from observations by tested code
  -- (src/lib/pipeline/reach.ts) and refreshed whenever evidence changes.
  add column contactable boolean,
  add column contact_channels jsonb not null default '[]'::jsonb,
  add column funnel_observable boolean,
  add column funnel_signal_count integer not null default 0;

create index prospects_discovery_idx on prospects (campaign_id, discovery_rail);
create index prospects_reach_idx on prospects (campaign_id, contactable, funnel_observable);

-- ---------------------------------------------------------------------------
-- 2. Google Places cost ledger
-- ---------------------------------------------------------------------------
-- One row per call actually issued to Google, written inside the same code path
-- that issues it. Cache hits are recorded too, with billable = false, because
-- "how many calls did we avoid" is the number that proves the tiering works.
create table google_places_usage (
  id              uuid primary key default gen_random_uuid(),
  occurred_on     date not null default (now() at time zone 'utc')::date,
  occurred_at     timestamptz not null default now(),
  campaign_slug   text,
  run_id          uuid references campaign_runs(id) on delete set null,
  -- searchText | searchNearby | placeDetails
  endpoint        text not null,
  -- The SKU tier the field mask lands in, as named by Google's current pricing
  -- documentation. Recorded verbatim so a pricing change is a data question.
  sku_tier        text not null,
  field_mask      text not null,
  -- false for a cache hit or a call refused by the budget guard.
  billable        boolean not null default true,
  cache_hit       boolean not null default false,
  results_count   integer not null default 0,
  query           text,
  area_label      text,
  http_status     integer,
  error           text
);

create index google_places_usage_day_idx on google_places_usage (occurred_on, billable);
create index google_places_usage_run_idx on google_places_usage (run_id);

-- ---------------------------------------------------------------------------
-- 3. Places content cache, with an enforced expiry
-- ---------------------------------------------------------------------------
-- Google's terms allow a place ID to be kept indefinitely and other Places
-- content only temporarily. That distinction is the whole point of this table:
-- `place_id` is durable and lives on the prospect row, while `payload` is
-- provider content on a lease and is unreadable past `expires_at`.
create table google_places_cache (
  place_id      text primary key,
  payload       jsonb not null,
  field_mask    text not null,
  sku_tier      text not null,
  fetched_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);

create index google_places_cache_expiry_idx on google_places_cache (expires_at);

-- ---------------------------------------------------------------------------
-- 4. Reproducible discovery ledger
-- ---------------------------------------------------------------------------
-- Every (query, area, page) tuple a discovery source issued, with what it
-- yielded. A benchmark that cannot be replayed is an anecdote.
create table discovery_queries (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid references campaign_runs(id) on delete cascade,
  campaign_id     uuid not null references campaigns(id) on delete cascade,
  provider        text not null,
  query           text not null,
  area_label      text,
  page            integer not null default 0,
  page_token      boolean not null default false,
  raw_results     integer not null default 0,
  new_candidates  integer not null default 0,
  duplicates      integer not null default 0,
  rejected_geo    integer not null default 0,
  rejected_other  integer not null default 0,
  stopped_reason  text,
  created_at      timestamptz not null default now()
);

create index discovery_queries_run_idx on discovery_queries (run_id, provider);
