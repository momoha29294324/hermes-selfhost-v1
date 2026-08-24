/**
 * Periodic backup of the PGlite datadir.
 *
 * Uses PGlite's own `dumpDataDir()` — a physical snapshot taken through the
 * instance that owns the files — rather than a raw filesystem copy, which
 * could race a concurrent writer. Takes the same cross-process lock as
 * `createPgliteSql()` (`@/lib/db/pgliteDatadirLock`): if another process
 * already has the datadir open, this throws instead of reading a datadir
 * that's mid-write.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { acquireDatadirLock } from '@/lib/db/pgliteDatadirLock';
import { logger } from '@/lib/logging/logger';

const MANIFEST_FILE = 'manifest.json';

export interface BackupManifestEntry {
  file: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

export interface BackupResult extends BackupManifestEntry {
  pruned: string[];
}

function manifestPath(backupsDir: string): string {
  return join(backupsDir, MANIFEST_FILE);
}

function readManifest(backupsDir: string): BackupManifestEntry[] {
  const path = manifestPath(backupsDir);
  if (!existsSync(path)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? (parsed as BackupManifestEntry[]) : [];
  } catch {
    return [];
  }
}

function writeManifest(backupsDir: string, entries: BackupManifestEntry[]): void {
  writeFileSync(manifestPath(backupsDir), `${JSON.stringify(entries, null, 2)}\n`);
}

export interface BackupOptions {
  /** How many generations to keep (oldest pruned first). Default 14. */
  retention?: number;
  /** Injected for deterministic tests; defaults to the real clock. */
  now?: Date;
}

/**
 * Snapshots `dataDir` to a timestamped, gzip-compressed tarball in
 * `backupsDir` (outside the datadir), records it in `backupsDir/manifest.json`
 * with its SHA-256, and prunes the oldest backups beyond `retention`.
 */
export async function backupPgliteDataDir(
  dataDir: string,
  backupsDir: string,
  opts: BackupOptions = {},
): Promise<BackupResult> {
  const retention = opts.retention ?? 14;
  const now = opts.now ?? new Date();
  mkdirSync(backupsDir, { recursive: true });

  const lock = acquireDatadirLock(dataDir);
  let buf: Buffer;
  try {
    const pg = await PGlite.create({ dataDir });
    try {
      const dump = await pg.dumpDataDir('gzip');
      buf = Buffer.from(await dump.arrayBuffer());
    } finally {
      await pg.close();
    }
  } finally {
    lock.release();
  }

  const sha256 = createHash('sha256').update(buf).digest('hex');
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const filename = `pgdata-${stamp}.tar.gz`;
  writeFileSync(join(backupsDir, filename), buf);

  const entry: BackupManifestEntry = {
    file: filename,
    sha256,
    sizeBytes: buf.byteLength,
    createdAt: now.toISOString(),
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
  writeManifest(backupsDir, manifest);

  logger.info('pglite.backup.created', { dataDir, backupsDir, ...entry, pruned });

  return { ...entry, pruned };
}
