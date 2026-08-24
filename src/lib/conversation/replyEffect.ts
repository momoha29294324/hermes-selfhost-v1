/**
 * HERMES-REPLY-DELIVERY-R1 §8/§9/§10/§14 — la TRACE d'une exécution de réponse.
 *
 * ---------------------------------------------------------------------------
 * Trois niveaux de certitude, et le refus d'en inventer un quatrième
 * ---------------------------------------------------------------------------
 * Le 14 août, le dépôt a appris à ses dépens qu'« un clic a eu lieu » et « le
 * message est arrivé » sont deux phrases différentes, et qu'entre les deux il y
 * en a une troisième : « j'ai pu regarder ». Le rail rendait la première, le
 * journal inscrivait la troisième, et personne n'avait la deuxième.
 *
 * Ce module écrit les trois séparément, et la base refuse qu'elles se
 * contredisent (`hermes_effect_certainty_ladder`,
 * `hermes_effect_confirmed_means_sent`) :
 *
 *   * `effectAttempted` — le clic a eu lieu. Posé AVANT le geste par la
 *     réservation, jamais après ;
 *   * `effectObserved` — la récolte d'après-clic a pu s'exécuter ;
 *   * `deliveryConfirmed` — `deliveryProof` a conclu `SENT` sur une observation
 *     lisible. Rien d'autre ne vaut confirmation.
 *
 * ---------------------------------------------------------------------------
 * §8 — l'AMBIGU d'après-effet
 * ---------------------------------------------------------------------------
 * Il n'a pas de table à lui et n'en aura pas. C'est un STATUT (`AMBIGUOUS`),
 * absorbant depuis 0049, plus une ligne d'ici qui en porte les preuves. Deux
 * mécanismes pour une seule vérité auraient fini par se contredire, et c'est
 * toujours le plus indulgent qui aurait gagné.
 *
 * Ce que ce statut garantit, et qui est tout l'objet du §8 : il ne se
 * transforme JAMAIS en « échec avant effet ». `judgeReplyOutcome` ne connaît
 * aucun chemin qui prenne un résultat portant `effectAttempted` et rende
 * `BLOCKED` ou `SKIPPED`. Un plan `AMBIGUOUS` n'est pas rejouable : il est
 * terminal en base, il porte déjà sa tentative, et le crochet pré-effet le
 * refuserait de toute façon (`EFFECT_ALREADY_ATTEMPTED`).
 */

import { isTemporaryReplyAbort, type InstagramReplyResult } from '@/lib/instagram/replyRail';
import type { Sql } from '@/lib/db/sql';

export type ReplyEffectMode = 'PREVIEW' | 'DRAFT' | 'LIVE';

export type ReplyEffectStatus =
  | 'PREVIEWED'
  | 'DRAFT_READY'
  | 'BLOCKED'
  | 'FAILED'
  | 'SENT'
  | 'DELIVERY_FAILED'
  | 'AMBIGUOUS';

export interface ReplyEffectRecord {
  readonly planId: string;
  readonly prospectId: string;
  readonly policyVersion: string;
  readonly commercialPolicyVersion: string;
  readonly brainVersion: string;
  readonly idempotencyKey: string;
  readonly triggerInboundMessageId: string;
  readonly conversationWatermark: string | null;
  readonly bodySha256: string;

  readonly targetThreadId: string;
  readonly targetHandle: string;
  readonly accountHandle: string;

  readonly mode: ReplyEffectMode;
  readonly status: ReplyEffectStatus;
  readonly reasonCode: string;
  readonly detail: string;

  readonly observedThreadId: string | null;
  readonly observedThreadUrl: string | null;
  readonly observedHandle: string | null;
  readonly sessionState: string | null;

  readonly priorBubbles: number | null;
  readonly matchingBubblesBefore: number | null;
  readonly matchingBubblesAfter: number | null;
  readonly harvestReadableBefore: boolean | null;
  readonly harvestReadableAfter: boolean | null;
  readonly composerCleared: boolean | null;
  readonly outgoingBubbleConfirmed: boolean | null;
  readonly deliveryFailureMarkers: readonly string[];
  readonly deliveryVerdict: 'SENT' | 'DELIVERY_FAILED' | 'AMBIGUOUS' | null;

  readonly effectAttempted: boolean;
  readonly effectObserved: boolean;
  readonly deliveryConfirmed: boolean;

  readonly workerId: string;
  readonly durationMs: number | null;
  readonly screenshotPath: string | null;
}

/**
 * Inscrit une exécution. Ne décide rien : ce qu'elle reçoit a déjà été jugé.
 *
 * Rend l'identifiant de la ligne. Ne lève que si la base refuse — et une base
 * qui refuse ici dit quelque chose : les contraintes de 0050 sont des gardes,
 * pas de la validation de confort. Un aperçu qui prétendrait avoir cliqué,
 * un `SENT` sans confirmation, une remise confirmée sans observation : chacun
 * fait échouer la transaction plutôt que de consigner un mensonge.
 */
export async function recordReplyEffect(sql: Sql, input: ReplyEffectRecord): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `insert into hermes_conversation_effects (
       plan_id, prospect_id, channel,
       policy_version, commercial_policy_version, brain_version,
       idempotency_key, trigger_inbound_message_id, conversation_watermark, body_sha256,
       target_thread_id, target_handle, account_handle,
       mode, status, reason_code, detail,
       observed_thread_id, observed_thread_url, observed_handle, session_state,
       prior_bubbles, matching_bubbles_before, matching_bubbles_after,
       harvest_readable_before, harvest_readable_after, composer_cleared,
       outgoing_bubble_confirmed, delivery_failure_markers, delivery_verdict,
       effect_attempted, effect_observed, delivery_confirmed,
       worker_id, duration_ms, screenshot_path
     ) values (
       $1,$2,'instagram_dm',
       $3,$4,$5,
       $6,$7,$8,$9,
       $10,$11,$12,
       $13,$14,$15,$16,
       $17,$18,$19,$20,
       $21,$22,$23,
       $24,$25,$26,
       $27,$28::jsonb,$29,
       $30,$31,$32,
       $33,$34,$35
     )
     returning id`,
    [
      input.planId,
      input.prospectId,
      input.policyVersion,
      input.commercialPolicyVersion,
      input.brainVersion,
      input.idempotencyKey,
      input.triggerInboundMessageId,
      input.conversationWatermark,
      input.bodySha256,
      input.targetThreadId,
      input.targetHandle,
      input.accountHandle,
      input.mode,
      input.status,
      input.reasonCode,
      input.detail.slice(0, 2_000),
      input.observedThreadId,
      input.observedThreadUrl,
      input.observedHandle,
      input.sessionState,
      input.priorBubbles,
      input.matchingBubblesBefore,
      input.matchingBubblesAfter,
      input.harvestReadableBefore,
      input.harvestReadableAfter,
      input.composerCleared,
      input.outgoingBubbleConfirmed,
      JSON.stringify([...input.deliveryFailureMarkers]),
      input.deliveryVerdict,
      input.effectAttempted,
      input.effectObserved,
      input.deliveryConfirmed,
      input.workerId,
      input.durationMs,
      input.screenshotPath,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('l’inscription de l’effet de réponse n’a rendu aucune ligne — état incohérent');
  }
  return id;
}

// ---------------------------------------------------------------------------
// §8/§9 — juger ce que le rail a rendu, sans jamais l'améliorer
// ---------------------------------------------------------------------------

export interface ReplyOutcomeJudgement {
  readonly status: ReplyEffectStatus;
  readonly reasonCode: string;
  readonly detail: string;
  readonly effectAttempted: boolean;
  readonly effectObserved: boolean;
  readonly deliveryConfirmed: boolean;
  /**
   * L'issue peut-elle être retentée par une évaluation ultérieure ?
   *
   * `false` dès qu'un effet a été tenté, sans exception et sans condition —
   * c'est §8 écrit en une ligne. `false` aussi pour les refus qui ne cesseront
   * pas d'être vrais en réessayant : une identité qui ne concorde pas, un fil
   * vide, un texte qui ne s'est pas saisi.
   */
  readonly retryable: boolean;
}

/**
 * Traduit un `InstagramReplyResult` en issue, et rien de plus.
 *
 * Aucun chemin ne remonte le niveau de certitude. En particulier : un
 * `deliveryVerdict` `AMBIGUOUS` reste `AMBIGUOUS` même quand le composeur s'est
 * vidé et que la bulle semble là — c'est `deliveryProof` qui en décide, sur des
 * preuves, et ce module ne repasse pas derrière lui.
 */
export function judgeReplyOutcome(result: InstagramReplyResult): ReplyOutcomeJudgement {
  if (result.kind === 'NOT_ATTEMPTED') {
    // Aucun effet, et le crochet n'a même pas été appelé : la réservation n'a
    // pas eu lieu, le plan n'est pas marqué, rien n'est parti.
    //
    // Deux statuts et non un, parce que les deux se relisent différemment dans
    // six mois. `FAILED` est une PANNE — une session tombée, une page qui n'a
    // pas chargé, un bouton qui n'est pas apparu ; elle cessera d'être vraie
    // toute seule. `BLOCKED` est un REFUS — une identité qui ne concorde pas,
    // un fil sans passé, un texte qui ne s'est pas saisi ; réessayer ne le
    // change pas, et réessayer sans avoir regardé est ce que ce dépôt refuse.
    const temporary = isTemporaryReplyAbort(result.code);
    return Object.freeze({
      status: temporary ? ('FAILED' as const) : ('BLOCKED' as const),
      reasonCode: result.code,
      detail: result.detail,
      effectAttempted: false,
      effectObserved: false,
      deliveryConfirmed: false,
      retryable: temporary,
    });
  }

  if (result.kind === 'PREVIEWED') {
    return Object.freeze({
      status: 'PREVIEWED' as const,
      reasonCode: 'REPLY_PREVIEWED',
      detail: result.detail,
      effectAttempted: false,
      effectObserved: false,
      deliveryConfirmed: false,
      retryable: true,
    });
  }

  if (result.kind === 'DRAFT_READY') {
    return Object.freeze({
      status: 'DRAFT_READY' as const,
      reasonCode: 'REPLY_DRAFT_READY',
      detail: result.detail,
      effectAttempted: false,
      effectObserved: false,
      deliveryConfirmed: false,
      retryable: true,
    });
  }

  const observation = result.observation;
  const observed = observation.harvestReadableAfter;

  if (observation.deliveryVerdict === 'SENT') {
    return Object.freeze({
      status: 'SENT' as const,
      reasonCode: 'REPLY_SENT',
      detail: observation.detail,
      effectAttempted: true,
      effectObserved: observed,
      // `deliveryProof` ne rend `SENT` que sur une observation lisible ; la
      // conjonction est écrite quand même, parce qu'une contrainte de base
      // (`hermes_effect_certainty_ladder`) refuserait la ligne si les deux
      // modules divergeaient un jour — et échouer bruyamment vaut mieux que
      // consigner « confirmé » sans avoir regardé.
      deliveryConfirmed: observed,
      retryable: false,
    });
  }

  if (observation.deliveryVerdict === 'DELIVERY_FAILED') {
    return Object.freeze({
      status: 'DELIVERY_FAILED' as const,
      reasonCode: 'REPLY_DELIVERY_FAILED',
      detail: observation.detail,
      effectAttempted: true,
      effectObserved: observed,
      deliveryConfirmed: false,
      // Instagram a AFFICHÉ un échec — mais le clic, lui, a eu lieu. Rejouer
      // reviendrait à parier que l'affichage disait vrai. §8 l'interdit.
      retryable: false,
    });
  }

  return Object.freeze({
    status: 'AMBIGUOUS' as const,
    reasonCode: 'REPLY_AMBIGUOUS_POST_EFFECT',
    detail:
      `${observation.detail} — le clic a eu lieu et l'issue n'est pas établie. Ce plan ne sera pas ` +
      'rejoué : « on a essayé, on ne sait pas » ne se résout pas en réessayant, mais en regardant.',
    effectAttempted: true,
    effectObserved: observed,
    deliveryConfirmed: false,
    retryable: false,
  });
}

/**
 * L'issue d'une exception levée APRÈS la réservation.
 *
 * C'est le cas §8 dans sa forme la plus brutale : navigateur perdu, page
 * fermée, processus interrompu entre le clic et l'observation. La réservation
 * a déjà inscrit `external_effect_attempted` sur le plan, donc la seule chose
 * vraie est « on a essayé, on ne sait pas ».
 *
 * Le message d'erreur est repris tel quel : il décrit une panne locale, jamais
 * un contenu de prospect ni un secret — les rails ne mettent ni cookie ni jeton
 * dans leurs exceptions, et un test le vérifie sur la trace de refus.
 */
export function ambiguousAfterEffect(error: unknown): ReplyOutcomeJudgement {
  const message = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    status: 'AMBIGUOUS' as const,
    reasonCode: 'REPLY_AMBIGUOUS_POST_EFFECT',
    detail:
      `l'exécution a échoué APRÈS la réservation de l'effet (${message}) — le clic a peut-être eu lieu, ` +
      'et rien ne permet de le savoir. Aucun rejeu automatique : ce plan est clos en AMBIGUOUS et ' +
      'attend un regard.',
    effectAttempted: true,
    effectObserved: false,
    deliveryConfirmed: false,
    retryable: false,
  });
}
