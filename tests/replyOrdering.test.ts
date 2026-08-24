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
import { applyTransition, loadOutreachState, loadOutreachStateRow } from '@/lib/replies/state';
import {
  auditReplyOrdering,
  auditReplyStates,
  foldReplyOrder,
  repairReplyOrdering,
} from '@/lib/replies/stateAudit';
import { resolveLane } from '@/lib/crm/view';
import { makeReplyFixtures, type ReplyFixtures } from './support/replyFixture';
import { turnAnswer } from './support/turnAnswer';

/**
 * HERMES-REPLY-ORDERING-R1 — « la dernière phrase du prospect gouverne ».
 *
 * Le défaut corrigé ici n'était, encore une fois, la panne de personne : la
 * corrélation trouvait le bon prospect, le classifieur concluait juste sur
 * CHAQUE message, chaque transition était journalisée. Ce qui manquait était
 * un ORDRE. Le système en connaissait deux — celui de la boîte de réception et
 * celui de la file de traitement — et c'est le second qui écrivait l'état,
 * alors que seul le premier a un sens pour un prospect.
 *
 * Ces tests sont donc écrits autour d'une seule question : est-ce que l'ORDRE
 * DE TRAITEMENT peut encore changer le résultat ? Chaque scénario est joué dans
 * les deux sens, et le test ne passe que si les deux sens donnent le même état.
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
  dir = mkdtempSync(join(tmpdir(), 'hermes-reply-ordering-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-ordering-test', 'Test', 'example-services', '{}'],
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

const DRAFT_ANSWER = {
  body: 'Bien noté, je regarde ça et je reviens vers vous avec une proposition simple.',
  rationale: 'Réponse courte, sans chiffre ni promesse.',
  used_facts: [],
};

/**
 * Un routeur dont la réponse dépend du TEXTE reçu.
 *
 * Un routeur par message aurait obligé chaque scénario à savoir dans quel ordre
 * il allait traiter — c'est-à-dire à encoder dans le test exactement ce que le
 * test cherche à rendre sans effet. Ici le classifieur est une fonction du
 * message, comme le vrai : le scénario peut être rejoué dans n'importe quel
 * sens sans qu'une seule ligne change.
 *
 * HERMES-CONTEXTUAL-REPLY-CLASSIFICATION-R1 — la correspondance est bornée au
 * message COURANT. Depuis que le prompt porte les tours antérieurs, un `includes`
 * sur le prompt entier retrouverait aussi les marqueurs des messages
 * précédents, et ce faux routeur classerait le troisième message comme le
 * premier. Le vrai modèle, lui, lit la consigne — « classe le DERNIER MESSAGE
 * REÇU » —, mais un faux routeur ne lit rien : il faut donc lui donner la même
 * frontière, découpée là où le prompt la pose.
 */
function routerFor(script: ReadonlyMap<string, string>): ModelRouter {
  const provider: LlmProvider = {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async (request) => {
      // HERMES-SEMANTIC-GROUNDING-R1 — le tour est unifié : le prompt ne porte
      // plus le bloc de contexte du classifieur, mais le FIL, dans lequel le
      // message jugé est nommé en toutes lettres.
      const cut = request.prompt.lastIndexOf('le message auquel tu réponds maintenant');
      const current = cut < 0 ? request.prompt : request.prompt.slice(cut);
      const hit = [...script.entries()].find(([marker]) => current.includes(marker));
      if (hit === undefined) throw new LlmError('aucun script pour ce message', 'provider_error');
      return {
        text: JSON.stringify(
          turnAnswer(
            {
              category: hit[1],
              confidence: 0.94,
              reasoning_summary: `réponse classée ${hit[1]} sur la base du texte reçu.`,
              evidence_excerpts: [],
            },
            DRAFT_ANSWER,
          ),
        ),
      };
    },
  };
  return new ModelRouter({ sql, logger, providers: { codex: provider } });
}

interface ReplySpec {
  readonly marker: string;
  readonly category: string;
  readonly receivedAt: string;
}

interface Conversation {
  readonly prospectId: string;
  /** Les identifiants entrants, dans l'ordre de RÉCEPTION. */
  readonly ids: readonly string[];
  readonly router: ModelRouter;
}

/** Un prospect contacté, plusieurs réponses datées, aucun traitement encore. */
async function conversation(recipient: string, specs: readonly ReplySpec[]): Promise<Conversation> {
  const contacted = await contactedProspect(recipient);
  const ids: string[] = [];
  for (const spec of specs) {
    ids.push(
      await inbound({
        manifest: contacted.manifest,
        outreachEventId: contacted.outreachEventId,
        prospectId: contacted.prospectId,
        body: `Bonjour, ${spec.marker} de notre côté.`,
        receivedAt: spec.receivedAt,
      }),
    );
  }
  const script = new Map(specs.map((spec) => [spec.marker, spec.category] as const));
  return { prospectId: contacted.prospectId, ids, router: routerFor(script) };
}

async function processInOrder(convo: Conversation, order: readonly number[]): Promise<void> {
  for (const index of order) {
    await processReply(sql, convo.router, convo.ids[index]!, { crm: NO_CRM });
  }
}

/**
 * Le scénario réel du 21 août 2026, réduit à ses trois phrases utiles.
 *
 * Aucun nom, aucun texte et aucune adresse réels : seule la FORME du cas est
 * reprise — trois réponses du même prospect, dont la dernière est un refus, et
 * un traitement qui se termine par la première.
 */
const ATELIER_LIKE: readonly ReplySpec[] = [
  { marker: 'je suis installé depuis onze ans', category: 'REVIEW_REQUIRED', receivedAt: '2026-08-21T13:13:23.612Z' },
  { marker: 'votre offre me semble chère', category: 'OBJECTION', receivedAt: '2026-08-21T13:26:13.140Z' },
  { marker: 'ce ne sera pas pour nous', category: 'NOT_INTERESTED', receivedAt: '2026-08-21T13:35:31.696Z' },
];

// ---------------------------------------------------------------------------
// La règle, avant la base
// ---------------------------------------------------------------------------

describe('le repli canonique d’une conversation', () => {
  it('rend le même état quel que soit l’ordre dans lequel on lui donne les mêmes réponses… non : il dépend de l’ordre, et c’est le but', () => {
    const chronological = foldReplyOrder([
      { classification: 'REVIEW_REQUIRED' },
      { classification: 'OBJECTION' },
      { classification: 'NOT_INTERESTED' },
    ]);
    expect(chronological).toBe('NOT_INTERESTED');

    // Le repli est une FONCTION de la séquence : lui donner une autre séquence
    // rend un autre état. C'est précisément pourquoi la séquence doit venir de
    // `received_at` et de rien d'autre — le repli ne peut pas corriger un ordre
    // faux, il ne peut que refléter fidèlement celui qu'on lui donne.
    expect(
      foldReplyOrder([
        { classification: 'NOT_INTERESTED' },
        { classification: 'OBJECTION' },
      ]),
    ).toBe('INTERESTED');
  });

  it('tient SUPPRESSED pour terminal, même si la suite dit oui', () => {
    expect(
      foldReplyOrder([
        { classification: 'UNSUBSCRIBE' },
        { classification: 'INTERESTED' },
      ]),
    ).toBe('SUPPRESSED');
  });
});

// ---------------------------------------------------------------------------
// §13 — les vingt scénarios
// ---------------------------------------------------------------------------

describe('ordre de réception vs ordre de traitement', () => {
  it('1. traité dans l’ordre chronologique, l’état suit la dernière réponse', async () => {
    const convo = await conversation('chrono@acme-test.fr', ATELIER_LIKE);
    await processInOrder(convo, [0, 1, 2]);
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('NOT_INTERESTED');
  });

  it('2. traité à l’envers, l’état suit toujours la dernière réponse REÇUE', async () => {
    const convo = await conversation('anti-chrono@acme-test.fr', ATELIER_LIKE);
    await processInOrder(convo, [2, 1, 0]);
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('NOT_INTERESTED');
  });

  it('3. les deux ordres, et un ordre quelconque, produisent le MÊME état final', async () => {
    const orders = [
      [0, 1, 2],
      [2, 1, 0],
      [1, 2, 0],
      [2, 0, 1],
    ];
    const states: (string | null)[] = [];
    for (const [index, order] of orders.entries()) {
      const convo = await conversation(`ordre-${String(index)}@acme-test.fr`, ATELIER_LIKE);
      await processInOrder(convo, order);
      states.push(await loadOutreachState(sql, convo.prospectId));
    }
    expect(new Set(states).size).toBe(1);
    expect(states[0]).toBe('NOT_INTERESTED');
  });

  it('4. un REVIEW_REQUIRED ancien ne réécrit pas un NOT_INTERESTED récent', async () => {
    const convo = await conversation('review-apres@acme-test.fr', [
      { marker: 'je suis installé depuis onze ans', category: 'REVIEW_REQUIRED', receivedAt: '2026-08-21T13:13:00.000Z' },
      { marker: 'ce ne sera pas pour nous', category: 'NOT_INTERESTED', receivedAt: '2026-08-21T13:35:00.000Z' },
    ]);
    await processInOrder(convo, [1]);
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('NOT_INTERESTED');

    const late = await processReply(sql, convo.router, convo.ids[0]!, { crm: NO_CRM });
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('NOT_INTERESTED');
    expect(late.stateApplied).toBe(false);
  });

  it('5. un INTERESTED ancien ne réécrit pas un NOT_INTERESTED récent', async () => {
    const convo = await conversation('interesse-avant@acme-test.fr', [
      { marker: 'oui ça nous parle', category: 'INTERESTED', receivedAt: '2026-08-21T13:00:00.000Z' },
      { marker: 'ce ne sera pas pour nous', category: 'NOT_INTERESTED', receivedAt: '2026-08-21T13:35:00.000Z' },
    ]);
    await processInOrder(convo, [1]);
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('NOT_INTERESTED');

    const late = await processReply(sql, convo.router, convo.ids[0]!, { crm: NO_CRM });
    expect(late.staleReplyIgnored).toBe(true);
    expect(late.stateApplied).toBe(false);
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('NOT_INTERESTED');
  });

  it('6. un NOT_INTERESTED ancien ne réécrit pas un INTERESTED récent', async () => {
    const convo = await conversation('refus-avant@acme-test.fr', [
      { marker: 'ce ne sera pas pour nous', category: 'NOT_INTERESTED', receivedAt: '2026-08-21T13:00:00.000Z' },
      { marker: 'oui ça nous parle', category: 'INTERESTED', receivedAt: '2026-08-21T13:35:00.000Z' },
    ]);
    await processInOrder(convo, [1]);
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('INTERESTED');

    const late = await processReply(sql, convo.router, convo.ids[0]!, { crm: NO_CRM });
    expect(late.staleReplyIgnored).toBe(true);
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('INTERESTED');
  });

  it('7. rejouer exactement le même message n’a aucun second effet', async () => {
    const convo = await conversation('idempotent@acme-test.fr', ATELIER_LIKE);
    await processInOrder(convo, [0, 1, 2]);
    const before = await sql.query<{ n: string }>(
      `select count(*)::text as n from r6b_prospect_state_transitions where prospect_id = $1`,
      [convo.prospectId],
    );

    for (const index of [2, 2, 1, 0]) {
      await processReply(sql, convo.router, convo.ids[index]!, { crm: NO_CRM });
    }
    const after = await sql.query<{ n: string }>(
      `select count(*)::text as n from r6b_prospect_state_transitions where prospect_id = $1`,
      [convo.prospectId],
    );
    expect(after[0]!.n).toBe(before[0]!.n);
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('NOT_INTERESTED');
  });

  it('8. un redémarrage — un lot entier repassé à zéro — rend le même état', async () => {
    const convo = await conversation('restart@acme-test.fr', ATELIER_LIKE);
    const first = await processNewReplies(sql, convo.router, { crm: NO_CRM });
    expect(first.processed).toHaveLength(3);
    const state = await loadOutreachState(sql, convo.prospectId);
    expect(state).toBe('NOT_INTERESTED');

    const restart = await processNewReplies(sql, convo.router, { crm: NO_CRM });
    expect(restart.candidates).toBe(0);
    expect(await loadOutreachState(sql, convo.prospectId)).toBe(state);
  });

  it('9. --resume (includeAnalyzed) repasse sur tout sans rien faire régresser', async () => {
    const convo = await conversation('resume@acme-test.fr', ATELIER_LIKE);
    await processNewReplies(sql, convo.router, { crm: NO_CRM });
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('NOT_INTERESTED');

    const resumed = await processNewReplies(sql, convo.router, { crm: NO_CRM }, { includeAnalyzed: true });
    expect(resumed.candidates).toBe(3);
    expect(resumed.repliesAcknowledged).toBe(0);
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('NOT_INTERESTED');
  });

  it('10. deux traitements entrelacés convergent vers la réponse la plus récente', async () => {
    const convo = await conversation('concurrent@acme-test.fr', [
      { marker: 'oui ça nous parle', category: 'INTERESTED', receivedAt: '2026-08-21T13:00:00.000Z' },
      { marker: 'ce ne sera pas pour nous', category: 'NOT_INTERESTED', receivedAt: '2026-08-21T13:35:00.000Z' },
    ]);
    await Promise.all([
      processReply(sql, convo.router, convo.ids[0]!, { crm: NO_CRM }),
      processReply(sql, convo.router, convo.ids[1]!, { crm: NO_CRM }),
    ]);
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('NOT_INTERESTED');
  });

  it('11. l’analyse d’une réponse dépassée est CONSERVÉE', async () => {
    const convo = await conversation('analyse-conservee@acme-test.fr', ATELIER_LIKE);
    await processInOrder(convo, [2, 1, 0]);

    const analyses = await sql.query<{ inboundMessageId: string; classification: string; status: string }>(
      `select inbound_message_id as "inboundMessageId", classification, status
         from r6b_reply_analyses where status = 'ACTIVE' order by created_at`,
    );
    expect(analyses).toHaveLength(3);
    expect(analyses.map((row) => row.classification).sort()).toEqual(
      ['NOT_INTERESTED', 'OBJECTION', 'REVIEW_REQUIRED'],
    );
    // Le message lui-même n'est ni effacé ni marqué : le Learning Loop le lit
    // exactement comme avant.
    const messages = await sql.query<{ n: string }>(
      `select count(*)::text as n from r6b_inbound_messages where correlated_prospect_id = $1`,
      [convo.prospectId],
    );
    expect(Number(messages[0]!.n)).toBe(3);
  });

  it('12. une réponse dépassée produit encore ses diagnostics — brouillon et alerte', async () => {
    const convo = await conversation('diagnostics@acme-test.fr', [
      { marker: 'oui ça nous parle', category: 'INTERESTED', receivedAt: '2026-08-21T13:00:00.000Z' },
      { marker: 'ce ne sera pas pour nous', category: 'NOT_INTERESTED', receivedAt: '2026-08-21T13:35:00.000Z' },
    ]);
    await processInOrder(convo, [1]);
    const stale = await processReply(sql, convo.router, convo.ids[0]!, { crm: NO_CRM });

    expect(stale.staleReplyIgnored).toBe(true);
    expect(stale.draftId).not.toBeNull();
    expect(stale.alertId).not.toBeNull();
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('NOT_INTERESTED');
  });

  it('13. une transition qui ne vient PAS d’un message entrant n’est pas soumise à l’ordre', async () => {
    const convo = await conversation('humain@acme-test.fr', ATELIER_LIKE);
    await processInOrder(convo, [0, 1, 2]);
    const before = await loadOutreachStateRow(sql, convo.prospectId);
    expect(before?.state).toBe('NOT_INTERESTED');
    expect(before?.lastReplyReceivedAt?.toISOString()).toBe('2026-08-21T13:35:31.696Z');

    // Un humain tranche, sans message entrant. Aucune heure de réception ne
    // s'oppose à lui, et la marque d'eau ne bouge pas d'un pouce.
    const human = await applyTransition(sql, {
      prospectId: convo.prospectId,
      toState: 'INTERESTED',
      causeKind: 'human',
      causeId: null,
      analysisId: null,
      reason: 'décision humaine de test',
    });
    expect(human.applied).toBe(true);
    const after = await loadOutreachStateRow(sql, convo.prospectId);
    expect(after?.state).toBe('INTERESTED');
    expect(after?.lastReplyReceivedAt?.toISOString()).toBe('2026-08-21T13:35:31.696Z');
  });

  it('14. la première réponse humaine fait toujours CONTACTED → REPLIED', async () => {
    const convo = await conversation('premiere@acme-test.fr', ATELIER_LIKE);
    await processInOrder(convo, [0, 1, 2]);
    const replied = await sql.query<{ n: string }>(
      `select count(*)::text as n from r6b_prospect_state_transitions
        where prospect_id = $1 and from_state = 'CONTACTED' and to_state = 'REPLIED'`,
      [convo.prospectId],
    );
    expect(Number(replied[0]!.n)).toBe(1);
  });

  it('15. une intention PLUS RÉCENTE remplace bien la précédente', async () => {
    const convo = await conversation('progression@acme-test.fr', [
      { marker: 'oui ça nous parle', category: 'INTERESTED', receivedAt: '2026-08-21T13:00:00.000Z' },
      { marker: 'ce ne sera pas pour nous', category: 'NOT_INTERESTED', receivedAt: '2026-08-21T13:35:00.000Z' },
    ]);
    await processInOrder(convo, [0]);
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('INTERESTED');
    await processInOrder(convo, [1]);
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('NOT_INTERESTED');
  });
});

// ---------------------------------------------------------------------------
// §8 — l'audit d'ordre et sa réparation bornée
// ---------------------------------------------------------------------------

/**
 * Remet un prospect dans l'état FAUX que l'ancien code produisait.
 *
 * Rejouer le bug demanderait de faire tourner l'ancien code ; il n'existe plus.
 * Ce que la réparation doit savoir traiter, ce n'est pas le bug, c'est sa
 * TRACE : un état courant qui ne correspond pas au repli de ses réponses,
 * alors que chaque message a bien son analyse et sa transition.
 */
async function forceState(prospectId: string, state: string): Promise<void> {
  await sql.query(
    `update r6b_prospect_outreach_states
        set state = $2, last_reply_received_at = null where prospect_id = $1`,
    [prospectId, state],
  );
}

describe('audit d’ordre, puis réparation bornée', () => {
  it('16. sur un flux traité dans l’ordre, aucun audit ne signale quoi que ce soit', async () => {
    const convo = await conversation('sain@acme-test.fr', ATELIER_LIKE);
    await processInOrder(convo, [0, 1, 2]);

    const progression = await auditReplyStates(sql);
    expect(progression.counts.MISSING_PROGRESSION).toBe(0);
    expect(progression.counts.NO_ANALYSIS).toBe(0);

    const order = await auditReplyOrdering(sql);
    expect(order.counts.DIVERGENT).toBe(0);
    expect(order.counts.CONSISTENT).toBe(1);
    expect(order.cases[0]?.expectedState).toBe('NOT_INTERESTED');
  });

  it('17. le DRY-RUN nomme la divergence et n’écrit rien', async () => {
    const convo = await conversation('divergent@acme-test.fr', ATELIER_LIKE);
    await processInOrder(convo, [0, 1, 2]);
    await forceState(convo.prospectId, 'REVIEW_REQUIRED');

    const audit = await auditReplyOrdering(sql);
    expect(audit.counts.DIVERGENT).toBe(1);
    expect(audit.cases[0]?.currentState).toBe('REVIEW_REQUIRED');
    expect(audit.cases[0]?.expectedState).toBe('NOT_INTERESTED');
    expect(audit.cases[0]?.latestReceivedAt).toBe('2026-08-21T13:35:31.696Z');

    const dryRun = await repairReplyOrdering(sql);
    expect(dryRun.applied).toBe(false);
    expect(dryRun.divergent).toBe(1);
    expect(dryRun.repaired).toBe(0);
    expect(dryRun.outcomes[0]?.written).toBe(false);
    // Rien n'a bougé : c'est le seul critère qui compte pour un dry-run.
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('REVIEW_REQUIRED');
  });

  it('17 bis. écrire sans se nommer est refusé', async () => {
    await expect(repairReplyOrdering(sql, { apply: true })).rejects.toThrow(/--as/);
  });

  it('18. --apply ne touche QUE les prospects divergents', async () => {
    const divergent = await conversation('a-reparer@acme-test.fr', ATELIER_LIKE);
    await processInOrder(divergent, [0, 1, 2]);
    await forceState(divergent.prospectId, 'REVIEW_REQUIRED');

    const healthy = await conversation('deja-juste@acme-test.fr', ATELIER_LIKE);
    await processInOrder(healthy, [0, 1, 2]);
    const healthyBefore = await sql.query<{ n: string }>(
      `select count(*)::text as n from r6b_prospect_state_transitions where prospect_id = $1`,
      [healthy.prospectId],
    );

    const report = await repairReplyOrdering(sql, { apply: true, actor: 'Operator Example' });
    expect(report.audited).toBe(2);
    expect(report.divergent).toBe(1);
    expect(report.repaired).toBe(1);
    expect(report.unchanged).toBe(1);

    expect(await loadOutreachState(sql, divergent.prospectId)).toBe('NOT_INTERESTED');
    expect(await loadOutreachState(sql, healthy.prospectId)).toBe('NOT_INTERESTED');
    const healthyAfter = await sql.query<{ n: string }>(
      `select count(*)::text as n from r6b_prospect_state_transitions where prospect_id = $1`,
      [healthy.prospectId],
    );
    expect(healthyAfter[0]!.n).toBe(healthyBefore[0]!.n);

    // La réparation est journalisée, nommément, et elle ajoute — elle ne
    // réécrit rien.
    const repairRow = await sql.query<{ reason: string; causeKind: string }>(
      `select reason, cause_kind as "causeKind" from r6b_prospect_state_transitions
        where prospect_id = $1 and cause_kind = 'human'`,
      [divergent.prospectId],
    );
    expect(repairRow).toHaveLength(1);
    expect(repairRow[0]!.reason).toContain('Operator Example');
    expect(repairRow[0]!.reason).toContain('REPAIR_REPLY_ORDER');
  });

  it('19. une seconde réparation appliquée ne change plus rien', async () => {
    const convo = await conversation('deux-fois@acme-test.fr', ATELIER_LIKE);
    await processInOrder(convo, [0, 1, 2]);
    await forceState(convo.prospectId, 'REVIEW_REQUIRED');

    const first = await repairReplyOrdering(sql, { apply: true, actor: 'Operator Example' });
    expect(first.repaired).toBe(1);

    const second = await repairReplyOrdering(sql, { apply: true, actor: 'Operator Example' });
    expect(second.divergent).toBe(0);
    expect(second.repaired).toBe(0);
    expect(second.outcomes).toHaveLength(0);
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('NOT_INTERESTED');
  });

  it('19 bis. un --resume après réparation ne ressuscite pas la réponse ancienne', async () => {
    const convo = await conversation('resume-apres@acme-test.fr', ATELIER_LIKE);
    await processInOrder(convo, [0, 1, 2]);
    await forceState(convo.prospectId, 'REVIEW_REQUIRED');
    await repairReplyOrdering(sql, { apply: true, actor: 'Operator Example' });

    await processNewReplies(sql, convo.router, { crm: NO_CRM }, { includeAnalyzed: true });
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('NOT_INTERESTED');
  });

  it('19 ter. un dossier tranché par un humain n’est jamais recalculé', async () => {
    const convo = await conversation('humain-decide@acme-test.fr', ATELIER_LIKE);
    await processInOrder(convo, [0, 1, 2]);
    await applyTransition(sql, {
      prospectId: convo.prospectId,
      toState: 'NOT_NOW',
      causeKind: 'human',
      causeId: null,
      analysisId: null,
      reason: 'un opérateur a rappelé, ils recontacteront en janvier',
    });

    const audit = await auditReplyOrdering(sql);
    expect(audit.counts.HUMAN_DECIDED).toBe(1);
    expect(audit.counts.DIVERGENT).toBe(0);

    const report = await repairReplyOrdering(sql, { apply: true, actor: 'Operator Example' });
    expect(report.repaired).toBe(0);
    expect(await loadOutreachState(sql, convo.prospectId)).toBe('NOT_NOW');
  });

  it('19 quater. une réponse non analysée bloque le recalcul plutôt que de le fausser', async () => {
    const convo = await conversation('analyse-manquante@acme-test.fr', ATELIER_LIKE);
    await processInOrder(convo, [0, 1]);

    const audit = await auditReplyOrdering(sql);
    expect(audit.counts.PENDING_ANALYSIS).toBe(1);
    expect(audit.counts.DIVERGENT).toBe(0);
    const report = await repairReplyOrdering(sql, { apply: true, actor: 'Operator Example' });
    expect(report.repaired).toBe(0);
  });

  it('20. le pipeline affiche la colonne de l’état réparé', async () => {
    const convo = await conversation('pipeline@acme-test.fr', ATELIER_LIKE);
    await processInOrder(convo, [0, 1, 2]);
    await forceState(convo.prospectId, 'REVIEW_REQUIRED');
    expect(
      resolveLane({
        stage: 'approved',
        outreachState: 'REVIEW_REQUIRED',
        sentCount: 1,
        hasLockedManifest: true,
        isClient: false,
        doNotContact: false,
      }),
    ).toBe('REVIEW_REQUIRED');

    await repairReplyOrdering(sql, { apply: true, actor: 'Operator Example' });
    const state = await loadOutreachState(sql, convo.prospectId);
    expect(state).toBe('NOT_INTERESTED');
    expect(
      resolveLane({
        stage: 'approved',
        outreachState: state,
        sentCount: 1,
        hasLockedManifest: true,
        isClient: false,
        doNotContact: false,
      }),
    ).toBe('NOT_INTERESTED');
  });
});
