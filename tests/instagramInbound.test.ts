import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { createLogger } from '@/lib/logging/logger';
import { ModelRouter } from '@/lib/models/router';
import { LlmError, type LlmProvider } from '@/lib/models/types';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import { lockManifestForItem, type DispatchManifest } from '@/lib/pipeline/r6bDispatch';
import { DispatchBlockedError, resolveDispatchTarget } from '@/lib/pipeline/r6bDispatcher';
import { collectInstagramInbound, threadLedgerVerdict } from '@/lib/inbound/instagramCollector';
import { InstagramInboundError, openInboundPoll } from '@/lib/inbound/instagramIntake';
import { correlateInstagramInbound } from '@/lib/inbound/instagramCorrelation';
import { instagramMessageFingerprint } from '@/lib/instagram/inboundThread';
import { classifyAdjudicationRequest } from '@/lib/instagram/readOnlyGuard';
import { processReply } from '@/lib/replies/process';
import { createReplyProcessingStep } from '@/lib/inbound/instagramDownstream';
import { loadOutreachState } from '@/lib/replies/state';
import { loadActiveAnalysis } from '@/lib/replies/analyses';
import { loadCrmAlerts, loadCrmInbox, loadCrmInboxStatus, loadTimeline, loadCrmWorkspace } from '@/lib/crm/queries';
import { REPLY_DRAFT_PROMPT_VERSION_INSTAGRAM } from '@/lib/replies/draft';
import { conversationPromptVersionFor } from '@/lib/conversation/brain';
import { evaluateInstagramEligibility } from '@/lib/instagram/eligibility';
import type { CrmResolution } from '@/lib/crm/types';
import type { Sql } from '@/lib/db/sql';
import { makeProspectInstagramEligible } from './support/instagramEligibility';
import { FakeInstagramInboundRail, domMessage as message, makeThread, networkMessage } from './support/instagramInboundFixture';
import type { MessageDirection, ObservedThreadMessage } from '@/lib/instagram/inboundThread';
import { turnAnswer } from './support/turnAnswer';

/**
 * IG5.1 — le rail entrant de bout en bout, sur une vraie base.
 *
 * Aucun test de ce fichier n'ouvre de navigateur ni de connexion réseau : le
 * rail est simulé au niveau de son CONTRAT (des observations), et le modèle est
 * un faux provider injecté dans le VRAI `ModelRouter`. Tout le reste — schéma,
 * contraintes, index d'unicité, corrélation, machine à états, brouillon,
 * projections CRM — est le code de production.
 *
 * Les entreprises, comptes et textes sont fictifs.
 */

const logger = createLogger({ test: 'ig5-inbound' });
const ACCOUNT = 'hermes.test';
const HANDLE = 'atelier.test';
const OTHER_HANDLE = 'demo_account_19';
const FIRST_TOUCH = 'Bonjour, comment vos clients vous trouvent aujourd’hui ?';

let sql: Sql;
let dir: string;
let campaignId: string;

const NO_CRM: CrmResolution = {
  configured: false,
  kind: 'NOT_CONFIGURED',
  reason: 'aucune destination CRM configurée pour Hermes',
  missing: ['OUTBOUND_CRM_PROVIDER'],
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-ig5-inbound-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-ig5-inbound-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  // `cascade` plutôt qu'une liste ordonnée à la main : l'ordre des dépendances
  // change quand une migration en ajoute une, et une liste incomplète ferait
  // échouer le prestation standard — donc tous les tests suivants, pour une raison sans
  // rapport avec ce qu'ils vérifient. La campagne survit : rien ne la référence
  // depuis les tables tronquées.
  await sql.exec('truncate table prospects, r6b_batches, ig_inbound_polls, do_not_contact cascade');
});

// ---------------------------------------------------------------------------
// Fixtures — le manifeste passe par le vrai chemin humain (vote puis lock)
// ---------------------------------------------------------------------------

interface ContactedInstagramProspect {
  readonly manifest: DispatchManifest;
  readonly prospectId: string;
  readonly outreachEventId: string;
}

async function lockInstagramManifest(handle: string, text = FIRST_TOUCH): Promise<DispatchManifest> {
  const prospect = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, instagram_handle, website_url, score, score_band)
     values ($1,$2,'ATELIER TEST',$3,'https://example.com',74,'A') returning id`,
    [campaignId, `prospect-${handle}-${Math.random()}`, handle],
  );
  const prospectId = prospect[0]!.id;
  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,'instagram_handle',$2,'website','crawl','https://example.com',1.0)`,
    [prospectId, handle],
  );
  const batch = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
    [`batch-${Math.random()}`, campaignId],
  );
  const item = await sql.query<{ id: string }>(
    `insert into r6b_batch_items (batch_id, prospect_id, item_index, original_draft, contact_channels)
     values ($1,$2,1,'brouillon',$3) returning id`,
    [batch[0]!.id, prospectId, JSON.stringify(['instagram'])],
  );
  await castR6bVote(sql, { itemId: item[0]!.id, verdict: 'SEND', approvedText: text, note: null });
  await makeProspectInstagramEligible(sql, prospectId);
  return lockManifestForItem(sql, { itemId: item[0]!.id, transport: 'instagram_dm' });
}

/** Un prospect réellement contacté sur Instagram : manifeste verrouillé + outreach_event. */
async function contacted(handle = HANDLE, text = FIRST_TOUCH): Promise<ContactedInstagramProspect> {
  const manifest = await lockInstagramManifest(handle, text);
  const event = await sql.query<{ id: string }>(
    `insert into outreach_events (prospect_id, kind, channel, payload, manifest_id, occurred_at)
     values ($1,'sent','instagram_dm','{}'::jsonb,$2,'2026-08-14T09:00:00Z') returning id`,
    [manifest.prospectId, manifest.id],
  );
  return { manifest, prospectId: manifest.prospectId, outreachEventId: event[0]!.id };
}

// ---------------------------------------------------------------------------
// Messages observés
// ---------------------------------------------------------------------------


async function poll(
  threads: readonly ReturnType<typeof makeThread>[],
  options: { maxThreads?: number; polledBy?: string } = {},
): Promise<Awaited<ReturnType<typeof collectInstagramInbound>>> {
  const rail = new FakeInstagramInboundRail([{ accountHandle: ACCOUNT, threads }]);
  return collectInstagramInbound(
    sql,
    { rail, logger },
    {
      accountHandle: ACCOUNT,
      polledBy: options.polledBy ?? 'test',
      maxThreads: options.maxThreads ?? 10,
      leaseMs: 300_000,
    },
  );
}

// ---------------------------------------------------------------------------
// Faux modèle — le VRAI routeur, un transport simulé
// ---------------------------------------------------------------------------

interface Script {
  readonly classify?: unknown;
  readonly draft?: unknown;
}

function makeRouter(script: Script): ModelRouter {
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

function classifyAs(category: string, confidence = 0.92): Record<string, unknown> {
  return {
    category,
    confidence,
    reasoning_summary: `réponse classée ${category} sur la base du texte reçu.`,
    evidence_excerpts: [],
  };
}

const DRAFT_ANSWER = {
  body: 'Merci pour votre retour, je vous propose un échange court quand cela vous arrange.',
  rationale: 'Réponse courte, sans chiffre ni promesse.',
  used_facts: [],
};

// ---------------------------------------------------------------------------
// 1. Déduplication et rejeu
// ---------------------------------------------------------------------------

describe('IG5.1 §14 — déduplication, rejeu, concurrence', () => {
  it('le même message relevé deux fois ne devient jamais deux réponses', async () => {
    await contacted();
    const thread = makeThread({
      threadId: '111',
      counterpartyHandle: HANDLE,
      messages: [message('Oui je suis intéressé', 'INCOMING')],
    });

    const first = await poll([thread]);
    const second = await poll([thread]);

    expect(first.ingested).toBe(1);
    expect(second.ingested).toBe(0);
    expect(second.alreadyKnown).toBe(1);

    const rows = await sql.query<{ n: string }>(
      `select count(*) as n from r6b_inbound_messages where provider = 'instagram'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('deux messages identiques du même expéditeur restent deux réponses', async () => {
    await contacted();
    const thread = makeThread({
      threadId: '111',
      counterpartyHandle: HANDLE,
      messages: [message('ok', 'INCOMING', 0), message('ok', 'INCOMING', 1)],
    });

    const report = await poll([thread]);
    expect(report.ingested).toBe(2);
  });

  it('le journal d’observation conserve chaque tour, la table des réponses non', async () => {
    await contacted();
    const thread = makeThread({
      threadId: '111',
      counterpartyHandle: HANDLE,
      messages: [message('Oui je suis intéressé', 'INCOMING')],
    });
    await poll([thread]);
    await poll([thread]);

    const observations = await sql.query<{ outcome: string; n: string }>(
      `select outcome, count(*)::text as n from ig_inbound_message_observations group by outcome order by outcome`,
    );
    expect(observations).toEqual([
      { outcome: 'ALREADY_KNOWN', n: '1' },
      { outcome: 'INGESTED', n: '1' },
    ]);
  });

  it('un second collecteur simultané est refusé par la base, pas par une convention', async () => {
    const pollId = await openInboundPoll(sql, { accountHandle: ACCOUNT, polledBy: 'a', leaseMs: 300_000 });
    expect(pollId).toBeTruthy();

    await expect(
      openInboundPoll(sql, { accountHandle: ACCOUNT, polledBy: 'b', leaseMs: 300_000 }),
    ).rejects.toMatchObject({ code: 'IG_INBOUND_POLL_RUNNING' });
  });

  it('un tour dont le bail a expiré est clos, et la relève reprend', async () => {
    await openInboundPoll(sql, { accountHandle: ACCOUNT, polledBy: 'crashé', leaseMs: 30_000 });
    await sql.query(`update ig_inbound_polls set lease_expires_at = now() - interval '1 hour'`);

    const report = await poll([]);
    expect(report.pollId).toBeTruthy();

    const statuses = await sql.query<{ status: string; n: string }>(
      `select status, count(*)::text as n from ig_inbound_polls group by status order by status`,
    );
    expect(statuses).toEqual([
      { status: 'COMPLETED', n: '1' },
      { status: 'FAILED', n: '1' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Ce qui n'est PAS une réponse
// ---------------------------------------------------------------------------

describe('IG5.1 §15 — un message sortant n’est jamais une réponse', () => {
  it('une bulle sortante est journalisée et n’entre pas dans les réponses', async () => {
    await contacted();
    const report = await poll([
      makeThread({
        threadId: '111',
        counterpartyHandle: HANDLE,
        messages: [message(FIRST_TOUCH, 'OUTGOING')],
      }),
    ]);

    expect(report.ingested).toBe(0);
    expect(report.outgoingSkipped).toBe(1);
    const rows = await sql.query<{ n: string }>(`select count(*) as n from r6b_inbound_messages`);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('une direction indécidable est consignée, jamais promue', async () => {
    await contacted();
    const report = await poll([
      makeThread({
        threadId: '111',
        counterpartyHandle: HANDLE,
        messages: [message('Aujourd’hui', 'UNKNOWN')],
      }),
    ]);

    expect(report.ingested).toBe(0);
    expect(report.unknownDirectionSkipped).toBe(1);
    const rows = await sql.query<{ outcome: string }>(
      `select outcome from ig_inbound_message_observations`,
    );
    expect(rows[0]?.outcome).toBe('SKIPPED_UNKNOWN_DIRECTION');
  });

  it('un expéditeur non identifié n’est pas deviné', async () => {
    await contacted();
    const report = await poll([
      makeThread({
        threadId: '111',
        counterpartyHandle: null,
        handles: [HANDLE, OTHER_HANDLE],
        messages: [message('salut', 'INCOMING')],
      }),
    ]);

    expect(report.ingested).toBe(0);
    expect(report.unidentifiedSenderSkipped).toBe(1);
  });

  it('un fil illisible ne produit ni réponse ni absence', async () => {
    await contacted();
    const report = await poll([
      makeThread({ threadId: '111', counterpartyHandle: null, outcome: 'UNREADABLE', messages: [] }),
    ]);

    expect(report.threadsUnreadable).toBe(1);
    expect(report.ingested).toBe(0);
    const rows = await sql.query<{ outcome: string; detail: string }>(
      `select outcome, detail from ig_inbound_thread_observations`,
    );
    expect(rows[0]?.outcome).toBe('UNREADABLE');
  });

  it('une ligne sans identifiant de fil n’est pas ouverte — aucune URL n’est fabriquée', async () => {
    const report = await poll([
      makeThread({ threadId: null, counterpartyHandle: null, outcome: 'NOT_OPENED', messages: [] }),
    ]);
    expect(report.threadsNotOpened).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Corrélation
// ---------------------------------------------------------------------------

describe('IG5.1 §7 — corrélation', () => {
  it('handle connu + un seul envoi antérieur → HIGH_CONFIDENCE, jamais EXACT', async () => {
    const target = await contacted();
    const report = await poll([
      makeThread({
        threadId: '111',
        counterpartyHandle: HANDLE,
        messages: [message('Oui je suis intéressé', 'INCOMING')],
      }),
    ]);

    expect(report.correlated[0]?.correlationStatus).toBe('HIGH_CONFIDENCE');
    expect(report.correlated[0]?.correlationMethod).toBe('instagram_sole_outbound_handle');
    expect(report.correlated[0]?.prospectId).toBe(target.prospectId);
  });

  it('le fil qui porte notre texte approuvé devient un identifiant fort → EXACT', async () => {
    const target = await contacted();
    const report = await poll([
      makeThread({
        threadId: '111',
        counterpartyHandle: HANDLE,
        messages: [message(FIRST_TOUCH, 'OUTGOING'), message('Oui je suis intéressé', 'INCOMING')],
      }),
    ]);

    expect(report.threadsBound).toBe(1);
    expect(report.correlated[0]?.correlationStatus).toBe('EXACT');
    expect(report.correlated[0]?.correlationMethod).toBe('instagram_thread_binding');
    expect(report.correlated[0]?.prospectId).toBe(target.prospectId);
  });

  it('handle connu mais AUCUN envoi Instagram → UNMATCHED, et rien n’est rattaché', async () => {
    // Le prospect existe, son handle est connu du dépôt — mais personne ne lui
    // a écrit sur Instagram. Ce n'est donc pas une réponse commerciale.
    await lockInstagramManifest(HANDLE);
    const report = await poll([
      makeThread({
        threadId: '111',
        counterpartyHandle: HANDLE,
        messages: [message('Bonjour, vous faites quoi ?', 'INCOMING')],
      }),
    ]);

    expect(report.correlated[0]?.correlationStatus).toBe('UNMATCHED');
    expect(report.correlated[0]?.prospectId).toBeNull();

    const row = await sql.query<{ correlationMethod: string | null; correlatedProspectId: string | null }>(
      `select correlation_method as "correlationMethod", correlated_prospect_id as "correlatedProspectId"
         from r6b_inbound_messages`,
    );
    expect(row[0]?.correlationMethod).toBeNull();
    expect(row[0]?.correlatedProspectId).toBeNull();
  });

  it('un compte inconnu ne pollue ni un prospect ni le CRM', async () => {
    const target = await contacted();
    await poll([
      makeThread({
        threadId: '222',
        counterpartyHandle: 'inconnu.total',
        messages: [message('Salut, tu vends des trucs ?', 'INCOMING')],
      }),
    ]);

    const timeline = await loadTimeline(sql, target.prospectId);
    expect(timeline.filter((entry) => entry.kind === 'inbound_reply')).toHaveLength(0);
  });

  it('deux envois vers le même handle → REVIEW_REQUIRED, aucun n’est choisi', () => {
    const facts = {
      accountHandle: ACCOUNT,
      threadId: '111',
      senderHandle: HANDLE,
      observedAt: new Date('2026-08-15T10:00:00Z'),
      occurrenceIndex: 0,
      directionBasis: 'geometry' as const,
      receivedAtBasis: 'observed_at' as const,
      rowAgeMs: null,
    };
    const sends = [
      {
        manifestId: 'm1',
        outreachEventId: 'e1',
        prospectId: 'p1',
        recipientHandle: HANDLE,
        sentAt: new Date('2026-08-01T10:00:00Z'),
      },
      {
        manifestId: 'm2',
        outreachEventId: 'e2',
        prospectId: 'p2',
        recipientHandle: HANDLE,
        sentAt: new Date('2026-08-05T10:00:00Z'),
      },
    ];

    const result = correlateInstagramInbound(facts, sends, []);
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(result.method).toBe('instagram_ambiguous_outbound_candidates');
    expect(result.prospectId).toBeNull();
  });

  it('un lien de fil qui désigne quelqu’un d’autre que l’expéditeur → REVIEW_REQUIRED', () => {
    const result = correlateInstagramInbound(
      {
        accountHandle: ACCOUNT,
        threadId: '111',
        senderHandle: OTHER_HANDLE,
        observedAt: new Date('2026-08-15T10:00:00Z'),
        occurrenceIndex: 0,
        directionBasis: 'geometry',
        receivedAtBasis: 'observed_at',
        rowAgeMs: null,
      },
      [],
      [
        {
          threadId: '111',
          manifestId: 'm1',
          outreachEventId: 'e1',
          prospectId: 'p1',
          counterpartyHandle: HANDLE,
        },
      ],
    );
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(result.method).toBe('instagram_binding_handle_mismatch');
  });

  it('la preuve conserve comment received_at a été obtenu', async () => {
    await contacted();
    await poll([
      makeThread({
        threadId: '111',
        counterpartyHandle: HANDLE,
        ageMs: 7_200_000,
        messages: [message('Oui je suis intéressé', 'INCOMING')],
      }),
    ]);

    const row = await sql.query<{ evidence: { observation: { receivedAtBasis: string } } }>(
      `select correlation_evidence as evidence from r6b_inbound_messages`,
    );
    expect(row[0]?.evidence.observation.receivedAtBasis).toBe('inbox_row_relative_age');
  });
});

// ---------------------------------------------------------------------------
// 4. Le schéma refuse ce qui serait faux
// ---------------------------------------------------------------------------

describe('IG5.1 §6 — le schéma nomme ce que les valeurs sont', () => {
  it('une réponse Instagram porte handle + empreinte observée, jamais un id fournisseur', async () => {
    await contacted();
    await poll([
      makeThread({
        threadId: '111',
        counterpartyHandle: HANDLE,
        messages: [message('Oui je suis intéressé', 'INCOMING')],
      }),
    ]);

    const row = await sql.query<{
      provider: string;
      counterpartyKind: string;
      messageIdentityKind: string;
      bodySource: string;
      subject: string | null;
      normalizedSubject: string;
      providerMessageId: string;
      fromAddress: string;
    }>(
      `select provider, counterparty_kind as "counterpartyKind",
              message_identity_kind as "messageIdentityKind", body_source as "bodySource",
              subject, normalized_subject as "normalizedSubject",
              provider_message_id as "providerMessageId", from_address as "fromAddress"
         from r6b_inbound_messages`,
    );
    expect(row[0]).toMatchObject({
      provider: 'instagram',
      counterpartyKind: 'instagram_handle',
      messageIdentityKind: 'observed_fingerprint',
      bodySource: 'instagram_dm_text',
      subject: null,
      normalizedSubject: '',
      fromAddress: HANDLE,
    });
    expect(row[0]?.providerMessageId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuse une ligne Instagram qui prétendrait à un identifiant fournisseur', async () => {
    await expect(
      sql.query(
        `insert into r6b_inbound_messages
           (provider, mailbox, provider_message_id, received_at, from_address,
            normalized_subject, body_text, body_sha256, body_source,
            correlation_status, counterparty_kind, message_identity_kind)
         values ('instagram',$1,'abc',now(),$2,'','x',$3,'instagram_dm_text',
                 'UNMATCHED','instagram_handle','provider_issued')`,
        [ACCOUNT, HANDLE, createHash('sha256').update('x').digest('hex')],
      ),
    ).rejects.toThrow();
  });

  it('refuse une ligne Instagram porteuse d’un objet', async () => {
    await expect(
      sql.query(
        `insert into r6b_inbound_messages
           (provider, mailbox, provider_message_id, received_at, from_address,
            subject, normalized_subject, body_text, body_sha256, body_source,
            correlation_status, counterparty_kind, message_identity_kind)
         values ('instagram',$1,$4,now(),$2,'Re: bonjour','re: bonjour','x',$3,'instagram_dm_text',
                 'UNMATCHED','instagram_handle','observed_fingerprint')`,
        [
          ACCOUNT,
          HANDLE,
          createHash('sha256').update('x').digest('hex'),
          instagramMessageFingerprint({
            accountHandle: ACCOUNT,
            threadId: '1',
            senderHandle: HANDLE,
            occurrenceIndex: 0,
            text: 'x',
          }),
        ],
      ),
    ).rejects.toThrow();
  });

  it('le rail e-mail garde exactement son vocabulaire', async () => {
    // Non-régression : la migration élargit sans relâcher. Une ligne Gmail qui
    // se déclarerait « handle » est refusée.
    await expect(
      sql.query(
        `insert into r6b_inbound_messages
           (provider, mailbox, provider_message_id, received_at, from_address,
            normalized_subject, body_text, body_sha256, body_source,
            correlation_status, counterparty_kind, message_identity_kind)
         values ('gmail','boite@exemple.fr','id-1',now(),'a@exemple.fr','','x',$1,'text/plain',
                 'UNMATCHED','instagram_handle','provider_issued')`,
        [createHash('sha256').update('x').digest('hex')],
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Classification, arrêt, brouillon, CRM
// ---------------------------------------------------------------------------

describe('IG5.1 §8/§9/§11/§12 — l’aval D2, réutilisé tel quel', () => {
  async function ingestReply(text: string): Promise<{ inboundId: string; target: ContactedInstagramProspect }> {
    const target = await contacted();
    const report = await poll([
      makeThread({
        threadId: '111',
        counterpartyHandle: HANDLE,
        messages: [message(FIRST_TOUCH, 'OUTGOING'), message(text, 'INCOMING')],
      }),
    ]);
    const entry = report.correlated[0];
    expect(entry?.correlationStatus).toBe('EXACT');
    return { inboundId: entry!.inboundMessageId, target };
  }

  it('classe une réponse Instagram avec le classifieur existant, sans nouvelle taxonomie', async () => {
    const { inboundId } = await ingestReply('Oui, ça m’intéresse, on peut en parler ?');
    const router = makeRouter({ classify: classifyAs('INTERESTED'), draft: DRAFT_ANSWER });

    const processed = await processReply(sql, router, inboundId, { crm: NO_CRM });

    expect(processed.classification).toBe('INTERESTED');
    expect(processed.stateTo).toBe('INTERESTED');
    const analysis = await loadActiveAnalysis(sql, inboundId);
    expect(analysis?.classification).toBe('INTERESTED');
  });

  it('rédige un brouillon PROPOSED, lié à la réponse, et jamais envoyé', async () => {
    const { inboundId, target } = await ingestReply('Oui, ça m’intéresse, on peut en parler ?');
    const router = makeRouter({ classify: classifyAs('INTERESTED'), draft: DRAFT_ANSWER });

    const processed = await processReply(sql, router, inboundId, { crm: NO_CRM });
    expect(processed.draftId).not.toBeNull();

    const draft = await sql.query<{
      status: string;
      inboundMessageId: string;
      manifestId: string;
      prospectId: string;
      promptVersion: string;
    }>(
      `select status, inbound_message_id as "inboundMessageId", manifest_id as "manifestId",
              prospect_id as "prospectId", prompt_version as "promptVersion"
         from r6b_reply_drafts`,
    );
    expect(draft[0]?.status).toBe('PROPOSED');
    expect(draft[0]?.inboundMessageId).toBe(inboundId);
    expect(draft[0]?.manifestId).toBe(target.manifest.id);
    expect(draft[0]?.prospectId).toBe(target.prospectId);
    // Le prompt du canal, pas celui de l'e-mail : deux textes différents ne
    // peuvent pas partager un numéro de version.
    //
    // HERMES-CONTACT-PURPOSE-R1 — et ce prompt est désormais celui du CERVEAU.
    // `processReply` appelait `generateReplyDraft`, qui ne voit ni le fil, ni
    // le registre observé, ni le budget de longueur du tour ; le rail autonome
    // lisait pourtant ce brouillon-là. Le rédacteur est unique depuis, et il
    // porte sa propre version — jamais celle de R6B-D2.
    expect(draft[0]?.promptVersion).toBe(conversationPromptVersionFor('instagram_dm'));
    expect(draft[0]?.promptVersion).not.toBe(REPLY_DRAFT_PROMPT_VERSION_INSTAGRAM);

    // Aucun statut d'envoi n'existe dans le schéma : la contrainte le refuse.
    await expect(sql.query(`update r6b_reply_drafts set status = 'SENT'`)).rejects.toThrow();
  });

  it('une réponse corrélée arrête les séquences sortantes concurrentes', async () => {
    const { inboundId, target } = await ingestReply('Non merci, ça ne m’intéresse pas.');
    const router = makeRouter({ classify: classifyAs('NOT_INTERESTED') });

    // Avant : le chemin d'envoi accepterait ce manifeste.
    await expect(resolveDispatchTarget(sql, target.manifest.id, 'DRY_RUN')).resolves.toBeTruthy();

    await processReply(sql, router, inboundId, { crm: NO_CRM });

    expect(await loadOutreachState(sql, target.prospectId)).toBe('NOT_INTERESTED');
    // Après : le MÊME chemin, celui qu'empruntent `instagram/worker.ts` et
    // `instagram/liveWorker.ts`, refuse.
    await expect(resolveDispatchTarget(sql, target.manifest.id, 'DRY_RUN')).rejects.toBeInstanceOf(
      DispatchBlockedError,
    );
  });

  it('l’arrêt est idempotent : rejouer ne double ni l’état ni le journal', async () => {
    const { inboundId, target } = await ingestReply('Non merci, ça ne m’intéresse pas.');
    const router = makeRouter({ classify: classifyAs('NOT_INTERESTED') });

    await processReply(sql, router, inboundId, { crm: NO_CRM });
    const second = await processReply(sql, router, inboundId, { crm: NO_CRM });

    expect(second.stateApplied).toBe(false);
    const transitions = await sql.query<{ n: string }>(
      `select count(*) as n from r6b_prospect_state_transitions where to_state = 'NOT_INTERESTED'`,
    );
    expect(Number(transitions[0]!.n)).toBe(1);
    expect(await loadOutreachState(sql, target.prospectId)).toBe('NOT_INTERESTED');
  });

  it('un opt-out en DM inscrit un HANDLE, et le gate Instagram le lit', async () => {
    const { inboundId, target } = await ingestReply('Ne me recontactez plus, merci.');
    const router = makeRouter({ classify: classifyAs('UNSUBSCRIBE', 0.95) });

    await processReply(sql, router, inboundId, { crm: NO_CRM });

    const rows = await sql.query<{ matchKind: string; value: string }>(
      `select match_kind as "matchKind", value from do_not_contact order by match_kind`,
    );
    // Un handle, sous le type qui le décrit — jamais sous « email ».
    expect(rows.every((row) => row.matchKind === 'instagram')).toBe(true);
    expect(rows.some((row) => row.value === HANDLE)).toBe(true);

    // Le gate refuse. Il refuse même AVANT d'arriver à la porte du handle,
    // parce que l'état commercial du prospect mord en premier — les deux
    // verrous existent, et le plus large gagne. Ce que ce test fixe, c'est
    // qu'aucun des deux ne laisse passer.
    const decision = await evaluateInstagramEligibility(sql, {
      manifestId: target.manifest.id,
      action: 'first_touch_dm',
    });
    expect(decision.verdict).not.toBe('ELIGIBLE');
    expect(decision.reasonCode).toBe('PROSPECT_STATE_BLOCKS_OUTBOUND');
  });

  it('une exclusion enregistrée comme handle suffit, à elle seule, à refuser un envoi', async () => {
    // La porte `opt_out` isolée : aucun état commercial, seulement la ligne
    // `do_not_contact` typée `instagram`. C'est elle que l'écriture d'IG5.1
    // produit, et c'est ce test qui prouve qu'elle est LUE.
    const target = await contacted();
    await sql.query(
      `insert into do_not_contact (match_kind, value, reason, added_by)
       values ('instagram',$1,'test IG5.1','ig5-test')`,
      [HANDLE],
    );

    const decision = await evaluateInstagramEligibility(sql, {
      manifestId: target.manifest.id,
      action: 'first_touch_dm',
    });
    expect(decision.verdict).toBe('INELIGIBLE');
    expect(decision.reasonCode).toBe('IG_HANDLE_SUPPRESSED');
    expect(decision.reason).toBe('opt_out');
  });

  it('une réponse non corrélée ne déclenche aucune action commerciale', async () => {
    await contacted();
    await poll([
      makeThread({
        threadId: '222',
        counterpartyHandle: 'inconnu.total',
        messages: [message('Salut', 'INCOMING')],
      }),
    ]);

    const analyses = await sql.query<{ n: string }>(`select count(*) as n from r6b_reply_analyses`);
    const states = await sql.query<{ n: string }>(`select count(*) as n from r6b_prospect_outreach_states`);
    expect(Number(analyses[0]!.n)).toBe(0);
    expect(Number(states[0]!.n)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Projections CRM
// ---------------------------------------------------------------------------

describe('IG5.1 §12 — ce que le CRM montre réellement', () => {
  it('l’Inbox affiche la réponse Instagram, avec son canal', async () => {
    const target = await contacted();
    await poll([
      makeThread({
        threadId: '111',
        counterpartyHandle: HANDLE,
        messages: [message(FIRST_TOUCH, 'OUTGOING'), message('Oui ça m’intéresse', 'INCOMING')],
      }),
    ]);

    const rows = await loadCrmInbox(50, sql);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe('instagram');
    expect(rows[0]?.counterpartyKind).toBe('instagram_handle');
    expect(rows[0]?.fromAddress).toBe(HANDLE);
    expect(rows[0]?.prospectId).toBe(target.prospectId);
    expect(rows[0]?.correlationStatus).toBe('EXACT');
  });

  it('le statut de l’Inbox distingue les deux rails', async () => {
    await contacted();
    await poll([
      makeThread({
        threadId: '111',
        counterpartyHandle: HANDLE,
        messages: [message('Oui ça m’intéresse', 'INCOMING')],
      }),
    ]);

    const status = await loadCrmInboxStatus(sql);
    expect(status.instagramAccount).toBe(ACCOUNT);
    expect(status.instagramLastPolledAt).not.toBeNull();
    expect(status.instagramReplies).toBe(1);
    // Gmail n'a jamais été relevé : la page doit pouvoir le dire.
    expect(status.mailbox).toBeNull();
  });

  it('la timeline du prospect porte le canal Instagram, plus « email » en dur', async () => {
    const target = await contacted();
    await poll([
      makeThread({
        threadId: '111',
        counterpartyHandle: HANDLE,
        messages: [message(FIRST_TOUCH, 'OUTGOING'), message('Oui ça m’intéresse', 'INCOMING')],
      }),
    ]);

    const timeline = await loadTimeline(sql, target.prospectId);
    const reply = timeline.find((entry) => entry.kind === 'inbound_reply');
    expect(reply?.channel).toBe('instagram_dm');
    expect(reply?.facts.some((fact) => fact.includes(`@${HANDLE}`))).toBe(true);
  });

  it('une alerte est levée pour une réponse intéressée, et le workspace la montre', async () => {
    const target = await contacted();
    const report = await poll([
      makeThread({
        threadId: '111',
        counterpartyHandle: HANDLE,
        messages: [message(FIRST_TOUCH, 'OUTGOING'), message('Oui ça m’intéresse', 'INCOMING')],
      }),
    ]);
    const router = makeRouter({ classify: classifyAs('INTERESTED'), draft: DRAFT_ANSWER });
    await processReply(sql, router, report.correlated[0]!.inboundMessageId, { crm: NO_CRM });

    const alerts = await loadCrmAlerts(50, sql);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe('URGENT');
    expect(alerts[0]?.prospectId).toBe(target.prospectId);

    const workspace = await loadCrmWorkspace(target.prospectId, sql);
    expect(workspace).not.toBeNull();
    expect(workspace?.prospect.lastReplyClassification).toBe('INTERESTED');
  });
});

// ---------------------------------------------------------------------------
// 7. La garde structurelle du collecteur
// ---------------------------------------------------------------------------

describe('IG5.1 §20 — le collecteur refuse un rail capable d’agir', () => {
  it('refuse de tourner si l’objet reçu expose une primitive d’envoi', async () => {
    const rail = new FakeInstagramInboundRail([{ accountHandle: ACCOUNT, threads: [] }]);
    // On lui GREFFE la méthode : c'est exactement le futur diff imprudent que
    // la garde doit attraper, et un contrat de type ne l'aurait pas vu.
    (rail as unknown as Record<string, unknown>).sendFirstTouchDm = () => undefined;

    await expect(
      collectInstagramInbound(
        sql,
        { rail, logger },
        { accountHandle: ACCOUNT, polledBy: 'test', maxThreads: 5, leaseMs: 300_000 },
      ),
    ).rejects.toBeInstanceOf(InstagramInboundError);

    // Et rien n'a été ouvert : le refus précède le tour.
    const polls = await sql.query<{ n: string }>(`select count(*) as n from ig_inbound_polls`);
    expect(Number(polls[0]!.n)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. IG5 R3 — les messages lus dans la réponse réseau du fil
// ---------------------------------------------------------------------------

/**
 * IG5 R3 — le rail entrant alimenté par `IGDThreadDetailQuery` plutôt que par
 * les bulles du DOM.
 *
 * Ce que ces tests exercent, c'est le COLLECTEUR : le rail est simulé au niveau
 * de son contrat, avec des messages qui portent ce que la réponse réseau porte
 * réellement — un identifiant natif, un expéditeur nommé, un horodatage à la
 * milliseconde. Tout l'aval est le code de production, sans un seul chemin
 * parallèle : c'est précisément ce qu'il s'agit de prouver.
 *
 * L'envoi de référence des fixtures est daté du 14 août 2026 à 09:00 UTC
 * (`contacted()`), et toutes les dates ci-dessous se lisent par rapport à lui.
 */
describe('IG5 R3 §7/§8 — une réponse se juge par rapport à NOTRE envoi', () => {
  const OUTREACH_AT = '2026-08-14T09:00:00.000Z';

  function ourDm(at = '2026-08-14T09:00:01.000Z'): ObservedThreadMessage {
    return networkMessage({
      text: FIRST_TOUCH,
      direction: 'OUTGOING',
      providerMessageId: 'mid.$SYNTH000000000000000000000000DM',
      senderHandle: ACCOUNT,
      sentAt: at,
    });
  }

  function theirMessage(at: string, id = 'mid.$SYNTH0000000000000000000000REP'): ObservedThreadMessage {
    return networkMessage({
      text: 'Oui, ça m’intéresse, on peut en parler ?',
      direction: 'INCOMING',
      providerMessageId: id,
      senderHandle: HANDLE,
      sentAt: at,
      occurrenceIndex: 0,
    });
  }

  function networkThread(messages: readonly ObservedThreadMessage[]): ReturnType<typeof makeThread> {
    return makeThread({ threadId: '111', counterpartyHandle: HANDLE, messages });
  }

  it('un message du prospect ANTÉRIEUR à notre DM n’est pas une réponse à ce DM', async () => {
    await contacted();
    // Une conversation vieille de sept mois, sans rapport avec la campagne.
    const report = await poll([
      networkThread([theirMessage('2026-01-09T14:22:00.000Z', 'mid.$SYNTH00000000000000000000VIEUX'), ourDm()]),
    ]);

    expect(report.preOutreachSkipped).toBe(1);
    expect(report.ingested).toBe(0);
    expect(report.correlated).toHaveLength(0);

    // Il est CONSIGNÉ — ni perdu, ni promu.
    const observed = await sql.query<{ outcome: string; source: string }>(
      `select outcome, source from ig_inbound_message_observations where direction = 'INCOMING'`,
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]?.outcome).toBe('SKIPPED_PRE_OUTREACH');
    expect(observed[0]?.source).toBe('thread_detail_network');

    // Et aucune ligne de réponse n'existe : rien ne descendra dans D2.
    const inbound = await sql.query<{ n: string }>(`select count(*) as n from r6b_inbound_messages`);
    expect(Number(inbound[0]!.n)).toBe(0);
  });

  it('un message du prospect POSTÉRIEUR à notre DM est une réponse, et elle est corrélée', async () => {
    const target = await contacted();
    const report = await poll([networkThread([ourDm(), theirMessage('2026-08-15T10:30:00.000Z')])]);

    expect(report.preOutreachSkipped).toBe(0);
    expect(report.ingested).toBe(1);
    const entry = report.correlated[0];
    expect(entry?.correlationStatus).toBe('EXACT');
    expect(entry?.prospectId).toBe(target.prospectId);

    // La date d'arrivée est celle qu'Instagram porte sur le message, pas
    // l'instant où nous avons regardé.
    const rows = await sql.query<{ receivedAt: Date | string; evidence: unknown }>(
      `select received_at as "receivedAt", correlation_evidence as evidence from r6b_inbound_messages`,
    );
    const receivedAt = rows[0]!.receivedAt;
    expect(new Date(receivedAt).toISOString()).toBe('2026-08-15T10:30:00.000Z');
    const evidence = rows[0]!.evidence as { observation: { receivedAtBasis: string; providerMessageId: string } };
    expect(evidence.observation.receivedAtBasis).toBe('provider_timestamp');
    expect(evidence.observation.providerMessageId).toBe('mid.$SYNTH0000000000000000000000REP');
  });

  it('le même fil peut porter les deux : l’ancien est écarté, le récent entre', async () => {
    await contacted();
    const report = await poll([
      networkThread([
        theirMessage('2026-02-02T09:00:00.000Z', 'mid.$SYNTH00000000000000000000VIEUX'),
        ourDm(),
        theirMessage('2026-08-15T10:30:00.000Z'),
      ]),
    ]);

    expect(report.preOutreachSkipped).toBe(1);
    expect(report.ingested).toBe(1);
    expect(report.replyStatuses[0]?.replyStatus).toBe('REPLY_OBSERVED');
  });

  it('notre DM seul, sans rien après : NO_REPLY_OBSERVED — une absence CONSTATÉE', async () => {
    await contacted();
    const report = await poll([networkThread([ourDm()])]);

    expect(report.ingested).toBe(0);
    const status = report.replyStatuses[0];
    expect(status?.replyStatus).toBe('NO_REPLY_OBSERVED');
    expect(status?.outboundFound).toBe(true);
    expect(status?.messagesRead).toBe(1);
    expect(status?.outreachSentAt?.toISOString()).toBe(OUTREACH_AT);

    const persisted = await sql.query<{ status: string }>(
      `select reply_status as status from ig_inbound_thread_observations`,
    );
    expect(persisted[0]?.status).toBe('NO_REPLY_OBSERVED');
  });

  it('un fil « lu » qui ne rend AUCUN message ne devient jamais « pas de réponse »', async () => {
    // C'est exactement la situation des huit fils de R2 : ouverts, lus, zéro
    // bulle. Les rendre « sans réponse » aurait été le faux verdict.
    await contacted();
    const report = await poll([networkThread([])]);

    expect(report.replyStatuses[0]?.replyStatus).toBe('THREAD_UNREADABLE');
  });

  it('un fil illisible, un fil non ouvert et un fil sans réponse sont trois verdicts distincts', async () => {
    await contacted();
    const report = await poll([
      makeThread({ rowIndex: 0, threadId: '111', counterpartyHandle: HANDLE, messages: [ourDm()] }),
      makeThread({ rowIndex: 1, threadId: '222', counterpartyHandle: null, outcome: 'UNREADABLE', messages: [] }),
      makeThread({ rowIndex: 2, threadId: null, counterpartyHandle: null, outcome: 'NOT_OPENED', messages: [] }),
    ]);

    expect(report.replyStatuses.map((entry) => entry.replyStatus)).toEqual(['NO_REPLY_OBSERVED']);
    const persisted = await sql.query<{ rowIndex: number; status: string }>(
      `select row_index as "rowIndex", reply_status as status
         from ig_inbound_thread_observations order by row_index`,
    );
    expect(persisted.map((row) => row.status)).toEqual(['NO_REPLY_OBSERVED', 'THREAD_UNREADABLE', 'UNKNOWN']);
  });

  it('sans envoi connu vers ce compte, la conversation est observée mais jamais recopiée', async () => {
    // Aucun `contacted()` : personne n'a été joint sur ce compte.
    //
    // C'est la situation que le premier relevé LIVE de R3 a rendue concrète —
    // cinq fils personnels, trente-six messages. Ils sortaient tous
    // `UNMATCHED`, donc sans la moindre conséquence commerciale ; mais leur
    // CORPS était écrit en base. Une conversation privée sans lien commercial
    // n'a rien à faire dans la base d'une campagne de prospection.
    const report = await poll([
      makeThread({
        threadId: '333',
        counterpartyHandle: OTHER_HANDLE,
        messages: [
          networkMessage({
            text: 'bonjour',
            direction: 'INCOMING',
            providerMessageId: 'mid.$SYNTH00000000000000000INCONNU1',
            senderHandle: OTHER_HANDLE,
            sentAt: '2026-08-15T10:00:00.000Z',
          }),
        ],
      }),
    ]);

    expect(report.noOutreachSkipped).toBe(1);
    expect(report.ingested).toBe(0);
    expect(report.correlated).toHaveLength(0);

    // Rien du contenu n'est en base.
    const inbound = await sql.query<{ n: string }>(`select count(*) as n from r6b_inbound_messages`);
    expect(Number(inbound[0]!.n)).toBe(0);

    // Mais l'existence du message, elle, est consignée : qui, quand, et son
    // empreinte. On sait que la conversation existe sans l'avoir archivée.
    const observed = await sql.query<{ outcome: string; sender: string; sentAt: Date | string; sha: string }>(
      `select outcome, sender_handle as sender, message_sent_at as "sentAt", text_sha256 as sha
         from ig_inbound_message_observations`,
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]?.outcome).toBe('SKIPPED_NO_OUTREACH');
    expect(observed[0]?.sender).toBe(OTHER_HANDLE);
    expect(new Date(observed[0]!.sentAt).toISOString()).toBe('2026-08-15T10:00:00.000Z');
    expect(observed[0]?.sha).toMatch(/^[0-9a-f]{64}$/);

    // Et on ne prétend pas non plus que ce compte « n'a pas répondu » : sans
    // DM de référence, la phrase n'a pas de sens.
    expect(report.replyStatuses[0]?.replyStatus).toBe('UNKNOWN');
  });

  it('« aucun envoi » et « antérieur à l’envoi » sont deux refus distincts', async () => {
    // Le second suppose un envoi ; le premier constate qu'il n'y en a aucun.
    // Les confondre reviendrait à inventer un envoi pour dater le message.
    await contacted();
    const report = await poll([
      makeThread({
        rowIndex: 0,
        threadId: '111',
        counterpartyHandle: HANDLE,
        messages: [theirMessage('2026-02-02T09:00:00.000Z', 'mid.$SYNTH0000000000000000000VIEUX'), ourDm()],
      }),
      makeThread({
        rowIndex: 1,
        threadId: '333',
        counterpartyHandle: OTHER_HANDLE,
        messages: [
          networkMessage({
            text: 'bonjour',
            direction: 'INCOMING',
            providerMessageId: 'mid.$SYNTH00000000000000000INCONNU1',
            senderHandle: OTHER_HANDLE,
            sentAt: '2026-08-15T10:00:00.000Z',
          }),
        ],
      }),
    ]);

    expect(report.preOutreachSkipped).toBe(1);
    expect(report.noOutreachSkipped).toBe(1);
    const outcomes = await sql.query<{ outcome: string }>(
      `select outcome from ig_inbound_message_observations
        where direction = 'INCOMING' order by outcome`,
    );
    expect(outcomes.map((row) => row.outcome)).toEqual(['SKIPPED_NO_OUTREACH', 'SKIPPED_PRE_OUTREACH']);
  });

  it('une réponse sans texte compte comme réponse, sans corps fabriqué', async () => {
    await contacted();
    const report = await poll([
      networkThread([
        ourDm(),
        networkMessage({
          text: '',
          direction: 'INCOMING',
          providerMessageId: 'mid.$SYNTH000000000000000000000PHOTO',
          senderHandle: HANDLE,
          sentAt: '2026-08-15T11:00:00.000Z',
          contentKind: 'NON_TEXT',
        }),
      ]),
    ]);

    expect(report.nonTextSkipped).toBe(1);
    expect(report.ingested).toBe(0);
    // Le fil n'est PAS « sans réponse » : quelqu'un a bien écrit après notre DM.
    expect(report.replyStatuses[0]?.replyStatus).toBe('REPLY_OBSERVED');
  });

  it('un expéditeur tiers dans le fil n’est jamais promu en réponse du prospect', async () => {
    await contacted();
    const report = await poll([
      networkThread([
        ourDm(),
        networkMessage({
          text: 'un message de quelqu’un d’autre',
          direction: 'UNKNOWN',
          providerMessageId: 'mid.$SYNTH0000000000000000000TIERS1',
          senderHandle: 'compte.tiers',
          sentAt: '2026-08-15T12:00:00.000Z',
        }),
      ]),
    ]);

    expect(report.unknownDirectionSkipped).toBe(1);
    expect(report.ingested).toBe(0);
    expect(report.replyStatuses[0]?.replyStatus).toBe('NO_REPLY_OBSERVED');
  });
});

describe('IG5 R3 §5/§14 — l’identité vient d’Instagram, donc le rejeu ne double rien', () => {
  function conversation(): readonly ObservedThreadMessage[] {
    return [
      networkMessage({
        text: FIRST_TOUCH,
        direction: 'OUTGOING',
        providerMessageId: 'mid.$SYNTH000000000000000000000000DM',
        senderHandle: ACCOUNT,
        sentAt: '2026-08-14T09:00:01.000Z',
      }),
      networkMessage({
        text: 'Oui, ça m’intéresse, on peut en parler ?',
        direction: 'INCOMING',
        providerMessageId: 'mid.$SYNTH0000000000000000000000REP',
        senderHandle: HANDLE,
        sentAt: '2026-08-15T10:30:00.000Z',
      }),
    ];
  }

  it('deux relèves du même fil ne produisent qu’une réponse', async () => {
    await contacted();
    const thread = makeThread({ threadId: '111', counterpartyHandle: HANDLE, messages: conversation() });

    const first = await poll([thread]);
    const second = await poll([thread]);

    expect(first.ingested).toBe(1);
    expect(second.ingested).toBe(0);
    expect(second.alreadyKnown).toBe(1);

    const rows = await sql.query<{ n: string }>(`select count(*) as n from r6b_inbound_messages`);
    expect(Number(rows[0]!.n)).toBe(1);
    // Le lien de fil non plus n'est pas dupliqué.
    const bindings = await sql.query<{ n: string }>(`select count(*) as n from ig_inbound_thread_bindings`);
    expect(Number(bindings[0]!.n)).toBe(1);
  });

  it('l’identité ne bouge pas quand un message plus ancien apparaît dans le fil', async () => {
    // C'est ce que l'empreinte `ig-dm-v1` ne pouvait pas garantir : son rang
    // d'occurrence se décale dès que le fil change autour du message.
    await contacted();
    const [ourDm, reply] = conversation();
    await poll([makeThread({ threadId: '111', counterpartyHandle: HANDLE, messages: [ourDm!, reply!] })]);

    const older = networkMessage({
      text: 'un message bien plus ancien',
      direction: 'INCOMING',
      providerMessageId: 'mid.$SYNTH00000000000000000000VIEUX',
      senderHandle: HANDLE,
      sentAt: '2026-01-02T08:00:00.000Z',
    });
    const second = await poll([
      makeThread({ threadId: '111', counterpartyHandle: HANDLE, messages: [older, ourDm!, reply!] }),
    ]);

    expect(second.ingested).toBe(0);
    expect(second.alreadyKnown).toBe(1);
    const rows = await sql.query<{ n: string }>(`select count(*) as n from r6b_inbound_messages`);
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('le journal conserve l’identifiant natif et l’instant réel, la réponse conserve un condensé', async () => {
    await contacted();
    await poll([makeThread({ threadId: '111', counterpartyHandle: HANDLE, messages: conversation() })]);

    const observed = await sql.query<{
      providerMessageId: string;
      sentAt: Date | string;
      source: string;
      basis: string;
    }>(
      `select provider_message_id as "providerMessageId", message_sent_at as "sentAt",
              source, direction_basis as basis
         from ig_inbound_message_observations where direction = 'INCOMING'`,
    );
    expect(observed[0]?.providerMessageId).toBe('mid.$SYNTH0000000000000000000000REP');
    expect(new Date(observed[0]!.sentAt).toISOString()).toBe('2026-08-15T10:30:00.000Z');
    expect(observed[0]?.source).toBe('thread_detail_network');
    // La direction a été LUE, pas déduite d'une position à l'écran.
    expect(observed[0]?.basis).toBe('sender_identity');

    // En base, la clé reste un condensé : 0042 interdit de faire passer une
    // valeur calculée pour un identifiant émis par Instagram.
    const inbound = await sql.query<{ id: string; kind: string }>(
      `select provider_message_id as id, message_identity_kind as kind from r6b_inbound_messages`,
    );
    expect(inbound[0]?.kind).toBe('observed_fingerprint');
    expect(inbound[0]?.id).toMatch(/^[0-9a-f]{64}$/);
    expect(inbound[0]?.id).not.toContain('mid.');
  });

  it('la réponse lue par le réseau descend dans le MÊME aval D2, sans le dupliquer', async () => {
    const target = await contacted();
    const report = await poll([
      makeThread({ threadId: '111', counterpartyHandle: HANDLE, messages: conversation() }),
    ]);
    const inboundId = report.correlated[0]!.inboundMessageId;
    const router = makeRouter({ classify: classifyAs('INTERESTED'), draft: DRAFT_ANSWER });

    const processed = await processReply(sql, router, inboundId, { crm: NO_CRM });
    expect(processed.classification).toBe('INTERESTED');
    expect(processed.draftId).not.toBeNull();

    // Rejouer l'aval ne crée ni seconde analyse, ni second brouillon.
    await processReply(sql, router, inboundId, { crm: NO_CRM });
    const drafts = await sql.query<{ n: string }>(
      `select count(*) as n from r6b_reply_drafts where inbound_message_id = $1`,
      [inboundId],
    );
    expect(Number(drafts[0]!.n)).toBe(1);

    // L'Inbox du CRM montre la réponse avec son canal — la même vue que
    // l'e-mail, sans filtre de canal ni seconde table.
    const inbox = await loadCrmInbox(10, sql);
    expect(inbox.some((item) => item.id === inboundId && item.provider === 'instagram')).toBe(true);

    // Et le prospect est bien celui du manifeste, pas un rattachement approché.
    expect(report.correlated[0]?.prospectId).toBe(target.prospectId);
  });
});

// ---------------------------------------------------------------------------
// IG5 R4 — la relève devient périodique, donc l'invariant devient permanent
// ---------------------------------------------------------------------------

/**
 * R3 a corrigé la copie de conversations personnelles au coup par coup, sur un
 * rail qu'un humain lançait à la main. R4 le fait tourner 24/7 : la même faute,
 * si elle revenait, ne serait plus un relevé malheureux mais une collecte
 * continue. Les tests qui suivent existent pour que cette régression casse une
 * construction plutôt que d'être découverte dans une base.
 *
 * Ils s'attachent à ce qui ne peut PAS arriver, et le vérifient à trois
 * hauteurs différentes : ce que le schéma autorise, ce que le collecteur écrit,
 * et ce que l'aval réel — celui du runtime, pas une imitation — fait de ce qui
 * a été écrit.
 */
describe('IG5 R4 §4 — un fil sans outreach ne descend nulle part', () => {
  /** Un fil personnel : quelqu'un à qui Hermes n'a jamais rien envoyé. */
  function personalThread(rowIndex = 0): ReturnType<typeof makeThread> {
    return makeThread({
      rowIndex,
      threadId: '777',
      counterpartyHandle: OTHER_HANDLE,
      messages: [
        networkMessage({
          text: 'tu passes ce soir ?',
          direction: 'INCOMING',
          providerMessageId: 'mid.$SYNTH000000000000000000PERSO01',
          senderHandle: OTHER_HANDLE,
          sentAt: '2026-08-20T19:12:00.000Z',
        }),
      ],
    });
  }

  /**
   * Un routeur qui COMPTE ses appels et refuse d'en servir un seul.
   *
   * C'est la seule façon d'affirmer « aucun résumé LLM » : compter zéro ligne
   * d'analyse prouverait seulement qu'aucune n'a été GARDÉE. Un modèle appelé
   * puis ignoré aurait quand même vu le texte.
   */
  function forbiddenRouter(calls: { n: number }): ModelRouter {
    const provider: LlmProvider = {
      name: 'codex',
      availability: () => ({ ok: true }),
      generate: async () => {
        calls.n += 1;
        throw new LlmError('aucun modèle ne doit voir une conversation sans outreach', 'provider_error');
      },
    };
    return new ModelRouter({ sql, logger, providers: { codex: provider } });
  }

  it('rien n’est recopié, et l’aval RÉEL du runtime ne trouve aucun candidat', async () => {
    // Aucun `contacted()` : il n'existe aucun envoi vers ce compte.
    const report = await poll([personalThread()]);

    expect(report.noOutreachSkipped).toBe(1);
    expect(report.ingested).toBe(0);
    expect(report.correlated).toHaveLength(0);

    // L'aval branché par `src/cli/ig-inbound-run.ts`, à l'identique — pas une
    // reconstitution. C'est lui qui tournera toutes les cinq minutes.
    const calls = { n: 0 };
    const downstream = await createReplyProcessingStep(forbiddenRouter(calls), { limit: 50, crm: NO_CRM })(sql);

    expect(downstream.candidates).toBe(0);
    expect(downstream.classified).toBe(0);
    expect(downstream.drafted).toBe(0);
    expect(downstream.failures).toBe(0);
    expect(calls.n).toBe(0);
  });

  it('zéro ligne dans TOUTE table commerciale — corps, D2, CRM, alerte, brouillon', async () => {
    await poll([personalThread()]);
    const calls = { n: 0 };
    await createReplyProcessingStep(forbiddenRouter(calls), { limit: 50, crm: NO_CRM })(sql);

    // Une liste explicite plutôt qu'un échantillon : chacune de ces tables est
    // une conséquence commerciale nommée par §4, et une régression n'en
    // toucherait qu'une seule.
    const tables = [
      'r6b_inbound_messages', // le CORPS du message
      'r6b_reply_analyses', // D2 — classification
      'r6b_reply_drafts', // brouillon
      'r6b_alerts', // alerte
      'r6b_crm_projections', // CRM Inbox
      'r6b_crm_contact_links',
      'r6b_crm_notes',
      'r6b_prospect_state_transitions', // machine à états
      'do_not_contact',
      'outreach_events',
    ] as const;
    for (const table of tables) {
      const rows = await sql.query<{ n: string }>(`select count(*)::text as n from ${table}`);
      expect(`${table}=${rows[0]!.n}`).toBe(`${table}=0`);
    }

    // Ce qui EXISTE, en revanche : la trace technique minimale. Savoir qu'une
    // conversation a été vue sans l'avoir archivée est tout l'objet de R3-R4.
    const observed = await sql.query<{ outcome: string; sender: string; sha: string; sentAt: Date | string }>(
      `select outcome, sender_handle as sender, text_sha256 as sha, message_sent_at as "sentAt"
         from ig_inbound_message_observations where direction = 'INCOMING'`,
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]?.outcome).toBe('SKIPPED_NO_OUTREACH');
    expect(observed[0]?.sender).toBe(OTHER_HANDLE);
    expect(observed[0]?.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(observed[0]!.sentAt).toISOString()).toBe('2026-08-20T19:12:00.000Z');
  });

  it('le journal d’observation ne PEUT pas porter un corps de message', async () => {
    // La garantie structurelle, celle qu'aucune relecture de code ne peut
    // remplacer : il n'existe aucune colonne où un corps tiendrait. Une
    // régression qui voudrait recopier le texte devrait d'abord écrire une
    // migration — donc passer par une revue.
    const columns = await sql.query<{ name: string }>(
      `select column_name as name from information_schema.columns
        where table_name = 'ig_inbound_message_observations'`,
    );
    const names = columns.map((row) => row.name);
    expect(names).toContain('text_sha256');
    expect(names).toContain('fingerprint');
    expect(names.filter((name) => /body|content|snippet|preview|excerpt|^text$|_text$/.test(name))).toEqual([]);
  });

  it('les trois verdicts restent trois : sans outreach, sans réponse, illisible', async () => {
    // Le seul relevé qui exerce la distinction en une fois. Les fusionner
    // rendrait un fil personnel « sans réponse » — c'est-à-dire une absence
    // AFFIRMÉE sur une conversation à laquelle nous n'avons jamais écrit.
    await contacted();
    const report = await poll([
      // 1. Notre DM, aucune réponse après lui.
      makeThread({
        rowIndex: 0,
        threadId: '111',
        counterpartyHandle: HANDLE,
        messages: [
          networkMessage({
            text: FIRST_TOUCH,
            direction: 'OUTGOING',
            providerMessageId: 'mid.$SYNTH000000000000000000000000DM',
            senderHandle: ACCOUNT,
            sentAt: '2026-08-14T09:00:01.000Z',
          }),
        ],
      }),
      // 2. Une conversation personnelle, jamais sollicitée.
      personalThread(1),
      // 3. Un fil qu'on n'a pas su lire.
      makeThread({ rowIndex: 2, threadId: '888', counterpartyHandle: null, outcome: 'UNREADABLE', messages: [] }),
    ]);

    const byHandle = new Map(report.replyStatuses.map((entry) => [entry.counterpartyHandle, entry.replyStatus]));
    expect(byHandle.get(HANDLE)).toBe('NO_REPLY_OBSERVED');
    // Ni « pas de réponse » ni « illisible » : on ne sait rien, et c'est exact.
    expect(byHandle.get(OTHER_HANDLE)).toBe('UNKNOWN');

    const persisted = await sql.query<{ status: string; outcome: string }>(
      `select reply_status as status, outcome from ig_inbound_thread_observations order by row_index`,
    );
    expect(persisted.map((row) => row.status)).toEqual(['NO_REPLY_OBSERVED', 'UNKNOWN', 'THREAD_UNREADABLE']);
    expect(report.noOutreachSkipped).toBe(1);
    expect(report.ingested).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HERMES-CONTROLLED-THREAD-INBOUND-INGESTION-DIAGNOSTIC-R1
// ---------------------------------------------------------------------------

/**
 * Le 23 août 2026, un fil contrôlé a été déclaré « non ingéré » alors que son
 * message était en base depuis le tour précédent. Le diagnostic n'a rien
 * trouvé de cassé dans l'ingestion — et c'est précisément le problème : rien
 * de ce que le tour affichait ne permettait de le savoir sans ouvrir la base.
 *
 * Ces tests fixent ce que le registre de tour DIT, et ce qu'il ne dit pas.
 * Aucun n'exerce une exception : le registre ne reçoit ni prospect, ni
 * coquille, ni configuration — seulement ce que le fil a montré.
 */
describe('HERMES-CTIID-R1 §4 — le registre nomme le sort du dernier message', () => {
  const OUR_DM = 'mid.$SYNTH00000000000000000000000DM';

  function ourDm(sentAt = '2026-08-14T09:00:01.000Z'): ObservedThreadMessage {
    return networkMessage({
      text: FIRST_TOUCH,
      direction: 'OUTGOING',
      providerMessageId: OUR_DM,
      senderHandle: ACCOUNT,
      sentAt,
    });
  }

  function reply(spec: {
    text: string;
    providerMessageId: string;
    sentAt: string;
    direction?: MessageDirection;
  }): ObservedThreadMessage {
    return networkMessage({
      text: spec.text,
      direction: spec.direction ?? 'INCOMING',
      providerMessageId: spec.providerMessageId,
      senderHandle: spec.direction === 'OUTGOING' ? ACCOUNT : HANDLE,
      sentAt: spec.sentAt,
    });
  }

  function entryFor(
    report: Awaited<ReturnType<typeof poll>>,
    threadId: string,
  ): (typeof report.threadLedger)[number] {
    const found = report.threadLedger.find((line) => line.threadId === threadId);
    expect(found, `aucune ligne de registre pour le fil ${threadId}`).toBeDefined();
    return found as (typeof report.threadLedger)[number];
  }

  // ---- A ------------------------------------------------------------------
  it('A — un fil portant un nouveau message est sélectionné, lu, et rendu NEW', async () => {
    await contacted();
    const thread = makeThread({
      threadId: '17849017046724398',
      counterpartyHandle: HANDLE,
      messages: [ourDm(), reply({ text: 'et après, ça coûte combien ?', providerMessageId: 'mid.$SYNTHA1', sentAt: '2026-08-15T10:00:00.000Z' })],
    });

    const report = await poll([thread]);
    const line = entryFor(report, '17849017046724398');

    expect(line.outcome).toBe('READ');
    expect(line.verdict).toBe('NEW');
    expect(line.reason).toBe('ingested');
    expect(report.ingested).toBe(1);
  });

  // ---- B ------------------------------------------------------------------
  //
  // La borne de fils par tour est appliquée par le RAIL (`observeInbox`), pas
  // par le collecteur : c'est le rail qui décide quelles lignes il ouvre, et
  // il rend `SKIPPED_LIMIT` pour les autres. Le fil ci-dessous porte donc
  // l'issue que le rail aurait produite — la simuler autrement ferait dire au
  // test que la borne vit là où elle ne vit pas.
  it('B — un fil hors de la borne est NOT_SELECTED, et un message nouveau le fait remonter', async () => {
    await contacted();
    const conversation = [
      ourDm(),
      reply({ text: 'oui je suis intéressé', providerMessageId: 'mid.$SYNTHL1', sentAt: '2026-08-15T10:00:00.000Z' }),
    ];

    const first = await poll([
      makeThread({
        rowIndex: 0,
        threadId: '900',
        counterpartyHandle: OTHER_HANDLE,
        messages: [reply({ text: 'bonjour', providerMessageId: 'mid.$SYNTHN1', sentAt: '2026-08-15T09:00:00.000Z' })],
      }),
      makeThread({
        rowIndex: 1,
        threadId: '901',
        counterpartyHandle: HANDLE,
        outcome: 'SKIPPED_LIMIT',
        messages: [],
      }),
    ]);

    const skipped = entryFor(first, '901');
    expect(skipped.verdict).toBe('NOT_SELECTED');
    expect(skipped.reason).toBe('thread_limit_reached');
    // Une ligne écartée par la borne ne produit AUCUN verdict de réponse : rien
    // n'a été lu, donc rien n'est conclu de ce fil.
    expect(first.threadsSkipped).toBe(1);
    expect(first.ingested).toBe(0);

    // Instagram ordonne la boîte par récence : un fil qui REÇOIT remonte, donc
    // il repasse sous la borne au tour suivant. C'est ce qui rend la famine
    // impossible pour un fil porteur d'un message nouveau — et c'est une
    // propriété de l'ORDRE, pas un rattrapage.
    const second = await poll([
      makeThread({ rowIndex: 0, threadId: '901', counterpartyHandle: HANDLE, messages: conversation }),
      makeThread({
        rowIndex: 1,
        threadId: '900',
        counterpartyHandle: OTHER_HANDLE,
        outcome: 'SKIPPED_LIMIT',
        messages: [],
      }),
    ]);

    expect(entryFor(second, '901').verdict).toBe('NEW');
    expect(second.ingested).toBe(1);
  });

  // ---- C ------------------------------------------------------------------
  it('C — un nouveau message dans un fil DÉJÀ connu est NEW, jamais ALREADY_KNOWN', async () => {
    await contacted();
    const first = reply({ text: 'ok merci', providerMessageId: 'mid.$SYNTHC1', sentAt: '2026-08-15T10:00:00.000Z' });
    const base = [ourDm(), first];

    const one = await poll([makeThread({ threadId: '111', counterpartyHandle: HANDLE, messages: base })]);
    expect(one.ingested).toBe(1);
    expect(entryFor(one, '111').verdict).toBe('NEW');

    const second = reply({ text: 'et après les 7 jours ?', providerMessageId: 'mid.$SYNTHC2', sentAt: '2026-08-15T11:00:00.000Z' });
    const two = await poll([makeThread({ threadId: '111', counterpartyHandle: HANDLE, messages: [...base, second] })]);

    expect(two.ingested).toBe(1);
    expect(two.alreadyKnown).toBe(1);
    const line = entryFor(two, '111');
    expect(line.verdict).toBe('NEW');
    expect(line.lastMessageId).toBe('mid.$SYNTHC2');

    const rows = await sql.query<{ n: string }>(`select count(*) as n from r6b_inbound_messages`);
    expect(Number(rows[0]!.n)).toBe(2);
  });

  // ---- D ------------------------------------------------------------------
  it('D — même texte, identifiant différent : deux événements distincts', async () => {
    await contacted();
    const text = 'ok';
    const messages = [
      ourDm(),
      reply({ text, providerMessageId: 'mid.$SYNTHD1', sentAt: '2026-08-15T10:00:00.000Z' }),
      reply({ text, providerMessageId: 'mid.$SYNTHD2', sentAt: '2026-08-15T12:00:00.000Z' }),
    ];

    const report = await poll([makeThread({ threadId: '111', counterpartyHandle: HANDLE, messages })]);
    expect(report.ingested).toBe(2);

    const rows = await sql.query<{ id: string }>(
      `select provider_message_id as id from r6b_inbound_messages order by received_at`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
  });

  // ---- E ------------------------------------------------------------------
  it('E — même identifiant : idempotent, et le registre dit ALREADY_KNOWN', async () => {
    await contacted();
    const messages = [
      ourDm(),
      reply({ text: 'oui', providerMessageId: 'mid.$SYNTHE1', sentAt: '2026-08-15T10:00:00.000Z' }),
    ];
    const thread = makeThread({ threadId: '111', counterpartyHandle: HANDLE, messages });

    const one = await poll([thread]);
    const two = await poll([thread]);

    expect(one.ingested).toBe(1);
    expect(two.ingested).toBe(0);
    expect(two.alreadyKnown).toBe(1);
    const line = entryFor(two, '111');
    expect(line.verdict).toBe('ALREADY_KNOWN');
    expect(line.reason).toBe('already_known');
    // La clé n'a pas bougé d'un tour à l'autre : c'est CE message, pas ce fil.
    expect(line.lastMessageKey).toBe(entryFor(one, '111').lastMessageKey);

    const rows = await sql.query<{ n: string }>(`select count(*) as n from r6b_inbound_messages`);
    expect(Number(rows[0]!.n)).toBe(1);
  });

  // ---- F ------------------------------------------------------------------
  it('F — un dernier message SORTANT est REJECTED, et nommé comme tel', async () => {
    await contacted();
    const report = await poll([
      makeThread({
        threadId: '111',
        counterpartyHandle: HANDLE,
        messages: [
          ourDm(),
          reply({ text: 'oui', providerMessageId: 'mid.$SYNTHF1', sentAt: '2026-08-15T10:00:00.000Z' }),
          reply({
            text: 'très bien, je vous rappelle',
            providerMessageId: 'mid.$SYNTHF2',
            sentAt: '2026-08-15T10:05:00.000Z',
            direction: 'OUTGOING',
          }),
        ],
      }),
    ]);

    const line = entryFor(report, '111');
    expect(line.lastMessageDirection).toBe('OUTGOING');
    expect(line.verdict).toBe('REJECTED');
    expect(line.reason).toBe('skipped_outgoing');
    // Notre propre message n'a jamais été ingéré ; la réponse, elle, l'a été.
    expect(report.ingested).toBe(1);
    expect(report.outgoingSkipped).toBe(2);
  });

  // ---- G ------------------------------------------------------------------
  it('G — le registre porte le DERNIER message réel du fil, avec son instant', async () => {
    await contacted();
    const report = await poll([
      makeThread({
        threadId: '111',
        counterpartyHandle: HANDLE,
        messages: [
          ourDm(),
          reply({ text: 'un', providerMessageId: 'mid.$SYNTHG1', sentAt: '2026-08-15T10:00:00.000Z' }),
          reply({ text: 'deux', providerMessageId: 'mid.$SYNTHG2', sentAt: '2026-08-15T10:30:00.000Z' }),
          reply({ text: 'trois', providerMessageId: 'mid.$SYNTHG3', sentAt: '2026-08-15T11:45:12.345Z' }),
        ],
      }),
    ]);

    const line = entryFor(report, '111');
    expect(line.messagesRead).toBe(4);
    expect(line.lastMessageId).toBe('mid.$SYNTHG3');
    // La milliseconde est conservée : elle est ce qui tranche deux tours.
    expect(line.lastMessageAt).toBe('2026-08-15T11:45:12.345Z');
    expect(line.lastMessageDirection).toBe('INCOMING');
    expect(line.verdict).toBe('NEW');
  });

  // ---- H ------------------------------------------------------------------
  it('H — aucun point de reprise ne masque un message plus récent', async () => {
    await contacted();
    const base = [ourDm(), reply({ text: 'oui', providerMessageId: 'mid.$SYNTHH1', sentAt: '2026-08-15T10:00:00.000Z' })];
    await poll([makeThread({ threadId: '111', counterpartyHandle: HANDLE, messages: base })]);

    // Un message PLUS ANCIEN remonte dans le fil ET un message plus récent
    // arrive. Le premier ne doit pas servir de borne au second : c'est
    // l'identité du message qui décide, jamais une position ni une horloge.
    const older = reply({ text: 'ancien', providerMessageId: 'mid.$SYNTHH0', sentAt: '2026-08-14T20:00:00.000Z' });
    const newer = reply({ text: 'plus récent', providerMessageId: 'mid.$SYNTHH2', sentAt: '2026-08-15T13:00:00.000Z' });

    const second = await poll([
      makeThread({ threadId: '111', counterpartyHandle: HANDLE, messages: [older, ...base, newer] }),
    ]);

    expect(second.ingested).toBe(2);
    expect(entryFor(second, '111').lastMessageId).toBe('mid.$SYNTHH2');
    expect(entryFor(second, '111').verdict).toBe('NEW');
  });

  // ---- Le fil non ouvert, et le fil lu sans rien montrer --------------------
  it('une ligne sans identifiant, et un fil lu sans message, sont NOT_VISIBLE', async () => {
    await contacted();
    const report = await poll([
      makeThread({ rowIndex: 0, threadId: null, counterpartyHandle: null, outcome: 'NOT_OPENED', messages: [] }),
      makeThread({ rowIndex: 1, threadId: '112', counterpartyHandle: HANDLE, messages: [] }),
    ]);

    const unnamed = report.threadLedger.find((line) => line.rowIndex === 0);
    expect(unnamed?.verdict).toBe('NOT_VISIBLE');
    expect(unnamed?.reason).toBe('thread_not_opened');

    const empty = entryFor(report, '112');
    expect(empty.verdict).toBe('NOT_VISIBLE');
    expect(empty.reason).toBe('thread_read_without_messages');
  });

  it('le registre porte une ligne par ligne VUE, y compris celles restées fermées', async () => {
    await contacted();
    const report = await poll(
      [
        makeThread({ rowIndex: 0, threadId: '111', counterpartyHandle: HANDLE, messages: [ourDm()] }),
        makeThread({ rowIndex: 1, threadId: '112', counterpartyHandle: OTHER_HANDLE, messages: [] }),
        makeThread({ rowIndex: 2, threadId: '113', counterpartyHandle: OTHER_HANDLE, messages: [] }),
      ],
      { maxThreads: 1 },
    );

    expect(report.threadLedger).toHaveLength(3);
    expect(report.threadLedger.map((line) => line.rowIndex)).toEqual([0, 1, 2]);
  });

  it('le registre ne porte AUCUN corps de message, ni extrait, ni condensé de texte', async () => {
    await contacted();
    const secret = 'un texte privé qui ne doit jamais sortir du corps du message';
    const report = await poll([
      makeThread({
        threadId: '111',
        counterpartyHandle: HANDLE,
        messages: [ourDm(), reply({ text: secret, providerMessageId: 'mid.$SYNTHS1', sentAt: '2026-08-15T10:00:00.000Z' })],
      }),
    ]);

    const serialized = JSON.stringify(report.threadLedger);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(FIRST_TOUCH);
    // Le condensé du texte n'y est pas non plus : la clé du registre est celle
    // de la DÉDUPLICATION, tronquée, et elle ne reconstitue rien.
    expect(serialized).not.toContain(createHash('sha256').update(secret, 'utf8').digest('hex'));
    for (const line of report.threadLedger) {
      expect(line.lastMessageKey === null || line.lastMessageKey.length === 16).toBe(true);
    }
  });
});

/**
 * Ce que le diagnostic du 23 août 2026 a établi sur les trois autres suspects,
 * et qui doit rester vrai : la garde réseau n'empêche pas de LIRE, l'ingestion
 * est la MÊME pour tout le monde, et rien n'y nomme un compte.
 */
describe('HERMES-CTIID-R1 §5 — ce que le diagnostic a écarté, et qui doit le rester', () => {
  // ---- I ------------------------------------------------------------------
  it('I — la garde réseau reste fail-closed, et laisse passer la lecture d’un fil', () => {
    // Ce que les tours réels bloquent en masse : de la télémétrie en POST, hors
    // de toute liste de lecture. Refusée par DÉFAUT, donc sans avoir à la nommer.
    for (const path of ['/ajax/qm/', '/ajax/bz', '/sync/instagram/', '/api/v1/web/fxcal/ig_sso_users/']) {
      const denied = classifyAdjudicationRequest({
        url: `https://www.instagram.com${path}`,
        method: 'POST',
        postData: null,
      });
      expect(denied.allowed, `${path} devrait être refusé`).toBe(false);
    }

    // Une mutation de messagerie reste refusée, y compris l'accusé de lecture.
    for (const operation of ['IGDirectTextSendMutation', 'useIGDMarkThreadAsReadMutation']) {
      const denied = classifyAdjudicationRequest({
        url: 'https://www.instagram.com/graphql/query',
        method: 'POST',
        postData: `fb_api_req_friendly_name=${operation}&doc_id=1&variables={}&mutation`,
      });
      expect(denied.allowed, `${operation} devrait être refusé`).toBe(false);
    }

    // Et ce qui fait REMONTER le fil — la page qui se construit elle-même —
    // passe. C'est la preuve que le blocage massif observé n'empêche rien de
    // ce dont la relève a besoin.
    for (const url of [
      'https://www.instagram.com/direct/inbox/',
      'https://www.instagram.com/direct/t/17849017046724398/',
      'https://www.instagram.com/graphql/query?doc_id=1',
    ]) {
      expect(classifyAdjudicationRequest({ url, method: 'GET', postData: null }).allowed).toBe(true);
    }
  });

  // ---- J et K -------------------------------------------------------------
  it('J/K — l’ingestion ne connaît ni coquille, ni compte nommé', () => {
    // Les COMMENTAIRES sont retirés, les chaînes NON. Un compte peut être
    // raconté dans une note d'incident — `inboxScan` raconte celui d'IG2.3 —
    // sans qu'aucune ligne ne le lise ; ce qu'on interdit, c'est qu'il soit une
    // VALEUR. Retirer aussi les chaînes rendrait le test complaisant.
    const withoutComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

    const sources = [
      'src/lib/inbound/instagramCollector.ts',
      'src/lib/inbound/instagramIntake.ts',
      'src/lib/inbound/instagramCorrelation.ts',
      'src/lib/instagram/playwrightInboundRail.ts',
      'src/lib/instagram/inboxScan.ts',
      'src/lib/instagram/inboxNetwork.ts',
      'src/lib/instagram/threadDetailNetwork.ts',
    ].map((path) => withoutComments(readFileSync(resolve(process.cwd(), path), 'utf8')));

    for (const source of sources) {
      // J — un seul chemin d'ingestion : le test contrôlé n'en a pas d'autre,
      // donc il ne peut pas être servi mieux ni moins bien que la production.
      expect(source).not.toContain('controlledSelfTest');
      expect(source).not.toContain('CONTROLLED_SELF_TEST');
      // K — aucun compte n'est nommé dans la logique générique.
      expect(source).not.toContain('operator_second_account');
      expect(source).not.toContain('northstar_studio');
    }
  });

  it('le verdict d’un fil ne reçoit ni prospect, ni cadence, ni configuration', () => {
    // Il n'existe donc AUCUNE donnée depuis laquelle une exception pourrait
    // être écrite : la fonction ne voit que ce que le fil a montré.
    expect(threadLedgerVerdict({ outcome: 'READ', messagesRead: 1, lastMessageOutcome: 'INGESTED' })).toEqual({
      verdict: 'NEW',
      reason: 'ingested',
    });
    expect(threadLedgerVerdict({ outcome: 'READ', messagesRead: 0, lastMessageOutcome: 'INGESTED' })).toEqual({
      verdict: 'NOT_VISIBLE',
      reason: 'thread_read_without_messages',
    });
    // Fail-closed : un dernier message dont le sort n'est pas connu ne devient
    // jamais un verdict qui laisserait croire qu'on a conclu.
    expect(threadLedgerVerdict({ outcome: 'READ', messagesRead: 3, lastMessageOutcome: null })).toEqual({
      verdict: 'NOT_VISIBLE',
      reason: 'last_message_not_observed',
    });
  });

  it('un code de refus survit au caviardage du journal, une vraie clé n’y survit pas', () => {
    // Cinq des sept codes de refus commencent par « sk » et faisaient plus de
    // treize caractères : ils sortaient en `[redacted]`, ce qui détruisait
    // silencieusement la donnée que ce round existe pour rendre lisible.
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    try {
      // Les deux faux jetons sont ASSEMBLÉS à l'exécution plutôt qu'écrits en
      // clair : un scanner de secrets qui relit le dépôt les signalerait
      // autrement, et un test qui apprend à ignorer une alerte de secret est
      // pire que pas de test du tout. La valeur reçue par le logger est
      // identique — c'est elle qui compte.
      const fakeAnthropicKey = ['sk', 'ant', 'api03', 'A'.repeat(20)].join('-');
      const fakeGithubToken = `ghp${'_'}${'A'.repeat(20)}`;
      createLogger({ probe: 'ctiid' }).info('sonde', {
        reason: 'skipped_outgoing',
        other: 'skipped_pre_outreach',
        apiKey: fakeAnthropicKey,
        loose: fakeGithubToken,
      });
    } finally {
      process.stdout.write = write;
    }

    const emitted = lines.join('\n');
    expect(emitted).toContain('skipped_outgoing');
    expect(emitted).toContain('skipped_pre_outreach');
    expect(emitted).not.toContain(['sk', 'ant', 'api03'].join('-'));
    expect(emitted).not.toContain(`ghp${'_'}${'A'.repeat(20)}`);
  });
});
