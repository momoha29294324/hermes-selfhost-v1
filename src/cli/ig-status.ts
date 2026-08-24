#!/usr/bin/env tsx
/**
 * IG-R1 §8 — l'état du rail, en lecture seule.
 *
 *   npm run ig:status
 *
 * Rien ici n'ouvre de navigateur, ne prend de job ni n'écrit une ligne. C'est
 * la commande qu'on lance avant de se demander si quelque chose peut partir —
 * et la réponse par défaut est « non », parce que l'arrêt global est armé tant
 * que personne ne l'a levé.
 */
import { getSql } from '@/lib/db';
import { loadInstagramRail } from '@/lib/config/load';
import { listInstagramJobs } from '@/lib/instagram/queue';
import { listCanaryAuthorizations } from '@/lib/instagram/canary';
import { evaluateSafety, loadSafetySnapshot } from '@/lib/instagram/safety';
import { hasLiveAdapter } from '@/lib/pipeline/r6bTransportAdapters';
import { inspectInstagramBrowserLease } from '@/lib/instagram/browserProfileLease';

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(26)} ${value}\n`);
}

async function main(): Promise<void> {
  const config = loadInstagramRail();
  const sql = await getSql();
  try {
    const snapshot = await loadSafetySnapshot(sql, config);
    const verdict = evaluateSafety(snapshot, config);

    process.stdout.write('\nIG-R1/IG2 — état du rail\n\n');
    process.stdout.write(' Capacité d’envoi\n');
    line('live_adapter_instagram_dm', String(hasLiveAdapter('instagram_dm')));
    // Depuis IG2, un adapter LIVE existe : ce n'est plus une anomalie, c'est un
    // fait. Ce qui décide reste ailleurs — l'arrêt global et une autorisation
    // canari nominative, tous deux affichés plus bas.
    const canaries = await listCanaryAuthorizations(sql, 5);
    const armed = canaries.filter((auth) => auth.state === 'ARMED');
    line('canary_armed', String(armed.length));
    for (const auth of armed) {
      line('  → autorisation', `${auth.id} · ${auth.expectedHandle} · échéance ${auth.expiresAt} · par ${auth.armedBy}`);
    }
    line(
      'conclusion',
      snapshot.killSwitch.engaged
        ? 'aucun envoi possible — arrêt global armé'
        : armed.length === 0
          ? 'aucun envoi possible — arrêt levé mais aucune autorisation canari'
          : 'ATTENTION — arrêt levé ET autorisation canari armée',
    );

    process.stdout.write('\n Arrêt global\n');
    line('engaged', String(snapshot.killSwitch.engaged));
    line('source', snapshot.killSwitch.fromDefault ? 'défaut (aucune ligne) — fail-closed' : 'décision explicite');
    line('set_by', snapshot.killSwitch.setBy ?? '—');
    line('reason', snapshot.killSwitch.reason ?? '—');
    line('updated_at', snapshot.killSwitch.updatedAt ?? '—');

    // Le profil navigateur, et qui le tient.
    //
    // Deux runtimes Hermes le partagent — la relève entrante et le worker
    // sortant — et un seul peut l'ouvrir à la fois. Sans cette lecture, un
    // opérateur qui voit un tour sans effet n'a aucun moyen de distinguer « une
    // porte a refusé » de « l'autre rail travaillait ». Le chemin affiché est
    // le chemin RÉEL, liens résolus : c'est lui qui sert de clé au bail.
    const lease = inspectInstagramBrowserLease(config.session.profileDir);
    process.stdout.write('\n Profil navigateur\n');
    line('profile_dir (config)', config.session.profileDir);
    line('profile_path (réel)', lease.profilePath);
    line('bail', lease.held ? 'TENU' : 'libre');
    if (lease.holder !== null) {
      line('  → détenteur', `pid ${String(lease.holder.pid)} sur ${lease.holder.hostname}`);
      line('  → depuis', lease.holder.startedAt);
      line('  → commande', lease.holder.cmd.slice(0, 90));
    }

    process.stdout.write('\n Plafonds\n');
    line('sent_last_24h', `${snapshot.sentLastDay}/${config.caps.dailySentCap}`);
    line('sent_last_1h', `${snapshot.sentLastHour}/${config.caps.hourlySentCap}`);
    line(
      'ms_since_last_effect',
      snapshot.msSinceLastExternalEffect === null
        ? 'aucune tentative d’effet externe'
        : String(snapshot.msSinceLastExternalEffect),
    );
    line('min_send_interval_ms', String(config.caps.minSendIntervalMs));
    line('consecutive_failures', `${snapshot.consecutiveFailures}/${config.caps.maxConsecutiveFailures}`);
    line('session_failures', `${snapshot.sessionFailures}/${config.caps.maxSessionFailures}`);
    line('verdict', verdict.allowed ? 'les gardes laisseraient passer un DRY-RUN' : `BLOQUÉ [${verdict.code}]`);
    if (!verdict.allowed) line('raison', verdict.reason);

    const jobs = await listInstagramJobs(sql, 20);
    process.stdout.write(`\n File (${jobs.length} job(s) les plus récents)\n`);
    if (jobs.length === 0) process.stdout.write('  (vide)\n');
    for (const job of jobs) {
      process.stdout.write(
        `  ${job.status.padEnd(18)} ${job.expectedHandle.padEnd(22)} attempts=${String(job.attempts).padEnd(3)} ` +
          `${job.lastReasonCode ?? '—'}  ${job.id}\n`,
      );
    }

    const counts = await sql.query<{ status: string; n: string }>(
      `select status, count(*) as n from ig_job_events group by status order by status`,
    );
    process.stdout.write('\n Journal des tentatives\n');
    if (counts.length === 0) process.stdout.write('  (vide)\n');
    for (const row of counts) line(row.status, row.n);

    // Compté sur les JOBS, jamais sur les événements.
    //
    // Le drapeau du job est posé une fois et une seule (`where
    // external_effect_attempted = false`) : un job qui le porte a tenté un
    // effet, exactement un. Les événements, eux, se multiplient sans qu'un
    // octet parte — une adjudication postérieure (IG2.1) en écrit un second qui
    // DÉCRIT la même tentative. Les compter reviendrait à annoncer deux DM là
    // où il n'y en a jamais eu qu'un.
    const effects = await sql.query<{ n: string }>(
      `select count(*) as n from ig_dispatch_jobs where external_effect_attempted = true`,
    );
    line('effets Instagram réels', effects[0]?.n ?? '0');

    const adjudications = await sql.query<{ verdict: string; adjudicatedBy: string; createdAt: string; jobId: string }>(
      `select verdict, adjudicated_by as "adjudicatedBy", created_at as "createdAt", job_id as "jobId"
         from ig_canary_adjudications order by created_at desc limit 5`,
    );
    process.stdout.write('\n Adjudications\n');
    if (adjudications.length === 0) process.stdout.write('  (aucune)\n');
    for (const row of adjudications) {
      line(row.verdict, `${row.jobId} · par ${row.adjudicatedBy} · ${row.createdAt}`);
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
