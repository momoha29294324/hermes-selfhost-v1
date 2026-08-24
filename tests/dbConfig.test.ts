/**
 * The backend declaration is the one decision every process depends on, and
 * getting it wrong silently is the expensive failure: a worker that meant to
 * write to PostgreSQL and quietly opened an embedded datadir would look
 * healthy while writing the corpus somewhere nobody reads.
 *
 * These tests pin the resolution rules and, above all, the refusals.
 */
import { describe, expect, it } from 'vitest';
import {
  DbConfigError,
  describeDbConfig,
  redactConnectionString,
  resolveDbConfig,
} from '@/lib/db/config';

/** A fake environment, so nothing here depends on the developer's own `.env`. */
function reader(values: Record<string, string>) {
  return (key: string, fallback?: string): string | undefined => values[key] ?? fallback;
}

describe('resolveDbConfig', () => {
  it('defaults to PGlite when nothing is declared — the transitional dev path', () => {
    const config = resolveDbConfig(reader({}));
    expect(config.backend).toBe('pglite');
  });

  it('infers Postgres from a bare OUTBOUND_DATABASE_URL, preserving the old rule', () => {
    const config = resolveDbConfig(reader({ OUTBOUND_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/db' }));
    expect(config.backend).toBe('postgres');
  });

  it('honours an explicit pglite declaration even when a URL is present', () => {
    const config = resolveDbConfig(
      reader({ OUTBOUND_DB_BACKEND: 'pglite', OUTBOUND_DATABASE_URL: 'postgresql://u:p@h:5433/db' }),
    );
    expect(config.backend).toBe('pglite');
  });

  it('refuses to fall back to PGlite when Postgres was asked for without a URL', () => {
    // The important one. Guessing here would write production data into a file.
    expect(() => resolveDbConfig(reader({ OUTBOUND_DB_BACKEND: 'postgres' }))).toThrow(DbConfigError);
  });

  it('rejects an unknown backend rather than picking one', () => {
    expect(() => resolveDbConfig(reader({ OUTBOUND_DB_BACKEND: 'sqlite' }))).toThrow(DbConfigError);
  });

  it('carries pool settings from the environment', () => {
    const config = resolveDbConfig(
      reader({
        OUTBOUND_DB_BACKEND: 'postgres',
        OUTBOUND_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/db',
        OUTBOUND_DB_APP_NAME: 'hermes-inbound-watcher',
      }),
    );
    if (config.backend !== 'postgres') throw new Error('expected postgres');
    expect(config.applicationName).toBe('hermes-inbound-watcher');
    expect(config.poolMax).toBeGreaterThan(0);
  });
});

describe('TLS posture', () => {
  const remote = 'postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres';

  it('verifies certificates by default against a managed, non-loopback host', () => {
    // The one that matters for Supabase: reaching a database over the public
    // internet must not silently settle for "encrypted but unverified".
    const config = resolveDbConfig(reader({ OUTBOUND_DATABASE_URL: remote }));
    if (config.backend !== 'postgres') throw new Error('expected postgres');
    expect(config.ssl).toBe('verify-full');
  });

  it('does not demand TLS from a loopback test cluster', () => {
    const config = resolveDbConfig(
      reader({ OUTBOUND_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/hermes_outbound' }),
    );
    if (config.backend !== 'postgres') throw new Error('expected postgres');
    expect(config.ssl).toBe('disable');
  });

  it('allows an explicit downgrade, but only when typed out', () => {
    const config = resolveDbConfig(reader({ OUTBOUND_DATABASE_URL: remote, OUTBOUND_DB_SSL: 'require' }));
    if (config.backend !== 'postgres') throw new Error('expected postgres');
    expect(config.ssl).toBe('require');
  });

  it('carries a pinned CA bundle path, so verify-full survives a private PKI', () => {
    // Supabase's pooler chains to "Supabase Root 2021 CA", which no system
    // trust store carries. Pinning it keeps verification instead of trading it
    // away for `require`.
    const config = resolveDbConfig(
      reader({ OUTBOUND_DATABASE_URL: remote, OUTBOUND_DB_SSL_ROOT_CERT: './var/supabase-ca.crt' }),
    );
    if (config.backend !== 'postgres') throw new Error('expected postgres');
    expect(config.ssl).toBe('verify-full');
    expect(config.sslRootCertPath).toBe('./var/supabase-ca.crt');
  });

  it('rejects an unrecognised TLS mode instead of falling back', () => {
    expect(() => resolveDbConfig(reader({ OUTBOUND_DATABASE_URL: remote, OUTBOUND_DB_SSL: 'maybe' }))).toThrow(
      DbConfigError,
    );
  });
});

describe('credential redaction', () => {
  it('drops the password from a connection string', () => {
    const redacted = redactConnectionString('postgresql://hermes:sup3rs3cret@127.0.0.1:5433/hermes_outbound');
    expect(redacted).toBe('postgresql://hermes@127.0.0.1:5433/hermes_outbound');
    expect(redacted).not.toContain('sup3rs3cret');
  });

  it('degrades to a placeholder rather than leaking an unparseable string', () => {
    expect(redactConnectionString('not a url at all')).toBe('<unparseable connection string>');
  });

  it('never puts a password in the log-safe description', () => {
    const config = resolveDbConfig(
      reader({
        OUTBOUND_DB_BACKEND: 'postgres',
        OUTBOUND_DATABASE_URL: 'postgresql://hermes:hunter2@127.0.0.1:5433/db',
      }),
    );
    expect(JSON.stringify(describeDbConfig(config))).not.toContain('hunter2');
  });
});
