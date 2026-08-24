/**
 * R6B-D1 — la surface de lecture de l'état « réponse » pour le reste de
 * l'application.
 *
 * Séparée de l'ingestion pour une raison simple : lire l'état des réponses ne
 * doit exiger ni fournisseur, ni identifiants Gmail, ni réseau. Un tableau de
 * bord, un rapport de gate ou une future mission de classification importent
 * ce fichier et rien d'autre — et ne peuvent donc pas déclencher un poll par
 * accident.
 */

import type { Sql } from '@/lib/db/sql';
import type { CorrelationStatus } from '@/lib/inbound/correlation';

export interface InboundReply {
  readonly id: string;
  readonly providerMessageId: string;
  readonly providerThreadId: string | null;
  readonly receivedAt: string;
  readonly fromAddress: string;
  readonly fromDisplay: string | null;
  readonly subject: string | null;
  readonly bodyText: string;
  readonly bodySha256: string;
  readonly bodySource: string;
  readonly automationSignals: readonly string[];
  readonly correlationStatus: CorrelationStatus;
  readonly correlationMethod: string | null;
  readonly manifestId: string | null;
  readonly outreachEventId: string | null;
  readonly prospectId: string | null;
}

interface ReplyRow {
  id: string;
  providerMessageId: string;
  providerThreadId: string | null;
  receivedAt: string | Date;
  fromAddress: string;
  fromDisplay: string | null;
  subject: string | null;
  bodyText: string;
  bodySha256: string;
  bodySource: string;
  automationSignals: unknown;
  correlationStatus: CorrelationStatus;
  correlationMethod: string | null;
  manifestId: string | null;
  outreachEventId: string | null;
  prospectId: string | null;
}

const REPLY_COLUMNS = `id,
        provider_message_id          as "providerMessageId",
        provider_thread_id           as "providerThreadId",
        received_at                  as "receivedAt",
        from_address                 as "fromAddress",
        from_display                 as "fromDisplay",
        subject,
        body_text                    as "bodyText",
        body_sha256                  as "bodySha256",
        body_source                  as "bodySource",
        automation_signals           as "automationSignals",
        correlation_status           as "correlationStatus",
        correlation_method           as "correlationMethod",
        correlated_manifest_id       as "manifestId",
        correlated_outreach_event_id as "outreachEventId",
        correlated_prospect_id       as "prospectId"`;

function toReply(row: ReplyRow): InboundReply {
  return Object.freeze({
    id: row.id,
    providerMessageId: row.providerMessageId,
    providerThreadId: row.providerThreadId,
    receivedAt: new Date(row.receivedAt).toISOString(),
    fromAddress: row.fromAddress,
    fromDisplay: row.fromDisplay,
    subject: row.subject,
    bodyText: row.bodyText,
    bodySha256: row.bodySha256,
    bodySource: row.bodySource,
    automationSignals: Object.freeze(Array.isArray(row.automationSignals) ? row.automationSignals.map(String) : []),
    correlationStatus: row.correlationStatus,
    correlationMethod: row.correlationMethod,
    manifestId: row.manifestId,
    outreachEventId: row.outreachEventId,
    prospectId: row.prospectId,
  });
}

/** Les réponses rattachées à un manifeste, de la plus récente à la plus ancienne. */
export async function loadRepliesForManifest(sql: Sql, manifestId: string): Promise<InboundReply[]> {
  const rows = await sql.query<ReplyRow>(
    `select ${REPLY_COLUMNS} from r6b_inbound_messages
      where correlated_manifest_id::text = $1
      order by received_at desc`,
    [manifestId],
  );
  return rows.map(toReply);
}

/**
 * Les messages entrants les plus récents, corrélés ou non.
 *
 * Rend aussi les `UNMATCHED` et les `REVIEW_REQUIRED` : les cacher derrière un
 * filtre « corrélé » ferait disparaître exactement les cas qu'un humain doit
 * voir.
 */
export async function loadRecentInbound(sql: Sql, limit = 50): Promise<InboundReply[]> {
  const bounded = Math.min(500, Math.max(1, Math.trunc(limit)));
  const rows = await sql.query<ReplyRow>(
    `select ${REPLY_COLUMNS} from r6b_inbound_messages order by received_at desc limit $1`,
    [bounded],
  );
  return rows.map(toReply);
}

export type InboundSummary = Readonly<Record<CorrelationStatus, number>> & { readonly total: number };

/** Compte par statut de corrélation. Lecture pure, sans effet de bord. */
export async function loadInboundSummary(sql: Sql): Promise<InboundSummary> {
  const rows = await sql.query<{ correlationStatus: CorrelationStatus; n: string }>(
    `select correlation_status as "correlationStatus", count(*)::text as n
       from r6b_inbound_messages group by correlation_status`,
  );
  const counts: Record<CorrelationStatus, number> = {
    EXACT: 0,
    HIGH_CONFIDENCE: 0,
    REVIEW_REQUIRED: 0,
    UNMATCHED: 0,
  };
  let total = 0;
  for (const row of rows) {
    const n = Number(row.n);
    counts[row.correlationStatus] = n;
    total += n;
  }
  return Object.freeze({ ...counts, total });
}
