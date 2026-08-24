/**
 * PGlite → PostgreSQL corpus transfer (DB1, phase 2).
 *
 * ---------------------------------------------------------------------------
 * The shape of the problem
 * ---------------------------------------------------------------------------
 * Both ends are real Postgres running the same 28 migrations, so this is not a
 * schema conversion — the schema on the target is already correct before a
 * single row moves. What has to be right is the *data*, and specifically three
 * things that are easy to get silently wrong:
 *
 *   1. **Values must survive the round trip.** Rather than marshalling every
 *      column through JavaScript — where a `bytea` becomes a Uint8Array, a
 *      `jsonb` becomes an object, and a `numeric` becomes a lossy float — each
 *      row is rendered to a SQL literal *by the source server itself* through
 *      `format('%L', col)`, and re-parsed *by the target server*. That is what
 *      `pg_dump --inserts` does, and it means the drivers never get an opinion
 *      about types.
 *
 *   2. **Foreign keys must not dictate insert order.** Three tables reference
 *      themselves (`prospects`, `r6b_dispatch_manifests`, `r6b_reply_analyses`),
 *      so no table-level ordering can be correct in general. The load therefore
 *      drops every foreign key, copies the data, and recreates the keys from
 *      the definitions captured beforehand. Recreating an FK makes Postgres
 *      validate every existing row against it — so the step that restores the
 *      constraints is also the step that proves referential integrity.
 *
 *   3. **A partial import must be impossible.** Everything above happens in a
 *      single transaction on the target. Any failure — a bad literal, a
 *      violated FK, a lost connection — rolls back to an untouched database.
 *      There is no state in which the target holds half a corpus.
 *
 * ---------------------------------------------------------------------------
 * Idempotency, and the seed rows that force the question
 * ---------------------------------------------------------------------------
 * A freshly migrated target is not actually empty: migration `0002` seeds a
 * `case_studies` row. So "refuse unless the target is empty" would refuse every
 * correctly prepared target, and "append to whatever is there" would duplicate
 * that seed.
 *
 * The transfer therefore defines itself as *making the target's data identical
 * to the source's* — it truncates every table (inside the same transaction,
 * after the foreign keys are dropped) and then loads. That makes it idempotent:
 * running it twice converges on the same state instead of doubling it.
 *
 * Truncation is destructive, so it is gated rather than assumed. A target
 * holding rows that a fresh migration would not have produced is refused unless
 * the caller explicitly passes `allowNonEmptyTarget` — the operator has to say
 * out loud that the data on the target is expendable.
 */
import type { Sql } from '@/lib/db/sql';
import { logger } from '@/lib/logging/logger';

/** Rows rendered per round trip. Small enough to keep statements readable in a log. */
const DEFAULT_BATCH_SIZE = 500;

export interface ForeignKey {
  readonly table: string;
  readonly name: string;
  /** `pg_get_constraintdef` output — replayed verbatim to recreate the key. */
  readonly definition: string;
}

export interface TableTransfer {
  readonly table: string;
  readonly rows: number;
}

export interface TransferReport {
  readonly tables: readonly TableTransfer[];
  readonly totalRows: number;
  readonly foreignKeysRestored: number;
}

export interface TransferOptions {
  readonly batchSize?: number;
  readonly onProgress?: (table: string, rows: number) => void;
  /** Accept a target holding data beyond what migrations seed. Destructive. */
  readonly allowNonEmptyTarget?: boolean;
}

/** Double-quotes an identifier taken from the catalog. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Pins every session setting that can change how a value renders as text.
 *
 * Both the literal rendering used by the transfer and the checksums used by the
 * audit go through `::text`. If the two ends disagreed on the time zone or on
 * float precision, identical data would produce different bytes: the
 * verification would then report a difference that does not exist — or, worse,
 * miss one that does.
 *
 * On Postgres this is handled one level down, in the driver's `connect` hook,
 * because a `SET` issued against a *pool* only reaches the one connection that
 * served it. Doing it here as well would be ineffective rather than merely
 * redundant, so this function deliberately does nothing for that driver: the
 * guarantee belongs where every connection passes, not where the caller
 * remembers to ask.
 *
 * PGlite has a single connection by construction, so a plain `SET` is exactly
 * right there.
 */
export async function normalizeSession(sql: Sql): Promise<void> {
  if (sql.driver === 'postgres') return;
  await sql.exec("set time zone 'UTC'");
  await sql.exec("set datestyle to 'ISO, YMD'");
  await sql.exec('set extra_float_digits to 1');
  await sql.exec("set bytea_output to 'hex'");
}

/** Every ordinary table in `public`, alphabetically — a stable, reproducible order. */
export async function listBaseTables(sql: Sql): Promise<string[]> {
  const rows = await sql.query<{ table_name: string }>(
    `select c.relname as table_name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`,
  );
  return rows.map((row) => row.table_name);
}

/** Column names in physical order — the order the generated literals follow. */
export async function tableColumns(sql: Sql, table: string): Promise<string[]> {
  const rows = await sql.query<{ column_name: string }>(
    `select attname as column_name
       from pg_attribute
      where attrelid = ($1::regclass) and attnum > 0 and not attisdropped
      order by attnum`,
    [`public.${ident(table)}`],
  );
  return rows.map((row) => row.column_name);
}

export async function countRows(sql: Sql, table: string): Promise<number> {
  const rows = await sql.query<{ n: number }>(`select count(*)::bigint as n from public.${ident(table)}`);
  return Number(rows[0]?.n ?? 0);
}

/** Every foreign key in `public`, with the exact definition needed to recreate it. */
export async function captureForeignKeys(sql: Sql): Promise<ForeignKey[]> {
  return sql.query<ForeignKey>(
    `select rel.relname            as table,
            con.conname            as name,
            pg_get_constraintdef(con.oid) as definition
       from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
       join pg_namespace n on n.oid = rel.relnamespace
      where con.contype = 'f' and n.nspname = 'public'
      order by rel.relname, con.conname`,
  );
}

/**
 * Copies one table using literals rendered by the source server.
 *
 * `format('%L', col)` yields a correctly quoted SQL literal for any type, and
 * the bare token `NULL` for a null — which is why the pieces are concatenated
 * with `||` rather than assembled in JavaScript, where a null would poison the
 * whole tuple.
 */
async function copyTable(
  source: Sql,
  target: Sql,
  table: string,
  batchSize: number,
): Promise<number> {
  const columns = await tableColumns(source, table);
  if (columns.length === 0) return 0;

  const tupleExpr = columns.map((c) => `format('%L', ${ident(c)})`).join(" || ',' || ");
  const columnList = columns.map(ident).join(', ');

  // Ordered by ctid: an arbitrary but *stable* physical order, so a re-run
  // reads the same rows in the same sequence and a diff of two logs is
  // meaningful.
  const rows = await source.query<{ tuple: string }>(
    `select (${tupleExpr}) as tuple from public.${ident(table)} order by ctid`,
  );
  if (rows.length === 0) return 0;

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = batch.map((row) => `(${row.tuple})`).join(',\n');
    await target.exec(`insert into public.${ident(table)} (${columnList}) values\n${values}`);
  }

  return rows.length;
}

export class TargetNotEmptyError extends Error {
  constructor(readonly occupied: readonly TableTransfer[]) {
    const summary = occupied.map((t) => `${t.table}=${t.rows}`).join(', ');
    super(
      `Refus de transférer : la base cible contient des données qu'une migration seule ` +
        `n'aurait pas produites (${summary}). Le transfert écraserait ces lignes. ` +
        'Relancez avec --reset-target si elles sont réellement jetables.',
    );
    this.name = 'TargetNotEmptyError';
  }
}

/**
 * Tables a freshly migrated database legitimately contains.
 *
 * Only `case_studies`, seeded by migration `0002`. Kept as an explicit list
 * rather than inferred, so adding a seeding migration forces a deliberate
 * decision here instead of silently widening what the guard tolerates.
 */
const MIGRATION_SEEDED_TABLES: ReadonlySet<string> = new Set(['case_studies']);

/**
 * Fail-closed precondition.
 *
 * The target is allowed to hold the schema, the `schema_migrations` ledger and
 * the rows migrations seed. Anything else means someone is about to lose data,
 * and that requires an explicit decision.
 */
export async function assertTargetTransferable(
  target: Sql,
  tables: readonly string[],
  allowNonEmptyTarget = false,
): Promise<void> {
  if (allowNonEmptyTarget) return;
  const occupied: TableTransfer[] = [];
  for (const table of tables) {
    if (table === 'schema_migrations' || MIGRATION_SEEDED_TABLES.has(table)) continue;
    const rows = await countRows(target, table);
    if (rows > 0) occupied.push({ table, rows });
  }
  if (occupied.length > 0) throw new TargetNotEmptyError(occupied);
}

/**
 * Moves the whole corpus. Atomic: the caller gets either a complete transfer
 * or an untouched target.
 */
export async function transferCorpus(
  source: Sql,
  target: Sql,
  options: TransferOptions = {},
): Promise<TransferReport> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  await normalizeSession(source);
  await normalizeSession(target);

  const sourceTables = await listBaseTables(source);
  const targetTables = new Set(await listBaseTables(target));

  const missing = sourceTables.filter((t) => !targetTables.has(t));
  if (missing.length > 0) {
    throw new Error(
      `La cible ne connaît pas ${missing.length} table(s) présente(s) à la source : ${missing.join(', ')}. ` +
        'Appliquez les migrations sur la cible avant de transférer.',
    );
  }

  await assertTargetTransferable(target, sourceTables, options.allowNonEmptyTarget ?? false);

  const foreignKeys = await captureForeignKeys(target);
  logger.info('db.transfer.start', {
    tables: sourceTables.length,
    foreignKeys: foreignKeys.length,
    batchSize,
  });

  return target.transaction(async (tx) => {
    await normalizeSession(tx);

    // Les clés étrangères sont retirées puis recréées à l'identique. Leur
    // recréation revalide chaque ligne : c'est la vérification d'intégrité
    // référentielle, et elle ne peut pas être oubliée puisque sans elle la
    // transaction ne se termine pas.
    for (const fk of foreignKeys) {
      await tx.exec(`alter table public.${ident(fk.table)} drop constraint ${ident(fk.name)}`);
    }

    // Vider avant de charger : c'est ce qui rend l'opération idempotente et ce
    // qui retire les lignes semées par les migrations, dont la source possède
    // déjà sa propre version. Les clés étrangères sont tombées juste au-dessus,
    // donc un `truncate` simple suffit — pas de CASCADE, qui pourrait toucher
    // une table hors de cette liste.
    for (const table of sourceTables) {
      if (table === 'schema_migrations') continue;
      await tx.exec(`truncate table public.${ident(table)}`);
    }

    const transferred: TableTransfer[] = [];
    let totalRows = 0;
    for (const table of sourceTables) {
      if (table === 'schema_migrations') continue;
      const rows = await copyTable(source, tx, table, batchSize);
      if (rows > 0) {
        transferred.push({ table, rows });
        totalRows += rows;
        options.onProgress?.(table, rows);
      }
    }

    for (const fk of foreignKeys) {
      await tx.exec(`alter table public.${ident(fk.table)} add constraint ${ident(fk.name)} ${fk.definition}`);
    }

    logger.info('db.transfer.done', {
      tables: transferred.length,
      totalRows,
      foreignKeysRestored: foreignKeys.length,
    });

    return { tables: transferred, totalRows, foreignKeysRestored: foreignKeys.length };
  });
}
