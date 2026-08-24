#!/usr/bin/env tsx
/**
 * IG3 §6/§9 — le worker Instagram, en conditions de production, sans effet.
 *
 *   npm run ig:worker -- --dry-run                 # jusqu'à maxJobsPerRun
 *   npm run ig:worker -- --once --dry-run          # un seul job
 *   npm run ig:worker -- --drain --dry-run         # tant qu'il reste des jobs dus
 *   npm run ig:worker -- --dry-run --job-id <uuid>
 *   npm run ig:worker -- --dry-run --headed --screenshot
 *
 * `--dry-run` est OBLIGATOIRE, et ce n'est pas une politesse : sans lui la
 * commande refuse de démarrer. Il n'existe pas de `--live` ici, et en ajouter
 * un ne suffirait pas — le rail construit dans ce fichier
 * (`PlaywrightInstagramRail`) n'expose aucune primitive d'envoi, et le worker
 * refuse de tourner si on lui en passe une. Un envoi réel a son propre chemin
 * (`ig:canary`), son propre rail et son autorisation humaine nominative.
 *
 * Ce que cette commande fait vraiment : la vraie file, le vrai ordonnanceur, la
 * vraie prise atomique, les vraies gardes, le vrai profil navigateur, la vraie
 * session, la vraie identité, le vrai payload — et zéro effet.
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
  dryRun: boolean;
  once: boolean;
  drain: boolean;
  jobId: string | null;
  manifestId: string | null;
  headed: boolean;
  screenshot: boolean;
  maxJobs: number | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    dryRun: false,
    once: false,
    drain: false,
    jobId: null,
    manifestId: null,
    headed: false,
    screenshot: false,
    maxJobs: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--once':
        args.once = true;
        break;
      case '--drain':
        args.drain = true;
        break;
      case '--job-id':
        args.jobId = (argv[++i] ?? '').trim();
        break;
      case '--manifest-id':
        args.manifestId = (argv[++i] ?? '').trim();
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
        throw new Error(`option inconnue : « ${String(token)} » (ce worker n'a pas de --live)`);
    }
  }

  if (!args.dryRun) {
    throw new Error(
      '--dry-run est obligatoire. Ce worker ne sait faire que cela : le rail qu’il construit n’expose ' +
        'aucune primitive d’envoi, et un envoi réel passe par « npm run ig:canary », avec son autorisation ' +
        'humaine nominative.',
    );
  }
  if (args.once && args.drain) throw new Error('--once et --drain sont exclusifs');
  if (args.jobId !== null && args.manifestId !== null) throw new Error('--job-id et --manifest-id sont exclusifs');
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
  line('event_status', outcome.status);
  line('job_status', outcome.jobStatus);
  line('reason_code', outcome.reasonCode);
  line('skip_reason', outcome.skipReason ?? '—');
  line('skip_class', outcome.skipClass ?? '—');
  line('next_attempt_at', outcome.nextAttemptAt ?? '— (aucun rejeu)');
  line('detail', outcome.detail);
  line('duration_ms', String(outcome.durationMs));
  line('event_id', outcome.eventId);
  if (outcome.screenshotPath !== null) line('screenshot', outcome.screenshotPath);
  line('gates', outcome.gates.map((gate) => `${gate.gate}=${gate.verdict}`).join(' '));
  if (outcome.liveProjection !== null) {
    // La réponse exacte à « ce que le worker aurait envoyé, et quand ».
    line('live_would_proceed', String(outcome.liveProjection.wouldProceed));
    line('live_blocked_by', outcome.liveProjection.blockedBy ?? '—');
    line('live_next_eligible', outcome.liveProjection.nextEligibleAt ?? '—');
    line('live_detail', outcome.liveProjection.detail);
  }
  if (outcome.preview !== null) {
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

    const maxJobs = args.maxJobs ?? (args.once ? 1 : null);

    const result = await runInstagramDryRun(
      {
        sql,
        config,
        workerId,
        mode: 'DRY_RUN',
        drain: args.drain,
        ...(jobId === undefined ? {} : { jobId }),
        ...(maxJobs === null ? {} : { maxJobs }),
      },
      { rail },
    );

    process.stdout.write('\nIG3 — worker DRY-RUN\n');
    line('worker_id', result.workerId);
    line('mode', result.mode);
    line('session_id', result.sessionId ?? '—');
    line('session_state', result.sessionState ?? '—');
    line('recovered_leases', String(result.recoveredLeases));
    line('review_required', String(result.reviewRequired));
    line('jobs_processed', String(result.outcomes.length));
    line('drain_truncated', String(result.drainTruncated));
    line('stopped_early', result.stoppedEarly ?? '—');
    line('external_effects', String(result.externalEffects));

    result.outcomes.forEach(reportOutcome);

    process.stdout.write('\nAucun DM, aucun clic, aucun follow/like/commentaire, aucun outreach_event.\n\n');

    // Un arrêt dur ou un refus doivent se voir dans le code de sortie : un
    // pipeline qui ne lit que stdout ne doit pas prendre un blocage pour un
    // succès. Un REPORT n'en est pas un — c'est le fonctionnement normal de
    // l'ordonnanceur — d'où le code 3, distinct des deux autres.
    if (result.stoppedEarly !== null) process.exitCode = 2;
    else if (result.outcomes.some((outcome) => outcome.status === 'BLOCKED' || outcome.status === 'FAILED')) {
      process.exitCode = 1;
    } else if (result.outcomes.some((outcome) => outcome.status === 'SKIPPED')) process.exitCode = 3;
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
