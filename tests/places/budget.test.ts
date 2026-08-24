import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import {
  limitsFromEnv,
  PlacesBudget,
  PlacesBudgetExceededError,
  type PlacesBudgetLimits,
} from '@/lib/discovery/places/budget';
import { PLACES_MASKS } from '@/lib/discovery/places/fieldMask';
import type { Sql } from '@/lib/db/sql';

/**
 * Google's free tier is not a guard: it bounds what is free, not what is
 * called. Nothing on Google's side stops a loop bug from issuing fifty thousand
 * requests — the first thousand are merely cheaper. This file protects the only
 * guard that actually exists, and in particular the property that makes it
 * real: it decides from a PERSISTENT ledger, so a crash does not reset it.
 */

let sql: Sql;
let dir: string;

const DISCOVERY = PLACES_MASKS.locate(); // essentials -> discovery envelope
const PRO = PLACES_MASKS.qualify(); // pro -> discovery envelope
const DETAILS = PLACES_MASKS.identify(); // enterprise -> details envelope
const FREE = PLACES_MASKS.discovery(); // ids_only -> free

function limits(overrides: Partial<PlacesBudgetLimits> = {}): PlacesBudgetLimits {
  return {
    run: 100,
    runCalls: 1_000,
    daily: 100,
    monthlyDiscovery: 100,
    monthlyDetails: 100,
    ...overrides,
  };
}

function budgetAt(iso: string, overrides: Partial<PlacesBudgetLimits> = {}): PlacesBudget {
  return new PlacesBudget({
    sql,
    campaignSlug: 'test',
    runId: null,
    limits: limits(overrides),
    now: () => new Date(iso),
  });
}

/** Issues `count` accepted billable calls through a budget, as the client would. */
async function spend(budget: PlacesBudget, plan: typeof DISCOVERY, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await budget.assertCanSpend(plan);
    await budget.record(plan, {
      billable: plan.envelope !== 'free',
      cacheHit: false,
      resultsCount: 1,
      query: null,
      areaLabel: null,
      httpStatus: 200,
      error: null,
    });
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-places-budget-'));
  sql = await createPgliteSql(join(dir, 'pgdata'));
  await migrate(sql);
}, 120_000);

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('delete from google_places_usage');
});

describe('the guard refuses before the money is spent', () => {
  it('stops a run once its billable ceiling is reached', async () => {
    const budget = budgetAt('2026-08-10T10:00:00Z', { run: 3 });
    await spend(budget, DISCOVERY, 3);
    await expect(budget.assertCanSpend(DISCOVERY)).rejects.toBeInstanceOf(PlacesBudgetExceededError);
  });

  it('names the scope that stopped it, so the run report can explain itself', async () => {
    const budget = budgetAt('2026-08-10T10:00:00Z', { run: 1 });
    await spend(budget, DISCOVERY, 1);
    await budget.assertCanSpend(DISCOVERY).catch((error: unknown) => {
      expect(error).toBeInstanceOf(PlacesBudgetExceededError);
      expect((error as PlacesBudgetExceededError).scope).toBe('run');
      expect((error as PlacesBudgetExceededError).limit).toBe(1);
    });
  });
});

describe('the ledger survives the process', () => {
  it('counts the daily limit from the database, not from an in-memory counter', async () => {
    // The crash-safety property: a second run must not get a fresh allowance.
    const first = budgetAt('2026-08-10T10:00:00Z', { daily: 4 });
    await spend(first, DISCOVERY, 4);

    const afterRestart = budgetAt('2026-08-10T18:00:00Z', { daily: 4 });
    await expect(afterRestart.assertCanSpend(DISCOVERY)).rejects.toMatchObject({ scope: 'daily' });
  });

  it('lets the next UTC day start again', async () => {
    const day1 = budgetAt('2026-08-10T23:00:00Z', { daily: 2 });
    await spend(day1, DISCOVERY, 2);
    const day2 = budgetAt('2026-08-11T01:00:00Z', { daily: 2 });
    await expect(day2.assertCanSpend(DISCOVERY)).resolves.toBeUndefined();
  });
});

describe('the two monthly envelopes are independent', () => {
  it('does not let discovery spending block an enterprise call', async () => {
    const budget = budgetAt('2026-08-10T10:00:00Z', { monthlyDiscovery: 2, monthlyDetails: 5 });
    await spend(budget, DISCOVERY, 2);
    await expect(budget.assertCanSpend(DISCOVERY)).rejects.toMatchObject({ scope: 'monthly_discovery' });

    const fresh = budgetAt('2026-08-10T10:00:00Z', { monthlyDiscovery: 2, monthlyDetails: 5 });
    await expect(fresh.assertCanSpend(DETAILS)).resolves.toBeUndefined();
  });

  it('does not let enterprise spending block a discovery call', async () => {
    const budget = budgetAt('2026-08-10T10:00:00Z', { monthlyDiscovery: 5, monthlyDetails: 2 });
    await spend(budget, DETAILS, 2);
    await expect(budget.assertCanSpend(DETAILS)).rejects.toMatchObject({ scope: 'monthly_details' });

    const fresh = budgetAt('2026-08-10T10:00:00Z', { monthlyDiscovery: 5, monthlyDetails: 2 });
    await expect(fresh.assertCanSpend(DISCOVERY)).resolves.toBeUndefined();
  });

  it('counts Pro calls against the discovery envelope alongside Essentials', async () => {
    const budget = budgetAt('2026-08-10T10:00:00Z', { monthlyDiscovery: 2 });
    await spend(budget, DISCOVERY, 1);
    await spend(budget, PRO, 1);
    const fresh = budgetAt('2026-08-10T10:00:00Z', { monthlyDiscovery: 2 });
    await expect(fresh.assertCanSpend(PRO)).rejects.toMatchObject({ scope: 'monthly_discovery' });
  });

  it('starts over at the calendar month boundary', async () => {
    const august = budgetAt('2026-08-31T22:00:00Z', { monthlyDetails: 1 });
    await spend(august, DETAILS, 1);
    const september = budgetAt('2026-09-01T02:00:00Z', { monthlyDetails: 1 });
    await expect(september.assertCanSpend(DETAILS)).resolves.toBeUndefined();
  });
});

describe('free calls are free, but not unlimited', () => {
  it('exempts them from the daily and monthly ceilings', async () => {
    const budget = budgetAt('2026-08-10T10:00:00Z', { daily: 1, monthlyDiscovery: 1, monthlyDetails: 1 });
    await spend(budget, FREE, 20);
    await expect(budget.assertCanSpend(FREE)).resolves.toBeUndefined();
  });

  it('still walls them off, because an unbounded free loop is a bug too', async () => {
    const budget = budgetAt('2026-08-10T10:00:00Z', { runCalls: 5 });
    await spend(budget, FREE, 5);
    await expect(budget.assertCanSpend(FREE)).rejects.toMatchObject({ scope: 'run_calls' });
  });

  it('does not spend the billable run ceiling on free calls', async () => {
    // The two fears deserve two numbers: a benchmark that sweeps a metropolitan
    // area issues hundreds of free searches and must not look like overspending.
    const budget = budgetAt('2026-08-10T10:00:00Z', { run: 2, runCalls: 100 });
    await spend(budget, FREE, 50);
    await expect(budget.assertCanSpend(DISCOVERY)).resolves.toBeUndefined();
  });
});

describe('a refusal is final, never a retry', () => {
  it('keeps refusing with the same error once it has said no', async () => {
    const budget = budgetAt('2026-08-10T10:00:00Z', { run: 1 });
    await spend(budget, DISCOVERY, 1);

    const first = await budget.assertCanSpend(DISCOVERY).catch((error: unknown) => error);
    expect(budget.exhausted).toBe(true);
    expect(budget.stopReason).toBe(first);

    const second = await budget.assertCanSpend(FREE).catch((error: unknown) => error);
    // The same object: the answer cannot improve, so it is not recomputed and
    // nothing about it invites a caller to try again.
    expect(second).toBe(first);
  });
});

describe('the ledger records what happened', () => {
  it('writes one row per call, with its SKU tier and field mask', async () => {
    const budget = budgetAt('2026-08-10T10:00:00Z');
    await spend(budget, DETAILS, 1);
    const rows = await sql.query<{ sku_tier: string; field_mask: string; billable: boolean; endpoint: string }>(
      'select sku_tier, field_mask, billable, endpoint from google_places_usage',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoint).toBe('placeDetails');
    expect(rows[0]?.sku_tier).toBe('enterprise:2D9A-3DE0-3766');
    expect(rows[0]?.field_mask).toBe('websiteUri,nationalPhoneNumber');
    expect(rows[0]?.billable).toBe(true);
  });

  it('records cache hits as non-billable, so avoided calls can be counted honestly', async () => {
    const budget = budgetAt('2026-08-10T10:00:00Z');
    await budget.record(DETAILS, {
      billable: false,
      cacheHit: true,
      resultsCount: 1,
      query: null,
      areaLabel: null,
      httpStatus: null,
      error: null,
    });
    const rows = await sql.query<{ billable: boolean; cache_hit: boolean }>(
      'select billable, cache_hit from google_places_usage',
    );
    expect(rows[0]?.billable).toBe(false);
    expect(rows[0]?.cache_hit).toBe(true);
    expect((await budget.snapshot()).cacheHits).toBe(1);
  });

  it('records a failed call with its status and error', async () => {
    const budget = budgetAt('2026-08-10T10:00:00Z');
    await budget.record(DISCOVERY, {
      billable: true,
      cacheHit: false,
      resultsCount: 0,
      query: 'example-services',
      areaLabel: 'Lyon',
      httpStatus: 503,
      error: 'HTTP 503',
    });
    const rows = await sql.query<{ http_status: number; error: string; query: string; area_label: string }>(
      'select http_status, error, query, area_label from google_places_usage',
    );
    expect(rows[0]?.http_status).toBe(503);
    expect(rows[0]?.error).toBe('HTTP 503');
    expect(rows[0]?.query).toBe('example-services');
    expect(rows[0]?.area_label).toBe('Lyon');
  });

  it('reports every scope in a snapshot the run report can print', async () => {
    const budget = budgetAt('2026-08-10T10:00:00Z');
    await spend(budget, DISCOVERY, 2);
    await spend(budget, DETAILS, 1);
    await spend(budget, FREE, 3);

    const snapshot = await budget.snapshot();
    expect(snapshot.runBillable).toBe(3);
    expect(snapshot.freeCalls).toBe(3);
    expect(snapshot.runCalls).toBe(6);
    expect(snapshot.dailyBillable).toBe(3);
    expect(snapshot.monthlyDiscovery).toBe(2);
    expect(snapshot.monthlyDetails).toBe(1);
  });
});

describe('shipped defaults', () => {
  const KEYS = [
    'GOOGLE_PLACES_RUN_LIMIT',
    'GOOGLE_PLACES_RUN_CALL_CEILING',
    'GOOGLE_PLACES_DAILY_LIMIT',
    'GOOGLE_PLACES_MONTHLY_DISCOVERY_LIMIT',
    'GOOGLE_PLACES_MONTHLY_DETAILS_LIMIT',
  ] as const;

  function withoutEnv<T>(fn: () => T): T {
    const saved = new Map(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
    try {
      return fn();
    } finally {
      for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
    }
  }

  it('sits strictly below Google’s documented monthly no-charge caps', () => {
    // Essentials 10 000 and Enterprise 1 000 are the documented free caps. The
    // gap is a deliberate margin: crossing it must take an edit, not an
    // afternoon. Closing that gap would be a money bug.
    const defaults = withoutEnv(() => limitsFromEnv());
    expect(defaults.monthlyDiscovery).toBeLessThan(10_000);
    expect(defaults.monthlyDetails).toBeLessThan(1_000);
    expect(defaults.monthlyDiscovery).toBe(8_000);
    expect(defaults.monthlyDetails).toBe(800);
  });

  it('bounds a single run more tightly than a month', () => {
    const defaults = withoutEnv(() => limitsFromEnv());
    expect(defaults.run).toBe(400);
    expect(defaults.daily).toBe(1_000);
    expect(defaults.runCalls).toBe(2_000);
    expect(defaults.run).toBeLessThan(defaults.monthlyDiscovery);
  });

  it('lets the environment tighten the limits', () => {
    const saved = process.env['GOOGLE_PLACES_RUN_LIMIT'];
    process.env['GOOGLE_PLACES_RUN_LIMIT'] = '7';
    try {
      expect(limitsFromEnv().run).toBe(7);
    } finally {
      if (saved === undefined) delete process.env['GOOGLE_PLACES_RUN_LIMIT'];
      else process.env['GOOGLE_PLACES_RUN_LIMIT'] = saved;
    }
  });
});
