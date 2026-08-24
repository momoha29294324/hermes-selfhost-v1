#!/usr/bin/env tsx
/**
 * IG5.1 §13 — l'état du rail ENTRANT, en lecture seule.
 *
 *   npm run ig:inbound:status
 *   npm run ig:inbound:status -- --polls 10
 *
 * Rien ici n'ouvre de navigateur, ne relève de boîte ni n'écrit une ligne.
 * C'est la commande qu'on lance pour savoir ce qui a été observé — et elle
 * distingue toujours « relevé, rien n'est arrivé » de « jamais relevé ».
 */
import { getSql } from '@/lib/db';
import { loadInstagramRail } from '@/lib/config/load';
import { resolveInboundRuntimeConfig } from '@/lib/inbound/instagramRuntime';
import { loadInboundRuntimeStatus } from '@/lib/inbound/instagramRuntimeStatus';

class ArgError extends Error {}

interface Args {
  readonly polls: number;
}

function parseArgs(argv: readonly string[]): Args {
  let polls = 5;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--polls') {
      const raw = argv[i + 1];
      i += 1;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new ArgError('--polls attend un entier entre 1 et 100');
      }
      polls = value;
      continue;
    }
    throw new ArgError(`option inconnue : ${String(arg)}`);
  }
  return { polls };
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(28)} ${value}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadInstagramRail();
  const sql = await getSql();
  try {
    process.stdout.write('\nIG5.1 / IG5.2A — état du rail entrant Instagram (lecture seule)\n\n');

    const runtime = resolveInboundRuntimeConfig(config, process.env);
    const status = await loadInboundRuntimeStatus(sql, runtime);

    process.stdout.write(' Configuration\n');
    line('account_handle', runtime.accountHandle ?? '— (à nommer avec --account)');
    line('max_threads_per_poll', String(runtime.maxThreadsPerPoll));
    line('lease_ms', String(runtime.leaseMs));
    line('profile_label', config.session.profileLabel);
    // La fenêtre sortante ne s'applique pas ici, et le dire est le but de cette
    // ligne : c'est la question qu'un opérateur se pose en premier.
    line('fenêtre de collecte', '24/7 — la fenêtre cold outbound ne s’applique pas à la lecture');

    // ---- IG5.2A — le runtime ------------------------------------------------
    //
    // « Dernier tour » et « dernier tour RÉUSSI » sont deux lignes distinctes,
    // et c'est le point de tout ce bloc : un rail qui échoue toutes les cinq
    // minutes a un dernier tour très frais. Les confondre rendrait ce statut
    // rassurant et faux.
    process.stdout.write('\n Runtime (IG5.2A)\n');
    line('enabled', runtime.enabled ? 'true' : 'false — désarmé, aucune relève automatique');
    line('poll_interval_ms', String(runtime.pollIntervalMs));
    line('retry_backoff_ms', String(runtime.retryBackoffMs));
    line('max_backoff_ms', String(runtime.maxBackoffMs));
    line('awaiting_human_backoff_ms', String(runtime.awaitingHumanBackoffMs));
    line('verdict à cet instant', status.decision.verdict);
    line('  → raison', status.decision.reason.slice(0, 140));
    line('prochaine tentative', status.decision.nextAttemptAt?.toISOString() ?? '—');
    line('intervention humaine', status.decision.needsHuman ? 'REQUISE' : 'non');
    line('tours non réussis d’affilée', String(status.state?.consecutiveFailures ?? 0));
    line(
      'bail en cours',
      status.state?.running == null
        ? '— (aucun tour RUNNING)'
        : `${status.state.running.pollId} — « ${status.state.running.polledBy} » jusqu’à ${status.state.running.leaseExpiresAt.toISOString()}`,
    );
    line(
      'dernier tour',
      status.state?.lastTerminal == null
        ? '— (jamais relevé)'
        : `${status.state.lastTerminal.status} / ${status.state.lastTerminal.sessionState ?? '—'} / ` +
          `${status.state.lastTerminal.inboxReadability ?? '—'} à ${status.state.lastTerminal.finishedAt.toISOString()}`,
    );
    line(
      'dernier tour RÉUSSI',
      status.state?.lastSuccessful == null
        ? '— (aucun tour n’a lu la boîte)'
        : status.state.lastSuccessful.finishedAt.toISOString(),
    );
    line('kill-switch sortant', 'non consulté — il arrête les effets, pas la lecture');

    const polls = await sql.query<{
      id: string;
      accountHandle: string;
      status: string;
      startedAt: string;
      finishedAt: string | null;
      sessionState: string | null;
      inboxReadability: string | null;
      threadsSeen: number;
      threadsRead: number;
      messagesObserved: number;
      messagesIngested: number;
      messagesAlreadyKnown: number;
      blockedWriteRequests: number;
      detail: string | null;
    }>(
      `select id, account_handle as "accountHandle", status,
              started_at as "startedAt", finished_at as "finishedAt",
              session_state as "sessionState", inbox_readability as "inboxReadability",
              threads_seen as "threadsSeen", threads_read as "threadsRead",
              messages_observed as "messagesObserved", messages_ingested as "messagesIngested",
              messages_already_known as "messagesAlreadyKnown",
              blocked_write_requests as "blockedWriteRequests", detail
         from ig_inbound_polls
        order by started_at desc
        limit $1`,
      [args.polls],
    );

    process.stdout.write(`\n Tours de relève (${polls.length} le(s) plus récent(s))\n`);
    if (polls.length === 0) process.stdout.write('  (aucune relève enregistrée)\n');
    for (const poll of polls) {
      process.stdout.write(
        `  ${poll.status.padEnd(10)} @${poll.accountHandle.padEnd(20)} ` +
          `fils ${poll.threadsRead}/${poll.threadsSeen}  ` +
          `msg ${poll.messagesObserved} → ${poll.messagesIngested} nouveau(x), ${poll.messagesAlreadyKnown} connu(s)  ` +
          `bloquées ${poll.blockedWriteRequests}  ${poll.startedAt}\n`,
      );
      if (poll.sessionState !== null || poll.inboxReadability !== null) {
        line('  → session / boîte', `${poll.sessionState ?? '—'} / ${poll.inboxReadability ?? '—'}`);
      }
      if (poll.detail !== null) line('  → détail', poll.detail.slice(0, 160));
    }

    const outcomes = await sql.query<{ outcome: string; n: string }>(
      `select outcome, count(*)::text as n
         from ig_inbound_message_observations group by outcome order by outcome`,
    );
    process.stdout.write('\n Bulles observées, par issue\n');
    if (outcomes.length === 0) process.stdout.write('  (aucune)\n');
    for (const row of outcomes) line(row.outcome, row.n);

    const threadOutcomes = await sql.query<{ outcome: string; n: string }>(
      `select outcome, count(*)::text as n
         from ig_inbound_thread_observations group by outcome order by outcome`,
    );
    process.stdout.write('\n Fils observés, par issue\n');
    if (threadOutcomes.length === 0) process.stdout.write('  (aucun)\n');
    for (const row of threadOutcomes) line(row.outcome, row.n);

    const correlation = await sql.query<{ correlationStatus: string; n: string }>(
      `select correlation_status as "correlationStatus", count(*)::text as n
         from r6b_inbound_messages where provider = 'instagram'
        group by correlation_status order by correlation_status`,
    );
    process.stdout.write('\n Réponses Instagram, par corrélation\n');
    if (correlation.length === 0) process.stdout.write('  (aucune)\n');
    for (const row of correlation) line(row.correlationStatus, row.n);

    process.stdout.write('\n Aval\n');
    line('classifiées', String(status.backlog.classified));
    line('brouillons (PROPOSED max)', String(status.backlog.drafted));
    line('alertes', String(status.backlog.alerts));
    line('liens de fil observés', String(status.observations.threadBindings));

    // Le RETARD, compté par la requête même que l'aval exécute pour choisir son
    // travail. Une seconde définition du retard aurait fini par contredire
    // celle qui décide vraiment.
    process.stdout.write('\n Retard (§8 — persisté mais pas encore traité)\n');
    line('corrélées sans analyse vivante', String(status.backlog.unprocessed));
    line('revue humaine requise', String(status.backlog.reviewRequired));
    line('non corrélées', String(status.backlog.unmatched));
    if (status.backlog.unprocessed > 0) {
      process.stdout.write(
        '  → repris automatiquement au prochain tour du runtime, ou à la main avec\n' +
          '    « npm run r6b:replies:process -- --resume ».\n',
      );
    }

    // Ce que cette commande ne peut pas faire, dit explicitement : c'est la
    // même discipline que `ig:status`, qui conclut sur ce qui reste impossible.
    process.stdout.write(
      '\nAucun envoi, aucune réponse, aucun accusé de lecture. Le rail entrant n’a pas de primitive d’action.\n\n',
    );
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof ArgError ? 1 : 2;
});
