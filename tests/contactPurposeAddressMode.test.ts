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
import {
  buildConversationReply,
  conversationPromptVersionFor,
  understandConversation,
} from '@/lib/conversation/brain';
import {
  CONVERSATION_POLICY_VERSION,
  decideAutonomousReply,
  type AutonomousDraftFacts,
  type AutonomousReplyFacts,
} from '@/lib/conversation/autonomy';
import {
  AUTONOMOUS_COMMERCIAL_SCOPE,
  COMMERCIAL_POLICY_VERSION,
  readCommercialDemands,
} from '@/lib/conversation/commercialPolicy';
import { decideReply } from '@/lib/conversation/decision';
import { buildGrounding } from '@/lib/conversation/grounding';
import { checkNaturalness } from '@/lib/conversation/naturalness';
import { assessOfferProgression } from '@/lib/conversation/offerProgression';
import { deriveConversationPlanKey, recordConversationPlan } from '@/lib/conversation/plan';
import { readSignals, type ConversationSignals } from '@/lib/conversation/signals';
import {
  buildStyleProfile,
  resolveAddressMode,
  type StyleProfile,
  type StyleSample,
} from '@/lib/conversation/style';
import { renderStyleDirective } from '@/lib/conversation/voice';
import type { ConversationState } from '@/lib/conversation/state';
import type { ConversationThread } from '@/lib/conversation/thread';
import {
  CONTACT_PURPOSE_FACTS,
  CONTACT_PURPOSE_VERSION,
  contactPurposeDisclosure,
  renderContactPurposeBlock,
} from '@/lib/sales/contactPurpose';
import { detectPerformanceClaims } from '@/lib/learning/offer';
import { checkReplyDraft, loadDraftForAnalysis } from '@/lib/replies/draft';
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
 * HERMES-CONTACT-PURPOSE-R1 — « Pourquoi tu me demande ça ».
 *
 * Le tour réel du 23 août 2026, et les huit façons de ne pas le trahir en le
 * réparant. Le défaut n'était pas une incompréhension : D2 avait rendu
 * `QUESTION` à 0,99. Il manquait deux choses, et deux seulement :
 *
 *   1. une VÉRITÉ — le dépôt ne portait nulle part le motif de son propre
 *      contact, donc la question tombait en `OTHER_QUESTION`, donc en
 *      `TOPIC_NOT_COVERED_BY_DATA`, donc en `HUMAN_ESCALATION` ;
 *
 *   2. un CHEMIN — le rédacteur qui écrivait le brouillon lu par le rail
 *      autonome ne recevait ni le registre observé, ni le budget de longueur du
 *      tour. Le contrôle de naturalité relevait donc `ADDRESS_MODE_MISMATCH` et
 *      `TOO_LONG` sur un texte que personne n'avait mis en position de réussir.
 *
 * Ce fichier vérifie les deux, et surtout tout ce qui NE DOIT PAS avoir bougé :
 * aucun seuil, aucune garde desserrée, aucune promesse ouverte, aucun second
 * effet possible. Entreprises et textes sont fictifs.
 */

const logger = createLogger({ test: 'contact-purpose-r1' });
const ROOT = resolve(__dirname, '..');
const MAILBOX = 'reponse@example.com';
const FIRST_TOUCH =
  'Bonjour, petite question : aujourd’hui, vous faites comment pour avoir régulièrement de ' +
  'nouvelles demandes ?';

/** Le message réel, à la lettre — sans « s », sans point d'interrogation. */
const REAL_TURN = 'Pourquoi tu me demande ça';

let sql: Sql;
let dir: string;
let campaignId: string;
let fixtures: ReplyFixtures;
let lastPrompt = '';

const SHORT_TU_ANSWER = {
  body: 'Je te demande ça parce que j’aide des boîtes de prestation standard sur leur acquisition.',
  rationale: 'Répond à la question, en tutoiement, sans rien promettre.',
  used_facts: [],
};

function makeRouter(answer: unknown = SHORT_TU_ANSWER): ModelRouter {
  const provider: LlmProvider = {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async (request) => {
      if (request.task !== 'message') {
        throw new LlmError(`tâche inattendue ${request.task}`, 'provider_error');
      }
      lastPrompt = request.prompt;
      return { text: JSON.stringify(answer) };
    },
  };
  return new ModelRouter({ sql, logger, providers: { codex: provider } });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-contact-purpose-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-contact-purpose-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
  fixtures = makeReplyFixtures(sql, { campaignId, mailbox: MAILBOX, firstTouch: FIRST_TOUCH });
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  lastPrompt = '';
});

let recipientCounter = 0;

async function newProspect(): Promise<ContactedProspect> {
  recipientCounter += 1;
  return fixtures.contactedProspect(`contact${String(recipientCounter)}@example.com`);
}

async function inboundTurn(
  prospect: ContactedProspect,
  body: string,
  category: ReplyCategory,
  hour: number,
  confidence = 0.99,
): Promise<{ context: ReplyContext; analysis: StoredAnalysis }> {
  const id = await fixtures.inbound({
    manifest: prospect.manifest,
    outreachEventId: prospect.outreachEventId,
    prospectId: prospect.prospectId,
    body,
    receivedAt: new Date(Date.UTC(2026, 7, 22, hour, 0, 0)).toISOString(),
  });

  const context = await loadReplyContext(sql, id);
  if (context === null) throw new Error('contexte introuvable');

  const decision = decideCategory({
    category,
    confidence,
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

/** Le fil réel du canari, rejoué : notre question, leur réponse, leur « pourquoi ». */
async function realCanaryThread(): Promise<{ context: ReplyContext; analysis: StoredAnalysis }> {
  const prospect = await newProspect();
  const first = await inboundTurn(prospect, 'Surtout via le bouche à oreille', 'INFORMATION_SHARED', 9);
  await approveOurReply(
    first.context,
    first.analysis,
    'Et ça t’en ramène assez régulièrement, ou ça dépend des mois ?',
  );
  return inboundTurn(prospect, REAL_TURN, 'QUESTION', 10);
}

// ---------------------------------------------------------------------------
// Outillage pur pour la décision d'autonomie
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

/**
 * Les faits d'autonomie pour un message donné, avec les VRAIES lectures.
 *
 * `readSignals`, `buildGrounding`, `decideReply`, `assessOfferProgression` et
 * `readCommercialDemands` sont exercées pour de bon : un test qui imiterait
 * leurs conclusions prouverait seulement qu'on sait recopier une réponse.
 */
function factsFor(
  body: string,
  overrides: { category?: ReplyCategory; draft?: AutonomousDraftFacts | null } = {},
): AutonomousReplyFacts {
  const category = overrides.category ?? 'QUESTION';
  const signals = readSignals(body, category, EMPTY_THREAD);
  const st = state();
  const grounding = buildGrounding(
    {
      prospect: { id: 'p1', displayName: 'Atelier Fictif', city: null },
      research: { observations: ['site actif'], opportunities: [] },
      angle: null,
      // HERMES-TRIAL-COST-VS-POST-TRIAL-PRICING-R1 — `buildGrounding` lit
      // désormais le message pour savoir de QUEL prix on parle. Un fixture qui
      // l'omettrait mesurerait autre chose que la production.
      reply: { bodyText: body },
    } as unknown as ReplyContext,
    signals,
  );

  return Object.freeze({
    policyVersion: CONVERSATION_POLICY_VERSION,
    commercialPolicyVersion: COMMERCIAL_POLICY_VERSION,
    commercialDemands: readCommercialDemands(body),
    appointmentQualification: 'POTENTIALLY_QUALIFIED' as const,
    correlation: 'HIGH_CONFIDENCE' as const,
    identityConfirmed: true,
    suppressed: false,
    outreachState: 'REPLIED' as const,
    terminalCategoryInThread: null,
    category,
    confidence: 0.99,
    signals,
    state: st,
    decision: decideReply({
      category,
      signals,
      state: st,
      groundingGaps: grounding.gaps,
      confidence: 0.99,
    }),
    groundingGaps: grounding.gaps,
    offer: assessOfferProgression({ category, signals, state: st }),
    newerInboundExists: false,
    burstSettled: true,
    draft: overrides.draft === undefined ? CLEAN_DRAFT : overrides.draft,
    minConfidence: 0.85,
  });
}

function samples(...texts: readonly string[]): StyleSample[] {
  return texts.map((text, index) => ({
    text,
    at: new Date(Date.UTC(2026, 7, 22, 9 + index, 0, 0)).toISOString(),
  }));
}

function naturalness(
  body: string,
  style: StyleProfile,
  lastInbound = REAL_TURN,
): readonly string[] {
  const signals = readSignals(lastInbound, 'QUESTION', EMPTY_THREAD);
  return checkNaturalness({
    body,
    lastInboundText: lastInbound,
    style,
    state: state(),
    signals,
    channel: 'instagram_dm',
    previousOutboundTexts: [],
  }).findings.map((finding) => finding.code);
}

// ---------------------------------------------------------------------------
// A / B — le motif de contact est devenu une vérité du dépôt
// ---------------------------------------------------------------------------

describe('A — « pourquoi tu me demandes ça » a désormais un sujet à elle', () => {
  it('lit CONTACT_PURPOSE sur le message réel, et sur ses variantes usuelles', () => {
    const asked = [
      REAL_TURN,
      'Pourquoi tu me demandes ça ?',
      'pourquoi vous me demandez ça',
      'pourquoi tu me contactes ?',
      'c’est pour quoi ?',
      'tu veux me proposer quoi ?',
      'pourquoi tu veux savoir ça',
      'vous cherchez quoi exactement ?',
    ];
    for (const body of asked) {
      expect(readSignals(body, 'QUESTION', EMPTY_THREAD).questionTopic).toBe('CONTACT_PURPOSE');
    }
  });

  it('le motif est versionné, et le bloc de prompt le porte', () => {
    expect(CONTACT_PURPOSE_VERSION).toBe('hermes-contact-purpose-r1');
    const block = renderContactPurposeBlock();
    expect(block).toContain(CONTACT_PURPOSE_VERSION);
    for (const fact of CONTACT_PURPOSE_FACTS) expect(block).toContain(fact);
  });

  it('le périmètre commercial autonome nomme désormais cette réponse', () => {
    expect(AUTONOMOUS_COMMERCIAL_SCOPE.some((entry) => entry.includes('POURQUOI'))).toBe(true);
  });
});

describe('B — la question ne tombe plus dans TOPIC_NOT_COVERED_BY_DATA', () => {
  it('aucun manque de grounding n’est ouvert par ce sujet', () => {
    const facts = factsFor(REAL_TURN);
    expect(facts.signals.questionTopic).toBe('CONTACT_PURPOSE');
    expect(facts.groundingGaps).not.toContain('TOPIC_NOT_COVERED_BY_DATA');
    expect(facts.decision.decision).toBe('DRAFT_FOR_HUMAN');
    expect(facts.decision.escalationReason).toBeNull();
  });

  it('la décision d’autonomie n’escalade plus sur `topic_not_covered`', () => {
    const decision = decideAutonomousReply(factsFor(REAL_TURN));
    expect(decision.reason).not.toBe('topic_not_covered');
    expect(decision.gate).not.toBe('grounding');
    expect(decision.outcome).toBe('AUTO_REPLY_ELIGIBLE');
  });

  it('une question SANS sujet reconnu escalade toujours, elle', () => {
    // La correction est un sujet de plus, jamais une porte retirée : ce qui
    // n'est réellement couvert par aucune donnée refuse comme avant.
    const decision = decideAutonomousReply(
      factsFor('Vous prenez quel type de véhicules en hivernage longue durée ?'),
    );
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(decision.reason).toBe('topic_not_covered');
  });
});

// ---------------------------------------------------------------------------
// C / D / E — le registre
// ---------------------------------------------------------------------------

describe('C — le dernier signal explicite décide du registre', () => {
  it('bascule au tutoiement quand le dernier tour tutoie franchement', () => {
    const profile = buildStyleProfile(
      samples('Bonjour, je regarde votre message', 'Surtout via le bouche à oreille', REAL_TURN),
    );
    expect(profile.addressMode).toBe('TU');
    const directive = renderStyleDirective(profile);
    expect(directive).toContain('Tutoie');
    expect(directive).toContain('« tu »');
  });

  it('un brouillon en « vous » reste refusé, un brouillon en « tu » passe', () => {
    const profile = buildStyleProfile(samples('Surtout via le bouche à oreille', REAL_TURN));
    expect(
      naturalness(
        'Je vous demande ça parce que j’aide des pros du prestation standard sur leur acquisition.',
        profile,
      ),
    ).toContain('ADDRESS_MODE_MISMATCH');
    expect(
      naturalness(
        'Je te demande ça parce que j’aide des boîtes de prestation standard sur leur acquisition.',
        profile,
      ),
    ).not.toContain('ADDRESS_MODE_MISMATCH');
  });
});

describe('D — un vouvoiement explicite reste un vouvoiement', () => {
  it('ne bascule pas au tutoiement parce qu’un vieux message tutoyait', () => {
    const profile = buildStyleProfile(
      samples('salut tu proposes quoi ?', 'Pourriez-vous me préciser votre offre, s’il vous plaît ?'),
    );
    expect(profile.addressMode).toBe('VOUS');
    expect(
      naturalness('Je te demande ça parce que j’aide des boîtes de prestation standard.', profile),
    ).toContain('ADDRESS_MODE_MISMATCH');
  });
});

describe('E — l’ambiguïté ne fait basculer personne', () => {
  it('un dernier message sans marqueur conserve le registre déjà établi', () => {
    const établi = buildStyleProfile(samples('Bonjour, que proposez-vous exactement ?', 'ok'));
    expect(établi.addressMode).toBe('VOUS');

    const tutoyé = buildStyleProfile(samples('salut, tu fais quoi exactement ?', 'ok'));
    expect(tutoyé.addressMode).toBe('TU');
  });

  it('un dernier message qui porte les DEUX registres ne tranche pas non plus', () => {
    const profile = buildStyleProfile(
      samples('salut, tu fais quoi ?', 'tu peux me dire ce que vous proposez ?'),
    );
    // Le dernier tour est à égalité (`tu` contre `vous`) : il ne renverse rien,
    // et c'est le tour d'avant qui reste.
    expect(resolveAddressMode(['tu peux me dire ce que vous proposez ?'])).toBe('UNKNOWN');
    expect(profile.addressMode).toBe('TU');
  });

  it('sans le moindre marqueur, le registre reste UNKNOWN et n’impose rien', () => {
    const profile = buildStyleProfile(samples('ok', 'merci'));
    expect(profile.addressMode).toBe('UNKNOWN');
    const directive = renderStyleDirective(profile);
    expect(directive).not.toContain('Tutoie');
    expect(directive).not.toContain('Vouvoie');
    // Et rien n'est reproché à un brouillon, dans un sens comme dans l'autre.
    expect(naturalness('Et ça te ramène des demandes ?', profile)).not.toContain(
      'ADDRESS_MODE_MISMATCH',
    );
    expect(naturalness('Et ça vous ramène des demandes ?', profile)).not.toContain(
      'ADDRESS_MODE_MISMATCH',
    );
  });
});

// ---------------------------------------------------------------------------
// F / G — ce que le motif n'autorise pas
// ---------------------------------------------------------------------------

describe('F — dire pourquoi on écrit n’ouvre aucune promesse et aucun prix', () => {
  it('le bloc lui-même ne porte ni chiffre, ni montant, ni promesse', () => {
    const block = renderContactPurposeBlock();
    expect(block).not.toMatch(/\d+\s*(?:€|%|euros?)/iu);
    expect(detectPerformanceClaims(block)).toHaveLength(0);
    expect(block).not.toMatch(/https?:\/\//iu);
  });

  it('un brouillon qui chiffre ou qui promet reste bloqué par les garde-fous', () => {
    const context = {
      reply: { bodyText: REAL_TURN },
      firstTouch: { body: FIRST_TOUCH },
      research: null,
    } as unknown as ReplyContext;

    const chiffré = checkReplyDraft(
      'Je te demande ça parce qu’on fait +40 % de demandes en plus pour 500 € par mois.',
      context,
    );
    expect(chiffré.some((flag) => flag.blocking)).toBe(true);

    // Et la même promesse au TUTOIEMENT — un trou réel, ouvert par ce round
    // même, puisque Hermes ne tutoyait pas avant lui.
    expect(
      detectPerformanceClaims('Je te demande ça parce que tu ne paies que si tu as des résultats.'),
    ).not.toHaveLength(0);
    expect(detectPerformanceClaims('Pendant le test tu ne paies rien.')).not.toHaveLength(0);
    expect(detectPerformanceClaims('Pendant le test vous ne payez rien.')).not.toHaveLength(0);
  });

  it('le motif n’affirme jamais que l’entreprise a un problème', () => {
    const block = renderContactPurposeBlock();
    expect(block).toContain('n’affirme pas');
    expect(block).toContain('rien ne l’a observé');
  });
});

describe('G — les demandes qui engagent escaladent exactement comme avant', () => {
  it('« combien ça coûte après les 7 jours ? » reste une demande de prix', () => {
    const decision = decideAutonomousReply(factsFor('Et combien ça coûte après les 7 jours ?'));
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(decision.reason).toBe('pricing_policy_missing');
  });

  it('une garantie demandée escalade toujours', () => {
    const decision = decideAutonomousReply(factsFor('Vous garantissez des résultats ?'));
    expect(decision.outcome).toBe('HUMAN_ESCALATION');
    expect(decision.reason).toBe('guarantee_requested');
  });
});

// ---------------------------------------------------------------------------
// H / I / J — ce qui ne se déclenche pas, et ce qui ne bouge pas
// ---------------------------------------------------------------------------

describe('H — une information partagée ne déclenche aucun pitch de motif', () => {
  it('le motif n’entre pas dans le prompt quand personne ne l’a demandé', () => {
    const signals = readSignals('Surtout via le bouche à oreille', 'INFORMATION_SHARED', EMPTY_THREAD);
    expect(signals.questionTopic).toBe('NONE');
    expect(contactPurposeDisclosure({ questionTopic: signals.questionTopic, humanNeeded: false })).toBe(
      'NOT_ASKED',
    );
  });

  it('il n’entre pas davantage quand un humain doit reprendre', () => {
    expect(contactPurposeDisclosure({ questionTopic: 'CONTACT_PURPOSE', humanNeeded: true })).toBe(
      'FORBIDDEN',
    );
  });
});

describe('I — `call_too_early` n’a pas bougé d’un cran', () => {
  it('un brouillon qui propose un échange sans maturité refuse toujours', () => {
    const facts = factsFor(REAL_TURN, { draft: { ...CLEAN_DRAFT, proposesCall: true } });
    const withLowReadiness: AutonomousReplyFacts = Object.freeze({
      ...facts,
      signals: Object.freeze({ ...facts.signals, callReadiness: 'LOW' }) as ConversationSignals,
    });
    const decision = decideAutonomousReply(withLowReadiness);
    // La porte reporte plutôt qu'elle n'escalade — c'est son comportement
    // d'origine, inchangé : la maturité peut monter d'elle-même au tour suivant.
    expect(decision.outcome).toBe('AUTO_REPLY_SKIP');
    expect(decision.reason).toBe('call_too_early');
    expect(decision.reconsiderable).toBe(true);
  });
});

describe('J — le contrôle de naturalité garde toutes ses protections', () => {
  const profile = buildStyleProfile(samples('Surtout via le bouche à oreille', REAL_TURN));

  it('l’ouverture générique reste bloquante', () => {
    expect(naturalness('Merci pour ton retour, je te demande ça pour comprendre.', profile)).toContain(
      'GENERIC_OPENING',
    );
  });

  it('le brouillon réel refusé le 23 août le serait encore', () => {
    const codes = naturalness(
      'Je vous demande ça parce qu’on aide des pros du prestation standard à structurer leur ' +
        'acquisition locale, et je voulais simplement savoir si le sujet pouvait être pertinent ' +
        'pour vous.',
      profile,
    );
    expect(codes).toContain('TOO_LONG');
    expect(codes).toContain('ADDRESS_MODE_MISMATCH');
  });

  it('le brouillon court et tutoyé, lui, ne relève rien de bloquant', () => {
    const codes = naturalness(SHORT_TU_ANSWER.body, profile);
    expect(codes).not.toContain('TOO_LONG');
    expect(codes).not.toContain('ADDRESS_MODE_MISMATCH');
    expect(codes).not.toContain('GENERIC_OPENING');
    expect(codes).not.toContain('CORPORATE_JARGON');
  });
});

// ---------------------------------------------------------------------------
// M — une seule vérité, une seule logique de registre
// ---------------------------------------------------------------------------

describe('M — production et test contrôlé partagent tout', () => {
  it('aucun module de motif ou de registre ne connaît la coquille', () => {
    const sources = [
      'src/lib/sales/contactPurpose.ts',
      'src/lib/conversation/signals.ts',
      'src/lib/conversation/style.ts',
      'src/lib/conversation/voice.ts',
    ];
    for (const relative of sources) {
      const source = readFileSync(resolve(ROOT, relative), 'utf8');
      expect(source).not.toContain('controlledSelfTest');
      expect(source).not.toContain('ControlledSelfTest');
      expect(source).not.toContain('operator_second_account');
    }
  });

  it('le rédacteur est unique : le traitement des réponses appelle le cerveau', () => {
    const source = readFileSync(resolve(ROOT, 'src/lib/replies/process.ts'), 'utf8');
    expect(source).toContain('buildConversationReply');
    expect(source).not.toContain('generateReplyDraft(');
  });
});

// ---------------------------------------------------------------------------
// K / L — replanifier sans jamais rejouer un effet
// ---------------------------------------------------------------------------

describe('K / L — une politique neuve rouvre la DÉCISION, jamais l’effet', () => {
  it('la clé d’un plan porte la compréhension ET les règles', () => {
    expect(deriveConversationPlanKey('AUTO_REPLY', 'p1', 'i1', 'a1', 'pol-r6')).toBe(
      'hermes-conv-r2/AUTO_REPLY/p1/i1#a1@pol-r6',
    );
    // Sans les composants, la clé reste celle d'hier, à l'octet près.
    expect(deriveConversationPlanKey('AUTO_REPLY', 'p1', 'i1')).toBe('hermes-conv-r2/AUTO_REPLY/p1/i1');
    expect(deriveConversationPlanKey('AUTO_REPLY', 'p1', 'i1', 'a1')).toBe(
      'hermes-conv-r2/AUTO_REPLY/p1/i1#a1',
    );
  });

  it('un tour refusé sous une politique périmée peut être replanifié', async () => {
    const turn = await realCanaryThread();
    const prospectId = turn.context.prospect.id;

    const base = {
      prospectId,
      channel: 'email' as const,
      kind: 'AUTO_REPLY' as const,
      triggerInboundMessageId: turn.context.reply.id,
      understandingRef: turn.analysis.id,
      commercialPolicyVersion: COMMERCIAL_POLICY_VERSION,
      brainVersion: conversationPromptVersionFor('email'),
      decisionGate: 'grounding',
      decisionDetail: 'test',
      conversationWatermark: null,
      naturalnessVerdict: null,
      groundingGaps: Object.freeze([]),
      offerReadiness: 'LOW' as const,
      callReadiness: 'LOW' as const,
      notBefore: new Date('2026-08-23T12:00:00.000Z'),
    };

    const hier = await recordConversationPlan(sql, {
      ...base,
      policyRef: 'hermes-conversation-r5',
      policyVersion: 'hermes-conversation-r5',
      decision: 'HUMAN_ESCALATION',
      decisionReason: 'topic_not_covered',
      body: null,
    });
    expect(hier.created).toBe(true);

    const aujourdHui = await recordConversationPlan(sql, {
      ...base,
      policyRef: CONVERSATION_POLICY_VERSION,
      policyVersion: CONVERSATION_POLICY_VERSION,
      decision: 'AUTO_REPLY_ELIGIBLE',
      decisionReason: null,
      body: SHORT_TU_ANSWER.body,
    });
    expect(aujourdHui.created).toBe(true);
    expect(aujourdHui.plan.id).not.toBe(hier.plan.id);
    expect(aujourdHui.plan.decision).toBe('AUTO_REPLY_ELIGIBLE');

    // L'historique reste : le plan d'hier garde son motif et sa version.
    const rows = await sql.query<{ id: string; decisionReason: string | null; policyVersion: string }>(
      `select id, decision_reason as "decisionReason", policy_version as "policyVersion"
         from hermes_conversation_plans where id = $1`,
      [hier.plan.id],
    );
    expect(rows[0]?.decisionReason).toBe('topic_not_covered');
    expect(rows[0]?.policyVersion).toBe('hermes-conversation-r5');
  });

  it('un déclencheur qui porte un effet TENTÉ ne se replanifie JAMAIS', async () => {
    const turn = await realCanaryThread();
    const prospectId = turn.context.prospect.id;

    const base = {
      prospectId,
      channel: 'email' as const,
      kind: 'AUTO_REPLY' as const,
      triggerInboundMessageId: turn.context.reply.id,
      understandingRef: turn.analysis.id,
      commercialPolicyVersion: COMMERCIAL_POLICY_VERSION,
      brainVersion: conversationPromptVersionFor('email'),
      decisionGate: 'test',
      decisionDetail: 'test',
      conversationWatermark: null,
      naturalnessVerdict: null,
      groundingGaps: Object.freeze([]),
      offerReadiness: 'LOW' as const,
      callReadiness: 'LOW' as const,
      notBefore: new Date('2026-08-23T12:00:00.000Z'),
    };

    const parti = await recordConversationPlan(sql, {
      ...base,
      policyRef: 'hermes-conversation-r5',
      policyVersion: 'hermes-conversation-r5',
      decision: 'AUTO_REPLY_ELIGIBLE',
      decisionReason: null,
      body: 'un texte déjà tenté',
    });
    await sql.query(
      `update hermes_conversation_plans
          set external_effect_attempted = true, external_effect_started_at = now(),
              status = 'AMBIGUOUS', terminated_at = now()
        where id = $1`,
      [parti.plan.id],
    );

    const rejoué = await recordConversationPlan(sql, {
      ...base,
      policyRef: CONVERSATION_POLICY_VERSION,
      policyVersion: CONVERSATION_POLICY_VERSION,
      decision: 'AUTO_REPLY_ELIGIBLE',
      decisionReason: null,
      body: SHORT_TU_ANSWER.body,
    });

    expect(rejoué.created).toBe(false);
    expect(rejoué.plan.id).toBe(parti.plan.id);
    expect(rejoué.plan.externalEffectAttempted).toBe(true);

    const count = await sql.query<{ n: string }>(
      `select count(*)::text as n from hermes_conversation_plans
        where trigger_inbound_message_id = $1`,
      [turn.context.reply.id],
    );
    expect(Number(count[0]!.n)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Le tour réel, de bout en bout, sans envoi
// ---------------------------------------------------------------------------

describe('le tour réel traverse le cerveau et reçoit ce qu’il lui fallait', () => {
  it('comprend, tutoie, et met le motif sous les yeux du modèle', async () => {
    const turn = await realCanaryThread();
    const understanding = await understandConversation(sql, turn.context, turn.analysis);

    expect(understanding.signals.questionTopic).toBe('CONTACT_PURPOSE');
    expect(understanding.state.goal).toBe('ANSWER_QUESTION');
    expect(understanding.grounding.gaps).not.toContain('TOPIC_NOT_COVERED_BY_DATA');
    expect(understanding.style.addressMode).toBe('TU');
    expect(understanding.contactPurpose).toBe('ALLOWED');
    expect(understanding.decision.shouldDraft).toBe(true);

    const reply = await buildConversationReply(sql, makeRouter(), turn.context, turn.analysis);

    expect(lastPrompt).toContain(CONTACT_PURPOSE_VERSION);
    expect(lastPrompt).toContain('Tutoie');
    expect(reply.draft?.promptVersion).toBe(conversationPromptVersionFor('email'));
    expect(reply.naturalness?.verdict).not.toBe('UNNATURAL');
    expect(reply.draft?.blocked).toBe(false);
    // Rien ne part : la décision conversationnelle ne porte aucun envoi.
    expect(reply.decision.autoSendAllowed).toBe(false);
  });

  it('un tour SANS question ne voit pas le bloc du motif', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(prospect, 'Surtout via le bouche à oreille', 'INFORMATION_SHARED', 9);
    const understanding = await understandConversation(sql, turn.context, turn.analysis);
    expect(understanding.contactPurpose).toBe('NOT_ASKED');

    await buildConversationReply(sql, makeRouter(), turn.context, turn.analysis);
    expect(lastPrompt).not.toContain(CONTACT_PURPOSE_VERSION);
  });
});

// ---------------------------------------------------------------------------
// La régénération d'un brouillon : une version, un texte, jamais un écrasement
// ---------------------------------------------------------------------------

describe('un rédacteur corrigé peut réécrire — sans effacer ce qui existait', () => {
  it('un prompt neuf écrit un brouillon À CÔTÉ de l’ancien', async () => {
    const turn = await realCanaryThread();

    const ancien = await persistDraft(sql, turn.context, turn.analysis, {
      body: 'Je vous demande ça parce qu’on aide des pros du prestation standard.',
      bodySha256: 'c'.repeat(64),
      rationale: 'ancien rédacteur',
      guardrailFlags: [],
      blocked: false,
      model: 'legacy-model',
      effort: null,
      promptVersion: 'ig5-draft-1',
      modelRunId: null,
    });
    expect(ancien.created).toBe(true);

    const neuf = await persistDraft(sql, turn.context, turn.analysis, {
      body: SHORT_TU_ANSWER.body,
      bodySha256: 'd'.repeat(64),
      rationale: 'cerveau',
      guardrailFlags: [],
      blocked: false,
      model: 'test-model',
      effort: null,
      promptVersion: conversationPromptVersionFor('email'),
      modelRunId: null,
    });
    expect(neuf.created).toBe(true);
    expect(neuf.draft.id).not.toBe(ancien.draft.id);

    // Le texte qui fait foi est le plus récent, l'ancien reste lisible.
    const retenu = await loadDraftForAnalysis(sql, turn.analysis.id);
    expect(retenu?.id).toBe(neuf.draft.id);
    const rows = await sql.query<{ n: string }>(
      `select count(*)::text as n from r6b_reply_drafts where analysis_id = $1`,
      [turn.analysis.id],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('le MÊME prompt ne produit toujours qu’un seul brouillon', async () => {
    const turn = await realCanaryThread();
    const spec = {
      body: SHORT_TU_ANSWER.body,
      bodySha256: 'e'.repeat(64),
      rationale: 'cerveau',
      guardrailFlags: [],
      blocked: false,
      model: 'test-model',
      effort: null,
      promptVersion: conversationPromptVersionFor('email'),
      modelRunId: null,
    };
    const first = await persistDraft(sql, turn.context, turn.analysis, spec);
    const second = await persistDraft(sql, turn.context, turn.analysis, spec);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.draft.id).toBe(first.draft.id);
  });

  it('la parole d’un humain l’emporte sur une génération plus récente', async () => {
    const turn = await realCanaryThread();
    const relu = await persistDraft(sql, turn.context, turn.analysis, {
      body: 'Le texte qu’un opérateur a validé.',
      bodySha256: 'f'.repeat(64),
      rationale: 'ancien rédacteur',
      guardrailFlags: [],
      blocked: false,
      model: 'legacy-model',
      effort: null,
      promptVersion: 'ig5-draft-1',
      modelRunId: null,
    });
    await reviewDraft(sql, { draftId: relu.draft.id, decision: 'APPROVE', reviewedBy: 'un opérateur' });

    await persistDraft(sql, turn.context, turn.analysis, {
      body: SHORT_TU_ANSWER.body,
      bodySha256: '0'.repeat(64),
      rationale: 'cerveau',
      guardrailFlags: [],
      blocked: false,
      model: 'test-model',
      effort: null,
      promptVersion: conversationPromptVersionFor('email'),
      modelRunId: null,
    });

    const retenu = await loadDraftForAnalysis(sql, turn.analysis.id);
    expect(retenu?.id).toBe(relu.draft.id);
    expect(retenu?.status).toBe('APPROVED');
  });
});
