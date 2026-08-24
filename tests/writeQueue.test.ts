import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WriteQueue, serialized, isReadOnly } from '@/lib/db/writeQueue';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import type { Sql } from '@/lib/db/sql';

/**
 * §18 : la concurrence LLM ne doit pas introduire de contention DB.
 *
 * PGlite est un Postgres embarqué mono-instance : deux transactions concurrentes
 * ne font pas la queue, elles s'imbriquent. Ces tests fixent la seule règle qui
 * rende la concurrence applicative sûre — un writer, quel que soit l'amont.
 */
describe('isReadOnly', () => {
  it('lets plain reads through', () => {
    expect(isReadOnly('select 1')).toBe(true);
    expect(isReadOnly('  SELECT * from prospects')).toBe(true);
    expect(isReadOnly('explain select 1')).toBe(true);
  });

  it('queues every write', () => {
    expect(isReadOnly('insert into t values (1)')).toBe(false);
    expect(isReadOnly('update t set a = 1')).toBe(false);
    expect(isReadOnly('delete from t')).toBe(false);
  });

  it('does not mistake a writing CTE for a read', () => {
    // `with ... insert ... returning` starts with `with` and writes. Reading the
    // first keyword alone would let it escape the queue.
    expect(isReadOnly('with x as (insert into t values (1) returning id) select * from x')).toBe(false);
  });
});

describe('WriteQueue', () => {
  it('runs writes one at a time, in the order they were asked for', async () => {
    const queue = new WriteQueue({} as Sql);
    const order: number[] = [];
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      [30, 5, 20, 1, 10].map((delay, index) =>
        queue.enqueue(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, delay));
          order.push(index);
          active -= 1;
        }),
      ),
    );

    expect(maxActive).toBe(1);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('survives a failing write instead of poisoning the chain', async () => {
    const queue = new WriteQueue({} as Sql);
    const failing = queue.enqueue(async () => {
      throw new Error('insert exploded');
    });

    await expect(failing).rejects.toThrow('insert exploded');
    // The caller sees its own error; the next writer must still run.
    await expect(queue.enqueue(async () => 'ok')).resolves.toBe('ok');
  });

  it('reports the deepest contention it saw', async () => {
    const queue = new WriteQueue({} as Sql);
    const writes = [1, 2, 3, 4].map(() => queue.enqueue(async () => undefined));
    expect(queue.depth).toBe(4);
    await Promise.all(writes);
    expect(queue.peakDepth).toBe(4);
    expect(queue.depth).toBe(0);
  });
});

describe('serialized', () => {
  async function withDb(fn: (sql: Sql) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-writequeue-'));
    const sql = await createPgliteSql(dir);
    try {
      await migrate(sql);
      await fn(sql);
    } finally {
      await sql.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('keeps concurrent inserts intact and loses none', async () => {
    await withDb(async (sql) => {
      const queue = new WriteQueue(sql);
      const guarded = serialized(sql, queue);

      // 40 concurrent writers is well past anything the concurrency benchmark
      // will produce; if the queue is right, none of them can trample another.
      await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          guarded.query(
            `insert into audit_events (actor, action, entity_type, entity_id, data)
             values ('test', 'bench.write', 'probe', $1, '{}'::jsonb)`,
            [`probe-${index}`],
          ),
        ),
      );
      await queue.drain();

      const rows = await sql.query<{ count: string }>(
        "select count(*)::text as count from audit_events where action = 'bench.write'",
      );
      expect(rows[0]?.count).toBe('40');
      expect(queue.peakDepth).toBeGreaterThan(1);
    });
  });

  it('does not queue reads, so a concurrency benchmark measures the models', async () => {
    await withDb(async (sql) => {
      const queue = new WriteQueue(sql);
      const guarded = serialized(sql, queue);
      await Promise.all(Array.from({ length: 5 }, () => guarded.query('select 1 as one')));
      expect(queue.peakDepth).toBe(0);
    });
  });
});
