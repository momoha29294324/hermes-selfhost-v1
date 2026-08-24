import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import {
  lockManifestForItem,
  loadManifestById,
  loadManifestHistoryForItem,
  sha256Hex,
  type DispatchManifest,
  type Transport,
} from '@/lib/pipeline/r6bDispatch';
import {
  canonicalJson,
  getLiveReadiness,
  hashTransportPayload,
  readTransportPayload,
  TRANSPORT_LIVE_REQUIREMENTS,
  TransportPayloadError,
  unsupportedPayloadKeys,
  validateEmailSubject,
  EMPTY_TRANSPORT_PAYLOAD,
  type PayloadJson,
  type TransportPayload,
} from '@/lib/pipeline/r6bTransportPayload';
import {
  completeEmailSubject,
  ManifestCompletionError,
  TRANSPORT_PAYLOAD_COMPLETION_REASON,
  type CompletionBlockCode,
  type CompletionExpectedState,
} from '@/lib/pipeline/r6bManifestCompletion';
import { dispatchManifest, DispatchBlockedError, type DispatchBlockCode } from '@/lib/pipeline/r6bDispatcher';
import { DRY_RUN_ADAPTERS } from '@/lib/pipeline/r6bTransportAdapters';
import type { Sql } from '@/lib/db/sql';

/**
 * R6B-C.2A §12 — payload transport immuable, empreinte canonique, LIVE
 * readiness et complétion humaine.
 *
 * Même patron PGlite temporaire que `r6bDispatch.test.ts` / `r6bDispatcher.test.ts` :
 * jamais la base de production. Aucun test de ce fichier n'ouvre de connexion
 * réseau ni ne produit d'`outreach_event` — c'est précisément ce que plusieurs
 * d'entre eux vérifient.
 */

const ROOT = resolve(__dirname, '..');
const TEXT = 'Bonjour, une question rapide sur vos réservations.';
const SUBJECT = 'Question rapide sur vos réservations';

let sql: Sql;
let dir: string;
let campaignId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-r6b-payload-'));
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
  await sql.query('delete from outreach_events');
  await sql.query('delete from r6b_dispatch_manifests');
  await sql.query('delete from r6b_batch_votes');
  await sql.query('delete from r6b_batch_items');
  await sql.query('delete from r6b_batches');
  await sql.query('delete from prospect_evidence');
  await sql.query('delete from prospects');
});

async function makeProspect(fields: {
  email?: string | null;
  phone?: string | null;
  websiteUrl?: string | null;
  instagramHandle?: string | null;
} = {}): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `insert into prospects
       (campaign_id, canonical_key, display_name, email, phone, website_url, instagram_handle, identity_review)
     values ($1,$2,'ACME ATELIER',$3,$4,$5,$6,'confirmed') returning id`,
    [
      campaignId,
      `prospect-${Math.random()}`,
      fields.email ?? null,
      fields.phone ?? null,
      fields.websiteUrl ?? null,
      fields.instagramHandle ?? null,
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

/** Verrouille par le vrai chemin humain (vote puis lock), jamais par un INSERT direct. */
async function lockFor(transport: 'email' | 'instagram_dm' | 'web_form' | 'phone_call'): Promise<DispatchManifest> {
  let prospectId: string;
  let channels: readonly string[];

  if (transport === 'email') {
    prospectId = await makeProspect({ email: 'contact@acme.fr' });
    await addEvidence(prospectId, 'email', 'contact@acme.fr');
    channels = ['email'];
  } else if (transport === 'instagram_dm') {
    prospectId = await makeProspect({ instagramHandle: 'acmeatelier' });
    await addEvidence(prospectId, 'instagram_handle', 'acmeatelier');
    channels = ['instagram'];
  } else if (transport === 'web_form') {
    prospectId = await makeProspect({ websiteUrl: 'https://acme.fr' });
    await addEvidence(prospectId, 'funnel_observed', 'form_contact: /contact');
    channels = ['website'];
  } else {
    prospectId = await makeProspect({ phone: '+33616790858' });
    await addEvidence(prospectId, 'phone', '+33616790858');
    channels = ['phone'];
  }

  const itemId = await makeItem(prospectId, channels);
  await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: TEXT, note: null });
  return lockManifestForItem(sql, { itemId, transport });
}

function expectedFrom(manifest: DispatchManifest): CompletionExpectedState {
  return {
    batchItemId: manifest.batchItemId,
    transport: manifest.transport as Transport,
    recipient: manifest.recipient,
    recipientEvidenceIds: manifest.recipientEvidenceIds,
    approvedTextSha256: manifest.approvedTextSha256,
    identityReview: manifest.identityReview,
    transportPayloadSha256: manifest.transportPayloadSha256,
  };
}

async function complete(manifest: DispatchManifest, subject = SUBJECT) {
  return completeEmailSubject(sql, {
    manifestId: manifest.id,
    expected: expectedFrom(manifest),
    subject,
    previewedTransportPayloadSha256: hashTransportPayload({ subject }),
  });
}

async function expectCompletionBlocked(promise: Promise<unknown>, code: CompletionBlockCode): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `attendu un ManifestCompletionError ${code}`).toBeInstanceOf(ManifestCompletionError);
  expect((error as ManifestCompletionError).code).toBe(code);
}

async function expectDispatchBlocked(promise: Promise<unknown>, code: DispatchBlockCode): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, `attendu un DispatchBlockedError ${code}`).toBeInstanceOf(DispatchBlockedError);
  expect((error as DispatchBlockedError).code).toBe(code);
}

describe('§2 — sérialisation canonique et empreinte du payload', () => {
  it('l’ordre d’écriture des clés ne change pas l’empreinte', () => {
    const a = { subject: 'Objet', reply_to: 'x@y.fr' } as const;
    const b = { reply_to: 'x@y.fr', subject: 'Objet' } as const;
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(hashTransportPayload(a)).toBe(hashTransportPayload(b));
  });

  it('le formatage JSON (espaces, indentation) ne change pas l’empreinte', () => {
    const pretty: unknown = JSON.parse(JSON.stringify({ subject: SUBJECT }, null, 4));
    const compact: unknown = JSON.parse(JSON.stringify({ subject: SUBJECT }));
    const a = readTransportPayload(pretty);
    const b = readTransportPayload(compact);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(hashTransportPayload(a!)).toBe(hashTransportPayload(b!));
    // Aucune espace de mise en forme : seule celle du contenu subsiste.
    expect(canonicalJson(a!)).toBe(`{"subject":${JSON.stringify(SUBJECT)}}`);
  });

  it('trie récursivement, y compris dans un objet imbriqué', () => {
    const a = { form_field_mapping: { message: 'body', email: 'to', name: 'x' } };
    const b = { form_field_mapping: { name: 'x', email: 'to', message: 'body' } };
    expect(canonicalJson(a)).toBe('{"form_field_mapping":{"email":"to","message":"body","name":"x"}}');
    expect(hashTransportPayload(a)).toBe(hashTransportPayload(b));
  });

  it('préserve l’ordre d’un tableau — un tableau n’est pas un ensemble', () => {
    expect(canonicalJson({ k: ['a', 'b'] })).not.toBe(canonicalJson({ k: ['b', 'a'] }));
  });

  it('la moindre mutation du payload change l’empreinte', () => {
    const base = hashTransportPayload({ subject: SUBJECT });
    expect(hashTransportPayload({ subject: `${SUBJECT} ` })).not.toBe(base);
    expect(hashTransportPayload({ subject: SUBJECT.toLowerCase() })).not.toBe(base);
    expect(hashTransportPayload({ subject: SUBJECT, extra: 'x' })).not.toBe(base);
    expect(hashTransportPayload(EMPTY_TRANSPORT_PAYLOAD)).not.toBe(base);
  });

  it('une propriété absente et une propriété à undefined sont le même payload', () => {
    const withUndefined = { subject: SUBJECT, reply_to: undefined } as unknown as Record<string, PayloadJson>;
    expect(hashTransportPayload(withUndefined)).toBe(hashTransportPayload({ subject: SUBJECT }));
  });

  it('le payload vide a l’empreinte utilisée par la migration 0022', () => {
    expect(canonicalJson(EMPTY_TRANSPORT_PAYLOAD)).toBe('{}');
    expect(hashTransportPayload(EMPTY_TRANSPORT_PAYLOAD)).toBe(sha256Hex('{}'));
    const migration = readFileSync(resolve(ROOT, 'db/migrations/0022_r6b_transport_payload.sql'), 'utf8');
    expect(migration).toContain(hashTransportPayload(EMPTY_TRANSPORT_PAYLOAD));
  });

  it('refuse ce qui n’est pas un payload : null, tableau, nombre non fini', () => {
    expect(readTransportPayload(null)).toBeNull();
    expect(readTransportPayload(['a'])).toBeNull();
    expect(readTransportPayload('subject')).toBeNull();
    expect(readTransportPayload({ subject: null })).toBeNull();
    expect(readTransportPayload({ nested: { deep: null } })).toBeNull();
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TransportPayloadError);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(TransportPayloadError);
  });
});

describe('§3 — prérequis LIVE par transport, centralisés', () => {
  it('couvre toute la taxonomie R6B-B.1', () => {
    expect(Object.keys(TRANSPORT_LIVE_REQUIREMENTS).sort()).toEqual(
      ['email', 'facebook_dm', 'instagram_dm', 'phone_call', 'sms', 'web_form', 'whatsapp'].sort(),
    );
  });

  it('email exige un objet, et rien d’autre', () => {
    expect(TRANSPORT_LIVE_REQUIREMENTS.email.map((r) => r.key)).toEqual(['subject']);
  });

  it('instagram_dm, facebook_dm, whatsapp et sms n’exigent rien de plus que le corps approuvé', () => {
    for (const transport of ['instagram_dm', 'facebook_dm', 'whatsapp', 'sms'] as const) {
      expect(TRANSPORT_LIVE_REQUIREMENTS[transport], transport).toEqual([]);
    }
  });

  it('phone_call exige un humain, et aucune donnée ne peut le remplacer', () => {
    const requirement = TRANSPORT_LIVE_REQUIREMENTS.phone_call[0]!;
    expect(requirement.key).toBe('human_caller');
    expect(requirement.kind).toBe('non_automatable');
    // Aucun payload, même construit exprès, ne rend un appel automatique « prêt ».
    const attempts: TransportPayload[] = [{}, { human_caller: 'oui' }, { human_caller: true }];
    for (const payload of attempts) {
      expect(requirement.isSatisfied(payload), JSON.stringify(payload)).toBe(false);
    }
    // …et `human_caller` n'est même pas une clé de payload acceptée.
    expect(unsupportedPayloadKeys('phone_call', { human_caller: 'oui' })).toEqual(['human_caller']);
  });

  it('web_form exige un mapping de champs structuré, jamais la seule vue d’un <form>', () => {
    const requirement = TRANSPORT_LIVE_REQUIREMENTS.web_form[0]!;
    expect(requirement.key).toBe('form_field_mapping');
    expect(requirement.isSatisfied({})).toBe(false);
    expect(requirement.isSatisfied({ form_field_mapping: {} })).toBe(false);
    expect(requirement.isSatisfied({ form_field_mapping: 'contact' })).toBe(false);
    expect(requirement.isSatisfied({ form_field_mapping: { message: 'body', email: 'from' } })).toBe(true);
  });

  it('refuse une clé que le transport ne connaît pas', () => {
    expect(unsupportedPayloadKeys('email', { subject: SUBJECT })).toEqual([]);
    expect(unsupportedPayloadKeys('email', { subject: SUBJECT, to: 'ailleurs@example.com' })).toEqual(['to']);
    expect(unsupportedPayloadKeys('instagram_dm', { subject: SUBJECT })).toEqual(['subject']);
  });
});

describe('§4 — LIVE readiness, déterministe et purement locale', () => {
  it('email sans objet → not ready, missing = [subject]', () => {
    expect(getLiveReadiness({ transport: 'email', transportPayload: {} })).toEqual({
      ready: false,
      missing: ['subject'],
    });
  });

  it('email avec objet → ready', () => {
    expect(getLiveReadiness({ transport: 'email', transportPayload: { subject: SUBJECT } })).toEqual({
      ready: true,
      missing: [],
    });
  });

  it('instagram_dm et whatsapp actuels → ready', () => {
    for (const transport of ['instagram_dm', 'whatsapp'] as const) {
      expect(getLiveReadiness({ transport, transportPayload: {} }), transport).toEqual({ ready: true, missing: [] });
    }
  });

  it('phone_call → not ready, missing = [human_caller]', () => {
    expect(getLiveReadiness({ transport: 'phone_call', transportPayload: {} })).toEqual({
      ready: false,
      missing: ['human_caller'],
    });
  });

  it('web_form sans mapping → not ready, missing = [form_field_mapping]', () => {
    expect(getLiveReadiness({ transport: 'web_form', transportPayload: {} })).toEqual({
      ready: false,
      missing: ['form_field_mapping'],
    });
  });

  it('un objet stocké non canonique (espaces de bord) ne satisfait pas l’exigence', () => {
    expect(getLiveReadiness({ transport: 'email', transportPayload: { subject: `  ${SUBJECT}  ` } }).ready).toBe(false);
    expect(getLiveReadiness({ transport: 'email', transportPayload: { subject: '' } }).ready).toBe(false);
    expect(getLiveReadiness({ transport: 'email', transportPayload: { subject: 42 } }).ready).toBe(false);
  });

  it('transport ou payload absents → not ready plutôt qu’une supposition', () => {
    expect(getLiveReadiness({ transport: null, transportPayload: {} }).missing).toEqual(['transport']);
    expect(getLiveReadiness({ transport: 'email', transportPayload: null }).missing).toEqual(['transport_payload']);
  });

  it('ne lit ni base, ni réseau, ni modèle — la même structure donne toujours le même verdict', () => {
    const source = readFileSync(resolve(ROOT, 'src/lib/pipeline/r6bTransportPayload.ts'), 'utf8');
    const imports = source.match(/^import[\s\S]*?from\s+'[^']+';$/gm) ?? [];
    // Le module ne peut pas interroger la base : il n'en importe rien, pas
    // même le type `Sql`. Un futur « juste une petite lecture » y serait donc
    // visible en revue plutôt que noyé dans le corps du fichier.
    for (const line of imports) {
      expect(line).not.toMatch(/@\/lib\/db|@\/lib\/http|undici|node:http|ModelRouter|nodemailer|resend|sendgrid/i);
    }
    const body = source.slice(source.indexOf('export function canonicalJson'));
    for (const forbidden of ['HttpClient', 'fetch(', 'ModelRouter', 'sql.query', 'await ']) {
      expect(body, forbidden).not.toContain(forbidden);
    }
    const subject = { transport: 'email', transportPayload: { subject: SUBJECT } } as const;
    expect(getLiveReadiness(subject)).toEqual(getLiveReadiness(subject));
  });
});

describe('§6/§12 — l’objet vient de l’humain, jamais du système', () => {
  it('un objet vide est refusé', () => {
    expect(validateEmailSubject('')).toMatchObject({ ok: false, code: 'empty' });
  });

  it('un objet composé uniquement d’espaces est refusé', () => {
    expect(validateEmailSubject('     ')).toMatchObject({ ok: false, code: 'empty' });
  });

  it('une injection d’en-tête (CR/LF) est refusée, jamais nettoyée', () => {
    for (const raw of [
      'Objet\r\nBcc: victime@example.com',
      'Objet\nX-Header: 1',
      'Objet\r',
      'Objet\tavec tabulation',
      `Objet${String.fromCharCode(0)}nul`,
    ]) {
      const result = validateEmailSubject(raw);
      expect(result, JSON.stringify(raw)).toMatchObject({ ok: false, code: 'control_characters' });
    }
  });

  it('un objet trop court ou trop long est refusé', () => {
    expect(validateEmailSubject('ok')).toMatchObject({ ok: false, code: 'too_short' });
    expect(validateEmailSubject('x'.repeat(121))).toMatchObject({ ok: false, code: 'too_long' });
  });

  it('un objet valide est conservé mot pour mot, seulement rogné', () => {
    expect(validateEmailSubject(`  ${SUBJECT}  `)).toEqual({ ok: true, subject: SUBJECT });
  });

  it('aucun objet par défaut, suggéré ou généré nulle part dans le code', () => {
    for (const file of [
      'src/lib/pipeline/r6bTransportPayload.ts',
      'src/lib/pipeline/r6bManifestCompletion.ts',
      'src/lib/pipeline/r6bTransportAdapters.ts',
      'src/lib/pipeline/r6bDispatcher.ts',
    ]) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      expect(source, file).not.toMatch(/DEFAULT_SUBJECT|FALLBACK_SUBJECT/);
      expect(source, file).not.toMatch(/generateSubject|suggestSubject|buildSubject|defaultSubject/i);
      // Aucun repli sur une valeur littérale quand l'objet est absent.
      expect(source, file).not.toMatch(/subject\s*(\?\?|\|\|)\s*['"`]/);
      expect(source, file).not.toMatch(/ModelRouter|generateMessages/);
    }
  });


  it('l’action de complétion refuse une saisie invalide avant toute écriture', async () => {
    const manifest = await lockFor('email');
    for (const bad of ['', '   ', 'Objet\r\nBcc: x@y.fr', 'ab']) {
      await expectCompletionBlocked(complete(manifest, bad), 'SUBJECT_INVALID');
    }
    const history = await loadManifestHistoryForItem(sql, manifest.batchItemId);
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe('LOCKED');
    expect(history[0]!.transportPayloadSha256).toBe(hashTransportPayload(EMPTY_TRANSPORT_PAYLOAD));
  });
});

describe('§5 — un manifeste LOCKED n’est jamais modifié, il est remplacé', () => {
  it('la complétion supersède l’ancien manifeste avec la raison exacte et en crée un nouveau', async () => {
    const before = await lockFor('email');
    const { superseded, locked } = await complete(before);

    expect(superseded.id).toBe(before.id);
    expect(superseded.status).toBe('SUPERSEDED');
    expect(superseded.supersededReason).toBe('live_transport_payload_completion');
    expect(superseded.supersededReason).toBe(TRANSPORT_PAYLOAD_COMPLETION_REASON);
    expect(superseded.supersededBy).toBe(locked.id);
    expect(superseded.supersededAt).not.toBeNull();

    expect(locked.id).not.toBe(before.id);
    expect(locked.status).toBe('LOCKED');
  });

  it('l’ancien manifeste garde son contenu intact — seul son statut change', async () => {
    const before = await lockFor('email');
    await complete(before);
    const after = await loadManifestById(sql, before.id);

    expect(after).not.toBeNull();
    expect(after!.transport).toBe(before.transport);
    expect(after!.recipient).toBe(before.recipient);
    expect(after!.approvedText).toBe(before.approvedText);
    expect(after!.approvedTextSha256).toBe(before.approvedTextSha256);
    expect(after!.transportPayload).toEqual({});
    expect(after!.transportPayloadSha256).toBe(hashTransportPayload(EMPTY_TRANSPORT_PAYLOAD));
    expect(after!.lockedAt).toEqual(before.lockedAt);
  });

  it('le nouveau manifeste conserve batch, item, prospect, transport, destinataire, preuves, texte et empreinte', async () => {
    const before = await lockFor('email');
    const { locked } = await complete(before);

    expect(locked.batchId).toBe(before.batchId);
    expect(locked.batchItemId).toBe(before.batchItemId);
    expect(locked.prospectId).toBe(before.prospectId);
    expect(locked.approvalVoteId).toBe(before.approvalVoteId);
    expect(locked.transport).toBe(before.transport);
    expect(locked.recipient).toBe(before.recipient);
    expect(locked.recipientEvidenceIds).toEqual(before.recipientEvidenceIds);
    expect(locked.recipientProvenance).toEqual(before.recipientProvenance);
    expect(locked.identityReview).toBe(before.identityReview);
    expect(locked.businessName).toBe(before.businessName);
    expect(locked.approvedText).toBe(before.approvedText);
    expect(locked.approvedTextSha256).toBe(before.approvedTextSha256);
    expect(locked.hookType).toBe(before.hookType);
    expect(locked.hookEvidenceIds).toEqual(before.hookEvidenceIds);
  });

  it('le nouveau manifeste porte l’objet saisi et sa propre empreinte de payload', async () => {
    const before = await lockFor('email');
    const { locked } = await complete(before);

    expect(locked.transportPayload).toEqual({ subject: SUBJECT });
    expect(locked.transportPayloadSha256).toBe(hashTransportPayload({ subject: SUBJECT }));
    expect(locked.transportPayloadSha256).not.toBe(before.transportPayloadSha256);
    expect(getLiveReadiness(locked)).toEqual({ ready: true, missing: [] });
  });

  it('l’historique reste append-only : deux lignes, aucune supprimée', async () => {
    const before = await lockFor('email');
    const { locked } = await complete(before);
    const history = await loadManifestHistoryForItem(sql, before.batchItemId);
    expect(history.map((m) => m.id)).toEqual([before.id, locked.id]);
    expect(history.map((m) => m.status)).toEqual(['SUPERSEDED', 'LOCKED']);
  });

  it('un seul manifeste LOCKED actif par item, avant comme après la complétion', async () => {
    const before = await lockFor('email');
    const { locked } = await complete(before);
    const rows = await sql.query<{ id: string }>(
      `select id from r6b_dispatch_manifests where batch_item_id = $1 and status = 'LOCKED'`,
      [before.batchItemId],
    );
    expect(rows.map((r) => r.id)).toEqual([locked.id]);
  });

  it('compléter deux fois le même objet est refusé — rien à remplacer', async () => {
    const before = await lockFor('email');
    const { locked } = await complete(before);
    await expectCompletionBlocked(complete(locked), 'TRANSPORT_PAYLOAD_UNCHANGED');
  });

  it('ne touche jamais outreach_events : compléter un payload n’est pas un contact', async () => {
    const before = await lockFor('email');
    await complete(before);
    const rows = await sql.query<{ n: string }>('select count(*)::text as n from outreach_events');
    expect(rows[0]?.n).toBe('0');
  });

  it('ne touche pas les manifestes des autres items', async () => {
    const email = await lockFor('email');
    const instagram = await lockFor('instagram_dm');
    const beforeOther = await loadManifestById(sql, instagram.id);
    await complete(email);
    const afterOther = await loadManifestById(sql, instagram.id);
    expect(afterOther).toEqual(beforeOther);
  });
});

describe('§8 — TOCTOU : toute divergence entre l’écran et la base bloque', () => {
  it('destinataire modifié entre l’affichage et la confirmation → fail closed', async () => {
    const manifest = await lockFor('email');
    await sql.query(`update r6b_dispatch_manifests set recipient = 'ailleurs@acme.fr' where id = $1`, [manifest.id]);
    await expectCompletionBlocked(complete(manifest), 'RECIPIENT_DRIFT');
  });

  it('corps du message modifié sans que son empreinte bouge → fail closed', async () => {
    const manifest = await lockFor('email');
    await sql.query(`update r6b_dispatch_manifests set approved_text = $2 where id = $1`, [
      manifest.id,
      `${TEXT} (phrase ajoutée après approbation)`,
    ]);
    await expectCompletionBlocked(complete(manifest), 'APPROVED_TEXT_SHA_MISMATCH');
  });

  it('empreinte du texte modifiée depuis l’affichage → fail closed', async () => {
    const manifest = await lockFor('email');
    const other = sha256Hex('autre texte');
    await sql.query(
      `update r6b_dispatch_manifests set approved_text = 'autre texte', approved_text_sha256 = $2 where id = $1`,
      [manifest.id, other],
    );
    await expectCompletionBlocked(complete(manifest), 'APPROVED_TEXT_SHA_DRIFT');
  });

  it('preuves du destinataire modifiées → fail closed', async () => {
    const manifest = await lockFor('email');
    await sql.query(`update r6b_dispatch_manifests set recipient_evidence_ids = $2 where id = $1`, [
      manifest.id,
      JSON.stringify(['00000000-0000-0000-0000-000000000000']),
    ]);
    await expectCompletionBlocked(complete(manifest), 'RECIPIENT_EVIDENCE_DRIFT');
  });

  it('identité figée modifiée depuis l’affichage → fail closed', async () => {
    const manifest = await lockFor('email');
    await sql.query(`update r6b_dispatch_manifests set identity_review = 'uncertain' where id = $1`, [manifest.id]);
    await expectCompletionBlocked(complete(manifest), 'IDENTITY_DRIFT');
  });

  it('identité devenue ambiguë sur la fiche prospect → fail closed', async () => {
    const manifest = await lockFor('email');
    await sql.query(`update prospects set identity_review = 'uncertain' where id = $1`, [manifest.prospectId]);
    await sql.query(
      `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
       values ($1,'website_title','Prestation Express Villeurbanne','website','crawl','https://acme.fr',1.0)`,
      [manifest.prospectId],
    );
    await expectCompletionBlocked(complete(manifest), 'IDENTITY_AMBIGUITY');
  });

  it('transport différent de celui affiché → fail closed', async () => {
    const manifest = await lockFor('email');
    await expectCompletionBlocked(
      completeEmailSubject(sql, {
        manifestId: manifest.id,
        expected: { ...expectedFrom(manifest), transport: 'whatsapp' },
        subject: SUBJECT,
        previewedTransportPayloadSha256: hashTransportPayload({ subject: SUBJECT }),
      }),
      'TRANSPORT_DRIFT',
    );
  });

  it('item de batch différent de celui affiché → fail closed', async () => {
    const manifest = await lockFor('email');
    await expectCompletionBlocked(
      completeEmailSubject(sql, {
        manifestId: manifest.id,
        expected: { ...expectedFrom(manifest), batchItemId: '00000000-0000-0000-0000-000000000000' },
        subject: SUBJECT,
        previewedTransportPayloadSha256: hashTransportPayload({ subject: SUBJECT }),
      }),
      'BATCH_ITEM_DRIFT',
    );
  });

  it('empreinte de payload prévisualisée qui ne correspond pas à l’objet confirmé → fail closed', async () => {
    const manifest = await lockFor('email');
    await expectCompletionBlocked(
      completeEmailSubject(sql, {
        manifestId: manifest.id,
        expected: expectedFrom(manifest),
        subject: SUBJECT,
        previewedTransportPayloadSha256: hashTransportPayload({ subject: 'un autre objet que celui affiché' }),
      }),
      'TRANSPORT_PAYLOAD_SHA_DRIFT',
    );
  });

  it('payload déjà complété par ailleurs entre l’affichage et la confirmation → fail closed', async () => {
    const manifest = await lockFor('email');
    const { locked } = await complete(manifest, 'Objet posé par une autre session');
    // un opérateur confirme un écran affiché avant cette complétion concurrente.
    await expectCompletionBlocked(
      completeEmailSubject(sql, {
        manifestId: locked.id,
        expected: { ...expectedFrom(locked), transportPayloadSha256: manifest.transportPayloadSha256 },
        subject: SUBJECT,
        previewedTransportPayloadSha256: hashTransportPayload({ subject: SUBJECT }),
      }),
      'TRANSPORT_PAYLOAD_DRIFT',
    );
  });

  it('manifeste déjà supersédé → fail closed', async () => {
    const manifest = await lockFor('email');
    await complete(manifest);
    await expectCompletionBlocked(complete(manifest), 'MANIFEST_NOT_LOCKED');
  });

  it('manifeste inconnu → fail closed', async () => {
    const manifest = await lockFor('email');
    await expectCompletionBlocked(
      completeEmailSubject(sql, {
        manifestId: '99999999-9999-9999-9999-999999999999',
        expected: expectedFrom(manifest),
        subject: SUBJECT,
        previewedTransportPayloadSha256: hashTransportPayload({ subject: SUBJECT }),
      }),
      'MANIFEST_NOT_FOUND',
    );
  });

  it('un transport non complétable par un objet est refusé', async () => {
    const manifest = await lockFor('instagram_dm');
    await expectCompletionBlocked(complete(manifest), 'TRANSPORT_NOT_COMPLETABLE');
    const history = await loadManifestHistoryForItem(sql, manifest.batchItemId);
    expect(history.map((m) => m.status)).toEqual(['LOCKED']);
  });

  it('un refus ne laisse aucune trace : l’état de la base est identique avant et après', async () => {
    const manifest = await lockFor('email');
    const before = await sql.query(`select * from r6b_dispatch_manifests order by id`);
    await expectCompletionBlocked(complete(manifest, 'ab'), 'SUBJECT_INVALID');
    await sql.query(`update r6b_dispatch_manifests set recipient = 'ailleurs@acme.fr' where id = $1`, [manifest.id]);
    await expectCompletionBlocked(complete(manifest), 'RECIPIENT_DRIFT');
    await sql.query(`update r6b_dispatch_manifests set recipient = $2 where id = $1`, [
      manifest.id,
      manifest.recipient,
    ]);
    const after = await sql.query(`select * from r6b_dispatch_manifests order by id`);
    expect(after).toEqual(before);
  });
});

describe('§10 — le dispatcher vérifie l’intégrité du payload, sans interdire un dry-run incomplet', () => {
  it('un manifeste email sans objet passe en DRY_RUN_OK et dit ce qui manque', async () => {
    const manifest = await lockFor('email');
    const result = await dispatchManifest(sql, manifest.id, 'DRY_RUN');
    expect(result.status).toBe('DRY_RUN_OK');
    expect(result.liveReady).toBe(false);
    expect(result.missingForLive).toEqual(['subject']);
    expect(result.preview.payloadFields).toEqual({ to: 'contact@acme.fr', body: TEXT });
    expect(result.networkAttempted).toBe(false);
    expect(result.sent).toBe(false);
  });

  it('un manifeste email complété passe en DRY_RUN_OK, prêt et avec l’objet dans le payload', async () => {
    const before = await lockFor('email');
    const { locked } = await complete(before);
    const result = await dispatchManifest(sql, locked.id, 'DRY_RUN');

    expect(result.status).toBe('DRY_RUN_OK');
    expect(result.liveReady).toBe(true);
    expect(result.missingForLive).toEqual([]);
    expect(result.transportPayloadSha256).toBe(hashTransportPayload({ subject: SUBJECT }));
    expect(result.preview.payloadFields).toEqual({ to: 'contact@acme.fr', subject: SUBJECT, body: TEXT });
    expect(result.networkAttempted).toBe(false);
    expect(result.sent).toBe(false);
  });

  it('une empreinte de payload qui ne correspond plus au payload bloque le dispatch', async () => {
    const manifest = await lockFor('email');
    await sql.query(`update r6b_dispatch_manifests set transport_payload = $2 where id = $1`, [
      manifest.id,
      JSON.stringify({ subject: 'objet glissé après le lock' }),
    ]);
    await expectDispatchBlocked(dispatchManifest(sql, manifest.id, 'DRY_RUN'), 'TRANSPORT_PAYLOAD_SHA_MISMATCH');
  });

  it('une empreinte de payload mal formée bloque le dispatch', async () => {
    const manifest = await lockFor('email');
    await sql.query(
      `alter table r6b_dispatch_manifests drop constraint r6b_manifest_transport_payload_sha_shape`,
    );
    try {
      await sql.query(`update r6b_dispatch_manifests set transport_payload_sha256 = 'pas-un-hash' where id = $1`, [
        manifest.id,
      ]);
      await expectDispatchBlocked(dispatchManifest(sql, manifest.id, 'DRY_RUN'), 'TRANSPORT_PAYLOAD_SHA_INVALID');
    } finally {
      await sql.query(`update r6b_dispatch_manifests set transport_payload_sha256 = $2 where id = $1`, [
        manifest.id,
        manifest.transportPayloadSha256,
      ]);
      await sql.query(
        `alter table r6b_dispatch_manifests add constraint r6b_manifest_transport_payload_sha_shape
           check (transport_payload_sha256 ~ '^[0-9a-f]{64}$')`,
      );
    }
  });

  it('une clé hors taxonomie dans le payload bloque le dispatch', async () => {
    const manifest = await lockFor('email');
    const payload = { subject: SUBJECT, to: 'ailleurs@example.com' };
    await sql.query(
      `update r6b_dispatch_manifests set transport_payload = $2, transport_payload_sha256 = $3 where id = $1`,
      [manifest.id, JSON.stringify(payload), hashTransportPayload(payload)],
    );
    await expectDispatchBlocked(dispatchManifest(sql, manifest.id, 'DRY_RUN'), 'TRANSPORT_PAYLOAD_INVALID');
  });

  it('phone_call reste explicitement non prêt, avec human_caller manquant', async () => {
    const manifest = await lockFor('phone_call');
    const result = await dispatchManifest(sql, manifest.id, 'DRY_RUN');
    expect(result.liveReady).toBe(false);
    expect(result.missingForLive).toEqual(['human_caller']);
    expect(result.preview.payloadFields).toEqual({ to_msisdn: '+33616790858', script: TEXT });
  });

  it('web_form reste explicitement non prêt, avec form_field_mapping manquant', async () => {
    const manifest = await lockFor('web_form');
    const result = await dispatchManifest(sql, manifest.id, 'DRY_RUN');
    expect(result.liveReady).toBe(false);
    expect(result.missingForLive).toEqual(['form_field_mapping']);
  });

  it('instagram_dm est prêt sans propriété supplémentaire', async () => {
    const manifest = await lockFor('instagram_dm');
    const result = await dispatchManifest(sql, manifest.id, 'DRY_RUN');
    expect(result.liveReady).toBe(true);
    expect(result.missingForLive).toEqual([]);
  });

  it('l’adapter ne comble jamais une propriété absente, même par une chaîne vide', () => {
    const preview = DRY_RUN_ADAPTERS.email.dryRun({
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
    });
    expect(Object.keys(preview.payloadFields)).not.toContain('subject');
    expect(preview.liveReady).toBe(false);
  });
});

describe('§11 — audit du payload, sans polluer outreach_events', () => {
  it('journalise l’empreinte du payload, live_ready et missing_for_live', async () => {
    const before = await lockFor('email');
    const incomplete = await dispatchManifest(sql, before.id, 'DRY_RUN');
    const { locked } = await complete(before);
    const complete2 = await dispatchManifest(sql, locked.id, 'DRY_RUN');

    const readAttempt = async (attemptId: string) => {
      const rows = await sql.query<{ payloadSha: string | null; liveReady: boolean | null; missing: unknown }>(
        `select transport_payload_sha256 as "payloadSha", live_ready as "liveReady",
                missing_for_live as "missing"
           from r6b_dispatch_attempts where id = $1`,
        [attemptId],
      );
      return rows[0];
    };

    expect(await readAttempt(incomplete.attemptId)).toEqual({
      payloadSha: hashTransportPayload(EMPTY_TRANSPORT_PAYLOAD),
      liveReady: false,
      missing: ['subject'],
    });
    expect(await readAttempt(complete2.attemptId)).toEqual({
      payloadSha: hashTransportPayload({ subject: SUBJECT }),
      liveReady: true,
      missing: [],
    });
  });

  it('la base refuse une ligne qui se dirait prête tout en listant un manque', async () => {
    const manifest = await lockFor('email');
    await expect(
      sql.query(
        `insert into r6b_dispatch_attempts
           (requested_manifest_id, manifest_id, mode, transport, recipient, approved_text_sha256,
            transport_payload_sha256, live_ready, missing_for_live, status)
         values ($1,$2,'DRY_RUN','email','contact@acme.fr',$3,$4,true,'["subject"]','DRY_RUN_OK')`,
        [manifest.id, manifest.id, manifest.approvedTextSha256, manifest.transportPayloadSha256],
      ),
    ).rejects.toThrow();
  });

  it('la base refuse live_ready sans missing_for_live, et l’inverse', async () => {
    const manifest = await lockFor('email');
    for (const [ready, missing] of [
      ['true', 'null'],
      ['null', `'[]'::jsonb`],
    ] as const) {
      await expect(
        sql.query(
          `insert into r6b_dispatch_attempts
             (requested_manifest_id, manifest_id, mode, transport, recipient, approved_text_sha256,
              transport_payload_sha256, live_ready, missing_for_live, status)
           values ($1,$2,'DRY_RUN','email','contact@acme.fr',$3,$4,${ready},${missing},'DRY_RUN_OK')`,
          [manifest.id, manifest.id, manifest.approvedTextSha256, manifest.transportPayloadSha256],
        ),
      ).rejects.toThrow();
    }
  });

  it('aucun outreach_event, aucun envoi, aucune tentative réseau après tout ce parcours', async () => {
    const before = await lockFor('email');
    await dispatchManifest(sql, before.id, 'DRY_RUN');
    const { locked } = await complete(before);
    await dispatchManifest(sql, locked.id, 'DRY_RUN');

    const rows = await sql.query<{ outreach: string; sent: string; net: string }>(
      `select (select count(*) from outreach_events)::text as outreach,
              (select count(*) from r6b_dispatch_attempts where sent = true)::text as sent,
              (select count(*) from r6b_dispatch_attempts where network_attempted = true)::text as net`,
    );
    expect(rows[0]).toEqual({ outreach: '0', sent: '0', net: '0' });
  });
});

describe('§15 — aucun sender, aucun provider, aucun réseau introduit par C.2A', () => {
  it('aucun module de complétion n’importe de client réseau ni de provider d’envoi', () => {
    for (const file of [
      'src/lib/pipeline/r6bTransportPayload.ts',
      'src/lib/pipeline/r6bManifestCompletion.ts',
    ]) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      const imports = source.match(/^import[\s\S]*?from\s+'[^']+';$/gm) ?? [];
      for (const line of imports) {
        expect(line, file).not.toMatch(
          /undici|node:http|node:https|node:net|node:dgram|child_process|nodemailer|resend|sendgrid|brevo|@\/lib\/http/i,
        );
      }
    }
  });

  it('aucun credential ni transport SMTP n’apparaît dans le dépôt applicatif', () => {
    for (const file of [
      'src/lib/pipeline/r6bTransportPayload.ts',
      'src/lib/pipeline/r6bManifestCompletion.ts',
      'src/lib/pipeline/r6bTransportAdapters.ts',
    ]) {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      for (const forbidden of ['SMTP_', 'RESEND_API_KEY', 'SENDGRID_API_KEY', 'BREVO_', 'createTransport']) {
        expect(source, `${file} / ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

});
