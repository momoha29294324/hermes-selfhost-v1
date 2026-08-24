import { envInt } from '@/lib/env';
import type { Sql } from '@/lib/db/sql';
import type { BudgetEnvelope, MaskPlan } from '@/lib/discovery/places/fieldMask';

/**
 * The application's own ceiling on Google Places spending.
 *
 * Google's free tier is not a guard: it bounds what is free, not what is
 * called. Nothing on Google's side stops a loop bug from issuing fifty thousand
 * requests — the first thousand are simply cheaper than the rest. So the guard
 * lives here, it refuses the call BEFORE it is issued, and it decides from a
 * persistent ledger rather than from an in-memory counter that a crash resets.
 *
 * Exceeding the budget is a controlled stop, never a retry. `withRetry` treats
 * PlacesBudgetExceededError as non-retryable by construction: the guard is not
 * consulted again once it has said no, because the answer cannot improve.
 */

export class PlacesBudgetExceededError extends Error {
  constructor(
    readonly scope: 'run' | 'run_calls' | 'daily' | 'monthly_discovery' | 'monthly_details',
    readonly used: number,
    readonly limit: number,
  ) {
    super(`Google Places budget exhausted: ${scope} usage ${used}/${limit}. Stopping cleanly.`);
    this.name = 'PlacesBudgetExceededError';
  }
}

export interface PlacesBudgetLimits {
  /** Billable calls this run may issue. The money ceiling. */
  run: number;
  /**
   * Total calls this run may issue, free ones included. The runaway ceiling.
   *
   * These are two different fears and they deserve two numbers. A free call
   * costs nothing, so counting it against the money ceiling would make a normal
   * benchmark look like overspending; but an unbounded loop of free calls is
   * still a bug, still hammers Google, and still needs a wall.
   */
  runCalls: number;
  daily: number;
  monthlyDiscovery: number;
  monthlyDetails: number;
}

/**
 * Conservative on purpose, and deliberately BELOW Google's documented monthly
 * no-charge caps (Essentials 10 000, Pro 5 000, Enterprise 1 000) so that going
 * past them takes a deliberate edit rather than a busy afternoon.
 */
export function limitsFromEnv(): PlacesBudgetLimits {
  return {
    run: envInt('GOOGLE_PLACES_RUN_LIMIT', 400),
    runCalls: envInt('GOOGLE_PLACES_RUN_CALL_CEILING', 2_000),
    daily: envInt('GOOGLE_PLACES_DAILY_LIMIT', 1_000),
    monthlyDiscovery: envInt('GOOGLE_PLACES_MONTHLY_DISCOVERY_LIMIT', 8_000),
    monthlyDetails: envInt('GOOGLE_PLACES_MONTHLY_DETAILS_LIMIT', 800),
  };
}

export interface PlacesUsageRecord {
  endpoint: string;
  skuTier: string;
  fieldMask: string;
  envelope: BudgetEnvelope;
  billable: boolean;
  cacheHit: boolean;
  resultsCount: number;
  query: string | null;
  areaLabel: string | null;
  httpStatus: number | null;
  error: string | null;
}

export interface PlacesBudgetOptions {
  sql: Sql;
  campaignSlug: string | null;
  runId: string | null;
  limits?: PlacesBudgetLimits;
  /** Injected so tests can cross a month boundary without waiting a month. */
  now?: () => Date;
}

export interface BudgetSnapshot {
  runBillable: number;
  runCalls: number;
  dailyBillable: number;
  monthlyDiscovery: number;
  monthlyDetails: number;
  freeCalls: number;
  cacheHits: number;
  limits: PlacesBudgetLimits;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcMonthStart(date: Date): string {
  return `${date.toISOString().slice(0, 7)}-01`;
}

export class PlacesBudget {
  private readonly sql: Sql;
  private readonly campaignSlug: string | null;
  private readonly runId: string | null;
  private readonly now: () => Date;
  readonly limits: PlacesBudgetLimits;

  /** Billable calls issued by THIS run. The other three scopes read the ledger. */
  private runBillable = 0;
  private freeCalls = 0;
  private cacheHits = 0;
  private stopped: PlacesBudgetExceededError | null = null;

  constructor(options: PlacesBudgetOptions) {
    this.sql = options.sql;
    this.campaignSlug = options.campaignSlug;
    this.runId = options.runId;
    this.limits = options.limits ?? limitsFromEnv();
    this.now = options.now ?? ((): Date => new Date());
  }

  /** True once the budget has refused a call; callers stop asking. */
  get exhausted(): boolean {
    return this.stopped !== null;
  }

  get stopReason(): PlacesBudgetExceededError | null {
    return this.stopped;
  }

  /**
   * Asks permission for one call at `plan`'s tier. Throws when it would breach a
   * ceiling — before any request leaves the process.
   *
   * Free-tier calls are exempt from every ceiling except the run ceiling. The run
   * ceiling still applies to them because an unbounded free loop is a bug even
   * when it is not an expense.
   */
  async assertCanSpend(plan: MaskPlan): Promise<void> {
    if (this.stopped) throw this.stopped;

    const billable = plan.envelope !== 'free';
    const totalRunCalls = this.runBillable + this.freeCalls;
    if (totalRunCalls >= this.limits.runCalls) {
      throw this.stop(new PlacesBudgetExceededError('run_calls', totalRunCalls, this.limits.runCalls));
    }
    if (!billable) return;

    if (this.runBillable >= this.limits.run) {
      throw this.stop(new PlacesBudgetExceededError('run', this.runBillable, this.limits.run));
    }

    const now = this.now();
    const daily = await this.countSince(utcDay(now), null);
    if (daily >= this.limits.daily) {
      throw this.stop(new PlacesBudgetExceededError('daily', daily, this.limits.daily));
    }

    const monthStart = utcMonthStart(now);
    if (plan.envelope === 'discovery') {
      const used = await this.countSince(monthStart, 'discovery');
      if (used >= this.limits.monthlyDiscovery) {
        throw this.stop(new PlacesBudgetExceededError('monthly_discovery', used, this.limits.monthlyDiscovery));
      }
    } else {
      const used = await this.countSince(monthStart, 'details');
      if (used >= this.limits.monthlyDetails) {
        throw this.stop(new PlacesBudgetExceededError('monthly_details', used, this.limits.monthlyDetails));
      }
    }
  }

  private stop(error: PlacesBudgetExceededError): PlacesBudgetExceededError {
    this.stopped = error;
    return error;
  }

  /**
   * Writes one ledger row per call — issued, cached or failed alike.
   *
   * A cache hit and a refused call are recorded with `billable = false`, because
   * "how many calls did the tiering avoid" is the number that proves the design
   * works, and it is only credible if it comes from the same ledger as the spend.
   */
  async record(plan: MaskPlan, record: Omit<PlacesUsageRecord, 'endpoint' | 'skuTier' | 'fieldMask' | 'envelope'>): Promise<void> {
    if (record.billable) this.runBillable += 1;
    else if (record.cacheHit) this.cacheHits += 1;
    else if (plan.envelope === 'free') this.freeCalls += 1;

    const occurredAt = this.now();
    await this.sql.query(
      `insert into google_places_usage
         (campaign_slug, run_id, endpoint, sku_tier, field_mask, billable, cache_hit,
          results_count, query, area_label, http_status, error, occurred_on, occurred_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        this.campaignSlug,
        this.runId,
        plan.endpoint,
        `${plan.tier}:${plan.sku}`,
        plan.header,
        record.billable,
        record.cacheHit,
        record.resultsCount,
        record.query,
        record.areaLabel,
        record.httpStatus,
        record.error,
        utcDay(occurredAt),
        occurredAt,
      ],
    );
  }

  private async countSince(fromDate: string, envelope: 'discovery' | 'details' | null): Promise<number> {
    // Envelope is derived in SQL from the tier prefix written by `record`, so the
    // ledger stays readable on its own without a join to application constants.
    const envelopeClause =
      envelope === 'discovery'
        ? "and (sku_tier like 'essentials:%' or sku_tier like 'pro:%')"
        : envelope === 'details'
          ? "and (sku_tier like 'enterprise:%' or sku_tier like 'enterprise_atmosphere:%')"
          : '';
    const rows = await this.sql.query<{ count: string }>(
      `select count(*)::text as count from google_places_usage
        where billable = true and occurred_on >= $1::date ${envelopeClause}`,
      [fromDate],
    );
    return Number.parseInt(rows[0]?.count ?? '0', 10) || 0;
  }

  async snapshot(): Promise<BudgetSnapshot> {
    const now = this.now();
    const monthStart = utcMonthStart(now);
    return {
      runBillable: this.runBillable,
      runCalls: this.runBillable + this.freeCalls,
      dailyBillable: await this.countSince(utcDay(now), null),
      monthlyDiscovery: await this.countSince(monthStart, 'discovery'),
      monthlyDetails: await this.countSince(monthStart, 'details'),
      freeCalls: this.freeCalls,
      cacheHits: this.cacheHits,
      limits: this.limits,
    };
  }
}
