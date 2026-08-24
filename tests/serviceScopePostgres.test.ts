import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresSql } from '@/lib/db/postgres';
import { migrate } from '@/lib/db/migrate';
import type { PostgresConfig } from '@/lib/db/config';
import type { Sql } from '@/lib/db/sql';

/**
 * HERMES-CLEANING-ONLY-ICP-R1 §29 — la migration 0052 et ses contraintes, sur
 * un vrai PostgreSQL.
 *
 * Le reste de la suite tourne sur PGlite, qui est du vrai Postgres compilé en
 * WebAssembly et qui suffit pour la logique. Ce fichier existe pour la seule
 * chose que PGlite ne prouve pas : que la migration s'applique et que ses
 * contraintes TIENNENT sur le moteur que la production utilise — c'est-à-dire
 * qu'elles REFUSENT ce qu'elles prétendent refuser.
 *
 * Une contrainte qu'on n'a jamais vue échouer n'est pas une contrainte
 * vérifiée : c'est une contrainte espérée. Chaque test ci-dessous provoque donc
 * l'échec, et le teste.
 *
 * Ignoré tant que `OUTBOUND_TEST_DATABASE_URL` ne désigne pas une base jetable,
 * pour que `npm test` reste vert sur une machine sans Postgres.
 * `scripts/pg17-local.sh init` en provisionne une.
 *
 * Ce fichier ne truncate rien : il crée ses propres lignes sous des clés qui
 * lui appartiennent et les retire à la fin, pour cohabiter avec les autres
 * tests Postgres sur la même base.
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

const SLUG = 'cleaning-only-r1-migration';
const KEY_PREFIX = 'registry_id:CLEANINGR1';

describeIfPostgres('HERMES-CLEANING-ONLY-ICP-R1 — migration 0052 sur PostgreSQL réel', () => {
  let sql: Sql;
  let campaignId: string;
  let prospectId: string;
  let manifestId: string | null = null;

  beforeAll(async () => {
    sql = await createPostgresSql(config('hermes-cleaning-only-migration'));
    await migrate(sql);

    await sql.query(`delete from business_entities where canonical_key like $1`, [`${KEY_PREFIX}%`]);
    await sql.query(
      `delete from prospects where campaign_id in (select id from campaigns where slug = $1)`,
      [SLUG],
    );
    await sql.query(`delete from campaigns where slug = $1`, [SLUG]);

    const campaign = await sql.query<{ id: string }>(
      `insert into campaigns (slug, name, niche_key, config)
       values ($1, 'Cleaning-only migration', 'example-services', '{}'::jsonb) returning id`,
      [SLUG],
    );
    campaignId = campaign[0]!.id;

    const prospect = await sql.query<{ id: string }>(
      `insert into prospects (campaign_id, canonical_key, display_name, stage)
       values ($1, $2, 'ATELIER MIGRATION 0052', 'qualified') returning id`,
      [campaignId, `${SLUG}-prospect`],
    );
    prospectId = prospect[0]!.id;
  });

  afterAll(async () => {
    if (manifestId !== null) {
      await sql.query(`delete from ig_enqueue_decisions where manifest_id = $1`, [manifestId]);
      await sql.query(`delete from ig_job_events where manifest_id = $1`, [manifestId]);
      await sql.query(`delete from ig_dispatch_jobs where manifest_id = $1`, [manifestId]);
      await sql.query(`delete from r6b_dispatch_manifests where id = $1`, [manifestId]);
    }
    await sql.query(
      `delete from r6b_batch_votes where item_id in (
         select i.id from r6b_batch_items i join r6b_batches b on b.id = i.batch_id where b.slug = $1)`,
      [`${SLUG}-batch`],
    );
    await sql.query(
      `delete from r6b_batch_items where batch_id in (select id from r6b_batches where slug = $1)`,
      [`${SLUG}-batch`],
    );
    await sql.query(`delete from r6b_batches where slug = $1`, [`${SLUG}-batch`]);
    await sql.query(`update prospects set business_entity_id = null where campaign_id = $1`, [campaignId]);
    await sql.query(`delete from business_entities where canonical_key like $1`, [`${KEY_PREFIX}%`]);
    await sql.query(`delete from prospects where campaign_id = $1`, [campaignId]);
    await sql.query(`delete from campaigns where id = $1`, [campaignId]);
    await sql.close();
  });

  // -------------------------------------------------------------------------
  // 1. Le vocabulaire de refus élargi
  // -------------------------------------------------------------------------

  it('les deux nouveaux motifs sont ENTRÉS dans le vocabulaire fermé des deux tables', async () => {
    const rows = await sql.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def
         from pg_constraint
        where conname in ('ig_dispatch_jobs_last_skip_reason_check', 'ig_job_events_skip_reason_check')`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.def, row.conname).toContain('service_scope_not_in_scope_only');
      expect(row.def, row.conname).toContain('market_scope_unknown');
      // Les motifs d'avant n'ont pas été perdus au passage : une migration qui
      // réécrit une liste peut en faire tomber un, et personne ne le verrait.
      expect(row.def, row.conname).toContain('audience_out_of_scope');
      expect(row.def, row.conname).toContain('icp_not_target');
      expect(row.def, row.conname).toContain('opt_out');
    }
  });

  it('la base REFUSE un motif inventé', async () => {
    await expect(
      sql.query(
        `insert into ig_job_events (job_id, manifest_id, prospect_id, worker_id, mode, status,
                                    reason_code, idempotency_key, gates, external_effect_attempted,
                                    skip_reason, skip_class)
         values (null, null, $1, 'test', 'DRY_RUN', 'SKIPPED', 'IG_AUTONOMOUS_POLICY_REFUSED',
                 $2, '[]'::jsonb, false, 'sells_revente_probably', 'TERMINAL')`,
        [prospectId, `${SLUG}-invented`],
      ),
    ).rejects.toThrow();
  });

  it('la base REFUSE un motif TERMINAL sur un job resté réclamable', async () => {
    // `ig_job_terminal_skip_is_absorbing` (0039), éprouvée sur le nouveau motif :
    // c'est elle qui rend impossible de « juste reporter » un refus définitif.
    // Le manifeste est construit en entier — batch, item, vote — parce que la
    // contrainte qu'on veut falsifier vit sur `ig_dispatch_jobs`, qui n'existe
    // pas sans lui. Aucun raccourci : ce sont les tables de production.
    const batch = await sql.query<{ id: string }>(
      `insert into r6b_batches (slug, campaign_id) values ($1, $2) returning id`,
      [`${SLUG}-batch`, campaignId],
    );
    const item = await sql.query<{ id: string }>(
      `insert into r6b_batch_items (batch_id, prospect_id, item_index, original_draft)
       values ($1, $2, 1, 'Bonjour, une question rapide ?') returning id`,
      [batch[0]!.id, prospectId],
    );
    const vote = await sql.query<{ id: string }>(
      `insert into r6b_batch_votes (item_id, verdict, approved, approved_text, approved_at, actor_kind)
       values ($1, 'SEND', true, 'Bonjour, une question rapide ?', now(), 'HUMAN') returning id`,
      [item[0]!.id],
    );
    const manifest = await sql.query<{ id: string }>(
      `insert into r6b_dispatch_manifests
         (batch_id, batch_item_id, prospect_id, approval_vote_id, business_name, channel, recipient,
          recipient_provenance, identity_review, approved_text, approved_text_sha256,
          recipient_evidence_ids, transport, transport_payload, transport_payload_sha256, status)
       values ($1, $2, $3, $4, 'ATELIER MIGRATION 0052', 'instagram', 'atelier_migration_0052',
               '{"source":"suite de tests 0052"}'::jsonb, 'confirmed', 'Bonjour, une question rapide ?', repeat('a', 64),
               '["evidence-0052"]'::jsonb, 'instagram_dm', '{}'::jsonb, repeat('b', 64), 'LOCKED')
       returning id`,
      [batch[0]!.id, item[0]!.id, prospectId, vote[0]!.id],
    );
    manifestId = manifest[0]!.id;

    const job = await sql.query<{ id: string }>(
      `insert into ig_dispatch_jobs
         (manifest_id, prospect_id, action, idempotency_key, expected_handle,
          approved_text_sha256, transport_payload_sha256, status, enqueued_by)
       values ($1, $2, 'first_touch_dm', $3, 'atelier_migration_0052',
               repeat('a', 64), repeat('b', 64), 'PENDING', 'suite de tests 0052')
       returning id`,
      [manifestId, prospectId, `${SLUG}-job`],
    );
    const jobId = job[0]!.id;

    await expect(
      sql.query(
        `update ig_dispatch_jobs
            set last_skip_reason = 'service_scope_not_in_scope_only', last_skip_class = 'TERMINAL'
          where id = $1`,
        [jobId],
      ),
    ).rejects.toThrow();

    // `market_scope_unknown` est TEMPORAIRE : lui, la base l'accepte sur un
    // job réclamable, et c'est exactement la distinction qu'on veut tenir.
    await sql.query(
      `update ig_dispatch_jobs
          set last_skip_reason = 'market_scope_unknown', last_skip_class = 'TEMPORARY'
        where id = $1`,
      [jobId],
    );

    // Et un INELIGIBLE doit nommer sa raison ET n'avoir rien tenté.
    await expect(
      sql.query(
        `update ig_dispatch_jobs
            set status = 'INELIGIBLE', terminated_at = now(),
                last_skip_reason = 'service_scope_not_in_scope_only', last_skip_class = 'TERMINAL',
                external_effect_attempted = true
          where id = $1`,
        [jobId],
      ),
    ).rejects.toThrow();

    await sql.query(
      `update ig_dispatch_jobs
          set status = 'INELIGIBLE', terminated_at = now(),
              last_skip_reason = 'service_scope_not_in_scope_only', last_skip_class = 'TERMINAL'
        where id = $1`,
      [jobId],
    );
    const rows = await sql.query<{ status: string; effect: boolean }>(
      `select status, external_effect_attempted as effect from ig_dispatch_jobs where id = $1`,
      [jobId],
    );
    expect(rows[0]!.status).toBe('INELIGIBLE');
    expect(rows[0]!.effect).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 2. L'entité métier
  // -------------------------------------------------------------------------

  it('la clé canonique doit porter son GENRE', async () => {
    await expect(
      sql.query(`insert into business_entities (canonical_key) values ($1)`, ['484122452']),
    ).rejects.toThrow();
    await expect(
      sql.query(`insert into business_entities (canonical_key) values ($1)`, ['phone:0601020304']),
    ).rejects.toThrow();
  });

  it('deux entités ne peuvent pas porter la même clé', async () => {
    const key = `${KEY_PREFIX}-unique`;
    await sql.query(`insert into business_entities (canonical_key) values ($1)`, [key]);
    await expect(
      sql.query(`insert into business_entities (canonical_key) values ($1)`, [key]),
    ).rejects.toThrow();
  });

  it('un prospect ne peut pointer que vers une entité EXISTANTE', async () => {
    await expect(
      sql.query(
        `update prospects set business_entity_id = '00000000-0000-0000-0000-000000000000'::uuid where id = $1`,
        [prospectId],
      ),
    ).rejects.toThrow();
  });

  it('le rattachement fonctionne, et n’altère ni dedupe_status ni merged_into_id', async () => {
    const before = await sql.query<{ dedupe: string; merged: string | null }>(
      `select dedupe_status as dedupe, merged_into_id as merged from prospects where id = $1`,
      [prospectId],
    );
    const entity = await sql.query<{ id: string }>(
      `insert into business_entities (canonical_key) values ($1) returning id`,
      [`${KEY_PREFIX}-link`],
    );
    await sql.query(`update prospects set business_entity_id = $1 where id = $2`, [entity[0]!.id, prospectId]);

    const after = await sql.query<{ dedupe: string; merged: string | null; entity: string | null }>(
      `select dedupe_status as dedupe, merged_into_id as merged, business_entity_id as entity
         from prospects where id = $1`,
      [prospectId],
    );
    expect(after[0]!.entity).toBe(entity[0]!.id);
    expect(after[0]!.dedupe).toBe(before[0]!.dedupe);
    expect(after[0]!.merged).toBe(before[0]!.merged);
  });
});
