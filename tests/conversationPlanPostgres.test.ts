import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONVERSATION_POLICY_VERSION } from '@/lib/conversation/autonomy';
import { COMMERCIAL_POLICY_VERSION } from '@/lib/conversation/commercialPolicy';
import {
  claimConversationPlan,
  recordConversationPlan,
  type RecordPlanInput,
} from '@/lib/conversation/plan';
import type { PostgresConfig } from '@/lib/db/config';
import { migrate } from '@/lib/db/migrate';
import { createPostgresSql } from '@/lib/db/postgres';
import type { Sql } from '@/lib/db/sql';
import { makeReplyFixtures, type ReplyFixtures } from './support/replyFixture';

/**
 * HERMES-CONVERSATION-R2 §34.11 — deux workers, un plan, sur PostgreSQL RÉEL.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi PGlite ne suffit pas ici
 * ---------------------------------------------------------------------------
 * PGlite est un vrai PostgreSQL, mais un seul processus peut l'ouvrir : il ne
 * peut donc pas exercer ce qui compte — deux connexions INDÉPENDANTES qui se
 * disputent la même ligne à la même microseconde. Ce fichier ouvre deux pools
 * distincts sur le même cluster, ce qui est la situation réelle du runtime
 * (deux runtimes Hermes tournent en permanence sur cette machine).
 *
 * Sauté tant que `OUTBOUND_TEST_DATABASE_URL` ne pointe pas sur une base
 * jetable, pour que `npm test` reste vert sur une machine sans PostgreSQL.
 * Cette base n'est jamais le corpus.
 *
 * Aucun test n'envoie quoi que ce soit : le module sous test n'importe aucune
 * primitive d'envoi, et aucune ligne d'effet externe n'est écrite ici.
 */

const TEST_URL = process.env.OUTBOUND_TEST_DATABASE_URL;
const describeIfPostgres = TEST_URL ? describe : describe.skip;

const MAILBOX = 'reponse@example.com';
const FIRST_TOUCH = 'Bonjour, comment vos clients vous trouvent aujourd’hui ?';

function config(applicationName: string): PostgresConfig {
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

describeIfPostgres('HERMES-CONVERSATION-R2 §34.11 — concurrence réelle', () => {
  let alpha: Sql;
  let beta: Sql;
  let fixtures: ReplyFixtures;

  beforeAll(async () => {
    alpha = await createPostgresSql(config('conversation-r2-alpha'));
    beta = await createPostgresSql(config('conversation-r2-beta'));
    await migrate(alpha);
    const rows = await alpha.query<{ id: string }>(
      `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
      [`conv-r2-${randomUUID().slice(0, 8)}`, 'Test', 'example-services', '{}'],
    );
    fixtures = makeReplyFixtures(alpha, { campaignId: rows[0]!.id, mailbox: MAILBOX, firstTouch: FIRST_TOUCH });
  }, 120_000);

  afterAll(async () => {
    await alpha.close();
    await beta.close();
  });

  it('deux workers concurrents : au plus UN obtient le plan', async () => {
    const prospect = await fixtures.contactedProspect(`race-${randomUUID().slice(0, 8)}@example.com`);
    const inboundId = await fixtures.inbound({
      manifest: prospect.manifest,
      outreachEventId: prospect.outreachEventId,
      prospectId: prospect.prospectId,
      body: 'Comment ça marche ?',
      receivedAt: new Date().toISOString(),
    });

    const input: RecordPlanInput = {
      prospectId: prospect.prospectId,
      channel: 'email',
      kind: 'AUTO_REPLY',
      triggerInboundMessageId: inboundId,
      policyVersion: CONVERSATION_POLICY_VERSION,
    commercialPolicyVersion: COMMERCIAL_POLICY_VERSION,
      brainVersion: 'conv-r1.1-draft-1',
      decision: 'AUTO_REPLY_ELIGIBLE',
      decisionGate: 'autonomous_reply',
      decisionReason: null,
      decisionDetail: 'test de concurrence',
      conversationWatermark: new Date().toISOString(),
      body: 'Et ça vous ramène des demandes régulièrement ?',
      naturalnessVerdict: 'NATURAL',
      groundingGaps: [],
      offerReadiness: 'MEDIUM',
      callReadiness: 'MEDIUM',
      notBefore: new Date(Date.now() - 60_000),
    };

    const recorded = await recordConversationPlan(alpha, input);

    // Les deux prises partent ensemble, sur deux connexions distinctes.
    const [first, second] = await Promise.all([
      claimConversationPlan(alpha, { workerId: 'alpha', leaseMs: 60_000, planId: recorded.plan.id }),
      claimConversationPlan(beta, { workerId: 'beta', leaseMs: 60_000, planId: recorded.plan.id }),
    ]);

    const winners = [first, second].filter((plan) => plan !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.claimToken).toBeTruthy();
    expect(winners[0]?.attempts).toBe(1);
  });

  it('deux enregistrements simultanés du même déclencheur ne produisent qu’UN plan', async () => {
    const prospect = await fixtures.contactedProspect(`dup-${randomUUID().slice(0, 8)}@example.com`);
    const inboundId = await fixtures.inbound({
      manifest: prospect.manifest,
      outreachEventId: prospect.outreachEventId,
      prospectId: prospect.prospectId,
      body: 'Comment ça marche ?',
      receivedAt: new Date().toISOString(),
    });

    const input: RecordPlanInput = {
      prospectId: prospect.prospectId,
      channel: 'email',
      kind: 'AUTO_REPLY',
      triggerInboundMessageId: inboundId,
      policyVersion: CONVERSATION_POLICY_VERSION,
    commercialPolicyVersion: COMMERCIAL_POLICY_VERSION,
      brainVersion: 'conv-r1.1-draft-1',
      decision: 'AUTO_REPLY_ELIGIBLE',
      decisionGate: 'autonomous_reply',
      decisionReason: null,
      decisionDetail: 'test d’idempotence concurrente',
      conversationWatermark: new Date().toISOString(),
      body: 'Et ça vous ramène des demandes régulièrement ?',
      naturalnessVerdict: 'NATURAL',
      groundingGaps: [],
      offerReadiness: 'MEDIUM',
      callReadiness: 'MEDIUM',
      notBefore: new Date(),
    };

    // Une contrainte d'unicité peut faire ÉCHOUER l'une des deux transactions
    // plutôt que de la faire retomber sur `do nothing` — c'est un conflit de
    // sérialisation légitime, et ce que le test doit prouver est plus étroit :
    // il n'existe jamais deux plans.
    await Promise.allSettled([
      recordConversationPlan(alpha, input),
      recordConversationPlan(beta, input),
    ]);

    const count = await alpha.query<{ n: string }>(
      `select count(*)::text as n from hermes_conversation_plans where trigger_inbound_message_id = $1`,
      [inboundId],
    );
    expect(Number(count[0]?.n ?? 0)).toBe(1);
  });
});
