import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Sql } from '@/lib/db/sql';
import { logger } from '@/lib/logging/logger';

const MIGRATIONS_DIR = resolve(process.cwd(), 'db/migrations');

export interface AppliedMigration {
  version: string;
  checksum: string;
}

export function listMigrationFiles(dir = MIGRATIONS_DIR): { version: string; path: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ version: f.replace(/\.sql$/, ''), path: resolve(dir, f) }));
}

/**
 * Applies pending migrations in lexical order. Idempotent: already-applied
 * versions are skipped, and a changed checksum is a hard error rather than a
 * silent divergence.
 */
export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  await sql.exec(`
    create table if not exists schema_migrations (
      version     text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    );
  `);

  const applied = await sql.query<AppliedMigration>('select version, checksum from schema_migrations');
  const appliedMap = new Map(applied.map((row) => [row.version, row.checksum]));
  const executed: string[] = [];

  for (const file of listMigrationFiles(dir)) {
    const body = readFileSync(file.path, 'utf8');
    const checksum = createHash('sha256').update(body).digest('hex').slice(0, 32);
    const known = appliedMap.get(file.version);

    if (known !== undefined) {
      if (known !== checksum) {
        throw new Error(
          `Migration ${file.version} changed after being applied (checksum ${known} -> ${checksum}). ` +
            'Add a new migration instead of editing an applied one.',
        );
      }
      continue;
    }

    logger.info('migration.apply', { version: file.version });
    await sql.transaction(async (tx) => {
      await tx.exec(body);
      await tx.query('insert into schema_migrations (version, checksum) values ($1, $2)', [
        file.version,
        checksum,
      ]);
    });
    executed.push(file.version);
  }

  return executed;
}
