import type { Sql } from '@/lib/db/sql';

/**
 * Enforcement of what we are allowed to keep from Google Places, in code rather
 * than in a comment.
 *
 * Two rules, and only two:
 *   - `place_id` may be kept indefinitely (explicit exemption from the caching
 *     restrictions).
 *   - latitude/longitude may be kept for at most 30 consecutive calendar days,
 *     "after which Customer must delete the cached latitude and longitude
 *     values". Deletion is an obligation, not a cleanup nicety.
 *
 * Everything else is never written in the first place, which is why there is no
 * third rule here.
 */

/** Maps Service Specific Terms §14.3. Not a tunable. */
export const PLACES_LOCATION_TTL_DAYS = 30;

/** Documented recommendation, not an obligation: refresh IDs older than a year. */
export const PLACE_ID_REFRESH_AFTER_DAYS = 365;

export function locationExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + PLACES_LOCATION_TTL_DAYS * 24 * 3600 * 1000);
}

export type PlaceCandidateStatus =
  | 'discovered'
  | 'in_area'
  | 'qualified'
  | 'identified'
  | 'unidentified'
  | 'rejected';

/**
 * How strongly an INDEPENDENT source identified a candidate.
 *
 * The threshold between `probable` and `uncertain` is where the compliance rule
 * and the data-quality rule turn out to be the same rule: a match we are not
 * sure of would put a Google-sourced trading name next to somebody else's SIREN,
 * which is simultaneously a wrong prospect and a Google value laundered into the
 * permanent store. Only `confirmed` and `probable` may become a prospect.
 */
export type PlaceResolution = 'confirmed' | 'probable' | 'uncertain' | 'not_found';

export const RESOLUTION_PROSPECTABLE: readonly PlaceResolution[] = ['confirmed', 'probable'];

/**
 * Name agreement above which an independent match is beyond reasonable doubt.
 *
 * Deliberately high. Below it a match is still usable but marked `probable`;
 * below `RESOLUTION_MIN_CONFIDENCE` it is not usable at all.
 */
export const RESOLUTION_CONFIRMED_AT = 0.9;
export const RESOLUTION_MIN_CONFIDENCE = 0.7;

/** Grades one independent match. A registry ID is worth more than a name. */
export function gradeResolution(input: {
  matched: boolean;
  similarity: number;
  hasRegistryId: boolean;
}): { resolution: PlaceResolution; confidence: number } {
  if (!input.matched) return { resolution: 'not_found', confidence: 0 };

  // A SIREN is an identifier a public registry assigned to one legal entity; a
  // name is a string two businesses may share. So a registry-backed match earns
  // the benefit of the doubt that a name-only match does not.
  const confidence = input.hasRegistryId
    ? Math.min(1, input.similarity + 0.1)
    : input.similarity;

  if (confidence >= RESOLUTION_CONFIRMED_AT) return { resolution: 'confirmed', confidence };
  if (confidence >= RESOLUTION_MIN_CONFIDENCE) return { resolution: 'probable', confidence };
  return { resolution: 'uncertain', confidence };
}

export interface PlaceCandidateRow {
  place_id: string;
  campaign_id: string;
  latitude: number | null;
  longitude: number | null;
  location_expires_at: string | null;
  status: PlaceCandidateStatus;
  reject_reason: string | null;
  tiers_fetched: string[];
  prospect_id: string | null;
  resolution: PlaceResolution | null;
  resolution_provider: string | null;
  resolution_confidence: number | null;
  resolution_source_url: string | null;
}

/**
 * Deletes every expired coordinate pair.
 *
 * Called at the start of every Places run and by the benchmark, so the lease is
 * honoured even if no purge job ever runs. Returns the number of rows cleared so
 * a run can report it rather than assume it.
 */
export async function purgeExpiredLocations(sql: Sql, now: Date = new Date()): Promise<number> {
  const rows = await sql.query<{ place_id: string }>(
    `update google_place_candidates
        set latitude = null, longitude = null, location_expires_at = null
      where location_expires_at is not null and location_expires_at <= $1
      returning place_id`,
    [now.toISOString()],
  );
  return rows.length;
}

/**
 * Counts the leases that have run out, without touching them.
 *
 * For read-only tools. A measurement command must stay a measurement command:
 * a benchmark that silently deleted rows would be indistinguishable from one
 * that did not, right up until it deleted the wrong ones. Reporting the number
 * lets the operator act; `purgeExpiredLocations` is what acts.
 */
export async function countExpiredLocations(sql: Sql, now: Date = new Date()): Promise<number> {
  const rows = await sql.query<{ count: string }>(
    `select count(*)::text as count from google_place_candidates
      where location_expires_at is not null and location_expires_at <= $1`,
    [now.toISOString()],
  );
  return Number.parseInt(rows[0]?.count ?? '0', 10) || 0;
}

/**
 * Records a place ID we have seen. Writes the ID and nothing else — the caller
 * decides later, stage by stage, what else may legitimately be attached.
 */
export async function rememberPlaceId(sql: Sql, campaignId: string, placeId: string): Promise<boolean> {
  const rows = await sql.query<{ place_id: string }>(
    `insert into google_place_candidates (place_id, campaign_id)
     values ($1, $2)
     on conflict (place_id) do update set last_seen_at = now()
     returning place_id, (xmax = 0) as inserted`,
    [placeId, campaignId],
  );
  const row = rows[0] as ({ place_id: string; inserted?: boolean } | undefined);
  return row?.inserted ?? false;
}

export async function loadCandidate(sql: Sql, placeId: string): Promise<PlaceCandidateRow | null> {
  const rows = await sql.query<PlaceCandidateRow>(
    'select * from google_place_candidates where place_id = $1',
    [placeId],
  );
  return rows[0] ?? null;
}

export async function listCandidates(
  sql: Sql,
  campaignId: string,
  statuses?: PlaceCandidateStatus[],
): Promise<PlaceCandidateRow[]> {
  if (statuses && statuses.length > 0) {
    return sql.query<PlaceCandidateRow>(
      'select * from google_place_candidates where campaign_id = $1 and status = any($2::text[]) order by first_seen_at',
      [campaignId, statuses],
    );
  }
  return sql.query<PlaceCandidateRow>(
    'select * from google_place_candidates where campaign_id = $1 order by first_seen_at',
    [campaignId],
  );
}

/** Attaches a coordinate pair under its 30-day lease. */
export async function setCandidateLocation(
  sql: Sql,
  placeId: string,
  location: { latitude: number | null; longitude: number | null },
  now: Date = new Date(),
): Promise<void> {
  const hasLocation = location.latitude != null && location.longitude != null;
  await sql.query(
    `update google_place_candidates
        set latitude = $2, longitude = $3, location_expires_at = $4, last_seen_at = now()
      where place_id = $1`,
    [
      placeId,
      location.latitude,
      location.longitude,
      hasLocation ? locationExpiryFrom(now).toISOString() : null,
    ],
  );
}

export async function setCandidateStatus(
  sql: Sql,
  placeId: string,
  status: PlaceCandidateStatus,
  rejectReason: string | null = null,
): Promise<void> {
  await sql.query(
    `update google_place_candidates
        set status = $2, reject_reason = $3, last_seen_at = now()
      where place_id = $1`,
    [placeId, status, rejectReason],
  );
}

/** Records how strongly an independent source identified a candidate, and which one. */
export async function setCandidateResolution(
  sql: Sql,
  placeId: string,
  resolution: PlaceResolution,
  detail: { provider: string | null; confidence: number; sourceUrl: string | null },
): Promise<void> {
  await sql.query(
    `update google_place_candidates
        set resolution = $2, resolution_provider = $3, resolution_confidence = $4,
            resolution_source_url = $5, last_seen_at = now()
      where place_id = $1`,
    [placeId, resolution, detail.provider, detail.confidence, detail.sourceUrl],
  );
}

export async function linkCandidateToProspect(sql: Sql, placeId: string, prospectId: string): Promise<void> {
  await sql.query(
    `update google_place_candidates
        set prospect_id = $2, status = 'identified', reject_reason = null, last_seen_at = now()
      where place_id = $1`,
    [placeId, prospectId],
  );
}

/** Marks a SKU tier as already paid for this place, so a re-run does not re-pay. */
export async function markTierFetched(sql: Sql, placeId: string, tier: string): Promise<void> {
  await sql.query(
    `update google_place_candidates
        set tiers_fetched = case
              when tiers_fetched @> to_jsonb($2::text) then tiers_fetched
              else tiers_fetched || to_jsonb($2::text)
            end,
            last_seen_at = now()
      where place_id = $1`,
    [placeId, tier],
  );
}

export function hasTier(candidate: PlaceCandidateRow | null, tier: string): boolean {
  return Array.isArray(candidate?.tiers_fetched) && candidate.tiers_fetched.includes(tier);
}

/**
 * Guards the prospect write path.
 *
 * Any value that came from Places and is not a place ID must be gone by the time
 * a prospect row is written. This is the last line of defence: it is called by
 * the rail-A stage on the column bag it is about to persist, and it throws
 * rather than silently dropping, because a silent drop would hide a regression.
 */
const NON_STORABLE_PLACES_FIELDS = [
  'google_rating',
  'google_review_count',
] as const;

export function assertNoPlacesContent(columns: Record<string, unknown>, context: string): void {
  for (const field of NON_STORABLE_PLACES_FIELDS) {
    if (columns[field] !== null && columns[field] !== undefined) {
      throw new Error(
        `${context}: refusing to persist "${field}" sourced from Google Places. ` +
          'Ratings and review counts carry no caching permission under the provider terms.',
      );
    }
  }
}
