#!/usr/bin/env tsx
/**
 * R6B-D1.1 — inscrit l'identité RFC 5322 d'un envoi déjà parti.
 *
 *   npm run r6b:backfill:rfc -- \
 *     --manifest-id <uuid> \
 *     --provider-message-id <id resend> \
 *     --recipient <adresse> \
 *     --subject "<objet>"
 *
 * Une lecture chez le provider (`GET /emails/{id}`), et une écriture d'une
 * seule colonne si — et seulement si — tout concorde. Aucun envoi n'est
 * possible depuis cette commande : elle n'appelle jamais `send`, ne construit
 * aucun payload et ne dérive aucune clé d'idempotence.
 *
 * Les quatre options sont obligatoires et sans valeur par défaut. Elles ne
 * servent pas à désigner la cible mais à l'AFFIRMER : chacune est confrontée à
 * la base avant le réseau, puis à ce que le provider relit. Une commande dont
 * une seule valeur diffère ne corrige rien — elle refuse.
 */
import { getSql } from '@/lib/db';
import { readSenderIdentity, ResendProvider, SenderIdentityError } from '@/lib/pipeline/r6bLiveEmail';
import {
  backfillRfcMessageId,
  RfcBackfillBlockedError,
  type RfcBackfillExpectation,
} from '@/lib/pipeline/r6bRfcMessageBackfill';

class BackfillArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackfillArgError';
  }
}

const OPTIONS = new Map<string, keyof RfcBackfillExpectation>([
  ['--manifest-id', 'manifestId'],
  ['--provider-message-id', 'providerMessageId'],
  ['--recipient', 'recipient'],
  ['--subject', 'subject'],
]);

/**
 * Liste blanche stricte, comme `parseDispatchArgs` : tout ce qui n'est pas
 * nommé ici est refusé, y compris les options que personne n'a encore
 * inventées.
 */
function parseArgs(argv: readonly string[]): RfcBackfillExpectation {
  const values = new Map<keyof RfcBackfillExpectation, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    const key = OPTIONS.get(token);
    if (key === undefined) {
      throw new BackfillArgError(
        `option inconnue « ${token} ». Options acceptées : ${[...OPTIONS.keys()].join(', ')}.`,
      );
    }
    if (values.has(key)) {
      throw new BackfillArgError(`${token} ne peut être passé qu'une seule fois.`);
    }
    const value = argv[i + 1];
    // Un objet ou une adresse peuvent contenir n'importe quoi sauf un préfixe
    // d'option : refuser ici évite qu'une valeur oubliée avale l'option
    // suivante et fasse porter à la commande une identité qu'elle n'affirme pas.
    if (value === undefined || value.startsWith('--')) {
      throw new BackfillArgError(`${token} exige une valeur.`);
    }
    values.set(key, value);
    i += 1;
  }

  const missing = [...OPTIONS.entries()].filter(([, key]) => !values.has(key)).map(([flag]) => flag);
  if (missing.length > 0) {
    throw new BackfillArgError(
      `option(s) obligatoire(s) manquante(s) : ${missing.join(', ')} — ` +
        'aucune identité n’est déduite, chacune doit être affirmée.',
    );
  }

  return Object.freeze({
    manifestId: values.get('manifestId')!.trim(),
    providerMessageId: values.get('providerMessageId')!.trim(),
    recipient: values.get('recipient')!.trim(),
    // L'objet n'est PAS rogné : il est comparé mot pour mot à celui du
    // manifeste verrouillé, et un blanc de bord y compte.
    subject: values.get('subject')!,
  });
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(22)} ${value}\n`);
}

async function main(): Promise<void> {
  const expectation = parseArgs(process.argv.slice(2));

  const senderIdentity = readSenderIdentity();
  const provider = ResendProvider.fromEnv();

  const sql = await getSql();
  try {
    const result = await backfillRfcMessageId(sql, expectation, { provider, senderIdentity });

    process.stdout.write('\nR6B-D1.1 — IDENTITÉ RFC\n');
    line('manifest_id', result.manifestId);
    line('live_attempt_id', result.liveAttemptId);
    line('provider_message_id', result.providerMessageId);
    line('rfc_message_id', result.rfcMessageId);
    line('status', result.status);
    line('rows_updated', String(result.rowsUpdated));
    line('sender_checked', String(result.senderChecked));
    line('detail', result.detail);
    if (!result.senderChecked) {
      process.stdout.write(
        '  ↑ le provider n’a pas exposé d’expéditeur sur cette relecture : ce contrôle n’a\n' +
          '    pas été fait, il n’a pas « réussi ».\n',
      );
    }
    process.stdout.write('\nAucun envoi, aucun outreach_event, aucun autre champ modifié.\n\n');
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof BackfillArgError || error instanceof SenderIdentityError) {
    process.stderr.write(`\nBLOQUÉ : ${error.message}\n\n`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof RfcBackfillBlockedError) {
    process.stderr.write(`\nBLOQUÉ : ${error.code} — ${error.message}\nRien n'a été écrit.\n\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
