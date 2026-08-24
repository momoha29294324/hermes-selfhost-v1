import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupPgliteDataDir, type BackupManifestEntry } from '@/lib/db/backup';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { DatadirLockedError } from '@/lib/db/pgliteDatadirLock';

let root: string;
let dataDir: string;
let backupsDir: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'hermes-backup-'));
  dataDir = join(root, 'pgdata');
  backupsDir = join(root, 'backups');
  const sql = await createPgliteSql(dataDir);
  await migrate(sql);
  await sql.query(
    `insert into campaigns (slug, name, niche_key, config) values ('backup-test','Backup Test','example-services','{}'::jsonb)`,
  );
  await sql.close();
}, 60_000);

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('backupPgliteDataDir', () => {
  it('produces a hashed tarball and a manifest entry', async () => {
    const result = await backupPgliteDataDir(dataDir, backupsDir, { now: new Date('2026-08-12T00:00:00.000Z') });

    const tarballPath = join(backupsDir, result.file);
    expect(existsSync(tarballPath)).toBe(true);
    const actualHash = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
    expect(actualHash).toBe(result.sha256);

    const manifest = JSON.parse(readFileSync(join(backupsDir, 'manifest.json'), 'utf8')) as BackupManifestEntry[];
    expect(manifest).toHaveLength(1);
    expect(manifest[0]?.file).toBe(result.file);
    expect(manifest[0]?.sha256).toBe(result.sha256);
  }, 60_000);

  it('prunes the oldest generations beyond retention', async () => {
    await backupPgliteDataDir(dataDir, backupsDir, { retention: 2, now: new Date('2026-08-01T00:00:00.000Z') });
    await backupPgliteDataDir(dataDir, backupsDir, { retention: 2, now: new Date('2026-08-02T00:00:00.000Z') });
    const third = await backupPgliteDataDir(dataDir, backupsDir, {
      retention: 2,
      now: new Date('2026-08-03T00:00:00.000Z'),
    });

    expect(third.pruned).toHaveLength(1);
    expect(third.pruned[0]).toContain('2026-08-01');

    const manifest = JSON.parse(readFileSync(join(backupsDir, 'manifest.json'), 'utf8')) as BackupManifestEntry[];
    expect(manifest).toHaveLength(2);
    expect(existsSync(join(backupsDir, third.pruned[0] as string))).toBe(false);

    const remainingFiles = readdirSync(backupsDir).filter((f) => f.endsWith('.tar.gz'));
    expect(remainingFiles).toHaveLength(2);
  }, 60_000);

  it('refuses to back up a datadir another live process already has open', async () => {
    const held = await createPgliteSql(dataDir);
    await expect(backupPgliteDataDir(dataDir, backupsDir)).rejects.toThrow(DatadirLockedError);
    await held.close();
  }, 60_000);

  it('restores to a working, queryable datadir via extraction + open', async () => {
    const result = await backupPgliteDataDir(dataDir, backupsDir);
    const extractDir = mkdtempSync(join(tmpdir(), 'hermes-restore-'));
    try {
      const tar = spawnSync('tar', ['-xzf', join(backupsDir, result.file), '-C', extractDir], { stdio: 'ignore' });
      expect(tar.status).toBe(0);

      const sql = await createPgliteSql(extractDir);
      try {
        const rows = await sql.query<{ slug: string }>("select slug from campaigns where slug = 'backup-test'");
        expect(rows).toHaveLength(1);
      } finally {
        await sql.close();
      }
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  }, 60_000);
});
