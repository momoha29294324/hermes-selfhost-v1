#!/usr/bin/env tsx
/**
 * R6B-D1 §11 — un tour de lecture de la boîte, une fois, puis on sort.
 *
 *   npm run r6b:inbound:poll
 *   npm run r6b:inbound:poll -- --mailbox reponse@exemple.fr --max 50
 *   npm run r6b:inbound:poll -- --show 10
 *
 * Volontairement pas un démon. Une primitive déterministe se relance,
 * s'observe et se raisonne ; une boucle de fond fait la même chose sans que
 * personne ne regarde. Le jour où un démon sera justifié, il appellera cette
 * fonction — il ne la remplacera pas.
 *
 * Cette commande ne peut RIEN envoyer : elle ne connaît aucun provider
 * d'envoi, aucune identité d'expéditeur, et le module qu'elle appelle n'en
 * importe aucun. Elle ne peut rien modifier dans Gmail non plus — le contrat
 * `InboundMailboxProvider` ne nomme aucune opération d'écriture, et le jeton
 * est refusé s'il porte une portée qui en donnerait le pouvoir.
 *
 * C'est ici, et seulement ici, que le vrai client Gmail est construit : le
 * domaine exige qu'on lui fournisse un fournisseur et n'en fabrique jamais.
 */
import { getSql } from '@/lib/db';
import { pollInboundReplies, type PollReport } from '@/lib/inbound/intake';
import {
  GMAIL_ENV_KEYS,
  GMAIL_READONLY_SCOPE,
  GmailInboundProvider,
  GmailRestApi,
  GmailScopeError,
  readGmailCredentials,
} from '@/lib/inbound/gmailProvider';
import { loadInboundSummary, loadRecentInbound } from '@/lib/inbound/replies';
import type { Sql } from '@/lib/db/sql';

class InboundArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboundArgError';
  }
}

interface InboundArgs {
  readonly mailbox: string | null;
  readonly maxMessages: number;
  readonly show: number;
}

function parseArgs(argv: readonly string[]): InboundArgs {
  let mailbox: string | null = null;
  let maxMessages = 100;
  let show = 0;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '--mailbox') {
      if (!next) throw new InboundArgError('--mailbox attend une adresse');
      mailbox = next.trim().toLowerCase();
      i += 1;
      continue;
    }
    if (arg === '--max') {
      const parsed = Number.parseInt(next ?? '', 10);
      if (!Number.isFinite(parsed) || parsed < 1) throw new InboundArgError('--max attend un entier ≥ 1');
      maxMessages = Math.min(500, parsed);
      i += 1;
      continue;
    }
    if (arg === '--show') {
      const parsed = Number.parseInt(next ?? '', 10);
      if (!Number.isFinite(parsed) || parsed < 1) throw new InboundArgError('--show attend un entier ≥ 1');
      show = Math.min(50, parsed);
      i += 1;
      continue;
    }
    throw new InboundArgError(`option inconnue : ${arg}`);
  }

  return { mailbox, maxMessages, show };
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(24)} ${value}\n`);
}

function reportPoll(report: PollReport): void {
  process.stdout.write('\nR6B-D1 — POLL ENTRANT (lecture seule)\n');
  line('provider', report.provider);
  line('mailbox', report.mailbox);
  line('strategy', report.strategy);
  line('since', report.since ?? '—');
  line('counterparties', String(report.counterparties.length));
  line('listed', String(report.listedMessages));
  line('fetched', String(report.fetchedMessages));
  line('already_known', String(report.alreadyKnown));
  line('persisted', String(report.persisted));
  line('EXACT', String(report.counts.EXACT));
  line('HIGH_CONFIDENCE', String(report.counts.HIGH_CONFIDENCE));
  line('REVIEW_REQUIRED', String(report.counts.REVIEW_REQUIRED));
  line('UNMATCHED', String(report.counts.UNMATCHED));
  line('truncated', String(report.truncated));
  line('checkpoint_invalidated', String(report.checkpointInvalidated));
  line('checkpoint_advanced', String(report.checkpointAdvanced));

  if (report.checkpointInvalidated) {
    process.stderr.write(
      '\nMARQUEUR DE BOÎTE INUTILISABLE — resynchronisation bornée effectuée.\n' +
        'Aucun message n’a été sauté : la borne de lecture vient de la date, pas du marqueur.\n',
    );
  }
  if (report.truncated) {
    process.stderr.write(
      `\nLISTE TRONQUÉE au plafond (--max ${report.listedMessages}) — le curseur n’a PAS avancé.\n` +
        'Relancer la commande pour lire la suite ; l’ingestion est idempotente.\n',
    );
  }
  for (const failure of report.failures) {
    process.stderr.write(`  échec ${failure.providerMessageId} : ${failure.reason}\n`);
  }
  if (report.failures.length > 0) {
    process.stderr.write(
      `\n${report.failures.length} message(s) non ingéré(s) — le curseur n’a PAS avancé, rien n’est perdu.\n`,
    );
  }
}

async function showRecent(sql: Sql, limit: number): Promise<void> {
  const rows = await loadRecentInbound(sql, limit);
  if (rows.length === 0) {
    process.stdout.write('\nAucun message entrant en base.\n');
    return;
  }
  process.stdout.write(`\n${rows.length} message(s) entrant(s) les plus récents :\n`);
  for (const row of rows) {
    process.stdout.write(
      `\n  ${row.receivedAt}  ${row.correlationStatus}` +
        `${row.correlationMethod ? ` (${row.correlationMethod})` : ''}\n` +
        `    de       ${row.fromAddress}\n` +
        `    objet    ${row.subject ?? '—'}\n` +
        `    manifeste ${row.manifestId ?? '—'}\n` +
        (row.automationSignals.length > 0 ? `    signaux  ${row.automationSignals.join(', ')}\n` : '') +
        `    extrait  ${row.bodyText.slice(0, 200).replace(/\n/g, ' ⏎ ') || '(vide)'}\n`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Fail-closed AVANT toute connexion : sans identifiants, il n'existe pas de
  // fournisseur dégradé — il n'existe pas de fournisseur.
  const credentials = readGmailCredentials();
  if (!credentials.ok && args.show === 0) {
    process.stderr.write(
      '\nACCÈS GMAIL NON PROVISIONNÉ — aucune lecture n’a été tentée.\n' +
        `Variables absentes : ${credentials.missing.join(', ')}\n\n` +
        'Ce qu’il faut, et rien d’autre :\n' +
        '  1. un projet Google Cloud dédié, API Gmail activée ;\n' +
        `  2. un identifiant OAuth « Desktop », consenti sur la SEULE portée ${GMAIL_READONLY_SCOPE} ;\n` +
        `  3. le jeton de rafraîchissement obtenu, placé dans ${GMAIL_ENV_KEYS.refreshToken} (jamais dans Git).\n\n` +
        'Aucun mot de passe, aucun IMAP, aucun accès en écriture : un jeton portant une portée\n' +
        'd’écriture est refusé par le code, pas seulement inutilisé.\n\n',
    );
    process.exitCode = 1;
    return;
  }

  const sql = await getSql();
  try {
    if (credentials.ok) {
      const mailbox = args.mailbox ?? credentials.credentials.inboxAddress;
      const api = new GmailRestApi({ credentials: credentials.credentials });
      const provider = new GmailInboundProvider({ api });

      const report = await pollInboundReplies(sql, provider, { mailbox, maxMessages: args.maxMessages });
      reportPoll(report);

      const summary = await loadInboundSummary(sql);
      process.stdout.write(
        `\nÉtat cumulé : ${summary.total} message(s) — EXACT ${summary.EXACT}, ` +
          `HIGH_CONFIDENCE ${summary.HIGH_CONFIDENCE}, REVIEW_REQUIRED ${summary.REVIEW_REQUIRED}, ` +
          `UNMATCHED ${summary.UNMATCHED}.\n`,
      );
      process.stdout.write('Aucun envoi, aucune réponse, aucune modification de la boîte Gmail.\n');
      if (report.failures.length > 0) process.exitCode = 2;
    }

    if (args.show > 0) await showRecent(sql, args.show);
    process.stdout.write('\n');
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof InboundArgError) {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof GmailScopeError) {
    process.stderr.write(`\nPORTÉE REFUSÉE — ${error.message}\n\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
