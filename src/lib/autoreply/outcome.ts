/**
 * HERMES-AUTO-REPLY-PRODUCTION-R1 §9 — le vocabulaire d'OBSERVATION du runtime.
 *
 * ---------------------------------------------------------------------------
 * Ce n'est PAS une seconde décision
 * ---------------------------------------------------------------------------
 * Chaque valeur est la TRADUCTION d'un verdict déjà rendu par son
 * propriétaire — `decideAutonomousReply` pour le contenu,
 * `evaluateConversationEffectGate` pour l'effet, `judgeReplyOutcome` pour la
 * remise, `assessAutoReplyEligibility` pour le périmètre. Aucun seuil n'est
 * relu ici, aucun refus n'est requalifié, et un refus que ce module ne saurait
 * pas nommer devient `HARD_BLOCKED_SAFETY` — jamais un feu vert.
 *
 * C'est exactement la posture d'`AutonomousStopCode` côté sortant, et le
 * parallèle est délibéré : un opérateur qui a appris à lire l'un lit l'autre.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi les plafonds et l'arrêt global ne portent pas le même mot
 * ---------------------------------------------------------------------------
 * Un plafond atteint cesse tout seul : le temps passe, la fenêtre glissante se
 * vide. Un arrêt global ne cesse que si quelqu'un le décide. Les confondre
 * ferait attendre l'écoulement du temps devant une porte que seule une
 * personne ouvre — et ferait appeler quelqu'un devant une porte qui allait
 * s'ouvrir seule.
 *
 * `TEMPORAIREMENT bloqué` ne veut donc jamais dire « le runtime est cassé », et
 * `HARD_BLOCKED_SAFETY` ne veut jamais dire « réessaie dans une minute ».
 */

import type { ConversationEffectRefusal } from '@/lib/conversation/preEffect';
import type { AutoReplyEligibilityRefusal } from '@/lib/autoreply/eligibility';
import type { AutonomousReplyOutcome } from '@/lib/conversation/autonomy';
import type { ReplyExecutionStatus } from '@/lib/conversation/replyExecution';

export type AutoReplyOutcome =
  // --- Ce qui s'est passé ---------------------------------------------------
  /** Un message est parti, et la remise est prouvée. */
  | 'AUTO_REPLIED'
  /** Un humain doit reprendre. Une issue NORMALE, pas une panne. */
  | 'HUMAN_ESCALATION'
  /** La conversation est close, définitivement, par la politique de contenu. */
  | 'CONVERSATION_STOPPED'
  /** Le parcours entier, sans clic — mode aperçu. */
  | 'PREVIEWED'
  // --- Ce qui reviendra tout seul ------------------------------------------
  /** « Pas encore » : salve ouverte, brouillon en cours, tour à réécrire. */
  | 'DEFERRED_NOT_YET'
  /** Le délai humain du plan n'est pas écoulé. Rien à réparer. */
  | 'WAITING_HUMAN_DELAY'
  | 'TEMPORARILY_BLOCKED_CAP'
  | 'TEMPORARILY_BLOCKED_WINDOW'
  | 'TEMPORARILY_BLOCKED_COOLDOWN'
  /** L'autre runtime Hermes tient le profil. Une file d'attente, pas une panne. */
  | 'BROWSER_PROFILE_BUSY'
  /** Un message est arrivé depuis : ce plan est mort, le tour neuf repart. */
  | 'STALE_REBUILT'
  // --- Ce qui ferme --------------------------------------------------------
  /** L'arrêt global, une exclusion, une identité, un état commercial terminal. */
  | 'HARD_BLOCKED_SAFETY'
  /** Le clic a eu lieu, l'issue est inconnue. Terminal, jamais rejoué. */
  | 'DELIVERY_AMBIGUOUS'
  /** Le rail a conclu que rien n'était arrivé. */
  | 'DELIVERY_FAILED'
  /** Cette conversation n'entre pas dans le périmètre autonome. */
  | 'NOT_ELIGIBLE'
  // --- Ce qui décrit le CYCLE, pas un tour ---------------------------------
  | 'NO_ELIGIBLE_CONVERSATION'
  | 'RUNTIME_NOT_ACTIVATED'
  | 'ROLLOUT_BUDGET_EXHAUSTED'
  | 'RUNTIME_REVISION_STOP';

/**
 * La traduction des refus du crochet pré-effet.
 *
 * Exhaustive par construction : `Record<ConversationEffectRefusal, …>` sans
 * `Partial`, donc le compilateur s'arrête ici le jour où un refus naît. Un
 * `Partial` aurait laissé un refus inconnu tomber sur `undefined`, et c'est
 * précisément le trou qu'on n'accepte pas sur un chemin qui envoie.
 */
const EFFECT_REFUSAL_OUTCOME: Readonly<Record<ConversationEffectRefusal, AutoReplyOutcome>> =
  Object.freeze({
    BLOCKED_KILL_SWITCH: 'HARD_BLOCKED_SAFETY',
    BLOCKED_OUTSIDE_WINDOW: 'TEMPORARILY_BLOCKED_WINDOW',
    BLOCKED_DAILY_CAP: 'TEMPORARILY_BLOCKED_CAP',
    BLOCKED_HOURLY_CAP: 'TEMPORARILY_BLOCKED_CAP',
    BLOCKED_COOLDOWN: 'TEMPORARILY_BLOCKED_COOLDOWN',
    BLOCKED_SAFETY: 'HARD_BLOCKED_SAFETY',
    BROWSER_PROFILE_BUSY: 'BROWSER_PROFILE_BUSY',
    PLAN_NOT_LIVE: 'HARD_BLOCKED_SAFETY',
    PLAN_NOT_ACTIONABLE: 'HARD_BLOCKED_SAFETY',
    PLAN_STALE: 'STALE_REBUILT',
    PLAN_POLICY_MISMATCH: 'STALE_REBUILT',
    EFFECT_ALREADY_ATTEMPTED: 'HARD_BLOCKED_SAFETY',
    PROSPECT_SUPPRESSED: 'HARD_BLOCKED_SAFETY',
    PROSPECT_TERMINAL_STATE: 'HARD_BLOCKED_SAFETY',
    IDENTITY_UNCONFIRMED: 'HARD_BLOCKED_SAFETY',
  });

/** La traduction des refus de périmètre. Exhaustive, pour la même raison. */
const ELIGIBILITY_REFUSAL_OUTCOME: Readonly<Record<AutoReplyEligibilityRefusal, AutoReplyOutcome>> =
  Object.freeze({
    RUNTIME_NOT_ACTIVATED: 'RUNTIME_NOT_ACTIVATED',
    BEFORE_ACTIVATION_FRONTIER: 'NOT_ELIGIBLE',
    NOT_CORRELATED: 'NOT_ELIGIBLE',
    NO_HERMES_FIRST_TOUCH: 'NOT_ELIGIBLE',
    CHANNEL_UNSUPPORTED: 'NOT_ELIGIBLE',
    PROSPECT_SUPPRESSED: 'HARD_BLOCKED_SAFETY',
    CONVERSATION_CLOSED: 'HARD_BLOCKED_SAFETY',
    IDENTITY_UNCONFIRMED: 'HARD_BLOCKED_SAFETY',
    IDENTITY_AMBIGUOUS: 'HARD_BLOCKED_SAFETY',
    SUPERSEDED_BY_NEWER_TURN: 'STALE_REBUILT',
    ABSORBED_INTO_BURST: 'NOT_ELIGIBLE',
    NOT_UNDERSTOOD_YET: 'DEFERRED_NOT_YET',
    ANALYSIS_VERSION_STALE: 'DEFERRED_NOT_YET',
    EFFECT_ALREADY_ATTEMPTED: 'HARD_BLOCKED_SAFETY',
  });

/** La traduction des décisions de contenu. Exhaustive, pour la même raison. */
const DECISION_OUTCOME: Readonly<Record<AutonomousReplyOutcome, AutoReplyOutcome>> = Object.freeze({
  AUTO_REPLY_ELIGIBLE: 'AUTO_REPLIED',
  AUTO_REPLY_SKIP: 'DEFERRED_NOT_YET',
  HUMAN_ESCALATION: 'HUMAN_ESCALATION',
  TERMINAL_STOP: 'CONVERSATION_STOPPED',
});

export function outcomeForEligibilityRefusal(refusal: AutoReplyEligibilityRefusal): AutoReplyOutcome {
  return ELIGIBILITY_REFUSAL_OUTCOME[refusal];
}

export function outcomeForDecision(decision: AutonomousReplyOutcome): AutoReplyOutcome {
  return DECISION_OUTCOME[decision];
}

/**
 * L'issue d'une EXÉCUTION, traduite depuis son statut et son code de refus.
 *
 * Le statut d'abord — il porte ce qui est arrivé au monde. Le code ensuite,
 * pour les statuts qui n'en disent pas assez (`BLOCKED`, `FAILED`, `REFUSED`
 * recouvrent quinze refus différents). Fail-closed : un code inconnu tombe sur
 * `HARD_BLOCKED_SAFETY`, jamais sur une attente.
 */
export function outcomeForExecution(status: ReplyExecutionStatus, reasonCode: string): AutoReplyOutcome {
  switch (status) {
    case 'SENT':
      return 'AUTO_REPLIED';
    case 'AMBIGUOUS':
      return 'DELIVERY_AMBIGUOUS';
    case 'DELIVERY_FAILED':
      return 'DELIVERY_FAILED';
    case 'PREVIEWED':
    case 'DRAFT_READY':
      return 'PREVIEWED';
    case 'NO_PLAN':
      // Le plan n'était pas dû, ou un autre worker l'a pris. Ni l'un ni l'autre
      // n'est une panne — et ce runtime n'est pas seul à pouvoir prendre un
      // plan (`conversation:reply` existe, nommé et manuel).
      return 'WAITING_HUMAN_DELAY';
    case 'BLOCKED':
    case 'FAILED':
    case 'REFUSED':
      return outcomeForRefusalCode(reasonCode);
  }
}

/**
 * Un code de refus, quel qu'en soit l'émetteur, traduit fail-closed.
 *
 * Les codes du crochet pré-effet sont connus ; ceux du rail (`REPLY_*`,
 * `IG_REPLY_*`, `TARGET_*`) ne le sont pas et n'ont pas à l'être — ce sont des
 * refus, et un refus non nommé est traité comme le plus fermé des refus.
 */
export function outcomeForRefusalCode(reasonCode: string): AutoReplyOutcome {
  const known = (EFFECT_REFUSAL_OUTCOME as Readonly<Record<string, AutoReplyOutcome | undefined>>)[
    reasonCode
  ];
  return known ?? 'HARD_BLOCKED_SAFETY';
}

/** Les issues qui décrivent un tour PARTI vers Instagram. */
export function isEffectOutcome(outcome: AutoReplyOutcome): boolean {
  return outcome === 'AUTO_REPLIED' || outcome === 'DELIVERY_AMBIGUOUS' || outcome === 'DELIVERY_FAILED';
}
