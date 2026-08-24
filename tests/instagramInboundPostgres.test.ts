import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresSql } from '@/lib/db/postgres';
import { migrate } from '@/lib/db/migrate';
import {
  InstagramInboundError,
  openInboundPoll,
  persistInstagramInboundMessage,
} from '@/lib/inbound/instagramIntake';
import { instagramMessageFingerprint } from '@/lib/instagram/inboundThread';
import type { InstagramCorrelationResult } from '@/lib/inbound/instagramCorrelation';
import type { PostgresConfig } from '@/lib/db/config';
import type { Sql } from '@/lib/db/sql';

/**
 * IG5.1 §16 — l'idempotence et la concurrence, prouvées sur PostgreSQL RÉEL.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi PGlite ne suffit pas ici
 * ---------------------------------------------------------------------------
 *
 * PGlite est un vrai PostgreSQL, mais un seul processus peut l'ouvrir : il ne
 * peut donc pas exercer ce qui compte ici — deux collecteurs qui se disputent
 * la même relève, et deux écritures concurrentes de la même réponse. Ce fichier
 * ouvre DEUX pools indépendants sur le même cluster, ce qui est la situation
 * réelle du runtime (le CRM lit pendant qu'un collecteur écrit).
 *
 * Il vérifie aussi que la migration 0042 s'applique sur un PostgreSQL complet :
 * les `alter table … drop constraint` par nom généré n'ont de sens que si ces
 * noms sont ceux que PostgreSQL produit vraiment.
 *
 * ---------------------------------------------------------------------------
 * Aucun `truncate`, et c'est délibéré
 * ---------------------------------------------------------------------------
 *
 * La base de test est partagée par les autres fichiers Postgres de cette suite,
 * qui tournent en parallèle. Un `truncate` y prend un verrou ACCESS EXCLUSIVE :
 * il ne se contente pas de vider des tables, il SUSPEND les autres fichiers le
 * temps de son exécution — et décale assez leur entrelacement pour faire
 * échouer, au hasard, des assertions qui n'ont rien à voir avec IG5.
 *
 * Chaque test travaille donc sur un compte qui n'appartient qu'à lui, et compte
 * uniquement les lignes portant ce compte. Les lignes s'accumulent dans une
 * base jetable, ce qui est sans conséquence, et aucun test n'a besoin que la
 * table soit vide pour dire quelque chose de vrai.
 *
 * ---------------------------------------------------------------------------
 * Où il tourne
 * ---------------------------------------------------------------------------
 *
 * Sauté tant que `OUTBOUND_TEST_DATABASE_URL` ne pointe pas sur une base
 * jetable, pour que `npm test` reste vert sur une machine sans PostgreSQL.
 * `scripts/pg17-local.sh init` en provisionne une et écrit l'URL dans
 * `var/pg17/connection.env`. Cette base n'est jamais le corpus.
 */

const TEST_URL = process.env.OUTBOUND_TEST_DATABASE_URL;
const describeIfPostgres = TEST_URL ? describe : describe.skip;

const HANDLE = 'atelier.test';

/** Un compte qui n'appartient qu'à un test. Borné à 30 caractères comme un vrai handle. */
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
    // Les trois délais sont OBLIGATOIRES dans `PostgresConfig` et le fichier les
    // omettait : `npm run typecheck` échouait donc à HEAD 2e49dd1, ce qui rendait
    // `npm run validate` rouge avant d'avoir écrit une ligne d'IG5.2A. Les
    // valeurs sont celles de `tests/postgresConcurrency.test.ts`, le seul autre
    // fichier qui ouvre ce cluster : pas de délai d'instruction (un test de
    // verrou attend volontairement), et des délais de connexion courts pour
    // qu'un cluster absent échoue vite au lieu de pendre la suite.
    statementTimeoutMs: 0,
    idleTimeoutMs: 5_000,
    connectionTimeoutMs: 10_000,
  };
}

function unmatched(accountHandle: string, threadId: string): InstagramCorrelationResult {
  return Object.freeze({
    status: 'UNMATCHED',
    method: null,
    manifestId: null,
    outreachEventId: null,
    prospectId: null,
    evidence: Object.freeze({
      channel: 'instagram' as const,
      threadId,
      senderHandle: HANDLE,
      accountHandle,
      threadBindings: Object.freeze([]),
      handleCandidates: Object.freeze([]),
      priorSendCount: 0,
      observation: Object.freeze({
        directionBasis: 'geometry' as const,
        occurrenceIndex: 0,
        receivedAtBasis: 'observed_at' as const,
        rowAgeMs: null,
        providerMessageId: null,
      }),
      notes: Object.freeze(['test de concurrence']),
    }),
  });
}

describeIfPostgres('IG5.1 §16 — PostgreSQL réel', () => {
  let a: Sql;
  let b: Sql;

  beforeAll(async () => {
    a = await createPostgresSql(config('ig5-inbound-a'));
    b = await createPostgresSql(config('ig5-inbound-b'));
    await migrate(a);
  }, 120_000);

  afterAll(async () => {
    await a.close();
    await b.close();
  });

  it('la migration 0042 s’applique et laisse les contraintes attendues', async () => {
    const rows = await a.query<{ conname: string; def: string }>(
      `select con.conname, pg_get_constraintdef(con.oid) as def
         from pg_constraint con
         join pg_class rel on rel.oid = con.conrelid
        where rel.relname = 'r6b_inbound_messages' and con.contype = 'c'
        order by con.conname`,
    );
    const byName = new Map(rows.map((row) => [row.conname, row.def]));

    // Le canal s'est ouvert d'exactement une valeur, et la liste reste fermée.
    expect(byName.get('r6b_inbound_messages_provider_check')).toMatch(/gmail/);
    expect(byName.get('r6b_inbound_messages_provider_check')).toMatch(/instagram/);
    // Le vocabulaire par canal est enfermé dans les deux sens.
    expect(byName.has('r6b_inbound_channel_vocabulary_is_coherent')).toBe(true);
    expect(byName.has('r6b_inbound_instagram_has_no_subject')).toBe(true);
    expect(byName.has('r6b_inbound_fingerprint_is_a_digest')).toBe(true);
    expect(byName.has('r6b_inbound_instagram_identifiers_are_handles')).toBe(true);

    // L'index d'idempotence de 0025 couvre le nouveau canal sans avoir bougé.
    const indexes = await a.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where tablename = 'r6b_inbound_messages'
          and indexname = 'r6b_inbound_messages_provider_message_idx'`,
    );
    expect(indexes[0]?.indexdef).toMatch(/UNIQUE/);
    expect(indexes[0]?.indexdef).toMatch(/provider.*mailbox.*provider_message_id/s);

    // Le verrou de relève est un index partiel, pas une convention applicative.
    const pollIndex = await a.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where tablename = 'ig_inbound_polls' and indexname = 'ig_inbound_polls_single_running_idx'`,
    );
    expect(pollIndex[0]?.indexdef).toMatch(/UNIQUE/);
    expect(pollIndex[0]?.indexdef).toMatch(/RUNNING/);
  });

  it('deux collecteurs simultanés : un seul obtient le tour', async () => {
    const account = uniqueAccount('ig5.race');
    const results = await Promise.allSettled([
      openInboundPoll(a, { accountHandle: account, polledBy: 'a', leaseMs: 300_000 }),
      openInboundPoll(b, { accountHandle: account, polledBy: 'b', leaseMs: 300_000 }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const lost = results.filter((result) => result.status === 'rejected');
    expect(lost).toHaveLength(1);
    // Le perdant est refusé PROPREMENT, avec un code — pas par une erreur brute
    // de contrainte remontée telle quelle.
    const rejection = lost[0] as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(InstagramInboundError);
    expect((rejection.reason as InstagramInboundError).code).toBe('IG_INBOUND_POLL_RUNNING');

    const rows = await a.query<{ n: string }>(
      `select count(*)::text as n from ig_inbound_polls where status = 'RUNNING' and account_handle = $1`,
      [account],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('deux comptes différents peuvent relever en même temps', async () => {
    // Le verrou porte sur le COMPTE, pas sur le rail : deux boîtes distinctes
    // n'ont aucune raison de s'attendre.
    await expect(
      Promise.all([
        openInboundPoll(a, { accountHandle: uniqueAccount('ig5.pa'), polledBy: 'a', leaseMs: 300_000 }),
        openInboundPoll(b, { accountHandle: uniqueAccount('ig5.pb'), polledBy: 'b', leaseMs: 300_000 }),
      ]),
    ).resolves.toHaveLength(2);
  });

  it('un tour au bail expiré est repris, sans jamais rouvrir le précédent', async () => {
    const account = uniqueAccount('ig5.lease');
    const first = await openInboundPoll(a, { accountHandle: account, polledBy: 'crashé', leaseMs: 30_000 });
    await a.query(`update ig_inbound_polls set lease_expires_at = now() - interval '1 hour' where id = $1`, [
      first,
    ]);

    const second = await openInboundPoll(b, { accountHandle: account, polledBy: 'repreneur', leaseMs: 300_000 });
    expect(second).not.toBe(first);

    const statuses = await a.query<{ id: string; status: string }>(
      `select id, status from ig_inbound_polls where account_handle = $1 order by started_at`,
      [account],
    );
    expect(statuses.map((row) => row.status)).toEqual(['FAILED', 'RUNNING']);
  });

  it('la même réponse écrite simultanément par deux processus reste une réponse', async () => {
    const account = uniqueAccount('ig5.dup');
    const threadId = '111';
    const text = 'Oui, ça m’intéresse.';
    const input = {
      accountHandle: account,
      threadId,
      senderHandle: HANDLE,
      fingerprint: instagramMessageFingerprint({
        accountHandle: account,
        threadId,
        senderHandle: HANDLE,
        occurrenceIndex: 0,
        text,
      }),
      receivedAt: new Date('2026-08-15T09:00:00Z'),
      bodyText: text,
      bodySha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      correlation: unmatched(account, threadId),
    };

    const [first, second] = await Promise.all([
      persistInstagramInboundMessage(a, input),
      persistInstagramInboundMessage(b, input),
    ]);

    // Les deux rendent le MÊME identifiant ; un seul a créé la ligne.
    expect(first.id).toBe(second.id);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);

    const rows = await a.query<{ n: string }>(
      `select count(*)::text as n from r6b_inbound_messages where provider = 'instagram' and mailbox = $1`,
      [account],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('dix écritures concurrentes de la même réponse ne produisent qu’une ligne', async () => {
    const account = uniqueAccount('ig5.ten');
    const threadId = '222';
    const text = 'ok';
    const input = {
      accountHandle: account,
      threadId,
      senderHandle: HANDLE,
      fingerprint: instagramMessageFingerprint({
        accountHandle: account,
        threadId,
        senderHandle: HANDLE,
        occurrenceIndex: 0,
        text,
      }),
      receivedAt: new Date('2026-08-15T09:00:00Z'),
      bodyText: text,
      bodySha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      correlation: unmatched(account, threadId),
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        persistInstagramInboundMessage(index % 2 === 0 ? a : b, input),
      ),
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it('un lecteur n’est jamais bloqué par un collecteur en cours d’écriture', async () => {
    // La situation réelle du runtime : le CRM lit pendant qu'une relève écrit.
    const account = uniqueAccount('ig5.mvcc');
    await a.transaction(async (tx) => {
      await openInboundPoll(tx, { accountHandle: account, polledBy: 'écrivain', leaseMs: 300_000 });
      const seen = await b.query<{ n: string }>(
        `select count(*)::text as n from ig_inbound_polls where account_handle = $1`,
        [account],
      );
      // MVCC : le lecteur voit l'état d'avant le commit, sans attendre.
      expect(seen[0]?.n).toBe('0');
    });

    const after = await b.query<{ n: string }>(
      `select count(*)::text as n from ig_inbound_polls where account_handle = $1`,
      [account],
    );
    expect(after[0]?.n).toBe('1');
  });
});
