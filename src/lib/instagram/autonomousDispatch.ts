import type { Sql } from '@/lib/db/sql';
import { logger } from '@/lib/logging/logger';
import { DispatchLockError, lockManifestForItem } from '@/lib/pipeline/r6bDispatch';
import {
  AutonomousApprovalError,
  recordAutonomousApproval,
  type AutonomousApproval,
} from '@/lib/pipeline/autonomousApproval';
import {
  evaluateBatchAutonomously,
  type AutonomousCandidate,
} from '@/lib/instagram/autonomousCandidate';
import {
  AUTONOMOUS_POLICY_VERSION,
  decideAutonomousOutcome,
  isAutoSendEligible,
} from '@/lib/instagram/autonomousPolicy';
import {
  enqueueInstagramJob,
  InstagramEligibilityError,
  InstagramQueueError,
  type EnqueueResult,
} from '@/lib/instagram/queue';

/**
 * HERMES-AUTONOMOUS-R2 §5 — de « ce prospect peut partir » à « une intention
 * existe dans la file », sans qu'aucun humain ne soit consulté et sans qu'aucune
 * porte ne soit sautée.
 *
 * ---------------------------------------------------------------------------
 * Trois écritures, dans cet ordre, et aucune ne suppose la précédente
 * ---------------------------------------------------------------------------
 *
 *   1. l'approbation MACHINE (`r6b_batch_votes`, actor_kind AUTONOMOUS_POLICY) ;
 *   2. le manifeste VERROUILLÉ (`lockManifestForItem`) ;
 *   3. l'entrée en FILE (`enqueueInstagramJob`).
 *
 * Ce module n'invente aucune garde et n'en relâche aucune. Les étapes 2 et 3
 * sont exactement celles qu'un humain déclenchait ; elles revalident pour leur
 * propre compte le vote approuvé, la disponibilité du transport, le
 * destinataire et sa provenance, l'audit d'identité, l'ICP, l'échelle
 * d'audience, la garde de contact par identité, puis les dix portes
 * d'`evaluateInstagramEligibility`. La seule chose que ce module remplace est
 * la MAIN qui les déclenchait.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi la politique est rejouée ici alors qu'elle vient de l'être
 * ---------------------------------------------------------------------------
 * `evaluateBatchAutonomously` a lu la base il y a quelques millisecondes ou
 * quelques minutes — un `--apply` qui suit un rapport relu peut arriver bien
 * plus tard. Entre les deux, une preuve a pu tomber, un humain a pu refuser,
 * une observation d'audience a pu être importée. Rejouer coûte une poignée de
 * requêtes et supprime toute une classe de « c'était vrai quand on a regardé ».
 *
 * La décision qui compte est TOUJOURS celle qui précède immédiatement
 * l'écriture, jamais celle qu'on a affichée.
 */

export type AutonomousDispatchStatus =
  /** Approbation, manifeste et job écrits. */
  | 'QUEUED'
  /** Rapport seul : ce prospect SERAIT enfilé. Rien n'a été écrit. */
  | 'WOULD_QUEUE'
  /** Le job existait déjà pour ce manifeste — rien n'a été dupliqué. */
  | 'ALREADY_QUEUED'
  /** La politique refuse. Zéro écriture. */
  | 'SKIPPED'
  /** Une porte AVAL a refusé (lock ou éligibilité). L'approbation reste, sans manifeste. */
  | 'BLOCKED'
  /** Panne technique. */
  | 'FAILED';

export interface AutonomousDispatchOutcome {
  readonly itemId: string;
  readonly prospectId: string;
  readonly displayName: string;
  readonly handle: string | null;
  readonly status: AutonomousDispatchStatus;
  readonly reason: string;
  readonly approval: AutonomousApproval | null;
  readonly manifestId: string | null;
  readonly jobId: string | null;
  readonly outcomeLabel: string;
}

export interface AutonomousDispatchInput {
  readonly batchSlug: string;
  /** `false` = rapport seul : la base n'est pas écrite du tout. */
  readonly apply: boolean;
  /** Inscrit dans `ig_dispatch_jobs.enqueued_by`. Nomme le RAIL, jamais un humain. */
  readonly enqueuedBy: string;
}

export interface AutonomousDispatchReport {
  readonly batchSlug: string;
  readonly applied: boolean;
  readonly candidates: readonly AutonomousCandidate[];
  readonly outcomes: readonly AutonomousDispatchOutcome[];
  readonly eligible: number;
  readonly skipped: number;
  readonly queued: number;
  readonly alreadyQueued: number;
  readonly blocked: number;
  readonly failed: number;
}

/**
 * Le nom du rail, tel qu'il apparaîtra dans `enqueued_by` et `armed_by`.
 *
 * Ce n'est pas un nom d'humain et il ne doit jamais en devenir un. Les colonnes
 * `*_kind` (0047) portent la provenance ; celle-ci ne porte que « quel
 * programme ». Un envoi réel se fait au nom de quelqu'un — et ce quelqu'un a
 * signé l'ARRÊT GLOBAL (`ig_kill_switch.set_by`), pas chaque message.
 */
export const AUTONOMOUS_RAIL_ACTOR = 'hermes-autonomous-rail';

export async function runAutonomousDispatch(
  sql: Sql,
  input: AutonomousDispatchInput,
): Promise<AutonomousDispatchReport> {
  const candidates = await evaluateBatchAutonomously(sql, input.batchSlug);
  const outcomes: AutonomousDispatchOutcome[] = [];

  for (const candidate of candidates) {
    if (!isAutoSendEligible(candidate.decision)) {
      outcomes.push({
        itemId: candidate.itemId,
        prospectId: candidate.prospectId,
        displayName: candidate.displayName,
        handle: candidate.instagramHandle,
        status: 'SKIPPED',
        reason: candidate.decision.detail,
        approval: null,
        manifestId: null,
        jobId: null,
        outcomeLabel: candidate.decision.outcome,
      });
      continue;
    }

    if (!input.apply) {
      outcomes.push({
        itemId: candidate.itemId,
        prospectId: candidate.prospectId,
        displayName: candidate.displayName,
        handle: candidate.instagramHandle,
        status: 'WOULD_QUEUE',
        reason: 'rapport seul — aucune écriture (ajouter --apply)',
        approval: null,
        manifestId: null,
        jobId: null,
        outcomeLabel: candidate.decision.outcome,
      });
      continue;
    }

    outcomes.push(await dispatchOne(sql, candidate, input.enqueuedBy));
  }

  return {
    batchSlug: input.batchSlug,
    applied: input.apply,
    candidates,
    outcomes,
    eligible: candidates.filter((c) => isAutoSendEligible(c.decision)).length,
    skipped: outcomes.filter((o) => o.status === 'SKIPPED').length,
    // Compte les écritures RÉELLES : un rapport n'enfile rien, et un bilan qui
    // dirait le contraire se relirait comme un envoi préparé.
    queued: outcomes.filter((o) => o.status === 'QUEUED').length,
    alreadyQueued: outcomes.filter((o) => o.status === 'ALREADY_QUEUED').length,
    blocked: outcomes.filter((o) => o.status === 'BLOCKED').length,
    failed: outcomes.filter((o) => o.status === 'FAILED').length,
  };
}

async function dispatchOne(
  sql: Sql,
  candidate: AutonomousCandidate,
  enqueuedBy: string,
): Promise<AutonomousDispatchOutcome> {
  const base = {
    itemId: candidate.itemId,
    prospectId: candidate.prospectId,
    displayName: candidate.displayName,
    handle: candidate.instagramHandle,
    outcomeLabel: candidate.decision.outcome,
  } as const;

  // ---- La politique, rejouée sur l'état COURANT, juste avant d'écrire -------
  const fresh = await reevaluate(sql, candidate);
  if (fresh === null) {
    return {
      ...base,
      status: 'SKIPPED',
      reason: 'le prospect a disparu du batch entre l’évaluation et l’écriture',
      approval: null,
      manifestId: null,
      jobId: null,
    };
  }
  if (!isAutoSendEligible(fresh.decision)) {
    logger.info('instagram.autonomous.recheck_refused', {
      rail: 'instagram',
      kind: 'AUTONOMOUS_DISPATCH',
      itemId: candidate.itemId,
      gate: fresh.decision.gate,
      reason: fresh.decision.reason,
    });
    return {
      ...base,
      status: 'SKIPPED',
      reason: `réévaluation avant écriture : ${fresh.decision.detail}`,
      approval: null,
      manifestId: null,
      jobId: null,
      outcomeLabel: fresh.decision.outcome,
    };
  }

  let approval: AutonomousApproval;
  try {
    approval = await recordAutonomousApproval(sql, {
      itemId: fresh.itemId,
      approvedText: fresh.outboundText,
      policyVersion: AUTONOMOUS_POLICY_VERSION,
    });
  } catch (error) {
    if (error instanceof AutonomousApprovalError) {
      return { ...base, status: 'BLOCKED', reason: error.message, approval: null, manifestId: null, jobId: null };
    }
    return { ...base, status: 'FAILED', reason: describe(error), approval: null, manifestId: null, jobId: null };
  }

  let manifestId: string;
  try {
    const manifest = await lockManifestForItem(sql, { itemId: fresh.itemId, transport: 'instagram_dm' });
    manifestId = manifest.id;
  } catch (error) {
    if (error instanceof DispatchLockError) {
      // L'approbation reste inscrite : elle DIT quelque chose de vrai — la
      // politique a bien approuvé — et une porte aval a refusé ensuite. Effacer
      // l'une pour faire disparaître l'autre rendrait le refus illisible.
      return {
        ...base,
        status: 'BLOCKED',
        reason: `verrouillage refusé [${error.code}] : ${error.message}`,
        approval,
        manifestId: null,
        jobId: null,
      };
    }
    return { ...base, status: 'FAILED', reason: describe(error), approval, manifestId: null, jobId: null };
  }

  let enqueued: EnqueueResult;
  try {
    enqueued = await enqueueInstagramJob(sql, {
      manifestId,
      action: 'first_touch_dm',
      enqueuedBy,
    });
  } catch (error) {
    if (error instanceof InstagramEligibilityError) {
      return {
        ...base,
        status: 'BLOCKED',
        reason: `éligibilité file refusée [${error.code}] : ${error.message}`,
        approval,
        manifestId,
        jobId: null,
      };
    }
    if (error instanceof InstagramQueueError) {
      return { ...base, status: 'BLOCKED', reason: error.message, approval, manifestId, jobId: null };
    }
    return { ...base, status: 'FAILED', reason: describe(error), approval, manifestId, jobId: null };
  }

  return {
    ...base,
    status: enqueued.created ? 'QUEUED' : 'ALREADY_QUEUED',
    reason: enqueued.created
      ? 'approbation machine, manifeste verrouillé, job enfilé'
      : 'un job portait déjà ce manifeste — aucune duplication',
    approval,
    manifestId,
    jobId: enqueued.job.id,
  };
}

/**
 * Relit CE candidat depuis la base et rejoue la politique.
 *
 * Passe par `evaluateBatchAutonomously` plutôt que par une requête dédiée : une
 * seconde façon de rassembler les faits finirait par diverger de la première,
 * et c'est exactement le genre d'écart qui laisse passer ce qu'on croyait
 * fermé. Le coût — relire le batch — est payé une fois par item, contre une
 * classe entière de désynchronisation.
 */
async function reevaluate(sql: Sql, candidate: AutonomousCandidate): Promise<AutonomousCandidate | null> {
  const rows = await evaluateBatchAutonomously(sql, candidate.batchSlug);
  const found = rows.find((row) => row.itemId === candidate.itemId);
  if (found === undefined) return null;
  // Recalcul explicite : `evaluateBatchAutonomously` décide déjà, mais l'appel
  // ci-dessous rend la dépendance visible et interdit qu'un futur cache la
  // court-circuite sans qu'on s'en aperçoive.
  return { ...found, decision: decideAutonomousOutcome(found.facts) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
