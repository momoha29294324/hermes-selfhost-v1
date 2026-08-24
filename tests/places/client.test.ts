import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { createLogger } from '@/lib/logging/logger';
import { HttpClient, HttpError } from '@/lib/http/client';
import { PlacesBudget, PlacesBudgetExceededError } from '@/lib/discovery/places/budget';
import { PlacesClient, placesAvailability } from '@/lib/discovery/places/client';
import type { EeaStance } from '@/lib/discovery/places/eea';
import type { Sql } from '@/lib/db/sql';

/**
 * The client is where compliance and cost meet the network. Two properties
 * matter more than the parsing: the field mask that leaves the process is
 * exactly the one we budgeted for, and a budget refusal means NO request is
 * issued at all. A guard that is consulted after the fact is not a guard.
 */

const KEY = 'test-places-key-not-real';
const logger = createLogger({ test: 'places-client' });

let sql: Sql;
let dir: string;

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function harness(responder: (call: RecordedCall, index: number) => { status?: number; body?: unknown }): {
  calls: RecordedCall[];
  http: HttpClient;
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    const result = responder(call, calls.length - 1);
    return {
      ok: (result.status ?? 200) >= 200 && (result.status ?? 200) < 300,
      status: result.status ?? 200,
      url: call.url,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: async () => JSON.stringify(result.body ?? {}),
    } as unknown as Response;
  };
  return { calls, http: new HttpClient({ sql: null, minHostIntervalMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch }) };
}

function makeClient(
  http: HttpClient,
  options: { limits?: Partial<{ run: number; runCalls: number }>; eea?: EeaStance } = {},
): { client: PlacesClient; budget: PlacesBudget } {
  const budget = new PlacesBudget({
    sql,
    campaignSlug: 'test',
    runId: null,
    limits: {
      run: options.limits?.run ?? 100,
      runCalls: options.limits?.runCalls ?? 100,
      daily: 100,
      monthlyDiscovery: 100,
      monthlyDetails: 100,
    },
  });
  return { client: new PlacesClient({ http, budget, logger, eea: options.eea ?? DECLARED }), budget };
}

/**
 * A stance that names a Permitted Use, so the tests below can exercise the
 * transport rather than the compliance gate. The gate itself is tested in
 * tests/places/eea.test.ts, including that this is NOT the default.
 */
const DECLARED: EeaStance = {
  eeaBillingAddress: true,
  declaredUse: 'sales_opportunities',
  restrictedContentAllowed: true,
  reason: 'test fixture',
};

const LYON = { center: { latitude: 45.7578, longitude: 4.832 }, radiusKm: 8, label: 'Lyon~8km' };
const SEARCH_OPTS = { regionCode: 'FR', languageCode: 'fr' };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-places-client-'));
  sql = await createPgliteSql(join(dir, 'pgdata'));
  await migrate(sql);
}, 120_000);

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('delete from google_places_usage');
  await sql.query('delete from http_cache');
  process.env['GOOGLE_PLACES_ENABLED'] = '1';
  process.env['OUTBOUND_GOOGLE_PLACES_KEY'] = KEY;
  process.env['GOOGLE_PLACES_EEA_PERMITTED_USE'] = 'sales_opportunities';
});

afterEach(() => {
  delete process.env['GOOGLE_PLACES_ENABLED'];
  delete process.env['OUTBOUND_GOOGLE_PLACES_KEY'];
  delete process.env['GOOGLE_PLACES_EEA_PERMITTED_USE'];
});

describe('availability', () => {
  it('stays off until it is deliberately switched on', () => {
    delete process.env['GOOGLE_PLACES_ENABLED'];
    const availability = placesAvailability();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain('GOOGLE_PLACES_ENABLED');
  });

  it('reports a missing key distinctly from a disabled rail', () => {
    delete process.env['OUTBOUND_GOOGLE_PLACES_KEY'];
    const availability = placesAvailability();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain('OUTBOUND_GOOGLE_PLACES_KEY');
  });

  it('reports an undeclared EEA permitted use distinctly from a missing key', () => {
    delete process.env['GOOGLE_PLACES_EEA_PERMITTED_USE'];
    const availability = placesAvailability();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain('Permitted Uses');
  });

  it('is available only once the switch, the key and a declared permitted use are all present', () => {
    expect(placesAvailability().ok).toBe(true);
  });
});

describe('discovery search', () => {
  it('asks for place ids only, at the free tier, with no spaces in the mask', async () => {
    const { calls, http } = harness(() => ({ body: { places: [{ id: 'a' }, { id: 'b' }] } }));
    const { client } = makeClient(http);
    const page = await client.searchText('example-services', LYON, SEARCH_OPTS);

    expect(page.hits.map((hit) => hit.placeId)).toEqual(['a', 'b']);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(call.headers['x-goog-fieldmask']).toBe('places.id,nextPageToken');
    expect(call.headers['x-goog-fieldmask']).not.toContain(' ');
  });

  it('sends the key in a header and never in the URL', async () => {
    const { calls, http } = harness(() => ({ body: { places: [] } }));
    const { client } = makeClient(http);
    await client.searchText('example-services', LYON, SEARCH_OPTS);
    expect(calls[0]!.headers['x-goog-api-key']).toBe(KEY);
    expect(calls[0]!.url).not.toContain(KEY);
    expect(calls[0]!.body ?? '').not.toContain(KEY);
  });

  it('RESTRICTS the search server-side rather than merely biasing it', async () => {
    // The distinction is the whole point: a bias lets out-of-area results
    // through, which is what forced R2 to test Places coordinates against the
    // campaign area — the containment analysis EEA ToS §3.3.2(c)(iv) speaks to.
    // A restriction makes Google the one enforcing the geography.
    const { calls, http } = harness(() => ({ body: { places: [] } }));
    const { client } = makeClient(http);
    await client.searchText('example-services', LYON, SEARCH_OPTS);

    const body = JSON.parse(calls[0]!.body ?? '{}') as {
      textQuery: string;
      regionCode: string;
      languageCode: string;
      pageSize: number;
      locationBias?: unknown;
      locationRestriction: {
        rectangle: { low: { latitude: number; longitude: number }; high: { latitude: number; longitude: number } };
      };
    };
    expect(body.textQuery).toBe('example-services');
    expect(body.regionCode).toBe('FR');
    expect(body.languageCode).toBe('fr');
    expect(body.pageSize).toBe(20);
    expect(body.locationBias).toBeUndefined();

    // Text Search accepts a restriction only as a rectangular viewport, so the
    // tile's disc travels as its bounding box: low = south-west, high = north-east.
    const { low, high } = body.locationRestriction.rectangle;
    expect(low.latitude).toBeLessThan(45.7578);
    expect(high.latitude).toBeGreaterThan(45.7578);
    expect(low.longitude).toBeLessThan(4.832);
    expect(high.longitude).toBeGreaterThan(4.832);
  });

  it('keeps every other parameter byte-identical between pages', async () => {
    // Google rejects a paged request whose parameters changed with
    // INVALID_ARGUMENT, so only the token may vary.
    const { calls, http } = harness((_call, index) =>
      index === 0
        ? { body: { places: [{ id: 'a' }], nextPageToken: 'token-2' } }
        : { body: { places: [{ id: 'b' }] } },
    );
    const { client } = makeClient(http);

    const first = await client.searchText('example-services', LYON, SEARCH_OPTS);
    expect(first.nextPageToken).toBe('token-2');
    await client.searchText('example-services', LYON, { ...SEARCH_OPTS, pageToken: 'token-2' });

    const bodyOne = JSON.parse(calls[0]!.body ?? '{}') as Record<string, unknown>;
    const bodyTwo = JSON.parse(calls[1]!.body ?? '{}') as Record<string, unknown>;
    expect(bodyTwo['pageToken']).toBe('token-2');
    delete bodyTwo['pageToken'];
    expect(bodyTwo).toEqual(bodyOne);
    expect(calls[1]!.headers['x-goog-fieldmask']).toBe(calls[0]!.headers['x-goog-fieldmask']);
  });

  it('drops results that carry no usable id', async () => {
    const { http } = harness(() => ({ body: { places: [{ id: 'a' }, {}, { id: '' }] } }));
    const { client } = makeClient(http);
    expect((await client.searchText('example-services', LYON, SEARCH_OPTS)).hits).toHaveLength(1);
  });
});

describe('the three detail stages', () => {
  it('reads categories and drops everything else the response happens to carry', async () => {
    // The response is scripted with a location and a display name that were never
    // asked for. Neither may survive the call: what the client returns is the
    // boundary the rest of the pipeline trusts.
    const { calls, http } = harness(() => ({
      body: { location: { latitude: 45.75, longitude: 4.83 }, types: ['atelier'], displayName: { text: 'leaked' } },
    }));
    const { client } = makeClient(http);
    const categories = await client.fetchCategories('place-1');

    expect(calls[0]!.url).toBe('https://places.googleapis.com/v1/places/place-1');
    expect(calls[0]!.headers['x-goog-fieldmask']).toBe('types');
    expect(categories).toEqual({ placeId: 'place-1', types: ['atelier'] });
  });

  it('qualifies a candidate with the trading name and its trading status', async () => {
    const { calls, http } = harness(() => ({
      body: { displayName: { text: '  Northstar Studio  ' }, primaryType: 'atelier', businessStatus: 'OPERATIONAL' },
    }));
    const { client } = makeClient(http);
    const hints = await client.fetchIdentityHints('place-1');

    expect(calls[0]!.headers['x-goog-fieldmask']).toBe('displayName,primaryType,businessStatus');
    expect(hints.displayName).toBe('Northstar Studio');
    expect(hints.businessStatus).toBe('OPERATIONAL');
  });

  it('buys exactly two pointers and carries nothing else back', async () => {
    const { calls, http } = harness(() => ({
      body: {
        websiteUri: 'https://example.net',
        nationalPhoneNumber: '04 78 00 00 00',
        rating: 4.9,
        userRatingCount: 120,
      },
    }));
    const { client } = makeClient(http);
    const pointers = await client.fetchPointers('place-1');

    expect(calls[0]!.headers['x-goog-fieldmask']).toBe('websiteUri,nationalPhoneNumber');
    // Even when Google volunteers a rating, it does not survive the boundary.
    expect(pointers).toEqual({
      placeId: 'place-1',
      websiteUri: 'https://example.net',
      phone: '04 78 00 00 00',
    });
    expect(Object.keys(pointers)).toHaveLength(3);
  });

  it('escapes the place id in the path', async () => {
    const { calls, http } = harness(() => ({ body: {} }));
    const { client } = makeClient(http);
    await client.fetchCategories('a/b?c');
    expect(calls[0]!.url).toBe('https://places.googleapis.com/v1/places/a%2Fb%3Fc');
  });
});

describe('Places content never enters the shared HTTP cache', () => {
  it('leaves http_cache empty after a details call', async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: unknown): Promise<Response> => {
      calls.push(String(input));
      return {
        ok: true,
        status: 200,
        url: String(input),
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        text: async () => JSON.stringify({ location: { latitude: 1, longitude: 2 }, types: [] }),
      } as unknown as Response;
    };
    // A cache-backed client: without noCache this GET would be persisted.
    const http = new HttpClient({ sql, minHostIntervalMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    const { client } = makeClient(http);
    await client.fetchCategories('place-1');

    const cached = await sql.query<{ count: string }>('select count(*)::text as count from http_cache');
    expect(cached[0]?.count).toBe('0');
  });
});

describe('failures are recorded, not swallowed', () => {
  it('throws on a non-2xx response and still writes a ledger row with the status', async () => {
    const { http } = harness(() => ({ status: 403, body: { error: { message: 'denied' } } }));
    const { client } = makeClient(http);
    await expect(client.fetchCategories('place-1')).rejects.toBeInstanceOf(HttpError);

    const rows = await sql.query<{ http_status: number; error: string; billable: boolean }>(
      'select http_status, error, billable from google_places_usage',
    );
    expect(rows[0]?.http_status).toBe(403);
    expect(rows[0]?.error).toBe('HTTP 403');
    expect(rows[0]?.billable).toBe(true);
  });

  it('records a transport failure with its message and rethrows', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('socket hang up');
    };
    const http = new HttpClient({ sql: null, minHostIntervalMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch });
    const { client } = makeClient(http);
    await expect(client.fetchCategories('place-1')).rejects.toThrow(/socket hang up/);

    const rows = await sql.query<{ error: string }>('select error from google_places_usage');
    expect(rows[0]?.error).toMatch(/socket hang up/);
  });

  it('refuses to run without a key even when the rail is enabled', async () => {
    delete process.env['OUTBOUND_GOOGLE_PLACES_KEY'];
    const { calls, http } = harness(() => ({ body: {} }));
    const { client } = makeClient(http);
    await expect(client.fetchCategories('place-1')).rejects.toThrow(/OUTBOUND_GOOGLE_PLACES_KEY/);
    expect(calls).toHaveLength(0);
  });
});

describe('the budget stops the request before it is made', () => {
  it('issues no HTTP call at all once the ceiling is reached', async () => {
    const { calls, http } = harness(() => ({ body: { location: { latitude: 1, longitude: 2 }, types: [] } }));
    const { client } = makeClient(http, { limits: { run: 1, runCalls: 10 } });

    await client.fetchCategories('place-1');
    expect(calls).toHaveLength(1);

    await expect(client.fetchCategories('place-2')).rejects.toBeInstanceOf(PlacesBudgetExceededError);
    // The property that makes the guard real rather than decorative.
    expect(calls).toHaveLength(1);
  });

  it('does not record a refused call as spending', async () => {
    const { http } = harness(() => ({ body: { location: { latitude: 1, longitude: 2 }, types: [] } }));
    const { client } = makeClient(http, { limits: { run: 1, runCalls: 10 } });
    await client.fetchCategories('place-1');
    await client.fetchCategories('place-2').catch(() => undefined);

    const rows = await sql.query<{ count: string }>(
      'select count(*)::text as count from google_places_usage where billable = true',
    );
    expect(rows[0]?.count).toBe('1');
  });
});
