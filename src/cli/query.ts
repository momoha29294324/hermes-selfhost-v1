#!/usr/bin/env tsx
/**
 * Ad-hoc read-only SQL against the local database, for inspection.
 *
 *   npm run db:psql -- "select display_name, score from prospects order by score desc limit 10"
 */
import { getSql } from '@/lib/db';

async function main(): Promise<void> {
  const statement = process.argv.slice(2).join(' ').trim();
  if (!statement) throw new Error('Usage: npm run db:psql -- "<select ...>"');
  if (!/^\s*(select|with|explain)\b/i.test(statement)) {
    throw new Error('Only read statements are allowed here. Use a migration for changes.');
  }

  const sql = await getSql();
  const rows = await sql.query(statement);
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  process.stdout.write(`${rows.length} ligne(s)\n`);
  await sql.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
