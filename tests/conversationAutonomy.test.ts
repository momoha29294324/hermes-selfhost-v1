import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_POLICY_VERSION,
  CONVERSATION_WINDOW_POLICY,
  decideAutonomousReply,
  formatAutonomousReplyDecision,
  isAutoReplyEligible,
  isTerminalReplyDecision,
  terminalCategoryIn,
  type AutonomousDraftFacts,
  type AutonomousReplyFacts,
} from '@/lib/conversation/autonomy';
import {
  COMMERCIAL_POLICY_VERSION,
  type CommercialDemandFinding,
} from '@/lib/conversation/commercialPolicy';
import { decideReply } from '@/lib/conversation/decision';
import type { AppointmentQualification } from '@/lib/sales/objective';
import type { GroundingGap } from '@/lib/conversation/grounding';
import { assessOfferProgression, COMMERCIAL_POLICY_STATUS } from '@/lib/conversation/offerProgression';
import { classifyProfileContention, isTemporaryRefusal, replyStaleness } from '@/lib/conversation/preEffect';
import type { ConversationSignals } from '@/lib/conversation/signals';
import type { ConversationGoal, ConversationState, CoveredTopic } from '@/lib/conversation/state';
import { detectPerformanceClaims } from '@/lib/learning/offer';
import { InstagramRailError } from '@/lib/instagram/rail';
import type { OutreachState, ReplyCategory } from '@/lib/replies/taxonomy';

/**
 * HERMES-CONVERSATION-R2 §34 — la décision de répondre SEUL.
 *
 * Aucun modèle, aucune base : la politique est pure, et c'est exactement ce qui
 * permet de l'éprouver sur des états que les huit réponses réelles ne
 * produiront jamais — une menace juridique, une demande de garantie, un
 * brouillon qui promet une rémunération à la performance.
 *
 * Le principe de chaque test est le même : partir d'un tour PARFAIT (celui qui
 * rend `AUTO_REPLY_ELIGIBLE`), changer UNE chose, et vérifier que la porte
 * attendue se referme. Un test qui construirait son propre cas depuis rien
 * finirait par prouver qu'une autre porte refuse, ce qui ne dit rien.
 *
 * Entreprises et textes sont fictifs.
 */

// ---------------------------------------------------------------------------
// Outillage
// ---------------------------------------------------------------------------

const BASE_SIGNALS: ConversationSignals = Object.freeze({
  questionTopic: 'HOW_IT_WORKS',
  objectionTopic: 'NONE',
  buyingSignal: 'WEAK',
  callReadiness: 'MEDIUM',
  sensitiveFlags: Object.freeze([]),
  explicitCallRequest: false,
  tooShortToRead: false,
});

function signals(overrides: Partial<ConversationSignals> = {}): ConversationSignals {
  return Object.freeze({ ...BASE_SIGNALS, ...overrides });
}

function state(overrides: Partial<ConversationState> = {}): ConversationState {
  return Object.freeze({
    prospectId: 'p1',
    counterparty: 'Atelier Fictif',
    channel: 'instagram_dm' as const,
    lastInboundAt: null,
    lastOutboundAt: null,
    inboundTurnCount: 2,
    outboundTurnCount: 1,
    isFirstReply: false,
    goal: 'ANSWER_QUESTION' as ConversationGoal,
    qualification: 'QUALIFYING' as const,
    coveredTopics: Object.freeze([] as CoveredTopic[]),
    questionsAskedByUs: 1,
    questionTopicsReceived: Object.freeze([]),
    objectionsEncountered: Object.freeze([]),
    nextAction: 'HUMAN_REPLY_NOW' as const,
    followUpStillRelevant: true,
    humanNeeded: false,
    ...overrides,
  });
}

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

function draft(overrides: Partial<AutonomousDraftFacts> = {}): AutonomousDraftFacts {
  return Object.freeze({ ...CLEAN_DRAFT, ...overrides });
}

interface Scenario {
  readonly category?: ReplyCategory;
  readonly confidence?: number;
  readonly signals?: Partial<ConversationSignals>;
  readonly state?: Partial<ConversationState>;
  readonly gaps?: readonly GroundingGap[];
  readonly draft?: AutonomousDraftFacts | null;
  readonly suppressed?: boolean;
  readonly outreachState?: OutreachState | null;
  readonly terminalCategoryInThread?: ReplyCategory | null;
  readonly identityConfirmed?: boolean;
  readonly newerInboundExists?: boolean;
  readonly burstSettled?: boolean;
  readonly policyVersion?: string;
  readonly commercialPolicyVersion?: string;
  readonly commercialDemands?: readonly CommercialDemandFinding[];
  readonly appointmentQualification?: AppointmentQualification;
}

/**
 * Le tour PARFAIT, et les variantes qu'on en dérive.
 *
 * `decideReply` et `assessOfferProgression` sont les VRAIS : le test exerce la
 * chaîne complète, pas une imitation de ses conclusions. Une régression dans
 * l'une des deux ferait donc échouer ce fichier, ce qui est le but.
 */
function facts(scenario: Scenario = {}): AutonomousReplyFacts {
  const category = scenario.category ?? 'QUESTION';
  const confidence = scenario.confidence ?? 0.95;
  const sig = signals(scenario.signals);
  const st = state(scenario.state);
  const gaps = scenario.gaps ?? [];

  return Object.freeze({
    policyVersion: scenario.policyVersion ?? CONVERSATION_POLICY_VERSION,
    commercialPolicyVersion: scenario.commercialPolicyVersion ?? COMMERCIAL_POLICY_VERSION,
    commercialDemands: scenario.commercialDemands ?? [],
    // Le défaut est le plus NEUTRE des quatre : il n'ouvre rien. Les scénarios
    // qui exercent l'élargissement de la porte 21 le posent explicitement.
    appointmentQualification: scenario.appointmentQualification ?? 'POTENTIALLY_QUALIFIED',
    correlation: 'HIGH_CONFIDENCE' as const,
    identityConfirmed: scenario.identityConfirmed ?? true,
    suppressed: scenario.suppressed ?? false,
    outreachState: scenario.outreachState ?? 'REPLIED',
    terminalCategoryInThread: scenario.terminalCategoryInThread ?? null,
    category,
    confidence,
    signals: sig,
    state: st,
    decision: decideReply({ category, signals: sig, state: st, groundingGaps: gaps, confidence }),
    groundingGaps: Object.freeze([...gaps]),
    offer: assessOfferProgression({ category, signals: sig, state: st }),
    newerInboundExists: scenario.newerInboundExists ?? false,
    burstSettled: scenario.burstSettled ?? true,
    draft: scenario.draft === undefined ? CLEAN_DRAFT : scenario.draft,
    minConfidence: 0.85,
  });
}

// ---------------------------------------------------------------------------
// §34.1 — le cas nominal
// ---------------------------------------------------------------------------

describe('HERMES-CONVERSATION-R2 §34 — décision d’auto-réponse', () => {
  it('§34.1 — une question ancrée, comprise et bien rédigée est éligible', () => {
    const decision = decideAutonomousReply(facts());
    expect(decision.outcome).toBe('AUTO_REPLY_ELIGIBLE');
    expect(decision.reason).toBeNull();
    expect(isAutoReplyEligible(decision)).toBe(true);
    expect(formatAutonomousReplyDecision(decision)).toBe('AUTO_REPLY_ELIGIBLE');
  });

  it('l’éligibilité n’est PAS une autorisation : le runtime reste à consulter', () => {
    // Le détail le dit en toutes lettres, parce qu'un opérateur qui lit
    // « ELIGIBLE » dans un rapport doit savoir que l'arrêt global, la fenêtre et
    // les plafonds n'ont pas encore été regardés.
    expect(decideAutonomousReply(facts()).detail).toContain('runtime');
  });

  // -------------------------------------------------------------------------
  // §34.2 à §34.4 — les escalades de contenu
  // -------------------------------------------------------------------------

  it('§34.2 — un message trop court et sans sujet escalade au lieu de deviner', () => {
    const decision = decideAutonomousReply(
      facts({
        signals: { tooShortToRead: true, questionTopic: 'NONE', buyingSignal: 'NONE' },
      }),
    );
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(decision.reason).toBe('ambiguous_message');
  });

  it('§34.3 — une question de prix escalade : aucune politique tarifaire n’existe', () => {
    const decision = decideAutonomousReply(
      facts({ signals: { questionTopic: 'PRICE' }, gaps: ['PRICING_POLICY_MISSING'] }),
    );
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    // La porte du grounding passe AVANT celle du palier commercial : les deux
    // refusent, et c'est la plus précise qui doit nommer le refus.
    expect(decision.reason).toBe('pricing_policy_missing');
  });

  it('§34.3 bis — même sans manque de grounding déclaré, le palier « modèle » escalade', () => {
    const decision = decideAutonomousReply(facts({ signals: { questionTopic: 'GUARANTEE' } }));
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(['guarantee_requested', 'commercial_policy_missing']).toContain(decision.reason);
  });

  it('§34.4 — une demande de preuve escalade : aucune preuve n’est citable en réponse', () => {
    const decision = decideAutonomousReply(
      facts({ signals: { questionTopic: 'RESULTS_PROOF' }, gaps: ['PROOF_NOT_QUOTABLE_IN_REPLY'] }),
    );
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(decision.reason).toBe('proof_requested');
  });

  it('un sujet qu’aucune donnée ne couvre escalade plutôt que de répondre de travers', () => {
    const decision = decideAutonomousReply(
      facts({ signals: { questionTopic: 'OTHER_QUESTION' }, gaps: ['TOPIC_NOT_COVERED_BY_DATA'] }),
    );
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(decision.reason).toBe('topic_not_covered');
  });

  it('un sujet sensible sort du chemin automatique, même sur une question ordinaire', () => {
    const decision = decideAutonomousReply(facts({ signals: { sensitiveFlags: ['LEGAL_THREAT'] } }));
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(decision.reason).toBe('sensitive_content');
  });

  it('une menace juridique ACCOMPAGNÉE d’un refus escalade — l’arrêt ne répond pas à la menace', () => {
    const decision = decideAutonomousReply(
      facts({ category: 'NOT_INTERESTED', signals: { sensitiveFlags: ['LEGAL_THREAT'] } }),
    );
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
  });

  it('une demande d’arrêt ACCOMPAGNÉE d’hostilité s’arrête d’abord', () => {
    const decision = decideAutonomousReply(
      facts({ category: 'UNSUBSCRIBE', signals: { sensitiveFlags: ['HOSTILE'] } }),
    );
    expect(decision.outcome).toBe('TERMINAL_STOP');
    expect(decision.reason).toBe('unsubscribe_requested');
  });

  // -------------------------------------------------------------------------
  // §34.5 à §34.7 — les arrêts
  // -------------------------------------------------------------------------

  it('§34.5 — un désabonnement est terminal', () => {
    const decision = decideAutonomousReply(facts({ category: 'UNSUBSCRIBE' }));
    expect(decision.outcome).toBe('TERMINAL_STOP');
    expect(isTerminalReplyDecision(decision)).toBe(true);
    expect(decision.reconsiderable).toBe(false);
  });

  it('§34.6 — un refus clair est terminal', () => {
    expect(decideAutonomousReply(facts({ category: 'NOT_INTERESTED' })).outcome).toBe('TERMINAL_STOP');
  });

  it('une non-remise est terminale : il n’y a personne au bout', () => {
    const decision = decideAutonomousReply(facts({ category: 'BOUNCE' }));
    expect(decision.outcome).toBe('TERMINAL_STOP');
    expect(decision.reason).toBe('channel_unusable');
  });

  it('un opt-out enregistré est terminal avant même de lire le message', () => {
    const decision = decideAutonomousReply(facts({ suppressed: true }));
    expect(decision.outcome).toBe('TERMINAL_STOP');
    expect(decision.reason).toBe('opt_out');
    expect(decision.gate).toBe('opt_out');
  });

  it('un état SUPPRESSED est terminal', () => {
    expect(decideAutonomousReply(facts({ outreachState: 'SUPPRESSED' })).outcome).toBe('TERMINAL_STOP');
  });

  it('un fil DÉJÀ refermé ne se rouvre pas sur un message ultérieur qui ressemble à de l’intérêt', () => {
    const decision = decideAutonomousReply(
      facts({ category: 'INTERESTED', terminalCategoryInThread: 'NOT_INTERESTED' }),
    );
    expect(decision.outcome).toBe('TERMINAL_STOP');
    expect(decision.reason).toBe('conversation_closed');
  });

  it('§34.7 — un report explicite ne produit aucune réponse immédiate', () => {
    const decision = decideAutonomousReply(facts({ category: 'NOT_NOW' }));
    expect(decision.outcome).toBe('AUTO_REPLY_SKIP');
    expect(decision.reason).toBe('not_now_deferred');
    expect(decision.reconsiderable).toBe(true);
    expect(decision.detail).toContain('relance');
  });

  it('une réponse d’absence automatique n’appelle pas de réponse', () => {
    expect(decideAutonomousReply(facts({ category: 'AUTO_REPLY' })).reason).toBe('automated_counterparty');
  });

  // -------------------------------------------------------------------------
  // §34.8, §34.9, §34.17 — le temps
  // -------------------------------------------------------------------------

  it('§34.8 — une conversation dépassée par un message plus récent est écartée', () => {
    const decision = decideAutonomousReply(facts({ newerInboundExists: true }));
    expect(decision.outcome).toBe('AUTO_REPLY_SKIP');
    expect(decision.reason).toBe('stale_reply');
  });

  it('§34.9 — un message reçu APRÈS le calcul rend le plan périmé', () => {
    const stale = replyStaleness('2026-08-21T13:00:00.000Z', '2026-08-21T13:05:00.000Z');
    expect(stale).not.toBeNull();
    expect(stale).toContain('plus la dernière');
  });

  it('§34.9 bis — un plan à jour n’est pas périmé', () => {
    expect(replyStaleness('2026-08-21T13:05:00.000Z', '2026-08-21T13:05:00.000Z')).toBeNull();
    expect(replyStaleness('2026-08-21T13:05:00.000Z', null)).toBeNull();
  });

  it('§34.9 ter — une marque illisible refuse plutôt que de conclure', () => {
    expect(replyStaleness('pas-une-date', '2026-08-21T13:05:00.000Z')).toContain('illisible');
    expect(replyStaleness(null, '2026-08-21T13:05:00.000Z')).toContain('dépassé');
  });

  it('une salve encore ouverte fait attendre, et le motif le distingue d’un message dépassé', () => {
    const decision = decideAutonomousReply(facts({ burstSettled: false }));
    expect(decision.outcome).toBe('AUTO_REPLY_SKIP');
    expect(decision.reason).toBe('burst_open');
  });

  it('§34.17 — une politique différente referme la décision', () => {
    const decision = decideAutonomousReply(facts({ policyVersion: 'hermes-conversation-r1' }));
    expect(decision.outcome).toBe('AUTO_REPLY_SKIP');
    expect(decision.reason).toBe('policy_version_mismatch');
  });

  // -------------------------------------------------------------------------
  // §34.14 à §34.16 — le brouillon
  // -------------------------------------------------------------------------

  it('§34.14 — un contrôle de naturalité bloquant empêche l’envoi automatique', () => {
    const decision = decideAutonomousReply(
      facts({ draft: draft({ naturalnessVerdict: 'UNNATURAL', naturalnessBlockingCodes: ['TOO_LONG'] }) }),
    );
    expect(decision.outcome).toBe('AUTO_REPLY_SKIP');
    expect(decision.reason).toBe('naturalness_blocking');
  });

  it('§34.15 — un garde-fou bloquant escalade : cela se lève par une régénération relue', () => {
    const decision = decideAutonomousReply(facts({ draft: draft({ guardrailBlocked: true }) }));
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(decision.reason).toBe('guardrail_blocked');
  });

  it('§34.16 — un registre qui ne correspond pas est un constat BLOQUANT de naturalité', () => {
    const decision = decideAutonomousReply(
      facts({
        draft: draft({
          naturalnessVerdict: 'UNNATURAL',
          naturalnessBlockingCodes: ['ADDRESS_MODE_MISMATCH'],
        }),
      }),
    );
    expect(decision.outcome).toBe('AUTO_REPLY_SKIP');
    expect(decision.reason).toBe('naturalness_blocking');
  });

  it('deux questions dans le même message écartent la réponse automatique', () => {
    const decision = decideAutonomousReply(facts({ draft: draft({ questions: 2 }) }));
    expect(decision.outcome).toBe('AUTO_REPLY_SKIP');
    expect(decision.reason).toBe('multiple_questions');
  });

  it('un brouillon absent écarte plutôt que d’en inventer un', () => {
    const decision = decideAutonomousReply(facts({ draft: null }));
    expect(decision.outcome).toBe('AUTO_REPLY_SKIP');
    expect(decision.reason).toBe('draft_missing');
  });

  // -------------------------------------------------------------------------
  // §11 — le modèle de rémunération
  // -------------------------------------------------------------------------

  it('§11 — une promesse de rémunération à la performance escalade, toujours', () => {
    const decision = decideAutonomousReply(
      facts({ draft: draft({ performanceClaims: ['à la performance'] }) }),
    );
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(decision.reason).toBe('performance_claim');
  });

  it('§11 — le détecteur attrape les formulations que la mission met sur la table', () => {
    const phrases = [
      'on travaille gratuitement au début',
      'vous ne payez que si ça marche',
      'aucun risque pour vous',
      'un résultat garanti',
      'notre rémunération est liée aux résultats',
      'nos intérêts sont alignés',
      'on se rémunère seulement si vous gagnez',
      'sans engagement',
    ];
    for (const phrase of phrases) {
      expect(detectPerformanceClaims(phrase).length, phrase).toBeGreaterThan(0);
    }
  });

  it('§11 — une phrase ordinaire n’est pas une promesse', () => {
    expect(detectPerformanceClaims('on peut en parler quinze minutes cette semaine')).toEqual([]);
    expect(detectPerformanceClaims('vous cherchez à avoir plus de demandes ?')).toEqual([]);
  });

  it('§11 — aucune politique commerciale canonique n’existe, et le type le dit', () => {
    expect(COMMERCIAL_POLICY_STATUS).toBe('MISSING');
    const progression = assessOfferProgression({
      category: 'QUESTION',
      signals: signals({ questionTopic: 'PRICE' }),
      state: state(),
    });
    expect(progression.stage).toBe('EXPLAIN_MODEL');
    expect(progression.needsCommercialPolicy).toBe(true);
    expect(progression.performanceModelMentionAllowed).toBe(false);
    expect(progression.pricingAnswerable).toBe(false);
    expect(progression.guaranteeAnswerable).toBe(false);
  });

  // -------------------------------------------------------------------------
  // §34.20 — la progression vers un échange
  // -------------------------------------------------------------------------

  it('§34.20 — une demande d’appel explicite mène au palier PROPOSE_CALL et reste éligible', () => {
    const decision = decideAutonomousReply(
      facts({
        signals: {
          explicitCallRequest: true,
          questionTopic: 'CALL_REQUEST',
          callReadiness: 'HIGH',
          buyingSignal: 'STRONG',
        },
        state: { goal: 'PROPOSE_CALL' },
        draft: draft({ proposesCall: true }),
      }),
    );
    expect(decision.outcome).toBe('AUTO_REPLY_ELIGIBLE');
  });

  it('un échange proposé sans maturité est écarté', () => {
    const decision = decideAutonomousReply(
      facts({ signals: { callReadiness: 'LOW' }, draft: draft({ proposesCall: true }) }),
    );
    expect(decision.outcome).toBe('AUTO_REPLY_SKIP');
    expect(decision.reason).toBe('call_too_early');
  });

  it('un argumentaire posé sans besoin exprimé est écarté', () => {
    const decision = decideAutonomousReply(
      facts({
        category: 'OBJECTION',
        signals: { questionTopic: 'NONE', objectionTopic: 'NONE', buyingSignal: 'NONE', callReadiness: 'LOW' },
        state: { goal: 'HANDLE_OBJECTION' },
        draft: draft({ containsPitch: true, questions: 0 }),
      }),
    );
    expect(decision.outcome).toBe('AUTO_REPLY_SKIP');
    expect(decision.reason).toBe('pitch_too_early');
  });

  // -------------------------------------------------------------------------
  // Identité, confiance, catégories illisibles
  // -------------------------------------------------------------------------

  it('une identité non établie escalade : répondre engagerait un message commercial', () => {
    const decision = decideAutonomousReply(facts({ identityConfirmed: false }));
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(decision.reason).toBe('identity_uncertain');
  });

  it('une confiance sous le seuil autonome escalade, même au-dessus du seuil D2', () => {
    const decision = decideAutonomousReply(facts({ confidence: 0.7 }));
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(decision.reason).toBe('low_confidence');
  });

  it('REVIEW_REQUIRED et OTHER ne sont pas auto-répondables', () => {
    for (const category of ['REVIEW_REQUIRED', 'OTHER'] as const) {
      const decision = decideAutonomousReply(facts({ category }));
      expect(decision.outcome, category).toBe('HUMAN_ESCALATION');
      expect(decision.reason, category).toBe('unclassifiable');
    }
  });

  it('un état conversationnel qui réclame un humain escalade', () => {
    const decision = decideAutonomousReply(facts({ state: { humanNeeded: true, goal: 'AWAIT_HUMAN' } }));
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(decision.reason).toBe('human_needed');
  });

  // -------------------------------------------------------------------------
  // §34.19 — le bail navigateur
  // -------------------------------------------------------------------------

  it('§34.19 — un profil navigateur occupé est un report, jamais une panne de session', () => {
    const busy = new InstagramRailError('IG_BROWSER_PROFILE_BUSY', 'profil tenu par l’autre runtime');
    const refusal = classifyProfileContention(busy);
    expect(refusal).toBe('BROWSER_PROFILE_BUSY');
    expect(isTemporaryRefusal('BROWSER_PROFILE_BUSY')).toBe(true);
  });

  it('§34.19 bis — une vraie panne de rail n’est pas une contention de profil', () => {
    expect(classifyProfileContention(new InstagramRailError('IG_RAIL_ERROR', 'navigation cassée'))).toBeNull();
    expect(classifyProfileContention(new Error('autre chose'))).toBeNull();
  });

  it('§34.18 — un refus d’arrêt global est temporaire, un refus de contenu ne l’est pas', () => {
    expect(isTemporaryRefusal('BLOCKED_KILL_SWITCH')).toBe(true);
    expect(isTemporaryRefusal('BLOCKED_OUTSIDE_WINDOW')).toBe(true);
    expect(isTemporaryRefusal('PROSPECT_SUPPRESSED')).toBe(false);
    expect(isTemporaryRefusal('PLAN_STALE')).toBe(false);
    expect(isTemporaryRefusal('EFFECT_ALREADY_ATTEMPTED')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Invariants de politique
  // -------------------------------------------------------------------------

  it('la politique conversationnelle ne partage pas son étiquette avec le ciblage', async () => {
    const targeting = await import('@/lib/instagram/autonomousPolicy');
    expect(CONVERSATION_POLICY_VERSION).toBe('hermes-conversation-r12');
    expect(CONVERSATION_POLICY_VERSION).not.toBe(targeting.AUTONOMOUS_POLICY_VERSION);
  });

  it('§21 — la fenêtre des réponses est celle du rail sortant, et c’est écrit', () => {
    expect(CONVERSATION_WINDOW_POLICY).toBe('INHERIT_OUTBOUND_WINDOW');
  });

  it('la catégorie terminale d’un fil se lit sur la PREMIÈRE rencontrée', () => {
    expect(terminalCategoryIn(['QUESTION', 'NOT_INTERESTED', 'UNSUBSCRIBE'])).toBe('NOT_INTERESTED');
    expect(terminalCategoryIn(['QUESTION', null, 'OBJECTION'])).toBeNull();
    expect(terminalCategoryIn([])).toBeNull();
  });

  it('aucune combinaison de doute ne rend AUTO_REPLY_ELIGIBLE', () => {
    // Fail-closed exhaustif : chaque facteur de doute, pris seul, doit refuser.
    const doubts: Scenario[] = [
      { suppressed: true },
      { identityConfirmed: false },
      { confidence: 0.5 },
      { newerInboundExists: true },
      { burstSettled: false },
      { draft: null },
      { draft: draft({ guardrailBlocked: true }) },
      { draft: draft({ naturalnessVerdict: 'UNNATURAL', naturalnessBlockingCodes: ['TOO_LONG'] }) },
      { policyVersion: 'autre' },
      { state: { humanNeeded: true } },
      { gaps: ['PRICING_POLICY_MISSING'] },
      { terminalCategoryInThread: 'UNSUBSCRIBE' },
    ];
    for (const doubt of doubts) {
      expect(isAutoReplyEligible(decideAutonomousReply(facts(doubt))), JSON.stringify(doubt)).toBe(false);
    }
  });
});
