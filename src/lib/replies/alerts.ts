/**
 * R6B-D2 — l'alerte speed-to-lead.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi aucun canal n'est choisi ici
 * ---------------------------------------------------------------------------
 *
 * §9 de la mission interdit de choisir Telegram, Slack ou SMS arbitrairement, et
 * l'inspection du dépôt confirme qu'il n'y a rien à choisir : aucun code
 * d'envoi de notification, aucune clé, aucun webhook. Le seul bot de
 * notification présent sur cette machine appartient à un autre projet, que
 * la documentation d’installation interdit de toucher — le réutiliser serait une violation
 * d'isolation déguisée en commodité.
 *
 * Une alerte est donc d'abord une LIGNE en base. Elle est visible en CLI dans
 * la seconde, elle survit à l'absence de canal, et le jour où un canal existera,
 * la livraison lira cette file au lieu d'être recâblée dans le pipeline.
 * `attempts` et `last_error` existent dès maintenant pour que cette livraison
 * future soit retentable sans reclasser quoi que ce soit.
 */

import type { Sql } from '@/lib/db/sql';
import type { StoredAnalysis } from '@/lib/replies/analyses';
import type { ReplyContext } from '@/lib/replies/context';
import type { NextAction, ReplyCategory } from '@/lib/replies/taxonomy';
import { CATEGORY_POLICY } from '@/lib/replies/taxonomy';

export type AlertKind = 'SPEED_TO_LEAD';
export type AlertStatus = 'PENDING' | 'NO_PROVIDER' | 'DELIVERED' | 'FAILED';

/** Longueur de l'extrait de réponse porté par une alerte. */
export const ALERT_EXCERPT_CHARS = 600;
export const ALERT_FIRST_TOUCH_CHARS = 800;

export interface AlertBody {
  readonly company: string;
  readonly prospectId: string;
  readonly city: string | null;
  readonly replyCategory: ReplyCategory;
  readonly replyConfidence: number;
  readonly replyReceivedAt: string;
  readonly replyFrom: string;
  readonly replyPreview: string;
  readonly originalSubject: string | null;
  readonly originalMessage: string;
  readonly recommendedAction: NextAction;
  /**
   * `PROPOSED`, `NONE` (aucun brouillon n'avait de sens) ou `FAILED` (la
   * rédaction n'a pas abouti). Jamais un statut d'envoi : il n'en existe pas.
   */
  readonly proposedResponseStatus: 'PROPOSED' | 'NONE' | 'FAILED';
  readonly requiresHumanReview: boolean;
  readonly correlationStatus: string;
  readonly manifestId: string;
  readonly inboundMessageId: string;
}

export interface AlertRow {
  readonly id: string;
  readonly kind: AlertKind;
  readonly severity: 'URGENT' | 'NORMAL';
  readonly status: AlertStatus;
  readonly title: string;
}

/** Les catégories qui justifient de réveiller un humain (§9). */
export function shouldAlert(category: ReplyCategory): boolean {
  return CATEGORY_POLICY[category].urgentAlert;
}

export function buildAlertBody(
  context: ReplyContext,
  analysis: StoredAnalysis,
  proposedResponseStatus: AlertBody['proposedResponseStatus'],
): AlertBody {
  return Object.freeze({
    company: context.firstTouch.businessName,
    prospectId: context.prospect.id,
    city: context.prospect.city,
    replyCategory: analysis.classification,
    replyConfidence: analysis.confidence,
    replyReceivedAt: context.reply.receivedAt,
    replyFrom: context.reply.fromAddress,
    replyPreview: context.reply.bodyText.slice(0, ALERT_EXCERPT_CHARS),
    originalSubject: context.firstTouch.subject,
    originalMessage: context.firstTouch.body.slice(0, ALERT_FIRST_TOUCH_CHARS),
    recommendedAction: analysis.recommendedNextAction,
    proposedResponseStatus,
    requiresHumanReview: analysis.requiresHumanReview,
    correlationStatus: context.reply.correlationStatus,
    manifestId: context.firstTouch.manifestId,
    inboundMessageId: context.reply.id,
  });
}

export interface RaiseAlertResult {
  readonly alert: AlertRow;
  /** Faux quand l'alerte existait déjà — retraiter ne réveille pas deux fois. */
  readonly created: boolean;
}

/**
 * Met une alerte en file, une seule fois.
 *
 * L'unicité est portée par `r6b_alerts_analysis_kind_idx` : la même analyse ne
 * peut pas produire deux alertes du même type, quelle que soit la course entre
 * deux processus. Le corps d'une alerte déjà en file n'est PAS réécrit — ce
 * qu'un humain a vu doit rester ce qu'il a vu.
 */
export async function raiseAlert(
  sql: Sql,
  context: ReplyContext,
  analysis: StoredAnalysis,
  proposedResponseStatus: AlertBody['proposedResponseStatus'],
): Promise<RaiseAlertResult> {
  const body = buildAlertBody(context, analysis, proposedResponseStatus);
  const title = `${analysis.classification} — ${context.firstTouch.businessName}`.slice(0, 200);

  const inserted = await sql.query<AlertRow>(
    `insert into r6b_alerts
       (kind, severity, prospect_id, inbound_message_id, analysis_id, manifest_id, title, body, status)
     values ('SPEED_TO_LEAD','URGENT',$1,$2,$3,$4,$5,$6::jsonb,'PENDING')
     on conflict (analysis_id, kind) do nothing
     returning id, kind, severity, status, title`,
    [
      context.prospect.id,
      context.reply.id,
      analysis.id,
      context.firstTouch.manifestId,
      title,
      JSON.stringify(body),
    ],
  );

  const row = inserted[0];
  if (row) return Object.freeze({ alert: row, created: true });

  const existing = await sql.query<AlertRow>(
    `select id, kind, severity, status, title from r6b_alerts
      where analysis_id = $1 and kind = 'SPEED_TO_LEAD'`,
    [analysis.id],
  );
  const found = existing[0];
  if (!found) {
    throw new Error(`alerte pour l'analyse ${analysis.id} ni insérée ni retrouvée`);
  }
  return Object.freeze({ alert: found, created: false });
}

/**
 * Constate qu'aucun canal de livraison n'existe.
 *
 * Appelée après la mise en file, jamais à sa place : une alerte doit exister
 * AVANT qu'on se demande comment la livrer. `PENDING → NO_PROVIDER` ne perd
 * rien — une future mission de livraison remettra ces lignes en `PENDING` ou
 * les lira directement, et rien n'a été effacé entre-temps.
 */
export async function markNoAlertProvider(sql: Sql, alertId: string): Promise<void> {
  await sql.query(
    `update r6b_alerts set status = 'NO_PROVIDER', updated_at = now()
      where id = $1 and status = 'PENDING'`,
    [alertId],
  );
}

export interface PendingAlert {
  readonly id: string;
  readonly title: string;
  readonly severity: string;
  readonly status: AlertStatus;
  readonly createdAt: string;
  readonly body: AlertBody;
}

/** Les alertes qu'aucun humain n'a encore traitées, les plus récentes d'abord. */
export async function loadPendingAlerts(sql: Sql, limit = 50): Promise<PendingAlert[]> {
  const bounded = Math.min(200, Math.max(1, Math.trunc(limit)));
  const rows = await sql.query<{
    id: string;
    title: string;
    severity: string;
    status: AlertStatus;
    createdAt: string | Date;
    body: AlertBody;
  }>(
    `select id, title, severity, status, created_at as "createdAt", body
       from r6b_alerts where status in ('PENDING','NO_PROVIDER','FAILED')
      order by created_at desc limit $1`,
    [bounded],
  );
  return rows.map((row) =>
    Object.freeze({
      id: row.id,
      title: row.title,
      severity: row.severity,
      status: row.status,
      createdAt: new Date(row.createdAt).toISOString(),
      body: row.body,
    }),
  );
}
