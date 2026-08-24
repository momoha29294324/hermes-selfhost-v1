#!/usr/bin/env tsx
/**
 * IG5.1 §13/§18 — la relève entrante Instagram.
 *
 *   npm run ig:inbound:poll -- --account <handle> --dry-run
 *   npm run ig:inbound:poll -- --account <handle>
 *   npm run ig:inbound:poll -- --account <handle> --max 5 --headed
 *
 * ---------------------------------------------------------------------------
 * Ce que cette commande ne peut pas faire
 * ---------------------------------------------------------------------------
 *
 * Envoyer. Répondre. Marquer un fil comme lu. Suivre, aimer, commenter. Ce
 * n'est pas une consigne : le rail construit ici (`PlaywrightInstagramInboundRail`)
 * n'expose aucune de ces méthodes, le collecteur refuse de tourner si l'objet
 * qu'on lui passe en expose une, et la garde réseau du contexte refuse qu'une
 * requête d'effet sorte du processus — `IGDirectTextSendMutation` comme
 * `useIGDMarkThreadAsReadMutation` sont refusées avant d'atteindre Instagram.
 *
 * ---------------------------------------------------------------------------
 * `--dry-run`
 * ---------------------------------------------------------------------------
 *
 * Observe et AFFICHE, sans écrire une seule ligne en base. C'est le mode du
 * smoke réel : il prouve que le chemin de lecture fonctionne sans faire dépendre
 * quoi que ce soit d'une migration appliquée ailleurs. Aucun texte de
 * conversation n'est imprimé — seulement des métadonnées et des empreintes.
 */
import { getSql } from '@/lib/db';
import { loadInstagramRail } from '@/lib/config/load';
import { collectInstagramInbound } from '@/lib/inbound/instagramCollector';
import { PlaywrightInstagramInboundRail } from '@/lib/instagram/playwrightInboundRail';
import { forbiddenMethodsOn } from '@/lib/instagram/inboundRail';
import { hasSendPrimitive } from '@/lib/instagram/rail';
import { normalizeHandle } from '@/lib/instagram/identity';
import { logger } from '@/lib/logging/logger';

class ArgError extends Error {}

interface Args {
  readonly account: string | null;
  readonly max: number | null;
  readonly dryRun: boolean;
  readonly headed: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let account: string | null = null;
  let max: number | null = null;
  let dryRun = false;
  let headed = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--account') {
      const raw = argv[i + 1];
      i += 1;
      if (raw === undefined) throw new ArgError('--account attend un handle Instagram');
      const normalized = normalizeHandle(raw);
      if (normalized === null) throw new ArgError(`handle invalide : « ${raw} »`);
      account = normalized;
      continue;
    }
    if (arg === '--max') {
      const raw = argv[i + 1];
      i += 1;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > 50) {
        throw new ArgError('--max attend un entier entre 1 et 50');
      }
      max = value;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--headed') {
      headed = true;
      continue;
    }
    throw new ArgError(`option inconnue : ${String(arg)}`);
  }
  return { account, max, dryRun, headed };
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(28)} ${value}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadInstagramRail();

  const account = args.account ?? config.inbound.accountHandle;
  if (account === null) {
    // Fail-closed AVANT d'ouvrir quoi que ce soit : deviner le compte depuis la
    // session ouverte reviendrait à relever une boîte que personne n'a nommée.
    throw new ArgError(
      'aucun compte à relever : passer --account <handle>, ou renseigner ' +
        'config/instagram.json → inbound.accountHandle',
    );
  }
  const maxThreads = args.max ?? config.inbound.maxThreadsPerPoll;

  const rail = new PlaywrightInstagramInboundRail({
    config,
    workerId: `ig-inbound-${process.pid}`,
    headless: !args.headed,
    screenshotDir: `${config.session.profileDir.replace(/\/profile$/, '')}/inbound-screenshots`,
  });

  // La preuve, avant l'usage. Deux questions distinctes, toutes deux posées à
  // l'OBJET et non au type : sait-il envoyer ? sait-il agir autrement ?
  const forbidden = forbiddenMethodsOn(rail);
  if (hasSendPrimitive(rail) || forbidden.length > 0) {
    throw new Error(
      `le rail entrant expose une capacité d'action (${forbidden.join(', ') || 'primitive d’envoi'}) — ` +
        'relève refusée',
    );
  }

  process.stdout.write('\nIG5.1 — RELÈVE ENTRANTE INSTAGRAM (lecture seule)\n\n');
  line('compte relevé', `@${account}`);
  line('mode', args.dryRun ? 'DRY-RUN — aucune écriture en base' : 'relève persistée');
  line('max_threads', String(maxThreads));
  line('send_primitive', 'absente');

  try {
    if (args.dryRun) {
      const sweep = await rail.observeInbox({ accountHandle: account, maxThreads });
      process.stdout.write('\n Observation\n');
      line('session_state', sweep.sessionState);
      line('inbox_readability', sweep.readability);
      line('stop_reason', sweep.stopReason ?? '—');
      line('lignes vues', String(sweep.rowsSeen));
      // IG5 R2 — la liste de fils servie par Instagram. « non lue » n'est pas
      // « vide » : sans elle, aucune ligne ne peut être ouverte, et aucune
      // absence de réponse ne peut en être déduite.
      line('liste de fils', sweep.threadListReadable ? `lue (${sweep.threadListSize} fil(s))` : 'NON LUE');
      line('requêtes d’écriture bloquées', String(sweep.blockedWriteRequests));
      line('durée_ms', String(sweep.durationMs));

      process.stdout.write('\n Fils\n');
      if (sweep.threads.length === 0) process.stdout.write('  (aucun)\n');
      for (const thread of sweep.threads) {
        const incoming = thread.messages.filter((message) => message.direction === 'INCOMING').length;
        const outgoing = thread.messages.filter((message) => message.direction === 'OUTGOING').length;
        const unknown = thread.messages.length - incoming - outgoing;
        const counterparty = thread.counterpartyHandle ?? thread.rowCounterpartyHandle;
        // Aucun texte de conversation n'est imprimé : seulement des comptes,
        // et la PROVENANCE de l'identifiant, qui n'a pas la même force selon
        // qu'elle vient de la ligne elle-même ou de la liste réseau.
        process.stdout.write(
          `  #${String(thread.rowIndex).padEnd(3)} ${thread.outcome.padEnd(14)} ` +
            `fil ${(thread.threadId ?? '—').padEnd(18)} ` +
            `src ${(thread.threadIdSource ?? '—').padEnd(8)} ` +
            // IG5 R3 — la source des MESSAGES et l'identité du fil. Deux faits
            // distincts de la source de l'identifiant, et tous deux nécessaires
            // pour relire un relevé : « lu par le réseau, sur le bon fil » n'a
            // pas la même valeur que « lu dans le DOM ».
            `msg ${(thread.messageSource ?? '—').padEnd(22)} ` +
            `id ${(thread.threadIdentity ?? '—').padEnd(24)} ` +
            `contrepartie ${(counterparty === null ? '—' : `@${counterparty}`).padEnd(24)} ` +
            `entrants ${incoming} · sortants ${outgoing} · indécidables ${unknown}` +
            `${thread.truncated ? ' · INCOMPLET' : ''}\n`,
        );
      }
      process.stdout.write(
        '\nAperçu non persistant : aucune ligne écrite, aucune structure IG5 créée.\n' +
          'Aucun envoi, aucune réponse, aucun accusé de lecture.\n\n',
      );
      return;
    }

    const sql = await getSql();
    try {
      const report = await collectInstagramInbound(
        sql,
        { rail, logger: logger.child({ cli: 'ig-inbound-poll' }) },
        {
          accountHandle: account,
          // Les mêmes anciens noms que le runtime : une relève à la main ne
          // doit pas réingérer ce qu'une relève supervisée reconnaîtrait.
          formerAccountHandles: config.inbound.formerAccountHandles,
          polledBy: `cli:${process.env.USER ?? 'operator'}`,
          maxThreads,
          leaseMs: config.inbound.leaseMs,
        },
      );

      process.stdout.write('\n Relève\n');
      line('poll_id', report.pollId);
      line('session_state', report.sessionState);
      line('inbox_readability', report.readability);
      line('stop_reason', report.stopReason ?? '—');
      line('lignes vues', String(report.rowsSeen));
      line('liste de fils', report.threadListReadable ? `lue (${report.threadListSize} fil(s))` : 'NON LUE');
      line('fils lus', String(report.threadsRead));
      line('fils sans identifiant', String(report.threadsNotOpened));
      line('fils illisibles', String(report.threadsUnreadable));
      line('fils reportés (borne)', String(report.threadsSkipped));
      line('fils liés à un manifeste', String(report.threadsBound));

      process.stdout.write('\n Bulles\n');
      line('observées', String(report.messagesObserved));
      line('sortantes (ignorées)', String(report.outgoingSkipped));
      line('direction indécidable', String(report.unknownDirectionSkipped));
      line('expéditeur non identifié', String(report.unidentifiedSenderSkipped));
      // IG5 R3 §7 — un message antérieur à notre DM n'est pas une réponse à ce
      // DM. Compté séparément, jamais confondu avec « rien vu ».
      line('antérieures au DM (écartées)', String(report.preOutreachSkipped));
      line('sans envoi connu (écartées)', String(report.noOutreachSkipped));
      line('sans texte (photo, vocal)', String(report.nonTextSkipped));
      line('réponses nouvelles', String(report.ingested));
      line('réponses déjà connues', String(report.alreadyKnown));

      // IG5 R3 §8 — la partie du rapport qui distingue « pas de réponse » de
      // « je n'ai pas su lire ». Sans elle, les deux se ressemblent : zéro
      // ligne de réponse dans les deux cas.
      process.stdout.write('\n Réponse, par fil lu\n');
      if (report.replyStatuses.length === 0) process.stdout.write('  (aucun fil lu)\n');
      for (const status of report.replyStatuses) {
        process.stdout.write(
          `  #${String(status.rowIndex).padEnd(3)} ` +
            `${(status.counterpartyHandle === null ? '—' : `@${status.counterpartyHandle}`).padEnd(24)} ` +
            `${status.replyStatus.padEnd(18)} ` +
            `messages ${String(status.messagesRead).padStart(3)} · ` +
            `notre DM ${status.outboundFound ? 'retrouvé' : 'absent  '} · ` +
            `envoi ${status.outreachSentAt === null ? '—' : status.outreachSentAt.toISOString()}\n`,
        );
      }

      const byStatus = new Map<string, number>();
      for (const entry of report.correlated) {
        byStatus.set(entry.correlationStatus, (byStatus.get(entry.correlationStatus) ?? 0) + 1);
      }
      process.stdout.write('\n Corrélation\n');
      if (byStatus.size === 0) process.stdout.write('  (aucune réponse)\n');
      for (const [status, count] of [...byStatus.entries()].sort()) line(status, String(count));

      process.stdout.write('\n Gardes\n');
      line('requêtes d’écriture bloquées', String(report.blockedWriteRequests));
      line('fils tronqués', String(report.truncatedThreads));

      if (report.ingested > 0) {
        process.stdout.write(
          '\nLes réponses corrélées ne sont ni classées ni rédigées ici : lancer ' +
            '« npm run r6b:replies:process ».\n',
        );
      }
      process.stdout.write('\nAucun envoi, aucune réponse, aucun accusé de lecture.\n\n');
    } finally {
      await sql.close();
    }
  } finally {
    await rail.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof ArgError ? 1 : 2;
});
