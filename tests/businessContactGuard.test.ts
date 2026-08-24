import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import { DispatchLockError, lockManifestForItem, type Transport } from '@/lib/pipeline/r6bDispatch';
import {
  enqueueInstagramJob,
  InstagramEligibilityError,
  markExternalEffectAttempted,
} from '@/lib/instagram/queue';
import { armCanaryAuthorization } from '@/lib/instagram/canary';
import { resolveDispatchTarget } from '@/lib/pipeline/r6bDispatcher';
import {
  bindingKeysOf,
  contactHistoryFromGroup,
  contactsOnChannel,
  contactsOnOtherChannels,
  loadBusinessContactHistory,
  resolveBusinessIdentityGroup,
} from '@/lib/pipeline/businessContactGuard';
import { makeProspectInstagramEligible } from './support/instagramEligibility';
import type { Sql } from '@/lib/db/sql';

/**
 * R7-PILOT §1 — la déduplication qui traverse les campagnes.
 *
 * Le scénario central de ce fichier est un incident réel, pas une hypothèse.
 * Le 19 août 2026, la campagne `example-campaign` a redécouvert `DEMO PROSPECT A`
 * (`example.org`, `@demo_prospect_a`) et lui a créé une ligne neuve, parce que
 * `prospect_identities` est indexée par campagne. La ligne neuve affichait
 * `outreach_events = 0`. Six jours plus tôt, ce même compte Instagram avait
 * reçu un DM, conclu `DELIVERY_FAILED` par une adjudication humaine, sous la
 * ligne de `example-campaign`.
 *
 * Rien dans le rail ne pouvait le voir : toutes les portes « déjà contacté ? »
 * interrogeaient `prospect_id`. Ce fichier prouve qu'elles interrogent
 * désormais le COMMERCE, et qu'elles refusent — au verrou comme à l'enfilement.
 *
 * Base PGlite temporaire, migrée comme le reste du dépôt. Jamais la base de
 * production, jamais un réseau, jamais un envoi.
 */

const TEXT = 'Bonjour, une question rapide sur vos prises de rendez-vous.';

let sql: Sql;
let dir: string;
let r5CampaignId: string;
let r7CampaignId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-contact-guard-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);

  const r5 = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-campaign-a', 'Campagne A', 'example-services', '{}'],
  );
  r5CampaignId = r5[0]!.id;
  const r7 = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-campaign-b', 'Campagne B', 'example-services', '{}'],
  );
  r7CampaignId = r7[0]!.id;
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('update ig_live_canary_authorizations set consumed_job_id = null');
  await sql.query('delete from ig_job_events');
  await sql.query('delete from ig_identity_checks');
  await sql.query('delete from ig_enqueue_decisions');
  await sql.query('delete from ig_dispatch_jobs');
  await sql.query('delete from ig_live_canary_authorizations');
  await sql.query('delete from ig_kill_switch');
  await sql.query('delete from outreach_events');
  await sql.query('delete from do_not_contact');
  await sql.query('delete from prospect_icp_assessments');
  await sql.query('delete from r6b_dispatch_attempts');
  await sql.query('delete from r6b_dispatch_manifests');
  await sql.query('delete from r6b_batch_votes');
  await sql.query('delete from r6b_batch_items');
  await sql.query('delete from r6b_batches');
  await sql.query('delete from prospect_evidence');
  await sql.query('delete from prospect_identities');
  await sql.query('delete from prospects');
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface ProspectSpec {
  readonly campaignId: string;
  readonly displayName: string;
  readonly domain?: string | null;
  readonly instagramHandle?: string | null;
  readonly email?: string | null;
  readonly city?: string | null;
  readonly postalCode?: string | null;
}

async function createProspect(spec: ProspectSpec): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, domain, website_url,
                            instagram_handle, email, city, postal_code)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [
      spec.campaignId,
      `prospect-${String(Math.random())}`,
      spec.displayName,
      spec.domain ?? null,
      spec.domain === undefined || spec.domain === null ? null : `https://${spec.domain}`,
      spec.instagramHandle ?? null,
      spec.email ?? null,
      spec.city ?? null,
      spec.postalCode ?? null,
    ],
  );
  const prospectId = rows[0]!.id;

  // Le handle et l'e-mail portent chacun leur preuve, comme en production : sans
  // elle, `resolveTransportOptions` refuserait le transport et le test
  // n'atteindrait jamais la garde qu'il veut éprouver.
  if (spec.instagramHandle) {
    await sql.query(
      `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
       values ($1,'instagram_handle',$2,'website','crawl',$3,1.0)`,
      [prospectId, spec.instagramHandle, `https://${spec.domain ?? 'exemple.fr'}`],
    );
  }
  if (spec.email) {
    await sql.query(
      `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
       values ($1,'email',$2,'website','crawl',$3,1.0)`,
      [prospectId, spec.email, `https://${spec.domain ?? 'exemple.fr'}`],
    );
  }
  return prospectId;
}

/** Le vrai chemin humain : un batch, un item, un vote SEND. Jamais un raccourci. */
async function approveForLock(prospectId: string, channels: readonly string[]): Promise<string> {
  const batch = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1, (select campaign_id from prospects where id = $2))
     returning id`,
    [`batch-${String(Math.random())}`, prospectId],
  );
  const item = await sql.query<{ id: string }>(
    `insert into r6b_batch_items (batch_id, prospect_id, item_index, original_draft, contact_channels)
     values ($1,$2,1,'brouillon',$3) returning id`,
    [batch[0]!.id, prospectId, JSON.stringify([...channels])],
  );
  const itemId = item[0]!.id;
  await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: TEXT, note: null });
  await makeProspectInstagramEligible(sql, prospectId);
  return itemId;
}

async function lockFor(prospectId: string, transport: Transport = 'instagram_dm'): Promise<string> {
  const itemId = await approveForLock(prospectId, [transport === 'instagram_dm' ? 'instagram' : 'email']);
  const manifest = await lockManifestForItem(sql, { itemId, transport });
  return manifest.id;
}

/**
 * Le job Instagram déjà exécuté de l'ancienne ligne, dans l'état exact qu'il a
 * en production : `DELIVERY_FAILED`, terminé, et SANS ligne `outreach_events`.
 * C'est cette absence qui rendait l'incident invisible — un contrôle qui ne
 * lirait que `outreach_events` ne verrait toujours rien.
 *
 * La tentative passe par le vrai chemin, canari compris : la base refuse un
 * `DELIVERY_FAILED` qui n'aurait rien tenté (`ig_job_delivery_failed_requires_effect`),
 * et refuse une tentative sans autorisation nominative rattachée
 * (`ig_job_effect_requires_canary`). Contourner ces deux contraintes par un
 * `insert` brut fabriquerait un état que la production ne peut pas produire.
 */
async function markJobDeliveryFailed(manifestId: string, jobId: string): Promise<void> {
  const { envelope } = await resolveDispatchTarget(sql, manifestId, 'LIVE');
  const canary = await armCanaryAuthorization(sql, {
    envelope,
    action: 'first_touch_dm',
    armedBy: 'Test',
    reason: 'reproduction du canari du 13 août',
    ttlMs: 30 * 60_000,
  });
  await markExternalEffectAttempted(sql, { jobId, canaryAuthorizationId: canary.id });
  await sql.query(
    `update ig_dispatch_jobs
        set status = 'DELIVERY_FAILED', terminated_at = now(),
            last_reason_code = 'IG_LIVE_DELIVERY_FAILED'
      where id = $1`,
    [jobId],
  );
}

// ---------------------------------------------------------------------------
// Les clés qui lient — fonction pure
// ---------------------------------------------------------------------------

describe('bindingKeysOf — quelles preuves lient deux lignes', () => {
  it('normalise le domaine, le handle et l’e-mail', () => {
    const keys = bindingKeysOf({
      domain: 'WWW.Example.ORG',
      instagramHandle: '@Demo_Prospect_A',
      email: 'Contact@Example.ORG',
    });
    expect(keys).toEqual([
      { kind: 'domain', value: 'example.org' },
      { kind: 'instagram', value: 'demo_prospect_a' },
      { kind: 'email', value: 'contact@example.org' },
    ]);
  });

  it('n’émet AUCUNE clé de nom, même avec une ville', () => {
    const keys = bindingKeysOf({ domain: null, instagramHandle: null, email: null });
    expect(keys).toEqual([]);
  });

  it('n’émet aucune clé de téléphone — un standard se partage', () => {
    // `BindingSource` n'a même pas de champ téléphone : la décision est dans le
    // type, pas seulement dans une branche qu'on pourrait rouvrir.
    const keys = bindingKeysOf({ domain: 'exemple.fr' });
    expect(keys.map((key) => key.kind)).toEqual(['domain']);
  });
});

// ---------------------------------------------------------------------------
// Le groupe d'identité
// ---------------------------------------------------------------------------

describe('resolveBusinessIdentityGroup — le commerce, pas la ligne', () => {
  it('même domaine dans deux campagnes → doublon détecté', async () => {
    const old = await createProspect({
      campaignId: r5CampaignId,
      displayName: 'DEMO PROSPECT A',
      domain: 'example.org',
    });
    const fresh = await createProspect({
      campaignId: r7CampaignId,
      displayName: 'DEMO PROSPECT A',
      domain: 'example.org',
    });

    const group = await resolveBusinessIdentityGroup(sql, fresh);
    expect(group.siblings).toHaveLength(1);
    expect(group.siblings[0]!.prospectId).toBe(old);
    expect(group.siblings[0]!.campaignSlug).toBe('example-campaign-a');
    expect(group.siblings[0]!.linkedBy).toContainEqual({ kind: 'domain', value: 'example.org' });
    expect(group.crossCampaign).toBe(true);
  });

  it('même handle Instagram corroboré dans deux campagnes → doublon détecté', async () => {
    const old = await createProspect({
      campaignId: r5CampaignId,
      displayName: 'Atelier',
      domain: 'ancien-site.fr',
      instagramHandle: 'example_services_',
    });
    const fresh = await createProspect({
      campaignId: r7CampaignId,
      displayName: 'EXAMPLE SERVICES',
      domain: 'nouveau-site.fr',
      instagramHandle: 'example_services_',
    });

    const group = await resolveBusinessIdentityGroup(sql, fresh);
    expect(group.siblings.map((sibling) => sibling.prospectId)).toEqual([old]);
    expect(group.siblings[0]!.linkedBy).toEqual([{ kind: 'instagram', value: 'example_services_' }]);
  });

  it('une entreprise sans rapport n’est pas affectée', async () => {
    await createProspect({ campaignId: r5CampaignId, displayName: 'DEMO PROSPECT A', domain: 'example.org' });
    const other = await createProspect({
      campaignId: r7CampaignId,
      displayName: 'Demo Charlie',
      domain: 'demo-62-exemple.fr',
      instagramHandle: 'demo_account_18',
    });

    const group = await resolveBusinessIdentityGroup(sql, other);
    expect(group.siblings).toHaveLength(0);
    expect(group.crossCampaign).toBe(false);
  });

  it('un nom identique, même ville comprise, ne suffit JAMAIS à lier', async () => {
    // Deux « ATELIER CAR » existent réellement dans le corpus, à Toul et à
    // Metz. Les lier sur le nom produirait un faux doublon, et un faux doublon
    // BLOQUE un prospect légitime — l'inverse exact du but de ce module.
    await createProspect({
      campaignId: r5CampaignId,
      displayName: 'ATELIER CAR',
      domain: null,
      city: 'METZ',
      postalCode: '57000',
    });
    const twin = await createProspect({
      campaignId: r7CampaignId,
      displayName: 'ATELIER CAR',
      domain: null,
      city: 'METZ',
      postalCode: '57000',
    });

    const group = await resolveBusinessIdentityGroup(sql, twin);
    expect(group.siblings).toHaveLength(0);
    expect(group.keys).toHaveLength(0);
  });

  it('lit aussi les clés de `prospect_identities`, pas seulement les colonnes', async () => {
    const old = await createProspect({
      campaignId: r5CampaignId,
      displayName: 'DEMO FOXTROT',
      domain: 'demo-53-exemple.fr',
    });
    const fresh = await createProspect({
      campaignId: r7CampaignId,
      displayName: 'Demo Foxtrot',
      domain: null,
    });
    // Une clé historique, attachée par le rail R3 sans jamais remplir la colonne.
    await sql.query(
      `insert into prospect_identities (prospect_id, campaign_id, kind, value, weight)
       values ($1,$2,'domain','demo-53-exemple.fr',0.95)`,
      [fresh, r7CampaignId],
    );

    const group = await resolveBusinessIdentityGroup(sql, fresh);
    expect(group.siblings.map((sibling) => sibling.prospectId)).toEqual([old]);
  });
});

// ---------------------------------------------------------------------------
// L'incident DEMO PROSPECT A, rejoué
// ---------------------------------------------------------------------------

describe('DEMO PROSPECT A — une nouvelle campagne ne rouvre pas une conversation', () => {
  /**
   * Le handle du scénario n'est pas `@demo_prospect_a` mais `demo_account_06`,
   * et la différence mérite d'être dite : le vrai handle contient « france »,
   * que le profil ICP traite comme une identité sociale de portée nationale et
   * refuse à lui seul. Un scénario écrit avec lui prouverait le gate ICP, pas
   * celui-ci. Le LIEN entre les deux lignes reste celui de l'incident réel : le
   * domaine `example.org`, identique des deux côtés.
   */
  async function detailCarIncident(): Promise<{ old: string; fresh: string; oldManifest: string }> {
    const old = await createProspect({
      campaignId: r5CampaignId,
      displayName: 'DEMO PROSPECT A',
      domain: 'example.org',
      instagramHandle: 'demo_kilo',
      city: 'AUBAGNE',
    });
    const oldManifest = await lockFor(old);
    const enqueued = await enqueueInstagramJob(sql, {
      manifestId: oldManifest,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    await markJobDeliveryFailed(oldManifest, enqueued.job.id);

    const fresh = await createProspect({
      campaignId: r7CampaignId,
      displayName: 'DEMO PROSPECT A',
      domain: 'example.org',
      instagramHandle: 'demo_kilo',
      city: 'AUBAGNE',
    });
    return { old, fresh, oldManifest };
  }

  it('la nouvelle ligne a bien zéro outreach_event — et le commerce est pourtant déjà joint', async () => {
    const { fresh } = await detailCarIncident();

    const localEvents = await sql.query<{ n: string }>(
      'select count(*)::text as n from outreach_events where prospect_id = $1',
      [fresh],
    );
    expect(Number(localEvents[0]!.n)).toBe(0);

    const history = await loadBusinessContactHistory(sql, fresh);
    expect(history.duplicateIdentity).toBe(true);
    expect(history.verdict).toBe('ALREADY_CONTACTED');
    expect(contactsOnChannel(history, 'instagram_dm')).toHaveLength(1);
    expect(contactsOnChannel(history, 'instagram_dm')[0]!.status).toBe('DELIVERY_FAILED');
    expect(contactsOnChannel(history, 'instagram_dm')[0]!.isSelf).toBe(false);
    expect(contactHistoryFromGroup(history)).toBe('already_contacted');
  });

  it('le VERROU refuse : pas de manifeste « prêt à partir » pour un commerce déjà joint', async () => {
    const { fresh } = await detailCarIncident();
    const itemId = await approveForLock(fresh, ['instagram']);

    await expect(lockManifestForItem(sql, { itemId, transport: 'instagram_dm' })).rejects.toMatchObject({
      code: 'identity_already_contacted',
    });

    const manifests = await sql.query<{ n: string }>(
      'select count(*)::text as n from r6b_dispatch_manifests where prospect_id = $1',
      [fresh],
    );
    expect(Number(manifests[0]!.n)).toBe(0);
  });

  it('l’ENFILEMENT refuse aussi, même si le manifeste précédait la découverte', async () => {
    // Un manifeste verrouillé HIER, avant que le doublon n'existe : la garde du
    // verrou ne pouvait rien voir ce jour-là. C'est exactement pourquoi la même
    // lecture est refaite ici, et pourquoi une seule des deux portes ne
    // suffirait pas.
    const fresh = await createProspect({
      campaignId: r7CampaignId,
      displayName: 'DEMO PROSPECT A',
      domain: 'example.org',
      instagramHandle: 'demo_kilo',
    });
    const freshManifest = await lockFor(fresh);

    const old = await createProspect({
      campaignId: r5CampaignId,
      displayName: 'DEMO PROSPECT A',
      domain: 'example.org',
      instagramHandle: 'demo_kilo',
    });
    const oldManifest = await lockFor(old);
    const enqueued = await enqueueInstagramJob(sql, {
      manifestId: oldManifest,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    await markJobDeliveryFailed(oldManifest, enqueued.job.id);

    const error = await enqueueInstagramJob(sql, {
      manifestId: freshManifest,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InstagramEligibilityError);
    const decision = (error as InstagramEligibilityError).decision;
    expect(decision.verdict).toBe('INELIGIBLE');
    expect(decision.reasonCode).toBe('IG_IDENTITY_ALREADY_CONTACTED');
    expect(decision.reason).toBe('already_contacted');
    // Le refus NOMME l'autre ligne : un opérateur ne doit pas avoir à chercher.
    expect(decision.detail).toContain(old);

    // Et aucun job n'a été créé pour la nouvelle ligne.
    const jobs = await sql.query<{ n: string }>(
      'select count(*)::text as n from ig_dispatch_jobs where prospect_id = $1',
      [fresh],
    );
    expect(Number(jobs[0]!.n)).toBe(0);
  });

  it('une intention encore ACTIVE sur l’autre ligne bloque aussi', async () => {
    const fresh = await createProspect({
      campaignId: r7CampaignId,
      displayName: 'DEMO PROSPECT A',
      domain: 'example.org',
      instagramHandle: 'demo_kilo',
    });
    const freshManifest = await lockFor(fresh);

    const old = await createProspect({
      campaignId: r5CampaignId,
      displayName: 'DEMO PROSPECT A',
      domain: 'example.org',
      instagramHandle: 'demo_kilo',
    });
    const oldManifest = await lockFor(old);
    await enqueueInstagramJob(sql, { manifestId: oldManifest, action: 'first_touch_dm', enqueuedBy: 'Test' });

    const error = await enqueueInstagramJob(sql, {
      manifestId: freshManifest,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InstagramEligibilityError);
    expect((error as InstagramEligibilityError).decision.reasonCode).toBe('IG_IDENTITY_CONCURRENT_INTENT');
  });
});

// ---------------------------------------------------------------------------
// do_not_contact
// ---------------------------------------------------------------------------

describe('do_not_contact — une exclusion appartient au commerce, pas à la fiche', () => {
  it('une exclusion posée sur l’e-mail de l’ancienne ligne bloque la nouvelle', async () => {
    await createProspect({
      campaignId: r5CampaignId,
      displayName: 'Demo Kilo',
      domain: 'demo-kilo.fr',
      email: 'contact@demo-kilo.fr',
    });
    await sql.query(
      `insert into do_not_contact (match_kind, value, reason, added_by)
       values ('email','contact@demo-kilo.fr','a demandé l''arrêt','Test')`,
    );

    const fresh = await createProspect({
      campaignId: r7CampaignId,
      displayName: 'Demo Kilo entre Aix et Marseille',
      domain: 'demo-kilo.fr',
      instagramHandle: 'demo_kilo',
    });

    const history = await loadBusinessContactHistory(sql, fresh);
    expect(history.verdict).toBe('DO_NOT_CONTACT');

    const itemId = await approveForLock(fresh, ['instagram']);
    await expect(lockManifestForItem(sql, { itemId, transport: 'instagram_dm' })).rejects.toMatchObject({
      code: 'identity_suppressed',
    });
  });

  it('une exclusion posée sur le handle bloque l’enfilement d’un manifeste antérieur', async () => {
    const fresh = await createProspect({
      campaignId: r7CampaignId,
      displayName: 'Demo Kilo',
      domain: 'demo-kilo.fr',
      instagramHandle: 'demo_kilo',
    });
    const manifestId = await lockFor(fresh);

    await createProspect({
      campaignId: r5CampaignId,
      displayName: 'Demo Kilo (ancienne fiche)',
      domain: 'demo-kilo.fr',
      instagramHandle: 'demo_kilo_ancien',
    });
    await sql.query(
      `insert into do_not_contact (match_kind, value, reason, added_by)
       values ('instagram','demo_kilo_ancien','a répondu « ne me recontactez pas »','Test')`,
    );

    const error = await enqueueInstagramJob(sql, {
      manifestId,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InstagramEligibilityError);
    expect((error as InstagramEligibilityError).decision.reasonCode).toBe('IG_IDENTITY_HANDLE_SUPPRESSED');
  });
});

// ---------------------------------------------------------------------------
// Le cloisonnement par canal
// ---------------------------------------------------------------------------

describe('canaux — un e-mail déjà envoyé n’interdit pas un premier DM', () => {
  it('le contact e-mail de l’autre ligne est VISIBLE mais ne bloque pas Instagram', async () => {
    const old = await createProspect({
      campaignId: r5CampaignId,
      displayName: 'Cleanyourcar69',
      domain: 'demo-prospect-b.fr',
      email: 'demo-prospect-b@yahoo.com',
    });
    await sql.query(
      `insert into outreach_events (prospect_id, kind, channel, payload, occurred_at)
       values ($1,'sent','email','{}'::jsonb, now())`,
      [old],
    );

    const fresh = await createProspect({
      campaignId: r7CampaignId,
      displayName: 'Clean Your Car 69',
      domain: 'demo-prospect-b.fr',
      instagramHandle: 'demo-prospect-b',
    });

    const history = await loadBusinessContactHistory(sql, fresh);
    expect(history.verdict).toBe('ALREADY_CONTACTED');
    expect(contactsOnChannel(history, 'instagram_dm')).toHaveLength(0);
    expect(contactsOnOtherChannels(history, 'instagram_dm')).toHaveLength(1);

    // Le verrou Instagram passe : ce sont deux conversations distinctes.
    const itemId = await approveForLock(fresh, ['instagram']);
    const manifest = await lockManifestForItem(sql, { itemId, transport: 'instagram_dm' });
    expect(manifest.status).toBe('LOCKED');
  });

  it('mais un e-mail déjà envoyé au commerce bloque un SECOND e-mail', async () => {
    const old = await createProspect({
      campaignId: r5CampaignId,
      displayName: 'Cleanyourcar69',
      domain: 'demo-prospect-b.fr',
      email: 'demo-prospect-b@yahoo.com',
    });
    await sql.query(
      `insert into outreach_events (prospect_id, kind, channel, payload, occurred_at)
       values ($1,'sent','email','{}'::jsonb, now())`,
      [old],
    );

    const fresh = await createProspect({
      campaignId: r7CampaignId,
      displayName: 'Clean Your Car 69',
      domain: 'demo-prospect-b.fr',
      email: 'bonjour@demo-prospect-b.fr',
    });
    const itemId = await approveForLock(fresh, ['email']);
    await expect(lockManifestForItem(sql, { itemId, transport: 'email' })).rejects.toBeInstanceOf(DispatchLockError);
  });
});
