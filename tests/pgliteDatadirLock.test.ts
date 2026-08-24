import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDatadirLock, DatadirLockedError, lockPath } from '@/lib/db/pgliteDatadirLock';
import { createPgliteSql } from '@/lib/db/pglite';

/**
 * PGlite has no server and no connection pool — nothing stops a second OS
 * process from opening the same datadir concurrently, which is the failure
 * mode la documentation d’installation had to recover from by hand. This
 * lock is the guard against a repeat: fail closed on a live holder, reclaim
 * only a confirmed-dead one, never touch an unrelated datadir.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-lock-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  // The lock lives as a sibling of the datadir (never inside it, see
  // pgliteDatadirLock.ts), so it isn't caught by the recursive dir removal.
  rmSync(lockPath(dir), { force: true });
});

describe('acquireDatadirLock', () => {
  it('acquires a fresh datadir', () => {
    const lock = acquireDatadirLock(dir);
    expect(readFileSync(lockPath(dir), 'utf8')).toContain(String(process.pid));
    lock.release();
  });

  it('refuses a second acquire while the first is held by a live process', () => {
    const first = acquireDatadirLock(dir);
    expect(() => acquireDatadirLock(dir)).toThrow(DatadirLockedError);
    first.release();
  });

  it('lets a fresh acquire succeed again once the holder releases', () => {
    const first = acquireDatadirLock(dir);
    first.release();
    const second = acquireDatadirLock(dir);
    second.release();
  });

  it('reclaims a stale lock left by a dead pid, without touching a live one', () => {
    // A pid essentially guaranteed not to exist on this machine.
    const deadPid = 999_999;
    writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: deadPid, hostname: 'stale-host', startedAt: new Date(0).toISOString(), cmd: 'stale' }),
    );

    const reclaimed = acquireDatadirLock(dir);
    expect(readFileSync(lockPath(dir), 'utf8')).toContain(String(process.pid));
    reclaimed.release();
  });

  it('never silently deletes a lock owned by the current live process from another handle', () => {
    // Acquiring while held must throw, not clobber the existing lock file.
    const first = acquireDatadirLock(dir);
    const before = readFileSync(lockPath(dir), 'utf8');
    expect(() => acquireDatadirLock(dir)).toThrow(DatadirLockedError);
    const after = readFileSync(lockPath(dir), 'utf8');
    expect(after).toBe(before);
    first.release();
  });

  it('does not affect an unrelated, isolated datadir', () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'hermes-lock-other-'));
    try {
      const held = acquireDatadirLock(dir);
      const isolated = acquireDatadirLock(otherDir);
      isolated.release();
      held.release();
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
      rmSync(lockPath(otherDir), { force: true });
    }
  });
});

describe('createPgliteSql cross-process guard', () => {
  it('refuses to open a datadir that a live handle already has open', async () => {
    const dataDir = join(dir, 'pgdata');
    const sql = await createPgliteSql(dataDir);
    await expect(createPgliteSql(dataDir)).rejects.toThrow(DatadirLockedError);
    await sql.close();
  });

  it('allows reopening once the first handle has closed (releasing the lock)', async () => {
    const dataDir = join(dir, 'pgdata');
    const first = await createPgliteSql(dataDir);
    await first.close();
    const second = await createPgliteSql(dataDir);
    await second.close();
  });

  it('does not lock an unrelated, isolated test datadir', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'hermes-lock-sql-other-'));
    try {
      const dataDir = join(dir, 'pgdata');
      const held = await createPgliteSql(dataDir);
      const isolated = await createPgliteSql(join(otherDir, 'pgdata'));
      await isolated.close();
      await held.close();
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
