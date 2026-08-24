#!/usr/bin/env tsx
import { getSql } from '@/lib/db';
import { invalidateQueueUnderCurrentPolicy } from '@/lib/instagram/queueInvalidation';
import { AUTONOMOUS_POLICY_VERSION } from '@/lib/instagram/autonomousPolicy';

/**
 * HERMES-CLEANING-ONLY-ICP-R1 §10 — refermer les jobs qu'une politique nouvelle
 * n'autorise plus, sans en supprimer un seul.
 *
 *   npm run ig:queue:invalidate                          # lecture seule
 *   npm run ig:queue:invalidate -- --apply --as "<nom>"  # referme réellement
 *
 * Ne supprime rien, n'ouvre aucun navigateur, ne touche pas à l'arrêt global,
 * ne peut produire aucun effet externe. Un job refermé porte `INELIGIBLE`, le
 * motif exact de la politique, et une ligne de journal qui date la décision.
 */

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const operator = arg('as');
  if (apply && (operator === null || operator.trim().length === 0)) {
    throw new Error('--apply exige --as "<nom de l’opérateur>" : une écriture porte le nom de qui la décide.');
  }

  const sql = await getSql();
  try {
    const report = await invalidateQueueUnderCurrentPolicy(sql, {
      operator: operator ?? 'lecture seule',
      apply,
    });
    const out = (line: string): void => void process.stdout.write(`${line}\n`);

    out('');
    out(`HERMES-CLEANING-ONLY-ICP-R1 — file rejouée ${apply ? '(APPLIQUÉ)' : '(LECTURE SEULE)'}`);
    out(`  politique                 ${AUTONOMOUS_POLICY_VERSION}`);
    if (apply) out(`  opérateur                 ${report.operator}`);
    out(`  jobs ouverts examinés     ${String(report.jobs.length)}`);
    out(`  encore éligibles          ${String(report.stillEligible)}`);
    out(`  ${apply ? 'refermés INELIGIBLE      ' : 'à refermer INELIGIBLE    '} ${String(report.closed)}`);
    out(`  laissés ouverts           ${String(report.leftOpen)}`);
    out('');

    for (const job of report.jobs) {
      out(`  @${(job.instagramHandle ?? '—').padEnd(26)} ${job.previousStatus.padEnd(10)} → ${job.outcome}`);
      out(`     ${job.displayName}`);
      out(`     verdict : ${job.verdict}`);
      out(`     motif   : ${job.skipReason ?? '—'}`);
      out(`     ${job.detail}`);
      out('');
    }

    if (!apply && report.closed > 0) {
      out('  Rien n’a été écrit. Pour appliquer :');
      out('    npm run ig:queue:invalidate -- --apply --as "<votre nom>"');
      out('');
    }
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
