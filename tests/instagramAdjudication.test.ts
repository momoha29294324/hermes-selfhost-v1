import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import { lockManifestForItem } from '@/lib/pipeline/r6bDispatch';
import { resolveDispatchTarget } from '@/lib/pipeline/r6bDispatcher';
import type { DispatchEnvelope } from '@/lib/pipeline/r6bTransportAdapters';
import {
  armCanaryAuthorization,
  consumeCanaryReservation,
  loadCanaryForManifest,
  releaseCanaryReservation,
  reserveCanaryAuthorization,
} from '@/lib/instagram/canary';
import {
  commitCanaryAdjudication,
  CanaryAdjudicationError,
  listCanaryAdjudications,
  loadCanaryAdjudication,
} from '@/lib/instagram/adjudication';
import type { DeliveryAdjudication } from '@/lib/instagram/deliveryProof';
import { enqueueInstagramJob, loadInstagramJob, markExternalEffectAttempted, type InstagramJob } from '@/lib/instagram/queue';
import { setKillSwitch } from '@/lib/instagram/safety';
import type { ThreadObservation } from '@/lib/instagram/threadObservation';
import type { Sql } from '@/lib/db/sql';
import { makeProspectInstagramEligible } from './support/instagramEligibility';

/**
 * IG2.1 §5/§7 — l'adjudication d'un canari déjà tenté, et la sémantique de
 * l'autorisation.
 *
 * Aucun test de ce fichier n'ouvre Instagram ni ne produit d'effet : ils
 * portent tous sur ce qui s'écrit APRÈS, à partir d'une observation fournie à
 * la main. C'est le point de la mission — une adjudication réconcilie un effet
 * déjà observé, elle n'en produit aucun.
 */

const TEXT = 'Bonjour, une question rapide sur vos prises de rendez-vous.';
const HANDLE = 'demo_prospect_a';

let sql: Sql;
let dir: string;
let campaignId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-ig-adjudication-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-ig21-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.query('delete from ig_canary_adjudications');
  await sql.query('delete from ig_job_events');
  await sql.query('delete from ig_identity_checks');
  await sql.query('update ig_live_canary_authorizations set reserved_job_id = null, consumed_job_id = null');
  // IG3 — le journal d'éligibilité pointe les jobs (FK) : il part d'abord.
  await sql.query('delete from ig_enqueue_decisions');
  await sql.query('delete from ig_dispatch_jobs');
  await sql.query('delete from ig_live_canary_authorizations');
  await sql.query('delete from ig_browser_sessions');
  await sql.query('delete from ig_kill_switch');
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

/**
 * R7-PILOT §1 — un handle par prospect, et non un handle pour tous.
 *
 * Cette fixture créait autant de lignes que nécessaire, toutes avec le MÊME
 * compte Instagram. Ce n'était pas gênant tant que rien ne reliait deux lignes
 * entre elles ; depuis que le handle les lie en un même commerce, un scénario
 * qui verrouille deux manifestes décrivait deux envois au même compte. Le
 * compteur rend donc un compte distinct par appel : ces scénarios parlent de
 * plusieurs prospects, pas d'un seul contacté plusieurs fois.
 */
let adjudicationHandleCounter = 0;

async function lockManifest(): Promise<string> {
  adjudicationHandleCounter += 1;
  const handle = `${HANDLE}_${String(adjudicationHandleCounter)}`;
  const prospect = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, instagram_handle)
     values ($1,$2,'DEMO PROSPECT A',$3) returning id`,
    [campaignId, `prospect-${Math.random()}`, handle],
  );
  const prospectId = prospect[0]!.id;
  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,'instagram_handle',$2,'website','crawl',$3,1.0)`,
    [prospectId, handle, `https://${handle}.example-test.fr`],
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
  const manifest = await lockManifestForItem(sql, { itemId: item[0]!.id, transport: 'instagram_dm' });
  return manifest.id;
}

/** Le monde d'après le 14 août : un effet tenté, une issue inconnue. */
async function attempted(): Promise<{ job: InstagramJob; envelope: DispatchEnvelope; canaryId: string }> {
  const manifestId = await lockManifest();
  const { job } = await enqueueInstagramJob(sql, { manifestId, action: 'first_touch_dm', enqueuedBy: 'Test' });
  await setKillSwitch(sql, { engaged: false, setBy: 'Operator Example', reason: 'test' });
  const { envelope } = await resolveDispatchTarget(sql, manifestId, 'LIVE');
  const auth = await armCanaryAuthorization(sql, {
    envelope,
    action: 'first_touch_dm',
    armedBy: 'Operator Example',
    reason: 'test IG2.1',
    ttlMs: 30 * 60_000,
  });
  const reserved = await reserveCanaryAuthorization(sql, {
    authorizationId: auth.id,
    jobId: job.id,
    workerId: 'w1',
    manifestId,
    expectedHandle: envelope.recipient,
    approvedTextSha256: envelope.approvedTextSha256,
    transportPayloadSha256: envelope.transportPayloadSha256,
  });
  expect(reserved).not.toBeNull();
  await consumeCanaryReservation(sql, { authorizationId: auth.id, jobId: job.id, workerId: 'w1' });
  await markExternalEffectAttempted(sql, { jobId: job.id, canaryAuthorizationId: auth.id });
  await sql.query(`update ig_dispatch_jobs set status = 'REVIEW_REQUIRED', terminated_at = now() where id = $1`, [
    job.id,
  ]);
  const reloaded = await loadInstagramJob(sql, job.id);
  return { job: reloaded!, envelope, canaryId: auth.id };
}

function observation(): ThreadObservation {
  return {
    threadUrl: 'https://www.instagram.com/direct/inbox/',
    inbox: null,
    stopReason: null,
    sessionState: 'SESSION_READY',
    handleLinks: [],
    composerRect: null,
    composerText: '',
    ancestorChain: [],
    nodes: [],
    truncated: false,
    screenshotPath: 'var/instagram/screenshots/x.png',
    blockedWriteRequests: 0,
    openClicks: 0,
    durationMs: 1_000,
  };
}

function adjudication(verdict: DeliveryAdjudication['verdict']): DeliveryAdjudication {
  return {
    verdict,
    detail: `verdict de test : ${verdict}`,
    scope: { kind: 'thread', level: 2, rect: null, detail: 'niveau 2', rejected: [] },
    bubbles: [],
    outgoingBubbles: [],
    failureMarkers: [],
    threadHandle: HANDLE,
    proofs: [{ proof: 'inbox_presence', verdict: 'BLOCK', detail: 'absente de la boîte' }],
  };
}

async function countOutreach(): Promise<number> {
  const rows = await sql.query<{ n: string }>(`select count(*) as n from outreach_events`);
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// §5 — ce que chaque verdict écrit, et ce qu'il n'écrit pas
// ---------------------------------------------------------------------------

describe('adjudication d’un canari', () => {
  it('DELIVERY_FAILED : job terminal, journal écrit, AUCUN outreach_event', async () => {
    const { job, envelope } = await attempted();
    const result = await commitCanaryAdjudication(sql, {
      job,
      envelope,
      adjudication: adjudication('DELIVERY_FAILED'),
      observation: observation(),
      adjudicatedBy: 'Operator Example',
      workerId: 'test/pid-1',
    });

    expect(result.jobStatus).toBe('DELIVERY_FAILED');
    expect(result.outreachEventId).toBeNull();
    // La règle qui compte : personne n'a été joint, donc la table qui atteste
    // d'un contact reste vide. Un « pour la trace » y ferait entrer un contact
    // fictif, que le CRM, le gate et les plafonds liraient comme un vrai.
    expect(await countOutreach()).toBe(0);

    const reloaded = await loadInstagramJob(sql, job.id);
    expect(reloaded!.status).toBe('DELIVERY_FAILED');
    expect(reloaded!.terminatedAt).not.toBeNull();
    // Le drapeau d'effet ne bouge pas : la tentative reste celle du 14 août.
    expect(reloaded!.externalEffectAttempted).toBe(true);

    const events = await sql.query<{ status: string; reason_code: string }>(
      `select status, reason_code from ig_job_events where job_id = $1 order by created_at desc limit 1`,
      [job.id],
    );
    expect(events[0]!.status).toBe('DELIVERY_FAILED');
    expect(events[0]!.reason_code).toBe('IG_LIVE_DELIVERY_FAILED');
  });

  it('AMBIGUOUS : rien n’est écrit, le job reste en attente d’un humain', async () => {
    const { job, envelope } = await attempted();
    const result = await commitCanaryAdjudication(sql, {
      job,
      envelope,
      adjudication: adjudication('AMBIGUOUS'),
      observation: observation(),
      adjudicatedBy: 'Operator Example',
      workerId: 'test/pid-1',
    });

    expect(result.adjudicationId).toBeNull();
    expect(await loadCanaryAdjudication(sql, job.id)).toBeNull();
    expect((await loadInstagramJob(sql, job.id))!.status).toBe('REVIEW_REQUIRED');
    expect(await countOutreach()).toBe(0);
  });

  it('SENT : réconcilie l’outreach_event manquant, exactement une fois', async () => {
    const { job, envelope } = await attempted();
    const first = await commitCanaryAdjudication(sql, {
      job,
      envelope,
      adjudication: adjudication('SENT'),
      observation: observation(),
      adjudicatedBy: 'Operator Example',
      workerId: 'test/pid-1',
    });

    expect(first.jobStatus).toBe('SENT');
    expect(first.outreachEventId).not.toBeNull();
    expect(await countOutreach()).toBe(1);

    // Rejouer la même adjudication ne duplique rien — ni la décision, ni le
    // contact. L'unicité vient de la base (index de 0023 et de 0033), pas d'une
    // discipline d'appelant.
    const reloaded = await loadInstagramJob(sql, job.id);
    const second = await commitCanaryAdjudication(sql, {
      job: reloaded!,
      envelope,
      adjudication: adjudication('SENT'),
      observation: observation(),
      adjudicatedBy: 'Operator Example',
      workerId: 'test/pid-2',
    });
    expect(second.adjudicationId).toBe(first.adjudicationId);
    expect(await countOutreach()).toBe(1);
    expect(await listCanaryAdjudications(sql, job.id)).toHaveLength(1);
  });

  it('un second verdict qui contredit le premier est refusé, pas écrasé', async () => {
    const { job, envelope } = await attempted();
    await commitCanaryAdjudication(sql, {
      job,
      envelope,
      adjudication: adjudication('DELIVERY_FAILED'),
      observation: observation(),
      adjudicatedBy: 'Operator Example',
      workerId: 'test/pid-1',
    });

    const reloaded = await loadInstagramJob(sql, job.id);
    await expect(
      commitCanaryAdjudication(sql, {
        job: reloaded!,
        envelope,
        adjudication: adjudication('SENT'),
        observation: observation(),
        adjudicatedBy: 'Quelqu’un d’autre',
        workerId: 'test/pid-2',
      }),
    ).rejects.toBeInstanceOf(CanaryAdjudicationError);
    expect(await countOutreach()).toBe(0);
  });

  it('une adjudication exige un auteur nommé', async () => {
    const { job, envelope } = await attempted();
    await expect(
      commitCanaryAdjudication(sql, {
        job,
        envelope,
        adjudication: adjudication('DELIVERY_FAILED'),
        observation: observation(),
        adjudicatedBy: '   ',
        workerId: 'test/pid-1',
      }),
    ).rejects.toBeInstanceOf(CanaryAdjudicationError);
  });

  it('un job qui n’a jamais rien tenté n’est pas adjugeable', async () => {
    const manifestId = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, { manifestId, action: 'first_touch_dm', enqueuedBy: 'Test' });
    const { envelope } = await resolveDispatchTarget(sql, manifestId, 'LIVE');
    await expect(
      commitCanaryAdjudication(sql, {
        job,
        envelope,
        adjudication: adjudication('DELIVERY_FAILED'),
        observation: observation(),
        adjudicatedBy: 'Operator Example',
        workerId: 'test/pid-1',
      }),
    ).rejects.toBeInstanceOf(CanaryAdjudicationError);
  });
});

// ---------------------------------------------------------------------------
// §7 — réservation, consommation, relâchement
// ---------------------------------------------------------------------------

describe('sémantique de l’autorisation', () => {
  async function armed(): Promise<{ manifestId: string; jobId: string; authId: string; envelope: DispatchEnvelope }> {
    const manifestId = await lockManifest();
    const { job } = await enqueueInstagramJob(sql, { manifestId, action: 'first_touch_dm', enqueuedBy: 'Test' });
    const { envelope } = await resolveDispatchTarget(sql, manifestId, 'LIVE');
    const auth = await armCanaryAuthorization(sql, {
      envelope,
      action: 'first_touch_dm',
      armedBy: 'Operator Example',
      reason: 'test IG2.1',
      ttlMs: 30 * 60_000,
    });
    return { manifestId, jobId: job.id, authId: auth.id, envelope };
  }

  function target(envelope: DispatchEnvelope, manifestId: string) {
    return {
      manifestId,
      expectedHandle: envelope.recipient,
      approvedTextSha256: envelope.approvedTextSha256,
      transportPayloadSha256: envelope.transportPayloadSha256,
    };
  }

  it('réserver ne dépense rien : le compteur de tentatives reste à zéro', async () => {
    const { manifestId, jobId, authId, envelope } = await armed();
    const reserved = await reserveCanaryAuthorization(sql, {
      authorizationId: authId,
      jobId,
      workerId: 'w1',
      ...target(envelope, manifestId),
    });
    expect(reserved!.state).toBe('RESERVED');
    expect(reserved!.externalAttemptsUsed).toBe(0);
    expect(reserved!.reservedBy).toBe('w1');
    expect(reserved!.consumedAt).toBeNull();
  });

  it('un refus strictement pré-effet rend la main, et ne brûle pas l’autorisation', async () => {
    const { manifestId, jobId, authId, envelope } = await armed();
    await reserveCanaryAuthorization(sql, { authorizationId: authId, jobId, workerId: 'w1', ...target(envelope, manifestId) });
    const released = await releaseCanaryReservation(sql, { authorizationId: authId, jobId, workerId: 'w1' });

    expect(released!.state).toBe('ARMED');
    expect(released!.externalAttemptsUsed).toBe(0);
    expect(released!.reservedAt).toBeNull();
    // Et elle est de nouveau réservable : c'est ce que « ne pas brûler » veut
    // dire concrètement.
    const again = await reserveCanaryAuthorization(sql, {
      authorizationId: authId,
      jobId,
      workerId: 'w2',
      ...target(envelope, manifestId),
    });
    expect(again!.state).toBe('RESERVED');
  });

  it('consommer est irréversible : le relâchement ne peut plus rien reprendre', async () => {
    const { manifestId, jobId, authId, envelope } = await armed();
    await reserveCanaryAuthorization(sql, { authorizationId: authId, jobId, workerId: 'w1', ...target(envelope, manifestId) });
    const spent = await consumeCanaryReservation(sql, { authorizationId: authId, jobId, workerId: 'w1' });
    expect(spent!.state).toBe('CONSUMED');
    expect(spent!.externalAttemptsUsed).toBe(1);

    // La garde n'est pas une discipline d'appelant : c'est le `where` de
    // l'instruction. Un relâchement écrit par erreur ne trouve simplement rien.
    expect(await releaseCanaryReservation(sql, { authorizationId: authId, jobId, workerId: 'w1' })).toBeNull();
    expect((await loadCanaryForManifest(sql, manifestId))!.state).toBe('CONSUMED');
  });

  it('deux workers ne peuvent jamais consommer la même autorisation', async () => {
    const { manifestId, jobId, authId, envelope } = await armed();
    const [a, b] = await Promise.all([
      reserveCanaryAuthorization(sql, { authorizationId: authId, jobId, workerId: 'w1', ...target(envelope, manifestId) }),
      reserveCanaryAuthorization(sql, { authorizationId: authId, jobId, workerId: 'w2', ...target(envelope, manifestId) }),
    ]);
    const holder = [a, b].filter((row) => row !== null);
    expect(holder).toHaveLength(1);

    const winner = holder[0]!.reservedBy!;
    const loser = winner === 'w1' ? 'w2' : 'w1';
    // Le perdant ne peut pas consommer, même en connaissant l'identifiant.
    expect(await consumeCanaryReservation(sql, { authorizationId: authId, jobId, workerId: loser })).toBeNull();
    expect(await consumeCanaryReservation(sql, { authorizationId: authId, jobId, workerId: winner })).not.toBeNull();
    // Et une seconde consommation par le gagnant lui-même échoue aussi.
    expect(await consumeCanaryReservation(sql, { authorizationId: authId, jobId, workerId: winner })).toBeNull();
  });

  it('une réservation ne peut être consommée que pour le job qu’elle a réservé', async () => {
    const { manifestId, jobId, authId, envelope } = await armed();
    await reserveCanaryAuthorization(sql, { authorizationId: authId, jobId, workerId: 'w1', ...target(envelope, manifestId) });
    const otherManifest = await lockManifest();
    const { job: other } = await enqueueInstagramJob(sql, {
      manifestId: otherManifest,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    expect(await consumeCanaryReservation(sql, { authorizationId: authId, jobId: other.id, workerId: 'w1' })).toBeNull();
  });

  it('une autorisation expirée ne se consomme pas, même réservée', async () => {
    const { manifestId, jobId, authId, envelope } = await armed();
    await reserveCanaryAuthorization(sql, { authorizationId: authId, jobId, workerId: 'w1', ...target(envelope, manifestId) });
    await sql.query(`update ig_live_canary_authorizations set expires_at = now() - interval '1 minute'`);
    expect(await consumeCanaryReservation(sql, { authorizationId: authId, jobId, workerId: 'w1' })).toBeNull();
  });

  it('une seule autorisation VIVANTE à la fois — réservée comprise', async () => {
    const { manifestId, jobId, authId, envelope } = await armed();
    await reserveCanaryAuthorization(sql, { authorizationId: authId, jobId, workerId: 'w1', ...target(envelope, manifestId) });

    // L'index de 0031 ne couvrait que `ARMED` : sans son élargissement, un
    // second armement serait passé pendant qu'un worker tient le premier.
    const otherManifest = await lockManifest();
    const { envelope: otherEnvelope } = await resolveDispatchTarget(sql, otherManifest, 'LIVE');
    await expect(
      armCanaryAuthorization(sql, {
        envelope: otherEnvelope,
        action: 'first_touch_dm',
        armedBy: 'Operator Example',
        reason: 'second prospect « pour aller plus vite »',
        ttlMs: 30 * 60_000,
      }),
    ).rejects.toThrow();
  });
});
