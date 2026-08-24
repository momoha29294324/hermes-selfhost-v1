import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConversationPolicy, loadInstagramRail } from '@/lib/config/load';
import { assessInboundMessage, type ConversationAssessment } from '@/lib/conversation/assessment';
import { conversationPromptVersionFor } from '@/lib/conversation/brain';
import {
  loadConversationPlan,
  recordConversationPlan,
  type ConversationPlan,
  type RecordPlanInput,
} from '@/lib/conversation/plan';
import { executeConversationReply } from '@/lib/conversation/replyExecution';
import { observeReplyShadow } from '@/lib/conversation/replyShadow';
import { resolveReplyTarget } from '@/lib/conversation/replyTarget';
import { canonicalAccountIdentity, type CanonicalAccountIdentity } from '@/lib/instagram/accountIdentity';
import { loadConversationThread } from '@/lib/conversation/thread';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import type { Sql } from '@/lib/db/sql';
import { InstagramBrowserProfileBusyError } from '@/lib/instagram/browserProfileLease';
import type {
  InstagramReplyInput,
  InstagramReplyRail,
  InstagramReplyResult,
} from '@/lib/instagram/replyRail';
import { setKillSwitch } from '@/lib/instagram/safety';
import { persistAnalysis } from '@/lib/replies/analyses';
import { loadReplyContext } from '@/lib/replies/context';
import { persistDraft, reviewDraft, sha256Hex } from '@/lib/replies/draft';
import { loadActiveAnalysis } from '@/lib/replies/analyses';
import { decideCategory, detectUnsubscribeDemand, resolveNextAction, type ReplyCategory } from '@/lib/replies/taxonomy';
import { makeReplyFixtures, type ContactedProspect, type ReplyFixtures } from './support/replyFixture';

/**
 * HERMES-REPLY-DELIVERY-R1 §16 — l'ORCHESTRATEUR de réponse, sur une vraie base.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce fichier prouve, et que rien de pur ne peut prouver
 * ---------------------------------------------------------------------------
 * Que les portes tiennent DANS L'ORDRE, sur des données réellement écrites : un
 * arrêt global armé ne laisse pas passer un plan par ailleurs parfait, un
 * message arrivé entre-temps périme le brouillon, une tentative inscrite ne se
 * rejoue jamais, et un fil qui ne concorde pas ferme la porte.
 *
 * ---------------------------------------------------------------------------
 * Le rail est un DOUBLE, et il est plus exigeant que le vrai
 * ---------------------------------------------------------------------------
 * Aucun navigateur n'est ouvert ici. Le double appelle `onBeforeExternalEffect`
 * exactement quand la vraie primitive l'appelle — c'est-à-dire seulement en
 * mode LIVE, après tous ses propres refus — et il COMPTE ses appels. C'est ce
 * compteur qui rend vérifiable la phrase « zéro effet externe » : un test qui
 * se contenterait du statut final ne verrait pas la différence entre « refusé
 * avant le crochet » et « refusé après ».
 *
 * Aucune donnée réelle : entreprises, handles et textes sont fictifs.
 */

const MAILBOX_EMAIL = 'reponse@example.com';
const ACCOUNT_HANDLE = 'compte_test_hermes';
const FIRST_TOUCH =
  'Bonjour, j’ai vu que vous faisiez du prestation standard à domicile. Comment vos clients vous trouvent aujourd’hui ?';
const REPLY_BODY = 'Et ça vous ramène des demandes régulièrement ?';
const THREAD_ID = '107403793987175';
const ROOT = resolve(__dirname, '..');

const conversation = loadConversationPolicy();
// Le compte de CE scénario, substitué à celui du fichier canonique : les
// fixtures écrivent `mailbox = ACCOUNT_HANDLE`, et depuis
// HERMES-IDENTITY-CANONICALIZATION-R1 §6 une boîte qui n'est pas la nôtre
// refuse la cible. Un test qui garderait le compte réel n'éprouverait plus
// que cette garde-là.
const loaded = loadInstagramRail();
const config = {
  ...loaded,
  inbound: { ...loaded.inbound, accountHandle: ACCOUNT_HANDLE, formerAccountHandles: [] },
};

/** La même identité que celle que l'exécution dérive de `config`. */
const TEST_ACCOUNT_IDENTITY: CanonicalAccountIdentity = (() => {
  const resolved = canonicalAccountIdentity({
    accountHandle: ACCOUNT_HANDLE,
    formerAccountHandles: [],
  });
  if (!resolved.ok) throw new Error(resolved.detail);
  return resolved.identity;
})();

let sql: Sql;
let dir: string;
let fixtures: ReplyFixtures;
let handleCounter = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-reply-delivery-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-reply-r1-test', 'Test', 'example-services', '{}'],
  );
  fixtures = makeReplyFixtures(sql, {
    campaignId: rows[0]!.id,
    mailbox: MAILBOX_EMAIL,
    firstTouch: FIRST_TOUCH,
  });
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  // L'arrêt global est ARMÉ par défaut, comme dans le dépôt. Chaque test qui a
  // besoin de le voir levé le lève explicitement — et le prochain `beforeEach`
  // le réarme, si bien qu'aucun test ne peut hériter d'une porte ouverte.
  await setKillSwitch(sql, { engaged: true, setBy: 'test', reason: 'défaut du dépôt' });
  await resetEffectLedger();
});

// ---------------------------------------------------------------------------
// Le double de rail
// ---------------------------------------------------------------------------

interface RailScript {
  /** Ce que la primitive rendra si elle atteint le bout. */
  readonly result?: InstagramReplyResult;
  /** Une exception levée APRÈS le crochet — donc après la réservation. */
  readonly throwAfterHook?: Error;
  /** Une exception levée AVANT le crochet — donc avant toute réservation. */
  readonly throwBeforeHook?: Error;
}

class FakeReplyRail implements InstagramReplyRail {
  /** Combien de fois le crochet pré-effet a été appelé. Zéro = aucun effet possible. */
  hookCalls = 0;
  /** Combien de fois la primitive a été appelée du tout. */
  calls = 0;
  lastInput: InstagramReplyInput | null = null;
  closed = false;

  constructor(private readonly script: RailScript = {}) {}

  async sendThreadReply(input: InstagramReplyInput): Promise<InstagramReplyResult> {
    this.calls += 1;
    this.lastInput = input;

    if (this.script.throwBeforeHook !== undefined) throw this.script.throwBeforeHook;

    // La vraie primitive rend son résultat AVANT le crochet dans les deux modes
    // sans effet. Le double fait exactement pareil : sinon il exercerait un
    // chemin qui n'existe pas.
    if (input.stopAfter === 'thread') {
      return Object.freeze({
        kind: 'PREVIEWED' as const,
        detail: 'fil atteint et vérifié (double)',
        sessionState: 'SESSION_READY' as const,
        threadUrl: `https://www.instagram.com/direct/t/${input.target.expectedThreadId}/`,
        threadHandle: input.target.expectedHandle,
        priorBubbles: 6,
        composerReady: true,
        screenshotPath: null,
      });
    }
    if (input.stopAfter === 'draft') {
      return Object.freeze({
        kind: 'DRAFT_READY' as const,
        detail: 'brouillon constaté sans clic (double)',
        sessionState: 'SESSION_READY' as const,
        threadUrl: `https://www.instagram.com/direct/t/${input.target.expectedThreadId}/`,
        threadHandle: input.target.expectedHandle,
        priorBubbles: 6,
        composerText: input.body,
        payloadExact: true,
        sendControl: {
          outcome: 'SEND_CONTROL_MATCH' as const,
          chosen: null,
          seen: 1,
          inScope: 1,
          detail: 'double de test — unique et actif dans le panneau confirmé',
        },
        sendControlPresent: true,
        sendControlEnabled: true,
        composerDescriptor: 'div[contenteditable=true] focus=true',
        composerCleared: true,
        screenshotPath: null,
      });
    }

    await input.onBeforeExternalEffect();
    this.hookCalls += 1;

    if (this.script.throwAfterHook !== undefined) throw this.script.throwAfterHook;
    return this.script.result ?? sent(input);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function sent(input: InstagramReplyInput): InstagramReplyResult {
  return Object.freeze({
    kind: 'ATTEMPTED' as const,
    observation: Object.freeze({
      threadUrl: `https://www.instagram.com/direct/t/${input.target.expectedThreadId}/`,
      observedThreadId: input.target.expectedThreadId,
      threadHandle: input.target.expectedHandle,
      priorBubbles: 6,
      matchingBubblesBefore: 0,
      matchingBubblesAfter: 1,
      harvestReadableBefore: true,
      harvestReadableAfter: true,
      composerCleared: true,
      outgoingBubbleConfirmed: true,
      deliveryFailureMarkers: Object.freeze([]),
      deliveryVerdict: 'SENT' as const,
      scopeDetail: 'niveau 3 retenu (double)',
      sessionState: 'SESSION_READY' as const,
      screenshotPath: null,
      durationMs: 3_100,
      detail: 'clic unique effectué (double)',
    }),
  });
}

// ---------------------------------------------------------------------------
// Le montage : un prospect Instagram, un tour, une analyse, un brouillon
// ---------------------------------------------------------------------------

interface Scene {
  readonly prospect: ContactedProspect;
  readonly handle: string;
  readonly inboundId: string;
  readonly assessment: ConversationAssessment;
  readonly plan: ConversationPlan;
}

async function newScene(
  options: {
    body?: string;
    category?: ReplyCategory;
    receivedAt?: string;
    threadId?: string;
    identityConfirmed?: boolean;
    draftBody?: string;
    recordPlan?: boolean;
  } = {},
): Promise<Scene> {
  handleCounter += 1;
  // Le handle DOIT ressembler au nom de l'entreprise : la porte d'éligibilité
  // ICP refuse de verrouiller un manifeste vers un compte sans rapport lexical
  // avec la fiche (`enforceIcpEligibility`). Cette garde est réelle, elle
  // s'applique au premier contact de ces fixtures, et la contourner ferait
  // valider une forme de donnée qui n'existe pas en production.
  const displayName = `ACME ATELIER ${String(handleCounter)}`;
  const handle = `acmeatelier${String(handleCounter)}`;
  const prospect = await fixtures.contactedProspect(handle, {
    transport: 'instagram_dm',
    displayName,
  });

  if (options.identityConfirmed !== false) {
    await sql.query(`update prospects set identity_review = 'confirmed' where id = $1`, [
      prospect.prospectId,
    ]);
  }

  const inboundId = await inboundTurn(prospect, handle, {
    body: options.body ?? 'oui je fais déjà de la pub mais ça marche moyen',
    category: options.category ?? 'OBJECTION',
    receivedAt: options.receivedAt ?? '2026-08-21T13:00:00.000Z',
    threadId: options.threadId ?? THREAD_ID,
    draftBody: options.draftBody ?? REPLY_BODY,
  });

  // La salve doit être CLOSE pour que la décision soit éligible : `now` est
  // largement postérieur au dernier message, comme il le serait en production.
  const assessment = await assess(inboundId);
  const plan =
    options.recordPlan === false
      ? (null as unknown as ConversationPlan)
      : (await recordConversationPlan(sql, planInputFrom(assessment))).plan;

  return { prospect, handle, inboundId, assessment, plan };
}

const NOW = new Date('2026-08-21T14:00:00.000Z');

async function assess(inboundId: string): Promise<ConversationAssessment> {
  const assessment = await assessInboundMessage(sql, inboundId, { config: conversation, now: NOW });
  if (assessment === null) throw new Error(`tour ${inboundId} non évaluable`);
  return assessment;
}

async function inboundTurn(
  prospect: ContactedProspect,
  handle: string,
  spec: {
    body: string;
    category: ReplyCategory;
    receivedAt: string;
    threadId: string;
    draftBody: string | null;
  },
): Promise<string> {
  const id = await fixtures.instagramInbound({
    manifest: prospect.manifest,
    outreachEventId: prospect.outreachEventId,
    prospectId: prospect.prospectId,
    body: spec.body,
    threadId: spec.threadId,
    accountHandle: ACCOUNT_HANDLE,
    from: handle,
    receivedAt: spec.receivedAt,
  });

  const context = await loadReplyContext(sql, id);
  if (context === null) throw new Error('contexte introuvable');

  const decision = decideCategory({
    category: spec.category,
    confidence: 0.95,
    correlationStatus: context.reply.correlationStatus,
    deterministic: true,
    unsubscribeDemand: detectUnsubscribeDemand(spec.body),
  });
  await persistAnalysis(sql, context, {
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
    promptVersion: 'test',
    inputSha256: 'f'.repeat(64),
    modelRunId: null,
  });

  if (spec.draftBody !== null) {
    const analysis = await loadActiveAnalysis(sql, id);
    if (analysis === null) throw new Error('analyse introuvable');
    await persistDraft(sql, context, analysis, {
      body: spec.draftBody,
      bodySha256: sha256Hex(spec.draftBody),
      rationale: 'test',
      guardrailFlags: [],
      blocked: false,
      model: 'test-model',
      effort: null,
      // Le rail autonome ne lit que le brouillon écrit sous la consigne
      // COURANTE (HERMES-END-TO-END-CERTIFICATION-R1). Une version inventée
      // modéliserait un texte que la production ne relirait jamais.
      promptVersion: conversationPromptVersionFor('instagram_dm'),
      modelRunId: null,
    });
  }
  return id;
}

function planInputFrom(assessment: ConversationAssessment): RecordPlanInput {
  return {
    prospectId: assessment.prospectId,
    channel: 'instagram_dm',
    kind: 'AUTO_REPLY',
    triggerInboundMessageId: assessment.inboundMessageId,
    // Comme `planConversationReply` en production : l'intention porte l'analyse
    // sur laquelle elle repose, sinon sa clé ne serait pas celle que
    // `assessment.idempotencyKey` annonce.
    understandingRef: assessment.analysisId,
    // …et sous quelles RÈGLES : `assessment.idempotencyKey` porte les deux, donc
    // omettre l'une ferait chercher le plan sous une clé qui n'existe pas.
    policyRef: assessment.policyVersion,
    policyVersion: assessment.policyVersion,
    commercialPolicyVersion: assessment.commercialPolicyVersion,
    brainVersion: conversationPromptVersionFor('instagram_dm'),
    decision: 'AUTO_REPLY_ELIGIBLE',
    decisionGate: assessment.autonomous.gate,
    decisionReason: assessment.autonomous.reason,
    decisionDetail: assessment.autonomous.detail,
    conversationWatermark: assessment.conversationWatermark,
    body: assessment.draft?.body ?? REPLY_BODY,
    naturalnessVerdict: assessment.draft?.naturalness.verdict ?? 'NATURAL',
    groundingGaps: [],
    offerReadiness: assessment.offer.readiness,
    callReadiness: assessment.callReadiness,
    // Dû : le délai humain a déjà couru quand le worker regarde.
    notBefore: new Date('2026-08-21T13:10:00.000Z'),
  };
}

/**
 * Repousse les tentatives d'effet hors de toutes les fenêtres de plafond.
 *
 * Les plafonds sont RÉELLEMENT partagés : dès qu'un test a réservé un créneau,
 * l'intervalle minimal refuse tous les suivants. Sans cette remise à zéro,
 * chaque test suivant prouverait seulement, une fois de plus, que l'intervalle
 * mord. Les tentatives sont REPOUSSÉES et jamais effacées : un plan `SENT` doit
 * porter la sienne (`hermes_plan_effect_precedes_outcome`).
 */
async function resetEffectLedger(): Promise<void> {
  await sql.query(
    `update hermes_conversation_plans
        set external_effect_started_at = now() - interval '2 days'
      where external_effect_attempted = true`,
  );
}

/** L'arrêt global levé, comme un opérateur nommé le ferait. */
async function releaseKillSwitch(): Promise<void> {
  await setKillSwitch(sql, { engaged: false, setBy: 'test', reason: 'porte observée par un test' });
}

async function run(
  rail: FakeReplyRail,
  options: { mode?: 'PREVIEW' | 'DRAFT' | 'LIVE'; planId?: string } = {},
): ReturnType<typeof executeConversationReply> {
  return executeConversationReply(
    {
      sql,
      config,
      conversation,
      workerId: 'test-reply-worker',
      mode: options.mode ?? 'LIVE',
      ...(options.planId === undefined ? {} : { planId: options.planId }),
      now: () => NOW,
    },
    { rail },
  );
}

// ---------------------------------------------------------------------------
// §16 — la frontière décision → exécution
// ---------------------------------------------------------------------------

describe('§16 — décision → exécution', () => {
  it('AUTO_REPLY_ELIGIBLE peut produire un plan, et le plan peut produire un effet', async () => {
    const scene = await newScene();
    expect(scene.assessment.autonomous.outcome).toBe('AUTO_REPLY_ELIGIBLE');
    expect(scene.plan.decision).toBe('AUTO_REPLY_ELIGIBLE');

    await releaseKillSwitch();
    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });

    expect(outcome.status).toBe('SENT');
    expect(outcome.externalEffectAttempted).toBe(true);
    expect(rail.hookCalls).toBe(1);

    const plan = await loadConversationPlan(sql, scene.plan.id);
    expect(plan?.status).toBe('SENT');
    expect(plan?.externalEffectAttempted).toBe(true);
  });

  it('la CIBLE passée à la primitive vient de la base, jamais d’une page', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    const rail = new FakeReplyRail();
    await run(rail, { planId: scene.plan.id });

    expect(rail.lastInput?.target.expectedThreadId).toBe(THREAD_ID);
    expect(rail.lastInput?.target.expectedHandle).toBe(scene.handle);
    expect(rail.lastInput?.target.expectedAccountHandle).toBe(ACCOUNT_HANDLE);
  });

  it('§10 — la PROVENANCE part avec l’appel, et se retrouve dans la trace', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });

    expect(rail.lastInput?.provenance.source).toBe('HERMES_AUTONOMOUS_REPLY');
    expect(rail.lastInput?.provenance.planId).toBe(scene.plan.id);
    expect(rail.lastInput?.provenance.inboundMessageId).toBe(scene.inboundId);
    expect(rail.lastInput?.provenance.idempotencyKey).toBe(scene.plan.idempotencyKey);
    expect(rail.lastInput?.provenance.commercialPolicyVersion).toBe(
      scene.assessment.commercialPolicyVersion,
    );

    const rows = await sql.query<{
      source: string;
      status: string;
      targetThreadId: string;
      deliveryConfirmed: boolean;
      effectAttempted: boolean;
      effectObserved: boolean;
    }>(
      `select source, status, target_thread_id as "targetThreadId",
              delivery_confirmed as "deliveryConfirmed",
              effect_attempted as "effectAttempted",
              effect_observed as "effectObserved"
         from hermes_conversation_effects where id = $1`,
      [outcome.effectId],
    );
    expect(rows[0]?.source).toBe('HERMES_AUTONOMOUS_REPLY');
    expect(rows[0]?.status).toBe('SENT');
    expect(rows[0]?.targetThreadId).toBe(THREAD_ID);
    expect(rows[0]?.effectAttempted).toBe(true);
    expect(rows[0]?.effectObserved).toBe(true);
    expect(rows[0]?.deliveryConfirmed).toBe(true);
  });

  it('une décision qui n’est PAS éligible ne produit aucun plan actionnable', async () => {
    // Un refus clair : la politique rend TERMINAL_STOP, et `recordConversationPlan`
    // inscrit une intention CLOSE. Il n'existe alors rien à prendre.
    const scene = await newScene({
      body: 'non merci, pas intéressé',
      category: 'NOT_INTERESTED',
      recordPlan: false,
    });
    expect(scene.assessment.autonomous.outcome).toBe('TERMINAL_STOP');

    const recorded = await recordConversationPlan(sql, {
      ...planInputFrom(scene.assessment),
      decision: 'TERMINAL_STOP',
      decisionReason: scene.assessment.autonomous.reason,
    });
    expect(recorded.plan.status).toBe('CANCELLED');

    await releaseKillSwitch();
    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: recorded.plan.id });
    expect(outcome.status).toBe('NO_PLAN');
    expect(rail.calls).toBe(0);
    expect(rail.hookCalls).toBe(0);
  });

  it('un plan dont le TEXTE n’est plus celui que la politique a jugé ne part pas', async () => {
    const scene = await newScene();
    await releaseKillSwitch();

    // Le plan porte un texte que l'évaluation d'aujourd'hui ne reconnaît pas.
    // C'est la situation d'un plan écrit depuis un brouillon remplacé depuis :
    // ce qu'il ferait partir n'a été jugé par personne.
    const other = 'Et vous en recevez souvent, des demandes comme ça ?';
    await sql.query(
      `update hermes_conversation_plans set body = $2, body_sha256 = $3 where id = $1`,
      [scene.plan.id, other, sha256Hex(other)],
    );

    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });
    expect(outcome.reasonCode).toBe('REPLY_DRAFT_CHANGED');
    expect(outcome.externalEffectAttempted).toBe(false);
    expect(rail.calls).toBe(0);
  });

  it('un brouillon RÉÉCRIT par un humain après la planification ne part pas non plus', async () => {
    const scene = await newScene();
    await releaseKillSwitch();

    const drafts = await sql.query<{ id: string }>(
      `select id from r6b_reply_drafts where prospect_id = $1`,
      [scene.prospect.prospectId],
    );
    await reviewDraft(sql, {
      draftId: drafts[0]!.id,
      decision: 'EDIT',
      reviewedBy: 'test',
      text: 'Et vous en recevez souvent, des demandes comme ça ?',
    });

    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });

    // Le MOTIF exact appartient à la politique — un brouillon repris par un
    // humain peut sortir du chemin autonome pour plus d'une raison, et ce test
    // ne fige pas laquelle. Ce qu'il fige est la seule chose qui compte : rien
    // ne part, et rien n'a été ouvert.
    expect(outcome.status).not.toBe('SENT');
    expect(outcome.externalEffectAttempted).toBe(false);
    expect(rail.calls).toBe(0);
    expect(rail.hookCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §6 — l'arrêt global
// ---------------------------------------------------------------------------

describe('§6 — l’arrêt global est une barrière, pas une consigne', () => {
  it('décision éligible + brouillon valide + session valide + arrêt ARMÉ = ZÉRO effet', async () => {
    const scene = await newScene();
    // Tout est vert par ailleurs : c'est exactement le test que la mission
    // demande, et il ne vaut que parce que les trois autres conditions tiennent.
    expect(scene.assessment.autonomous.outcome).toBe('AUTO_REPLY_ELIGIBLE');
    expect(scene.assessment.draft?.naturalness.verdict).not.toBe('UNNATURAL');
    expect(scene.plan.status).toBe('PLANNED');

    // L'arrêt est armé par le `beforeEach`, comme dans le dépôt.
    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reasonCode).toBe('BLOCKED_KILL_SWITCH');
    expect(outcome.externalEffectAttempted).toBe(false);
    // Le rail n'a même pas été appelé : la garde précède l'ouverture.
    expect(rail.calls).toBe(0);
    expect(rail.hookCalls).toBe(0);

    const plan = await loadConversationPlan(sql, scene.plan.id);
    expect(plan?.externalEffectAttempted).toBe(false);
    // Reporté, pas fermé : l'arrêt se lève, et le plan repartira.
    expect(plan?.status).toBe('SKIPPED');
  });

  it('un arrêt RÉARMÉ pendant l’exécution stoppe CE message, pas le suivant', async () => {
    // Le cas que §5 nomme : un humain voit quelque chose et réarme l'arrêt
    // pendant qu'un navigateur s'ouvre. La primitive a déjà tout vérifié ; c'est
    // le crochet, appelé juste avant le clic, qui doit refuser.
    const scene = await newScene();
    await releaseKillSwitch();

    class RearmingRail extends FakeReplyRail {
      override async sendThreadReply(input: InstagramReplyInput): Promise<InstagramReplyResult> {
        // Entre l'ouverture du fil et le clic, quelqu'un réarme.
        await setKillSwitch(sql, { engaged: true, setBy: 'test', reason: 'réarmé pendant l’exécution' });
        return super.sendThreadReply(input);
      }
    }

    const rail = new RearmingRail();
    const outcome = await run(rail, { planId: scene.plan.id });

    expect(rail.calls).toBe(1);
    // Le crochet a levé : il n'a jamais rendu la main.
    expect(rail.hookCalls).toBe(0);
    expect(outcome.reasonCode).toBe('BLOCKED_KILL_SWITCH');
    expect(outcome.externalEffectAttempted).toBe(false);
    const plan = await loadConversationPlan(sql, scene.plan.id);
    expect(plan?.externalEffectAttempted).toBe(false);
  });

  it('l’orchestrateur ne SAIT pas lever l’arrêt global', () => {
    // Cherché dans le CODE et non dans la prose : les deux fichiers NOMMENT
    // `setKillSwitch` pour dire qu'ils ne l'importent pas, et un test qui
    // interdirait le mot interdirait de l'écrire.
    const strip = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(strip(readFileSync(resolve(ROOT, 'src/lib/conversation/replyExecution.ts'), 'utf8'))).not.toContain(
      'setKillSwitch',
    );
    expect(strip(readFileSync(resolve(ROOT, 'src/cli/conversation-reply.ts'), 'utf8'))).not.toContain(
      'setKillSwitch',
    );
  });
});

// ---------------------------------------------------------------------------
// §5 — la fraîcheur
// ---------------------------------------------------------------------------

describe('§5 — la fraîcheur se lit sur received_at, et sur rien d’autre', () => {
  it('un nouvel entrant arrivé APRÈS la planification périme le brouillon', async () => {
    const scene = await newScene();
    await releaseKillSwitch();

    // La personne écrit à nouveau. Le plan répond à une phrase qui n'est plus
    // la dernière.
    await inboundTurn(scene.prospect, scene.handle, {
      body: 'enfin je sais pas trop en fait',
      category: 'QUESTION',
      receivedAt: '2026-08-21T13:40:00.000Z',
      threadId: THREAD_ID,
      draftBody: null,
    });

    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });
    expect(outcome.reasonCode).toBe('PLAN_STALE');
    expect(outcome.externalEffectAttempted).toBe(false);
    expect(rail.calls).toBe(0);
  });

  it('un message arrivé pendant l’ouverture du navigateur annule le clic', async () => {
    const scene = await newScene();
    await releaseKillSwitch();

    class LateInboundRail extends FakeReplyRail {
      override async sendThreadReply(input: InstagramReplyInput): Promise<InstagramReplyResult> {
        await inboundTurn(scene.prospect, scene.handle, {
          body: 'ah attends en fait',
          category: 'QUESTION',
          receivedAt: '2026-08-21T13:50:00.000Z',
          threadId: THREAD_ID,
          draftBody: null,
        });
        return super.sendThreadReply(input);
      }
    }

    const rail = new LateInboundRail();
    const outcome = await run(rail, { planId: scene.plan.id });
    expect(rail.calls).toBe(1);
    expect(rail.hookCalls).toBe(0);
    expect(outcome.reasonCode).toBe('PLAN_STALE');
    expect(outcome.externalEffectAttempted).toBe(false);
  });

  // HERMES-PLAN-STALE-TRIGGER-FIX-R1 — ce test disait l'inverse jusqu'au
  // 23 août 2026 : « une marque de fraîcheur PÉRIMÉE bloque, même sans message
  // plus récent ». C'était précisément le défaut. Une marque en retard sur un
  // fil où RIEN n'est arrivé depuis le déclencheur ne décrit aucun fait
  // nouveau : le dernier message de la conversation est celui auquel ce plan
  // répond. Le refus qui en sortait a bloqué le premier tour réellement
  // éligible, et aurait bloqué tous les suivants.
  it('une marque en retard ne périme rien tant que le dernier entrant EST le déclencheur', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    // Le plan porte une marque plus ancienne que la réalité — un arrondi, une
    // relecture, un rejeu. Son déclencheur reste le dernier message du fil.
    await sql.query(
      `update hermes_conversation_plans set conversation_watermark = $2 where id = $1`,
      [scene.plan.id, '2026-08-20T09:00:00.000Z'],
    );

    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });
    expect(outcome.reasonCode).not.toBe('PLAN_STALE');
    expect(rail.calls).toBe(1);
  });

  it('la même marque en retard bloque dès qu’un AUTRE message est arrivé', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    await sql.query(
      `update hermes_conversation_plans set conversation_watermark = $2 where id = $1`,
      [scene.plan.id, '2026-08-20T09:00:00.000Z'],
    );
    await inboundTurn(scene.prospect, scene.handle, {
      body: 'ah et aussi',
      category: 'QUESTION',
      receivedAt: '2026-08-21T13:45:00.000Z',
      threadId: THREAD_ID,
      draftBody: null,
    });

    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });
    expect(outcome.reasonCode).toBe('PLAN_STALE');
    expect(rail.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §3 — l'identité et le fil
// ---------------------------------------------------------------------------

describe('§3 — la cible, ou rien', () => {
  it('un fil ambigu (deux fils pour un prospect) FERME la porte', async () => {
    const scene = await newScene();
    await releaseKillSwitch();

    // Le message le plus récent vit dans un AUTRE fil : répondre dans le
    // premier pendant que le second bouge reviendrait à répondre à côté.
    await inboundTurn(scene.prospect, scene.handle, {
      body: 'je vous écris depuis une demande de message',
      category: 'QUESTION',
      receivedAt: '2026-08-21T13:30:00.000Z',
      threadId: '99999999999999',
      draftBody: null,
    });

    const resolution = await resolveReplyTarget(sql, {
      prospectId: scene.prospect.prospectId,
      triggerInboundMessageId: scene.inboundId,
      account: TEST_ACCOUNT_IDENTITY,
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.refusal).toBe('TARGET_THREAD_AMBIGUOUS');

    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });
    expect(outcome.reasonCode).toBe('TARGET_THREAD_AMBIGUOUS');
    expect(rail.calls).toBe(0);
  });

  it('un message sans identifiant de fil ne produit aucune cible', async () => {
    const scene = await newScene();
    await sql.query(`update r6b_inbound_messages set provider_thread_id = null where id = $1`, [
      scene.inboundId,
    ]);
    const resolution = await resolveReplyTarget(sql, {
      prospectId: scene.prospect.prospectId,
      triggerInboundMessageId: scene.inboundId,
      account: TEST_ACCOUNT_IDENTITY,
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.refusal).toBe('TARGET_NO_THREAD_ID');
  });

  it('un expéditeur qui ne concorde pas avec la fiche ferme la porte', async () => {
    const scene = await newScene();
    await sql.query(`update prospects set instagram_handle = $2 where id = $1`, [
      scene.prospect.prospectId,
      'quelqu_un_dautre',
    ]);
    const resolution = await resolveReplyTarget(sql, {
      prospectId: scene.prospect.prospectId,
      triggerInboundMessageId: scene.inboundId,
      account: TEST_ACCOUNT_IDENTITY,
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.refusal).toBe('TARGET_HANDLE_MISMATCH');
  });

  // -------------------------------------------------------------------------
  // HERMES-IDENTITY-CANONICALIZATION-R1 §6/§22 — notre compte, renommé
  // -------------------------------------------------------------------------

  it('§6 — une ligne écrite sous l’ANCIEN nom reste exploitable, sans être réécrite', async () => {
    const scene = await newScene();
    // Ce qu'il s'est réellement passé le 22 août 2026 : le compte a été
    // renommé, et les lignes déjà écrites portent le nom d'avant. Elles
    // décrivent une observation datée, et rien ne doit les toucher.
    await sql.query(`update r6b_inbound_messages set mailbox = $2 where id = $1`, [
      scene.inboundId,
      'ancien_nom_du_compte',
    ]);

    const renamed = canonicalAccountIdentity({
      accountHandle: ACCOUNT_HANDLE,
      formerAccountHandles: ['ancien_nom_du_compte'],
    });
    if (!renamed.ok) throw new Error(renamed.detail);

    const resolution = await resolveReplyTarget(sql, {
      prospectId: scene.prospect.prospectId,
      triggerInboundMessageId: scene.inboundId,
      account: renamed.identity,
    });
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      // Ce qui part vers la page est le nom d'AUJOURD'HUI…
      expect(resolution.target.accountHandle).toBe(ACCOUNT_HANDLE);
      // …et le nom observé est rendu tel quel, sans être corrigé.
      expect(resolution.target.observedAccountHandle).toBe('ancien_nom_du_compte');
    }

    // Et la ligne n'a pas bougé : résoudre une cible ne réécrit pas l'histoire.
    const rows = await sql.query<{ mailbox: string }>(
      `select mailbox from r6b_inbound_messages where id = $1`,
      [scene.inboundId],
    );
    expect(rows[0]?.mailbox).toBe('ancien_nom_du_compte');
  });

  it('§6 — sans déclaration d’ancien nom, la même ligne REFUSE plutôt que de deviner', async () => {
    const scene = await newScene();
    await sql.query(`update r6b_inbound_messages set mailbox = $2 where id = $1`, [
      scene.inboundId,
      'ancien_nom_du_compte',
    ]);
    const resolution = await resolveReplyTarget(sql, {
      prospectId: scene.prospect.prospectId,
      triggerInboundMessageId: scene.inboundId,
      account: TEST_ACCOUNT_IDENTITY,
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.refusal).toBe('TARGET_ACCOUNT_NOT_OURS');
  });

  it('§6 — une boîte ÉTRANGÈRE n’est jamais la nôtre, et le plan est bloqué', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    await sql.query(`update r6b_inbound_messages set mailbox = $2 where id = $1`, [
      scene.inboundId,
      'boite_de_quelqu_un_dautre',
    ]);

    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });
    expect(outcome.reasonCode).toBe('TARGET_ACCOUNT_NOT_OURS');
    // Aucun navigateur, aucune saisie : le refus est antérieur au rail.
    expect(rail.calls).toBe(0);
  });

  it('§6 — la CIBLE porte le compte COURANT, pas celui inscrit sur la ligne', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    await sql.query(`update r6b_inbound_messages set mailbox = $2 where id = $1`, [
      scene.inboundId,
      ACCOUNT_HANDLE.toUpperCase(),
    ]);

    const rail = new FakeReplyRail();
    await run(rail, { planId: scene.plan.id });
    expect(rail.lastInput?.target.expectedAccountHandle).toBe(ACCOUNT_HANDLE);
  });

  it('une identité NON confirmée bloque, même avec une cible parfaite', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    await sql.query(`update prospects set identity_review = 'manual_review' where id = $1`, [
      scene.prospect.prospectId,
    ]);

    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });
    expect(outcome.reasonCode).toBe('IDENTITY_UNCONFIRMED');
    expect(rail.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §7 — idempotence
// ---------------------------------------------------------------------------

describe('§7 — un effet logique, une fois', () => {
  it('le même plan exécuté deux fois ne produit qu’UN effet', async () => {
    const scene = await newScene();
    await releaseKillSwitch();

    const first = new FakeReplyRail();
    const one = await run(first, { planId: scene.plan.id });
    expect(one.status).toBe('SENT');
    expect(first.hookCalls).toBe(1);

    await resetEffectLedger();
    const second = new FakeReplyRail();
    const two = await run(second, { planId: scene.plan.id });

    // Le plan est clos et absorbant : il n'est plus réclamable du tout.
    expect(two.status).toBe('NO_PLAN');
    expect(second.calls).toBe(0);
    expect(second.hookCalls).toBe(0);

    const rows = await sql.query<{ count: string }>(
      `select count(*)::text as count from hermes_conversation_effects
        where plan_id = $1 and effect_attempted = true`,
      [scene.plan.id],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('la base REFUSE une seconde tentative sur la même intention logique', async () => {
    // La garde ne tient pas par le code : elle tient par un index unique
    // partiel. Un second worker qui aurait contourné toutes les portes
    // applicatives se heurterait quand même à celui-ci.
    const scene = await newScene();
    await releaseKillSwitch();
    const rail = new FakeReplyRail();
    await run(rail, { planId: scene.plan.id });

    await expect(
      sql.query(
        `insert into hermes_conversation_effects
           (plan_id, prospect_id, channel, policy_version, commercial_policy_version, brain_version,
            idempotency_key, trigger_inbound_message_id, body_sha256,
            target_thread_id, target_handle, account_handle,
            mode, status, reason_code, effect_attempted, effect_observed, delivery_confirmed, worker_id)
         values ($1,$2,'instagram_dm','p','c','b',$3,$4,$5,$6,$7,$8,
                 'LIVE','AMBIGUOUS','REPLAY',true,false,false,'pirate')`,
        [
          scene.plan.id,
          scene.prospect.prospectId,
          scene.plan.idempotencyKey,
          scene.inboundId,
          'a'.repeat(64),
          THREAD_ID,
          scene.handle,
          ACCOUNT_HANDLE,
        ],
      ),
    ).rejects.toThrow();
  });

  it('un aperçu ne consomme pas l’intention : le plan reste réclamable', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    const rail = new FakeReplyRail();
    const outcome = await run(rail, { mode: 'PREVIEW', planId: scene.plan.id });

    expect(outcome.status).toBe('PREVIEWED');
    expect(outcome.externalEffectAttempted).toBe(false);
    expect(rail.hookCalls).toBe(0);
    const plan = await loadConversationPlan(sql, scene.plan.id);
    expect(plan?.status).toBe('SKIPPED');
    expect(plan?.externalEffectAttempted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §8 — l'ambigu d'après-effet
// ---------------------------------------------------------------------------

describe('§8 — « on a essayé, on ne sait pas » ne se rejoue pas', () => {
  it('un crash APRÈS la réservation devient AMBIGUOUS, et le plan est clos', async () => {
    const scene = await newScene();
    await releaseKillSwitch();

    const rail = new FakeReplyRail({
      throwAfterHook: new Error('Target page, context or browser has been closed'),
    });
    const outcome = await run(rail, { planId: scene.plan.id });

    expect(rail.hookCalls).toBe(1);
    expect(outcome.status).toBe('AMBIGUOUS');
    expect(outcome.reasonCode).toBe('REPLY_AMBIGUOUS_POST_EFFECT');
    expect(outcome.externalEffectAttempted).toBe(true);

    const plan = await loadConversationPlan(sql, scene.plan.id);
    expect(plan?.status).toBe('AMBIGUOUS');
    expect(plan?.externalEffectAttempted).toBe(true);
    expect(plan?.terminatedAt).not.toBeNull();
  });

  it('un plan AMBIGUOUS n’est JAMAIS repris automatiquement', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    await run(new FakeReplyRail({ throwAfterHook: new Error('navigateur perdu') }), {
      planId: scene.plan.id,
    });

    await resetEffectLedger();
    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });
    expect(outcome.status).toBe('NO_PLAN');
    expect(rail.calls).toBe(0);
  });

  it('un AMBIGU n’est jamais transformé en « échec avant effet »', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    const outcome = await run(new FakeReplyRail({ throwAfterHook: new Error('boum') }), {
      planId: scene.plan.id,
    });

    const rows = await sql.query<{ status: string; effectAttempted: boolean }>(
      `select status, effect_attempted as "effectAttempted"
         from hermes_conversation_effects where id = $1`,
      [outcome.effectId],
    );
    expect(rows[0]?.status).toBe('AMBIGUOUS');
    expect(rows[0]?.effectAttempted).toBe(true);
    // Et surtout : pas BLOCKED, pas FAILED, pas SKIPPED.
    expect(['BLOCKED', 'FAILED']).not.toContain(rows[0]?.status);
  });

  it('une panne AVANT le crochet laisse le plan repartir — rien n’a eu lieu', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    const rail = new FakeReplyRail({ throwBeforeHook: new Error('navigation échouée') });
    const outcome = await run(rail, { planId: scene.plan.id });

    expect(rail.hookCalls).toBe(0);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.externalEffectAttempted).toBe(false);
    const plan = await loadConversationPlan(sql, scene.plan.id);
    expect(plan?.status).toBe('SKIPPED');
    expect(plan?.externalEffectAttempted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §4 — le bail navigateur
// ---------------------------------------------------------------------------

describe('§4 — un profil occupé n’est pas une panne', () => {
  it('la contention rend BROWSER_PROFILE_BUSY, sans attente et sans effet', async () => {
    const scene = await newScene();
    await releaseKillSwitch();

    const busy = new InstagramBrowserProfileBusyError(
      'var/instagram/profile',
      'var/instagram/profile.browser-lease',
      { pid: 4242, hostname: 'machine-test', startedAt: '2026-08-21T13:00:00.000Z', cmd: 'ig:inbound:run' },
    );
    const rail = new FakeReplyRail({ throwBeforeHook: busy });
    const outcome = await run(rail, { planId: scene.plan.id });

    expect(outcome.reasonCode).toBe('BROWSER_PROFILE_BUSY');
    expect(outcome.externalEffectAttempted).toBe(false);
    expect(rail.hookCalls).toBe(0);
    // Reporté, pas fermé : la contention est normale, elle cessera seule.
    const plan = await loadConversationPlan(sql, scene.plan.id);
    expect(plan?.status).toBe('SKIPPED');
  });
});

// ---------------------------------------------------------------------------
// HERMES-CONVERSATION-SKIPPED-RECLAIM-R1 — la REPRISE d'un report
// ---------------------------------------------------------------------------

/**
 * Le cas réel du 23 août 2026 : un plan `AUTO_REPLY_ELIGIBLE` reporté sur une
 * contention de profil, sans le moindre effet, que la borne échue doit rendre
 * à nouveau exécutable — sous TOUTES les portes, relues à neuf.
 *
 * Ce que ces tests refusent de laisser passer : que « réclamable » finisse par
 * vouloir dire « envoyable ». Une reprise repasse par le crochet pré-effet
 * exactement comme un premier essai, et chacun des quatre derniers tests le
 * montre en refermant une porte DIFFÉRENTE entre le report et la reprise.
 */
describe('§C — un report échu redevient exécutable, sous les mêmes portes', () => {
  const busy = (): InstagramBrowserProfileBusyError =>
    new InstagramBrowserProfileBusyError(
      'var/instagram/profile',
      'var/instagram/profile.browser-lease',
      { pid: 4242, hostname: 'machine-test', startedAt: '2026-08-21T13:00:00.000Z', cmd: 'ig:inbound:run' },
    );

  /** Fait échoir la borne de réclamation, comme le temps l'aurait fait. */
  async function backoffElapsed(planId: string): Promise<void> {
    await sql.query(
      `update hermes_conversation_plans set not_before = now() - interval '1 second' where id = $1`,
      [planId],
    );
  }

  /** Le report initial : profil occupé, rien d'ouvert, rien de tenté. */
  async function deferOnContention(planId: string): Promise<void> {
    const rail = new FakeReplyRail({ throwBeforeHook: busy() });
    const outcome = await run(rail, { planId });
    expect(outcome.reasonCode).toBe('BROWSER_PROFILE_BUSY');
    expect(outcome.externalEffectAttempted).toBe(false);
    expect(rail.hookCalls).toBe(0);
    const plan = await loadConversationPlan(sql, planId);
    expect(plan?.status).toBe('SKIPPED');
    expect(plan?.externalEffectAttempted).toBe(false);
    // La borne EXISTE et elle est postérieure au refus : le report n'est pas
    // une porte ouverte, c'est une porte qui se rouvrira. (Elle est lue sur
    // l'horloge injectée, celle que l'exécution a utilisée pour l'écrire.)
    expect(Date.parse(plan!.notBefore)).toBeGreaterThan(NOW.getTime());
  }

  it('la borne future refuse la prise — rien n’est ouvert, rien n’est tenté', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    await deferOnContention(scene.plan.id);
    // La prise atomique lit l'horloge de la BASE, pas celle qu'un test injecte :
    // la borne est portée dans le futur de cette horloge-là.
    await sql.query(
      `update hermes_conversation_plans set not_before = now() + interval '10 minutes' where id = $1`,
      [scene.plan.id],
    );

    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });
    expect(outcome.status).toBe('NO_PLAN');
    expect(rail.calls).toBe(0);
    expect(rail.hookCalls).toBe(0);
  });

  it('la borne échue rend le plan au registre, et il part', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    await deferOnContention(scene.plan.id);
    await backoffElapsed(scene.plan.id);
    await resetEffectLedger();

    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });
    expect(outcome.status).toBe('SENT');
    expect(rail.hookCalls).toBe(1);

    const plan = await loadConversationPlan(sql, scene.plan.id);
    expect(plan?.status).toBe('SENT');
    // Une seule tentative d'effet, malgré DEUX passages : la première n'en a
    // produit aucune.
    expect(plan?.attempts).toBe(2);
    const effects = await sql.query<{ total: string }>(
      `select count(*)::text as total from hermes_conversation_effects
        where plan_id = $1 and effect_attempted = true`,
      [scene.plan.id],
    );
    expect(effects[0]?.total).toBe('1');
  });

  it('§K — un profil ENCORE occupé produit un report propre, pas un effet', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    await deferOnContention(scene.plan.id);
    await backoffElapsed(scene.plan.id);

    const rail = new FakeReplyRail({ throwBeforeHook: busy() });
    const outcome = await run(rail, { planId: scene.plan.id });
    expect(outcome.reasonCode).toBe('BROWSER_PROFILE_BUSY');
    expect(outcome.externalEffectAttempted).toBe(false);
    expect(rail.hookCalls).toBe(0);

    const plan = await loadConversationPlan(sql, scene.plan.id);
    expect(plan?.status).toBe('SKIPPED');
    // Une borne NEUVE, repoussée à nouveau : le report se répète proprement,
    // il ne s'épuise pas en une boucle sans fin.
    expect(Date.parse(plan!.notBefore)).toBeGreaterThan(NOW.getTime());
  });

  it('§H — un message arrivé pendant le report périme la reprise', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    await deferOnContention(scene.plan.id);

    // La personne écrit à nouveau PENDANT le backoff. Le plan reste
    // réclamable au sens du registre — c'est la fraîcheur qui le referme.
    await inboundTurn(scene.prospect, scene.handle, {
      body: 'enfin bref',
      category: 'QUESTION',
      receivedAt: '2026-08-21T13:40:00.000Z',
      threadId: THREAD_ID,
      draftBody: null,
    });
    await backoffElapsed(scene.plan.id);

    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });
    expect(outcome.reasonCode).toBe('PLAN_STALE');
    expect(outcome.externalEffectAttempted).toBe(false);
    expect(rail.calls).toBe(0);
  });

  it('§I — un arrêt global RÉARMÉ pendant le report referme la reprise', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    await deferOnContention(scene.plan.id);
    await backoffElapsed(scene.plan.id);

    await setKillSwitch(sql, { engaged: true, setBy: 'test', reason: 'réarmé pendant le report' });

    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });
    expect(outcome.reasonCode).toBe('BLOCKED_KILL_SWITCH');
    expect(outcome.externalEffectAttempted).toBe(false);
    expect(rail.calls).toBe(0);
  });

  it('§J — un plafond devenu bloquant pendant le report referme la reprise', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    await deferOnContention(scene.plan.id);
    await backoffElapsed(scene.plan.id);

    // Un AUTRE message part entre-temps : l'espacement minimal est partagé, et
    // il mord sur la reprise exactement comme sur un premier contact.
    await resetEffectLedger();
    const other = await newScene();
    const first = await run(new FakeReplyRail(), { planId: other.plan.id });
    expect(first.status).toBe('SENT');

    const rail = new FakeReplyRail();
    const outcome = await run(rail, { planId: scene.plan.id });
    expect(outcome.status).not.toBe('SENT');
    expect(outcome.externalEffectAttempted).toBe(false);
    expect(rail.hookCalls).toBe(0);
    expect(['BLOCKED_COOLDOWN', 'BLOCKED_HOURLY_CAP', 'BLOCKED_DAILY_CAP']).toContain(
      outcome.reasonCode,
    );
  });

  it('§F/§G — un plan qui a TENTÉ un effet n’est jamais rendu au registre', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    // Une panne APRÈS le crochet : la réservation est commitée, donc « rien
    // n'a eu lieu » est faux.
    const outcome = await run(new FakeReplyRail({ throwAfterHook: new Error('boum') }), {
      planId: scene.plan.id,
    });
    expect(outcome.externalEffectAttempted).toBe(true);

    const plan = await loadConversationPlan(sql, scene.plan.id);
    expect(plan?.status).toBe('AMBIGUOUS');
    // Même en forçant la borne — ce qu'aucun code ne fait —, il ne repart pas.
    await backoffElapsed(scene.plan.id);
    const rail = new FakeReplyRail();
    const again = await run(rail, { planId: scene.plan.id });
    expect(again.status).toBe('NO_PLAN');
    expect(rail.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §16 — les états terminaux
// ---------------------------------------------------------------------------

describe('§16 — les états terminaux ne produisent aucun effet', () => {
  const terminals: ReadonlyArray<readonly [string, (scene: Scene) => Promise<void>]> = [
    [
      'do_not_contact (opt-out)',
      async (scene) => {
        await sql.query(
          `insert into do_not_contact (match_kind, value, reason, added_by)
             values ('instagram',$1,'test','test')`,
          [scene.handle],
        );
      },
    ],
    [
      'état SUPPRESSED',
      async (scene) => {
        await sql.query(
          `insert into r6b_prospect_outreach_states (prospect_id, state) values ($1,'SUPPRESSED')
             on conflict (prospect_id) do update set state = 'SUPPRESSED'`,
          [scene.prospect.prospectId],
        );
      },
    ],
    [
      'état NOT_INTERESTED',
      async (scene) => {
        await sql.query(
          `insert into r6b_prospect_outreach_states (prospect_id, state) values ($1,'NOT_INTERESTED')
             on conflict (prospect_id) do update set state = 'NOT_INTERESTED'`,
          [scene.prospect.prospectId],
        );
      },
    ],
  ];

  for (const [label, apply] of terminals) {
    it(`${label} → zéro effet`, async () => {
      const scene = await newScene();
      await releaseKillSwitch();
      await apply(scene);

      const rail = new FakeReplyRail();
      const outcome = await run(rail, { planId: scene.plan.id });

      expect(outcome.externalEffectAttempted).toBe(false);
      expect(rail.calls).toBe(0);
      expect(rail.hookCalls).toBe(0);
      const plan = await loadConversationPlan(sql, scene.plan.id);
      expect(plan?.externalEffectAttempted).toBe(false);
      expect(plan?.status).toBe('BLOCKED');
    });
  }

  it('une demande d’arrêt (UNSUBSCRIBE) ne devient jamais un plan actionnable', async () => {
    const scene = await newScene({
      body: 'stop, désinscrivez-moi de vos messages',
      category: 'UNSUBSCRIBE',
      recordPlan: false,
    });
    expect(scene.assessment.autonomous.outcome).toBe('TERMINAL_STOP');
    const recorded = await recordConversationPlan(sql, {
      ...planInputFrom(scene.assessment),
      decision: 'TERMINAL_STOP',
      decisionReason: scene.assessment.autonomous.reason,
    });
    expect(recorded.plan.status).toBe('CANCELLED');
  });
});

// ---------------------------------------------------------------------------
// §1 — la politique commerciale, sur le chemin réel
// ---------------------------------------------------------------------------

describe('§1 — une demande commerciale écarte l’autonomie, sur le vrai chemin', () => {
  it('une question de prix escalade au lieu de partir', async () => {
    const scene = await newScene({
      body: 'ok et vous facturez combien pour ce genre de prestation ?',
      category: 'QUESTION',
      recordPlan: false,
    });
    expect(scene.assessment.autonomous.outcome).toBe('HUMAN_ESCALATION');
    expect(scene.assessment.autonomous.gate).toBe('commercial_demand');
    expect(scene.assessment.autonomous.reason).toBe('pricing_policy_missing');
    expect(scene.assessment.commercialDemands.map((d) => d.demand)).toContain('EXACT_PRICE');
  });

  it('une demande de garantie escalade', async () => {
    const scene = await newScene({
      body: 'vous garantissez des résultats ?',
      category: 'QUESTION',
      recordPlan: false,
    });
    expect(scene.assessment.autonomous.outcome).toBe('HUMAN_ESCALATION');
    expect(scene.assessment.autonomous.reason).toBe('guarantee_requested');
  });

  it('un engagement contractuel escalade sous son PROPRE motif', async () => {
    const scene = await newScene({
      body: 'il y a un engagement à signer ?',
      category: 'QUESTION',
      recordPlan: false,
    });
    expect(scene.assessment.autonomous.outcome).toBe('HUMAN_ESCALATION');
    expect(scene.assessment.autonomous.reason).toBe('contract_terms_requested');
  });

  it('un brouillon qui PROMET escalade, même sur un tour anodin', async () => {
    const scene = await newScene({
      draftBody: 'Aucun risque de votre côté, des résultats garantis dès le premier mois.',
      recordPlan: false,
    });
    expect(scene.assessment.autonomous.outcome).toBe('HUMAN_ESCALATION');
    expect(scene.assessment.autonomous.reason).toBe('performance_claim');
  });

  it('une qualification générale reste ÉLIGIBLE', async () => {
    const scene = await newScene({ recordPlan: false });
    expect(scene.assessment.autonomous.outcome).toBe('AUTO_REPLY_ELIGIBLE');
    expect(scene.assessment.commercialDemands).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §14/§15 — l'historique et le mode ombre
// ---------------------------------------------------------------------------

describe('§14 — une réponse autonome est reconstruisible dans le fil', () => {
  it('une réponse REMISE devient un tour sortant, étiqueté comme tel', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    await run(new FakeReplyRail(), { planId: scene.plan.id });

    const context = await loadReplyContext(sql, scene.inboundId);
    const thread = await loadConversationThread(sql, context!);
    const autonomous = thread.outboundTurns.filter((t) => t.provenance === 'sent_autonomous_reply');
    expect(autonomous).toHaveLength(1);
    expect(autonomous[0]?.text).toBe(REPLY_BODY);
    expect(autonomous[0]?.sourceId).toBe(scene.plan.id);
  });

  it('une réponse AMBIGUË entre aussi, avec une étiquette qui ne promet rien', async () => {
    // L'omettre serait pire : le tour suivant redirait mot pour mot ce que le
    // prospect a peut-être déjà lu.
    const scene = await newScene();
    await releaseKillSwitch();
    await run(new FakeReplyRail({ throwAfterHook: new Error('perdu') }), { planId: scene.plan.id });

    const context = await loadReplyContext(sql, scene.inboundId);
    const thread = await loadConversationThread(sql, context!);
    const attempted = thread.outboundTurns.filter(
      (t) => t.provenance === 'attempted_autonomous_reply',
    );
    expect(attempted).toHaveLength(1);
  });

  it('un plan qui n’a RIEN écrit n’apparaît pas dans le fil', async () => {
    const scene = await newScene();
    // Arrêt armé : le plan est reporté sans aucun effet.
    await run(new FakeReplyRail(), { planId: scene.plan.id });

    const context = await loadReplyContext(sql, scene.inboundId);
    const thread = await loadConversationThread(sql, context!);
    expect(
      thread.outboundTurns.filter(
        (t) =>
          t.provenance === 'sent_autonomous_reply' || t.provenance === 'attempted_autonomous_reply',
      ),
    ).toHaveLength(0);
  });
});

describe('§15 — le mode ombre va jusqu’au dernier point, et s’arrête', () => {
  it('sur un tour éligible et un arrêt LEVÉ, il atteint READY_FOR_EFFECT', async () => {
    const scene = await newScene();
    await releaseKillSwitch();
    const observation = await observeReplyShadow(sql, scene.inboundId, {
      config,
      conversation,
      now: NOW,
    });
    expect(observation.stage).toBe('READY_FOR_EFFECT');
    expect(observation.targetThreadId).toBe(THREAD_ID);
    expect(observation.planId).toBe(scene.plan.id);
    expect(observation.externalEffects).toBe(false);
  });

  it('l’arrêt global ARMÉ le stoppe au crochet, sans rien ouvrir', async () => {
    const scene = await newScene();
    const observation = await observeReplyShadow(sql, scene.inboundId, {
      config,
      conversation,
      now: NOW,
    });
    expect(observation.stage).toBe('GATE_REFUSED');
    expect(observation.gateRefusal).toBe('BLOCKED_KILL_SWITCH');
  });

  it('le mode ombre n’importe AUCUN rail et AUCUNE primitive', () => {
    const source = readFileSync(resolve(ROOT, 'src/lib/conversation/replyShadow.ts'), 'utf8');
    for (const forbidden of [
      'playwrightReplyRail',
      'playwrightLiveRail',
      'sendThreadReply',
      'sendFirstTouchDm',
      'recordReplyEffect',
      'reserveConversationEffectSlot',
      'claimConversationPlan',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});
