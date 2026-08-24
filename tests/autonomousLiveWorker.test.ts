import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { loadIcpProfile, loadInstagramRail } from '@/lib/config/load';
import type { InstagramRailConfig } from '@/lib/config/schema';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import { lockManifestForItem } from '@/lib/pipeline/r6bDispatch';
import { assessProspect, recordIcpAssessment } from '@/lib/pipeline/icpAssessment';
import { recordAudienceObservation } from '@/lib/pipeline/audienceObservation';
import {
  claimNextInstagramJob,
  enqueueInstagramJob,
  loadInstagramJob,
  recoverExpiredLeases,
} from '@/lib/instagram/queue';
import {
  armCanaryAuthorization,
  loadCanaryForManifest,
  revokeCanaryAuthorization,
} from '@/lib/instagram/canary';
import { resolveDispatchTarget } from '@/lib/pipeline/r6bDispatcher';
import { loadSafetySnapshot, setKillSwitch } from '@/lib/instagram/safety';
import { AUTONOMOUS_POLICY_VERSION } from '@/lib/instagram/autonomousPolicy';
import { AUTONOMOUS_RAIL_ACTOR, runAutonomousDispatch } from '@/lib/instagram/autonomousDispatch';
import {
  AUTONOMOUS_MAX_IDLE_MS,
  nextCycleDelayMs,
  revokeStillArmedAutonomousAuthorizations,
  runAutonomousLiveRuntime,
  runAutonomousLiveWorker,
  type AutonomousRunResult,
} from '@/lib/instagram/autonomousLiveWorker';
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
import { UNREAD_RELATIONSHIP } from '@/lib/instagram/relationship';
import type { InstagramSessionState } from '@/lib/instagram/types';
import type { Sql } from '@/lib/db/sql';
import {
  acquireInstagramBrowserLease,
  inspectInstagramBrowserLease,
  instagramBrowserLeasePath,
  InstagramBrowserProfileBusyError,
} from '@/lib/instagram/browserProfileLease';
import { makeProspectInstagramEligible } from './support/instagramEligibility';
import { frozenClock, IG_WEEKDAY_IN_WINDOW, IG_WEEKEND } from './support/instagramClock';

/**
 * HERMES-AUTONOMOUS-R3 §7 — le worker LIVE autonome et son exécutable,
 * éprouvés de bout en bout sans qu'un seul DM ne parte.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce fichier prouve, et pourquoi il fallait l'écrire
 * ---------------------------------------------------------------------------
 * R2 a livré le module ; il n'avait jamais été exécuté contre une base. Les
 * scénarios ci-dessous sont ceux que R2 laissait ouverts, et deux d'entre eux
 * ont trouvé quelque chose dès le premier passage :
 *
 *   * la politique rejouée juste avant le clic comptait le job COURANT parmi
 *     les « intentions concurrentes » du commerce, et refusait donc chaque
 *     envoi autonome pour cause de duplication — de lui-même. Le rail entier
 *     était à zéro effet, silencieusement, pour une raison qu'aucun rapport
 *     n'aurait nommée ;
 *   * l'arrêt global n'était relu qu'au DÉBUT du cycle. Un humain qui le
 *     réarmait pendant qu'un navigateur s'ouvrait voyait partir le message
 *     qu'il essayait d'arrêter.
 *
 * ---------------------------------------------------------------------------
 * Aucun Instagram
 * ---------------------------------------------------------------------------
 * Le rail est un double injecté — le worker ne construit jamais son navigateur
 * lui-même. Les deux derniers scénarios lancent le VRAI exécutable dans un
 * sous-processus, contre une base PGlite jetable et l'arrêt global armé : ils
 * mesurent une sortie bornée et un arrêt propre, pas un envoi.
 */

const TEXT = 'Bonjour, une question rapide sur vos prises de rendez-vous.';
const HANDLE = 'atelier_prestation_demo';
const ROOT = resolve(__dirname, '..');

let sql: Sql;
let dir: string;
let campaignId: string;
let config: InstagramRailConfig;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-ig-autonomous-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  config = loadInstagramRail();
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-autonomous-r3-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Jobs et autorisations se pointent mutuellement (0031) : couper le cycle
  // avant de supprimer, comme dans `instagramLiveCanary.test.ts`.
  await sql.query('update ig_live_canary_authorizations set reserved_job_id = null, consumed_job_id = null');
  await sql.query('delete from ig_job_events');
  await sql.query('delete from ig_identity_checks');
  await sql.query('delete from ig_enqueue_decisions');
  await sql.query('delete from ig_dispatch_jobs');
  await sql.query('delete from ig_live_canary_authorizations');
  await sql.query('delete from ig_browser_sessions');
  await sql.query('delete from ig_kill_switch');
  await sql.query('delete from r6b_dispatch_attempts');
  await sql.query('delete from r6b_prospect_state_transitions');
  await sql.query('delete from r6b_prospect_outreach_states');
  await sql.query('delete from outreach_events');
  await sql.query('delete from do_not_contact');
  await sql.query('delete from prospect_icp_assessments');
  await sql.query('delete from prospect_audience_observations');
  await sql.query('delete from r6b_dispatch_manifests');
  await sql.query('delete from r6b_batch_votes');
  await sql.query('delete from r6b_batch_items');
  await sql.query('delete from r6b_batches');
  await sql.query('delete from prospect_evidence');
  await sql.query('delete from prospects');
});

// ---------------------------------------------------------------------------
// Fixtures — le chemin de PRODUCTION, jamais un raccourci
// ---------------------------------------------------------------------------

interface Enqueued {
  readonly manifestId: string;
  readonly jobId: string;
  readonly itemId: string;
  readonly prospectId: string;
  readonly batchSlug: string;
}

/**
 * Un prospect que la politique autonome accepte réellement.
 *
 * Rien n'est contourné : le contenu d'entreprise est lu, l'identité confirmée,
 * le verdict ICP écrit par l'évaluateur déterministe sur CES preuves, l'audience
 * observée et attribuée. Un test qui aurait fabriqué un `AUTO_SEND_ELIGIBLE` à
 * la main n'aurait prouvé que sa propre fabrication.
 */
async function eligibleProspect(handle: string): Promise<{ prospectId: string; batchSlug: string; itemId: string }> {
  const prospect = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, instagram_handle, stage)
     values ($1,$2,'ATELIER DEMO',$3,'message_ready') returning id`,
    [campaignId, `prospect-${String(Math.random())}`, handle],
  );
  const prospectId = prospect[0]!.id;
  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,'instagram_handle',$2,'website','crawl','https://example.com',1.0)`,
    [prospectId, handle],
  );
  await makeProspectInstagramEligible(sql, prospectId);

  // Le verdict ICP, rendu par l'évaluateur déterministe sur les preuves
  // ci-dessus — pas une ligne écrite à la main avec « GOOD_ICP » dedans.
  const assessment = await assessProspect(sql, prospectId, loadIcpProfile('example-icp'));
  expect(assessment?.verdict).toBe('GOOD_ICP');
  await recordIcpAssessment(sql, {
    prospectId,
    assessment: assessment!,
    decidedBy: 'deterministic',
    assessedBy: 'suite de tests HERMES-AUTONOMOUS-R3',
  });

  // Une audience LUE et ATTRIBUÉE, franchement sous la marge de confiance R2
  // (8 000) comme sous le seuil canonique (10 000).
  await recordAudienceObservation(sql, {
    prospectId,
    platform: 'instagram',
    handle,
    followersCount: 1_240,
    attributed: true,
    observedAt: '2026-08-20T09:00:00.000Z',
    source: 'blob JSON embarqué dans le document du profil',
    observationRunId: null,
    importedBy: 'suite de tests HERMES-AUTONOMOUS-R3',
  });

  const batchSlug = `autonomous-${String(Math.random())}`;
  const batch = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
    [batchSlug, campaignId],
  );
  const item = await sql.query<{ id: string }>(
    `insert into r6b_batch_items
       (batch_id, prospect_id, item_index, original_draft, contact_channels, hook_evidence_ids)
     values ($1,$2,1,$3,$4,$5) returning id`,
    [
      batch[0]!.id,
      prospectId,
      TEXT,
      JSON.stringify(['instagram']),
      JSON.stringify(['evidence-hook-test']),
    ],
  );
  return { prospectId, batchSlug, itemId: item[0]!.id };
}

/** Le chemin R2 complet : approbation machine → manifeste verrouillé → job en file. */
async function autonomousReady(handle = HANDLE): Promise<Enqueued> {
  const { prospectId, batchSlug, itemId } = await eligibleProspect(handle);
  const report = await runAutonomousDispatch(sql, {
    batchSlug,
    apply: true,
    enqueuedBy: AUTONOMOUS_RAIL_ACTOR,
  });
  const outcome = report.outcomes[0];
  expect(outcome?.status, `le lot ${batchSlug} : ${outcome?.reason ?? 'aucun résultat'}`).toBe('QUEUED');
  return {
    manifestId: outcome!.manifestId!,
    jobId: outcome!.jobId!,
    itemId,
    prospectId,
    batchSlug,
  };
}

/** Le chemin HUMAIN, inchangé : un vote d'humain, un manifeste, un job. */
async function humanReady(handle: string): Promise<Enqueued> {
  const { prospectId, batchSlug, itemId } = await eligibleProspect(handle);
  await castR6bVote(sql, { itemId, verdict: 'SEND', approvedText: TEXT, note: null });
  const manifest = await lockManifestForItem(sql, { itemId, transport: 'instagram_dm' });
  const { job } = await enqueueInstagramJob(sql, {
    manifestId: manifest.id,
    action: 'first_touch_dm',
    enqueuedBy: 'Operator Example',
  });
  return { manifestId: manifest.id, jobId: job.id, itemId, prospectId, batchSlug };
}

/** L'arrêt global levé, comme un opérateur le ferait — nominativement. */
async function releaseKillSwitch(): Promise<void> {
  await setKillSwitch(sql, {
    engaged: false,
    setBy: 'Operator Example via Hermes autonomous outbound',
    reason: 'suite de tests HERMES-AUTONOMOUS-R3 — transport simulé, aucun Instagram',
  });
}

// ---------------------------------------------------------------------------
// Doubles de rail
// ---------------------------------------------------------------------------

const GOOD_OBSERVATION: InstagramSendObservation = Object.freeze({
  threadUrl: 'https://www.instagram.com/direct/t/999/',
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
  readonly sessionState?: InstagramSessionState;
  readonly profileSessionState?: InstagramSessionState;
  /** Lève APRÈS le crochet d'effet — le timeout post-clic. */
  readonly throwAfterEffect?: Error;
  /** Lève AVANT le crochet — la panne pré-effet. */
  readonly throwBeforeEffect?: Error;
  /** Exécuté à l'entrée de la primitive, avant le crochet : le monde qui bouge. */
  readonly beforeHook?: () => Promise<void>;
}

class FakeLiveRail implements InstagramLiveRail {
  readonly opened: string[] = [];
  readonly sendCalls: InstagramSendInput[] = [];
  /** Le nombre de fois où l'effet externe a réellement été autorisé à démarrer. */
  effectsStarted = 0;
  closed = false;

  constructor(private readonly options: FakeLiveOptions = {}) {}

  async ensureSession(): Promise<InstagramSessionStatus> {
    return {
      state: this.options.sessionState ?? 'SESSION_READY',
      detail: 'double de test',
      profileLabel: 'test',
      headless: true,
    };
  }

  async openProfile(handle: string): Promise<InstagramProfileObservation> {
    this.opened.push(handle);
    return {
      requestedUrl: `https://www.instagram.com/${handle}/`,
      finalUrl: `https://www.instagram.com/${handle}/`,
      redirected: false,
      profileMissing: false,
      sessionState: this.options.profileSessionState ?? 'SESSION_READY',
      relationship: UNREAD_RELATIONSHIP,
      signals: [
        { name: 'canonical_url', handle, raw: `https://www.instagram.com/${handle}/` },
        { name: 'og_url', handle, raw: null },
        { name: 'profile_header', handle, raw: null },
      ],
      screenshotPath: null,
      durationMs: 1,
    };
  }

  async sendFirstTouchDm(input: InstagramSendInput): Promise<InstagramSendResult> {
    this.sendCalls.push(input);
    if (this.options.beforeHook) await this.options.beforeHook();
    if (this.options.throwBeforeEffect) throw this.options.throwBeforeEffect;
    await input.onBeforeExternalEffect();
    this.effectsStarted += 1;
    if (this.options.throwAfterEffect) throw this.options.throwAfterEffect;
    return { kind: 'ATTEMPTED', observation: { ...GOOD_OBSERVATION, threadHandle: input.expectedHandle } };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function run(
  rail: InstagramReadOnlyRail,
  over: { now?: Date; maxEffects?: number; previewOnly?: boolean; workerId?: string } = {},
): Promise<AutonomousRunResult> {
  return runAutonomousLiveWorker(
    {
      sql,
      config,
      workerId: over.workerId ?? 'test-autonomous-worker',
      maxEffects: over.maxEffects ?? 5,
      previewOnly: over.previewOnly ?? false,
      now: frozenClock(over.now ?? IG_WEEKDAY_IN_WINDOW),
    },
    { rail },
  );
}

async function countOutreach(): Promise<number> {
  const rows = await sql.query<{ n: string }>(`select count(*) as n from outreach_events`);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Les `SENT` journalisés POUR CE JOB.
 *
 * Compté par job et non globalement : certains scénarios fabriquent des envois
 * passés sur une ligne donneuse pour atteindre un plafond, et un compteur
 * global confondrait la fixture avec ce qu'on mesure.
 */
async function countSentEventsFor(jobId: string): Promise<number> {
  const rows = await sql.query<{ n: string }>(
    `select count(*) as n from ig_job_events where status = 'SENT' and job_id = $1`,
    [jobId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** L'invariant de tout refus : zéro clic, zéro contact, zéro trace de tentative. */
async function expectNoExternalEffect(rail: FakeLiveRail, jobId: string): Promise<void> {
  expect(rail.effectsStarted).toBe(0);
  expect(await countOutreach()).toBe(0);
  expect(await countSentEventsFor(jobId)).toBe(0);
  const job = await loadInstagramJob(sql, jobId);
  expect(job!.externalEffectAttempted).toBe(false);
  expect(job!.externalEffectStartedAt).toBeNull();
  expect(job!.status).not.toBe('SENT');
}

// ---------------------------------------------------------------------------
// §4 — l'arrêt global
// ---------------------------------------------------------------------------

describe('§4 arrêt global', () => {
  it('armé : le worker rend BLOCKED_KILL_SWITCH et ne produit AUCUN effet', async () => {
    const ready = await autonomousReady();
    // Aucune ligne `ig_kill_switch` : l'arrêt vaut ARMÉ par défaut, fail-closed.
    const rail = new FakeLiveRail();
    const result = await run(rail);

    expect(result.stopCode).toBe('BLOCKED_KILL_SWITCH');
    expect(result.stop).toBe('SAFETY');
    expect(result.effects).toBe(0);
    expect(result.outcomes).toHaveLength(0);
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoExternalEffect(rail, ready.jobId);
  });

  it('le worker ne LÈVE jamais l’arrêt : après le cycle, il est toujours armé', async () => {
    await autonomousReady();
    await run(new FakeLiveRail());
    const rows = await sql.query<{ n: string }>(`select count(*) as n from ig_kill_switch`);
    // Ni ligne écrite, ni ligne modifiée : le worker n'a pas touché à la table.
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('réarmé ENTRE la prise du job et l’effet : aucun clic', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();

    // Le monde bouge pendant que le navigateur s'ouvre : un humain réarme.
    const rail = new FakeLiveRail({
      beforeHook: async () => {
        await setKillSwitch(sql, {
          engaged: true,
          setBy: 'Operator Example',
          reason: 'arrêt d’urgence pendant l’ouverture du navigateur',
        });
      },
    });
    const result = await run(rail);

    // La primitive a été appelée — le rail était déjà en train d'ouvrir le fil —
    // mais le crochet d'effet a levé, donc rien n'est parti.
    expect(rail.sendCalls).toHaveLength(1);
    expect(result.effects).toBe(0);
    expect(result.outcomes[0]!.status).not.toBe('SENT');
    await expectNoExternalEffect(rail, ready.jobId);
  });
});

// ---------------------------------------------------------------------------
// §4 — la fenêtre, les plafonds, la cadence
// ---------------------------------------------------------------------------

describe('§4 ordonnancement', () => {
  it('hors fenêtre : aucun effet, et le motif le dit', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();
    const rail = new FakeLiveRail();
    const result = await run(rail, { now: IG_WEEKEND });

    expect(result.stopCode).toBe('BLOCKED_OUTSIDE_WINDOW');
    expect(result.effects).toBe(0);
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoExternalEffect(rail, ready.jobId);
  });

  it('plafond horaire atteint : aucun effet', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();
    // Trois envois dans l'heure, plafond horaire = 3. Placés à plus d'une heure
    // du plafond journalier ? Non : ils comptent aussi pour les 24 h, mais
    // 3 < 10, donc c'est bien le plafond HORAIRE qui refuse.
    await insertSentEvents(3, "now() - interval '10 minutes'");

    const rail = new FakeLiveRail();
    const result = await run(rail);

    expect(result.stopCode).toBe('BLOCKED_HOURLY_CAP');
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoExternalEffect(rail, ready.jobId);
  });

  it('plafond de 24 h atteint : aucun effet', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();
    // Dix envois hors de la dernière heure : le plafond journalier (10) refuse
    // AVANT le plafond horaire, qui lui est à zéro.
    await insertSentEvents(10, "now() - interval '5 hours'");

    const rail = new FakeLiveRail();
    const result = await run(rail);

    expect(result.stopCode).toBe('BLOCKED_DAILY_CAP');
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoExternalEffect(rail, ready.jobId);
  });

  it('espacement non écoulé : aucun effet', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();
    // Une tentative d'effet externe il y a une minute, sur une AUTRE ligne :
    // l'intervalle minimal est de quinze minutes.
    await markPastExternalEffect("now() - interval '1 minute'");

    const rail = new FakeLiveRail();
    const result = await run(rail);

    expect(result.stopCode).toBe('BLOCKED_COOLDOWN');
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoExternalEffect(rail, ready.jobId);
  });
});

/**
 * Des `SENT` fabriqués : la seule façon d'éprouver un plafond sans envoyer.
 *
 * Ils portent une VRAIE autorisation, sur un manifeste DONNEUR distinct — la
 * base refuse depuis 0031 un effet orphelin, et un test qui contournerait la
 * contrainte n'éprouverait pas le plafond que la production connaît.
 */
async function insertSentEvents(count: number, at: string): Promise<void> {
  const donor = await humanReady(`atelier_donneur_${String(Math.random()).slice(2, 10)}`);
  const { envelope } = await resolveDispatchTarget(sql, donor.manifestId, 'LIVE');
  const auth = await armCanaryAuthorization(sql, {
    envelope,
    action: 'first_touch_dm',
    armedBy: 'Operator Example',
    reason: 'fixture de plafond — aucune primitive appelée',
    ttlMs: 60_000,
  });
  for (let i = 0; i < count; i += 1) {
    await sql.query(
      `insert into ig_job_events
         (job_id, manifest_id, prospect_id, worker_id, mode, status, reason_code,
          idempotency_key, expected_handle, external_effect_attempted,
          canary_authorization_id, created_at)
       values ($1,$2,$3,'test','LIVE','SENT','IG_LIVE_SENT',$4,$5,true,$6,${at})`,
      [
        donor.jobId,
        donor.manifestId,
        donor.prospectId,
        `cap-${String(i)}-${String(Math.random())}`,
        HANDLE,
        auth.id,
      ],
    );
  }
  // Une seule autorisation peut être ARMÉE dans toute la base : celle-ci a
  // rempli son office, elle ne doit pas barrer la route au rail autonome.
  await revokeCanaryAuthorization(sql, {
    id: auth.id,
    revokedBy: 'Operator Example',
    reason: 'fin de fixture',
  });
}

/**
 * Une tentative d'effet externe PASSÉE, sur une autre ligne, telle que la base
 * l'accepte : autorisation nommée, statut terminal, horodatage.
 */
async function markPastExternalEffect(at: string): Promise<string> {
  const donor = await humanReady(`atelier_espacement_${String(Math.random()).slice(2, 10)}`);
  const { envelope } = await resolveDispatchTarget(sql, donor.manifestId, 'LIVE');
  const auth = await armCanaryAuthorization(sql, {
    envelope,
    action: 'first_touch_dm',
    armedBy: 'Operator Example',
    reason: 'fixture de cadence — aucune primitive appelée',
    ttlMs: 60_000,
  });
  await sql.query(
    `update ig_dispatch_jobs
        set external_effect_attempted = true,
            external_effect_started_at = ${at},
            canary_authorization_id = $2,
            status = 'REVIEW_REQUIRED',
            terminated_at = now()
      where id = $1`,
    [donor.jobId, auth.id],
  );
  await revokeCanaryAuthorization(sql, {
    id: auth.id,
    revokedBy: 'Operator Example',
    reason: 'fin de fixture',
  });
  return donor.jobId;
}

// ---------------------------------------------------------------------------
// §6 — la politique, rejouée entre l'enfilement et l'effet
// ---------------------------------------------------------------------------

describe('§6 recheck de politique', () => {
  it('un contact établi APRÈS l’enfilement referme la porte', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();
    await sql.query(
      `insert into outreach_events (prospect_id, kind, channel) values ($1,'sent','instagram_dm')`,
      [ready.prospectId],
    );

    const rail = new FakeLiveRail();
    const result = await run(rail);

    expect(result.outcomes[0]!.status).toBe('POLICY_REFUSED');
    expect(result.outcomes[0]!.reasonCode).toBe('IG_AUTONOMOUS_ALREADY_CONTACTED');
    expect(rail.sendCalls).toHaveLength(0);
    expect(result.effects).toBe(0);

    // Un contact déjà établi est TERMINAL : le job est clos, pas reporté.
    const job = await loadInstagramJob(sql, ready.jobId);
    expect(job!.status).toBe('INELIGIBLE');
    expect(job!.externalEffectAttempted).toBe(false);
  });

  it('une identité redevenue incertaine APRÈS l’enfilement referme la porte', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();
    await sql.query(`update prospects set identity_review = 'manual_review' where id = $1`, [
      ready.prospectId,
    ]);

    const rail = new FakeLiveRail();
    const result = await run(rail);

    expect(result.outcomes[0]!.status).toBe('POLICY_REFUSED');
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoExternalEffect(rail, ready.jobId);
    // `review_required` est TERMINAL du côté du JOB (`skipClassOf`) même si le
    // CANDIDAT reste reconsidérable : ce job-ci est clos, et c'est une nouvelle
    // passe d'enfilement qui rouvrira le prospect si le doute est levé. Le
    // worker ne choisit pas cette classe — `finalizeInstagramJob` la déduit.
    const job = await loadInstagramJob(sql, ready.jobId);
    expect(job!.status).toBe('INELIGIBLE');
    expect(job!.lastSkipReason).toBe('review_required');
  });

  it('une exclusion do_not_contact posée APRÈS l’enfilement referme la porte', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();
    await sql.query(
      `insert into do_not_contact (match_kind, value, reason, added_by)
       values ('instagram',$1,'demande du commerce','Operator Example')`,
      [HANDLE],
    );

    const rail = new FakeLiveRail();
    const result = await run(rail);

    expect(result.outcomes[0]!.reasonCode).toBe('IG_AUTONOMOUS_OPT_OUT');
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoExternalEffect(rail, ready.jobId);
  });

  it('la politique NE compte PAS le job courant comme une intention concurrente', async () => {
    // La régression que R3 a trouvée : sans cette exclusion, le rail entier
    // reste à zéro effet en refusant chaque job pour cause de lui-même.
    const ready = await autonomousReady();
    await releaseKillSwitch();
    const rail = new FakeLiveRail();
    const result = await run(rail);

    expect(result.outcomes[0]!.status).toBe('SENT');
    expect(result.outcomes[0]!.detail).not.toContain('intention est déjà active');
    expect(ready.jobId).toBe(result.outcomes[0]!.jobId);
  });
});

// ---------------------------------------------------------------------------
// §5 — la provenance de l'approbation
// ---------------------------------------------------------------------------

describe('§5 provenance', () => {
  it('un manifeste HUMAIN n’est pas un candidat — il est HORS de la requête', async () => {
    const human = await humanReady('atelier_prestation_humain');
    await releaseKillSwitch();

    const rail = new FakeLiveRail();
    const result = await run(rail);

    expect(result.stopCode).toBe('QUEUE_EMPTY');
    expect(result.outcomes).toHaveLength(0);
    expect(rail.sendCalls).toHaveLength(0);

    // Le job humain est intact : ni pris, ni reporté, ni clos.
    const job = await loadInstagramJob(sql, human.jobId);
    expect(job!.status).toBe('PENDING');
    expect(job!.attempts).toBe(0);
    expect(job!.externalEffectAttempted).toBe(false);
  });

  it('une approbation machine d’une AUTRE politique est refusée, pas exécutée', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();
    // La même provenance machine, une politique antérieure.
    await sql.query(
      `update r6b_batch_votes set policy_version = 'hermes-autonomous-r1'
        where actor_kind = 'AUTONOMOUS_POLICY'`,
    );

    const rail = new FakeLiveRail();
    const result = await run(rail);

    expect(result.outcomes[0]!.status).toBe('NOT_AUTONOMOUS');
    expect(result.outcomes[0]!.reasonCode).toBe('IG_NOT_AUTONOMOUS_APPROVAL');
    expect(result.outcomes[0]!.detail).toContain(AUTONOMOUS_POLICY_VERSION);
    expect(rail.sendCalls).toHaveLength(0);
    await expectNoExternalEffect(rail, ready.jobId);
  });
});

// ---------------------------------------------------------------------------
// Le chemin nominal, et lui seul, atteint la primitive
// ---------------------------------------------------------------------------

describe('le chemin nominal', () => {
  it('atteint la primitive d’envoi et rend SENT sous transport simulé', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();

    const rail = new FakeLiveRail();
    const result = await run(rail);

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]!.status).toBe('SENT');
    expect(result.effects).toBe(1);
    expect(result.sent).toBe(1);
    expect(rail.sendCalls).toHaveLength(1);
    expect(rail.sendCalls[0]!.expectedHandle).toBe(HANDLE);
    expect(rail.sendCalls[0]!.body).toBe(TEXT);
    expect(rail.effectsStarted).toBe(1);

    const job = await loadInstagramJob(sql, ready.jobId);
    expect(job!.status).toBe('SENT');
    expect(job!.externalEffectAttempted).toBe(true);
    expect(await countOutreach()).toBe(1);

    // L'autorisation d'effet a été armée par la POLITIQUE, jamais par un humain.
    const canary = await loadCanaryForManifest(sql, ready.manifestId);
    expect(canary!.armedByKind).toBe('AUTONOMOUS_POLICY');
    expect(canary!.armedBy).toBe(AUTONOMOUS_RAIL_ACTOR);
    expect(canary!.policyVersion).toBe(AUTONOMOUS_POLICY_VERSION);
    expect(canary!.state).toBe('CONSUMED');
  });

  it('l’aperçu parcourt le chemin sans jamais consommer l’autorisation', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();

    // Un aperçu s'arrête avant toute saisie : la primitive rend `PREVIEWED`.
    class PreviewRail extends FakeLiveRail {
      override async sendFirstTouchDm(input: InstagramSendInput): Promise<InstagramSendResult> {
        this.sendCalls.push(input);
        return {
          kind: 'PREVIEWED',
          detail: 'aperçu',
          sessionState: 'SESSION_READY',
          threadUrl: 'https://www.instagram.com/direct/t/999/',
          threadHandle: input.expectedHandle,
          composerReady: true,
          screenshotPath: null,
        };
      }
    }
    const rail = new PreviewRail();
    const result = await run(rail, { previewOnly: true });

    expect(result.outcomes[0]!.status).toBe('PREVIEWED');
    expect(result.effects).toBe(0);
    await expectNoExternalEffect(rail, ready.jobId);
  });
});

// ---------------------------------------------------------------------------
// Pannes, baux, redémarrages, concurrence
// ---------------------------------------------------------------------------

describe('pannes et reprises', () => {
  it('panne AVANT l’effet : rien n’est tenté, et le job reste reprenable', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();

    const rail = new FakeLiveRail({
      throwBeforeEffect: new InstagramRailError('IG_RAIL_ERROR', 'navigateur figé avant le composeur'),
    });
    const result = await run(rail);

    expect(result.outcomes[0]!.status).toBe('FAILED');
    await expectNoExternalEffect(rail, ready.jobId);
    // `FAILED` est réclamable : la file le reprendra à son heure.
    const job = await loadInstagramJob(sql, ready.jobId);
    expect(job!.status).toBe('FAILED');
  });

  it('un bail expiré AVANT tout effet rend le job à la file, et le cycle suivant l’envoie', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();

    // Un processus tué : le job reste CLAIMED, son bail expire.
    const claimed = await claimNextInstagramJob(sql, {
      workerId: 'worker-mort',
      leaseMs: 30_000,
      jobId: ready.jobId,
    });
    expect(claimed).not.toBeNull();
    await sql.query(`update ig_dispatch_jobs set lease_expires_at = now() - interval '1 minute'`);

    const rail = new FakeLiveRail();
    const result = await run(rail);

    expect(result.outcomes[0]!.status).toBe('SENT');
    expect(rail.effectsStarted).toBe(1);
  });

  it('panne APRÈS l’effet : AMBIGUOUS, REVIEW_REQUIRED, et aucun rejeu aveugle', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();

    const rail = new FakeLiveRail({ throwAfterEffect: new Error('timeout après le clic') });
    const result = await run(rail);

    expect(result.outcomes[0]!.status).toBe('AMBIGUOUS');
    expect(result.effects).toBe(1);
    const job = await loadInstagramJob(sql, ready.jobId);
    expect(job!.status).toBe('REVIEW_REQUIRED');
    expect(job!.externalEffectAttempted).toBe(true);
    expect(await countOutreach()).toBe(0);

    // Le cycle suivant ne le reprend pas — il est hors de la requête.
    const second = new FakeLiveRail();
    const again = await run(second);
    expect(again.outcomes).toHaveLength(0);
    expect(second.sendCalls).toHaveLength(0);
  });

  it('un bail expiré APRÈS une tentative devient REVIEW_REQUIRED, jamais PENDING', async () => {
    const ready = await autonomousReady();
    const { envelope } = await resolveDispatchTarget(sql, ready.manifestId, 'LIVE');
    const auth = await armCanaryAuthorization(sql, {
      envelope,
      action: 'first_touch_dm',
      armedBy: AUTONOMOUS_RAIL_ACTOR,
      armedByKind: 'AUTONOMOUS_POLICY',
      policyVersion: AUTONOMOUS_POLICY_VERSION,
      reason: 'fixture de bail — aucune primitive appelée',
      ttlMs: 60_000,
    });
    // Un processus tué APRÈS avoir posé le drapeau : la ligne dit exactement
    // ce que la production laisserait derrière elle.
    await sql.query(
      `update ig_dispatch_jobs
          set status = 'CLAIMED', claimed_by = 'worker-mort', claim_token = gen_random_uuid(),
              claimed_at = now() - interval '10 minutes',
              lease_expires_at = now() - interval '1 minute',
              external_effect_attempted = true, external_effect_started_at = now(),
              canary_authorization_id = $2
        where id = $1`,
      [ready.jobId, auth.id],
    );

    const recovered = await recoverExpiredLeases(sql);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.status).toBe('REVIEW_REQUIRED');

    // Et il ne redevient jamais un candidat : aucun rejeu aveugle.
    await releaseKillSwitch();
    const rail = new FakeLiveRail();
    const result = await run(rail);
    expect(result.outcomes).toHaveLength(0);
    expect(rail.sendCalls).toHaveLength(0);
  });

  it('redémarrage après un envoi : aucun second effet externe', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();

    const first = new FakeLiveRail();
    expect((await run(first)).sent).toBe(1);

    // Un nouveau processus, un nouveau rail, la même file.
    const second = new FakeLiveRail();
    const again = await run(second, { workerId: 'test-autonomous-worker-2' });

    // Le premier verrou est la CADENCE : quinze minutes séparent deux effets,
    // et le redémarrage ne les efface pas.
    expect(again.stopCode).toBe('BLOCKED_COOLDOWN');
    expect(again.outcomes).toHaveLength(0);
    expect(second.sendCalls).toHaveLength(0);
    expect(second.effectsStarted).toBe(0);

    // Le second verrou est le job lui-même. On vieillit la tentative pour que
    // la cadence cesse de refuser, et on redemande : la file est vide, et rien
    // ne repart.
    await sql.query(
      `update ig_dispatch_jobs
          set external_effect_started_at = now() - interval '2 hours'
        where external_effect_attempted = true`,
    );
    const third = new FakeLiveRail();
    const later = await run(third, { workerId: 'test-autonomous-worker-3' });
    expect(later.stopCode).toBe('QUEUE_EMPTY');
    expect(later.queueRemaining).toBe(0);
    expect(third.sendCalls).toHaveLength(0);
    expect(third.effectsStarted).toBe(0);

    expect(await countOutreach()).toBe(1);
    const job = await loadInstagramJob(sql, ready.jobId);
    expect(job!.status).toBe('SENT');
  });

  it('deux workers en course sur le même job : un seul effet externe', async () => {
    await autonomousReady();
    await releaseKillSwitch();

    const a = new FakeLiveRail();
    const b = new FakeLiveRail();
    const [ra, rb] = await Promise.all([
      run(a, { workerId: 'worker-a' }),
      run(b, { workerId: 'worker-b' }),
    ]);

    // L'invariant, pas le chemin : lequel des deux gagne n'a aucune importance.
    expect(a.effectsStarted + b.effectsStarted).toBe(1);
    expect(ra.effects + rb.effects).toBe(1);
    expect(ra.sent + rb.sent).toBe(1);
    expect(await countOutreach()).toBe(1);
    const sent = await sql.query<{ n: string }>(
      `select count(*) as n from ig_dispatch_jobs where status = 'SENT'`,
    );
    expect(Number(sent[0]!.n)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §3 — le runtime durable
// ---------------------------------------------------------------------------

describe('§3 runtime durable', () => {
  it('--once : exactement un cycle, puis sortie', async () => {
    await autonomousReady();
    await releaseKillSwitch();

    const rail = new FakeLiveRail();
    const report = await runAutonomousLiveRuntime(
      { sql, config, workerId: 'runtime-once', maxEffects: 5, previewOnly: false, now: frozenClock(IG_WEEKDAY_IN_WINDOW) },
      { rail },
      { signal: new AbortController().signal, maxCycles: 1 },
    );

    expect(report.cycles).toHaveLength(1);
    expect(report.stoppedBy).toBe('MAX_CYCLES');
    expect(report.sent).toBe(1);
  });

  it('un arrêt demandé pendant l’attente sort sans attendre — et sans couper un cycle', async () => {
    await autonomousReady();
    await releaseKillSwitch();

    const controller = new AbortController();
    const rail = new FakeLiveRail();
    const slept: number[] = [];

    const report = await runAutonomousLiveRuntime(
      { sql, config, workerId: 'runtime-loop', maxEffects: 5, previewOnly: false, now: frozenClock(IG_WEEKDAY_IN_WINDOW) },
      { rail },
      {
        signal: controller.signal,
        maxCycles: null,
        sleep: async (ms) => {
          slept.push(ms);
          // Le SIGTERM arrive pendant l'attente, pas pendant le cycle.
          controller.abort();
        },
      },
    );

    expect(report.stoppedBy).toBe('ABORTED');
    expect(report.cycles).toHaveLength(1);
    // Le cycle en cours est allé jusqu'au bout : un job pris doit écrire son verdict.
    expect(report.cycles[0]!.outcomes[0]!.status).toBe('SENT');
    expect(slept).toHaveLength(1);
  });

  it('referme les autorisations MACHINE encore armées, jamais celles d’un humain', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();
    // Un cycle qui plante après avoir armé, sans consommer.
    const rail = new FakeLiveRail({
      throwBeforeEffect: new InstagramRailError('IG_RAIL_ERROR', 'navigateur figé'),
    });
    await run(rail);
    expect((await loadCanaryForManifest(sql, ready.manifestId))!.state).toBe('ARMED');

    const revoked = await revokeStillArmedAutonomousAuthorizations(sql);
    expect(revoked).toBe(1);
    expect((await loadCanaryForManifest(sql, ready.manifestId))!.state).toBe('REVOKED');
  });

  it('la cadence de sondage est un DÉLAI, jamais une autorisation', () => {
    const base: AutonomousRunResult = {
      workerId: 'x',
      stop: 'QUEUE_EMPTY',
      stopCode: 'QUEUE_EMPTY',
      stopDetail: '',
      outcomes: [],
      effects: 0,
      sent: 0,
      queueRemaining: 0,
      nextEligibleAt: null,
      durationMs: 0,
    };
    const now = Date.parse('2026-08-21T10:00:00.000Z');

    // Rien à attendre de nommé : le plancher.
    expect(nextCycleDelayMs(base, 60_000, now)).toBe(60_000);
    // Une échéance déjà passée ne fait pas tourner en boucle.
    expect(nextCycleDelayMs({ ...base, nextEligibleAt: '2026-08-21T09:00:00.000Z' }, 60_000, now)).toBe(60_000);
    // Une échéance proche est respectée.
    expect(nextCycleDelayMs({ ...base, nextEligibleAt: '2026-08-21T10:05:00.000Z' }, 60_000, now)).toBe(300_000);
    // Une échéance lointaine est bornée : le runtime reste réactif.
    expect(nextCycleDelayMs({ ...base, nextEligibleAt: '2026-08-25T10:00:00.000Z' }, 60_000, now)).toBe(
      AUTONOMOUS_MAX_IDLE_MS,
    );
  });
});

// ---------------------------------------------------------------------------
// §7.15/§7.16 — l'EXÉCUTABLE, lancé pour de vrai
// ---------------------------------------------------------------------------

interface CliRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Lance le VRAI `ig:autonomous:worker`, dans un sous-processus, contre une base
 * PGlite jetable et l'arrêt global ARMÉ.
 *
 * L'arrêt armé est ce qui rend ces deux scénarios sûrs sans les rendre creux :
 * la commande démarre réellement, lit réellement la base, et se fait réellement
 * refuser. Aucun navigateur n'est ouvert — le worker sort sur la garde de
 * sûreté avant d'avoir un job à traiter.
 */
function runCli(args: readonly string[], dataDir: string, onSpawn?: (kill: () => void) => void): Promise<CliRun> {
  return new Promise<CliRun>((resolveRun, rejectRun) => {
    const child = execFile(
      'npx',
      ['tsx', 'src/cli/ig-autonomous-worker.ts', ...args],
      {
        cwd: ROOT,
        timeout: 90_000,
        env: {
          ...process.env,
          OUTBOUND_DB_BACKEND: 'pglite',
          OUTBOUND_DB_DIR: dataDir,
          // Aucune variable d'envoi : la commande n'en lit aucune, et
          // l'absence est ici une assertion autant qu'une précaution.
        },
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: number } | null)?.code ?? child.exitCode;
        const signal = (error as { signal?: NodeJS.Signals } | null)?.signal ?? child.signalCode;
        if (error && typeof code !== 'number' && signal === null) {
          rejectRun(error);
          return;
        }
        resolveRun({
          code: typeof code === 'number' ? code : null,
          signal: signal ?? null,
          stdout,
          stderr,
        });
      },
    );
    if (onSpawn) onSpawn(() => child.kill('SIGTERM'));
  });
}

describe('§7 l’exécutable', () => {
  let cliDir: string;

  beforeAll(async () => {
    // Une base à part : le sous-processus ouvre le datadir, et PGlite le
    // verrouille — il ne peut pas partager celui de cette suite.
    cliDir = mkdtempSync(join(tmpdir(), 'hermes-ig-autonomous-cli-'));
    const cliSql = await createPgliteSql(cliDir);
    await migrate(cliSql);
    // L'arrêt global reste ARMÉ (aucune ligne) : fail-closed par défaut.
    await cliSql.close();
  }, 120_000);

  afterAll(() => {
    rmSync(cliDir, { recursive: true, force: true });
  });

  it('refuse un mode implicite, et toute option d’envoi en masse', async () => {
    const noMode = await runCli([], cliDir);
    expect(noMode.code).toBe(1);
    expect(noMode.stderr).toContain('--once');

    const bogus = await runCli(['--once', '--all'], cliDir);
    expect(bogus.code).toBe(1);
    expect(bogus.stderr).toContain('option inconnue');
  }, 120_000);

  it('--once : sortie BORNÉE, arrêt global rendu, zéro effet', async () => {
    const result = await runCli(['--once'], cliDir);

    // 3 = « l'arrêt global était armé », le code que la CLI réserve à ce cas.
    expect(result.code).toBe(3);
    expect(result.stdout).toContain('BLOCKED_KILL_SWITCH');
    expect(result.stdout).toContain('effets externes              0');
    // Et l'invariant de R3 : la commande n'a pas réarmé ce qu'elle n'a pas levé.
    expect(result.stdout).toContain('NON réengagé');
  }, 120_000);

  it('--loop : un SIGTERM produit un arrêt PROPRE, pas une mort', async () => {
    const result = await runCli(['--loop', '--poll-ms', '1000'], cliDir, (kill) => {
      // Laisser le premier cycle démarrer, puis demander l'arrêt.
      setTimeout(kill, 12_000).unref();
    });

    // Sorti de lui-même, avec un code : ni tué par le signal, ni laissé en vie.
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain('SIGTERM reçu');
    expect(result.stdout).toContain('arrêté par');
    expect(result.stdout).toContain('ABORTED');
    expect(result.stdout).toContain('effets externes');
    expect(result.stdout).not.toContain('SENT');
  }, 120_000);
});


// ---------------------------------------------------------------------------
// Le PROFIL NAVIGATEUR partagé — un seul Chromium à la fois
// ---------------------------------------------------------------------------

/**
 * Un rail qui prend le VRAI bail au moment où il ouvrirait un navigateur.
 *
 * Il n'ouvre rien : il fait exactement ce que `PlaywrightInstagramRail.open()`
 * fait en premier, et laisse remonter la même erreur de rail. C'est ce qui
 * permet d'observer, sans Chromium et sans Instagram, si le worker a demandé
 * le profil — et surtout s'il ne l'a PAS demandé.
 */
class LeasingRail extends FakeLiveRail {
  leaseAttempts = 0;
  private lease: { release: () => void } | null = null;

  constructor(private readonly profileDir: string) {
    super();
  }

  override async ensureSession(): Promise<InstagramSessionStatus> {
    this.leaseAttempts += 1;
    try {
      this.lease = acquireInstagramBrowserLease(this.profileDir);
    } catch (error) {
      if (error instanceof InstagramBrowserProfileBusyError) {
        throw new InstagramRailError('IG_BROWSER_PROFILE_BUSY', error.message, { cause: error });
      }
      throw error;
    }
    return super.ensureSession();
  }

  override async close(): Promise<void> {
    const lease = this.lease;
    this.lease = null;
    lease?.release();
    await super.close();
  }
}

describe('profil navigateur partagé', () => {
  let profileDir: string;

  beforeEach(() => {
    profileDir = join(mkdtempSync(join(tmpdir(), 'ig-autonomous-profile-')), 'profile');
  });

  /**
   * La relève entrante, simulée par ce qu'elle laisse VRAIMENT derrière elle :
   * un fichier de bail nommant un autre processus, vivant.
   *
   * Et non `acquireInstagramBrowserLease()` appelé depuis le test : le bail est
   * réentrant DANS un processus — c'est voulu, le tour entrant le prend avant
   * son rail — donc le prendre ici ne refuserait rien au worker, qui tourne
   * dans ce même processus de test. En production les deux rails sont deux
   * processus ; la fixture doit l'être aussi.
   *
   * Le pid 1 (`launchd`) est le seul pid dont on soit certain qu'il vit.
   */
  function otherRuntimeHoldsProfile(): () => void {
    const file = instagramBrowserLeasePath(profileDir);
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ pid: 1, hostname: hostname(), startedAt: new Date().toISOString(), cmd: 'ig:inbound:run --loop' }),
    );
    return () => rmSync(file, { force: true });
  }

  it('arrêt global ARMÉ : le worker ne demande même pas le profil', async () => {
    // §13 de la mission, et la propriété qui rend le partage supportable : un
    // worker bloqué globalement sort AVANT le navigateur. S'il prenait le bail
    // pour découvrir ensuite qu'il n'a rien à faire, il volerait une minute sur
    // deux à la relève entrante, sans jamais rien envoyer.
    const ready = await autonomousReady();
    const rail = new LeasingRail(profileDir);

    const result = await run(rail);

    expect(result.stopCode).toBe('BLOCKED_KILL_SWITCH');
    expect(rail.leaseAttempts).toBe(0);
    expect(inspectInstagramBrowserLease(profileDir).held).toBe(false);
    await expectNoExternalEffect(rail, ready.jobId);
  });

  it('file vide : le worker ne demande pas le profil non plus', async () => {
    await releaseKillSwitch();
    const rail = new LeasingRail(profileDir);

    const result = await run(rail);

    expect(result.stopCode).toBe('QUEUE_EMPTY');
    expect(rail.leaseAttempts).toBe(0);
    expect(inspectInstagramBrowserLease(profileDir).held).toBe(false);
  });

  it('profil tenu par l’autre rail : BROWSER_PROFILE_BUSY, zéro effet, job intact', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();

    const release = otherRuntimeHoldsProfile();
    const rail = new LeasingRail(profileDir);
    try {
      const result = await run(rail);

      expect(rail.leaseAttempts).toBe(1);
      expect(result.stopCode).toBe('BROWSER_PROFILE_BUSY');
      expect(result.stop).toBe('SAFETY');
      expect(result.effects).toBe(0);
      expect(result.sent).toBe(0);
      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0]!.reasonCode).toBe('IG_BROWSER_PROFILE_BUSY');
      expect(result.outcomes[0]!.externalEffectAttempted).toBe(false);
      await expectNoExternalEffect(rail, ready.jobId);
    } finally {
      release();
    }

    // Le job n'est pas mort : il est BLOQUÉ, donc encore réclamable, et il
    // repartira au tour suivant sans qu'un humain n'ait à le rouvrir.
    const job = await loadInstagramJob(sql, ready.jobId);
    expect(job!.status).toBe('BLOCKED');
    expect(job!.lastReasonCode).toBe('IG_BROWSER_PROFILE_BUSY');
  });

  it('le tour s’arrête au premier refus, il ne brûle pas la file entière', async () => {
    // Sans cet arrêt, chaque job dû recevrait le même refus dans le même tour :
    // autant de lignes de journal que de jobs, toutes pour une seule cause, et
    // un opérateur qui croit lire dix incidents.
    const first = await autonomousReady();
    await autonomousReady('atelier_prestation_second');
    await releaseKillSwitch();

    const release = otherRuntimeHoldsProfile();
    try {
      const result = await run(new LeasingRail(profileDir));
      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0]!.jobId).toBe(first.jobId);
      expect(result.stopCode).toBe('BROWSER_PROFILE_BUSY');
    } finally {
      release();
    }
  });

  it('une contention n’est PAS comptée comme une session Instagram en panne', async () => {
    // `ig_browser_sessions` n'est écrit qu'APRÈS une session jugée. Un profil
    // occupé n'en fabrique aucune — sinon trois contentions d'affilée
    // atteindraient `maxSessionFailures` et fermeraient le rail.
    await autonomousReady();
    await releaseKillSwitch();

    const release = otherRuntimeHoldsProfile();
    try {
      await run(new LeasingRail(profileDir));
    } finally {
      release();
    }

    const sessions = await sql.query<{ n: string }>(`select count(*) as n from ig_browser_sessions`);
    expect(Number(sessions[0]!.n)).toBe(0);

    // Et pas davantage comme un échec de job : la série qui ferme le rail au
    // bout de trois ne compte que les `FAILED`.
    const snapshot = await loadSafetySnapshot(sql, config);
    expect(snapshot.consecutiveFailures).toBe(0);
    expect(snapshot.sessionFailures).toBe(0);
  });

  it('le profil libéré, le tour suivant repasse — sans intervention humaine', async () => {
    const ready = await autonomousReady();
    await releaseKillSwitch();

    const release = otherRuntimeHoldsProfile();
    const rail = new LeasingRail(profileDir);
    const blocked = await run(rail);
    expect(blocked.stopCode).toBe('BROWSER_PROFILE_BUSY');

    release();

    const passed = await run(rail);
    expect(passed.stopCode).not.toBe('BROWSER_PROFILE_BUSY');
    expect(passed.sent).toBe(1);
    expect(await countSentEventsFor(ready.jobId)).toBe(1);
    await rail.close();
  });

  it('le runtime referme le navigateur ENTRE deux tours, donc rend le profil', async () => {
    // Sans cela, le premier tour qui ouvre Chromium dans un `--loop` garderait
    // le profil — et son bail — jusqu'au SIGTERM, et la relève entrante
    // n'aurait plus jamais son tour de la journée.
    await autonomousReady();
    await releaseKillSwitch();

    const rail = new LeasingRail(profileDir);
    const heldDuringSleep: boolean[] = [];
    const controller = new AbortController();

    await runAutonomousLiveRuntime(
      { sql, config, workerId: 'runtime-lease', maxEffects: 5, previewOnly: false, now: frozenClock(IG_WEEKDAY_IN_WINDOW) },
      { rail },
      {
        signal: controller.signal,
        maxCycles: null,
        sleep: async () => {
          heldDuringSleep.push(inspectInstagramBrowserLease(profileDir).held);
          controller.abort();
        },
      },
    );

    // Le rail a bien été ouvert pendant le tour — sinon ce test ne prouverait
    // rien — puis refermé avant l'attente.
    expect(rail.leaseAttempts).toBe(1);
    expect(rail.closed).toBe(true);
    expect(heldDuringSleep).toEqual([false]);
    expect(inspectInstagramBrowserLease(profileDir).held).toBe(false);
  });
});
