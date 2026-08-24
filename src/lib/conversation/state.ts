/**
 * CONVERSATION-R1 — l'état de la conversation, DÉRIVÉ et non stocké.
 *
 * Pourquoi aucune table : l'état ne contient rien qu'on ne puisse recalculer à
 * partir des messages canoniques et des analyses D2 déjà écrites. Le persister
 * créerait une seconde source de vérité qui se désynchroniserait au premier
 * message arrivé hors traitement, et il faudrait alors décider laquelle croit-on
 * — question sans bonne réponse. On recalcule ; c'est quelques millisecondes.
 *
 * Ce que l'état sait tenir, et qui est exactement ce qui manquait :
 *
 *   - ce que NOUS avons déjà dit (pitch, appel proposé, preuve citée) — donc ce
 *     qu'il ne faut pas répéter (§5) ;
 *   - ce qu'EUX ont déjà objecté ou demandé — donc le contexte d'une objection
 *     qui arrive au troisième tour ;
 *   - où en est l'objectif commercial — donc quoi faire ensuite, plutôt que
 *     « répondre » au sens vide.
 *
 * Rien ici n'est une supposition : chaque champ se lit dans un message ou dans
 * une ligne `r6b_reply_analyses`. Ce qui n'est pas observé vaut `false`, `NONE`
 * ou tableau vide — jamais une valeur plausible.
 */

import { normalizeForMatching } from '@/lib/conversation/text';
import type { ConversationThread, ConversationTurn } from '@/lib/conversation/thread';
import type { ConversationSignals, ObjectionTopic, QuestionTopic } from '@/lib/conversation/signals';
import type { NextAction, ReplyCategory } from '@/lib/replies/taxonomy';
import { CATEGORY_POLICY } from '@/lib/replies/taxonomy';

/** L'objectif commercial du tour à venir. */
export type ConversationGoal =
  /** On ne sait pas encore ce dont cette personne a besoin. */
  | 'UNDERSTAND_NEED'
  /** Le besoin se dessine ; une question de qualification légère a du sens. */
  | 'QUALIFY_LIGHTLY'
  /** Une question précise attend une réponse précise. */
  | 'ANSWER_QUESTION'
  /** Un frein est posé et doit être traité dans son contexte. */
  | 'HANDLE_OBJECTION'
  /** Le contexte est mûr : proposer un échange. */
  | 'PROPOSE_CALL'
  /** Accuser réception et refermer proprement, sans négocier. */
  | 'ACKNOWLEDGE_AND_CLOSE'
  /** La machine s'arrête ; un humain reprend. */
  | 'AWAIT_HUMAN';

export type QualificationState =
  | 'NOT_STARTED'
  | 'ENGAGED'
  | 'QUALIFYING'
  | 'DISQUALIFIED';

/** Ce que NOS tours ont déjà couvert. Observé dans leur texte, pas supposé. */
export type CoveredTopic =
  | 'OFFER_EXPLAINED'
  | 'HOW_IT_WORKS_EXPLAINED'
  | 'CALL_PROPOSED'
  | 'PROOF_CITED'
  | 'PRICE_ADDRESSED';

export interface ConversationState {
  readonly prospectId: string;
  /** Le nom d'affichage du prospect, tel que la base le porte. */
  readonly counterparty: string;
  readonly channel: 'email' | 'instagram_dm';

  readonly lastInboundAt: string | null;
  readonly lastOutboundAt: string | null;
  readonly inboundTurnCount: number;
  readonly outboundTurnCount: number;
  /** Vrai au tout premier échange : eux n'avaient jamais écrit avant. */
  readonly isFirstReply: boolean;

  readonly goal: ConversationGoal;
  readonly qualification: QualificationState;

  /** Ce que nous avons déjà couvert — donc ce qu'il est inutile de refaire. */
  readonly coveredTopics: readonly CoveredTopic[];
  /** Combien de questions nous avons posées, tous tours confondus. */
  readonly questionsAskedByUs: number;
  /** Les sujets de question déjà reçus, du plus ancien au plus récent. */
  readonly questionTopicsReceived: readonly QuestionTopic[];
  /** Les objections déjà rencontrées, du plus ancien au plus récent. */
  readonly objectionsEncountered: readonly ObjectionTopic[];

  readonly nextAction: NextAction;
  /** Une relance ultérieure a-t-elle encore un sens ? */
  readonly followUpStillRelevant: boolean;
  readonly humanNeeded: boolean;
}

// ---------------------------------------------------------------------------
// Ce que NOS messages ont couvert
// ---------------------------------------------------------------------------

/**
 * Motifs lus dans NOS propres tours.
 *
 * Ils sont volontairement larges : rater un « on peut s'appeler » déjà écrit
 * coûte une répétition agaçante ; en voir un qui n'existe pas coûte une
 * proposition jamais faite. Le premier défaut est réparable au tour suivant,
 * le second laisse la conversation sans issue — donc on préfère la détection
 * généreuse.
 */
const COVERED_PATTERNS: ReadonlyArray<readonly [CoveredTopic, RegExp]> = [
  ['CALL_PROPOSED', /\b(s'appeler|un appel|un échange|un point rapide|se parler|quinze minutes|15 minutes|call|téléphone|telephone|de vive voix|dispo(nible)? pour (un|en))\b/i],
  ['PROOF_CITED', /\b(3\s?500|3500)\s?€|\bnous avons déjà généré\b/i],
  ['PRICE_ADDRESSED', /\b(prix|tarif|tarifs|budget|coût|cout|combien (ça|ca) coûte|dépend (du|de la|des))\b/i],
  ['HOW_IT_WORKS_EXPLAINED', /\b(concrètement|concretement|en pratique|on commence par|la façon dont|le principe|on met en place|étape|etape)\b/i],
  ['OFFER_EXPLAINED', /\b(on aide|nous aidons|on accompagne|nous accompagnons|notre (offre|métier|travail)|on (fait|s'occupe de)|acquisition|campagnes?|publicité|pubs?)\b/i],
];

/**
 * Les sujets qu'un texte couvre, lus avec le lexique ci-dessus.
 *
 * Exportée depuis R1.1 pour que le contrôle de naturalité demande « ce
 * brouillon réexplique-t-il l'offre ? » au MÊME lexique que celui qui a établi
 * « l'offre a déjà été expliquée ». Un second lexique finirait par répondre
 * non à la première question et oui à la seconde, et la répétition passerait.
 */
export function topicsCoveredByText(text: string): CoveredTopic[] {
  const normalized = normalizeForMatching(text);
  return COVERED_PATTERNS.filter((entry) => entry[1].test(normalized)).map((entry) => entry[0]);
}

function coveredIn(turns: readonly ConversationTurn[]): CoveredTopic[] {
  const found = new Set<CoveredTopic>();
  for (const turn of turns) {
    for (const topic of topicsCoveredByText(turn.text)) found.add(topic);
  }
  return [...found];
}

function countQuestions(turns: readonly ConversationTurn[]): number {
  return turns.reduce((sum, turn) => sum + (turn.text.match(/\?/g)?.length ?? 0), 0);
}

// ---------------------------------------------------------------------------
// La dérivation
// ---------------------------------------------------------------------------

export interface DeriveStateInput {
  readonly thread: ConversationThread;
  readonly counterparty: string;
  readonly category: ReplyCategory;
  readonly signals: ConversationSignals;
  /** Sujets d'objection lus sur les tours entrants ANTÉRIEURS. */
  readonly priorObjectionTopics: readonly ObjectionTopic[];
  /** Sujets de question lus sur les tours entrants ANTÉRIEURS. */
  readonly priorQuestionTopics: readonly QuestionTopic[];
}

/**
 * Choisit l'objectif du tour à venir.
 *
 * L'ordre des tests est la politique elle-même, et il se lit de haut en bas :
 * une conversation qu'un humain doit reprendre n'a pas d'objectif commercial ;
 * un refus se referme, il ne se négocie pas ; une question précise passe avant
 * une proposition d'appel — répondre à côté pour « avancer » est la faute la
 * plus fréquente d'un agent commercial, humain comme machine.
 */
function resolveGoal(input: DeriveStateInput, humanNeeded: boolean): ConversationGoal {
  if (humanNeeded) return 'AWAIT_HUMAN';

  const { category, signals, thread } = input;
  if (category === 'UNSUBSCRIBE' || category === 'NOT_INTERESTED') return 'ACKNOWLEDGE_AND_CLOSE';
  if (category === 'NOT_NOW') return 'ACKNOWLEDGE_AND_CLOSE';
  if (category === 'OBJECTION' || signals.objectionTopic !== 'NONE') return 'HANDLE_OBJECTION';
  if (signals.explicitCallRequest) return 'PROPOSE_CALL';
  if (signals.questionTopic !== 'NONE') return 'ANSWER_QUESTION';
  if (signals.callReadiness === 'HIGH') return 'PROPOSE_CALL';
  if (thread.priorInboundCount >= 1) return 'QUALIFY_LIGHTLY';
  return 'UNDERSTAND_NEED';
}

function resolveQualification(input: DeriveStateInput): QualificationState {
  const { category, thread } = input;
  if (category === 'UNSUBSCRIBE' || category === 'NOT_INTERESTED') return 'DISQUALIFIED';
  if (thread.priorInboundCount >= 1) return 'QUALIFYING';
  if (category === 'INTERESTED' || category === 'QUESTION' || category === 'OBJECTION') return 'ENGAGED';
  return 'NOT_STARTED';
}

/**
 * Construit l'état. Fonction pure : mêmes entrées, même état.
 */
export function deriveConversationState(input: DeriveStateInput): ConversationState {
  const { thread, signals, category } = input;

  const inbound = thread.inboundTurns;
  const outbound = thread.outboundTurns;
  // HERMES-SEMANTIC-GROUNDING-R1 — ce qui a été COUVERT se mesure sur ce que la
  // personne a REÇU.
  //
  // `coveredTopics` alimente `PITCH_REPEATED` (« tu réexpliques ce que le fil a
  // déjà couvert ») et `CTA_TOO_EARLY` (« un échange a déjà été proposé »). Les
  // deux sont des affirmations sur ce que le prospect a LU. Un brouillon validé
  // par un humain dans `r6b_reply_drafts` n'a jamais quitté la base — le schéma
  // R6B-D2 l'écrit, « TOUJOURS PAS ENVOYÉ » — et le compter fabriquerait une
  // histoire conversationnelle qui n'a pas eu lieu, puis mettrait en silence un
  // tour parfaitement neuf pour la personne d'en face.
  //
  // `lastOutboundAt` et `outboundTurnCount` ne bougent PAS : ils décrivent
  // notre activité, pas ce qu'elle a lu, et ce round ne leur demande rien.
  const exposed = thread.exposedOutboundTurns;

  // Un humain est nécessaire quand la machine n'a pas de lecture sûre, ou quand
  // le sujet n'est plus commercial. `REVIEW_REQUIRED` et `OTHER` sont déjà des
  // aveux d'incertitude côté D2 : les reprendre ici évite d'inventer une
  // seconde politique de doute.
  const humanNeeded =
    signals.sensitiveFlags.length > 0 || category === 'REVIEW_REQUIRED' || category === 'OTHER';

  const policy = CATEGORY_POLICY[category];

  const objections = [...input.priorObjectionTopics];
  if (signals.objectionTopic !== 'NONE') objections.push(signals.objectionTopic);

  const questions = [...input.priorQuestionTopics];
  if (signals.questionTopic !== 'NONE') questions.push(signals.questionTopic);

  return Object.freeze({
    prospectId: thread.prospectId,
    counterparty: input.counterparty,
    channel: thread.channel,

    lastInboundAt: inbound.length > 0 ? (inbound[inbound.length - 1]?.at ?? null) : null,
    lastOutboundAt: outbound.length > 0 ? (outbound[outbound.length - 1]?.at ?? null) : null,
    inboundTurnCount: inbound.length,
    outboundTurnCount: outbound.length,
    isFirstReply: thread.priorInboundCount === 0,

    goal: resolveGoal(input, humanNeeded),
    qualification: resolveQualification(input),

    coveredTopics: Object.freeze(coveredIn(exposed)),
    questionsAskedByUs: countQuestions(exposed),
    questionTopicsReceived: Object.freeze(questions),
    objectionsEncountered: Object.freeze(objections),

    nextAction: humanNeeded ? 'HUMAN_REVIEW' : policy.action,
    // Une relance n'a plus de sens dès que la conséquence de la catégorie est
    // de réduire le contact. `freezesNoReplySequence` dit autre chose (« cette
    // personne a répondu, donc la séquence sans réponse s'arrête ») — les deux
    // se ressemblent et ne se confondent pas.
    followUpStillRelevant: policy.suppression === 'none' && category !== 'NOT_INTERESTED',
    humanNeeded,
  });
}

/** Rend l'état sous la forme que le modèle lit. */
export function renderStateBlock(state: ConversationState): string {
  const covered = state.coveredTopics.length > 0 ? state.coveredTopics.join(', ') : 'rien encore';
  const objections = state.objectionsEncountered.length > 0 ? state.objectionsEncountered.join(', ') : 'aucune';
  const questions =
    state.questionTopicsReceived.length > 0 ? state.questionTopicsReceived.join(', ') : 'aucune';

  return [
    'ÉTAT DE LA CONVERSATION',
    `- tours reçus d'eux : ${state.inboundTurnCount} (premier échange : ${state.isFirstReply ? 'oui' : 'non'})`,
    `- tours envoyés par nous : ${state.outboundTurnCount}`,
    `- objectif de CE tour : ${state.goal}`,
    `- qualification : ${state.qualification}`,
    `- déjà couvert par nous : ${covered}`,
    `- questions déjà posées par nous : ${state.questionsAskedByUs}`,
    `- sujets de question reçus : ${questions}`,
    `- objections rencontrées : ${objections}`,
  ].join('\n');
}
