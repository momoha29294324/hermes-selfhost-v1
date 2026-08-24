/**
 * The one place that decides which database backend the process talks to.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists
 * ---------------------------------------------------------------------------
 * Until DB1 the choice lived inline in `@/lib/db/index.ts` as a single ternary
 * on `OUTBOUND_DATABASE_URL`. That was enough while PGlite was the default and
 * Postgres the hypothesis. It stops being enough the moment the runtime is
 * several processes — the CRM, the Gmail watcher, discovery, nurture — because
 * then "which backend am I on" is a question every operator asks, and an
 * inferred answer is the wrong kind of answer.
 *
 * So the backend is now *declared*, and the declaration is resolved exactly
 * once, here. Everything downstream reads a typed `DbConfig` and never touches
 * `process.env` again. That is the whole anti-sprawl rule: no module below this
 * one is allowed to branch on the backend.
 *
 * ---------------------------------------------------------------------------
 * Resolution order
 * ---------------------------------------------------------------------------
 *   OUTBOUND_DB_BACKEND=postgres  -> Postgres, URL required (hard error if absent)
 *   OUTBOUND_DB_BACKEND=pglite    -> PGlite, datadir OUTBOUND_DB_DIR
 *   unset + OUTBOUND_DATABASE_URL -> Postgres  (back-compat with the old rule)
 *   unset + nothing               -> PGlite    (back-compat: tests, transitional dev)
 *
 * Credentials only ever arrive through the environment. Nothing in this file
 * carries a host, a user or a password, and `describeDbConfig` is the only
 * sanctioned way to put a connection into a log line.
 */
import { resolve } from 'node:path';
import { env, envInt } from '@/lib/env';

export type DbBackend = 'pglite' | 'postgres';

/**
 * TLS posture for a Postgres connection.
 *
 *   disable      — plaintext. Only ever appropriate for a loopback test cluster.
 *   require      — encrypted, certificate not verified. Protects against passive
 *                  capture but not against an active man-in-the-middle.
 *   verify-full  — encrypted and the server certificate is verified against the
 *                  system trust store. The correct setting for a managed
 *                  provider reachable over the public internet.
 */
export type SslMode = 'disable' | 'require' | 'verify-full';

export interface PgliteConfig {
  readonly backend: 'pglite';
  /** Absolute path to the embedded datadir. */
  readonly dataDir: string;
}

export interface PostgresConfig {
  readonly backend: 'postgres';
  /** Full libpq URL. Never logged — use `describeDbConfig`. */
  readonly connectionString: string;
  /** Upper bound on server-side connections held by THIS process. */
  readonly poolMax: number;
  /** Shows up in `pg_stat_activity`, so an operator can tell the processes apart. */
  readonly applicationName: string;
  /** TLS posture. Defaults to `verify-full` for any non-loopback host. */
  readonly ssl: SslMode;
  /**
   * Path to a PEM CA bundle used to verify the server certificate — the
   * equivalent of libpq's `sslrootcert`.
   *
   * Managed providers commonly terminate TLS with a certificate signed by
   * their own CA rather than a public one; Supabase's connection pooler does.
   * Without the CA, `verify-full` fails with "self-signed certificate in
   * certificate chain", and the tempting fix is to drop to `require` — which
   * keeps the encryption but abandons the identity check, so an active
   * man-in-the-middle stops being detectable. Pinning the CA keeps full
   * verification instead of trading it away.
   */
  readonly sslRootCertPath?: string;
  /** Server-side statement timeout. 0 disables it. */
  readonly statementTimeoutMs: number;
  /** How long a client may sit idle in the pool before being dropped. */
  readonly idleTimeoutMs: number;
  /** How long to wait for a connection before failing. */
  readonly connectionTimeoutMs: number;
}

export type DbConfig = PgliteConfig | PostgresConfig;

/** Injected in tests; defaults to the process environment. */
export type EnvReader = (key: string, fallback?: string) => string | undefined;

export class DbConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbConfigError';
  }
}

const DEFAULT_DATADIR = './var/pgdata';
const DEFAULT_POOL_MAX = 10;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

/** True for a host that cannot leave this machine. */
function isLoopback(connectionString: string): boolean {
  try {
    const host = new URL(connectionString).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '';
  } catch {
    return false;
  }
}

/**
 * Resolves the TLS posture.
 *
 * The default is deliberately asymmetric: a loopback cluster gets plaintext
 * (there is no network to protect and no certificate to verify), and anything
 * else gets `verify-full`. A managed provider like Supabase is reached over the
 * public internet, so "encrypted but unverified" is not a safe default to
 * inherit silently — downgrading has to be typed out.
 */
function readSslMode(read: EnvReader, connectionString: string): SslMode {
  const raw = read('OUTBOUND_DB_SSL');
  if (raw === undefined) return isLoopback(connectionString) ? 'disable' : 'verify-full';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'disable' || normalized === 'off' || normalized === 'false') return 'disable';
  if (normalized === 'require') return 'require';
  if (normalized === 'verify-full' || normalized === 'verify_full' || normalized === 'on') return 'verify-full';
  throw new DbConfigError(
    `OUTBOUND_DB_SSL must be "disable", "require" or "verify-full" (got "${raw}").`,
  );
}

function readBackend(read: EnvReader): DbBackend | null {
  const raw = read('OUTBOUND_DB_BACKEND');
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'postgres' || normalized === 'postgresql' || normalized === 'pg') return 'postgres';
  if (normalized === 'pglite' || normalized === 'embedded') return 'pglite';
  throw new DbConfigError(
    `OUTBOUND_DB_BACKEND must be "postgres" or "pglite" (got "${raw}").`,
  );
}

/**
 * Derives a default `application_name` from the entry point, so
 * `pg_stat_activity` distinguishes the CRM from the inbound watcher without
 * anyone having to set a variable per process.
 */
function defaultApplicationName(read: EnvReader): string {
  const explicit = read('OUTBOUND_DB_APP_NAME');
  if (explicit) return explicit.slice(0, 63);
  const entry = process.argv[1];
  const leaf = entry ? entry.split('/').pop()?.replace(/\.[cm]?[jt]s$/, '') : undefined;
  return `hermes-${leaf && leaf.length > 0 ? leaf : 'app'}`.slice(0, 63);
}

/**
 * Resolves the backend declaration into a typed config.
 *
 * Throws rather than guessing: a process that asked for Postgres and has no
 * URL must not quietly open an embedded database and write the corpus into a
 * file nobody is watching.
 */
export function resolveDbConfig(read: EnvReader = env): DbConfig {
  const declared = readBackend(read);
  const url = read('OUTBOUND_DATABASE_URL');
  const backend: DbBackend = declared ?? (url ? 'postgres' : 'pglite');

  if (backend === 'postgres') {
    if (!url) {
      throw new DbConfigError(
        'OUTBOUND_DB_BACKEND=postgres requires OUTBOUND_DATABASE_URL ' +
          '(e.g. postgresql://user:password@127.0.0.1:5433/hermes_outbound). ' +
          'Credentials come from the environment only — never from a file in Git.',
      );
    }
    return {
      backend: 'postgres',
      connectionString: url,
      poolMax: envInt('OUTBOUND_DB_POOL_MAX', DEFAULT_POOL_MAX),
      applicationName: defaultApplicationName(read),
      ssl: readSslMode(read, url),
      sslRootCertPath: read('OUTBOUND_DB_SSL_ROOT_CERT'),
      statementTimeoutMs: envInt('OUTBOUND_DB_STATEMENT_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS),
      idleTimeoutMs: envInt('OUTBOUND_DB_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS),
      connectionTimeoutMs: envInt('OUTBOUND_DB_CONNECT_TIMEOUT_MS', DEFAULT_CONNECTION_TIMEOUT_MS),
    };
  }

  return {
    backend: 'pglite',
    dataDir: resolve(process.cwd(), read('OUTBOUND_DB_DIR', DEFAULT_DATADIR) as string),
  };
}

/**
 * Strips userinfo and query string from a libqp URL so a connection can be
 * named in a log without leaking the password.
 *
 * Anything that fails to parse degrades to the scheme alone — an unparseable
 * URL is exactly the case where blind string surgery would leak.
 */
export function redactConnectionString(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    const port = parsed.port ? `:${parsed.port}` : '';
    const database = parsed.pathname.replace(/^\//, '');
    const user = parsed.username ? `${parsed.username}@` : '';
    return `${parsed.protocol}//${user}${parsed.hostname}${port}/${database}`;
  } catch {
    return '<unparseable connection string>';
  }
}

/** A log-safe description of the resolved backend. Never contains a password. */
export function describeDbConfig(config: DbConfig): Record<string, unknown> {
  if (config.backend === 'pglite') {
    return { backend: 'pglite', dataDir: config.dataDir };
  }
  return {
    backend: 'postgres',
    target: redactConnectionString(config.connectionString),
    poolMax: config.poolMax,
    applicationName: config.applicationName,
    ssl: config.ssl,
  };
}
