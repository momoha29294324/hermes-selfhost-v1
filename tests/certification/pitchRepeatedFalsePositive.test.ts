/**
 * PITCH_REPEATED-FALSE-POSITIVE-R1 — non-régression, dans le harness de
 * certification.
 *
 * L'incident réel, daté du 23 août 2026 à 17:03:45.122Z : le prospect écrit
 * « J'avais des leads mais c'était surtout des curieux personne n'achetait »,
 * D2 comprend correctement (`INFORMATION_SHARED`, 0.99) et le rédacteur
 * produit une question de diagnostic — « Tu faisais la pub sur quelle
 * prestation à l'époque ? ». Le contrôle de naturalité (`naturalness.ts`)
 * confondait alors une QUESTION contenant le mot « pub » avec une AFFIRMATION
 * réexpliquant l'offre, et bloquait le tour en `PITCH_REPEATED`
 * (plan `00000000-0000-4000-8000-000000000010`, `CANCELLED`, sans effet
 * tenté — il reste tel quel, historique, jamais ressuscité par ce fichier).
 *
 * Ce fichier prouve deux choses, ensemble, comme la mission l'exige :
 *
 *   1. FALSE_POSITIVE_FIXED — une question de qualification qui partage du
 *      vocabulaire avec le lexique d'offre n'est plus un pitch ;
 *   2. TRUE_POSITIVE_PRESERVED — un vrai pitch réaffirmé, presque mot pour
 *      mot, reste détecté comme une répétition.
 *
 * Aucun modèle n'est appelé : `checkNaturalness` est une fonction pure, ce qui
 * rend ce scénario rejouable à l'identique, comme le reste de cette matrice.
 */

import { describe, expect, it } from 'vitest';
import { checkNaturalness, type NaturalnessInput } from '@/lib/conversation/naturalness';
import { buildStyleProfile } from '@/lib/conversation/style';
import type { ConversationSignals } from '@/lib/conversation/signals';
import type { ConversationState, CoveredTopic } from '@/lib/conversation/state';

const REAL_INBOUND = 'J’avais des leads mais c’était surtout des curieux personne n’achetait';

const SIGNALS: ConversationSignals = Object.freeze({
  questionTopic: 'NONE',
  objectionTopic: 'NONE',
  buyingSignal: 'WEAK',
  callReadiness: 'LOW',
  sensitiveFlags: Object.freeze([]),
  explicitCallRequest: false,
  tooShortToRead: false,
});

/** Un fil où l'offre a déjà été présentée — l'état exact sous lequel le faux positif s'est produit. */
const STATE_OFFER_ALREADY_COVERED: ConversationState = Object.freeze({
  prospectId: 'certif-pitch-repeated',
  counterparty: 'Prospect certification',
  channel: 'instagram_dm',
  lastInboundAt: null,
  lastOutboundAt: null,
  inboundTurnCount: 2,
  outboundTurnCount: 2,
  isFirstReply: false,
  goal: 'QUALIFY_LIGHTLY',
  qualification: 'QUALIFYING',
  coveredTopics: Object.freeze<CoveredTopic[]>(['OFFER_EXPLAINED']),
  questionsAskedByUs: 1,
  questionTopicsReceived: Object.freeze([]),
  objectionsEncountered: Object.freeze([]),
  nextAction: 'HUMAN_REPLY_NOW',
  followUpStillRelevant: true,
  humanNeeded: false,
});

function input(body: string): NaturalnessInput {
  return {
    body,
    lastInboundText: REAL_INBOUND,
    style: buildStyleProfile([{ text: REAL_INBOUND, at: '2026-08-23T17:03:45.122Z' }]),
    state: STATE_OFFER_ALREADY_COVERED,
    signals: SIGNALS,
    channel: 'instagram_dm',
    previousOutboundTexts: Object.freeze([]),
  };
}

describe('PITCH_REPEATED-FALSE-POSITIVE-R1 — le vrai tour du 23 août 2026', () => {
  it('FALSE_POSITIVE_FIXED — la question de diagnostic réelle n’est plus un pitch répété', () => {
    const report = checkNaturalness(input('Tu faisais la pub sur quelle prestation à l’époque ?'));
    const codes = report.findings.map((finding) => finding.code);
    expect(codes).not.toContain('PITCH_REPEATED');
  });

  it('TRUE_POSITIVE_PRESERVED — un pitch réellement réaffirmé reste bloquant', () => {
    const report = checkNaturalness(
      input('Je mets en place des pubs Facebook et Instagram ciblées dans ta zone.'),
    );
    const finding = report.findings.find((f) => f.code === 'PITCH_REPEATED');
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('BLOCKING');
    expect(report.verdict).toBe('UNNATURAL');
  });
});
