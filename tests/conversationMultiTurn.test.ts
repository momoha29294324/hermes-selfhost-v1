import { describe, expect, it } from 'vitest';
import {
  BURST_GAP_MS,
  burstContaining,
  burstSettled,
  burstText,
  closesBurst,
  groupInboundBursts,
} from '@/lib/conversation/burst';
import { checkNaturalness } from '@/lib/conversation/naturalness';
import {
  assessOfferProgression,
  COMMERCIAL_POLICY_STATUS,
  performanceModelAllowed,
} from '@/lib/conversation/offerProgression';
import { readSignals } from '@/lib/conversation/signals';
import { deriveConversationState } from '@/lib/conversation/state';
import { buildStyleProfile } from '@/lib/conversation/style';
import type { ConversationThread, ConversationTurn } from '@/lib/conversation/thread';
import { buildLearningInjection, learningInjectionEnabled } from '@/lib/learning/injection';
import type { ReplyCategory } from '@/lib/replies/taxonomy';

/**
 * HERMES-CONVERSATION-R2 §36 — plusieurs tours, une seule conversation.
 *
 * Tout est pur : les salves, l'état, la naturalité, le palier commercial. Ce
 * fichier n'ouvre aucune base et n'appelle aucun modèle — ce qu'il vérifie est
 * ce qui GOUVERNE la conversation, pas la prose qui en sort.
 *
 * Les messages entrants reproduits ici sont ceux, réels, de deux conversations
 * du 21 août 2026 : ils sont exactement le cas que la mission demande de tenir
 * (« oui » / « je fais déjà de la pub » / « mais ça marche moyen » → UNE
 * réponse). Aucune identité n'y figure.
 */

const T0 = Date.parse('2026-08-21T13:13:00.000Z');

function turn(
  offsetMs: number,
  text: string,
  direction: 'INBOUND' | 'OUTBOUND' = 'INBOUND',
  classification: ReplyCategory | null = null,
): ConversationTurn {
  return Object.freeze({
    direction,
    provenance: direction === 'INBOUND' ? ('inbound_message' as const) : ('sent_first_touch' as const),
    at: new Date(T0 + offsetMs).toISOString(),
    text,
    sourceId: `turn-${String(offsetMs)}`,
    classification,
    exposed: true,
  });
}

function thread(turns: readonly ConversationTurn[], currentId: string): ConversationThread {
  const inbound = turns.filter((entry) => entry.direction === 'INBOUND');
  const currentIndex = turns.findIndex((entry) => entry.sourceId === currentId);
  return Object.freeze({
    prospectId: 'p1',
    turns: Object.freeze([...turns]),
    inboundTurns: Object.freeze(inbound),
    outboundTurns: Object.freeze(turns.filter((entry) => entry.direction === 'OUTBOUND')),
    exposedOutboundTurns: Object.freeze(
      turns.filter((entry) => entry.direction === 'OUTBOUND' && entry.exposed),
    ),
    currentInboundId: currentId,
    priorInboundCount:
      currentIndex < 0
        ? inbound.length
        : turns.slice(0, currentIndex).filter((entry) => entry.direction === 'INBOUND').length,
    channel: 'instagram_dm',
    truncated: false,
  });
}

describe('HERMES-CONVERSATION-R2 §36 — multi-tour', () => {
  // -------------------------------------------------------------------------
  // §36.37 / §23 — la salve
  // -------------------------------------------------------------------------

  it('§36.37 — trois bulles d’affilée forment UNE salve, donc UNE réponse', () => {
    const turns = [
      turn(0, 'oui'),
      turn(4_000, 'je fais déjà de la pub'),
      turn(11_000, 'mais ça marche moyen'),
    ];
    const bursts = groupInboundBursts(turns);
    expect(bursts).toHaveLength(1);
    expect(bursts[0]?.turns).toHaveLength(3);
    expect(closesBurst(bursts[0]!, 'turn-11000')).toBe(true);
    expect(closesBurst(bursts[0]!, 'turn-4000')).toBe(false);
    expect(burstText(bursts[0]!)).toBe('oui\nje fais déjà de la pub\nmais ça marche moyen');
  });

  it('§36.37 bis — un retour après un long silence est une SECONDE salve', () => {
    const turns = [turn(0, 'oui'), turn(BURST_GAP_MS + 1_000, 'finalement je suis intéressé')];
    expect(groupInboundBursts(turns)).toHaveLength(2);
  });

  it('§23 — tant que le silence n’est pas établi, on ne répond pas', () => {
    const turns = [turn(0, 'oui'), turn(4_000, 'je fais déjà de la pub')];
    const burst = burstContaining(turns, 'turn-4000');
    expect(burst).not.toBeNull();
    // Une minute après la dernière bulle : la personne tape peut-être encore.
    expect(burstSettled(burst!, new Date(T0 + 64_000), 300_000)).toBe(false);
    // Six minutes après : la prise de parole est finie.
    expect(burstSettled(burst!, new Date(T0 + 364_000), 300_000)).toBe(true);
  });

  /**
   * HERMES-MULTI-TURN-BURSTS-R1 — ce test disait l'inverse, et il disait VRAI à
   * sa date. Il est REMPLACÉ, pas amendé.
   *
   * Sa prémisse était écrite dans `burst.ts` : « deux bulles reçues à deux
   * secondes d'intervalle sont une seule prise de parole, que nous ayons ou non
   * écrit entre les deux (nous ne pouvons pas : l'intervalle est de deux
   * secondes) ». Elle a cessé d'être vraie le jour où Hermes a répondu seul :
   * l'espacement minimal de la coquille est à ZÉRO, et le rail autonome écrit
   * en quelques secondes. Un message reçu APRÈS notre réponse répond à cette
   * réponse ; le coller à ce qui la précédait fabrique une prise de parole qui
   * n'a jamais eu lieu, et fait relire une question déjà traitée.
   */
  it('§23 bis — un tour sortant EXPOSÉ coupe la salve : ce qui suit répond à ce que nous avons dit', () => {
    const turns = [
      turn(0, 'oui'),
      turn(1_000, 'question de notre côté ?', 'OUTBOUND'),
      turn(4_000, 'je fais déjà de la pub'),
    ];
    const bursts = groupInboundBursts(turns);
    expect(bursts).toHaveLength(2);
    expect(bursts[0]?.messageIds).toEqual(['turn-0']);
    expect(bursts[1]?.messageIds).toEqual(['turn-4000']);
  });

  it('§23 bis (suite) — un brouillon JAMAIS REMIS ne coupe rien : il n’a interrompu personne', () => {
    const neverSent: ConversationTurn = Object.freeze({
      direction: 'OUTBOUND' as const,
      provenance: 'human_approved_reply' as const,
      at: new Date(T0 + 1_000).toISOString(),
      text: 'texte validé, jamais envoyé',
      sourceId: 'draft-1',
      classification: null,
      // Le schéma R6B-D2 l'écrit en toutes lettres : « TOUJOURS PAS ENVOYÉ ».
      exposed: false,
    });
    const turns = [turn(0, 'oui'), neverSent, turn(4_000, 'je fais déjà de la pub')];
    const bursts = groupInboundBursts(turns);
    expect(bursts).toHaveLength(1);
    expect(bursts[0]?.messageIds).toEqual(['turn-0', 'turn-4000']);
  });

  it('§23 ter — un horodatage illisible ne coupe pas la salve : « je ne sais pas » n’est pas « elle est revenue »', () => {
    const broken: ConversationTurn = Object.freeze({
      direction: 'INBOUND' as const,
      provenance: 'inbound_message' as const,
      at: 'pas-une-date',
      text: 'et sinon ?',
      sourceId: 'turn-broken',
      exposed: true,
      classification: null,
    });
    expect(groupInboundBursts([turn(0, 'oui'), broken])).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // §36.38 / §36.39 — le contexte des tours précédents
  // -------------------------------------------------------------------------

  it('§36.38/§36.39 — une objection au troisième tour garde la question du premier', () => {
    const turns = [
      turn(-600_000, 'Comment ça marche concrètement ?', 'INBOUND', 'QUESTION'),
      turn(-300_000, 'ok', 'INBOUND', 'REVIEW_REQUIRED'),
      turn(0, 'je fais déjà de la pub et j’ai pas le budget', 'INBOUND', 'OBJECTION'),
    ];
    const current = turns[2]!;
    const th = thread(turns, current.sourceId);
    const signals = readSignals(current.text, 'OBJECTION', th);

    const state = deriveConversationState({
      thread: th,
      counterparty: 'Atelier Fictif',
      category: 'OBJECTION',
      signals,
      priorObjectionTopics: [],
      priorQuestionTopics: ['HOW_IT_WORKS'],
    });

    // La question du premier tour reste au dossier…
    expect(state.questionTopicsReceived).toContain('HOW_IT_WORKS');
    // …et l'objection du troisième s'y ajoute, sans l'effacer.
    expect(state.objectionsEncountered.length).toBeGreaterThan(0);
    expect(state.goal).toBe('HANDLE_OBJECTION');
    expect(state.inboundTurnCount).toBe(3);
    expect(state.isFirstReply).toBe(false);
  });

  // -------------------------------------------------------------------------
  // §36.40 — le pitch ne se répète pas
  // -------------------------------------------------------------------------

  it('§36.40 — réexpliquer l’offre déjà expliquée est BLOQUANT', () => {
    const turns = [turn(0, 'ah d’accord', 'INBOUND', 'INTERESTED')];
    const th = thread(turns, 'turn-0');
    const signals = readSignals('ah d’accord', 'INTERESTED', th);
    const state = deriveConversationState({
      thread: th,
      counterparty: 'Atelier Fictif',
      category: 'INTERESTED',
      signals,
      priorObjectionTopics: [],
      priorQuestionTopics: [],
    });

    const report = checkNaturalness({
      body: 'On aide des ateliers comme le vôtre à avoir plus de demandes.',
      lastInboundText: 'ah d’accord',
      style: buildStyleProfile([{ text: 'ah d’accord', at: new Date(T0).toISOString() }]),
      state: Object.freeze({ ...state, coveredTopics: Object.freeze(['OFFER_EXPLAINED' as const]) }),
      signals,
      channel: 'instagram_dm',
      previousOutboundTexts: ['On aide des ateliers à avoir plus de demandes régulièrement.'],
    });

    expect(report.findings.map((finding) => finding.code)).toContain('PITCH_REPEATED');
    expect(report.verdict).toBe('UNNATURAL');
  });

  // -------------------------------------------------------------------------
  // §36.41 — l'appel n'est pas proposé trop tôt
  // -------------------------------------------------------------------------

  it('§36.41 — « oui pourquoi pas » au premier tour ne vaut pas une proposition d’échange', () => {
    const turns = [turn(0, 'oui pourquoi pas', 'INBOUND', 'INTERESTED')];
    const th = thread(turns, 'turn-0');
    const signals = readSignals('oui pourquoi pas', 'INTERESTED', th);

    // §17 de R1.1 : avoir répondu n'est pas un signal. Un « pourquoi pas » au
    // premier échange plafonne à MEDIUM.
    expect(signals.callReadiness).toBe('MEDIUM');

    const state = deriveConversationState({
      thread: th,
      counterparty: 'Atelier Fictif',
      category: 'INTERESTED',
      signals,
      priorObjectionTopics: [],
      priorQuestionTopics: [],
    });
    const progression = assessOfferProgression({ category: 'INTERESTED', signals, state });
    expect(progression.stage).not.toBe('PROPOSE_CALL');
  });

  it('§36.41 bis — une demande explicite d’échange mène directement au palier PROPOSE_CALL', () => {
    const turns = [turn(0, 'on peut s’appeler cette semaine ?', 'INBOUND', 'INTERESTED')];
    const th = thread(turns, 'turn-0');
    const signals = readSignals('on peut s’appeler cette semaine ?', 'INTERESTED', th);
    expect(signals.explicitCallRequest).toBe(true);
    expect(signals.callReadiness).toBe('HIGH');

    const state = deriveConversationState({
      thread: th,
      counterparty: 'Atelier Fictif',
      category: 'INTERESTED',
      signals,
      priorObjectionTopics: [],
      priorQuestionTopics: [],
    });
    expect(assessOfferProgression({ category: 'INTERESTED', signals, state }).stage).toBe('PROPOSE_CALL');
  });

  // -------------------------------------------------------------------------
  // §36.42 / §36.43 — l'offre et ses conditions
  // -------------------------------------------------------------------------

  it('§36.42 — une maturité LOW interdit toute mention d’un modèle à la performance', () => {
    const turns = [turn(0, 'bonjour', 'INBOUND', 'REVIEW_REQUIRED')];
    const th = thread(turns, 'turn-0');
    const signals = readSignals('bonjour', 'REVIEW_REQUIRED', th);
    const state = deriveConversationState({
      thread: th,
      counterparty: 'Atelier Fictif',
      category: 'REVIEW_REQUIRED',
      signals,
      priorObjectionTopics: [],
      priorQuestionTopics: [],
    });
    const progression = assessOfferProgression({ category: 'REVIEW_REQUIRED', signals, state });
    expect(progression.readiness).toBe('LOW');
    expect(progression.performanceModelMentionAllowed).toBe(false);
    expect(performanceModelAllowed(progression)).toBe(false);
  });

  it('§36.43 — une maturité HIGH n’invente toujours aucune condition commerciale', () => {
    const turns = [turn(0, 'c’est combien ?', 'INBOUND', 'QUESTION')];
    const th = thread(turns, 'turn-0');
    const signals = readSignals('c’est combien ?', 'QUESTION', th);
    const state = deriveConversationState({
      thread: th,
      counterparty: 'Atelier Fictif',
      category: 'QUESTION',
      signals,
      priorObjectionTopics: [],
      priorQuestionTopics: [],
    });
    const progression = assessOfferProgression({ category: 'QUESTION', signals, state });

    expect(progression.readiness).toBe('HIGH');
    expect(progression.stage).toBe('EXPLAIN_MODEL');
    expect(progression.needsCommercialPolicy).toBe(true);
    expect(progression.commercialPolicy).toBe(COMMERCIAL_POLICY_STATUS);
    expect(progression.performanceModelMentionAllowed).toBe(false);
    expect(progression.pricingAnswerable).toBe(false);
  });

  it('§9 — l’échelle ne se déroule pas au compteur : un besoin non exprimé reste au premier palier', () => {
    const turns = [turn(0, 'ok merci', 'INBOUND', 'REVIEW_REQUIRED')];
    const th = thread(turns, 'turn-0');
    const signals = readSignals('ok merci', 'REVIEW_REQUIRED', th);
    const state = deriveConversationState({
      thread: th,
      counterparty: 'Atelier Fictif',
      category: 'REVIEW_REQUIRED',
      signals,
      priorObjectionTopics: [],
      priorQuestionTopics: [],
    });
    // `REVIEW_REQUIRED` réclame un humain : le palier est HOLD, pas un pitch.
    expect(assessOfferProgression({ category: 'REVIEW_REQUIRED', signals, state }).stage).toBe('HOLD');
  });

  it('une objection nomme un besoin : le palier monte d’un cran, sans aller jusqu’au pitch', () => {
    const turns = [turn(0, 'j’ai déjà une agence', 'INBOUND', 'OBJECTION')];
    const th = thread(turns, 'turn-0');
    const signals = readSignals('j’ai déjà une agence', 'OBJECTION', th);
    const state = deriveConversationState({
      thread: th,
      counterparty: 'Atelier Fictif',
      category: 'OBJECTION',
      signals,
      priorObjectionTopics: [],
      priorQuestionTopics: [],
    });
    const progression = assessOfferProgression({ category: 'OBJECTION', signals, state });
    expect(progression.readiness).toBe('MEDIUM');
    expect(progression.stage).toBe('EXPLORE_NEED');
  });

  // -------------------------------------------------------------------------
  // §36.46 / §27 — l'apprentissage reste ÉTEINT
  // -------------------------------------------------------------------------

  it('§27/§36.46 — l’injection d’apprentissage reste éteinte par défaut', () => {
    expect(learningInjectionEnabled()).toBe(false);
  });

  it('§27 bis — éteinte, l’injection ne rend RIEN : le prompt est celui d’avant, au caractère près', () => {
    const injection = buildLearningInjection({
      enabled: false,
      style: {} as never,
      exemplars: [],
      offerReadiness: 'HIGH',
    });
    expect(injection).toBeNull();
  });
});
