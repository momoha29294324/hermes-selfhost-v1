import type { Sql } from '@/lib/db/sql';
import { reevaluateQueue, type ReevaluatedJob } from '@/lib/instagram/queueReevaluation';
import { claimNextInstagramJob, finalizeInstagramJob } from '@/lib/instagram/queue';
import { recordJobEvent } from '@/lib/instagram/events';
import { isTerminalSkip, type InstagramSkipReason } from '@/lib/instagram/types';

/**
 * HERMES-CLEANING-ONLY-ICP-R1 §10 — refermer, proprement, les jobs qu'une
 * politique nouvelle n'autorise plus.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi une écriture, alors que `queueReevaluation` disait qu'il n'en fallait pas
 * ---------------------------------------------------------------------------
 * `queueReevaluation.ts` argumentait — et il avait raison sous R1 — que deux
 * mécanismes suffisaient : la VERSION de politique referme les approbations
 * d'hier, et le crochet pré-effet rejoue la politique juste avant le clic. Un
 * troisième mécanisme qui écrirait dans la file serait le seul à pouvoir se
 * tromper.
 *
 * Ce raisonnement reste vrai pour la SÛRETÉ, et il n'est pas remplacé : rien
 * ici n'est ce qui empêche un envoi. Ce qu'il ne couvre pas, et que §10
 * demande, est une question de MÉMOIRE :
 *
 *     un job qui a existé, qu'une politique a rendu inéligible, et dont on doit
 *     pouvoir lire la raison exacte — sans le supprimer, et sans qu'il reste
 *     éternellement `PENDING` en donnant l'impression qu'il attend son tour.
 *
 * Quatre jobs `PENDING` visant `@demo_account_05`, `@demo_account_04`,
 * `@demo_account_35_nantes` et `@demo_account_2331_toulouse` étaient exactement dans cet
 * état le 22 août 2026. Les laisser `PENDING` aurait été sûr et illisible.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module ne s'autorise pas
 * ---------------------------------------------------------------------------
 * Il ne SUPPRIME rien : §10 l'interdit, et l'histoire d'un job fait partie de
 * ce qu'on doit pouvoir relire (« job existed → targeting policy changed →
 * became ineligible → exact reason »).
 *
 * Il n'invente aucun motif : le refus vient de `evaluateItemAutonomously`,
 * c'est-à-dire de la MÊME politique que le worker rejouerait, et le motif est
 * celui qu'elle prononce. Un module qui choisirait son propre motif finirait
 * par en inventer un que la politique ne prononce pas.
 *
 * Il ne clôt que les refus TERMINAUX. Un refus reconsidérable — audience non
 * mesurée, marché non ancré — laisse le job où il est : le fermer condamnerait
 * un prospect sur une absence d'observation, ce que CLAUDE.md §2 interdit. La
 * classe n'est d'ailleurs pas choisie ici : `finalizeInstagramJob` la déduit du
 * motif, et la base ajoute sa propre garde (`ig_job_terminal_skip_is_absorbing`).
 *
 * Il ne touche ni l'arrêt global, ni un manifeste, ni un prospect, ni un
 * `outreach_event`. Il n'ouvre aucun navigateur et ne peut produire aucun effet
 * externe : `INELIGIBLE` est le seul statut absorbant qui affirme que rien n'a
 * été tenté, et la base l'impose (`ig_job_ineligible_has_no_effect`, 0039).
 */

export interface InvalidatedJob {
  readonly jobId: string;
  readonly previousStatus: string;
  readonly instagramHandle: string | null;
  readonly displayName: string;
  readonly verdict: string;
  readonly skipReason: InstagramSkipReason | null;
  readonly detail: string;
  readonly outcome: 'CLOSED_INELIGIBLE' | 'LEFT_OPEN_RECONSIDERABLE' | 'LEFT_OPEN_STILL_ELIGIBLE' | 'CLAIM_LOST';
}

export interface QueueInvalidationReport {
  readonly operator: string;
  readonly applied: boolean;
  readonly jobs: readonly InvalidatedJob[];
  readonly closed: number;
  readonly leftOpen: number;
  readonly stillEligible: number;
}

const WORKER_ID = 'hermes-targeting-invalidation';

/**
 * Rejoue la politique courante sur la file ouverte et referme les refus
 * terminaux.
 *
 * `apply = false` par défaut : un opérateur lit d'abord ce qui serait fermé.
 */
export async function invalidateQueueUnderCurrentPolicy(
  sql: Sql,
  options: { operator: string; apply?: boolean },
): Promise<QueueInvalidationReport> {
  const apply = options.apply === true;
  const reevaluation = await reevaluateQueue(sql);
  const jobs: InvalidatedJob[] = [];
  let closed = 0;
  let leftOpen = 0;

  for (const job of reevaluation.jobs) {
    const entry = await handleJob(sql, job, options.operator, apply);
    jobs.push(entry);
    if (entry.outcome === 'CLOSED_INELIGIBLE') closed += 1;
    else if (entry.outcome !== 'LEFT_OPEN_STILL_ELIGIBLE') leftOpen += 1;
  }

  return Object.freeze({
    operator: options.operator,
    applied: apply,
    jobs: Object.freeze(jobs),
    closed,
    leftOpen,
    stillEligible: reevaluation.stillEligible,
  });
}

async function handleJob(
  sql: Sql,
  job: ReevaluatedJob,
  operator: string,
  apply: boolean,
): Promise<InvalidatedJob> {
  const base = {
    jobId: job.jobId,
    previousStatus: job.status,
    instagramHandle: job.instagramHandle,
    displayName: job.displayName,
    verdict: job.verdict,
  };

  if (job.stillEligible) {
    return Object.freeze({
      ...base,
      skipReason: null,
      detail: 'la politique courante laisse ce job éligible',
      outcome: 'LEFT_OPEN_STILL_ELIGIBLE' as const,
    });
  }

  // Un job ORPHELIN — dont l'item de batch n'existe plus — n'est pas envoyable,
  // mais aucun motif de politique ne le décrit : la politique n'a pas pu être
  // évaluée. On le laisse ouvert plutôt que d'inscrire un refus qu'aucune règle
  // n'a prononcé.
  //
  // DEUX conditions, et les deux sont nécessaires, parce qu'elles répondent à
  // deux questions différentes que le dépôt distingue depuis IG3 :
  //
  //   * `reconsiderable` parle du CANDIDAT — « une preuve nouvelle peut-elle
  //     rouvrir ce prospect ? ». C'est la question métier, et c'est elle qui
  //     décide : fermer un job parce qu'une audience n'a pas encore été mesurée
  //     condamnerait un prospect sur une absence d'observation ;
  //   * `isTerminalSkip` parle du JOB — et la base l'impose de toute façon
  //     (`ig_job_terminal_skip_is_absorbing`) : un motif classé TERMINAL ne peut
  //     pas s'inscrire sur un job resté réclamable.
  //
  // Les deux axes se ressemblent et ne coïncident pas : `review_required` est
  // TERMINAL pour un job et RECONSIDÉRABLE pour un candidat. Sur ce motif-là,
  // on ne ferme donc rien — on laisse le job où il est, et le crochet pré-effet
  // continuera de le refuser tant que le doute dure.
  const decision = job.candidate?.decision ?? null;
  if (
    decision === null ||
    decision.reason === null ||
    decision.reconsiderable ||
    !isTerminalSkip(decision.reason)
  ) {
    return Object.freeze({
      ...base,
      skipReason: decision?.reason ?? null,
      detail:
        decision === null
          ? 'item de batch absent — la politique n’a pas pu être évaluée, donc aucun refus n’est inscrit'
          : decision.detail,
      outcome: 'LEFT_OPEN_RECONSIDERABLE' as const,
    });
  }

  if (!apply) {
    return Object.freeze({
      ...base,
      skipReason: decision.reason,
      detail: decision.detail,
      outcome: 'CLOSED_INELIGIBLE' as const,
    });
  }

  // Le chemin canonique, et lui seul : on PREND le bail avant d'écrire l'issue.
  // Écrire sans bail contournerait la sérialisation qui protège la file, et
  // `finalizeInstagramJob` refuserait de toute façon (`status = 'CLAIMED'` et
  // `claim_token` sont dans son `where`).
  const claimed = await claimNextInstagramJob(sql, {
    workerId: WORKER_ID,
    leaseMs: 60_000,
    jobId: job.jobId,
  });
  if (claimed === null || claimed.claimToken === null) {
    return Object.freeze({
      ...base,
      skipReason: decision.reason,
      detail: 'le bail n’a pas pu être pris — un autre worker tient ce job, rien n’a été écrit',
      outcome: 'CLAIM_LOST' as const,
    });
  }

  const detail = `${decision.gate} — ${decision.detail} [${operator}]`;
  const written = await finalizeInstagramJob(sql, {
    jobId: job.jobId,
    claimToken: claimed.claimToken,
    status: 'INELIGIBLE',
    reasonCode: 'IG_AUTONOMOUS_POLICY_REFUSED',
    detail,
    skipReason: decision.reason,
  });

  if (!written) {
    return Object.freeze({
      ...base,
      skipReason: decision.reason,
      detail: 'le bail a expiré avant l’écriture — rien n’a été écrit',
      outcome: 'CLAIM_LOST' as const,
    });
  }

  // Le journal, pour que la SÉQUENCE se relise : ce job a été pris, puis refusé
  // par cette porte-là, à cette date-là, sous cette politique-là.
  await recordJobEvent(sql, {
    jobId: job.jobId,
    manifestId: job.manifestId,
    prospectId: job.prospectId,
    sessionId: null,
    workerId: WORKER_ID,
    mode: 'DRY_RUN',
    status: 'SKIPPED',
    reasonCode: 'IG_AUTONOMOUS_POLICY_REFUSED',
    idempotencyKey: claimed.idempotencyKey,
    expectedHandle: job.instagramHandle,
    observedHandle: null,
    sessionState: null,
    gates: [{ gate: decision.gate, verdict: 'BLOCK', detail: decision.detail }],
    durationMs: null,
    detail,
    externalEffectAttempted: false,
    canaryAuthorizationId: null,
    skipReason: decision.reason,
    nextEligibleAt: null,
  });

  return Object.freeze({
    ...base,
    skipReason: decision.reason,
    detail: decision.detail,
    outcome: 'CLOSED_INELIGIBLE' as const,
  });
}
