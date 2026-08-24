import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { loadInstagramRail } from '@/lib/config/load';
import type { InstagramRailConfig } from '@/lib/config/schema';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import { lockManifestForItem, type DispatchManifest } from '@/lib/pipeline/r6bDispatch';
import { resolveDispatchTarget } from '@/lib/pipeline/r6bDispatcher';
import {
  armCanaryAuthorization,
  CanaryAuthorizationError,
  checkCanaryAuthorization,
  consumeCanaryReservation,
  reserveCanaryAuthorization,
  expireStaleCanaryAuthorizations,
  listCanaryHistory,
  loadCanaryForManifest,
  MAX_CANARY_TTL_MS,
  revokeCanaryAuthorization,
  type CanaryAuthorization,
} from '@/lib/instagram/canary';
import { enqueueInstagramJob, loadInstagramJob, markExternalEffectAttempted } from '@/lib/instagram/queue';
import { loadKillSwitch, setKillSwitch } from '@/lib/instagram/safety';
import { judgeSendOutcome, runInstagramLiveCanary, type LiveCanaryResult } from '@/lib/instagram/liveWorker';
import { classifyLiveDmRequest, isAllowedLiveNavigation } from '@/lib/instagram/readOnlyGuard';
import {
  InstagramRailError,
  type InstagramLiveRail,
  type InstagramProfileObservation,
  type InstagramReadOnlyRail,
  type InstagramSendInput,
  type InstagramSendObservation,
  type InstagramSendResult,
  type InstagramSessionStatus,
} from '@/lib/instagram/rail';
import { UNREAD_RELATIONSHIP, type InstagramRelationshipObservation } from '@/lib/instagram/relationship';
import type { InstagramSessionState } from '@/lib/instagram/types';
import type { Sql } from '@/lib/db/sql';
import { makeProspectInstagramEligible } from './support/instagramEligibility';

/**
 * IG2 §11 — le canari LIVE, éprouvé sans envoyer un seul message.
 *
 * Aucun test de ce fichier n'ouvre Instagram : le rail est un double injecté,
 * exactement comme en R1, parce que le worker ne construit jamais son
 * navigateur lui-même. Ce que les doubles permettent, et qu'un vrai navigateur
 * rendrait impossible à éprouver : un timeout APRÈS le clic, deux workers en
 * course sur la même autorisation, une preuve UI incomplète.
 *
 * L'invariant vérifié partout : un `SENT` n'existe que là où les cinq preuves
 * concordent, et `outreach_events` ne bouge nulle part ailleurs.
 */

const TEXT = 'Bonjour, une question rapide sur vos prises de rendez-vous.';
const HANDLE = 'demo_prospect_a';
const ROOT = resolve(__dirname, '..');

let sql: Sql;
let dir: string;
let campaignId: string;
let config: InstagramRailConfig;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-ig-canary-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  config = loadInstagramRail();
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-ig2-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Les deux tables se référencent mutuellement (0031) : le job pointe vers
  // l'autorisation qui l'a couvert, l'autorisation vers le job qui l'a
  // consommée. Rien n'est jamais supprimé en production ; ici il faut d'abord
  // rompre le cycle.
  await sql.query('update ig_live_canary_authorizations set consumed_job_id = null');
  await sql.query('delete from ig_job_events');
  await sql.query('delete from ig_identity_checks');
  // Jobs et autorisations se pointent mutuellement (le job nomme l'autorisation
  // qui a couvert sa tentative, l'autorisation nomme le job qu'elle a réservé) :
  // il faut couper le cycle avant de supprimer, dans un sens ou dans l'autre.
  await sql.query('update ig_live_canary_authorizations set reserved_job_id = null, consumed_job_id = null');
  // IG3 — le journal d'éligibilité pointe les jobs (FK) : il part d'abord.
  await sql.query('delete from ig_enqueue_decisions');
  await sql.query('delete from ig_dispatch_jobs');
  await sql.query('delete from ig_live_canary_authorizations');
  await sql.query('delete from ig_browser_sessions');
  await sql.query('delete from ig_kill_switch');
  await sql.query('delete from r6b_dispatch_attempts');
  await sql.query('delete from r6b_prospect_state_transitions');
  await sql.query('delete from r6b_prospect_outreach_states');
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

async function lockManifest(handle = HANDLE): Promise<DispatchManifest> {
  const prospect = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, instagram_handle)
     values ($1,$2,'DEMO PROSPECT A',$3) returning id`,
    [campaignId, `prospect-${Math.random()}`, handle],
  );
  const prospectId = prospect[0]!.id;
  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,'instagram_handle',$2,'website','crawl','https://example.org',1.0)`,
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
  await castR6bVote(sql, { itemId: item[0]!.id, verdict: 'SEND', approvedText: TEXT, note: null });
  await makeProspectInstagramEligible(sql, prospectId);
  return lockManifestForItem(sql, { itemId: item[0]!.id, transport: 'instagram_dm' });
}

async function arm(manifestId: string, ttlMs = 30 * 60_000): Promise<CanaryAuthorization> {
  const { envelope } = await resolveDispatchTarget(sql, manifestId, 'LIVE');
  return armCanaryAuthorization(sql, {
    envelope,
    action: 'first_touch_dm',
    armedBy: 'Operator Example',
    reason: 'test IG2',
    ttlMs,
  });
}

/** Le monde nominal : manifeste verrouillé, job enfilé, arrêt levé, canari armé. */
async function ready(): Promise<{ manifestId: string; jobId: string; auth: CanaryAuthorization }> {
  const manifest = await lockManifest();
  const { job } = await enqueueInstagramJob(sql, {
    manifestId: manifest.id,
    action: 'first_touch_dm',
    enqueuedBy: 'Test',
  });
  await setKillSwitch(sql, { engaged: false, setBy: 'Operator Example', reason: 'test IG2' });
  const auth = await arm(manifest.id);
  return { manifestId: manifest.id, jobId: job.id, auth };
}

async function countOutreach(): Promise<number> {
  const rows = await sql.query<{ n: string }>(`select count(*) as n from outreach_events`);
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Doubles de rail
// ---------------------------------------------------------------------------

const GOOD_OBSERVATION: InstagramSendObservation = Object.freeze({
  threadUrl: 'https://www.instagram.com/direct/t/123/',
  threadHandle: HANDLE,
  matchingBubblesBefore: 0,
  matchingBubblesAfter: 1,
  harvestReadableBefore: true,
  harvestReadableAfter: true,
  composerCleared: true,
  outgoingBubbleConfirmed: true,
  deliveryFailureMarkers: Object.freeze([]),
  deliveryVerdict: 'SENT',
  scopeDetail: 'niveau 3 (div[role=dialog])',
  sessionState: 'SESSION_READY',
  screenshotPath: null,
  durationMs: 10,
  detail: 'clic unique',
});

interface FakeLiveOptions {
  sessionState?: InstagramSessionState;
  profileSessionState?: InstagramSessionState;
  observedHandle?: string | null;
  ensureError?: InstagramRailError;
  /** Ce que la primitive rendra, une fois le crochet d'effet appelé. */
  sendResult?: InstagramSendResult;
  /** Lève APRÈS avoir appelé `onBeforeExternalEffect` — le timeout post-effet. */
  throwAfterEffect?: Error;
  /** Lève AVANT le crochet — la panne pré-effet. */
  throwBeforeEffect?: Error;
  /** IG2.2 — la relation d'abonnement rendue par la page de profil. */
  relationship?: InstagramRelationshipObservation;
}

class FakeLiveRail implements InstagramLiveRail {
  readonly opened: string[] = [];
  readonly sendCalls: InstagramSendInput[] = [];
  effectHookCalls = 0;
  closed = false;

  constructor(private readonly options: FakeLiveOptions = {}) {}

  async ensureSession(): Promise<InstagramSessionStatus> {
    if (this.options.ensureError) throw this.options.ensureError;
    return {
      state: this.options.sessionState ?? 'SESSION_READY',
      detail: 'double de test',
      profileLabel: 'test',
      headless: true,
    };
  }

  async openProfile(handle: string): Promise<InstagramProfileObservation> {
    this.opened.push(handle);
    const observed = this.options.observedHandle === undefined ? handle : this.options.observedHandle;
    return {
      requestedUrl: `https://www.instagram.com/${handle}/`,
      finalUrl: `https://www.instagram.com/${handle}/`,
      redirected: false,
      profileMissing: false,
      sessionState: this.options.profileSessionState ?? 'SESSION_READY',
      relationship: this.options.relationship ?? UNREAD_RELATIONSHIP,
      signals: [
        { name: 'canonical_url', handle, raw: `https://www.instagram.com/${handle}/` },
        { name: 'og_url', handle: observed, raw: null },
        { name: 'profile_header', handle: observed, raw: null },
      ],
      screenshotPath: null,
      durationMs: 1,
    };
  }

  async sendFirstTouchDm(input: InstagramSendInput): Promise<InstagramSendResult> {
    this.sendCalls.push(input);
    if (this.options.throwBeforeEffect) throw this.options.throwBeforeEffect;
    if (input.stopAfter === 'thread') {
      return {
        kind: 'PREVIEWED',
        detail: 'aperçu',
        sessionState: 'SESSION_READY',
        threadUrl: 'https://www.instagram.com/direct/t/123/',
        threadHandle: HANDLE,
        composerReady: true,
        screenshotPath: null,
      };
    }
    await input.onBeforeExternalEffect();
    this.effectHookCalls += 1;
    if (this.options.throwAfterEffect) throw this.options.throwAfterEffect;
    return this.options.sendResult ?? { kind: 'ATTEMPTED', observation: GOOD_OBSERVATION };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Un rail en LECTURE SEULE : il n'a rien à appeler pour envoyer. */
class ReadOnlyRail implements InstagramReadOnlyRail {
  async ensureSession(): Promise<InstagramSessionStatus> {
    return { state: 'SESSION_READY', detail: '', profileLabel: 'test', headless: true };
  }
  async openProfile(handle: string): Promise<InstagramProfileObservation> {
    return {
      requestedUrl: `https://www.instagram.com/${handle}/`,
      finalUrl: `https://www.instagram.com/${handle}/`,
      redirected: false,
      profileMissing: false,
      sessionState: 'SESSION_READY',
      relationship: UNREAD_RELATIONSHIP,
      signals: [],
      screenshotPath: null,
      durationMs: 1,
    };
  }
  async close(): Promise<void> {}
}

async function runCanary(
  rail: InstagramReadOnlyRail,
  manifestId: string,
  over: { mode?: string; previewOnly?: boolean; workerId?: string } = {},
): Promise<LiveCanaryResult> {
  return runInstagramLiveCanary(
    {
      sql,
      config,
      workerId: over.workerId ?? 'test-live-worker',
      mode: over.mode ?? 'LIVE',
      manifestId,
      action: 'first_touch_dm',
      previewOnly: over.previewOnly ?? false,
    },
    { rail },
  );
}

/** L'invariant de tout refus : zéro effet, zéro contact, zéro trace de tentative. */
async function expectNoEffect(result: LiveCanaryResult, jobId: string): Promise<void> {
  expect(result.externalAttempts).toBe(0);
  expect(result.externalEffectAttempted).toBe(false);
  expect(await countOutreach()).toBe(0);
  const job = await loadInstagramJob(sql, jobId);
  expect(job!.externalEffectAttempted).toBe(false);
  expect(job!.externalEffectStartedAt).toBeNull();
  expect(job!.status).not.toBe('SENT');
  const sent = await sql.query<{ n: string }>(`select count(*) as n from ig_job_events where status = 'SENT'`);
  expect(Number(sent[0]!.n)).toBe(0);
}

// ---------------------------------------------------------------------------
// §3 — l'autorisation elle-même
// ---------------------------------------------------------------------------

describe('autorisation canari', () => {
  it('n’existe pas par défaut : une base neuve n’autorise rien', async () => {
    const manifest = await lockManifest();
    expect(await loadCanaryForManifest(sql, manifest.id)).toBeNull();
    const verdict = checkCanaryAuthorization({
      authorization: null,
      manifestId: manifest.id,
      action: 'first_touch_dm',
      expectedHandle: HANDLE,
      approvedTextSha256: 'a'.repeat(64),
      transportPayloadSha256: 'b'.repeat(64),
      now: Date.now(),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('IG_CANARY_NOT_ARMED');
  });

  it('recopie sa cible depuis le manifeste, jamais depuis l’appelant', async () => {
    const manifest = await lockManifest();
    const auth = await arm(manifest.id);
    const { envelope } = await resolveDispatchTarget(sql, manifest.id, 'LIVE');
    expect(auth.expectedHandle).toBe(envelope.recipient);
    expect(auth.approvedTextSha256).toBe(envelope.approvedTextSha256);
    expect(auth.transportPayloadSha256).toBe(envelope.transportPayloadSha256);
    expect(auth.maxExternalAttempts).toBe(1);
    expect(auth.externalAttemptsUsed).toBe(0);
    expect(auth.state).toBe('ARMED');
    expect(auth.armedBy).toBe('Operator Example');
  });

  it('refuse une durée de vie hors bornes — « courte » est un nombre, pas une intention', async () => {
    const manifest = await lockManifest();
    await expect(arm(manifest.id, MAX_CANARY_TTL_MS + 1)).rejects.toBeInstanceOf(CanaryAuthorizationError);
    await expect(arm(manifest.id, 0)).rejects.toBeInstanceOf(CanaryAuthorizationError);
  });

  it('exige un auteur nommé', async () => {
    const manifest = await lockManifest();
    const { envelope } = await resolveDispatchTarget(sql, manifest.id, 'LIVE');
    await expect(
      armCanaryAuthorization(sql, { envelope, action: 'first_touch_dm', armedBy: '  ', reason: 'x', ttlMs: 1000 }),
    ).rejects.toBeInstanceOf(CanaryAuthorizationError);
  });

  it('une seule autorisation armée dans toute la base', async () => {
    const first = await lockManifest();
    const second = await lockManifest('demo_account_30');
    await arm(first.id);
    await expect(arm(second.id)).rejects.toBeInstanceOf(CanaryAuthorizationError);
  });

  it('expire toute seule, et l’expiration est relue même sur une ligne restée ARMED', async () => {
    const manifest = await lockManifest();
    const auth = await arm(manifest.id, 60_000);

    // Le statut n'a pas encore été balayé, mais l'échéance est passée : la
    // vérification pure doit refuser sur la DATE, pas sur le statut.
    const stale = { ...auth, expiresAt: new Date(Date.now() - 1_000).toISOString() };
    const verdict = checkCanaryAuthorization({
      authorization: stale,
      manifestId: manifest.id,
      action: 'first_touch_dm',
      expectedHandle: auth.expectedHandle,
      approvedTextSha256: auth.approvedTextSha256,
      transportPayloadSha256: auth.transportPayloadSha256,
      now: Date.now(),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('IG_CANARY_EXPIRED');

    await sql.query(`update ig_live_canary_authorizations set expires_at = now() - interval '1 minute'`);
    expect(await expireStaleCanaryAuthorizations(sql)).toBe(1);
    expect((await loadCanaryForManifest(sql, manifest.id))!.state).toBe('EXPIRED');
  });

  it('refuse la cible qui ne correspond pas : manifeste, action, handle, empreintes', async () => {
    const manifest = await lockManifest();
    const auth = await arm(manifest.id);
    const base = {
      authorization: auth,
      manifestId: manifest.id,
      action: 'first_touch_dm' as const,
      expectedHandle: auth.expectedHandle,
      approvedTextSha256: auth.approvedTextSha256,
      transportPayloadSha256: auth.transportPayloadSha256,
      now: Date.now(),
    };
    expect(checkCanaryAuthorization(base).ok).toBe(true);

    const cases = [
      [{ ...base, manifestId: '00000000-0000-0000-0000-000000000000' }, 'IG_CANARY_MANIFEST_MISMATCH'],
      [{ ...base, expectedHandle: 'unautrecompte' }, 'IG_CANARY_HANDLE_MISMATCH'],
      [{ ...base, approvedTextSha256: 'c'.repeat(64) }, 'IG_CANARY_PAYLOAD_DRIFT'],
      [{ ...base, transportPayloadSha256: 'd'.repeat(64) }, 'IG_CANARY_PAYLOAD_DRIFT'],
    ] as const;
    for (const [input, code] of cases) {
      const verdict = checkCanaryAuthorization(input);
      expect(verdict.ok, code).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe(code);
    }
  });

  it('la casse du handle ne fait pas dériver la cible — Instagram l’ignore', async () => {
    const manifest = await lockManifest();
    const auth = await arm(manifest.id);
    const verdict = checkCanaryAuthorization({
      authorization: auth,
      manifestId: manifest.id,
      action: 'first_touch_dm',
      expectedHandle: HANDLE.toUpperCase(),
      approvedTextSha256: auth.approvedTextSha256,
      transportPayloadSha256: auth.transportPayloadSha256,
      now: Date.now(),
    });
    expect(verdict.ok).toBe(true);
  });

  it('un armement dépensé SANS effet ne ferme pas le manifeste — 0032', async () => {
    // Le premier canari réel s'est arrêté au dernier point, sans clic : zéro
    // octet parti. La contrainte d'origine (une autorisation par manifeste,
    // pour toujours) rendait pourtant toute reprise impossible. C'est le fait
    // « un effet a été tenté » qui doit fermer la porte, pas le fait « une
    // autorisation a existé ».
    const manifest = await lockManifest();
    await enqueueInstagramJob(sql, { manifestId: manifest.id, action: 'first_touch_dm', enqueuedBy: 'Test' });
    const first = await arm(manifest.id);
    await revokeCanaryAuthorization(sql, { id: first.id, revokedBy: 'un opérateur', reason: 'rail corrigé' });

    const second = await arm(manifest.id);
    expect(second.id).not.toBe(first.id);
    expect(second.state).toBe('ARMED');
    // Et l'historique complet reste lisible : deux décisions, pas une réécriture.
    expect(await listCanaryHistory(sql, manifest.id)).toHaveLength(2);
    expect((await loadCanaryForManifest(sql, manifest.id))!.id).toBe(second.id);
  });

  it('mais un effet DÉJÀ tenté ferme le manifeste définitivement — 0032', async () => {
    const { manifestId, jobId, auth } = await ready();
    await markExternalEffectAttempted(sql, { jobId, canaryAuthorizationId: auth.id });
    await revokeCanaryAuthorization(sql, { id: auth.id, revokedBy: 'un opérateur', reason: 'issue inconnue' });

    await expect(arm(manifestId)).rejects.toThrow(/IG_CANARY_EFFECT_ALREADY_ATTEMPTED|effet externe/);
  });

  it('une seule reste armée à la fois, même avec un historique', async () => {
    const manifest = await lockManifest();
    const first = await arm(manifest.id);
    await expect(arm(manifest.id)).rejects.toBeInstanceOf(CanaryAuthorizationError);
    await revokeCanaryAuthorization(sql, { id: first.id, revokedBy: 'un opérateur', reason: 'x' });
    const second = await arm(manifest.id);
    const armedRows = (await listCanaryHistory(sql, manifest.id)).filter((a) => a.state === 'ARMED');
    expect(armedRows).toHaveLength(1);
    expect(armedRows[0]!.id).toBe(second.id);
  });

  it('révoquée, elle ne se rouvre pas', async () => {
    const manifest = await lockManifest();
    const auth = await arm(manifest.id);
    const revoked = await revokeCanaryAuthorization(sql, { id: auth.id, revokedBy: 'un opérateur', reason: 'test' });
    expect(revoked!.state).toBe('REVOKED');
    expect(await revokeCanaryAuthorization(sql, { id: auth.id, revokedBy: 'un opérateur', reason: 'x' })).toBeNull();
  });

  it('la réservation est atomique : deux workers, un seul gagne', async () => {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    const auth = await arm(manifest.id);
    const input = {
      authorizationId: auth.id,
      jobId: job.id,
      manifestId: manifest.id,
      expectedHandle: auth.expectedHandle,
      approvedTextSha256: auth.approvedTextSha256,
      transportPayloadSha256: auth.transportPayloadSha256,
    };

    const [a, b] = await Promise.all([
      reserveCanaryAuthorization(sql, { ...input, workerId: 'w1' }),
      reserveCanaryAuthorization(sql, { ...input, workerId: 'w2' }),
    ]);
    const winners = [a, b].filter((row) => row !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.state).toBe('RESERVED');
    // IG2.1 §7 — réserver ne dépense rien : le compteur reste à zéro tant qu'aucun
    // effet externe n'est tenté.
    expect(winners[0]!.externalAttemptsUsed).toBe(0);

    // Et une troisième tentative, séquentielle, échoue aussi.
    expect(await reserveCanaryAuthorization(sql, { ...input, workerId: 'w3' })).toBeNull();
  });

  it('la réservation refuse une cible qui a bougé entre la vérification et la prise', async () => {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    const auth = await arm(manifest.id);
    const reserved = await reserveCanaryAuthorization(sql, {
      authorizationId: auth.id,
      jobId: job.id,
      workerId: 'w1',
      manifestId: manifest.id,
      expectedHandle: auth.expectedHandle,
      approvedTextSha256: 'f'.repeat(64),
      transportPayloadSha256: auth.transportPayloadSha256,
    });
    expect(reserved).toBeNull();
    expect((await loadCanaryForManifest(sql, manifest.id))!.state).toBe('ARMED');
  });
});

// ---------------------------------------------------------------------------
// §5 — les gardes, une par une
// ---------------------------------------------------------------------------

describe('gardes pré-envoi', () => {
  it('LIVE est impossible sans autorisation canari, même arrêt global levé', async () => {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    await setKillSwitch(sql, { engaged: false, setBy: 'un opérateur', reason: 'test' });

    const rail = new FakeLiveRail();
    const result = await runCanary(rail, manifest.id);

    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCode).toBe('IG_CANARY_NOT_ARMED');
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoEffect(result, job.id);
  });

  it('l’arrêt global refuse avant tout : ni job pris, ni navigateur ouvert', async () => {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    // Armé PUIS refermé : l'autorisation seule ne suffit jamais.
    await setKillSwitch(sql, { engaged: false, setBy: 'un opérateur', reason: 'test' });
    await arm(manifest.id);
    await setKillSwitch(sql, { engaged: true, setBy: 'un opérateur', reason: 'on referme' });

    const rail = new FakeLiveRail();
    const result = await runCanary(rail, manifest.id);

    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCode).toBe('IG_KILL_SWITCH_ENGAGED');
    expect(rail.opened).toHaveLength(0);
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoEffect(result, job.id);
    // L'autorisation n'a pas été touchée : un refus ne consomme pas un droit.
    expect((await loadCanaryForManifest(sql, manifest.id))!.state).toBe('ARMED');
  });

  it('un mode autre que LIVE est refusé', async () => {
    const { manifestId, jobId } = await ready();
    const rail = new FakeLiveRail();
    const result = await runCanary(rail, manifestId, { mode: 'DRY_RUN' });
    expect(result.reasonCode).toBe('IG_LIVE_MODE_REQUIRED');
    await expectNoEffect(result, jobId);
  });

  it('un rail sans primitive d’envoi ne peut rien tenter', async () => {
    const { manifestId, jobId } = await ready();
    const result = await runCanary(new ReadOnlyRail(), manifestId);
    expect(result.reasonCode).toBe('IG_LIVE_ADAPTER_MISSING');
    await expectNoEffect(result, jobId);
  });

  it('un autre manifeste que celui armé est refusé', async () => {
    await ready();
    const other = await lockManifest('demo_account_30');
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: other.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    const rail = new FakeLiveRail();
    const result = await runCanary(rail, other.id);

    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCode).toBe('IG_CANARY_NOT_ARMED');
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoEffect(result, job.id);
  });

  it('un handle qui a dérivé depuis l’armement est refusé', async () => {
    const { manifestId, jobId } = await ready();
    // Le manifeste change de destinataire après l'armement.
    await sql.query(`update r6b_dispatch_manifests set recipient = 'unautrecompte' where id = $1`, [manifestId]);

    const rail = new FakeLiveRail();
    const result = await runCanary(rail, manifestId);
    expect(result.status).toBe('BLOCKED');
    // La dérive job ↔ manifeste mord la première : le job avait figé le handle.
    expect(['IG_JOB_MANIFEST_DRIFT', 'IG_CANARY_HANDLE_MISMATCH']).toContain(result.reasonCode);
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoEffect(result, jobId);
  });

  it('un texte approuvé qui a dérivé est refusé — par son empreinte', async () => {
    const { manifestId, jobId } = await ready();
    await sql.query(`update r6b_dispatch_manifests set approved_text = $2 where id = $1`, [
      manifestId,
      'Un texte que personne n’a approuvé.',
    ]);

    const rail = new FakeLiveRail();
    const result = await runCanary(rail, manifestId);
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCode).toBe('APPROVED_TEXT_SHA_MISMATCH');
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoEffect(result, jobId);
  });

  it('une autorisation expirée est refusée', async () => {
    const { manifestId, jobId } = await ready();
    await sql.query(`update ig_live_canary_authorizations set expires_at = now() - interval '1 minute'`);

    const rail = new FakeLiveRail();
    const result = await runCanary(rail, manifestId);
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCode).toBe('IG_CANARY_EXPIRED');
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoEffect(result, jobId);
  });

  it('une autorisation déjà consommée est refusée', async () => {
    const { manifestId, jobId, auth } = await ready();
    await reserveCanaryAuthorization(sql, {
      authorizationId: auth.id,
      jobId,
      workerId: 'un-autre-worker',
      manifestId,
      expectedHandle: auth.expectedHandle,
      approvedTextSha256: auth.approvedTextSha256,
      transportPayloadSha256: auth.transportPayloadSha256,
    });
    await consumeCanaryReservation(sql, { authorizationId: auth.id, jobId, workerId: 'un-autre-worker' });

    const rail = new FakeLiveRail();
    const result = await runCanary(rail, manifestId);
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCode).toBe('IG_CANARY_CONSUMED');
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoEffect(result, jobId);
  });

  it('une autorisation révoquée est refusée', async () => {
    const { manifestId, jobId, auth } = await ready();
    await revokeCanaryAuthorization(sql, { id: auth.id, revokedBy: 'un opérateur', reason: 'on annule' });

    const result = await runCanary(new FakeLiveRail(), manifestId);
    expect(result.reasonCode).toBe('IG_CANARY_REVOKED');
    await expectNoEffect(result, jobId);
  });

  it('une identité qui ne correspond pas refuse avant le composeur', async () => {
    const { manifestId, jobId } = await ready();
    const rail = new FakeLiveRail({ observedHandle: 'unautre' });
    const result = await runCanary(rail, manifestId);

    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCode).toBe('IG_IDENTITY_MISMATCH');
    expect(result.identityVerdict).toBe('MISMATCH');
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoEffect(result, jobId);
  });

  it.each([
    ['CHALLENGE', 'IG_SESSION_CHALLENGE'],
    ['CAPTCHA', 'IG_SESSION_CAPTCHA'],
    ['BLOCKED', 'IG_SESSION_BLOCKED'],
    ['SESSION_EXPIRED', 'IG_SESSION_EXPIRED'],
    ['LOGIN_REQUIRED', 'IG_SESSION_LOGIN_REQUIRED'],
    ['UNKNOWN', 'IG_SESSION_UNKNOWN'],
  ] as const)('session %s refuse le canari (%s)', async (state, code) => {
    const { manifestId, jobId } = await ready();
    const rail = new FakeLiveRail({ sessionState: state });
    const result = await runCanary(rail, manifestId);

    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCode).toBe(code);
    expect(rail.opened).toHaveLength(0);
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoEffect(result, jobId);
  });

  it('un challenge apparu SUR la page de profil refuse aussi', async () => {
    const { manifestId, jobId } = await ready();
    const rail = new FakeLiveRail({ profileSessionState: 'CHALLENGE' });
    const result = await runCanary(rail, manifestId);

    expect(result.reasonCode).toBe('IG_SESSION_CHALLENGE');
    expect(result.detail).toContain('arrêt dur');
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoEffect(result, jobId);
  });

  it('les plafonds d’envoi refusent le canari', async () => {
    const { manifestId, jobId, auth } = await ready();
    for (let i = 0; i < config.caps.dailySentCap; i += 1) {
      await sql.query(
        `insert into ig_job_events
           (job_id, manifest_id, worker_id, mode, status, reason_code, idempotency_key,
            external_effect_attempted, canary_authorization_id, created_at)
         values ($1,$2,'w','LIVE','SENT','IG_LIVE_SENT','k',true,$3, now() - interval '3 hours')`,
        [jobId, manifestId, auth.id],
      );
    }
    const rail = new FakeLiveRail();
    const result = await runCanary(rail, manifestId);
    expect(result.status).toBe('BLOCKED');
    expect(['IG_CAP_DAILY_SENT', 'IG_CAP_HOURLY_SENT']).toContain(result.reasonCode);
    expect(rail.sendCalls).toHaveLength(0);
  });

  it('l’intervalle minimal se mesure sur un effet, et il refuse le canari', async () => {
    const { manifestId, jobId, auth } = await ready();
    // Un effet tout récent : il n'a rien prouvé, mais il a chargé Instagram —
    // donc il consomme l'intervalle. C'est exactement §1.
    //
    // IG2.1 — la mesure lit le JOB (`external_effect_started_at`), plus le
    // journal : un événement date un RÉCIT, le drapeau du job date le geste.
    // Une adjudication postérieure écrit un second événement sans qu'un octet
    // parte, et repousserait la cadence à chaque relecture.
    await markExternalEffectAttempted(sql, { jobId, canaryAuthorizationId: auth.id });
    const rail = new FakeLiveRail();
    const result = await runCanary(rail, manifestId);
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCode).toBe('IG_CAP_MIN_INTERVAL');
    expect(rail.sendCalls).toHaveLength(0);
  });

  it('un DRY-RUN récent ne consomme PAS l’intervalle — régression §1', async () => {
    const { manifestId, jobId } = await ready();
    await sql.query(
      `insert into ig_job_events
         (job_id, manifest_id, worker_id, mode, status, reason_code, idempotency_key, external_effect_attempted)
       values ($1,$2,'w','DRY_RUN','DRY_RUN_OK','IG_DRY_RUN_OK','k',false)`,
      [jobId, manifestId],
    );
    const result = await runCanary(new FakeLiveRail(), manifestId);
    expect(result.status).toBe('SENT');
  });

  it('un job qui a déjà tenté un effet ne repart jamais', async () => {
    const { manifestId, jobId, auth } = await ready();
    await markExternalEffectAttempted(sql, { jobId, canaryAuthorizationId: auth.id });
    // L'intervalle de cadence mordrait d'abord (c'est son rôle) : on l'écarte
    // pour éprouver la garde qui nous intéresse — celle qui interdit un second
    // effet même quand tout le reste est vert.
    await sql.query(`update ig_dispatch_jobs set external_effect_started_at = now() - interval '2 days'`);

    const rail = new FakeLiveRail();
    const result = await runCanary(rail, manifestId);
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCode).toBe('IG_LIVE_EFFECT_ALREADY_ATTEMPTED');
    expect(rail.sendCalls).toHaveLength(0);
    expect(await countOutreach()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §6 — l'aperçu
// ---------------------------------------------------------------------------

describe('aperçu', () => {
  it('parcourt tout le chemin sans cliquer, sans saisir et sans consommer l’autorisation', async () => {
    const { manifestId, jobId } = await ready();
    const rail = new FakeLiveRail();
    const result = await runCanary(rail, manifestId, { previewOnly: true });

    expect(result.status).toBe('PREVIEWED');
    expect(result.externalAttempts).toBe(0);
    expect(result.externalEffectAttempted).toBe(false);
    expect(rail.sendCalls).toHaveLength(1);
    expect(rail.sendCalls[0]!.stopAfter).toBe('thread');
    expect(rail.effectHookCalls).toBe(0);

    // Le rapport porte tout ce que §6 demande.
    expect(result.expectedHandle).toBe(HANDLE);
    expect(result.identityVerdict).toBe('MATCH');
    expect(result.approvedText).toBe(TEXT);
    expect(result.approvedTextSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.canary!.state).toBe('ARMED');
    expect(result.sessionState).toBe('SESSION_READY');
    expect(result.gates.some((g) => g.gate === 'cap_daily_sent' && g.verdict === 'PASS')).toBe(true);

    await expectNoEffect(result, jobId);
    // L'autorisation reste armée : un aperçu ne dépense pas le droit d'envoyer.
    expect((await loadCanaryForManifest(sql, manifestId))!.state).toBe('ARMED');
  });

  it('le message de l’aperçu vient du manifeste, mot pour mot', async () => {
    const { manifestId } = await ready();
    const rail = new FakeLiveRail();
    await runCanary(rail, manifestId, { previewOnly: true });
    expect(rail.sendCalls[0]!.body).toBe(TEXT);
  });

  it('l’aperçu tourne arrêt global ARMÉ, le rapporte, et ne peut rien envoyer', async () => {
    // §6 — l'aperçu précède la levée de l'arrêt. Il doit donc pouvoir tourner
    // pendant qu'il est armé, et le DIRE.
    const { manifestId, jobId } = await ready();
    await setKillSwitch(sql, { engaged: true, setBy: 'un opérateur', reason: 'toujours fermé' });

    const rail = new FakeLiveRail();
    const result = await runCanary(rail, manifestId, { previewOnly: true });

    expect(result.status).toBe('PREVIEWED');
    const gate = result.gates.find((g) => g.gate === 'kill_switch');
    expect(gate?.verdict).toBe('BLOCK');
    expect(rail.effectHookCalls).toBe(0);
    await expectNoEffect(result, jobId);
    expect((await loadCanaryForManifest(sql, manifestId))!.state).toBe('ARMED');
  });

  it('mais un ENVOI reste refusé par le même arrêt global', async () => {
    const { manifestId, jobId } = await ready();
    await setKillSwitch(sql, { engaged: true, setBy: 'un opérateur', reason: 'toujours fermé' });

    const rail = new FakeLiveRail();
    const result = await runCanary(rail, manifestId, { previewOnly: false });

    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCode).toBe('IG_KILL_SWITCH_ENGAGED');
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoEffect(result, jobId);
  });

  it('l’aperçu s’arrête quand même sur l’identité, la session et le manifeste', async () => {
    const { manifestId, jobId } = await ready();
    const rail = new FakeLiveRail({ observedHandle: 'unautre' });
    const result = await runCanary(rail, manifestId, { previewOnly: true });
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCode).toBe('IG_IDENTITY_MISMATCH');
    await expectNoEffect(result, jobId);
  });
});

// ---------------------------------------------------------------------------
// §4/§7/§8 — l'effet, sa trace et sa preuve
// ---------------------------------------------------------------------------

describe('canari LIVE', () => {
  it('envoie une fois, prouve, et crée exactement un outreach_event', async () => {
    const { manifestId, jobId } = await ready();
    const rail = new FakeLiveRail();
    const result = await runCanary(rail, manifestId);

    expect(result.status).toBe('SENT');
    expect(result.reasonCode).toBe('IG_LIVE_SENT');
    expect(result.externalAttempts).toBe(1);
    expect(result.externalEffectAttempted).toBe(true);
    expect(rail.sendCalls).toHaveLength(1);
    expect(rail.effectHookCalls).toBe(1);

    // Le job est terminal, avec sa trace d'effet horodatée.
    const job = await loadInstagramJob(sql, jobId);
    expect(job!.status).toBe('SENT');
    expect(job!.externalEffectAttempted).toBe(true);
    expect(job!.externalEffectStartedAt).not.toBeNull();
    expect(job!.terminatedAt).not.toBeNull();
    expect(job!.canaryAuthorizationId).toBe(result.canary!.id);

    // L'autorisation est consommée, définitivement.
    const auth = await loadCanaryForManifest(sql, manifestId);
    expect(auth!.state).toBe('CONSUMED');
    expect(auth!.externalAttemptsUsed).toBe(1);
    expect(auth!.consumedJobId).toBe(jobId);

    // Exactement un événement de contact, et un état commercial d'attente.
    expect(await countOutreach()).toBe(1);
    const events = await sql.query<{ kind: string; channel: string; manifestId: string }>(
      `select kind, channel, manifest_id as "manifestId" from outreach_events`,
    );
    expect(events[0]).toMatchObject({ kind: 'sent', channel: 'instagram_dm', manifestId });
    expect(result.outreachState).toBe('CONTACTED');

    // Et une ligne SENT au journal, rattachée à l'autorisation.
    // IG3 — le journal porte aussi l'entrée en file (`ENQUEUED`). On isole donc
    // l'ISSUE, qui est la seule ligne pouvant déclarer un effet.
    const journal = await sql.query<{ status: string; effect: boolean; canary: string }>(
      `select status, external_effect_attempted as effect, canary_authorization_id as canary
         from ig_job_events where status not in ('ENQUEUED', 'CLAIMED', 'DRY_RUN_STARTED', 'SKIPPED')`,
    );
    expect(journal).toHaveLength(1);
    expect(journal[0]!.status).toBe('SENT');
    expect(journal[0]!.effect).toBe(true);
    expect(journal[0]!.canary).toBe(result.canary!.id);
  });

  it('deux appels LIVE successifs : le second ne peut rien tenter', async () => {
    const { manifestId, jobId } = await ready();
    const first = await runCanary(new FakeLiveRail(), manifestId);
    expect(first.status).toBe('SENT');

    // L'intervalle de cadence mordrait le premier (c'est son rôle) : on le
    // laisse passer pour éprouver la garde qui nous intéresse — celle qui
    // interdit un second effet même quand tout le reste est vert.
    await sql.query(`update ig_job_events set created_at = now() - interval '2 days'`);
    await sql.query(
      `update ig_dispatch_jobs set external_effect_started_at = now() - interval '2 days'
         where external_effect_attempted = true`,
    );

    const rail = new FakeLiveRail();
    const second = await runCanary(rail, manifestId);
    expect(second.status).toBe('BLOCKED');
    expect(second.reasonCode).toBe('IG_LIVE_EFFECT_ALREADY_ATTEMPTED');
    expect(rail.sendCalls).toHaveLength(0);

    // Toujours exactement un contact.
    expect(await countOutreach()).toBe(1);
    const job = await loadInstagramJob(sql, jobId);
    expect(job!.status).toBe('SENT');
  });

  it('une preuve incomplète donne AMBIGUOUS, jamais SENT, et aucun outreach_event', async () => {
    const { manifestId, jobId } = await ready();
    const rail = new FakeLiveRail({
      sendResult: {
        kind: 'ATTEMPTED',
        observation: { ...GOOD_OBSERVATION, composerCleared: false, outgoingBubbleConfirmed: false },
      },
    });
    const result = await runCanary(rail, manifestId);

    expect(result.status).toBe('AMBIGUOUS');
    expect(result.reasonCode).toBe('IG_LIVE_AMBIGUOUS');
    expect(result.externalAttempts).toBe(1);
    expect(await countOutreach()).toBe(0);

    const job = await loadInstagramJob(sql, jobId);
    expect(job!.status).toBe('REVIEW_REQUIRED');
    expect(job!.externalEffectAttempted).toBe(true);
    expect(job!.terminatedAt).not.toBeNull();

    const journal = await sql.query<{ status: string }>(
      `select status from ig_job_events where status not in ('ENQUEUED', 'CLAIMED', 'DRY_RUN_STARTED', 'SKIPPED')`,
    );
    expect(journal[0]!.status).toBe('AMBIGUOUS');
  });

  it('un timeout APRÈS le clic donne AMBIGUOUS — jamais un rejeu', async () => {
    const { manifestId, jobId } = await ready();
    const rail = new FakeLiveRail({ throwAfterEffect: new Error('Timeout 20000ms exceeded') });
    const result = await runCanary(rail, manifestId);

    expect(result.status).toBe('AMBIGUOUS');
    expect(result.externalAttempts).toBe(1);
    expect(result.detail).toContain('Issue inconnue');
    expect(await countOutreach()).toBe(0);

    const job = await loadInstagramJob(sql, jobId);
    expect(job!.status).toBe('REVIEW_REQUIRED');
    expect(job!.externalEffectAttempted).toBe(true);

    // Et un nouvel appel ne retente rien, même une fois la cadence écoulée.
    await sql.query(`update ig_job_events set created_at = now() - interval '2 days'`);
    await sql.query(
      `update ig_dispatch_jobs set external_effect_started_at = now() - interval '2 days'
         where external_effect_attempted = true`,
    );
    const again = new FakeLiveRail();
    const second = await runCanary(again, manifestId);
    expect(second.reasonCode).toBe('IG_LIVE_EFFECT_ALREADY_ATTEMPTED');
    expect(again.sendCalls).toHaveLength(0);
  });

  it('une panne AVANT le clic laisse le job récupérable — rien n’a été tenté', async () => {
    const { manifestId, jobId } = await ready();
    const rail = new FakeLiveRail({ throwBeforeEffect: new Error('navigateur mort avant le composeur') });
    const result = await runCanary(rail, manifestId);

    expect(result.status).toBe('FAILED');
    expect(result.externalAttempts).toBe(0);
    await expectNoEffect(result, jobId);

    // FAILED reste réclamable : la condition qui a échoué peut changer.
    const job = await loadInstagramJob(sql, jobId);
    expect(job!.status).toBe('FAILED');
    expect(job!.terminatedAt).toBeNull();
  });

  it('un renoncement de la primitive avant le clic ne crée aucun effet', async () => {
    const { manifestId, jobId } = await ready();
    const rail = new FakeLiveRail({
      sendResult: {
        kind: 'NOT_ATTEMPTED',
        code: 'IG_SEND_THREAD_IDENTITY_UNCONFIRMED',
        detail: 'le fil ouvert porte « autre »',
        sessionState: 'SESSION_READY',
        screenshotPath: null,
      },
    });
    // La primitive appelle quand même le crochet dans ce double : on veut le
    // cas RÉEL où elle ne l'appelle pas. On le reproduit avec un double dédié.
    const strict: InstagramLiveRail = {
      ensureSession: () => rail.ensureSession(),
      openProfile: (h) => rail.openProfile(h),
      close: () => rail.close(),
      sendFirstTouchDm: async () => ({
        kind: 'NOT_ATTEMPTED',
        code: 'IG_SEND_THREAD_IDENTITY_UNCONFIRMED',
        detail: 'le fil ouvert porte « autre »',
        sessionState: 'SESSION_READY',
        screenshotPath: null,
      }),
    };
    const result = await runCanary(strict, manifestId);

    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCode).toBe('IG_SEND_THREAD_IDENTITY_UNCONFIRMED');
    expect(result.externalAttempts).toBe(0);
    await expectNoEffect(result, jobId);

    // IG2.1 §7 — l'autorisation est RENDUE, pas dépensée : zéro octet est parti,
    // et un compteur d'effets externes qui compterait ce renoncement ne
    // compterait plus des effets externes. C'est l'inversion exacte de ce que
    // faisait IG2, et la raison en est le canari du 14 août : quatre
    // autorisations dépensées pour UN effet réel.
    const after = (await loadCanaryForManifest(sql, manifestId))!;
    expect(after.state).toBe('ARMED');
    expect(after.externalAttemptsUsed).toBe(0);
    expect(after.reservedAt).toBeNull();
    expect(after.consumedAt).toBeNull();
  });

  it('deux workers sur le même canari : un seul peut tenter', async () => {
    const { manifestId } = await ready();
    const railA = new FakeLiveRail();
    const railB = new FakeLiveRail();

    const [a, b] = await Promise.all([
      runCanary(railA, manifestId, { workerId: 'worker-a' }),
      runCanary(railB, manifestId, { workerId: 'worker-b' }),
    ]);

    const attempts = [a, b].map((r) => r.externalAttempts);
    expect(attempts.filter((n) => n === 1)).toHaveLength(1);
    expect(railA.sendCalls.length + railB.sendCalls.length).toBe(1);
    expect(await countOutreach()).toBe(1);

    const loser = [a, b].find((r) => r.externalAttempts === 0)!;
    expect(['IG_JOB_NOT_CLAIMABLE', 'IG_CANARY_RESERVATION_LOST', 'IG_CANARY_CONSUMED']).toContain(loser.reasonCode);
  });

  it('le message envoyé est celui du manifeste, jamais une reformulation', async () => {
    const { manifestId } = await ready();
    const rail = new FakeLiveRail();
    await runCanary(rail, manifestId);
    expect(rail.sendCalls[0]!.body).toBe(TEXT);
    expect(rail.sendCalls[0]!.expectedHandle).toBe(HANDLE);
  });
});

// ---------------------------------------------------------------------------
// §8 — la table de vérité de la preuve
// ---------------------------------------------------------------------------

describe('preuve d’envoi', () => {
  it('exige les cinq observations, et refuse dès qu’une manque', () => {
    expect(judgeSendOutcome(GOOD_OBSERVATION, HANDLE).outcome).toBe('SENT');

    const broken: readonly Partial<InstagramSendObservation>[] = [
      { threadHandle: 'unautre' },
      { threadHandle: null },
      { matchingBubblesBefore: 1, matchingBubblesAfter: 1 },
      { matchingBubblesAfter: 0 },
      { composerCleared: false },
      { outgoingBubbleConfirmed: false },
      { sessionState: 'CHALLENGE' },
      // IG2.1 — les trois observations ajoutées après le canari du 14 août.
      { harvestReadableBefore: false },
      { harvestReadableAfter: false },
      { deliveryVerdict: 'AMBIGUOUS' },
    ];
    for (const over of broken) {
      const judgement = judgeSendOutcome({ ...GOOD_OBSERVATION, ...over }, HANDLE);
      expect(judgement.outcome, JSON.stringify(over)).not.toBe('SENT');
      expect(judgement.missing.length).toBeGreaterThan(0);
    }
  });

  it('un texte déjà présent avant le clic ne prouve rien', () => {
    const judgement = judgeSendOutcome(
      { ...GOOD_OBSERVATION, matchingBubblesBefore: 1, matchingBubblesAfter: 2 },
      HANDLE,
    );
    expect(judgement.outcome).toBe('AMBIGUOUS');
    expect(judgement.missing.join(' ')).toContain('déjà présent');
  });

  it('« cliqué » ne devient jamais « envoyé » tout seul', () => {
    // L'observation minimale d'un clic : rien d'autre n'a pu être lu.
    const blind: InstagramSendObservation = {
      threadUrl: null,
      threadHandle: null,
      matchingBubblesBefore: 0,
      matchingBubblesAfter: 0,
      harvestReadableBefore: false,
      harvestReadableAfter: false,
      composerCleared: false,
      outgoingBubbleConfirmed: false,
      deliveryFailureMarkers: Object.freeze([]),
      deliveryVerdict: 'AMBIGUOUS',
      scopeDetail: 'aucun périmètre',
      sessionState: 'UNKNOWN',
      screenshotPath: null,
      durationMs: 1,
      detail: '',
    };
    expect(judgeSendOutcome(blind, HANDLE).outcome).toBe('AMBIGUOUS');
  });
});

// ---------------------------------------------------------------------------
// §2 — la garde réseau du canari
// ---------------------------------------------------------------------------

describe('garde réseau LIVE', () => {
  const guard = (url: string, method = 'GET', postData: string | null = null) =>
    classifyLiveDmRequest({ url, method, postData });

  it('laisse passer un envoi de message direct — c’est sa raison d’être', () => {
    expect(guard('https://www.instagram.com/api/v1/direct_v2/threads/broadcast/text/', 'POST').allowed).toBe(true);
    expect(guard('https://www.instagram.com/direct/t/123/', 'GET').allowed).toBe(true);
  });

  it('refuse toujours follow, like, commentaire, blocage et modification de compte', () => {
    const forbidden: readonly [string, string][] = [
      ['https://www.instagram.com/api/v1/friendships/create/1/', 'POST'],
      ['https://www.instagram.com/api/v1/web/likes/1/like/', 'POST'],
      ['https://www.instagram.com/api/v1/web/comments/1/add/', 'POST'],
      ['https://www.instagram.com/api/v1/web/blocks/1/block/', 'POST'],
      ['https://www.instagram.com/api/v1/accounts/edit/', 'POST'],
      ['https://www.instagram.com/api/v1/users/report/', 'POST'],
      ['https://www.instagram.com/api/v1/web/save/1/save/', 'POST'],
    ];
    for (const [url, method] of forbidden) {
      const decision = guard(url, method);
      expect(decision.allowed, url).toBe(false);
      if (!decision.allowed) expect(decision.rule).toBe('effect_path');
    }
  });

  it('refuse une mutation GraphQL qui n’est pas de la messagerie', () => {
    const follow = guard('https://www.instagram.com/api/graphql', 'POST', 'fb_api_req_friendly_name=FollowMutation');
    expect(follow.allowed).toBe(false);
    const dm = guard('https://www.instagram.com/api/graphql', 'POST', 'fb_api_req_friendly_name=direct_v2SendMutation');
    expect(dm.allowed).toBe(true);
  });

  it('refuse par défaut toute écriture non nommée', () => {
    expect(guard('https://www.instagram.com/api/v1/inconnu/', 'POST').allowed).toBe(false);
    expect(guard('https://autre-site.example/api', 'POST').allowed).toBe(false);
  });

  it('n’accepte de naviguer que vers la racine, un profil et un fil', () => {
    expect(isAllowedLiveNavigation('https://www.instagram.com/')).toBe(true);
    expect(isAllowedLiveNavigation('https://www.instagram.com/demo_prospect_a/')).toBe(true);
    expect(isAllowedLiveNavigation('https://www.instagram.com/direct/t/12345/')).toBe(true);
    expect(isAllowedLiveNavigation('https://www.instagram.com/direct/new/')).toBe(true);
    // Pas la boîte de réception : le canari n'a rien à y faire.
    expect(isAllowedLiveNavigation('https://www.instagram.com/direct/inbox/')).toBe(false);
    expect(isAllowedLiveNavigation('https://www.instagram.com/direct/')).toBe(false);
    expect(isAllowedLiveNavigation('https://www.instagram.com/direct/t/abc/')).toBe(false);
    expect(isAllowedLiveNavigation('http://www.instagram.com/demo_prospect_a/')).toBe(false);
    expect(isAllowedLiveNavigation('https://evil.example/direct/t/1/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §12 — ce que le code ne peut pas faire
// ---------------------------------------------------------------------------

describe('bornes structurelles', () => {
  it('la primitive n’a qu’UN site de clic, et il journalise', () => {
    const source = readFileSync(resolve(ROOT, 'src/lib/instagram/playwrightLiveRail.ts'), 'utf8');
    expect(source.match(/\.click\(/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/private async clickOnce\(/);
    // Et il compte ce qu'il fait : le worker n'a pas à croire le rail sur parole.
    expect(source).toMatch(/this\.clicks \+= 1/);
    // Aucun autre geste capable de produire un effet.
    for (const forbidden of ['.press(', '.tap(', '.dblclick(', '.setInputFiles(', '.selectOption(']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('le journal d’effet précède le clic dans le code, pas seulement dans l’intention', () => {
    const source = readFileSync(resolve(ROOT, 'src/lib/instagram/playwrightLiveRail.ts'), 'utf8');
    const hook = source.indexOf('await input.onBeforeExternalEffect()');
    const send = source.indexOf('this.clickOnce(sendControl');
    const openComposer = source.indexOf('this.clickOnce(messageButton');
    expect(hook).toBeGreaterThan(0);
    expect(send).toBeGreaterThan(hook);
    // Les clics d'ouverture, eux, précèdent le crochet : aucun ne produit d'effet.
    expect(openComposer).toBeGreaterThan(0);
    expect(openComposer).toBeLessThan(hook);
    expect(source.indexOf("'open_contact_menu'")).toBeLessThan(hook);
  });

  it('aucune CLI ne permet d’envoyer toute la file', () => {
    const source = readFileSync(resolve(ROOT, 'src/cli/ig-live.ts'), 'utf8');
    for (const forbidden of ['--all', '--batch', '--prospect', '--send-all', '--max-jobs']) {
      expect(source.includes(`case '${forbidden}'`), forbidden).toBe(false);
    }
    // `--manifest-id` est obligatoire et unique.
    expect(source).toMatch(/--manifest-id est obligatoire/);
    expect(source).toMatch(/ne peut être donné qu’une fois/);
  });

  it('le CLI canari réengage l’arrêt global dans un finally', () => {
    const source = readFileSync(resolve(ROOT, 'src/cli/ig-live.ts'), 'utf8');
    expect(source).toMatch(/} finally \{[\s\S]*reengageKillSwitch/);
    expect(source).toMatch(/revokeStillArmed/);
    expect(source).toMatch(/engaged: true/);
  });

  it('le menu « Contacter » ne peut mener qu’à un message, jamais à un e-mail ou un appel', () => {
    // Trouvé par le premier aperçu réel : un compte PROFESSIONNEL n'affiche pas
    // « Message » mais « Contacter », dont le menu propose aussi l'e-mail et le
    // téléphone. Les sélecteurs sont des égalités de texte (`:text-is`) et non
    // des « contient » — « Envoyer un e-mail » ne peut donc pas être pris pour
    // « Envoyer un message ».
    // IG2.1 — les sélecteurs vivent désormais dans `domSelectors.ts`, partagés
    // avec le rail d'adjudication : le fil qu'on relit doit être celui qu'on a
    // ouvert. La règle vérifiée, elle, ne bouge pas.
    const source = readFileSync(resolve(ROOT, 'src/lib/instagram/domSelectors.ts'), 'utf8');
    const start = source.indexOf('export const CONTACT_MENU_MESSAGE_SELECTORS');
    const menu = source.slice(start, source.indexOf('];', start) + 2);
    expect(menu).not.toMatch(/e-?mail/i);
    expect(menu).not.toMatch(/appeler|call|itinéraire|directions/i);
    expect(menu).not.toContain(':has-text(');
    for (const selector of ['Envoyer un message', 'Send message']) {
      expect(menu).toContain(`:text-is("${selector}")`);
    }
  });

  it('le contrôle d’envoi se désigne par égalité stricte, jamais par « contient »', () => {
    // Le canari réel a montré que l'envoi est un bouton-ICÔNE : `aria-label`
    // « Envoyer », texte vide. Il faut donc viser l'attribut — et le viser en
    // ÉGALITÉ : un `[aria-label*="Envoyer"]` attraperait « Envoyer un e-mail »
    // ou « Envoyer une invitation », c'est-à-dire un autre effet que celui
    // autorisé.
    const source = readFileSync(resolve(ROOT, 'src/lib/instagram/domSelectors.ts'), 'utf8');
    const block = source.slice(source.indexOf('export const SEND_CONTROL_SELECTORS'));
    expect(block).toContain('div[role="button"][aria-label="Envoyer"]');
    expect(block).toContain('div[role="button"][aria-label="Send"]');
    expect(block).not.toContain('aria-label*=');
    expect(block).not.toContain(':has-text(');
    expect(block).not.toMatch(/e-?mail|invitation/i);
  });

  it('le rail LIVE ne contient aucune technique d’évitement', () => {
    // Cherché dans le CODE, pas dans la prose : le commentaire d'en-tête nomme
    // ces techniques pour dire qu'elles sont absentes, et un test qui
    // interdirait le mot interdirait de l'écrire.
    const source = readFileSync(resolve(ROOT, 'src/lib/instagram/playwrightLiveRail.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const forbidden of [
      'Math.random',
      'proxy:',
      'userAgent',
      'setExtraHTTPHeaders',
      'webdriver',
      'stealth',
      'addInitScript',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it('aucun module Instagram ne génère de message', () => {
    const dir = resolve(ROOT, 'src/lib/instagram');
    for (const file of ['liveWorker.ts', 'playwrightLiveRail.ts', 'canary.ts']) {
      const source = readFileSync(resolve(dir, file), 'utf8');
      expect(source, file).not.toMatch(/ModelRouter|callModel|generateText|prompt/i);
    }
  });
});

// ---------------------------------------------------------------------------
// §9 — la finalisation
// ---------------------------------------------------------------------------

describe('finalisation', () => {
  it('l’arrêt global se réengage nominativement et se relit', async () => {
    await setKillSwitch(sql, { engaged: false, setBy: 'Operator Example', reason: 'canari' });
    expect((await loadKillSwitch(sql)).engaged).toBe(false);
    await setKillSwitch(sql, { engaged: true, setBy: 'Operator Example', reason: 'fin du canari IG2' });
    const state = await loadKillSwitch(sql);
    expect(state.engaged).toBe(true);
    expect(state.setBy).toBe('Operator Example');
    expect(state.fromDefault).toBe(false);
  });

  it('le job finit toujours dans un état cohérent, quel que soit le chemin', async () => {
    const paths: readonly [string, FakeLiveOptions, string][] = [
      ['SENT', {}, 'SENT'],
      ['AMBIGUOUS', { throwAfterEffect: new Error('timeout') }, 'REVIEW_REQUIRED'],
      ['FAILED', { throwBeforeEffect: new Error('panne') }, 'FAILED'],
      ['BLOCKED', { observedHandle: 'unautre' }, 'BLOCKED'],
    ];
    for (const [label, options, expected] of paths) {
      await beforeEachCleanup();
      const { manifestId, jobId } = await ready();
      await runCanary(new FakeLiveRail(options), manifestId);
      const job = await loadInstagramJob(sql, jobId);
      expect(job!.status, label).toBe(expected);
      expect(job!.claimToken, label).toBeNull();
      expect(job!.leaseExpiresAt, label).toBeNull();
      // Les deux statuts absorbants portent leur horodatage, les autres non.
      expect(job!.terminatedAt === null, label).toBe(!['SENT', 'REVIEW_REQUIRED'].includes(expected));
    }
  });
});

async function beforeEachCleanup(): Promise<void> {
  // Les deux tables se référencent mutuellement (0031) : le job pointe vers
  // l'autorisation qui l'a couvert, l'autorisation vers le job qui l'a
  // consommée. Rien n'est jamais supprimé en production ; ici il faut d'abord
  // rompre le cycle.
  await sql.query('update ig_live_canary_authorizations set consumed_job_id = null');
  await sql.query('delete from ig_job_events');
  await sql.query('delete from ig_identity_checks');
  // Jobs et autorisations se pointent mutuellement (le job nomme l'autorisation
  // qui a couvert sa tentative, l'autorisation nomme le job qu'elle a réservé) :
  // il faut couper le cycle avant de supprimer, dans un sens ou dans l'autre.
  await sql.query('update ig_live_canary_authorizations set reserved_job_id = null, consumed_job_id = null');
  // IG3 — le journal d'éligibilité pointe les jobs (FK) : il part d'abord.
  await sql.query('delete from ig_enqueue_decisions');
  await sql.query('delete from ig_dispatch_jobs');
  await sql.query('delete from ig_live_canary_authorizations');
  await sql.query('delete from ig_browser_sessions');
  await sql.query('delete from r6b_dispatch_attempts');
  await sql.query('delete from r6b_prospect_state_transitions');
  await sql.query('delete from r6b_prospect_outreach_states');
  await sql.query('delete from outreach_events');
  await sql.query('delete from r6b_dispatch_manifests');
  await sql.query('delete from r6b_batch_votes');
  await sql.query('delete from r6b_batch_items');
  await sql.query('delete from r6b_batches');
  await sql.query('delete from prospect_evidence');
  await sql.query('delete from prospects');
}
