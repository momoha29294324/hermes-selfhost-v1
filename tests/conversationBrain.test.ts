import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { createLogger } from '@/lib/logging/logger';
import { ModelRouter } from '@/lib/models/router';
import { LlmError, type LlmProvider } from '@/lib/models/types';
import { buildConversationReply, understandConversation } from '@/lib/conversation/brain';
import { loadConversationThread, renderThreadBlock } from '@/lib/conversation/thread';
import { persistAnalysis, type StoredAnalysis } from '@/lib/replies/analyses';
import { loadReplyContext, type ReplyContext } from '@/lib/replies/context';
import { persistDraft, reviewDraft } from '@/lib/replies/draft';
import { decideCategory, detectUnsubscribeDemand, resolveNextAction, type ReplyCategory } from '@/lib/replies/taxonomy';
import { makeReplyFixtures, type ContactedProspect, type ReplyFixtures } from './support/replyFixture';
import type { Sql } from '@/lib/db/sql';

/**
 * CONVERSATION-R1 §18 — le cerveau multi-tour, sur une vraie base.
 *
 * Aucun test n'ouvre de connexion réseau : le modèle est un faux provider
 * injecté dans le VRAI `ModelRouter`, donc le routage, la validation de schéma
 * et l'instrumentation `model_runs` sont réellement exercés — seule la couche
 * qui parlerait à Internet est remplacée. Et rien ici ne peut envoyer : le
 * module sous test n'importe aucun provider d'envoi.
 *
 * Entreprises, adresses et textes sont fictifs.
 */

const logger = createLogger({ test: 'conversation-r1' });
const MAILBOX = 'reponse@example.com';
const FIRST_TOUCH =
  'Bonjour, j’ai vu que vous faisiez du prestation standard à domicile. Comment vos clients vous trouvent aujourd’hui ?';

let sql: Sql;
let dir: string;
let campaignId: string;
let fixtures: ReplyFixtures;

const DRAFT_ANSWER = {
  body: 'Merci pour votre retour, je vous propose un échange court quand cela vous arrange.',
  rationale: 'Réponse courte, sans chiffre ni promesse.',
  used_facts: [],
};

/** Le faux modèle. Il ne sert qu'à faire vivre le chemin de rédaction. */
function makeRouter(answer: unknown = DRAFT_ANSWER): ModelRouter {
  const provider: LlmProvider = {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async (request) => {
      if (request.task !== 'message') {
        throw new LlmError(`tâche inattendue ${request.task}`, 'provider_error');
      }
      lastPrompt = request.prompt;
      lastSystem = request.system ?? '';
      return { text: JSON.stringify(answer) };
    },
  };
  return new ModelRouter({ sql, logger, providers: { codex: provider } });
}

let lastPrompt = '';
let lastSystem = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-conversation-r1-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-conversation-r1-test', 'Test', 'example-services', '{}'],
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
  lastSystem = '';
});

// ---------------------------------------------------------------------------
// Outillage : construire une conversation à N tours
// ---------------------------------------------------------------------------

let recipientCounter = 0;

async function newProspect(): Promise<ContactedProspect> {
  recipientCounter += 1;
  return fixtures.contactedProspect(`contact${recipientCounter}@example.com`);
}

/** Écrit un tour entrant et son analyse D2, comme le pipeline le ferait. */
async function inboundTurn(
  prospect: ContactedProspect,
  body: string,
  category: ReplyCategory,
  hour: number,
  confidence = 0.9,
): Promise<{ context: ReplyContext; analysis: StoredAnalysis }> {
  const id = await fixtures.inbound({
    manifest: prospect.manifest,
    outreachEventId: prospect.outreachEventId,
    prospectId: prospect.prospectId,
    body,
    receivedAt: new Date(Date.UTC(2026, 7, 20, hour, 0, 0)).toISOString(),
  });

  const context = await loadReplyContext(sql, id);
  if (context === null) throw new Error('contexte introuvable');

  // La décision passe par la VRAIE politique D2 : fabriquer une décision à la
  // main ferait porter aux tests une seconde politique, qui divergerait.
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
    inputSha256: createHash('sha256').update(`${id}:${category}`).digest('hex'),
    modelRunId: null,
  });

  return { context, analysis: persisted.analysis };
}

/**
 * Inscrit une réponse de Hermes RÉELLEMENT REMISE à ce prospect.
 *
 * HERMES-SEMANTIC-GROUNDING-R1 — ces trois scénarios simulaient « notre tour
 * précédent » avec un brouillon `APPROVED`, c'est-à-dire un texte qu'un humain
 * a validé et que le schéma R6B-D2 déclare « TOUJOURS PAS ENVOYÉ ». Ils
 * prouvaient donc qu'un texte JAMAIS REMIS suffisait à faire dire au système
 * « je vous l'ai déjà expliqué » — exactement ce que ce round referme.
 *
 * L'intention des tests est intacte : ce qu'ils veulent éprouver est « on ne
 * réexplique pas ce qui a déjà été dit ». Ce qui change est la façon dont ce
 * tour précédent est REMIS — par le seul chemin de remise que ce dépôt
 * possède pour une réponse, `hermes_conversation_plans`.
 */
async function deliverOurReply(prospectId: string, inboundMessageId: string, body: string): Promise<void> {
  await sql.query(
    `insert into hermes_conversation_plans (
       prospect_id, channel, kind, trigger_inbound_message_id, idempotency_key,
       policy_version, commercial_policy_version, brain_version,
       decision, decision_gate, body, body_sha256,
       offer_readiness, call_readiness, status,
       external_effect_attempted, external_effect_started_at, terminated_at
     ) values ($1, 'instagram_dm', 'AUTO_REPLY', $2, $3,
       'test-policy', 'test-commercial', 'test-brain',
       'AUTO_REPLY_ELIGIBLE', 'autonomous_reply', $4, $5,
       'LOW', 'LOW', 'SENT', true, now(), now())`,
    [prospectId, inboundMessageId, `test-${inboundMessageId}`, body, createHash('sha256').update(body).digest('hex')],
  );
}

/** Fait valider par un humain la réponse de Hermes à un tour donné. */
async function approveOurReply(
  context: ReplyContext,
  analysis: StoredAnalysis,
  body: string,
): Promise<void> {
  const persisted = await persistDraft(sql, context, analysis, {
    body,
    bodySha256: 'b'.repeat(64),
    rationale: 'réponse de test',
    guardrailFlags: [],
    blocked: false,
    model: 'test-model',
    effort: null,
    promptVersion: 'test-1',
    modelRunId: null,
  });
  await reviewDraft(sql, {
    draftId: persisted.draft.id,
    decision: 'APPROVE',
    reviewedBy: 'test',
  });
}

// ---------------------------------------------------------------------------
// §18.9 / §18.10 — la continuité multi-tour
// ---------------------------------------------------------------------------

describe('§18.9 — au deuxième tour, on ne recommence pas le pitch', () => {
  it('sait que l’offre a déjà été expliquée et le dit au rédacteur', async () => {
    const prospect = await newProspect();

    const turn1 = await inboundTurn(prospect, 'oui pourquoi pas, vous faites quoi exactement ?', 'QUESTION', 9);
    await deliverOurReply(
      prospect.prospectId,
      turn1.context.reply.id,
      'On aide les pros du atelier à avoir un flux de clients régulier, via des campagnes ciblées.',
    );

    const turn2 = await inboundTurn(prospect, 'et niveau prix ?', 'QUESTION', 11);
    const understanding = await understandConversation(sql, turn2.context, turn2.analysis);

    expect(understanding.state.coveredTopics).toContain('OFFER_EXPLAINED');
    expect(understanding.state.isFirstReply).toBe(false);
    expect(understanding.state.inboundTurnCount).toBe(2);
    expect(understanding.signals.questionTopic).toBe('PRICE');
    expect(understanding.state.goal).toBe('ANSWER_QUESTION');

    const router = makeRouter();
    await buildConversationReply(sql, router, turn2.context, turn2.analysis);

    // Le fil entier part au modèle, et la consigne de non-répétition avec lui.
    expect(lastPrompt).toContain('vous faites quoi exactement');
    expect(lastPrompt).toContain('OFFER_EXPLAINED');
    expect(lastSystem).toContain('répéter ce qui a déjà été dit dans ce fil');
    expect(lastSystem).toContain('recommencer la présentation depuis le début');
  });

  it('ne prétend rien avoir expliqué au tout premier échange', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(prospect, 'oui pourquoi pas, vous faites quoi exactement ?', 'QUESTION', 9);
    const understanding = await understandConversation(sql, turn.context, turn.analysis);

    expect(understanding.state.isFirstReply).toBe(true);
    expect(understanding.state.inboundTurnCount).toBe(1);
    expect(understanding.state.coveredTopics).not.toContain('CALL_PROPOSED');
  });
});

describe('§18.10 — une objection au troisième tour garde son contexte', () => {
  it('retient les deux tours précédents et le sujet de l’objection', async () => {
    const prospect = await newProspect();

    const turn1 = await inboundTurn(prospect, 'oui pourquoi pas, vous faites quoi exactement ?', 'QUESTION', 9);
    await deliverOurReply(
      prospect.prospectId,
      turn1.context.reply.id,
      'On aide les pros du atelier à générer des demandes entrantes régulières.',
    );

    const turn2 = await inboundTurn(prospect, 'et niveau prix ?', 'QUESTION', 11);
    await deliverOurReply(
      prospect.prospectId,
      turn2.context.reply.id,
      'Le budget dépend vraiment du périmètre. Sur quelle zone travaillez-vous ?',
    );

    const turn3 = await inboundTurn(
      prospect,
      'ok mais j’ai déjà quelqu’un qui gère mes pubs',
      'OBJECTION',
      14,
    );
    const understanding = await understandConversation(sql, turn3.context, turn3.analysis);

    expect(understanding.state.inboundTurnCount).toBe(3);
    expect(understanding.signals.objectionTopic).toBe('ALREADY_HAS_PROVIDER');
    expect(understanding.state.goal).toBe('HANDLE_OBJECTION');
    // La question de prix du tour 2 n'est pas oubliée par l'arrivée d'une
    // objection au tour 3.
    expect(understanding.state.questionTopicsReceived).toContain('PRICE');
    expect(understanding.state.coveredTopics).toContain('OFFER_EXPLAINED');

    const router = makeRouter();
    await buildConversationReply(sql, router, turn3.context, turn3.analysis);
    expect(lastPrompt).toContain('ALREADY_HAS_PROVIDER');
    expect(lastPrompt).toContain('dans le contexte de ce qui a DÉJÀ été dit');
  });

  it('un brouillon seulement VALIDÉ ne fabrique aucune répétition', async () => {
    // HERMES-SEMANTIC-GROUNDING-R1 — le pendant du test qui suit. Celui-là
    // vérifie que le PROMPT étiquette correctement ; celui-ci vérifie que la
    // logique de RÉPÉTITION ne compte pas un texte jamais remis.
    //
    // La conséquence, si on le comptait : `PITCH_REPEATED` et `CTA_TOO_EARLY`
    // se déclencheraient sur un tour parfaitement neuf pour la personne d'en
    // face, et le tour partirait en silence.
    const prospect = await newProspect();
    const turn1 = await inboundTurn(prospect, 'vous faites quoi exactement ?', 'QUESTION', 9);
    await approveOurReply(
      turn1.context,
      turn1.analysis,
      'On aide les pros du atelier sur l’acquisition, et on peut s’appeler quinze minutes.',
    );

    const turn2 = await inboundTurn(prospect, 'et le prix ?', 'QUESTION', 11);
    const understanding = await understandConversation(sql, turn2.context, turn2.analysis);

    expect(understanding.state.coveredTopics).not.toContain('OFFER_EXPLAINED');
    expect(understanding.state.coveredTopics).not.toContain('CALL_PROPOSED');
    // Le tour existe pourtant bel et bien dans le fil, avec son étiquette.
    expect(understanding.thread.outboundTurns.map((turn) => turn.provenance)).toContain(
      'human_approved_reply',
    );
    expect(understanding.thread.exposedOutboundTurns.map((turn) => turn.provenance)).not.toContain(
      'human_approved_reply',
    );
  });

  it('distingue un message envoyé d’un brouillon seulement validé', async () => {
    const prospect = await newProspect();
    const turn1 = await inboundTurn(prospect, 'vous faites quoi exactement ?', 'QUESTION', 9);
    await approveOurReply(turn1.context, turn1.analysis, 'On aide les pros du atelier sur l’acquisition.');
    // HERMES-SEMANTIC-GROUNDING-R1 — le fil rendu s'arrête au message traité.
    // La relecture d'un brouillon date de `now()`, donc APRÈS le tour 2 ; sans
    // cette antidatation, ce tour serait « le futur » du message qu'on juge et
    // n'aurait rien à faire dans le prompt. Ce que ce test veut voir est son
    // ÉTIQUETTE, pas sa place dans le temps.
    await sql.query(
      `update r6b_reply_drafts set reviewed_at = $1 where prospect_id = $2`,
      [new Date(Date.UTC(2026, 7, 20, 10, 0, 0)).toISOString(), prospect.prospectId],
    );

    const turn2 = await inboundTurn(prospect, 'et le prix ?', 'QUESTION', 11);
    const thread = await loadConversationThread(sql, turn2.context);
    const rendered = renderThreadBlock(thread);

    // Le premier message est prouvé parti ; un brouillon approuvé ne l'est pas.
    // Confondre les deux ferait dire « je vous l'ai envoyé » sur un texte que
    // personne n'a peut-être reçu.
    expect(rendered).toContain('premier message, réellement envoyé');
    expect(rendered).toContain('envoi non prouvé');
    expect(thread.outboundTurns.map((turn) => turn.provenance)).toEqual([
      'sent_first_touch',
      'human_approved_reply',
    ]);
  });
});

// ---------------------------------------------------------------------------
// §18.11 / §18.12 / §18.17 — l'ancrage
// ---------------------------------------------------------------------------

describe('§18.11 — une question de prix sans politique tarifaire', () => {
  it('nomme le manque et interdit tout chiffre', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(prospect, 'c’est combien ?', 'QUESTION', 9);
    const understanding = await understandConversation(sql, turn.context, turn.analysis);

    expect(understanding.signals.questionTopic).toBe('PRICE');
    expect(understanding.grounding.gaps).toContain('PRICING_POLICY_MISSING');

    const router = makeRouter();
    await buildConversationReply(sql, router, turn.context, turn.analysis);

    expect(lastPrompt).toContain('PRICING_POLICY_MISSING');
    expect(lastPrompt).toContain('AUCUN prix, fourchette, tarif de départ');
    expect(lastPrompt).toContain('dépend du besoin réel');
  });

  it('bloque un brouillon qui inventerait un montant', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(prospect, 'c’est combien vos prestations ?', 'QUESTION', 9);

    const router = makeRouter({
      body: 'Nos accompagnements démarrent à 1 500 € par mois et montent selon le périmètre.',
      rationale: 'tentative de chiffrage',
      used_facts: [],
    });
    const reply = await buildConversationReply(sql, router, turn.context, turn.analysis);

    // Les garde-fous de R6B-D2 s'appliquent tels quels : le montant n'est pas
    // dans les faits observés, donc le brouillon est marqué bloquant.
    expect(reply.draft).not.toBeNull();
    expect(reply.draft?.blocked).toBe(true);
  });
});

describe('§18.12 — une demande de preuve', () => {
  it('interdit toute preuve chiffrée dans une réponse', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(prospect, 'vous avez des résultats à montrer ?', 'QUESTION', 9);
    const understanding = await understandConversation(sql, turn.context, turn.analysis);

    expect(understanding.signals.questionTopic).toBe('RESULTS_PROOF');
    expect(understanding.grounding.gaps).toContain('PROOF_NOT_QUOTABLE_IN_REPLY');
    // La preuve canonique des « ≈ 3 500 € » appartient au premier contact.
    // `checkReplyDraft` (R6B-D2) passe `allowedCaseStudyClaim: null` : R1 se
    // range sur cette décision au lieu de la desserrer.
    expect(understanding.grounding.quotableProofClaim).toBeNull();

    const router = makeRouter();
    await buildConversationReply(sql, router, turn.context, turn.analysis);
    expect(lastPrompt).toContain('AUCUN résultat chiffré');
  });

  it('bloque un brouillon qui citerait la preuve canonique en réponse', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(prospect, 'vous avez des preuves ?', 'QUESTION', 9);

    const router = makeRouter({
      body: 'Nous avons déjà généré environ 3 500 € pour un client que nous accompagnons.',
      rationale: 'preuve canonique',
      used_facts: [],
    });
    const reply = await buildConversationReply(sql, router, turn.context, turn.analysis);
    expect(reply.draft?.blocked).toBe(true);
  });
});

describe('§18.17 — une question factuelle sans donnée fiable', () => {
  it('demande une précision plutôt que d’inventer', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(
      prospect,
      'vous travaillez avec quels logiciels de gestion de flotte ?',
      'QUESTION',
      9,
    );
    const understanding = await understandConversation(sql, turn.context, turn.analysis);

    expect(understanding.grounding.gaps).toContain('TOPIC_NOT_COVERED_BY_DATA');
    expect(understanding.decision.decision).toBe('CLARIFY');
    expect(understanding.decision.escalationReason).toBe('NO_RELIABLE_DATA');
    // On rédige quand même : le bon brouillon est celui qui dit qu'il ne sait
    // pas, pas l'absence de brouillon.
    expect(understanding.decision.shouldDraft).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §18.13 à §18.16 — arrêt, escalade, maturité
// ---------------------------------------------------------------------------

describe('§18.13 — désabonnement', () => {
  it('arrête définitivement et n’écrit aucun brouillon', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(prospect, 'merci de me retirer de votre liste', 'UNSUBSCRIBE', 9);

    const router = makeRouter();
    const reply = await buildConversationReply(sql, router, turn.context, turn.analysis);

    expect(reply.decision.decision).toBe('STOP_PERMANENT');
    expect(reply.decision.shouldDraft).toBe(false);
    expect(reply.draft).toBeNull();
    expect(reply.decision.futureAutoReplyEligible).toBe(false);
    expect(reply.state.followUpStillRelevant).toBe(false);
    // Aucun appel de modèle : rien n'a été rédigé.
    expect(lastPrompt).toBe('');
  });

  it('arrête même quand le message est aussi hostile', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(
      prospect,
      'foutez-moi la paix et retirez-moi de votre liste',
      'UNSUBSCRIBE',
      9,
    );
    const understanding = await understandConversation(sql, turn.context, turn.analysis);
    expect(understanding.decision.decision).toBe('STOP_PERMANENT');
  });
});

describe('§18.14 — refus clair', () => {
  it('arrête la prospection froide sans rédiger', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(prospect, 'non merci, ça ne m’intéresse pas', 'NOT_INTERESTED', 9);

    const router = makeRouter();
    const reply = await buildConversationReply(sql, router, turn.context, turn.analysis);

    expect(reply.decision.decision).toBe('STOP_COLD');
    expect(reply.draft).toBeNull();
    expect(reply.state.qualification).toBe('DISQUALIFIED');
    expect(reply.state.followUpStillRelevant).toBe(false);
    expect(lastPrompt).toBe('');
  });
});

describe('§18.15 — ambiguïté', () => {
  it('escalade ce que D2 n’a pas su lire', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(prospect, 'hmm', 'REVIEW_REQUIRED', 9, 0.4);
    const understanding = await understandConversation(sql, turn.context, turn.analysis);

    expect(understanding.decision.decision).toBe('HUMAN_ESCALATION');
    expect(understanding.decision.escalationReason).toBe('UNCLASSIFIABLE');
    expect(understanding.state.humanNeeded).toBe(true);
    expect(understanding.state.goal).toBe('AWAIT_HUMAN');
  });

  it('demande une précision sur un message trop court pour être lu', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(prospect, '...', 'OTHER', 9, 0.5);
    const understanding = await understandConversation(sql, turn.context, turn.analysis);
    expect(understanding.decision.decision).toBe('HUMAN_ESCALATION');
  });

  it('escalade un contenu juridique quelle que soit la catégorie', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(
      prospect,
      'où avez-vous eu mes données ? je vais saisir la CNIL',
      'QUESTION',
      9,
    );
    const understanding = await understandConversation(sql, turn.context, turn.analysis);

    expect(understanding.signals.sensitiveFlags).toContain('DATA_PRIVACY_DEMAND');
    expect(understanding.decision.decision).toBe('HUMAN_ESCALATION');
    expect(understanding.decision.escalationReason).toBe('SENSITIVE_CONTENT');
    expect(understanding.decision.shouldDraft).toBe(false);
  });
});

describe('§18.16 — une demande d’appel', () => {
  it('rend une maturité HIGH dès la demande explicite', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(prospect, 'on peut s’appeler ?', 'INTERESTED', 9);
    const understanding = await understandConversation(sql, turn.context, turn.analysis);

    expect(understanding.signals.explicitCallRequest).toBe(true);
    expect(understanding.signals.callReadiness).toBe('HIGH');
    expect(understanding.state.goal).toBe('PROPOSE_CALL');
  });

  it('ne pousse pas l’appel sur un signal faible au premier tour', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(prospect, 'ok', 'QUESTION', 9);
    const understanding = await understandConversation(sql, turn.context, turn.analysis);

    expect(understanding.signals.callReadiness).toBe('LOW');
    expect(understanding.state.goal).not.toBe('PROPOSE_CALL');
  });

  it('ne repropose pas un appel déjà proposé', async () => {
    const prospect = await newProspect();
    const turn1 = await inboundTurn(prospect, 'pourquoi pas', 'INTERESTED', 9);
    await deliverOurReply(
      prospect.prospectId,
      turn1.context.reply.id,
      'On peut s’appeler quinze minutes si vous voulez.',
    );

    const turn2 = await inboundTurn(prospect, 'et vous faites ça comment ?', 'QUESTION', 11);
    const understanding = await understandConversation(sql, turn2.context, turn2.analysis);

    expect(understanding.state.coveredTopics).toContain('CALL_PROPOSED');

    const router = makeRouter();
    await buildConversationReply(sql, router, turn2.context, turn2.analysis);
    expect(lastPrompt).toContain('CALL_PROPOSED');
    expect(lastSystem).toContain("une proposition d'échange déjà faite");
  });
});

// ---------------------------------------------------------------------------
// §18.20 / §19 — la sortie et l'absence d'envoi
// ---------------------------------------------------------------------------

describe('§18.20 / §19 — la sortie reste PROPOSED et rien ne part', () => {
  it('publie en PROPOSED et jamais autrement', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(prospect, 'oui ça m’intéresse, vous faites quoi ?', 'QUESTION', 9);

    const router = makeRouter();
    const reply = await buildConversationReply(sql, router, turn.context, turn.analysis);
    expect(reply.publicationStatus).toBe('PROPOSED');
    expect(reply.decision.autoSendAllowed).toBe(false);

    expect(reply.draft).not.toBeNull();
    const persisted = await persistDraft(sql, turn.context, turn.analysis, reply.draft!);
    expect(persisted.draft.status).toBe('PROPOSED');

    // La table elle-même ne connaît aucun statut ressemblant à un envoi.
    const rows = await sql.query<{ status: string }>(
      `select status from r6b_reply_drafts where prospect_id = $1`,
      [prospect.prospectId],
    );
    for (const row of rows) expect(['PROPOSED', 'APPROVED', 'EDITED', 'REJECTED']).toContain(row.status);
  });

  it('n’écrit aucun événement sortant', async () => {
    const prospect = await newProspect();
    const before = await sql.query<{ count: string }>(
      `select count(*)::text as count from outreach_events where prospect_id = $1`,
      [prospect.prospectId],
    );

    const turn = await inboundTurn(prospect, 'ok et concrètement ?', 'QUESTION', 9);
    const router = makeRouter();
    await buildConversationReply(sql, router, turn.context, turn.analysis);

    const after = await sql.query<{ count: string }>(
      `select count(*)::text as count from outreach_events where prospect_id = $1`,
      [prospect.prospectId],
    );
    expect(after[0]!.count).toBe(before[0]!.count);
  });

  it('porte une version de prompt distincte de celle de R6B-D2', async () => {
    const prospect = await newProspect();
    const turn = await inboundTurn(prospect, 'intéressant, dites m’en plus', 'INTERESTED', 9);
    const router = makeRouter();
    const reply = await buildConversationReply(sql, router, turn.context, turn.analysis);

    // Deux prompts différents ne partagent pas un numéro de version, sinon
    // `prompt_version` cesse de dire ce qui a réellement été demandé. R1.1 a
    // réécrit le prompt (§6) : il porte donc son propre numéro, distinct de
    // celui de R6B-D2 comme de celui de R1.
    expect(reply.draft?.promptVersion).toBe('conv-r8-draft-1');
    expect(reply.draft?.promptVersion).not.toBe('conv-r2-draft-1');
    expect(reply.draft?.promptVersion).not.toBe('r6b-d2-draft-1');
    expect(reply.draft?.promptVersion).not.toBe('conv-r1-draft-1');
    expect(reply.draft?.promptVersion).not.toBe('conv-r1.1-draft-1');
  });
});

describe('le profil de style se construit sur les seuls messages entrants', () => {
  it('ignore nos propres tours', async () => {
    const prospect = await newProspect();
    const turn1 = await inboundTurn(prospect, 'slt tu fais quoi ?', 'QUESTION', 9);
    await approveOurReply(
      turn1.context,
      turn1.analysis,
      'Bonjour, nous vous remercions de votre message et vous prions de bien vouloir préciser votre besoin.',
    );

    const turn2 = await inboundTurn(prospect, 'ok mais tu fais quoi vraiment ?', 'QUESTION', 11);
    const understanding = await understandConversation(sql, turn2.context, turn2.analysis);

    // Notre propre réponse est formelle et vouvoie. Si elle entrait dans le
    // corpus, le profil basculerait sur NOTRE voix au lieu de la leur.
    expect(understanding.style.addressMode).toBe('TU');
    expect(understanding.style.observedMessages).toBe(2);
  });
});
