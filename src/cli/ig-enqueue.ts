#!/usr/bin/env tsx
/**
 * IG-R1 §3 — enfile l'intention portée par un manifeste R6B verrouillé.
 *
 *   npm run ig:enqueue -- --manifest-id <uuid> --as "<nom>"
 *
 * Enfiler n'autorise rien : un job PENDING attend derrière l'arrêt global, les
 * plafonds, la vérification de session et la vérification d'identité. Enfiler
 * deux fois le même manifeste ne crée pas un second job — la base l'interdit
 * (`ig_dispatch_jobs_one_per_intent`, 0029).
 *
 * Aucun message n'est écrit ni modifié ici : le texte vient du manifeste, et
 * seules ses empreintes sont recopiées pour détecter une dérive ultérieure.
 */
import { getSql } from '@/lib/db';
import { DispatchBlockedError } from '@/lib/pipeline/r6bDispatcher';
import { enqueueInstagramJob, InstagramEligibilityError, InstagramQueueError } from '@/lib/instagram/queue';
import { formatEligibility } from '@/lib/instagram/eligibility';

interface Args {
  manifestId: string;
  enqueuedBy: string;
}

function parseArgs(argv: readonly string[]): Args {
  let manifestId = '';
  let enqueuedBy = '';
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--manifest-id') manifestId = argv[++i] ?? '';
    else if (token === '--as') enqueuedBy = argv[++i] ?? '';
    else throw new Error(`option inconnue : « ${String(token)} »`);
  }
  if (manifestId.trim().length === 0) throw new Error('--manifest-id <uuid> est obligatoire');
  if (enqueuedBy.trim().length === 0) {
    throw new Error('--as "<nom>" est obligatoire — un job enfilé porte le nom de qui l’a demandé');
  }
  return { manifestId: manifestId.trim(), enqueuedBy: enqueuedBy.trim() };
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(24)} ${value}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = await getSql();
  try {
    const result = await enqueueInstagramJob(sql, {
      manifestId: args.manifestId,
      action: 'first_touch_dm',
      enqueuedBy: args.enqueuedBy,
    });

    process.stdout.write(`\nIG-R1 — ${result.created ? 'job enfilé' : 'job déjà présent (aucun doublon créé)'}\n`);
    line('verdict', formatEligibility(result.eligibility));
    line('decision_id', result.decisionId);
    line('job_id', result.job.id);
    line('manifest_id', result.job.manifestId);
    line('prospect_id', result.job.prospectId);
    line('action', result.job.action);
    line('idempotency_key', result.job.idempotencyKey);
    line('expected_handle', result.job.expectedHandle);
    line('status', result.job.status);
    line('attempts', String(result.job.attempts));
    process.stdout.write('\nAucun envoi. Le job attend derrière l’arrêt global, les plafonds et la vérification d’identité.\n\n');
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof InstagramEligibilityError) {
    process.stderr.write(`REFUSÉ ${formatEligibility(error.decision)} [${error.code}] ${error.message}\n`);
    process.stderr.write(`verdict journalisé : ig_enqueue_decisions ${error.decisionId}\n`);
  } else if (error instanceof DispatchBlockedError || error instanceof InstagramQueueError) {
    process.stderr.write(`REFUSÉ [${error.code}] ${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
