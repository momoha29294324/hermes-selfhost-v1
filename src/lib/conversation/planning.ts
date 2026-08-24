/**
 * HERMES-CONTROLLED-LIVE-CONVERSATION-CANARY-R1 §5 — d'une ÉVALUATION à une
 * INTENTION inscrite. Le chaînon qui manquait.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce fichier répare
 * ---------------------------------------------------------------------------
 * Le dépôt savait tout faire sauf une chose. `assessInboundMessage` rend une
 * décision complète ; `recordConversationPlan` sait inscrire une intention ;
 * `executeConversationReply` sait exécuter un plan `AUTO_REPLY_ELIGIBLE`. Entre
 * la première et la seconde, il n'y avait RIEN — `recordConversationPlan`
 * n'avait aucun appelant hors des tests, et c'est la raison littérale pour
 * laquelle « aucune conversation AUTO_REPLY_ELIGIBLE n'existe » : personne
 * n'écrivait jamais de plan.
 *
 * Ce module est cette ligne-là, et rien de plus.
 *
 * ---------------------------------------------------------------------------
 * Il ne DÉCIDE rien
 * ---------------------------------------------------------------------------
 * Pas un seuil, pas une fenêtre, pas une comparaison. Il recopie la décision
 * que la politique a rendue, telle quelle, dans la ligne qui la porte. C'est
 * délibéré et c'est vérifiable : `plan.decision` vaut TOUJOURS
 * `assessment.autonomous.outcome`, sans traduction, sans indulgence, sans
 * « si le reste est vert alors ».
 *
 * La conséquence pratique est celle qu'on veut : inscrire un plan ne peut pas
 * rendre éligible ce que la politique refuse. Un `HUMAN_ESCALATION` s'inscrit
 * CLOS (`recordConversationPlan` s'en charge), un `TERMINAL_STOP` aussi. Écrire
 * l'intention n'ouvre donc aucune porte — cela ne fait que rendre relisible ce
 * qui a été décidé.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'il n'ouvre pas
 * ---------------------------------------------------------------------------
 * Aucun effet : aucun provider, aucun navigateur, aucune primitive d'envoi
 * n'entre dans sa clôture d'imports. Aucun plan écrit ici ne part tout seul —
 * il faut encore que quelqu'un appelle l'exécution, que l'arrêt global soit
 * levé, que le crochet pré-effet passe DEUX fois, et que la décision se rejoue
 * à l'identique sur l'état du moment.
 */

import type { ConversationAssessment } from '@/lib/conversation/assessment';
import {
  recordConversationPlan,
  type ConversationPlanDecision,
  type RecordPlanResult,
} from '@/lib/conversation/plan';
import type { Sql } from '@/lib/db/sql';

/**
 * La décision d'autonomie, telle quelle, dans le vocabulaire des plans.
 *
 * Les quatre issues de `AutonomousReplyOutcome` sont littéralement quatre des
 * huit `ConversationPlanDecision`. L'écrire comme une fonction plutôt que comme
 * un transtypage a une raison : le jour où l'une des deux unions gagne un
 * membre, le compilateur s'arrête ICI plutôt que de laisser une valeur inconnue
 * atteindre une colonne contrainte.
 */
export function planDecisionFor(
  outcome: ConversationAssessment['autonomous']['outcome'],
): ConversationPlanDecision {
  switch (outcome) {
    case 'AUTO_REPLY_ELIGIBLE':
      return 'AUTO_REPLY_ELIGIBLE';
    case 'AUTO_REPLY_SKIP':
      return 'AUTO_REPLY_SKIP';
    case 'HUMAN_ESCALATION':
      return 'HUMAN_ESCALATION';
    case 'TERMINAL_STOP':
      return 'TERMINAL_STOP';
  }
}

/**
 * Inscrit l'intention que cette évaluation porte.
 *
 * Le TEXTE n'est joint que si la décision autorise un effet. Un plan refusé qui
 * transporterait quand même son brouillon offrirait à un futur chemin un texte
 * tout prêt, à un endroit où la décision dit « non » — c'est-à-dire exactement
 * la forme qu'un contournement prend en pratique. Un refus n'a pas de corps.
 *
 * `notBefore` vient de l'évaluation (le délai humain de §22, ancré sur la fin
 * de la salve). Il n'est pas recalculé ici : deux calculs du même retard
 * finiraient par diverger d'une seconde, et l'idempotence du plan porte sur sa
 * clé, pas sur son heure.
 */
export async function planConversationReply(
  sql: Sql,
  assessment: ConversationAssessment,
): Promise<RecordPlanResult> {
  const decision = planDecisionFor(assessment.autonomous.outcome);
  const actionable = decision === 'AUTO_REPLY_ELIGIBLE';

  return recordConversationPlan(sql, {
    prospectId: assessment.prospectId,
    channel: assessment.channel,
    kind: 'AUTO_REPLY',
    triggerInboundMessageId: assessment.inboundMessageId,
    // Ce que le système a compris de ce tour. Une reclassification produit une
    // intention neuve plutôt qu'un plan périmé rendu en silence ; un second
    // effet reste impossible, `recordConversationPlan` s'en charge.
    understandingRef: assessment.analysisId,
    // Et sous quelles RÈGLES elle a été comprise. Sans ce composant, un tour
    // refusé sous une politique périmée resterait refusé pour toujours, sans
    // autre issue que de reclasser un message correctement classé.
    policyRef: assessment.policyVersion,
    policyVersion: assessment.policyVersion,
    commercialPolicyVersion: assessment.commercialPolicyVersion,
    brainVersion: assessment.brainVersion,
    decision,
    decisionGate: assessment.autonomous.gate,
    decisionReason: assessment.autonomous.reason,
    decisionDetail: assessment.autonomous.detail.slice(0, 1_000),
    conversationWatermark: assessment.conversationWatermark,
    body: actionable ? (assessment.draft?.body ?? null) : null,
    naturalnessVerdict: assessment.draft?.naturalness.verdict ?? null,
    groundingGaps: assessment.groundingGaps,
    offerReadiness: assessment.offer.readiness,
    callReadiness: assessment.callReadiness,
    notBefore: new Date(assessment.notBefore),
  });
}
