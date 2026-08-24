/**
 * HERMES-REPLY-DELIVERY-R1 §12 — l'ORCHESTRATEUR : ce qui relie une décision
 * pure à un geste réel, dans un ordre que personne ne peut réarranger par
 * accident.
 *
 * ---------------------------------------------------------------------------
 * Le partage, et ce qu'il coûterait de le perdre
 * ---------------------------------------------------------------------------
 * `decideAutonomousReply` est PURE : elle prend des faits, elle rend un
 * verdict, elle n'ouvre rien. `evaluateConversationEffectGate` relit le monde à
 * l'instant où il ne reste plus rien derrière. `sendThreadReply` clique une
 * fois. Aucune des trois ne connaît les deux autres.
 *
 * Ce fichier est le seul qui les connaisse toutes, et c'est pour cela qu'il ne
 * contient AUCUNE règle : pas un seuil, pas une fenêtre, pas un plafond, pas
 * une comparaison de handle. Tout ce qu'il fait est d'appeler, dans l'ordre, ce
 * qui décide — puis d'écrire ce qui s'est passé.
 *
 * Un gros `if` aurait été plus court. Il aurait aussi rendu invérifiable la
 * seule propriété qui compte ici : que rien ne puisse atteindre le clic sans
 * être passé par chacune des portes.
 *
 * ---------------------------------------------------------------------------
 * L'ordre, et pourquoi c'est celui-là
 * ---------------------------------------------------------------------------
 *
 *   1. **reprendre les baux abandonnés** — un plan dont le bail a expiré APRÈS
 *      une tentative devient `AMBIGUOUS` et ne repart jamais (§8). Fait en
 *      premier pour qu'un tel plan ne puisse pas être repris par ce tour-ci ;
 *   2. **prendre UN plan**, atomiquement, et seulement du genre qu'on sait
 *      exécuter. Postgres départage, aucune lecture applicative ne précède ;
 *   3. **résoudre la CIBLE** depuis la base (`resolveReplyTarget`). Avant le
 *      reste parce que c'est gratuit, et parce que tout refus ultérieur pourra
 *      alors s'inscrire dans `hermes_conversation_effects` avec de quoi le
 *      relire ;
 *   4. **le crochet pré-effet**, une première fois — arrêt global, plafonds,
 *      fenêtre, plan vivant, politique courante, prospect, fraîcheur ;
 *   5. **rejouer la DÉCISION** sur l'état courant, et vérifier que le texte du
 *      plan est encore celui que la politique juge envoyable aujourd'hui ;
 *   6. **ouvrir le navigateur** et parcourir jusqu'au dernier point ;
 *   7. **le crochet pré-effet, une seconde fois**, à l'intérieur de la
 *      primitive, juste avant le clic — puis la RÉSERVATION, qui inscrit
 *      « un effet va être tenté » avant que quoi que ce soit ne parte ;
 *   8. **écrire l'issue** : une ligne d'effet, un statut de plan, et rien qui
 *      remonte le niveau de certitude.
 *
 * Les étapes 4 et 7 sont la même garde, appelée deux fois, et ce n'est pas une
 * redondance : entre les deux il s'écoule le temps d'ouvrir un navigateur, de
 * vérifier une session et de rapprocher trois identités — quelques dizaines de
 * secondes pendant lesquelles un humain a pu voir quelque chose et réarmer
 * l'arrêt d'urgence. Un worker qui ne relirait qu'au début transformerait ce
 * geste en « le prochain sera épargné », alors que celui qu'il regardait part
 * quand même.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module n'ouvre pas
 * ---------------------------------------------------------------------------
 *   * aucun envoi sans plan : il n'existe aucun chemin d'ici vers la primitive
 *     qui ne parte pas d'un plan `AUTO_REPLY_ELIGIBLE` pris atomiquement ;
 *   * aucun second compteur : les plafonds sont ceux de
 *     `reserveConversationEffectSlot`, sous le MÊME verrou consultatif que le
 *     premier contact et le test contrôlé ;
 *   * aucun rejeu : `retryable` est faux dès qu'un effet a été tenté, et la
 *     base le confirme (`hermes_effect_one_attempt_per_plan`) ;
 *   * aucune levée d'arrêt : ce module n'importe pas `setKillSwitch`, et un
 *     test le vérifie sur le source.
 */

import type { ConversationPolicyConfig, InstagramRailConfig } from '@/lib/config/schema';
import { assessInboundMessage } from '@/lib/conversation/assessment';
import { COMMERCIAL_POLICY_VERSION } from '@/lib/conversation/commercialPolicy';
import {
  claimConversationPlan,
  finalizeConversationPlan,
  recoverExpiredConversationLeases,
  reserveConversationEffectSlot,
  type ConversationPlan,
  type ConversationPlanStatus,
} from '@/lib/conversation/plan';
import {
  classifyProfileContention,
  evaluateConversationEffectGate,
  type ConversationEffectRefusal,
} from '@/lib/conversation/preEffect';
import {
  ambiguousAfterEffect,
  judgeReplyOutcome,
  recordReplyEffect,
  type ReplyEffectMode,
  type ReplyEffectStatus,
  type ReplyOutcomeJudgement,
} from '@/lib/conversation/replyEffect';
import { resolveReplyTarget, type ReplyTarget } from '@/lib/conversation/replyTarget';
import { canonicalAccountIdentity } from '@/lib/instagram/accountIdentity';
import type { Sql } from '@/lib/db/sql';
import { logger } from '@/lib/logging/logger';
import type { InstagramReplyRail, InstagramReplyResult } from '@/lib/instagram/replyRail';

/** Le bail par défaut d'un plan pris pour exécution. */
export const REPLY_LEASE_MS = 5 * 60 * 1000;

/**
 * Le report appliqué à un refus TEMPORAIRE dont personne ne sait dire quand il
 * cessera — une session tombée, une page qui n'a pas chargé.
 *
 * Cinq minutes, la cadence du rail entrant. Assez court pour que le prospect ne
 * l'attende pas, assez long pour qu'une boucle ne repasse pas trois fois par
 * seconde devant la même panne.
 */
export const REPLY_TEMPORARY_BACKOFF_MS = 5 * 60 * 1000;

export type ReplyExecutionStatus =
  /** Aucun plan dû : le registre est vide ou tout est à l'heure. */
  | 'NO_PLAN'
  /** Refusé avant même d'avoir ouvert quoi que ce soit. */
  | 'REFUSED'
  | ReplyEffectStatus;

export interface ReplyExecutionOutcome {
  readonly planId: string | null;
  readonly prospectId: string | null;
  readonly threadId: string | null;
  readonly status: ReplyExecutionStatus;
  readonly reasonCode: string;
  readonly detail: string;
  /** §8 — la seule question qui compte pour savoir si un rejeu est concevable. */
  readonly externalEffectAttempted: boolean;
  readonly effectId: string | null;
}

export interface ReplyExecutionInput {
  readonly sql: Sql;
  readonly config: InstagramRailConfig;
  readonly conversation: ConversationPolicyConfig;
  readonly workerId: string;
  /**
   * Où le parcours s'arrête. `LIVE` est le seul mode capable de produire un
   * effet, et il faut le NOMMER : le défaut d'une union n'existe pas, donc
   * personne ne peut envoyer par omission.
   */
  readonly mode: ReplyEffectMode;
  /** Restreint l'exécution à ce plan précis. Absent : le prochain plan dû. */
  readonly planId?: string;
  readonly leaseMs?: number;
  readonly now?: () => Date;
}

export interface ReplyExecutionDeps {
  readonly rail: InstagramReplyRail;
}

/**
 * Draine UN plan de réponse, ou dit pourquoi il n'y en a pas.
 *
 * Rend toujours une issue, jamais une exception métier : une panne de
 * navigateur, une contention de profil, un refus de politique sont des
 * RÉSULTATS. Seules les erreurs de programmation remontent.
 */
export async function executeConversationReply(
  input: ReplyExecutionInput,
  deps: ReplyExecutionDeps,
): Promise<ReplyExecutionOutcome> {
  const { sql, workerId, mode } = input;
  const clock = input.now ?? ((): Date => new Date());
  const log = logger.child({ rail: 'conversation-reply', workerId, mode });

  // ---- 1. Les baux abandonnés, d'abord ------------------------------------
  const recovered = await recoverExpiredConversationLeases(sql);
  for (const plan of recovered) {
    log.warn('conversation.reply.lease_recovered', { planId: plan.id, status: plan.status });
  }

  // ---- 2. UN plan, atomiquement, et du bon genre --------------------------
  const plan = await claimConversationPlan(sql, {
    workerId,
    leaseMs: input.leaseMs ?? REPLY_LEASE_MS,
    ...(input.planId === undefined ? {} : { planId: input.planId }),
    kinds: ['AUTO_REPLY'],
  });
  if (plan === null) {
    return outcome(null, null, null, 'NO_PLAN', 'REPLY_NO_PLAN', 'aucun plan de réponse dû', false, null);
  }

  const claimToken = plan.claimToken;
  if (claimToken === null) {
    // Impossible par construction (`hermes_plan_claim_lease_coherent`), et
    // traité quand même : un état impossible ne reçoit pas le bénéfice du doute.
    return outcome(
      plan.id,
      plan.prospectId,
      null,
      'REFUSED',
      'REPLY_CLAIM_TOKEN_MISSING',
      `le plan ${plan.id} a été pris sans jeton de bail — état incohérent, aucun geste`,
      false,
      null,
    );
  }

  try {
    return await runClaimedPlan(input, deps, plan, claimToken, clock, log);
  } catch (error) {
    // Une exception ARRIVÉE ICI n'a pas pu passer par la réservation : le seul
    // chemin qui réserve vit dans le crochet, à l'intérieur de `runClaimedPlan`,
    // et ce qu'il lève y est déjà traité. Reste ce qui casse avant : une
    // requête refusée, une configuration illisible, une panne de pool.
    //
    // Le plan est reposé, pas fermé : rien n'a eu lieu.
    const message = error instanceof Error ? error.message : String(error);
    await finalizeConversationPlan(sql, {
      planId: plan.id,
      claimToken,
      status: 'SKIPPED',
      reasonCode: 'REPLY_EXECUTION_ERROR',
      detail: message.slice(0, 1_000),
      notBefore: new Date(clock().getTime() + REPLY_TEMPORARY_BACKOFF_MS),
    });
    log.error('conversation.reply.execution_error', { planId: plan.id, error: message });
    return outcome(
      plan.id,
      plan.prospectId,
      null,
      'REFUSED',
      'REPLY_EXECUTION_ERROR',
      `l'exécution a échoué avant toute réservation (${message}) — le plan retourne au registre`,
      false,
      null,
    );
  }
}

async function runClaimedPlan(
  input: ReplyExecutionInput,
  deps: ReplyExecutionDeps,
  plan: ConversationPlan,
  claimToken: string,
  clock: () => Date,
  log: ReturnType<typeof logger.child>,
): Promise<ReplyExecutionOutcome> {
  const { sql, config, mode } = input;

  if (plan.channel !== 'instagram_dm') {
    return await closePlan(
      sql,
      plan,
      claimToken,
      'BLOCKED',
      'REPLY_CHANNEL_UNSUPPORTED',
      `le plan porte le canal ${plan.channel} — ce rail ne sait remettre que des DM Instagram`,
      null,
      null,
    );
  }

  const body = plan.body;
  const bodySha256 = plan.bodySha256;
  if (body === null || bodySha256 === null) {
    return await closePlan(
      sql,
      plan,
      claimToken,
      'BLOCKED',
      'REPLY_BODY_MISSING',
      'le plan ne porte aucun texte — il n’y a rien à remettre',
      null,
      null,
    );
  }

  // ---- 3. La CIBLE, résolue depuis la base --------------------------------
  //
  // L'identité de NOTRE compte vient de la configuration courante, pas de la
  // ligne du message : `mailbox` dit sous quel nom la boîte a été LUE, ce qui
  // n'est plus le nom d'aujourd'hui dès qu'un compte est renommé
  // (HERMES-IDENTITY-CANONICALIZATION-R1 §6). Une identité illisible refuse le
  // plan plutôt que de laisser passer un compte deviné.
  const identity = canonicalAccountIdentity({
    accountHandle: config.inbound.accountHandle ?? '',
    formerAccountHandles: config.inbound.formerAccountHandles,
  });
  if (!identity.ok) {
    return await closePlan(
      sql,
      plan,
      claimToken,
      'BLOCKED',
      identity.refusal,
      identity.detail,
      null,
      null,
    );
  }

  const resolution = await resolveReplyTarget(sql, {
    prospectId: plan.prospectId,
    triggerInboundMessageId: plan.triggerInboundMessageId,
    account: identity.identity,
  });
  if (!resolution.ok) {
    return await closePlan(
      sql,
      plan,
      claimToken,
      'BLOCKED',
      resolution.refusal,
      resolution.detail,
      null,
      null,
    );
  }
  const target = resolution.target;

  // ---- 4. Le crochet pré-effet, une PREMIÈRE fois -------------------------
  const gate = await evaluateConversationEffectGate(sql, {
    config,
    plan,
    now: clock(),
  });
  if (!gate.allowed) {
    return await recordAndClose(input, plan, claimToken, target, bodySha256, {
      status: gate.temporary ? 'FAILED' : 'BLOCKED',
      reasonCode: gate.refusal,
      detail: gate.detail,
      effectAttempted: false,
      effectObserved: false,
      deliveryConfirmed: false,
      retryable: gate.temporary,
      nextEligibleAt: gate.nextEligibleAt,
    });
  }

  // ---- 5. La DÉCISION, rejouée sur l'état courant -------------------------
  //
  // Le plan porte une décision rendue à un instant. Ce qu'on relit ici est la
  // décision d'AUJOURD'HUI, sur les mêmes règles, avec le fil tel qu'il est.
  // Elles peuvent diverger — un tour supplémentaire, une catégorie révisée par
  // une nouvelle analyse, un brouillon réécrit par un humain — et c'est le cas
  // où il ne faut pas envoyer.
  const decisionRefusal = await replayDecision(input, plan, bodySha256);
  if (decisionRefusal !== null) {
    return await recordAndClose(input, plan, claimToken, target, bodySha256, {
      ...decisionRefusal,
      effectAttempted: false,
      effectObserved: false,
      deliveryConfirmed: false,
      nextEligibleAt: null,
    });
  }

  // ---- 6/7. Le parcours, et le crochet juste avant le clic ----------------
  const stopAfter: 'thread' | 'draft' | null =
    mode === 'PREVIEW' ? 'thread' : mode === 'DRAFT' ? 'draft' : null;

  // Passe à `true` DANS le crochet, une fois la réservation commitée. Il
  // distingue « l'exécution a échoué avant toute réservation » (le plan
  // retourne au registre) de « elle a échoué après » (AMBIGUOUS, terminal).
  let reserved = false;

  let result: InstagramReplyResult;
  try {
    result = await deps.rail.sendThreadReply({
      target: {
        expectedThreadId: target.threadId,
        expectedHandle: target.counterpartyHandle,
        expectedAccountHandle: target.accountHandle,
      },
      provenance: {
        source: 'HERMES_AUTONOMOUS_REPLY',
        planId: plan.id,
        idempotencyKey: plan.idempotencyKey,
        inboundMessageId: target.inboundMessageId,
        policyVersion: plan.policyVersion,
        commercialPolicyVersion: plan.commercialPolicyVersion,
        brainVersion: plan.brainVersion,
        bodySha256,
      },
      body,
      stopAfter,
      onBeforeExternalEffect: async () => {
        // §5/§6 — TOUT est relu ici, sur état frais, à l'instant où il ne reste
        // plus rien derrière : arrêt global, plafonds, cadence, fenêtre, plan
        // encore vivant, politiques courantes, exclusion, état commercial,
        // identité, et fraîcheur du dernier message reçu.
        //
        // Lever ici ne dépense rien : la réservation vient après, donc la garde
        // est gratuite tant qu'elle passe et totale quand elle refuse.
        const late = await evaluateConversationEffectGate(sql, {
          config,
          plan,
          now: clock(),
        });
        if (!late.allowed) {
          throw new ReplyPreEffectRefusal(late.refusal, late.detail, late.temporary, late.nextEligibleAt);
        }

        // Et la décision, une dernière fois : un message arrivé pendant
        // l'ouverture du navigateur rend ce brouillon caduc, et `PLAN_STALE`
        // ci-dessus ne le voit que si la marque du plan est plus ancienne — ce
        // qui est le cas, mais la porte de contenu répond à une question de
        // plus (le fil a-t-il basculé en terminal ?).
        const lateDecision = await replayDecision(input, plan, bodySha256);
        if (lateDecision !== null) {
          throw new ReplyPreEffectRefusal(lateDecision.reasonCode, lateDecision.detail, lateDecision.retryable, null);
        }

        // §7 — la RÉSERVATION : elle compte les plafonds sous le verrou partagé
        // et inscrit `external_effect_attempted` AVANT le geste. Si elle
        // échoue, l'exception remonte et le clic n'a pas lieu.
        // La réservation compte sous le verrou, et elle relit le même
        // espacement minimal que le crochet. Lui passer la configuration BRUTE
        // pendant que le crochet en applique une autre créerait la pire des
        // incohérences : une porte verte suivie d'un refus, à l'instant précis
        // où le navigateur est ouvert. La politique est donc résolue ici aussi,
        // depuis le MÊME jeton et le MÊME plan — les plafonds journalier et
        // horaire y restent ceux de la configuration, intacts.
        await reserveConversationEffectSlot(
          sql,
          config,
          { planId: plan.id, claimToken },
        );
        reserved = true;
        log.info('conversation.reply.effect_reserved', {
          planId: plan.id,
          threadId: target.threadId,
        });
      },
    });
  } catch (error) {
    if (reserved) {
      // §8 — l'AMBIGU d'après-effet dans sa forme la plus brutale. La
      // réservation est commitée, donc « rien n'a été fait » est faux, et
      // « c'est parti » n'est pas établi. On ne rejoue pas.
      const judgement = ambiguousAfterEffect(error);
      log.error('conversation.reply.ambiguous_post_effect', {
        planId: plan.id,
        threadId: target.threadId,
      });
      return await recordAndClose(input, plan, claimToken, target, bodySha256, {
        ...judgement,
        nextEligibleAt: null,
      });
    }

    if (error instanceof ReplyPreEffectRefusal) {
      return await recordAndClose(input, plan, claimToken, target, bodySha256, {
        status: error.temporary ? 'FAILED' : 'BLOCKED',
        reasonCode: error.code,
        detail: error.detail,
        effectAttempted: false,
        effectObserved: false,
        deliveryConfirmed: false,
        retryable: error.temporary,
        nextEligibleAt: error.nextEligibleAt,
      });
    }

    // Un profil navigateur occupé n'est pas une panne : l'autre runtime Hermes
    // le tient, rien n'a été ouvert, il n'y a rien à réparer.
    const contention: ConversationEffectRefusal | null = classifyProfileContention(error);
    if (contention !== null) {
      return await recordAndClose(input, plan, claimToken, target, bodySha256, {
        status: 'FAILED',
        reasonCode: contention,
        detail:
          'le profil navigateur est tenu par l’autre runtime Hermes — aucun navigateur ouvert, aucune ' +
          'session jugée, aucun effet. Le plan repartira au tour suivant.',
        effectAttempted: false,
        effectObserved: false,
        deliveryConfirmed: false,
        retryable: true,
        nextEligibleAt: null,
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    return await recordAndClose(input, plan, claimToken, target, bodySha256, {
      status: 'FAILED',
      reasonCode: 'REPLY_RAIL_ERROR',
      detail: `le rail a échoué AVANT toute réservation (${message}) — aucun effet`,
      effectAttempted: false,
      effectObserved: false,
      deliveryConfirmed: false,
      retryable: true,
      nextEligibleAt: null,
    });
  }

  // ---- 8. L'issue, écrite sans jamais remonter la certitude ---------------
  const judgement = judgeReplyOutcome(result);
  return await recordAndClose(
    input,
    plan,
    claimToken,
    target,
    bodySha256,
    { ...judgement, nextEligibleAt: null },
    result,
  );
}

/**
 * Le refus de dernière seconde, en exception, pour qu'il traverse la primitive
 * sans qu'elle ait à le comprendre.
 *
 * La primitive ne connaît qu'une chose du crochet : s'il lève, on ne clique
 * pas. C'est exactement ce qu'on veut qu'elle sache.
 */
class ReplyPreEffectRefusal extends Error {
  readonly code: string;
  readonly detail: string;
  readonly temporary: boolean;
  readonly nextEligibleAt: Date | null;

  constructor(code: string, detail: string, temporary: boolean, nextEligibleAt: Date | null) {
    super(`${code} : ${detail}`);
    this.name = 'ReplyPreEffectRefusal';
    this.code = code;
    this.detail = detail;
    this.temporary = temporary;
    this.nextEligibleAt = nextEligibleAt;
  }
}

interface DecisionRefusal {
  readonly status: ReplyEffectStatus;
  readonly reasonCode: string;
  readonly detail: string;
  readonly retryable: boolean;
}

/**
 * La politique, rejouée sur l'état courant. `null` quand rien ne s'y oppose.
 *
 * Trois questions, et aucune n'est celle du plan :
 *
 *   1. le tour est-il encore ÉVALUABLE ? Un message dont l'analyse a été
 *      retirée ne l'est plus, et « je n'ai pas trouvé » n'est pas
 *      « rien ne s'y oppose » ;
 *   2. la décision d'aujourd'hui est-elle encore `AUTO_REPLY_ELIGIBLE` ?
 *   3. le texte du plan est-il encore CELUI que la politique a jugé ? Un
 *      brouillon réécrit entre-temps n'a pas été jugé ; l'envoyer parce qu'un
 *      plan porte son ancien nom serait envoyer un texte que personne n'a vu.
 */
async function replayDecision(
  input: ReplyExecutionInput,
  plan: ConversationPlan,
  bodySha256: string,
): Promise<DecisionRefusal | null> {
  const triggerId = plan.triggerInboundMessageId;
  if (triggerId === null) {
    return {
      status: 'BLOCKED',
      reasonCode: 'REPLY_NO_TRIGGER',
      detail: 'ce plan ne porte pas de message déclencheur — la politique n’a rien à rejouer',
      retryable: false,
    };
  }

  const assessment = await assessInboundMessage(input.sql, triggerId, {
    config: input.conversation,
    now: (input.now ?? ((): Date => new Date()))(),
  });
  if (assessment === null) {
    return {
      status: 'BLOCKED',
      reasonCode: 'REPLY_DECISION_UNAVAILABLE',
      detail:
        `le tour ${triggerId} n'est plus évaluable — message, corrélation ou analyse absents. ` +
        '« Je n’ai pas trouvé » n’est pas « rien ne s’y oppose ».',
      retryable: false,
    };
  }

  if (assessment.autonomous.outcome !== 'AUTO_REPLY_ELIGIBLE') {
    const terminal =
      assessment.autonomous.outcome === 'TERMINAL_STOP' ||
      assessment.autonomous.outcome === 'HUMAN_ESCALATION';
    return {
      status: 'BLOCKED',
      reasonCode: `REPLY_DECISION_${assessment.autonomous.outcome}`,
      detail:
        `la politique rejouée maintenant rend ${assessment.autonomous.outcome}` +
        `${assessment.autonomous.reason === null ? '' : `:${assessment.autonomous.reason}`} ` +
        `[${assessment.autonomous.gate}] — ${assessment.autonomous.detail}`,
      retryable: !terminal,
    };
  }

  if (assessment.commercialPolicyVersion !== COMMERCIAL_POLICY_VERSION) {
    return {
      status: 'BLOCKED',
      reasonCode: 'REPLY_COMMERCIAL_POLICY_MISMATCH',
      detail:
        `l'évaluation courante a été rendue sous « ${assessment.commercialPolicyVersion} » et la ` +
        `politique commerciale est « ${COMMERCIAL_POLICY_VERSION} »`,
      retryable: true,
    };
  }

  const draft = assessment.draft;
  if (draft === null || draft.bodySha256 !== bodySha256) {
    return {
      status: 'BLOCKED',
      reasonCode: 'REPLY_DRAFT_CHANGED',
      detail:
        `le texte retenu aujourd'hui (${draft?.bodySha256.slice(0, 12) ?? 'aucun brouillon'}) n'est pas ` +
        `celui que ce plan porte (${bodySha256.slice(0, 12)}) — un texte que la politique n'a pas jugé ` +
        'ne part pas parce qu’un plan porte son ancien nom',
      retryable: true,
    };
  }

  return null;
}

interface ClosingJudgement extends ReplyOutcomeJudgement {
  readonly nextEligibleAt: Date | null;
}

/**
 * Écrit la ligne d'effet, puis clôt le plan. Dans cet ordre.
 *
 * L'ordre a une conséquence concrète : si l'écriture de la trace échoue, le
 * plan reste `CLAIMED` et son bail finira par expirer. La reprise en tirera la
 * seule conclusion possible — `AMBIGUOUS` s'il portait une tentative,
 * `PLANNED` sinon. Clore le plan d'abord aurait produit l'inverse : un plan
 * `SENT` sans aucune trace de ce qui a été observé.
 */
async function recordAndClose(
  input: ReplyExecutionInput,
  plan: ConversationPlan,
  claimToken: string,
  target: ReplyTarget,
  bodySha256: string,
  judgement: ClosingJudgement,
  result?: InstagramReplyResult,
): Promise<ReplyExecutionOutcome> {
  const observation = result?.kind === 'ATTEMPTED' ? result.observation : null;
  const previewed = result?.kind === 'PREVIEWED' ? result : null;
  const drafted = result?.kind === 'DRAFT_READY' ? result : null;
  const notAttempted = result?.kind === 'NOT_ATTEMPTED' ? result : null;

  const effectId = await recordReplyEffect(input.sql, {
    planId: plan.id,
    prospectId: plan.prospectId,
    policyVersion: plan.policyVersion,
    commercialPolicyVersion: plan.commercialPolicyVersion,
    brainVersion: plan.brainVersion,
    idempotencyKey: plan.idempotencyKey,
    triggerInboundMessageId: target.inboundMessageId,
    conversationWatermark: plan.conversationWatermark,
    bodySha256,
    targetThreadId: target.threadId,
    targetHandle: target.counterpartyHandle,
    accountHandle: target.accountHandle,
    mode: input.mode,
    status: judgement.status,
    reasonCode: judgement.reasonCode,
    detail: judgement.detail,
    observedThreadId: observation?.observedThreadId ?? null,
    observedThreadUrl: observation?.threadUrl ?? previewed?.threadUrl ?? drafted?.threadUrl ?? null,
    observedHandle: observation?.threadHandle ?? previewed?.threadHandle ?? drafted?.threadHandle ?? null,
    sessionState:
      observation?.sessionState ??
      previewed?.sessionState ??
      drafted?.sessionState ??
      notAttempted?.sessionState ??
      null,
    priorBubbles: observation?.priorBubbles ?? previewed?.priorBubbles ?? drafted?.priorBubbles ?? null,
    matchingBubblesBefore: observation?.matchingBubblesBefore ?? null,
    matchingBubblesAfter: observation?.matchingBubblesAfter ?? null,
    harvestReadableBefore: observation?.harvestReadableBefore ?? null,
    harvestReadableAfter: observation?.harvestReadableAfter ?? null,
    composerCleared: observation?.composerCleared ?? drafted?.composerCleared ?? null,
    outgoingBubbleConfirmed: observation?.outgoingBubbleConfirmed ?? null,
    deliveryFailureMarkers: observation?.deliveryFailureMarkers ?? [],
    deliveryVerdict: observation?.deliveryVerdict ?? null,
    effectAttempted: judgement.effectAttempted,
    effectObserved: judgement.effectObserved,
    deliveryConfirmed: judgement.deliveryConfirmed,
    workerId: input.workerId,
    durationMs: observation?.durationMs ?? null,
    screenshotPath:
      observation?.screenshotPath ??
      previewed?.screenshotPath ??
      drafted?.screenshotPath ??
      notAttempted?.screenshotPath ??
      null,
  });

  const planStatus = planStatusFor(judgement);
  const now = (input.now ?? ((): Date => new Date()))();
  const notBefore =
    planStatus === 'SKIPPED'
      ? (judgement.nextEligibleAt ?? new Date(now.getTime() + REPLY_TEMPORARY_BACKOFF_MS))
      : undefined;

  await finalizeConversationPlan(input.sql, {
    planId: plan.id,
    claimToken,
    status: planStatus,
    reasonCode: judgement.reasonCode,
    detail: judgement.detail.slice(0, 1_000),
    ...(notBefore === undefined ? {} : { notBefore }),
  });

  return outcome(
    plan.id,
    plan.prospectId,
    target.threadId,
    judgement.status,
    judgement.reasonCode,
    judgement.detail,
    judgement.effectAttempted,
    effectId,
  );
}

/**
 * De l'issue d'exécution au statut de PLAN.
 *
 * `SKIPPED` est le seul statut qui laisse un plan repartir, et il est réservé
 * à ce qui n'a produit AUCUN effet et peut cesser d'être vrai tout seul. Dès
 * qu'un effet a été tenté, `retryable` est faux et le plan est clos : c'est §8
 * dans le seul endroit où il pourrait être contourné.
 */
function planStatusFor(
  judgement: ReplyOutcomeJudgement,
): Exclude<ConversationPlanStatus, 'PLANNED' | 'CLAIMED'> {
  if (judgement.status === 'SENT') return 'SENT';
  if (judgement.status === 'AMBIGUOUS') return 'AMBIGUOUS';
  if (judgement.status === 'DELIVERY_FAILED') return 'FAILED';
  if (judgement.effectAttempted) return 'AMBIGUOUS';
  return judgement.retryable ? 'SKIPPED' : 'BLOCKED';
}

/** Clôt un plan sans avoir rien observé — il n'y a pas de ligne d'effet à écrire. */
async function closePlan(
  sql: Sql,
  plan: ConversationPlan,
  claimToken: string,
  status: Exclude<ConversationPlanStatus, 'PLANNED' | 'CLAIMED'>,
  reasonCode: string,
  detail: string,
  threadId: string | null,
  effectId: string | null,
): Promise<ReplyExecutionOutcome> {
  await finalizeConversationPlan(sql, {
    planId: plan.id,
    claimToken,
    status,
    reasonCode,
    detail: detail.slice(0, 1_000),
  });
  return outcome(plan.id, plan.prospectId, threadId, 'REFUSED', reasonCode, detail, false, effectId);
}

function outcome(
  planId: string | null,
  prospectId: string | null,
  threadId: string | null,
  status: ReplyExecutionStatus,
  reasonCode: string,
  detail: string,
  externalEffectAttempted: boolean,
  effectId: string | null,
): ReplyExecutionOutcome {
  return Object.freeze({
    planId,
    prospectId,
    threadId,
    status,
    reasonCode,
    detail,
    externalEffectAttempted,
    effectId,
  });
}
