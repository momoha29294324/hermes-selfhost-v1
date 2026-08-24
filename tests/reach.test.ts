import { describe, expect, it } from 'vitest';
import {
  assessReach,
  commercialVisibility,
  contactChannels,
  funnelObservability,
  isQualifiedContactableObservable,
} from '@/lib/pipeline/reach';
import type { EvidenceLike } from '@/lib/pipeline/score';
import type { ProspectRow } from '@/lib/repo/types';

/**
 * R2 is judged on two measurements and one distinction.
 *
 * The measurements: can we reach this business, and can we see how it sells.
 * The distinction: how VISIBLE a business is from outside is not how GOOD it
 * is. A small excellent artisan who only posts on Instagram scores low on
 * visibility and may still be the best prospect in the corpus. Every test here
 * exists to stop that distinction from eroding.
 *
 * Nothing in this module sends anything. `contactable` is a measurement.
 */

function prospect(overrides: Partial<ProspectRow> = {}): ProspectRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    campaign_id: '00000000-0000-0000-0000-0000000000c1',
    canonical_key: 'registry_id:944555226',
    display_name: 'NORTHSTAR STUDIO',
    legal_name: null,
    brand_name: null,
    registry_id: null,
    registry_source: null,
    country: 'FR',
    address_line: null,
    postal_code: null,
    city: 'LYON',
    department: null,
    region: null,
    latitude: null,
    longitude: null,
    domain: null,
    website_url: null,
    instagram_handle: null,
    facebook_url: null,
    email: null,
    phone: null,
    google_place_id: null,
    google_rating: null,
    google_review_count: null,
    stage: 'enriched',
    niche_verdict: null,
    niche_confidence: null,
    score: null,
    score_band: null,
    dedupe_status: 'unique',
    merged_into_id: null,
    first_seen_at: '2026-08-01T00:00:00.000Z',
    last_enriched_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as ProspectRow;
}

function evidence(fields: string[]): EvidenceLike[] {
  return fields.map((field, index) => ({
    id: `e${index}`,
    field,
    value_text: 'x',
    value_json: null,
    provider: 'website',
    source_url: null,
  }));
}

describe('contactability is a measurement, and nothing is ever sent', () => {
  it('lists exactly the channels observed', () => {
    expect(contactChannels(prospect())).toEqual([]);
    expect(contactChannels(prospect({ phone: '+33478000000' }))).toEqual(['phone']);
    expect(
      contactChannels(
        prospect({
          email: 'contact@example.net',
          phone: '+33478000000',
          website_url: 'https://example.net',
          instagram_handle: 'northstarstudio',
          facebook_url: 'https://facebook.com/northstarstudio',
        }),
      ),
    ).toEqual(['email', 'phone', 'website', 'instagram', 'facebook']);
  });

  it('counts a single public channel as contactable', () => {
    expect(assessReach({ prospect: prospect({ instagram_handle: 'x' }), evidence: [] }).contactable).toBe(true);
  });

  it('is false when no professional channel was found at all', () => {
    expect(assessReach({ prospect: prospect(), evidence: [] }).contactable).toBe(false);
  });
});

describe('funnel observability separates "we looked" from "we never looked"', () => {
  it('is true when a page was read and nothing was found — that is an observation', () => {
    const { observable } = funnelObservability(evidence(['funnel_not_observed']));
    expect(observable).toBe(true);
  });

  it('is true when a page was read and a signal was found', () => {
    expect(funnelObservability(evidence(['website_quality', 'cta_quality'])).observable).toBe(true);
  });

  it('is false for a registry-only prospect — a SIREN and an address are not a funnel', () => {
    expect(funnelObservability(evidence(['registry_id', 'address_line', 'city'])).observable).toBe(false);
  });

  it('is false when nothing at all was observed', () => {
    expect(funnelObservability([]).observable).toBe(false);
  });

  it('counts every funnel-bearing observation', () => {
    const { signalCount } = funnelObservability(
      evidence(['website_quality', 'cta_quality', 'booking_system', 'funnel_observed', 'phone']),
    );
    expect(signalCount).toBe(4);
  });
});

describe('commercial visibility', () => {
  it('values a site that was read above a site that is merely known', () => {
    const known = commercialVisibility({
      prospect: prospect({ website_url: 'https://example.net' }),
      evidence: [],
    });
    const read = commercialVisibility({
      prospect: prospect({ website_url: 'https://example.net' }),
      evidence: evidence(['website_quality']),
    });
    expect(read.score).toBeGreaterThan(known.score);
  });

  it('stays inside 0..100 however many channels pile up', () => {
    const everything = commercialVisibility({
      prospect: prospect({
        website_url: 'https://example.net',
        instagram_handle: 'northstarstudio',
        facebook_url: 'https://facebook.com/northstarstudio',
        phone: '+33478000000',
        email: 'contact@example.net',
        google_place_id: 'place-1',
        registry_id: '944555226',
      }),
      evidence: evidence(['website_quality', 'cta_quality']),
    });
    expect(everything.score).toBeLessThanOrEqual(100);
    expect(everything.score).toBeGreaterThan(80);
    expect(commercialVisibility({ prospect: prospect(), evidence: [] }).score).toBe(0);
  });

  it('explains itself in French, including when there is nothing to explain', () => {
    expect(commercialVisibility({ prospect: prospect(), evidence: [] }).reasons[0]).toContain('aucun canal');
    expect(
      commercialVisibility({ prospect: prospect({ phone: '+33478000000' }), evidence: [] }).reasons,
    ).toContain('téléphone public');
  });

  it('is a statement about our data, not about the business', () => {
    // An Instagram-first artisan is barely observable and may still be the
    // best prospect in the corpus. The function must report LOW VISIBILITY and
    // must not be read — here or anywhere downstream — as low quality. It is
    // deliberately absent from the scoring profile for this reason.
    const instagramFirst = commercialVisibility({
      prospect: prospect({ instagram_handle: 'northstarstudio' }),
      evidence: [],
    });
    const bigDullSite = commercialVisibility({
      prospect: prospect({ website_url: 'https://x.fr', phone: '+33478000000', email: 'a@x.fr' }),
      evidence: evidence(['website_quality']),
    });

    expect(instagramFirst.score).toBeLessThan(bigDullSite.score);
    expect(instagramFirst.reasons).toContain('compte Instagram identifié');
    // The claim is observability only: no verdict, no band, no ranking.
    expect(Object.keys(instagramFirst)).toEqual(['score', 'reasons']);
  });
});

describe('the R2 headline metric', () => {
  const observable = evidence(['website_quality', 'cta_quality']);

  it('requires the business to be in the niche, reachable AND legible', () => {
    expect(
      isQualifiedContactableObservable(
        prospect({ niche_verdict: 'in_niche', phone: '+33478000000' }),
        observable,
      ),
    ).toBe(true);
  });

  it('excludes a business we cannot reach, however good it looks', () => {
    expect(isQualifiedContactableObservable(prospect({ niche_verdict: 'in_niche' }), observable)).toBe(false);
  });

  it('excludes a business whose commercial path we have never seen', () => {
    expect(
      isQualifiedContactableObservable(
        prospect({ niche_verdict: 'in_niche', phone: '+33478000000' }),
        evidence(['registry_id']),
      ),
    ).toBe(false);
  });

  it('excludes a business that is not in the niche', () => {
    expect(
      isQualifiedContactableObservable(
        prospect({ niche_verdict: 'adjacent', phone: '+33478000000' }),
        observable,
      ),
    ).toBe(false);
  });

  it('reports both measurements together so a run can be judged on the pair', () => {
    const reach = assessReach({
      prospect: prospect({ phone: '+33478000000', website_url: 'https://example.net' }),
      evidence: observable,
    });
    expect(reach.contactable).toBe(true);
    expect(reach.funnelObservable).toBe(true);
    expect(reach.funnelSignalCount).toBe(2);
    expect(reach.channels).toEqual(['phone', 'website']);
    expect(reach.commercialVisibility).toBeGreaterThan(0);
    expect(reach.visibilityReasons.length).toBeGreaterThan(0);
  });
});
