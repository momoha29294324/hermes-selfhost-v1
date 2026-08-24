/**
 * R6B-D2.1 §11 — la reprise des projections en attente.
 *
 * Le traitement d'une réponse (`r6b:replies:process`) projette au fil de l'eau.
 * Quand il n'a pas pu — pas de destination, destination refusée, fournisseur
 * injoignable — la ligne reste dans un état RETENTABLE, et c'est cette commande
 * qui la reprend. Sans elle, corriger une configuration obligerait à reclasser
 * des réponses déjà classées, donc à rappeler un modèle pour rien.
 *
 * ---------------------------------------------------------------------------
 * Ce que la reprise ne fait pas
 * ---------------------------------------------------------------------------
 *
 *   * elle ne RECLASSE rien. L'analyse vivante est relue telle quelle ; si elle
 *     n'existe plus, la projection est ignorée plutôt que reconstruite ;
 *   * elle ne reprend PAS `BLOCKED_POLICY`. Une corrélation `HIGH_CONFIDENCE`
 *     attend un arbitrage humain, et une commande qui « réessaierait » ces
 *     lignes finirait par écrire ce que la politique refuse ;
 *   * elle ne reprend pas `APPLIED` ni `FAILED_PERMANENT` : l'une est faite,
 *     l'autre ne changera pas d'avis toute seule ;
 *   * elle n'écrit RIEN sans `--apply`. Le défaut est un plan : les mêmes
 *     décisions, calculées, affichées, sans appeler le fournisseur.
 */

import type { Sql } from '@/lib/db/sql';
import { loadActiveAnalysis } from '@/lib/replies/analyses';
import { loadReplyContext } from '@/lib/replies/context';
import { loadDraftForAnalysis } from '@/lib/replies/draft';
import {
  projectToCrm,
  RETRYABLE_CRM_STATUSES,
  type CrmProjectionStatus,
} from '@/lib/replies/crm';
import { CATEGORY_POLICY, allowsExternalWrite, type OutreachState } from '@/lib/replies/taxonomy';
import type { ProposedResponseStatus } from '@/lib/crm/note';
import type { CrmResolution } from '@/lib/crm/types';

export interface SyncCandidate {
  readonly projectionId: string;
  readonly prospectId: string;
  readonly company: string;
  readonly status: CrmProjectionStatus;
  readonly inboundMessageId: string | null;
  readonly analysisId: string | null;
  readonly attempts: number;
}

export interface SyncOutcome {
  readonly projectionId: string;
  readonly company: string;
  readonly from: CrmProjectionStatus;
  readonly to: CrmProjectionStatus | null;
  readonly detail: string;
  readonly wrote: boolean;
}

export interface SyncReport {
  readonly configured: boolean;
  readonly configuration: string;
  readonly apply: boolean;
  readonly candidates: number;
  readonly applied: number;
  readonly blocked: number;
  readonly failed: number;
  readonly skipped: number;
  readonly outcomes: readonly SyncOutcome[];
}

export interface SyncOptions {
  readonly limit?: number;
  /** Faux par défaut : le plan est calculé, le fournisseur n'est pas appelé. */
  readonly apply?: boolean;
}

/**
 * Les projections qu'une exécution peut faire avancer, les plus anciennes
 * d'abord.
 *
 * L'ordre est déterministe (création croissante, puis identifiant) : deux
 * exécutions sur la même base traitent les mêmes lignes dans le même ordre, ce
 * qui rend un `--limit` reproductible plutôt qu'arbitraire.
 */
export async function loadSyncCandidates(sql: Sql, limit = 50): Promise<SyncCandidate[]> {
  const bounded = Math.min(500, Math.max(1, Math.trunc(limit)));
  const rows = await sql.query<SyncCandidate>(
    `select c.id                 as "projectionId",
            c.prospect_id        as "prospectId",
            coalesce(m.business_name, p.display_name) as "company",
            c.status,
            c.inbound_message_id as "inboundMessageId",
            c.analysis_id        as "analysisId",
            c.attempts
       from r6b_crm_projections c
       join prospects p on p.id = c.prospect_id
       left join r6b_dispatch_manifests m on m.id = c.manifest_id
      where c.status = any($1::text[])
      order by c.created_at asc, c.id asc
      limit $2`,
    [[...RETRYABLE_CRM_STATUSES], bounded],
  );
  return rows.map((row) => Object.freeze({ ...row }));
}

/**
 * Reprend les projections en attente.
 *
 * Ne lève jamais pour une ligne : un message dont le contexte a disparu est
 * IGNORÉ et le dit, il n'interrompt pas les autres.
 */
export async function syncCrmProjections(
  sql: Sql,
  resolution: CrmResolution,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const apply = options.apply ?? false;
  const candidates = await loadSyncCandidates(sql, options.limit ?? 50);
  const outcomes: SyncOutcome[] = [];

  for (const candidate of candidates) {
    if (candidate.inboundMessageId === null) {
      outcomes.push(skipped(candidate, 'projection sans message entrant — rien à reprendre'));
      continue;
    }

    const context = await loadReplyContext(sql, candidate.inboundMessageId);
    if (context === null) {
      outcomes.push(skipped(candidate, 'contexte de réponse introuvable ou corrélation non exploitable'));
      continue;
    }

    const analysis = await loadActiveAnalysis(sql, candidate.inboundMessageId);
    if (analysis === null) {
      outcomes.push(skipped(candidate, 'aucune analyse vivante — reclasser d’abord'));
      continue;
    }

    const policy = CATEGORY_POLICY[analysis.classification];
    if (!policy.crmEligible || policy.nextState === null) {
      outcomes.push(skipped(candidate, `${analysis.classification} n’est pas projetable`));
      continue;
    }

    const externalWriteAllowed = allowsExternalWrite(context.reply.correlationStatus);
    const draft = await loadDraftForAnalysis(sql, analysis.id);
    const proposedResponseStatus: ProposedResponseStatus = draft === null ? 'NONE' : 'PROPOSED';

    if (!apply) {
      outcomes.push(
        Object.freeze({
          projectionId: candidate.projectionId,
          company: candidate.company,
          from: candidate.status,
          to: null,
          wrote: false,
          detail: plan(resolution, externalWriteAllowed, policy.nextState),
        }),
      );
      continue;
    }

    const result = await projectToCrm(sql, {
      context,
      analysis,
      outreachState: policy.nextState,
      externalWriteAllowed,
      resolution,
      proposedResponseStatus,
    });

    outcomes.push(
      Object.freeze({
        projectionId: candidate.projectionId,
        company: candidate.company,
        from: candidate.status,
        to: result.status,
        wrote: result.wrote,
        detail: result.detail,
      }),
    );
  }

  return Object.freeze({
    configured: resolution.configured,
    configuration: resolution.configured
      ? `fournisseur « ${resolution.provider.name} » · sous-compte ${resolution.target.destination.locationId}`
      : resolution.reason,
    apply,
    candidates: candidates.length,
    applied: outcomes.filter((outcome) => outcome.to === 'APPLIED').length,
    blocked: outcomes.filter((outcome) => outcome.to === 'BLOCKED_CONFIG' || outcome.to === 'BLOCKED_POLICY')
      .length,
    failed: outcomes.filter((outcome) => outcome.to === 'FAILED' || outcome.to === 'FAILED_PERMANENT').length,
    skipped: outcomes.filter((outcome) => outcome.to === null).length,
    outcomes: Object.freeze(outcomes),
  });
}

function skipped(candidate: SyncCandidate, detail: string): SyncOutcome {
  return Object.freeze({
    projectionId: candidate.projectionId,
    company: candidate.company,
    from: candidate.status,
    to: null,
    wrote: false,
    detail,
  });
}

/** Ce qu'une exécution avec `--apply` ferait, calculé sans rien appeler. */
function plan(
  resolution: CrmResolution,
  externalWriteAllowed: boolean,
  state: OutreachState,
): string {
  // Même ordre que `projectToCrm` : sans destination nommée, il n'y a pas
  // d'écriture externe à refuser — le dossier local est simplement complet.
  if (!resolution.configured && resolution.kind === 'NOT_CONFIGURED') {
    return 'LOCAL_ONLY — dossier canonique local à jour, aucune projection externe demandée';
  }
  if (!externalWriteAllowed) return 'BLOCKED_POLICY — corrélation insuffisante pour une écriture externe';
  if (!resolution.configured) return `BLOCKED_CONFIG — ${resolution.reason}`;
  if (state === 'REVIEW_REQUIRED') {
    return 'BLOCKED_POLICY — conclusion non tranchée, aucune évolution d’étape automatique';
  }
  const stage = resolution.target.stages[state];
  if (stage === undefined) return `BLOCKED_CONFIG — l’état ${state} n’a aucune étape cartographiée`;
  return `écrirait le contact et l’étape « ${stage.stageName} » (état ${state})`;
}
