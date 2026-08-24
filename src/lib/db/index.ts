import type { Sql } from '@/lib/db/sql';
import { resolveDbConfig, type DbConfig } from '@/lib/db/config';

/**
 * The single point where the process acquires its database handle.
 *
 * The backend is declared, not inferred here: `@/lib/db/config` owns that
 * decision and this module only routes it. Both drivers are imported lazily so
 * a Postgres runtime never loads PGlite's WASM (≈314 MB resident per process,
 * measured in la documentation d’installation — the reason DB1 exists), and a
 * PGlite test run never requires `pg` to be reachable.
 */
let cached: Promise<Sql> | null = null;

export function getSql(): Promise<Sql> {
  if (cached) return cached;
  cached = createSql().catch((error: unknown) => {
    // A failed connection must not be cached, or every later call in this
    // process replays the same stale rejection and can never recover.
    cached = null;
    throw error;
  });
  return cached;
}

async function createSql(config: DbConfig = resolveDbConfig()): Promise<Sql> {
  if (config.backend === 'postgres') {
    const { createPostgresSql } = await import('@/lib/db/postgres');
    return createPostgresSql(config);
  }
  const { createPgliteSql } = await import('@/lib/db/pglite');
  return createPgliteSql(config.dataDir);
}

/** Opens an independent handle, bypassing the process-wide cache. */
export function openSql(config: DbConfig): Promise<Sql> {
  return createSql(config);
}

/** Test helper: drop the cached connection so the next getSql() reconnects. */
export function resetSqlCache(): void {
  cached = null;
}

export type { Sql };
export { resolveDbConfig, describeDbConfig, type DbConfig } from '@/lib/db/config';
