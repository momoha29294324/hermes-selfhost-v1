/**
 * HERMES-SEMANTIC-GROUNDING-R1 — ce qu'une garde a le droit de coûter.
 *
 * Ce fichier éprouve UNE frontière : celle entre « ce message ne partirait pas
 * tel quel » (une mesure de qualité) et « il vaut mieux se taire » (une
 * décision). Les deux se confondaient, et c'est ce qui mettait en silence des
 * tours commercialement justes.
 *
 * Il éprouve aussi son revers, qui compte davantage : **aucune violation de
 * sécurité n'est devenue réparable**. Les trois portes qui refusent pour de
 * vrai — garde-fous de contenu, promesse de rémunération, essai décrit à
 * moitié — sont rejouées ici une par une.
 *
 * Aucun modèle, aucune base : tout est pur.
 */

import { describe, expect, it } from 'vitest';

import {
  decideAutonomousReply,
  CONVERSATION_POLICY_VERSION,
  type AutonomousDraftFacts,
  type AutonomousReplyFacts,
} from '@/lib/conversation/autonomy';
import { COMMERCIAL_POLICY_VERSION } from '@/lib/conversation/commercialPolicy';
import { decideReply } from '@/lib/conversation/decision';
import {
  NATURALNESS_CLASS,
  naturalnessSendGate,
  type NaturalnessCode,
  type NaturalnessFinding,
  type NaturalnessReport,
} from '@/lib/conversation/naturalness';
import { assessOfferProgression } from '@/lib/conversation/offerProgression';
import type { ConversationSignals } from '@/lib/conversation/signals';
import type { ConversationState } from '@/lib/conversation/state';

// ---------------------------------------------------------------------------
// Outillage — un tour PARFAIT, dont on ne change qu'une chose à la fois
// ---------------------------------------------------------------------------

const SIGNALS: ConversationSignals = Object.freeze({
  questionTopic: 'HOW_IT_WORKS',
  objectionTopic: 'NONE',
  buyingSignal: 'WEAK',
  callReadiness: 'MEDIUM',
  sensitiveFlags: Object.freeze([]),
  explicitCallRequest: false,
  tooShortToRead: false,
});

const STATE: ConversationState = Object.freeze({
  prospectId: 'p1',
  counterparty: 'Atelier Fictif',
  channel: 'instagram_dm' as const,
  lastInboundAt: null,
  lastOutboundAt: null,
  inboundTurnCount: 2,
  outboundTurnCount: 1,
  isFirstReply: false,
  goal: 'ANSWER_QUESTION' as const,
  qualification: 'QUALIFYING' as const,
  coveredTopics: Object.freeze([]),
  questionsAskedByUs: 1,
  questionTopicsReceived: Object.freeze([]),
  objectionsEncountered: Object.freeze([]),
  nextAction: 'HUMAN_REPLY_NOW' as const,
  followUpStillRelevant: true,
  humanNeeded: false,
});

const CLEAN_DRAFT: AutonomousDraftFacts = Object.freeze({
  bodySha256: 'a'.repeat(64),
  guardrailBlocked: false,
  naturalnessVerdict: 'NATURAL' as const,
  naturalnessBlockingCodes: Object.freeze([]),
  naturalnessWarningCodes: Object.freeze([]),
  questions: 1,
  proposesCall: false,
  containsPitch: false,
  performanceClaims: Object.freeze([]),
  trialStatementCodes: Object.freeze([]),
});

function facts(draft: Partial<AutonomousDraftFacts> = {}): AutonomousReplyFacts {
  const offer = assessOfferProgression({
    category: 'QUESTION',
    signals: SIGNALS,
    state: STATE,
    priceSubject: null,
  });
  return Object.freeze({
    policyVersion: CONVERSATION_POLICY_VERSION,
    commercialPolicyVersion: COMMERCIAL_POLICY_VERSION,
    correlation: 'EXACT' as const,
    identityConfirmed: true,
    suppressed: false,
    outreachState: 'REPLIED' as const,
    terminalCategoryInThread: null,
    category: 'QUESTION' as const,
    confidence: 0.99,
    signals: SIGNALS,
    state: STATE,
    decision: decideReply({
      category: 'QUESTION',
      signals: SIGNALS,
      state: STATE,
      groundingGaps: [],
      confidence: 0.99,
    }),
    groundingGaps: Object.freeze([]),
    offer,
    newerInboundExists: false,
    burstSettled: true,
    commercialDemands: Object.freeze([]),
    appointmentQualification: 'POTENTIALLY_QUALIFIED' as const,
    draft: Object.freeze({ ...CLEAN_DRAFT, ...draft }),
    minConfidence: 0.85,
  });
}

function report(...findings: readonly (readonly [NaturalnessCode, 'BLOCKING' | 'WARNING'])[]): NaturalnessReport {
  const built: NaturalnessFinding[] = findings.map(([code, severity]) =>
    Object.freeze({ code, severity, message: code, excerpt: null }),
  );
  return Object.freeze({
    verdict: built.some((finding) => finding.severity === 'BLOCKING') ? 'UNNATURAL' : 'ACCEPTABLE',
    findings: Object.freeze(built),
    metrics: Object.freeze({
      chars: 100,
      words: 20,
      sentences: 1,
      questions: 1,
      emojis: 0,
      exclamations: 0,
    }),
    budget: Object.freeze({ band: 'SHORT' as const, maxChars: 220, maxSentences: 2, inboundChars: 60 }),
    rebound: 'ANCHOR' as const,
    anchors: Object.freeze([]),
  });
}

// ---------------------------------------------------------------------------

const ALL_CODES: readonly NaturalnessCode[] = Object.freeze([
  'TOO_LONG',
  'TOO_MANY_SENTENCES',
  'MULTIPLE_QUESTIONS',
  'GENERIC_OPENING',
  'OPENING_ALREADY_USED',
  'TEMPLATE_REPEATED',
  'CORPORATE_JARGON',
  'PITCH_REPEATED',
  'CTA_TOO_EARLY',
  'EMOJI_INFLATION',
  'ADDRESS_MODE_MISMATCH',
  'TEXTISM_OR_TYPO',
  'FORCED_SLANG',
  'TOO_MANY_INTENTS',
  'NO_CONCRETE_REBOUND',
  'QUESTION_WITHOUT_ANSWER',
]);

describe('la classification des constats de naturalité', () => {
  it('chaque constat porte une classe — aucun ne l’obtient par défaut', () => {
    for (const code of ALL_CODES) {
      expect(NATURALNESS_CLASS[code], code).toMatch(/^(POLICY|REPAIRABLE)$/u);
    }
    expect(Object.keys(NATURALNESS_CLASS).sort()).toEqual([...ALL_CODES].sort());
  });

  it('les quatre règles ÉCRITES ailleurs sont POLICY, et elles seules', () => {
    const policy = ALL_CODES.filter((code) => NATURALNESS_CLASS[code] === 'POLICY');
    expect([...policy].sort()).toEqual(
      ['CORPORATE_JARGON', 'CTA_TOO_EARLY', 'MULTIPLE_QUESTIONS', 'QUESTION_WITHOUT_ANSWER'].sort(),
    );
  });

  it('un constat POLICY bloquant reste bloquant', () => {
    const gate = naturalnessSendGate(report(['MULTIPLE_QUESTIONS', 'BLOCKING']));
    expect(gate.blocking).toEqual(['MULTIPLE_QUESTIONS']);
    expect(gate.warnings).toEqual([]);
  });

  it('un constat RÉPARABLE bloquant devient un avertissement', () => {
    const gate = naturalnessSendGate(report(['TEMPLATE_REPEATED', 'BLOCKING']));
    expect(gate.blocking).toEqual([]);
    expect(gate.warnings).toEqual(['TEMPLATE_REPEATED']);
  });

  it('un POLICY et un RÉPARABLE ensemble : seul le premier refuse', () => {
    const gate = naturalnessSendGate(
      report(['TOO_LONG', 'BLOCKING'], ['CTA_TOO_EARLY', 'BLOCKING'], ['NO_CONCRETE_REBOUND', 'WARNING']),
    );
    expect(gate.blocking).toEqual(['CTA_TOO_EARLY']);
    expect([...gate.warnings].sort()).toEqual(['NO_CONCRETE_REBOUND', 'TOO_LONG']);
  });
});

describe('la porte de naturalité, côté décision', () => {
  it('un tour dont le seul défaut est réparable PART', () => {
    const decision = decideAutonomousReply(
      facts({
        naturalnessVerdict: 'UNNATURAL',
        naturalnessBlockingCodes: naturalnessSendGate(report(['OPENING_ALREADY_USED', 'BLOCKING'])).blocking,
        naturalnessWarningCodes: naturalnessSendGate(report(['OPENING_ALREADY_USED', 'BLOCKING'])).warnings,
      }),
    );
    expect(decision.outcome).toBe('AUTO_REPLY_ELIGIBLE');
  });

  it('un tour qui porte une règle écrite ailleurs NE PART PAS', () => {
    const gate = naturalnessSendGate(report(['QUESTION_WITHOUT_ANSWER', 'BLOCKING']));
    const decision = decideAutonomousReply(
      facts({
        naturalnessVerdict: 'UNNATURAL',
        naturalnessBlockingCodes: gate.blocking,
        naturalnessWarningCodes: gate.warnings,
      }),
    );
    expect(decision.outcome).toBe('AUTO_REPLY_SKIP');
    expect(decision.reason).toBe('naturalness_blocking');
    expect(decision.detail).toContain('QUESTION_WITHOUT_ANSWER');
  });

  it('le VERDICT seul ne refuse plus rien — c’est le constat qui décide', () => {
    const decision = decideAutonomousReply(
      facts({ naturalnessVerdict: 'UNNATURAL', naturalnessBlockingCodes: Object.freeze([]) }),
    );
    expect(decision.outcome).toBe('AUTO_REPLY_ELIGIBLE');
  });
});

describe('AUCUNE sécurité n’est devenue réparable', () => {
  it('un garde-fou de contenu refuse toujours', () => {
    const decision = decideAutonomousReply(facts({ guardrailBlocked: true }));
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(decision.reason).toBe('guardrail_blocked');
    expect(decision.reconsiderable).toBe(false);
  });

  it('une promesse de rémunération refuse toujours', () => {
    const decision = decideAutonomousReply(
      facts({ performanceClaims: Object.freeze(['vous ne payez que si ça marche']) }),
    );
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(decision.reason).toBe('performance_claim');
  });

  it('un essai décrit à moitié refuse toujours', () => {
    const decision = decideAutonomousReply(
      facts({ trialStatementCodes: Object.freeze(['TRIAL_AD_SPEND_OMITTED']) }),
    );
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(decision.reason).toBe('trial_misstated');
  });

  it('deux questions restent deux questions — la porte dédiée n’a pas bougé', () => {
    const decision = decideAutonomousReply(facts({ questions: 2 }));
    expect(decision.outcome).toBe('AUTO_REPLY_SKIP');
    expect(decision.reason).toBe('multiple_questions');
  });

  it('un appel proposé trop tôt refuse toujours, par sa porte propre', () => {
    const decision = decideAutonomousReply(facts({ proposesCall: true }));
    expect(decision.outcome).toBe('AUTO_REPLY_SKIP');
    expect(decision.reason).toBe('call_too_early');
  });

  it('les trois portes de sécurité passent AVANT la naturalité', () => {
    // Un brouillon qui cumule un garde-fou bloquant ET un défaut réparable
    // n'est pas « réparable » : c'est la sécurité qui répond.
    const gate = naturalnessSendGate(report(['TOO_LONG', 'BLOCKING']));
    const decision = decideAutonomousReply(
      facts({
        guardrailBlocked: true,
        naturalnessBlockingCodes: gate.blocking,
        naturalnessWarningCodes: gate.warnings,
      }),
    );
    expect(decision.reason).toBe('guardrail_blocked');
  });
});
