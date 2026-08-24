import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import {
  assertNoPlacesContent,
  gradeResolution,
  hasTier,
  linkCandidateToProspect,
  listCandidates,
  loadCandidate,
  RESOLUTION_PROSPECTABLE,
  locationExpiryFrom,
  markTierFetched,
  PLACES_LOCATION_TTL_DAYS,
  purgeExpiredLocations,
  rememberPlaceId,
  setCandidateLocation,
  setCandidateStatus,
} from '@/lib/discovery/places/retention';
import type { Sql } from '@/lib/db/sql';

/**
 * Google's terms let us keep a place ID indefinitely and latitude/longitude for
 * thirty calendar days, "after which Customer must delete the cached latitude
 * and longitude values". Deletion is an obligation, not housekeeping.
 *
 * This file exists so that obligation is enforced by code that fails loudly,
 * rather than by a comment nobody reads at 2am.
 */

let sql: Sql;
let dir: string;
let campaignId: string;

const DAY_MS = 24 * 3600 * 1000;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-places-retention-'));
  sql = await createPgliteSql(join(dir, 'pgdata'));
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ('r','R','example-services','{}'::jsonb) returning id`,
  );
  campaignId = rows[0]!.id;
}, 120_000);

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('delete from google_place_candidates');
});

describe('the 30-day lease is a term, not a tunable', () => {
  it('is exactly thirty days', () => {
    expect(PLACES_LOCATION_TTL_DAYS).toBe(30);
  });

  it('expires a coordinate pair thirty days after it was observed', () => {
    const now = new Date('2026-08-10T00:00:00Z');
    expect(locationExpiryFrom(now).toISOString()).toBe('2026-09-09T00:00:00.000Z');
  });
});

describe('seeing a place stores nothing about it', () => {
  it('remembers the identifier and nothing else', async () => {
    expect(await rememberPlaceId(sql, campaignId, 'place-1')).toBe(true);

    const candidate = await loadCandidate(sql, 'place-1');
    expect(candidate?.place_id).toBe('place-1');
    // The compliance property: no name, no address, no coordinates yet.
    expect(candidate?.latitude).toBeNull();
    expect(candidate?.longitude).toBeNull();
    expect(candidate?.location_expires_at).toBeNull();
    expect(candidate?.prospect_id).toBeNull();
    expect(candidate?.status).toBe('discovered');
  });

  it('reports a repeat sighting as not new, so duplicates can be counted', async () => {
    await rememberPlaceId(sql, campaignId, 'place-1');
    expect(await rememberPlaceId(sql, campaignId, 'place-1')).toBe(false);
    expect(await listCandidates(sql, campaignId)).toHaveLength(1);
  });
});

describe('coordinates are held on a lease', () => {
  it('attaches an expiry alongside the position', async () => {
    await rememberPlaceId(sql, campaignId, 'place-1');
    const now = new Date('2026-08-10T00:00:00Z');
    await setCandidateLocation(sql, 'place-1', { latitude: 45.75, longitude: 4.83 }, now);

    const candidate = await loadCandidate(sql, 'place-1');
    expect(candidate?.latitude).toBeCloseTo(45.75, 4);
    expect(new Date(candidate!.location_expires_at!).getTime()).toBe(now.getTime() + 30 * DAY_MS);
  });

  it('clears the expiry when there is no position to hold', async () => {
    await rememberPlaceId(sql, campaignId, 'place-1');
    await setCandidateLocation(sql, 'place-1', { latitude: null, longitude: null });
    expect((await loadCandidate(sql, 'place-1'))?.location_expires_at).toBeNull();
  });

  it('deletes an expired position while keeping the identifier we may keep', async () => {
    await rememberPlaceId(sql, campaignId, 'place-1');
    const observed = new Date('2026-08-10T00:00:00Z');
    await setCandidateLocation(sql, 'place-1', { latitude: 45.75, longitude: 4.83 }, observed);
    await setCandidateStatus(sql, 'place-1', 'qualified');

    const purged = await purgeExpiredLocations(sql, new Date(observed.getTime() + 31 * DAY_MS));
    expect(purged).toBe(1);

    const candidate = await loadCandidate(sql, 'place-1');
    expect(candidate?.latitude).toBeNull();
    expect(candidate?.longitude).toBeNull();
    expect(candidate?.location_expires_at).toBeNull();
    // The place ID is exempt from the caching restrictions, so it stays, and so
    // does the verdict we reached ourselves.
    expect(candidate?.place_id).toBe('place-1');
    expect(candidate?.status).toBe('qualified');
  });

  it('leaves a lease that has not run out alone', async () => {
    await rememberPlaceId(sql, campaignId, 'place-1');
    const observed = new Date('2026-08-10T00:00:00Z');
    await setCandidateLocation(sql, 'place-1', { latitude: 45.75, longitude: 4.83 }, observed);

    expect(await purgeExpiredLocations(sql, new Date(observed.getTime() + 29 * DAY_MS))).toBe(0);
    expect((await loadCandidate(sql, 'place-1'))?.latitude).toBeCloseTo(45.75, 4);
  });
});

describe('a verdict is not paid for twice', () => {
  it('accumulates the SKU tiers already bought, without duplicating them', async () => {
    await rememberPlaceId(sql, campaignId, 'place-1');
    await markTierFetched(sql, 'place-1', 'locate');
    await markTierFetched(sql, 'place-1', 'locate');
    await markTierFetched(sql, 'place-1', 'qualify');

    const candidate = await loadCandidate(sql, 'place-1');
    expect(candidate?.tiers_fetched).toEqual(['locate', 'qualify']);
    expect(hasTier(candidate, 'locate')).toBe(true);
    expect(hasTier(candidate, 'identify')).toBe(false);
    expect(hasTier(null, 'locate')).toBe(false);
  });
});

describe('candidate lifecycle', () => {
  it('records a rejection with the reason it was rejected', async () => {
    await rememberPlaceId(sql, campaignId, 'place-1');
    await setCandidateStatus(sql, 'place-1', 'rejected', 'hors zone de campagne');
    const candidate = await loadCandidate(sql, 'place-1');
    expect(candidate?.status).toBe('rejected');
    expect(candidate?.reject_reason).toBe('hors zone de campagne');
  });

  it('clears the rejection reason when a candidate is finally identified', async () => {
    const prospect = await sql.query<{ id: string }>(
      `insert into prospects (campaign_id, canonical_key, display_name) values ($1,'k','N') returning id`,
      [campaignId],
    );
    await rememberPlaceId(sql, campaignId, 'place-1');
    await setCandidateStatus(sql, 'place-1', 'unidentified', 'aucune source indépendante');
    await linkCandidateToProspect(sql, 'place-1', prospect[0]!.id);

    const candidate = await loadCandidate(sql, 'place-1');
    expect(candidate?.status).toBe('identified');
    expect(candidate?.reject_reason).toBeNull();
    expect(candidate?.prospect_id).toBe(prospect[0]!.id);
  });

  it('lists candidates by status so the benchmark can count what was left behind', async () => {
    await rememberPlaceId(sql, campaignId, 'place-1');
    await rememberPlaceId(sql, campaignId, 'place-2');
    await setCandidateStatus(sql, 'place-1', 'unidentified', 'ni site ni registre');
    await setCandidateStatus(sql, 'place-2', 'rejected', 'hors niche');

    expect(await listCandidates(sql, campaignId, ['unidentified'])).toHaveLength(1);
    expect(await listCandidates(sql, campaignId, ['unidentified', 'rejected'])).toHaveLength(2);
  });
});

describe('the last line of defence before a prospect is written', () => {
  it('refuses to persist a rating or review count sourced from Places', () => {
    expect(() => assertNoPlacesContent({ google_rating: 4.8 }, 'rail A')).toThrow(/google_rating/);
    expect(() => assertNoPlacesContent({ google_review_count: 74 }, 'rail A')).toThrow(/google_review_count/);
  });

  it('explains why, because the reason is not obvious from the field name', () => {
    try {
      assertNoPlacesContent({ google_rating: 4.8 }, 'rail A');
    } catch (error) {
      expect((error as Error).message).toContain('caching permission');
      expect((error as Error).message).toContain('provider terms');
    }
  });

  it('lets a genuinely empty column bag through', () => {
    expect(() =>
      assertNoPlacesContent({ google_rating: null, google_review_count: undefined, phone: '0478000000' }, 'rail A'),
    ).not.toThrow();
  });
});

describe('grading an independent identification', () => {
  it('treats a registry-backed strong name match as beyond reasonable doubt', () => {
    const graded = gradeResolution({ matched: true, similarity: 0.95, hasRegistryId: true });
    expect(graded.resolution).toBe('confirmed');
  });

  it('promotes a registry match over a name-only match at the same similarity', () => {
    // A SIREN identifies one legal entity; a name is a string two businesses may
    // share. The bonus is what encodes that difference.
    const withRegistry = gradeResolution({ matched: true, similarity: 0.85, hasRegistryId: true });
    const nameOnly = gradeResolution({ matched: true, similarity: 0.85, hasRegistryId: false });
    expect(withRegistry.resolution).toBe('confirmed');
    expect(nameOnly.resolution).toBe('probable');
    expect(withRegistry.confidence).toBeGreaterThan(nameOnly.confidence);
  });

  it('calls a weak match uncertain rather than rounding it up to usable', () => {
    expect(gradeResolution({ matched: true, similarity: 0.55, hasRegistryId: false }).resolution).toBe('uncertain');
  });

  it('separates "nothing answered" from "something answered badly"', () => {
    expect(gradeResolution({ matched: false, similarity: 0, hasRegistryId: false }).resolution).toBe('not_found');
  });

  it('lets only confirmed and probable through to a prospect', () => {
    expect(RESOLUTION_PROSPECTABLE).toEqual(['confirmed', 'probable']);
    expect(RESOLUTION_PROSPECTABLE).not.toContain('uncertain');
    expect(RESOLUTION_PROSPECTABLE).not.toContain('not_found');
  });
});
