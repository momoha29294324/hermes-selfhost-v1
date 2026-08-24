import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import { lockManifestForItem, type DispatchManifest } from '@/lib/pipeline/r6bDispatch';
import { completeEmailSubject } from '@/lib/pipeline/r6bManifestCompletion';
import { hashTransportPayload } from '@/lib/pipeline/r6bTransportPayload';
import { R6B_LIVE_ARMED_MANIFEST_ID } from '@/lib/pipeline/r6bLiveDispatch';
import {
  GmailInboundProvider,
  GMAIL_ENV_KEYS,
  readGmailCredentials,
  type GmailApi,
  type GmailListMessagesResponse,
  type GmailProfile,
} from '@/lib/inbound/gmailProvider';
import type { GmailMessage } from '@/lib/inbound/gmailMessage';
import { toInboundRawMessage } from '@/lib/inbound/gmailMessage';
import {
  loadCheckpoint,
  loadOutboundSends,
  persistInboundMessage,
  pollInboundReplies,
  resolveSince,
  type PollReport,
} from '@/lib/inbound/intake';
import { normalizeInboundMessage } from '@/lib/inbound/parse';
import { correlateInbound } from '@/lib/inbound/correlation';
import { loadInboundSummary, loadRepliesForManifest } from '@/lib/inbound/replies';
import type { Sql } from '@/lib/db/sql';

/**
 * R6B-D1 — ingestion, idempotence, curseur et non-régression outbound.
 *
 * Aucun test de ce fichier n'ouvre de connexion réseau : le transport Gmail
 * est toujours un faux, injecté, et `GmailInboundProvider` n'en construit
 * jamais aucun de lui-même. Le faux remplace la couche HTTP, pas le
 * fournisseur — les tests exercent donc le VRAI code de bornage, de
 * pagination, de décodage base64url et de parcours MIME, pas une maquette de
 * celui-ci.
 *
 * Les adresses, textes et objets sont fictifs. Rien du prospect réel n'entre
 * dans ce dépôt.
 */

const ROOT = resolve(__dirname, '..');
const MAILBOX = 'reponse@example.com';
const TEXT = 'Bonjour, une question rapide sur vos créneaux de prestation.';

let sql: Sql;
let dir: string;
let campaignId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-r6b-inbound-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);

  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-commercial-inbound-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('delete from r6b_inbound_messages');
  await sql.query('delete from r6b_inbound_checkpoints');
  await sql.query('delete from r6b_reply_tokens');
  await sql.query('delete from r6b_dispatch_attempts');
  await sql.query('delete from r6b_live_send_attempts');
  await sql.query('delete from outreach_events');
  await sql.query('delete from r6b_dispatch_manifests');
  await sql.query('delete from r6b_batch_votes');
  await sql.query('delete from r6b_batch_items');
  await sql.query('delete from r6b_batches');
  await sql.query('delete from prospect_evidence');
  await sql.query('delete from prospects');
});

// ---------------------------------------------------------------------------
// Fixtures outbound
// ---------------------------------------------------------------------------

/**
 * Construit un manifeste email complet par le vrai chemin humain — vote,
 * lock, complétion de l'objet. Passer par le pipeline plutôt que par un
 * `insert` direct garantit que la corrélation lit la forme réelle des données,
 * pas une forme reconstituée à la main.
 */
async function emailManifest(recipient: string, subject: string): Promise<DispatchManifest> {
  const prospect = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, email)
     values ($1,$2,'ACME ATELIER',$3) returning id`,
    [campaignId, `prospect-${randomUUID()}`, recipient],
  );
  const prospectId = prospect[0]!.id;
  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,'email',$2,'website','crawl','https://acme-test.fr',1.0)`,
    [prospectId, recipient],
  );

  const batch = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
    [`batch-${randomUUID()}`, campaignId],
  );
  const item = await sql.query<{ id: string }>(
    `insert into r6b_batch_items (batch_id, prospect_id, item_index, original_draft, contact_channels)
     values ($1,$2,1,'brouillon',$3) returning id`,
    [batch[0]!.id, prospectId, JSON.stringify(['email'])],
  );
  const itemId = item[0]!.id;

  await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: TEXT, note: null });
  const locked = await lockManifestForItem(sql, { itemId, transport: 'email' });

  const completed = await completeEmailSubject(sql, {
    manifestId: locked.id,
    expected: {
      batchItemId: locked.batchItemId,
      transport: 'email',
      recipient: locked.recipient,
      recipientEvidenceIds: locked.recipientEvidenceIds,
      approvedTextSha256: locked.approvedTextSha256,
      identityReview: locked.identityReview,
      transportPayloadSha256: locked.transportPayloadSha256,
    },
    subject,
    previewedTransportPayloadSha256: hashTransportPayload({ subject }),
  });

  return completed.locked;
}

/**
 * Inscrit un envoi réussi : registre LIVE + `outreach_event`, exactement comme
 * `finalizeOutcome` le fait en production.
 */
async function recordSend(
  manifest: DispatchManifest,
  options: { sentAt: string; rfcMessageId?: string | null } = { sentAt: '2026-08-12T22:11:32.505Z' },
): Promise<{ outreachEventId: string; liveAttemptId: string }> {
  const live = await sql.query<{ id: string }>(
    `insert into r6b_live_send_attempts
       (manifest_id, provider, idempotency_key, transport, recipient,
        approved_text_sha256, transport_payload_sha256, provider_payload_sha256,
        provider_idempotency_expires_at, status, network_attempted, network_started_at,
        provider_message_id, provider_rfc_message_id, claimed_at, completed_at)
     values ($1,'resend',$2,'email',$3,$4,$5,$6, $7::timestamptz + interval '24 hours',
             'SENT', true, $7::timestamptz, $8, $9, $7::timestamptz, $7::timestamptz)
     returning id`,
    [
      manifest.id,
      `r6b-c2b-first-touch-email/${manifest.id}`,
      manifest.recipient,
      manifest.approvedTextSha256,
      manifest.transportPayloadSha256,
      'f'.repeat(64),
      options.sentAt,
      `provider-${randomUUID()}`,
      options.rfcMessageId ?? null,
    ],
  );

  const event = await sql.query<{ id: string }>(
    `insert into outreach_events (prospect_id, kind, channel, payload, manifest_id, occurred_at)
     values ($1,'sent','email','{}'::jsonb,$2,$3::timestamptz) returning id`,
    [manifest.prospectId, manifest.id, options.sentAt],
  );

  return { outreachEventId: event[0]!.id, liveAttemptId: live[0]!.id };
}

// ---------------------------------------------------------------------------
// Faux transport Gmail
// ---------------------------------------------------------------------------

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface MessageSpec {
  readonly id: string;
  readonly from: string;
  readonly to?: string;
  readonly deliveredTo?: string;
  readonly subject?: string;
  readonly body?: string;
  readonly internalDateMs: number;
  readonly inReplyTo?: string;
  readonly references?: string;
  readonly threadId?: string;
}

function gmailMessage(spec: MessageSpec): GmailMessage {
  const headers = [
    { name: 'From', value: spec.from },
    { name: 'To', value: spec.to ?? MAILBOX },
    { name: 'Delivered-To', value: spec.deliveredTo ?? spec.to ?? MAILBOX },
    { name: 'Subject', value: spec.subject ?? 'Re: Petite question' },
    { name: 'Message-ID', value: `<${spec.id}@mail.exemple.fr>` },
  ];
  if (spec.inReplyTo) headers.push({ name: 'In-Reply-To', value: spec.inReplyTo });
  if (spec.references) headers.push({ name: 'References', value: spec.references });

  return {
    id: spec.id,
    threadId: spec.threadId ?? `thread-${spec.id}`,
    historyId: '1000',
    internalDate: String(spec.internalDateMs),
    payload: {
      mimeType: 'multipart/alternative',
      headers,
      parts: [
        { mimeType: 'text/html', body: { data: b64url('<p>version html</p>') } },
        { mimeType: 'text/plain', body: { data: b64url(spec.body ?? 'Oui, ça m’intéresse.') } },
      ],
    },
  };
}

interface FakeScript {
  readonly messages?: readonly GmailMessage[];
  readonly historyIds?: readonly string[];
  /** Chaque identifiant est rendu deux fois par la liste — Gmail le fait. */
  readonly duplicateIds?: boolean;
  readonly failGet?: ReadonlySet<string>;
  readonly missingGet?: ReadonlySet<string>;
  /** Force la pagination : nombre d'identifiants rendus par page. */
  readonly pageLimit?: number;
  /**
   * Injecte, dans la boîte simulée, des messages dont l'expéditeur n'est PAS
   * une contrepartie sortante connue — le bruit d'une vraie boîte
   * (newsletters, notifications SaaS…). `listMessages` les filtre exactement
   * comme le ferait Gmail avec une clause `from:` server-side : le test de
   * régression vie-privée dépend de ce filtrage étant RÉEL, pas simulé côté
   * client.
   */
  readonly unrelatedMessages?: readonly GmailMessage[];
}

function headerValue(message: GmailMessage, name: string): string {
  const header = (message.payload?.headers ?? []).find(
    (h) => typeof h.name === 'string' && h.name.toLowerCase() === name.toLowerCase(),
  );
  return typeof header?.value === 'string' ? header.value : '';
}

/** Les adresses `from:` d'une clause `{from:a from:b}` d'une requête Gmail. */
function extractFromAddresses(q: string): Set<string> {
  const group = q.match(/\{([^}]*)\}/)?.[1] ?? '';
  return new Set([...group.matchAll(/from:(\S+)/g)].map((m) => m[1]!.toLowerCase()));
}

/** La borne `after:YYYY/MM/DD` d'une requête Gmail, en epoch ms UTC. */
function extractAfterMs(q: string): number | null {
  const match = q.match(/after:(\d{4})\/(\d{2})\/(\d{2})/);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * Faux transport Gmail qui applique RÉELLEMENT la requête `q` — filtrage
 * `from:` et `after:` — plutôt que de rendre tout `script.messages` sans
 * condition. C'est ce qui rend le filtrage server-side vérifiable : un test
 * qui se contenterait d'inspecter la chaîne `q` construite pourrait passer
 * alors que le code appelant ignorerait cette même chaîne.
 */
class FakeGmailApi implements GmailApi {
  readonly listCalls: { q: string; pageToken: string | null }[] = [];
  readonly getCalls: string[] = [];
  profileCalls = 0;

  constructor(private readonly script: FakeScript = {}) {}

  async getProfile(): Promise<GmailProfile> {
    const ids = this.script.historyIds ?? ['H1'];
    const value = ids[Math.min(this.profileCalls, ids.length - 1)]!;
    this.profileCalls += 1;
    return { historyId: value };
  }

  async listMessages(params: {
    q: string;
    maxResults: number;
    pageToken: string | null;
  }): Promise<GmailListMessagesResponse> {
    this.listCalls.push({ q: params.q, pageToken: params.pageToken });

    const fromAddresses = extractFromAddresses(params.q);
    const afterMs = extractAfterMs(params.q);
    const pool = [...(this.script.messages ?? []), ...(this.script.unrelatedMessages ?? [])];

    const matching = pool.filter((message) => {
      const from = headerValue(message, 'From').toLowerCase();
      if (!fromAddresses.has(from)) return false;
      if (afterMs !== null && Number(message.internalDate) < afterMs) return false;
      return true;
    });

    const all = matching.flatMap((message) => (this.script.duplicateIds ? [message.id, message.id] : [message.id]));
    const start = params.pageToken === null ? 0 : Number(params.pageToken);
    const size = Math.min(params.maxResults, this.script.pageLimit ?? params.maxResults);
    const slice = all.slice(start, start + size);
    const next = start + size < all.length ? String(start + size) : undefined;

    return { messages: slice.map((id) => ({ id })), ...(next === undefined ? {} : { nextPageToken: next }) };
  }

  async getMessage(id: string): Promise<GmailMessage | null> {
    this.getCalls.push(id);
    if (this.script.failGet?.has(id)) throw new Error(`Gmail 503 sur ${id}`);
    if (this.script.missingGet?.has(id)) return null;
    return (
      (this.script.messages ?? []).find((message) => message.id === id) ??
      (this.script.unrelatedMessages ?? []).find((message) => message.id === id) ??
      null
    );
  }
}

function providerFor(
  script: FakeScript = {},
  deps: { pageSize?: number; maxQueryClauseLength?: number } = {},
): { provider: GmailInboundProvider; api: FakeGmailApi } {
  const api = new FakeGmailApi(script);
  return { provider: new GmailInboundProvider({ api, ...deps }), api };
}

async function poll(
  script: FakeScript,
  maxMessages = 100,
  providerDeps: { pageSize?: number; maxQueryClauseLength?: number } = {},
): Promise<{ report: PollReport; api: FakeGmailApi }> {
  const { provider, api } = providerFor(script, providerDeps);
  const report = await pollInboundReplies(sql, provider, { mailbox: MAILBOX, maxMessages });
  return { report, api };
}

async function inboundRows(): Promise<
  { providerMessageId: string; correlationStatus: string; correlationMethod: string | null; manifestId: string | null }[]
> {
  return sql.query(
    `select provider_message_id as "providerMessageId", correlation_status as "correlationStatus",
            correlation_method as "correlationMethod", correlated_manifest_id::text as "manifestId"
       from r6b_inbound_messages order by received_at asc`,
  );
}

const SENT_AT = '2026-08-12T22:11:32.505Z';
const SENT_MS = Date.parse(SENT_AT);
const HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Ingestion et idempotence
// ---------------------------------------------------------------------------

describe('ingestion', () => {
  it('une réponse nouvelle donne exactement une ligne', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    const { report } = await poll({
      messages: [gmailMessage({ id: 'g1', from: 'prospect@example.com', internalDateMs: SENT_MS + HOUR })],
    });

    expect(report.persisted).toBe(1);
    expect(await inboundRows()).toHaveLength(1);
  });

  it('le même message Gmail ingéré deux fois donne une seule ligne', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });
    const messages = [gmailMessage({ id: 'g1', from: 'prospect@example.com', internalDateMs: SENT_MS + HOUR })];

    // Le marqueur de boîte bouge entre les deux tours : la requête est donc
    // bel et bien relancée et le message relu. Ce qui empêche le doublon est
    // l'index unique, pas le fait d'avoir évité la relecture.
    const first = await poll({ messages, historyIds: ['1000'] });
    const second = await poll({ messages, historyIds: ['2000'] });

    expect(first.report.persisted).toBe(1);
    expect(second.report.persisted).toBe(0);
    expect(second.report.alreadyKnown).toBe(1);
    expect(await inboundRows()).toHaveLength(1);
  });

  it('cent ingestions du même message donnent une seule ligne', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    const raw = toInboundRawMessage(
      gmailMessage({ id: 'g1', from: 'prospect@example.com', internalDateMs: SENT_MS + HOUR }),
    );
    const normalized = normalizeInboundMessage(raw);
    const sends = await loadOutboundSends(sql);
    const correlation = correlateInbound(normalized, sends, new Map());

    for (let i = 0; i < 100; i += 1) {
      await persistInboundMessage(sql, MAILBOX, normalized, correlation);
    }
    expect(await inboundRows()).toHaveLength(1);
  });

  it('des ingestions concurrentes du même message ne créent qu’une ligne', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    const normalized = normalizeInboundMessage(
      toInboundRawMessage(gmailMessage({ id: 'g-race', from: 'prospect@example.com', internalDateMs: SENT_MS + HOUR })),
    );
    const correlation = correlateInbound(normalized, await loadOutboundSends(sql), new Map());

    // La garantie ne vient pas d'un `select` préalable — deux appelants y
    // liraient tous deux « inconnu » — mais de l'index unique.
    const results = await Promise.all(
      Array.from({ length: 25 }, () => persistInboundMessage(sql, MAILBOX, normalized, correlation)),
    );

    expect(results.filter((result) => result.inserted)).toHaveLength(1);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(await inboundRows()).toHaveLength(1);
  });

  it('l’unicité est une contrainte de base, pas une vérification applicative', async () => {
    const rows = await sql.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where tablename = 'r6b_inbound_messages' and indexname = 'r6b_inbound_messages_provider_message_idx'`,
    );
    expect(rows[0]?.indexdef).toMatch(/CREATE UNIQUE INDEX/i);
  });

  it('des identifiants rendus en double par Gmail ne produisent qu’une ligne', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    const { report, api } = await poll({
      messages: [gmailMessage({ id: 'g1', from: 'prospect@example.com', internalDateMs: SENT_MS + HOUR })],
      duplicateIds: true,
    });

    expect(report.listedMessages).toBe(1);
    expect(api.getCalls).toEqual(['g1']);
    expect(await inboundRows()).toHaveLength(1);
  });

  it('ingère dans l’ordre des dates, quel que soit l’ordre rendu par Gmail', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    await poll({
      messages: [
        gmailMessage({ id: 'tard', from: 'prospect@example.com', internalDateMs: SENT_MS + 5 * HOUR }),
        gmailMessage({ id: 'tot', from: 'prospect@example.com', internalDateMs: SENT_MS + HOUR }),
      ],
    });

    expect((await inboundRows()).map((row) => row.providerMessageId)).toEqual(['tot', 'tard']);
    const checkpoint = await loadCheckpoint(sql, MAILBOX);
    expect(checkpoint?.lastMessageId).toBe('tard');
    expect(checkpoint?.lastInternalDateMs).toBe(SENT_MS + 5 * HOUR);
  });
});

// ---------------------------------------------------------------------------
// Corrélation, contre la vraie base
// ---------------------------------------------------------------------------

describe('corrélation', () => {
  it('EXACT quand la réponse cite le Message-ID RFC de l’envoi', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    const rfc = '<sortant-1@example.com>';
    const { outreachEventId } = await recordSend(manifest, { sentAt: SENT_AT, rfcMessageId: rfc });

    // Expéditeur = la contrepartie sortante elle-même : c'est le cas réel (le
    // client mail du prospect répond depuis son adresse). Qu'une identité RFC
    // l'emporte même sur un expéditeur INCONNU est une propriété pure de
    // `correlateInbound`, déjà couverte sans Gmail dans
    // `tests/r6bInboundParse.test.ts` — pas la peine de la rejouer ici derrière
    // une requête bornée qui, par construction, ne peut plus faire venir un
    // expéditeur inconnu jusqu'à la corrélation (R6B-D1.3).
    await poll({
      messages: [
        gmailMessage({
          id: 'g1',
          from: 'prospect@example.com',
          internalDateMs: SENT_MS + HOUR,
          inReplyTo: rfc,
        }),
      ],
    });

    const rows = await inboundRows();
    expect(rows[0]?.correlationStatus).toBe('EXACT');
    expect(rows[0]?.correlationMethod).toBe('rfc_in_reply_to');
    expect(rows[0]?.manifestId).toBe(manifest.id);

    const replies = await loadRepliesForManifest(sql, manifest.id);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.outreachEventId).toBe(outreachEventId);
  });

  it('HIGH_CONFIDENCE — jamais EXACT — sur le repli du premier envoi réel', async () => {
    // Le cas de production : l'email est parti avant qu'on sache lire le
    // Message-ID RFC chez le provider, donc `provider_rfc_message_id` est nul.
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT, rfcMessageId: null });

    await poll({
      messages: [
        gmailMessage({
          id: 'g1',
          from: 'prospect@example.com',
          subject: 'Re: Petite question pour ACME',
          internalDateMs: SENT_MS + HOUR,
        }),
      ],
    });

    const rows = await inboundRows();
    expect(rows[0]?.correlationStatus).toBe('HIGH_CONFIDENCE');
    expect(rows[0]?.correlationMethod).toBe('sole_outbound_recipient');
    expect(rows[0]?.manifestId).toBe(manifest.id);
  });

  it('REVIEW_REQUIRED dès qu’un second envoi vise la même adresse', async () => {
    // Les deux manifestes sont verrouillés AVANT le premier envoi. L'ordre
    // compte depuis R7-PILOT §1 : deux lignes qui partagent une adresse sont un
    // même commerce, et verrouiller la seconde APRÈS un envoi à la première
    // serait désormais refusé comme un double contact. Ce scénario n'éprouve
    // pas cette garde — il éprouve ce que l'inbound fait d'une ambiguïté
    // héritée, qui existe bel et bien dans le journal.
    const first = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    const second = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(first, { sentAt: SENT_AT });
    await recordSend(second, { sentAt: '2026-08-12T23:00:00.000Z' });

    await poll({
      messages: [
        gmailMessage({
          id: 'g1',
          from: 'prospect@example.com',
          subject: 'Re: Petite question pour ACME',
          internalDateMs: SENT_MS + 5 * HOUR,
        }),
      ],
    });

    const rows = await inboundRows();
    expect(rows[0]?.correlationStatus).toBe('REVIEW_REQUIRED');
    expect(rows[0]?.correlationMethod).toBe('ambiguous_outbound_candidates');
    // La base refuse qu'une non-conclusion désigne quoi que ce soit.
    expect(rows[0]?.manifestId).toBeNull();
  });

  it('un expéditeur qui n’est PAS une contrepartie sortante n’est jamais rendu par Gmail — pas ingéré, pas même UNMATCHED', async () => {
    // R6B-D1.3 — invariant vie privée : un message dont l'expéditeur n'a
    // jamais reçu d'envoi sortant n'a pas à avoir son corps lu pour qu'on
    // découvre après coup qu'il est hors sujet. La borne doit agir CÔTÉ
    // SERVEUR, dans `q` — c'est ce que `FakeGmailApi` vérifie réellement (elle
    // filtre par `from:`, comme le ferait Gmail), pas seulement le texte de la
    // requête construite.
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    const { report, api } = await poll({
      messages: [],
      unrelatedMessages: [
        gmailMessage({ id: 'newsletter-1', from: 'newsletter@brevo.com', internalDateMs: SENT_MS + HOUR }),
        gmailMessage({ id: 'linkedin-1', from: 'messages-noreply@linkedin.com', internalDateMs: SENT_MS + HOUR }),
      ],
    });

    expect(report.listedMessages).toBe(0);
    expect(report.persisted).toBe(0);
    // Le corps n'a jamais été demandé pour ces identifiants : privacy invariant.
    expect(api.getCalls).toHaveLength(0);
    expect(await inboundRows()).toHaveLength(0);

    for (const call of api.listCalls) {
      expect(call.q).not.toContain('brevo.com');
      expect(call.q).not.toContain('linkedin.com');
      expect(call.q).toContain('from:prospect@example.com');
    }
  });

  it('EXACT sur un jeton de réponse résolu en base', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    const { outreachEventId } = await recordSend(manifest, { sentAt: SENT_AT });
    const token = 'a1b2c3d4e5f6a7b8';
    await sql.query(
      `insert into r6b_reply_tokens (token, manifest_id, prospect_id, outreach_event_id)
       values ($1,$2,$3,$4)`,
      [token, manifest.id, manifest.prospectId, outreachEventId],
    );

    // Expéditeur = la contrepartie sortante : sous la requête bornée, seul un
    // expéditeur ayant reçu un envoi peut être fetché. Qu'un jeton résolu
    // l'emporte pour un tiers complètement étranger à l'envoi est une
    // propriété pure de `correlateInbound`, déjà couverte sans Gmail dans
    // `tests/r6bInboundParse.test.ts`.
    await poll({
      messages: [
        gmailMessage({
          id: 'g1',
          from: 'prospect@example.com',
          to: `reponse+ob_${token}@example.com`,
          deliveredTo: `reponse+ob_${token}@example.com`,
          subject: 'Une question',
          internalDateMs: SENT_MS + HOUR,
        }),
      ],
    });

    const rows = await inboundRows();
    expect(rows[0]?.correlationStatus).toBe('EXACT');
    expect(rows[0]?.correlationMethod).toBe('reply_token');
    expect(rows[0]?.manifestId).toBe(manifest.id);
  });

  it('un jeton absent de la base ne fait pas gagner un chemin fort — repli sur l’évidence disponible', async () => {
    // Avant R6B-D1.3, ce cas était démontré avec un expéditeur totalement
    // étranger à l'outbound, ce qu'une requête bornée ne peut plus faire
    // parvenir jusqu'à la corrélation. Rejoué ici avec la contrepartie réelle :
    // le jeton absent ne produit toujours PAS `EXACT` — le système retombe sur
    // le repli du §7 (un seul envoi vers cet expéditeur, mais ni objet ni
    // en-tête de réponse ne le confirme), qui est `REVIEW_REQUIRED`, jamais une
    // conclusion inventée.
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    await poll({
      messages: [
        gmailMessage({
          id: 'g1',
          from: 'prospect@example.com',
          to: 'reponse+ob_ffffffffffffffff@example.com',
          deliveredTo: 'reponse+ob_ffffffffffffffff@example.com',
          subject: 'Une question',
          internalDateMs: SENT_MS + HOUR,
        }),
      ],
    });

    const rows = await inboundRows();
    expect(rows[0]?.correlationStatus).not.toBe('EXACT');
    expect(rows[0]?.correlationStatus).toBe('REVIEW_REQUIRED');
    expect(rows[0]?.correlationMethod).toBe('recipient_without_reply_evidence');
    expect(rows[0]?.manifestId).toBeNull();
  });

  it('un jeton révoqué cesse de corréler — repli sur l’évidence disponible', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });
    const token = 'b1b2c3d4e5f6a7b8';
    await sql.query(
      `insert into r6b_reply_tokens (token, manifest_id, prospect_id, revoked_at)
       values ($1,$2,$3, now())`,
      [token, manifest.id, manifest.prospectId],
    );

    await poll({
      messages: [
        gmailMessage({
          id: 'g1',
          from: 'prospect@example.com',
          to: `reponse+ob_${token}@example.com`,
          deliveredTo: `reponse+ob_${token}@example.com`,
          subject: 'Une question',
          internalDateMs: SENT_MS + HOUR,
        }),
      ],
    });

    const rows = await inboundRows();
    expect(rows[0]?.correlationStatus).not.toBe('EXACT');
    expect(rows[0]?.correlationStatus).toBe('REVIEW_REQUIRED');
  });

  it('la base refuse une conclusion à moitié écrite', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    await expect(
      sql.query(
        `insert into r6b_inbound_messages
           (provider, mailbox, provider_message_id, received_at, from_address, normalized_subject,
            body_text, body_sha256, body_source, correlation_status, correlation_method, correlated_manifest_id)
         values ('gmail',$1,'forge', now(), 'x@y.fr','objet','', $2, 'none', 'EXACT', 'rfc_in_reply_to', $3)`,
        [MAILBOX, 'a'.repeat(64), manifest.id],
      ),
    ).rejects.toThrow(); // manifeste seul, sans outreach_event ni prospect

    await expect(
      sql.query(
        `insert into r6b_inbound_messages
           (provider, mailbox, provider_message_id, received_at, from_address, normalized_subject,
            body_text, body_sha256, body_source, correlation_status, correlated_manifest_id)
         values ('gmail',$1,'forge2', now(), 'x@y.fr','objet','', $2, 'none', 'REVIEW_REQUIRED', $3)`,
        [MAILBOX, 'a'.repeat(64), manifest.id],
      ),
    ).rejects.toThrow(); // une non-conclusion ne désigne rien
  });

  it('expose l’état des réponses à l’application', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    // Une seconde contrepartie, réelle elle aussi, dont l'envoi part APRÈS la
    // réception du message g2 : « connu de l'outbound » ne veut pas dire
    // « toute réponse de cette adresse se corrèle ». Ici, aucun envoi
    // n'existe encore vers elle au moment de g2 → UNMATCHED légitime, sans
    // qu'aucun expéditeur inconnu n'ait eu besoin d'être fetché.
    const second = await emailManifest('second-prospect@example.com', 'Petite question pour ACME 2');
    await recordSend(second, { sentAt: new Date(SENT_MS + 3 * HOUR).toISOString() });

    await poll({
      messages: [
        gmailMessage({
          id: 'g1',
          from: 'prospect@example.com',
          subject: 'Re: Petite question pour ACME',
          internalDateMs: SENT_MS + HOUR,
        }),
        gmailMessage({
          id: 'g2',
          from: 'second-prospect@example.com',
          internalDateMs: SENT_MS + 2 * HOUR,
        }),
      ],
    });

    const rows = await inboundRows();
    expect(rows.find((r) => r.providerMessageId === 'g2')?.correlationStatus).toBe('UNMATCHED');

    const summary = await loadInboundSummary(sql);
    expect(summary).toMatchObject({ total: 2, HIGH_CONFIDENCE: 1, UNMATCHED: 1, EXACT: 0 });
  });
});

// ---------------------------------------------------------------------------
// Corps
// ---------------------------------------------------------------------------

describe('corps', () => {
  it('persiste le texte multipart décodé et son empreinte', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    await poll({
      messages: [
        gmailMessage({
          id: 'g1',
          from: 'prospect@example.com',
          body: 'Oui, rappelez-moi jeudi.',
          internalDateMs: SENT_MS + HOUR,
        }),
      ],
    });

    const rows = await sql.query<{ bodyText: string; bodySource: string; bodySha256: string }>(
      `select body_text as "bodyText", body_source as "bodySource", body_sha256 as "bodySha256"
         from r6b_inbound_messages`,
    );
    expect(rows[0]?.bodyText).toBe('Oui, rappelez-moi jeudi.');
    expect(rows[0]?.bodySource).toBe('text/plain');
    expect(rows[0]?.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ingère un message sans corps lisible plutôt que de le perdre', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    // Un vrai DSN Gmail arrive `From: mailer-daemon@...`, une adresse qui n'a
    // jamais reçu d'envoi — donc, par construction de R6B-D1.3, jamais
    // fetchée. C'est un compromis assumé (rapporté dans le compte-rendu de
    // mission), pas un oubli : la détection de bounce redevient possible le
    // jour où une corrélation par `Message-ID` référencé suffit à l'atteindre
    // sans élargir `q`. Ici, l'expéditeur est la contrepartie elle-même — ce
    // que ce test vérifie est que la persistance NE PERD PAS un message dont
    // le corps est illisible, pas d'où viennent les vrais DSN.
    const message: GmailMessage = {
      id: 'vide',
      threadId: 't',
      internalDate: String(SENT_MS + HOUR),
      payload: {
        mimeType: 'multipart/report',
        headers: [
          { name: 'From', value: 'prospect@example.com' },
          { name: 'To', value: MAILBOX },
          { name: 'Subject', value: 'Delivery Status Notification (Failure)' },
          { name: 'Content-Type', value: 'multipart/report; report-type=delivery-status' },
          { name: 'Return-Path', value: '<>' },
        ],
        parts: [],
      },
    };

    await poll({ messages: [message] });

    const rows = await sql.query<{ bodySource: string; automationSignals: unknown; correlationStatus: string }>(
      `select body_source as "bodySource", automation_signals as "automationSignals",
              correlation_status as "correlationStatus" from r6b_inbound_messages`,
    );
    expect(rows[0]?.bodySource).toBe('none');
    // Ni objet correspondant ni en-tête de réponse : repli du §7 en
    // REVIEW_REQUIRED — mais la ligne existe, ce qui est ce que ce test vérifie.
    expect(rows[0]?.correlationStatus).toBe('REVIEW_REQUIRED');
    // Les indices sont persistés comme des faits, sans étiquette « bounce ».
    expect(rows[0]?.automationSignals).toEqual(
      expect.arrayContaining(['delivery_status_report', 'multipart_report', 'null_return_path']),
    );
  });
});

// ---------------------------------------------------------------------------
// Curseur
// ---------------------------------------------------------------------------

describe('curseur', () => {
  it('n’avance qu’après une persistance intégrale', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    const messages = [
      gmailMessage({ id: 'ok', from: 'prospect@example.com', internalDateMs: SENT_MS + HOUR }),
      gmailMessage({ id: 'ko', from: 'prospect@example.com', internalDateMs: SENT_MS + 2 * HOUR }),
    ];

    const failing = await poll({ messages, failGet: new Set(['ko']) });
    expect(failing.report.failures).toHaveLength(1);
    expect(failing.report.checkpointAdvanced).toBe(false);
    expect((await loadCheckpoint(sql, MAILBOX))?.historyId).toBeNull();

    // Le message manquant n'est pas perdu : le tour suivant le reprend, et le
    // premier n'est pas ré-inséré.
    const healed = await poll({ messages });
    expect(healed.report.persisted).toBe(1);
    expect(healed.report.alreadyKnown).toBe(1);
    expect(healed.report.checkpointAdvanced).toBe(true);
    expect((await inboundRows()).map((row) => row.providerMessageId)).toEqual(['ok', 'ko']);
  });

  it('compte un message disparu entre la liste et la lecture comme un échec', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    const { report } = await poll({
      messages: [gmailMessage({ id: 'parti', from: 'prospect@example.com', internalDateMs: SENT_MS + HOUR })],
      missingGet: new Set(['parti']),
    });
    expect(report.failures).toHaveLength(1);
    expect(report.checkpointAdvanced).toBe(false);
  });

  it('n’avance pas quand le plafond a tronqué la liste', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    const messages = Array.from({ length: 5 }, (_v, i) =>
      gmailMessage({ id: `g${i}`, from: 'prospect@example.com', internalDateMs: SENT_MS + (i + 1) * HOUR }),
    );
    const { report } = await poll({ messages, pageLimit: 2 }, 2);

    expect(report.truncated).toBe(true);
    expect(report.checkpointAdvanced).toBe(false);
    expect(report.persisted).toBe(2);
    expect((await loadCheckpoint(sql, MAILBOX))?.historyId).toBeNull();
  });

  it('pagine jusqu’au plafond sans tronquer quand tout tient', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    const messages = Array.from({ length: 5 }, (_v, i) =>
      gmailMessage({ id: `g${i}`, from: 'prospect@example.com', internalDateMs: SENT_MS + (i + 1) * HOUR }),
    );
    const { report, api } = await poll({ messages, pageLimit: 2 });

    expect(api.listCalls.length).toBeGreaterThan(1);
    expect(report.truncated).toBe(false);
    expect(report.persisted).toBe(5);
    expect(report.checkpointAdvanced).toBe(true);
  });

  it('ne relit rien quand le marqueur de boîte n’a pas bougé', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });
    const script: FakeScript = {
      messages: [gmailMessage({ id: 'g1', from: 'prospect@example.com', internalDateMs: SENT_MS + HOUR })],
      historyIds: ['H1'],
    };

    await poll(script);
    const second = await poll(script);

    expect(second.report.strategy).toBe('unchanged');
    expect(second.api.listCalls).toHaveLength(0);
    expect(await inboundRows()).toHaveLength(1);
  });

  it('signale un marqueur qui recule et resynchronise au lieu de sauter', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    await poll({ messages: [], historyIds: ['5000'] });
    expect((await loadCheckpoint(sql, MAILBOX))?.historyId).toBe('5000');

    // Un `historyId` ne peut pas décroître dans une boîte saine. Le dire, puis
    // relire quand même — la borne de lecture vient de la date, pas du marqueur.
    const { report } = await poll({
      messages: [gmailMessage({ id: 'g1', from: 'prospect@example.com', internalDateMs: SENT_MS + HOUR })],
      historyIds: ['4000'],
    });

    expect(report.checkpointInvalidated).toBe(true);
    expect(report.strategy).toBe('query');
    expect(report.persisted).toBe(1);
    const checkpoint = await loadCheckpoint(sql, MAILBOX);
    expect(checkpoint?.invalidationCount).toBe(1);
  });

  it('borne la première lecture au premier envoi, pas au début de la boîte', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    const { api } = await poll({ messages: [] });
    // 24 h de recouvrement sous l'envoi : `after:` de Gmail a une granularité
    // de jour, donc reprendre à la milliseconde perdrait les messages du jour.
    expect(api.listCalls[0]?.q).toContain('after:2026/08/11');
    // R6B-D1.3 : la borne est la contrepartie sortante, jamais la boîte lue.
    expect(api.listCalls[0]?.q).toContain('from:prospect@example.com');
    expect(api.listCalls[0]?.q).not.toContain(MAILBOX);
  });

  it('une seule contrepartie SENT → la requête ne borne que sur elle', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    const { api, report } = await poll({ messages: [] });
    expect(report.counterparties).toEqual(['prospect@example.com']);
    for (const call of api.listCalls) {
      expect(call.q).toBe('{from:prospect@example.com} -in:sent -in:draft -in:chats after:2026/08/11');
    }
  });

  it('plusieurs contreparties SENT → un OU borné aux deux, jamais plus large', async () => {
    const first = await emailManifest('prospect-a@example.com', 'Petite question pour ACME');
    await recordSend(first, { sentAt: SENT_AT });
    const second = await emailManifest('prospect-b@example.com', 'Petite question pour ACME');
    await recordSend(second, { sentAt: new Date(SENT_MS + HOUR).toISOString() });

    const { api, report } = await poll({ messages: [] });
    expect(new Set(report.counterparties)).toEqual(new Set(['prospect-a@example.com', 'prospect-b@example.com']));
    expect(api.listCalls).toHaveLength(1);
    expect(api.listCalls[0]?.q).toContain('from:prospect-a@example.com');
    expect(api.listCalls[0]?.q).toContain('from:prospect-b@example.com');
  });

  it('aucune contrepartie SENT connue → aucune requête Gmail, ni liste ni profil', async () => {
    // Aucun manifeste, aucun envoi : rien à corréler. `no_counterparties`
    // court-circuite avant même `getProfile()`.
    const { api, report } = await poll({ messages: [] });
    expect(report.strategy).toBe('no_counterparties');
    expect(report.listedMessages).toBe(0);
    expect(api.listCalls).toHaveLength(0);
    expect(api.profileCalls).toBe(0);
  });

  it('un grand nombre de contreparties se découpe en plusieurs requêtes, sans en omettre ni en dupliquer une', async () => {
    const recipients = Array.from({ length: 12 }, (_v, i) => `prospect-${i}@exemple-tres-longue-tres-longue.fr`);
    for (const [i, recipient] of recipients.entries()) {
      const manifest = await emailManifest(recipient, 'Petite question pour ACME');
      await recordSend(manifest, { sentAt: new Date(SENT_MS + i * HOUR).toISOString() });
    }

    // Borne artificiellement basse pour forcer plusieurs chunks sans avoir à
    // fabriquer des centaines d'adresses.
    const { api, report } = await poll({ messages: [] }, 100, { maxQueryClauseLength: 120 });

    expect(api.listCalls.length).toBeGreaterThan(1);
    expect(new Set(report.counterparties)).toEqual(new Set(recipients));

    const coveredAddresses = new Set(
      api.listCalls.flatMap((call) => [...call.q.matchAll(/from:([^\s}]+)/g)].map((m) => m[1]!)),
    );
    for (const recipient of recipients) expect(coveredAddresses.has(recipient)).toBe(true);
  });

  it('la déduplication des identifiants tient sur l’ensemble d’un poll multi-chunks', async () => {
    // Chaque contrepartie n'appartient qu'à UN chunk (le partitionnement se
    // fait sur les adresses `from:`), donc un même message ne peut pas être
    // rendu par deux chunks différents — son expéditeur n'en interroge qu'un
    // seul. Ce que ce test vérifie est l'invariant qui compte réellement :
    // même quand un poll tourne sur plusieurs chunks, la déduplication
    // (ici, Gmail rendant deux fois le même identifiant dans UNE page, ce
    // qu'il fait réellement) reste globale au tour entier, pas seulement au
    // chunk qui l'a produite.
    const first = await emailManifest('prospect-a@example.com', 'Petite question pour ACME');
    await recordSend(first, { sentAt: SENT_AT });
    const second = await emailManifest('prospect-b@example.com', 'Petite question pour ACME');
    await recordSend(second, { sentAt: new Date(SENT_MS + HOUR).toISOString() });

    const { report, api } = await poll(
      {
        messages: [
          gmailMessage({
            id: 'g1',
            from: 'prospect-a@example.com',
            subject: 'Re: Petite question pour ACME',
            internalDateMs: SENT_MS + 2 * HOUR,
          }),
        ],
        duplicateIds: true,
      },
      100,
      { maxQueryClauseLength: 30 }, // force prospect-a et prospect-b dans des chunks séparés
    );

    expect(api.listCalls.length).toBeGreaterThanOrEqual(2);
    expect(report.listedMessages).toBe(1);
    expect(report.persisted).toBe(1);
    expect(await inboundRows()).toHaveLength(1);
  });

  it('sans aucun envoi connu, se limite à une fenêtre courte', () => {
    const now = new Date('2026-08-13T00:00:00.000Z');
    const since = resolveSince(null, [], now);
    expect(since).not.toBeNull();
    const days = (now.getTime() - since!.getTime()) / (24 * HOUR);
    expect(days).toBeLessThanOrEqual(14);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed et surface
// ---------------------------------------------------------------------------

describe('accès', () => {
  it('sans identifiants, il n’existe pas de fournisseur dégradé', () => {
    // `env()` charge `.env` paresseusement, une seule fois par processus, et
    // seulement pour les clés absentes de `process.env` — un appel témoin ICI
    // force ce chargement pendant que les vraies clés Gmail (provisionnées en
    // amont pour la lecture réelle) sont encore présentes. Sans lui, si cet
    // appel de `readGmailCredentials()` était le tout premier du processus, la
    // suppression ci-dessous serait masquée : `.env` réinjecterait aussitôt
    // les clés qu'on vient d'effacer.
    readGmailCredentials();

    const saved: Record<string, string | undefined> = {};
    for (const key of Object.values(GMAIL_ENV_KEYS)) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      const result = readGmailCredentials();
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.missing).toEqual([...Object.values(GMAIL_ENV_KEYS)]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('ne rend que des noms de variables, jamais une valeur', () => {
    // La garantie porte sur le chemin d'ÉCHEC (`missing`, une liste de NOMS de
    // variables) — un succès rend forcément les identifiants (c'est pour ça
    // qu'on les lit). Ce test doit donc rester sur ce chemin : les 4 clés sont
    // absentes ici, `clientId` y compris malgré la valeur factice qu'on lui
    // donne, sans quoi un `.env` local réellement provisionné (le cas de ce
    // dépôt depuis le bootstrap OAuth Gmail) ferait passer `ok` à `true` et ce
    // test cesserait de vérifier ce qu'il prétend vérifier.
    readGmailCredentials(); // force le chargement de `.env` avant les suppressions
    const saved: Record<string, string | undefined> = {};
    for (const key of Object.values(GMAIL_ENV_KEYS)) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env[GMAIL_ENV_KEYS.clientId] = 'valeur-secrete-a-ne-jamais-divulguer';
    try {
      const result = readGmailCredentials();
      expect(result.ok).toBe(false);
      const rendered = JSON.stringify(result);
      expect(rendered).not.toContain('valeur-secrete-a-ne-jamais-divulguer');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('le fournisseur n’expose aucune primitive d’envoi ni d’écriture', () => {
    const { provider } = providerFor();
    const surface = [
      ...Object.getOwnPropertyNames(provider),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(provider)),
    ];
    for (const member of surface) {
      expect(member, `${member} ressemble à une écriture`).not.toMatch(
        /send|reply|draft|delete|trash|modify|archive|label|insert|markRead|untrash/i,
      );
    }
    expect(provider.capabilities.canSend).toBe(false);
    expect(provider.capabilities.canModifyMailbox).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Non-régression outbound (§15)
// ---------------------------------------------------------------------------

describe('non-régression outbound', () => {
  const inboundFiles = readdirSync(join(ROOT, 'src/lib/inbound'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(ROOT, 'src/lib/inbound', name));

  it('aucun appel sortant possible depuis le module entrant', () => {
    // Le nom du provider d'envoi peut apparaître dans un COMMENTAIRE — c'est
    // même souhaitable pour expliquer d'où vient un Message-ID. Ce qui est
    // interdit, c'est d'en importer le client, la clé ou l'URL.
    const forbidden = [
      /api\.resend\.com/i,
      /ResendProvider/,
      /from '@\/lib\/pipeline\/r6bLive/,
      /RESEND_API_KEY/,
      /OUTBOUND_ALLOW_SENDING/,
      /OUTBOUND_LIVE_MANIFEST_ID/,
      /OUTBOUND_EMAIL_FROM/,
      /nodemailer|sendgrid|twilio/i,
    ];
    for (const file of [...inboundFiles, join(ROOT, 'src/cli/r6b-inbound-poll.ts')]) {
      const body = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect(pattern.test(body), `${file} référence ${pattern}`).toBe(false);
      }
    }
  });

  it('le module entrant ne nomme que des hôtes Google', () => {
    const hosts = new Set<string>();
    for (const file of inboundFiles) {
      for (const match of readFileSync(file, 'utf8').matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        hosts.add(match[1]!.toLowerCase());
      }
    }
    // `www.googleapis.com` et `mail.google.com` n'apparaissent que dans des
    // URL de PORTÉES OAuth : ce sont des identifiants de portée, jamais des
    // points d'appel — et `mail.google.com` figure dans la liste des portées
    // REFUSÉES.
    expect([...hosts].sort()).toEqual([
      'gmail.googleapis.com',
      'mail.google.com',
      'oauth2.googleapis.com',
      'www.googleapis.com',
    ]);
  });

  it('les deux seuls points d’appel sont Gmail en lecture et le point de jetons', () => {
    const provider = readFileSync(join(ROOT, 'src/lib/inbound/gmailProvider.ts'), 'utf8');
    expect(provider).toContain("const GMAIL_BASE_URL = 'https://gmail.googleapis.com/gmail/v1'");
    expect(provider).toContain("const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'");
  });

  it('un seul POST dans tout le module entrant, et il va au point de jetons', () => {
    const posts = inboundFiles.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/method: 'POST'/g)]);
    expect(posts).toHaveLength(1);
    const provider = readFileSync(join(ROOT, 'src/lib/inbound/gmailProvider.ts'), 'utf8');
    // Le seul `request(...)` non-GET porte `this.tokenUrl` : rien ne peut
    // écrire vers Gmail lui-même.
    expect(provider).toMatch(/this\.http\.request\(this\.tokenUrl, \{\s*method: 'POST'/);
  });

  it('la garde d’envoi outbound est intacte', async () => {
    // Les constantes de la triple garde n'ont pas bougé, et le drapeau
    // d'envoi reste à zéro dans l'environnement de test.
    expect(R6B_LIVE_ARMED_MANIFEST_ID).toBe('a4f2f9d5-785c-4a91-8326-2828e77bf942');
    expect(process.env['OUTBOUND_ALLOW_SENDING'] ?? '0').toBe('0');
  });

  it('un tour de poll ne touche ni manifeste, ni outreach_event, ni tentative LIVE', async () => {
    const manifest = await emailManifest('prospect@example.com', 'Petite question pour ACME');
    await recordSend(manifest, { sentAt: SENT_AT });

    const before = await outboundFootprint();
    await poll({
      messages: [
        gmailMessage({ id: 'g1', from: 'prospect@example.com', internalDateMs: SENT_MS + HOUR }),
        gmailMessage({ id: 'g2', from: 'inconnu@ailleurs.fr', internalDateMs: SENT_MS + 2 * HOUR }),
      ],
    });
    const after = await outboundFootprint();

    expect(after).toEqual(before);
    expect(after.outreachEvents).toBe(1);
    expect(after.sent).toBe(1);
  });
});

/**
 * Empreinte de l'état outbound : les compteurs ET les empreintes de contenu.
 * Comparer seulement des compteurs laisserait passer une mutation de manifeste
 * à nombre de lignes constant.
 */
async function outboundFootprint(): Promise<Record<string, number | string>> {
  const rows = await sql.query<{
    outreachEvents: string;
    sent: string;
    manifests: string;
    manifestDigest: string | null;
    liveDigest: string | null;
  }>(
    `select (select count(*) from outreach_events)::text as "outreachEvents",
            (select count(*) from r6b_live_send_attempts where status = 'SENT')::text as "sent",
            (select count(*) from r6b_dispatch_manifests)::text as "manifests",
            (select md5(string_agg(t::text, '|' order by t.id))
               from r6b_dispatch_manifests t) as "manifestDigest",
            (select md5(string_agg(t::text, '|' order by t.id))
               from r6b_live_send_attempts t) as "liveDigest"`,
  );
  const row = rows[0]!;
  return {
    outreachEvents: Number(row.outreachEvents),
    sent: Number(row.sent),
    manifests: Number(row.manifests),
    manifestDigest: row.manifestDigest ?? '',
    liveDigest: row.liveDigest ?? '',
  };
}
