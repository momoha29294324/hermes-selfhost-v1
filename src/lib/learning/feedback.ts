/**
 * LEARNING-R1 §5, §6 — le retour d'expérience d'un tour, par RÉFÉRENCE.
 *
 * Rien de ce que ce fichier produit ne contient un message. Un `TurnFeedback`
 * porte des identifiants canoniques, des codes d'énumération et des compteurs ;
 * le texte reste là où il est déjà — `r6b_inbound_messages.body_text`,
 * `r6b_batch_votes.approved_text`, `r6b_reply_drafts.human_text`. §5 le demande
 * (« ne jamais écraser le message réel »), §22 aussi (« éviter toute
 * duplication massive de contenu conversationnel »), et la raison profonde est
 * la même dans les deux cas : une copie diverge, et le jour où elle diverge on
 * ne sait plus laquelle croire.
 *
 * ---------------------------------------------------------------------------
 * Les deux endroits où un humain écrit
 * ---------------------------------------------------------------------------
 *
 * Le dépôt en connaît exactement deux, et la boucle lit les deux :
 *
 *   1. **le premier message** — `r6b_batch_items.original_draft` porte ce que
 *      le modèle a écrit, `r6b_batch_votes.approved_text` ce qu'un humain a
 *      validé. Seuls les votes `actor_kind = 'HUMAN'` comptent : un vote
 *      `AUTONOMOUS_POLICY` est une machine qui approuve une machine, et
 *      l'apprendre comme une préférence de un opérateur serait apprendre un écho ;
 *
 *   2. **les réponses** — `r6b_reply_drafts.body` contre `human_text`, quand un
 *      humain a réécrit (`EDITED`) ou validé tel quel (`APPROVED`).
 *
 * Il n'y en a pas de troisième, et c'est une LACUNE réelle qu'il faut nommer
 * plutôt que combler par une supposition : un message tapé directement dans
 * Instagram ne laisse en base qu'une empreinte (`text_sha256`) et une direction
 * souvent indécidable (`SKIPPED_UNKNOWN_DIRECTION`). Son texte n'est pas
 * observable. Le champ `humanTextObservability` le dit à chaque tour, et le
 * rapport le remonte au lieu de compter zéro correction.
 */

import { compareOverride, type OverrideComparison } from '@/lib/learning/override';
import { assessOfferReadiness, type OfferReadiness } from '@/lib/learning/offer';
import type { FunnelStage } from '@/lib/learning/outcome';
import { readSignals, type ConversationSignals } from '@/lib/conversation/signals';
import type { ConversationThread } from '@/lib/conversation/thread';
import type { CoveredTopic } from '@/lib/conversation/state';
import type { ReplyCategory } from '@/lib/replies/taxonomy';

// ---------------------------------------------------------------------------
// D'où vient le texte humain
// ---------------------------------------------------------------------------

export type HumanTextSource =
  /** Premier message : brouillon de modèle, validé ou réécrit par un humain. */
  | 'FIRST_TOUCH_VOTE'
  /** Réponse : brouillon `r6b_reply_drafts`, validé ou réécrit par un humain. */
  | 'REPLY_DRAFT'
  /** Un humain a écrit hors du dépôt. Le texte n'existe nulle part en base. */
  | 'NOT_OBSERVABLE';

/** Un couple brouillon / texte retenu, prêt à être comparé. */
export interface OverridePair {
  readonly source: Exclude<HumanTextSource, 'NOT_OBSERVABLE'>;
  readonly prospectId: string;
  /** L'identifiant canonique de la ligne qui porte le texte retenu. */
  readonly referenceId: string;
  readonly at: string;
  readonly draftBody: string;
  readonly sentBody: string;
}

export interface OverrideRecord {
  readonly source: Exclude<HumanTextSource, 'NOT_OBSERVABLE'>;
  readonly prospectId: string;
  readonly referenceId: string;
  readonly at: string;
  readonly comparison: OverrideComparison;
}

/**
 * Compare une liste de couples. Aucun texte ne survit à l'appel.
 *
 * C'est la frontière de confidentialité du module : les textes entrent, des
 * codes sortent. Tout ce qui est en aval — profil de voix, propositions,
 * rapport — ne voit jamais autre chose que des `OverrideComparison`.
 */
export function recordOverrides(pairs: readonly OverridePair[]): readonly OverrideRecord[] {
  return Object.freeze(
    pairs.map((pair) =>
      Object.freeze({
        source: pair.source,
        prospectId: pair.prospectId,
        referenceId: pair.referenceId,
        at: pair.at,
        comparison: compareOverride(pair.draftBody, pair.sentBody),
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Le tour
// ---------------------------------------------------------------------------

export interface TurnFeedback {
  readonly prospectId: string;
  readonly inboundMessageId: string;
  readonly receivedAt: string;
  /** Le rang de ce tour parmi les tours entrants de ce prospect. 1 = le premier. */
  readonly turnIndex: number;
  /** La conclusion D2 déjà rendue. `null` quand aucune analyse ACTIVE n'existe. */
  readonly classification: ReplyCategory | null;
  readonly confidence: number | null;
  /** Le brouillon Hermes de CE tour, s'il existe. */
  readonly draftId: string | null;
  /** La comparaison brouillon → texte retenu. `null` sans brouillon (§25.2). */
  readonly override: OverrideComparison | null;
  readonly humanTextObservability: HumanTextSource;
  readonly signals: Pick<
    ConversationSignals,
    'questionTopic' | 'objectionTopic' | 'buyingSignal' | 'callReadiness' | 'explicitCallRequest'
  >;
  readonly offerReadiness: OfferReadiness;
  readonly offerReasons: readonly string[];
  /** Le tour entrant SUIVANT, quand il y en a un. */
  readonly nextInboundMessageId: string | null;
  readonly nextReplyLatencyMs: number | null;
  readonly nextClassification: ReplyCategory | null;
  /** Le barreau atteint par ce prospect, tel que l'issue le porte. */
  readonly stageReached: FunnelStage;
}

/** Un message entrant, réduit à ce que la boucle consomme. */
export interface InboundTurnInput {
  readonly id: string;
  readonly receivedAt: string;
  readonly bodyText: string;
  readonly classification: ReplyCategory | null;
  readonly confidence: number | null;
  readonly draftId: string | null;
  readonly override: OverrideComparison | null;
  readonly humanTextObservability: HumanTextSource;
}

export interface BuildTurnsInput {
  readonly prospectId: string;
  readonly channel: 'email' | 'instagram_dm';
  readonly turns: readonly InboundTurnInput[];
  /** Ce que NOS tours prouvés partis ont couvert. Vide si rien n'est observable. */
  readonly coveredTopics: readonly CoveredTopic[];
  readonly stageReached: FunnelStage;
}

/**
 * Un fil MINIMAL, construit pour `readSignals` et rien d'autre.
 *
 * `readSignals` n'utilise du fil qu'une seule chose : combien de fois cette
 * personne avait déjà écrit avant le message courant (`priorInboundCount`, via
 * `resolveCallReadiness`). Reconstruire un vrai `ConversationThread` demanderait
 * un `ReplyContext` complet — manifeste, recherche, angle — c'est-à-dire trois
 * lectures de plus par tour, pour une valeur que la boucle connaît déjà par
 * construction. On donne donc le strict nécessaire, et le reste est vide plutôt
 * qu'inventé.
 */
function minimalThread(
  prospectId: string,
  channel: 'email' | 'instagram_dm',
  currentInboundId: string,
  priorInboundCount: number,
): ConversationThread {
  return Object.freeze({
    prospectId,
    turns: Object.freeze([]),
    inboundTurns: Object.freeze([]),
    outboundTurns: Object.freeze([]),
    exposedOutboundTurns: Object.freeze([]),
    currentInboundId,
    priorInboundCount,
    channel,
    truncated: false,
  });
}

/**
 * Construit le retour de chaque tour d'une conversation.
 *
 * Les tours sont supposés TRIÉS par date croissante — c'est ce que rend la
 * requête, et le trier à nouveau ici masquerait un jour une requête cassée.
 */
export function buildTurnFeedback(input: BuildTurnsInput): readonly TurnFeedback[] {
  return Object.freeze(
    input.turns.map((turn, index) => {
      const category: ReplyCategory = turn.classification ?? 'OTHER';
      const signals = readSignals(
        turn.bodyText,
        category,
        minimalThread(input.prospectId, input.channel, turn.id, index),
      );
      const offer = assessOfferReadiness({
        category,
        signals,
        coveredTopics: input.coveredTopics,
      });

      const next = input.turns[index + 1] ?? null;
      const currentMs = Date.parse(turn.receivedAt);
      const nextMs = next === null ? Number.NaN : Date.parse(next.receivedAt);
      const latency =
        Number.isFinite(currentMs) && Number.isFinite(nextMs) && nextMs >= currentMs
          ? nextMs - currentMs
          : null;

      return Object.freeze({
        prospectId: input.prospectId,
        inboundMessageId: turn.id,
        receivedAt: turn.receivedAt,
        turnIndex: index + 1,
        classification: turn.classification,
        confidence: turn.confidence,
        draftId: turn.draftId,
        override: turn.override,
        humanTextObservability: turn.humanTextObservability,
        signals: Object.freeze({
          questionTopic: signals.questionTopic,
          objectionTopic: signals.objectionTopic,
          buyingSignal: signals.buyingSignal,
          callReadiness: signals.callReadiness,
          explicitCallRequest: signals.explicitCallRequest,
        }),
        offerReadiness: offer.readiness,
        offerReasons: offer.reasons,
        nextInboundMessageId: next?.id ?? null,
        nextReplyLatencyMs: latency,
        nextClassification: next?.classification ?? null,
        stageReached: input.stageReached,
      });
    }),
  );
}
