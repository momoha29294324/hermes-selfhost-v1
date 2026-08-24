/**
 * Verification of a PGlite → PostgreSQL transfer (DB1, phase 2).
 *
 * ---------------------------------------------------------------------------
 * What "verified" has to mean here
 * ---------------------------------------------------------------------------
 * A row count that matches proves almost nothing: it is satisfied by a copy
 * that transposed two columns, truncated every text, or turned a timestamp
 * into a different instant. So the audit compares a *snapshot* of each side,
 * and the snapshot is designed so that any single-value difference changes it.
 *
 * The pieces, and what each one catches:
 *
 *   * **row count per table** — the coarse check; catches a table skipped
 *     outright or a batch lost.
 *   * **content checksum per table** — `md5` of every row's text form,
 *     aggregated in sorted order so it does not depend on physical row order.
 *     This is what catches a wrong value, a wrong column order, or a truncated
 *     field. It is the load-bearing check.
 *   * **null count per column** — catches a nullable column that silently
 *     became all-null, which a checksum would also catch but which this
 *     reports in a form an operator can read.
 *   * **constraint inventory** — primary keys, foreign keys, unique and check
 *     constraints, compared by definition. This is the "no loss of constraints,
 *     indexes, FKs" requirement, checked rather than assumed.
 *   * **NOT NULL inventory** — read from `pg_attribute.attnotnull` rather than
 *     from `pg_constraint`, because the two ends run different major versions
 *     and only disagree about where NOT NULL is *recorded*, not about whether
 *     it is enforced. See `constraintInventory` for the full story.
 *   * **index inventory** — same, for indexes.
 *   * **applied migrations** — version *and* checksum, so the two databases are
 *     provably at the same schema revision.
 *
 * Checksums are only meaningful if both sides render text identically, which is
 * why every connection is put through `normalizeSession` (time zone, datestyle,
 * float digits, bytea format) before anything is read.
 */
import type { Sql } from '@/lib/db/sql';
import { listBaseTables, normalizeSession } from '@/lib/db/transfer';

export interface TableSnapshot {
  readonly table: string;
  readonly rows: number;
  /** md5 over every row's text form; '' for an empty table. */
  readonly checksum: string;
}

export interface ColumnNullability {
  readonly table: string;
  readonly column: string;
  readonly nulls: number;
}

export interface ConstraintRecord {
  readonly table: string;
  readonly name: string;
  readonly kind: string;
  readonly definition: string;
}

export interface IndexRecord {
  readonly table: string;
  readonly name: string;
  readonly definition: string;
}

export interface MigrationRecord {
  readonly version: string;
  readonly checksum: string;
}

export interface DatabaseSnapshot {
  readonly tables: readonly TableSnapshot[];
  readonly nullability: readonly ColumnNullability[];
  readonly constraints: readonly ConstraintRecord[];
  /** NOT NULL columns, read version-independently from `pg_attribute`. */
  readonly notNull: readonly ConstraintRecord[];
  readonly indexes: readonly IndexRecord[];
  readonly migrations: readonly MigrationRecord[];
}

function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Order-independent content hash of a table.
 *
 * `t.*::text` renders the whole row the way Postgres itself would print it, so
 * every column participates. Hashing each row first and then aggregating the
 * hashes **sorted** removes any dependence on physical order — the source is a
 * datadir that has been vacuumed and rewritten, the target is a fresh load, and
 * their heap orders have no reason to agree.
 */
async function tableChecksum(sql: Sql, table: string): Promise<string> {
  const rows = await sql.query<{ checksum: string | null }>(
    `select md5(string_agg(h, '' order by h)) as checksum
       from (select md5(t.*::text) as h from public.${ident(table)} t) s`,
  );
  return rows[0]?.checksum ?? '';
}

async function tableNullability(sql: Sql, table: string): Promise<ColumnNullability[]> {
  const columns = await sql.query<{ column_name: string }>(
    `select attname as column_name
       from pg_attribute
      where attrelid = ($1::regclass) and attnum > 0 and not attisdropped
      order by attnum`,
    [`public.${ident(table)}`],
  );
  if (columns.length === 0) return [];

  const projections = columns
    .map((c) => `count(*) filter (where ${ident(c.column_name)} is null)::bigint as ${ident(c.column_name)}`)
    .join(', ');
  const rows = await sql.query<Record<string, number>>(
    `select ${projections} from public.${ident(table)}`,
  );
  const row = rows[0];
  if (!row) return [];

  return columns.map((c) => ({
    table,
    column: c.column_name,
    nulls: Number(row[c.column_name] ?? 0),
  }));
}

/**
 * Primary keys, foreign keys, unique and check constraints.
 *
 * `contype = 'n'` (NOT NULL) is deliberately excluded, and the reason is a real
 * version difference rather than an oversight. PGlite 0.5.4 embeds PostgreSQL
 * 18, which records every NOT NULL as a *named row* in `pg_constraint`;
 * PostgreSQL 17 — the target — records it only as `pg_attribute.attnotnull`.
 * Comparing the catalog rows would therefore report all 603 NOT NULLs as "lost"
 * on a target where every one of them is enforced.
 *
 * The invariant is not skipped, it is checked where both versions agree:
 * `notNullInventory` below reads `attnotnull` directly.
 */
async function constraintInventory(sql: Sql): Promise<ConstraintRecord[]> {
  return sql.query<ConstraintRecord>(
    `select rel.relname as table,
            con.conname as name,
            con.contype::text as kind,
            pg_get_constraintdef(con.oid) as definition
       from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
       join pg_namespace n on n.oid = rel.relnamespace
      where n.nspname = 'public' and rel.relkind = 'r' and con.contype <> 'n'
      order by rel.relname, con.conname`,
  );
}

/**
 * Every NOT NULL column, read from `pg_attribute` — the one representation
 * PostgreSQL 17 and 18 both share.
 */
async function notNullInventory(sql: Sql): Promise<ConstraintRecord[]> {
  return sql.query<ConstraintRecord>(
    `select rel.relname as table,
            att.attname as name,
            'n'         as kind,
            'NOT NULL'  as definition
       from pg_attribute att
       join pg_class rel on rel.oid = att.attrelid
       join pg_namespace n on n.oid = rel.relnamespace
      where n.nspname = 'public' and rel.relkind = 'r'
        and att.attnum > 0 and not att.attisdropped and att.attnotnull
      order by rel.relname, att.attname`,
  );
}

async function indexInventory(sql: Sql): Promise<IndexRecord[]> {
  return sql.query<IndexRecord>(
    `select tablename as table, indexname as name, indexdef as definition
       from pg_indexes
      where schemaname = 'public'
      order by tablename, indexname`,
  );
}

async function migrationInventory(sql: Sql): Promise<MigrationRecord[]> {
  return sql.query<MigrationRecord>(
    'select version, checksum from schema_migrations order by version',
  );
}

/** Reads everything the comparison needs. Read-only. */
export async function snapshotDatabase(sql: Sql): Promise<DatabaseSnapshot> {
  await normalizeSession(sql);
  const tables = await listBaseTables(sql);

  const tableSnapshots: TableSnapshot[] = [];
  const nullability: ColumnNullability[] = [];
  for (const table of tables) {
    if (table === 'schema_migrations') continue;
    const rows = await sql.query<{ n: number }>(`select count(*)::bigint as n from public.${ident(table)}`);
    const count = Number(rows[0]?.n ?? 0);
    tableSnapshots.push({ table, rows: count, checksum: await tableChecksum(sql, table) });
    nullability.push(...(await tableNullability(sql, table)));
  }

  return {
    tables: tableSnapshots,
    nullability,
    constraints: await constraintInventory(sql),
    notNull: await notNullInventory(sql),
    indexes: await indexInventory(sql),
    migrations: await migrationInventory(sql),
  };
}

export interface SnapshotDifference {
  readonly kind:
    | 'row_count'
    | 'checksum'
    | 'nullability'
    | 'constraint'
    | 'not_null'
    | 'index'
    | 'migration'
    | 'table';
  readonly subject: string;
  readonly source: string;
  readonly target: string;
}

export interface ComparisonResult {
  readonly identical: boolean;
  readonly differences: readonly SnapshotDifference[];
  readonly tablesCompared: number;
  readonly rowsCompared: number;
}

function keyed<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  return new Map(items.map((item) => [key(item), item]));
}

function diffSets<T>(
  kind: SnapshotDifference['kind'],
  source: readonly T[],
  target: readonly T[],
  key: (item: T) => string,
  render: (item: T) => string,
): SnapshotDifference[] {
  const out: SnapshotDifference[] = [];
  const sourceMap = keyed(source, key);
  const targetMap = keyed(target, key);

  for (const [id, item] of sourceMap) {
    const other = targetMap.get(id);
    if (!other) {
      out.push({ kind, subject: id, source: render(item), target: '<absent>' });
    } else if (render(item) !== render(other)) {
      out.push({ kind, subject: id, source: render(item), target: render(other) });
    }
  }
  for (const [id, item] of targetMap) {
    if (!sourceMap.has(id)) {
      out.push({ kind, subject: id, source: '<absent>', target: render(item) });
    }
  }
  return out;
}

/**
 * Compares two snapshots. `identical` is the cutover gate: anything other than
 * true means the transfer is not trustworthy and must not be cut over to.
 */
export function compareSnapshots(source: DatabaseSnapshot, target: DatabaseSnapshot): ComparisonResult {
  const differences: SnapshotDifference[] = [];

  differences.push(
    ...diffSets('table', source.tables, target.tables, (t) => t.table, (t) => `${t.rows} rows`)
      .map((d) => ({ ...d, kind: 'row_count' as const })),
  );
  differences.push(
    ...diffSets('checksum', source.tables, target.tables, (t) => t.table, (t) => t.checksum),
  );
  differences.push(
    ...diffSets(
      'nullability',
      source.nullability,
      target.nullability,
      (c) => `${c.table}.${c.column}`,
      (c) => `${c.nulls} nulls`,
    ),
  );
  differences.push(
    ...diffSets(
      'constraint',
      source.constraints,
      target.constraints,
      (c) => `${c.table}.${c.name}`,
      (c) => `${c.kind} ${c.definition}`,
    ),
  );
  differences.push(
    ...diffSets(
      'not_null',
      source.notNull,
      target.notNull,
      (c) => `${c.table}.${c.name}`,
      (c) => c.definition,
    ),
  );
  differences.push(
    ...diffSets('index', source.indexes, target.indexes, (i) => `${i.table}.${i.name}`, (i) => i.definition),
  );
  differences.push(
    ...diffSets('migration', source.migrations, target.migrations, (m) => m.version, (m) => m.checksum),
  );

  return {
    identical: differences.length === 0,
    differences,
    tablesCompared: source.tables.length,
    rowsCompared: source.tables.reduce((sum, t) => sum + t.rows, 0),
  };
}
