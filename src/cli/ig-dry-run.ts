#!/usr/bin/env tsx
/**
 * IG-R1 §6 — le worker DRY-RUN Instagram.
 *
 *   npm run ig:dry-run                                  # la file, dans l'ordre
 *   npm run ig:dry-run -- --job-id <uuid>               # un job précis
 *   npm run ig:dry-run -- --manifest-id <uuid>          # le job de ce manifeste
 *   npm run ig:dry-run -- --headed --screenshot         # fenêtre visible + captures
 *
 * IG3 — `npm run ig:worker -- --dry-run` fait la même chose et davantage
 * (`--once`, `--drain`, la projection LIVE, le motif de report et sa date de
 * reprise). Cette commande reste parce qu'elle est dans les runbooks et dans
 * l'historique des rapports ; les deux appellent le même worker, il n'y a
 * qu'un seul chemin.
 *
 * Il n'existe PAS de `--live`. Ce n'est pas une option retirée du parseur :
 * aucun envoi Instagram n'est implémenté dans ce dépôt
 * (`LIVE_CAPABLE_TRANSPORTS.instagram_dm = false`), le rail passé au worker
 * n'expose aucune méthode capable d'agir, et la base refuse d'enregistrer un
 * DRY_RUN qui prétendrait avoir produit un effet (0029).
 *
 * C'est ici, et seulement ici, que le vrai navigateur est construit : le
 * domaine exige qu'on lui fournisse un rail et n'en fabrique jamais.
 */
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { getSql } from '@/lib/db';
import { loadInstagramRail } from '@/lib/config/load';
import { loadInstagramJobForManifest } from '@/lib/instagram/queue';
import { PlaywrightInstagramRail } from '@/lib/instagram/playwrightRail';
import { runInstagramDryRun, type JobOutcome } from '@/lib/instagram/worker';

const SCREENSHOT_DIR = 'var/instagram/screenshots';

interface Args {
  jobId: string | null;
  manifestId: string | null;
  headed: boolean;
  screenshot: boolean;
  maxJobs: number | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { jobId: null, manifestId: null, headed: false, screenshot: false, maxJobs: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--job-id':
        args.jobId = argv[++i] ?? '';
        break;
      case '--manifest-id':
        args.manifestId = argv[++i] ?? '';
        break;
      case '--max-jobs':
        args.maxJobs = Number.parseInt(argv[++i] ?? '', 10);
        break;
      case '--headed':
        args.headed = true;
        break;
      case '--screenshot':
        args.screenshot = true;
        break;
      default:
        throw new Error(`option inconnue : « ${String(token)} » (ce rail n'a pas de --live)`);
    }
  }
  if (args.jobId !== null && args.manifestId !== null) {
    throw new Error('--job-id et --manifest-id sont exclusifs');
  }
  if (args.maxJobs !== null && (!Number.isFinite(args.maxJobs) || args.maxJobs < 1)) {
    throw new Error('--max-jobs attend un entier ≥ 1');
  }
  return args;
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(24)} ${value}\n`);
}

function reportOutcome(outcome: JobOutcome, index: number): void {
  process.stdout.write(`\n[${index + 1}] job ${outcome.jobId}\n`);
  line('manifest_id', outcome.manifestId);
  line('prospect_id', outcome.prospectId);
  line('idempotency_key', outcome.idempotencyKey);
  line('expected_handle', outcome.expectedHandle);
  line('observed_handle', outcome.observedHandle ?? '—');
  line('session_state', outcome.sessionState ?? '—');
  line('status', outcome.status);
  line('reason_code', outcome.reasonCode);
  line('detail', outcome.detail);
  line('duration_ms', String(outcome.durationMs));
  line('event_id', outcome.eventId);
  if (outcome.screenshotPath !== null) line('screenshot', outcome.screenshotPath);
  line('gates', outcome.gates.map((gate) => `${gate.gate}=${gate.verdict}`).join(' '));
  if (outcome.preview !== null) {
    // Le message qui PARTIRAIT, calculé par l'adapter qui servirait à un envoi.
    line('would_send_to', outcome.preview.payloadFields['to_handle'] ?? '—');
    line('would_send_body', JSON.stringify(outcome.preview.payloadFields['body'] ?? ''));
    line('live_ready', String(outcome.liveReady));
    line('missing_for_live', `[${(outcome.missingForLive ?? []).join(', ')}]`);
  }
  line('external_effect', 'aucun');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadInstagramRail();
  const sql = await getSql();
  const workerId = `${hostname()}/pid-${process.pid}`;

  try {
    let jobId = args.jobId ?? undefined;
    if (args.manifestId !== null) {
      const job = await loadInstagramJobForManifest(sql, args.manifestId, 'first_touch_dm');
      if (!job) throw new Error(`aucun job Instagram enfilé pour le manifeste ${args.manifestId}`);
      jobId = job.id;
    }

    const rail = new PlaywrightInstagramRail({
      config,
      headless: args.headed ? false : config.session.headless,
      screenshotDir: args.screenshot ? resolve(process.cwd(), SCREENSHOT_DIR) : null,
      workerId,
    });

    const result = await runInstagramDryRun(
      {
        sql,
        config,
        workerId,
        mode: 'DRY_RUN',
        ...(jobId === undefined ? {} : { jobId }),
        ...(args.maxJobs === null ? {} : { maxJobs: args.maxJobs }),
      },
      { rail },
    );

    process.stdout.write('\nIG-R1 — DRY-RUN\n');
    line('worker_id', result.workerId);
    line('mode', result.mode);
    line('session_id', result.sessionId ?? '—');
    line('session_state', result.sessionState ?? '—');
    line('recovered_leases', String(result.recoveredLeases));
    line('review_required', String(result.reviewRequired));
    line('jobs_processed', String(result.outcomes.length));
    line('stopped_early', result.stoppedEarly ?? '—');

    result.outcomes.forEach(reportOutcome);

    process.stdout.write('\nAucun DM, aucun clic, aucun follow/like/commentaire, aucun outreach_event.\n\n');

    // Un arrêt dur ou un refus doivent se voir dans le code de sortie : un
    // pipeline qui ne lit que stdout ne doit pas prendre un blocage pour un
    // succès.
    if (result.stoppedEarly !== null) process.exitCode = 2;
    else if (result.outcomes.some((outcome) => outcome.status !== 'DRY_RUN_COMPLETED')) process.exitCode = 1;
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
