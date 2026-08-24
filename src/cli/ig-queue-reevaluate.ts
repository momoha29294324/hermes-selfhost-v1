#!/usr/bin/env tsx
/**
 * HERMES-TARGETING-R1 §22 — ce que la file contient encore, sous les règles
 * d'AUJOURD'HUI.
 *
 *   npm run ig:queue:reevaluate
 *   npm run ig:queue:reevaluate -- --json
 *
 * À passer avant toute reprise, et notamment avant de relâcher l'arrêt global :
 * un job enfilé sous `hermes-autonomous-r2` a été décidé par une politique qui
 * ne connaissait pas `core_service_fit`, et son ancienneté ne vaut pas
 * autorisation.
 *
 * LECTURE SEULE. Cette commande n'écrit rien, n'annule aucun job, n'ouvre aucun
 * navigateur et ne touche pas à l'arrêt global — voir l'en-tête de
 * `src/lib/instagram/queueReevaluation.ts` pour la raison : ce sont la version
 * de politique et le crochet pré-effet qui referment réellement la file, pas
 * une écriture faite ici.
 */
import { getSql } from '@/lib/db';
import { AUTONOMOUS_POLICY_VERSION } from '@/lib/instagram/autonomousPolicy';
import { reevaluateQueue } from '@/lib/instagram/queueReevaluation';

function parseArgs(argv: readonly string[]): { json: boolean } {
  let json = false;
  for (const token of argv) {
    if (token === '--json') json = true;
    else {
      throw new Error(
        `option inconnue : « ${String(token)} » — cette commande n'a ni --apply, ni --cancel, ni --send`,
      );
    }
  }
  return { json };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = await getSql();

  try {
    const report = await reevaluateQueue(sql);

    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    process.stdout.write(`\nHERMES-TARGETING-R1 — file Instagram relue sous « ${AUTONOMOUS_POLICY_VERSION} »\n\n`);
    process.stdout.write(`  jobs non terminaux        ${String(report.jobs.length)}\n`);
    process.stdout.write(`  encore éligibles          ${String(report.stillEligible)}\n`);
    process.stdout.write(`  désormais écartés         ${String(report.newlySkipped)}\n`);
    process.stdout.write(`  orphelins (item absent)   ${String(report.orphaned)}\n\n`);

    if (report.jobs.length === 0) {
      process.stdout.write('  La file ne contient aucun job non terminal. Rien à réévaluer.\n\n');
      return;
    }

    process.stdout.write(
      `  ${pad('entreprise', 30)} ${pad('handle', 24)} ${pad('statut', 12)} verdict\n`,
    );
    process.stdout.write(`  ${'-'.repeat(104)}\n`);
    for (const job of report.jobs) {
      process.stdout.write(
        `  ${pad(job.displayName, 30)} ${pad(job.instagramHandle ?? '—', 24)} ` +
          `${pad(job.status, 12)} ${job.verdict}\n`,
      );
    }
    process.stdout.write('\n');
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
