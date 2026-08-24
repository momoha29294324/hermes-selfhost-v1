import { describe, expect, it } from 'vitest';
import { ModelRouter, hashRequest, timeoutForAttempt } from '@/lib/models/router';
import { createLogger } from '@/lib/logging/logger';
import { EMPTY_USAGE, LlmError, type LlmProvider } from '@/lib/models/types';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRoute, ModelRoutingConfig } from '@/lib/config/schema';
import type { Sql } from '@/lib/db/sql';

const logger = createLogger({ test: 'llm-instrumentation' });

const routing: ModelRoutingConfig = {
  version: 'test',
  declaredEfforts: ['low', 'high'],
  defaultRoute: { provider: 'codex', model: 'default-model', effort: 'low', timeoutMs: 1000, maxAttempts: 2 },
  tasks: {},
};

/**
 * R5 reported two timeouts on a corpus that had paid for about sixteen: a run
 * that timed out once and succeeded on retry was written as a plain success,
 * and the 180 seconds burnt by the first attempt existed nowhere. These tests
 * pin the finer ledger that makes the benchmark's timeout numbers trustworthy.
 */
describe('per-attempt instrumentation', () => {
  function provider(script: ('ok' | 'timeout' | 'boom')[]): LlmProvider {
    let call = 0;
    return {
      name: 'codex',
      availability: () => ({ ok: true }),
      generate: async () => {
        const step = script[call] ?? 'ok';
        call += 1;
        if (step === 'timeout') throw new LlmError('codex exec timed out after 1000ms', 'timeout');
        if (step === 'boom') throw new LlmError('exploded', 'provider_error');
        return {
          text: '{"ok":true}',
          usage: { ...EMPTY_USAGE, tokensInput: 900, tokensCachedInput: 700, tokensOutput: 40 },
        };
      },
    };
  }

  it('records the timed-out attempt of a run that eventually succeeded', async () => {
    const router = new ModelRouter({
      sql: null,
      logger,
      routing,
      providers: { codex: provider(['timeout', 'ok']) },
    });
    const outcome = await router.run({ task: 'research', prompt: 'x' }, (value) => value);

    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0]?.status).toBe('timeout');
    expect(outcome.attempts[1]?.status).toBe('ok');
  });

  it('separates an invalid answer from a provider failure', async () => {
    const router = new ModelRouter({
      sql: null,
      logger,
      routing,
      providers: {
        codex: {
          name: 'codex',
          availability: () => ({ ok: true }),
          generate: async () => ({ text: 'pas du json' }),
        },
      },
    });
    const outcome = await router.run(
      { task: 'research', prompt: 'x', schema: { type: 'object' } },
      (value) => value,
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts.every((entry) => entry.status === 'invalid_output')).toBe(true);
    expect(outcome.attempts[0]?.schemaValid).toBe(false);
  });

  it('carries the usage of the successful attempt', async () => {
    const router = new ModelRouter({
      sql: null,
      logger,
      routing,
      providers: { codex: provider(['ok']) },
    });
    const outcome = await router.run({ task: 'research', prompt: 'x' }, (value) => value);
    expect(outcome.usage.tokensInput).toBe(900);
    expect(outcome.usage.tokensCachedInput).toBe(700);
  });

  it('stops after an unavailable provider instead of retrying it', async () => {
    const router = new ModelRouter({
      sql: null,
      logger,
      routing,
      providers: {
        codex: {
          name: 'codex',
          availability: () => ({ ok: true }),
          generate: async () => {
            throw new LlmError('binary missing', 'unavailable');
          },
        },
      },
    });
    const outcome = await router.run({ task: 'research', prompt: 'x' }, (value) => value);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0]?.status).toBe('unavailable');
  });
});

describe('llm_attempts persistence', () => {
  async function withDb(fn: (sql: Sql) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-attempts-'));
    const sql = await createPgliteSql(dir);
    try {
      await migrate(sql);
      await fn(sql);
    } finally {
      await sql.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('writes one row per attempt and summarises them on the run', async () => {
    await withDb(async (sql) => {
      let call = 0;
      const router = new ModelRouter({
        sql,
        logger,
        routing,
        providers: {
          codex: {
            name: 'codex',
            availability: () => ({ ok: true }),
            generate: async () => {
              call += 1;
              if (call === 1) throw new LlmError('codex exec timed out after 1000ms', 'timeout');
              return {
                text: '{"ok":true}',
                usage: { ...EMPTY_USAGE, tokensInput: 1200, tokensOutput: 55, tokensReasoning: 30 },
              };
            },
          },
        },
      });

      const outcome = await router.run({ task: 'research', prompt: 'x' }, (value) => value);
      expect(outcome.ok).toBe(true);

      const runs = await sql.query<{ status: string; attempts: number; timeouts: number; tokens_input: number }>(
        'select status, attempts, timeouts, tokens_input from model_runs',
      );
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('ok');
      expect(runs[0]?.attempts).toBe(2);
      // The point of the whole migration: a success that cost a timeout says so.
      expect(runs[0]?.timeouts).toBe(1);
      expect(runs[0]?.tokens_input).toBe(1200);

      const attempts = await sql.query<{ attempt: number; status: string }>(
        'select attempt, status from llm_attempts order by attempt',
      );
      expect(attempts.map((row) => row.status)).toEqual(['timeout', 'ok']);
    });
  });

  it('records the attempts of a run that never succeeded', async () => {
    await withDb(async (sql) => {
      const router = new ModelRouter({
        sql,
        logger,
        routing,
        providers: {
          codex: {
            name: 'codex',
            availability: () => ({ ok: true }),
            generate: async () => {
              throw new LlmError('codex exec timed out after 1000ms', 'timeout');
            },
          },
        },
      });
      await router.run({ task: 'research', prompt: 'x' }, (value) => value);

      const runs = await sql.query<{ status: string; timeouts: number }>(
        'select status, timeouts from model_runs',
      );
      expect(runs[0]?.status).toBe('timeout');
      expect(runs[0]?.timeouts).toBe(2);

      const attempts = await sql.query<{ count: string }>(
        "select count(*)::text as count from llm_attempts where status = 'timeout'",
      );
      expect(attempts[0]?.count).toBe('2');
    });
  });
});

describe('timeoutForAttempt', () => {
  const base: ModelRoute = {
    provider: 'codex',
    model: 'm',
    effort: 'low',
    timeoutMs: 180_000,
    maxAttempts: 2,
  };

  it('gives every attempt the flat timeout when no schedule is configured', () => {
    expect(timeoutForAttempt(base, 1)).toBe(180_000);
    expect(timeoutForAttempt(base, 2)).toBe(180_000);
  });

  it('follows the schedule, so a retry can be shorter than the attempt it replaces', () => {
    const route: ModelRoute = { ...base, timeoutScheduleMs: [120_000, 90_000] };
    expect(timeoutForAttempt(route, 1)).toBe(120_000);
    expect(timeoutForAttempt(route, 2)).toBe(90_000);
  });

  it('reuses the last scheduled value rather than falling back to the longer default', () => {
    const route: ModelRoute = { ...base, maxAttempts: 3, timeoutScheduleMs: [120_000, 90_000] };
    expect(timeoutForAttempt(route, 3)).toBe(90_000);
  });
});

describe('hashRequest', () => {
  const route: ModelRoute = {
    provider: 'codex',
    model: 'm',
    effort: 'low',
    timeoutMs: 1000,
    maxAttempts: 1,
  };

  it('separates two calls that differ only by their output schema', () => {
    // R5's hash ignored the schema. Two benchmark variants differing only in the
    // shape they demand would have shared a cache entry, and one would have been
    // credited with the other's answer.
    const a = hashRequest(route, { task: 't', prompt: 'p', schema: { type: 'object' } });
    const b = hashRequest(route, { task: 't', prompt: 'p', schema: { type: 'array' } });
    expect(a).not.toBe(b);
  });

  it('separates two models given the same prompt', () => {
    const a = hashRequest(route, { task: 't', prompt: 'p' });
    const b = hashRequest({ ...route, model: 'other' }, { task: 't', prompt: 'p' });
    expect(a).not.toBe(b);
  });

  it('is stable for identical inputs, which is what makes resume safe', () => {
    const a = hashRequest(route, { task: 't', prompt: 'p', system: 's' });
    const b = hashRequest(route, { task: 't', prompt: 'p', system: 's' });
    expect(a).toBe(b);
  });
});
