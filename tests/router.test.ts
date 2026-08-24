import { describe, expect, it, vi } from 'vitest';
import { ModelRouter, extractJson } from '@/lib/models/router';
import { createLogger } from '@/lib/logging/logger';
import { LlmError, type LlmProvider } from '@/lib/models/types';
import type { ModelRoutingConfig } from '@/lib/config/schema';
import { loadModelRouting } from '@/lib/config/load';

const logger = createLogger({ test: 'router' });

const routing: ModelRoutingConfig = {
  version: 'test',
  declaredEfforts: ['low', 'high'],
  defaultRoute: { provider: 'codex', model: 'default-model', effort: 'low', timeoutMs: 1000, maxAttempts: 2 },
  tasks: {
    research: { provider: 'codex', model: 'big-model', effort: 'high', timeoutMs: 2000, maxAttempts: 1 },
    dedupe: { provider: 'none', model: 'deterministic', effort: null, timeoutMs: 1000, maxAttempts: 1 },
  },
};

function providerReturning(text: string, failures = 0): LlmProvider {
  let calls = 0;
  return {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async () => {
      calls += 1;
      if (calls <= failures) throw new LlmError('transient', 'provider_error');
      return { text };
    },
  };
}

describe('extractJson', () => {
  it('parses bare JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses fenced JSON', () => {
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('parses JSON embedded in prose', () => {
    expect(extractJson('Voici la réponse : {"a":3} — voilà.')).toEqual({ a: 3 });
  });

  it('throws rather than guessing when there is no JSON', () => {
    expect(() => extractJson('pas de json ici')).toThrow(LlmError);
  });
});

describe('ModelRouter.routeFor', () => {
  const router = new ModelRouter({ sql: null, logger, routing, providers: {} });

  it('uses the per-task override', () => {
    expect(router.routeFor('research')).toMatchObject({ model: 'big-model', effort: 'high' });
  });

  it('falls back to the default route for unknown tasks', () => {
    expect(router.routeFor('unknown')).toMatchObject({ model: 'default-model', effort: 'low' });
  });

  it('honours a deterministic route', () => {
    expect(router.routeFor('dedupe').provider).toBe('none');
  });
});

describe('ModelRouter.run', () => {
  it('parses a successful structured answer', async () => {
    const router = new ModelRouter({
      sql: null,
      logger,
      routing,
      providers: { codex: providerReturning('{"verdict":"in_niche"}') },
    });
    const result = await router.run({ task: 'classification', prompt: 'x' }, (value) => value as { verdict: string });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ verdict: 'in_niche' });
    expect(router.callCount).toBe(1);
  });

  it('retries once then succeeds, within maxAttempts', async () => {
    const router = new ModelRouter({
      sql: null,
      logger,
      routing,
      providers: { codex: providerReturning('{"ok":true}', 1) },
    });
    const result = await router.run({ task: 'classification', prompt: 'x' }, (value) => value);
    expect(result.ok).toBe(true);
    expect(router.callCount).toBe(2);
  });

  it('never throws when the provider keeps failing', async () => {
    const router = new ModelRouter({
      sql: null,
      logger,
      routing,
      providers: { codex: providerReturning('{"ok":true}', 99) },
    });
    const result = await router.run({ task: 'classification', prompt: 'x' }, (value) => value);
    expect(result.ok).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it('skips a deterministic route without calling any provider', async () => {
    const generate = vi.fn();
    const router = new ModelRouter({
      sql: null,
      logger,
      routing,
      providers: { codex: { name: 'codex', availability: () => ({ ok: true }), generate } },
    });
    const result = await router.run({ task: 'dedupe', prompt: 'x' }, (value) => value);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('route_none');
    expect(generate).not.toHaveBeenCalled();
  });

  it('stops calling once the run budget is spent', async () => {
    const router = new ModelRouter({
      sql: null,
      logger,
      routing,
      maxCalls: 1,
      providers: { codex: providerReturning('{"ok":true}') },
    });
    await router.run({ task: 'classification', prompt: 'x' }, (value) => value);
    const second = await router.run({ task: 'classification', prompt: 'y' }, (value) => value);
    expect(second.error).toBe('budget_exhausted');
  });

  it('reports an unavailable provider instead of pretending', async () => {
    const router = new ModelRouter({
      sql: null,
      logger,
      routing,
      providers: {
        codex: {
          name: 'codex',
          availability: () => ({ ok: false, reason: 'no credentials' }),
          generate: async () => ({ text: '{}' }),
        },
      },
    });
    const result = await router.run({ task: 'classification', prompt: 'x' }, (value) => value);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no credentials');
  });
});

describe('shipped model routing config', () => {
  it('parses and declares no hardcoded model outside config', () => {
    const config = loadModelRouting();
    expect(config.defaultRoute.model.length).toBeGreaterThan(0);
    expect(Object.keys(config.tasks)).toContain('message');
    expect(config.tasks['discovery']?.provider).toBe('none');
  });
});
