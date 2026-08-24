import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { createLogger } from '@/lib/logging/logger';
import { ModelRouter } from '@/lib/models/router';
import { LlmError, type LlmProvider } from '@/lib/models/types';
import { DispatchBlockedError, resolveDispatchTarget } from '@/lib/pipeline/r6bDispatcher';
import { loadPendingAlerts } from '@/lib/replies/alerts';
import { loadActiveAnalysis } from '@/lib/replies/analyses';
import { loadReplyContext } from '@/lib/replies/context';
import { checkReplyDraft, reviewDraft } from '@/lib/replies/draft';
import { buildCrmPayload, hashCrmPayload } from '@/lib/crm/payload';
import { resolveCrmDestination } from '@/lib/crm/resolve';
import type { CrmProvider, CrmResolution } from '@/lib/crm/types';
import { confirmedDestination } from './support/crmDestination';
import { makeReplyFixtures, type ReplyFixtures } from './support/replyFixture';
import { loadOutreachState } from '@/lib/replies/state';
import { processNewReplies, processReply } from '@/lib/replies/process';
import { loadReplyOverviews, loadReplySummary } from '@/lib/replies/queries';
import {
  CATEGORY_POLICY,
  MIN_ACTIONABLE_CONFIDENCE,
  allowsExternalWrite,
  classifyDeterministically,
  decideCategory,
  detectUnsubscribeDemand,
  resolveNextAction,
} from '@/lib/replies/taxonomy';
import type { Sql } from '@/lib/db/sql';
import { turnAnswer } from './support/turnAnswer';

/**
 * R6B-D2 — classification, machine à états, projection CRM, alertes,
 * brouillons, et non-régression outbound.
 *
 * Aucun test de ce fichier n'ouvre de connexion réseau : le modèle est toujours
 * un faux provider injecté dans le VRAI `ModelRouter`, donc le routage, la
 * validation de schéma et l'instrumentation `model_runs` sont réellement
 * exercés — seule la couche qui parlerait à Internet est remplacée.
 *
 * Les entreprises, adresses et textes sont fictifs. Rien du prospect réel
 * n'entre dans ce dépôt.
 */

const logger = createLogger({ test: 'r6b-replies' });
const MAILBOX = 'reponse@example.com';
const FIRST_TOUCH = 'Bonjour, j’ai vu que vous faisiez du prestation standard à domicile. Comment vos clients vous trouvent ?';

let sql: Sql;
let dir: string;
let campaignId: string;
let contactedProspect: ReplyFixtures['contactedProspect'];
let inbound: ReplyFixtures['inbound'];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-r6b-replies-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-commercial-replies-test', 'Test', 'example-services', '{}'],
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

// ---------------------------------------------------------------------------
// Faux modèle
// ---------------------------------------------------------------------------

interface Script {
  readonly classify?: unknown | (() => unknown);
  readonly draft?: unknown | (() => unknown);
}

function resolveScripted(value: unknown | (() => unknown)): unknown {
  return typeof value === 'function' ? (value as () => unknown)() : value;
}

/**
 * Le VRAI `ModelRouter`, avec un faux transport. Le routage vient toujours de
 * `config/models.json` : si la tâche `reply` ou `message` y disparaissait, ces
 * tests tomberaient — ce qui est exactement ce qu'on veut d'un test de routage.
 */
function makeRouter(script: Script): ModelRouter {
  const provider: LlmProvider = {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async (request) => {
      if (script.classify === undefined && script.draft === undefined) {
        throw new LlmError(`aucun script pour la tâche ${request.task}`, 'provider_error');
      }
      const classify = script.classify === undefined ? undefined : resolveScripted(script.classify);
      const draft = script.draft === undefined ? undefined : resolveScripted(script.draft);
      if (classify instanceof Error) throw classify;
      if (draft instanceof Error) throw draft;
      return {
        text: JSON.stringify(
          turnAnswer(classify as Record<string, unknown>, draft as Record<string, unknown>),
        ),
      };
    },
  };
  return new ModelRouter({ sql, logger, providers: { codex: provider } });
}

function classifyAs(category: string, confidence = 0.9, quote?: string): Record<string, unknown> {
  return {
    category,
    confidence,
    reasoning_summary: `réponse classée ${category} sur la base du texte reçu.`,
    evidence_excerpts: quote === undefined ? [] : [{ quote, why: 'passage décisif' }],
  };
}

const DRAFT_ANSWER = {
  body: 'Merci pour votre retour. Je vous propose un échange court quand cela vous arrange, dites-moi ce qui vous convient.',
  rationale: 'Réponse courte, sans chiffre ni promesse.',
  used_facts: [],
};

/** Aucun CRM configuré — l'état réel du dépôt. */
const NO_CRM: CrmResolution = {
  configured: false,
  kind: 'NOT_CONFIGURED',
  reason: 'aucune destination CRM configurée pour Hermes',
  missing: ['OUTBOUND_CRM_PROVIDER'],
};

/**
 * Un fournisseur factice branché sur une destination RÉELLEMENT confirmée en
 * base : la garde de configuration est donc franchie par le vrai chemin, et
 * seule la couche réseau est remplacée.
 */
async function fakeCrm(behaviour: { readonly fail?: boolean } = {}): Promise<{
  readonly resolution: CrmResolution;
  readonly calls: { count: number; lastContactId: string | null };
}> {
  const target = await confirmedDestination(sql);
  const calls = { count: 0, lastContactId: null as string | null };
  const provider: CrmProvider = {
    name: 'fake-crm',
    availability: () => ({ ok: true }),
    probe: async () => {
      throw new Error('probe n’a pas sa place dans ce test');
    },
    lookup: async () => null,
    upsert: async (request) => {
      calls.count += 1;
      calls.lastContactId = request.contact?.externalContactId ?? null;
      if (behaviour.fail === true) throw new Error('CRM injoignable');
      return {
        externalContactId: 'contact-1',
        externalOpportunityId: 'opp-1',
        externalStage: request.stage?.stageId ?? null,
        matchKind: request.contact?.matchKind ?? 'created',
        matchValue: request.contact?.matchValue ?? null,
        contactCreated: request.contact === null,
        opportunityCreated: request.contact?.externalOpportunityId == null,
        externalNoteId: request.note === null ? null : 'note-1',
        noteCreated: request.note !== null,
      };
    },
  };
  return { resolution: { configured: true, provider, target }, calls };
}

// ---------------------------------------------------------------------------
// Politique pure
// ---------------------------------------------------------------------------

describe('taxonomie — chemin déterministe', () => {
  it('lit une non-remise dans les en-têtes, sans modèle', () => {
    expect(classifyDeterministically(['delivery_status_report'])?.category).toBe('BOUNCE');
    expect(classifyDeterministically(['system_sender:mailer-daemon'])?.category).toBe('BOUNCE');
    expect(classifyDeterministically(['failed_recipients_header'])?.category).toBe('BOUNCE');
    expect(classifyDeterministically(['multipart_report', 'null_return_path'])?.category).toBe('BOUNCE');
  });

  it('ne conclut pas à une non-remise sur un multipart/report seul', () => {
    // Un `multipart/report` sert aussi aux accusés de lecture : seul, il ne
    // prouve rien, et conclure quand même ferait disparaître de vraies réponses.
    expect(classifyDeterministically(['multipart_report'])).toBeNull();
  });

  it('lit une réponse automatique dans les en-têtes', () => {
    expect(classifyDeterministically(['auto_submitted:auto-replied'])?.category).toBe('AUTO_REPLY');
    expect(classifyDeterministically(['auto_reply_header'])?.category).toBe('AUTO_REPLY');
  });

  it('fait primer la non-remise sur l’auto-réponse', () => {
    const verdict = classifyDeterministically(['auto_submitted:auto-generated', 'delivery_status_report']);
    expect(verdict?.category).toBe('BOUNCE');
  });

  it('ne conclut rien sur une vraie réponse humaine', () => {
    expect(classifyDeterministically([])).toBeNull();
    expect(classifyDeterministically(['list_unsubscribe'])).toBeNull();
  });
});

describe('taxonomie — demande d’arrêt', () => {
  it('reconnaît une demande d’arrêt explicite', () => {
    expect(detectUnsubscribeDemand('Arrêtez de me contacter s’il vous plaît.')).not.toBeNull();
    expect(detectUnsubscribeDemand('Merci de me désinscrire.')).not.toBeNull();
    expect(detectUnsubscribeDemand('Ne me contactez plus.')).not.toBeNull();
    expect(detectUnsubscribeDemand('Retirez-moi de votre liste.')).not.toBeNull();
  });

  it('ne se déclenche pas sur un refus commercial ordinaire', () => {
    expect(detectUnsubscribeDemand('Non merci, ça ne m’intéresse pas.')).toBeNull();
    expect(detectUnsubscribeDemand('Arrêtez, c’est trop beau pour être vrai.')).toBeNull();
    expect(detectUnsubscribeDemand('Stop au gaspillage, on est déjà équipés.')).toBeNull();
  });
});

describe('taxonomie — décision', () => {
  it('rabat une conclusion peu sûre vers REVIEW_REQUIRED, jamais vers une autre catégorie', () => {
    const decision = decideCategory({
      category: 'INTERESTED',
      confidence: MIN_ACTIONABLE_CONFIDENCE - 0.01,
      correlationStatus: 'EXACT',
      deterministic: false,
      unsubscribeDemand: null,
    });
    expect(decision.category).toBe('REVIEW_REQUIRED');
    expect(decision.requiresHumanReview).toBe(true);
  });

  it('fait monter vers UNSUBSCRIBE quand le corps le demande, quelle que soit l’étiquette', () => {
    const decision = decideCategory({
      category: 'NOT_INTERESTED',
      confidence: 0.95,
      correlationStatus: 'EXACT',
      deterministic: false,
      unsubscribeDemand: { reason: 'demande d’arrêt', excerpt: 'arrêtez de me contacter' },
    });
    expect(decision.category).toBe('UNSUBSCRIBE');
    expect(resolveNextAction(decision)).toBe('SUPPRESS_PERMANENTLY');
  });

  it('met en revue une conclusion commerciale sous corrélation faible', () => {
    const decision = decideCategory({
      category: 'INTERESTED',
      confidence: 0.95,
      correlationStatus: 'HIGH_CONFIDENCE',
      deterministic: false,
      unsubscribeDemand: null,
    });
    expect(decision.requiresHumanReview).toBe(true);
    expect(allowsExternalWrite('HIGH_CONFIDENCE')).toBe(false);
    expect(allowsExternalWrite('EXACT')).toBe(true);
  });

  it('n’attend pas de confirmation humaine pour une conclusion protectrice', () => {
    // L'asymétrie : arrêter de contacter quelqu'un sous preuve faible ne coûte
    // rien à ce quelqu'un. Le faire attendre, si.
    for (const category of ['UNSUBSCRIBE', 'BOUNCE', 'NOT_INTERESTED'] as const) {
      const decision = decideCategory({
        category,
        confidence: 0.9,
        correlationStatus: 'HIGH_CONFIDENCE',
        deterministic: category === 'BOUNCE',
        unsubscribeDemand: null,
      });
      expect(decision.category).toBe(category);
      expect(decision.requiresHumanReview).toBe(false);
      expect(resolveNextAction(decision)).toBe(CATEGORY_POLICY[category].action);
    }
  });

  it('ne gèle pas une séquence sur une réponse automatique', () => {
    // Un « je suis en vacances » est un fait d'agenda, pas un désintérêt :
    // le traiter comme une réponse sortirait de la file tous les absents.
    expect(CATEGORY_POLICY.AUTO_REPLY.freezesNoReplySequence).toBe(false);
    expect(CATEGORY_POLICY.AUTO_REPLY.nextState).toBeNull();
    // Toute vraie réponse humaine, elle, gèle la séquence.
    for (const category of ['INTERESTED', 'QUESTION', 'OBJECTION', 'NOT_NOW', 'NOT_INTERESTED', 'UNSUBSCRIBE', 'OTHER', 'REVIEW_REQUIRED'] as const) {
      expect(CATEGORY_POLICY[category].freezesNoReplySequence).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Matrice de classification (§15)
// ---------------------------------------------------------------------------

describe('classification de bout en bout', () => {
  it('réponse positive → INTERESTED, brouillon proposé, alerte urgente', async () => {
    const fixture = await contactedProspect('contact-a@example.com');
    const id = await inbound({ ...fixture, body: 'Oui, ça m’intéresse. On peut en discuter cette semaine ?' });

    const router = makeRouter({
      classify: classifyAs('INTERESTED', 0.92, 'ça m’intéresse'),
      draft: DRAFT_ANSWER,
    });
    const result = await processReply(sql, router, id, { crm: NO_CRM });

    expect(result.classification).toBe('INTERESTED');
    expect(result.stateTo).toBe('INTERESTED');
    expect(result.stateApplied).toBe(true);
    expect(result.draftId).not.toBeNull();
    expect(result.draftCreated).toBe(true);
    expect(result.alertId).not.toBeNull();

    const drafts = await sql.query<{ status: string; body: string }>(
      'select status, body from r6b_reply_drafts',
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.status).toBe('PROPOSED');
  });

  it('question → QUESTION, brouillon proposé', async () => {
    const fixture = await contactedProspect('contact-b@example.com');
    const id = await inbound({ ...fixture, body: 'Vous faites ça comment exactement ? Et c’est quoi vos tarifs ?' });

    const router = makeRouter({ classify: classifyAs('QUESTION', 0.88), draft: DRAFT_ANSWER });
    const result = await processReply(sql, router, id, { crm: NO_CRM });

    expect(result.classification).toBe('QUESTION');
    expect(result.stateTo).toBe('INTERESTED');
    expect(result.draftId).not.toBeNull();
  });

  it('objection tarifaire → OBJECTION, conversation ouverte et alerte', async () => {
    const fixture = await contactedProspect('contact-c@example.com');
    const id = await inbound({ ...fixture, body: 'Franchement c’est trop cher pour nous en ce moment.' });

    const router = makeRouter({ classify: classifyAs('OBJECTION', 0.85), draft: DRAFT_ANSWER });
    const result = await processReply(sql, router, id, { crm: NO_CRM });

    expect(result.classification).toBe('OBJECTION');
    expect(result.stateTo).toBe('INTERESTED');
    expect(result.alertId).not.toBeNull();
  });

  it('« pas maintenant » → NOT_NOW, aucun rappel planifié', async () => {
    const fixture = await contactedProspect('contact-d@example.com');
    const id = await inbound({ ...fixture, body: 'Pas maintenant, recontactez-moi en septembre.' });

    const router = makeRouter({ classify: classifyAs('NOT_NOW', 0.9), draft: DRAFT_ANSWER });
    const result = await processReply(sql, router, id, { crm: NO_CRM });

    expect(result.classification).toBe('NOT_NOW');
    expect(result.stateTo).toBe('NOT_NOW');
    expect(result.alertId).toBeNull();

    // §3 — candidat nurture, rien de planifié : aucune table de ce dépôt ne
    // porte d'échéance, et cette mission n'en crée pas.
    const tables = await sql.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and (table_name like '%schedule%' or table_name like '%nurture%')`,
    );
    expect(tables).toHaveLength(0);
  });

  it('« non merci » → NOT_INTERESTED, sans suppression d’adresse', async () => {
    const fixture = await contactedProspect('contact-e@example.com');
    const id = await inbound({ ...fixture, body: 'Non merci, ce n’est pas pour nous.' });

    const router = makeRouter({ classify: classifyAs('NOT_INTERESTED', 0.93) });
    const result = await processReply(sql, router, id, { crm: NO_CRM });

    expect(result.classification).toBe('NOT_INTERESTED');
    expect(result.stateTo).toBe('NOT_INTERESTED');
    expect(result.suppressed).toBe(false);
    expect(result.draftId).toBeNull();

    // Un refus commercial n'est pas une demande d'arrêt : rien n'entre dans la
    // liste d'exclusion, qui a une portée durable et un sens juridique.
    const dnc = await sql.query('select 1 from do_not_contact');
    expect(dnc).toHaveLength(0);
  });

  it('« arrêtez de me contacter » → UNSUBSCRIBE, suppression et état terminal', async () => {
    const fixture = await contactedProspect('contact-f@example.com');
    const id = await inbound({ ...fixture, body: 'Arrêtez de me contacter, merci.' });

    const router = makeRouter({ classify: classifyAs('UNSUBSCRIBE', 0.97, 'Arrêtez de me contacter') });
    const result = await processReply(sql, router, id, { crm: NO_CRM });

    expect(result.classification).toBe('UNSUBSCRIBE');
    expect(result.stateTo).toBe('SUPPRESSED');
    expect(result.suppressed).toBe(true);
    expect(result.draftId).toBeNull();

    const dnc = await sql.query<{ value: string; addedBy: string }>(
      'select value, added_by as "addedBy" from do_not_contact',
    );
    expect(dnc).toHaveLength(1);
    expect(dnc[0]!.value).toBe('contact-f@example.com');
    expect(dnc[0]!.addedBy).toBe('r6b-d2');
  });

  it('réponse d’absence → AUTO_REPLY sans appel de modèle et sans transition', async () => {
    const fixture = await contactedProspect('contact-g@example.com');
    const id = await inbound({
      ...fixture,
      body: 'Je suis absent jusqu’au 25 août. Je répondrai à mon retour.',
      automationSignals: ['auto_submitted:auto-replied'],
    });

    // Aucun script de classification : si le modèle était appelé, le faux
    // provider lèverait et le test échouerait.
    const router = makeRouter({});
    const result = await processReply(sql, router, id, { crm: NO_CRM });

    expect(result.classification).toBe('AUTO_REPLY');
    expect(result.stateTo).toBeNull();
    expect(result.draftId).toBeNull();
    expect(result.alertId).toBeNull();
    expect(result.crmStatus).toBeNull();

    // L'état reste CONTACTED : une auto-réponse n'est pas une réponse.
    expect(await loadOutreachState(sql, fixture.prospectId)).toBe('CONTACTED');

    const analysis = await loadActiveAnalysis(sql, id);
    expect(analysis?.decidedDeterministically).toBe(true);
    expect(analysis?.model).toBe('deterministic');
  });

  it('mailer-daemon → BOUNCE, adresse marquée inutilisable', async () => {
    const fixture = await contactedProspect('contact-h@example.com');
    const id = await inbound({
      ...fixture,
      from: 'mailer-daemon@example.com',
      body: 'Delivery Status Notification (Failure)',
      automationSignals: ['delivery_status_report', 'system_sender:mailer-daemon'],
    });

    const router = makeRouter({});
    const result = await processReply(sql, router, id, { crm: NO_CRM });

    expect(result.classification).toBe('BOUNCE');
    expect(result.stateTo).toBe('BOUNCED');
    expect(result.suppressed).toBe(true);

    // Les deux adresses : celle qui a émis le rapport ET le destinataire figé
    // par le manifeste, qui est celle qui ne délivre pas.
    const dnc = await sql.query<{ value: string }>('select value from do_not_contact order by value');
    expect(dnc.map((row) => row.value)).toContain('contact-h@example.com');
  });

  it('texte ambigu → REVIEW_REQUIRED, aucune action commerciale', async () => {
    const fixture = await contactedProspect('contact-i@example.com');
    const id = await inbound({ ...fixture, body: 'ok' });

    const router = makeRouter({ classify: classifyAs('REVIEW_REQUIRED', 0.4) });
    const result = await processReply(sql, router, id, { crm: NO_CRM });

    expect(result.classification).toBe('REVIEW_REQUIRED');
    // HERMES-TARGETING-R1 §5 — l'état de repos d'un `REVIEW_REQUIRED` est
    // désormais `REPLIED`, et non plus l'état homonyme. Ce que le classifieur
    // n'arrive pas à trancher est l'INTENTION, pas le fait qu'on ait répondu :
    // « une réponse corrélée, intention non tranchée » est mot pour mot la
    // règle de la colonne `REPLIED`. `REVIEW_REQUIRED` reste atteignable par
    // `OTHER` — un message qui ne nous est pas destiné.
    //
    // Ce que ce test continue de garantir, et qui est son objet : AUCUNE action
    // commerciale ne découle d'un doute. Pas de brouillon, pas d'alerte, pas de
    // projection.
    expect(result.stateTo).toBe('REPLIED');
    expect(result.draftId).toBeNull();
    expect(result.alertId).toBeNull();
    expect(result.crmStatus).toBeNull();
  });

  it('une conclusion sous le seuil de confiance ne devient jamais une action', async () => {
    const fixture = await contactedProspect('contact-j@example.com');
    const id = await inbound({ ...fixture, body: 'peut-être, je ne sais pas trop' });

    const router = makeRouter({ classify: classifyAs('INTERESTED', 0.3), draft: DRAFT_ANSWER });
    const result = await processReply(sql, router, id, { crm: NO_CRM });

    expect(result.classification).toBe('REVIEW_REQUIRED');
    expect(result.draftId).toBeNull();
  });

  it('écarte un extrait de preuve absent du corps reçu', async () => {
    const fixture = await contactedProspect('contact-k@example.com');
    const id = await inbound({ ...fixture, body: 'Oui ça m’intéresse.' });

    const router = makeRouter({
      classify: classifyAs('INTERESTED', 0.9, 'nous avons un budget de 5000 € par mois'),
      draft: DRAFT_ANSWER,
    });
    await processReply(sql, router, id, { crm: NO_CRM });

    const rows = await sql.query<{ excerpts: unknown; summary: string }>(
      'select evidence_excerpts as excerpts, reasoning_summary as summary from r6b_reply_analyses',
    );
    expect(rows[0]!.excerpts).toEqual([]);
    expect(rows[0]!.summary).toContain('écarté');
  });
});

// ---------------------------------------------------------------------------
// Politique de corrélation (§14)
// ---------------------------------------------------------------------------

describe('politique de corrélation', () => {
  it('EXACT autorise le traitement complet', async () => {
    const fixture = await contactedProspect('contact-l@example.com');
    const id = await inbound({ ...fixture, body: 'Oui, intéressé.', correlationStatus: 'EXACT' });

    const crm = await fakeCrm();
    const router = makeRouter({ classify: classifyAs('INTERESTED', 0.9), draft: DRAFT_ANSWER });
    const result = await processReply(sql, router, id, { crm: crm.resolution });

    expect(result.crmStatus).toBe('APPLIED');
    expect(crm.calls.count).toBe(1);
  });

  it('HIGH_CONFIDENCE classe mais bloque toute écriture externe', async () => {
    const fixture = await contactedProspect('contact-m@example.com');
    const id = await inbound({ ...fixture, body: 'Oui, intéressé.', correlationStatus: 'HIGH_CONFIDENCE' });

    const crm = await fakeCrm();
    const router = makeRouter({ classify: classifyAs('INTERESTED', 0.95), draft: DRAFT_ANSWER });
    const result = await processReply(sql, router, id, { crm: crm.resolution });

    expect(result.classification).toBe('INTERESTED');
    expect(result.crmStatus).toBe('BLOCKED_POLICY');
    expect(crm.calls.count).toBe(0);

    const analysis = await loadActiveAnalysis(sql, id);
    expect(analysis?.requiresHumanReview).toBe(true);
  });

  it('HIGH_CONFIDENCE laisse quand même agir une suppression', async () => {
    const fixture = await contactedProspect('contact-n@example.com');
    const id = await inbound({
      ...fixture,
      body: 'Ne me contactez plus.',
      correlationStatus: 'HIGH_CONFIDENCE',
    });

    const router = makeRouter({ classify: classifyAs('UNSUBSCRIBE', 0.96) });
    const result = await processReply(sql, router, id, { crm: NO_CRM });

    expect(result.stateTo).toBe('SUPPRESSED');
    expect(result.suppressed).toBe(true);
  });

  it('REVIEW_REQUIRED et UNMATCHED ne sont jamais chargés ni classés', async () => {
    const fixture = await contactedProspect('contact-o@example.com');
    const review = await inbound({ ...fixture, body: 'bonjour', correlationStatus: 'REVIEW_REQUIRED' });
    const unmatched = await inbound({ ...fixture, body: 'bonjour', correlationStatus: 'UNMATCHED' });

    expect(await loadReplyContext(sql, review)).toBeNull();
    expect(await loadReplyContext(sql, unmatched)).toBeNull();

    const crm = await fakeCrm();
    const router = makeRouter({ classify: classifyAs('INTERESTED', 0.9), draft: DRAFT_ANSWER });
    const report = await processNewReplies(sql, router, { crm: crm.resolution });

    expect(report.candidates).toBe(0);
    expect(report.classified).toBe(0);
    expect(crm.calls.count).toBe(0);
    expect(await sql.query('select 1 from r6b_reply_analyses')).toHaveLength(0);
    expect(await sql.query('select 1 from r6b_crm_projections')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotence et échecs
// ---------------------------------------------------------------------------

describe('idempotence', () => {
  it('deux fois le même message → une analyse, un brouillon, une transition, une alerte', async () => {
    const fixture = await contactedProspect('contact-p@example.com');
    const id = await inbound({ ...fixture, body: 'Oui, ça m’intéresse.' });

    const crm = await fakeCrm();
    const router = makeRouter({ classify: classifyAs('INTERESTED', 0.9), draft: DRAFT_ANSWER });

    const first = await processReply(sql, router, id, { crm: crm.resolution });
    const second = await processReply(sql, router, id, { crm: crm.resolution });

    expect(first.analysisCreated).toBe(true);
    expect(second.analysisCreated).toBe(false);
    expect(second.draftCreated).toBe(false);
    expect(second.alertCreated).toBe(false);

    expect(await sql.query('select 1 from r6b_reply_analyses')).toHaveLength(1);
    expect(await sql.query('select 1 from r6b_reply_drafts')).toHaveLength(1);
    expect(await sql.query('select 1 from r6b_alerts')).toHaveLength(1);
    expect(await sql.query('select 1 from r6b_crm_projections')).toHaveLength(1);

    // Une seule transition PAR MARCHE, plus l'amorce `CONTACTED`.
    //
    // HERMES-TARGETING-R1 §5 ajoute la marche `REPLIED` : le fait qu'un humain
    // ait écrit est inscrit avant ce que sa réponse veut dire. Ce que ce test
    // garantit reste le même — rejouer le traitement n'ajoute RIEN — et il le
    // garantit sur trois lignes au lieu de deux.
    //
    // L'ensemble plutôt que la liste ordonnée : les deux marches d'un même
    // passage partagent le `now()` de leur transaction, et leur ordre relatif
    // n'est donc pas observable par `created_at`. Ce qui compte ici est le
    // NOMBRE, et il est exact.
    const transitions = await sql.query<{ toState: string }>(
      'select to_state as "toState" from r6b_prospect_state_transitions',
    );
    expect(transitions).toHaveLength(3);
    expect(new Set(transitions.map((row) => row.toState))).toEqual(
      new Set(['CONTACTED', 'REPLIED', 'INTERESTED']),
    );
  });

  it('la deuxième exécution ne rappelle pas le modèle', async () => {
    const fixture = await contactedProspect('contact-q@example.com');
    const id = await inbound({ ...fixture, body: 'Oui, ça m’intéresse.' });

    // HERMES-SEMANTIC-GROUNDING-R1 — on compte les APPELS, pas les lectures.
    //
    // Un tour coûte désormais un appel unique qui lit ET écrit, plus au plus
    // une réécriture bornée. Compter les lectures ne dirait donc plus ce que ce
    // test veut savoir : « la seconde exécution rappelle-t-elle le modèle ? ».
    // On mesure la réponse à cette question directement.
    let calls = 0;
    const router = makeRouter({
      classify: () => {
        calls += 1;
        return classifyAs('INTERESTED', 0.9);
      },
      draft: DRAFT_ANSWER,
    });

    await processReply(sql, router, id, { crm: NO_CRM });
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);
    await processReply(sql, router, id, { crm: NO_CRM });
    expect(calls).toBe(afterFirst);
  });

  it('un prospect supprimé ne peut pas revenir dans un état actif', async () => {
    const fixture = await contactedProspect('contact-r@example.com');
    // HERMES-MULTI-TURN-BURSTS-R1 — DEUX tours, et non deux bulles d'une même
    // phrase. Ce que ce test veut savoir est « un second tour peut-il ranimer
    // un prospect supprimé ? » ; deux messages écrits à la même seconde sont
    // désormais lus comme UNE prise de parole, ce qui poserait une autre
    // question. Une heure les sépare, donc deux salves.
    const stop = await inbound({
      ...fixture,
      body: 'Arrêtez de me contacter.',
      receivedAt: '2026-08-13T09:00:00Z',
    });
    const later = await inbound({
      ...fixture,
      body: 'Finalement je suis intéressé.',
      receivedAt: '2026-08-13T10:00:00Z',
    });

    const router = makeRouter({
      classify: () => classifyAs('UNSUBSCRIBE', 0.97, 'Arrêtez de me contacter'),
      draft: DRAFT_ANSWER,
    });
    await processReply(sql, router, stop, { crm: NO_CRM });

    const router2 = makeRouter({ classify: classifyAs('INTERESTED', 0.95), draft: DRAFT_ANSWER });
    const result = await processReply(sql, router2, later, { crm: NO_CRM });

    expect(result.stateApplied).toBe(false);
    expect(await loadOutreachState(sql, fixture.prospectId)).toBe('SUPPRESSED');
  });
});

describe('échecs', () => {
  it('échec du classifieur → aucune analyse, aucune transition commerciale', async () => {
    const fixture = await contactedProspect('contact-s@example.com');
    await inbound({ ...fixture, body: 'Oui, ça m’intéresse.' });

    const router = makeRouter({ classify: () => new LlmError('provider mort', 'provider_error') });
    const report = await processNewReplies(sql, router, { crm: NO_CRM });

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.stage).toBe('classification');
    expect(report.classified).toBe(0);

    expect(await sql.query('select 1 from r6b_reply_analyses')).toHaveLength(0);
    expect(await sql.query('select 1 from r6b_reply_drafts')).toHaveLength(0);
    expect(await sql.query('select 1 from r6b_crm_projections')).toHaveLength(0);
    // L'amorce CONTACTED reste : elle décrit un envoi réel, pas une conclusion.
    expect(await loadOutreachState(sql, fixture.prospectId)).toBe('CONTACTED');
  });

  it('un TOUR raté n’écrit rien du tout — ni analyse, ni brouillon', async () => {
    // HERMES-SEMANTIC-GROUNDING-R1 — la lecture et la rédaction sortent du même
    // appel. Quand cet appel échoue, il n'y a rien à sauver : ni conclusion, ni
    // texte. C'est §15 appliqué au tour entier — « je n'ai pas réussi à
    // demander » laisse le message NON TRAITÉ, et la prochaine exécution
    // réessaie.
    const fixture = await contactedProspect('contact-t0@example.com');
    const id = await inbound({ ...fixture, body: 'Oui, ça m’intéresse.' });

    const broken = makeRouter({ classify: () => new LlmError('modèle indisponible', 'timeout') });
    await expect(processReply(sql, broken, id, { crm: NO_CRM })).rejects.toThrow();
    expect(await loadActiveAnalysis(sql, id)).toBeNull();
    expect(await sql.query('select 1 from r6b_reply_drafts')).toHaveLength(0);

    // La reprise écrit les deux, sans rien avoir laissé derrière elle.
    const router = makeRouter({ classify: classifyAs('INTERESTED', 0.9), draft: DRAFT_ANSWER });
    const resumed = await processReply(sql, router, id, { crm: NO_CRM });
    expect(resumed.classification).toBe('INTERESTED');
    expect(resumed.draftId).not.toBeNull();
  });

  it('échec de rédaction → l’analyse survit, aucun faux brouillon', async () => {
    // Le chemin qui reste après l'unification : une lecture DÉJÀ rendue est
    // réutilisée, et c'est la rédaction seule qui échoue. Il se produit quand
    // la consigne de rédaction a changé depuis — `loadDraftForAnalysisVersion`
    // ne trouve alors aucun texte sous la version du jour.
    const fixture = await contactedProspect('contact-t@example.com');
    const id = await inbound({ ...fixture, body: 'Oui, ça m’intéresse.' });

    const first = makeRouter({ classify: classifyAs('INTERESTED', 0.9), draft: DRAFT_ANSWER });
    await processReply(sql, first, id, { crm: NO_CRM });
    await sql.query('delete from r6b_reply_drafts');
    // L'alerte est idempotente par (analyse, genre) : sans ce prestation standard, celle
    // du premier passage masquerait celle qu'on veut lire.
    await sql.query('delete from r6b_alerts');

    const router = makeRouter({
      classify: classifyAs('INTERESTED', 0.9),
      draft: () => new LlmError('rédaction indisponible', 'timeout'),
    });
    const result = await processReply(sql, router, id, { crm: NO_CRM });

    expect(result.classification).toBe('INTERESTED');
    expect(result.analysisCreated).toBe(false);
    expect(result.draftId).toBeNull();
    expect(result.draftFailure).not.toBeNull();
    expect(await sql.query('select 1 from r6b_reply_drafts')).toHaveLength(0);
    expect(await loadActiveAnalysis(sql, id)).not.toBeNull();

    // L'alerte dit la vérité sur l'état de la réponse proposée. Le premier
    // passage en a laissé une, réussie ; c'est la présence de l'échec qui
    // compte, pas sa position dans la file.
    const alerts = await loadPendingAlerts(sql);
    expect(alerts.map((alert) => alert.body.proposedResponseStatus)).toContain('FAILED');

    // Reprise : le brouillon est rédigé sans reclasser.
    const retry = makeRouter({ draft: DRAFT_ANSWER });
    const resumed = await processReply(sql, retry, id, { crm: NO_CRM });
    expect(resumed.analysisCreated).toBe(false);
    expect(resumed.draftCreated).toBe(true);
    expect(await sql.query('select 1 from r6b_reply_analyses')).toHaveLength(1);
  });

  it('échec CRM → état retentable, sans reclasser ni dupliquer', async () => {
    const fixture = await contactedProspect('contact-u@example.com');
    const id = await inbound({ ...fixture, body: 'Oui, ça m’intéresse.' });

    const failing = await fakeCrm({ fail: true });
    const router = makeRouter({ classify: classifyAs('INTERESTED', 0.9), draft: DRAFT_ANSWER });
    const first = await processReply(sql, router, id, { crm: failing.resolution });

    expect(first.crmStatus).toBe('FAILED');
    const rows = await sql.query<{ status: string; attempts: number; lastError: string }>(
      'select status, attempts, last_error as "lastError" from r6b_crm_projections',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.lastError).toContain('CRM injoignable');

    // Reprise avec un CRM qui répond : même ligne, pas de seconde analyse.
    const working = await fakeCrm();
    const second = await processReply(sql, router, id, { crm: working.resolution });
    expect(second.analysisCreated).toBe(false);
    expect(second.crmStatus).toBe('APPLIED');
    expect(await sql.query('select 1 from r6b_crm_projections')).toHaveLength(1);
    expect(await sql.query('select 1 from r6b_reply_analyses')).toHaveLength(1);
  });

  it('aucun canal d’alerte → l’alerte est persistée et visible, jamais perdue', async () => {
    const fixture = await contactedProspect('contact-v@example.com');
    const id = await inbound({ ...fixture, body: 'Oui, ça m’intéresse.' });

    const router = makeRouter({ classify: classifyAs('INTERESTED', 0.9), draft: DRAFT_ANSWER });
    await processReply(sql, router, id, { crm: NO_CRM, alertProviderConfigured: false });

    const alerts = await loadPendingAlerts(sql);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.status).toBe('NO_PROVIDER');
    expect(alerts[0]!.body.replyPreview).toContain('intéresse');
    expect(alerts[0]!.body.originalMessage).toContain('prestation standard à domicile');
  });
});

// ---------------------------------------------------------------------------
// CRM
// ---------------------------------------------------------------------------

describe('projection CRM', () => {
  it('sans destination configurée, la charge utile est prête et l’état le dit', async () => {
    const fixture = await contactedProspect('contact-w@example.com');
    const id = await inbound({ ...fixture, body: 'Oui, ça m’intéresse.' });

    const router = makeRouter({ classify: classifyAs('INTERESTED', 0.9), draft: DRAFT_ANSWER });
    const result = await processReply(sql, router, id, { crm: NO_CRM });

    expect(result.crmStatus).toBe('LOCAL_ONLY');
    const rows = await sql.query<{ provider: string; payload: Record<string, unknown> }>(
      'select provider, payload from r6b_crm_projections',
    );
    expect(rows[0]!.provider).toBe('hermes_local');
    expect(rows[0]!.payload['source']).toBe('Hermes');
    expect(rows[0]!.payload['targetStage']).toBe('Intéressé');
    expect(rows[0]!.payload['contactName']).toBeNull();
  });

  it('un prospect ne devient jamais deux contacts', async () => {
    const fixture = await contactedProspect('contact-x@example.com');
    // Deux TOURS distincts — une heure d'écart. Écrits à la même seconde, ils
    // formeraient une seule prise de parole, et seul le dernier serait raisonné.
    const first = await inbound({
      ...fixture,
      body: 'Une question rapide sur vos prestations.',
      receivedAt: '2026-08-13T09:00:00Z',
    });
    const second = await inbound({
      ...fixture,
      body: 'Finalement oui, ça m’intéresse.',
      receivedAt: '2026-08-13T10:00:00Z',
    });

    const crm = await fakeCrm();
    const routerA = makeRouter({ classify: classifyAs('QUESTION', 0.9), draft: DRAFT_ANSWER });
    await processReply(sql, routerA, first, { crm: crm.resolution });

    const routerB = makeRouter({ classify: classifyAs('INTERESTED', 0.95), draft: DRAFT_ANSWER });
    await processReply(sql, routerB, second, { crm: crm.resolution });

    expect(await sql.query('select 1 from r6b_crm_projections')).toHaveLength(1);
    // Le second appel connaît l'identifiant rendu par le premier : c'est ce qui
    // en fait une mise à jour et non une création.
    expect(crm.calls.lastContactId).toBe('contact-1');
  });

  it('aucune destination n’est devinée par défaut', async () => {
    // La résolution réelle du dépôt, sans variable d'environnement : rien.
    const resolution = await resolveCrmDestination(sql);
    expect(resolution.configured).toBe(false);
    expect(resolution.configured === false && resolution.kind).toBe('NOT_CONFIGURED');
  });

  it('la charge utile n’invente jamais un nom d’interlocuteur', async () => {
    const fixture = await contactedProspect('contact-y@example.com');
    const id = await inbound({ ...fixture, body: 'Oui, ça m’intéresse.' });
    const context = await loadReplyContext(sql, id);
    expect(context).not.toBeNull();

    const router = makeRouter({ classify: classifyAs('INTERESTED', 0.9), draft: DRAFT_ANSWER });
    await processReply(sql, router, id, { crm: NO_CRM });
    const analysis = await loadActiveAnalysis(sql, id);

    const payload = buildCrmPayload(context!, analysis!, 'INTERESTED');
    expect(payload.contactName).toBeNull();
    expect(payload.source).toBe('Hermes');
    // L'empreinte est stable d'un calcul à l'autre.
    expect(hashCrmPayload(payload)).toBe(hashCrmPayload(buildCrmPayload(context!, analysis!, 'INTERESTED')));
  });
});

// ---------------------------------------------------------------------------
// Brouillons et frontière humaine
// ---------------------------------------------------------------------------

describe('brouillons', () => {
  it('les garde-fous du premier message s’appliquent à une réponse', async () => {
    const fixture = await contactedProspect('contact-z@example.com');
    const id = await inbound({ ...fixture, body: 'Combien ça coûte ?' });
    const context = (await loadReplyContext(sql, id))!;

    const invented = checkReplyDraft(
      'Nous garantissons un retour sur investissement de 300 % dès le premier mois.',
      context,
    );
    expect(invented.some((flag) => flag.blocking)).toBe(true);

    const scarcity = checkReplyDraft('Il ne reste que 2 places ce mois-ci, répondez vite.', context);
    expect(scarcity.some((flag) => flag.code === 'fake_urgency')).toBe(true);

    const link = checkReplyDraft('Voici mon agenda : https://cal.example.com/hermes — choisissez un créneau.', context);
    expect(link.some((flag) => flag.code === 'unconfigured_link')).toBe(true);

    const invoiced = checkReplyDraft('Le tarif serait de 4 900 € par mois.', context);
    expect(invoiced.some((flag) => flag.code === 'unapproved_metric')).toBe(true);

    // Un montant que le prospect a lui-même publié reste citable : il est observé.
    const grounded = checkReplyDraft('Vous parlez bien de vos formules à 50 € et 80 € ?', context);
    expect(grounded.filter((flag) => flag.blocking)).toEqual([]);
  });

  it('APPROVE enregistre une décision et n’envoie rien', async () => {
    const fixture = await contactedProspect('contact-aa@example.com');
    const id = await inbound({ ...fixture, body: 'Oui, ça m’intéresse.' });
    const router = makeRouter({ classify: classifyAs('INTERESTED', 0.9), draft: DRAFT_ANSWER });
    const result = await processReply(sql, router, id, { crm: NO_CRM });

    const approved = await reviewDraft(sql, {
      draftId: result.draftId!,
      decision: 'APPROVE',
      reviewedBy: 'operator',
    });
    expect(approved.status).toBe('APPROVED');

    // Le schéma refuse structurellement tout statut d'envoi.
    await expect(
      sql.query(`update r6b_reply_drafts set status = 'SENT' where id = $1`, [result.draftId]),
    ).rejects.toThrow();
  });

  it('EDIT conserve le texte de la machine à côté de celui de l’humain', async () => {
    const fixture = await contactedProspect('contact-ab@example.com');
    const id = await inbound({ ...fixture, body: 'Oui, ça m’intéresse.' });
    const router = makeRouter({ classify: classifyAs('INTERESTED', 0.9), draft: DRAFT_ANSWER });
    const result = await processReply(sql, router, id, { crm: NO_CRM });

    const edited = await reviewDraft(sql, {
      draftId: result.draftId!,
      decision: 'EDIT',
      reviewedBy: 'operator',
      text: 'Super, je vous appelle demain matin ?',
    });
    expect(edited.status).toBe('EDITED');
    expect(edited.humanText).toBe('Super, je vous appelle demain matin ?');
    expect(edited.body).toBe(DRAFT_ANSWER.body);
  });
});

// ---------------------------------------------------------------------------
// Non-régression outbound (§17)
// ---------------------------------------------------------------------------

describe('non-régression outbound', () => {
  it('un prospect supprimé ne peut plus être dispatché, même en DRY_RUN', async () => {
    const fixture = await contactedProspect('contact-ac@example.com');
    const id = await inbound({ ...fixture, body: 'Arrêtez de me contacter.' });

    const router = makeRouter({ classify: classifyAs('UNSUBSCRIBE', 0.97, 'Arrêtez de me contacter') });
    await processReply(sql, router, id, { crm: NO_CRM });

    await expect(resolveDispatchTarget(sql, fixture.manifest.id, 'DRY_RUN')).rejects.toThrow(DispatchBlockedError);
    await expect(resolveDispatchTarget(sql, fixture.manifest.id, 'DRY_RUN')).rejects.toMatchObject({
      code: 'RECIPIENT_SUPPRESSED',
    });

    // Le refus est journalisé, et il précède tout réseau.
    const attempts = await sql.query<{ errorCode: string; networkAttempted: boolean }>(
      `select error_code as "errorCode", network_attempted as "networkAttempted"
         from r6b_dispatch_attempts where status = 'BLOCKED'`,
    );
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((row) => row.networkAttempted === false)).toBe(true);
  });

  it('un prospect NOT_INTERESTED est également retiré de la file sortante', async () => {
    const fixture = await contactedProspect('contact-ad@example.com');
    const id = await inbound({ ...fixture, body: 'Non merci.' });

    const router = makeRouter({ classify: classifyAs('NOT_INTERESTED', 0.95) });
    await processReply(sql, router, id, { crm: NO_CRM });

    await expect(resolveDispatchTarget(sql, fixture.manifest.id, 'DRY_RUN')).rejects.toMatchObject({
      code: 'PROSPECT_STATE_BLOCKS_OUTBOUND',
    });
  });

  it('le traitement n’écrit jamais dans outreach_events ni dans le registre d’envoi', async () => {
    const fixture = await contactedProspect('contact-ae@example.com');
    const id = await inbound({ ...fixture, body: 'Oui, ça m’intéresse.' });

    const before = await sql.query<{ n: string }>('select count(*)::text as n from outreach_events');
    const crm = await fakeCrm();
    const router = makeRouter({ classify: classifyAs('INTERESTED', 0.9), draft: DRAFT_ANSWER });
    await processReply(sql, router, id, { crm: crm.resolution });
    const after = await sql.query<{ n: string }>('select count(*)::text as n from outreach_events');

    expect(after[0]!.n).toBe(before[0]!.n);
    expect(await sql.query('select 1 from r6b_live_send_attempts')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Vue opérateur
// ---------------------------------------------------------------------------

describe('vue opérateur', () => {
  it('rend la réponse, le message d’origine, le brouillon et les états', async () => {
    const fixture = await contactedProspect('contact-af@example.com');
    const id = await inbound({ ...fixture, body: 'Oui, ça m’intéresse beaucoup.' });

    const router = makeRouter({ classify: classifyAs('INTERESTED', 0.91), draft: DRAFT_ANSWER });
    await processReply(sql, router, id, { crm: NO_CRM });

    const rows = await loadReplyOverviews(sql);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.classification).toBe('INTERESTED');
    expect(row.bodyText).toContain('intéresse');
    expect(row.originalMessage).toBe(FIRST_TOUCH);
    expect(row.draftStatus).toBe('PROPOSED');
    expect(row.outreachState).toBe('INTERESTED');
    expect(row.crmStatus).toBe('LOCAL_ONLY');
    expect(row.alertStatus).toBe('NO_PROVIDER');

    const summary = await loadReplySummary(sql);
    expect(summary.correlatedInbound).toBe(1);
    expect(summary.analyzed).toBe(1);
    expect(summary.draftsProposed).toBe(1);
    expect(summary.alertsOpen).toBe(1);
  });

  it('affiche aussi une réponse dont la classification a échoué', async () => {
    const fixture = await contactedProspect('contact-ag@example.com');
    await inbound({ ...fixture, body: 'Oui, ça m’intéresse.' });

    const router = makeRouter({ classify: () => new LlmError('indisponible', 'unavailable') });
    await processNewReplies(sql, router, { crm: NO_CRM });

    const rows = await loadReplyOverviews(sql);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.classification).toBeNull();
    expect(rows[0]!.analysisId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Boîte de production vide (§16)
// ---------------------------------------------------------------------------

describe('aucun chemin d’envoi n’existe', () => {
  /**
   * La promesse « rien ne part » ne se vérifie pas en lisant des intentions :
   * elle se vérifie en constatant qu'aucun module de cette couche n'importe
   * quoi que ce soit qui sache parler à un provider d'envoi, et que le schéma
   * ne connaît aucun statut d'envoi. Un test de comportement ne pourrait
   * jamais prouver l'absence d'un chemin ; celui-ci le peut.
   */
  const FORBIDDEN_IMPORTS = [
    'r6bLiveEmail',
    'r6bLiveDispatch',
    'r6bTransportAdapters',
    'gmailProvider',
    'resend',
  ];

  it('aucun module de la couche réponse n’importe un chemin d’envoi', () => {
    const root = resolve(__dirname, '..', 'src', 'lib', 'replies');
    const files = readdirSync(root).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8');
      const imports = [...source.matchAll(/^import[\s\S]*?from\s+'([^']+)';/gm)].map((match) => match[1] ?? '');
      for (const forbidden of FORBIDDEN_IMPORTS) {
        const offending = imports.filter((specifier) => specifier.toLowerCase().includes(forbidden.toLowerCase()));
        expect(offending, `${file} importe ${forbidden}`).toEqual([]);
      }
    }
  });

  it('les deux CLI de cette mission n’importent aucun provider d’envoi', () => {
    for (const file of ['r6b-replies.ts', 'r6b-replies-process.ts']) {
      const source = readFileSync(resolve(__dirname, '..', 'src', 'cli', file), 'utf8');
      const imports = [...source.matchAll(/^import[\s\S]*?from\s+'([^']+)';/gm)].map((match) => match[1] ?? '');
      for (const forbidden of FORBIDDEN_IMPORTS) {
        expect(
          imports.filter((specifier) => specifier.toLowerCase().includes(forbidden.toLowerCase())),
          `${file} importe ${forbidden}`,
        ).toEqual([]);
      }
      expect(source).not.toContain('OUTBOUND_ALLOW_SENDING');
    }
  });

  it('le schéma des brouillons ne connaît aucun statut d’envoi', () => {
    const migration = readFileSync(
      resolve(__dirname, '..', 'db', 'migrations', '0026_r6b_reply_intelligence.sql'),
      'utf8',
    );
    const statusCheck = migration.match(/status\s+text not null default 'PROPOSED'\s*\n?\s*check \(status in \(([^)]*)\)\)/);
    expect(statusCheck).not.toBeNull();
    const values = statusCheck![1]!;
    for (const forbidden of ['SENT', 'SENDING', 'DELIVERED', 'QUEUED']) {
      expect(values).not.toContain(forbidden);
    }

    // Les commentaires sont retirés avant la vérification : la migration
    // EXPLIQUE pourquoi `reply_drafts` (0019) et sa colonne `sent_text` ne sont
    // pas réutilisées, et cette explication a sa place. Ce qui ne doit pas
    // exister, c'est la colonne.
    const declarations = migration
      .split('\n')
      .filter((row) => !row.trimStart().startsWith('--'))
      .join('\n');
    expect(declarations).not.toContain('sent_text');
  });
});

describe('boîte vide', () => {
  it('sans réponse, le traitement ne fait rien et le dit', async () => {
    const router = makeRouter({});
    const report = await processNewReplies(sql, router, { crm: NO_CRM });

    expect(report.candidates).toBe(0);
    expect(report.processed).toHaveLength(0);
    expect(report.classified).toBe(0);
    expect(report.drafted).toBe(0);
    expect(report.crmWrites).toBe(0);
    expect(report.alertsRaised).toBe(0);
    expect(report.failures).toHaveLength(0);
  });
});
