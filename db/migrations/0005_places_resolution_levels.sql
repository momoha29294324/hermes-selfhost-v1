-- 0005_places_resolution_levels.sql — R2.1.
--
-- R2 recorded identification as a binary: a candidate was `identified` or
-- `unidentified`. That is enough to decide whether to write a prospect, and not
-- enough to answer the question the R2.1 gate exists to answer, which is where
-- the funnel actually leaks:
--
--   - Places found a real artisan, the registry confirmed it beyond doubt;
--   - Places found a real artisan, the match is likely but not certain;
--   - Places found something, nothing independent could pin it down;
--   - Places found nothing that any independent source has ever heard of.
--
-- "PARTIAL because independent resolution is insufficient" and "FAIL because the
-- discovery is poor" look identical under a boolean and completely different
-- under these four. So the verdict needs the distinction, and a benchmark that
-- cannot produce it cannot justify its own conclusion.
--
-- Only `confirmed` and `probable` may become a prospect. `uncertain` and
-- `not_found` stay place IDs with a reason — counted, never invented into a
-- business.

alter table google_place_candidates
  add column resolution text
    check (resolution in ('confirmed', 'probable', 'uncertain', 'not_found')),
  -- Which independent source answered, and how strongly. Never a Google value:
  -- this describes OUR evidence about the candidate, not Google's content.
  add column resolution_provider text,
  add column resolution_confidence double precision
    check (resolution_confidence >= 0 and resolution_confidence <= 1),
  add column resolution_source_url text;

create index google_place_candidates_resolution_idx
  on google_place_candidates (campaign_id, resolution);

comment on column google_place_candidates.resolution is
  'Force de l''identification par une source INDÉPENDANTE. Seuls confirmed et probable '
  'peuvent devenir un prospect ; uncertain et not_found restent des place_id avec un motif.';
comment on column google_place_candidates.resolution_provider is
  'Source indépendante qui a répondu (sirene, website). Jamais « google_places ».';
