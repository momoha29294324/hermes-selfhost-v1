import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConversationPolicy, loadInstagramRail } from '@/lib/config/load';
import { CONVERSATION_POLICY_VERSION } from '@/lib/conversation/autonomy';
import { COMMERCIAL_POLICY_VERSION } from '@/lib/conversation/commercialPolicy';
import { conversationPromptVersionFor } from '@/lib/conversation/brain';
import {
  claimConversationPlan,
  recordConversationPlan,
  reserveConversationEffectSlot,
  type ConversationPlan,
} from '@/lib/conversation/plan';
import { executeConversationReply } from '@/lib/conversation/replyExecution';
import { recordReplyEffect, type ReplyEffectRecord } from '@/lib/conversation/replyEffect';
import type { PostgresConfig } from '@/lib/db/config';
import { migrate } from '@/lib/db/migrate';
import { createPostgresSql } from '@/lib/db/postgres';
import type { Sql } from '@/lib/db/sql';
import type {
  InstagramReplyInput,
  InstagramReplyRail,
  InstagramReplyResult,
} from '@/lib/instagram/replyRail';
import { setKillSwitch } from '@/lib/instagram/safety';
import { makeReplyFixtures, type ReplyFixtures } from './support/replyFixture';

/**
 * HERMES-REPLY-DELIVERY-R1 §16 — ce qui ne tient QUE parce que PostgreSQL le
 * tient.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi PGlite ne suffit pas ici
 * ---------------------------------------------------------------------------
 * PGlite est un vrai PostgreSQL, mais un seul processus peut l'ouvrir. Il ne
 * peut donc pas exercer ce qui compte : deux CONNEXIONS indépendantes qui se
 * disputent la même ligne à la même microseconde — c'est-à-dire la situation
 * réelle du runtime, où deux runtimes Hermes tournent en permanence.
 *
 * Trois propriétés de sûreté de ce round reposent sur la base et non sur le
 * code, et sont vérifiées ici :
 *
 *   1. **au plus un effet par plan** — index unique partiel
 *      `hermes_effect_one_attempt_per_plan` ;
 *   2. **au plus un effet par INTENTION LOGIQUE** —
 *      `hermes_effect_one_attempt_per_intent`, qui survit au remplacement d'un
 *      plan par un autre portant la même clé ;
 *   3. **la réservation départage** — `reserveConversationEffectSlot` prend le
 *      verrou consultatif partagé et n'accorde la tentative qu'une fois.
 *
 * Sauté tant que `OUTBOUND_TEST_DATABASE_URL` ne pointe pas sur une base
 * jetable, pour que `npm test` reste vert sur une machine sans PostgreSQL.
 * Cette base n'est JAMAIS le corpus.
 *
 * Aucun test n'envoie quoi que ce soit : le rail est un double qui ne connaît
 * aucun navigateur, et l'arrêt global est levé sur la base jetable uniquement.
 */

const TEST_URL = process.env.OUTBOUND_TEST_DATABASE_URL;
const describeIfPostgres = TEST_URL ? describe : describe.skip;

const MAILBOX = 'reponse@example.com';
const FIRST_TOUCH = 'Bonjour, comment vos clients vous trouvent aujourd’hui ?';
const REPLY_BODY = 'Et ça vous ramène des demandes régulièrement ?';
const THREAD_ID = '107403793987175';
const ACCOUNT_HANDLE = 'compte_test_hermes';

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

function pgConfig(applicationName: string): PostgresConfig {
  return {
    backend: 'postgres',
    connectionString: TEST_URL as string,
    poolMax: 5,
    applicationName,
    ssl: 'disable',
    statementTimeoutMs: 0,
    idleTimeoutMs: 5_000,
    connectionTimeoutMs: 10_000,
  };
}

/** Un double qui n'ouvre rien et ne clique nulle part. */
class FakeReplyRail implements InstagramReplyRail {
  hookCalls = 0;
  calls = 0;

  async sendThreadReply(input: InstagramReplyInput): Promise<InstagramReplyResult> {
    this.calls += 1;
    await input.onBeforeExternalEffect();
    this.hookCalls += 1;
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
        scopeDetail: 'double',
        sessionState: 'SESSION_READY' as const,
        screenshotPath: null,
        durationMs: 1_000,
        detail: 'clic unique (double)',
      }),
    });
  }

  async close(): Promise<void> {
    // Aucun navigateur n'a été ouvert : il n'y a rien à fermer.
  }
}

describeIfPostgres('HERMES-REPLY-DELIVERY-R1 §16 — sûreté portée par PostgreSQL', () => {
  let alpha: Sql;
  let beta: Sql;
  let fixtures: ReplyFixtures;
  let counter = 0;

  beforeAll(async () => {
    alpha = await createPostgresSql(pgConfig('reply-r1-alpha'));
    beta = await createPostgresSql(pgConfig('reply-r1-beta'));
    await migrate(alpha);
    const rows = await alpha.query<{ id: string }>(
      `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
      [`reply-r1-${randomUUID().slice(0, 8)}`, 'Test', 'example-services', '{}'],
    );
    fixtures = makeReplyFixtures(alpha, {
      campaignId: rows[0]!.id,
      mailbox: MAILBOX,
      firstTouch: FIRST_TOUCH,
    });
    await setKillSwitch(alpha, { engaged: false, setBy: 'test', reason: 'base jetable' });
  }, 180_000);

  afterAll(async () => {
    await alpha.close();
    await beta.close();
  });

  /**
   * Un plan de réponse PRÊT, écrit directement.
   *
   * Le chemin d'évaluation complet est exercé par `replyExecution.test.ts` ; ce
   * fichier-ci n'a besoin que d'un plan valide, parce que ce qu'il éprouve est
   * la BASE et non la politique.
   */
  async function readyPlan(): Promise<{ plan: ConversationPlan; prospectId: string; inboundId: string }> {
    counter += 1;
    const handle = `acmeatelier${String(counter)}${randomUUID().slice(0, 4)}`;
    const prospect = await fixtures.contactedProspect(handle, {
      transport: 'instagram_dm',
      displayName: `ACME ATELIER ${String(counter)}`,
    });
    await alpha.query(`update prospects set identity_review = 'confirmed' where id = $1`, [
      prospect.prospectId,
    ]);
    const inboundId = await fixtures.instagramInbound({
      manifest: prospect.manifest,
      outreachEventId: prospect.outreachEventId,
      prospectId: prospect.prospectId,
      body: 'oui je fais déjà de la pub mais ça marche moyen',
      threadId: THREAD_ID,
      accountHandle: ACCOUNT_HANDLE,
      from: handle,
      receivedAt: '2026-08-21T13:00:00.000Z',
    });

    const recorded = await recordConversationPlan(alpha, {
      prospectId: prospect.prospectId,
      channel: 'instagram_dm',
      kind: 'AUTO_REPLY',
      triggerInboundMessageId: inboundId,
      policyVersion: CONVERSATION_POLICY_VERSION,
      commercialPolicyVersion: COMMERCIAL_POLICY_VERSION,
      brainVersion: conversationPromptVersionFor('instagram_dm'),
      decision: 'AUTO_REPLY_ELIGIBLE',
      decisionGate: 'autonomous_reply',
      decisionReason: null,
      decisionDetail: 'toutes les portes de contenu sont vertes',
      conversationWatermark: '2026-08-21T13:00:00.000Z',
      body: REPLY_BODY,
      naturalnessVerdict: 'NATURAL',
      groundingGaps: [],
      offerReadiness: 'MEDIUM',
      callReadiness: 'MEDIUM',
      notBefore: new Date('2026-08-21T13:10:00.000Z'),
    });
    return { plan: recorded.plan, prospectId: prospect.prospectId, inboundId };
  }

  function effect(
    plan: ConversationPlan,
    inboundId: string,
    overrides: Partial<ReplyEffectRecord> = {},
  ): ReplyEffectRecord {
    return {
      planId: plan.id,
      prospectId: plan.prospectId,
      policyVersion: plan.policyVersion,
      commercialPolicyVersion: plan.commercialPolicyVersion,
      brainVersion: plan.brainVersion,
      idempotencyKey: plan.idempotencyKey,
      triggerInboundMessageId: inboundId,
      conversationWatermark: plan.conversationWatermark,
      bodySha256: plan.bodySha256 ?? 'a'.repeat(64),
      targetThreadId: THREAD_ID,
      targetHandle: 'acmeatelier0',
      accountHandle: ACCOUNT_HANDLE,
      mode: 'LIVE',
      status: 'SENT',
      reasonCode: 'REPLY_SENT',
      detail: 'test',
      observedThreadId: THREAD_ID,
      observedThreadUrl: `https://www.instagram.com/direct/t/${THREAD_ID}/`,
      observedHandle: 'acmeatelier0',
      sessionState: 'SESSION_READY',
      priorBubbles: 6,
      matchingBubblesBefore: 0,
      matchingBubblesAfter: 1,
      harvestReadableBefore: true,
      harvestReadableAfter: true,
      composerCleared: true,
      outgoingBubbleConfirmed: true,
      deliveryFailureMarkers: [],
      deliveryVerdict: 'SENT',
      effectAttempted: true,
      effectObserved: true,
      deliveryConfirmed: true,
      workerId: 'test',
      durationMs: 1_000,
      screenshotPath: null,
      ...overrides,
    };
  }

  /** Repousse les tentatives hors des fenêtres de plafond. Jamais de suppression. */
  async function resetLedger(): Promise<void> {
    await alpha.query(
      `update hermes_conversation_plans
          set external_effect_started_at = now() - interval '2 days'
        where external_effect_attempted = true`,
    );
  }

  // -------------------------------------------------------------------------
  // §7 — la concurrence réelle
  // -------------------------------------------------------------------------

  it('§7 — deux workers concurrents sur le même plan : au plus UN effet', async () => {
    await resetLedger();
    const { plan } = await readyPlan();

    const railA = new FakeReplyRail();
    const railB = new FakeReplyRail();

    // Deux connexions INDÉPENDANTES, lancées ensemble. C'est la seule forme qui
    // exerce `for update skip locked` : deux appels séquentiels ne prouveraient
    // que l'absorption des statuts.
    const [a, b] = await Promise.all([
      executeConversationReply(
        { sql: alpha, config, conversation, workerId: 'alpha', mode: 'LIVE', planId: plan.id },
        { rail: railA },
      ),
      executeConversationReply(
        { sql: beta, config, conversation, workerId: 'beta', mode: 'LIVE', planId: plan.id },
        { rail: railB },
      ),
    ]);

    const attempts = [a, b].filter((outcome) => outcome.externalEffectAttempted);
    expect(attempts.length, 'plus d’un effet a été tenté sur le même plan').toBeLessThanOrEqual(1);
    expect(railA.hookCalls + railB.hookCalls).toBeLessThanOrEqual(1);

    const rows = await alpha.query<{ count: string }>(
      `select count(*)::text as count from hermes_conversation_effects
        where plan_id = $1 and effect_attempted = true`,
      [plan.id],
    );
    expect(Number(rows[0]?.count ?? '0')).toBeLessThanOrEqual(1);
  }, 60_000);

  it('§7 — la RÉSERVATION n’est accordée qu’une fois, même prise simultanément', async () => {
    await resetLedger();
    const { plan } = await readyPlan();

    // Prise du plan par alpha, puis deux réservations concurrentes avec le même
    // jeton. C'est le cœur de l'exactly-once : la seconde doit échouer.
    const claimed = await claimConversationPlan(alpha, {
      workerId: 'alpha',
      leaseMs: 60_000,
      planId: plan.id,
    });
    expect(claimed).not.toBeNull();
    const token = claimed!.claimToken!;

    const results = await Promise.allSettled([
      reserveConversationEffectSlot(alpha, config, { planId: plan.id, claimToken: token }),
      reserveConversationEffectSlot(beta, config, { planId: plan.id, claimToken: token }),
    ]);
    const granted = results.filter((r) => r.status === 'fulfilled');
    expect(granted).toHaveLength(1);
  }, 60_000);

  it('§7 — la base REFUSE un second effet sur le même PLAN', async () => {
    await resetLedger();
    const { plan, inboundId } = await readyPlan();
    await recordReplyEffect(alpha, effect(plan, inboundId));
    await expect(recordReplyEffect(beta, effect(plan, inboundId))).rejects.toThrow();
  }, 60_000);

  it('§7 — et un second effet sur la même INTENTION LOGIQUE, fût-ce depuis un autre plan', async () => {
    // Le cas que l'index par plan ne couvre pas : un plan superseded remplacé
    // par un autre portant la MÊME clé d'idempotence. La clé est ce qui désigne
    // l'intention ; le plan n'est qu'un exemplaire.
    await resetLedger();
    const { plan, inboundId } = await readyPlan();
    await recordReplyEffect(alpha, effect(plan, inboundId));

    const twin = await alpha.query<{ id: string }>(
      `insert into hermes_conversation_plans
         (prospect_id, channel, kind, trigger_inbound_message_id, idempotency_key,
          policy_version, commercial_policy_version, brain_version, decision, decision_gate,
          offer_readiness, call_readiness, status, not_before, terminated_at)
       values ($1,'instagram_dm','AUTO_REPLY',$2,$3,$4,$5,$6,'AUTO_REPLY_SKIP','test',
               'MEDIUM','MEDIUM','CANCELLED', now(), now())
       returning id`,
      [
        plan.prospectId,
        inboundId,
        `${plan.idempotencyKey}#jumeau`,
        plan.policyVersion,
        plan.commercialPolicyVersion,
        plan.brainVersion,
      ],
    );

    await expect(
      recordReplyEffect(beta, {
        ...effect(plan, inboundId),
        planId: twin[0]!.id,
        // Même intention logique, autre plan.
        idempotencyKey: plan.idempotencyKey,
      }),
    ).rejects.toThrow();
  }, 60_000);

  // -------------------------------------------------------------------------
  // §9 — les contraintes qui refusent un MENSONGE
  // -------------------------------------------------------------------------

  describe('§9 — la base refuse d’enregistrer ce qui ne peut pas être vrai', () => {
    it('un APERÇU qui prétendrait avoir cliqué est REFUSÉ', async () => {
      await resetLedger();
      const { plan, inboundId } = await readyPlan();
      await expect(
        recordReplyEffect(alpha, effect(plan, inboundId, { mode: 'PREVIEW' })),
      ).rejects.toThrow();
    }, 60_000);

    it('une remise « confirmée » sans observation est REFUSÉE', async () => {
      await resetLedger();
      const { plan, inboundId } = await readyPlan();
      await expect(
        recordReplyEffect(alpha, effect(plan, inboundId, { effectObserved: false })),
      ).rejects.toThrow();
    }, 60_000);

    it('une observation sans tentative est REFUSÉE', async () => {
      await resetLedger();
      const { plan, inboundId } = await readyPlan();
      await expect(
        recordReplyEffect(
          alpha,
          effect(plan, inboundId, {
            status: 'BLOCKED',
            reasonCode: 'X',
            effectAttempted: false,
            effectObserved: true,
            deliveryConfirmed: false,
            deliveryVerdict: null,
          }),
        ),
      ).rejects.toThrow();
    }, 60_000);

    it('un SENT non confirmé est REFUSÉ', async () => {
      await resetLedger();
      const { plan, inboundId } = await readyPlan();
      await expect(
        recordReplyEffect(alpha, effect(plan, inboundId, { deliveryConfirmed: false })),
      ).rejects.toThrow();
    }, 60_000);

    it('un BLOCKED qui déclarerait un effet est REFUSÉ', async () => {
      await resetLedger();
      const { plan, inboundId } = await readyPlan();
      await expect(
        recordReplyEffect(
          alpha,
          effect(plan, inboundId, {
            status: 'BLOCKED',
            reasonCode: 'X',
            deliveryConfirmed: false,
            deliveryVerdict: null,
          }),
        ),
      ).rejects.toThrow();
    }, 60_000);

    it('un fil avec SOI-MÊME est REFUSÉ', async () => {
      await resetLedger();
      const { plan, inboundId } = await readyPlan();
      await expect(
        recordReplyEffect(
          alpha,
          effect(plan, inboundId, { targetHandle: ACCOUNT_HANDLE, observedHandle: ACCOUNT_HANDLE }),
        ),
      ).rejects.toThrow();
    }, 60_000);

    it('un AMBIGU, lui, est parfaitement enregistrable — et il le faut', async () => {
      // Le pendant nécessaire : si la base refusait l'ambigu, le worker n'aurait
      // nulle part où écrire « on a essayé, on ne sait pas » et retomberait sur
      // le seul mensonge disponible.
      await resetLedger();
      const { plan, inboundId } = await readyPlan();
      const id = await recordReplyEffect(
        alpha,
        effect(plan, inboundId, {
          status: 'AMBIGUOUS',
          reasonCode: 'REPLY_AMBIGUOUS_POST_EFFECT',
          effectObserved: false,
          deliveryConfirmed: false,
          deliveryVerdict: null,
        }),
      );
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }, 60_000);
  });
});
