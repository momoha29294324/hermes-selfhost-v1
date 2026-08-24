/**
 * Per-provider circuit breakers.
 *
 * The rule this enforces: no single upstream can stall the pipeline. A search
 * engine that starts refusing traffic, a site that hangs, a browser that will
 * not start — each gets its own breaker, and the rest of the run continues
 * without it. Nothing here retries harder when something says no; it backs off.
 *
 * closed --(N consecutive failures)--> open --(cooldown elapsed)--> half_open
 * half_open --(one success)--> closed
 * half_open --(one failure)--> open, with the cooldown restarted
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerSnapshot {
  state: BreakerState;
  failures: number;
  openedAt: string | null;
  lastReason: string | null;
  /** Number of calls the breaker refused since process start. */
  refused: number;
}

export interface BreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  now?: () => number;
}

interface Entry {
  state: BreakerState;
  failures: number;
  openedAtMs: number | null;
  lastReason: string | null;
  refused: number;
}

export class BreakerRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: BreakerOptions) {
    this.failureThreshold = Math.max(1, options.failureThreshold);
    this.cooldownMs = Math.max(0, options.cooldownMs);
    this.now = options.now ?? (() => Date.now());
  }

  private entry(key: string): Entry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { state: 'closed', failures: 0, openedAtMs: null, lastReason: null, refused: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /**
   * Whether a call to `key` may proceed. Transitions an expired `open` breaker
   * to `half_open`, which lets exactly the next call through as a probe.
   */
  allows(key: string): boolean {
    const entry = this.entry(key);
    if (entry.state === 'closed' || entry.state === 'half_open') return true;

    const openedAt = entry.openedAtMs ?? 0;
    if (this.now() - openedAt >= this.cooldownMs) {
      entry.state = 'half_open';
      return true;
    }
    entry.refused += 1;
    return false;
  }

  /** Keys among `candidates` whose breaker currently allows a call. */
  filterAllowed(candidates: string[]): { allowed: string[]; skipped: string[] } {
    const allowed: string[] = [];
    const skipped: string[] = [];
    for (const key of candidates) {
      if (this.allows(key)) allowed.push(key);
      else skipped.push(key);
    }
    return { allowed, skipped };
  }

  success(key: string): void {
    const entry = this.entry(key);
    entry.state = 'closed';
    entry.failures = 0;
    entry.openedAtMs = null;
    entry.lastReason = null;
  }

  failure(key: string, reason: string): BreakerState {
    const entry = this.entry(key);
    entry.lastReason = reason.slice(0, 200);

    // A failed probe re-opens immediately: the upstream is still unhealthy, and
    // waiting out another full cooldown is the point.
    if (entry.state === 'half_open') {
      entry.state = 'open';
      entry.openedAtMs = this.now();
      entry.failures = this.failureThreshold;
      return entry.state;
    }

    entry.failures += 1;
    if (entry.failures >= this.failureThreshold) {
      entry.state = 'open';
      entry.openedAtMs = this.now();
    }
    return entry.state;
  }

  state(key: string): BreakerState {
    return this.entry(key).state;
  }

  /** Manual reset, used by the diagnostics endpoint. */
  reset(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  snapshot(): Record<string, BreakerSnapshot> {
    const out: Record<string, BreakerSnapshot> = {};
    for (const [key, entry] of this.entries) {
      out[key] = {
        state: entry.state,
        failures: entry.failures,
        openedAt: entry.openedAtMs === null ? null : new Date(entry.openedAtMs).toISOString(),
        lastReason: entry.lastReason,
        refused: entry.refused,
      };
    }
    return out;
  }

  /** True when at least one breaker is open — surfaced by /health. */
  anyOpen(): boolean {
    for (const entry of this.entries.values()) if (entry.state === 'open') return true;
    return false;
  }
}
