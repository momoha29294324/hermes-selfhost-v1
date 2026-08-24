#!/usr/bin/env tsx
/**
 * HERMES-AUTONOMOUS-R2 §4/§5 — évaluer un batch sous la politique autonome, et
 * n'enfiler que ce qui est certain.
 *
 *   npm run ig:autonomous -- --batch <slug>            # rapport, aucune écriture
 *   npm run ig:autonomous -- --batch <slug> --apply    # approbations, manifestes, jobs
 *
 * Cette commande n'envoie RIEN et ne peut pas envoyer : elle n'ouvre aucun
 * navigateur, n'importe aucune primitive d'envoi, et ne touche pas à l'arrêt
 * global. Son point d'arrivée est une file — `ig_dispatch_jobs` — dont le
 * drainage est le travail d'une autre commande, sous d'autres gardes.
 *
 * `--apply` réévalue chaque prospect juste avant d'écrire : le rapport qu'on
 * vient de lire n'autorise rien, c'est le calcul du moment de l'écriture qui
 * décide.
 */
import { getSql } from '@/lib/db';
import { runAutonomousDispatch, AUTONOMOUS_RAIL_ACTOR } from '@/lib/instagram/autonomousDispatch';
import { AUTONOMOUS_POLICY_VERSION, AUTONOMOUS_BORDERLINE_AT_OR_ABOVE } from '@/lib/instagram/autonomousPolicy';

interface Args {
  batch: string;
  apply: boolean;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { batch: '', apply: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--batch':
        if (args.batch !== '') throw new Error('--batch ne peut être donné qu’une fois');
        args.batch = argv[++i] ?? '';
        break;
      case '--apply':
        args.apply = true;
        break;
      case '--json':
        args.json = true;
        break;
      default:
        throw new Error(
          `option inconnue : « ${String(token)} » — cette commande n'a ni --send, ni --live, ni --all`,
        );
    }
  }
  if (args.batch.trim() === '') throw new Error('--batch <slug> est obligatoire');
  return args;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = await getSql();

  try {
    const report = await runAutonomousDispatch(sql, {
      batchSlug: args.batch.trim(),
      apply: args.apply,
      enqueuedBy: AUTONOMOUS_RAIL_ACTOR,
    });

    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }

    process.stdout.write(`\nHERMES-AUTONOMOUS-R2 — ${report.batchSlug}\n`);
    process.stdout.write(`  politique                  ${AUTONOMOUS_POLICY_VERSION}\n`);
    process.stdout.write(`  seuil ICP canonique        10000 (inchangé)\n`);
    process.stdout.write(`  marge auto-send            ${String(AUTONOMOUS_BORDERLINE_AT_OR_ABOVE)}\n`);
    process.stdout.write(`  mode                       ${report.applied ? 'APPLY (écriture)' : 'RAPPORT (lecture seule)'}\n\n`);

    process.stdout.write(
      `  ${pad('entreprise', 34)} ${pad('handle', 26)} ${pad('abonnés', 8)} ${pad('décision', 30)} action\n`,
    );
    for (const candidate of report.candidates) {
      const outcome = report.outcomes.find((o) => o.itemId === candidate.itemId);
      process.stdout.write(
        `  ${pad(candidate.displayName, 34)} ${pad(candidate.instagramHandle ?? '—', 26)} ` +
          `${pad(candidate.followers === null ? '—' : String(candidate.followers), 8)} ` +
          `${pad(`${candidate.decision.outcome}${candidate.decision.reason === null ? '' : `:${candidate.decision.reason}`}`, 30)} ` +
          `${outcome?.status ?? '—'}\n`,
      );
    }

    process.stdout.write('\n  Motifs\n');
    for (const candidate of report.candidates) {
      if (candidate.decision.reason === null) continue;
      process.stdout.write(`    ${candidate.instagramHandle ?? candidate.displayName} — ${candidate.decision.detail}\n`);
    }

    process.stdout.write('\n  Bilan\n');
    process.stdout.write(`    candidats                ${String(report.candidates.length)}\n`);
    process.stdout.write(`    AUTO_SEND_ELIGIBLE       ${String(report.eligible)}\n`);
    process.stdout.write(`    AUTO_SKIP                ${String(report.skipped)}\n`);
    if (report.applied) {
      process.stdout.write(`    jobs enfilés             ${String(report.queued)}\n`);
      process.stdout.write(`    déjà en file             ${String(report.alreadyQueued)}\n`);
      process.stdout.write(`    bloqués en aval          ${String(report.blocked)}\n`);
      process.stdout.write(`    pannes                   ${String(report.failed)}\n`);
      for (const outcome of report.outcomes) {
        if (outcome.status === 'BLOCKED' || outcome.status === 'FAILED') {
          process.stdout.write(`      ${outcome.handle ?? outcome.displayName} — ${outcome.reason}\n`);
        }
      }
    }
    process.stdout.write('\n  0 message envoyé — cette commande n’ouvre aucun navigateur.\n\n');
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
