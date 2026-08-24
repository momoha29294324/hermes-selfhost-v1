/**
 * HERMES-AUTO-REPLY-PRODUCTION-R1 §5 — le BATTEMENT DE CŒUR du runtime.
 *
 * ---------------------------------------------------------------------------
 * Ce module ne décide rien, et c'est la propriété qui compte
 * ---------------------------------------------------------------------------
 * Aucune porte ne lit cette table. Aucun envoi n'en dépend. L'effacer
 * n'empêcherait ni ne permettrait quoi que ce soit — elle serait seulement
 * illisible. C'est délibéré : un signal d'observation qui gagnerait le pouvoir
 * de bloquer deviendrait une porte de plus, et une porte qu'on n'aurait pas
 * pensée comme telle.
 *
 * Elle répond à une question que rien d'autre ne pouvait répondre :
 * « le processus est-il vivant ? » — distincte de « le rail est-il armé ? »
 * (l'activation), de « l'envoi est-il permis ? » (l'arrêt global et les
 * plafonds), et de « un plan attend-il ? » (le registre).
 *
 * La confusion que cela referme, mot pour mot : un plafond atteint n'est pas un
 * runtime cassé, et un processus qui tourne n'est pas un envoi autorisé.
 */

import type { Sql } from '@/lib/db/sql';

export type AutoReplyRuntimeMode = 'PLAN' | 'PREVIEW' | 'LIVE';

export interface AutoReplyHeartbeat {
  readonly workerId: string;
  readonly host: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly lastSeenAt: string;
  readonly codeRevision: string | null;
  readonly mode: AutoReplyRuntimeMode;
  readonly cycles: number;
  readonly effects: number;
  readonly lastOutcome: string;
  readonly lastDetail: string | null;
  readonly stoppedAt: string | null;
  readonly stoppedBy: string | null;
}

const COLUMNS = `
  worker_id     as "workerId",
  host,
  pid,
  started_at    as "startedAt",
  last_seen_at  as "lastSeenAt",
  code_revision as "codeRevision",
  mode,
  cycles,
  effects,
  last_outcome  as "lastOutcome",
  last_detail   as "lastDetail",
  stopped_at    as "stoppedAt",
  stopped_by    as "stoppedBy"`;

interface Row {
  readonly workerId: string;
  readonly host: string;
  readonly pid: number | string;
  readonly startedAt: string | Date;
  readonly lastSeenAt: string | Date;
  readonly codeRevision: string | null;
  readonly mode: AutoReplyRuntimeMode;
  readonly cycles: number | string;
  readonly effects: number | string;
  readonly lastOutcome: string;
  readonly lastDetail: string | null;
  readonly stoppedAt: string | Date | null;
  readonly stoppedBy: string | null;
}

function hydrate(row: Row): AutoReplyHeartbeat {
  return Object.freeze({
    workerId: row.workerId,
    host: row.host,
    pid: Number(row.pid),
    startedAt: new Date(row.startedAt).toISOString(),
    lastSeenAt: new Date(row.lastSeenAt).toISOString(),
    codeRevision: row.codeRevision,
    mode: row.mode,
    cycles: Number(row.cycles),
    effects: Number(row.effects),
    lastOutcome: row.lastOutcome,
    lastDetail: row.lastDetail,
    stoppedAt: row.stoppedAt === null ? null : new Date(row.stoppedAt).toISOString(),
    stoppedBy: row.stoppedBy,
  });
}

export interface HeartbeatInput {
  readonly workerId: string;
  readonly host: string;
  readonly pid: number;
  readonly mode: AutoReplyRuntimeMode;
  readonly codeRevision: string | null;
  readonly cycles: number;
  readonly effects: number;
  readonly lastOutcome: string;
  readonly lastDetail: string | null;
}

/**
 * Écrit le battement. Ne lève jamais pour l'appelant : un battement manqué ne
 * doit pas arrêter un tour qui, lui, se passe bien.
 */
export async function recordAutoReplyHeartbeat(sql: Sql, input: HeartbeatInput): Promise<void> {
  await sql.query(
    `insert into hermes_autoreply_heartbeats
       (worker_id, host, pid, started_at, last_seen_at, code_revision, mode,
        cycles, effects, last_outcome, last_detail, stopped_at, stopped_by)
     values ($1,$2,$3, now(), now(), $4,$5,$6,$7,$8,$9, null, null)
     on conflict (worker_id) do update
        set last_seen_at   = now(),
            code_revision  = excluded.code_revision,
            mode           = excluded.mode,
            cycles         = excluded.cycles,
            effects        = excluded.effects,
            last_outcome   = excluded.last_outcome,
            last_detail    = excluded.last_detail,
            -- Un battement REPREND un worker qu'on croyait arrêté : le même
            -- identifiant qui rebat est le même processus (ou son successeur
            -- exact), et prétendre qu'il est encore arrêté ferait lire une
            -- panne là où il y a une reprise.
            stopped_at     = null,
            stopped_by     = null`,
    [
      input.workerId,
      input.host,
      input.pid,
      input.codeRevision,
      input.mode,
      input.cycles,
      input.effects,
      input.lastOutcome,
      input.lastDetail?.slice(0, 1_000) ?? null,
    ],
  );
}

/** Marque l'arrêt. `stoppedBy` porte la raison, dans le vocabulaire du runtime. */
export async function closeAutoReplyHeartbeat(
  sql: Sql,
  workerId: string,
  stoppedBy: string,
): Promise<void> {
  await sql.query(
    `update hermes_autoreply_heartbeats
        set stopped_at = now(), stopped_by = $2, last_seen_at = now()
      where worker_id = $1`,
    [workerId, stoppedBy],
  );
}

export async function loadAutoReplyHeartbeats(
  sql: Sql,
  limit = 10,
): Promise<readonly AutoReplyHeartbeat[]> {
  const bounded = Math.min(50, Math.max(1, Math.trunc(limit)));
  const rows = await sql.query<Row>(
    `select ${COLUMNS} from hermes_autoreply_heartbeats order by last_seen_at desc limit $1`,
    [bounded],
  );
  return Object.freeze(rows.map(hydrate));
}

/**
 * Un battement est-il FRAIS ?
 *
 * Pure, et fail-closed : une date illisible n'est pas fraîche. Le seuil est
 * passé par l'appelant plutôt que figé ici — c'est une question d'affichage,
 * pas une règle, et la figer ferait croire qu'elle en est une.
 */
export function isHeartbeatFresh(
  heartbeat: AutoReplyHeartbeat,
  now: Date,
  staleAfterMs: number,
): boolean {
  if (heartbeat.stoppedAt !== null) return false;
  const seen = Date.parse(heartbeat.lastSeenAt);
  if (!Number.isFinite(seen)) return false;
  return now.getTime() - seen <= staleAfterMs;
}
