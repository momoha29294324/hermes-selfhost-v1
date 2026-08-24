import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { createLogger } from '@/lib/logging/logger';
import { ModelRouter } from '@/lib/models/router';
import { LlmError, type LlmProvider } from '@/lib/models/types';
import { buildConversationReply, understandConversation } from '@/lib/conversation/brain';
import {
  CONVERSATION_POLICY_VERSION,
  decideAutonomousReply,
  type AutonomousDraftFacts,
  type AutonomousReplyFacts,
} from '@/lib/conversation/autonomy';
import {
  COMMERCIAL_POLICY_VERSION,
  readCommercialDemands,
  signalCommercialDemand,
} from '@/lib/conversation/commercialPolicy';
import { decideReply } from '@/lib/conversation/decision';
import { answerBlockedByGaps, buildGrounding } from '@/lib/conversation/grounding';
import { assessOfferProgression } from '@/lib/conversation/offerProgression';
import { readSignals } from '@/lib/conversation/signals';
import { resolveAddressMode } from '@/lib/conversation/style';
import { conversationPromptVersionFor } from '@/lib/conversation/promptVersion';
import type { ConversationState } from '@/lib/conversation/state';
import type { ConversationThread } from '@/lib/conversation/thread';
import { acquisitionDisclosure } from '@/lib/sales/acquisitionService';
import { TRIAL_FACTS, checkTrialStatement, trialDisclosure } from '@/lib/sales/offer';
import { resolvePriceSubject } from '@/lib/sales/priceSubject';
import { detectPerformanceClaims } from '@/lib/learning/offer';
import { persistAnalysis, type StoredAnalysis } from '@/lib/replies/analyses';
import { loadReplyContext, type ReplyContext } from '@/lib/replies/context';
import { persistDraft, reviewDraft } from '@/lib/replies/draft';
import {
  decideCategory,
  detectUnsubscribeDemand,
  resolveNextAction,
  type ReplyCategory,
} from '@/lib/replies/taxonomy';
import { makeReplyFixtures, type ContactedProspect, type ReplyFixtures } from './support/replyFixture';
import type { Sql } from '@/lib/db/sql';

/**
 * HERMES-TRIAL-IMPLEMENTATION-ROUTING-R1 — « Ok concrètement pendant les 7
 * jours tu met quoi en place ? ».
 *
 * Le tour réel du 23 août 2026, et les façons de ne pas le trahir en le
 * réparant.
 *
 * Le défaut n'était ni une incompréhension — D2 avait rendu `QUESTION` à 0,99 —
 * ni une vérité manquante : `TRIAL_FACTS` dit depuis HERMES-SALES-KNOWLEDGE-R1
 * que « pendant ces sept jours, je mets en place au minimum les publicités Meta
 * et le CRM », et `ACQUISITION_TRUTH` dit la chaîne complète. C'était une CASE :
 * aucun sujet de question ne décrivait « qu'est-ce que tu mets en place pendant
 * le test ? », donc le message tombait en `OTHER_QUESTION`, qui ouvre
 * `TOPIC_NOT_COVERED_BY_DATA`, donc `HUMAN_ESCALATION:topic_not_covered`.
 *
 * Ce fichier vérifie la distinction, et surtout tout ce qui NE DOIT PAS avoir
 * bougé — à commencer par le prix de la SUITE, posé avec la MÊME ancre « 7
 * jours » et qui doit toujours rendre la main. Entreprises et textes sont
 * fictifs, hors le message réel cité ci-dessous.
 */

const logger = createLogger({ test: 'trial-implementation-routing-r1' });
const ROOT = resolve(__dirname, '..');
const MAILBOX = 'reponse@example.com';
const FIRST_TOUCH =
  'Bonjour, petite question : aujourd’hui, vous faites comment pour avoir régulièrement de ' +
  'nouvelles demandes ?';

/** Le message réel, à la lettre — faute de frappe comprise. */
const REAL_TURN = 'Ok concrètement pendant les 7 jours tu met quoi en place ?';

let sql: Sql;
let dir: string;
let fixtures: ReplyFixtures;
let lastPrompt = '';

/**
 * Une réponse conceptuellement proche de celle qu'on attend, jamais celle qu'on
 * impose : le pipeline doit la produire depuis les faits, pas la recopier. Elle
 * sert ici à éprouver les GARDES sur un texte plausible.
 */
const GOOD_ANSWER = {
  body:
    'Je mets en place les pubs Facebook et Instagram, le formulaire de demande et le CRM pour ' +
    'centraliser et suivre les demandes. Ensuite tu récupères les personnes à rappeler.',
  rationale: 'Répond d’abord, dit ce qui est installé, laisse le rappel au client.',
  used_facts: [],
};

function makeRouter(answer: unknown = GOOD_ANSWER): ModelRouter {
  const provider: LlmProvider = {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async (request) => {
      if (request.task !== 'message') {
        throw new LlmError(`tâche inattendue ${String(request.task)}`, 'provider_error');
      }
      lastPrompt = request.prompt;
      return { text: JSON.stringify(answer) };
    },
  };
  return new ModelRouter({ sql, logger, providers: { codex: provider } });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-trial-impl-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-trial-impl-test', 'Test', 'example-services', '{}'],
  );
  fixtures = makeReplyFixtures(sql, { campaignId: rows[0]!.id, mailbox: MAILBOX, firstTouch: FIRST_TOUCH });
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  lastPrompt = '';
});

let recipientCounter = 0;

async function inboundTurn(
  prospect: ContactedProspect,
  body: string,
  category: ReplyCategory,
  hour: number,
): Promise<{ context: ReplyContext; analysis: StoredAnalysis }> {
  const id = await fixtures.inbound({
    manifest: prospect.manifest,
    outreachEventId: prospect.outreachEventId,
    prospectId: prospect.prospectId,
    body,
    receivedAt: new Date(Date.UTC(2026, 7, 23, hour, 0, 0)).toISOString(),
  });
  const context = await loadReplyContext(sql, id);
  if (context === null) throw new Error('contexte introuvable');

  const decision = decideCategory({
    category,
    confidence: 0.99,
    correlationStatus: context.reply.correlationStatus,
    deterministic: true,
    unsubscribeDemand: detectUnsubscribeDemand(body),
  });
  const persisted = await persistAnalysis(sql, context, {
    category: decision.category,
    confidence: decision.confidence,
    reasoningSummary: `classé ${decision.category} pour le test`,
    evidenceExcerpts: [],
    currentRequest: 'NONE' as const,
    reportedContent: [],
    requiresHumanReview: decision.requiresHumanReview,
    recommendedNextAction: resolveNextAction(decision),
    decision,
    decidedDeterministically: true,
    model: 'test-model',
    effort: null,
    promptVersion: 'test-1',
    inputSha256: createHash('sha256').update(`${id}:${category}:${String(hour)}`).digest('hex'),
    modelRunId: null,
  });
  return { context, analysis: persisted.analysis };
}

async function approveOurReply(
  context: ReplyContext,
  analysis: StoredAnalysis,
  body: string,
): Promise<void> {
  const persisted = await persistDraft(sql, context, analysis, {
    body,
    bodySha256: createHash('sha256').update(body).digest('hex'),
    rationale: 'réponse de test',
    guardrailFlags: [],
    blocked: false,
    model: 'test-model',
    effort: null,
    promptVersion: 'test-1',
    modelRunId: null,
  });
  await reviewDraft(sql, { draftId: persisted.draft.id, decision: 'APPROVE', reviewedBy: 'test' });
}

/** Le fil réel, rejoué jusqu'au tour qui nous occupe, en tutoiement. */
async function realThread(
  finalTurn = REAL_TURN,
): Promise<{ context: ReplyContext; analysis: StoredAnalysis }> {
  recipientCounter += 1;
  const prospect = await fixtures.contactedProspect(`impl${String(recipientCounter)}@example.com`);
  const first = await inboundTurn(prospect, 'Surtout via le bouche à oreille', 'INFORMATION_SHARED', 7);
  await approveOurReply(
    first.context,
    first.analysis,
    'Et ça t’en ramène assez régulièrement, ou ça dépend des mois ?',
  );
  const second = await inboundTurn(prospect, 'Pourquoi tu me demande ça', 'QUESTION', 8);
  await approveOurReply(
    second.context,
    second.analysis,
    'J’aide les pros du prestation standard à trouver des clients, donc je voulais simplement savoir ' +
      'comment tu obtiens tes demandes aujourd’hui.',
  );
  return inboundTurn(prospect, finalTurn, 'QUESTION', 13);
}

// ---------------------------------------------------------------------------
// Outillage pur
// ---------------------------------------------------------------------------

const EMPTY_THREAD: ConversationThread = Object.freeze({
  prospectId: 'p1',
  channel: 'instagram_dm' as const,
  currentInboundId: 'i1',
  turns: Object.freeze([]),
  inboundTurns: Object.freeze([]),
  outboundTurns: Object.freeze([]),
  exposedOutboundTurns: Object.freeze([]),
  priorInboundCount: 1,
  truncated: false,
}) as unknown as ConversationThread;

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
    goal: 'ANSWER_QUESTION' as const,
    qualification: 'QUALIFYING' as const,
    coveredTopics: Object.freeze([]),
    questionsAskedByUs: 1,
    questionTopicsReceived: Object.freeze([]),
    objectionsEncountered: Object.freeze([]),
    nextAction: 'HUMAN_REPLY_NOW' as const,
    followUpStillRelevant: true,
    humanNeeded: false,
    ...overrides,
  });
}

function groundingContext(body: string): ReplyContext {
  return {
    prospect: { id: 'p1', displayName: 'Atelier Fictif', city: null },
    research: { observations: ['site actif'], opportunities: [] },
    angle: null,
    reply: { bodyText: body },
  } as unknown as ReplyContext;
}

const CLEAN_DRAFT: AutonomousDraftFacts = Object.freeze({
  bodySha256: 'a'.repeat(64),
  guardrailBlocked: false,
  naturalnessVerdict: 'NATURAL' as const,
  naturalnessBlockingCodes: Object.freeze([]),
  naturalnessWarningCodes: Object.freeze([]),
  questions: 0,
  proposesCall: false,
  containsPitch: false,
  performanceClaims: Object.freeze([]),
  trialStatementCodes: Object.freeze([]),
});

function factsFor(body: string, category: ReplyCategory = 'QUESTION'): AutonomousReplyFacts {
  const signals = readSignals(body, category, EMPTY_THREAD);
  const st = state();
  const grounding = buildGrounding(groundingContext(body), signals);

  const lexical = readCommercialDemands(body);
  const fromSignals = signalCommercialDemand(signals, body);
  const commercialDemands =
    fromSignals === null || lexical.some((finding) => finding.demand === fromSignals.demand)
      ? lexical
      : [...lexical, fromSignals];

  return Object.freeze({
    policyVersion: CONVERSATION_POLICY_VERSION,
    commercialPolicyVersion: COMMERCIAL_POLICY_VERSION,
    commercialDemands,
    appointmentQualification: 'POTENTIALLY_QUALIFIED' as const,
    correlation: 'HIGH_CONFIDENCE' as const,
    identityConfirmed: true,
    suppressed: false,
    outreachState: 'REPLIED' as const,
    terminalCategoryInThread: null,
    newerInboundExists: false,
    burstSettled: true,
    category,
    confidence: 0.99,
    signals,
    state: st,
    decision: decideReply({ category, confidence: 0.99, signals, state: st, groundingGaps: grounding.gaps }),
    groundingGaps: grounding.gaps,
    offer: assessOfferProgression({ signals, state: st, category, priceSubject: resolvePriceSubject(body) }),
    draft: CLEAN_DRAFT,
    minConfidence: 0.85,
  }) as AutonomousReplyFacts;
}

function outcomeFor(body: string, category: ReplyCategory = 'QUESTION'): string {
  const decision = decideAutonomousReply(factsFor(body, category));
  return decision.outcome === 'AUTO_REPLY_ELIGIBLE'
    ? 'AUTO_REPLY_ELIGIBLE'
    : `${decision.outcome}:${decision.reason}`;
}

function topicOf(body: string): string {
  return readSignals(body, 'QUESTION', EMPTY_THREAD).questionTopic;
}

// ---------------------------------------------------------------------------
// A — la case qui manquait
// ---------------------------------------------------------------------------

describe('A — « pendant les 7 jours tu mets quoi en place ? » a désormais un sujet', () => {
  const QUESTIONS: readonly string[] = Object.freeze([
    REAL_TURN,
    'pendant les 7 jours tu mets quoi en place ?',
    'concrètement le test comprend quoi ?',
    'qu’est-ce que tu fais pendant l’essai ?',
    'le CRM est compris dans le test ?',
    'pendant la semaine tu gères quoi exactement ?',
  ]);

  it.each(QUESTIONS)('« %s » se lit comme une question de périmètre', (question) => {
    expect(topicOf(question)).toBe('TRIAL_IMPLEMENTATION');
  });

  it.each(QUESTIONS)('« %s » n’ouvre plus TOPIC_NOT_COVERED_BY_DATA', (question) => {
    const signals = readSignals(question, 'QUESTION', EMPTY_THREAD);
    const grounding = buildGrounding(groundingContext(question), signals);
    expect(grounding.gaps).not.toContain('TOPIC_NOT_COVERED_BY_DATA');
    expect(answerBlockedByGaps(grounding.gaps)).toBe(false);
  });

  it.each(QUESTIONS)('« %s » est auto-répondable', (question) => {
    expect(outcomeFor(question)).toBe('AUTO_REPLY_ELIGIBLE');
  });

  it('sans offre écrite, il n’y a AUCUNE vérité d’essai — et rien n’en est inventé', () => {
    // Cette édition ne livre pas d'offre : `config/offer.json` est absent, donc
    // `TRIAL_FACTS` est vide. Ce n'est pas une panne — c'est ce qui fait
    // escalader toute question d'essai plutôt que d'y répondre au hasard.
    expect(TRIAL_FACTS).toHaveLength(0);
  });

  it('le périmètre ouvre la chaîne du service, sans la facette comparative', () => {
    const disclosure = acquisitionDisclosure({
      questionTopic: 'TRIAL_IMPLEMENTATION',
      humanNeeded: false,
      priceSubject: resolvePriceSubject(REAL_TURN),
    });
    expect([...disclosure.facets]).toEqual(['WHAT_WE_DO', 'SYSTEM_FLOW', 'CLIENT_ROLE']);
    expect(disclosure.facets).not.toContain('DIFFERENTIATION');
    // Une question de périmètre ne rend AUCUN montant citable.
    expect(disclosure.quotableAmounts).toHaveLength(0);
  });

  it('et l’essai entre dans le prompt, puisque la personne vient de le nommer', () => {
    expect(
      trialDisclosure({
        offerStage: 'EXPLAIN_OFFER',
        asksHowItWorks: false,
        asksAboutTrial: true,
        humanNeeded: false,
      }),
    ).toBe('ALLOWED');
  });
});

// ---------------------------------------------------------------------------
// B — la DURÉE de l'essai, distincte du délai de RÉSULTAT
// ---------------------------------------------------------------------------

describe('B — la durée du test n’est plus lue comme un délai de résultat', () => {
  it.each([
    'Le test dure combien de temps ?',
    'C’est sur combien de jours l’essai ?',
    'Ça dure combien de temps ton test ?',
  ])('« %s » est une question de durée', (question) => {
    expect(topicOf(question)).toBe('TRIAL_DURATION');
    expect(outcomeFor(question)).toBe('AUTO_REPLY_ELIGIBLE');
  });

  it('un délai de RÉSULTAT reste un délai de résultat, même s’il nomme le test', () => {
    expect(topicOf('En combien de temps j’ai des résultats avec le test ?')).toBe('RESULT_TIMING');
  });

  it('une question de durée n’ouvre ni facette de service, ni montant', () => {
    const question = 'Le test dure combien de temps ?';
    const disclosure = acquisitionDisclosure({
      questionTopic: 'TRIAL_DURATION',
      humanNeeded: false,
      priceSubject: resolvePriceSubject(question),
    });
    expect(disclosure.facets).toHaveLength(0);
    expect(disclosure.quotableAmounts).toHaveLength(0);
  });

  it('« combien de temps » n’est pas une question d’argent', () => {
    expect(resolvePriceSubject('Le test dure combien de temps ?').subject).toBe('UNRESOLVED');
    expect(resolvePriceSubject('C’est sur combien de jours l’essai ?').subject).toBe('UNRESOLVED');
    // …et les formes qui parlent VRAIMENT d'argent n'ont pas bougé.
    expect(resolvePriceSubject('Et ça me coûte combien de tester ?').subject).toBe('TRIAL_COST');
    expect(resolvePriceSubject('C’est combien ?').subject).toBe('UNRESOLVED');
    expect(resolvePriceSubject('Ça coûte combien après les 7 jours ?').subject).toBe(
      'POST_TRIAL_PRICE',
    );
  });
});

// ---------------------------------------------------------------------------
// C — ce que le périmètre du test N'OUVRE PAS
// ---------------------------------------------------------------------------

describe('C — ouvrir le périmètre du test n’ouvre rien d’autre', () => {
  it.each([
    ['Après les 7 jours ça coûte combien ?', 'HUMAN_ESCALATION:pricing_policy_missing'],
    ['Ok, et ça coûte combien après les 7 jours ?', 'HUMAN_ESCALATION:pricing_policy_missing'],
    ['Et pendant les 7 jours tu me garantis quoi ?', 'HUMAN_ESCALATION:guarantee_requested'],
    ['Tu garantis quel ROI ?', 'HUMAN_ESCALATION:guarantee_requested'],
    ['Avec 20€ par jour j’aurai combien de clients ?', 'HUMAN_ESCALATION:guarantee_requested'],
    ['Tu prends combien de pourcentage ?', 'HUMAN_ESCALATION:pricing_policy_missing'],
  ])('« %s » → %s', (question, expected) => {
    expect(outcomeFor(question)).toBe(expected);
  });

  it('sans offre écrite, le coût du test escalade — et AUCUN montant n’est citable', () => {
    expect(outcomeFor('Et ça me coûte combien de tester ?')).toBe(
      'HUMAN_ESCALATION:pricing_policy_missing',
    );
    const disclosure = acquisitionDisclosure({
      questionTopic: 'PRICE',
      humanNeeded: false,
      priceSubject: resolvePriceSubject('Et ça me coûte combien de tester ?'),
    });
    expect(disclosure.quotableAmounts).toHaveLength(0);
  });

  it('une demande d’arrêt reste une demande d’arrêt', () => {
    expect(outcomeFor('Arrête de me contacter', 'UNSUBSCRIBE')).toBe(
      'TERMINAL_STOP:unsubscribe_requested',
    );
  });

  it('un contenu sensible sort toujours du chemin automatique', () => {
    expect(outcomeFor('Pendant les 7 jours tu fais quoi de mes données ? RGPD.')).toBe(
      'HUMAN_ESCALATION:sensitive_content',
    );
  });
});

// ---------------------------------------------------------------------------
// D — « tu mets juste les pubs ? », qui ne nomme pas l'essai
// ---------------------------------------------------------------------------

describe('D — sans ancre d’essai, la question reste une question de méthode', () => {
  it.each([
    'tu mets juste les pubs ?',
    'Tu mets quoi en place ?',
    'Tu gères quoi exactement ?',
    'Tu fais des pubs ?',
  ])('« %s » se lit comme une question de méthode', (question) => {
    expect(topicOf(question)).toBe('ACQUISITION_METHOD');
    expect(outcomeFor(question)).toBe('AUTO_REPLY_ELIGIBLE');
  });

  it('et elle ouvre bien la facette qui répond à « tu t’arrêtes à la pub ? »', () => {
    const disclosure = acquisitionDisclosure({
      questionTopic: 'ACQUISITION_METHOD',
      humanNeeded: false,
      priceSubject: null,
    });
    expect(disclosure.facets).toContain('DIFFERENTIATION');
  });

  it('un verbe d’essai ne suffit jamais à ouvrir l’essai', () => {
    // « tester » et « testé » sont des verbes : un refus et une objection ne
    // sont pas des questions sur notre offre.
    expect(topicOf('Ok je vais tester avec quelqu’un d’autre')).not.toBe('TRIAL_IMPLEMENTATION');
    expect(topicOf('On a testé la pub une fois, ça a rien donné')).not.toBe('TRIAL_IMPLEMENTATION');
  });
});

// ---------------------------------------------------------------------------
// E — aucune exception pour la coquille
// ---------------------------------------------------------------------------

describe('E — aucune exception pour la coquille', () => {
  const MODULES = [
    'src/lib/conversation/signals.ts',
    'src/lib/conversation/grounding.ts',
    'src/lib/conversation/offerProgression.ts',
    'src/lib/sales/acquisitionService.ts',
    'src/lib/sales/priceSubject.ts',
  ];

  it.each(MODULES)('%s ne connaît pas le test contrôlé', (relative) => {
    const source = readFileSync(join(ROOT, relative), 'utf8');
    expect(source).not.toContain('controlledSelfTest');
    expect(source).not.toContain('ControlledSelfTest');
    expect(source).not.toContain('CONTROLLED_SELF_TEST');
  });

  it('la lecture des sujets ne voit ni prospect, ni cadence, ni configuration', () => {
    // Trois arguments : un texte, une catégorie, un fil. Il n'existe aucune
    // donnée depuis laquelle une exception pourrait être écrite.
    expect(readSignals.length).toBe(3);
  });

  it('les versions bougent, donc referment ce qui a été jugé sous les anciennes', () => {
    expect(CONVERSATION_POLICY_VERSION).toBe('hermes-conversation-r12');
    expect(COMMERCIAL_POLICY_VERSION).toBe('hermes-commercial-r7');
    expect(conversationPromptVersionFor('email')).toBe('conv-r8-draft-1');
    expect(conversationPromptVersionFor('instagram_dm')).toBe('conv-r8-ig-draft-1');
  });
});

// ---------------------------------------------------------------------------
// F — le tour réel, rejoué sur la base
// ---------------------------------------------------------------------------

describe('F — le tour réel, rejoué de bout en bout', () => {
  it('le prompt reçoit l’essai, la chaîne du service, et la consigne de répondre d’abord', async () => {
    const { context, analysis } = await realThread();
    const understanding = await understandConversation(sql, context, analysis);

    expect(understanding.signals.questionTopic).toBe('TRIAL_IMPLEMENTATION');
    expect(understanding.trialDisclosure).toBe('ALLOWED');
    expect([...understanding.acquisition.facets]).toEqual([
      'WHAT_WE_DO',
      'SYSTEM_FLOW',
      'CLIENT_ROLE',
    ]);
    expect(understanding.acquisition.quotableAmounts).toHaveLength(0);
    expect(understanding.grounding.gaps).not.toContain('TOPIC_NOT_COVERED_BY_DATA');
    expect(understanding.answerExpected).toBe(true);
    expect(resolveAddressMode(understanding.thread.inboundTurns.map((turn) => turn.text))).toBe('TU');

    await buildConversationReply(sql, makeRouter(), context, analysis);

    expect(lastPrompt).toContain('L’OFFRE HERMES');
    expect(lastPrompt).toContain('[WHAT_WE_DO]');
    expect(lastPrompt).toContain('[SYSTEM_FLOW]');
    expect(lastPrompt).toContain('[CLIENT_ROLE]');
    expect(lastPrompt).toContain('RÉPONDS D’ABORD');
  });

  it('le brouillon qui répond passe les gardes, sans chiffre et sans promesse', async () => {
    const { context, analysis } = await realThread();
    const built = await buildConversationReply(sql, makeRouter(), context, analysis);

    expect(built.draft!.guardrailFlags.filter((flag) => flag.blocking)).toHaveLength(0);
    expect(built.draft!.blocked).toBe(false);
    expect(
      built.naturalness!.findings.filter((finding) => finding.severity === 'BLOCKING'),
    ).toHaveLength(0);
    expect(built.draft!.body).not.toMatch(/\d/);
  });

  it('mais un brouillon qui annonce le test sans le budget publicitaire est relevé', async () => {
    const { context, analysis } = await realThread();
    const built = await buildConversationReply(
      sql,
      makeRouter({
        body:
          'Pendant les 7 jours je mets en place les pubs Meta et le CRM, et je ne facture pas ' +
          'mes frais de service.',
        rationale: 'omet le budget publicitaire',
        used_facts: [],
      }),
      context,
      analysis,
    );

    expect(checkTrialStatement(built.draft!.body).map((finding) => finding.code)).toContain(
      'TRIAL_AD_SPEND_OMITTED',
    );
  });

  it('et un brouillon qui promet un résultat reste refusé', async () => {
    const { context, analysis } = await realThread();
    const promise =
      'Je mets en place les pubs et le CRM, et tu auras 10 clients par mois dès la première ' +
      'semaine.';
    const built = await buildConversationReply(
      sql,
      makeRouter({ body: promise, rationale: 'promet un résultat', used_facts: [] }),
      context,
      analysis,
    );

    // `unapproved_metric` ne s'applique PAS ici, et c'est juste : cette garde
    // porte sur les MONTANTS, et « 10 clients » n'en est pas un. Ce qui refuse
    // est le détecteur de promesses, que le rail autonome relit — le dire
    // autrement chercherait une protection là où elle n'est pas.
    const claims = detectPerformanceClaims(built.draft!.body);
    expect(claims.length).toBeGreaterThan(0);

    const facts = factsFor(REAL_TURN);
    const refused = decideAutonomousReply({
      ...facts,
      draft: { ...CLEAN_DRAFT, performanceClaims: claims },
    });
    expect(refused.outcome).toBe('HUMAN_ESCALATION');
    expect(refused.reason).toBe('performance_claim');
  });

  it('le prix d’APRÈS, sur la même base et avec la même ancre, escalade toujours', async () => {
    const { context, analysis } = await realThread('Après les 7 jours ça coûte combien ?');
    const understanding = await understandConversation(sql, context, analysis);

    expect(understanding.grounding.gaps).toContain('PRICING_POLICY_MISSING');
    expect(understanding.acquisition.quotableAmounts).toHaveLength(0);
    expect(understanding.answerExpected).toBe(false);
  });
});
