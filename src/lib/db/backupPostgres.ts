/**
 * Periodic backup of a PostgreSQL database.
 *
 * The PGlite sibling (`@/lib/db/backup`) snapshots a datadir through the engine
 * that owns it. A server has no datadir this process can see — it may not even
 * be on this machine — so the equivalent is a logical dump taken over the
 * connection, which is what `pg_dump` is for.
 *
 * Custom format (`-Fc`) rather than plain SQL: it is compressed, and it lets
 * `pg_restore` rebuild selectively (a single table, schema before data) instead
 * of forcing an all-or-nothing replay. That matters for the rollback story —
 *.
 *
 * The password never appears in an argument vector (`ps` is world-readable on
 * this host); it is passed to the child through `PGPASSWORD` in its own
 * environment, and the manifest records only the redacted target.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { env } from '@/lib/env';
import { redactConnectionString, type PostgresConfig } from '@/lib/db/config';
import { logger } from '@/lib/logging/logger';

const execFileAsync = promisify(execFile);
const MANIFEST_FILE = 'manifest-postgres.json';

export interface PostgresBackupEntry {
  file: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  /** Redacted — never carries the password. */
  target: string;
}

export interface PostgresBackupResult extends PostgresBackupEntry {
  pruned: string[];
}

export interface PostgresBackupOptions {
  retention?: number;
  now?: Date;
  /** Overrides the `pg_dump` binary; defaults to OUTBOUND_PG_DUMP or PATH. */
  pgDumpPath?: string;
}

function manifestPath(dir: string): string {
  return join(dir, MANIFEST_FILE);
}

function readManifest(dir: string): PostgresBackupEntry[] {
  const path = manifestPath(dir);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? (parsed as PostgresBackupEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Splits the password out of the URL so it can travel in the environment
 * instead of on the command line.
 */
function splitCredentials(connectionString: string): { url: string; password?: string } {
  try {
    const parsed = new URL(connectionString);
    const password = parsed.password;
    if (!password) return { url: connectionString };
    parsed.password = '';
    return { url: parsed.toString(), password: decodeURIComponent(password) };
  } catch {
    return { url: connectionString };
  }
}

export async function backupPostgres(
  config: PostgresConfig,
  backupsDir: string,
  opts: PostgresBackupOptions = {},
): Promise<PostgresBackupResult> {
  const retention = opts.retention ?? 14;
  const now = opts.now ?? new Date();
  const pgDump = opts.pgDumpPath ?? env('OUTBOUND_PG_DUMP', 'pg_dump') ?? 'pg_dump';
  mkdirSync(backupsDir, { recursive: true });

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const filename = `postgres-${stamp}.dump`;
  const outPath = join(backupsDir, filename);
  const { url, password } = splitCredentials(config.connectionString);

  const childEnv = { ...process.env };
  if (password !== undefined) childEnv.PGPASSWORD = password;

  try {
    await execFileAsync(pgDump, ['--format=custom', '--no-owner', '--no-acl', '--file', outPath, url], {
      env: childEnv,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `pg_dump a échoué pour ${redactConnectionString(config.connectionString)}. ` +
        `Vérifiez que « ${pgDump} » existe (OUTBOUND_PG_DUMP pour le préciser). Détail : ${message}`,
      { cause: cause as Error },
    );
  }

  const buf = readFileSync(outPath);
  const entry: PostgresBackupEntry = {
    file: filename,
    sha256: createHash('sha256').update(buf).digest('hex'),
    sizeBytes: statSync(outPath).size,
    createdAt: now.toISOString(),
    target: redactConnectionString(config.connectionString),
  };

  const manifest = [...readManifest(backupsDir), entry].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const pruned: string[] = [];
  while (manifest.length > retention) {
    const oldest = manifest.shift();
    if (!oldest) break;
    try {
      unlinkSync(join(backupsDir, oldest.file));
    } catch {
      // Already gone — nothing to prune.
    }
    pruned.push(oldest.file);
  }
  writeFileSync(manifestPath(backupsDir), `${JSON.stringify(manifest, null, 2)}\n`);

  logger.info('postgres.backup.created', { backupsDir, ...entry, pruned });
  return { ...entry, pruned };
}
