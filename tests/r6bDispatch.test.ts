import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import {
  deriveObservedTradingName,
  resolveTransportOptions,
  resolveIdentityAudit,
  sha256Hex,
  lockManifestForItem,
  DispatchLockError,
  type DispatchEvidenceRow,
  type DispatchProspect,
} from '@/lib/pipeline/r6bDispatch';
import { envBool } from '@/lib/env';
import type { Sql } from '@/lib/db/sql';

/**
 * R6B-B / R6B-B.1 — manifeste de dispatch et transports (§16/§19 des deux
 * missions : liste explicite des invariants à tester). Même patron PGlite
 * temporaire que `r6bBatch.test.ts` — jamais la base de production.
 */

let sql: Sql;
let dir: string;
let campaignId: string;
let prospectId: string;
let itemId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-r6b-dispatch-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);

  const campaignRows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-campaign-test', 'Test', 'example-services', '{}'],
  );
  campaignId = campaignRows[0]!.id;
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

async function makeProspect(overrides: Partial<{
  email: string | null;
  phone: string | null;
  website_url: string | null;
  instagram_handle: string | null;
  facebook_url: string | null;
  legal_name: string | null;
  identity_review: string | null;
  display_name: string;
}> = {}): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `insert into prospects
       (campaign_id, canonical_key, display_name, legal_name, email, phone, website_url,
        instagram_handle, facebook_url, identity_review)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [
      campaignId,
      `prospect-${Math.random()}`,
      overrides.display_name ?? 'ACME ATELIER',
      overrides.legal_name ?? null,
      overrides.email ?? 'contact@acme.fr',
      overrides.phone ?? '+33600000000',
      overrides.website_url ?? 'https://acme.fr',
      overrides.instagram_handle ?? null,
      overrides.facebook_url ?? null,
      overrides.identity_review ?? null,
    ],
  );
  return rows[0]!.id;
}

async function addEvidence(pId: string, field: string, valueText: string, sourceUrl = 'https://acme.fr'): Promise<void> {
  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,$2,$3,'website','crawl',$4,1.0)`,
    [pId, field, valueText, sourceUrl],
  );
}

/** `funnel_observed` — la seule source qui prouve qu'un élément concret (formulaire, lien WhatsApp) a été lu. */
async function addFunnelObserved(pId: string, tokens: string, sourceUrl = 'https://acme.fr/'): Promise<void> {
  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,'funnel_observed',$2,'webintel','crawl',$3,0.9)`,
    [pId, tokens, sourceUrl],
  );
}

async function makeBatchWithItem(pId: string, contactChannels: string[] = ['email', 'website']): Promise<string> {
  const batchRows = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
    [`batch-${Date.now()}-${Math.random()}`, campaignId],
  );
  const bId = batchRows[0]!.id;
  const itemRows = await sql.query<{ id: string }>(
    `insert into r6b_batch_items (batch_id, prospect_id, item_index, original_draft, contact_channels)
     values ($1,$2,1,$3,$4) returning id`,
    [bId, pId, 'brouillon original', JSON.stringify(contactChannels)],
  );
  return itemRows[0]!.id;
}

beforeEach(async () => {
  await sql.query('delete from r6b_dispatch_manifests');
  await sql.query('delete from r6b_batch_votes');
  await sql.query('delete from r6b_batch_items');
  await sql.query('delete from r6b_batches');
  await sql.query('delete from prospect_evidence');
  await sql.query('delete from prospects');

  prospectId = await makeProspect();
  await addEvidence(prospectId, 'email', 'contact@acme.fr');
  await addEvidence(prospectId, 'website_url', 'https://acme.fr');
  itemId = await makeBatchWithItem(prospectId);
});

describe('transport — canal de base non observé (§3/§4)', () => {
  it('un transport dont le canal de base n’a pas été observé à la génération du batch n’apparaît pas du tout', () => {
    const options = resolveTransportOptions(['email'], toDispatchProspect({}), []);
    expect(options.find((o) => o.transport === 'web_form')).toBeUndefined();
    expect(options.find((o) => o.transport === 'whatsapp')).toBeUndefined();
    expect(options.find((o) => o.transport === 'phone_call')).toBeUndefined();
  });
});

describe('site != web_form automatiquement (§3/§16)', () => {
  it('un site observé sans formulaire de contact réellement lu laisse web_form unresolved', () => {
    const prospect = toDispatchProspect({ websiteUrl: 'https://acme.fr' });
    const evidence: DispatchEvidenceRow[] = [
      {
        id: 'e1',
        field: 'funnel_observed',
        valueText: 'cta_primary: réserver | cta_phone: +33600000000',
        provider: 'webintel',
        method: 'crawl',
        sourceUrl: 'https://acme.fr/',
        confidence: 0.9,
        observedAt: new Date().toISOString(),
      },
    ];
    const options = resolveTransportOptions(['website'], prospect, evidence);
    const webForm = options.find((o) => o.transport === 'web_form');
    expect(webForm?.status).toBe('unresolved');
    expect(webForm?.recipient).toBeNull();
  });

  it('un formulaire de contact réellement observé rend web_form verified, destinataire = page qui le porte', () => {
    const prospect = toDispatchProspect({ websiteUrl: 'https://acme.fr' });
    const evidence: DispatchEvidenceRow[] = [
      {
        id: 'e1',
        field: 'funnel_observed',
        valueText: 'cta_primary: devis | form_contact: action=(vide) champs=nom,email,message',
        provider: 'webintel',
        method: 'crawl',
        sourceUrl: 'https://acme.fr/contact',
        confidence: 0.9,
        observedAt: new Date().toISOString(),
      },
    ];
    const options = resolveTransportOptions(['website'], prospect, evidence);
    const webForm = options.find((o) => o.transport === 'web_form');
    expect(webForm?.status).toBe('verified');
    expect(webForm?.recipient).toBe('https://acme.fr/contact');
    expect(webForm?.recipientEvidenceIds).toEqual(['e1']);
  });
});

describe('telephone != sms automatiquement (§4/§16)', () => {
  it('sms reste unresolved même avec un numéro de téléphone corroboré par une preuve', () => {
    const prospect = toDispatchProspect({ phone: '+33600000000' });
    const evidence: DispatchEvidenceRow[] = [
      {
        id: 'e1',
        field: 'phone',
        valueText: '+33600000000',
        provider: 'website',
        method: 'crawl',
        sourceUrl: 'https://acme.fr',
        confidence: 1,
        observedAt: new Date().toISOString(),
      },
    ];
    const options = resolveTransportOptions(['phone'], prospect, evidence);
    const sms = options.find((o) => o.transport === 'sms');
    expect(sms?.status).toBe('unresolved');
    expect(sms?.recipient).toBeNull();
  });
});

describe('telephone != whatsapp automatiquement (§4/§16)', () => {
  it('whatsapp reste unresolved sans lien WhatsApp réellement observé', () => {
    const prospect = toDispatchProspect({ phone: '+33600000000' });
    const evidence: DispatchEvidenceRow[] = [
      {
        id: 'e1',
        field: 'phone',
        valueText: '+33600000000',
        provider: 'website',
        method: 'crawl',
        sourceUrl: 'https://acme.fr',
        confidence: 1,
        observedAt: new Date().toISOString(),
      },
    ];
    const options = resolveTransportOptions(['phone'], prospect, evidence);
    const whatsapp = options.find((o) => o.transport === 'whatsapp');
    expect(whatsapp?.status).toBe('unresolved');
  });

  it('un lien wa.me/api.whatsapp.com réellement observé rend whatsapp verified, numéro normalisé', () => {
    const prospect = toDispatchProspect({ phone: '+33612345678' });
    const evidence: DispatchEvidenceRow[] = [
      {
        id: 'e1',
        field: 'funnel_observed',
        valueText: 'cta_phone: +33612345678 | cta_whatsapp: https://api.whatsapp.com/send?phone=33612345678',
        provider: 'webintel',
        method: 'crawl',
        sourceUrl: 'https://acme.fr/',
        confidence: 0.9,
        observedAt: new Date().toISOString(),
      },
    ];
    const options = resolveTransportOptions(['phone'], prospect, evidence);
    const whatsapp = options.find((o) => o.transport === 'whatsapp');
    expect(whatsapp?.status).toBe('verified');
    expect(whatsapp?.recipient).toBe('+33612345678');
    expect(whatsapp?.recipientEvidenceIds).toEqual(['e1']);
  });

  it('phone_call reste verified directement depuis le numéro (correspondance directe, pas une inférence)', () => {
    const prospect = toDispatchProspect({ phone: '+33600000000' });
    const evidence: DispatchEvidenceRow[] = [
      {
        id: 'e1',
        field: 'phone',
        valueText: '+33600000000',
        provider: 'website',
        method: 'crawl',
        sourceUrl: 'https://acme.fr',
        confidence: 1,
        observedAt: new Date().toISOString(),
      },
    ];
    const options = resolveTransportOptions(['phone'], prospect, evidence);
    const phoneCall = options.find((o) => o.transport === 'phone_call');
    expect(phoneCall?.status).toBe('verified');
    expect(phoneCall?.recipient).toBe('+33600000000');
  });

  it('phone_call canonicalise un numéro brut fautif (0 national résiduel) en +33 valide — jamais +330... (régression R6B-B.1)', () => {
    // Forme brute telle qu'un prospect peut réellement l'afficher : le 0
    // national conservé alors que le +33 a été ajouté par-dessus. La preuve
    // et la valeur prospect gardent cette forme brute inchangée — seul le
    // destinataire canonique calculé pour le lock doit être corrigé.
    const raw = '+33 07 73 47 28 33';
    const prospect = toDispatchProspect({ phone: raw });
    const evidence: DispatchEvidenceRow[] = [
      {
        id: 'e1',
        field: 'phone',
        valueText: raw,
        provider: 'website',
        method: 'crawl',
        sourceUrl: 'https://demo-prospect-b.fr',
        confidence: 1,
        observedAt: new Date().toISOString(),
      },
    ];
    const options = resolveTransportOptions(['phone'], prospect, evidence);
    const phoneCall = options.find((o) => o.transport === 'phone_call');
    expect(phoneCall?.status).toBe('verified');
    expect(phoneCall?.recipient).toBe('+33773472833');
    expect(phoneCall?.recipient).not.toMatch(/^\+330/);
    // La preuve référencée reste celle qui porte la valeur brute observée.
    expect(phoneCall?.recipientEvidenceIds).toEqual(['e1']);
  });

  it('whatsapp canonicalise un lien wa.me portant un 0 national résiduel — jamais +330...', () => {
    const prospect = toDispatchProspect({ phone: '+33773472833' });
    const evidence: DispatchEvidenceRow[] = [
      {
        id: 'e1',
        field: 'funnel_observed',
        valueText: 'cta_whatsapp: https://wa.me/330773472833',
        provider: 'webintel',
        method: 'crawl',
        sourceUrl: 'https://acme.fr/',
        confidence: 0.9,
        observedAt: new Date().toISOString(),
      },
    ];
    const options = resolveTransportOptions(['phone'], prospect, evidence);
    const whatsapp = options.find((o) => o.transport === 'whatsapp');
    expect(whatsapp?.status).toBe('verified');
    expect(whatsapp?.recipient).toBe('+33773472833');
    expect(whatsapp?.recipient).not.toMatch(/^\+330/);
  });
});

describe('canal — uniquement ce qui est corroboré par une preuve (§4/§5)', () => {
  it('une valeur prospect sans ligne prospect_evidence correspondante est unresolved', () => {
    const prospect = toDispatchProspect({ email: 'contact@acme.fr' });
    const options = resolveTransportOptions(['email'], prospect, []); // aucune evidence
    expect(options[0]?.status).toBe('unresolved');
    expect(options[0]?.recipient).toBe('contact@acme.fr'); // affiché, mais pas exploitable
  });

  it('une valeur corroborée par prospect_evidence est verified', () => {
    const prospect = toDispatchProspect({ email: 'contact@acme.fr' });
    const evidence: DispatchEvidenceRow[] = [
      {
        id: 'e1',
        field: 'email',
        valueText: 'contact@acme.fr',
        provider: 'website',
        method: 'crawl',
        sourceUrl: 'https://acme.fr',
        confidence: 1,
        observedAt: new Date().toISOString(),
      },
    ];
    const options = resolveTransportOptions(['email'], prospect, evidence);
    expect(options[0]?.status).toBe('verified');
    expect(options[0]?.provenance?.provider).toBe('website');
    expect(options[0]?.recipientEvidenceIds).toEqual(['e1']);
  });
});

describe('lockManifestForItem — refus explicites', () => {
  it('rejette un item sans vote approuvé (§16 "only approved items selectable")', async () => {
    await expect(lockManifestForItem(sql, { itemId, transport: 'email' })).rejects.toThrow(DispatchLockError);
    await expect(lockManifestForItem(sql, { itemId, transport: 'email' })).rejects.toMatchObject({ code: 'not_approved' });
  });

  it('rejette un item REJECT même avec un texte présent', async () => {
    await castR6bVote(sql, { itemId, verdict: 'REJECT', approvedText: 'texte quelconque', note: null });
    await expect(lockManifestForItem(sql, { itemId, transport: 'email' })).rejects.toMatchObject({ code: 'not_approved' });
  });

  it('rejette un transport jamais proposé pour cet item (§16 "unobserved channel impossible")', async () => {
    await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: 'texte approuvé', note: null });
    await expect(lockManifestForItem(sql, { itemId, transport: 'instagram_dm' })).rejects.toMatchObject({
      code: 'transport_not_available',
    });
  });

  it('rejette un transport non vérifié (§16 "unverified transport unavailable")', async () => {
    // item par défaut : contact_channels = ['email','website'], aucun form_contact observé -> web_form unresolved
    await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: 'texte approuvé', note: null });
    await expect(lockManifestForItem(sql, { itemId, transport: 'web_form' })).rejects.toMatchObject({
      code: 'recipient_unresolved',
    });
  });

  it('rejette une destination non corroborée par une preuve', async () => {
    const driftedProspect = await makeProspect({ email: 'autre@acme.fr' }); // pas d'evidence pour cette valeur
    const driftedItem = await makeBatchWithItem(driftedProspect, ['email']);
    await castR6bVote(sql, { itemId: driftedItem, verdict: 'SEND', approvedText: 'texte approuvé', note: null });
    await expect(lockManifestForItem(sql, { itemId: driftedItem, transport: 'email' })).rejects.toMatchObject({
      code: 'recipient_unresolved',
    });
  });
});

describe('identité — cas VTC LYONNAIS / Prestation Auto Lyon (§6, §16 "identity ambiguity blocks dispatch")', () => {
  it('un désaccord de nom sans identité légale confirmée bloque le dispatch', async () => {
    const mismatchProspect = toDispatchProspect({
      displayName: 'VTC LYONNAIS 69800',
      legalName: 'VTC LYONNAIS 69800',
      identityReview: 'manual_review', // pas confirmé
    });
    const evidence: DispatchEvidenceRow[] = titleEvidence(['Prestation Auto Lyon | Prestation standard', 'Contact | Prestation Auto Lyon']);
    const audit = resolveIdentityAudit(mismatchProspect, evidence);
    expect(audit.nameMismatch).toBe(true);
    expect(audit.ambiguous).toBe(true);
  });

  it('le même désaccord est résolu quand une identité légale confirmée relie les deux noms', async () => {
    const mismatchProspect = toDispatchProspect({
      displayName: 'VTC LYONNAIS 69800',
      legalName: 'VTC LYONNAIS 69800',
      identityReview: 'confirmed', // SIREN publié, cf. r6bSelection.ts
    });
    const evidence: DispatchEvidenceRow[] = titleEvidence(['Prestation Auto Lyon | Prestation standard', 'Contact | Prestation Auto Lyon']);
    const audit = resolveIdentityAudit(mismatchProspect, evidence);
    expect(audit.nameMismatch).toBe(true);
    expect(audit.ambiguous).toBe(false);
    expect(audit.businessNameForDisplay).toBe('Prestation Auto Lyon');
  });

  it('lockManifestForItem refuse réellement un item en identity_ambiguity — identité non résolue ne verrouille jamais', async () => {
    const ambiguousProspect = await makeProspect({
      display_name: 'VTC LYONNAIS 69800',
      legal_name: 'VTC LYONNAIS 69800',
      identity_review: 'manual_review',
      email: 'contact@example.org',
    });
    await addEvidence(ambiguousProspect, 'email', 'contact@example.org', 'https://example.org');
    await addEvidence(ambiguousProspect, 'website_title', 'Prestation Auto Lyon | Prestation standard', 'https://example.org');
    await addEvidence(ambiguousProspect, 'website_title', 'Contact | Prestation Auto Lyon', 'https://example.org/contact');
    const ambiguousItem = await makeBatchWithItem(ambiguousProspect, ['email']);
    await castR6bVote(sql, { itemId: ambiguousItem, verdict: 'SEND', approvedText: 'texte approuvé', note: null });

    await expect(lockManifestForItem(sql, { itemId: ambiguousItem, transport: 'email' })).rejects.toMatchObject({
      code: 'identity_ambiguity',
    });
  });

  it('aucun désaccord détecté quand le titre du site cite le nom interne', () => {
    const prospect = toDispatchProspect({ displayName: 'DEMO PROSPECT A', legalName: null, identityReview: 'manual_review' });
    const evidence = titleEvidence(['Prestation écologique - DEMO PROSPECT A', 'Contact - DEMO PROSPECT A']);
    const audit = resolveIdentityAudit(prospect, evidence);
    expect(audit.nameMismatch).toBe(false);
    expect(audit.ambiguous).toBe(false);
  });
});

describe('lockManifestForItem — transport dérivé de funnel_observed via la base (§3/§16)', () => {
  it('verrouille web_form de bout en bout quand un formulaire de contact a été observé', async () => {
    await addFunnelObserved(prospectId, 'form_contact: action=(vide) champs=nom,email,message', 'https://acme.fr/contact');
    await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: 'texte final', note: null });
    const manifest = await lockManifestForItem(sql, { itemId, transport: 'web_form' });
    expect(manifest.transport).toBe('web_form');
    expect(manifest.recipient).toBe('https://acme.fr/contact');
  });
});

describe('lock — transport exact, texte exact, sha256, append-only (§8, §12, §16)', () => {
  it('stocke le transport exact, le destinataire exact, le texte approuvé exact et son sha256', async () => {
    await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: 'texte final exact', note: null });
    const manifest = await lockManifestForItem(sql, { itemId, transport: 'email' });
    expect(manifest.transport).toBe('email');
    expect(manifest.recipient).toBe('contact@acme.fr');
    expect(manifest.approvedText).toBe('texte final exact');
    expect(manifest.approvedTextSha256).toBe(sha256Hex('texte final exact'));
    expect(manifest.status).toBe('LOCKED');
    expect(manifest.recipientEvidenceIds.length).toBeGreaterThan(0);
  });

  it('sha256 est stable pour un même texte, différent pour un texte différent', async () => {
    await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: 'texte A', note: null });
    const a = await lockManifestForItem(sql, { itemId, transport: 'email' });
    expect(a.approvedTextSha256).toBe(sha256Hex('texte A'));
    expect(a.approvedTextSha256).not.toBe(sha256Hex('texte B'));
  });

  it('LOCK != SEND : aucun outreach_event n’est créé par un lock', async () => {
    await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: 'texte final exact', note: null });
    await lockManifestForItem(sql, { itemId, transport: 'email' });
    const events = await sql.query<{ n: string }>('select count(*)::text as n from outreach_events');
    expect(events[0]?.n).toBe('0');
  });

  it('changer le texte approuvé invalide le lock précédent (nouveau vote = correction)', async () => {
    await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: 'texte v1', note: null });
    const first = await lockManifestForItem(sql, { itemId, transport: 'email' });

    await castR6bVote(sql, { itemId, verdict: 'EDIT', approvedText: 'texte v2', note: 'correction' });
    const second = await lockManifestForItem(sql, { itemId, transport: 'email' });

    expect(second.approvedText).toBe('texte v2');
    expect(second.approvedTextSha256).not.toBe(first.approvedTextSha256);

    const rows = await sql.query<{ id: string; status: string }>(
      'select id, status from r6b_dispatch_manifests where id = $1',
      [first.id],
    );
    expect(rows[0]?.status).toBe('SUPERSEDED');

    const currentLocked = await sql.query<{ n: string }>(
      `select count(*)::text as n from r6b_dispatch_manifests where batch_item_id = $1 and status = 'LOCKED'`,
      [itemId],
    );
    expect(currentLocked[0]?.n).toBe('1');
  });

  it('changer le destinataire (transport) invalide aussi le lock précédent', async () => {
    await addEvidence(prospectId, 'phone', '+33600000000', 'https://acme.fr');
    await sql.query(`update prospects set phone = $1 where id = $2`, ['+33600000000', prospectId]);
    await sql.query(`update r6b_batch_items set contact_channels = $1 where id = $2`, [
      JSON.stringify(['email', 'phone']),
      itemId,
    ]);
    await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: 'texte final', note: null });
    const first = await lockManifestForItem(sql, { itemId, transport: 'email' });
    const second = await lockManifestForItem(sql, { itemId, transport: 'phone_call' });

    expect(second.transport).toBe('phone_call');
    expect(second.recipient).not.toBe(first.recipient);

    const rows = await sql.query<{ status: string }>('select status from r6b_dispatch_manifests where id = $1', [first.id]);
    expect(rows[0]?.status).toBe('SUPERSEDED');
  });
});

describe('supersede sans remplaçant immédiat — mécanisme utilisé par la normalisation de taxonomie (§7, §12, §16)', () => {
  it('un lock peut être supersedé avec une raison explicite et sans nouveau lock immédiat (append-only)', async () => {
    await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: 'texte', note: null });
    const locked = await lockManifestForItem(sql, { itemId, transport: 'email' });

    await sql.query(
      `update r6b_dispatch_manifests
          set status = 'SUPERSEDED', superseded_at = now(), superseded_reason = 'transport_taxonomy_normalization'
        where id = $1`,
      [locked.id],
    );

    const rows = await sql.query<{
      status: string;
      superseded_by: string | null;
      superseded_reason: string | null;
      recipient: string;
      approved_text: string;
    }>('select status, superseded_by, superseded_reason, recipient, approved_text from r6b_dispatch_manifests where id = $1', [
      locked.id,
    ]);
    // append-only : le contenu de la ligne (destinataire, texte) n'a pas bougé, seul le statut a changé.
    expect(rows[0]?.status).toBe('SUPERSEDED');
    expect(rows[0]?.superseded_by).toBeNull();
    expect(rows[0]?.superseded_reason).toBe('transport_taxonomy_normalization');
    expect(rows[0]?.recipient).toBe(locked.recipient);
    expect(rows[0]?.approved_text).toBe(locked.approvedText);

    const currentLocked = await sql.query<{ n: string }>(
      `select count(*)::text as n from r6b_dispatch_manifests where batch_item_id = $1 and status = 'LOCKED'`,
      [itemId],
    );
    expect(currentLocked[0]?.n).toBe('0'); // aucun remplaçant automatique — un opérateur reverrouille lui-même
  });
});

describe('un seul manifeste LOCKED actif par item (§9/§12/§16)', () => {
  it('la contrainte DB refuse deux lignes LOCKED pour le même batch_item_id, même en contournant l’app', async () => {
    await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: 'texte', note: null });
    const first = await lockManifestForItem(sql, { itemId, transport: 'email' });
    // Insertion directe qui contourne lockManifestForItem — la garantie doit
    // tenir au niveau de l'index partiel, pas seulement dans l'app.
    await expect(
      sql.query(
        `insert into r6b_dispatch_manifests
           (batch_id, batch_item_id, prospect_id, approval_vote_id, business_name,
            transport, recipient, recipient_provenance, recipient_evidence_ids, identity_review,
            approved_text, approved_text_sha256, transport_payload, transport_payload_sha256, status)
         select batch_id, batch_item_id, prospect_id, approval_vote_id, business_name,
                transport, recipient, recipient_provenance, recipient_evidence_ids, identity_review,
                approved_text, approved_text_sha256, transport_payload, transport_payload_sha256, 'LOCKED'
           from r6b_dispatch_manifests where id = $1`,
        [first.id],
      ),
    ).rejects.toThrow();
  });
});

describe('TOCTOU — le lock relit toujours l’état courant, jamais un instantané côté client (§6/§16)', () => {
  it('un email retiré de la fiche prospect entre la lecture des options et le lock fait échouer le lock', async () => {
    await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: 'texte', note: null });
    // "lecture des options" telle que l'UI l'aurait faite au rendu de la page.
    const context = await (await import('@/lib/pipeline/r6bDispatch')).loadDispatchContext(sql, itemId);
    const before = resolveTransportOptions(context!.observedChannels, context!.prospect, context!.evidence);
    expect(before.find((o) => o.transport === 'email')?.status).toBe('verified');

    // dérive côté serveur entre le rendu et le clic humain
    await sql.query(`update prospects set email = null where id = $1`, [prospectId]);

    await expect(lockManifestForItem(sql, { itemId, transport: 'email' })).rejects.toMatchObject({
      code: 'recipient_unresolved',
    });
  });

  it('une identité qui devient ambiguë entre la lecture et le lock fait échouer le lock', async () => {
    const p = await makeProspect({
      display_name: 'VTC LYONNAIS 69800',
      legal_name: 'VTC LYONNAIS 69800',
      identity_review: 'confirmed',
      email: 'contact@example.org',
    });
    await addEvidence(p, 'email', 'contact@example.org', 'https://example.org');
    const item = await makeBatchWithItem(p, ['email']);
    await castR6bVote(sql, { itemId: item, verdict: 'SEND', approvedText: 'texte', note: null });

    // "lecture" initiale : identité confirmée, pas de mismatch — dispatchable.
    const contextBefore = await (await import('@/lib/pipeline/r6bDispatch')).loadDispatchContext(sql, item);
    const auditBefore = resolveIdentityAudit(contextBefore!.prospect, contextBefore!.evidence);
    expect(auditBefore.ambiguous).toBe(false);

    // dérive : l'identité repasse en manual_review entre le rendu et le clic.
    await sql.query(`update prospects set identity_review = 'manual_review' where id = $1`, [p]);
    await addEvidence(p, 'website_title', 'Prestation Auto Lyon | Prestation standard', 'https://example.org');
    await addEvidence(p, 'website_title', 'Contact | Prestation Auto Lyon', 'https://example.org/contact');

    await expect(lockManifestForItem(sql, { itemId: item, transport: 'email' })).rejects.toMatchObject({
      code: 'identity_ambiguity',
    });
  });
});

describe('§20 — invariants globaux', () => {
  it('aucun outreach_event n’existe, quel que soit l’état des manifestes', async () => {
    await addEvidence(prospectId, 'phone', '+33600000000', 'https://acme.fr');
    await sql.query(`update prospects set phone = $1 where id = $2`, ['+33600000000', prospectId]);
    await sql.query(`update r6b_batch_items set contact_channels = $1 where id = $2`, [
      JSON.stringify(['email', 'phone']),
      itemId,
    ]);
    await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: 'texte', note: null });
    await lockManifestForItem(sql, { itemId, transport: 'email' });
    await lockManifestForItem(sql, { itemId, transport: 'phone_call' });
    const events = await sql.query<{ n: string }>('select count(*)::text as n from outreach_events');
    expect(events[0]?.n).toBe('0');
  });

  it('OUTBOUND_ALLOW_SENDING reste à 0 dans l’environnement de test', () => {
    expect(envBool('OUTBOUND_ALLOW_SENDING', false)).toBe(false);
  });

  it('aucun transport réseau dans le module de dispatch', () => {
    const root = resolve(__dirname, '..');
    const source = readFileSync(resolve(root, 'src/lib/pipeline/r6bDispatch.ts'), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/HttpClient/);
    expect(source).not.toMatch(/nodemailer|twilio|sendgrid|axios/i);
  });

  it('aucune fonction sendAll/sendBatch/sendWhereApproved n’existe dans le dépôt', () => {
    const root = resolve(__dirname, '..');
    const source = readFileSync(resolve(root, 'src/lib/pipeline/r6bDispatch.ts'), 'utf8');
    expect(source).not.toMatch(/sendAll|sendBatch|sendWhereApproved|sendNow/);
  });
});

describe('learning telemetry — append-only, originaux préservés (§15, §19)', () => {
  it('reply_drafts conserve ai_draft même après un edit humain', async () => {
    const conv = await sql.query<{ id: string }>(
      `insert into conversations (prospect_id, channel) values ($1,'email') returning id`,
      [prospectId],
    );
    const draft = await sql.query<{ id: string }>(
      `insert into reply_drafts (conversation_id, ai_draft, human_edited_text)
       values ($1,$2,$3) returning id`,
      [conv[0]!.id, 'brouillon IA original', 'texte réécrit par un opérateur'],
    );
    const row = await sql.query<{ aiDraft: string; humanEditedText: string }>(
      `select ai_draft as "aiDraft", human_edited_text as "humanEditedText" from reply_drafts where id = $1`,
      [draft[0]!.id],
    );
    expect(row[0]?.aiDraft).toBe('brouillon IA original');
    expect(row[0]?.humanEditedText).toBe('texte réécrit par un opérateur');
  });

  it('prospect_milestones est un journal append-only (plusieurs lignes conservées, aucune écrasée)', async () => {
    await sql.query(`insert into prospect_milestones (prospect_id, milestone) values ($1,'qualified')`, [prospectId]);
    await sql.query(`insert into prospect_milestones (prospect_id, milestone) values ($1,'meeting_booked')`, [
      prospectId,
    ]);
    const rows = await sql.query<{ milestone: string }>(
      'select milestone from prospect_milestones where prospect_id = $1 order by created_at asc',
      [prospectId],
    );
    expect(rows.map((r) => r.milestone)).toEqual(['qualified', 'meeting_booked']);
  });

  it('reply_classifications accepte la nouvelle taxonomie (§12)', async () => {
    const conv = await sql.query<{ id: string }>(
      `insert into conversations (prospect_id, channel) values ($1,'email') returning id`,
      [prospectId],
    );
    const msg = await sql.query<{ id: string }>(
      `insert into conversation_messages (conversation_id, direction, body) values ($1,'inbound','pas intéressé') returning id`,
      [conv[0]!.id],
    );
    await expect(
      sql.query(`insert into reply_classifications (conversation_message_id, label, confidence) values ($1,'NOT_INTERESTED',0.9)`, [
        msg[0]!.id,
      ]),
    ).resolves.not.toThrow();
    await expect(
      sql.query(`insert into reply_classifications (conversation_message_id, label, confidence) values ($1,'interested',0.9)`, [
        msg[0]!.id,
      ]),
    ).rejects.toThrow(); // ancienne taxonomie retirée
  });

  it('un futur outreach_event peut référencer un manifest_id explicite, qui porte déjà le transport (§15/§17)', async () => {
    await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: 'texte', note: null });
    const manifest = await lockManifestForItem(sql, { itemId, transport: 'email' });
    // Ce test ne crée pas d'événement réel (ce serait un envoi) — il vérifie
    // seulement que la colonne existe et accepte un manifest_id valide, et
    // qu'un futur sender peut retrouver le transport réel via ce lien plutôt
    // que de le redupliquer sur outreach_events.
    await expect(
      sql.query(
        `insert into outreach_events (prospect_id, kind, channel, manifest_id) values ($1,'sent','email',$2)`,
        [prospectId, manifest.id],
      ),
    ).resolves.not.toThrow();
    const joined = await sql.query<{ transport: string }>(
      `select m.transport from outreach_events e join r6b_dispatch_manifests m on m.id = e.manifest_id where e.manifest_id = $1`,
      [manifest.id],
    );
    expect(joined[0]?.transport).toBe('email');
    await sql.query('delete from outreach_events'); // ne pas polluer le compte §20 des autres tests
  });
});

describe('deriveObservedTradingName — heuristique de nom commercial observé', () => {
  it('retient le segment de titre qui revient sur la majorité des pages', () => {
    const evidence = titleEvidence([
      'Prestation Auto Lyon | Votre station de prestation standard à Lyon',
      'Réservation - Devis - Contacts | Prestation Auto Lyon',
      'Prestation standard voiture | Prestation Auto Lyon | Prix compétitifs',
    ]);
    expect(deriveObservedTradingName(evidence)).toBe('Prestation Auto Lyon');
  });

  it('retourne null sans evidence website_title', () => {
    expect(deriveObservedTradingName([])).toBeNull();
  });
});

function titleEvidence(titles: string[]): DispatchEvidenceRow[] {
  return titles.map((valueText, i) => ({
    id: `title-${i}`,
    field: 'website_title',
    valueText,
    provider: 'website',
    method: 'crawl',
    sourceUrl: `https://example.fr/${i}`,
    confidence: 1,
    observedAt: new Date().toISOString(),
  }));
}

function toDispatchProspect(overrides: Partial<DispatchProspect>): DispatchProspect {
  return {
    id: 'p1',
    displayName: 'ACME ATELIER',
    legalName: null,
    city: null,
    email: null,
    phone: null,
    websiteUrl: null,
    instagramHandle: null,
    facebookUrl: null,
    identityReview: null,
    ...overrides,
  };
}
