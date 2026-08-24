import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import { lockManifestForItem, sha256Hex, type DispatchManifest, type Transport } from '@/lib/pipeline/r6bDispatch';
import {
  buildDispatchEnvelope,
  dispatchManifest,
  DispatchBlockedError,
  type DispatchBlockCode,
} from '@/lib/pipeline/r6bDispatcher';
import {
  DRY_RUN_ADAPTERS,
  LIVE_CAPABLE_TRANSPORTS,
  hasLiveAdapter,
  liveCapableTransports,
} from '@/lib/pipeline/r6bTransportAdapters';
import { EMPTY_TRANSPORT_PAYLOAD, hashTransportPayload } from '@/lib/pipeline/r6bTransportPayload';
import { R6B_LIVE_ARMED_TRANSPORT } from '@/lib/pipeline/r6bLiveDispatch';
import { DispatchArgError, parseDispatchArgs } from '@/lib/pipeline/r6bDispatchArgs';
import type { DispatchEnvelope } from '@/lib/pipeline/r6bTransportAdapters';
import type { Sql } from '@/lib/db/sql';

/**
 * R6B-C.1 §14 — dispatcher à manifeste exact.
 *
 * Même patron PGlite temporaire que `r6bDispatch.test.ts` : jamais la base de
 * production. Aucun test de ce fichier n'ouvre de connexion réseau — il n'y a
 * rien à ouvrir, c'est précisément ce que plusieurs d'entre eux vérifient.
 */

const ROOT = resolve(__dirname, '..');
const TEXT = 'Bonjour, une question rapide sur vos réservations.';

let sql: Sql;
let dir: string;
let campaignId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-r6b-dispatcher-'));
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

interface ProspectFields {
  email: string | null;
  phone: string | null;
  websiteUrl: string | null;
  instagramHandle: string | null;
  facebookUrl: string | null;
}

async function makeProspect(fields: Partial<ProspectFields> = {}): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `insert into prospects
       (campaign_id, canonical_key, display_name, email, phone, website_url, instagram_handle, facebook_url)
     values ($1,$2,'ACME ATELIER',$3,$4,$5,$6,$7) returning id`,
    [
      campaignId,
      `prospect-${Math.random()}`,
      fields.email ?? null,
      fields.phone ?? null,
      fields.websiteUrl ?? null,
      fields.instagramHandle ?? null,
      fields.facebookUrl ?? null,
    ],
  );
  return rows[0]!.id;
}

async function addEvidence(prospectId: string, field: string, valueText: string): Promise<void> {
  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,$2,$3,'website','crawl','https://acme.fr',1.0)`,
    [prospectId, field, valueText],
  );
}

async function makeItem(prospectId: string, channels: readonly string[]): Promise<string> {
  const batch = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
    [`batch-${Math.random()}`, campaignId],
  );
  const item = await sql.query<{ id: string }>(
    `insert into r6b_batch_items (batch_id, prospect_id, item_index, original_draft, contact_channels)
     values ($1,$2,1,'brouillon',$3) returning id`,
    [batch[0]!.id, prospectId, JSON.stringify(channels)],
  );
  return item[0]!.id;
}

/** Verrouille un manifeste par le vrai chemin humain (vote puis lock), jamais par un INSERT direct. */
async function lockFor(transport: Transport, text = TEXT): Promise<DispatchManifest> {
  let prospectId: string;
  let channels: readonly string[];

  if (transport === 'email') {
    prospectId = await makeProspect({ email: 'contact@acme.fr' });
    await addEvidence(prospectId, 'email', 'contact@acme.fr');
    channels = ['email'];
  } else if (transport === 'instagram_dm') {
    prospectId = await makeProspect({ instagramHandle: 'acme_atelier_' });
    await addEvidence(prospectId, 'instagram_handle', 'acme_atelier_');
    channels = ['instagram'];
  } else if (transport === 'facebook_dm') {
    prospectId = await makeProspect({ facebookUrl: 'https://www.facebook.com/prestationautolyon' });
    await addEvidence(prospectId, 'facebook_url', 'https://www.facebook.com/prestationautolyon');
    channels = ['facebook'];
  } else if (transport === 'whatsapp') {
    prospectId = await makeProspect({ phone: '+33616790858', websiteUrl: 'https://acme.fr' });
    await addEvidence(prospectId, 'funnel_observed', 'cta_whatsapp: https://wa.me/33616790858');
    channels = ['phone'];
  } else if (transport === 'phone_call') {
    prospectId = await makeProspect({ phone: '+33616790858' });
    await addEvidence(prospectId, 'phone', '+33616790858');
    channels = ['phone'];
  } else {
    throw new Error(`transport ${transport} non verrouillable par ce helper`);
  }

  const itemId = await makeItem(prospectId, channels);
  await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: text, note: null });
  return lockManifestForItem(sql, { itemId, transport });
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

function envelopeFixture(overrides: Partial<DispatchEnvelope> = {}): DispatchEnvelope {
  return {
    manifestId: 'm1',
    batchId: 'b1',
    batchItemId: 'i1',
    prospectId: 'p1',
    transport: 'email',
    recipient: 'contact@acme.fr',
    approvedText: TEXT,
    approvedTextSha256: sha256Hex(TEXT),
    transportPayload: EMPTY_TRANSPORT_PAYLOAD,
    transportPayloadSha256: hashTransportPayload(EMPTY_TRANSPORT_PAYLOAD),
    recipientEvidenceIds: ['e1'],
    identityStatus: 'confirmed',
    ...overrides,
  };
}

function manifestFixture(overrides: Partial<DispatchManifest> = {}): DispatchManifest {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    batchId: '22222222-2222-2222-2222-222222222222',
    batchItemId: '33333333-3333-3333-3333-333333333333',
    prospectId: '44444444-4444-4444-4444-444444444444',
    approvalVoteId: '55555555-5555-5555-5555-555555555555',
    businessName: 'ACME ATELIER',
    legalName: null,
    legacyChannel: null,
    transport: 'email',
    recipient: 'contact@acme.fr',
    recipientProvenance: {
      field: 'email',
      provider: 'website',
      method: 'crawl',
      sourceUrl: 'https://acme.fr',
      confidence: 1,
      observedAt: '2026-08-10T00:00:00.000Z',
    },
    recipientEvidenceIds: ['e1'],
    identityReview: 'confirmed',
    approvedText: TEXT,
    approvedTextSha256: sha256Hex(TEXT),
    transportPayload: EMPTY_TRANSPORT_PAYLOAD,
    transportPayloadSha256: hashTransportPayload(EMPTY_TRANSPORT_PAYLOAD),
    hookType: null,
    hookEvidenceIds: [],
    status: 'LOCKED',
    supersededBy: null,
    supersededAt: null,
    supersededReason: null,
    lockedAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

describe('§1/§12 — le manifeste exact est le seul moyen de désigner une cible', () => {
  it('dispatchManifest ne prend que (sql, manifestId, mode)', () => {
    expect(dispatchManifest.length).toBe(3);
  });

  it('refuse une commande sans --manifest-id', () => {
    expect(() => parseDispatchArgs(['--dry-run'])).toThrow(DispatchArgError);
    expect(() => parseDispatchArgs([])).toThrow(/--manifest-id explicite est obligatoire/);
  });

  it('refuse --batch, --prospect, --all et toute autre sélection dynamique', () => {
    for (const flag of ['--batch', '--batch-id', '--batch-item', '--prospect', '--prospect-id', '--all', '--send-all']) {
      expect(() => parseDispatchArgs([flag, 'x', '--dry-run']), flag).toThrow(DispatchArgError);
    }
  });

  it('refuse un destinataire, un transport ou un texte fournis par l’appelant', () => {
    for (const flag of ['--recipient', '--transport', '--text', '--message']) {
      expect(() => parseDispatchArgs(['--manifest-id', 'm', flag, 'x', '--dry-run']), flag).toThrow(
        /vient du manifeste verrouillé/,
      );
    }
  });

  it('refuse toute option inconnue plutôt que de l’ignorer', () => {
    expect(() => parseDispatchArgs(['--manifest-id', 'm', '--dry-run', '--force'])).toThrow(/option inconnue/);
  });

  it('refuse deux manifestes dans la même commande', () => {
    expect(() => parseDispatchArgs(['--manifest-id', 'a', '--manifest-id', 'b', '--dry-run'])).toThrow(
      /une seule fois/,
    );
  });

  it('exige un mode explicite : aucun mode par défaut, jamais LIVE implicite', () => {
    expect(() => parseDispatchArgs(['--manifest-id', 'm'])).toThrow(/mode explicite est obligatoire/);
    expect(parseDispatchArgs(['--manifest-id', 'm', '--dry-run'])).toEqual({
      manifestId: 'm',
      mode: 'DRY_RUN',
      allowIdempotentReplay: false,
    });
    expect(parseDispatchArgs(['--manifest-id', 'm', '--live'])).toEqual({
      manifestId: 'm',
      mode: 'LIVE',
      allowIdempotentReplay: false,
    });
    expect(parseDispatchArgs(['--manifest-id', 'm', '--reconcile'])).toEqual({
      manifestId: 'm',
      mode: 'RECONCILE',
      allowIdempotentReplay: false,
    });
    for (const combination of [
      ['--dry-run', '--live'],
      ['--dry-run', '--reconcile'],
      ['--live', '--reconcile'],
    ]) {
      expect(() => parseDispatchArgs(['--manifest-id', 'm', ...combination]), combination.join(' ')).toThrow(
        /exclusifs/,
      );
    }
  });

  // R6B-C.2B.1 — le rejeu idempotent est une décision explicite, jamais un
  // défaut, et il n'a de sens que pour une réconciliation.
  it('le rejeu idempotent doit être demandé, et seulement avec --reconcile', () => {
    expect(parseDispatchArgs(['--manifest-id', 'm', '--reconcile', '--allow-idempotent-replay'])).toEqual({
      manifestId: 'm',
      mode: 'RECONCILE',
      allowIdempotentReplay: true,
    });
    for (const mode of ['--dry-run', '--live']) {
      expect(() => parseDispatchArgs(['--manifest-id', 'm', mode, '--allow-idempotent-replay']), mode).toThrow(
        /n’a de sens qu’avec --reconcile/,
      );
    }
  });
});

describe('§3 — validation fail-closed avant tout dispatch', () => {
  it('manifeste absent → MANIFEST_NOT_FOUND', async () => {
    await expectBlocked(
      dispatchManifest(sql, '99999999-9999-9999-9999-999999999999', 'DRY_RUN'),
      'MANIFEST_NOT_FOUND',
    );
  });

  it('identifiant qui n’est même pas un UUID → MANIFEST_NOT_FOUND, jamais une erreur de type', async () => {
    await expectBlocked(dispatchManifest(sql, 'pas-un-uuid', 'DRY_RUN'), 'MANIFEST_NOT_FOUND');
  });

  it('manifeste SUPERSEDED par un relock → MANIFEST_SUPERSEDED', async () => {
    const first = await lockFor('email');
    // Un second lock sur le même item supersède le premier (R6B-B).
    await lockManifestForItem(sql, { itemId: first.batchItemId, transport: 'email' });
    await expectBlocked(dispatchManifest(sql, first.id, 'DRY_RUN'), 'MANIFEST_SUPERSEDED');
  });

  it('manifeste supersédé sans remplaçant (normalisation) → MANIFEST_SUPERSEDED', async () => {
    const manifest = await lockFor('email');
    await sql.query(
      `update r6b_dispatch_manifests
          set status='SUPERSEDED', superseded_at=now(), superseded_reason='transport_taxonomy_normalization'
        where id = $1`,
      [manifest.id],
    );
    const error = await expectBlocked(dispatchManifest(sql, manifest.id, 'DRY_RUN'), 'MANIFEST_SUPERSEDED');
    expect(error.message).toContain('transport_taxonomy_normalization');
  });

  it('transport NULL → TRANSPORT_MISSING', () => {
    expect(() => buildDispatchEnvelope(manifestFixture({ transport: null, legacyChannel: 'site' }))).toThrow(
      DispatchBlockedError,
    );
    try {
      buildDispatchEnvelope(manifestFixture({ transport: null }));
    } catch (error) {
      expect((error as DispatchBlockedError).code).toBe('TRANSPORT_MISSING');
    }
  });

  it('transport hors taxonomie → TRANSPORT_UNSUPPORTED', () => {
    try {
      buildDispatchEnvelope(manifestFixture({ transport: 'pigeon' as Transport }));
      throw new Error('aurait dû bloquer');
    } catch (error) {
      expect((error as DispatchBlockedError).code).toBe('TRANSPORT_UNSUPPORTED');
    }
  });

  it('destinataire vide → RECIPIENT_MISSING, y compris en base', async () => {
    try {
      buildDispatchEnvelope(manifestFixture({ recipient: '   ' }));
      throw new Error('aurait dû bloquer');
    } catch (error) {
      expect((error as DispatchBlockedError).code).toBe('RECIPIENT_MISSING');
    }

    const manifest = await lockFor('email');
    await sql.query(`update r6b_dispatch_manifests set recipient = '' where id = $1`, [manifest.id]);
    await expectBlocked(dispatchManifest(sql, manifest.id, 'DRY_RUN'), 'RECIPIENT_MISSING');
  });

  it('preuve de destinataire vide → RECIPIENT_EVIDENCE_MISSING', () => {
    try {
      buildDispatchEnvelope(manifestFixture({ recipientEvidenceIds: [] }));
      throw new Error('aurait dû bloquer');
    } catch (error) {
      expect((error as DispatchBlockedError).code).toBe('RECIPIENT_EVIDENCE_MISSING');
    }
  });

  it('texte approuvé vide → APPROVED_TEXT_MISSING', () => {
    try {
      buildDispatchEnvelope(manifestFixture({ approvedText: '  ', approvedTextSha256: sha256Hex('  ') }));
      throw new Error('aurait dû bloquer');
    } catch (error) {
      expect((error as DispatchBlockedError).code).toBe('APPROVED_TEXT_MISSING');
    }
  });

  it('sha256 mal formé → APPROVED_TEXT_SHA_INVALID', () => {
    try {
      buildDispatchEnvelope(manifestFixture({ approvedTextSha256: 'pas-un-hash' }));
      throw new Error('aurait dû bloquer');
    } catch (error) {
      expect((error as DispatchBlockedError).code).toBe('APPROVED_TEXT_SHA_INVALID');
    }
  });

  it('texte altéré après le lock → APPROVED_TEXT_SHA_MISMATCH', async () => {
    const manifest = await lockFor('email');
    await sql.query(`update r6b_dispatch_manifests set approved_text = $2 where id = $1`, [
      manifest.id,
      `${TEXT} (phrase ajoutée après approbation)`,
    ]);
    const error = await expectBlocked(dispatchManifest(sql, manifest.id, 'DRY_RUN'), 'APPROVED_TEXT_SHA_MISMATCH');
    expect(error.message).toContain(manifest.approvedTextSha256);
  });

  it('destinataire figé qui n’a pas la forme du transport → RECIPIENT_SHAPE_INVALID', async () => {
    const manifest = await lockFor('email');
    await sql.query(`update r6b_dispatch_manifests set recipient = 'pas une adresse' where id = $1`, [manifest.id]);
    await expectBlocked(dispatchManifest(sql, manifest.id, 'DRY_RUN'), 'RECIPIENT_SHAPE_INVALID');
  });

  it('manifeste LOCKED qui n’est plus l’unique actif de son item → MANIFEST_NOT_CURRENT', async () => {
    const manifest = await lockFor('email');
    // Force un second LOCKED sur le même item en contournant l'index partiel
    // (situation que la base interdit) pour prouver que le dispatcher ne s'en
    // remet pas à cette seule contrainte.
    await sql.query('drop index r6b_dispatch_manifests_one_locked_idx');
    let duplicateId: string | null = null;
    try {
      const inserted = await sql.query<{ id: string }>(
        `insert into r6b_dispatch_manifests
           (batch_id, batch_item_id, prospect_id, approval_vote_id, business_name, transport, recipient,
            recipient_provenance, recipient_evidence_ids, identity_review, approved_text, approved_text_sha256,
            transport_payload, transport_payload_sha256, status)
         select batch_id, batch_item_id, prospect_id, approval_vote_id, business_name, transport, recipient,
                recipient_provenance, recipient_evidence_ids, identity_review, approved_text, approved_text_sha256,
                transport_payload, transport_payload_sha256, 'LOCKED'
           from r6b_dispatch_manifests where id = $1
         returning id`,
        [manifest.id],
      );
      duplicateId = inserted[0]!.id;
      await expectBlocked(dispatchManifest(sql, manifest.id, 'DRY_RUN'), 'MANIFEST_NOT_CURRENT');
    } finally {
      if (duplicateId) await sql.query('delete from r6b_dispatch_manifests where id = $1', [duplicateId]);
      await sql.query(
        `create unique index r6b_dispatch_manifests_one_locked_idx
           on r6b_dispatch_manifests (batch_item_id) where status = 'LOCKED'`,
      );
    }
  });

  it('ne modifie jamais le manifeste, même sur un refus', async () => {
    const manifest = await lockFor('email');
    const before = await sql.query(`select * from r6b_dispatch_manifests where id = $1`, [manifest.id]);
    await dispatchManifest(sql, manifest.id, 'DRY_RUN');
    await expectBlocked(dispatchManifest(sql, manifest.id, 'LIVE'), 'LIVE_NOT_ON_THIS_PATH');
    const after = await sql.query(`select * from r6b_dispatch_manifests where id = $1`, [manifest.id]);
    expect(after).toEqual(before);
  });
});

describe('§2/§4 — le manifeste est la source de vérité, jamais recalculée', () => {
  it('dispatche le destinataire figé même si la fiche prospect a changé depuis le lock', async () => {
    const manifest = await lockFor('email');

    // Le prospect change d'adresse et perd sa preuve après le lock : un
    // dispatcher qui re-résoudrait le transport enverrait ailleurs.
    await sql.query(`update prospects set email = 'nouvelle@acme.fr' where id = $1`, [manifest.prospectId]);
    await sql.query(`delete from prospect_evidence where prospect_id = $1`, [manifest.prospectId]);
    await sql.query(`update r6b_batch_items set contact_channels = '[]'::jsonb where id = $1`, [
      manifest.batchItemId,
    ]);

    const result = await dispatchManifest(sql, manifest.id, 'DRY_RUN');
    expect(result.recipient).toBe('contact@acme.fr');
    expect(result.transport).toBe('email');
    expect(result.approvedTextSha256).toBe(manifest.approvedTextSha256);
  });

  it('n’appelle ni resolveTransportOptions, ni research, ni LLM, ni client réseau', () => {
    const source = readFileSync(resolve(ROOT, 'src/lib/pipeline/r6bDispatcher.ts'), 'utf8');
    const body = source.slice(source.indexOf('export function buildDispatchEnvelope'));
    for (const forbidden of [
      'resolveTransportOptions',
      'loadDispatchContext',
      'ModelRouter',
      'generateMessages',
      'buildAngle',
      'prospect_research',
      'prospect_evidence',
      'HttpClient',
      'fetch(',
      'nodemailer',
      'twilio',
      'sendgrid',
      'resend',
      'axios',
      'sendAll',
      'sendBatch',
      'sendNow',
    ]) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });

  it('ne sélectionne jamais par prospect, batch ou item', () => {
    for (const file of ['src/lib/pipeline/r6bDispatcher.ts', 'src/cli/r6b-dispatch.ts']) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      expect(source, file).not.toMatch(/where\s+prospect_id\s*=/i);
      expect(source, file).not.toMatch(/where\s+batch_id\s*=/i);
      expect(source, file).not.toMatch(/status\s*=\s*'LOCKED'\s*(order|limit)/i);
    }
  });

  it('aucun module de dispatch n’importe de client réseau', () => {
    for (const file of [
      'src/lib/pipeline/r6bDispatcher.ts',
      'src/lib/pipeline/r6bTransportAdapters.ts',
      'src/lib/pipeline/r6bDispatchArgs.ts',
      'src/cli/r6b-dispatch.ts',
    ]) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      const imports = source.match(/^import[\s\S]*?from\s+'[^']+';$/gm) ?? [];
      for (const line of imports) {
        expect(line, file).not.toMatch(/undici|node:http|node:https|node:net|node:dgram|child_process|puppeteer|playwright/);
        expect(line, file).not.toMatch(/@\/lib\/http/);
      }
    }
  });
});

describe('§6/§9 — DRY_RUN : enveloppe exacte, aucun réseau, aucun envoi', () => {
  it('produit une enveloppe dérivée uniquement du manifeste', async () => {
    const manifest = await lockFor('email');
    const result = await dispatchManifest(sql, manifest.id, 'DRY_RUN');

    expect(result.manifestId).toBe(manifest.id);
    expect(result.mode).toBe('DRY_RUN');
    expect(result.transport).toBe('email');
    expect(result.recipient).toBe('contact@acme.fr');
    expect(result.approvedTextSha256).toBe(sha256Hex(TEXT));
    expect(result.networkAttempted).toBe(false);
    expect(result.sent).toBe(false);
    expect(result.status).toBe('DRY_RUN_OK');
    expect(result.preview.payloadFields).toEqual({ to: 'contact@acme.fr', body: TEXT });
  });

  it('ne régénère jamais le texte : le payload porte le texte approuvé mot pour mot', async () => {
    const manifest = await lockFor('email');
    const result = await dispatchManifest(sql, manifest.id, 'DRY_RUN');
    expect(result.preview.payloadFields.body).toBe(manifest.approvedText);
    expect(sha256Hex(String(result.preview.payloadFields.body))).toBe(manifest.approvedTextSha256);
  });

  it('l’enveloppe construite est gelée — un adapter ne peut pas la réécrire', () => {
    const envelope = buildDispatchEnvelope(manifestFixture());
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(() => {
      (envelope as { recipient: string }).recipient = 'ailleurs@example.com';
    }).toThrow();
  });

  it('ne crée aucun outreach_event', async () => {
    const manifest = await lockFor('email');
    await dispatchManifest(sql, manifest.id, 'DRY_RUN');
    await dispatchManifest(sql, manifest.id, 'DRY_RUN');
    await expectBlocked(dispatchManifest(sql, manifest.id, 'LIVE'), 'LIVE_NOT_ON_THIS_PATH');
    const rows = await sql.query<{ n: string }>('select count(*)::text as n from outreach_events');
    expect(rows[0]?.n).toBe('0');
  });

  it('plusieurs DRY_RUN du même manifeste sont autorisés', async () => {
    const manifest = await lockFor('email');
    const a = await dispatchManifest(sql, manifest.id, 'DRY_RUN');
    const b = await dispatchManifest(sql, manifest.id, 'DRY_RUN');
    const c = await dispatchManifest(sql, manifest.id, 'DRY_RUN');
    expect(new Set([a.attemptId, b.attemptId, c.attemptId]).size).toBe(3);
    expect([a, b, c].map((r) => r.approvedTextSha256)).toEqual(Array(3).fill(manifest.approvedTextSha256));
  });

  it('couvre les quatre transports réellement verrouillés dans le pilote', async () => {
    const expected: Record<string, string> = {
      email: 'contact@acme.fr',
      instagram_dm: 'acme_atelier_',
      facebook_dm: 'https://www.facebook.com/prestationautolyon',
      whatsapp: '+33616790858',
    };
    for (const transport of ['email', 'instagram_dm', 'facebook_dm', 'whatsapp'] as const) {
      const manifest = await lockFor(transport);
      const result = await dispatchManifest(sql, manifest.id, 'DRY_RUN');
      expect(result.transport, transport).toBe(transport);
      expect(result.recipient, transport).toBe(expected[transport]);
      expect(result.networkAttempted, transport).toBe(false);
      expect(result.sent, transport).toBe(false);
    }
  });
});

describe('§6/§7 — ce point d’entrée n’envoie jamais, même en R6B-C.2B', () => {
  const previous = process.env.OUTBOUND_ALLOW_SENDING;
  afterEach(() => {
    if (previous === undefined) delete process.env.OUTBOUND_ALLOW_SENDING;
    else process.env.OUTBOUND_ALLOW_SENDING = previous;
  });

  it('un LIVE demandé ici est refusé : l’envoi a son propre chemin gardé', async () => {
    const manifest = await lockFor('email');
    const error = await expectBlocked(dispatchManifest(sql, manifest.id, 'LIVE'), 'LIVE_NOT_ON_THIS_PATH');
    expect(error.message).toMatch(/triple garde/);
  });

  it('reste bloqué même avec OUTBOUND_ALLOW_SENDING=1 — le flag n’autorise rien', async () => {
    process.env.OUTBOUND_ALLOW_SENDING = '1';
    const manifest = await lockFor('email');
    await expectBlocked(dispatchManifest(sql, manifest.id, 'LIVE'), 'LIVE_NOT_ON_THIS_PATH');

    const rows = await sql.query<{ n: string }>(
      `select count(*)::text as n from r6b_dispatch_attempts where sent = true or network_attempted = true`,
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('le dispatcher ne consulte jamais OUTBOUND_ALLOW_SENDING : rien à débloquer', () => {
    const source = readFileSync(resolve(ROOT, 'src/lib/pipeline/r6bDispatcher.ts'), 'utf8');
    // Le drapeau est cité dans les commentaires — c'est justement le sujet.
    // Ce qui doit être absent, c'est toute lecture réelle de l'environnement.
    expect(source).not.toMatch(/from\s+'@\/lib\/env'/);
    expect(source).not.toMatch(/\benvBool\s*\(/);
    expect(source).not.toMatch(/process\.env/);
  });

  it('deux transports sont envoyables : email (R6B-C.2B) et instagram_dm (IG2)', () => {
    // Chaque ligne de ce registre est une décision : elle ne bascule que par un
    // diff, et ce test est l'endroit où ce diff doit être vu.
    expect([...liveCapableTransports()].sort()).toEqual(['email', 'instagram_dm']);
    expect(hasLiveAdapter('email')).toBe(true);
    expect(hasLiveAdapter('instagram_dm')).toBe(true);
    for (const transport of ['facebook_dm', 'web_form', 'sms', 'whatsapp', 'phone_call'] as const) {
      expect(hasLiveAdapter(transport), transport).toBe(false);
    }
    expect(Object.isFrozen(LIVE_CAPABLE_TRANSPORTS)).toBe(true);
  });

  it('le chemin LIVE email refuse un manifeste Instagram, même « capable »', async () => {
    // IG2 — `hasLiveAdapter('instagram_dm')` vaut maintenant `true`, et ce
    // chemin-ci construit pourtant un email. La garde ne lit donc plus le
    // registre des capacités mais le transport ARMÉ de sa propre mission.
    const source = readFileSync(resolve(ROOT, 'src/lib/pipeline/r6bLiveDispatch.ts'), 'utf8');
    expect(source).toMatch(/envelope\.transport !== R6B_LIVE_ARMED_TRANSPORT/);
    expect(R6B_LIVE_ARMED_TRANSPORT).toBe('email');
  });

  it('aucun adapter DRY_RUN n’expose de méthode d’envoi', () => {
    for (const adapter of Object.values(DRY_RUN_ADAPTERS)) {
      expect(Object.keys(adapter).sort()).toEqual(['dryRun', 'transport', 'validateEnvelope']);
    }
  });
});

describe('§8 — adapters de transport : forme et DRY_RUN, rien de plus', () => {
  it('couvre toute la taxonomie R6B-B.1', () => {
    expect(Object.keys(DRY_RUN_ADAPTERS).sort()).toEqual(
      ['email', 'facebook_dm', 'instagram_dm', 'phone_call', 'sms', 'web_form', 'whatsapp'].sort(),
    );
  });

  it('accepte un destinataire bien formé pour chaque transport', () => {
    const valid: Record<string, string> = {
      email: 'contact@acme.fr',
      instagram_dm: 'demo_prospect_a',
      facebook_dm: 'https://www.facebook.com/prestationautolyon',
      web_form: 'https://acme.fr/contact',
      sms: '+33616790858',
      whatsapp: '+33616790858',
      phone_call: '+33616790858',
    };
    for (const [transport, recipient] of Object.entries(valid)) {
      const adapter = DRY_RUN_ADAPTERS[transport as Transport];
      const envelope = envelopeFixture({ transport: transport as Transport, recipient });
      expect(adapter.validateEnvelope(envelope), transport).toBeNull();
      const preview = adapter.dryRun(envelope);
      expect(preview.networkAttempted, transport).toBe(false);
      expect(preview.recipient, transport).toBe(recipient);
      expect(Object.values(preview.payloadFields), transport).toContain(TEXT);
    }
  });

  it('refuse un destinataire mal formé pour chaque transport', () => {
    const invalid: Record<string, string> = {
      email: 'contact chez acme',
      instagram_dm: '@demo_prospect_a',
      facebook_dm: 'https://instagram.com/prestationautolyon',
      web_form: 'acme.fr/contact',
      sms: '0616790858',
      whatsapp: '33616790858',
      phone_call: 'appelez-nous',
    };
    for (const [transport, recipient] of Object.entries(invalid)) {
      const adapter = DRY_RUN_ADAPTERS[transport as Transport];
      expect(adapter.validateEnvelope(envelopeFixture({ transport: transport as Transport, recipient })), transport)
        .not.toBeNull();
    }
  });

  it('refuse une enveloppe adressée à un autre transport', () => {
    expect(DRY_RUN_ADAPTERS.email.validateEnvelope(envelopeFixture({ transport: 'sms', recipient: '+33616790858' })))
      .toMatch(/appelé avec une enveloppe/);
  });

  it('dit ce qui manque pour un envoi réel plutôt que de l’inventer', () => {
    expect(DRY_RUN_ADAPTERS.email.dryRun(envelopeFixture()).missingForLive).toContain('subject');
    expect(
      DRY_RUN_ADAPTERS.phone_call.dryRun(envelopeFixture({ transport: 'phone_call', recipient: '+33616790858' }))
        .missingForLive,
    ).toContain('human_caller');
  });

  it('est déterministe : deux DRY_RUN de la même enveloppe donnent le même payload', () => {
    const envelope = envelopeFixture();
    expect(DRY_RUN_ADAPTERS.email.dryRun(envelope)).toEqual(DRY_RUN_ADAPTERS.email.dryRun(envelope));
  });

  it('ne simule aucune livraison : ni identifiant de message, ni statut de remise', () => {
    const preview = DRY_RUN_ADAPTERS.email.dryRun(envelopeFixture());
    const keys = Object.keys(preview);
    expect(keys).not.toContain('messageId');
    expect(keys).not.toContain('deliveredAt');
    expect(keys).not.toContain('status');
    expect(JSON.stringify(preview)).not.toMatch(/delivered|accepted|queued/i);
  });
});

describe('§10/§11 — audit et frontière d’idempotence', () => {
  it('journalise chaque DRY_RUN sans jamais toucher outreach_events', async () => {
    const manifest = await lockFor('whatsapp');
    const result = await dispatchManifest(sql, manifest.id, 'DRY_RUN');

    const rows = await sql.query<{
      manifestId: string;
      mode: string;
      transport: string;
      recipient: string;
      sha: string;
      status: string;
      networkAttempted: boolean;
      sent: boolean;
      errorCode: string | null;
    }>(
      `select manifest_id as "manifestId", mode, transport, recipient,
              approved_text_sha256 as "sha", status,
              network_attempted as "networkAttempted", sent, error_code as "errorCode"
         from r6b_dispatch_attempts where id = $1`,
      [result.attemptId],
    );
    expect(rows[0]).toEqual({
      manifestId: manifest.id,
      mode: 'DRY_RUN',
      transport: 'whatsapp',
      recipient: '+33616790858',
      sha: manifest.approvedTextSha256,
      status: 'DRY_RUN_OK',
      networkAttempted: false,
      sent: false,
      errorCode: null,
    });
  });

  it('journalise aussi les refus, avec leur code', async () => {
    await expectBlocked(dispatchManifest(sql, 'inconnu', 'DRY_RUN'), 'MANIFEST_NOT_FOUND');
    const rows = await sql.query<{ requested: string; manifestId: string | null; status: string; errorCode: string }>(
      `select requested_manifest_id as "requested", manifest_id as "manifestId", status, error_code as "errorCode"
         from r6b_dispatch_attempts`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      requested: 'inconnu',
      manifestId: null,
      status: 'BLOCKED',
      errorCode: 'MANIFEST_NOT_FOUND',
    });
  });

  it('la base refuse un DRY_RUN qui prétendrait avoir touché le réseau ou envoyé', async () => {
    const manifest = await lockFor('email');
    await expect(
      sql.query(
        `insert into r6b_dispatch_attempts (requested_manifest_id, manifest_id, mode, status, network_attempted)
         values ($1,$2,'DRY_RUN','BLOCKED',true)`,
        [manifest.id, manifest.id],
      ),
    ).rejects.toThrow();
    await expect(
      sql.query(
        `insert into r6b_dispatch_attempts (requested_manifest_id, manifest_id, mode, status, sent)
         values ($1,$2,'DRY_RUN','SENT',true)`,
        [manifest.id, manifest.id],
      ),
    ).rejects.toThrow();
  });

  it('la base refuse un faux succès : SENT sans envoi réseau, ou sent sans SENT', async () => {
    const manifest = await lockFor('email');
    await expect(
      sql.query(
        `insert into r6b_dispatch_attempts (requested_manifest_id, manifest_id, mode, status, sent, network_attempted)
         values ($1,$2,'LIVE','SENT',true,false)`,
        [manifest.id, manifest.id],
      ),
    ).rejects.toThrow();
    await expect(
      sql.query(
        `insert into r6b_dispatch_attempts (requested_manifest_id, manifest_id, mode, status, sent)
         values ($1,$2,'LIVE','BLOCKED',true)`,
        [manifest.id, manifest.id],
      ),
    ).rejects.toThrow();
  });

  it('un manifeste ne peut jamais être envoyé deux fois avec succès', async () => {
    const manifest = await lockFor('email');
    const live = await sql.query<{ id: string }>(
      `insert into r6b_live_send_attempts
         (manifest_id, provider, idempotency_key, transport, recipient,
          approved_text_sha256, transport_payload_sha256, provider_payload_sha256,
          provider_idempotency_expires_at, status, network_attempted,
          network_started_at, provider_message_id, completed_at)
       values ($1,'resend',$2,'email','contact@acme.fr',$3,$4,$5,
               now() + interval '24 hours','SENT',true,now(),'msg-1',now())
       returning id`,
      [
        manifest.id,
        `r6b-c2b-first-touch-email/${manifest.id}`,
        manifest.approvedTextSha256,
        manifest.transportPayloadSha256,
        // Empreinte arbitraire mais bien formée : ce test porte sur l'unicité
        // du succès, pas sur l'identité du payload.
        'f'.repeat(64),
      ],
    );
    const insertSuccess = (): Promise<unknown> =>
      sql.query(
        `insert into r6b_dispatch_attempts
           (requested_manifest_id, manifest_id, mode, transport, recipient, approved_text_sha256,
            transport_payload_sha256, status, sent, network_attempted, provider, provider_message_id, live_attempt_id)
         values ($1,$2,'LIVE','email','contact@acme.fr',$3,$4,'SENT',true,true,'resend','msg-1',$5)`,
        [manifest.id, manifest.id, manifest.approvedTextSha256, manifest.transportPayloadSha256, live[0]!.id],
      );
    await insertSuccess();
    await expect(insertSuccess()).rejects.toThrow();
    await sql.query('delete from r6b_dispatch_attempts');
    await sql.query('delete from r6b_live_send_attempts');
  });

  it('un succès sans reçu provider est refusé par la base', async () => {
    const manifest = await lockFor('email');
    await expect(
      sql.query(
        `insert into r6b_dispatch_attempts
           (requested_manifest_id, manifest_id, mode, transport, recipient, approved_text_sha256,
            status, sent, network_attempted)
         values ($1,$2,'LIVE','email','contact@acme.fr',$3,'SENT',true,true)`,
        [manifest.id, manifest.id, manifest.approvedTextSha256],
      ),
    ).rejects.toThrow();
  });

  it('un refus ne peut pas prétendre avoir touché le réseau', async () => {
    const manifest = await lockFor('email');
    await expect(
      sql.query(
        `insert into r6b_dispatch_attempts
           (requested_manifest_id, manifest_id, mode, status, error_code, network_attempted)
         values ($1,$2,'LIVE','BLOCKED','LIVE_SENDING_DISABLED',true)`,
        [manifest.id, manifest.id],
      ),
    ).rejects.toThrow();
  });
});
