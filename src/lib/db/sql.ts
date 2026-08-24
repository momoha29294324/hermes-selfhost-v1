/**
 * The only database surface the domain is allowed to see.
 *
 * Two drivers implement it: PGlite (embedded Postgres, local dev) and node-postgres
 * (Supabase / any managed Postgres). Because both speak real Postgres, the SQL in
 * db/migrations and in the repositories is identical for both — moving to a hosted
 * instance is a driver swap, not a domain rewrite.
 */
export interface Sql {
  /** Parameterised query ($1, $2, …). Always use params; never interpolate. */
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Multi-statement DDL execution (migrations only). */
  exec(text: string): Promise<void>;
  /** Runs `fn` inside a transaction, rolling back on throw. */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly driver: 'pglite' | 'postgres';
}

export async function one<T = Record<string, unknown>>(
  sql: Sql,
  text: string,
  params?: readonly unknown[],
): Promise<T> {
  const rows = await sql.query<T>(text, params);
  const row = rows[0];
  if (row === undefined) throw new Error(`Expected exactly one row, got ${rows.length}`);
  return row;
}

export async function maybeOne<T = Record<string, unknown>>(
  sql: Sql,
  text: string,
  params?: readonly unknown[],
): Promise<T | null> {
  const rows = await sql.query<T>(text, params);
  return rows[0] ?? null;
}
