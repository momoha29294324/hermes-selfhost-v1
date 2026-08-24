import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { createLogger } from '@/lib/logging/logger';
import { ModelRouter } from '@/lib/models/router';
import { LlmError, type LlmProvider } from '@/lib/models/types';
import type { Sql } from '@/lib/db/sql';
import type { CrmResolution } from '@/lib/crm/types';
import { processNewReplies, processReply } from '@/lib/replies/process';
import { loadOutreachState } from '@/lib/replies/state';
import { auditReplyStates, repairMissingProgression } from '@/lib/replies/stateAudit';
import { resolveLane } from '@/lib/crm/view';
import {
  CATEGORY_POLICY,
  REPLY_ACKNOWLEDGEABLE_FROM,
  shouldAcknowledgeReply,
  type OutreachState,
} from '@/lib/replies/taxonomy';
import { makeReplyFixtures, type ReplyFixtures } from './support/replyFixture';
import { turnAnswer } from './support/turnAnswer';

/**
 * HERMES-TARGETING-R1, partie A — « une réponse fait avancer l'état ».
 *
 * Le défaut corrigé ici n'était pas une panne : chaque brique marchait. La
 * corrélation trouvait le bon prospect, la classification concluait, la
 * transition s'écrivait. Ce qui manquait était une MARCHE — le fait qu'un
 * humain ait écrit n'était inscrit nulle part, l'état sautait directement à
 * l'intention, et quand l'intention n'était pas tranchable il tombait en
 * « à arbitrer ». La colonne « Ont répondu » restait donc vide pendant que la
 * boîte de réception se remplissait.
 *
 * Ces tests portent donc autant sur ce qui BOUGE que sur ce qui ne bouge PAS :
 * un accusé d'absence, une non-remise et un second message d'un prospect déjà
 * intéressé doivent tous laisser l'état où il est.
 *
 * Aucun test n'ouvre de connexion réseau : le modèle est un faux transport
 * injecté dans le VRAI `ModelRouter`.
 */

const MAILBOX = 'contact@hermes-test.fr';
const FIRST_TOUCH = 'Bonjour, une question rapide sur vos prestations.';
const logger = createLogger({ level: 'error' });

const NO_CRM: CrmResolution = {
  configured: false,
  kind: 'NOT_CONFIGURED',
  reason: 'aucune destination CRM configurée pour Hermes',
  missing: ['OUTBOUND_CRM_PROVIDER'],
};

let sql: Sql;
let dir: string;
let campaignId: string;
let contactedProspect: ReplyFixtures['contactedProspect'];
let inbound: ReplyFixtures['inbound'];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-reply-progression-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-progression-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
  ({ contactedProspect, inbound } = makeReplyFixtures(sql, {
    campaignId,
    mailbox: MAILBOX,
    firstTouch: FIRST_TOUCH,
  }));
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('delete from r6b_alerts');
  await sql.query('delete from r6b_reply_drafts');
  await sql.query('delete from r6b_crm_projections');
  await sql.query('delete from r6b_prospect_state_transitions');
  await sql.query('delete from r6b_prospect_outreach_states');
  await sql.query('delete from r6b_reply_analyses');
  await sql.query('delete from r6b_inbound_messages');
  await sql.query('delete from do_not_contact');
  await sql.query('delete from r6b_dispatch_attempts');
  await sql.query('delete from r6b_live_send_attempts');
  await sql.query('delete from outreach_events');
  await sql.query('delete from r6b_dispatch_manifests');
  await sql.query('delete from r6b_batch_votes');
  await sql.query('delete from r6b_batch_items');
  await sql.query('delete from r6b_batches');
  await sql.query('delete from prospect_angles');
  await sql.query('delete from prospect_research');
  await sql.query('delete from prospect_evidence');
  await sql.query('delete from prospects');
});

interface Script {
  readonly classify?: unknown | (() => unknown);
  readonly draft?: unknown | (() => unknown);
}

function makeRouter(script: Script): ModelRouter {
  const provider: LlmProvider = {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async (request) => {
      // HERMES-SEMANTIC-GROUNDING-R1 — un tour, un appel : la lecture et le
      // texte sortent du même objet.
      if (script.classify === undefined && script.draft === undefined) {
        throw new LlmError(`aucun script pour ${request.task}`, 'provider_error');
      }
      const resolve = (value: unknown): unknown =>
        typeof value === 'function' ? (value as () => unknown)() : value;
      const classify = resolve(script.classify) as Record<string, unknown> | undefined;
      const draft = resolve(script.draft) as Record<string, unknown> | undefined;
      return { text: JSON.stringify(turnAnswer(classify, draft)) };
    },
  };
  return new ModelRouter({ sql, logger, providers: { codex: provider } });
}

function classifyAs(category: string, confidence = 0.92): Record<string, unknown> {
  return {
    category,
    confidence,
    reasoning_summary: `réponse classée ${category} sur la base du texte reçu.`,
    evidence_excerpts: [],
  };
}

const DRAFT_ANSWER = {
  body: 'Bien noté, je regarde ça et je reviens vers vous avec une proposition simple.',
  rationale: 'Réponse courte, sans chiffre ni promesse.',
  used_facts: [],
};

/**
 * Le CHEMIN parcouru par un prospect, reconstitué en suivant les transitions.
 *
 * Pas un `order by created_at` : les marches d'un même passage sont écrites à
 * quelques microsecondes l'une de l'autre, et `now()` étant l'heure de
 * TRANSACTION, deux transitions voisines peuvent porter le même horodatage.
 * Un test qui s'y fierait passerait ou tomberait selon la machine.
 *
 * Le chemin, lui, est une donnée exacte : chaque ligne dit d'où elle part, et
 * une seule part de l'état d'arrivée de la précédente. Le reconstituer vérifie
 * en prime que la chaîne est CONTINUE — c'est-à-dire qu'aucune marche n'a été
 * sautée, ce qui est précisément l'objet de cette mission.
 */
async function transitionsFor(prospectId: string): Promise<{ from: string | null; to: string }[]> {
  const rows = await sql.query<{ from: string | null; to: string }>(
    `select from_state as "from", to_state as "to"
       from r6b_prospect_state_transitions where prospect_id = $1`,
    [prospectId],
  );
  const chain: { from: string | null; to: string }[] = [];
  const remaining = [...rows];
  let current: string | null = null;
  for (;;) {
    const index = remaining.findIndex((row) => row.from === current);
    if (index < 0) break;
    const [step] = remaining.splice(index, 1);
    if (step === undefined) break;
    chain.push(step);
    current = step.to;
  }
  // Une ligne qui ne se raccroche à rien serait une marche orpheline : le test
  // doit tomber, pas l'ignorer.
  expect(remaining).toEqual([]);
  return chain;
}

/** Un prospect contacté, une réponse corrélée, un traitement. */
async function replyOnce(
  body: string,
  category: string,
  options: { readonly recipient?: string; readonly automationSignals?: readonly string[] } = {},
): Promise<{ prospectId: string; inboundId: string; router: ModelRouter }> {
  const recipient = options.recipient ?? `client-${Math.random().toString(36).slice(2, 10)}@acme-test.fr`;
  const contacted = await contactedProspect(recipient);
  const inboundId = await inbound({
    manifest: contacted.manifest,
    outreachEventId: contacted.outreachEventId,
    prospectId: contacted.prospectId,
    body,
    automationSignals: options.automationSignals,
  });
  const router = makeRouter({ classify: classifyAs(category), draft: DRAFT_ANSWER });
  await processReply(sql, router, inboundId, { crm: NO_CRM });
  return { prospectId: contacted.prospectId, inboundId, router };
}

// ---------------------------------------------------------------------------
// La règle, avant la base
// ---------------------------------------------------------------------------

describe('la règle d’accusé de réponse', () => {
  it('n’est vraie que depuis CONTACTED', () => {
    expect(REPLY_ACKNOWLEDGEABLE_FROM).toEqual(['CONTACTED']);
    for (const state of ['REPLIED', 'INTERESTED', 'NOT_NOW', 'NOT_INTERESTED', 'REVIEW_REQUIRED',
      'BOUNCED', 'SUPPRESSED'] as OutreachState[]) {
      expect(shouldAcknowledgeReply('INTERESTED', state)).toBe(false);
    }
    expect(shouldAcknowledgeReply('INTERESTED', 'CONTACTED')).toBe(true);
  });

  it('ne tient jamais pour une auto-réponse ni pour une non-remise', () => {
    expect(CATEGORY_POLICY.AUTO_REPLY.evidencesHumanReply).toBe(false);
    expect(CATEGORY_POLICY.BOUNCE.evidencesHumanReply).toBe(false);
    expect(shouldAcknowledgeReply('AUTO_REPLY', 'CONTACTED')).toBe(false);
    expect(shouldAcknowledgeReply('BOUNCE', 'CONTACTED')).toBe(false);
  });

  it('tient pour toutes les catégories écrites par un humain', () => {
    for (const category of ['INTERESTED', 'QUESTION', 'OBJECTION', 'NOT_NOW', 'NOT_INTERESTED',
      'UNSUBSCRIBE', 'OTHER', 'REVIEW_REQUIRED'] as const) {
      expect(CATEGORY_POLICY[category].evidencesHumanReply).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// §25 — les dix scénarios
// ---------------------------------------------------------------------------

describe('réponse corrélée → progression d’état', () => {
  it('1. une vraie réponse commerciale fait passer CONTACTED → REPLIED', async () => {
    const { prospectId } = await replyOnce(
      'Bonjour, principalement mon site internet et ma fiche Google.',
      'REVIEW_REQUIRED',
    );
    expect(await loadOutreachState(sql, prospectId)).toBe('REPLIED');
    expect(await transitionsFor(prospectId)).toEqual([
      { from: null, to: 'CONTACTED' },
      { from: 'CONTACTED', to: 'REPLIED' },
    ]);
  });

  it('2. un second passage sur le même message n’écrit pas de seconde transition', async () => {
    const { prospectId, inboundId, router } = await replyOnce('Ça m’intéresse, dites-m’en plus.', 'INTERESTED');
    const before = await transitionsFor(prospectId);

    const again = await processReply(sql, router, inboundId, { crm: NO_CRM });
    expect(again.replyAcknowledged).toBe(false);
    expect(again.stateApplied).toBe(false);
    expect(await transitionsFor(prospectId)).toEqual(before);
    expect(await loadOutreachState(sql, prospectId)).toBe('INTERESTED');
  });

  it('3. une corrélation faible ne produit aucune transition', async () => {
    const contacted = await contactedProspect('faible@acme-test.fr');
    await inbound({
      manifest: contacted.manifest,
      outreachEventId: contacted.outreachEventId,
      prospectId: contacted.prospectId,
      body: 'Bonjour, de quoi s’agit-il ?',
      correlationStatus: 'REVIEW_REQUIRED',
    });

    const router = makeRouter({ classify: classifyAs('QUESTION'), draft: DRAFT_ANSWER });
    const report = await processNewReplies(sql, router, { crm: NO_CRM });

    expect(report.candidates).toBe(0);
    expect(report.repliesAcknowledged).toBe(0);
    expect(await loadOutreachState(sql, contacted.prospectId)).toBeNull();
    expect(await transitionsFor(contacted.prospectId)).toEqual([]);
  });

  it('4. une auto-réponse laisse l’état à CONTACTED', async () => {
    const { prospectId } = await replyOnce(
      'Je suis absent jusqu’au 30 août.',
      'INTERESTED',
      { automationSignals: ['auto_submitted:auto-replied'] },
    );
    expect(await loadOutreachState(sql, prospectId)).toBe('CONTACTED');
    expect(await transitionsFor(prospectId)).toEqual([{ from: null, to: 'CONTACTED' }]);
  });

  it('5. une non-remise ne produit jamais un faux REPLIED', async () => {
    const { prospectId } = await replyOnce(
      'Delivery Status Notification (Failure)',
      'INTERESTED',
      { automationSignals: ['delivery_status_report'] },
    );
    expect(await loadOutreachState(sql, prospectId)).toBe('BOUNCED');
    const transitions = await transitionsFor(prospectId);
    expect(transitions.some((entry) => entry.to === 'REPLIED')).toBe(false);
  });

  it('6. un désabonnement reste terminal, en passant par REPLIED', async () => {
    const { prospectId } = await replyOnce('Ne me contactez plus, merci.', 'UNSUBSCRIBE');
    expect(await loadOutreachState(sql, prospectId)).toBe('SUPPRESSED');
    expect(await transitionsFor(prospectId)).toEqual([
      { from: null, to: 'CONTACTED' },
      { from: 'CONTACTED', to: 'REPLIED' },
      { from: 'REPLIED', to: 'SUPPRESSED' },
    ]);

    const suppression = await sql.query<{ n: string }>(
      `select count(*)::text as n from do_not_contact`,
    );
    expect(Number(suppression[0]!.n)).toBeGreaterThan(0);
  });

  it('7. INTERESTED emprunte le chemin légal CONTACTED → REPLIED → INTERESTED', async () => {
    const { prospectId } = await replyOnce('Oui, ça m’intéresse, on peut en parler.', 'INTERESTED');
    expect(await transitionsFor(prospectId)).toEqual([
      { from: null, to: 'CONTACTED' },
      { from: 'CONTACTED', to: 'REPLIED' },
      { from: 'REPLIED', to: 'INTERESTED' },
    ]);
    expect(await loadOutreachState(sql, prospectId)).toBe('INTERESTED');
  });

  it('8. NOT_INTERESTED emprunte le même chemin légal', async () => {
    const { prospectId } = await replyOnce('Non merci, ce n’est pas pour nous.', 'NOT_INTERESTED');
    expect(await transitionsFor(prospectId)).toEqual([
      { from: null, to: 'CONTACTED' },
      { from: 'CONTACTED', to: 'REPLIED' },
      { from: 'REPLIED', to: 'NOT_INTERESTED' },
    ]);
  });

  it('9. un second message d’un prospect déjà INTERESTED ne le ramène pas en REPLIED', async () => {
    const contacted = await contactedProspect('deux-tours@acme-test.fr');
    const first = await inbound({
      manifest: contacted.manifest,
      outreachEventId: contacted.outreachEventId,
      prospectId: contacted.prospectId,
      body: 'Oui ça m’intéresse.',
      receivedAt: '2026-08-20T10:00:00.000Z',
    });
    const second = await inbound({
      manifest: contacted.manifest,
      outreachEventId: contacted.outreachEventId,
      prospectId: contacted.prospectId,
      body: 'J’ai beaucoup de travail en ce moment.',
      receivedAt: '2026-08-20T11:00:00.000Z',
    });

    const router = makeRouter({ classify: classifyAs('INTERESTED'), draft: DRAFT_ANSWER });
    await processReply(sql, router, first, { crm: NO_CRM });
    expect(await loadOutreachState(sql, contacted.prospectId)).toBe('INTERESTED');

    const ambiguous = makeRouter({ classify: classifyAs('REVIEW_REQUIRED'), draft: DRAFT_ANSWER });
    const outcome = await processReply(sql, ambiguous, second, { crm: NO_CRM });
    expect(outcome.replyAcknowledged).toBe(false);

    const toReplied = (await transitionsFor(contacted.prospectId)).filter((entry) => entry.to === 'REPLIED');
    expect(toReplied).toHaveLength(1);
  });

  it('10. la colonne du pipeline suit l’état canonique', async () => {
    const { prospectId } = await replyOnce('Bonjour, ça fait onze ans que j’exerce.', 'REVIEW_REQUIRED');
    const state = await loadOutreachState(sql, prospectId);
    expect(state).toBe('REPLIED');
    expect(
      resolveLane({
        stage: 'approved',
        outreachState: state,
        sentCount: 1,
        hasLockedManifest: true,
        isClient: false,
        doNotContact: false,
      }),
    ).toBe('REPLIED');
  });

  it('un lot complet, rejoué, ne bouge rien une seconde fois', async () => {
    for (const recipient of ['un@acme-test.fr', 'deux@acme-test.fr']) {
      const contacted = await contactedProspect(recipient);
      await inbound({
        manifest: contacted.manifest,
        outreachEventId: contacted.outreachEventId,
        prospectId: contacted.prospectId,
        body: 'Bonjour, comment ça fonctionne exactement ?',
      });
    }
    const router = makeRouter({ classify: classifyAs('QUESTION'), draft: DRAFT_ANSWER });

    const first = await processNewReplies(sql, router, { crm: NO_CRM });
    expect(first.repliesAcknowledged).toBe(2);

    const second = await processNewReplies(sql, router, { crm: NO_CRM }, { includeAnalyzed: true });
    expect(second.repliesAcknowledged).toBe(0);

    const rows = await sql.query<{ n: string }>(
      `select count(*)::text as n from r6b_prospect_state_transitions where to_state = 'REPLIED'`,
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §8 — l'audit et sa réparation bornée
// ---------------------------------------------------------------------------

describe('audit d’état, en lecture seule puis en réparation bornée', () => {
  it('nomme la réponse jamais analysée sans prétendre pouvoir la réparer', async () => {
    const contacted = await contactedProspect('jamais-analyse@acme-test.fr');
    await inbound({
      manifest: contacted.manifest,
      outreachEventId: contacted.outreachEventId,
      prospectId: contacted.prospectId,
      body: 'Bonjour, je suis intéressé.',
    });

    const audit = await auditReplyStates(sql);
    expect(audit.counts.NO_ANALYSIS).toBe(1);
    expect(audit.counts.MISSING_PROGRESSION).toBe(0);

    const repair = await repairMissingProgression(sql);
    expect(repair.eligible).toBe(0);
    expect(repair.repaired).toHaveLength(0);
    // Rien n'a été inventé : l'état reste ce qu'il était.
    expect(await loadOutreachState(sql, contacted.prospectId)).toBeNull();
  });

  it('répare une analyse existante restée sans progression, et ne le fait qu’une fois', async () => {
    const { prospectId, inboundId } = await replyOnce('Ça m’intéresse.', 'INTERESTED');

    // On remet l'état commercial dans l'état d'AVANT le correctif : l'analyse
    // reste, les transitions disparaissent. C'est exactement la situation d'un
    // dépôt dont le pipeline a tourné sous l'ancienne règle.
    await sql.query('delete from r6b_prospect_outreach_states where prospect_id = $1', [prospectId]);
    await sql.query('delete from r6b_prospect_state_transitions where prospect_id = $1', [prospectId]);
    await sql.query(
      `insert into r6b_prospect_outreach_states (prospect_id, state, entered_at, updated_at)
       values ($1,'CONTACTED',now(),now())`,
      [prospectId],
    );

    const audit = await auditReplyStates(sql);
    expect(audit.counts.MISSING_PROGRESSION).toBe(1);
    expect(audit.cases.find((entry) => entry.inboundMessageId === inboundId)?.targetState).toBe('INTERESTED');

    const repair = await repairMissingProgression(sql);
    expect(repair.eligible).toBe(1);
    expect(repair.repaired[0]?.acknowledged).toBe(true);
    expect(repair.repaired[0]?.intentApplied).toBe(true);
    expect(await loadOutreachState(sql, prospectId)).toBe('INTERESTED');

    const again = await repairMissingProgression(sql);
    expect(again.eligible).toBe(0);
    expect((await auditReplyStates(sql)).counts.MISSING_PROGRESSION).toBe(0);
  });

  it('ne touche jamais un prospect protégé', async () => {
    const { prospectId } = await replyOnce('Ne me contactez plus.', 'UNSUBSCRIBE');
    expect(await loadOutreachState(sql, prospectId)).toBe('SUPPRESSED');

    const audit = await auditReplyStates(sql);
    expect(audit.counts.PROTECTED).toBe(1);
    expect(audit.counts.MISSING_PROGRESSION).toBe(0);

    await repairMissingProgression(sql);
    expect(await loadOutreachState(sql, prospectId)).toBe('SUPPRESSED');
  });
});
