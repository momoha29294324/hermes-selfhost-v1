#!/usr/bin/env tsx
/**
 * Diagnostic of the Web Intelligence worker, from this machine.
 *
 *   npm run webintel:health
 *   npm run webintel:health -- --full     # components, breakers, cache
 *
 * Answers the first question of any incident: is the worker reachable from
 * here, and which of its parts are degraded?
 */
import { env } from '@/lib/env';
import { HttpClient } from '@/lib/http/client';
import { webIntelConfigured } from '@/lib/enrichment/webintel';

interface ComponentHealth {
  status: string;
  detail: string;
  [key: string]: unknown;
}

interface HealthPayload {
  status: string;
  version: string;
  uptimeMs: number;
  components?: Record<string, ComponentHealth>;
  breakers?: Record<string, { state: string; failures: number; openedAt: string | null }>;
}

async function main(): Promise<void> {
  const configured = webIntelConfigured();
  if (!configured.ok) {
    process.stderr.write(`Web Intelligence non configuré : ${configured.reason}\n`);
    process.exitCode = 1;
    return;
  }

  const baseUrl = (env('OUTBOUND_WEBINTEL_URL') as string).replace(/\/$/, '');
  const token = env('OUTBOUND_WEBINTEL_TOKEN') as string;
  const full = process.argv.includes('--full');
  const http = new HttpClient({ sql: null, minHostIntervalMs: 0 });

  const started = Date.now();
  const response = await http.get(`${baseUrl}/health${full ? '?full=1' : ''}`, {
    timeoutMs: 15_000,
    attempts: 1,
    noCache: true,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const latencyMs = Date.now() - started;

  if (!response.ok) {
    process.stderr.write(`HTTP ${response.status} depuis ${baseUrl}\n`);
    process.exitCode = 1;
    return;
  }

  const payload = JSON.parse(response.body) as HealthPayload;
  process.stdout.write(`worker   : ${baseUrl}\n`);
  process.stdout.write(`statut   : ${payload.status}\n`);
  process.stdout.write(`version  : ${payload.version}\n`);
  process.stdout.write(`uptime   : ${Math.round(payload.uptimeMs / 1000)} s\n`);
  process.stdout.write(`latence  : ${latencyMs} ms\n`);

  if (payload.components) {
    process.stdout.write('\ncomposants :\n');
    for (const [name, component] of Object.entries(payload.components)) {
      process.stdout.write(`  ${name.padEnd(9)} ${component.status.padEnd(9)} ${component.detail}\n`);
    }
  }
  if (payload.breakers) {
    const open = Object.entries(payload.breakers).filter(([, value]) => value.state !== 'closed');
    process.stdout.write(`\ndisjoncteurs ouverts : ${open.length === 0 ? 'aucun' : ''}\n`);
    for (const [name, value] of open) {
      process.stdout.write(`  ${name} — ${value.state} (${value.failures} échecs, depuis ${value.openedAt})\n`);
    }
  }

  if (payload.status !== 'ok') process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
