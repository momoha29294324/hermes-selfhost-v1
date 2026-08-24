import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import { lockManifestForItem, loadManifestById, type DispatchManifest } from '@/lib/pipeline/r6bDispatch';
import { completeEmailSubject } from '@/lib/pipeline/r6bManifestCompletion';
import { DispatchBlockedError, type DispatchBlockCode } from '@/lib/pipeline/r6bDispatcher';
import {
  dispatchManifestLive,
  evaluateLiveGate,
  reconcileLiveAttempt,
  R6B_LIVE_ARMED_MANIFEST_ID,
  R6B_LIVE_ARMED_TRANSPORT,
  type LiveDispatchDeps,
  type LiveEnvironment,
  type ReconcileDeps,
} from '@/lib/pipeline/r6bLiveDispatch';
import {
  buildEmailSendRequest,
  classifySendResult,
  deriveIdempotencyKey,
  hashProviderPayload,
  EMAIL_SEND_REQUEST_FIELDS,
  PROVIDER_IDEMPOTENCY_WINDOW_MS,
  extractEmailAddress,
  validateSenderIdentity,
  type EmailProvider,
  type EmailSendRequest,
  type ProviderEmailRecord,
  type ProviderSendOutcome,
  type SenderIdentity,
} from '@/lib/pipeline/r6bLiveEmail';
import { hashTransportPayload } from '@/lib/pipeline/r6bTransportPayload';
import type { Sql } from '@/lib/db/sql';

/**
 * R6B-C.2B — porte d'envoi réel à manifeste unique.
 *
 * Aucun test de ce fichier n'ouvre de connexion réseau : le provider est
 * toujours un faux, injecté, et `dispatchManifestLive` n'en construit jamais
 * aucun de lui-même (il l'exige en paramètre — c'est ce qui rend l'oubli
 * impossible plutôt qu'improbable).
 *
 * Le manifeste de test porte volontairement l'identifiant réellement armé :
 * la triple garde est ainsi exercée telle qu'elle sera exécutée, sans réglage
 * de test qui l'assouplirait. Son texte, son objet et son destinataire, eux,
 * sont fictifs — rien du prospect réel n'entre dans ce dépôt.
 */

const ROOT = resolve(__dirname, '..');
const TEXT = 'Bonjour, une question rapide sur vos créneaux de prestation.';
const SUBJECT = 'Petite question rapide';
const RECIPIENT = 'contact@acme-test.fr';

const IDENTITY: SenderIdentity = Object.freeze({
  from: 'Prénom <expediteur@example.com>',
  replyTo: 'reponse@example.com',
});

/**
 * La cible ARMÉE, pour les tests seulement.
 *
 * Le dépôt livré n'arme aucun manifeste (`R6B_LIVE_ARMED_MANIFEST_ID === ''`),
 * ce qui est le bon défaut mais rendrait le chemin armé inexerçable. Cette
 * constante l'ouvre pour la suite, et pour elle seule : aucun module de
 * production ne passe `armedManifestId`, ce qu'un test ci-dessous vérifie en
 * relisant les sources.
 */
const TEST_ARMED_MANIFEST_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const ARMED_ENVIRONMENT: LiveEnvironment = Object.freeze({
  allowSending: true,
  liveManifestId: TEST_ARMED_MANIFEST_ID,
  armedManifestId: TEST_ARMED_MANIFEST_ID,
});

let sql: Sql;
let dir: string;
let campaignId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-r6b-live-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);

  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-campaign-test', 'Test', 'example-services', '{}'],
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

/**
 * Construit un manifeste email complet par le vrai chemin humain — vote,
 * lock, puis complétion de l'objet — et lui donne enfin l'identifiant armé.
 *
 * La ré-identification est le seul artifice : elle permet d'exercer la garde
 * avec l'identifiant réel plutôt que d'ajouter au code une porte de test qui
 * accepterait un autre manifeste. Le contenu, lui, sort du pipeline normal.
 */
async function armedManifest(): Promise<DispatchManifest> {
  const prospect = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, email)
     values ($1,$2,'ACME ATELIER',$3) returning id`,
    [campaignId, `prospect-${Math.random()}`, RECIPIENT],
  );
  const prospectId = prospect[0]!.id;
  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,'email',$2,'website','crawl','https://acme-test.fr',1.0)`,
    [prospectId, RECIPIENT],
  );

  const batch = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
    [`batch-${Math.random()}`, campaignId],
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
    previewedTransportPayloadSha256: hashSubject(SUBJECT),
  });

  await reidentify(completed.locked.id, TEST_ARMED_MANIFEST_ID);

  const manifest = await loadManifestById(sql, TEST_ARMED_MANIFEST_ID);
  expect(manifest, 'le manifeste armé doit exister après ré-identification').not.toBeNull();
  return manifest!;
}

/**
 * FK `superseded_by` différée (0019) : les deux mises à jour sont validées
 * ensemble, donc l'état intermédiaire n'est jamais observable.
 */
async function reidentify(from: string, to: string): Promise<void> {
  await sql.transaction(async (tx) => {
    await tx.query('update r6b_dispatch_manifests set id = $2 where id = $1', [from, to]);
    await tx.query('update r6b_dispatch_manifests set superseded_by = $2 where superseded_by = $1', [from, to]);
  });
}

/**
 * Passe par la même sérialisation canonique que le domaine plutôt que par une
 * constante recopiée : un changement de canonicalisation doit faire échouer le
 * test, pas le contourner.
 */
function hashSubject(subject: string): string {
  return hashTransportPayload({ subject });
}

interface FakeScript {
  readonly outcome?: ProviderSendOutcome;
  /** Issues successives, pour exercer un rejeu borné. Prioritaire sur `outcome`. */
  readonly outcomes?: readonly ProviderSendOutcome[];
  readonly gate?: Promise<void>;
  readonly records?: readonly ProviderEmailRecord[];
}

class FakeProvider implements EmailProvider {
  readonly name = 'resend' as const;
  readonly sendCalls: { request: EmailSendRequest; idempotencyKey: string }[] = [];
  readonly retrieveCalls: string[] = [];
  listCalls = 0;

  constructor(private readonly script: FakeScript = {}) {}

  async send(request: EmailSendRequest, idempotencyKey: string): Promise<ProviderSendOutcome> {
    this.sendCalls.push({ request, idempotencyKey });
    if (this.script.gate) await this.script.gate;
    const scripted = this.script.outcomes;
    if (scripted !== undefined && scripted.length > 0) {
      // La dernière issue scriptée persiste : un test qui borne à 3 rejeux ne
      // doit pas dépendre du nombre exact d'entrées écrites ici.
      return scripted[Math.min(this.sendCalls.length - 1, scripted.length - 1)]!;
    }
    return this.script.outcome ?? { status: 'SENT', providerMessageId: 'msg-fake-0001' };
  }

  async retrieve(providerMessageId: string): Promise<ProviderEmailRecord | null> {
    this.retrieveCalls.push(providerMessageId);
    return this.script.records?.find((record) => record.id === providerMessageId) ?? null;
  }

  async listRecent(limit: number): Promise<readonly ProviderEmailRecord[]> {
    this.listCalls += 1;
    return (this.script.records ?? []).slice(0, limit);
  }
}

function deps(provider: EmailProvider): LiveDispatchDeps {
  return { provider, senderIdentity: IDENTITY };
}

async function expectBlocked(promise: Promise<unknown>, code: DispatchBlockCode): Promise<DispatchBlockedError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `attendu un DispatchBlockedError ${code}`).toBeInstanceOf(DispatchBlockedError);
  const blocked = error as DispatchBlockedError;
  expect(blocked.code).toBe(code);
  return blocked;
}

async function counts(): Promise<{ outreach: number; sent: number; network: number; live: number }> {
  const rows = await sql.query<{ outreach: string; sent: string; network: string; live: string }>(
    `select (select count(*)::text from outreach_events) as outreach,
            (select count(*)::text from r6b_dispatch_attempts where sent = true) as sent,
            (select count(*)::text from r6b_dispatch_attempts where network_attempted = true) as network,
            (select count(*)::text from r6b_live_send_attempts where status = 'SENT') as live`,
  );
  const row = rows[0]!;
  return {
    outreach: Number(row.outreach),
    sent: Number(row.sent),
    network: Number(row.network),
    live: Number(row.live),
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error(`condition jamais atteinte : ${label}`);
}

// ---------------------------------------------------------------------------
// Triple garde
// ---------------------------------------------------------------------------

describe('triple garde — quatre conditions simultanées, aucune facultative', () => {
  it('AUCUN module de production ne passe la cible armée de test', () => {
    // `armedManifestId` existe pour que cette suite puisse exercer le chemin
    // armé alors que le dépôt n'arme rien. C'est une porte dérobée acceptable
    // à une condition : que la production ne l'emprunte jamais. Ce test la
    // vérifie en relisant les sources plutôt qu'en faisant confiance.
    const root = resolve(__dirname, '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = join(dir, entry.name);
        if (entry.isDirectory()) { walk(child); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const source = readFileSync(child, 'utf8');
        // La DÉCLARATION du champ est légitime ; le PASSER ne l'est pas.
        if (/armedManifestId\s*:/u.test(source) && !child.endsWith('r6bLiveDispatch.ts')) {
          offenders.push(child);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('cette édition ne livre AUCUN manifeste armé', () => {
    // L'état de repos, et il est opposable : tant que cette constante est
    // vide, aucune combinaison de mode, de variable d'environnement et
    // d'argument ne peut armer un envoi. Armer demande un diff relu.
    expect(R6B_LIVE_ARMED_MANIFEST_ID).toBe('');
    expect(R6B_LIVE_ARMED_TRANSPORT).toBe('email');
  });

  it('rien n’est armable tant que la constante est vide — quoi qu’on passe', () => {
    for (const envManifestId of [undefined, '', '00000000-0000-4000-8000-000000000012']) {
      for (const requestedManifestId of ['', '00000000-0000-4000-8000-000000000012']) {
        const verdict = evaluateLiveGate({
          mode: 'LIVE',
          allowSending: true,
          envManifestId,
          requestedManifestId,
        });
        expect(verdict, `${String(envManifestId)}/${requestedManifestId}`).toEqual(
          expect.objectContaining({ armed: false, code: 'LIVE_MANIFEST_NOT_ARMED' }),
        );
      }
    }
  });

  const armed = {
    mode: 'LIVE',
    allowSending: true,
    envManifestId: TEST_ARMED_MANIFEST_ID,
    requestedManifestId: TEST_ARMED_MANIFEST_ID,
    armedManifestId: TEST_ARMED_MANIFEST_ID,
  } as const;

  it('n’arme que si les quatre concordent', () => {
    expect(evaluateLiveGate(armed)).toEqual({ armed: true });
  });

  it('refuse un mode qui n’est pas LIVE', () => {
    for (const mode of ['DRY_RUN', 'RECONCILE', '', 'live']) {
      const verdict = evaluateLiveGate({ ...armed, mode });
      expect(verdict, mode).toEqual(expect.objectContaining({ armed: false, code: 'LIVE_MODE_REQUIRED' }));
    }
  });

  it('refuse tant que OUTBOUND_ALLOW_SENDING n’est pas à 1', () => {
    expect(evaluateLiveGate({ ...armed, allowSending: false })).toEqual(
      expect.objectContaining({ armed: false, code: 'LIVE_SENDING_DISABLED' }),
    );
  });

  it('refuse si OUTBOUND_LIVE_MANIFEST_ID est absent ou désigne autre chose', () => {
    for (const envManifestId of [undefined, '', '   ', '00000000-0000-4000-8000-000000000011']) {
      const verdict = evaluateLiveGate({ ...armed, envManifestId });
      expect(verdict, String(envManifestId)).toEqual(
        expect.objectContaining({ armed: false, code: 'LIVE_MANIFEST_NOT_ARMED' }),
      );
    }
  });

  it('refuse si la ligne de commande ne demande pas exactement le manifeste armé', () => {
    for (const requestedManifestId of [
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-0000-0000-000000000000',
      `${R6B_LIVE_ARMED_MANIFEST_ID}x`,
      '',
    ]) {
      const verdict = evaluateLiveGate({ ...armed, requestedManifestId });
      expect(verdict, requestedManifestId).toEqual(
        expect.objectContaining({ armed: false, code: 'LIVE_MANIFEST_MISMATCH' }),
      );
    }
  });

  it('refuse avant tout réseau, et le journalise ainsi', async () => {
    await armedManifest();
    const provider = new FakeProvider();

    for (const environment of [
      { allowSending: false, liveManifestId: TEST_ARMED_MANIFEST_ID, armedManifestId: TEST_ARMED_MANIFEST_ID },
      { allowSending: true, liveManifestId: undefined, armedManifestId: TEST_ARMED_MANIFEST_ID },
      { allowSending: true, liveManifestId: '00000000-0000-4000-8000-000000000011', armedManifestId: TEST_ARMED_MANIFEST_ID },
    ] satisfies LiveEnvironment[]) {
      await expect(
        dispatchManifestLive(sql, R6B_LIVE_ARMED_MANIFEST_ID, deps(provider), environment),
      ).rejects.toBeInstanceOf(DispatchBlockedError);
    }

    expect(provider.sendCalls).toHaveLength(0);
    const rows = await sql.query<{ status: string; network: boolean }>(
      `select status, network_attempted as network from r6b_dispatch_attempts`,
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === 'BLOCKED' && row.network === false)).toBe(true);
    expect(await counts()).toEqual({ outreach: 0, sent: 0, network: 0, live: 0 });
  });

  it('les autres manifestes verrouillés restent inatteignables, même armés en .env', async () => {
    const manifest = await armedManifest();
    // Le même manifeste, complet et verrouillé, sous un autre identifiant :
    // exactement la situation des quatre autres manifestes du pilote.
    await reidentify(manifest.id, '11111111-2222-3333-4444-555555555555');
    const provider = new FakeProvider();

    // Même en prétendant l'armer par l'environnement, la constante du code
    // refuse : `.env` ne peut pas désigner un autre manifeste.
    await expectBlocked(
      dispatchManifestLive(sql, '11111111-2222-3333-4444-555555555555', deps(provider), {
        allowSending: true,
        liveManifestId: '11111111-2222-3333-4444-555555555555',
        armedManifestId: TEST_ARMED_MANIFEST_ID,
      }),
      'LIVE_MANIFEST_NOT_ARMED',
    );
    expect(provider.sendCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Payload exact
// ---------------------------------------------------------------------------

describe('payload — exactement ce que le manifeste porte, rien de plus', () => {
  it('n’envoie que from, to, reply_to, subject, text', async () => {
    const manifest = await armedManifest();
    const provider = new FakeProvider();
    await dispatchManifestLive(sql, manifest.id, deps(provider), ARMED_ENVIRONMENT);

    const call = provider.sendCalls[0]!;
    expect(Object.keys(call.request).sort()).toEqual([...EMAIL_SEND_REQUEST_FIELDS].sort());
    expect(call.request).toEqual({
      from: IDENTITY.from,
      to: RECIPIENT,
      reply_to: IDENTITY.replyTo,
      subject: SUBJECT,
      text: TEXT,
    });
  });

  it('n’ajoute ni signature, ni pied de page, ni pixel, ni variante HTML', async () => {
    const manifest = await armedManifest();
    const provider = new FakeProvider();
    await dispatchManifestLive(sql, manifest.id, deps(provider), ARMED_ENVIRONMENT);

    const serialized = JSON.stringify(provider.sendCalls[0]!.request);
    expect(provider.sendCalls[0]!.request.text).toBe(manifest.approvedText);
    expect(serialized).not.toMatch(/html|<img|<a |tracking|unsubscribe|désinscri|Envoyé (par|via)/i);
  });

  it('le destinataire vient du manifeste, jamais de l’appelant', () => {
    // `buildEmailSendRequest` n'a que deux entrées : l'enveloppe figée et
    // l'identité d'expéditeur. Il n'existe aucun paramètre pour un
    // destinataire, un objet, un corps ou un transport.
    expect(buildEmailSendRequest.length).toBe(2);
    const source = readFileSync(resolve(ROOT, 'src/lib/pipeline/r6bLiveDispatch.ts'), 'utf8');
    for (const forbidden of ['deps.to', 'deps.subject', 'deps.body', 'deps.text', 'deps.recipient', 'deps.transport']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('refuse de construire un payload sans objet approuvé', async () => {
    const manifest = await armedManifest();
    await sql.query(
      `update r6b_dispatch_manifests
          set transport_payload = '{}'::jsonb,
              transport_payload_sha256 = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
        where id = $1`,
      [manifest.id],
    );
    const provider = new FakeProvider();
    await expectBlocked(
      dispatchManifestLive(sql, manifest.id, deps(provider), ARMED_ENVIRONMENT),
      'LIVE_MANIFEST_NOT_READY',
    );
    expect(provider.sendCalls).toHaveLength(0);
  });

  it('refuse une identité d’expéditeur absente ou mal formée', async () => {
    const manifest = await armedManifest();
    const provider = new FakeProvider();
    await expectBlocked(
      dispatchManifestLive(
        sql,
        manifest.id,
        { provider, senderIdentity: { from: 'pas une adresse', replyTo: IDENTITY.replyTo } },
        ARMED_ENVIRONMENT,
      ),
      'SENDER_IDENTITY_INVALID',
    );
    expect(provider.sendCalls).toHaveLength(0);
  });

  it('applique au LIVE toutes les vérifications d’intégrité du DRY_RUN', async () => {
    const manifest = await armedManifest();
    await sql.query(`update r6b_dispatch_manifests set approved_text = $2 where id = $1`, [
      manifest.id,
      `${TEXT} (phrase ajoutée après approbation)`,
    ]);
    const provider = new FakeProvider();
    await expectBlocked(
      dispatchManifestLive(sql, manifest.id, deps(provider), ARMED_ENVIRONMENT),
      'APPROVED_TEXT_SHA_MISMATCH',
    );
    expect(provider.sendCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

describe('idempotence — clé déterministe dérivée du seul manifeste', () => {
  it('est stable, propre au manifeste et au format documenté', () => {
    const key = deriveIdempotencyKey(TEST_ARMED_MANIFEST_ID);
    expect(key).toBe(deriveIdempotencyKey(TEST_ARMED_MANIFEST_ID));
    expect(key).toContain(TEST_ARMED_MANIFEST_ID);
    expect(key).not.toBe(deriveIdempotencyKey('00000000-0000-0000-0000-000000000000'));
    expect(key.length).toBeGreaterThanOrEqual(1);
    expect(key.length).toBeLessThanOrEqual(256);
    expect(key).toMatch(/^[a-z0-9-]+\/[0-9a-f-]+$/);
  });

  it('est transmise telle quelle au provider et enregistrée', async () => {
    const manifest = await armedManifest();
    const provider = new FakeProvider();
    const result = await dispatchManifestLive(sql, manifest.id, deps(provider), ARMED_ENVIRONMENT);

    expect(provider.sendCalls[0]!.idempotencyKey).toBe(deriveIdempotencyKey(manifest.id));
    expect(result.idempotencyKey).toBe(deriveIdempotencyKey(manifest.id));
    const rows = await sql.query<{ key: string }>(
      `select idempotency_key as key from r6b_live_send_attempts where id = $1`,
      [result.liveAttemptId],
    );
    expect(rows[0]?.key).toBe(deriveIdempotencyKey(manifest.id));
  });
});

// ---------------------------------------------------------------------------
// Succès
// ---------------------------------------------------------------------------

describe('succès — reçu provider persisté et exactement un outreach_event', () => {
  it('persiste le reçu complet et un seul événement de contact', async () => {
    const manifest = await armedManifest();
    const provider = new FakeProvider({ outcome: { status: 'SENT', providerMessageId: 'msg-42' } });
    const result = await dispatchManifestLive(sql, manifest.id, deps(provider), ARMED_ENVIRONMENT);

    expect(provider.sendCalls).toHaveLength(1);
    expect(result.status).toBe('SENT');
    expect(result.sent).toBe(true);
    expect(result.networkAttempted).toBe(true);
    expect(result.provider).toBe('resend');
    expect(result.providerMessageId).toBe('msg-42');
    expect(result.outreachEventId).not.toBeNull();

    const live = await sql.query<{
      status: string;
      provider: string;
      messageId: string;
      recipient: string;
      textSha: string;
      payloadSha: string;
      network: boolean;
    }>(
      `select status, provider, provider_message_id as "messageId", recipient,
              approved_text_sha256 as "textSha", transport_payload_sha256 as "payloadSha",
              network_attempted as network
         from r6b_live_send_attempts where manifest_id = $1`,
      [manifest.id],
    );
    expect(live[0]).toEqual({
      status: 'SENT',
      provider: 'resend',
      messageId: 'msg-42',
      recipient: RECIPIENT,
      textSha: manifest.approvedTextSha256,
      payloadSha: manifest.transportPayloadSha256,
      network: true,
    });

    const events = await sql.query<{ kind: string; channel: string; manifestId: string; payload: string }>(
      `select kind, channel, manifest_id as "manifestId", payload::text as payload from outreach_events`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('sent');
    expect(events[0]!.channel).toBe('email');
    expect(events[0]!.manifestId).toBe(manifest.id);
    expect(events[0]!.payload).toContain('msg-42');
    // Le corps du message vit dans le manifeste : il n'est pas recopié ici.
    expect(events[0]!.payload).not.toContain(TEXT);

    const journal = await sql.query<{ status: string; sent: boolean; network: boolean; provider: string }>(
      `select status, sent, network_attempted as network, provider from r6b_dispatch_attempts where mode = 'LIVE'`,
    );
    expect(journal).toEqual([{ status: 'SENT', sent: true, network: true, provider: 'resend' }]);
    expect(await counts()).toEqual({ outreach: 1, sent: 1, network: 1, live: 1 });
  });

  it('un manifeste déjà envoyé ne peut plus jamais repartir', async () => {
    const manifest = await armedManifest();
    await dispatchManifestLive(
      sql,
      manifest.id,
      deps(new FakeProvider({ outcome: { status: 'SENT', providerMessageId: 'msg-1' } })),
      ARMED_ENVIRONMENT,
    );

    const second = new FakeProvider({ outcome: { status: 'SENT', providerMessageId: 'msg-2' } });
    await expectBlocked(
      dispatchManifestLive(sql, manifest.id, deps(second), ARMED_ENVIRONMENT),
      'LIVE_ALREADY_SENT',
    );

    expect(second.sendCalls).toHaveLength(0);
    expect(await counts()).toEqual({ outreach: 1, sent: 1, network: 1, live: 1 });
  });
});

// ---------------------------------------------------------------------------
// Concurrence
// ---------------------------------------------------------------------------

describe('concurrence — un seul processus atteint le provider', () => {
  it('deux dispatches simultanés : un envoi, un refus avant réseau', async () => {
    const manifest = await armedManifest();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = new FakeProvider({ gate, outcome: { status: 'SENT', providerMessageId: 'msg-solo' } });
    const second = new FakeProvider({ outcome: { status: 'SENT', providerMessageId: 'msg-double' } });

    const running = dispatchManifestLive(sql, manifest.id, deps(first), ARMED_ENVIRONMENT);
    await waitFor(() => first.sendCalls.length === 1, 'le premier processus atteint le provider');

    const blocked = await expectBlocked(
      dispatchManifestLive(sql, manifest.id, deps(second), ARMED_ENVIRONMENT),
      'LIVE_ATTEMPT_IN_FLIGHT',
    );
    expect(second.sendCalls).toHaveLength(0);

    release();
    const result = await running;

    expect(result.status).toBe('SENT');
    expect(first.sendCalls).toHaveLength(1);

    const blockedRow = await sql.query<{ status: string; network: boolean }>(
      `select status, network_attempted as network from r6b_dispatch_attempts where id = $1`,
      [blocked.attemptId],
    );
    expect(blockedRow[0]).toEqual({ status: 'BLOCKED', network: false });
    expect(await counts()).toEqual({ outreach: 1, sent: 1, network: 1, live: 1 });
  });

  it('la base refuse deux réservations ouvertes, quelle que soit la garde applicative', async () => {
    const manifest = await armedManifest();
    const claim = (): Promise<unknown> =>
      sql.query(
        `insert into r6b_live_send_attempts
           (manifest_id, provider, idempotency_key, transport, recipient,
            approved_text_sha256, transport_payload_sha256, provider_payload_sha256,
            provider_idempotency_expires_at, status)
         values ($1,'resend',$2,'email',$3,$4,$5,$6, now() + interval '24 hours', 'CLAIMED')`,
        [
          manifest.id,
          deriveIdempotencyKey(manifest.id),
          RECIPIENT,
          manifest.approvedTextSha256,
          manifest.transportPayloadSha256,
          hashProviderPayload({
            from: IDENTITY.from,
            to: RECIPIENT,
            reply_to: IDENTITY.replyTo,
            subject: SUBJECT,
            text: TEXT,
          }),
        ],
      );
    // La première réservation doit RÉUSSIR : sans cela, le rejet de la seconde
    // ne prouverait pas l'unicité, seulement qu'une colonne manquait.
    await claim();
    await expect(claim()).rejects.toThrow(/duplicate key value|unique constraint/i);
  });

  it('la base refuse deux événements de contact pour un même manifeste', async () => {
    const manifest = await armedManifest();
    const event = (): Promise<unknown> =>
      sql.query(
        `insert into outreach_events (prospect_id, kind, channel, manifest_id)
         values ($1,'sent','email',$2)`,
        [manifest.prospectId, manifest.id],
      );
    await event();
    await expect(event()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Issue ambiguë
// ---------------------------------------------------------------------------

describe('issue ambiguë — jamais de retentative automatique', () => {
  const AMBIGUOUS: ProviderSendOutcome = {
    status: 'AMBIGUOUS',
    failureCode: 'network_no_response',
    detail: 'timeout',
  };

  it('s’arrête : réseau touché, rien d’envoyé, aucun outreach_event', async () => {
    const manifest = await armedManifest();
    const provider = new FakeProvider({ outcome: AMBIGUOUS });
    const result = await dispatchManifestLive(sql, manifest.id, deps(provider), ARMED_ENVIRONMENT);

    expect(provider.sendCalls).toHaveLength(1); // un seul appel, aucune retentative
    expect(result.status).toBe('AMBIGUOUS');
    expect(result.networkAttempted).toBe(true);
    expect(result.sent).toBe(false);
    expect(result.providerMessageId).toBeNull();
    expect(result.outreachEventId).toBeNull();

    const live = await sql.query<{ status: string; network: boolean; messageId: string | null }>(
      `select status, network_attempted as network, provider_message_id as "messageId"
         from r6b_live_send_attempts where manifest_id = $1`,
      [manifest.id],
    );
    expect(live[0]).toEqual({ status: 'AMBIGUOUS', network: true, messageId: null });

    const journal = await sql.query<{ status: string; sent: boolean; network: boolean; code: string }>(
      `select status, sent, network_attempted as network, error_code as code
         from r6b_dispatch_attempts where mode = 'LIVE'`,
    );
    expect(journal).toEqual([
      { status: 'AMBIGUOUS', sent: false, network: true, code: 'network_no_response' },
    ]);
    expect(await counts()).toEqual({ outreach: 0, sent: 0, network: 1, live: 0 });
  });

  it('bloque toute tentative ultérieure tant qu’un humain n’a pas tranché', async () => {
    const manifest = await armedManifest();
    await dispatchManifestLive(sql, manifest.id, deps(new FakeProvider({ outcome: AMBIGUOUS })), ARMED_ENVIRONMENT);

    const next = new FakeProvider({ outcome: { status: 'SENT', providerMessageId: 'msg-apres' } });
    await expectBlocked(
      dispatchManifestLive(sql, manifest.id, deps(next), ARMED_ENVIRONMENT),
      'LIVE_ATTEMPT_AMBIGUOUS_PENDING',
    );
    expect(next.sendCalls).toHaveLength(0);
    expect(await counts()).toEqual({ outreach: 0, sent: 0, network: 1, live: 0 });
  });

  it('un échec définitif du provider ne crée rien et laisse un nouvel armement possible', async () => {
    const manifest = await armedManifest();
    const failing = new FakeProvider({
      outcome: { status: 'FAILED', failureCode: 'validation_error', detail: 'champ invalide' },
    });
    const failed = await dispatchManifestLive(sql, manifest.id, deps(failing), ARMED_ENVIRONMENT);

    expect(failed.status).toBe('FAILED');
    expect(failed.sent).toBe(false);
    expect(failed.outreachEventId).toBeNull();
    expect(await counts()).toEqual({ outreach: 0, sent: 0, network: 1, live: 0 });

    // Un refus documenté n'a créé aucun email : réessayer reste permis, avec
    // la même clé d'idempotence pour couvrir le cas où le refus aurait menti.
    const retry = new FakeProvider({ outcome: { status: 'SENT', providerMessageId: 'msg-ok' } });
    const sent = await dispatchManifestLive(sql, manifest.id, deps(retry), ARMED_ENVIRONMENT);
    expect(sent.status).toBe('SENT');
    expect(retry.sendCalls[0]!.idempotencyKey).toBe(failing.sendCalls[0]!.idempotencyKey);
    expect(await counts()).toEqual({ outreach: 1, sent: 1, network: 2, live: 1 });
  });
});

// ---------------------------------------------------------------------------
// Classification des réponses provider
// ---------------------------------------------------------------------------

describe('sémantique provider — fail-closed sur tout ce qui n’est pas prouvé', () => {
  it('un 2xx avec identifiant est le seul succès', () => {
    expect(classifySendResult({ kind: 'response', status: 200, body: '{"id":"49a3999c"}' })).toEqual({
      status: 'SENT',
      providerMessageId: '49a3999c',
    });
  });

  it('un 2xx sans identifiant exploitable est ambigu, jamais un échec', () => {
    for (const body of ['{}', 'pas du json', '{"id":""}', '{"id":123}']) {
      expect(classifySendResult({ kind: 'response', status: 200, body }).status, body).toBe('AMBIGUOUS');
    }
  });

  it('les refus documentés sont des échecs définitifs', () => {
    const cases: [number, string][] = [
      [400, '{"statusCode":400,"name":"validation_error","message":"champ invalide"}'],
      [400, '{"name":"invalid_idempotency_key","message":"1-256"}'],
      [401, '{"name":"missing_api_key"}'],
      [401, '{"name":"restricted_api_key"}'],
      [403, '{"name":"invalid_api_key"}'],
      [404, '{}'],
      [422, '{"name":"validation_error"}'],
      [429, '{"name":"rate_limit_exceeded"}'],
      [429, '{"name":"daily_quota_exceeded"}'],
      [429, '{"name":"monthly_quota_exceeded"}'],
    ];
    for (const [status, body] of cases) {
      const outcome = classifySendResult({ kind: 'response', status, body });
      expect(outcome.status, `${status} ${body}`).toBe('FAILED');
    }
  });

  it('les deux conflits d’idempotence sont ambigus : un email a pu être créé', () => {
    for (const name of ['invalid_idempotent_request', 'concurrent_idempotent_requests']) {
      const outcome = classifySendResult({ kind: 'response', status: 409, body: `{"name":"${name}"}` });
      expect(outcome.status, name).toBe('AMBIGUOUS');
      expect(outcome.status === 'AMBIGUOUS' && outcome.failureCode).toBe(name);
    }
  });

  it('un statut inconnu, un 5xx, un 429 non documenté et une absence de réponse sont ambigus', () => {
    expect(classifySendResult({ kind: 'response', status: 418, body: '{}' }).status).toBe('AMBIGUOUS');
    expect(classifySendResult({ kind: 'response', status: 429, body: '{"name":"surprise"}' }).status).toBe('AMBIGUOUS');
    expect(classifySendResult({ kind: 'http_error', status: 500, message: 'upstream 500' }).status).toBe('AMBIGUOUS');
    expect(classifySendResult({ kind: 'http_error', status: 502, message: 'upstream 502' }).status).toBe('AMBIGUOUS');
    expect(classifySendResult({ kind: 'http_error', status: null, message: 'socket' }).status).toBe('AMBIGUOUS');
    expect(classifySendResult({ kind: 'transport_error', message: 'timed out after 20000ms' }).status).toBe(
      'AMBIGUOUS',
    );
  });

  it('un 429 remonté comme erreur HTTP reste un refus définitif', () => {
    expect(classifySendResult({ kind: 'http_error', status: 429, message: 'upstream 429' }).status).toBe('FAILED');
  });

  it('ne recopie jamais un corps de réponse entier dans le détail', () => {
    const outcome = classifySendResult({ kind: 'response', status: 400, body: `{"message":"${'x'.repeat(5000)}"}` });
    expect(outcome.status === 'FAILED' && outcome.detail.length).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// Identité d'expéditeur
// ---------------------------------------------------------------------------

describe('identité d’expéditeur — lue de la configuration, jamais inventée', () => {
  it('accepte « Nom <adresse> » et une adresse nue', () => {
    const named = validateSenderIdentity('Prénom <a@b.fr>', 'c@d.fr');
    expect(named.ok && named.identity).toEqual({ from: 'Prénom <a@b.fr>', replyTo: 'c@d.fr' });
    const bare = validateSenderIdentity('a@b.fr', 'c@d.fr');
    expect(bare.ok).toBe(true);
    expect(extractEmailAddress('Prénom <a@b.fr>')).toBe('a@b.fr');
    expect(extractEmailAddress('a@b.fr')).toBe('a@b.fr');
    expect(extractEmailAddress('pas une adresse')).toBeNull();
  });

  it('refuse une injection d’en-tête plutôt que de la nettoyer', () => {
    const injected = validateSenderIdentity('Nom <a@b.fr>\r\nBcc: victime@c.fr', 'c@d.fr');
    expect(injected).toEqual(expect.objectContaining({ ok: false, code: 'control_characters' }));
  });

  it('refuse une identité absente ou mal formée', () => {
    expect(validateSenderIdentity(undefined, 'c@d.fr')).toEqual(expect.objectContaining({ code: 'missing' }));
    expect(validateSenderIdentity('a@b.fr', '')).toEqual(expect.objectContaining({ code: 'missing' }));
    expect(validateSenderIdentity('Nom <pas-une-adresse>', 'c@d.fr')).toEqual(
      expect.objectContaining({ code: 'malformed' }),
    );
    expect(validateSenderIdentity('a@b.fr', 'Nom <c@d.fr>')).toEqual(expect.objectContaining({ code: 'malformed' }));
  });

  it('aucune adresse d’expéditeur n’est écrite en dur dans le code', () => {
    for (const file of [
      'src/lib/pipeline/r6bLiveEmail.ts',
      'src/lib/pipeline/r6bLiveDispatch.ts',
      'src/cli/r6b-dispatch.ts',
    ]) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      // Aucune adresse email littérale hors exemples de documentation.
      const literals = source.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
      for (const literal of literals) {
        expect(literal, `${file} : ${literal}`).toMatch(/exemple\.fr|example\.com/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Réconciliation
// ---------------------------------------------------------------------------

/** Les dépendances de réconciliation, avec la même identité que l'envoi. */
function reconcileDeps(provider: EmailProvider, extra: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    provider,
    senderIdentity: IDENTITY,
    // Aucun test n'attend réellement : le délai est un no-op injecté.
    sleep: async () => {},
    ...extra,
  };
}

const TIMEOUT: ProviderSendOutcome = {
  status: 'AMBIGUOUS',
  failureCode: 'network_no_response',
  detail: 'timeout',
};

/** Amène le manifeste armé à l'état « issue inconnue », par le vrai chemin LIVE. */
async function ambiguousAttempt(): Promise<DispatchManifest> {
  const manifest = await armedManifest();
  await dispatchManifestLive(sql, manifest.id, deps(new FakeProvider({ outcome: TIMEOUT })), ARMED_ENVIRONMENT);
  return manifest;
}

/**
 * Fait expirer la fenêtre d'idempotence, en vieillissant la tentative entière
 * plutôt qu'en rapprochant l'échéance.
 *
 * La contrainte `r6b_live_send_idempotency_window_is_forward` (0024) interdit
 * une échéance antérieure à la réservation : la seule façon honnête de simuler
 * l'expiration est donc de reculer la tentative dans le temps, exactement
 * comme l'aurait fait l'horloge — 48 h en arrière, échéance il y a 24 h.
 */
async function expireIdempotencyWindow(manifestId: string): Promise<void> {
  await sql.query(
    `update r6b_live_send_attempts
        set claimed_at = now() - interval '48 hours',
            network_started_at = now() - interval '48 hours',
            provider_idempotency_expires_at = now() - interval '24 hours'
      where manifest_id = $1`,
    [manifestId],
  );
}

const RECORD_BASE = {
  to: [RECIPIENT],
  from: IDENTITY.from,
  subject: SUBJECT,
  rfcMessageId: '<record-base@example.com>',
  lastEvent: 'delivered',
} as const;

describe('réconciliation — rejeu à l’identique, et jamais de conclusion non prouvée', () => {
  it('refuse un manifeste qui n’est pas l’armé', async () => {
    await armedManifest();
    await expectBlocked(
      reconcileLiveAttempt(sql, '00000000-0000-0000-0000-000000000000', reconcileDeps(new FakeProvider()), TEST_ARMED_MANIFEST_ID),
      'LIVE_MANIFEST_MISMATCH',
    );
  });

  it('ne fait rien, et n’interroge personne, quand il n’y a rien à trancher', async () => {
    const manifest = await armedManifest();
    const provider = new FakeProvider();
    const result = await reconcileLiveAttempt(sql, manifest.id, reconcileDeps(provider), TEST_ARMED_MANIFEST_ID);
    expect(result.status).toBe('NOTHING_TO_RECONCILE');
    expect(result.providerQueried).toBe(false);
    expect(provider.listCalls).toBe(0);
    expect(provider.sendCalls).toHaveLength(0);
  });

  // §9 — un envoi confirmé ne peut jamais devenir un second envoi.
  it('n’interroge ni ne rejoue rien quand le registre dit déjà « envoyé »', async () => {
    const manifest = await armedManifest();
    await dispatchManifestLive(
      sql,
      manifest.id,
      deps(new FakeProvider({ outcome: { status: 'SENT', providerMessageId: 'msg-1' } })),
      ARMED_ENVIRONMENT,
    );

    const provider = new FakeProvider();
    const result = await reconcileLiveAttempt(
      sql,
      manifest.id,
      reconcileDeps(provider, { allowIdempotentReplay: true }), TEST_ARMED_MANIFEST_ID);

    expect(result.status).toBe('ALREADY_SENT');
    expect(provider.sendCalls).toHaveLength(0);
    expect(provider.listCalls).toBe(0);
    expect(provider.retrieveCalls).toHaveLength(0);
    expect(await counts()).toEqual({ outreach: 1, sent: 1, network: 1, live: 1 });
  });

  // -------------------------------------------------------------------------
  // §2A — le rejeu autorisé
  // -------------------------------------------------------------------------

  it('même manifeste + même payload + même clé + dans la fenêtre → rejeu autorisé', async () => {
    const manifest = await ambiguousAttempt();
    const provider = new FakeProvider({ outcome: { status: 'SENT', providerMessageId: 'msg-idem' } });

    const result = await reconcileLiveAttempt(
      sql,
      manifest.id,
      reconcileDeps(provider, { allowIdempotentReplay: true }), TEST_ARMED_MANIFEST_ID);

    expect(result.status).toBe('CONFIRMED_SENT');
    expect(result.providerReplayed).toBe(true);
    expect(result.withinIdempotencyWindow).toBe(true);
    expect(result.providerMessageId).toBe('msg-idem');

    // La clé du rejeu est LITTÉRALEMENT celle de la tentative d'origine.
    expect(provider.sendCalls).toHaveLength(1);
    expect(provider.sendCalls[0]!.idempotencyKey).toBe(deriveIdempotencyKey(manifest.id));
    expect(provider.sendCalls[0]!.idempotencyKey).not.toMatch(/retry|[0-9]{10,}/);

    // Une seule tentative LIVE, et exactement un outreach_event : le rejeu
    // poursuit la même intention, il n'en ouvre pas une seconde.
    const rows = await sql.query<{ n: string }>(
      'select count(*)::text as n from r6b_live_send_attempts where manifest_id = $1',
      [manifest.id],
    );
    expect(rows[0]?.n).toBe('1');
    expect(await counts()).toEqual({ outreach: 1, sent: 1, network: 2, live: 1 });
  });

  it('le rejeu envoie exactement le même payload que la tentative d’origine', async () => {
    const manifest = await armedManifest();
    const first = new FakeProvider({ outcome: TIMEOUT });
    await dispatchManifestLive(sql, manifest.id, deps(first), ARMED_ENVIRONMENT);

    const replay = new FakeProvider({ outcome: { status: 'SENT', providerMessageId: 'msg-idem' } });
    await reconcileLiveAttempt(sql, manifest.id, reconcileDeps(replay, { allowIdempotentReplay: true }), TEST_ARMED_MANIFEST_ID);

    expect(replay.sendCalls[0]!.request).toEqual(first.sendCalls[0]!.request);
    expect(hashProviderPayload(replay.sendCalls[0]!.request)).toBe(hashProviderPayload(first.sendCalls[0]!.request));
  });

  // La propriété qui rend le rejeu défendable : il ne peut JAMAIS être le
  // premier contact réseau. Il n'existe donc aucun chemin par lequel une
  // réconciliation enverrait un email que personne n'a armé puis déclenché.
  it('une réservation qui n’a jamais touché le réseau n’est jamais rejouée', async () => {
    const manifest = await armedManifest();
    await sql.query(
      `insert into r6b_live_send_attempts
         (manifest_id, provider, idempotency_key, transport, recipient,
          approved_text_sha256, transport_payload_sha256, provider_payload_sha256,
          provider_idempotency_expires_at, status, network_attempted)
       values ($1,'resend',$2,'email',$3,$4,$5,$6, now() + interval '24 hours', 'CLAIMED', false)`,
      [
        manifest.id,
        deriveIdempotencyKey(manifest.id),
        RECIPIENT,
        manifest.approvedTextSha256,
        manifest.transportPayloadSha256,
        hashProviderPayload({
          from: IDENTITY.from,
          to: RECIPIENT,
          reply_to: IDENTITY.replyTo,
          subject: SUBJECT,
          text: TEXT,
        }),
      ],
    );

    const provider = new FakeProvider({ outcome: { status: 'SENT', providerMessageId: 'msg-jamais' } });
    const result = await reconcileLiveAttempt(
      sql,
      manifest.id,
      reconcileDeps(provider, { allowIdempotentReplay: true }), TEST_ARMED_MANIFEST_ID);

    expect(result.status).toBe('NOTHING_TO_RECONCILE');
    expect(provider.sendCalls).toHaveLength(0);
    expect(await counts()).toEqual({ outreach: 0, sent: 0, network: 0, live: 0 });
  });

  it('sans demande explicite, la réconciliation ne rejoue rien', async () => {
    const manifest = await ambiguousAttempt();
    const provider = new FakeProvider({ outcome: { status: 'SENT', providerMessageId: 'msg-jamais' } });

    const result = await reconcileLiveAttempt(sql, manifest.id, reconcileDeps(provider), TEST_ARMED_MANIFEST_ID);

    expect(result.status).toBe('UNRESOLVED');
    expect(result.providerReplayed).toBe(false);
    expect(provider.sendCalls).toHaveLength(0);
    expect(await counts()).toEqual({ outreach: 0, sent: 0, network: 1, live: 0 });
  });

  // -------------------------------------------------------------------------
  // §9 — ce qui bloque AVANT le réseau
  // -------------------------------------------------------------------------

  it('même clé + payload changé → bloqué avant le réseau', async () => {
    const manifest = await ambiguousAttempt();
    const provider = new FakeProvider({ outcome: { status: 'SENT', providerMessageId: 'msg-x' } });

    // Le `from` configuré a changé : la requête ne serait plus la même, donc
    // le rejeu n'en serait plus un.
    const blocked = await expectBlocked(
      reconcileLiveAttempt(
        sql,
        manifest.id,
        reconcileDeps(provider, {
          allowIdempotentReplay: true,
          senderIdentity: { from: 'Autre <autre@example.com>', replyTo: IDENTITY.replyTo },
        }), TEST_ARMED_MANIFEST_ID),
      'LIVE_PROVIDER_PAYLOAD_DRIFT',
    );

    expect(blocked.message).toMatch(/payload provider a changé/);
    expect(provider.sendCalls).toHaveLength(0);
    expect(provider.listCalls).toBe(0);
    expect(await counts()).toEqual({ outreach: 0, sent: 0, network: 1, live: 0 });
  });

  it('un reply-to changé suffit à bloquer : les cinq champs comptent', async () => {
    const manifest = await ambiguousAttempt();
    const provider = new FakeProvider();

    await expectBlocked(
      reconcileLiveAttempt(
        sql,
        manifest.id,
        reconcileDeps(provider, {
          allowIdempotentReplay: true,
          senderIdentity: { from: IDENTITY.from, replyTo: 'autre-reponse@example.com' },
        }), TEST_ARMED_MANIFEST_ID),
      'LIVE_PROVIDER_PAYLOAD_DRIFT',
    );
    expect(provider.sendCalls).toHaveLength(0);
  });

  it('clé d’idempotence différente de celle enregistrée → bloqué avant le réseau', async () => {
    const manifest = await ambiguousAttempt();
    // Simule une dérivation de clé qui aurait changé sous nos pieds.
    await sql.query(
      `update r6b_live_send_attempts set idempotency_key = $2 where manifest_id = $1`,
      [manifest.id, 'une-autre-cle/000'],
    );

    const provider = new FakeProvider({ outcome: { status: 'SENT', providerMessageId: 'msg-x' } });
    await expectBlocked(
      reconcileLiveAttempt(sql, manifest.id, reconcileDeps(provider, { allowIdempotentReplay: true }), TEST_ARMED_MANIFEST_ID),
      'LIVE_IDEMPOTENCY_KEY_DRIFT',
    );

    expect(provider.sendCalls).toHaveLength(0);
    expect(await counts()).toEqual({ outreach: 0, sent: 0, network: 1, live: 0 });
  });

  // -------------------------------------------------------------------------
  // §3 — au-delà de la fenêtre du provider
  // -------------------------------------------------------------------------

  it('fenêtre expirée → aucun rejeu de POST, décision humaine requise', async () => {
    const manifest = await ambiguousAttempt();
    await expireIdempotencyWindow(manifest.id);

    const provider = new FakeProvider({ outcome: { status: 'SENT', providerMessageId: 'msg-jamais' } });
    const result = await reconcileLiveAttempt(
      sql,
      manifest.id,
      // Même explicitement autorisé, le rejeu n'a pas lieu : la clé n'est
      // plus honorée par le provider, donc ce ne serait plus un rejeu.
      reconcileDeps(provider, { allowIdempotentReplay: true }), TEST_ARMED_MANIFEST_ID);

    expect(result.status).toBe('REQUIRES_HUMAN_RECONCILIATION');
    expect(result.withinIdempotencyWindow).toBe(false);
    expect(result.providerReplayed).toBe(false);
    expect(provider.sendCalls).toHaveLength(0);
    expect(result.detail).toMatch(/fenêtre d'idempotence du provider expirée/);
    expect(await counts()).toEqual({ outreach: 0, sent: 0, network: 1, live: 0 });
  });

  it('la protection locale survit à l’expiration de la fenêtre provider', async () => {
    const manifest = await armedManifest();
    await dispatchManifestLive(
      sql,
      manifest.id,
      deps(new FakeProvider({ outcome: { status: 'SENT', providerMessageId: 'msg-1' } })),
      ARMED_ENVIRONMENT,
    );
    await expireIdempotencyWindow(manifest.id);

    // Les 24 h du provider ne protégeaient que le provider. La base, elle,
    // refuse toujours — et pour toujours.
    const next = new FakeProvider();
    await expectBlocked(
      dispatchManifestLive(sql, manifest.id, deps(next), ARMED_ENVIRONMENT),
      'LIVE_ALREADY_SENT',
    );
    expect(next.sendCalls).toHaveLength(0);

    const again = new FakeProvider();
    const result = await reconcileLiveAttempt(
      sql,
      manifest.id,
      reconcileDeps(again, { allowIdempotentReplay: true }), TEST_ARMED_MANIFEST_ID);
    expect(result.status).toBe('ALREADY_SENT');
    expect(again.sendCalls).toHaveLength(0);
    expect(await counts()).toEqual({ outreach: 1, sent: 1, network: 1, live: 1 });
  });

  // -------------------------------------------------------------------------
  // §4 — les deux conflits 409
  // -------------------------------------------------------------------------

  it('409 concurrent : rejeu borné, même clé, et rien de créé tant que rien n’est confirmé', async () => {
    const manifest = await ambiguousAttempt();
    const provider = new FakeProvider({
      outcomes: [
        { status: 'AMBIGUOUS', failureCode: 'concurrent_idempotent_requests', detail: 'en cours' },
      ],
    });

    const result = await reconcileLiveAttempt(
      sql,
      manifest.id,
      reconcileDeps(provider, { allowIdempotentReplay: true, maxReplayAttempts: 3 }), TEST_ARMED_MANIFEST_ID);

    // Borné : exactement le plafond, jamais une boucle.
    expect(provider.sendCalls).toHaveLength(3);
    // Toujours la même clé, sans compteur ni horodatage.
    const keys = new Set(provider.sendCalls.map((call) => call.idempotencyKey));
    expect(keys).toEqual(new Set([deriveIdempotencyKey(manifest.id)]));

    expect(result.status).toBe('UNRESOLVED');
    expect(result.detail).toMatch(/requête concurrente/);
    // Aucun outreach_event tant que rien n'est confirmé.
    expect(await counts()).toEqual({ outreach: 0, sent: 0, network: 1, live: 0 });
  });

  it('409 concurrent puis succès : le rejeu conclut sans jamais changer de clé', async () => {
    const manifest = await ambiguousAttempt();
    const provider = new FakeProvider({
      outcomes: [
        { status: 'AMBIGUOUS', failureCode: 'concurrent_idempotent_requests', detail: 'en cours' },
        { status: 'SENT', providerMessageId: 'msg-apres-attente' },
      ],
    });

    const result = await reconcileLiveAttempt(
      sql,
      manifest.id,
      reconcileDeps(provider, { allowIdempotentReplay: true, maxReplayAttempts: 3 }), TEST_ARMED_MANIFEST_ID);

    expect(provider.sendCalls).toHaveLength(2);
    expect(result.status).toBe('CONFIRMED_SENT');
    expect(result.providerMessageId).toBe('msg-apres-attente');
    expect(new Set(provider.sendCalls.map((c) => c.idempotencyKey)).size).toBe(1);
    expect(await counts()).toEqual({ outreach: 1, sent: 1, network: 2, live: 1 });
  });

  it('409 invalid_idempotent_request : arrêt immédiat, aucune nouvelle clé', async () => {
    const manifest = await ambiguousAttempt();
    const provider = new FakeProvider({
      outcome: { status: 'AMBIGUOUS', failureCode: 'invalid_idempotent_request', detail: 'payload différent' },
    });

    const result = await reconcileLiveAttempt(
      sql,
      manifest.id,
      reconcileDeps(provider, { allowIdempotentReplay: true, maxReplayAttempts: 3 }), TEST_ARMED_MANIFEST_ID);

    // Un seul appel : ce conflit-là ne se résout pas en attendant.
    expect(provider.sendCalls).toHaveLength(1);
    expect(result.status).toBe('REQUIRES_HUMAN_RECONCILIATION');
    expect(result.detail).toMatch(/aucune nouvelle clé/);
    expect(await counts()).toEqual({ outreach: 0, sent: 0, network: 1, live: 0 });
  });

  it('aucune boucle de retry généraliste : une issue ambiguë ordinaire n’est pas rejouée', async () => {
    const manifest = await ambiguousAttempt();
    const provider = new FakeProvider({ outcome: TIMEOUT });

    const result = await reconcileLiveAttempt(
      sql,
      manifest.id,
      reconcileDeps(provider, { allowIdempotentReplay: true, maxReplayAttempts: 5 }), TEST_ARMED_MANIFEST_ID);

    // Une seule requête malgré un plafond à 5 : seul le 409 concurrent, que
    // Resend dit explicitement sûr à retenter, autorise une seconde requête.
    expect(provider.sendCalls).toHaveLength(1);
    expect(result.status).toBe('UNRESOLVED');
    expect(await counts()).toEqual({ outreach: 0, sent: 0, network: 1, live: 0 });
  });

  // -------------------------------------------------------------------------
  // §5 — GET par identifiant vs liste heuristique
  // -------------------------------------------------------------------------

  it('identifiant provider connu → GET par identifiant exact fait autorité', async () => {
    const manifest = await ambiguousAttempt();
    // Un humain a retrouvé l'email dans le tableau de bord et inscrit son id.
    await sql.query(`update r6b_live_send_attempts set provider_message_id = $2 where manifest_id = $1`, [
      manifest.id,
      'msg-connu',
    ]);

    const provider = new FakeProvider({
      records: [{ id: 'msg-connu', ...RECORD_BASE, createdAt: new Date().toISOString() }],
    });
    const result = await reconcileLiveAttempt(sql, manifest.id, reconcileDeps(provider), TEST_ARMED_MANIFEST_ID);

    expect(result.status).toBe('CONFIRMED_SENT');
    expect(result.providerMessageId).toBe('msg-connu');
    expect(provider.retrieveCalls).toEqual(['msg-connu']);
    // Autoritaire sans rejeu : aucun POST n'a été nécessaire.
    expect(provider.sendCalls).toHaveLength(0);
    expect(await counts()).toEqual({ outreach: 1, sent: 1, network: 2, live: 1 });
  });

  it('identifiant connu mais non confirmé par le provider → décision humaine', async () => {
    const manifest = await ambiguousAttempt();
    await sql.query(`update r6b_live_send_attempts set provider_message_id = $2 where manifest_id = $1`, [
      manifest.id,
      'msg-fantome',
    ]);

    const provider = new FakeProvider({ records: [] });
    const result = await reconcileLiveAttempt(sql, manifest.id, reconcileDeps(provider), TEST_ARMED_MANIFEST_ID);

    expect(result.status).toBe('REQUIRES_HUMAN_RECONCILIATION');
    expect(result.detail).toMatch(/ne prouve pas qu’aucun email n’est parti/);
    expect(await counts()).toEqual({ outreach: 0, sent: 0, network: 1, live: 0 });
  });

  it('un match destinataire + objet dans la liste ne peut JAMAIS produire un SENT', async () => {
    const manifest = await ambiguousAttempt();
    // Un envoi récent correspond parfaitement sur destinataire, objet et date.
    const provider = new FakeProvider({
      records: [{ id: 'msg-ressemblant', ...RECORD_BASE, createdAt: new Date(Date.now() + 1000).toISOString() }],
    });

    const result = await reconcileLiveAttempt(sql, manifest.id, reconcileDeps(provider), TEST_ARMED_MANIFEST_ID);

    // Il est signalé comme piste, jamais retenu comme preuve.
    expect(result.status).not.toBe('CONFIRMED_SENT');
    expect(result.diagnosticCandidates).toEqual(['msg-ressemblant']);
    expect(result.detail).toMatch(/n’est pas une preuve d’identité/);
    expect(await counts()).toEqual({ outreach: 0, sent: 0, network: 1, live: 0 });

    // Et l'attente d'un humain reste bloquante.
    const next = new FakeProvider();
    await expectBlocked(
      dispatchManifestLive(sql, manifest.id, deps(next), ARMED_ENVIRONMENT),
      'LIVE_ATTEMPT_AMBIGUOUS_PENDING',
    );
    expect(next.sendCalls).toHaveLength(0);
  });

  it('même hors fenêtre, plusieurs candidats ne tranchent rien', async () => {
    const manifest = await ambiguousAttempt();
    await expireIdempotencyWindow(manifest.id);

    const createdAt = new Date(Date.now() + 1000).toISOString();
    const provider = new FakeProvider({
      records: [
        { id: 'a', ...RECORD_BASE, createdAt },
        { id: 'b', ...RECORD_BASE, createdAt },
      ],
    });
    const result = await reconcileLiveAttempt(sql, manifest.id, reconcileDeps(provider), TEST_ARMED_MANIFEST_ID);

    expect(result.status).toBe('REQUIRES_HUMAN_RECONCILIATION');
    expect(result.diagnosticCandidates).toEqual(['a', 'b']);
    expect(await counts()).toEqual({ outreach: 0, sent: 0, network: 1, live: 0 });
  });

  it('ne conclut jamais « rien n’est parti » : sans preuve, l’issue reste bloquante', async () => {
    const manifest = await ambiguousAttempt();
    const provider = new FakeProvider({ records: [] });
    const result = await reconcileLiveAttempt(sql, manifest.id, reconcileDeps(provider), TEST_ARMED_MANIFEST_ID);

    expect(result.status).toBe('UNRESOLVED');
    expect(result.detail).toMatch(/ne prouve rien/);
    expect(await counts()).toEqual({ outreach: 0, sent: 0, network: 1, live: 0 });

    const next = new FakeProvider();
    await expectBlocked(
      dispatchManifestLive(sql, manifest.id, deps(next), ARMED_ENVIRONMENT),
      'LIVE_ATTEMPT_AMBIGUOUS_PENDING',
    );
    expect(next.sendCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // §9 — les quatre autres manifestes
  // -------------------------------------------------------------------------

  it('les autres manifestes verrouillés restent hors de portée d’une réconciliation', async () => {
    const manifest = await armedManifest();
    await reidentify(manifest.id, '11111111-2222-3333-4444-555555555555');

    const provider = new FakeProvider();
    await expectBlocked(
      reconcileLiveAttempt(
        sql,
        '11111111-2222-3333-4444-555555555555',
        reconcileDeps(provider, { allowIdempotentReplay: true }), TEST_ARMED_MANIFEST_ID),
      'LIVE_MANIFEST_MISMATCH',
    );
    expect(provider.sendCalls).toHaveLength(0);
    expect(provider.listCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Identité de la requête provider
// ---------------------------------------------------------------------------

describe('empreinte du payload provider — les cinq champs, canoniquement', () => {
  const REQUEST: EmailSendRequest = Object.freeze({
    from: IDENTITY.from,
    to: RECIPIENT,
    reply_to: IDENTITY.replyTo,
    subject: SUBJECT,
    text: TEXT,
  });

  it('est stable et indépendante de l’ordre d’écriture des champs', () => {
    const reordered: EmailSendRequest = {
      text: TEXT,
      subject: SUBJECT,
      reply_to: IDENTITY.replyTo,
      to: RECIPIENT,
      from: IDENTITY.from,
    };
    expect(hashProviderPayload(reordered)).toBe(hashProviderPayload(REQUEST));
    expect(hashProviderPayload(REQUEST)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('change dès qu’un seul des cinq champs change', () => {
    const base = hashProviderPayload(REQUEST);
    const variants: EmailSendRequest[] = [
      { ...REQUEST, from: 'Autre <autre@example.com>' },
      { ...REQUEST, to: 'autre@example.com' },
      { ...REQUEST, reply_to: 'autre-reponse@example.com' },
      { ...REQUEST, subject: `${SUBJECT} !` },
      { ...REQUEST, text: `${TEXT} ` },
    ];
    for (const variant of variants) {
      expect(hashProviderPayload(variant), JSON.stringify(variant)).not.toBe(base);
    }
  });

  it('couvre l’expéditeur, ce que l’empreinte du manifeste ne fait pas', () => {
    // Deux requêtes que `transport_payload_sha256` (objet seul) confondrait.
    const other = { ...REQUEST, from: 'Autre <autre@example.com>' };
    expect(hashTransportPayload({ subject: REQUEST.subject })).toBe(hashTransportPayload({ subject: other.subject }));
    expect(hashProviderPayload(REQUEST)).not.toBe(hashProviderPayload(other));
  });

  it('la fenêtre d’idempotence est celle documentée par Resend : 24 h', () => {
    expect(PROVIDER_IDEMPOTENCY_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('est persistée avec la tentative, pour qu’un rejeu puisse être prouvé identique', async () => {
    const manifest = await armedManifest();
    const provider = new FakeProvider({ outcome: TIMEOUT });
    const result = await dispatchManifestLive(sql, manifest.id, deps(provider), ARMED_ENVIRONMENT);

    const stored = await sql.query<{ sha: string; expires: string; claimed: string }>(
      `select provider_payload_sha256 as sha, provider_idempotency_expires_at as expires, claimed_at as claimed
         from r6b_live_send_attempts where manifest_id = $1`,
      [manifest.id],
    );
    expect(stored[0]!.sha).toBe(hashProviderPayload(provider.sendCalls[0]!.request));
    expect(result.providerPayloadSha256).toBe(stored[0]!.sha);

    // La fenêtre stockée est bien de 24 h après la réservation.
    const spanMs = Date.parse(stored[0]!.expires) - Date.parse(stored[0]!.claimed);
    expect(spanMs).toBe(PROVIDER_IDEMPOTENCY_WINDOW_MS);
  });

  it('ne contient aucun secret', async () => {
    const manifest = await armedManifest();
    await dispatchManifestLive(sql, manifest.id, deps(new FakeProvider({ outcome: TIMEOUT })), ARMED_ENVIRONMENT);
    const rows = await sql.query<Record<string, unknown>>(
      'select * from r6b_live_send_attempts where manifest_id = $1',
      [manifest.id],
    );
    const dump = JSON.stringify(rows[0]);
    // Une clé Resend est un jeton `re_…` long, pas la sous-chaîne « re_ » que
    // porte innocemment `failure_code` : le motif vise le secret, pas le mot.
    expect(dump).not.toMatch(/Bearer\s|authorization|"re_[A-Za-z0-9]{16,}/i);
  });
});

// ---------------------------------------------------------------------------
// Frontière réseau
// ---------------------------------------------------------------------------

describe('frontière réseau — un seul module parle au provider', () => {
  it('l’orchestrateur LIVE n’importe aucun client réseau', () => {
    const source = readFileSync(resolve(ROOT, 'src/lib/pipeline/r6bLiveDispatch.ts'), 'utf8');
    const imports = source.match(/^import[\s\S]*?from\s+'[^']+';$/gm) ?? [];
    for (const line of imports) {
      expect(line).not.toMatch(/@\/lib\/http|undici|node:http|node:https|node:net|child_process/);
    }
    expect(source).not.toMatch(/\bfetch\s*\(/);
    // Il n'instancie jamais de provider : il l'exige de son appelant.
    expect(source).not.toMatch(/new\s+ResendProvider|ResendProvider\.fromEnv/);
  });

  it('le vrai client n’est construit que par la ligne de commande', () => {
    const constructors: string[] = [];
    for (const file of [
      'src/cli/r6b-dispatch.ts',
      'src/lib/pipeline/r6bLiveDispatch.ts',
      'src/lib/pipeline/r6bDispatcher.ts',
      'src/lib/pipeline/r6bTransportAdapters.ts',
      'src/lib/pipeline/r6bManifestCompletion.ts',
    ]) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      if (/ResendProvider\.fromEnv\s*\(/.test(source)) constructors.push(file);
    }
    expect(constructors).toEqual(['src/cli/r6b-dispatch.ts']);
  });

  it('la clé d’API n’est lue qu’à un seul endroit et n’est jamais journalisée', () => {
    const readers: string[] = [];
    for (const file of [
      'src/lib/pipeline/r6bLiveEmail.ts',
      'src/lib/pipeline/r6bLiveDispatch.ts',
      'src/cli/r6b-dispatch.ts',
      'src/lib/pipeline/r6bDispatcher.ts',
    ]) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      if (source.includes('RESEND_API_KEY')) readers.push(file);
      expect(source, file).not.toMatch(/logger\.(info|warn|error|debug)\([^)]*apiKey/);
    }
    expect(readers).toEqual(['src/lib/pipeline/r6bLiveEmail.ts']);
  });

  it('l’adapter n’autorise aucune retentative d’envoi', () => {
    const source = readFileSync(resolve(ROOT, 'src/lib/pipeline/r6bLiveEmail.ts'), 'utf8');
    expect(source).toMatch(/attempts:\s*1/);
    expect(source).not.toMatch(/withRetry|attempts:\s*[2-9]/);
    expect(source).toMatch(/noCache:\s*true/);
  });
});
