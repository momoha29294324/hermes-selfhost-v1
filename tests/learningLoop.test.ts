import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildConversationReply } from '@/lib/conversation/brain';
import { EMPTY_STYLE_PROFILE } from '@/lib/conversation/style';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import type { Sql } from '@/lib/db/sql';
import { createLogger } from '@/lib/logging/logger';
import { ModelRouter } from '@/lib/models/router';
import type { LlmProvider } from '@/lib/models/types';
import { buildTurnFeedback, recordOverrides, type OverridePair } from '@/lib/learning/feedback';
import { buildExemplarBank } from '@/lib/learning/exemplars';
import { buildLearningInjection, renderLearningBlock } from '@/lib/learning/injection';
import { segmentBy, stageMetricsFor, type OutcomeRow } from '@/lib/learning/metrics';
import { assessOfferReadiness, detectPerformanceClaims } from '@/lib/learning/offer';
import {
  compareProgression,
  deriveOutcome,
  funnelRank,
  STAGE_OBSERVABILITY,
  unobservableStages,
  type ProspectOutcome,
} from '@/lib/learning/outcome';
import { compareOverride } from '@/lib/learning/override';
import { buildProposal, ForbiddenClaimError } from '@/lib/learning/proposal';
import { readOnlySql } from '@/lib/learning/readOnly';
import { buildLearningReport } from '@/lib/learning/report';
import { renderLearningReport } from '@/lib/learning/render';
import { rate } from '@/lib/learning/sufficiency';
import {
  buildPreSendFeatures,
  latestBefore,
  messageFamilyOf,
  type PreSendFeatures,
} from '@/lib/learning/targeting';
import { buildOperatorStyleProfile } from '@/lib/learning/voiceProfile';
import { persistAnalysis, type StoredAnalysis } from '@/lib/replies/analyses';
import { loadReplyContext, type ReplyContext } from '@/lib/replies/context';
import { persistDraft, reviewDraft } from '@/lib/replies/draft';
import { decideCategory, detectUnsubscribeDemand, resolveNextAction, type ReplyCategory } from '@/lib/replies/taxonomy';
import { makeReplyFixtures, type ContactedProspect, type ReplyFixtures } from './support/replyFixture';

/**
 * LEARNING-R1 §25 — la boucle d'apprentissage, sur une vraie base.
 *
 * Aucun test n'ouvre de connexion réseau et aucun n'appelle un vrai modèle : la
 * boucle est entièrement déterministe, et le seul endroit où un modèle
 * intervient (le cerveau conversationnel, pour §25.27) reçoit un faux provider
 * injecté dans le VRAI `ModelRouter`.
 *
 * Entreprises, adresses et textes sont fictifs.
 */

const logger = createLogger({ test: 'learning-r1' });
const MAILBOX = 'reponse@example.com';
const FIRST_TOUCH =
  'Bonjour, j’ai vu que vous faisiez du prestation standard à domicile. Comment vos clients vous trouvent aujourd’hui ?';

let sql: Sql;
let dir: string;
let campaignId: string;
let fixtures: ReplyFixtures;
let recipientCounter = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-learning-r1-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-learning-r1-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
  fixtures = makeReplyFixtures(sql, { campaignId, mailbox: MAILBOX, firstTouch: FIRST_TOUCH });
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

async function newProspect(): Promise<ContactedProspect> {
  recipientCounter += 1;
  return fixtures.contactedProspect(`contact${recipientCounter}@example.com`);
}

async function inboundTurn(
  prospect: ContactedProspect,
  body: string,
  category: ReplyCategory,
  at: string,
): Promise<{ context: ReplyContext; analysis: StoredAnalysis }> {
  const id = await fixtures.inbound({
    manifest: prospect.manifest,
    outreachEventId: prospect.outreachEventId,
    prospectId: prospect.prospectId,
    body,
    receivedAt: at,
  });
  const context = await loadReplyContext(sql, id);
  if (context === null) throw new Error('contexte introuvable');
  const decision = decideCategory({
    category,
    confidence: 0.9,
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
    inputSha256: createHash('sha256').update(`${id}:${category}`).digest('hex'),
    modelRunId: null,
  });
  return { context, analysis: persisted.analysis };
}

/** Écrit un brouillon Hermes, puis la décision humaine dessus. */
async function humanReply(
  context: ReplyContext,
  analysis: StoredAnalysis,
  draftBody: string,
  humanBody: string | null,
): Promise<string> {
  const persisted = await persistDraft(sql, context, analysis, {
    body: draftBody,
    bodySha256: createHash('sha256').update(draftBody).digest('hex'),
    rationale: 'brouillon de test',
    guardrailFlags: [],
    blocked: false,
    model: 'test-model',
    effort: null,
    promptVersion: 'test-1',
    modelRunId: null,
  });
  await reviewDraft(sql, {
    draftId: persisted.draft.id,
    decision: humanBody === null ? 'APPROVE' : 'EDIT',
    reviewedBy: 'test',
    ...(humanBody === null ? {} : { text: humanBody }),
  });
  return persisted.draft.id;
}

const FEATURES: PreSendFeatures = Object.freeze({
  prospectId: 'p',
  sentAt: '2026-08-01T00:00:00.000Z',
  channel: 'instagram_dm',
  score: 70,
  scoreBand: 'A',
  followers: 900,
  audienceBucket: 'FROM_500_TO_2K',
  websitePresence: true,
  googlePresence: null,
  icpVerdict: 'GOOD_ICP',
  nicheVerdict: 'IN_NICHE',
  identityReview: null,
  hasAngle: true,
  messageFamily: 'QUESTION_OPENER',
  niche: 'example-services',
  zone: '33',
});

function featuresWith(overrides: Partial<PreSendFeatures>): PreSendFeatures {
  return Object.freeze({ ...FEATURES, ...overrides });
}

function outcomeAt(stage: ProspectOutcome['stage'], prospectId: string): ProspectOutcome {
  return Object.freeze({
    prospectId,
    channel: 'instagram_dm',
    manifestId: null,
    firstSentAt: '2026-08-01T00:00:00.000Z',
    stage,
    terminal: null,
    source: 'INBOUND_OBSERVATION' as const,
    inboundCount: stage === 'NO_REPLY' ? 0 : 1,
    inboundBursts: stage === 'NO_REPLY' ? 0 : 1,
    firstReplyAt: null,
    firstReplyLatencyMs: null,
    outreachState: null,
    classifications: Object.freeze([]),
  });
}

// ===========================================================================
// §25.1 à §25.7 — la correction humaine, lue en abstrait
// ===========================================================================

describe('§25.1 — un brouillon et le texte retenu sont reliés', () => {
  it('relie chaque couple à sa ligne canonique, sans copier de texte', () => {
    const pairs: OverridePair[] = [
      {
        source: 'REPLY_DRAFT',
        prospectId: 'p1',
        referenceId: 'draft-1',
        at: '2026-08-02T10:00:00.000Z',
        draftBody: 'Je comprends. Quels sont vos objectifs actuels ?',
        sentBody: 'Et ça vous ramène déjà pas mal de demandes ou pas vraiment ?',
      },
    ];
    const records = recordOverrides(pairs);
    expect(records).toHaveLength(1);
    expect(records[0]!.referenceId).toBe('draft-1');
    expect(records[0]!.source).toBe('REPLY_DRAFT');
    // Le texte n'a pas survécu à l'appel : seul un objet de mesures sort.
    expect(JSON.stringify(records)).not.toContain('objectifs actuels');
  });
});

describe('§25.2 — un tour sans brouillon reste un retour valide', () => {
  it('produit un feedback complet avec override null', () => {
    const turns = buildTurnFeedback({
      prospectId: 'p1',
      channel: 'instagram_dm',
      turns: [
        {
          id: 'in-1',
          receivedAt: '2026-08-02T10:00:00.000Z',
          bodyText: 'Bonjour, principalement mon site internet et ma fiche Google',
          classification: 'OTHER',
          confidence: 0.8,
          draftId: null,
          override: null,
          humanTextObservability: 'NOT_OBSERVABLE',
        },
      ],
      coveredTopics: [],
      stageReached: 'REPLIED',
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]!.override).toBeNull();
    expect(turns[0]!.draftId).toBeNull();
    expect(turns[0]!.humanTextObservability).toBe('NOT_OBSERVABLE');
    expect(turns[0]!.offerReadiness).toBeDefined();
  });
});

describe('§25.3 — « plus court » est détecté', () => {
  it('signale SHORTER au-delà du bruit, et rien en deçà', () => {
    const long = 'Merci pour votre retour. Je me permets de revenir vers vous afin de comprendre vos objectifs.';
    const short = 'Et ça vous ramène des demandes ?';
    expect(compareOverride(long, short).deltas).toContain('SHORTER');

    // Une retouche d'un caractère n'est pas une préférence de longueur.
    const almost = `${long}.`;
    expect(compareOverride(long, almost).deltas).not.toContain('LONGER');
  });
});

describe('§25.4 — le retrait d’une ouverture générique est détecté', () => {
  it('voit disparaître le réflexe d’accusé de réception', () => {
    const withOpening = 'Merci pour votre retour, je note bien votre situation actuelle.';
    const without = 'Vous tournez surtout grâce au bouche-à-oreille alors.';
    expect(compareOverride(withOpening, without).deltas).toContain('GENERIC_OPENING_REMOVED');
  });
});

describe('§25.5 — un changement de nombre de questions est détecté', () => {
  it('compte les questions dans les deux sens', () => {
    const two = 'Vous travaillez sur quelle zone ? Et depuis combien de temps ?';
    const one = 'Vous travaillez sur quelle zone ?';
    expect(compareOverride(two, one).deltas).toContain('QUESTIONS_REMOVED');
    expect(compareOverride(one, two).deltas).toContain('QUESTIONS_ADDED');
  });
});

describe('§25.6 — le retrait d’un argumentaire est détecté', () => {
  it('voit disparaître le pitch', () => {
    const pitched = 'On aide les pros du atelier à avoir un flux régulier de demandes qualifiées chaque mois.';
    const plain = 'Vous en refusez déjà pas mal alors ?';
    expect(compareOverride(pitched, plain).deltas).toContain('PITCH_REMOVED');
  });
});

describe('§25.7 — un passage du vouvoiement au tutoiement est détecté', () => {
  it('lit le mode d’adresse dans les deux sens', () => {
    const vous = 'Vous avez déjà essayé de passer par des campagnes ciblées de votre côté ?';
    const tu = 'Tu as déjà essayé de passer par des campagnes ciblées de ton côté ?';
    expect(compareOverride(vous, tu).deltas).toContain('ADDRESS_MODE_TO_TU');
    expect(compareOverride(tu, vous).deltas).toContain('ADDRESS_MODE_TO_VOUS');
  });
});

// ===========================================================================
// §25.8 à §25.11 — la suite de la conversation, et son issue
// ===========================================================================

describe('§25.8 / §25.10 — la réponse suivante est reliée, tôt comme tard', () => {
  it('relie le tour suivant et mesure son délai', () => {
    const turns = buildTurnFeedback({
      prospectId: 'p1',
      channel: 'instagram_dm',
      turns: [
        {
          id: 'in-1',
          receivedAt: '2026-08-02T10:00:00.000Z',
          bodyText: 'oui pourquoi pas',
          classification: 'INTERESTED',
          confidence: 0.9,
          draftId: null,
          override: null,
          humanTextObservability: 'NOT_OBSERVABLE',
        },
        {
          id: 'in-2',
          // Onze jours plus tard : une réponse tardive reste une réponse.
          receivedAt: '2026-08-13T10:00:00.000Z',
          bodyText: 'et niveau prix ?',
          classification: 'QUESTION',
          confidence: 0.9,
          draftId: null,
          override: null,
          humanTextObservability: 'NOT_OBSERVABLE',
        },
      ],
      coveredTopics: [],
      stageReached: 'ENGAGED',
    });
    expect(turns[0]!.nextInboundMessageId).toBe('in-2');
    expect(turns[0]!.nextClassification).toBe('QUESTION');
    expect(turns[0]!.nextReplyLatencyMs).toBe(11 * 24 * 60 * 60 * 1000);
    expect(turns[1]!.nextInboundMessageId).toBeNull();
    expect(turns[1]!.nextReplyLatencyMs).toBeNull();
  });
});

describe('§25.9 — l’absence de réponse est un fait, pas un trou', () => {
  it('rend NO_REPLY sans latence inventée', () => {
    const outcome = deriveOutcome({
      prospectId: 'p1',
      channel: 'instagram_dm',
      manifestId: null,
      firstSentAt: '2026-08-01T09:00:00.000Z',
      inboundAt: [],
      outreachState: 'CONTACTED',
      classifications: [],
      callProposedInValidatedReply: false,
      crmStage: null,
    });
    expect(outcome.stage).toBe('NO_REPLY');
    expect(outcome.firstReplyAt).toBeNull();
    expect(outcome.firstReplyLatencyMs).toBeNull();
    expect(outcome.inboundBursts).toBe(0);
  });

  it('distingue une salve unique d’un vrai échange', () => {
    const burst = deriveOutcome({
      prospectId: 'p2',
      channel: 'instagram_dm',
      manifestId: null,
      firstSentAt: '2026-08-01T09:00:00.000Z',
      // Trois bulles en une minute : Instagram encourage ce geste, ce n'est pas
      // une conversation engagée.
      inboundAt: ['2026-08-01T10:00:00.000Z', '2026-08-01T10:00:20.000Z', '2026-08-01T10:00:40.000Z'],
      outreachState: null,
      classifications: [],
      callProposedInValidatedReply: false,
      crmStage: null,
    });
    expect(burst.inboundBursts).toBe(1);
    expect(burst.stage).toBe('REPLIED');

    const engaged = deriveOutcome({
      prospectId: 'p3',
      channel: 'instagram_dm',
      manifestId: null,
      firstSentAt: '2026-08-01T09:00:00.000Z',
      inboundAt: ['2026-08-01T10:00:00.000Z', '2026-08-01T11:30:00.000Z'],
      outreachState: null,
      classifications: [],
      callProposedInValidatedReply: false,
      crmStage: null,
    });
    expect(engaged.inboundBursts).toBe(2);
    expect(engaged.stage).toBe('ENGAGED');
  });
});

describe('§25.11 — un client gagné passe devant une simple réponse', () => {
  it('ordonne les barreaux, et le gain l’emporte', () => {
    expect(funnelRank('CLIENT_WON')).toBeGreaterThan(funnelRank('REPLIED'));
    expect(funnelRank('CALL_BOOKED')).toBeGreaterThan(funnelRank('INTERESTED'));
    expect(compareProgression(outcomeAt('CLIENT_WON', 'a'), outcomeAt('REPLIED', 'b'))).toBeGreaterThan(0);
  });

  it('ne redescend pas un prospect qui a intéressé puis refusé', () => {
    const outcome = deriveOutcome({
      prospectId: 'p1',
      channel: 'instagram_dm',
      manifestId: null,
      firstSentAt: '2026-08-01T09:00:00.000Z',
      inboundAt: ['2026-08-01T10:00:00.000Z', '2026-08-02T10:00:00.000Z'],
      outreachState: 'NOT_INTERESTED',
      classifications: ['INTERESTED', 'NOT_INTERESTED'],
      callProposedInValidatedReply: false,
      crmStage: null,
    });
    expect(outcome.stage).toBe('INTERESTED');
    expect(outcome.terminal).toBe('LOST');
  });
});

// ===========================================================================
// §25.12 — le taux de réponse n'est pas le KPI
// ===========================================================================

describe('§25.12 — un segment qui répond beaucoup mais n’avance pas passe derrière', () => {
  it('classe sur la progression, pas sur le taux de réponse', () => {
    const bavard: OutcomeRow[] = Array.from({ length: 10 }, (_unused, index) => ({
      features: featuresWith({ messageFamily: 'PITCH_LED', prospectId: `bavard-${index}` }),
      outcome: outcomeAt(index < 8 ? 'REPLIED' : 'NO_REPLY', `bavard-${index}`),
    }));
    const efficace: OutcomeRow[] = Array.from({ length: 10 }, (_unused, index) => ({
      features: featuresWith({ messageFamily: 'QUESTION_OPENER', prospectId: `efficace-${index}` }),
      outcome: outcomeAt(index < 3 ? 'INTERESTED' : 'NO_REPLY', `efficace-${index}`),
    }));

    const segments = segmentBy([...bavard, ...efficace], 'messageFamily');
    const pitch = segments.find((segment) => segment.value === 'PITCH_LED')!;
    const question = segments.find((segment) => segment.value === 'QUESTION_OPENER')!;

    // Le bavard répond plus souvent…
    expect(pitch.stages.find((stage) => stage.stage === 'REPLIED')!.rate.value).toBeGreaterThan(
      question.stages.find((stage) => stage.stage === 'REPLIED')!.rate.value!,
    );
    // …et se retrouve pourtant derrière au classement.
    expect(segments[0]!.value).toBe('QUESTION_OPENER');
    expect(question.meanProgression).toBeGreaterThan(pitch.meanProgression);
  });
});

// ===========================================================================
// §25.13, §25.14, §25.28, §25.29 — l'effectif
// ===========================================================================

describe('§25.13 — un succès sur un n’est jamais un signal', () => {
  it('rend INSUFFICIENT_DATA sur 1/1', () => {
    const value = rate(1, 1);
    expect(value.value).toBe(1);
    expect(value.status).toBe('INSUFFICIENT_DATA');
    // Et l'intervalle le dit aussi : il descend très bas.
    expect(value.interval!.lower).toBeLessThan(0.3);
  });
});

describe('§25.14 — un effectif suffisant et cohérent produit un signal', () => {
  it('monte en EARLY_SIGNAL puis SUPPORTED_SIGNAL', () => {
    expect(rate(3, 12).status).toBe('EARLY_SIGNAL');
    expect(rate(1, 40).status).toBe('SUPPORTED_SIGNAL');
    // Un effectif large mais un intervalle large reste EARLY_SIGNAL.
    expect(rate(15, 30).status).toBe('EARLY_SIGNAL');
  });
});

describe('§25.28 / §25.29 — une recommandation montre son n et sa confiance', () => {
  it('porte toujours effectif, intervalle et fenêtre', () => {
    const proposal = buildProposal({
      type: 'TARGETING',
      status: 'EARLY_SIGNAL',
      sampleSize: 12,
      proposal: 'Les messages ouverts par une question avancent plus loin.',
      evidence: {
        metric: 'message_family_progression',
        rate: rate(2, 12),
        references: [],
        range: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-21T00:00:00.000Z' },
      },
    });
    expect(proposal.kind).toBe('LEARNING_PROPOSAL');
    expect(proposal.requiresHumanDecision).toBe(true);
    expect(proposal.sampleSize).toBe(12);
    expect(proposal.evidence.rate!.interval).not.toBeNull();
    expect(proposal.evidence.range.from).not.toBeNull();
  });
});

// ===========================================================================
// §25.15, §25.16 — les features d'AVANT
// ===========================================================================

describe('§25.15 / §25.16 — la segmentation ne lit que l’avant-envoi', () => {
  it('ignore une valeur écrite après le départ du message', () => {
    const rows = [
      { at: '2026-07-01T00:00:00.000Z', value: { total: 40, band: 'C' } },
      { at: '2026-09-01T00:00:00.000Z', value: { total: 95, band: 'A' } },
    ];
    expect(latestBefore(rows, '2026-08-01T00:00:00.000Z')).toEqual({ total: 40, band: 'C' });
  });

  it('rend null quand rien n’avait été écrit avant', () => {
    expect(latestBefore([{ at: '2026-09-01T00:00:00.000Z', value: 1 }], '2026-08-01T00:00:00.000Z')).toBeNull();
  });

  it('n’invente pas une absence de site faute d’avoir regardé', () => {
    const features = buildPreSendFeatures({
      prospectId: 'p1',
      sentAt: '2026-08-01T00:00:00.000Z',
      channel: 'instagram_dm',
      approvedText: FIRST_TOUCH,
      scores: [{ at: '2026-09-01T00:00:00.000Z', value: { total: 95, band: 'A' } }],
      audience: [],
      icp: [],
      classifications: [],
      angles: [],
      evidenceFields: [],
      identityReview: null,
      niche: 'example-services',
      zone: '33',
    });
    // Le score postérieur n'a pas fui…
    expect(features.score).toBeNull();
    expect(features.scoreBand).toBeNull();
    // …et « pas d'evidence » n'est pas « pas de site ».
    expect(features.websitePresence).toBeNull();
    expect(features.googlePresence).toBeNull();
    expect(features.audienceBucket).toBeNull();
  });
});

// ===========================================================================
// §25.17 — ce qu'on ne sait pas reste inconnu
// ===========================================================================

describe('§25.17 — un résultat commercial non observable reste inconnu', () => {
  it('n’émet jamais CALL_BOOKED ni CLIENT_WON', () => {
    expect(unobservableStages()).toEqual(['CALL_BOOKED', 'CLIENT_WON']);
    expect(STAGE_OBSERVABILITY.CLIENT_WON.level).toBe('NOT_OBSERVABLE');

    const outcome = deriveOutcome({
      prospectId: 'p1',
      channel: 'instagram_dm',
      manifestId: null,
      firstSentAt: '2026-08-01T09:00:00.000Z',
      inboundAt: ['2026-08-01T10:00:00.000Z', '2026-08-02T10:00:00.000Z'],
      outreachState: 'INTERESTED',
      classifications: ['INTERESTED'],
      callProposedInValidatedReply: true,
      crmStage: null,
    });
    expect(outcome.stage).toBe('CALL_PROPOSED');
    expect(funnelRank(outcome.stage)).toBeLessThan(funnelRank('CALL_BOOKED'));
  });

  it('n’affiche jamais « 0 % » sur un barreau sans source', () => {
    const metrics = stageMetricsFor([outcomeAt('REPLIED', 'a'), outcomeAt('REPLIED', 'b')]);
    const won = metrics.find((metric) => metric.stage === 'CLIENT_WON')!;
    expect(won.observability).toBe('NOT_OBSERVABLE');
    expect(won.rate.denominator).toBe(0);
    expect(won.rate.value).toBeNull();
  });

  it('marque l’issue commerciale d’un exemplar comme UNKNOWN', () => {
    const bank = buildExemplarBank([
      {
        outcome: {
          ...outcomeAt('ENGAGED', 'p1'),
          inboundBursts: 3,
        },
        turns: buildTurnFeedback({
          prospectId: 'p1',
          channel: 'instagram_dm',
          turns: [
            {
              id: 'in-1',
              receivedAt: '2026-08-02T10:00:00.000Z',
              bodyText: 'oui pourquoi pas',
              classification: 'INTERESTED',
              confidence: 0.9,
              draftId: null,
              override: null,
              humanTextObservability: 'NOT_OBSERVABLE',
            },
          ],
          coveredTopics: [],
          stageReached: 'ENGAGED',
        }),
        prospectStyle: EMPTY_STYLE_PROFILE,
        messageFamily: 'QUESTION_OPENER',
      },
    ]);
    expect(bank).toHaveLength(1);
    expect(bank[0]!.commercialOutcome).toBe('UNKNOWN');
  });
});

// ===========================================================================
// §25.30 — la maturité pour l'offre n'écrit aucune promesse
// ===========================================================================

describe('§25.30 — la maturité observe, elle ne promet rien', () => {
  it('ne rend aucun texte, et jamais une autorisation', () => {
    const assessment = assessOfferReadiness({
      category: 'QUESTION',
      signals: {
        questionTopic: 'PRICE',
        objectionTopic: 'NONE',
        buyingSignal: 'WEAK',
        callReadiness: 'MEDIUM',
        sensitiveFlags: [],
        explicitCallRequest: false,
        tooShortToRead: false,
      },
      coveredTopics: [],
    });
    expect(assessment.readiness).toBe('HIGH');
    expect(assessment.performanceModelMentionAllowed).toBe(false);
    // Le type ne porte pas de texte : rien de commercial ne peut en sortir.
    expect(Object.keys(assessment).sort()).toEqual([
      'performanceModelMentionAllowed',
      'readiness',
      'reasons',
    ]);
    expect(detectPerformanceClaims(assessment.reasons.join(' '))).toEqual([]);
  });

  it('refuse de construire une proposition qui promet', () => {
    expect(() =>
      buildProposal({
        type: 'OFFER_TIMING',
        status: 'EARLY_SIGNAL',
        sampleSize: 12,
        proposal: 'Dire au prospect qu’il ne paye que si ça marche.',
        evidence: { metric: 'x', rate: null, references: [], range: { from: null, to: null } },
      }),
    ).toThrow(ForbiddenClaimError);
  });

  it('reconnaît les promesses que les garde-fous existants ne couvrent pas', () => {
    expect(detectPerformanceClaims('aucun risque pour vous')).toContain('aucun risque');
    expect(detectPerformanceClaims('vous ne payez que si vous gagnez')).toContain('vous ne payez que si');
    expect(detectPerformanceClaims('on part sur un test de deux semaines')).toEqual([]);
  });
});

// ===========================================================================
// §25.20 à §25.22 — ce que la boucle ne peut pas atteindre
// ===========================================================================

describe('§25.20 / §25.21 / §25.22 — la clôture d’imports interdit l’envoi et la mutation', () => {
  const SRC = resolve(process.cwd(), 'src');

  function resolveImport(specifier: string, fromFile: string): string | null {
    const base = specifier.startsWith('@/')
      ? resolve(SRC, specifier.slice(2))
      : specifier.startsWith('.')
        ? resolve(dirname(fromFile), specifier)
        : null;
    if (base === null) return null;
    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      try {
        readFileSync(candidate, 'utf8');
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  function closureOf(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [resolve(SRC, entry)];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        const resolved = resolveImport(match[1] ?? '', file);
        if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
      }
    }
    return [...seen];
  }

  const FORBIDDEN_PREFIXES = [
    'lib/instagram/',
    'lib/pipeline/r6bDispatch',
    'lib/pipeline/r6bLiveDispatch',
    'lib/pipeline/r6bLiveEmail',
    'lib/pipeline/r6bDispatcher',
    'lib/inbound/instagramRuntime',
    'lib/crm/ghl',
  ];

  for (const entry of ['lib/learning/report.ts', 'cli/learning-report.ts']) {
    it(`${entry} n’atteint ni rail d’envoi, ni kill-switch, ni CRM`, () => {
      const closure = closureOf(entry);
      expect(closure.length).toBeGreaterThan(10);
      const offenders = closure
        .map((file) => relative(SRC, file).replace(/\\/g, '/'))
        .filter((path) => FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)));
      expect(offenders).toEqual([]);
    });

    it(`${entry} ne lit aucune autorisation d’envoi`, () => {
      const offenders = closureOf(entry)
        .filter((file) => readFileSync(file, 'utf8').includes('OUTBOUND_ALLOW_SENDING'))
        .map((file) => relative(SRC, file));
      expect(offenders).toEqual([]);
    });
  }

  it('n’importe aucune primitive d’écriture, de revue ou de modèle', () => {
    const files = ['lib/learning/report.ts', 'lib/learning/injection.ts', 'cli/learning-report.ts'];
    for (const file of files) {
      const source = readFileSync(resolve(SRC, file), 'utf8');
      const imported = [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)]
        .flatMap((match) => (match[1] ?? '').split(','))
        .map((name) => name.replace(/\btype\b/, '').trim());
      for (const forbidden of ['persistDraft', 'persistAnalysis', 'reviewDraft', 'ModelRouter']) {
        expect(imported).not.toContain(forbidden);
      }
    }
  });

  it('n’existe aucun type de mutation de politique dans la boucle', () => {
    for (const file of ['lib/learning/proposal.ts', 'lib/learning/report.ts', 'cli/learning-report.ts']) {
      expect(readFileSync(resolve(SRC, file), 'utf8')).not.toContain('POLICY_MUTATION');
    }
  });
});

// ===========================================================================
// §25.27 — l'injection éteinte ne change RIEN
// ===========================================================================

describe('§25.27 — injection OFF : le prompt est celui d’avant, au caractère près', () => {
  let lastPrompt = '';

  function makeRouter(): ModelRouter {
    const provider: LlmProvider = {
      name: 'codex',
      availability: () => ({ ok: true }),
      generate: async (request) => {
        lastPrompt = request.prompt;
        return {
          text: JSON.stringify({
            body: 'Vous tournez surtout au bouche-à-oreille alors ?',
            rationale: 'court',
            used_facts: [],
          }),
        };
      },
    };
    return new ModelRouter({ sql, logger, providers: { codex: provider } });
  }

  it('rend le même prompt sans option, avec option absente et avec null', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(prospect, 'oui pourquoi pas, dites m’en plus', 'INTERESTED', '2026-08-14T09:00:00Z');
    const router = makeRouter();

    await buildConversationReply(sql, router, turn.context, turn.analysis);
    const withoutOptions = lastPrompt;

    await buildConversationReply(sql, router, turn.context, turn.analysis, {});
    const withEmptyOptions = lastPrompt;

    await buildConversationReply(sql, router, turn.context, turn.analysis, { learning: null });
    const withNull = lastPrompt;

    expect(withEmptyOptions).toBe(withoutOptions);
    expect(withNull).toBe(withoutOptions);
    expect(withoutOptions).not.toContain('CE QUI A ÉTÉ OBSERVÉ');
  });

  it('n’injecte rien tant que le drapeau est absent, même avec un profil riche', () => {
    const style = buildOperatorStyleProfile({
      overrides: Array.from({ length: 40 }, () => ({
        deltas: ['GENERIC_OPENING_REMOVED'] as const,
        sent: { chars: 40, words: 8, sentences: 1, questions: 1, emojis: 0 },
        draftHadGenericOpening: true,
        draftHadPitch: false,
        draftHadCall: false,
        draftHadJargon: false,
        sentHadGenericOpening: false,
        rewritten: true,
      })),
      humanTexts: [],
      turnsBeforePitch: [],
      turnsBeforeCall: [],
    });
    expect(style.genericOpeningTolerance.value).toBe('REMOVES');
    expect(style.genericOpeningTolerance.basis).toBe('REWRITTEN');

    // Drapeau éteint : rien, quel que soit ce qui a été appris.
    expect(buildLearningInjection({ style, exemplars: [], offerReadiness: 'HIGH', enabled: false })).toBeNull();

    // Drapeau allumé : le bloc existe, et il ne dit rien de commercial.
    const injection = buildLearningInjection({ style, exemplars: [], offerReadiness: 'HIGH', enabled: true });
    expect(injection).not.toBeNull();
    const block = renderLearningBlock(injection!);
    expect(block).toContain('accusé de réception générique');
    expect(detectPerformanceClaims(block)).toEqual([]);
  });

  it('n’injecte rien quand l’apprentissage ne repose sur rien, drapeau allumé', () => {
    const style = buildOperatorStyleProfile({
      overrides: [],
      humanTexts: [],
      turnsBeforePitch: [],
      turnsBeforeCall: [],
    });
    expect(buildLearningInjection({ style, exemplars: [], offerReadiness: null, enabled: true })).toBeNull();
  });
});

// ===========================================================================
// §25.18, §25.19, §25.23 à §25.26 — le rapport sur une vraie base
// ===========================================================================

describe('§25.18 / §25.19 / §25.23 / §25.25 / §25.26 — le rapport, en lecture seule', () => {
  it('refuse toute écriture au niveau de la syntaxe', async () => {
    const guarded = readOnlySql(sql, 'test');
    await expect(guarded.query("update prospects set score = 1")).rejects.toThrow();
    await expect(guarded.query("with x as (delete from prospects returning *) select * from x")).rejects.toThrow();
    await expect(guarded.exec('select 1')).rejects.toThrow();
    await expect(guarded.transaction(async () => 1)).rejects.toThrow();
    // Une lecture passe.
    await expect(guarded.query('select 1 as one')).resolves.toBeDefined();
  });

  it('produit un rapport complet sans écrire une seule ligne', async () => {
    const prospect = await newProspect();
    const turn1 = await inboundTurn(
      prospect,
      'Bonjour, principalement mon site internet ainsi que ma fiche Google',
      'OTHER',
      '2026-08-15T09:00:00Z',
    );
    await humanReply(
      turn1.context,
      turn1.analysis,
      'Merci pour votre retour. Je comprends. Quels sont vos objectifs actuels en matière de développement ?',
      'Et ça vous ramène déjà pas mal de demandes ou pas vraiment ?',
    );
    await inboundTurn(prospect, 'j’ai beaucoup de travail en ce moment', 'OTHER', '2026-08-15T11:00:00Z');

    const before = await snapshot();
    // Le rapport passe par l'enveloppe de lecture seule : une écriture
    // n'atteindrait même pas le serveur.
    const report = await buildLearningReport(readOnlySql(sql, 'test'), new Date('2026-08-16T00:00:00Z'));
    const after = await snapshot();

    // §25.18 / §25.19 / §25.22 — rien n'a bougé : ni score, ni éligibilité,
    // ni état, ni brouillon, ni manifeste.
    expect(after).toEqual(before);

    expect(report.corpus.prospectsContacted).toBeGreaterThan(0);
    expect(report.corpus.overridePairs).toBeGreaterThan(0);
    expect(report.proposals.length).toBeGreaterThan(0);
    for (const proposal of report.proposals) {
      expect(proposal.kind).toBe('LEARNING_PROPOSAL');
      expect(proposal.requiresHumanDecision).toBe(true);
      expect(typeof proposal.sampleSize).toBe('number');
    }

    // §25.23 — un exemplar ne pointe que des identifiants canoniques.
    for (const exemplar of report.exemplars) {
      for (const id of exemplar.inboundMessageIds) {
        const rows = await sql.query<{ id: string }>(
          `select id from r6b_inbound_messages where id = $1`,
          [id],
        );
        expect(rows).toHaveLength(1);
      }
    }

    // La correction humaine du tour a bien été lue en abstrait.
    const withOverride = report.turns.filter((turn) => turn.override !== null);
    expect(withOverride.length).toBeGreaterThan(0);
    expect(withOverride[0]!.override!.deltas).toContain('GENERIC_OPENING_REMOVED');
    expect(withOverride[0]!.override!.deltas).toContain('SHORTER');

    // Le rendu ne parle pas non plus.
    const rendered = renderLearningReport(report);
    expect(rendered).toContain('HERMES LEARNING R1');
    expect(rendered).toContain('Aucune écriture, aucun envoi, aucune politique modifiée.');
    expect(detectPerformanceClaims(rendered)).toEqual([]);
  });

  it('§25.24 — ni contenu de message ni attribut sensible dans la sortie', async () => {
    const report = await buildLearningReport(readOnlySql(sql, 'test'), new Date('2026-08-16T00:00:00Z'));
    const serialized = JSON.stringify(report);
    const rendered = renderLearningReport(report);

    // Aucun fragment des messages réels — ni du prospect, ni de nous.
    for (const fragment of [
      'fiche Google',
      'beaucoup de travail',
      'objectifs actuels',
      'pas mal de demandes',
      FIRST_TOUCH.slice(0, 30),
    ]) {
      expect(serialized).not.toContain(fragment);
      expect(rendered).not.toContain(fragment);
    }

    // Aucun axe de profilage sensible, ni comme clé ni comme valeur.
    //
    // La comparaison se fait sur des MOTS, pas sur des sous-chaînes : « age »
    // vit dans « message », « percentage » et « language », et un test qui
    // l'ignorerait échouerait sur du vocabulaire parfaitement anodin — puis
    // serait désarmé, ce qui est le vrai risque.
    const SENSITIVE = /\b(age|ages|origine?s?|origins?|ethnic\w*|ethnie|religion\w*|genre|gender|sexe|sante|health|psycholog\w*|personality|classe_sociale|social_class|orientation)\b/i;
    expect(SENSITIVE.test(serialized)).toBe(false);
    expect(SENSITIVE.test(rendered)).toBe(false);

    // Et aucune CLÉ du rapport ne porte un tel axe, à n'importe quelle
    // profondeur — c'est la forme sous laquelle un profil sensible
    // arriverait s'il arrivait un jour.
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        keys.add(key);
        walk(child);
      }
    };
    walk(report);
    expect([...keys].filter((key) => SENSITIVE.test(key))).toEqual([]);
  });
});

/** Photographie des tables qu'une boucle d'apprentissage ne doit jamais toucher. */
async function snapshot(): Promise<string> {
  const rows = await sql.query<Record<string, unknown>>(
    `select (select count(*) from prospect_scores)                as "scores",
            (select count(*) from prospect_icp_assessments)       as "icp",
            (select count(*) from r6b_reply_drafts)               as "drafts",
            (select count(*) from r6b_reply_analyses)             as "analyses",
            (select count(*) from r6b_prospect_outreach_states)   as "states",
            (select count(*) from r6b_dispatch_manifests)         as "manifests",
            (select count(*) from outreach_events)                as "events",
            (select coalesce(sum(score), 0) from prospects)       as "scoreSum",
            (select count(*) from r6b_batch_votes)                as "votes"`,
  );
  return JSON.stringify(rows);
}

// ===========================================================================
// La famille de message, dérivée du texte réellement parti
// ===========================================================================

describe('la famille de message se lit dans le message, pas dans le hook', () => {
  it('reconnaît les familles, et refuse d’en inventer une', () => {
    expect(messageFamilyOf('Nous avons déjà généré environ 3 500 € pour un client.')).toBe('PROOF_LED');
    expect(messageFamilyOf('On peut s’appeler quinze minutes si vous voulez.')).toBe('CALL_LED');
    expect(messageFamilyOf('On aide les pros du atelier à structurer leur acquisition.')).toBe('PITCH_LED');
    expect(messageFamilyOf('Comment vos clients vous trouvent aujourd’hui ?')).toBe('QUESTION_OPENER');
    expect(messageFamilyOf(null)).toBeNull();
    expect(messageFamilyOf('   ')).toBeNull();
  });
});
