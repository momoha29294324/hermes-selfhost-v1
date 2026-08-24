import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { loadInstagramRail } from '@/lib/config/load';
import type { InstagramRailConfig } from '@/lib/config/schema';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import { lockManifestForItem, type DispatchManifest, type Transport } from '@/lib/pipeline/r6bDispatch';
import {
  claimNextInstagramJob,
  enqueueInstagramJob,
  finalizeInstagramJob,
  InstagramEligibilityError,
  loadInstagramJob,
  markExternalEffectAttempted,
  recoverExpiredLeases,
} from '@/lib/instagram/queue';
import { armCanaryAuthorization, type CanaryAuthorization } from '@/lib/instagram/canary';
import { resolveDispatchTarget } from '@/lib/pipeline/r6bDispatcher';
import { evaluateSafety, loadKillSwitch, loadSafetySnapshot, setKillSwitch } from '@/lib/instagram/safety';
import { runInstagramDryRun } from '@/lib/instagram/worker';
import { evaluateSchedule, isInsideWindow, loadScheduleSnapshot } from '@/lib/instagram/scheduler';
import { InstagramRailError, type InstagramProfileObservation, type InstagramReadOnlyRail, type InstagramSessionStatus } from '@/lib/instagram/rail';
import { UNREAD_RELATIONSHIP } from '@/lib/instagram/relationship';
import { skipClassOf, type InstagramIdentitySignal, type InstagramSessionState } from '@/lib/instagram/types';
import type { Sql } from '@/lib/db/sql';
import { recordIcpAssessment } from '@/lib/pipeline/icpAssessment';
import { evaluateIcpEligibility } from '@/lib/pipeline/icpEligibility';
import { loadIcpProfile } from '@/lib/config/load';
import { makeProspectInstagramEligible, makeProspectFranchise } from './support/instagramEligibility';
import {
  frozenClock,
  IG_WEEKDAY_AFTER_HOURS,
  IG_WEEKDAY_IN_WINDOW,
  IG_WEEKEND,
  IG_WINTER_WEEKDAY_IN_WINDOW,
} from './support/instagramClock';

/**
 * IG-R1 §9 — la file, les gardes et le worker, sur une base réelle.
 *
 * Même patron PGlite temporaire que `r6bDispatch.test.ts` : jamais la base de
 * production. Aucun test de ce fichier n'ouvre Instagram — le rail est un
 * double injecté, précisément parce que le worker ne construit jamais son
 * navigateur lui-même.
 *
 * Un invariant est vérifié après chaque scénario : `outreach_events` ne bouge
 * pas d'une ligne. Un DRY-RUN est un artefact d'audit, pas un contact.
 */

const TEXT = 'Bonjour, une question rapide sur vos prises de rendez-vous.';
const HANDLE = 'demo_prospect_a';

let sql: Sql;
let dir: string;
let campaignId: string;
let config: InstagramRailConfig;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-ig-queue-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  config = loadInstagramRail();

  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-commercial-ig-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Cycle de références entre jobs et autorisations (0031) : rompu d'abord.
  await sql.query('update ig_live_canary_authorizations set consumed_job_id = null');
  await sql.query('delete from ig_job_events');
  await sql.query('delete from ig_identity_checks');
  // IG3 — le journal d'éligibilité pointe les jobs (FK) : il part d'abord.
  await sql.query('delete from ig_enqueue_decisions');
  await sql.query('delete from ig_dispatch_jobs');
  await sql.query('delete from ig_live_canary_authorizations');
  await sql.query('delete from ig_browser_sessions');
  await sql.query('delete from ig_kill_switch');
  await sql.query('delete from r6b_dispatch_attempts');
  await sql.query('delete from outreach_events');
  await sql.query('delete from do_not_contact');
  await sql.query('delete from prospect_icp_assessments');
  await sql.query('delete from r6b_dispatch_manifests');
  await sql.query('delete from r6b_batch_votes');
  await sql.query('delete from r6b_batch_items');
  await sql.query('delete from r6b_batches');
  await sql.query('delete from prospect_evidence');
  await sql.query('delete from prospects');
});

// ---------------------------------------------------------------------------
// Fixtures — le manifeste passe par le vrai chemin humain (vote puis lock)
// ---------------------------------------------------------------------------

async function lockManifest(transport: Transport = 'instagram_dm', handle = HANDLE): Promise<DispatchManifest> {
  const isInstagram = transport === 'instagram_dm';
  const prospect = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, email, instagram_handle)
     values ($1,$2,'DEMO PROSPECT A',$3,$4) returning id`,
    [
      campaignId,
      `prospect-${Math.random()}`,
      isInstagram ? null : 'contact@example.org',
      isInstagram ? handle : null,
    ],
  );
  const prospectId = prospect[0]!.id;

  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,$2,$3,'website','crawl','https://example.org',1.0)`,
    [prospectId, isInstagram ? 'instagram_handle' : 'email', isInstagram ? handle : 'contact@example.org'],
  );

  const batch = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
    [`batch-${Math.random()}`, campaignId],
  );
  const item = await sql.query<{ id: string }>(
    `insert into r6b_batch_items (batch_id, prospect_id, item_index, original_draft, contact_channels)
     values ($1,$2,1,'brouillon',$3) returning id`,
    [batch[0]!.id, prospectId, JSON.stringify([isInstagram ? 'instagram' : 'email'])],
  );
  await castR6bVote(sql, { itemId: item[0]!.id, verdict: 'SEND', approvedText: TEXT, note: null });
  // IG3 §2 — le prospect doit franchir les dix portes d'éligibilité comme en
  // production : contenu d'entreprise lu, identité confirmée.
  await makeProspectInstagramEligible(sql, prospectId);
  return lockManifestForItem(sql, { itemId: item[0]!.id, transport });
}

async function releaseKillSwitch(): Promise<void> {
  await setKillSwitch(sql, { engaged: false, setBy: 'Test', reason: 'suite de tests IG-R1' });
}

async function countOutreachEvents(): Promise<number> {
  const rows = await sql.query<{ n: string }>('select count(*) as n from outreach_events');
  return Number(rows[0]?.n ?? 0);
}

/**
 * IG2 — arme un canari pour un manifeste, par le vrai chemin.
 *
 * Nécessaire dès qu'un test veut représenter une tentative d'effet : la base
 * refuse depuis 0031 un `external_effect_attempted = true` sans autorisation
 * rattachée. C'est exactement l'invariant qu'on veut, et l'écrire ici plutôt
 * que de contourner par un `insert` brut garde les tests dans le même monde que
 * la production.
 */
async function armFor(manifestId: string): Promise<CanaryAuthorization> {
  const { envelope } = await resolveDispatchTarget(sql, manifestId, 'LIVE');
  return armCanaryAuthorization(sql, {
    envelope,
    action: 'first_touch_dm',
    armedBy: 'Test',
    reason: 'suite de tests IG2',
    ttlMs: 30 * 60_000,
  });
}

// ---------------------------------------------------------------------------
// Double de rail — aucune méthode d'action, exactement comme le vrai
// ---------------------------------------------------------------------------

interface FakeRailOptions {
  sessionState?: InstagramSessionState;
  profileSessionState?: InstagramSessionState;
  observedHandle?: string | null;
  profileMissing?: boolean;
  redirected?: boolean;
  ensureError?: InstagramRailError;
  openError?: InstagramRailError;
  signals?: readonly InstagramIdentitySignal[];
}

class FakeRail implements InstagramReadOnlyRail {
  readonly opened: string[] = [];
  closed = false;

  constructor(private readonly options: FakeRailOptions = {}) {}

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
    if (this.options.openError) throw this.options.openError;
    const observed = this.options.observedHandle === undefined ? handle : this.options.observedHandle;
    const signals: readonly InstagramIdentitySignal[] =
      this.options.signals ??
      (['canonical_url', 'og_url', 'profile_header'] as const).map((name) => ({
        name,
        handle: observed,
        raw: observed,
      }));
    return {
      requestedUrl: `https://www.instagram.com/${handle}/`,
      finalUrl: `https://www.instagram.com/${observed ?? handle}/`,
      redirected: this.options.redirected ?? false,
      profileMissing: this.options.profileMissing ?? false,
      sessionState: this.options.profileSessionState ?? this.options.sessionState ?? 'SESSION_READY',
      relationship: UNREAD_RELATIONSHIP,
      signals,
      screenshotPath: null,
      durationMs: 12,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * IG4.3 — l'horloge de ce fichier est CHOISIE, jamais celle de la machine.
 *
 * Les scénarios ci-dessous portent sur la file, les baux, les gardes, l'identité
 * et le journal — pas sur le calendrier. Ils doivent donc s'exécuter depuis un
 * instant où le calendrier ne dit rien, c'est-à-dire dans la fenêtre de
 * production telle qu'elle est réellement configurée. Avant IG4.3 ce défaut
 * était implicite (`() => new Date()` dans le worker) et donc faux la moitié du
 * temps : passé 20:00 Europe/Paris, ou un week-end, vingt scénarios qui
 * attendaient `DRY_RUN_COMPLETED` recevaient `SKIPPED` / `outside_window` — un
 * refus parfaitement correct de l'ordonnanceur, sur une question que ces tests
 * ne posaient pas.
 *
 * La fenêtre n'a pas été élargie pour autant : `config` reste la configuration
 * de production (lun–ven 09:00–20:00), et le describe « fenêtre horaire » plus
 * bas éprouve le refus depuis ses propres instants. Ce qui a changé est qu'on
 * NOMME l'instant au lieu de le subir.
 */
const DEFAULT_TEST_CLOCK = frozenClock(IG_WEEKDAY_IN_WINDOW);

async function run(
  rail: InstagramReadOnlyRail,
  over: {
    mode?: 'DRY_RUN' | 'LIVE';
    jobId?: string;
    config?: InstagramRailConfig;
    now?: () => Date;
    maxJobs?: number;
    drain?: boolean;
  } = {},
) {
  return runInstagramDryRun(
    {
      sql,
      config: over.config ?? config,
      workerId: 'test-worker',
      mode: over.mode ?? 'DRY_RUN',
      ...(over.jobId === undefined ? {} : { jobId: over.jobId }),
      now: over.now ?? DEFAULT_TEST_CLOCK,
      ...(over.maxJobs === undefined ? {} : { maxJobs: over.maxJobs }),
      ...(over.drain === undefined ? {} : { drain: over.drain }),
    },
    { rail },
  );
}

// ---------------------------------------------------------------------------
// Enfilement et idempotence
// ---------------------------------------------------------------------------

describe('enfilement', () => {
  it('crée un job depuis un manifeste verrouillé, et un seul', async () => {
    const manifest = await lockManifest();
    const first = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    expect(first.created).toBe(true);
    expect(first.job.status).toBe('PENDING');
    expect(first.job.expectedHandle).toBe(HANDLE);
    expect(first.job.idempotencyKey).toBe(`ig-r1/first_touch_dm/${manifest.id}`);

    const second = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);

    const rows = await sql.query<{ n: string }>('select count(*) as n from ig_dispatch_jobs');
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('refuse un manifeste dont le transport n’est pas Instagram', async () => {
    const manifest = await lockManifest('email');
    // IG3 — le refus passe par l'éligibilité, qui le JOURNALISE. Le
    // destinataire d'un manifeste e-mail n'est pas un handle : la ligne du
    // journal ne peut donc pas le porter dans `expected_handle` (contrainte de
    // forme, 0039) et le laisse à `null` plutôt que d'échouer à écrire le refus.
    await expect(
      enqueueInstagramJob(sql, { manifestId: manifest.id, action: 'first_touch_dm', enqueuedBy: 'Test' }),
    ).rejects.toBeInstanceOf(InstagramEligibilityError);

    const rows = await sql.query<{ verdict: string; reasonCode: string; expectedHandle: string | null }>(
      `select verdict, reason_code as "reasonCode", expected_handle as "expectedHandle"
         from ig_enqueue_decisions where manifest_id = $1`,
      [manifest.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe('INELIGIBLE');
    expect(rows[0]!.reasonCode).toBe('IG_TRANSPORT_NOT_INSTAGRAM');
    expect(rows[0]!.expectedHandle).toBeNull();
    // Rien n'est entré dans la file.
    const jobs = await sql.query<{ n: string }>('select count(*) as n from ig_dispatch_jobs');
    expect(Number(jobs[0]!.n)).toBe(0);
  });

  it('refuse un manifeste SUPERSEDED — la validation R6B est réutilisée telle quelle', async () => {
    const manifest = await lockManifest();
    // Un relock sur le même item rend le premier obsolète.
    await lockManifestForItem(sql, { itemId: manifest.batchItemId, transport: 'instagram_dm' });

    // IG3 — le code de refus reste celui de R6B, mot pour mot : l'éligibilité
    // RELAIE, elle ne réécrit pas. Ce qui change est l'enveloppe, parce qu'un
    // refus est désormais un verdict journalisé plutôt qu'une exception perdue.
    const error = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstagramEligibilityError);
    expect((error as InstagramEligibilityError).code).toBe('MANIFEST_SUPERSEDED');
    // Un manifeste réparable (quelqu'un peut reverrouiller le bon) : le verdict
    // demande une revue, il ne condamne pas le prospect.
    expect((error as InstagramEligibilityError).decision.verdict).toBe('REVIEW_REQUIRED');
  });

  it('refuse un prospect hors ICP — et le refus est écrit, pas seulement levé', async () => {
    // La garde exacte que la mission demande : « demo_prospect_a reste
    // historique et hors ICP. Aucun mécanisme ne doit pouvoir le remettre dans
    // une queue commerciale. » Ici, une franchise fabriquée par le même chemin
    // de preuve que la vraie.
    const manifest = await lockManifest();
    await makeProspectFranchise(sql, manifest.prospectId);
    await recordIcpAssessment(sql, {
      prospectId: manifest.prospectId,
      assessment: evaluateIcpEligibility({
        subject: { displayName: 'DEMO PROSPECT A', instagramHandle: HANDLE },
        evidence: [
          {
            id: 'evidence-franchise-test',
            field: 'website_headings',
            valueText: 'Devenez franchisé et rejoignez notre réseau national',
            provider: 'website',
            sourceUrl: 'https://exemple-reseau.fr',
          },
          {
            id: 'evidence-franchise-test-b',
            field: 'website_text',
            valueText: 'Rejoignez notre réseau national : franchise clés en main',
            provider: 'website',
            sourceUrl: 'https://exemple-reseau.fr/franchise',
          },
        ],
        profile: loadIcpProfile('example-icp'),
      }),
      decidedBy: 'deterministic',
      assessedBy: 'test',
    });

    const error = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstagramEligibilityError);
    expect((error as InstagramEligibilityError).decision.verdict).toBe('INELIGIBLE');
    expect((error as InstagramEligibilityError).decision.reason).toBe('icp_not_target');

    const jobs = await sql.query<{ n: string }>('select count(*) as n from ig_dispatch_jobs');
    expect(Number(jobs[0]!.n)).toBe(0);

    const decisions = await sql.query<{ verdict: string; reasonCode: string }>(
      `select verdict, reason_code as "reasonCode" from ig_enqueue_decisions where manifest_id = $1`,
      [manifest.id],
    );
    expect(decisions[0]!.verdict).toBe('INELIGIBLE');
    expect(decisions[0]!.reasonCode).toBe('IG_ICP_NOT_TARGET');
  });

  it('refuse un prospect jamais évalué — non évalué n’est pas éligible', async () => {
    const manifest = await lockManifest();
    // On efface tous les verdicts : le prospect redevient inconnu du gate ICP.
    await sql.query('delete from prospect_icp_assessments where prospect_id = $1', [manifest.prospectId]);

    const error = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstagramEligibilityError);
    expect((error as InstagramEligibilityError).decision.verdict).toBe('REVIEW_REQUIRED');
    expect((error as InstagramEligibilityError).code).toBe('IG_ICP_NOT_ASSESSED');
  });

  it('refuse un prospect déjà joint sur Instagram', async () => {
    const manifest = await lockManifest();
    await sql.query(
      `insert into outreach_events (prospect_id, kind, channel, payload, manifest_id)
       values ($1,'sent','instagram_dm','{}'::jsonb,$2)`,
      [manifest.prospectId, manifest.id],
    );

    const error = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstagramEligibilityError);
    expect((error as InstagramEligibilityError).decision.reason).toBe('already_contacted');
  });

  it('refuse un HANDLE en opt-out — le trou que le chemin e-mail ne voyait pas', async () => {
    // `loadRecipientSuppression` interroge `match_kind = 'email'` en dur : un
    // handle exclu ne lui apparaissait jamais. La table connaît pourtant
    // `'instagram'` depuis 0001. Ce test verrouille le gate qui manquait.
    const manifest = await lockManifest();
    await sql.query(
      `insert into do_not_contact (match_kind, value, reason, added_by)
       values ('instagram',$1,'a demandé de ne plus être contacté','test')`,
      [manifest.recipient],
    );

    const error = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstagramEligibilityError);
    expect((error as InstagramEligibilityError).decision.verdict).toBe('INELIGIBLE');
    expect((error as InstagramEligibilityError).decision.reason).toBe('opt_out');
    expect((error as InstagramEligibilityError).code).toBe('IG_HANDLE_SUPPRESSED');
    // Un opt-out ne se reporte pas : il n'a pas de date de reprise.
    expect(skipClassOf('opt_out')).toBe('TERMINAL');
  });

  it('l’enfilement écrit un événement ENQUEUED, une seule fois', async () => {
    const manifest = await lockManifest();
    await enqueueInstagramJob(sql, { manifestId: manifest.id, action: 'first_touch_dm', enqueuedBy: 'Test' });
    await enqueueInstagramJob(sql, { manifestId: manifest.id, action: 'first_touch_dm', enqueuedBy: 'Test' });

    const events = await sql.query<{ n: string }>(
      `select count(*) as n from ig_job_events where status = 'ENQUEUED'`,
    );
    // Deux appels, une seule intention : un journal qui compterait deux
    // ENQUEUED annoncerait deux prospects là où il n'y en a qu'un.
    expect(Number(events[0]!.n)).toBe(1);

    const decisions = await sql.query<{ jobCreated: boolean }>(
      `select job_created as "jobCreated" from ig_enqueue_decisions order by created_at asc`,
    );
    expect(decisions.map((row) => row.jobCreated)).toEqual([true, false]);
  });

  it('la base refuse un second job pour la même intention, même par INSERT direct', async () => {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    await expect(
      sql.query(
        `insert into ig_dispatch_jobs
           (manifest_id, prospect_id, action, idempotency_key, expected_handle,
            approved_text_sha256, transport_payload_sha256, status, enqueued_by)
         values ($1,$2,'first_touch_dm','ig-r1/autre-cle',$3,$4,$5,'PENDING','Test')`,
        [job.manifestId, job.prospectId, job.expectedHandle, job.approvedTextSha256, job.transportPayloadSha256],
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Prise atomique et bail
// ---------------------------------------------------------------------------

describe('prise et bail', () => {
  async function enqueued(): Promise<string> {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    return job.id;
  }

  it('une prise attribue un bail neuf et incrémente les tentatives', async () => {
    await enqueued();
    const claimed = await claimNextInstagramJob(sql, { workerId: 'w1', leaseMs: 60_000 });
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('CLAIMED');
    expect(claimed!.claimedBy).toBe('w1');
    expect(claimed!.claimToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(claimed!.attempts).toBe(1);
  });

  it('un job déjà pris n’est pas repris par un second worker', async () => {
    await enqueued();
    const first = await claimNextInstagramJob(sql, { workerId: 'w1', leaseMs: 60_000 });
    const second = await claimNextInstagramJob(sql, { workerId: 'w2', leaseMs: 60_000 });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('deux prises successives donnent deux jetons différents', async () => {
    await enqueued();
    const first = await claimNextInstagramJob(sql, { workerId: 'w1', leaseMs: 60_000 });
    await finalizeInstagramJob(sql, {
      jobId: first!.id,
      claimToken: first!.claimToken!,
      status: 'BLOCKED',
      reasonCode: 'IG_KILL_SWITCH_ENGAGED',
      detail: null,
    });
    const second = await claimNextInstagramJob(sql, { workerId: 'w1', leaseMs: 60_000 });
    expect(second!.claimToken).not.toBe(first!.claimToken);
    expect(second!.attempts).toBe(2);
  });

  it('un jeton périmé n’écrit rien — le worker évincé ne peut pas clore le job d’un autre', async () => {
    await enqueued();
    const first = await claimNextInstagramJob(sql, { workerId: 'w1', leaseMs: 60_000 });
    const staleToken = first!.claimToken!;

    // Le bail expire, un autre worker reprend le job.
    await sql.query(`update ig_dispatch_jobs set lease_expires_at = now() - interval '1 minute'`);
    await recoverExpiredLeases(sql);
    const second = await claimNextInstagramJob(sql, { workerId: 'w2', leaseMs: 60_000 });
    expect(second).not.toBeNull();

    const wrote = await finalizeInstagramJob(sql, {
      jobId: first!.id,
      claimToken: staleToken,
      status: 'DRY_RUN_VALIDATED',
      reasonCode: 'IG_DRY_RUN_OK',
      detail: 'écriture tardive',
    });
    expect(wrote).toBe(false);
    const job = await loadInstagramJob(sql, first!.id);
    expect(job!.status).toBe('CLAIMED');
    expect(job!.claimedBy).toBe('w2');
  });

  it('un job non encore dû n’est pas réclamable — intervalle minimal d’ordonnancement', async () => {
    const id = await enqueued();
    await sql.query(`update ig_dispatch_jobs set not_before = now() + interval '1 hour' where id = $1`, [id]);
    expect(await claimNextInstagramJob(sql, { workerId: 'w1', leaseMs: 60_000 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reprise après redémarrage
// ---------------------------------------------------------------------------

describe('reprise après redémarrage', () => {
  async function claimedJob(): Promise<string> {
    const manifest = await lockManifest();
    await enqueueInstagramJob(sql, { manifestId: manifest.id, action: 'first_touch_dm', enqueuedBy: 'Test' });
    const job = await claimNextInstagramJob(sql, { workerId: 'w-dead', leaseMs: 60_000 });
    return job!.id;
  }

  it('un bail expiré sans effet externe retourne dans la file', async () => {
    const id = await claimedJob();
    await sql.query(`update ig_dispatch_jobs set lease_expires_at = now() - interval '1 minute'`);

    const recovered = await recoverExpiredLeases(sql);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.status).toBe('PENDING');

    const job = await loadInstagramJob(sql, id);
    expect(job!.status).toBe('PENDING');
    expect(job!.claimToken).toBeNull();
    expect(job!.terminatedAt).toBeNull();
    expect(job!.lastReasonCode).toBe('IG_LEASE_EXPIRED');
  });

  it('un bail expiré APRÈS une tentative d’effet devient terminal, jamais un nouvel essai', async () => {
    const id = await claimedJob();
    // IG2 — le drapeau est posé par `markExternalEffectAttempted`, avant le
    // geste, puis le processus meurt. Il n'est plus écrit à la main : la base
    // exige désormais une autorisation canari rattachée, donc le test passe par
    // le vrai chemin.
    const claimed = await loadInstagramJob(sql, id);
    const auth = await armFor(claimed!.manifestId);
    await markExternalEffectAttempted(sql, { jobId: id, canaryAuthorizationId: auth.id });
    await sql.query(`update ig_dispatch_jobs set lease_expires_at = now() - interval '1 minute'`);

    const recovered = await recoverExpiredLeases(sql);
    expect(recovered[0]!.status).toBe('REVIEW_REQUIRED');

    const job = await loadInstagramJob(sql, id);
    expect(job!.status).toBe('REVIEW_REQUIRED');
    expect(job!.terminatedAt).not.toBeNull();
    expect(job!.lastReasonCode).toBe('IG_LEASE_EXPIRED_AFTER_EFFECT');

    // Et il n'est plus jamais repris.
    expect(await claimNextInstagramJob(sql, { workerId: 'w2', leaseMs: 60_000 })).toBeNull();
  });

  it('un job terminal ne peut pas être ré-enfilé comme un job neuf', async () => {
    const manifest = await lockManifest();
    await enqueueInstagramJob(sql, { manifestId: manifest.id, action: 'first_touch_dm', enqueuedBy: 'Test' });
    const claimed = await claimNextInstagramJob(sql, { workerId: 'w1', leaseMs: 60_000 });
    await finalizeInstagramJob(sql, {
      jobId: claimed!.id,
      claimToken: claimed!.claimToken!,
      status: 'REVIEW_REQUIRED',
      reasonCode: 'IG_LEASE_EXPIRED_AFTER_EFFECT',
      detail: null,
    });

    const again = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    expect(again.created).toBe(false);
    expect(again.job.status).toBe('REVIEW_REQUIRED');
    expect(await claimNextInstagramJob(sql, { workerId: 'w1', leaseMs: 60_000 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Contraintes de base
// ---------------------------------------------------------------------------

describe('ce que la base refuse d’enregistrer', () => {
  it('un événement DRY_RUN qui prétendrait avoir produit un effet', async () => {
    await expect(
      sql.query(
        `insert into ig_job_events (worker_id, mode, status, reason_code, idempotency_key, external_effect_attempted)
         values ('w','DRY_RUN','DRY_RUN_OK','IG_DRY_RUN_OK','k',true)`,
      ),
    ).rejects.toThrow();
  });

  it('un événement DRY_RUN au statut SENT', async () => {
    await expect(
      sql.query(
        `insert into ig_job_events (worker_id, mode, status, reason_code, idempotency_key)
         values ('w','DRY_RUN','SENT','IG_DRY_RUN_OK','k')`,
      ),
    ).rejects.toThrow();
  });

  it('un refus BLOCKED qui déclarerait un effet', async () => {
    await expect(
      sql.query(
        `insert into ig_job_events (worker_id, mode, status, reason_code, idempotency_key, external_effect_attempted)
         values ('w','LIVE','BLOCKED','IG_KILL_SWITCH_ENGAGED','k',true)`,
      ),
    ).rejects.toThrow();
  });

  it('un job SENT sans effet externe', async () => {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    await expect(
      sql.query(`update ig_dispatch_jobs set status = 'SENT', terminated_at = now() where id = $1`, [job.id]),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Arrêt global
// ---------------------------------------------------------------------------

describe('arrêt global persistant', () => {
  it('est armé tant qu’aucune ligne n’existe', async () => {
    const state = await loadKillSwitch(sql);
    expect(state.engaged).toBe(true);
    expect(state.fromDefault).toBe(true);
  });

  it('se lève et se rearme nominativement, en une seule ligne', async () => {
    const released = await setKillSwitch(sql, { engaged: false, setBy: 'un opérateur', reason: 'canari' });
    expect(released.engaged).toBe(false);
    expect(released.setBy).toBe('un opérateur');
    expect(released.fromDefault).toBe(false);

    const engaged = await setKillSwitch(sql, { engaged: true, setBy: 'un opérateur', reason: 'fin de mission' });
    expect(engaged.engaged).toBe(true);

    const rows = await sql.query<{ n: string }>('select count(*) as n from ig_kill_switch');
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('refuse une levée anonyme', async () => {
    await expect(setKillSwitch(sql, { engaged: false, setBy: '  ', reason: 'x' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

describe('worker DRY-RUN', () => {
  async function ready(): Promise<{ manifestId: string; jobId: string }> {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    await releaseKillSwitch();
    return { manifestId: manifest.id, jobId: job.id };
  }

  it('va au bout : session, profil exact, identité, message calculé — et n’envoie rien', async () => {
    const { jobId, manifestId } = await ready();
    const rail = new FakeRail();
    const result = await run(rail);

    expect(result.outcomes).toHaveLength(1);
    const outcome = result.outcomes[0]!;
    expect(outcome.status).toBe('DRY_RUN_COMPLETED');
    expect(outcome.reasonCode).toBe('IG_DRY_RUN_OK');
    expect(outcome.observedHandle).toBe(HANDLE);
    expect(rail.opened).toEqual([HANDLE]);
    expect(rail.closed).toBe(true);

    // Le message qui partirait vient de l'adapter, pas d'une reconstruction.
    expect(outcome.preview!.payloadFields['to_handle']).toBe(HANDLE);
    expect(outcome.preview!.payloadFields['body']).toBe(TEXT);
    expect(outcome.preview!.networkAttempted).toBe(false);

    // Toutes les gardes ont été évaluées et journalisées.
    expect(outcome.gates.map((g) => g.gate)).toEqual([
      'mode',
      'no_send_primitive',
      // IG3 — les gardes de CHARGE d'abord (opposables au dry-run), puis celles
      // d'EFFET, projetées, avec la fenêtre d'ordonnancement au milieu.
      'cap_consecutive_failures',
      'cap_session_failures',
      'kill_switch',
      'schedule_window',
      'cap_daily_sent',
      'cap_hourly_sent',
      'cap_min_interval',
      'manifest',
      'transport',
      'job_manifest_drift',
      'session',
      'session_on_profile',
      'identity',
    ]);

    const job = await loadInstagramJob(sql, jobId);
    expect(job!.status).toBe('DRY_RUN_VALIDATED');

    const identity = await sql.query<{ verdict: string; provider: string; method: string; observedUrl: string }>(
      `select verdict, provider, method, observed_url as "observedUrl" from ig_identity_checks where manifest_id = $1`,
      [manifestId],
    );
    expect(identity[0]!.verdict).toBe('MATCH');
    expect(identity[0]!.provider).toBe('instagram_web');
    expect(identity[0]!.method).toBe('browser_profile_page');

    expect(result.externalEffects).toBe(0);
    expect(await countOutreachEvents()).toBe(0);
    const effects = await sql.query<{ n: string }>(
      `select count(*) as n from ig_job_events where external_effect_attempted = true`,
    );
    expect(Number(effects[0]!.n)).toBe(0);
  });

  it('l’arrêt global ARMÉ n’empêche pas le DRY-RUN — il est projeté, pas opposé', async () => {
    // IG3 §7, et c'est un changement volontaire de comportement.
    //
    // Avant : l'arrêt global barrait ce worker, donc le seul chemin qui permet
    // de vérifier le rail sans rien risquer était aussi le seul qu'on ne
    // pouvait jamais emprunter — l'arrêt étant armé par défaut. Une garde
    // d'ENVOI barrait un chemin qui n'envoie pas.
    //
    // Maintenant : l'arrêt est évalué, journalisé comme un refus, et la
    // vérification continue. Ce qui rend cela légitime n'est pas une décision
    // d'assouplissement mais une propriété du chemin — il n'a rien à appeler
    // pour envoyer — et les trois assertions de fin le vérifient plutôt que de
    // le supposer.
    const manifest = await lockManifest();
    await enqueueInstagramJob(sql, { manifestId: manifest.id, action: 'first_touch_dm', enqueuedBy: 'Test' });
    // Pas de levée : l'arrêt par défaut est en place.
    expect((await loadKillSwitch(sql)).engaged).toBe(true);

    const result = await run(new FakeRail());

    expect(result.outcomes[0]!.status).toBe('DRY_RUN_COMPLETED');
    expect(result.outcomes[0]!.preview).not.toBeNull();
    // Et la projection dit franchement ce qu'un LIVE aurait donné.
    expect(result.outcomes[0]!.liveProjection?.wouldProceed).toBe(false);
    expect(result.outcomes[0]!.liveProjection?.blockedBy).toBe('kill_switch');
    // La garde est journalisée comme un refus, pas effacée.
    expect(
      result.outcomes[0]!.gates.some((gate) => gate.gate === 'kill_switch' && gate.verdict === 'BLOCK'),
    ).toBe(true);

    // Les trois invariants qui rendent la projection acceptable.
    expect(result.externalEffects).toBe(0);
    const effects = await sql.query<{ n: string }>(
      `select count(*) as n from ig_dispatch_jobs where external_effect_attempted = true`,
    );
    expect(Number(effects[0]!.n)).toBe(0);
    expect(await countOutreachEvents()).toBe(0);
  });

  it('arrêt global ARMÉ : un LIVE reste refusé, sur le même instantané', async () => {
    // Le pendant du test précédent, et ce qui prouve que la projection n'est
    // pas un relâchement : le MÊME état de base, évalué en posture LIVE, refuse.
    const snapshot = await loadScheduleSnapshot(sql, config);
    expect(snapshot.safety.killSwitch.engaged).toBe(true);

    const live = evaluateSchedule({ now: IG_WEEKDAY_IN_WINDOW, snapshot, config, killSwitch: 'enforce' });
    expect(live.allowed).toBe(false);
    if (!live.allowed) {
      expect(live.reason).toBe('kill_switch');
      // Un arrêt ne se lève pas par l'écoulement du temps.
      expect(live.nextEligibleAt).toBeNull();
    }

    // Et la garde du chemin d'envoi, elle, n'a pas bougé d'une ligne.
    const safety = evaluateSafety(await loadSafetySnapshot(sql, config), config);
    expect(safety.allowed).toBe(false);
    if (!safety.allowed) expect(safety.code).toBe('IG_KILL_SWITCH_ENGAGED');
  });

  it('le mode LIVE est refusé avant toute lecture', async () => {
    await ready();
    const rail = new FakeRail();
    const result = await run(rail, { mode: 'LIVE' });

    expect(result.outcomes[0]!.status).toBe('BLOCKED');
    expect(result.outcomes[0]!.reasonCode).toBe('IG_LIVE_NOT_ON_THIS_PATH');
    expect(result.stoppedEarly).toBe('IG_LIVE_NOT_ON_THIS_PATH');
    expect(rail.opened).toHaveLength(0);

    const sent = await sql.query<{ n: string }>(`select count(*) as n from ig_job_events where status = 'SENT'`);
    expect(Number(sent[0]!.n)).toBe(0);
    expect(await countOutreachEvents()).toBe(0);
  });

  it.each([
    ['LOGIN_REQUIRED', 'IG_SESSION_LOGIN_REQUIRED', false],
    ['SESSION_EXPIRED', 'IG_SESSION_EXPIRED', false],
    ['CHALLENGE', 'IG_SESSION_CHALLENGE', true],
    ['CAPTCHA', 'IG_SESSION_CAPTCHA', true],
    ['BLOCKED', 'IG_SESSION_BLOCKED', true],
    ['UNKNOWN', 'IG_SESSION_UNKNOWN', false],
  ] as const)('session %s → %s (arrêt dur : %s)', async (state, code, hardStop) => {
    await ready();
    const rail = new FakeRail({ sessionState: state });
    const result = await run(rail);

    expect(result.outcomes[0]!.status).toBe('BLOCKED');
    expect(result.outcomes[0]!.reasonCode).toBe(code);
    expect(result.stoppedEarly).toBe(hardStop ? code : null);
    // Aucune session non saine n'ouvre un profil.
    expect(rail.opened).toHaveLength(0);
    expect(await countOutreachEvents()).toBe(0);
  });

  it('une session saine qui se dégrade SUR la page de profil bloque aussi', async () => {
    await ready();
    const rail = new FakeRail({ sessionState: 'SESSION_READY', profileSessionState: 'CHALLENGE' });
    const result = await run(rail);

    expect(result.outcomes[0]!.reasonCode).toBe('IG_SESSION_CHALLENGE');
    expect(result.stoppedEarly).toBe('IG_SESSION_CHALLENGE');
    expect(rail.opened).toEqual([HANDLE]);
  });

  it('un handle différent est refusé et journalisé comme MISMATCH', async () => {
    const { manifestId } = await ready();
    const result = await run(new FakeRail({ observedHandle: 'demo_prospect_a_officiel' }));

    expect(result.outcomes[0]!.status).toBe('BLOCKED');
    expect(result.outcomes[0]!.reasonCode).toBe('IG_IDENTITY_MISMATCH');

    const rows = await sql.query<{ verdict: string; observedHandle: string; expectedHandle: string }>(
      `select verdict, observed_handle as "observedHandle", expected_handle as "expectedHandle"
         from ig_identity_checks where manifest_id = $1`,
      [manifestId],
    );
    expect(rows[0]!.verdict).toBe('MISMATCH');
    expect(rows[0]!.expectedHandle).toBe(HANDLE);
    expect(rows[0]!.observedHandle).toBe('demo_prospect_a_officiel');
    expect(await countOutreachEvents()).toBe(0);
  });

  it('un profil absent est refusé', async () => {
    await ready();
    const result = await run(new FakeRail({ profileMissing: true }));
    expect(result.outcomes[0]!.reasonCode).toBe('IG_IDENTITY_NOT_FOUND');
  });

  it('une identité illisible est refusée — jamais un MATCH par défaut', async () => {
    await ready();
    const result = await run(
      new FakeRail({
        signals: [
          { name: 'canonical_url', handle: null, raw: null },
          { name: 'og_url', handle: null, raw: null },
          { name: 'profile_header', handle: null, raw: null },
        ],
      }),
    );
    expect(result.outcomes[0]!.reasonCode).toBe('IG_IDENTITY_UNAVAILABLE');
  });

  it('un navigateur qui ne démarre pas est un échec technique, et arrête l’exécution', async () => {
    await ready();
    const rail = new FakeRail({
      ensureError: new InstagramRailError('IG_BROWSER_LAUNCH_FAILED', 'chromium introuvable'),
    });
    const result = await run(rail);

    expect(result.outcomes[0]!.status).toBe('FAILED');
    expect(result.outcomes[0]!.reasonCode).toBe('IG_BROWSER_LAUNCH_FAILED');
    expect(result.stoppedEarly).toBe('IG_BROWSER_LAUNCH_FAILED');
  });

  it('une navigation échouée est un échec technique, sans arrêt de toute la file', async () => {
    const { jobId } = await ready();
    const result = await run(new FakeRail({ openError: new InstagramRailError('IG_NAVIGATION_FAILED', 'timeout') }));

    expect(result.outcomes[0]!.status).toBe('FAILED');
    expect(result.outcomes[0]!.reasonCode).toBe('IG_NAVIGATION_FAILED');
    expect(result.stoppedEarly).toBeNull();
    const job = await loadInstagramJob(sql, jobId);
    expect(job!.status).toBe('FAILED');
  });

  it('une dérive du manifeste depuis l’enfilement est refusée', async () => {
    const { manifestId } = await ready();
    // Le handle figé par le job ne correspond plus à celui du manifeste.
    await sql.query(`update ig_dispatch_jobs set expected_handle = 'unautrecompte' where manifest_id = $1`, [
      manifestId,
    ]);
    const rail = new FakeRail();
    const result = await run(rail);

    expect(result.outcomes[0]!.reasonCode).toBe('IG_JOB_MANIFEST_DRIFT');
    expect(rail.opened).toHaveLength(0);
  });

  it('les plafonds d’envoi bloquent réellement le worker', async () => {
    const { manifestId, jobId } = await ready();
    // Fabrique un envoi passé : la seule façon d'éprouver un plafond sans
    // envoyer. Depuis 0031, un événement portant un effet doit nommer
    // l'autorisation qui le couvrait — la base refuse un effet orphelin.
    const auth = await armFor(manifestId);
    for (let i = 0; i < config.caps.hourlySentCap; i += 1) {
      await sql.query(
        `insert into ig_job_events
           (job_id, manifest_id, worker_id, mode, status, reason_code, idempotency_key,
            external_effect_attempted, canary_authorization_id)
         values ($1,$2,'w','LIVE','SENT','IG_LIVE_SENT','k',true,$3)`,
        [jobId, manifestId, auth.id],
      );
    }

    const snapshot = await loadSafetySnapshot(sql, config);
    expect(snapshot.sentLastHour).toBe(config.caps.hourlySentCap);

    const rail = new FakeRail();
    const result = await run(rail);
    // IG3 — un plafond atteint n'est plus un « blocage » mais un REPORT, et il
    // dit quand. Le mot change parce que la durée de vie change : un plafond
    // horaire cesse d'être vrai dans l'heure, un opt-out jamais.
    expect(result.outcomes[0]!.status).toBe('SKIPPED');
    expect(result.outcomes[0]!.reasonCode).toBe('IG_SCHEDULE_DEFERRED');
    expect(['hourly_cap', 'daily_cap', 'cooldown']).toContain(result.outcomes[0]!.skipReason);
    expect(result.outcomes[0]!.skipClass).toBe('TEMPORARY');
    // Un report est REPLANIFIÉ, et le job reste réclamable.
    expect(result.outcomes[0]!.nextAttemptAt).not.toBeNull();
    const replanned = await loadInstagramJob(sql, jobId);
    expect(replanned!.status).toBe('SKIPPED');
    expect(new Date(replanned!.notBefore).getTime()).toBeGreaterThan(Date.now());
    expect(replanned!.skipCount).toBe(1);
    // Le navigateur n'a pas été sollicité : un report se décide avant.
    expect(rail.opened).toHaveLength(0);
  });

  it('le plafond d’échecs consécutifs arrête le rail', async () => {
    const { manifestId, jobId } = await ready();
    for (let i = 0; i < config.caps.maxConsecutiveFailures; i += 1) {
      await sql.query(
        `insert into ig_job_events (job_id, manifest_id, worker_id, mode, status, reason_code, idempotency_key)
         values ($1,$2,'w','DRY_RUN','FAILED','IG_NAVIGATION_FAILED','k')`,
        [jobId, manifestId],
      );
    }
    const result = await run(new FakeRail());
    expect(result.outcomes[0]!.reasonCode).toBe('IG_CAP_CONSECUTIVE_FAILURES');
    // IG3 — un plafond de CHARGE reste opposable au dry-run : il ne mesure pas
    // un droit d'envoyer mais un rail en panne, et un rail en panne le reste
    // qu'on l'observe ou qu'on l'utilise.
    expect(result.outcomes[0]!.status).toBe('BLOCKED');
    expect(result.outcomes[0]!.skipReason).toBe('consecutive_failures');
  });

  it('les événements de cycle de vie ne cassent pas la série d’échecs', async () => {
    // Régression trouvée en écrivant IG3. Le compteur lisait la queue de
    // `ig_job_events` tous statuts confondus ; les nouveaux faits de parcours
    // (`ENQUEUED`, `CLAIMED`, `DRY_RUN_STARTED`) devenaient les événements les
    // plus récents et arrêtaient la série sur eux. Le plafond mesurait donc
    // toujours zéro, et un rail qui échoue en boucle aurait continué
    // indéfiniment — en silence, puisque rien n'échouait « à la suite ».
    const { manifestId, jobId } = await ready();
    for (let i = 0; i < config.caps.maxConsecutiveFailures; i += 1) {
      await sql.query(
        `insert into ig_job_events (job_id, manifest_id, worker_id, mode, status, reason_code, idempotency_key)
         values ($1,$2,'w','DRY_RUN','FAILED','IG_NAVIGATION_FAILED','k')`,
        [jobId, manifestId],
      );
    }
    // Un fait de parcours écrit APRÈS les échecs, exactement comme le worker le
    // fait à chaque prise.
    await sql.query(
      `insert into ig_job_events (job_id, manifest_id, worker_id, mode, status, reason_code, idempotency_key)
       values ($1,$2,'w','DRY_RUN','CLAIMED','IG_DRY_RUN_OK','k')`,
      [jobId, manifestId],
    );

    const snapshot = await loadSafetySnapshot(sql, config);
    expect(snapshot.consecutiveFailures).toBe(config.caps.maxConsecutiveFailures);
  });

  /**
   * Régression trouvée par le PREMIER dry-run AUTHENTIFIÉ (IG-R1 §10).
   *
   * Le plafond comptait toutes les sessions non saines de la fenêtre, sans
   * regarder ce qui était arrivé APRÈS. Trois sessions ratées constatées avant
   * une reconnexion manuelle réussie bloquaient donc encore le rail, alors
   * qu'une session `SESSION_READY` avait été observée depuis — il aurait fallu
   * attendre la fin de la fenêtre (1 h) après chaque reconnexion.
   *
   * Le plafond compte désormais la série qui se termine maintenant.
   */
  it('une session saine remet le compteur d’échecs de session à zéro', async () => {
    await ready();
    const unhealthy = ['LOGIN_REQUIRED', 'LOGIN_REQUIRED', 'CAPTCHA'] as const;
    for (const state of unhealthy) {
      await sql.query(
        `insert into ig_browser_sessions (worker_id, profile_label, headless, state)
         values ('w','test',true,$1)`,
        [state],
      );
    }
    expect((await loadSafetySnapshot(sql, config)).sessionFailures).toBe(3);
    expect(evaluateSafety(await loadSafetySnapshot(sql, config), config).allowed).toBe(false);

    // un opérateur se reconnecte : la session suivante est saine.
    await sql.query(
      `insert into ig_browser_sessions (worker_id, profile_label, headless, state)
       values ('w','test',true,'SESSION_READY')`,
    );
    expect((await loadSafetySnapshot(sql, config)).sessionFailures).toBe(0);
    expect(evaluateSafety(await loadSafetySnapshot(sql, config), config).allowed).toBe(true);

    // Mais une panne qui reprend APRÈS ce succès recompte, et rebloque.
    for (const state of unhealthy) {
      await sql.query(
        `insert into ig_browser_sessions (worker_id, profile_label, headless, state)
         values ('w','test',true,$1)`,
        [state],
      );
    }
    expect((await loadSafetySnapshot(sql, config)).sessionFailures).toBe(3);
    expect(evaluateSafety(await loadSafetySnapshot(sql, config), config).allowed).toBe(false);
  });

  /**
   * Régression trouvée par le PREMIER dry-run AUTHENTIFIÉ (IG-R1 §10).
   *
   * L'intervalle de cadence était appliqué à TOUT refus. Un job bloqué sur
   * l'arrêt global ou un plafond — donc sans qu'une seule requête parte vers
   * Instagram — repoussait quand même sa propre reprise d'un quart d'heure, et
   * chaque nouvelle tentative refusée re-facturait le délai. La garde ne bornait
   * alors aucune charge : elle rendait seulement le rail intestable.
   *
   * Elle s'applique désormais à ce qu'elle nomme : les jobs qui ont touché
   * Instagram.
   */
  /**
   * IG2 §1 — RÉGRESSION. Ce test affirmait l'inverse jusqu'ici, et c'était le
   * bug : « avoir touché Instagram » (au sens : avoir ouvert une page) suffisait
   * à consommer `minSendIntervalMs`.
   *
   * Le nom du réglage promet un intervalle entre deux ENVOIS. Un dry-run qui
   * ouvre un profil, lit un handle et repart n'envoie rien ; lui facturer un
   * quart d'heure ne bornait aucune charge d'envoi, et rendait toute
   * vérification répétée impraticable.
   *
   * Aucun chemin de ce worker ne peut donc plus repousser `not_before` — il n'a
   * aucun effet à facturer. La charge d'une exécution reste bornée ailleurs :
   * un job déjà traité n'est pas repris dans la même exécution.
   */
  it('aucun dry-run ne consomme l’intervalle de cadence — il ne produit aucun effet', async () => {
    const { jobId } = await ready();

    // Un backoff d'ordonnancement DISTINCT de l'intervalle de cadence, sans
    // quoi ce test ne saurait pas dire lequel des deux a repoussé le job : les
    // deux valent 900 000 ms par défaut, et une coïncidence n'est pas une preuve.
    const backoff = 60_000;
    const withBackoff: InstagramRailConfig = {
      ...config,
      schedule: { ...config.schedule, defaultBackoffMs: backoff },
    };
    expect(withBackoff.caps.minSendIntervalMs).not.toBe(backoff);

    // 1. Refus AVANT le navigateur : aucune page ouverte.
    await sql.query(`update ig_dispatch_jobs set expected_handle = 'unautrecompte' where id = $1`, [jobId]);
    const railNotUsed = new FakeRail();
    const blocked = await run(railNotUsed, { config: withBackoff });
    expect(blocked.outcomes[0]!.reasonCode).toBe('IG_JOB_MANIFEST_DRIFT');
    expect(blocked.outcomes[0]!.sessionState).toBeNull();
    expect(railNotUsed.opened).toHaveLength(0);

    // IG3 — le job est REPLANIFIÉ, et c'est le backoff d'ordonnancement qui le
    // repousse, pas la cadence d'envoi. La distinction est tout l'objet du
    // correctif d'IG2.1 : `minSendIntervalMs` borne des EFFETS, et un dry-run
    // n'en produit aucun.
    // Le report se mesure depuis l'horloge de l'ORDONNANCEUR, pas depuis celle
    // de la machine : c'est elle que `nextAttemptAt` a additionnée au backoff.
    // Et elle est gelée, donc le délai est exact plutôt qu'approché — les
    // tolérances de ±10 s qui absorbaient la dérive entre deux lectures de
    // l'horloge murale n'ont plus rien à absorber.
    const afterPreBrowserBlock = await loadInstagramJob(sql, jobId);
    const delay1 = new Date(afterPreBrowserBlock!.notBefore).getTime() - IG_WEEKDAY_IN_WINDOW.getTime();
    expect(delay1).toBe(backoff);
    expect(delay1).toBeLessThan(config.caps.minSendIntervalMs);

    // 2. Refus APRÈS ouverture de la session — une page Instagram a bien été
    // chargée. C'est le cas qui repoussait `not_before` d'un quart d'heure.
    await sql.query(
      `update ig_dispatch_jobs set expected_handle = $1, not_before = now() where id = $2`,
      [HANDLE, jobId],
    );
    const touched = await run(new FakeRail({ observedHandle: 'unautre' }), { config: withBackoff });
    expect(touched.outcomes[0]!.reasonCode).toBe('IG_IDENTITY_MISMATCH');
    expect(touched.outcomes[0]!.sessionState).toBe('SESSION_READY');
    // Une identité qui ne correspond pas est TERMINALE : pas de rejeu du tout.
    expect(touched.outcomes[0]!.skipClass).toBe('TERMINAL');
    expect(touched.outcomes[0]!.nextAttemptAt).toBeNull();
    const afterBrowserBlock = await loadInstagramJob(sql, jobId);
    expect(afterBrowserBlock!.status).toBe('INELIGIBLE');

    // 3. Et un DRY-RUN qui va jusqu'au bout ne repousse rien du tout.
    await sql.query(
      `update ig_dispatch_jobs
          set status = 'PENDING', not_before = now(), terminated_at = null,
              last_skip_reason = null, last_skip_class = null
        where id = $1`,
      [jobId],
    );
    const ok = await run(new FakeRail(), { config: withBackoff });
    expect(ok.outcomes[0]!.status).toBe('DRY_RUN_COMPLETED');
    const afterSuccess = await loadInstagramJob(sql, jobId);
    expect(new Date(afterSuccess!.notBefore).getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

    // 4. Le compteur de cadence, lui, n'a jamais bougé : il compte des effets.
    expect((await loadSafetySnapshot(sql, config)).msSinceLastExternalEffect).toBeNull();

    // 5. Immédiatement reclaimable — c'est le but.
    const reclaimable = await claimNextInstagramJob(sql, { workerId: 'w', leaseMs: 60_000 });
    expect(reclaimable).not.toBeNull();
    await finalizeInstagramJob(sql, {
      jobId: reclaimable!.id,
      claimToken: reclaimable!.claimToken!,
      status: 'BLOCKED',
      reasonCode: 'IG_JOB_MANIFEST_DRIFT',
      detail: null,
    });
  });

  it('une exécution ne reprend jamais deux fois le même job, même sans délai', async () => {
    // Corollaire du correctif : `not_before` ne borne plus rien pour un
    // dry-run, donc c'est l'exécution elle-même qui doit refuser de tourner en
    // boucle sur la même cible.
    await ready();
    const rail = new FakeRail();
    const result = await runInstagramDryRun(
      { sql, config, workerId: 'test-worker', mode: 'DRY_RUN', maxJobs: 5, now: DEFAULT_TEST_CLOCK },
      { rail },
    );
    expect(result.outcomes).toHaveLength(1);
    expect(rail.opened).toHaveLength(1);
  });

  it('journalise tout ce que §8 demande, sans jamais un cookie', async () => {
    const { jobId, manifestId } = await ready();
    await run(new FakeRail());

    const rows = await sql.query<Record<string, unknown>>(
      `select job_id as "jobId", manifest_id as "manifestId", prospect_id as "prospectId",
              session_id as "sessionId", worker_id as "workerId", mode, status, reason_code as "reasonCode",
              idempotency_key as "idempotencyKey", expected_handle as "expectedHandle",
              observed_handle as "observedHandle", session_state as "sessionState", gates::text as gates,
              external_effect_attempted as "effect", duration_ms as "durationMs"
         from ig_job_events order by seq asc`,
    );

    // IG3 §10 — le cycle de vie complet, dans l'ordre. Chacun est un fait daté :
    // un `DRY_RUN_STARTED` sans `DRY_RUN_COMPLETED` est la signature exacte
    // d'un worker mort en cours de route, et c'est la seule trace qui survive à
    // un processus tué.
    expect(rows.map((row) => row['status'])).toEqual([
      'ENQUEUED',
      'CLAIMED',
      'DRY_RUN_STARTED',
      'DRY_RUN_COMPLETED',
    ]);
    // Aucun de ces quatre événements ne déclare d'effet — la base l'impose en
    // plus (`ig_job_event_lifecycle_has_no_effect`, 0039).
    expect(rows.every((row) => row['effect'] === false)).toBe(true);

    const event = rows[3]!;
    expect(event['jobId']).toBe(jobId);
    expect(event['manifestId']).toBe(manifestId);
    expect(event['workerId']).toBe('test-worker');
    expect(event['mode']).toBe('DRY_RUN');
    expect(event['status']).toBe('DRY_RUN_COMPLETED');
    expect(event['reasonCode']).toBe('IG_DRY_RUN_OK');
    expect(event['expectedHandle']).toBe(HANDLE);
    expect(event['observedHandle']).toBe(HANDLE);
    expect(event['sessionState']).toBe('SESSION_READY');
    expect(event['effect']).toBe(false);
    expect(String(event['gates'])).toContain('identity');
    // Les champs libres ne portent aucun nom de cookie de session.
    for (const row of rows) {
      expect(String(row['gates'])).not.toMatch(/ds_user_id|csrftoken|\bsessionid\b/i);
    }
  });

  it('aucune table du rail ne porte de colonne capable de stocker un secret', async () => {
    const columns = await sql.query<{ table: string; column: string }>(
      `select table_name as "table", column_name as "column"
         from information_schema.columns
        where table_name like 'ig\\_%'`,
    );
    expect(columns.length).toBeGreaterThan(0);
    // Deux exceptions nommées, et leur raison :
    //   session_id  — clé étrangère vers ig_browser_sessions, un UUID local ;
    //   claim_token — jeton de BAIL, généré par `gen_random_uuid()` et sans
    //                 valeur hors de cette base ;
    //   canary_authorization_id — clé étrangère vers une décision humaine
    //                 locale (IG2). Aucun des trois n'est un identifiant
    //                 Instagram, et aucun ne sort de cette base.
    const localOnly = new Set(['session_id', 'claim_token', 'canary_authorization_id']);
    for (const { table, column } of columns) {
      if (localOnly.has(column)) continue;
      expect(column, `${table}.${column}`).not.toMatch(/cookie|token|password|secret|credential|auth/i);
    }
  });

  it('rejouer un DRY-RUN reste sûr et ne crée aucun second job', async () => {
    const { jobId } = await ready();
    await run(new FakeRail());
    // Plus aucun délai à lever : un dry-run ne consomme pas l'intervalle (IG2 §1).
    await run(new FakeRail());

    const jobs = await sql.query<{ n: string }>('select count(*) as n from ig_dispatch_jobs');
    expect(Number(jobs[0]!.n)).toBe(1);
    const job = await loadInstagramJob(sql, jobId);
    expect(job!.attempts).toBe(2);
    expect(job!.status).toBe('DRY_RUN_VALIDATED');
    expect(await countOutreachEvents()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// IG4.3 — la fenêtre horaire, éprouvée sur des instants nommés
// ---------------------------------------------------------------------------

/**
 * Ce describe est la contrepartie du défaut d'horloge introduit plus haut.
 *
 * Le reste du fichier fixe un instant DANS la fenêtre pour que le calendrier
 * cesse d'être une variable cachée. Il resterait à démontrer que ce défaut
 * n'anesthésie pas la garde qu'il contourne : ces scénarios font tourner le
 * MÊME worker, sur la MÊME configuration de production, depuis des instants
 * HORS fenêtre, et exigent un refus.
 *
 * C'est la preuve que l'ordonnanceur n'a pas été affaibli — seulement rendu
 * interrogeable. Si quelqu'un élargissait un jour `config/instagram.json` à
 * 24 h / 7 j pour « faire passer les tests », ce sont ces trois scénarios qui
 * tomberaient, pas les autres.
 */
describe('fenêtre horaire — le worker répond à l’instant qu’on lui donne', () => {
  async function ready(): Promise<{ manifestId: string; jobId: string }> {
    const manifest = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    await releaseKillSwitch();
    return { manifestId: manifest.id, jobId: job.id };
  }

  it('un jour ouvré à 10:00 Europe/Paris : le dry-run va au bout', async () => {
    await ready();
    const rail = new FakeRail();
    const result = await run(rail, { now: frozenClock(IG_WEEKDAY_IN_WINDOW) });

    expect(result.outcomes[0]!.status).toBe('DRY_RUN_COMPLETED');
    expect(result.outcomes[0]!.skipReason).toBeNull();
    expect(
      result.outcomes[0]!.gates.some((g) => g.gate === 'schedule_window' && g.verdict === 'PASS'),
    ).toBe(true);
    // La fenêtre étant ouverte, le navigateur a bien été sollicité.
    expect(rail.opened).toEqual([HANDLE]);
    expect(result.externalEffects).toBe(0);
  });

  it('le même jour ouvré à 21:30 Europe/Paris : reporté à la réouverture du lendemain', async () => {
    const { jobId } = await ready();
    const rail = new FakeRail();
    const result = await run(rail, { now: frozenClock(IG_WEEKDAY_AFTER_HOURS) });

    expect(result.outcomes[0]!.status).toBe('SKIPPED');
    expect(result.outcomes[0]!.reasonCode).toBe('IG_SCHEDULE_DEFERRED');
    expect(result.outcomes[0]!.skipReason).toBe('outside_window');
    expect(result.outcomes[0]!.skipClass).toBe('TEMPORARY');
    expect(
      result.outcomes[0]!.gates.some((g) => g.gate === 'schedule_window' && g.verdict === 'BLOCK'),
    ).toBe(true);

    // Un report DIT quand. Mercredi 21:30 → jeudi 16 juillet 09:00 Paris,
    // c'est-à-dire 07:00 UTC en heure d'été. Une date exacte, pas « plus tard ».
    expect(result.outcomes[0]!.nextAttemptAt).toBe('2026-07-16T07:00:00.000Z');
    const job = await loadInstagramJob(sql, jobId);
    expect(job!.status).toBe('SKIPPED');
    expect(job!.lastSkipReason).toBe('outside_window');

    // Et le refus est arrivé AVANT le navigateur : hors fenêtre, on n'ouvre rien.
    expect(rail.opened).toHaveLength(0);
    expect(result.externalEffects).toBe(0);
  });

  it('un samedi midi : hors fenêtre par le JOUR, et la reprise saute au lundi', async () => {
    await ready();
    const rail = new FakeRail();
    const result = await run(rail, { now: frozenClock(IG_WEEKEND) });

    expect(result.outcomes[0]!.skipReason).toBe('outside_window');
    // Samedi 18 juillet → lundi 20 juillet 09:00 Paris (07:00 UTC). Le dimanche
    // est sauté parce que la configuration ne l'ouvre pas, pas parce qu'un
    // « +1 jour » serait tombé juste.
    expect(result.outcomes[0]!.nextAttemptAt).toBe('2026-07-20T07:00:00.000Z');
    expect(rail.opened).toHaveLength(0);
    expect(result.externalEffects).toBe(0);
  });

  it('les deux instants sont bien de part et d’autre de la fenêtre CONFIGURÉE', () => {
    // Ce que les trois scénarios ci-dessus supposent, vérifié contre la vraie
    // `config/instagram.json` plutôt que contre un commentaire. Si la fenêtre de
    // production changeait, c'est ici qu'on l'apprendrait — et non par vingt
    // scénarios sans rapport qui se mettraient à échouer.
    expect(isInsideWindow(IG_WEEKDAY_IN_WINDOW, config.schedule)).toBe(true);
    expect(isInsideWindow(IG_WEEKDAY_AFTER_HOURS, config.schedule)).toBe(false);
    expect(isInsideWindow(IG_WEEKEND, config.schedule)).toBe(false);
    // Heure d'HIVER, même heure murale : la fenêtre est lue en heure locale, et
    // non par un décalage UTC figé qui se tromperait six mois par an.
    expect(isInsideWindow(IG_WINTER_WEEKDAY_IN_WINDOW, config.schedule)).toBe(true);
  });

  it('aucun de ces refus n’a produit d’événement de contact', async () => {
    expect(await countOutreachEvents()).toBe(0);
    const effects = await sql.query<{ n: string }>(
      `select count(*) as n from ig_job_events where external_effect_attempted = true`,
    );
    expect(Number(effects[0]!.n)).toBe(0);
  });
});
