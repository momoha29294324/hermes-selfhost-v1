#!/usr/bin/env tsx
/**
 * R6B-D2.1 §11 — la reprise déterministe des projections en attente.
 *
 *   npm run r6b:crm:sync                 # PLAN : calcule, affiche, n’appelle rien
 *   npm run r6b:crm:sync -- --apply      # applique réellement
 *   npm run r6b:crm:sync -- --limit 10
 *
 * Le défaut est un plan, et ce n'est pas de la prudence décorative : §10 de la
 * mission interdit de projeter quoi que ce soit « juste pour prouver que l'API
 * marche ». Une commande qui écrirait dès la première invocation ferait
 * exactement cela, la première fois qu'un humain la tape pour voir.
 *
 * Ce que cette commande ne traite jamais :
 *
 *   * `BLOCKED_POLICY` — corrélation insuffisante, arbitrage humain requis ;
 *   * `APPLIED` — déjà fait, et le refaire créerait une seconde note ;
 *   * `FAILED_PERMANENT` — un refus définitif ne change pas d'avis tout seul.
 *
 * Elle n'envoie aucun message : ni email, ni SMS, ni DM. Les modules qu'elle
 * importe n'ont aucun chemin de code vers un fournisseur d'envoi.
 */
import { getSql } from '@/lib/db';
import { resolveCrmDestination } from '@/lib/crm/resolve';
import { syncCrmProjections, type SyncReport } from '@/lib/crm/sync';

class SyncArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncArgError';
  }
}

interface SyncArgs {
  readonly limit: number;
  readonly apply: boolean;
}

function parseArgs(argv: readonly string[]): SyncArgs {
  let limit = 50;
  let apply = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '--limit') {
      const parsed = Number.parseInt(next ?? '', 10);
      if (!Number.isFinite(parsed) || parsed < 1) throw new SyncArgError('--limit attend un entier ≥ 1');
      limit = Math.min(500, parsed);
      i += 1;
      continue;
    }
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    throw new SyncArgError(`option inconnue : ${arg}`);
  }

  return { limit, apply };
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(26)} ${value}\n`);
}

function report(result: SyncReport): void {
  process.stdout.write(
    `\nR6B-D2.1 — PROJECTIONS CRM ${result.apply ? '(APPLICATION RÉELLE)' : '(PLAN — rien n’est appelé)'}\n`,
  );
  line('destination', result.configuration);
  line('candidats', String(result.candidates));
  if (result.apply) {
    line('appliquées', String(result.applied));
    line('bloquées', String(result.blocked));
    line('en échec', String(result.failed));
  }
  line('ignorées', String(result.skipped));

  for (const outcome of result.outcomes) {
    process.stdout.write(`\n  ${outcome.company} — ${outcome.from}${outcome.to === null ? '' : ` → ${outcome.to}`}\n`);
    process.stdout.write(`    ${outcome.detail}\n`);
  }

  if (!result.apply && result.candidates > 0) {
    process.stdout.write('\n  Rien n’a été écrit. Relancer avec « -- --apply » pour appliquer ce plan.\n');
  }
  process.stdout.write('\n  Aucun message envoyé. Aucune boîte mail modifiée.\n\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = await getSql();

  try {
    const resolution = await resolveCrmDestination(sql);
    if (args.apply && !resolution.configured) {
      process.stderr.write(`\nAucune écriture possible : ${resolution.reason}\n\n`);
      process.exitCode = 1;
      return;
    }

    const result = await syncCrmProjections(sql, resolution, { limit: args.limit, apply: args.apply });
    report(result);
    if (result.failed > 0) process.exitCode = 2;
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof SyncArgError) {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
