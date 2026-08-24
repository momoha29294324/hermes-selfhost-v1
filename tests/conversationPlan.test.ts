import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConversationPolicy, loadInstagramRail } from '@/lib/config/load';
import { CONVERSATION_POLICY_VERSION } from '@/lib/conversation/autonomy';
import { COMMERCIAL_POLICY_VERSION } from '@/lib/conversation/commercialPolicy';
import { conversationPromptVersionFor } from '@/lib/conversation/brain';
import { assessInboundMessage, loadFollowUpFacts } from '@/lib/conversation/assessment';
import { loadConversationGuards } from '@/lib/conversation/guards';
import {
  cancelConversationPlans,
  claimConversationPlan,
  ConversationPlanError,
  conversationReplyDelayMs,
  deriveConversationPlanKey,
  EXTERNAL_EFFECT_LOCK_KEY,
  finalizeConversationPlan,
  loadConversationPlan,
  recordConversationPlan,
  recoverExpiredConversationLeases,
  reserveConversationEffectSlot,
  type ConversationPlan,
  type RecordPlanInput,
} from '@/lib/conversation/plan';
import { evaluateConversationEffectGate } from '@/lib/conversation/preEffect';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import type { Sql } from '@/lib/db/sql';
import { evaluateEffectCaps, loadSafetySnapshot, setKillSwitch } from '@/lib/instagram/safety';
import { persistAnalysis } from '@/lib/replies/analyses';
import { loadReplyContext } from '@/lib/replies/context';
import { decideCategory, detectUnsubscribeDemand, resolveNextAction, type ReplyCategory } from '@/lib/replies/taxonomy';
import { makeReplyFixtures, type ContactedProspect, type ReplyFixtures } from './support/replyFixture';

/**
 * HERMES-CONVERSATION-R2 §26/§34/§36 — le registre des intentions, sur une
 * vraie base.
 *
 * Ce fichier existe pour prouver ce qu'aucun test pur ne peut prouver :
 * l'idempotence tient parce que PostgreSQL la tient, pas parce qu'un `select`
 * préalable a été bien écrit. Les index uniques, les contraintes de cohérence
 * de bail et l'absorption des statuts terminaux sont exercés RÉELLEMENT.
 *
 * Aucun test n'envoie quoi que ce soit : le module sous test n'importe aucune
 * primitive d'envoi, et l'arrêt global reste armé sauf là où un test le lève
 * explicitement — sur une base jetable, en mémoire.
 *
 * Entreprises, adresses et textes sont fictifs.
 */

const MAILBOX = 'reponse@example.com';
const FIRST_TOUCH =
  'Bonjour, j’ai vu que vous faisiez du prestation standard à domicile. Comment vos clients vous trouvent aujourd’hui ?';

const policy = loadConversationPolicy();
const rail = loadInstagramRail();

let sql: Sql;
let dir: string;
let fixtures: ReplyFixtures;
let recipientCounter = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-conversation-r2-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-conversation-r2-test', 'Test', 'example-services', '{}'],
  );
  fixtures = makeReplyFixtures(sql, { campaignId: rows[0]!.id, mailbox: MAILBOX, firstTouch: FIRST_TOUCH });
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

async function newProspect(options: { identityConfirmed?: boolean } = {}): Promise<ContactedProspect> {
  recipientCounter += 1;
  const prospect = await fixtures.contactedProspect(`contact${String(recipientCounter)}@example.com`);
  if (options.identityConfirmed === true) {
    // La même barre que le premier contact : la provenance automatique figée.
    // Sans elle, l'évaluation s'arrête à la porte d'identité — ce qui est juste,
    // et ce qui masquerait la porte qu'un test veut observer.
    await sql.query(`update prospects set identity_review = 'confirmed' where id = $1`, [
      prospect.prospectId,
    ]);
  }
  return prospect;
}

/** Écrit un tour entrant et son analyse D2, par le VRAI chemin de décision. */
async function inboundTurn(
  prospect: ContactedProspect,
  body: string,
  category: ReplyCategory,
  receivedAt: string,
  confidence = 0.95,
): Promise<string> {
  const id = await fixtures.inbound({
    manifest: prospect.manifest,
    outreachEventId: prospect.outreachEventId,
    prospectId: prospect.prospectId,
    body,
    receivedAt,
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
    // Le rail autonome ne lit que le brouillon écrit sous la consigne
    // COURANTE (HERMES-END-TO-END-CERTIFICATION-R1). Une version inventée
    // modéliserait un texte que la production ne relirait jamais.
    promptVersion: conversationPromptVersionFor('instagram_dm'),
    inputSha256: 'f'.repeat(64),
    modelRunId: null,
  });
  return id;
}

/**
 * Efface les TENTATIVES d'effet déjà inscrites dans cette base jetable.
 *
 * Nécessaire, et pour une raison qui est elle-même une preuve : les plafonds
 * sont RÉELLEMENT partagés (§20). Dès qu'un test a réservé un créneau, la
 * cadence de quinze minutes refuse tous les suivants — y compris ceux qui
 * veulent observer une AUTRE porte. Sans cette remise à zéro, chaque test
 * suivant prouverait seulement, une fois de plus, que l'intervalle mord.
 *
 * Ce n'est pas un contournement de garde : la garde est vérifiée explicitement
 * par les deux tests §20, et c'est la seule chose que ce helper rend possible
 * d'isoler.
 */
async function resetEffectLedger(): Promise<void> {
  // Les tentatives sont REPOUSSÉES dans le passé, jamais effacées : un plan
  // `SENT` ou `AMBIGUOUS` DOIT porter sa tentative (contrainte
  // `hermes_plan_effect_precedes_outcome`), et effacer le drapeau ferait mentir
  // la base sur ce qui a eu lieu. Deux jours suffisent à sortir de toutes les
  // fenêtres — vingt-quatre heures, une heure, quinze minutes.
  await sql.query(
    `update hermes_conversation_plans
        set external_effect_started_at = now() - interval '2 days'
      where external_effect_attempted = true`,
  );
}

function planInput(
  prospectId: string,
  inboundId: string,
  overrides: Partial<RecordPlanInput> = {},
): RecordPlanInput {
  return {
    prospectId,
    channel: 'email',
    kind: 'AUTO_REPLY',
    triggerInboundMessageId: inboundId,
    policyVersion: CONVERSATION_POLICY_VERSION,
    commercialPolicyVersion: COMMERCIAL_POLICY_VERSION,
    brainVersion: conversationPromptVersionFor('email'),
    decision: 'AUTO_REPLY_ELIGIBLE',
    decisionGate: 'autonomous_reply',
    decisionReason: null,
    decisionDetail: 'toutes les portes de contenu sont vertes',
    conversationWatermark: '2026-08-21T13:00:00.000Z',
    body: 'Et ça vous ramène des demandes régulièrement ?',
    naturalnessVerdict: 'NATURAL',
    groundingGaps: [],
    offerReadiness: 'MEDIUM',
    callReadiness: 'MEDIUM',
    notBefore: new Date('2026-08-21T13:05:00.000Z'),
    ...overrides,
  };
}

describe('HERMES-CONVERSATION-R2 — registre des intentions', () => {
  // -------------------------------------------------------------------------
  // §26 / §34.10 — idempotence
  // -------------------------------------------------------------------------

  it('§34.10 — le même message entrant ne produit qu’UN plan', async () => {
    const prospect = await newProspect();
    const inbound = await inboundTurn(prospect, 'Comment ça marche ?', 'QUESTION', '2026-08-21T13:00:00.000Z');

    const first = await recordConversationPlan(sql, planInput(prospect.prospectId, inbound));
    const second = await recordConversationPlan(sql, planInput(prospect.prospectId, inbound));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.plan.id).toBe(first.plan.id);
    expect(second.plan.idempotencyKey).toBe(
      deriveConversationPlanKey('AUTO_REPLY', prospect.prospectId, inbound),
    );
  });

  // -------------------------------------------------------------------------
  // HERMES-CONTEXTUAL-REPLY-CLASSIFICATION-R1 — reclasser, sans jamais doubler
  // -------------------------------------------------------------------------

  it('une COMPRÉHENSION neuve produit une intention neuve, plutôt qu’un plan périmé rendu en silence', async () => {
    const prospect = await newProspect();
    const inbound = await inboundTurn(prospect, 'Surtout le bouche à oreille', 'REVIEW_REQUIRED', '2026-08-21T13:00:00.000Z');

    // Le 22 août : compris de travers, escaladé, plan CLOS.
    const before = await recordConversationPlan(
      sql,
      planInput(prospect.prospectId, inbound, {
        understandingRef: 'analysis-avant',
        decision: 'HUMAN_ESCALATION',
        decisionReason: 'unclassifiable',
        body: null,
      }),
    );
    expect(before.plan.status).toBe('BLOCKED');

    // Après le correctif : une analyse NEUVE, donc une intention neuve.
    const after = await recordConversationPlan(
      sql,
      planInput(prospect.prospectId, inbound, { understandingRef: 'analysis-apres' }),
    );
    expect(after.created).toBe(true);
    expect(after.plan.id).not.toBe(before.plan.id);
    expect(after.plan.status).toBe('PLANNED');
    expect(after.plan.decision).toBe('AUTO_REPLY_ELIGIBLE');

    // Le plan d'hier reste lisible, tel qu'il a été décidé.
    const kept = await sql.query<{ status: string; decisionReason: string | null }>(
      `select status, decision_reason as "decisionReason" from hermes_conversation_plans where id = $1`,
      [before.plan.id],
    );
    expect(kept[0]).toEqual({ status: 'BLOCKED', decisionReason: 'unclassifiable' });
  });

  it('tant que la compréhension ne change pas, rejouer retombe sur le MÊME plan', async () => {
    const prospect = await newProspect();
    const inbound = await inboundTurn(prospect, 'Comment ça marche ?', 'QUESTION', '2026-08-21T13:00:00.000Z');
    const first = await recordConversationPlan(
      sql,
      planInput(prospect.prospectId, inbound, { understandingRef: 'analysis-1' }),
    );
    const again = await recordConversationPlan(
      sql,
      planInput(prospect.prospectId, inbound, { understandingRef: 'analysis-1' }),
    );
    expect(again.created).toBe(false);
    expect(again.plan.id).toBe(first.plan.id);
  });

  it('un déclencheur qui a DÉJÀ produit un effet ne peut plus en produire un second, reclassement compris', async () => {
    const prospect = await newProspect();
    const inbound = await inboundTurn(prospect, 'Comment ça marche ?', 'QUESTION', '2026-08-21T13:00:00.000Z');
    const sent = await recordConversationPlan(
      sql,
      planInput(prospect.prospectId, inbound, { understandingRef: 'analysis-1' }),
    );
    // Le geste a eu lieu : `external_effect_attempted` est posé AVANT le clic,
    // et il ne s'efface jamais.
    await sql.query(
      `update hermes_conversation_plans
          set external_effect_attempted = true, external_effect_started_at = now(),
              status = 'SENT', terminated_at = now()
        where id = $1`,
      [sent.plan.id],
    );

    const replayed = await recordConversationPlan(
      sql,
      planInput(prospect.prospectId, inbound, { understandingRef: 'analysis-2' }),
    );
    expect(replayed.created).toBe(false);
    expect(replayed.plan.id).toBe(sent.plan.id);
    expect(replayed.plan.status).toBe('SENT');

    const count = await sql.query<{ n: string }>(
      `select count(*)::text as n from hermes_conversation_plans where trigger_inbound_message_id = $1`,
      [inbound],
    );
    expect(Number(count[0]!.n)).toBe(1);
    await resetEffectLedger();
  });

  it('la clé SANS compréhension reste celle d’hier, à l’octet près', () => {
    expect(deriveConversationPlanKey('AUTO_REPLY', 'p1', 'i1')).toBe('hermes-conv-r2/AUTO_REPLY/p1/i1');
    expect(deriveConversationPlanKey('AUTO_REPLY', 'p1', 'i1', 'a1')).toBe('hermes-conv-r2/AUTO_REPLY/p1/i1#a1');
  });

  it('§34.10 bis — la clé est déterministe et sans horloge', () => {
    const a = deriveConversationPlanKey('AUTO_REPLY', 'p1', 'i1');
    const b = deriveConversationPlanKey('AUTO_REPLY', 'p1', 'i1');
    expect(a).toBe(b);
    expect(a).not.toContain(String(new Date().getUTCFullYear()));
    expect(deriveConversationPlanKey('FOLLOW_UP_1', 'p1', 'i1')).not.toBe(a);
  });

  it('§22 — le délai humain est déterministe, borné, et le même pour la même conversation', () => {
    const key = deriveConversationPlanKey('AUTO_REPLY', 'p1', 'i1');
    const delay = conversationReplyDelayMs(key, policy);
    expect(conversationReplyDelayMs(key, policy)).toBe(delay);
    expect(delay).toBeGreaterThanOrEqual(policy.reply.minDelayMs);
    expect(delay).toBeLessThan(policy.reply.maxDelayMs);
  });

  // -------------------------------------------------------------------------
  // §24 / §34.9 — un message plus récent annule le précédent
  // -------------------------------------------------------------------------

  it('§34.9 — un nouveau message SUPERSÈDE le plan précédent, et la base l’impose', async () => {
    const prospect = await newProspect();
    const first = await inboundTurn(prospect, 'Comment ça marche ?', 'QUESTION', '2026-08-21T13:00:00.000Z');
    const older = await recordConversationPlan(sql, planInput(prospect.prospectId, first));
    expect(older.plan.status).toBe('PLANNED');

    const second = await inboundTurn(prospect, 'En fait combien ?', 'QUESTION', '2026-08-21T13:10:00.000Z');
    const newer = await recordConversationPlan(
      sql,
      planInput(prospect.prospectId, second, { conversationWatermark: '2026-08-21T13:10:00.000Z' }),
    );

    expect(newer.superseded).toContain(older.plan.id);
    const reloaded = await loadConversationPlan(sql, older.plan.id);
    expect(reloaded?.status).toBe('SUPERSEDED');
    expect(reloaded?.terminatedAt).not.toBeNull();
    expect(newer.plan.status).toBe('PLANNED');
  });

  it('§24 bis — une décision qui n’attend rien est inscrite CLOSE, jamais vivante', async () => {
    const prospect = await newProspect();
    const inbound = await inboundTurn(prospect, 'Non merci', 'NOT_INTERESTED', '2026-08-21T13:00:00.000Z');
    const recorded = await recordConversationPlan(
      sql,
      planInput(prospect.prospectId, inbound, {
        decision: 'TERMINAL_STOP',
        decisionReason: 'not_interested',
        decisionGate: 'category',
        body: null,
        naturalnessVerdict: null,
      }),
    );
    expect(recorded.plan.status).toBe('CANCELLED');
    expect(recorded.plan.terminatedAt).not.toBeNull();

    const escalated = await newProspect();
    const escalatedInbound = await inboundTurn(
      escalated,
      'Vous garantissez quoi exactement ?',
      'QUESTION',
      '2026-08-21T13:00:00.000Z',
    );
    const blocked = await recordConversationPlan(
      sql,
      planInput(escalated.prospectId, escalatedInbound, {
        decision: 'HUMAN_ESCALATION',
        decisionReason: 'guarantee_requested',
        decisionGate: 'grounding',
        body: null,
        naturalnessVerdict: null,
      }),
    );
    expect(blocked.plan.status).toBe('BLOCKED');
  });

  it('la base refuse une intention ÉLIGIBLE sans texte', async () => {
    const prospect = await newProspect();
    const inbound = await inboundTurn(prospect, 'Comment ça marche ?', 'QUESTION', '2026-08-21T13:00:00.000Z');
    await expect(
      recordConversationPlan(
        sql,
        planInput(prospect.prospectId, inbound, { body: null, naturalnessVerdict: null }),
      ),
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // §34.11 à §34.13 — prise, crash, rejeu
  // -------------------------------------------------------------------------

  it('§34.11 — un plan ne se prend qu’UNE fois : le second worker repart les mains vides', async () => {
    const prospect = await newProspect();
    const inbound = await inboundTurn(prospect, 'Comment ça marche ?', 'QUESTION', '2026-08-21T13:00:00.000Z');
    const recorded = await recordConversationPlan(
      sql,
      planInput(prospect.prospectId, inbound, { notBefore: new Date('2020-01-01T00:00:00.000Z') }),
    );

    const first = await claimConversationPlan(sql, {
      workerId: 'worker-a',
      leaseMs: 60_000,
      planId: recorded.plan.id,
    });
    const second = await claimConversationPlan(sql, {
      workerId: 'worker-b',
      leaseMs: 60_000,
      planId: recorded.plan.id,
    });

    expect(first?.claimToken).toBeTruthy();
    expect(second).toBeNull();

    // Et le second ne peut pas écrire l'issue d'un travail qui ne lui appartient pas.
    const stolen = await finalizeConversationPlan(sql, {
      planId: recorded.plan.id,
      claimToken: '00000000-0000-0000-0000-000000000000',
      status: 'BLOCKED',
      reasonCode: 'TEST',
      detail: null,
    });
    expect(stolen).toBe(false);

    const owned = await finalizeConversationPlan(sql, {
      planId: recorded.plan.id,
      claimToken: first!.claimToken!,
      status: 'BLOCKED',
      reasonCode: 'TEST',
      detail: null,
    });
    expect(owned).toBe(true);
  });

  it('§34.12 — un bail expiré SANS tentative retourne dans le registre', async () => {
    const prospect = await newProspect();
    const inbound = await inboundTurn(prospect, 'Comment ça marche ?', 'QUESTION', '2026-08-21T13:00:00.000Z');
    const recorded = await recordConversationPlan(
      sql,
      planInput(prospect.prospectId, inbound, { notBefore: new Date('2020-01-01T00:00:00.000Z') }),
    );
    const claimed = await claimConversationPlan(sql, {
      workerId: 'worker-crash',
      leaseMs: 60_000,
      planId: recorded.plan.id,
    });
    expect(claimed).not.toBeNull();

    await sql.query(
      `update hermes_conversation_plans set lease_expires_at = now() - interval '1 minute' where id = $1`,
      [recorded.plan.id],
    );
    const recovered = await recoverExpiredConversationLeases(sql);
    expect(recovered.find((row) => row.id === recorded.plan.id)?.status).toBe('PLANNED');

    const reloaded = await loadConversationPlan(sql, recorded.plan.id);
    expect(reloaded?.status).toBe('PLANNED');
    expect(reloaded?.externalEffectAttempted).toBe(false);
  });

  it('§34.13 — un bail expiré APRÈS une tentative devient AMBIGU, et n’est jamais rejoué', async () => {
    const prospect = await newProspect();
    const inbound = await inboundTurn(prospect, 'Comment ça marche ?', 'QUESTION', '2026-08-21T13:00:00.000Z');
    const recorded = await recordConversationPlan(
      sql,
      planInput(prospect.prospectId, inbound, { notBefore: new Date('2020-01-01T00:00:00.000Z') }),
    );
    const claimed = await claimConversationPlan(sql, {
      workerId: 'worker-effect',
      leaseMs: 60_000,
      planId: recorded.plan.id,
    });

    await reserveConversationEffectSlot(sql, rail, {
      planId: recorded.plan.id,
      claimToken: claimed!.claimToken!,
    });

    await sql.query(
      `update hermes_conversation_plans set lease_expires_at = now() - interval '1 minute' where id = $1`,
      [recorded.plan.id],
    );
    const recovered = await recoverExpiredConversationLeases(sql);
    expect(recovered.find((row) => row.id === recorded.plan.id)?.status).toBe('AMBIGUOUS');

    // Absorbant : plus réclamable, jamais.
    const reclaimed = await claimConversationPlan(sql, {
      workerId: 'worker-again',
      leaseMs: 60_000,
      planId: recorded.plan.id,
    });
    expect(reclaimed).toBeNull();
  });

  it('§26 — une tentative d’effet ne se réserve pas deux fois', async () => {
    await resetEffectLedger();
    const prospect = await newProspect();
    const inbound = await inboundTurn(prospect, 'Comment ça marche ?', 'QUESTION', '2026-08-21T13:00:00.000Z');
    const recorded = await recordConversationPlan(
      sql,
      planInput(prospect.prospectId, inbound, { notBefore: new Date('2020-01-01T00:00:00.000Z') }),
    );
    const claimed = await claimConversationPlan(sql, {
      workerId: 'worker-once',
      leaseMs: 60_000,
      planId: recorded.plan.id,
    });

    await reserveConversationEffectSlot(sql, rail, {
      planId: recorded.plan.id,
      claimToken: claimed!.claimToken!,
    });
    await expect(
      reserveConversationEffectSlot(sql, rail, {
        planId: recorded.plan.id,
        claimToken: claimed!.claimToken!,
      }),
    ).rejects.toThrow(ConversationPlanError);
  });

  // -------------------------------------------------------------------------
  // §20 — les plafonds sont PARTAGÉS
  // -------------------------------------------------------------------------

  it('§20 — une tentative conversationnelle consomme l’intervalle du rail sortant', async () => {
    await resetEffectLedger();
    const prospect = await newProspect();
    const inbound = await inboundTurn(prospect, 'Comment ça marche ?', 'QUESTION', '2026-08-21T13:00:00.000Z');
    const recorded = await recordConversationPlan(
      sql,
      planInput(prospect.prospectId, inbound, { notBefore: new Date('2020-01-01T00:00:00.000Z') }),
    );
    const claimed = await claimConversationPlan(sql, {
      workerId: 'worker-caps',
      leaseMs: 60_000,
      planId: recorded.plan.id,
    });
    await reserveConversationEffectSlot(sql, rail, {
      planId: recorded.plan.id,
      claimToken: claimed!.claimToken!,
    });

    // L'arrêt global doit être levé pour que la porte SUIVANTE — la cadence —
    // soit celle qui refuse : c'est elle qu'on veut observer.
    await setKillSwitch(sql, { engaged: false, setBy: 'test', reason: 'observer la cadence partagée' });
    const snapshot = await loadSafetySnapshot(sql, rail);
    expect(snapshot.msSinceLastExternalEffect).not.toBeNull();

    const verdict = evaluateEffectCaps(snapshot, rail);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe('IG_CAP_MIN_INTERVAL');

    await setKillSwitch(sql, { engaged: true, setBy: 'test', reason: 'réarmé après le test' });
  });

  it('§20 bis — une réponse REMISE compte dans le plafond journalier du rail', async () => {
    await resetEffectLedger();
    const before = await loadSafetySnapshot(sql, rail);
    const prospect = await newProspect();
    const inbound = await inboundTurn(prospect, 'Comment ça marche ?', 'QUESTION', '2026-08-21T13:00:00.000Z');
    const recorded = await recordConversationPlan(
      sql,
      planInput(prospect.prospectId, inbound, { notBefore: new Date('2020-01-01T00:00:00.000Z') }),
    );
    const claimed = await claimConversationPlan(sql, {
      workerId: 'worker-sent',
      leaseMs: 60_000,
      planId: recorded.plan.id,
    });
    await reserveConversationEffectSlot(sql, rail, {
      planId: recorded.plan.id,
      claimToken: claimed!.claimToken!,
    });
    await finalizeConversationPlan(sql, {
      planId: recorded.plan.id,
      claimToken: claimed!.claimToken!,
      status: 'SENT',
      reasonCode: 'TEST_SENT',
      detail: null,
    });

    const after = await loadSafetySnapshot(sql, rail);
    expect(after.sentLastDay).toBe(before.sentLastDay + 1);
    expect(after.sentLastHour).toBe(before.sentLastHour + 1);
  });

  it('§20 ter — le verrou d’effet est celui du rail, pas un second', () => {
    expect(EXTERNAL_EFFECT_LOCK_KEY).toBe('ig_external_effect_slot');
  });

  // -------------------------------------------------------------------------
  // §34.18 / §18 — le crochet pré-effet
  // -------------------------------------------------------------------------

  async function livePlan(): Promise<{ plan: ConversationPlan; prospect: ContactedProspect }> {
    // Identité établie : sinon la porte d'identité refuse la première, et les
    // tests suivants n'observeraient jamais la porte qu'ils visent.
    const prospect = await newProspect({ identityConfirmed: true });
    const inbound = await inboundTurn(prospect, 'Comment ça marche ?', 'QUESTION', '2026-08-21T13:00:00.000Z');
    const recorded = await recordConversationPlan(
      sql,
      planInput(prospect.prospectId, inbound, {
        conversationWatermark: '2026-08-21T13:00:00.000Z',
        notBefore: new Date('2020-01-01T00:00:00.000Z'),
      }),
    );
    return { plan: recorded.plan, prospect };
  }

  it('§34.18 — l’arrêt global armé À L’INSTANT DE L’EFFET refuse, et rien ne part', async () => {
    const { plan } = await livePlan();
    const verdict = await evaluateConversationEffectGate(sql, {
      config: rail,
      plan,
      now: new Date('2026-08-24T10:00:00.000Z'),
    });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.refusal).toBe('BLOCKED_KILL_SWITCH');
      expect(verdict.temporary).toBe(true);
    }
    const reloaded = await loadConversationPlan(sql, plan.id);
    expect(reloaded?.externalEffectAttempted).toBe(false);
  });

  it('§21 — hors fenêtre, le crochet refuse et donne la prochaine ouverture', async () => {
    await resetEffectLedger();
    const { plan } = await livePlan();
    await setKillSwitch(sql, { engaged: false, setBy: 'test', reason: 'observer la fenêtre' });
    try {
      // Un dimanche à 3 h du matin, heure de Paris.
      const verdict = await evaluateConversationEffectGate(sql, {
        config: rail,
        plan,
        now: new Date('2026-08-23T01:00:00.000Z'),
      });
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) {
        expect(verdict.refusal).toBe('BLOCKED_OUTSIDE_WINDOW');
        expect(verdict.nextEligibleAt).not.toBeNull();
      }
    } finally {
      await setKillSwitch(sql, { engaged: true, setBy: 'test', reason: 'réarmé après le test' });
    }
  });

  it('§18/§24 — un message reçu APRÈS la planification rend le plan périmé', async () => {
    await resetEffectLedger();
    const { plan, prospect } = await livePlan();
    await inboundTurn(prospect, 'en fait laissez tomber', 'NOT_NOW', '2026-08-21T14:00:00.000Z');

    await setKillSwitch(sql, { engaged: false, setBy: 'test', reason: 'observer la fraîcheur' });
    try {
      const verdict = await evaluateConversationEffectGate(sql, {
        config: rail,
        plan,
        now: new Date('2026-08-24T10:00:00.000Z'),
      });
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.refusal).toBe('PLAN_STALE');
    } finally {
      await setKillSwitch(sql, { engaged: true, setBy: 'test', reason: 'réarmé après le test' });
    }
  });

  it('§18 — une intention annulée ne peut plus agir', async () => {
    await resetEffectLedger();
    const { plan, prospect } = await livePlan();
    const cancelled = await cancelConversationPlans(sql, {
      prospectId: prospect.prospectId,
      reasonCode: 'PROSPECT_OPTED_OUT',
      detail: 'test',
    });
    expect(cancelled).toContain(plan.id);

    const reloaded = await loadConversationPlan(sql, plan.id);
    expect(reloaded?.status).toBe('CANCELLED');

    await setKillSwitch(sql, { engaged: false, setBy: 'test', reason: 'observer un plan annulé' });
    try {
      const verdict = await evaluateConversationEffectGate(sql, {
        config: rail,
        plan: reloaded!,
        now: new Date('2026-08-24T10:00:00.000Z'),
      });
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.refusal).toBe('PLAN_NOT_LIVE');
    } finally {
      await setKillSwitch(sql, { engaged: true, setBy: 'test', reason: 'réarmé après le test' });
    }
  });

  it('§40 — un plan rendu sous une autre politique n’agit pas', async () => {
    await resetEffectLedger();
    const prospect = await newProspect();
    const inbound = await inboundTurn(prospect, 'Comment ça marche ?', 'QUESTION', '2026-08-21T13:00:00.000Z');
    const recorded = await recordConversationPlan(
      sql,
      planInput(prospect.prospectId, inbound, {
        policyVersion: 'hermes-conversation-r1',
        notBefore: new Date('2020-01-01T00:00:00.000Z'),
      }),
    );
    await setKillSwitch(sql, { engaged: false, setBy: 'test', reason: 'observer la version de politique' });
    try {
      const verdict = await evaluateConversationEffectGate(sql, {
        config: rail,
        plan: recorded.plan,
        now: new Date('2026-08-24T10:00:00.000Z'),
      });
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.refusal).toBe('PLAN_POLICY_MISMATCH');
    } finally {
      await setKillSwitch(sql, { engaged: true, setBy: 'test', reason: 'réarmé après le test' });
    }
  });

  // -------------------------------------------------------------------------
  // §25 / §36.45 / §36.46 — provenance et traçabilité
  // -------------------------------------------------------------------------

  it('§25/§36.45 — un plan porte une provenance MACHINE, jamais humaine', async () => {
    const prospect = await newProspect();
    const inbound = await inboundTurn(prospect, 'Comment ça marche ?', 'QUESTION', '2026-08-21T13:00:00.000Z');
    const recorded = await recordConversationPlan(sql, planInput(prospect.prospectId, inbound));

    expect(recorded.plan.actorKind).toBe('AUTONOMOUS_POLICY');
    expect(recorded.plan.policyVersion).toBe(CONVERSATION_POLICY_VERSION);
    expect(recorded.plan.brainVersion).toBe(conversationPromptVersionFor('email'));

    // La base elle-même refuse une provenance humaine.
    await expect(
      sql.query(`update hermes_conversation_plans set actor_kind = 'HUMAN' where id = $1`, [
        recorded.plan.id,
      ]),
    ).rejects.toThrow();
  });

  it('§28/§36.46 — le plan relie le message reçu, la décision et le texte, sans allumer l’apprentissage', async () => {
    const prospect = await newProspect();
    const inbound = await inboundTurn(prospect, 'Comment ça marche ?', 'QUESTION', '2026-08-21T13:00:00.000Z');
    const recorded = await recordConversationPlan(sql, planInput(prospect.prospectId, inbound));

    expect(recorded.plan.triggerInboundMessageId).toBe(inbound);
    expect(recorded.plan.bodySha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(recorded.plan.conversationWatermark).not.toBeNull();
    expect(recorded.plan.offerReadiness).toBe('MEDIUM');
    expect(recorded.plan.callReadiness).toBe('MEDIUM');
    expect(process.env.OUTBOUND_LEARNING_INJECTION_ENABLED ?? '0').not.toBe('1');
  });

  // -------------------------------------------------------------------------
  // §30 — l'évaluation de bout en bout, sur une vraie conversation
  // -------------------------------------------------------------------------

  it('§30 — l’évaluation lit la base, décide, et ne produit AUCUN effet', async () => {
    const prospect = await newProspect({ identityConfirmed: true });
    const inbound = await inboundTurn(
      prospect,
      'Bonjour, comment ça marche concrètement chez vous ?',
      'QUESTION',
      '2026-08-21T13:00:00.000Z',
    );

    const assessment = await assessInboundMessage(sql, inbound, {
      config: policy,
      now: new Date('2026-08-21T14:00:00.000Z'),
    });
    expect(assessment).not.toBeNull();
    expect(assessment!.externalEffects).toBe(false);
    expect(assessment!.policyVersion).toBe(CONVERSATION_POLICY_VERSION);
    // Aucun brouillon n'a été rédigé pour ce tour : la décision le DIT plutôt
    // que d'en inventer un.
    expect(assessment!.autonomous.reason).toBe('draft_missing');
    expect(assessment!.burstSettled).toBe(true);
    expect(assessment!.newerInboundExists).toBe(false);
  });

  it('§30 bis — les gardes d’un prospect se lisent en une fois et refusent un inconnu', async () => {
    const guards = await loadConversationGuards(sql, '00000000-0000-0000-0000-000000000000', 'instagram_dm');
    expect(guards.suppressed).toBe(true);
    expect(guards.identityConfirmed).toBe(false);
  });

  it('§35 — les faits de relance se lisent sur les preuves, pas sur les intentions', async () => {
    const prospect = await newProspect();
    const facts = await loadFollowUpFacts(sql, prospect.prospectId, 'email');
    expect(facts).not.toBeNull();
    expect(facts!.followUpsSent).toBe(0);
    expect(facts!.policyVersion).toBe(CONVERSATION_POLICY_VERSION);
    expect(facts!.firstTouchSentAt).not.toBeNull();
  });
});
