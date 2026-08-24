#!/usr/bin/env tsx
/**
 * IG3 §9 — la file Instagram, vue et alimentée par un opérateur.
 *
 *   npm run ig:queue -- --status
 *   npm run ig:queue -- --check   --manifest-id <uuid>
 *   npm run ig:queue -- --enqueue --manifest-id <uuid> --as "<nom>"
 *
 * Aucune de ces trois commandes n'envoie quoi que ce soit, et deux d'entre
 * elles n'écrivent rien du tout :
 *
 *   `--status`  lit. Zéro écriture, zéro navigateur.
 *   `--check`   évalue l'éligibilité et l'AFFICHE sans rien journaliser ni
 *               enfiler. C'est la commande qu'on lance pour savoir pourquoi un
 *               prospect ne passe pas, sans laisser de trace d'une intention
 *               qu'on n'a pas prise.
 *   `--enqueue` enfile — derrière les dix portes d'éligibilité, et en
 *               journalisant le verdict quel qu'il soit.
 *
 * Un job enfilé n'autorise rien. Il attend derrière l'ordonnanceur, les
 * plafonds, la vérification de session et la vérification d'identité — et
 * derrière l'arrêt global, qui reste armé.
 */
import { getSql } from '@/lib/db';
import { loadInstagramRail } from '@/lib/config/load';
import { DispatchBlockedError } from '@/lib/pipeline/r6bDispatcher';
import {
  enqueueInstagramJob,
  InstagramEligibilityError,
  InstagramQueueError,
  listInstagramJobs,
  loadQueueOverview,
} from '@/lib/instagram/queue';
import { evaluateInstagramEligibility, formatEligibility } from '@/lib/instagram/eligibility';
import { listEnqueueDecisions } from '@/lib/instagram/events';
import { evaluateSchedule, isInsideWindow, loadScheduleSnapshot, nextWindowOpening } from '@/lib/instagram/scheduler';
import { deriveQueueState } from '@/lib/instagram/types';

type Command = 'status' | 'check' | 'enqueue';

interface Args {
  command: Command;
  manifestId: string | null;
  as: string | null;
  limit: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: 'status', manifestId: null, as: null, limit: 20 };
  let commandSeen = false;
  const setCommand = (command: Command): void => {
    if (commandSeen) throw new Error('une seule commande à la fois : --status, --check ou --enqueue');
    args.command = command;
    commandSeen = true;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--status':
        setCommand('status');
        break;
      case '--check':
        setCommand('check');
        break;
      case '--enqueue':
        setCommand('enqueue');
        break;
      case '--manifest-id':
        args.manifestId = (argv[++i] ?? '').trim();
        break;
      case '--as':
        args.as = (argv[++i] ?? '').trim();
        break;
      case '--limit':
        args.limit = Number.parseInt(argv[++i] ?? '', 10);
        break;
      default:
        throw new Error(`option inconnue : « ${String(token)} » (cette commande n'a pas de --live)`);
    }
  }

  if (args.command !== 'status' && (args.manifestId === null || args.manifestId.length === 0)) {
    throw new Error('--manifest-id <uuid> est obligatoire');
  }
  if (args.command === 'enqueue' && (args.as === null || args.as.length === 0)) {
    throw new Error('--as "<nom>" est obligatoire — un job enfilé porte le nom de qui l’a demandé');
  }
  if (!Number.isFinite(args.limit) || args.limit < 1) throw new Error('--limit attend un entier ≥ 1');
  return args;
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(26)} ${value}\n`);
}

async function status(limit: number): Promise<void> {
  const config = loadInstagramRail();
  const sql = await getSql();
  try {
    const now = new Date();
    const overview = await loadQueueOverview(sql);
    const snapshot = await loadScheduleSnapshot(sql, config);
    const { safety } = snapshot;

    process.stdout.write('\nIG3 — file Instagram\n\n');

    process.stdout.write(' Arrêt global\n');
    line('engaged', String(safety.killSwitch.engaged));
    line('source', safety.killSwitch.fromDefault ? 'défaut (aucune ligne) — fail-closed' : 'décision explicite');
    line('set_by', safety.killSwitch.setBy ?? '—');
    line('reason', safety.killSwitch.reason ?? '—');

    process.stdout.write('\n Profondeur de file\n');
    if (overview.depth.length === 0) process.stdout.write('  (vide)\n');
    for (const row of overview.depth) {
      line(row.status, `${row.total} (dus ${row.dueNow} · programmés ${row.scheduled})`);
    }
    line('total', String(overview.total));
    line('due_now', String(overview.dueNow));
    line('scheduled', String(overview.scheduled));
    line('blocked', String(overview.blocked));
    line('terminal', String(overview.terminal));
    line(
      'next_scheduled',
      overview.nextScheduledAt === null
        ? '—'
        : `${overview.nextScheduledAt} (job ${overview.nextScheduledJobId ?? '—'})`,
    );

    process.stdout.write('\n Ordonnancement\n');
    line('timezone', config.schedule.timezone);
    line(
      'fenêtres',
      config.schedule.windows
        .map(
          (w) =>
            `jours[${w.days.join(',')}] ` +
            `${String(Math.floor(w.startMinute / 60)).padStart(2, '0')}:${String(w.startMinute % 60).padStart(2, '0')}` +
            `→${String(Math.floor(w.endMinute / 60)).padStart(2, '0')}:${String(w.endMinute % 60).padStart(2, '0')}`,
        )
        .join(' | '),
    );
    line('dans_la_fenêtre', String(isInsideWindow(now, config.schedule)));
    line('prochaine_ouverture', nextWindowOpening(now, config.schedule)?.toISOString() ?? '—');
    line('jitter_ms', String(config.schedule.jitterMs));

    process.stdout.write('\n Plafonds\n');
    line(
      'daily',
      `${safety.sentLastDay}/${config.caps.dailySentCap} utilisés · ` +
        `${Math.max(0, config.caps.dailySentCap - safety.sentLastDay)} restants` +
        (snapshot.dailyCapFreesAt === null ? '' : ` · libère ${snapshot.dailyCapFreesAt}`),
    );
    line(
      'hourly',
      `${safety.sentLastHour}/${config.caps.hourlySentCap} utilisés · ` +
        `${Math.max(0, config.caps.hourlySentCap - safety.sentLastHour)} restants` +
        (snapshot.hourlyCapFreesAt === null ? '' : ` · libère ${snapshot.hourlyCapFreesAt}`),
    );
    line('min_interval_ms', String(config.caps.minSendIntervalMs));
    line('dernier_effet_réel', snapshot.lastExternalEffectAt ?? 'aucune tentative d’effet externe');
    line(
      'ms_depuis_effet',
      safety.msSinceLastExternalEffect === null ? '—' : String(safety.msSinceLastExternalEffect),
    );
    line('consecutive_failures', `${safety.consecutiveFailures}/${config.caps.maxConsecutiveFailures}`);
    line('session_failures', `${safety.sessionFailures}/${config.caps.maxSessionFailures}`);

    // Les deux verdicts, côte à côte. C'est la lecture qui répond à la question
    // que pose la mission : « ce que le worker aurait envoyé, et quand ».
    const live = evaluateSchedule({ now, snapshot, config, killSwitch: 'enforce' });
    const dry = evaluateSchedule({ now, snapshot, config, killSwitch: 'project' });
    process.stdout.write('\n Verdict d’ordonnancement\n');
    line(
      'LIVE',
      live.allowed
        ? 'rien ne s’oppose (il resterait l’identité, la session et une autorisation canari)'
        : `REPORTÉ [${live.reason}] ${live.nextEligibleAt === null ? 'sans échéance' : `→ ${live.nextEligibleAt.toISOString()}`}`,
    );
    line(
      'DRY_RUN',
      dry.allowed
        ? 'le worker traiterait les jobs dus'
        : `REPORTÉ [${dry.reason}] ${dry.nextEligibleAt === null ? 'sans échéance' : `→ ${dry.nextEligibleAt.toISOString()}`}`,
    );

    if (overview.skipReasons.length > 0) {
      process.stdout.write('\n Reports en cours\n');
      for (const row of overview.skipReasons) line(row.reason, String(row.count));
    }

    const jobs = await listInstagramJobs(sql, limit);
    process.stdout.write(`\n Jobs récents (${jobs.length})\n`);
    if (jobs.length === 0) process.stdout.write('  (vide)\n');
    for (const job of jobs) {
      const state = deriveQueueState(job.status, job.notBefore, now);
      process.stdout.write(
        `  ${state.padEnd(18)} ${job.expectedHandle.padEnd(20)} att=${String(job.attempts).padEnd(3)} ` +
          `skips=${String(job.skipCount).padEnd(3)} ${(job.lastSkipReason ?? job.lastReasonCode ?? '—').padEnd(24)} ` +
          `not_before=${job.notBefore}  ${job.id}\n`,
      );
    }

    const decisions = await listEnqueueDecisions(sql, limit);
    process.stdout.write(`\n Verdicts d’éligibilité récents (${decisions.length})\n`);
    if (decisions.length === 0) process.stdout.write('  (aucun)\n');
    for (const row of decisions) {
      process.stdout.write(
        `  ${row.verdict.padEnd(16)} ${(row.expectedHandle ?? '—').padEnd(20)} ${row.reasonCode.padEnd(30)} ` +
          `${row.createdAt}\n`,
      );
    }

    // Compté sur les JOBS, jamais sur les événements : le drapeau du job est
    // posé une fois et une seule, tandis qu'une adjudication postérieure écrit
    // un second événement qui DÉCRIT la même tentative.
    const effects = await sql.query<{ n: string }>(
      `select count(*) as n from ig_dispatch_jobs where external_effect_attempted = true`,
    );
    const outreach = await sql.query<{ n: string }>(
      `select count(*) as n from outreach_events where channel = 'instagram_dm'`,
    );
    process.stdout.write('\n Effets réels\n');
    line('external_effect_attempted', effects[0]?.n ?? '0');
    line('outreach_events instagram', outreach[0]?.n ?? '0');
    process.stdout.write('\n');
  } finally {
    await sql.close();
  }
}

async function check(manifestId: string): Promise<void> {
  const sql = await getSql();
  try {
    const decision = await evaluateInstagramEligibility(sql, { manifestId, action: 'first_touch_dm' });
    process.stdout.write('\nIG3 — éligibilité (lecture seule, rien n’est journalisé ni enfilé)\n\n');
    line('verdict', formatEligibility(decision));
    line('prospect_id', decision.prospectId ?? '—');
    line('manifest_id', decision.manifestId ?? '—');
    line('expected_handle', decision.expectedHandle ?? '—');
    line('reason_code', decision.reasonCode);
    line('detail', decision.detail);
    process.stdout.write('\n Portes\n');
    for (const gate of decision.gates) {
      process.stdout.write(`  ${gate.verdict.padEnd(6)} ${gate.gate.padEnd(24)} ${gate.detail ?? ''}\n`);
    }
    process.stdout.write('\n');
    if (decision.verdict !== 'ELIGIBLE') process.exitCode = 1;
  } finally {
    await sql.close();
  }
}

async function enqueue(manifestId: string, as: string): Promise<void> {
  const sql = await getSql();
  try {
    const result = await enqueueInstagramJob(sql, { manifestId, action: 'first_touch_dm', enqueuedBy: as });

    process.stdout.write(`\nIG3 — ${result.created ? 'job enfilé' : 'job déjà présent (aucun doublon créé)'}\n`);
    line('verdict', formatEligibility(result.eligibility));
    line('decision_id', result.decisionId);
    line('job_id', result.job.id);
    line('manifest_id', result.job.manifestId);
    line('prospect_id', result.job.prospectId);
    line('action', result.job.action);
    line('idempotency_key', result.job.idempotencyKey);
    line('expected_handle', result.job.expectedHandle);
    line('status', result.job.status);
    line('scheduled_at', result.job.notBefore);
    line('attempts', String(result.job.attempts));
    process.stdout.write(
      '\nAucun envoi. Le job attend derrière l’ordonnanceur, les plafonds, la session, ' +
        'l’identité et l’arrêt global.\n\n',
    );
  } finally {
    await sql.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'status') return status(args.limit);
  if (args.command === 'check') return check(args.manifestId as string);
  return enqueue(args.manifestId as string, args.as as string);
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
