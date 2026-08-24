import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresSql } from '@/lib/db/postgres';
import { migrate } from '@/lib/db/migrate';
import { recordChannelIdentityDecision, loadEffectiveChannelIdentityDecision } from '@/lib/pipeline/channelIdentity';
import type { PostgresConfig } from '@/lib/db/config';
import type { Sql } from '@/lib/db/sql';

/**
 * IG4.2 §9 — la migration 0040 et ses contraintes, sur un vrai PostgreSQL.
 *
 * Le reste de la suite tourne sur PGlite, qui est du vrai Postgres compilé en
 * WebAssembly et qui suffit pour la logique. Ce fichier existe pour la seule
 * chose que PGlite ne prouve pas : que la migration s'applique et que ses
 * contraintes tiennent sur le moteur que la production utilise réellement —
 * avant qu'elle ne soit appliquée à Supabase.
 *
 * Ignoré tant que `OUTBOUND_TEST_DATABASE_URL` ne désigne pas une base jetable,
 * pour que `npm test` reste vert sur une machine sans Postgres.
 * `scripts/pg17-local.sh init` en provisionne une.
 *
 * Ce fichier ne truncate rien : il crée ses propres lignes sous un slug qui
 * lui appartient et les retire à la fin, pour cohabiter avec
 * `postgresConcurrency.test.ts` sur la même base.
 */

const TEST_URL = process.env.OUTBOUND_TEST_DATABASE_URL;
const describeIfPostgres = TEST_URL ? describe : describe.skip;

function config(applicationName: string): PostgresConfig {
  return {
    backend: 'postgres',
    connectionString: TEST_URL as string,
    poolMax: 2,
    applicationName,
    ssl: 'disable',
    statementTimeoutMs: 0,
    idleTimeoutMs: 5_000,
    connectionTimeoutMs: 10_000,
  };
}

const SLUG = 'ig42-channel-identity';
const HANDLE = 'example_services_';
const OPERATOR = 'Operator Example';

describeIfPostgres('IG4.2 — migration 0040 sur PostgreSQL réel', () => {
  let sql: Sql;
  let prospectId: string;

  beforeAll(async () => {
    sql = await createPostgresSql(config('hermes-ig42-migration'));
    await migrate(sql);

    await sql.query(`delete from campaigns where slug = $1`, [SLUG]);
    const campaign = await sql.query<{ id: string }>(
      `insert into campaigns (slug, name, niche_key, config)
       values ($1, 'IG4.2 migration', 'example-services', '{}'::jsonb) returning id`,
      [SLUG],
    );
    const prospect = await sql.query<{ id: string }>(
      `insert into prospects (campaign_id, canonical_key, display_name, instagram_handle, identity_review)
       values ($1, $2, 'EXAMPLE SERVICES', $3, 'manual_review') returning id`,
      [campaign[0]!.id, `${SLUG}-prospect`, HANDLE],
    );
    prospectId = prospect[0]!.id;
  }, 60_000);

  afterAll(async () => {
    if (sql) {
      // Cascade : la décision part avec le prospect, le prospect avec la campagne.
      await sql.query(`delete from campaigns where slug = $1`, [SLUG]);
      await sql.close();
    }
  });

  it('s’applique, et ne crée aucune décision', async () => {
    const applied = await sql.query<{ version: string }>(
      `select version from schema_migrations where version = '0040_channel_identity_human_confirmation'`,
    );
    expect(applied).toHaveLength(1);

    const rows = await sql.query<{ n: string }>(
      `select count(*) as n from channel_identity_decisions where prospect_id = $1`,
      [prospectId],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('refuse une décision hors du vocabulaire fermé', async () => {
    await expect(
      sql.query(
        `insert into channel_identity_decisions
           (prospect_id, transport, recipient, decision, reason, reason_sha256, decided_by)
         values ($1,'instagram_dm',$2,'MAYBE','motif',repeat('a',64),$3)`,
        [prospectId, HANDLE, OPERATOR],
      ),
    ).rejects.toThrow(/channel_identity_decisions_decision_check|check constraint/i);
  });

  it('refuse un transport hors taxonomie, une empreinte mal formée et une URL non http', async () => {
    const insert = (transport: string, sha: string, url: string | null) =>
      sql.query(
        `insert into channel_identity_decisions
           (prospect_id, transport, recipient, decision, reason, reason_sha256, evidence_url, decided_by)
         values ($1,$2,$3,'CONFIRMED','motif',$4,$5,$6)`,
        [prospectId, transport, HANDLE, sha, url, OPERATOR],
      );

    await expect(insert('carrier_pigeon', 'a'.repeat(64), null)).rejects.toThrow(/check constraint/i);
    await expect(insert('instagram_dm', 'PAS-UNE-EMPREINTE', null)).rejects.toThrow(/check constraint/i);
    await expect(insert('instagram_dm', 'b'.repeat(64), 'javascript:alert(1)')).rejects.toThrow(/check constraint/i);
  });

  it('refuse une décision sans auteur, sans motif, ou sur un prospect inexistant', async () => {
    const insert = (prospect: string, reason: string, by: string | null) =>
      sql.query(
        `insert into channel_identity_decisions
           (prospect_id, transport, recipient, decision, reason, reason_sha256, decided_by)
         values ($1,'instagram_dm',$2,'CONFIRMED',$3,repeat('c',64),$4)`,
        [prospect, HANDLE, reason, by],
      );

    await expect(insert(prospectId, '   ', OPERATOR)).rejects.toThrow(/check constraint/i);
    await expect(insert(prospectId, 'motif', null)).rejects.toThrow(/not-null|null value/i);
    await expect(
      insert('00000000-0000-0000-0000-000000000000', 'motif', OPERATOR),
    ).rejects.toThrow(/foreign key/i);
  });

  it('l’index de rejeu refuse la même décision, mot pour mot, deux fois', async () => {
    const first = await recordChannelIdentityDecision(sql, {
      prospectId,
      transport: 'instagram_dm',
      recipient: HANDLE,
      decision: 'CONFIRMED',
      reason: 'le site officiel publie un CTA vers ce compte',
      evidenceUrl: 'https://www.instagram.com/example_services_/',
      decidedBy: OPERATOR,
    });
    expect(first.created).toBe(true);

    // Directement en SQL, pour éprouver l'index plutôt que la garde applicative
    // — y compris pour une graphie de casse différente du même compte.
    await expect(
      sql.query(
        `insert into channel_identity_decisions
           (prospect_id, transport, recipient, decision, reason, reason_sha256, decided_by)
         values ($1,'instagram_dm',$2,$3,$4,$5,$6)`,
        [
          prospectId,
          'Demo_Account_A_',
          first.decision.decision,
          first.decision.reason,
          first.decision.reasonSha256,
          'Quelqu’un d’autre',
        ],
      ),
    ).rejects.toThrow(/channel_identity_decisions_replay/i);

    // …et la lecture du gate, insensible à la casse elle aussi.
    const effective = await loadEffectiveChannelIdentityDecision(sql, {
      prospectId,
      transport: 'instagram_dm',
      recipient: '@Demo_Account_A_'.replace('@', ''),
    });
    expect(effective?.id).toBe(first.decision.id);
  });

  it('un changement d’avis s’inscrit, et c’est le dernier qui fait foi', async () => {
    await recordChannelIdentityDecision(sql, {
      prospectId,
      transport: 'instagram_dm',
      recipient: HANDLE,
      decision: 'REJECTED',
      reason: 'vérification manuelle : le CTA pointait vers un compte de réseau',
      decidedBy: OPERATOR,
    });

    const effective = await loadEffectiveChannelIdentityDecision(sql, {
      prospectId,
      transport: 'instagram_dm',
      recipient: HANDLE,
    });
    expect(effective?.decision).toBe('REJECTED');

    const all = await sql.query<{ n: string }>(
      `select count(*) as n from channel_identity_decisions where prospect_id = $1`,
      [prospectId],
    );
    expect(Number(all[0]!.n)).toBe(2);
  });
});
