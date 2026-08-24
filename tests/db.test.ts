import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import type { Sql } from '@/lib/db/sql';

let sql: Sql;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-db-'));
  sql = await createPgliteSql(join(dir, 'pgdata'));
  await migrate(sql);
}, 120_000);

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('driver typing', () => {
  it('returns numeric columns as numbers, matching the domain types', async () => {
    const rows = await sql.query<{ n: unknown; i: unknown; f: unknown }>(
      'select 0.90::numeric(3,2) as n, 42::integer as i, 1.5::double precision as f',
    );
    expect(typeof rows[0]?.n).toBe('number');
    expect(rows[0]?.n).toBeCloseTo(0.9);
    expect(typeof rows[0]?.i).toBe('number');
    expect(typeof rows[0]?.f).toBe('number');
  });

  it('round-trips a prospect confidence as a number', async () => {
    const campaign = await sql.query<{ id: string }>(
      `insert into campaigns (slug, name, niche_key, config)
       values ('typing','Typing','example-services','{}'::jsonb) returning id`,
    );
    await sql.query(
      `insert into prospects (campaign_id, canonical_key, display_name, niche_verdict, niche_confidence, score)
       values ($1,'k','N','in_niche',0.93,77)`,
      [campaign[0]!.id],
    );
    const rows = await sql.query<{ niche_confidence: unknown; score: unknown }>(
      'select niche_confidence, score from prospects where canonical_key = $1',
      ['k'],
    );
    expect(typeof rows[0]?.niche_confidence).toBe('number');
    expect((rows[0]?.niche_confidence as number).toFixed(2)).toBe('0.93');
    expect(rows[0]?.score).toBe(77);
  });
});

describe('transactions', () => {
  it('rolls back on throw', async () => {
    await expect(
      sql.transaction(async (tx) => {
        await tx.query(
          `insert into campaigns (slug, name, niche_key, config) values ('rollback','R','example-services','{}'::jsonb)`,
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const rows = await sql.query('select 1 from campaigns where slug = $1', ['rollback']);
    expect(rows).toHaveLength(0);
  });
});

describe('schema guarantees', () => {
  it('refuses an out-of-range score', async () => {
    const campaign = await sql.query<{ id: string }>(
      `insert into campaigns (slug, name, niche_key, config)
       values ('range','Range','example-services','{}'::jsonb) returning id`,
    );
    await expect(
      sql.query(
        `insert into prospects (campaign_id, canonical_key, display_name, score) values ($1,'x','X',150)`,
        [campaign[0]!.id],
      ),
    ).rejects.toThrow();
  });

  it('keeps canonical_key unique per campaign', async () => {
    const campaign = await sql.query<{ id: string }>(
      `insert into campaigns (slug, name, niche_key, config)
       values ('uniq','U','example-services','{}'::jsonb) returning id`,
    );
    await sql.query(
      `insert into prospects (campaign_id, canonical_key, display_name) values ($1,'dup','A')`,
      [campaign[0]!.id],
    );
    await expect(
      sql.query(`insert into prospects (campaign_id, canonical_key, display_name) values ($1,'dup','B')`, [
        campaign[0]!.id,
      ]),
    ).rejects.toThrow();
  });

  it('ships exactly one approved case study, with no invented metric', async () => {
    const rows = await sql.query<{ key: string; claim: string; metrics: unknown[] }>(
      'select key, claim, metrics from case_studies where is_approved = true',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.claim).toContain('3 500');
    expect(rows[0]?.metrics).toEqual([]);
  });
});
