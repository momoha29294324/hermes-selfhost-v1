/**
 * Cross-process fail-closed lock for a PGlite datadir.
 *
 * PGlite is an embedded, single-process Postgres: it has no server, no
 * connection pool, and (unlike a real `postmaster.pid`) nothing stopping a
 * second OS process from opening the same datadir at the same time. Two
 * processes writing to the same files concurrently is exactly the kind of
 * corruption la documentation d’installation had to recover from by
 * patching `pg_control` and replaying WAL by hand.
 *
 * This lock does not make concurrent access safe — it makes it impossible:
 * a second `createPgliteSql()` call against a locked datadir throws instead
 * of opening. It never silently removes a lock held by a live process; it
 * only reclaims a lock whose owning PID is confirmed dead (a stale lock left
 * behind by a crash), and logs when it does.
 *
 * The mechanism itself now lives in `@/lib/fs/exclusiveFileLock`, shared with
 * the Instagram browser-profile lease. Nothing about the behaviour described
 * above changed in the move: same atomic `O_EXCL` acquire, same fail-closed
 * stance on a live or unreadable holder, same PID-only staleness proof, same
 * `pglite.lock.stale_reclaimed` warning. What changed is that there is now ONE
 * implementation of it to review instead of two.
 */
import {
  acquireExclusiveFileLock,
  ExclusiveFileLockHeldError,
  ExclusiveFileLockUnreadableError,
  type ExclusiveLockHolder,
} from '@/lib/fs/exclusiveFileLock';
import { mkdirSync } from 'node:fs';
import { logger } from '@/lib/logging/logger';

type LockInfo = ExclusiveLockHolder;

export interface DatadirLock {
  release(): void;
}

export class DatadirLockedError extends Error {
  readonly dataDir: string;
  readonly holder: LockInfo;

  constructor(dataDir: string, holder: LockInfo) {
    super(
      `datadir ${dataDir} is already open in another process ` +
        `(pid ${holder.pid} on ${holder.hostname}, since ${holder.startedAt}, cmd: ${holder.cmd}). ` +
        `Refusing to open it a second time — PGlite has no connection pool and concurrent writers can corrupt the datadir.`,
    );
    this.name = 'DatadirLockedError';
    this.dataDir = dataDir;
    this.holder = holder;
  }
}

/**
 * Sibling file, never inside `dataDir` itself. PGlite's `dumpDataDir()`
 * (used by `@/lib/db/backup`) tars up `dataDir` verbatim — a lock file
 * living inside it would get baked into every backup, so every restore
 * would carry a stale lock claiming to be held by whatever PID happened to
 * be running the backup job.
 */
export function lockPath(dataDir: string): string {
  const trimmed = dataDir.endsWith('/') ? dataDir.slice(0, -1) : dataDir;
  return `${trimmed}.lock`;
}

/**
 * Acquires an exclusive lock on `dataDir`, or throws.
 *
 * - Fresh datadir / no lock file: acquires immediately.
 * - Lock held by a live PID: throws `DatadirLockedError` — fail closed.
 * - Lock held by a dead PID (process crashed without releasing): reclaims
 *   it after logging a warning, then retries the atomic acquire.
 */
export function acquireDatadirLock(dataDir: string): DatadirLock {
  // The datadir itself, not just the lock's parent: `createPgliteSql` expects
  // to find it there, and a lock taken on a path that does not exist yet would
  // be a lock on nothing.
  mkdirSync(dataDir, { recursive: true });
  const file = lockPath(dataDir);

  try {
    const lock = acquireExclusiveFileLock(file, {
      onStaleReclaim: (holder, attempt) => {
        logger.warn('pglite.lock.stale_reclaimed', { dataDir, ...holder, attempt });
      },
    });
    return { release: (): void => lock.release() };
  } catch (error) {
    // Traduction, pas enrichissement : les appelants (et les tests) connaissent
    // `DatadirLockedError`, et le message ci-dessus dit ce que PGlite risque —
    // ce que le verrou générique, lui, n'a pas à savoir.
    if (error instanceof ExclusiveFileLockHeldError) throw new DatadirLockedError(dataDir, error.holder);
    if (error instanceof ExclusiveFileLockUnreadableError) {
      throw new Error(
        `datadir lock file at ${file} exists but could not be read as a valid lock; ` +
          `refusing to open ${dataDir}. Remove it manually only after confirming no process holds it.`,
      );
    }
    throw error;
  }
}
