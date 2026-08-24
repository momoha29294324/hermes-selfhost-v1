import { describe, expect, it } from 'vitest';
import {
  classifyMask,
  PLACES_MASKS,
  PLACES_SKU,
  PLACES_TIERS,
  TIER_ENVELOPE,
  tierOfField,
  UnknownPlacesFieldError,
} from '@/lib/discovery/places/fieldMask';

/**
 * Google bills a Places call at the highest SKU tier present in its field mask,
 * not per field. One stray `websiteUri` in an otherwise free mask turns a €0
 * call into a $20/1000 one, silently, with an identical-looking response.
 *
 * This file is the cost contract of the release: it pins which tier each of our
 * four masks lands in. If someone widens a mask, this fails before the invoice
 * does.
 */

describe('tier of a single field', () => {
  it('places every documented field in its billed tier', () => {
    expect(tierOfField('id')).toBe('ids_only');
    expect(tierOfField('location')).toBe('essentials');
    expect(tierOfField('formattedAddress')).toBe('essentials');
    expect(tierOfField('displayName')).toBe('pro');
    expect(tierOfField('businessStatus')).toBe('pro');
    expect(tierOfField('websiteUri')).toBe('enterprise');
    expect(tierOfField('nationalPhoneNumber')).toBe('enterprise');
    expect(tierOfField('rating')).toBe('enterprise');
    expect(tierOfField('reviews')).toBe('enterprise_atmosphere');
  });

  it('accepts the search-style "places." prefix and resolves nested paths by their root', () => {
    expect(tierOfField('places.websiteUri')).toBe('enterprise');
    expect(tierOfField('displayName.text')).toBe('pro');
    expect(tierOfField('places.location.latitude')).toBe('essentials');
  });

  it('treats nextPageToken as free — it carries no place content', () => {
    expect(tierOfField('nextPageToken')).toBe('ids_only');
  });

  it('refuses an undocumented field rather than assuming it is cheap', () => {
    // A new Google field of unknown tier could reprice every call carrying it.
    expect(() => tierOfField('someNewFieldGoogleAdded')).toThrow(UnknownPlacesFieldError);
    try {
      tierOfField('someNewFieldGoogleAdded');
    } catch (error) {
      expect((error as Error).name).toBe('UnknownPlacesFieldError');
      expect((error as Error).message).toContain('someNewFieldGoogleAdded');
      expect((error as Error).message).toContain('fieldMask.ts');
    }
  });
});

describe('a mask is billed at its most expensive field', () => {
  it('takes the maximum tier regardless of field order', () => {
    const cheapFirst = classifyMask('placeDetails', ['id', 'location', 'websiteUri']);
    const expensiveFirst = classifyMask('placeDetails', ['websiteUri', 'location', 'id']);
    expect(cheapFirst.tier).toBe('enterprise');
    expect(expensiveFirst.tier).toBe('enterprise');
    expect(cheapFirst.sku).toBe(expensiveFirst.sku);
  });

  it('turns a free call into an Enterprise call with one extra field', () => {
    const free = classifyMask('placeDetails', ['id']);
    expect(free.tier).toBe('ids_only');
    expect(free.envelope).toBe('free');
    expect(free.sku).toBe(PLACES_SKU.placeDetails.ids_only);

    const notFree = classifyMask('placeDetails', ['id', 'websiteUri']);
    expect(notFree.tier).toBe('enterprise');
    expect(notFree.envelope).toBe('details');
    expect(notFree.sku).toBe(PLACES_SKU.placeDetails.enterprise);
    expect(notFree.sku).not.toBe(free.sku);
  });
});

describe('the same field costs differently depending on the endpoint', () => {
  it('reprices Essentials fields as Pro when they are asked for through a search', () => {
    // This asymmetry is the reason the module exists: `location` is $5/1000 via
    // Place Details and $32/1000 via Text Search.
    expect(classifyMask('placeDetails', ['location']).tier).toBe('essentials');
    expect(classifyMask('searchText', ['places.location']).tier).toBe('pro');
  });

  it('keeps ids free on both endpoints', () => {
    expect(classifyMask('placeDetails', ['id']).tier).toBe('ids_only');
    expect(classifyMask('searchText', ['places.id', 'nextPageToken']).tier).toBe('ids_only');
  });
});

describe('masks that must never be issued', () => {
  it('refuses an empty mask, which Google answers with an error', () => {
    expect(() => classifyMask('placeDetails', [])).toThrow(/may not be empty/);
  });

  it('refuses a wildcard, which bills at the most expensive SKU', () => {
    expect(() => classifyMask('placeDetails', ['*'])).toThrow(/wildcard/i);
    expect(() => classifyMask('searchText', ['places.id', 'places.*'])).toThrow(/wildcard/i);
  });
});

describe('the four masks this release actually issues', () => {
  it('discovers place ids for nothing at all', () => {
    const plan = PLACES_MASKS.discovery();
    expect(plan.header).toBe('places.id,nextPageToken');
    expect(plan.tier).toBe('ids_only');
    expect(plan.envelope).toBe('free');
    expect(plan.sku).toBe('635D-A9DD-C520');
  });

  it('reads a candidate category at the Essentials tier, and asks for no coordinates', () => {
    const plan = PLACES_MASKS.locate();
    expect(plan.header).toBe('types');
    expect(plan.tier).toBe('essentials');
    expect(plan.envelope).toBe('discovery');
    expect(plan.sku).toBe('6E05-E1C3-8D85');
    // R2 asked for `location` here and tested it against the campaign area.
    // EEA ToS §3.3.2(c)(iv) puts that analysis out of bounds, and Google now
    // restricts the search server-side instead, so the field is simply not bought.
    expect(plan.fields).not.toContain('location');
  });

  it('qualifies a candidate at the Pro tier', () => {
    const plan = PLACES_MASKS.qualify();
    expect(plan.header).toBe('displayName,primaryType,businessStatus');
    expect(plan.tier).toBe('pro');
    expect(plan.envelope).toBe('discovery');
    expect(plan.sku).toBe('4ED6-464A-2AFC');
  });

  it('buys exactly two pointers at the Enterprise tier, and nothing else', () => {
    const plan = PLACES_MASKS.identify();
    expect(plan.header).toBe('websiteUri,nationalPhoneNumber');
    expect(plan.tier).toBe('enterprise');
    expect(plan.envelope).toBe('details');
    expect(plan.sku).toBe('2D9A-3DE0-3766');
  });

  it('refreshes an ageing place id for free', () => {
    expect(PLACES_MASKS.refresh().tier).toBe('ids_only');
  });

  it('never asks for ratings, reviews or photos', () => {
    // The product does not use them (mission §18), they may not be stored, and
    // they sit in the two most expensive tiers. Asking would be pure loss.
    const forbidden = ['rating', 'userRatingCount', 'reviews', 'photos', 'editorialSummary'];
    for (const [name, build] of Object.entries(PLACES_MASKS)) {
      const header = build().header;
      for (const field of forbidden) {
        expect(header.includes(field), `mask "${name}" must not request ${field}`).toBe(false);
      }
    }
  });

  it('emits headers without spaces — a space is a parse failure at Google', () => {
    for (const [name, build] of Object.entries(PLACES_MASKS)) {
      expect(build().header.includes(' '), `mask "${name}" contains a space`).toBe(false);
    }
  });

  it('keeps at most one mask in the expensive details envelope', () => {
    const details = Object.values(PLACES_MASKS).filter((build) => build().envelope === 'details');
    expect(details).toHaveLength(1);
  });
});

describe('budget envelopes', () => {
  it('routes every tier to the envelope that pays for it', () => {
    expect(TIER_ENVELOPE.ids_only).toBe('free');
    expect(TIER_ENVELOPE.essentials).toBe('discovery');
    expect(TIER_ENVELOPE.pro).toBe('discovery');
    expect(TIER_ENVELOPE.enterprise).toBe('details');
    expect(TIER_ENVELOPE.enterprise_atmosphere).toBe('details');
  });

  it('assigns an envelope and a SKU to every declared tier on both endpoints', () => {
    for (const tier of PLACES_TIERS) {
      expect(TIER_ENVELOPE[tier], `tier ${tier} has no envelope`).toBeTruthy();
      expect(PLACES_SKU.searchText[tier], `searchText/${tier} has no SKU`).toMatch(/^[0-9A-F-]+$/);
      expect(PLACES_SKU.placeDetails[tier], `placeDetails/${tier} has no SKU`).toMatch(/^[0-9A-F-]+$/);
    }
  });

  it('orders tiers from cheapest to most expensive, which is the billing rule', () => {
    expect(PLACES_TIERS).toEqual(['ids_only', 'essentials', 'pro', 'enterprise', 'enterprise_atmosphere']);
  });
});
