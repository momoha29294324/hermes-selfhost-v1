import type { Sql } from '@/lib/db/sql';

/**
 * One writer, whatever the concurrency upstream.
 *
 * ---------------------------------------------------------------------------
 * Why this exists at all
 * ---------------------------------------------------------------------------
 * R5.1 runs several LLM calls at once. The calls themselves are independent —
 * separate `codex exec` processes, no shared state — but each of them wants to
 * write: a `model_runs` row, several `llm_attempts` rows, a benchmark result.
 *
 * PGlite is an embedded Postgres running in this process. It is not a server
 * with a connection pool: there is one instance, and `transaction()` on it
 * takes a real lock. Two concurrent transactions therefore do not queue
 * politely — the second one is issued against a handle that is already inside
 * the first, and the failure mode is either a deadlock or, worse, statements
 * landing in someone else's transaction and being rolled back with it.
 *
 * The rule the §18 of the mission asks for is "do not open several writers if
 * the architecture does not allow it". This wrapper is that rule, expressed
 * once, rather than a convention every call site is expected to remember.
 *
 * ---------------------------------------------------------------------------
 * The shape of the answer
 * ---------------------------------------------------------------------------
 * A promise chain, not a lock and not a worker thread. Every write is appended
 * to a single chain and runs when its predecessor has settled, so:
 *
 *   * order is the order the callers asked for — a benchmark result can never
 *     land before the run it belongs to;
 *   * a failed write does not poison the chain: the link is caught internally
 *     and the caller still sees its own rejection;
 *   * reads are NOT queued. They take no lock, they do not need ordering, and
 *     serialising them would turn a concurrency benchmark into a measurement of
 *     this file.
 *
 * The cost is real and worth naming: a write waits for every write queued
 * before it. With the row counts here (a few hundred small inserts per run)
 * that is microseconds. If a future stage writes thousands of rows per
 * prospect, batching belongs at the call site — not a second writer.
 */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private peak = 0;

  constructor(private readonly sql: Sql) {}

  /** How many writes are waiting or running right now. */
  get depth(): number {
    return this.queued;
  }

  /** The deepest the queue ever got — the contention this run actually saw. */
  get peakDepth(): number {
    return this.peak;
  }

  /** Runs `fn` when every previously enqueued write has settled. */
  enqueue<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    this.queued += 1;
    if (this.queued > this.peak) this.peak = this.queued;

    const run = this.tail.then(
      () => fn(this.sql),
      () => fn(this.sql),
    );
    // The chain must survive a rejected link, or one failed insert would make
    // every later write reject with somebody else's error.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.queued -= 1;
    });
  }

  /** Resolves once the queue is empty. Call before closing the database. */
  async drain(): Promise<void> {
    await this.tail;
  }
}

/**
 * An `Sql` whose writes go through the queue and whose reads do not.
 *
 * Handed to anything that runs concurrently — the router, the benchmark harness
 * — so the single-writer rule holds without those modules knowing it exists.
 *
 * A statement is classified by its first keyword. Anything that is not a plain
 * `select`/`with`/`explain` is treated as a write, which is the safe direction
 * to be wrong in: a queued read costs latency, an unqueued write costs data.
 */
export function serialized(sql: Sql, queue: WriteQueue): Sql {
  const wrapped: Sql = {
    driver: sql.driver,
    async query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      if (isReadOnly(text)) return sql.query<T>(text, params);
      return queue.enqueue((inner) => inner.query<T>(text, params));
    },
    async exec(text: string) {
      await queue.enqueue((inner) => inner.exec(text));
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      // The whole transaction is one link in the chain: splitting it would let
      // another writer's statements interleave inside it, which is the exact
      // corruption this file exists to prevent.
      return queue.enqueue((inner) => inner.transaction(fn));
    },
    async close() {
      await queue.drain();
      await sql.close();
    },
  };
  return wrapped;
}

export function isReadOnly(statement: string): boolean {
  if (!/^\s*(select|with|explain|show)\b/i.test(statement)) return false;
  // `with x as (insert ... returning ...) select ...` starts like a read and
  // writes. Postgres allows it, so the keyword test alone is not enough.
  return !/\b(insert|update|delete|merge|create|drop|alter|truncate)\b/i.test(statement);
}
