#!/usr/bin/env tsx
/**
 * Extracts a backup produced by `db:backup` into an empty directory and
 * opens it to prove it's a valid, restorable datadir. Never touches
 * `var/pgdata` — swapping a verified restore into production follows the
 * same rename → copy → verify → atomic-rename procedure documented in
 * la documentation d’installation, done deliberately, not by this script.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { BackupManifestEntry } from '@/lib/db/backup';
import { createPgliteSql } from '@/lib/db/pglite';
import { logger } from '@/lib/logging/logger';

function parseArgs(): { file: string; to: string } {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const toIdx = args.indexOf('--to');
  const file = fileIdx === -1 ? undefined : args[fileIdx + 1];
  const to = toIdx === -1 ? undefined : args[toIdx + 1];
  if (!file || !to) {
    throw new Error('usage: npm run db:restore -- --file <backup.tar.gz> --to <empty-directory>');
  }
  return { file: resolve(process.cwd(), file), to: resolve(process.cwd(), to) };
}

function verifyChecksum(file: string): void {
  const manifestFile = join(dirname(file), 'manifest.json');
  if (!existsSync(manifestFile)) {
    logger.warn('db.restore.no_manifest', { manifestFile });
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as BackupManifestEntry[];
  const entry = manifest.find((e) => e.file === basename(file));
  if (!entry) {
    logger.warn('db.restore.not_in_manifest', { file: basename(file) });
    return;
  }
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (actual !== entry.sha256) {
    throw new Error(`checksum mismatch for ${file}: manifest says ${entry.sha256}, extracted file hashes to ${actual}`);
  }
  logger.info('db.restore.checksum_ok', { file: basename(file), sha256: actual });
}

async function main(): Promise<void> {
  const { file, to } = parseArgs();
  if (!existsSync(file)) throw new Error(`backup file not found: ${file}`);
  if (existsSync(to) && readdirSync(to).length > 0) {
    throw new Error(`--to ${to} already exists and is not empty; refusing to extract over it`);
  }

  verifyChecksum(file);
  mkdirSync(to, { recursive: true });

  const tar = spawnSync('tar', ['-xzf', file, '-C', to], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error(`tar extraction failed with exit code ${String(tar.status)}`);

  const sql = await createPgliteSql(to);
  try {
    const version = await sql.query<{ version: string }>('select version()');
    const tables = await sql.query<{ count: string }>(
      "select count(*) as count from information_schema.tables where table_schema = 'public'",
    );
    logger.info('db.restore.verified', {
      to,
      version: version[0]?.version,
      publicTables: tables[0]?.count,
    });
  } finally {
    await sql.close();
  }

  logger.info('db.restore.done', { file, to });
}

main().catch((error: unknown) => {
  logger.error('db.restore.failed', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
