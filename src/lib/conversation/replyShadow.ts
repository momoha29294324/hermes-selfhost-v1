/**
 * HERMES-REPLY-DELIVERY-R1 §15 — le MODE OMBRE de l'orchestrateur de réponse.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'il observe, et ce qu'il ne peut pas faire
 * ---------------------------------------------------------------------------
 * Il parcourt exactement les portes de l'orchestrateur, dans le même ordre, en
 * appelant les MÊMES fonctions — la décision, la cible, le crochet pré-effet —
 * et il s'arrête là où le navigateur commencerait. Il ne prend aucun plan, il
 * n'écrit rien, il n'ouvre rien.
 *
 * « Aucun effet » n'est pas ici une consigne mais une propriété du fichier :
 * il n'importe aucun rail, aucune primitive, aucune fonction d'écriture. Il n'y
 * a rien à appeler pour envoyer, et un test le vérifie sur le source.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi il n'utilise pas `executeConversationReply` avec un rail muet
 * ---------------------------------------------------------------------------
 * Parce que l'orchestrateur PREND le plan, incrémente ses tentatives et clôt
 * son bail. Un mode ombre qui ferait cela laisserait des traces d'exécution sur
 * des intentions que personne n'a voulu exécuter, et changerait l'état qu'il
 * prétend observer. Le partage est le même que partout ailleurs dans ce dépôt :
 * la lecture d'un côté, l'effet de l'autre.
 *
 * La contrepartie assumée : il n'exerce pas la réservation ni la clôture. Ces
 * deux-là s'éprouvent sur PostgreSQL réel, dans les tests de concurrence, où
 * elles peuvent être prises en défaut sans qu'un prospect soit au bout.
 */

import type { ConversationPolicyConfig, InstagramRailConfig } from '@/lib/config/schema';
import { assessInboundMessage } from '@/lib/conversation/assessment';
import { formatAutonomousReplyDecision } from '@/lib/conversation/autonomy';
import {
  evaluateConversationEffectGate,
  type ConversationEffectRefusal,
} from '@/lib/conversation/preEffect';
import { loadConversationPlanByKey, type ConversationPlan } from '@/lib/conversation/plan';
import { resolveReplyTarget, type ReplyTargetRefusal } from '@/lib/conversation/replyTarget';
import { canonicalAccountIdentity } from '@/lib/instagram/accountIdentity';
import type { Sql } from '@/lib/db/sql';

/** Jusqu'où le tour est allé. L'ordre du type est celui du parcours. */
export type ReplyShadowStage =
  /** Le message n'est plus évaluable : ni corrélation exploitable, ni analyse vivante. */
  | 'NOT_ASSESSABLE'
  /** La politique de contenu refuse. Le parcours s'arrête avant tout le reste. */
  | 'DECISION_REFUSED'
  /** La cible n'a pas pu être résolue depuis la base. */
  | 'TARGET_REFUSED'
  /** Aucun plan n'a été inscrit pour ce tour : il n'y a rien à exécuter. */
  | 'NO_PLAN'
  /** Le crochet pré-effet refuse. */
  | 'GATE_REFUSED'
  /**
   * Tout est vert jusqu'au dernier point. C'est ICI que le navigateur
   * s'ouvrirait, et c'est ici que le mode ombre s'arrête.
   */
  | 'READY_FOR_EFFECT';

export interface ReplyShadowObservation {
  readonly inboundMessageId: string;
  readonly prospectId: string | null;
  readonly stage: ReplyShadowStage;
  readonly decision: string | null;
  readonly targetThreadId: string | null;
  readonly targetHandle: string | null;
  readonly accountHandle: string | null;
  readonly planId: string | null;
  readonly planStatus: string | null;
  readonly gateRefusal: ConversationEffectRefusal | null;
  readonly targetRefusal: ReplyTargetRefusal | null;
  readonly detail: string;
  /** Littéral de type, pas un calcul : il n'existe aucun chemin d'ici vers un effet. */
  readonly externalEffects: false;
}

export interface ReplyShadowInput {
  readonly config: InstagramRailConfig;
  readonly conversation: ConversationPolicyConfig;
  readonly now: Date;
}

/**
 * Observe ce que l'orchestrateur ferait de CE message, sans rien faire.
 *
 * Les portes sont appelées dans l'ordre de l'exécution réelle, et le premier
 * refus gagne — c'est ce qui rend le rapport comparable à ce qui se passerait :
 * un tour refusé par la politique n'est pas allé chercher sa cible, et un
 * rapport qui l'aurait fait quand même donnerait à lire un parcours qui n'a pas
 * eu lieu.
 */
export async function observeReplyShadow(
  sql: Sql,
  inboundMessageId: string,
  input: ReplyShadowInput,
): Promise<ReplyShadowObservation> {
  const assessment = await assessInboundMessage(sql, inboundMessageId, {
    config: input.conversation,
    now: input.now,
  });
  if (assessment === null) {
    return frozen({
      inboundMessageId,
      prospectId: null,
      stage: 'NOT_ASSESSABLE',
      decision: null,
      detail:
        'ni corrélation exploitable ni analyse vivante — il n’y a rien à décider, et ce n’est pas une ' +
        'anomalie',
    });
  }

  const base = { inboundMessageId, prospectId: assessment.prospectId } as const;
  const decision = formatAutonomousReplyDecision(assessment.autonomous);

  if (assessment.autonomous.outcome !== 'AUTO_REPLY_ELIGIBLE') {
    return frozen({
      ...base,
      stage: 'DECISION_REFUSED',
      decision,
      detail: `[${assessment.autonomous.gate}] ${assessment.autonomous.detail}`,
    });
  }

  // La MÊME identité canonique que l'exécution : un rapport d'ombre qui
  // résoudrait sa cible sous un autre compte décrirait un parcours que
  // personne ne ferait.
  const identity = canonicalAccountIdentity({
    accountHandle: input.config.inbound.accountHandle ?? '',
    formerAccountHandles: input.config.inbound.formerAccountHandles,
  });
  if (!identity.ok) {
    return frozen({
      ...base,
      stage: 'TARGET_REFUSED',
      decision,
      targetRefusal: 'TARGET_ACCOUNT_NOT_OURS',
      detail: identity.detail,
    });
  }

  const resolution = await resolveReplyTarget(sql, {
    prospectId: assessment.prospectId,
    triggerInboundMessageId: inboundMessageId,
    account: identity.identity,
  });
  if (!resolution.ok) {
    return frozen({
      ...base,
      stage: 'TARGET_REFUSED',
      decision,
      targetRefusal: resolution.refusal,
      detail: resolution.detail,
    });
  }
  const target = resolution.target;
  const withTarget = {
    ...base,
    decision,
    targetThreadId: target.threadId,
    targetHandle: target.counterpartyHandle,
    accountHandle: target.accountHandle,
  } as const;

  const plan: ConversationPlan | null = await loadConversationPlanByKey(sql, assessment.idempotencyKey);
  if (plan === null) {
    return frozen({
      ...withTarget,
      stage: 'NO_PLAN',
      detail:
        `aucun plan inscrit sous la clé ${assessment.idempotencyKey} — la décision est verte et la cible ` +
        'résolue, mais rien n’a encore été enregistré à exécuter',
    });
  }

  const gate = await evaluateConversationEffectGate(sql, {
    config: input.config,
    plan,
    now: input.now,
  });
  if (!gate.allowed) {
    return frozen({
      ...withTarget,
      stage: 'GATE_REFUSED',
      planId: plan.id,
      planStatus: plan.status,
      gateRefusal: gate.refusal,
      detail: gate.detail,
    });
  }

  return frozen({
    ...withTarget,
    stage: 'READY_FOR_EFFECT',
    planId: plan.id,
    planStatus: plan.status,
    detail:
      `toutes les portes sont vertes jusqu'au dernier point : fil ${target.threadId}, correspondant ` +
      `« ${target.counterpartyHandle} », compte « ${target.accountHandle} ». C'est ICI qu'un navigateur ` +
      's’ouvrirait — le mode ombre s’arrête avant.',
  });
}

interface ShadowDraft {
  readonly inboundMessageId: string;
  readonly prospectId: string | null;
  readonly stage: ReplyShadowStage;
  readonly decision: string | null;
  readonly detail: string;
  readonly targetThreadId?: string;
  readonly targetHandle?: string;
  readonly accountHandle?: string;
  readonly planId?: string;
  readonly planStatus?: string;
  readonly gateRefusal?: ConversationEffectRefusal;
  readonly targetRefusal?: ReplyTargetRefusal;
}

/** Complète les champs non renseignés par `null`, une fois, au même endroit. */
function frozen(partial: ShadowDraft): ReplyShadowObservation {
  return Object.freeze({
    inboundMessageId: partial.inboundMessageId,
    prospectId: partial.prospectId,
    stage: partial.stage,
    decision: partial.decision,
    targetThreadId: partial.targetThreadId ?? null,
    targetHandle: partial.targetHandle ?? null,
    accountHandle: partial.accountHandle ?? null,
    planId: partial.planId ?? null,
    planStatus: partial.planStatus ?? null,
    gateRefusal: partial.gateRefusal ?? null,
    targetRefusal: partial.targetRefusal ?? null,
    detail: partial.detail,
    externalEffects: false as const,
  });
}

/** La forme lisible d'une observation, pour un rapport en console. */
export function renderReplyShadow(observation: ReplyShadowObservation): string[] {
  const lines: string[] = [
    `  message      ${observation.inboundMessageId}`,
    `  étape        ${observation.stage}`,
  ];
  if (observation.decision !== null) lines.push(`  décision     ${observation.decision}`);
  if (observation.targetThreadId !== null) {
    lines.push(
      `  cible        fil ${observation.targetThreadId} · « ${observation.targetHandle ?? '?'} » ` +
        `depuis « ${observation.accountHandle ?? '?'} »`,
    );
  }
  if (observation.planId !== null) {
    lines.push(`  plan         ${observation.planId} (${observation.planStatus ?? '?'})`);
  }
  if (observation.gateRefusal !== null) lines.push(`  crochet      ${observation.gateRefusal}`);
  if (observation.targetRefusal !== null) lines.push(`  cible        ${observation.targetRefusal}`);
  lines.push(`  détail       ${observation.detail}`);
  return lines;
}

/**
 * Un résumé compact d'un lot d'observations, pour la fin d'un rapport.
 *
 * `sends` est un littéral zéro et non un compteur : ce module ne peut pas
 * produire d'effet, donc afficher un total calculé laisserait croire qu'il
 * aurait pu en compter un autre.
 */
export function summarizeReplyShadow(observations: readonly ReplyShadowObservation[]): {
  readonly evaluated: number;
  readonly byStage: Readonly<Record<string, number>>;
  readonly readyForEffect: number;
  readonly sends: 0;
} {
  const byStage: Record<string, number> = {};
  for (const observation of observations) {
    byStage[observation.stage] = (byStage[observation.stage] ?? 0) + 1;
  }
  return Object.freeze({
    evaluated: observations.length,
    byStage: Object.freeze(byStage),
    readyForEffect: observations.filter((o) => o.stage === 'READY_FOR_EFFECT').length,
    sends: 0 as const,
  });
}
