/**
 * CONVERSATION-R1 — la décision de répondre, et surtout celle de NE PAS
 * répondre.
 *
 * §14 demande que Hermes SACHE s'arrêter, même si R1 ne peut de toute façon
 * rien envoyer. La distinction est importante : implémenter la décision
 * maintenant, alors qu'aucun envoi n'est possible, est le seul moment où on
 * peut la tester sans risque. L'inverse — brancher un envoi puis découvrir que
 * la règle d'arrêt n'existait pas — est l'ordre dans lequel les accidents
 * arrivent.
 *
 * Un invariant tient tout le fichier : `autoSendAllowed` est le littéral
 * `false`, pas un booléen calculé. Aucune donnée, aucune configuration, aucun
 * appelant ne peut le faire basculer, parce qu'il n'y a rien à basculer — c'est
 * le TYPE qui l'interdit, et le compilateur refuserait un chemin qui prétendrait
 * le contraire. R1 n'ajoute aucune primitive d'envoi (§19), et cette constante
 * est ce qui rend l'affirmation vérifiable plutôt que promise.
 */

import type { ConversationSignals } from '@/lib/conversation/signals';
import type { ConversationState } from '@/lib/conversation/state';
import type { GroundingGap } from '@/lib/conversation/grounding';
import type { ReplyCategory } from '@/lib/replies/taxonomy';
import { CATEGORY_POLICY } from '@/lib/replies/taxonomy';

export type ConversationDecision =
  /** Un brouillon a du sens ; il partira en revue humaine. */
  | 'DRAFT_FOR_HUMAN'
  /** Demande d'arrêt : plus jamais, par aucun chemin automatique. */
  | 'STOP_PERMANENT'
  /** Refus clair : on arrête la prospection froide sans supprimer. */
  | 'STOP_COLD'
  /** Sujet sensible, hostile ou juridique : un humain reprend la main. */
  | 'HUMAN_ESCALATION'
  /** Message trop ambigu pour qu'une réponse soit honnête. */
  | 'CLARIFY';

export type EscalationReason =
  | 'SENSITIVE_CONTENT'
  | 'UNCLASSIFIABLE'
  | 'AMBIGUOUS_SHORT'
  | 'NO_RELIABLE_DATA';

export interface ReplyDecision {
  readonly decision: ConversationDecision;
  readonly escalationReason: EscalationReason | null;
  /**
   * Un brouillon doit-il être rédigé ?
   *
   * `STOP_PERMANENT` et `STOP_COLD` rendent `false` : écrire une réponse à
   * quelqu'un qui a demandé qu'on arrête, même pour la faire relire, met sous
   * les yeux d'un humain pressé un texte prêt à être copié-collé. Le brouillon
   * qui n'existe pas est le seul qui ne part jamais par erreur.
   */
  readonly shouldDraft: boolean;
  /**
   * Un futur R2 aurait-il le droit de répondre seul sur ce tour ?
   *
   * Consigné pour être MESURÉ avant d'être utilisé : c'est l'entrée d'une
   * décision d'automatisation, jamais une autorisation.
   */
  readonly futureAutoReplyEligible: boolean;
  /** L'envoi automatique. Toujours interdit en R1, par construction. */
  readonly autoSendAllowed: false;
}

export interface DecideInput {
  readonly category: ReplyCategory;
  readonly signals: ConversationSignals;
  readonly state: ConversationState;
  readonly groundingGaps: readonly GroundingGap[];
  /** La confiance de l'analyse D2 sur ce message. */
  readonly confidence: number;
}

/**
 * Tranche. L'ordre est la politique, et il va du plus protecteur au plus
 * commercial — jamais l'inverse.
 */
export function decideReply(input: DecideInput): ReplyDecision {
  const { category, signals, state } = input;

  const stop = (decision: 'STOP_PERMANENT' | 'STOP_COLD'): ReplyDecision =>
    Object.freeze({
      decision,
      escalationReason: null,
      shouldDraft: false,
      futureAutoReplyEligible: false,
      autoSendAllowed: false as const,
    });

  const escalate = (reason: EscalationReason): ReplyDecision =>
    Object.freeze({
      decision: 'HUMAN_ESCALATION' as const,
      escalationReason: reason,
      shouldDraft: false,
      futureAutoReplyEligible: false,
      autoSendAllowed: false as const,
    });

  // 1. Une demande d'arrêt gagne sur tout le reste, y compris sur un contenu
  //    hostile : quelqu'un qui insulte ET demande qu'on arrête a d'abord
  //    demandé qu'on arrête.
  if (category === 'UNSUBSCRIBE') return stop('STOP_PERMANENT');

  // 2. Le contenu sensible sort du chemin automatique. Un « je vous colle un
  //    avocat » n'appelle pas une réponse commerciale mieux tournée.
  if (signals.sensitiveFlags.length > 0) return escalate('SENSITIVE_CONTENT');

  // 3. Refus clair : on s'arrête, sans supprimer et sans plaider.
  if (category === 'NOT_INTERESTED') return stop('STOP_COLD');

  // 4. Ce que D2 n'a pas su lire ne devient pas lisible ici.
  if (category === 'REVIEW_REQUIRED' || category === 'OTHER') return escalate('UNCLASSIFIABLE');

  // 5. Un message trop court pour porter un sujet, sans signal d'achat et sans
  //    question, n'appelle pas une réponse devinée mais une précision.
  if (signals.tooShortToRead && signals.questionTopic === 'NONE' && signals.buyingSignal === 'NONE') {
    return Object.freeze({
      decision: 'CLARIFY' as const,
      escalationReason: 'AMBIGUOUS_SHORT' as const,
      shouldDraft: true,
      futureAutoReplyEligible: false,
      autoSendAllowed: false as const,
    });
  }

  // 6. Une question sur un sujet qu'aucune donnée ne couvre : on demande une
  //    précision plutôt que d'inventer. `shouldDraft` reste vrai — le brouillon
  //    correct est celui qui dit honnêtement qu'il ne sait pas.
  if (input.groundingGaps.includes('TOPIC_NOT_COVERED_BY_DATA')) {
    return Object.freeze({
      decision: 'CLARIFY' as const,
      escalationReason: 'NO_RELIABLE_DATA' as const,
      shouldDraft: true,
      futureAutoReplyEligible: false,
      autoSendAllowed: false as const,
    });
  }

  // 7. Le cas normal. `draftEligible` reste la table D2 : une seconde table
  //    d'éligibilité finirait par la contredire.
  const eligible = CATEGORY_POLICY[category].draftEligible;

  return Object.freeze({
    decision: eligible ? ('DRAFT_FOR_HUMAN' as const) : ('HUMAN_ESCALATION' as const),
    escalationReason: eligible ? null : ('UNCLASSIFIABLE' as const),
    shouldDraft: eligible,
    // Un tour serait candidat à une réponse autonome quand tout est clair : la
    // catégorie est confiante, aucun sujet sensible, aucun manque de données,
    // et un humain n'est pas déjà requis. Cela reste une MESURE.
    futureAutoReplyEligible:
      eligible && input.confidence >= 0.8 && input.groundingGaps.length === 0 && !state.humanNeeded,
    autoSendAllowed: false,
  });
}
