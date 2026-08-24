/**
 * LEARNING-R1 §8 — la banque d'exemples, faite de RÉFÉRENCES.
 *
 * §8 demande une petite banque de conversations réellement réussies, utilisable
 * plus tard en récupération par le Conversation Brain, et pose une contrainte
 * qui décide de tout : « les conversations complètes ne doivent pas être
 * dupliquées si les messages existent déjà ». Un exemplar est donc une FICHE :
 * des identifiants, un profil de style dérivé, des compteurs, et un résumé
 * construit à partir de codes — jamais une transcription.
 *
 * Conséquence pratique, et elle est bonne : un exemplar reste juste quand un
 * message est corrigé en base, parce qu'il ne porte pas de copie. Et il ne peut
 * pas devenir un gabarit à recopier, parce qu'il n'y a rien à recopier dedans.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'on appelle « réussi », faute de mieux, et en le disant
 * ---------------------------------------------------------------------------
 *
 * Aucune source du dépôt ne porte « client gagné » ni « rendez-vous pris »
 * (voir `STAGE_OBSERVABILITY`). Sélectionner sur le résultat commercial est
 * donc impossible aujourd'hui. La banque sélectionne sur la PROGRESSION
 * observée — une conversation qui est allée plus loin qu'un accusé de réception
 * — et chaque fiche porte `commercialOutcome: 'UNKNOWN'` tant que rien ne le
 * renseigne. Un exemplar qui prétendrait « ça a marché » sans source serait
 * exactement l'invention que CLAUDE.md §2 interdit.
 */

import type { StyleProfile } from '@/lib/conversation/style';
import { funnelRank, type FunnelStage, type ProspectOutcome, type TerminalOutcome } from '@/lib/learning/outcome';
import type { MessageFamily } from '@/lib/learning/targeting';
import type { TurnFeedback } from '@/lib/learning/feedback';

/** Le barreau minimal pour entrer dans la banque. */
export const MIN_STAGE_FOR_EXEMPLAR: FunnelStage = 'ENGAGED';

/** Combien de fiches au plus. Une banque qu'on ne relit pas ne sert à rien. */
export const MAX_EXEMPLARS = 20;

export type CommercialOutcome = 'UNKNOWN' | 'LOST' | 'UNSUBSCRIBED';

export interface Exemplar {
  readonly prospectId: string;
  readonly manifestId: string | null;
  readonly channel: string;
  readonly messageFamily: MessageFamily;
  readonly stageReached: FunnelStage;
  /**
   * L'issue commerciale.
   *
   * `UNKNOWN` tant qu'aucune source ne porte de gain ni de rendez-vous. Ce
   * n'est pas un défaut de la banque, c'est l'état du dépôt, et il est écrit
   * ici pour qu'on ne le prenne pas pour un succès.
   */
  readonly commercialOutcome: CommercialOutcome;
  /** Les messages entrants, PAR RÉFÉRENCE. Aucun texte n'est copié. */
  readonly inboundMessageIds: readonly string[];
  /** Les brouillons concernés, par référence. */
  readonly draftIds: readonly string[];
  /** Le profil de style du prospect, dérivé — pas un extrait de ses messages. */
  readonly prospectStyle: StyleProfile;
  readonly inboundTurnCount: number;
  readonly inboundBursts: number;
  readonly firstReplyLatencyMs: number | null;
  /** Résumé DÉTERMINISTE, construit de codes. Aucun mot du prospect n'y entre. */
  readonly summary: string;
}

export interface ExemplarCandidate {
  readonly outcome: ProspectOutcome;
  readonly turns: readonly TurnFeedback[];
  readonly prospectStyle: StyleProfile;
  readonly messageFamily: MessageFamily;
}

/**
 * Le résumé d'une conversation, écrit en codes.
 *
 * Trois raisons pour cette forme plutôt qu'un résumé rédigé : elle est
 * déterministe (donc testable), elle ne peut pas contenir un fragment de
 * message par inadvertance, et elle n'exige aucun appel de modèle — donc
 * `learning:report` reste gratuit et hors ligne.
 */
export function summarizeExemplar(candidate: ExemplarCandidate): string {
  const { outcome, turns } = candidate;
  const questions = [...new Set(turns.map((turn) => turn.signals.questionTopic))].filter(
    (topic) => topic !== 'NONE',
  );
  const objections = [...new Set(turns.map((turn) => turn.signals.objectionTopic))].filter(
    (topic) => topic !== 'NONE',
  );
  const readiness = turns.reduce<string>((highest, turn) => {
    const order = ['LOW', 'MEDIUM', 'HIGH'];
    return order.indexOf(turn.offerReadiness) > order.indexOf(highest) ? turn.offerReadiness : highest;
  }, 'LOW');

  return [
    `stage=${outcome.stage}`,
    `terminal=${outcome.terminal ?? 'NONE'}`,
    `family=${candidate.messageFamily}`,
    `turns=${turns.length}`,
    `bursts=${outcome.inboundBursts}`,
    `questions=${questions.length === 0 ? 'NONE' : questions.join('|')}`,
    `objections=${objections.length === 0 ? 'NONE' : objections.join('|')}`,
    `offer_readiness_max=${readiness}`,
  ].join(' ');
}

function commercialOutcomeOf(terminal: TerminalOutcome | null): CommercialOutcome {
  return terminal ?? 'UNKNOWN';
}

/**
 * Retient les conversations qui sont allées quelque part.
 *
 * Une demande d'arrêt est exclue quel que soit son parcours : ce n'est pas un
 * exemple dont on veut s'inspirer, et le garder « pour la variété » ferait
 * entrer dans la banque le seul cas où notre message a explicitement gêné.
 */
export function buildExemplarBank(candidates: readonly ExemplarCandidate[]): readonly Exemplar[] {
  const kept = candidates
    .filter((candidate) => funnelRank(candidate.outcome.stage) >= funnelRank(MIN_STAGE_FOR_EXEMPLAR))
    .filter((candidate) => candidate.outcome.terminal !== 'UNSUBSCRIBED')
    .sort((left, right) => {
      const byStage = funnelRank(right.outcome.stage) - funnelRank(left.outcome.stage);
      if (byStage !== 0) return byStage;
      return right.outcome.inboundBursts - left.outcome.inboundBursts;
    })
    .slice(0, MAX_EXEMPLARS);

  return Object.freeze(
    kept.map((candidate) =>
      Object.freeze({
        prospectId: candidate.outcome.prospectId,
        manifestId: candidate.outcome.manifestId,
        channel: candidate.outcome.channel,
        messageFamily: candidate.messageFamily,
        stageReached: candidate.outcome.stage,
        commercialOutcome: commercialOutcomeOf(candidate.outcome.terminal),
        inboundMessageIds: Object.freeze(candidate.turns.map((turn) => turn.inboundMessageId)),
        draftIds: Object.freeze(
          candidate.turns
            .map((turn) => turn.draftId)
            .filter((id): id is string => id !== null),
        ),
        prospectStyle: candidate.prospectStyle,
        inboundTurnCount: candidate.turns.length,
        inboundBursts: candidate.outcome.inboundBursts,
        firstReplyLatencyMs: candidate.outcome.firstReplyLatencyMs,
        summary: summarizeExemplar(candidate),
      }),
    ),
  );
}
