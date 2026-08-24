import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { createLogger } from '@/lib/logging/logger';
import { HttpClient } from '@/lib/http/client';
import { ProspectRepository } from '@/lib/repo/prospects';
import { PlacesBudget } from '@/lib/discovery/places/budget';
import { PlacesClient } from '@/lib/discovery/places/client';
import { PLACES_MASKS, classifyMask } from '@/lib/discovery/places/fieldMask';
import {
  EEA_PERMITTED_USES,
  EeaPermittedUseError,
  assertEeaUseAllowed,
  assertNotGeometryInput,
  assertNotModelInput,
  eeaStance,
  maskIsUnrestrictedUnderEea,
} from '@/lib/discovery/places/eea';
import type { DiscoveredBusiness } from '@/lib/discovery/types';
import type { Sql } from '@/lib/db/sql';

/**
 * The EEA regime, tested where it actually binds.
 *
 * R2 built against the standard terms and flagged that the EEA ones were
 * unverified. They are verified now, and they invert the default: EEA Service
 * Specific Terms §15.2 says that other than latitude, longitude and place_id,
 * Places content may be used ONLY as the nine Permitted Uses allow. An allowlist
 * with no residual clause is not something a codebase can satisfy by being
 * careful — it has to be told which item it is operating under.
 *
 * So the assertions that matter most here are, again, the ones about what does
 * NOT happen: no restricted call without a declared use, no Google-attributed
 * row in the permanent store, no Places value in a prompt.
 */

const logger = createLogger({ test: 'places-eea' });
const KEY = 'test-key';

let sql: Sql;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-places-eea-'));
  sql = await createPgliteSql(join(dir, 'pgdata'));
  await migrate(sql);
}, 120_000);

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('delete from google_places_usage');
  process.env['OUTBOUND_GOOGLE_PLACES_KEY'] = KEY;
});

afterEach(() => {
  delete process.env['OUTBOUND_GOOGLE_PLACES_KEY'];
  delete process.env['GOOGLE_PLACES_EEA_PERMITTED_USE'];
  delete process.env['GOOGLE_PLACES_EEA_BILLING'];
});

describe('the Permitted Uses list is transcribed, not summarised', () => {
  it('carries all nine items from the June 4, 2025 document', () => {
    expect(Object.keys(EEA_PERMITTED_USES)).toHaveLength(9);
    expect(EEA_PERMITTED_USES.sales_opportunities).toBe(
      "enable Customers to visualize and manage Places content related to a sales team's customers or opportunities",
    );
  });
});

describe('the default stance refuses restricted content', () => {
  it('treats an unset permitted use as "not permitted", never as "probably fine"', () => {
    const stance = eeaStance();
    expect(stance.eeaBillingAddress).toBe(true);
    expect(stance.declaredUse).toBeNull();
    expect(stance.restrictedContentAllowed).toBe(false);
  });

  it('assumes an EEA billing address when the variable is unset', () => {
    // The stricter regime is the safe default: guessing "non-EEA" would re-open
    // the whole restricted-field surface on nothing but an unset variable.
    expect(eeaStance().eeaBillingAddress).toBe(true);
  });

  it('refuses a use that is not on the list rather than inventing a tenth', () => {
    process.env['GOOGLE_PLACES_EEA_PERMITTED_USE'] = 'lead_generation';
    expect(() => eeaStance()).toThrow(EeaPermittedUseError);
  });

  it('accepts a declared use and says which one it is', () => {
    process.env['GOOGLE_PLACES_EEA_PERMITTED_USE'] = 'sales_opportunities';
    const stance = eeaStance();
    expect(stance.declaredUse).toBe('sales_opportunities');
    expect(stance.restrictedContentAllowed).toBe(true);
    expect(stance.reason).toContain('sales team');
  });
});

describe('what §15.2 carves out, and what it does not', () => {
  it('lets the place id and coordinates through with no declared use', () => {
    expect(maskIsUnrestrictedUnderEea(['places.id', 'nextPageToken'])).toBe(true);
    expect(maskIsUnrestrictedUnderEea(['id'])).toBe(true);
    expect(maskIsUnrestrictedUnderEea(['location'])).toBe(true);
  });

  it('does not confuse the resource name with the display name', () => {
    // `name` is `places/ChIJ…` — the place id in resource form, and exempt.
    // `displayName` is the trading name, and is restricted. Reading the first as
    // the second is the easiest way to believe a mask is exempt when it is not.
    expect(maskIsUnrestrictedUnderEea(['name'])).toBe(true);
    expect(maskIsUnrestrictedUnderEea(['displayName'])).toBe(false);
  });

  it('treats every stage past discovery as restricted', () => {
    expect(maskIsUnrestrictedUnderEea(PLACES_MASKS.discovery().fields)).toBe(true);
    expect(maskIsUnrestrictedUnderEea(PLACES_MASKS.locate().fields)).toBe(false);
    expect(maskIsUnrestrictedUnderEea(PLACES_MASKS.qualify().fields)).toBe(false);
    expect(maskIsUnrestrictedUnderEea(PLACES_MASKS.identify().fields)).toBe(false);
  });

  it('permits stage 1 but refuses stage 2 when no use is declared', () => {
    const stance = eeaStance();
    expect(() => assertEeaUseAllowed(PLACES_MASKS.discovery().fields, stance)).not.toThrow();
    expect(() => assertEeaUseAllowed(PLACES_MASKS.locate().fields, stance)).toThrow(EeaPermittedUseError);
  });
});

describe('the gate runs before the request, not after it', () => {
  function harness(): { calls: number; http: HttpClient } {
    const state = { calls: 0 };
    const fetchImpl = async (): Promise<Response> => {
      state.calls += 1;
      return new Response(JSON.stringify({ types: ['atelier'] }), { status: 200 });
    };
    return {
      get calls() {
        return state.calls;
      },
      http: new HttpClient({ sql: null, minHostIntervalMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch }),
    };
  }

  function makeClient(http: HttpClient): PlacesClient {
    const budget = new PlacesBudget({
      sql,
      campaignSlug: 'eea',
      runId: null,
      limits: { run: 100, runCalls: 100, daily: 100, monthlyDiscovery: 100, monthlyDetails: 100 },
    });
    return new PlacesClient({ http, budget, logger });
  }

  it('issues no HTTP request for a restricted mask with no declared use', async () => {
    const h = harness();
    await expect(makeClient(h.http).fetchCategories('place-1')).rejects.toThrow(EeaPermittedUseError);
    expect(h.calls).toBe(0);
  });

  it('writes no ledger row either — a refused call is not a call', async () => {
    const h = harness();
    await expect(makeClient(h.http).fetchIdentityHints('place-1')).rejects.toThrow(EeaPermittedUseError);
    const rows = await sql.query('select 1 from google_places_usage');
    expect(rows).toHaveLength(0);
  });

  it('still allows the free discovery stage, so a key can be smoke-tested at zero exposure', async () => {
    const h = harness();
    await makeClient(h.http).searchText(
      'example-services',
      { center: { latitude: 45.75, longitude: 4.83 }, radiusKm: 8, label: 'lyon' },
      { regionCode: 'FR', languageCode: 'fr' },
    );
    expect(h.calls).toBe(1);
  });

  it('lets restricted stages through once a use is declared', async () => {
    process.env['GOOGLE_PLACES_EEA_PERMITTED_USE'] = 'sales_opportunities';
    const h = harness();
    const result = await makeClient(h.http).fetchCategories('place-1');
    expect(result.types).toEqual(['atelier']);
    expect(h.calls).toBe(1);
  });
});

describe('the wildcard mask stays refused', () => {
  it('refuses it before any tier arithmetic happens', () => {
    expect(() => classifyMask('placeDetails', ['*'])).toThrow(/wildcard/i);
    expect(() => classifyMask('searchText', ['places.*'])).toThrow(/wildcard/i);
  });
});

describe('Google Maps Content never becomes a permanent, independent-looking fact', () => {
  it('refuses to persist a business attributed to Places', async () => {
    const repo = new ProspectRepository(sql, logger);
    const rows = await sql.query<{ id: string }>(
      `insert into campaigns (slug, name, niche_key, config)
       values ('eea-guard','EEA guard','example-services','{}'::jsonb) returning id`,
    );
    const campaignId = rows[0]!.id;

    const business: DiscoveredBusiness = {
      provider: 'google_places',
      externalId: 'ChIJdeadbeef',
      sourceUrl: null,
      observedAt: new Date().toISOString(),
      name: 'Atelier Lyon',
      city: 'LYON',
      raw: {},
    };

    await expect(repo.upsertDiscovered(campaignId, business)).rejects.toThrow(/google_places/);
    expect(await sql.query('select 1 from prospects where campaign_id = $1', [campaignId])).toHaveLength(0);
  });

  it('refuses a rating or a review count whatever provider claims to have seen it', async () => {
    const repo = new ProspectRepository(sql, logger);
    const rows = await sql.query<{ id: string }>(
      `insert into campaigns (slug, name, niche_key, config)
       values ('eea-rating','EEA rating','example-services','{}'::jsonb) returning id`,
    );
    const campaignId = rows[0]!.id;

    // Laundering the value through a legitimate provider must not help: the
    // guard reads the column bag, not the label on it.
    const business: DiscoveredBusiness = {
      provider: 'sirene',
      externalId: 'siren-1',
      sourceUrl: null,
      observedAt: new Date().toISOString(),
      name: 'Atelier Lyon',
      googleRating: 4.8,
      raw: {},
    };

    await expect(repo.upsertDiscovered(campaignId, business)).rejects.toThrow(/google_rating/);
  });
});

describe('the two content-creation tripwires', () => {
  it('refuses Places content as model input', () => {
    expect(() => assertNotModelInput('Northstar Studio', 'classify')).toThrow(/train, test, validate or fine-tune/);
    // Nothing to guard is not a failure: absent content passes.
    expect(() => assertNotModelInput(null, 'classify')).not.toThrow();
    expect(() => assertNotModelInput(undefined, 'classify')).not.toThrow();
  });

  it('refuses Places coordinates as geometric input', () => {
    expect(() => assertNotGeometryInput('rail A')).toThrow(/point-in-polygon/);
  });
});
