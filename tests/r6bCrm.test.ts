import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { createLogger } from '@/lib/logging/logger';
import { HttpClient } from '@/lib/http/client';
import { ModelRouter } from '@/lib/models/router';
import { LlmError, type LlmProvider } from '@/lib/models/types';
import { applyCrmProjection, CrmProjectionRefusal } from '@/lib/crm/apply';
import { GhlApi, GhlCrmProvider, GHL_OPPORTUNITY_STATUS, GHL_TAG } from '@/lib/crm/ghl';
import { buildCrmNote } from '@/lib/crm/note';
import {
  buildCrmPayload,
  CRM_STAGE_LABELS,
  normalizeCrmEmail,
  normalizeCrmPhone,
} from '@/lib/crm/payload';
import { resolveCrmDestination, type CrmAdapterFactory } from '@/lib/crm/resolve';
import { loadContactLink, loadStageMap } from '@/lib/crm/store';
import { syncCrmProjections } from '@/lib/crm/sync';
import {
  CrmPermanentError,
  type CrmProvider,
  type CrmTarget,
  type CrmUpsertOutcome,
  type CrmUpsertRequest,
} from '@/lib/crm/types';
import { proposeFieldMap, proposeStageMapping, verifyCrmDestination } from '@/lib/crm/verify';
import { loadActiveAnalysis } from '@/lib/replies/analyses';
import { loadReplyContext } from '@/lib/replies/context';
import { projectToCrm } from '@/lib/replies/crm';
import { processReply } from '@/lib/replies/process';
import type { Sql } from '@/lib/db/sql';
import { confirmedDestination } from './support/crmDestination';
import { makeReplyFixtures, type ReplyFixtures } from './support/replyFixture';
import { turnAnswer } from './support/turnAnswer';

/**
 * R6B-D2.1 — configuration CRM, identité de contact, idempotence, refus.
 *
 * Aucun test de ce fichier n'ouvre de connexion réseau. Deux niveaux de faux,
 * et la différence compte :
 *
 *   * un faux `GhlApi` (le TRANSPORT) : le vrai `GhlCrmProvider` tourne, donc
 *     la vraie logique de création/mise à jour, d'opportunité et de note est
 *     exercée ;
 *   * un faux `CrmProvider` complet : pour les tests d'orchestration, où ce
 *     qu'on vérifie est la décision de `applyCrmProjection`, pas la forme des
 *     appels HTTP.
 *
 * Les entreprises, adresses, identifiants et jetons sont fictifs.
 */

const logger = createLogger({ test: 'r6b-crm' });
const MAILBOX = 'reponse@example.com';
const FIRST_TOUCH = 'Bonjour, j’ai vu que vous faisiez du prestation standard à domicile. Comment vos clients vous trouvent ?';

let sql: Sql;
let dir: string;
let campaignId: string;
let contactedProspect: ReplyFixtures['contactedProspect'];
let inbound: ReplyFixtures['inbound'];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-r6b-crm-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-crm-test', 'Test', 'example-services', '{}'],
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
  await sql.query('delete from r6b_crm_notes');
  await sql.query('delete from r6b_crm_contact_links');
  await sql.query('delete from r6b_crm_projections');
  await sql.query('delete from r6b_prospect_state_transitions');
  await sql.query('delete from r6b_prospect_outreach_states');
  await sql.query('delete from r6b_reply_analyses');
  await sql.query('delete from r6b_inbound_messages');
  await sql.query('delete from do_not_contact');
  await sql.query('delete from outreach_events');
  await sql.query('delete from r6b_dispatch_manifests');
  await sql.query('delete from r6b_batch_votes');
  await sql.query('delete from r6b_batch_items');
  await sql.query('delete from r6b_batches');
  await sql.query('delete from prospect_angles');
  await sql.query('delete from prospect_research');
  await sql.query('delete from prospect_evidence');
  await sql.query('delete from prospects');
  await sql.query('delete from r6b_crm_stage_map');
  await sql.query('delete from r6b_crm_pipeline_stages');
  await sql.query('delete from r6b_crm_destinations');
});

const CRM_ENV = ['OUTBOUND_CRM_PROVIDER', 'OUTBOUND_CRM_LOCATION_ID', 'OUTBOUND_CRM_API_KEY'] as const;

afterEach(() => {
  for (const key of CRM_ENV) delete process.env[key];
});

// ---------------------------------------------------------------------------
// Faux fournisseur d'orchestration
// ---------------------------------------------------------------------------

interface FakeCalls {
  lookups: { email: string | null; phone: string | null }[];
  upserts: CrmUpsertRequest[];
}

interface FakeOptions {
  /** Contact rendu par la recherche d'identité forte. */
  readonly found?: string | null;
  readonly failWith?: Error;
  readonly contactId?: string;
  readonly opportunityId?: string | null;
}

function fakeProvider(options: FakeOptions = {}): { provider: CrmProvider; calls: FakeCalls } {
  const calls: FakeCalls = { lookups: [], upserts: [] };
  const provider: CrmProvider = {
    name: 'fake-crm',
    availability: () => ({ ok: true }),
    probe: async () => {
      throw new Error('probe hors sujet ici');
    },
    lookup: async (_location, by) => {
      calls.lookups.push({ email: by.email, phone: by.phone });
      const found = options.found ?? null;
      return found === null
        ? null
        : { externalContactId: found, matchKind: 'email' as const, matchValue: by.email };
    },
    upsert: async (request): Promise<CrmUpsertOutcome> => {
      calls.upserts.push(request);
      if (options.failWith !== undefined) throw options.failWith;
      const contactId = request.contact?.externalContactId ?? options.contactId ?? 'contact-new';
      const opportunityId =
        request.contact?.externalOpportunityId ?? options.opportunityId ?? 'opp-new';
      return {
        externalContactId: contactId,
        externalOpportunityId: opportunityId,
        externalStage: request.stage?.stageId ?? null,
        matchKind: request.contact?.matchKind ?? 'created',
        matchValue: request.contact?.matchValue ?? null,
        contactCreated: request.contact === null,
        opportunityCreated: request.contact?.externalOpportunityId == null,
        externalNoteId: request.note === null ? null : 'note-x',
        noteCreated: request.note !== null,
      };
    },
  };
  return { provider, calls };
}

// ---------------------------------------------------------------------------
// Faux modèle (identique à R6B-D2 : vrai routeur, faux transport)
// ---------------------------------------------------------------------------

function makeRouter(script: { classify?: unknown; draft?: unknown }): ModelRouter {
  const provider: LlmProvider = {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async (request) => {
      if (script.classify === undefined && script.draft === undefined) {
        throw new LlmError(`aucun script pour ${request.task}`, 'provider_error');
      }
      return { text: JSON.stringify(turnAnswer(script.classify, script.draft)) };
    },
  };
  return new ModelRouter({ sql, logger, providers: { codex: provider } });
}

function classifyAs(category: string, confidence = 0.9): Record<string, unknown> {
  return {
    category,
    confidence,
    reasoning_summary: `réponse classée ${category} sur la base du texte reçu.`,
    evidence_excerpts: [],
  };
}

const DRAFT_ANSWER = {
  body: 'Merci pour votre retour. Je vous propose un échange court quand cela vous arrange.',
  rationale: 'Réponse courte, sans chiffre ni promesse.',
  used_facts: [],
};

/** Un contexte + une analyse réels, prêts à être projetés. */
async function projectable(
  recipient: string,
  body: string,
  options: {
    readonly category?: string;
    readonly correlationStatus?: 'EXACT' | 'HIGH_CONFIDENCE';
    readonly displayName?: string;
    readonly phone?: string | null;
  } = {},
) {
  const fixture = await contactedProspect(recipient, {
    ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
    ...(options.phone === undefined ? {} : { phone: options.phone }),
  });
  const id = await inbound({
    ...fixture,
    body,
    ...(options.correlationStatus === undefined ? {} : { correlationStatus: options.correlationStatus }),
  });
  const router = makeRouter({ classify: classifyAs(options.category ?? 'INTERESTED'), draft: DRAFT_ANSWER });
  await processReply(sql, router, id, {
    crm: { configured: false, kind: 'NOT_CONFIGURED', reason: 'test', missing: [] },
  });
  const context = (await loadReplyContext(sql, id))!;
  const analysis = (await loadActiveAnalysis(sql, id))!;
  return { fixture, inboundMessageId: id, context, analysis };
}

// ---------------------------------------------------------------------------
// Identité de contact (§4)
// ---------------------------------------------------------------------------

describe('identité de contact', () => {
  it('crée le contact une seule fois, puis met à jour', async () => {
    const target = await confirmedDestination(sql);
    const { provider, calls } = fakeProvider({ contactId: 'contact-1' });
    const { context, analysis } = await projectable('ident-a@example.com', 'Oui, ça m’intéresse.');
    const payload = buildCrmPayload(context, analysis, 'INTERESTED');

    const first = await applyCrmProjection(sql, { provider, target, payload, note: null, analysisId: analysis.id });
    expect(first.outcome.contactCreated).toBe(true);
    expect(calls.upserts[0]!.contact).toBeNull();

    const second = await applyCrmProjection(sql, { provider, target, payload, note: null, analysisId: analysis.id });
    expect(second.outcome.contactCreated).toBe(false);
    expect(calls.upserts[1]!.contact?.externalContactId).toBe('contact-1');
    expect(calls.upserts[1]!.contact?.matchKind).toBe('link');

    // Une recherche d'identité n'a eu lieu qu'au premier passage : ensuite le
    // lien persisté répond, donc aucun doublon n'est possible.
    expect(calls.lookups).toHaveLength(1);
    expect(await sql.query('select 1 from r6b_crm_contact_links')).toHaveLength(1);
  });

  it('réutilise un contact trouvé par identité forte plutôt que d’en créer un', async () => {
    const target = await confirmedDestination(sql);
    const { provider, calls } = fakeProvider({ found: 'contact-preexistant' });
    const { context, analysis } = await projectable('ident-b@example.com', 'Oui, ça m’intéresse.');
    const payload = buildCrmPayload(context, analysis, 'INTERESTED');

    const result = await applyCrmProjection(sql, { provider, target, payload, note: null, analysisId: null });

    expect(result.outcome.contactCreated).toBe(false);
    expect(result.outcome.externalContactId).toBe('contact-preexistant');
    expect(calls.upserts[0]!.contact?.matchKind).toBe('email');
    expect(calls.lookups[0]!.email).toBe('ident-b@example.com');

    const link = await loadContactLink(sql, target.destination.id, payload.prospectId);
    expect(link?.externalContactId).toBe('contact-preexistant');
    expect(link?.matchKind).toBe('email');

    // Une seconde projection ne réécrit pas la provenance : « trouvé par
    // email » reste un fait daté, il ne devient pas « déjà lié ».
    await applyCrmProjection(sql, { provider, target, payload, note: null, analysisId: null });
    const after = await loadContactLink(sql, target.destination.id, payload.prospectId);
    expect(after?.matchKind).toBe('email');
    expect(after?.matchValue).toBe('ident-b@example.com');
  });

  it('ne fusionne jamais deux entreprises, et refuse AVANT d’écrire', async () => {
    const target = await confirmedDestination(sql);
    const first = await projectable('merge-a@example.com', 'Oui.', { displayName: 'DEMO PAPA' });
    const second = await projectable('merge-b@example.com', 'Oui.', { displayName: 'DEMO PAPA SERVICES' });

    // Le premier prospect prend le contact.
    const owner = fakeProvider({ contactId: 'contact-partage' });
    await applyCrmProjection(sql, {
      provider: owner.provider,
      target,
      payload: buildCrmPayload(first.context, first.analysis, 'INTERESTED'),
      note: null,
      analysisId: null,
    });

    // Le second a une adresse DIFFÉRENTE mais un fournisseur qui rendrait le
    // même contact : le nom seul ne doit jamais suffire à fusionner.
    const intruder = fakeProvider({ found: 'contact-partage' });
    await expect(
      applyCrmProjection(sql, {
        provider: intruder.provider,
        target,
        payload: buildCrmPayload(second.context, second.analysis, 'INTERESTED'),
        note: null,
        analysisId: null,
      }),
    ).rejects.toBeInstanceOf(CrmProjectionRefusal);

    // Aucune écriture n'a été tentée pour le second : le refus précède l'appel.
    expect(intruder.calls.upserts).toHaveLength(0);
    expect(await sql.query('select 1 from r6b_crm_contact_links')).toHaveLength(1);
  });

  it('des noms voisins avec des adresses distinctes restent deux contacts', async () => {
    const target = await confirmedDestination(sql);
    const a = await projectable('voisin-a@example.com', 'Oui.', { displayName: 'DEMO PAPA' });
    const b = await projectable('voisin-b@example.com', 'Oui.', { displayName: 'DEMO PAPA' });

    const first = fakeProvider({ contactId: 'contact-a' });
    await applyCrmProjection(sql, {
      provider: first.provider,
      target,
      payload: buildCrmPayload(a.context, a.analysis, 'INTERESTED'),
      note: null,
      analysisId: null,
    });
    const second = fakeProvider({ contactId: 'contact-b' });
    await applyCrmProjection(sql, {
      provider: second.provider,
      target,
      payload: buildCrmPayload(b.context, b.analysis, 'INTERESTED'),
      note: null,
      analysisId: null,
    });

    const links = await sql.query<{ externalContactId: string }>(
      'select external_contact_id as "externalContactId" from r6b_crm_contact_links order by created_at',
    );
    expect(links.map((row) => row.externalContactId)).toEqual(['contact-a', 'contact-b']);
  });

  it('sans email ni téléphone observés, refuse sans appeler le fournisseur', async () => {
    const target = await confirmedDestination(sql);
    const { provider, calls } = fakeProvider();
    const { context, analysis } = await projectable('vide@example.com', 'Oui.');
    const payload = {
      ...buildCrmPayload(context, analysis, 'INTERESTED'),
      email: null,
      phone: null,
    };

    await expect(
      applyCrmProjection(sql, { provider, target, payload, note: null, analysisId: null }),
    ).rejects.toBeInstanceOf(CrmProjectionRefusal);
    expect(calls.upserts).toHaveLength(0);
  });

  it('normalise les identifiants sans jamais les « corriger »', () => {
    expect(normalizeCrmEmail('  Contact@Example.COM ')).toBe('contact@example.com');
    // Ni les points ni le +suffixe ne sont retirés : deux adresses distinctes
    // peuvent appartenir à deux personnes.
    expect(normalizeCrmEmail('a.b+promo@example.com')).toBe('a.b+promo@example.com');
    expect(normalizeCrmEmail('pas-une-adresse')).toBeNull();

    expect(normalizeCrmPhone('+33 6 12 34 56 78')).toBe('+33612345678');
    expect(normalizeCrmPhone('06 12 34 56 78')).toBe('0612345678');
    // Aucun préfixe pays n'est ajouté, aucun fragment n'est recherché.
    expect(normalizeCrmPhone('12 34')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Opportunité et notes (§6, §8, §9)
// ---------------------------------------------------------------------------

describe('opportunité et notes', () => {
  it('une seule opportunité, quel que soit le nombre de passages', async () => {
    const target = await confirmedDestination(sql);
    const { provider, calls } = fakeProvider({ contactId: 'contact-1', opportunityId: 'opp-1' });
    const { context, analysis } = await projectable('opp-a@example.com', 'Oui, ça m’intéresse.');
    const payload = buildCrmPayload(context, analysis, 'INTERESTED');

    const first = await applyCrmProjection(sql, { provider, target, payload, note: null, analysisId: null });
    expect(first.outcome.opportunityCreated).toBe(true);

    const second = await applyCrmProjection(sql, { provider, target, payload, note: null, analysisId: null });
    expect(second.outcome.opportunityCreated).toBe(false);
    expect(calls.upserts[1]!.contact?.externalOpportunityId).toBe('opp-1');

    const links = await sql.query<{ opportunityId: string }>(
      'select external_opportunity_id as "opportunityId" from r6b_crm_contact_links',
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.opportunityId).toBe('opp-1');
  });

  it('la même réponse ne dépose jamais deux notes', async () => {
    const target = await confirmedDestination(sql);
    const { provider, calls } = fakeProvider({ contactId: 'contact-1' });
    const { context, analysis } = await projectable('note-a@example.com', 'Oui, ça m’intéresse.');
    const payload = buildCrmPayload(context, analysis, 'INTERESTED');
    const note = buildCrmNote({
      payload,
      firstTouchSentAt: context.firstTouch.sentAt,
      firstTouchSubject: context.firstTouch.subject,
      firstTouchBody: context.firstTouch.body,
      replyFrom: context.reply.fromAddress,
      replySubject: context.reply.subject,
      replyBody: context.reply.bodyText,
      reasoningSummary: analysis.reasoningSummary,
      recommendedNextAction: analysis.recommendedNextAction,
      proposedResponseStatus: 'PROPOSED',
    });

    const first = await applyCrmProjection(sql, { provider, target, payload, note, analysisId: analysis.id });
    expect(first.outcome.noteCreated).toBe(true);
    expect(first.noteSkipped).toBe(false);

    const second = await applyCrmProjection(sql, { provider, target, payload, note, analysisId: analysis.id });
    expect(second.outcome.noteCreated).toBe(false);
    expect(second.noteSkipped).toBe(true);
    // Le fournisseur n'a même pas reçu la note la seconde fois.
    expect(calls.upserts[1]!.note).toBeNull();
    expect(await sql.query('select 1 from r6b_crm_notes')).toHaveLength(1);
  });

  it('la note porte l’historique auditable, jamais le brouillon ni un raisonnement caché', async () => {
    const { context, analysis } = await projectable('note-b@example.com', 'Combien ça coûte ?', {
      category: 'QUESTION',
    });
    const payload = buildCrmPayload(context, analysis, 'INTERESTED');
    const note = buildCrmNote({
      payload,
      firstTouchSentAt: context.firstTouch.sentAt,
      firstTouchSubject: context.firstTouch.subject,
      firstTouchBody: context.firstTouch.body,
      replyFrom: context.reply.fromAddress,
      replySubject: context.reply.subject,
      replyBody: context.reply.bodyText,
      reasoningSummary: analysis.reasoningSummary,
      recommendedNextAction: analysis.recommendedNextAction,
      proposedResponseStatus: 'PROPOSED',
    });

    expect(note.body).toContain('QUESTION');
    expect(note.body).toContain('Combien ça coûte ?');
    expect(note.body).toContain('prestation standard à domicile');
    expect(note.body).toContain(analysis.reasoningSummary);
    expect(note.body).toContain('NON ENVOYÉE');
    // Le texte du brouillon n'y est pas : posé dans un CRM, il finirait
    // copié-collé, et ce dépôt n'a le droit de rien envoyer.
    expect(note.body).not.toContain(DRAFT_ANSWER.body);

    // Déterministe : mêmes entrées, même empreinte.
    const again = buildCrmNote({
      payload,
      firstTouchSentAt: context.firstTouch.sentAt,
      firstTouchSubject: context.firstTouch.subject,
      firstTouchBody: context.firstTouch.body,
      replyFrom: context.reply.fromAddress,
      replySubject: context.reply.subject,
      replyBody: context.reply.bodyText,
      reasoningSummary: analysis.reasoningSummary,
      recommendedNextAction: analysis.recommendedNextAction,
      proposedResponseStatus: 'PROPOSED',
    });
    expect(again.bodySha256).toBe(note.bodySha256);
  });
});

// ---------------------------------------------------------------------------
// Étapes et machine à états (§6)
// ---------------------------------------------------------------------------

describe('étapes de pipeline', () => {
  it('chaque état porte l’étape de sa correspondance persistée', async () => {
    const target = await confirmedDestination(sql);
    const { provider } = fakeProvider({ contactId: 'contact-1' });
    const { context, analysis } = await projectable('stage-a@example.com', 'Oui.');

    const interested = await applyCrmProjection(sql, {
      provider,
      target,
      payload: buildCrmPayload(context, analysis, 'INTERESTED'),
      note: null,
      analysisId: null,
    });
    expect(interested.stage.stageName).toBe('Intéressé');

    const refused = await applyCrmProjection(sql, {
      provider,
      target,
      payload: buildCrmPayload(context, analysis, 'NOT_INTERESTED'),
      note: null,
      analysisId: null,
    });
    expect(refused.stage.stageName).toBe('Non intéressé');
    expect(refused.outcome.externalStage).toBe(refused.stage.stageId);
  });

  it('REVIEW_REQUIRED ne déplace jamais rien, et la base refuse même de le cartographier', async () => {
    const target = await confirmedDestination(sql);
    const { provider, calls } = fakeProvider();
    const { context, analysis } = await projectable('stage-b@example.com', 'Bonjour.');

    await expect(
      applyCrmProjection(sql, {
        provider,
        target,
        payload: buildCrmPayload(context, analysis, 'REVIEW_REQUIRED'),
        note: null,
        analysisId: null,
      }),
    ).rejects.toMatchObject({ status: 'BLOCKED_POLICY' });
    expect(calls.upserts).toHaveLength(0);

    // La contrainte de 0027, pas seulement une règle applicative.
    await expect(
      sql.query(
        `insert into r6b_crm_stage_map (destination_id, outreach_state, stage_id)
         values ($1,'REVIEW_REQUIRED','stage-interesse')`,
        [target.destination.id],
      ),
    ).rejects.toThrow();

    expect(CRM_STAGE_LABELS.REVIEW_REQUIRED).toBeNull();
  });

  it('un état non cartographié bloque en configuration, sans rien écrire', async () => {
    const target = await confirmedDestination(sql, { unmappedStates: ['NOT_NOW'] });
    const { provider, calls } = fakeProvider();
    const { context, analysis } = await projectable('stage-c@example.com', 'Pas maintenant.');

    await expect(
      applyCrmProjection(sql, {
        provider,
        target,
        payload: buildCrmPayload(context, analysis, 'NOT_NOW'),
        note: null,
        analysisId: null,
      }),
    ).rejects.toMatchObject({ status: 'BLOCKED_CONFIG' });
    expect(calls.upserts).toHaveLength(0);
  });

  it('une suppression se propage jusqu’au fournisseur', async () => {
    const target = await confirmedDestination(sql);
    const { provider, calls } = fakeProvider({ contactId: 'contact-1' });
    const { context, analysis } = await projectable('stop@example.com', 'Ne me contactez plus.', {
      category: 'UNSUBSCRIBE',
    });

    const result = await applyCrmProjection(sql, {
      provider,
      target,
      payload: buildCrmPayload(context, analysis, 'SUPPRESSED'),
      note: null,
      analysisId: null,
    });

    expect(calls.upserts[0]!.doNotContact).toBe(true);
    expect(result.stage.stageName).toBe('Perdu');
    expect(GHL_OPPORTUNITY_STATUS.SUPPRESSED).toBe('abandoned');

    // La suppression LOCALE, elle, a déjà eu lieu au traitement de la réponse.
    const dnc = await sql.query<{ value: string }>('select value from do_not_contact');
    expect(dnc.map((row) => row.value)).toContain('stop@example.com');
  });

  it('un état commercial vivant reste « open », un refus devient « lost »', () => {
    expect(GHL_OPPORTUNITY_STATUS.INTERESTED).toBe('open');
    expect(GHL_OPPORTUNITY_STATUS.NOT_NOW).toBe('open');
    expect(GHL_OPPORTUNITY_STATUS.NOT_INTERESTED).toBe('lost');
    // Une non-remise n'est pas un refus commercial.
    expect(GHL_OPPORTUNITY_STATUS.BOUNCED).toBe('abandoned');
    expect(GHL_OPPORTUNITY_STATUS.REVIEW_REQUIRED).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Politique de corrélation et configuration (§7, §8)
// ---------------------------------------------------------------------------

describe('gardes de projection', () => {
  it('EXACT projette, HIGH_CONFIDENCE bloque sans appeler le fournisseur', async () => {
    const target = await confirmedDestination(sql);

    const exact = await projectable('gate-a@example.com', 'Oui, ça m’intéresse.');
    const allowed = fakeProvider({ contactId: 'contact-1' });
    const applied = await projectToCrm(sql, {
      context: exact.context,
      analysis: exact.analysis,
      outreachState: 'INTERESTED',
      externalWriteAllowed: true,
      resolution: { configured: true, provider: allowed.provider, target },
    });
    expect(applied.status).toBe('APPLIED');
    expect(allowed.calls.upserts).toHaveLength(1);

    const weak = await projectable('gate-b@example.com', 'Oui, ça m’intéresse.', {
      correlationStatus: 'HIGH_CONFIDENCE',
    });
    const refused = fakeProvider();
    const blocked = await projectToCrm(sql, {
      context: weak.context,
      analysis: weak.analysis,
      outreachState: 'INTERESTED',
      externalWriteAllowed: false,
      resolution: { configured: true, provider: refused.provider, target },
    });
    expect(blocked.status).toBe('BLOCKED_POLICY');
    expect(refused.calls.upserts).toHaveLength(0);
    expect(refused.calls.lookups).toHaveLength(0);
  });

  it('une panne passagère devient un état retentable, un refus définitif ne l’est pas', async () => {
    const target = await confirmedDestination(sql);
    const { context, analysis } = await projectable('fail-a@example.com', 'Oui.');

    const flaky = fakeProvider({ failWith: new Error('CRM injoignable (502)') });
    const failed = await projectToCrm(sql, {
      context,
      analysis,
      outreachState: 'INTERESTED',
      externalWriteAllowed: true,
      resolution: { configured: true, provider: flaky.provider, target },
    });
    expect(failed.status).toBe('FAILED');
    expect(failed.projection.attempts).toBe(1);

    const rejected = fakeProvider({ failWith: new CrmPermanentError('401 — jeton refusé') });
    const permanent = await projectToCrm(sql, {
      context,
      analysis,
      outreachState: 'INTERESTED',
      externalWriteAllowed: true,
      resolution: { configured: true, provider: rejected.provider, target },
    });
    expect(permanent.status).toBe('FAILED_PERMANENT');

    // Toujours UNE ligne : un échec n'en crée pas une seconde.
    expect(await sql.query('select 1 from r6b_crm_projections')).toHaveLength(1);
  });

  it('configurer un CRM après coup fait ÉVOLUER la ligne, sans en créer une seconde', async () => {
    const target = await confirmedDestination(sql);
    const { context, analysis } = await projectable('upgrade@example.com', 'Oui.');

    // 1. Aucune destination externe : la ligne existe, au nom du CRM local,
    //    et dit que le dossier canonique est déjà tenu ici.
    const pending = await projectToCrm(sql, {
      context,
      analysis,
      outreachState: 'INTERESTED',
      externalWriteAllowed: true,
      resolution: { configured: false, kind: 'NOT_CONFIGURED', reason: 'test', missing: [] },
    });
    expect(pending.status).toBe('LOCAL_ONLY');

    // 2. La destination est confirmée : la MÊME ligne passe à APPLIED.
    const { provider } = fakeProvider({ contactId: 'contact-1' });
    const applied = await projectToCrm(sql, {
      context,
      analysis,
      outreachState: 'INTERESTED',
      externalWriteAllowed: true,
      resolution: { configured: true, provider, target },
    });
    expect(applied.status).toBe('APPLIED');
    expect(applied.projection.id).toBe(pending.projection.id);

    const rows = await sql.query<{ provider: string; status: string }>(
      'select provider, status from r6b_crm_projections',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('fake-crm');
    expect(rows[0]!.status).toBe('APPLIED');
  });

  it('après un échec, la reprise réutilise les entités déjà créées', async () => {
    const target = await confirmedDestination(sql);
    const first = await projectable('retry-a@example.com', 'Une question rapide.', { category: 'QUESTION' });

    const ok = fakeProvider({ contactId: 'contact-1', opportunityId: 'opp-1' });
    await projectToCrm(sql, {
      context: first.context,
      analysis: first.analysis,
      outreachState: 'INTERESTED',
      externalWriteAllowed: true,
      resolution: { configured: true, provider: ok.provider, target },
    });

    // Une seconde réponse du même prospect, d'abord en échec puis reprise.
    //
    // HERMES-MULTI-TURN-BURSTS-R1 — une heure plus tard, donc un TOUR distinct.
    // À horodatage égal, les deux messages formeraient une seule prise de
    // parole, et « le second » ne serait plus celui qui la clôt : l'ordre
    // serait décidé par l'identifiant, ce que ce test n'a jamais voulu dire.
    const second = await inbound({
      ...first.fixture,
      body: 'Finalement oui, allons-y.',
      receivedAt: '2026-08-13T10:00:00Z',
    });
    const router = makeRouter({ classify: classifyAs('INTERESTED', 0.95), draft: DRAFT_ANSWER });
    const flaky = fakeProvider({ failWith: new Error('502') });
    const failed = await processReply(sql, router, second, {
      crm: { configured: true, provider: flaky.provider, target },
    });
    expect(failed.crmStatus).toBe('FAILED');

    const resumed = fakeProvider();
    const retried = await processReply(sql, router, second, {
      crm: { configured: true, provider: resumed.provider, target },
    });
    expect(retried.crmStatus).toBe('APPLIED');
    expect(retried.analysisCreated).toBe(false);
    // Le lien persisté au premier passage a servi : ni second contact, ni
    // seconde opportunité.
    expect(resumed.calls.upserts[0]!.contact?.externalContactId).toBe('contact-1');
    expect(resumed.calls.upserts[0]!.contact?.externalOpportunityId).toBe('opp-1');
    expect(resumed.calls.lookups).toHaveLength(0);
    expect(await sql.query('select 1 from r6b_crm_contact_links')).toHaveLength(1);
    expect(await sql.query('select 1 from r6b_crm_projections')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Résolution de destination (§2, §14)
// ---------------------------------------------------------------------------

describe('résolution de destination', () => {
  const adapters: Readonly<Record<string, CrmAdapterFactory>> = {
    'fake-crm': () => ({ ok: true, provider: fakeProvider().provider }),
  };

  it('sans variable, rien n’est configuré et ce n’est pas une erreur', async () => {
    const resolution = await resolveCrmDestination(sql, { adapters });
    expect(resolution.configured).toBe(false);
    expect(resolution.configured === false && resolution.kind).toBe('NOT_CONFIGURED');
  });

  it('un fournisseur sans adapter est refusé, pas remplacé par un défaut', async () => {
    process.env['OUTBOUND_CRM_PROVIDER'] = 'un-crm-inconnu';
    process.env['OUTBOUND_CRM_LOCATION_ID'] = 'loc-hermes-test';
    const resolution = await resolveCrmDestination(sql, { adapters });
    expect(resolution.configured).toBe(false);
    expect(resolution.configured === false && resolution.kind).toBe('BLOCKED_CONFIG');
    expect(resolution.configured === false && resolution.reason).toContain('aucun adapter');
  });

  it('une variable sans confirmation en base n’autorise aucune écriture', async () => {
    process.env['OUTBOUND_CRM_PROVIDER'] = 'fake-crm';
    process.env['OUTBOUND_CRM_LOCATION_ID'] = 'loc-hermes-test';
    // Le sous-compte existe et a été OBSERVÉ, mais personne ne l'a confirmé.
    await sql.query(
      `insert into r6b_crm_destinations (provider, location_id, location_name, pipeline_id, status)
       values ('fake-crm','loc-hermes-test','Hermes (test)','pipe-1','UNCONFIRMED')`,
    );

    const resolution = await resolveCrmDestination(sql, { adapters });
    expect(resolution.configured).toBe(false);
    expect(resolution.configured === false && resolution.kind).toBe('BLOCKED_CONFIG');
    expect(resolution.configured === false && resolution.reason).toContain('confirmé');
  });

  it('un sous-compte qui ne correspond PAS à la confirmation est bloqué', async () => {
    await confirmedDestination(sql, { locationId: 'loc-hermes-test' });
    process.env['OUTBOUND_CRM_PROVIDER'] = 'fake-crm';
    // La variable pointe ailleurs — typiquement le sous-compte d'un autre projet.
    process.env['OUTBOUND_CRM_LOCATION_ID'] = 'loc-d-un-autre-projet';

    const resolution = await resolveCrmDestination(sql, { adapters });
    expect(resolution.configured).toBe(false);
    expect(resolution.configured === false && resolution.kind).toBe('BLOCKED_CONFIG');
    expect(resolution.configured === false && resolution.reason).toContain('loc-d-un-autre-projet');
    expect(resolution.configured === false && resolution.reason).toContain('refusée');
  });

  it('des identifiants manquants sont annoncés par NOM, jamais par valeur', async () => {
    process.env['OUTBOUND_CRM_PROVIDER'] = 'gohighlevel';
    process.env['OUTBOUND_CRM_LOCATION_ID'] = 'loc-x';
    const resolution = await resolveCrmDestination(sql);
    expect(resolution.configured).toBe(false);
    expect(resolution.configured === false && resolution.missing).toContain('OUTBOUND_CRM_API_KEY');
  });

  it('les deux faits concordants ouvrent la porte, et seulement eux', async () => {
    await confirmedDestination(sql, { locationId: 'loc-hermes-test' });
    process.env['OUTBOUND_CRM_PROVIDER'] = 'fake-crm';
    process.env['OUTBOUND_CRM_LOCATION_ID'] = 'loc-hermes-test';

    const resolution = await resolveCrmDestination(sql, { adapters });
    expect(resolution.configured).toBe(true);
    expect(resolution.configured === true && resolution.target.destination.status).toBe('CONFIRMED');
    expect(resolution.configured === true && resolution.target.destination.confirmedBy).toBe('test-operator');
  });

  it('une configuration refusée produit BLOCKED_CONFIG, pas une écriture', async () => {
    const { context, analysis } = await projectable('cfg-a@example.com', 'Oui.');
    const result = await projectToCrm(sql, {
      context,
      analysis,
      outreachState: 'INTERESTED',
      externalWriteAllowed: true,
      resolution: {
        configured: false,
        kind: 'BLOCKED_CONFIG',
        reason: 'sous-compte non confirmé',
        missing: [],
      },
    });
    expect(result.status).toBe('BLOCKED_CONFIG');
    expect(result.wrote).toBe(false);
    expect(result.projection.attempts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Vérification et correspondance d'étapes (§3)
// ---------------------------------------------------------------------------

describe('vérification de sous-compte', () => {
  function probingProvider(options: {
    readonly stages: readonly { id: string; name: string }[];
    readonly pipelines?: number;
    readonly customFields?: readonly { id: string; key: string; name: string }[];
  }): CrmProvider {
    const pipelines = Array.from({ length: options.pipelines ?? 1 }, (_value, index) => ({
      pipelineId: `pipe-${index}`,
      pipelineName: `Pipeline ${index}`,
      stages: options.stages.map((stage, position) => ({
        stageId: stage.id,
        stageName: stage.name,
        position,
      })),
    }));
    return {
      name: 'fake-crm',
      availability: () => ({ ok: true }),
      probe: async (locationId) => ({
        locationId,
        locationName: 'Hermes (test)',
        pipelines,
        customFields: options.customFields ?? [],
      }),
      lookup: async () => null,
      upsert: async () => {
        throw new Error('aucune écriture pendant une vérification');
      },
    };
  }

  const FULL_STAGES = [
    { id: 's1', name: 'Prospect qualifié' },
    { id: 's2', name: 'Contacté' },
    { id: 's3', name: 'Réponse reçue' },
    { id: 's4', name: 'Intéressé' },
    { id: 's5', name: 'À relancer' },
    { id: 's6', name: 'Pas maintenant' },
    { id: 's7', name: 'Non intéressé' },
    { id: 's8', name: 'Perdu' },
    { id: 's9', name: 'Client' },
  ];

  it('observer n’est pas confirmer', async () => {
    const result = await verifyCrmDestination(sql, probingProvider({ stages: FULL_STAGES }), 'loc-1');
    expect(result.confirmed).toBe(false);
    expect(result.destination.status).toBe('UNCONFIRMED');
    expect(result.blockers).toEqual([]);
    // Les identifiants d'étape sont conservés dès l'observation (§3).
    const stages = await sql.query('select 1 from r6b_crm_pipeline_stages');
    expect(stages).toHaveLength(FULL_STAGES.length);
    // Mais aucune correspondance n'est figée sans confirmation.
    expect(await sql.query('select 1 from r6b_crm_stage_map')).toHaveLength(0);
  });

  it('confirmer fige la correspondance par identifiant, jamais par nom', async () => {
    const result = await verifyCrmDestination(sql, probingProvider({ stages: FULL_STAGES }), 'loc-1', {
      confirmedBy: 'un opérateur',
    });
    expect(result.confirmed).toBe(true);
    expect(result.destination.status).toBe('CONFIRMED');

    const map = await loadStageMap(sql, result.destination.id);
    expect(map.INTERESTED?.stageId).toBe('s4');
    expect(map.NOT_INTERESTED?.stageId).toBe('s7');
    expect(map.SUPPRESSED?.stageId).toBe('s8');
    expect(Object.keys(map)).not.toContain('REVIEW_REQUIRED');
  });

  it('une étape manquante empêche la confirmation plutôt que d’être devinée', async () => {
    const partial = FULL_STAGES.filter((stage) => stage.name !== 'Non intéressé');
    const result = await verifyCrmDestination(sql, probingProvider({ stages: partial }), 'loc-1', {
      confirmedBy: 'un opérateur',
    });
    expect(result.confirmed).toBe(false);
    expect(result.blockers.join(' ')).toContain('Non intéressé');
    expect(result.destination.status).toBe('UNCONFIRMED');
  });

  it('plusieurs pipelines sans choix explicite ne sont pas départagés au hasard', async () => {
    const result = await verifyCrmDestination(sql, probingProvider({ stages: FULL_STAGES, pipelines: 3 }), 'loc-1');
    expect(result.pipeline).toBeNull();
    expect(result.blockers.join(' ')).toContain('--pipeline');
  });

  it('la correspondance de libellé est exacte, jamais approximative', () => {
    const stages = [
      { stageId: 'a', stageName: 'Intéressé', position: 0 },
      { stageId: 'b', stageName: 'INTERESSE', position: 1 },
      { stageId: 'c', stageName: 'Presque intéressé', position: 2 },
    ];
    const proposals = proposeStageMapping(stages);
    const interested = proposals.find((proposal) => proposal.state === 'INTERESTED');
    // « Intéressé » et « INTERESSE » se valent (casse et accents) ; « Presque
    // intéressé » ne se substitue jamais.
    expect(interested?.stage?.stageId).toBe('a');
    const refused = proposals.find((proposal) => proposal.state === 'NOT_INTERESTED');
    expect(refused?.stage).toBeNull();
  });

  it('un champ personnalisé absent n’est pas inventé', () => {
    const map = proposeFieldMap([
      { id: 'f1', key: 'contact.hermes_prospect_id', name: 'Prospect Hermes' },
      { id: 'f2', key: 'contact.autre_champ', name: 'Autre' },
    ]);
    expect(map.prospectId).toEqual({ id: 'f1', key: 'contact.hermes_prospect_id' });
    expect(map.researchSummary).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Reprise (§11)
// ---------------------------------------------------------------------------

describe('reprise des projections', () => {
  it('sans --apply, rien n’est appelé et rien ne change', async () => {
    const target = await confirmedDestination(sql);
    const { context, analysis } = await projectable('sync-a@example.com', 'Oui.');
    await projectToCrm(sql, {
      context,
      analysis,
      outreachState: 'INTERESTED',
      externalWriteAllowed: true,
      resolution: { configured: false, kind: 'NOT_CONFIGURED', reason: 'test', missing: [] },
    });

    const { provider, calls } = fakeProvider();
    const report = await syncCrmProjections(sql, { configured: true, provider, target });
    expect(report.apply).toBe(false);
    expect(report.candidates).toBe(1);
    expect(calls.upserts).toHaveLength(0);
    expect(report.outcomes[0]!.detail).toContain('Intéressé');

    const rows = await sql.query<{ status: string }>('select status from r6b_crm_projections');
    expect(rows[0]!.status).toBe('LOCAL_ONLY');
  });

  it('avec --apply, une projection en attente est appliquée sans reclasser', async () => {
    const target = await confirmedDestination(sql);
    const { context, analysis } = await projectable('sync-b@example.com', 'Oui.');
    await projectToCrm(sql, {
      context,
      analysis,
      outreachState: 'INTERESTED',
      externalWriteAllowed: true,
      resolution: { configured: false, kind: 'NOT_CONFIGURED', reason: 'test', missing: [] },
    });

    const { provider, calls } = fakeProvider({ contactId: 'contact-1' });
    const report = await syncCrmProjections(sql, { configured: true, provider, target }, { apply: true });
    expect(report.applied).toBe(1);
    expect(calls.upserts).toHaveLength(1);

    const rows = await sql.query<{ status: string; contactId: string }>(
      'select status, external_contact_id as "contactId" from r6b_crm_projections',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('APPLIED');
    expect(rows[0]!.contactId).toBe('contact-1');

    // Une seconde reprise ne trouve plus rien : APPLIED n'est pas retentable.
    const again = await syncCrmProjections(sql, { configured: true, provider, target }, { apply: true });
    expect(again.candidates).toBe(0);
  });

  it('une ligne bloquée par la politique n’est jamais reprise', async () => {
    const target = await confirmedDestination(sql);
    const { context, analysis } = await projectable('sync-c@example.com', 'Oui.', {
      correlationStatus: 'HIGH_CONFIDENCE',
    });
    const blocked = await projectToCrm(sql, {
      context,
      analysis,
      outreachState: 'INTERESTED',
      externalWriteAllowed: false,
      resolution: { configured: true, provider: fakeProvider().provider, target },
    });
    expect(blocked.status).toBe('BLOCKED_POLICY');

    const { provider, calls } = fakeProvider();
    const report = await syncCrmProjections(sql, { configured: true, provider, target }, { apply: true });
    expect(report.candidates).toBe(0);
    expect(calls.upserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// L'adapter GoHighLevel, avec un faux transport
// ---------------------------------------------------------------------------

describe('adapter GoHighLevel', () => {
  interface Recorded {
    readonly method: string;
    readonly path: string;
    readonly body: unknown;
  }

  function ghl(routes: Readonly<Record<string, { status: number; body: unknown }>>): {
    api: GhlApi;
    seen: Recorded[];
  } {
    const seen: Recorded[] = [];
    const http = new HttpClient({
      sql: null,
      minHostIntervalMs: 0,
      fetchImpl: async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : String(input));
        const method = (init?.method ?? 'GET').toUpperCase();
        const path = `${url.pathname}${url.search}`;
        const raw = typeof init?.body === 'string' ? init.body : null;
        seen.push({ method, path, body: raw === null ? null : JSON.parse(raw) });
        const route = routes[`${method} ${path}`] ?? routes[`${method} ${url.pathname}`];
        if (route === undefined) {
          return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
        }
        return new Response(JSON.stringify(route.body), {
          status: route.status,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    return { api: new GhlApi({ apiKey: 'jeton-de-test' }, { http, base: 'https://crm.test' }), seen };
  }

  it('vérifie le sous-compte par la lecture la plus étroite, puis le pipeline', async () => {
    const { api, seen } = ghl({
      'GET /locations/loc-1': { status: 200, body: { location: { id: 'loc-1', name: 'Hermes' } } },
      'GET /opportunities/pipelines': {
        status: 200,
        body: { pipelines: [{ id: 'p1', name: 'Outbound', stages: [{ id: 's1', name: 'Intéressé', position: 0 }] }] },
      },
      'GET /locations/loc-1/customFields': { status: 200, body: { customFields: [] } },
    });

    const probe = await new GhlCrmProvider(api).probe('loc-1');
    expect(probe.locationName).toBe('Hermes');
    expect(probe.pipelines[0]!.stages[0]!.stageId).toBe('s1');
    // La première requête est la plus étroite : le sous-compte lui-même.
    expect(seen[0]!.path).toBe('/locations/loc-1');
    expect(seen.every((call) => call.method === 'GET')).toBe(true);
  });

  it('cherche un doublon par email puis par téléphone, jamais par nom', async () => {
    const { api, seen } = ghl({
      'GET /contacts/search/duplicate?locationId=loc-1&email=a%40example.com': {
        status: 200,
        body: { contact: null },
      },
      'GET /contacts/search/duplicate?locationId=loc-1&number=%2B33612345678': {
        status: 200,
        body: { contact: { id: 'contact-tel' } },
      },
    });

    const match = await new GhlCrmProvider(api).lookup('loc-1', {
      email: 'a@example.com',
      phone: '+33612345678',
    });
    expect(match?.externalContactId).toBe('contact-tel');
    expect(match?.matchKind).toBe('phone');
    expect(seen).toHaveLength(2);
    expect(seen.every((call) => call.path.includes('email=') || call.path.includes('number='))).toBe(true);
  });

  it('crée contact, opportunité et note, avec l’étiquette et la source Hermes', async () => {
    const { api, seen } = ghl({
      'POST /contacts/': { status: 200, body: { contact: { id: 'contact-1' } } },
      'GET /opportunities/search': { status: 200, body: { opportunities: [] } },
      'POST /opportunities/': { status: 200, body: { opportunity: { id: 'opp-1' } } },
      'POST /contacts/contact-1/notes': { status: 200, body: { note: { id: 'note-1' } } },
    });

    const target = await confirmedDestination(sql, { provider: 'gohighlevel', locationId: 'loc-1' });
    const { context, analysis } = await projectable('ghl-a@example.com', 'Oui, ça m’intéresse.');
    const payload = buildCrmPayload(context, analysis, 'INTERESTED');
    const stage = target.stages.INTERESTED!;

    const outcome = await new GhlCrmProvider(api).upsert({
      payload,
      target,
      contact: null,
      stage,
      note: { body: 'historique', bodySha256: 'a'.repeat(64) },
      doNotContact: false,
    });

    expect(outcome.externalContactId).toBe('contact-1');
    expect(outcome.externalOpportunityId).toBe('opp-1');
    expect(outcome.contactCreated).toBe(true);
    expect(outcome.noteCreated).toBe(true);

    const created = seen.find((call) => call.path === '/contacts/')!;
    const body = created.body as Record<string, unknown>;
    expect(body['source']).toBe('Hermes');
    expect(body['tags']).toEqual([GHL_TAG]);
    expect(body['companyName']).toBe('ACME ATELIER');
    expect(body['dnd']).toBeUndefined();

    const opportunity = seen.find((call) => call.path === '/opportunities/')!.body as Record<string, unknown>;
    expect(opportunity['pipelineStageId']).toBe(stage.stageId);
    expect(opportunity['status']).toBe('open');
  });

  it('met à jour plutôt que de créer quand le contact est déjà tranché', async () => {
    const { api, seen } = ghl({
      'PUT /contacts/contact-1': { status: 200, body: { contact: { id: 'contact-1' } } },
      'PUT /opportunities/opp-1': { status: 200, body: { opportunity: { id: 'opp-1' } } },
    });

    const target = await confirmedDestination(sql, { provider: 'gohighlevel', locationId: 'loc-1' });
    const { context, analysis } = await projectable('ghl-b@example.com', 'Ne me contactez plus.', {
      category: 'UNSUBSCRIBE',
    });
    const payload = buildCrmPayload(context, analysis, 'SUPPRESSED');

    const outcome = await new GhlCrmProvider(api).upsert({
      payload,
      target,
      contact: {
        externalContactId: 'contact-1',
        externalOpportunityId: 'opp-1',
        matchKind: 'link',
        matchValue: null,
      },
      stage: target.stages.SUPPRESSED!,
      note: null,
      doNotContact: true,
    });

    expect(outcome.contactCreated).toBe(false);
    expect(outcome.opportunityCreated).toBe(false);
    expect(seen.some((call) => call.method === 'POST')).toBe(false);

    const update = seen.find((call) => call.path === '/contacts/contact-1')!.body as Record<string, unknown>;
    expect(update['dnd']).toBe(true);
    // L'API v2 refuse `locationId` sur une mise à jour de contact.
    expect(update['locationId']).toBeUndefined();

    const opportunity = seen.find((call) => call.path === '/opportunities/opp-1')!.body as Record<string, unknown>;
    expect(opportunity['status']).toBe('abandoned');
  });

  it('réutilise une opportunité créée à la main sur le même pipeline', async () => {
    const target = await confirmedDestination(sql, { provider: 'gohighlevel', locationId: 'loc-1' });
    const { api, seen } = ghl({
      'PUT /contacts/contact-1': { status: 200, body: { contact: { id: 'contact-1' } } },
      'GET /opportunities/search': {
        status: 200,
        body: { opportunities: [{ id: 'opp-manuelle', pipelineId: target.pipelineId, pipelineStageId: 'x' }] },
      },
      'PUT /opportunities/opp-manuelle': { status: 200, body: { opportunity: { id: 'opp-manuelle' } } },
    });

    const { context, analysis } = await projectable('ghl-c@example.com', 'Oui.');
    const outcome = await new GhlCrmProvider(api).upsert({
      payload: buildCrmPayload(context, analysis, 'INTERESTED'),
      target,
      contact: {
        externalContactId: 'contact-1',
        externalOpportunityId: null,
        matchKind: 'email',
        matchValue: 'ghl-c@example.com',
      },
      stage: target.stages.INTERESTED!,
      note: null,
      doNotContact: false,
    });

    expect(outcome.externalOpportunityId).toBe('opp-manuelle');
    expect(outcome.opportunityCreated).toBe(false);
    expect(seen.some((call) => call.path === '/opportunities/')).toBe(false);
  });

  it('classe un refus du fournisseur en définitif plutôt qu’en retentable', async () => {
    const { api } = ghl({
      'GET /locations/loc-1': { status: 401, body: { message: 'Invalid token' } },
    });
    await expect(new GhlCrmProvider(api).probe('loc-1')).rejects.toBeInstanceOf(CrmPermanentError);
  });

  it('n’écrit que des champs personnalisés réellement observés', async () => {
    const { api, seen } = ghl({ 'POST /contacts/': { status: 200, body: { contact: { id: 'c1' } } } });
    const base = await confirmedDestination(sql, { provider: 'gohighlevel', locationId: 'loc-1' });
    const target: CrmTarget = {
      ...base,
      destination: { ...base.destination, fieldMap: { prospectId: { id: 'f1', key: 'contact.hermes_prospect_id' } } },
    };
    const { context, analysis } = await projectable('ghl-d@example.com', 'Oui.');
    const payload = buildCrmPayload(context, analysis, 'INTERESTED');

    await new GhlCrmProvider(api).upsert({
      payload,
      target,
      contact: null,
      stage: null,
      note: null,
      doNotContact: false,
    });

    const body = seen[0]!.body as { customFields?: { id: string; value: string }[] };
    expect(body.customFields).toEqual([{ id: 'f1', value: payload.prospectId }]);
  });
});

// ---------------------------------------------------------------------------
// Non-régression outbound (§16)
// ---------------------------------------------------------------------------

describe('aucun envoi possible', () => {
  const CRM_DIR = resolve(__dirname, '../src/lib/crm');

  function crmSources(): { file: string; text: string }[] {
    return readdirSync(CRM_DIR)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => ({ file: name, text: readFileSync(join(CRM_DIR, name), 'utf8') }));
  }

  it('aucun chemin de messagerie n’existe dans la couche CRM', () => {
    // GoHighLevel envoie email, SMS et DM par `/conversations/messages`, avec
    // exactement les identifiants d'ici. Une méthode qui existe finit par être
    // appelée : la garantie est qu'aucune n'existe.
    const forbidden = [
      '/conversations',
      'conversations/messages',
      'sendMessage',
      'send_message',
      'emailTo',
      'smsTo',
      'api.resend.com',
    ];
    for (const source of crmSources()) {
      for (const needle of forbidden) {
        // Les fichiers ont le droit d'EXPLIQUER pourquoi ils ne le font pas ;
        // seules les lignes de code sont inspectées.
        const code = source.text
          .split('\n')
          .filter((row) => !row.trimStart().startsWith('*') && !row.trimStart().startsWith('//'))
          .join('\n');
        expect(code, `${source.file} ne doit pas contenir « ${needle} »`).not.toContain(needle);
      }
    }
  });

  it('la couche CRM n’importe aucun module d’envoi', () => {
    for (const source of crmSources()) {
      expect(source.text).not.toContain('r6bLiveEmail');
      expect(source.text).not.toContain('r6bLiveDispatch');
      expect(source.text).not.toContain('r6bDispatcher');
      expect(source.text).not.toContain('OUTBOUND_ALLOW_SENDING');
    }
  });

  it('l’unique envoi historique reste unique après toute projection', async () => {
    const target = await confirmedDestination(sql);
    const { provider } = fakeProvider({ contactId: 'contact-1' });
    const { context, analysis } = await projectable('final@example.com', 'Oui, ça m’intéresse.');

    await projectToCrm(sql, {
      context,
      analysis,
      outreachState: 'INTERESTED',
      externalWriteAllowed: true,
      resolution: { configured: true, provider, target },
    });

    const events = await sql.query<{ n: string }>(
      `select count(*)::text as n from outreach_events where kind = 'sent'`,
    );
    expect(events[0]!.n).toBe('1');
    // Aucun brouillon ne peut porter un statut d'envoi : le schéma le refuse.
    const drafts = await sql.query<{ id: string }>('select id from r6b_reply_drafts limit 1');
    if (drafts[0] !== undefined) {
      await expect(
        sql.query(`update r6b_reply_drafts set status = 'SENT' where id = $1`, [drafts[0].id]),
      ).rejects.toThrow();
    }
  });
});
