/**
 * node-postgres driver — the target runtime backend (DB1).
 *
 * ---------------------------------------------------------------------------
 * What changes versus PGlite, and what deliberately does not
 * ---------------------------------------------------------------------------
 * Nothing in `db/migrations` and nothing in the repositories changes: both
 * drivers speak real Postgres, and they always have. What changes is the
 * *shape of ownership*. PGlite is an embedded engine with one owner per
 * datadir, enforced by `@/lib/db/pgliteDatadirLock`. A Postgres server has a
 * connection pool and many owners, which is the entire point of DB1 — the CRM,
 * the Gmail watcher and the workers open their own pools against the same
 * database at the same time.
 *
 * So this driver takes **no process-level lock**. Concurrency is the server's
 * job now, expressed in SQL (`for update` in `@/lib/pipeline/r6bDispatch`),
 * not in the filesystem.
 *
 * ---------------------------------------------------------------------------
 * Type parity is a correctness requirement, not a nicety
 * ---------------------------------------------------------------------------
 * The domain types were written against what PGlite returns. Two OIDs differ
 * from node-postgres' defaults, and both would fail silently rather than loudly:
 *
 *   * `numeric` (1700) — node-postgres returns a string to preserve precision.
 *     Every numeric column here is a score, a confidence or a rating, declared
 *     `number` in the domain.
 *   * `int8` (20) — node-postgres returns a string; PGlite returns a number.
 *     This is what `count(*)` comes back as. Left alone, every count in the
 *     CRM would become a string that compares wrong and renders right, which
 *     is the worst combination available.
 *
 * The parsers are attached to the pool rather than through the global
 * `pg.types.setTypeParser`, so importing this module cannot change how some
 * other pg consumer in the process reads its rows.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import type { Sql } from '@/lib/db/sql';
import type { PostgresConfig } from '@/lib/db/config';
import { describeDbConfig } from '@/lib/db/config';
import { logger } from '@/lib/logging/logger';

const { Pool, types: defaultTypes } = pg;

/** `numeric` — string by default in node-postgres, number in the domain. */
const NUMERIC_OID = 1700;
/** `int8`/`bigint` — string by default in node-postgres, number in PGlite. */
const INT8_OID = 20;

/**
 * Per-pool parser overrides. Values above 2^53 would lose precision as JS
 * numbers, but every int8 the schema produces is a `count(*)` or a byte size,
 * and matching PGlite exactly is what keeps one code path correct on two
 * backends.
 */
const typeParsers: { getTypeParser: typeof defaultTypes.getTypeParser } = {
  getTypeParser(oid: number, format?: unknown) {
    if (oid === NUMERIC_OID) return (value: string) => Number.parseFloat(value);
    if (oid === INT8_OID) return (value: string) => Number.parseInt(value, 10);
    return defaultTypes.getTypeParser(oid, format as never);
  },
};

type PoolClient = pg.PoolClient;

/**
 * Session settings pinned on **every** physical connection.
 *
 * These control how values render as text, which the transfer (`format('%L')`)
 * and the audit (`md5(t.*::text)`) both depend on. Applying them with a plain
 * `SET` through the pool would be a bug that hides itself: the statement lands
 * on whichever connection the pool happened to hand out, and the next query may
 * run on a different one that never saw it. A local single-connection cluster
 * makes that look like it works; a remote pool does not.
 *
 * So they are attached to the `connect` event instead — the one place that runs
 * exactly once per physical connection, including connections the pool opens
 * later under load.
 */
const SESSION_SETTINGS = [
  "set time zone 'UTC'",
  "set datestyle to 'ISO, YMD'",
  'set extra_float_digits to 1',
  "set bytea_output to 'hex'",
].join('; ');

/**
 * Maps the declared posture onto what node-postgres expects.
 *
 * When a CA bundle is configured it is loaded and handed to the TLS stack, so
 * `verify-full` can succeed against a provider whose certificate is signed by
 * its own authority instead of a public one. A missing or unreadable bundle is
 * a hard error: silently continuing would verify against the system store,
 * fail, and push the operator toward disabling verification altogether.
 */
function sslOption(config: PostgresConfig): boolean | { rejectUnauthorized: boolean; ca?: string } {
  if (config.ssl === 'disable') return false;

  const rejectUnauthorized = config.ssl === 'verify-full';
  if (!config.sslRootCertPath) return { rejectUnauthorized };

  const path = resolve(process.cwd(), config.sslRootCertPath);
  try {
    return { rejectUnauthorized, ca: readFileSync(path, 'utf8') };
  } catch (cause) {
    throw new Error(
      `OUTBOUND_DB_SSL_ROOT_CERT points at ${path}, which could not be read. ` +
        'Download the provider CA certificate, or unset the variable to verify ' +
        'against the system trust store.',
      { cause: cause as Error },
    );
  }
}

/**
 * Wraps a client already inside a transaction.
 *
 * `transaction()` here reuses the open transaction instead of nesting, which
 * is exactly what the PGlite driver does and what `@/lib/replies/state.ts`
 * documents relying on: a repository helper that opens a transaction stays
 * correct when called from an already-transactional caller.
 */
function fromClient(client: PoolClient): Sql {
  const tx: Sql = {
    driver: 'postgres',
    async query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      const result = await client.query(text, params ? [...params] : undefined);
      return result.rows as T[];
    },
    async exec(text: string) {
      await client.query(text);
    },
    async transaction<T>(fn: (inner: Sql) => Promise<T>) {
      return fn(tx);
    },
    async close() {
      /* The transaction owner releases the client; a nested handle must not. */
    },
  };
  return tx;
}

export async function createPostgresSql(config: PostgresConfig): Promise<Sql> {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.poolMax,
    application_name: config.applicationName,
    statement_timeout: config.statementTimeoutMs > 0 ? config.statementTimeoutMs : undefined,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    ssl: sslOption(config),
    types: typeParsers,
  });

  /**
   * An idle pooled client that loses its connection emits `error` on the pool.
   * Without this listener Node treats it as an unhandled 'error' event and
   * takes the whole process down — a provider-side restart would kill the CRM.
   */
  pool.on('error', (error: Error) => {
    logger.error('postgres.pool.error', { error: error.message });
  });

  pool.on('connect', (client) => {
    // Fire-and-forget by necessity: the event handler cannot be awaited. A
    // failure here would make text rendering inconsistent, so it is logged
    // rather than swallowed — and the settings themselves cannot fail on a
    // healthy connection.
    client.query(SESSION_SETTINGS).catch((error: unknown) => {
      logger.error('postgres.session.pin_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  // Fail fast and loudly at startup rather than on the first user request.
  const probe = await pool.connect().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Cannot connect to Postgres at ${describeDbConfig(config).target as string}: ${message}`,
      { cause: cause as Error },
    );
  });
  probe.release();
  logger.info('postgres.pool.ready', describeDbConfig(config));

  return {
    driver: 'postgres',
    async query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      const result = await pool.query(text, params ? [...params] : undefined);
      return result.rows as T[];
    },
    async exec(text: string) {
      await pool.query(text);
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn(fromClient(client));
        await client.query('commit');
        return out;
      } catch (error) {
        // A failed rollback means the connection is already gone; the client is
        // released either way and the original error is what the caller needs.
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
