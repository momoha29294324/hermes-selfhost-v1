/**
 * R6B-D2 — la surface de lecture de l'état « réponse traitée ».
 *
 * Séparée du traitement pour la même raison qu'en R6B-D1 : regarder ne doit
 * exiger ni modèle, ni fournisseur, ni réseau. Un opérateur, un tableau de bord
 * ou un futur rapport importent ce fichier et ne peuvent donc pas déclencher
 * une classification par accident.
 */

import type { Sql } from '@/lib/db/sql';
import type { CrmProjectionStatus } from '@/lib/replies/crm';
import type { DraftStatus } from '@/lib/replies/draft';
import type { NextAction, OutreachState, ReplyCategory } from '@/lib/replies/taxonomy';

export interface ReplyOverview {
  readonly inboundMessageId: string;
  readonly receivedAt: string;
  readonly fromAddress: string;
  readonly subject: string | null;
  readonly bodyText: string;
  readonly correlationStatus: string;
  readonly correlationMethod: string | null;

  readonly prospectId: string;
  readonly company: string;
  readonly city: string | null;

  readonly manifestId: string;
  readonly originalSubject: string | null;
  readonly originalMessage: string;

  readonly analysisId: string | null;
  readonly classification: ReplyCategory | null;
  readonly confidence: number | null;
  readonly reasoningSummary: string | null;
  readonly recommendedNextAction: NextAction | null;
  readonly requiresHumanReview: boolean | null;
  readonly decidedDeterministically: boolean | null;
  readonly analysisModel: string | null;

  readonly outreachState: OutreachState | null;

  readonly draftId: string | null;
  readonly draftBody: string | null;
  readonly draftHumanText: string | null;
  readonly draftStatus: DraftStatus | null;
  readonly draftBlocked: boolean | null;

  readonly crmStatus: CrmProjectionStatus | null;
  readonly crmProvider: string | null;
  readonly crmLastError: string | null;

  readonly alertId: string | null;
  readonly alertStatus: string | null;
}

interface OverviewRow extends Omit<ReplyOverview, 'receivedAt' | 'confidence'> {
  receivedAt: string | Date;
  confidence: string | number | null;
}

/**
 * Toutes les réponses corrélées, avec ce que le système en a fait.
 *
 * `left join` partout après le message entrant : une réponse dont la
 * classification a échoué doit APPARAÎTRE, avec ses colonnes vides. La cacher
 * derrière une jointure stricte ferait disparaître exactement les cas qu'un
 * humain doit voir.
 */
export async function loadReplyOverviews(sql: Sql, limit = 50): Promise<ReplyOverview[]> {
  const bounded = Math.min(200, Math.max(1, Math.trunc(limit)));
  const rows = await sql.query<OverviewRow>(
    `select i.id                          as "inboundMessageId",
            i.received_at                 as "receivedAt",
            i.from_address                as "fromAddress",
            i.subject,
            i.body_text                   as "bodyText",
            i.correlation_status          as "correlationStatus",
            i.correlation_method          as "correlationMethod",

            p.id                          as "prospectId",
            m.business_name               as "company",
            p.city,

            m.id                          as "manifestId",
            m.transport_payload->>'subject' as "originalSubject",
            m.approved_text               as "originalMessage",

            a.id                          as "analysisId",
            a.classification,
            a.confidence,
            a.reasoning_summary           as "reasoningSummary",
            a.recommended_next_action     as "recommendedNextAction",
            a.requires_human_review       as "requiresHumanReview",
            a.decided_deterministically   as "decidedDeterministically",
            a.model                       as "analysisModel",

            s.state                       as "outreachState",

            d.id                          as "draftId",
            d.body                        as "draftBody",
            d.human_text                  as "draftHumanText",
            d.status                      as "draftStatus",
            d.blocked                     as "draftBlocked",

            c.status                      as "crmStatus",
            c.provider                    as "crmProvider",
            c.last_error                  as "crmLastError",

            al.id                         as "alertId",
            al.status                     as "alertStatus"
       from r6b_inbound_messages i
       join r6b_dispatch_manifests m on m.id = i.correlated_manifest_id
       join prospects p on p.id = i.correlated_prospect_id
       left join r6b_reply_analyses a
              on a.inbound_message_id = i.id and a.status = 'ACTIVE'
       left join r6b_prospect_outreach_states s on s.prospect_id = p.id
       left join r6b_reply_drafts d on d.analysis_id = a.id
       left join r6b_crm_projections c on c.prospect_id = p.id
       left join r6b_alerts al on al.analysis_id = a.id and al.kind = 'SPEED_TO_LEAD'
      where i.correlation_status in ('EXACT','HIGH_CONFIDENCE')
      order by i.received_at desc
      limit $1`,
    [bounded],
  );

  return rows.map((row) =>
    Object.freeze({
      ...row,
      receivedAt: new Date(row.receivedAt).toISOString(),
      confidence: row.confidence === null ? null : Number(row.confidence),
    }),
  );
}

export interface ReplySummary {
  readonly correlatedInbound: number;
  readonly analyzed: number;
  readonly awaitingAnalysis: number;
  readonly byClassification: Readonly<Record<string, number>>;
  readonly byState: Readonly<Record<string, number>>;
  readonly draftsProposed: number;
  readonly draftsBlocked: number;
  readonly alertsOpen: number;
  readonly crmPending: number;
  readonly crmApplied: number;
  readonly suppressedAddresses: number;
}

/** Compteurs. Lecture pure, sans effet de bord. */
export async function loadReplySummary(sql: Sql): Promise<ReplySummary> {
  const [totals] = await sql.query<{
    correlatedInbound: string;
    analyzed: string;
    draftsProposed: string;
    draftsBlocked: string;
    alertsOpen: string;
    crmPending: string;
    crmApplied: string;
    suppressedAddresses: string;
  }>(
    `select (select count(*) from r6b_inbound_messages
              where correlation_status in ('EXACT','HIGH_CONFIDENCE'))::text        as "correlatedInbound",
            (select count(*) from r6b_reply_analyses where status = 'ACTIVE')::text as "analyzed",
            (select count(*) from r6b_reply_drafts where status = 'PROPOSED')::text as "draftsProposed",
            (select count(*) from r6b_reply_drafts where blocked)::text             as "draftsBlocked",
            (select count(*) from r6b_alerts
              where status in ('PENDING','NO_PROVIDER','FAILED'))::text             as "alertsOpen",
            -- « en attente » = tout ce qui n'est pas appliqué. Énumérer les
            -- statuts ferait disparaître du compteur ceux qu'une migration
            -- ultérieure ajoute (0027 en a ajouté deux) — c'est-à-dire faire
            -- silencieusement disparaître des prospects du tableau de bord.
            (select count(*) from r6b_crm_projections where status <> 'APPLIED')::text as "crmPending",
            (select count(*) from r6b_crm_projections where status = 'APPLIED')::text as "crmApplied",
            (select count(*) from do_not_contact where added_by = 'r6b-d2')::text   as "suppressedAddresses"`,
  );

  const classes = await sql.query<{ classification: string; n: string }>(
    `select classification, count(*)::text as n from r6b_reply_analyses
      where status = 'ACTIVE' group by classification`,
  );
  const states = await sql.query<{ state: string; n: string }>(
    'select state, count(*)::text as n from r6b_prospect_outreach_states group by state',
  );

  const byClassification: Record<string, number> = {};
  for (const row of classes) byClassification[row.classification] = Number(row.n);
  const byState: Record<string, number> = {};
  for (const row of states) byState[row.state] = Number(row.n);

  const correlatedInbound = Number(totals?.correlatedInbound ?? '0');
  const analyzed = Number(totals?.analyzed ?? '0');

  return Object.freeze({
    correlatedInbound,
    analyzed,
    awaitingAnalysis: Math.max(0, correlatedInbound - analyzed),
    byClassification: Object.freeze(byClassification),
    byState: Object.freeze(byState),
    draftsProposed: Number(totals?.draftsProposed ?? '0'),
    draftsBlocked: Number(totals?.draftsBlocked ?? '0'),
    alertsOpen: Number(totals?.alertsOpen ?? '0'),
    crmPending: Number(totals?.crmPending ?? '0'),
    crmApplied: Number(totals?.crmApplied ?? '0'),
    suppressedAddresses: Number(totals?.suppressedAddresses ?? '0'),
  });
}

export interface StateTransitionRow {
  readonly id: string;
  readonly prospectId: string;
  readonly company: string;
  readonly fromState: OutreachState | null;
  readonly toState: OutreachState;
  readonly causeKind: string;
  readonly reason: string;
  readonly createdAt: string;
}

/** Le journal des transitions, le plus récent d'abord. */
export async function loadStateTransitions(sql: Sql, limit = 50): Promise<StateTransitionRow[]> {
  const bounded = Math.min(200, Math.max(1, Math.trunc(limit)));
  const rows = await sql.query<Omit<StateTransitionRow, 'createdAt'> & { createdAt: string | Date }>(
    `select t.id,
            t.prospect_id as "prospectId",
            p.display_name as "company",
            t.from_state  as "fromState",
            t.to_state    as "toState",
            t.cause_kind  as "causeKind",
            t.reason,
            t.created_at  as "createdAt"
       from r6b_prospect_state_transitions t
       join prospects p on p.id = t.prospect_id
      order by t.created_at desc limit $1`,
    [bounded],
  );
  return rows.map((row) => Object.freeze({ ...row, createdAt: new Date(row.createdAt).toISOString() }));
}
