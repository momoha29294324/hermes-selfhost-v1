import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { acquireDatadirLock, type DatadirLock } from '@/lib/db/pgliteDatadirLock';
import type { Sql } from '@/lib/db/sql';

type PGliteLike = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  exec: (text: string) => Promise<unknown>;
};

function wrap(handle: PGliteLike, root: PGlite | null, lock: DatadirLock | null): Sql {
  const sql: Sql = {
    driver: 'pglite',
    async query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      const result = await handle.query(text, params ? [...params] : undefined);
      return result.rows as T[];
    },
    async exec(text: string) {
      await handle.exec(text);
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      if (!root) {
        // Already inside a transaction: reuse it rather than nesting.
        return fn(sql);
      }
      return root.transaction(async (tx) => fn(wrap(tx as unknown as PGliteLike, null, null))) as Promise<T>;
    },
    async close() {
      if (root) await root.close();
      lock?.release();
    },
  };
  return sql;
}

/**
 * Postgres hands `numeric` back as a string to preserve precision, and both
 * drivers do the same by default. Every numeric column here is a score, a
 * confidence or a rating — the domain types declare them as numbers, so the
 * parser is aligned with the types instead of scattering `Number(...)` across
 * the code (and crashing the day one is forgotten).
 */
const NUMERIC_OID = 1700;

export async function createPgliteSql(dataDir: string): Promise<Sql> {
  mkdirSync(dataDir, { recursive: true });
  const lock = acquireDatadirLock(dataDir);
  try {
    const pg = await PGlite.create({
      dataDir,
      parsers: { [NUMERIC_OID]: (value: string) => Number.parseFloat(value) },
    });
    return wrap(pg as unknown as PGliteLike, pg, lock);
  } catch (err) {
    lock.release();
    throw err;
  }
}
