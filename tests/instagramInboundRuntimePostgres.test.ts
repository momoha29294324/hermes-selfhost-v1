import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresSql } from '@/lib/db/postgres';
import { migrate } from '@/lib/db/migrate';
import { createLogger } from '@/lib/logging/logger';
import { openInboundPoll } from '@/lib/inbound/instagramIntake';
import {
  decideInboundTick,
  loadInboundRuntimeState,
  runInboundRuntimeLoop,
  runInboundTick,
  type InboundRuntimeConfig,
} from '@/lib/inbound/instagramRuntime';
import type { InstagramInboundRail, InstagramInboundSweep } from '@/lib/instagram/inboundRail';
import type { PostgresConfig } from '@/lib/db/config';
import type { Sql } from '@/lib/db/sql';
import { domMessage as message, makeThread } from './support/instagramInboundFixture';

/**
 * IG5.2A §4/§13 — la PROPRIÉTÉ d'un tour et la reprise, sur PostgreSQL RÉEL.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce fichier existe à côté de `instagramInboundRuntime.test.ts`
 * ---------------------------------------------------------------------------
 *
 * Celui-là tourne sur PGlite, qu'un seul processus peut ouvrir : il prouve la
 * LOGIQUE (cadence, taxonomie, reprise), pas la CONCURRENCE. Ici deux pools
 * indépendants s'ouvrent sur le même cluster, ce qui est la situation réelle —
 * deux runtimes lancés par erreur, ou un runtime relancé pendant qu'un autre
 * tourne encore.
 *
 * Ce que ce fichier ajoute à `instagramInboundPostgres.test.ts` (IG5.1) : IG5.1
 * prouve la PRIMITIVE (`openInboundPoll` refuse le second appel). Celui-ci
 * prouve le RUNTIME au-dessus — que le second collecteur ne fait pas un second
 * BALAYAGE, ce qui est une propriété différente : un rail peut très bien ouvrir
 * un navigateur et lire une boîte avant de découvrir qu'il n'avait pas le tour.
 *
 * ---------------------------------------------------------------------------
 * Aucun `truncate`, aucune horloge réelle dans les assertions
 * ---------------------------------------------------------------------------
 *
 * La base est partagée avec les autres fichiers Postgres de la suite : un
 * `truncate` y prendrait un verrou ACCESS EXCLUSIVE et déstabiliserait des
 * tests sans rapport. Chaque test travaille donc sur un compte qui n'appartient
 * qu'à lui.
 *
 * Sauté tant que `OUTBOUND_TEST_DATABASE_URL` ne pointe pas sur une base
 * jetable (`scripts/pg17-local.sh init`).
 */

const TEST_URL = process.env.OUTBOUND_TEST_DATABASE_URL;
const describeIfPostgres = TEST_URL ? describe : describe.skip;

const logger = createLogger({ test: 'ig5.2a-runtime-pg' });

function uniqueAccount(prefix: string): string {
  return `${prefix}.${randomUUID().slice(0, 8)}`;
}

function config(applicationName: string): PostgresConfig {
  return {
    backend: 'postgres',
    connectionString: TEST_URL as string,
    poolMax: 5,
    applicationName,
    ssl: 'disable',
    statementTimeoutMs: 0,
    idleTimeoutMs: 5_000,
    connectionTimeoutMs: 10_000,
  };
}

function runtimeConfig(accountHandle: string, overrides: Partial<InboundRuntimeConfig> = {}): InboundRuntimeConfig {
  return Object.freeze({
    enabled: true,
    accountHandle,
    formerAccountHandles: [],
    pollIntervalMs: 300_000,
    leaseMs: 300_000,
    maxThreadsPerPoll: 10,
    retryBackoffMs: 600_000,
    maxBackoffMs: 3_600_000,
    awaitingHumanBackoffMs: 1_800_000,
    downstreamLimit: 50,
    ...overrides,
  });
}


/**
 * Un rail qui COMPTE ses balayages, et qu'on peut retenir.
 *
 * Le compteur est le cœur de ce fichier : « le second collecteur ne fait pas un
 * second sweep » ne se démontre pas en regardant la base — il se démontre en
 * regardant si le navigateur a été ouvert.
 */
class CountingInboundRail implements InstagramInboundRail {
  sweeps = 0;
  closed = 0;
  constructor(
    private readonly accountHandle: string,
    private readonly threads: readonly ReturnType<typeof makeThread>[],
    private readonly hold?: Promise<void>,
  ) {}

  async ensureSession(): Promise<{ state: 'SESSION_READY'; detail: string }> {
    return { state: 'SESSION_READY', detail: 'session simulée' };
  }

  async observeInbox(): Promise<InstagramInboundSweep> {
    this.sweeps += 1;
    if (this.hold !== undefined) await this.hold;
    return Object.freeze({
      accountHandle: this.accountHandle,
      sessionState: 'SESSION_READY' as const,
      readability: 'INBOX_READABLE' as const,
      stopReason: null,
      threads: this.threads,
      rowsSeen: this.threads.length,
      threadListReadable: true,
      threadListSize: this.threads.length,
      blockedWriteRequests: 0,
      screenshotPath: null,
      durationMs: 5,
    });
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

describeIfPostgres('IG5.2A §4/§13 — propriété et reprise, PostgreSQL réel', () => {
  let a: Sql;
  let b: Sql;

  beforeAll(async () => {
    a = await createPostgresSql(config('ig5.2a-runtime-a'));
    b = await createPostgresSql(config('ig5.2a-runtime-b'));
    await migrate(a);
  }, 120_000);

  afterAll(async () => {
    await a.close();
    await b.close();
  });

  // -------------------------------------------------------------------------
  // 1. Deux collecteurs, un seul balayage
  // -------------------------------------------------------------------------

  it('collecteur B ne fait AUCUN balayage tant que le tour de A court', async () => {
    const account = uniqueAccount('conc');
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const railA = new CountingInboundRail(account, [], held);
    const railB = new CountingInboundRail(account, []);

    // A part et se bloque DANS son balayage, tour déjà ouvert : l'état exact
    // d'un collecteur en train de relever.
    const tickA = runInboundTick(a, { railFactory: () => railA, polledBy: 'A', logger }, runtimeConfig(account));
    for (let i = 0; i < 200 && railA.sweeps === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(railA.sweeps).toBe(1);

    const resultB = await runInboundTick(
      b,
      { railFactory: () => railB, polledBy: 'B', logger },
      runtimeConfig(account),
    );

    release();
    const resultA = await tickA;

    expect(resultA.outcome).toBe('SUCCESS');
    expect(resultB.decision.verdict).toBe('POLL_ALREADY_RUNNING');
    expect(resultB.decision.reason).toContain('A');
    // La propriété qui compte : B n'a pas ouvert de navigateur.
    expect(railB.sweeps).toBe(0);

    const polls = await b.query<{ n: string }>(
      `select count(*) as n from ig_inbound_polls where account_handle = $1`,
      [account],
    );
    expect(Number(polls[0]!.n)).toBe(1);
  });

  it('deux runtimes lancés ensemble : exactement un tour, quel que soit l’entrelacement', async () => {
    const account = uniqueAccount('race');
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Les DEUX rails sont retenus, et c'est ce qui rend ce test déterministe.
    //
    // Sans cela il ne prouve rien de façon fiable : deux `runInboundTick`
    // lancés par `Promise.all` peuvent parfaitement se sérialiser — le premier
    // ouvre, relève, clôt et referme son tour avant que le second n'ait lu
    // l'état, et les deux réussissent. C'est un comportement CORRECT du
    // produit (deux relèves successives), mais ce n'est pas la course qu'on
    // veut observer, et l'assertion échouait au hasard sous charge.
    //
    // Retenir les deux garantit que le gagnant reste `RUNNING` pendant que le
    // perdant se présente. Lequel gagne reste indéterminé, et l'assertion ne
    // le suppose pas : elle porte sur l'invariant — un seul.
    const rails = [
      new CountingInboundRail(account, [], held),
      new CountingInboundRail(account, [], held),
    ];

    const tickA = runInboundTick(a, { railFactory: () => rails[0]!, polledBy: 'A', logger }, runtimeConfig(account));
    const tickB = runInboundTick(b, { railFactory: () => rails[1]!, polledBy: 'B', logger }, runtimeConfig(account));

    // Le premier des deux à RENDRE est nécessairement le perdant : le gagnant
    // est retenu dans son balayage et ne peut pas finir avant qu'on le
    // relâche. Attendre cette course-là, plutôt que les deux, est ce qui
    // supprime le hasard.
    //
    // Le perdant est refusé par la décision s'il a lu l'état après l'insert du
    // gagnant, par l'index partiel unique s'il a lu avant. Les deux chemins
    // rendent la même issue, et c'est voulu : l'appelant n'a pas à savoir
    // lequel des deux l'a arrêté.
    const loser = await Promise.race([tickA, tickB]);
    expect(loser.outcome).toBe('POLL_ALREADY_RUNNING');

    release();
    const [first, second] = await Promise.all([tickA, tickB]);

    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(['POLL_ALREADY_RUNNING', 'SUCCESS'].sort());
    // Un seul navigateur a été ouvert : le perdant n'a pas balayé.
    expect(rails[0]!.sweeps + rails[1]!.sweeps).toBe(1);

    const polls = await a.query<{ status: string }>(
      `select status from ig_inbound_polls where account_handle = $1`,
      [account],
    );
    expect(polls).toHaveLength(1);
    expect(polls[0]!.status).toBe('COMPLETED');
  });

  it('deux comptes différents relèvent en parallèle sans se gêner', async () => {
    const accountA = uniqueAccount('paraa');
    const accountB = uniqueAccount('parab');
    const railA = new CountingInboundRail(accountA, []);
    const railB = new CountingInboundRail(accountB, []);

    const [resA, resB] = await Promise.all([
      runInboundTick(a, { railFactory: () => railA, polledBy: 'A', logger }, runtimeConfig(accountA)),
      runInboundTick(b, { railFactory: () => railB, polledBy: 'B', logger }, runtimeConfig(accountB)),
    ]);

    expect(resA.outcome).toBe('SUCCESS');
    expect(resB.outcome).toBe('SUCCESS');
    // Le verrou porte sur le COMPTE, pas sur la table : sinon un second compte
    // serait bloqué par le premier sans aucune raison.
    expect(railA.sweeps).toBe(1);
    expect(railB.sweeps).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 2. Crash et reprise
  // -------------------------------------------------------------------------

  it('un collecteur tué : le bail expire, un autre reprend, et l’ancien tour n’est pas réécrit', async () => {
    const account = uniqueAccount('crash');

    // Le tour d'un processus qui ne reviendra pas.
    const orphan = await openInboundPoll(a, { accountHandle: account, polledBy: 'processus-mort', leaseMs: 30_000 });
    await a.query(`update ig_inbound_polls set lease_expires_at = now() - interval '1 minute' where id = $1`, [orphan]);

    // Tant que le bail court, le tour appartient à quelqu'un. Une fois expiré,
    // il est reprenable — et c'est la DÉCISION qui doit le voir, depuis l'autre
    // connexion.
    const seen = await loadInboundRuntimeState(b, account);
    expect(seen.running?.pollId).toBe(orphan);
    expect(decideInboundTick({ state: seen, config: runtimeConfig(account), now: new Date() }).verdict).toBe('POLL');

    const rail = new CountingInboundRail(account, []);
    const result = await runInboundTick(b, { railFactory: () => rail, polledBy: 'repreneur', logger }, runtimeConfig(account));

    expect(result.outcome).toBe('SUCCESS');
    expect(result.pollId).not.toBe(orphan);

    const rows = await a.query<{ id: string; status: string; detail: string | null; threadsSeen: number }>(
      `select id, status, detail, threads_seen as "threadsSeen"
         from ig_inbound_polls where account_handle = $1 order by started_at asc`,
      [account],
    );
    expect(rows).toHaveLength(2);
    // L'ancien est clos POUR CE QU'IL EST, et ses compteurs restent les siens :
    // le repreneur n'écrit pas dans l'histoire de quelqu'un d'autre.
    expect(rows[0]!.id).toBe(orphan);
    expect(rows[0]!.status).toBe('FAILED');
    expect(rows[0]!.detail).toContain('bail expiré');
    expect(rows[0]!.threadsSeen).toBe(0);
    expect(rows[1]!.status).toBe('COMPLETED');
  });

  it('aucune issue ne laisse un tour RUNNING derrière elle', async () => {
    const account = uniqueAccount('terminal');

    const failing: InstagramInboundRail = {
      ensureSession: async () => ({ state: 'SESSION_READY' as const, detail: 'x' }),
      observeInbox: async () => {
        throw new Error('navigateur perdu');
      },
      close: async () => undefined,
    };

    const broken = await runInboundTick(a, { railFactory: () => failing, polledBy: 'A', logger }, runtimeConfig(account));
    expect(broken.outcome).toBe('BROWSER_FAILURE');

    await a.query(`update ig_inbound_polls set finished_at = finished_at - interval '2 hours' where account_handle = $1`, [
      account,
    ]);
    const ok = await runInboundTick(
      a,
      { railFactory: () => new CountingInboundRail(account, []), polledBy: 'A', logger },
      runtimeConfig(account),
    );
    expect(ok.outcome).toBe('SUCCESS');

    const running = await b.query<{ n: string }>(
      `select count(*) as n from ig_inbound_polls where account_handle = $1 and status = 'RUNNING'`,
      [account],
    );
    expect(Number(running[0]!.n)).toBe(0);

    const finished = await b.query<{ n: string }>(
      `select count(*) as n from ig_inbound_polls
        where account_handle = $1 and status in ('COMPLETED','FAILED') and finished_at is not null`,
      [account],
    );
    expect(Number(finished[0]!.n)).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 3. Rejeu à travers un redémarrage
  // -------------------------------------------------------------------------

  it('le même message relevé par deux runtimes distincts reste UNE réponse', async () => {
    const account = uniqueAccount('dedup');
    const counterparty = uniqueAccount('pros');
    const threadId = String(Date.now()).slice(-12);
    const thread = makeThread({
      threadId,
      counterpartyHandle: counterparty,
      messages: [message('Oui je suis intéressé', 'INCOMING')],
    });

    // Runtime A relève. Puis « redémarrage » : c'est l'autre connexion qui
    // reprend, sur la même boîte inchangée.
    const first = await runInboundTick(
      a,
      { railFactory: () => new CountingInboundRail(account, [thread]), polledBy: 'A', logger },
      runtimeConfig(account),
    );
    await a.query(`update ig_inbound_polls set finished_at = finished_at - interval '2 hours' where account_handle = $1`, [
      account,
    ]);
    const second = await runInboundTick(
      b,
      { railFactory: () => new CountingInboundRail(account, [thread]), polledBy: 'B', logger },
      runtimeConfig(account),
    );

    expect(first.report?.ingested).toBe(1);
    expect(second.report?.ingested).toBe(0);
    expect(second.report?.alreadyKnown).toBe(1);

    const rows = await b.query<{ n: string }>(
      `select count(*) as n from r6b_inbound_messages where provider = 'instagram' and mailbox = $1`,
      [account],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('deux boucles lancées sur le même compte n’ouvrent qu’un tour à la fois', async () => {
    const account = uniqueAccount('loops');
    const rails: CountingInboundRail[] = [];
    const factory = (): InstagramInboundRail => {
      const rail = new CountingInboundRail(account, []);
      rails.push(rail);
      return rail;
    };

    const [left, right] = await Promise.all([
      runInboundRuntimeLoop(
        a,
        { railFactory: factory, polledBy: 'gauche', logger, sleep: async () => undefined },
        runtimeConfig(account),
        { maxTicks: 3 },
      ),
      runInboundRuntimeLoop(
        b,
        { railFactory: factory, polledBy: 'droite', logger, sleep: async () => undefined },
        runtimeConfig(account),
        { maxTicks: 3 },
      ),
    ]);

    // Six tours au total, mais la cadence et le verrou font qu'un seul relevé
    // aboutit : les cinq autres sont soit NOT_DUE, soit refusés par l'index.
    const sweeps = rails.reduce((sum, rail) => sum + rail.sweeps, 0);
    expect(sweeps).toBeLessThanOrEqual(2);

    const polls = await a.query<{ status: string }>(
      `select status from ig_inbound_polls where account_handle = $1`,
      [account],
    );
    expect(polls.length).toBeLessThanOrEqual(2);
    expect(polls.every((row) => row.status !== 'RUNNING')).toBe(true);
    expect(left.ticks.length + right.ticks.length).toBe(6);
  });
});
