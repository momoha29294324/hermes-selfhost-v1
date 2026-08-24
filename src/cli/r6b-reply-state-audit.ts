#!/usr/bin/env tsx
/**
 * HERMES-TARGETING-R1 §8 / HERMES-REPLY-ORDERING-R1 §8 — l'audit des états
 * commerciaux, et ses deux réparations bornées.
 *
 *   npm run r6b:replies:state-audit                                    # lecture seule
 *   npm run r6b:replies:state-audit -- --json                          # lecture seule
 *   npm run r6b:replies:state-audit -- --repair --as "<nom>"           # progression manquante
 *   npm run r6b:replies:state-audit -- --order                         # lecture seule, ORDRE
 *   npm run r6b:replies:state-audit -- --repair-order                  # DRY-RUN, n'écrit rien
 *   npm run r6b:replies:state-audit -- --repair-order --apply --as "<nom>"
 *
 * Deux défauts distincts, deux réparations distinctes, et elles ne se
 * remplacent pas :
 *
 *   * `--repair` traite « une décision est enregistrée, l'état ne l'a pas
 *     suivie ». Il rejoue les transitions canoniques du message lui-même ;
 *   * `--repair-order` traite « chaque message a bien progressé, mais c'est le
 *     dernier TRAITÉ qui gouverne au lieu du dernier REÇU ». Rejouer ne servirait
 *     à rien — les causes sont déjà journalisées — donc il recalcule l'état
 *     canonique en repliant les réponses par heure de réception, et n'écrit que
 *     les divergences prouvées. Son défaut est le DRY-RUN : `--apply` est un
 *     second geste, et il exige un nom.
 *
 * Le défaut est de REGARDER. `--repair` est un geste distinct, il exige un nom
 * d'opérateur, et il ne touche qu'aux cas `MISSING_PROGRESSION` — ceux où une
 * analyse existante établit qu'un humain a écrit alors que l'état est resté à
 * `CONTACTED`. Aucun autre cas n'est muté, et aucune conclusion n'est inventée :
 * la réparation rejoue une décision déjà enregistrée.
 *
 * Cette commande n'envoie rien, n'ouvre aucun navigateur et n'appelle aucun
 * modèle.
 */
import { getSql } from '@/lib/db';
import {
  auditReplyOrdering,
  auditReplyStates,
  repairMissingProgression,
  repairReplyOrdering,
} from '@/lib/replies/stateAudit';

interface Args {
  readonly repair: boolean;
  readonly order: boolean;
  readonly repairOrder: boolean;
  readonly apply: boolean;
  readonly as: string;
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let repair = false;
  let order = false;
  let repairOrder = false;
  let apply = false;
  let as = '';
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--repair':
        repair = true;
        break;
      case '--order':
        order = true;
        break;
      case '--repair-order':
        repairOrder = true;
        break;
      case '--apply':
        apply = true;
        break;
      case '--as':
        as = (argv[++i] ?? '').trim();
        break;
      case '--json':
        json = true;
        break;
      default:
        throw new Error(`option inconnue : « ${String(token)} »`);
    }
  }
  if (repair && as.length === 0) {
    throw new Error(
      '--repair exige --as "<nom>" : une écriture d’état porte le nom de qui l’a demandée, jamais celui d’un script',
    );
  }
  if (apply && !repairOrder) {
    throw new Error('--apply ne veut rien dire seul : il arme --repair-order, et rien d’autre');
  }
  if (repairOrder && apply && as.length === 0) {
    throw new Error(
      '--repair-order --apply exige --as "<nom>" : une écriture d’état porte le nom de qui l’a demandée',
    );
  }
  if (repair && repairOrder) {
    throw new Error(
      'une réparation à la fois : --repair rejoue une progression manquante, --repair-order ' +
        'recalcule un ordre. Les enchaîner sans regarder entre les deux mélangerait deux causes',
    );
  }
  return { repair, order, repairOrder, apply, as, json };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

async function runOrder(sql: Awaited<ReturnType<typeof getSql>>, args: Args): Promise<void> {
  const audit = await auditReplyOrdering(sql);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    if (!args.repairOrder) return;
  } else {
    process.stdout.write('\nHERMES-REPLY-ORDERING-R1 — état courant vs ordre réel des réponses\n\n');
    process.stdout.write(
      `  ${pad('entreprise', 30)} ${pad('courant', 16)} ${pad('attendu', 16)} ${pad('verdict', 20)} dernière réponse\n`,
    );
    process.stdout.write(`  ${'-'.repeat(110)}\n`);
    for (const entry of audit.cases) {
      process.stdout.write(
        `  ${pad(entry.displayName, 30)} ${pad(entry.currentState ?? '—', 16)} ` +
          `${pad(entry.expectedState ?? '—', 16)} ${pad(entry.verdict, 20)} ` +
          `${entry.latestReceivedAt?.slice(0, 19).replace('T', ' ') ?? '—'} ` +
          `(${entry.latestClassification ?? '—'})\n`,
      );
    }
    process.stdout.write('\n  Verdicts\n');
    for (const [verdict, count] of Object.entries(audit.counts)) {
      process.stdout.write(`    ${pad(verdict, 24)} ${String(count)}\n`);
    }
  }

  if (!args.repairOrder) {
    process.stdout.write(
      audit.counts.DIVERGENT === 0
        ? '\n  Aucune divergence d’ordre. Rien à écrire.\n\n'
        : `\n  ${String(audit.counts.DIVERGENT)} divergence(s). Pour les regarder en détail :\n` +
            '    npm run r6b:replies:state-audit -- --repair-order\n\n',
    );
    return;
  }

  const report = await repairReplyOrdering(sql, { apply: args.apply, actor: args.as });
  process.stdout.write(
    args.apply
      ? `\n  Réparation d’ordre APPLIQUÉE, demandée par « ${args.as} »\n`
      : '\n  Réparation d’ordre — DRY-RUN. Aucune écriture n’a eu lieu.\n',
  );
  process.stdout.write(`  prospects audités          ${String(report.audited)}\n`);
  process.stdout.write(`  divergents                 ${String(report.divergent)}\n`);
  process.stdout.write(`  réparés                    ${String(report.repaired)}\n`);
  process.stdout.write(`  inchangés                  ${String(report.unchanged)}\n\n`);
  for (const outcome of report.outcomes) {
    process.stdout.write(
      `    ${pad(outcome.displayName, 30)} ${pad(outcome.fromState ?? '—', 16)} → ` +
        `${pad(outcome.toState ?? '—', 16)} ${outcome.written ? 'ÉCRIT' : 'à écrire'}\n` +
        `      dernière réponse ${outcome.latestReceivedAt ?? '—'} (${outcome.latestClassification ?? '—'})\n` +
        `      ${outcome.detail}\n`,
    );
  }
  if (!args.apply && report.divergent > 0) {
    process.stdout.write(
      '\n  Pour écrire ces corrections, et seulement celles-là :\n' +
        '    npm run r6b:replies:state-audit -- --repair-order --apply --as "<nom>"\n',
    );
  }
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = await getSql();

  try {
    if (args.order || args.repairOrder) {
      await runOrder(sql, args);
      return;
    }

    const audit = await auditReplyStates(sql);

    if (args.json && !args.repair) {
      process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
      return;
    }

    process.stdout.write('\nHERMES-TARGETING-R1 — états commerciaux vs réponses corrélées\n\n');
    process.stdout.write(
      `  ${pad('entreprise', 30)} ${pad('état', 16)} ${pad('analyse', 16)} ${pad('constat', 22)} reçu le\n`,
    );
    process.stdout.write(`  ${'-'.repeat(100)}\n`);
    for (const entry of audit.cases) {
      process.stdout.write(
        `  ${pad(entry.displayName, 30)} ${pad(entry.currentState ?? '—', 16)} ` +
          `${pad(entry.classification ?? '—', 16)} ${pad(entry.finding, 22)} ${entry.receivedAt.slice(0, 16)}\n`,
      );
    }

    process.stdout.write('\n  Constats\n');
    for (const [finding, count] of Object.entries(audit.counts)) {
      process.stdout.write(`    ${pad(finding, 24)} ${String(count)}\n`);
    }

    if (!args.repair) {
      const repairable = audit.counts.MISSING_PROGRESSION;
      process.stdout.write(
        repairable === 0
          ? '\n  Aucun cas réparable par une transition. Rien à écrire.\n\n'
          : `\n  ${String(repairable)} cas réparable(s). Pour les traiter :\n` +
              '    npm run r6b:replies:state-audit -- --repair --as "<nom>"\n\n',
      );
      if (audit.counts.NO_ANALYSIS > 0) {
        process.stdout.write(
          `  ${String(audit.counts.NO_ANALYSIS)} réponse(s) sans analyse vivante — elles ne se réparent PAS\n` +
            '  par une écriture d’état : faire tourner npm run r6b:replies:process -- --resume.\n\n',
        );
      }
      return;
    }

    const report = await repairMissingProgression(sql);
    process.stdout.write(`\n  Réparation demandée par « ${args.as} »\n`);
    process.stdout.write(`  cas éligibles              ${String(report.eligible)}\n`);
    process.stdout.write(`  transitions écrites        ${String(report.repaired.length)}\n\n`);
    for (const outcome of report.repaired) {
      process.stdout.write(
        `    ${pad(outcome.displayName, 30)} accusé=${outcome.acknowledged ? 'oui' : 'non'} ` +
          `intention=${outcome.intentApplied ? 'oui' : 'non'} → ${outcome.finalState ?? '—'}\n`,
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
