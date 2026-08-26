/**
 * The proof that DB1 actually removed the mono-owner constraint.
 *
 * ---------------------------------------------------------------------------
 * What this test is for
 * ---------------------------------------------------------------------------
 * Migrating to PostgreSQL is worthless if the application keeps behaving as if
 * one process owned the database. PGlite forbade a second opener outright —
 * `tests/pgliteDatadirLock.test.ts` asserts that refusal, and it is still the
 * correct behaviour for that driver. This file asserts the opposite for the
 * Postgres driver, on the scenario the runtime actually has:
 *
 *   the CRM reading   +   a worker writing   =   at the same time, no lock-out
 *
 * Three levels, weakest to strongest:
 *
 *   1. two independent pools coexist and both work;
 *   2. a reader is never blocked by an in-flight writer (MVCC), and sees the
 *      pre-commit snapshot until the writer commits;
 *   3. two writers contending for the same row via `select … for update` — the
 *      exact primitive `@/lib/pipeline/r6bDispatch` uses to reserve a manifest —
 *      serialise correctly, with exactly one winner and no lost update.
 *
 * And finally the same thing across real OS processes, which is what PGlite
 * made impossible and what the Gmail watcher plus the CRM will do every day.
 *
 * ---------------------------------------------------------------------------
 * Where it runs
 * ---------------------------------------------------------------------------
 * Skipped unless `OUTBOUND_TEST_DATABASE_URL` points at a disposable database,
 * so `npm test` stays green on a machine with no Postgres. `scripts/pg17-local.sh
 * init` provisions one and writes the URL to `var/pg17/connection.env`.
 *
 * The test database is never the corpus database: this file truncates what it
 * touches, and the URL it reads is a different variable from the runtime's.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresSql } from '@/lib/db/postgres';
import { migrate } from '@/lib/db/migrate';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import { lockManifestForItem } from '@/lib/pipeline/r6bDispatch';
import {
  claimNextInstagramJob,
  enqueueInstagramJob,
  finalizeInstagramJob,
  InstagramQueueError,
  reserveExternalEffectSlot,
} from '@/lib/instagram/queue';
import { armCanaryAuthorization } from '@/lib/instagram/canary';
import { runInstagramDryRun } from '@/lib/instagram/worker';
import { UNREAD_RELATIONSHIP } from '@/lib/instagram/relationship';
import type {
  InstagramProfileObservation,
  InstagramReadOnlyRail,
  InstagramSessionStatus,
} from '@/lib/instagram/rail';
import { resolveDispatchTarget } from '@/lib/pipeline/r6bDispatcher';
import { loadInstagramRail } from '@/lib/config/load';
import { makeProspectInstagramEligible } from './support/instagramEligibility';
import type { PostgresConfig } from '@/lib/db/config';
import type { Sql } from '@/lib/db/sql';

const execFileAsync = promisify(execFile);

const TEST_URL = process.env.OUTBOUND_TEST_DATABASE_URL;
const describeIfPostgres = TEST_URL ? describe : describe.skip;

function config(applicationName: string): PostgresConfig {
  return {
    backend: 'postgres',
    connectionString: TEST_URL as string,
    poolMax: 5,
    applicationName,
    // The fixture cluster is loopback-only; there is no network to protect and
    // no certificate to verify.
    ssl: 'disable',
    // 0 disables the server-side timeout: one test deliberately holds a row
    // lock while another connection waits on it.
    statementTimeoutMs: 0,
    idleTimeoutMs: 5_000,
    connectionTimeoutMs: 10_000,
  };
}

/** Resolves once `check()` is true, or throws. Avoids fixed sleeps. */
async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/**
 * Le double du rail navigateur : session saine, profil qui porte le handle
 * demandé, et AUCUNE méthode capable d'agir — exactement comme le vrai contrat
 * de lecture (`InstagramReadOnlyRail`). Le worker refuserait de tourner si on
 * lui passait un objet exposant la primitive d'envoi.
 */
class StubRail implements InstagramReadOnlyRail {
  async ensureSession(): Promise<InstagramSessionStatus> {
    return { state: 'SESSION_READY', detail: 'double de test', profileLabel: 'test', headless: true };
  }

  async openProfile(handle: string): Promise<InstagramProfileObservation> {
    return {
      requestedUrl: `https://www.instagram.com/${handle}/`,
      finalUrl: `https://www.instagram.com/${handle}/`,
      redirected: false,
      profileMissing: false,
      sessionState: 'SESSION_READY',
      relationship: UNREAD_RELATIONSHIP,
      signals: (['canonical_url', 'og_url', 'profile_header'] as const).map((name) => ({
        name,
        handle,
        raw: handle,
      })),
      screenshotPath: null,
      durationMs: 5,
    };
  }

  async close(): Promise<void> {}
}

describeIfPostgres('postgres concurrency (DB1)', () => {
  /** Stands in for the CRM / Next.js server. */
  let crm: Sql;
  /** Stands in for the Gmail watcher, discovery, nurture… */
  let worker: Sql;
  let campaignId: string;

  beforeAll(async () => {
    // A single handle applies the schema; the two runtime handles open after.
    const setup = await createPostgresSql(config('hermes-test-setup'));
    await migrate(setup);
    await setup.close();

    crm = await createPostgresSql(config('hermes-crm'));
    worker = await createPostgresSql(config('hermes-worker'));

    await worker.exec('truncate table campaigns cascade');
    const rows = await worker.query<{ id: string }>(
      `insert into campaigns (slug, name, niche_key, config)
       values ('db1-concurrency', 'DB1 concurrency', 'example-services', '{}'::jsonb)
       returning id`,
    );
    campaignId = rows[0]?.id as string;
  }, 120_000);

  afterAll(async () => {
    await worker?.exec('truncate table campaigns cascade').catch(() => undefined);
    await crm?.close();
    await worker?.close();
  });

  it('opens two independent pools against the same database — the thing PGlite refused', async () => {
    const [a, b] = await Promise.all([
      crm.query<{ n: number }>('select count(*)::bigint as n from campaigns'),
      worker.query<{ n: number }>('select count(*)::bigint as n from campaigns'),
    ]);
    expect(a[0]?.n).toBe(1);
    expect(b[0]?.n).toBe(1);

    // Both handles are genuinely distinct sessions on the server.
    const backends = await crm.query<{ application_name: string }>(
      `select distinct application_name from pg_stat_activity
        where application_name in ('hermes-crm', 'hermes-worker')`,
    );
    expect(backends.map((r) => r.application_name).sort()).toEqual(['hermes-crm', 'hermes-worker']);
  });

  it('does not block the CRM read while a worker holds an open write transaction', async () => {
    const prospect = await worker.query<{ id: string }>(
      `insert into prospects (campaign_id, canonical_key, display_name, niche_verdict, score)
       values ($1, 'db1-mvcc', 'Before', 'in_niche', 10) returning id`,
      [campaignId],
    );
    const prospectId = prospect[0]?.id as string;

    let writeStarted = false;
    let releaseWriter: () => void = () => undefined;
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });

    const writing = worker.transaction(async (tx) => {
      await tx.query('update prospects set display_name = $2 where id = $1', [prospectId, 'After']);
      writeStarted = true;
      // Hold the transaction open until the reader has had its turn.
      await writerGate;
      return 'committed';
    });

    await until(() => writeStarted, 'worker to issue its UPDATE');

    // The read must complete now — not after the writer commits. If the runtime
    // had kept a mono-writer serialisation, this would deadlock instead.
    const duringWrite = await crm.query<{ display_name: string }>(
      'select display_name from prospects where id = $1',
      [prospectId],
    );
    expect(duringWrite[0]?.display_name).toBe('Before');

    releaseWriter();
    await expect(writing).resolves.toBe('committed');

    const afterCommit = await crm.query<{ display_name: string }>(
      'select display_name from prospects where id = $1',
      [prospectId],
    );
    expect(afterCommit[0]?.display_name).toBe('After');
  });

  it('serialises two writers on `select … for update`, the dispatch reservation primitive', async () => {
    const prospect = await worker.query<{ id: string }>(
      `insert into prospects (campaign_id, canonical_key, display_name, niche_verdict, score)
       values ($1, 'db1-forupdate', 'Contended', 'in_niche', 0) returning id`,
      [campaignId],
    );
    const prospectId = prospect[0]?.id as string;

    const order: string[] = [];
    let firstHolds = false;
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = worker.transaction(async (tx) => {
      await tx.query('select id from prospects where id = $1 for update', [prospectId]);
      firstHolds = true;
      order.push('first:locked');
      await firstGate;
      await tx.query('update prospects set score = score + 1 where id = $1', [prospectId]);
      order.push('first:committed');
    });

    await until(() => firstHolds, 'first writer to take the row lock');

    const second = crm.transaction(async (tx) => {
      // Blocks until `first` commits — that is the point.
      await tx.query('select id from prospects where id = $1 for update', [prospectId]);
      order.push('second:locked');
      await tx.query('update prospects set score = score + 1 where id = $1', [prospectId]);
      order.push('second:committed');
    });

    // Give the second writer a chance to prove it is genuinely waiting.
    await until(
      async () => {
        const waiting = await worker.query<{ n: number }>(
          `select count(*)::bigint as n from pg_stat_activity
            where wait_event_type = 'Lock' and application_name = 'hermes-crm'`,
        );
        return Number(waiting[0]?.n ?? 0) > 0;
      },
      'second writer to be waiting on the row lock',
    );
    expect(order).toEqual(['first:locked']);

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['first:locked', 'first:committed', 'second:locked', 'second:committed']);

    // Neither increment was lost: `for update` made the read-modify-write safe.
    const final = await crm.query<{ score: number }>('select score from prospects where id = $1', [prospectId]);
    expect(final[0]?.score).toBe(2);
  });

  it('lets two separate OS processes read and write the same database at once', async () => {
    // The decisive case. Under PGlite the second process throws
    // DatadirLockedError before it can run a single statement.
    // The scratch script lives *inside* the repo: Node resolves `pg` by walking
    // up from the file's own directory, and a script in the OS temp dir has no
    // node_modules above it.
    const dir = mkdtempSync(join(process.cwd(), 'var', 'db1-proc-'));
    const script = join(dir, 'worker.mjs');
    writeFileSync(
      script,
      `import pg from 'pg';
       const label = process.argv[2];
       const pool = new pg.Pool({ connectionString: process.env.OUTBOUND_TEST_DATABASE_URL, application_name: label });
       const client = await pool.connect();
       await client.query('begin');
       await client.query(
         "insert into prospects (campaign_id, canonical_key, display_name, niche_verdict, score) values ($1, $2, $3, 'in_niche', 1)",
         [process.argv[3], 'db1-proc-' + label, label],
       );
       const seen = await client.query('select count(*)::int as n from prospects');
       await client.query('commit');
       client.release();
       await pool.end();
       process.stdout.write(JSON.stringify({ label, seen: seen.rows[0].n }));
      `,
    );

    try {
      const [a, b] = await Promise.all([
        execFileAsync(process.execPath, [script, 'proc-a', campaignId], {
          env: { ...process.env, OUTBOUND_TEST_DATABASE_URL: TEST_URL as string },
        }),
        execFileAsync(process.execPath, [script, 'proc-b', campaignId], {
          env: { ...process.env, OUTBOUND_TEST_DATABASE_URL: TEST_URL as string },
        }),
      ]);

      expect(JSON.parse(a.stdout).label).toBe('proc-a');
      expect(JSON.parse(b.stdout).label).toBe('proc-b');

      const written = await crm.query<{ display_name: string }>(
        "select display_name from prospects where canonical_key like 'db1-proc-%' order by display_name",
      );
      expect(written.map((r) => r.display_name)).toEqual(['proc-a', 'proc-b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// IG-R1 §3 — la prise de job Instagram est-elle réellement atomique ?
// ---------------------------------------------------------------------------
//
// Ce bloc vit dans CE fichier et pas dans le sien, pour une raison de
// correction et non de rangement : les deux suites partagent l'unique base
// jetable désignée par `OUTBOUND_TEST_DATABASE_URL`, et celle du dessus fait un
// `truncate table campaigns cascade`. Deux fichiers séparés tournent en
// parallèle sous Vitest — donc l'un viderait les fixtures de l'autre en pleine
// course. Deux suites d'un même fichier s'exécutent l'une après l'autre.
//
// PGlite ne peut pas répondre à la question posée ici : un seul processus peut
// ouvrir son datadir, donc « deux workers en même temps » n'y existe pas. Il
// faut deux pools indépendants sur un vrai PostgreSQL — exactement la
// situation que `for update skip locked` est censé trancher.

describeIfPostgres('prise de job Instagram, multi-worker (IG-R1 §3)', () => {
  let workerA: Sql;
  let workerB: Sql;
  let campaignId: string;

  beforeAll(async () => {
    workerA = await createPostgresSql(config('ig-worker-a'));
    workerB = await createPostgresSql(config('ig-worker-b'));
    await migrate(workerA);

    const rows = await workerA.query<{ id: string }>(
      `insert into campaigns (slug, name, niche_key, config)
       values ('ig-r1-concurrency', 'IG-R1 concurrency', 'example-services', '{}'::jsonb)
       on conflict (slug) do update set name = excluded.name
       returning id`,
    );
    campaignId = rows[0]?.id as string;
  }, 120_000);

  afterAll(async () => {
    await workerA?.exec('truncate table campaigns cascade').catch(() => undefined);
    await workerA?.close();
    await workerB?.close();
  });

  beforeEach(async () => {
    await workerA.query('delete from ig_job_events');
    await workerA.query('delete from ig_identity_checks');
    // IG3 — le journal d'éligibilité pointe les jobs (FK) : il part d'abord.
    await workerA.query('delete from ig_enqueue_decisions');
    // Cycle de références entre jobs et autorisations (0031) : rompu d'abord.
    await workerA.query('update ig_live_canary_authorizations set consumed_job_id = null');
    await workerA.query('delete from ig_dispatch_jobs');
    await workerA.query('delete from ig_live_canary_authorizations');
    await workerA.query('delete from ig_browser_sessions');
    await workerA.query('delete from r6b_dispatch_attempts');
    await workerA.query('delete from r6b_dispatch_manifests');
    await workerA.query('delete from r6b_batch_votes');
    await workerA.query('delete from r6b_batch_items');
    await workerA.query('delete from r6b_batches');
    await workerA.query('delete from prospect_icp_assessments');
    await workerA.query('delete from prospect_evidence');
    await workerA.query('delete from prospects where campaign_id = $1', [campaignId]);
  });

  /** Un manifeste Instagram verrouillé par le vrai chemin (vote puis lock), puis enfilé. */
  async function enqueueJob(handle: string): Promise<string> {
    // Le nom d'affichage DÉRIVE du handle, et ce n'est pas cosmétique : le gate
    // ICP refuse un manifeste dont le handle n'a aucun rapport lexical avec le
    // nom de l'entreprise (« handle sans rapport lexical », signal fort). Un
    // couple incohérent ferait échouer le verrouillage avant même d'arriver au
    // sujet de ce fichier, qui est la concurrence.
    const prospect = await workerA.query<{ id: string }>(
      `insert into prospects (campaign_id, canonical_key, display_name, instagram_handle)
       values ($1,$2,$3,$4) returning id`,
      [campaignId, `ig-${handle}-${Math.random()}`, handle.replace(/[._]/g, ' ').toUpperCase(), handle],
    );
    const prospectId = prospect[0]?.id as string;
    await workerA.query(
      `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
       values ($1,'instagram_handle',$2,'website','crawl','https://example.org',1.0)`,
      [prospectId, handle],
    );
    const batch = await workerA.query<{ id: string }>(
      `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
      [`ig-batch-${Math.random()}`, campaignId],
    );
    const item = await workerA.query<{ id: string }>(
      `insert into r6b_batch_items (batch_id, prospect_id, item_index, original_draft, contact_channels)
       values ($1,$2,1,'brouillon',$3) returning id`,
      [batch[0]?.id as string, prospectId, JSON.stringify(['instagram'])],
    );
    const itemId = item[0]?.id as string;
    await castR6bVote(workerA, { itemId, verdict: 'SEND', approvedText: 'Bonjour.', note: null });
    // IG3 §2 — le prospect franchit les dix portes d'éligibilité comme en
    // production : contenu d'entreprise lu, identité confirmée.
    await makeProspectInstagramEligible(workerA, prospectId);
    const manifest = await lockManifestForItem(workerA, { itemId, transport: 'instagram_dm' });
    const { job } = await enqueueInstagramJob(workerA, {
      manifestId: manifest.id,
      action: 'first_touch_dm',
      enqueuedBy: 'Test',
    });
    return job.id;
  }

  it('deux workers qui prennent EN MÊME TEMPS le seul job de la file : un gagne, l’autre repart les mains vides', async () => {
    await enqueueJob('demo_prospect_a');

    const [a, b] = await Promise.all([
      claimNextInstagramJob(workerA, { workerId: 'A', leaseMs: 60_000 }),
      claimNextInstagramJob(workerB, { workerId: 'B', leaseMs: 60_000 }),
    ]);

    const winners = [a, b].filter((job) => job !== null);
    expect(winners).toHaveLength(1);

    const rows = await workerA.query<{ status: string; claimedBy: string; attempts: number }>(
      `select status, claimed_by as "claimedBy", attempts from ig_dispatch_jobs`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('CLAIMED');
    expect(rows[0]?.claimedBy).toBe(winners[0]?.claimedBy);
    // Une seule prise : le perdant n'a pas incrémenté le compteur au passage.
    expect(Number(rows[0]?.attempts)).toBe(1);
  });

  it('deux jobs, deux workers simultanés : chacun le sien, jamais le même', async () => {
    await enqueueJob('demo_prospect_a');
    await enqueueJob('example_services_');

    const [a, b] = await Promise.all([
      claimNextInstagramJob(workerA, { workerId: 'A', leaseMs: 60_000 }),
      claimNextInstagramJob(workerB, { workerId: 'B', leaseMs: 60_000 }),
    ]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // `skip locked` : le second worker ne s'est pas mis en attente, il a pris l'autre.
    expect(a?.id).not.toBe(b?.id);
    expect(a?.claimToken).not.toBe(b?.claimToken);
  });

  it('huit prises concurrentes sur trois jobs n’attribuent jamais deux fois le même', async () => {
    const ids = [
      await enqueueJob('demo_prospect_a'),
      await enqueueJob('example_services_'),
      await enqueueJob('demo_account_31'),
    ];

    const claimed = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        claimNextInstagramJob(index % 2 === 0 ? workerA : workerB, { workerId: `w${index}`, leaseMs: 60_000 }),
      ),
    );

    const won = claimed.filter((job) => job !== null);
    expect(won).toHaveLength(3);
    expect(new Set(won.map((job) => job?.id)).size).toBe(3);
    expect(new Set(won.map((job) => job?.id))).toEqual(new Set(ids));
  });

  it('seul le détenteur du bail peut clore le job', async () => {
    await enqueueJob('demo_prospect_a');
    const winner = await claimNextInstagramJob(workerA, { workerId: 'A', leaseMs: 60_000 });

    // Un autre worker, avec un jeton fabriqué, n'écrit rien.
    const impostor = await finalizeInstagramJob(workerB, {
      jobId: winner?.id as string,
      claimToken: '00000000-0000-0000-0000-000000000000',
      status: 'DRY_RUN_VALIDATED',
      reasonCode: 'IG_DRY_RUN_OK',
      detail: 'usurpation',
    });
    expect(impostor).toBe(false);

    const holder = await finalizeInstagramJob(workerA, {
      jobId: winner?.id as string,
      claimToken: winner?.claimToken as string,
      status: 'DRY_RUN_VALIDATED',
      reasonCode: 'IG_DRY_RUN_OK',
      detail: null,
    });
    expect(holder).toBe(true);
  });

  it('deux enfilements simultanés du même manifeste ne créent qu’un job', async () => {
    const prospect = await workerA.query<{ id: string }>(
      `insert into prospects (campaign_id, canonical_key, display_name, instagram_handle)
       values ($1,$2,'DEMO PROSPECT A','demo_prospect_a') returning id`,
      [campaignId, `ig-race-${Math.random()}`],
    );
    const prospectId = prospect[0]?.id as string;
    await workerA.query(
      `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
       values ($1,'instagram_handle','demo_prospect_a','website','crawl','https://example.org',1.0)`,
      [prospectId],
    );
    const batch = await workerA.query<{ id: string }>(
      `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
      [`ig-batch-${Math.random()}`, campaignId],
    );
    const item = await workerA.query<{ id: string }>(
      `insert into r6b_batch_items (batch_id, prospect_id, item_index, original_draft, contact_channels)
       values ($1,$2,1,'brouillon',$3) returning id`,
      [batch[0]?.id as string, prospectId, JSON.stringify(['instagram'])],
    );
    const itemId = item[0]?.id as string;
    await castR6bVote(workerA, { itemId, verdict: 'SEND', approvedText: 'Bonjour.', note: null });
    await makeProspectInstagramEligible(workerA, prospectId);
    const manifest = await lockManifestForItem(workerA, { itemId, transport: 'instagram_dm' });

    const results = await Promise.all([
      enqueueInstagramJob(workerA, { manifestId: manifest.id, action: 'first_touch_dm', enqueuedBy: 'A' }),
      enqueueInstagramJob(workerB, { manifestId: manifest.id, action: 'first_touch_dm', enqueuedBy: 'B' }),
    ]);

    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);

    const rows = await workerA.query<{ n: string }>('select count(*) as n from ig_dispatch_jobs');
    expect(Number(rows[0]?.n)).toBe(1);

    // IG3 — les deux verdicts d'éligibilité sont journalisés, et un seul a créé
    // le job. L'idempotence se VOIT dans le journal, elle ne s'y devine pas.
    const decisions = await workerA.query<{ jobCreated: boolean }>(
      `select job_created as "jobCreated" from ig_enqueue_decisions where manifest_id = $1`,
      [manifest.id],
    );
    expect(decisions).toHaveLength(2);
    expect(decisions.filter((row) => row.jobCreated)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // IG3 §5 — la course sur la dernière place d'un plafond
  // -------------------------------------------------------------------------

  /**
   * Ce que ce bloc éprouve, et pourquoi il ne peut se tester que sur Postgres.
   *
   * `evaluateSafety` LIT des compteurs puis l'appelant AGIT : entre les deux, il
   * y a une fenêtre. Deux workers qui lisent « 2 envois sur 3 » à la même
   * milliseconde concluent tous deux qu'il reste une place, et un plafond de 3
   * devient 4. Aucune relecture ne referme cette fenêtre — il faut que la
   * vérification et l'écriture soient la même opération.
   *
   * `reserveExternalEffectSlot` l'est : un verrou consultatif de transaction
   * (`pg_advisory_xact_lock`) sérialise les prétendants, le compteur est
   * recalculé À L'INTÉRIEUR, et le drapeau du job est posé dans la même
   * transaction. PGlite ne saurait pas montrer cela — un seul processus, tout
   * est déjà sérialisé. Il faut deux connexions réelles.
   */
  describe('réservation de plafond, deux workers réels', () => {
    const rail = loadInstagramRail();

    /**
     * Une autorisation canari POUR CE JOB, par le vrai chemin d'armement, puis
     * révoquée.
     *
     * L'aller-retour est nécessaire et instructif : la base n'accepte qu'UNE
     * autorisation `ARMED` à la fois (index unique partiel, 0031), et ce test
     * en veut plusieurs. Les révoquer laisse des lignes valides — ce dont
     * `reserveExternalEffectSlot` a besoin, puisque la contrainte du job exige
     * une autorisation RATTACHÉE, pas une autorisation vivante. L'unicité de
     * l'autorisation armée est éprouvée ailleurs (`instagramLiveCanary`), et ce
     * fichier porte sur le PLAFOND.
     *
     * Fabriquer les lignes par un `insert` direct serait plus court et faux :
     * les contraintes de 0031/0034 les refusent, et c'est très bien ainsi.
     */
    async function authorizationFor(jobId: string): Promise<string> {
      const rows = await workerA.query<{ manifestId: string }>(
        'select manifest_id as "manifestId" from ig_dispatch_jobs where id = $1',
        [jobId],
      );
      const { envelope } = await resolveDispatchTarget(workerA, rows[0]?.manifestId as string, 'LIVE');
      const auth = await armCanaryAuthorization(workerA, {
        envelope,
        action: 'first_touch_dm',
        armedBy: 'Test',
        reason: 'course sur la dernière place d’un plafond',
        ttlMs: 30 * 60_000,
      });
      await workerA.query(
        `update ig_live_canary_authorizations
            set state = 'REVOKED', closed_at = now(), closed_by = 'Test',
                closed_reason = 'libère l''unique place ARMED pour la suite du test'
          where id = $1`,
        [auth.id],
      );
      return auth.id;
    }

    it('deux workers sur la dernière place : un seul réserve, le plafond tient', async () => {
      // Un plafond d'UNE tentative : la « dernière place » est la première.
      const capOne = { ...rail, caps: { ...rail.caps, dailySentCap: 1, hourlySentCap: 1, minSendIntervalMs: 0 } };

      const jobA = await enqueueJob('coursea');
      const jobB = await enqueueJob('courseb');
      const authA = await authorizationFor(jobA);
      const authB = await authorizationFor(jobB);

      // Les deux réservent EN MÊME TEMPS, sur deux connexions distinctes.
      const outcomes = await Promise.allSettled([
        reserveExternalEffectSlot(workerA, capOne, { jobId: jobA, canaryAuthorizationId: authA }),
        reserveExternalEffectSlot(workerB, capOne, { jobId: jobB, canaryAuthorizationId: authB }),
      ]);

      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // Le perdant est refusé par le PLAFOND, pas par un hasard de verrou.
      const reason = (rejected[0] as PromiseRejectedResult).reason as InstagramQueueError;
      expect(reason).toBeInstanceOf(InstagramQueueError);
      expect(['IG_CAP_DAILY_SENT', 'IG_CAP_HOURLY_SENT']).toContain(reason.code);

      // Et la base ne porte qu'UNE tentative d'effet. C'est l'assertion qui
      // compte : le plafond n'a pas été dépassé, il a été TENU.
      const effects = await workerA.query<{ n: string }>(
        `select count(*) as n from ig_dispatch_jobs where external_effect_attempted = true`,
      );
      expect(Number(effects[0]?.n)).toBe(1);
    });

    it('six workers sur trois places : exactement trois passent', async () => {
      const capThree = { ...rail, caps: { ...rail.caps, dailySentCap: 3, hourlySentCap: 3, minSendIntervalMs: 0 } };

      const jobs: string[] = [];
      for (const handle of ['sixa', 'sixb', 'sixc', 'sixd', 'sixe', 'sixf']) {
        jobs.push(await enqueueJob(handle));
      }
      // Une autorisation par job. Séquentiel, pas `Promise.all` : l'index unique
      // partiel n'autorise qu'un seul ARMED à la fois, et les armer en parallèle
      // ferait échouer tout le monde sauf un — ce qui est le bon comportement,
      // et pas le sujet ici.
      const auths: string[] = [];
      for (const jobId of jobs) auths.push(await authorizationFor(jobId));

      const outcomes = await Promise.allSettled(
        jobs.map((jobId, index) =>
          reserveExternalEffectSlot(index % 2 === 0 ? workerA : workerB, capThree, {
            jobId,
            canaryAuthorizationId: auths[index] as string,
          }),
        ),
      );

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(3);
      const effects = await workerA.query<{ n: string }>(
        `select count(*) as n from ig_dispatch_jobs where external_effect_attempted = true`,
      );
      expect(Number(effects[0]?.n)).toBe(3);
    });

    it('l’intervalle de cadence est lui aussi tenu sous concurrence', async () => {
      const withInterval = {
        ...rail,
        caps: { ...rail.caps, dailySentCap: 10, hourlySentCap: 10, minSendIntervalMs: 900_000 },
      };

      const jobA = await enqueueJob('cadencea');
      const jobB = await enqueueJob('cadenceb');
      const auths = [await authorizationFor(jobA), await authorizationFor(jobB)];

      const outcomes = await Promise.allSettled([
        reserveExternalEffectSlot(workerA, withInterval, { jobId: jobA, canaryAuthorizationId: auths[0] as string }),
        reserveExternalEffectSlot(workerB, withInterval, { jobId: jobB, canaryAuthorizationId: auths[1] as string }),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      expect((rejected.reason as InstagramQueueError).code).toBe('IG_CAP_MIN_INTERVAL');
    });

    /**
     * IG3 §13 — le chemin complet, sur PostgreSQL réel.
     *
     * Les autres fichiers éprouvent l'ordonnanceur sur PGlite : correct, mais
     * PGlite est un seul processus et une seule connexion. Ce test fait passer
     * UN job par toutes les étapes — enfilement, prise atomique, report hors
     * fenêtre, replanification, reprise, aperçu — sur le moteur qui sert en
     * production, avec les migrations réelles.
     *
     * Le rail est un double : ce test porte sur la file et l'ordonnancement, et
     * ouvrir un vrai navigateur vers un vrai compte Instagram n'apprendrait rien
     * de plus sur eux tout en touchant une cible pour rien.
     */
    it('le chemin complet sur Postgres réel : enfilement → prise → report → replanification → aperçu', async () => {
      const jobId = await enqueueJob('chemincomplet');
      const open = {
        ...rail,
        schedule: {
          ...rail.schedule,
          windows: [{ days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1_080 }],
        },
      };

      // --- 1. Samedi : hors fenêtre. Reporté au lundi 9 h, PAS traité. --------
      const saturday = new Date('2026-07-18T12:00:00Z');
      const deferred = await runInstagramDryRun(
        { sql: workerA, config: open, workerId: 'pg-w1', mode: 'DRY_RUN', now: () => saturday },
        { rail: new StubRail() },
      );
      expect(deferred.outcomes[0]!.status).toBe('SKIPPED');
      expect(deferred.outcomes[0]!.skipReason).toBe('outside_window');
      expect(deferred.outcomes[0]!.skipClass).toBe('TEMPORARY');

      const afterSkip = await workerA.query<{
        status: string;
        notBefore: string;
        skipCount: number;
        lastSkipReason: string;
      }>(
        `select status, not_before as "notBefore", skip_count as "skipCount",
                last_skip_reason as "lastSkipReason"
           from ig_dispatch_jobs where id = $1`,
        [jobId],
      );
      expect(afterSkip[0]?.status).toBe('SKIPPED');
      expect(afterSkip[0]?.lastSkipReason).toBe('outside_window');
      expect(Number(afterSkip[0]?.skipCount)).toBe(1);
      expect(new Date(afterSkip[0]?.notBefore as string).toISOString()).toBe('2026-07-20T07:00:00.000Z');

      // --- 2. Tant que l'heure n'est pas venue, personne ne le prend. --------
      // La borne est appliquée par la BASE (`not_before <= now()`), pas par le
      // worker : un second processus ne le voit pas davantage.
      await workerA.query(`update ig_dispatch_jobs set not_before = now() + interval '1 hour' where id = $1`, [
        jobId,
      ]);
      expect(await claimNextInstagramJob(workerB, { workerId: 'pg-w2', leaseMs: 60_000 })).toBeNull();

      // --- 3. L'heure venue, il repart et va au bout. -----------------------
      await workerA.query(`update ig_dispatch_jobs set not_before = now() where id = $1`, [jobId]);
      const monday = new Date('2026-07-20T12:00:00Z');
      const completed = await runInstagramDryRun(
        { sql: workerA, config: open, workerId: 'pg-w3', mode: 'DRY_RUN', now: () => monday },
        { rail: new StubRail() },
      );
      expect(completed.outcomes[0]!.status).toBe('DRY_RUN_COMPLETED');
      expect(completed.outcomes[0]!.preview).not.toBeNull();
      expect(completed.outcomes[0]!.preview?.payloadFields['body']).toBe('Bonjour.');
      // L'arrêt global est armé par défaut ici : la projection le dit, et le
      // dry-run continue quand même — c'est tout l'objet d'IG3 §7.
      expect(completed.outcomes[0]!.liveProjection?.wouldProceed).toBe(false);
      expect(completed.outcomes[0]!.liveProjection?.blockedBy).toBe('kill_switch');

      // --- 4. Le résultat est DURABLE, et le cycle de vie est complet. -------
      const final = await workerA.query<{ status: string; dryRunAt: string | null }>(
        `select status, last_dry_run_at as "dryRunAt" from ig_dispatch_jobs where id = $1`,
        [jobId],
      );
      expect(final[0]?.status).toBe('DRY_RUN_VALIDATED');
      expect(final[0]?.dryRunAt).not.toBeNull();

      const events = await workerA.query<{ status: string }>(
        `select status from ig_job_events where job_id = $1 order by seq asc`,
        [jobId],
      );
      expect(events.map((row) => row.status)).toEqual([
        'ENQUEUED',
        'CLAIMED',
        'DRY_RUN_STARTED',
        'SKIPPED',
        'CLAIMED',
        'DRY_RUN_STARTED',
        'DRY_RUN_COMPLETED',
      ]);

      // --- 5. Et l'invariant de toute la mission. ---------------------------
      const effects = await workerA.query<{ n: string }>(
        `select count(*) as n from ig_dispatch_jobs where external_effect_attempted = true`,
      );
      expect(Number(effects[0]?.n)).toBe(0);
      const outreach = await workerA.query<{ n: string }>('select count(*) as n from outreach_events');
      expect(Number(outreach[0]?.n)).toBe(0);
    });

    it('une tentative déjà inscrite ne se réserve pas deux fois', async () => {
      const capWide = { ...rail, caps: { ...rail.caps, dailySentCap: 50, hourlySentCap: 50, minSendIntervalMs: 0 } };
      const jobId = await enqueueJob('deuxfois');
      const authId = await authorizationFor(jobId);

      await reserveExternalEffectSlot(workerA, capWide, { jobId, canaryAuthorizationId: authId });
      await expect(
        reserveExternalEffectSlot(workerB, capWide, { jobId, canaryAuthorizationId: authId }),
      ).rejects.toMatchObject({ code: 'IG_EFFECT_ALREADY_MARKED' });
    });
  });
});
