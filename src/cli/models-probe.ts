#!/usr/bin/env tsx
/**
 * Detects what the installed providers actually support instead of assuming it.
 * Each (provider, model, effort) combination declared in config/models.json is
 * exercised with a trivial structured request; the result lands in
 * model_capabilities and is printed as a table.
 *
 *   npm run models:probe            # probe every declared effort
 *   npm run models:probe -- --used  # only the routes the campaign will actually use
 */
import { getSql } from '@/lib/db';
import { migrate } from '@/lib/db/migrate';
import { loadModelRouting } from '@/lib/config/load';
import { ModelRouter } from '@/lib/models/router';
import { createLogger } from '@/lib/logging/logger';
import type { ModelRoute } from '@/lib/config/schema';

const PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'echo'],
  properties: {
    ok: { type: 'boolean' },
    echo: { type: 'string' },
  },
} as const;

interface ProbeOutcome {
  provider: string;
  model: string;
  effort: string | null;
  supported: boolean;
  latencyMs: number;
  error: string | null;
}

async function main(): Promise<void> {
  const onlyUsed = process.argv.includes('--used');
  const logger = createLogger({ cmd: 'models:probe' });
  const sql = await getSql();
  await migrate(sql);

  const routing = loadModelRouting();
  const combos = new Map<string, ModelRoute>();

  const add = (route: ModelRoute): void => {
    if (route.provider === 'none') return;
    combos.set(`${route.provider}|${route.model}|${route.effort ?? ''}`, route);
  };

  add(routing.defaultRoute);
  for (const [, override] of Object.entries(routing.tasks)) {
    if (!override) continue;
    add({
      provider: override.provider ?? routing.defaultRoute.provider,
      model: override.model ?? routing.defaultRoute.model,
      effort: override.effort === undefined ? routing.defaultRoute.effort : override.effort,
      timeoutMs: override.timeoutMs ?? routing.defaultRoute.timeoutMs,
      maxAttempts: 1,
    });
  }

  if (!onlyUsed) {
    const models = new Set([...combos.values()].map((r) => `${r.provider}|${r.model}`));
    for (const key of models) {
      const [provider, model] = key.split('|');
      if (!provider || !model) continue;
      for (const effort of routing.declaredEfforts) {
        combos.set(`${provider}|${model}|${effort}`, {
          provider: provider as ModelRoute['provider'],
          model,
          effort,
          timeoutMs: 120_000,
          maxAttempts: 1,
        });
      }
    }
  }

  const outcomes: ProbeOutcome[] = [];

  for (const route of combos.values()) {
    const router = new ModelRouter({
      sql,
      logger,
      routing: { ...routing, defaultRoute: { ...route, maxAttempts: 1 }, tasks: {} },
    });
    const started = Date.now();
    const result = await router.run({ task: 'probe', prompt: 'Réponds {"ok":true,"echo":"probe"}.', schema: PROBE_SCHEMA as unknown as Record<string, unknown> }, (value) => {
      const parsed = value as { ok?: unknown };
      if (typeof parsed.ok !== 'boolean') throw new Error('probe response missing ok');
      return parsed;
    });
    const latencyMs = Date.now() - started;

    const outcome: ProbeOutcome = {
      provider: route.provider,
      model: route.model,
      effort: route.effort,
      supported: result.ok,
      latencyMs,
      error: result.ok ? null : (result.error ?? 'unknown'),
    };
    outcomes.push(outcome);

    await sql.query(
      `insert into model_capabilities (provider, model, effort, supported, latency_ms, error, checked_at)
       values ($1,$2,$3,$4,$5,$6, now())
       on conflict (provider, model, effort) do update
         set supported = excluded.supported, latency_ms = excluded.latency_ms,
             error = excluded.error, checked_at = now()`,
      [outcome.provider, outcome.model, outcome.effort, outcome.supported, outcome.latencyMs, outcome.error],
    );

    logger.info('probe.result', outcome as unknown as Record<string, unknown>);
  }

  process.stdout.write('\nCapacités réellement détectées\n');
  process.stdout.write('─'.repeat(78) + '\n');
  for (const outcome of outcomes) {
    const status = outcome.supported ? 'OK    ' : 'ÉCHEC ';
    process.stdout.write(
      `${status} ${outcome.provider.padEnd(18)} ${outcome.model.padEnd(16)} ${(outcome.effort ?? '-').padEnd(8)} ${String(outcome.latencyMs).padStart(6)} ms  ${outcome.error ?? ''}\n`,
    );
  }
  process.stdout.write('─'.repeat(78) + '\n');

  await sql.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
