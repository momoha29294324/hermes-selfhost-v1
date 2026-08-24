import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { HttpClient } from '@/lib/http/client';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import { lockManifestForItem, type DispatchManifest } from '@/lib/pipeline/r6bDispatch';
import { completeEmailSubject } from '@/lib/pipeline/r6bManifestCompletion';
import { hashTransportPayload } from '@/lib/pipeline/r6bTransportPayload';
import {
  ResendProvider,
  type EmailProvider,
  type EmailSendRequest,
  type ProviderEmailRecord,
  type ProviderSendOutcome,
  type SenderIdentity,
} from '@/lib/pipeline/r6bLiveEmail';
import {
  backfillRfcMessageId,
  RfcBackfillBlockedError,
  type RfcBackfillBlockCode,
  type RfcBackfillExpectation,
} from '@/lib/pipeline/r6bRfcMessageBackfill';
import type { Sql } from '@/lib/db/sql';

/**
 * R6B-D1.1 — inscription de l'identité RFC 5322 d'un envoi déjà parti.
 *
 * Aucun test de ce fichier n'ouvre de connexion réseau, et aucun ne peut
 * envoyer : le faux provider lève sur `send`, donc un chemin de code qui
 * enverrait ferait échouer la suite au lieu de passer inaperçu.
 *
 * Adresses, objets et identifiants sont fictifs. Rien du prospect réel n'entre
 * dans ce dépôt.
 */

const TEXT = 'Bonjour, une question rapide sur vos créneaux de prestation.';
const SUBJECT = 'Petite question pour Acme';
const RECIPIENT = 'contact@acme-test.fr';
const PROVIDER_MESSAGE_ID = '11111111-2222-3333-4444-555555555555';
const RFC_MESSAGE_ID = '<abcdef01-2345@mail.example.com>';

const IDENTITY: SenderIdentity = Object.freeze({
  from: 'Prénom <expediteur@example.com>',
  replyTo: 'reponse@example.com',
});

let sql: Sql;
let dir: string;
let campaignId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-r6b-rfc-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);

  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-commercial-rfc-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
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
// Fixtures
// ---------------------------------------------------------------------------

/** Un manifeste email verrouillé et complété, construit par le vrai chemin humain. */
async function emailManifest(): Promise<DispatchManifest> {
  const prospect = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, email)
     values ($1,$2,'ACME ATELIER',$3) returning id`,
    [campaignId, `prospect-${randomUUID()}`, RECIPIENT],
  );
  const prospectId = prospect[0]!.id;
  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,'email',$2,'website','crawl','https://acme-test.fr',1.0)`,
    [prospectId, RECIPIENT],
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
    subject: SUBJECT,
    previewedTransportPayloadSha256: hashTransportPayload({ subject: SUBJECT }),
  });

  return completed.locked;
}

/**
 * Reproduit l'état laissé par le premier envoi réel : registre `SENT` avec son
 * reçu provider, `outreach_event` unique, et `provider_rfc_message_id` non
 * observé.
 */
async function recordSend(
  manifest: DispatchManifest,
  options: { rfcMessageId?: string | null } = {},
): Promise<{ liveAttemptId: string; outreachEventId: string }> {
  const live = await sql.query<{ id: string }>(
    `insert into r6b_live_send_attempts
       (manifest_id, provider, idempotency_key, transport, recipient,
        approved_text_sha256, transport_payload_sha256, provider_payload_sha256,
        provider_idempotency_expires_at, status, network_attempted, network_started_at,
        provider_message_id, provider_rfc_message_id, claimed_at, completed_at)
     values ($1,'resend',$2,'email',$3,$4,$5,$6, now() + interval '24 hours',
             'SENT', true, now(), $7, $8, now(), now())
     returning id`,
    [
      manifest.id,
      `r6b-c2b-first-touch-email/${manifest.id}`,
      manifest.recipient,
      manifest.approvedTextSha256,
      manifest.transportPayloadSha256,
      'f'.repeat(64),
      PROVIDER_MESSAGE_ID,
      options.rfcMessageId ?? null,
    ],
  );

  const event = await sql.query<{ id: string }>(
    `insert into outreach_events (prospect_id, kind, channel, payload, manifest_id)
     values ($1,'sent','email','{}'::jsonb,$2) returning id`,
    [manifest.prospectId, manifest.id],
  );

  return { liveAttemptId: live[0]!.id, outreachEventId: event[0]!.id };
}

// ---------------------------------------------------------------------------
// Faux provider — capable de relire, incapable d'envoyer
// ---------------------------------------------------------------------------

class FakeProvider implements EmailProvider {
  readonly name = 'resend' as const;
  readonly retrieveCalls: string[] = [];

  constructor(private readonly record: ProviderEmailRecord | null) {}

  async send(_request: EmailSendRequest, _idempotencyKey: string): Promise<ProviderSendOutcome> {
    throw new Error('le backfill ne doit JAMAIS envoyer');
  }

  async retrieve(providerMessageId: string): Promise<ProviderEmailRecord | null> {
    this.retrieveCalls.push(providerMessageId);
    if (this.record === null || this.record.id !== providerMessageId) return null;
    return this.record;
  }

  async listRecent(): Promise<readonly ProviderEmailRecord[]> {
    throw new Error('le backfill ne liste rien');
  }
}

function record(overrides: Partial<ProviderEmailRecord> = {}): ProviderEmailRecord {
  return Object.freeze({
    id: PROVIDER_MESSAGE_ID,
    to: [RECIPIENT],
    from: IDENTITY.from,
    subject: SUBJECT,
    rfcMessageId: RFC_MESSAGE_ID,
    createdAt: '2026-08-12T22:11:32.000Z',
    lastEvent: 'delivered',
    ...overrides,
  });
}

function expectation(manifest: DispatchManifest, overrides: Partial<RfcBackfillExpectation> = {}): RfcBackfillExpectation {
  return {
    manifestId: manifest.id,
    providerMessageId: PROVIDER_MESSAGE_ID,
    recipient: RECIPIENT,
    subject: SUBJECT,
    ...overrides,
  };
}

async function expectBlocked(promise: Promise<unknown>, code: RfcBackfillBlockCode): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `attendu un RfcBackfillBlockedError ${code}`).toBeInstanceOf(RfcBackfillBlockedError);
  expect((error as RfcBackfillBlockedError).code).toBe(code);
}

async function storedRfcId(manifestId: string): Promise<string | null> {
  const rows = await sql.query<{ value: string | null }>(
    `select provider_rfc_message_id as value from r6b_live_send_attempts where manifest_id = $1`,
    [manifestId],
  );
  return rows[0]?.value ?? null;
}

// ---------------------------------------------------------------------------

describe('backfill de l’identité RFC — remplir un NULL, jamais écraser une observation', () => {
  it('inscrit l’identité relue quand base, identité affirmée et provider concordent', async () => {
    const manifest = await emailManifest();
    const { liveAttemptId } = await recordSend(manifest);
    const provider = new FakeProvider(record());

    const result = await backfillRfcMessageId(sql, expectation(manifest), { provider, senderIdentity: IDENTITY });

    expect(result.status).toBe('BACKFILLED');
    expect(result.rfcMessageId).toBe(RFC_MESSAGE_ID);
    expect(result.rowsUpdated).toBe(1);
    expect(result.senderChecked).toBe(true);
    expect(result.liveAttemptId).toBe(liveAttemptId);
    // Exactement une lecture provider, et aucun envoi (le faux lèverait).
    expect(provider.retrieveCalls).toEqual([PROVIDER_MESSAGE_ID]);
    expect(await storedRfcId(manifest.id)).toBe(RFC_MESSAGE_ID);
  });

  it('ne touche ni le statut, ni le reçu provider, ni l’outreach_event', async () => {
    const manifest = await emailManifest();
    await recordSend(manifest);

    const before = await sql.query(
      `select status, provider_message_id, network_attempted, claimed_at, network_started_at,
              completed_at, approved_text_sha256, transport_payload_sha256, provider_payload_sha256,
              idempotency_key, failure_code, detail
         from r6b_live_send_attempts where manifest_id = $1`,
      [manifest.id],
    );
    const eventsBefore = await sql.query(`select id, kind, payload, occurred_at from outreach_events`);

    await backfillRfcMessageId(sql, expectation(manifest), {
      provider: new FakeProvider(record()),
      senderIdentity: IDENTITY,
    });

    const after = await sql.query(
      `select status, provider_message_id, network_attempted, claimed_at, network_started_at,
              completed_at, approved_text_sha256, transport_payload_sha256, provider_payload_sha256,
              idempotency_key, failure_code, detail
         from r6b_live_send_attempts where manifest_id = $1`,
      [manifest.id],
    );
    const eventsAfter = await sql.query(`select id, kind, payload, occurred_at from outreach_events`);

    expect(after).toEqual(before);
    expect(eventsAfter).toEqual(eventsBefore);
    expect(eventsAfter).toHaveLength(1);
  });

  it('est idempotent : la même valeur, deux fois, n’écrit qu’une fois', async () => {
    const manifest = await emailManifest();
    await recordSend(manifest);
    const provider = new FakeProvider(record());
    const deps = { provider, senderIdentity: IDENTITY };

    const first = await backfillRfcMessageId(sql, expectation(manifest), deps);
    const second = await backfillRfcMessageId(sql, expectation(manifest), deps);

    expect(first.status).toBe('BACKFILLED');
    expect(first.rowsUpdated).toBe(1);
    expect(second.status).toBe('ALREADY_PRESENT');
    expect(second.rowsUpdated).toBe(0);
    expect(second.rfcMessageId).toBe(RFC_MESSAGE_ID);
    expect(await storedRfcId(manifest.id)).toBe(RFC_MESSAGE_ID);
  });

  it('bloque quand une AUTRE identité RFC est déjà inscrite', async () => {
    const manifest = await emailManifest();
    await recordSend(manifest, { rfcMessageId: '<deja-la@mail.example.com>' });

    await expectBlocked(
      backfillRfcMessageId(sql, expectation(manifest), {
        provider: new FakeProvider(record()),
        senderIdentity: IDENTITY,
      }),
      'RFC_MESSAGE_ID_CONFLICT',
    );

    expect(await storedRfcId(manifest.id)).toBe('<deja-la@mail.example.com>');
  });
});

describe('identité affirmée — un écart bloque AVANT le réseau', () => {
  it('bloque sur un destinataire attendu différent, sans interroger le provider', async () => {
    const manifest = await emailManifest();
    await recordSend(manifest);
    const provider = new FakeProvider(record());

    await expectBlocked(
      backfillRfcMessageId(sql, expectation(manifest, { recipient: 'quelquun-dautre@example.com' }), {
        provider,
        senderIdentity: IDENTITY,
      }),
      'RECIPIENT_MISMATCH',
    );

    expect(provider.retrieveCalls).toHaveLength(0);
    expect(await storedRfcId(manifest.id)).toBeNull();
  });

  it('bloque sur un objet attendu différent, sans interroger le provider', async () => {
    const manifest = await emailManifest();
    await recordSend(manifest);
    const provider = new FakeProvider(record());

    await expectBlocked(
      backfillRfcMessageId(sql, expectation(manifest, { subject: 'Un autre objet' }), {
        provider,
        senderIdentity: IDENTITY,
      }),
      'SUBJECT_MISMATCH',
    );

    expect(provider.retrieveCalls).toHaveLength(0);
    expect(await storedRfcId(manifest.id)).toBeNull();
  });

  it('bloque sur un identifiant provider attendu différent, sans interroger le provider', async () => {
    const manifest = await emailManifest();
    await recordSend(manifest);
    const provider = new FakeProvider(record());

    await expectBlocked(
      backfillRfcMessageId(sql, expectation(manifest, { providerMessageId: '99999999-0000-0000-0000-000000000000' }), {
        provider,
        senderIdentity: IDENTITY,
      }),
      'PROVIDER_MESSAGE_ID_MISMATCH',
    );

    expect(provider.retrieveCalls).toHaveLength(0);
    expect(await storedRfcId(manifest.id)).toBeNull();
  });

  it('bloque quand aucun envoi confirmé n’existe pour ce manifeste', async () => {
    const manifest = await emailManifest();
    const provider = new FakeProvider(record());

    await expectBlocked(
      backfillRfcMessageId(sql, expectation(manifest), { provider, senderIdentity: IDENTITY }),
      'NO_SENT_ATTEMPT',
    );
    expect(provider.retrieveCalls).toHaveLength(0);
  });
});

describe('relecture provider — ce qui revient doit être notre envoi', () => {
  it('bloque quand le provider ne connaît pas l’identifiant', async () => {
    const manifest = await emailManifest();
    await recordSend(manifest);

    await expectBlocked(
      backfillRfcMessageId(sql, expectation(manifest), {
        provider: new FakeProvider(null),
        senderIdentity: IDENTITY,
      }),
      'PROVIDER_RECORD_NOT_FOUND',
    );
    expect(await storedRfcId(manifest.id)).toBeNull();
  });

  it('bloque quand la relecture vise un autre destinataire', async () => {
    const manifest = await emailManifest();
    await recordSend(manifest);

    await expectBlocked(
      backfillRfcMessageId(sql, expectation(manifest), {
        provider: new FakeProvider(record({ to: ['autre@example.com'] })),
        senderIdentity: IDENTITY,
      }),
      'PROVIDER_RECIPIENT_MISMATCH',
    );
    expect(await storedRfcId(manifest.id)).toBeNull();
  });

  it('bloque quand la relecture porte un destinataire de plus', async () => {
    const manifest = await emailManifest();
    await recordSend(manifest);

    await expectBlocked(
      backfillRfcMessageId(sql, expectation(manifest), {
        provider: new FakeProvider(record({ to: [RECIPIENT, 'copie@example.com'] })),
        senderIdentity: IDENTITY,
      }),
      'PROVIDER_RECIPIENT_MISMATCH',
    );
    expect(await storedRfcId(manifest.id)).toBeNull();
  });

  it('bloque quand la relecture porte un autre objet', async () => {
    const manifest = await emailManifest();
    await recordSend(manifest);

    await expectBlocked(
      backfillRfcMessageId(sql, expectation(manifest), {
        provider: new FakeProvider(record({ subject: 'Objet inattendu' })),
        senderIdentity: IDENTITY,
      }),
      'PROVIDER_SUBJECT_MISMATCH',
    );
    expect(await storedRfcId(manifest.id)).toBeNull();
  });

  it('bloque quand la relecture vient d’un autre expéditeur', async () => {
    const manifest = await emailManifest();
    await recordSend(manifest);

    await expectBlocked(
      backfillRfcMessageId(sql, expectation(manifest), {
        provider: new FakeProvider(record({ from: 'Quelqu’un <inconnu@example.com>' })),
        senderIdentity: IDENTITY,
      }),
      'PROVIDER_SENDER_MISMATCH',
    );
    expect(await storedRfcId(manifest.id)).toBeNull();
  });

  it('accepte un expéditeur non exposé, et le DIT au lieu de le compter comme vérifié', async () => {
    const manifest = await emailManifest();
    await recordSend(manifest);

    const result = await backfillRfcMessageId(sql, expectation(manifest), {
      provider: new FakeProvider(record({ from: null })),
      senderIdentity: IDENTITY,
    });

    expect(result.status).toBe('BACKFILLED');
    expect(result.senderChecked).toBe(false);
    expect(await storedRfcId(manifest.id)).toBe(RFC_MESSAGE_ID);
  });

  // CLAUDE.md, interdit n°2 : « non observé » reste NULL, jamais reconstruit.
  it('laisse la colonne NULL quand le provider n’expose aucun message_id', async () => {
    const manifest = await emailManifest();
    await recordSend(manifest);

    await expectBlocked(
      backfillRfcMessageId(sql, expectation(manifest), {
        provider: new FakeProvider(record({ rfcMessageId: null })),
        senderIdentity: IDENTITY,
      }),
      'RFC_MESSAGE_ID_ABSENT',
    );
    expect(await storedRfcId(manifest.id)).toBeNull();
  });

  it('bloque sur un message_id qui n’a pas la forme d’un msg-id RFC 5322', async () => {
    const manifest = await emailManifest();
    await recordSend(manifest);

    await expectBlocked(
      backfillRfcMessageId(sql, expectation(manifest), {
        provider: new FakeProvider(record({ rfcMessageId: 'pas-un-message-id' })),
        senderIdentity: IDENTITY,
      }),
      'RFC_MESSAGE_ID_MALFORMED',
    );
    expect(await storedRfcId(manifest.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lecture du champ chez le provider réel — sans réseau
// ---------------------------------------------------------------------------

describe('ResendProvider.retrieve — `message_id` et `id` sont deux champs distincts', () => {
  it('lit `message_id` et `from` de la réponse, sans les confondre avec `id`', async () => {
    const calls: string[] = [];
    const http = new HttpClient({
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return new Response(
          JSON.stringify({
            object: 'email',
            id: PROVIDER_MESSAGE_ID,
            to: [RECIPIENT],
            from: IDENTITY.from,
            subject: SUBJECT,
            message_id: RFC_MESSAGE_ID,
            created_at: '2026-08-12T22:11:32.000Z',
            last_event: 'delivered',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });

    const provider = new ResendProvider({ apiKey: 'cle-de-test', http });
    const found = await provider.retrieve(PROVIDER_MESSAGE_ID);

    expect(calls).toEqual([`https://api.resend.com/emails/${PROVIDER_MESSAGE_ID}`]);
    expect(found?.id).toBe(PROVIDER_MESSAGE_ID);
    expect(found?.rfcMessageId).toBe(RFC_MESSAGE_ID);
    expect(found?.from).toBe(IDENTITY.from);
    expect(found?.subject).toBe(SUBJECT);
  });

  it('rend `null` sur un `message_id` absent plutôt qu’une chaîne vide', async () => {
    const http = new HttpClient({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ id: PROVIDER_MESSAGE_ID, to: [RECIPIENT], subject: SUBJECT }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });

    const found = await new ResendProvider({ apiKey: 'cle-de-test', http }).retrieve(PROVIDER_MESSAGE_ID);

    expect(found?.rfcMessageId).toBeNull();
    expect(found?.from).toBeNull();
  });
});
