#!/usr/bin/env tsx
/**
 * IG4.2 §3 — la confirmation humaine d'identité de canal, par un opérateur.
 *
 *   npm run ig:identity -- --status  --prospect <uuid>
 *   npm run ig:identity -- --confirm --prospect <uuid> --handle <handle> \
 *                          --as "<nom>" --reason "<sur quoi vous vous fondez>" \
 *                          [--evidence-url <https://…>]
 *   npm run ig:identity -- --reject  --prospect <uuid> --handle <handle> \
 *                          --as "<nom>" --reason "<pourquoi ce n'est pas leur compte>"
 *
 * Ce que cette commande remplace : une écriture SQL tapée à la main en
 * production pour faire passer `prospects.identity_review` à « confirmed ».
 * Cette écriture-là aurait fait dire au rail automatique une chose qu'il n'a
 * jamais conclue — qu'une identité légale SIREN/SIRET avait été rapprochée — et
 * elle aurait effacé ce qu'il avait réellement conclu. Ici, les deux faits
 * coexistent : la colonne du rail n'est pas touchée, et la décision humaine
 * s'inscrit à côté, datée et signée.
 *
 * Ce qu'elle ne fait pas, et ne peut pas faire :
 *
 *   * aucun effet Instagram — elle n'ouvre aucun navigateur, ne touche aucun
 *     réseau, n'importe aucun rail ;
 *   * aucun `outreach_event` — la table qui atteste qu'un humain a été joint
 *     n'est ni lue ni écrite ici ;
 *   * aucune autorisation canari, aucun job enfilé, aucun envoi ;
 *   * l'arrêt global n'est ni lu comme une permission, ni levé : rien dans ce
 *     fichier ne l'écrit.
 *
 * Ce qu'elle ouvre, exactement : la porte `identity_provenance` du gate
 * Instagram, pour ce prospect, ce transport et ce destinataire — et rien
 * d'autre. ICP, opt-out, suppression, manifeste, payload, contact déjà établi,
 * intention concurrente, ordonnanceur, plafonds, cooldown, canari et arrêt
 * global restent tous en place, et sont réévalués à chaque passage.
 */
import { getSql } from '@/lib/db';
import {
  ChannelIdentityError,
  listChannelIdentityDecisions,
  loadEffectiveChannelIdentityDecision,
  normalizeInstagramRecipient,
  recordChannelIdentityDecision,
  type ChannelIdentityDecisionValue,
} from '@/lib/pipeline/channelIdentity';

/** Cette commande n'écrit QUE des décisions Instagram : le transport n'est pas un paramètre. */
const TRANSPORT = 'instagram_dm' as const;

type Command = 'status' | 'confirm' | 'reject';

interface Args {
  readonly command: Command;
  readonly prospectId: string;
  readonly handle: string | null;
  readonly as: string | null;
  readonly reason: string | null;
  readonly evidenceUrl: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  let command: Command | null = null;
  let prospectId = '';
  let handle: string | null = null;
  let as: string | null = null;
  let reason: string | null = null;
  let evidenceUrl: string | null = null;

  const setCommand = (next: Command): void => {
    if (command !== null) throw new Error('une seule décision à la fois : --status, --confirm ou --reject');
    command = next;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--status':
        setCommand('status');
        break;
      case '--confirm':
        setCommand('confirm');
        break;
      case '--reject':
        setCommand('reject');
        break;
      case '--prospect':
        prospectId = (argv[++i] ?? '').trim();
        break;
      case '--handle':
        handle = (argv[++i] ?? '').trim();
        break;
      case '--as':
        as = (argv[++i] ?? '').trim();
        break;
      case '--reason':
        reason = argv[++i] ?? '';
        break;
      case '--evidence-url':
        evidenceUrl = (argv[++i] ?? '').trim();
        break;
      default:
        throw new Error(`option inconnue : « ${String(token)} » (cette commande n'a ni --live ni --send)`);
    }
  }

  // Aucun défaut. Une décision d'identité qu'on obtient en oubliant un drapeau
  // n'est pas une décision — c'est ce que la mission demande d'exiger
  // explicitement.
  if (command === null) {
    throw new Error(
      'une décision explicite est obligatoire : --status (lecture seule), --confirm ou --reject',
    );
  }
  if (prospectId.length === 0) throw new Error('--prospect <uuid> est obligatoire');
  if (command === 'status') return { command, prospectId, handle, as, reason, evidenceUrl };

  if (handle === null || handle.length === 0) {
    throw new Error('--handle <handle> est obligatoire — une décision porte sur UN compte, pas sur un prospect en général');
  }
  if (as === null || as.length === 0) {
    throw new Error('--as "<votre nom>" est obligatoire — une décision humaine que personne ne signe n’en est pas une');
  }
  if (reason === null || reason.trim().length === 0) {
    throw new Error('--reason "<sur quoi vous vous fondez>" est obligatoire');
  }
  return { command, prospectId, handle, as, reason, evidenceUrl };
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(26)} ${value}\n`);
}

interface ProspectRow {
  readonly id: string;
  readonly displayName: string | null;
  readonly websiteUrl: string | null;
  readonly instagramHandle: string | null;
  readonly identityReview: string | null;
}

async function loadProspect(sql: Awaited<ReturnType<typeof getSql>>, prospectId: string): Promise<ProspectRow> {
  const rows = await sql.query<ProspectRow>(
    `select id, display_name as "displayName", website_url as "websiteUrl",
            instagram_handle as "instagramHandle", identity_review as "identityReview"
       from prospects where id = $1`,
    [prospectId],
  );
  const row = rows[0];
  if (row === undefined) throw new ChannelIdentityError('PROSPECT_NOT_FOUND', `aucun prospect ${prospectId}`);
  return row;
}

/** Ce que l'opérateur doit voir AVANT que sa décision compte : de qui, et de quel compte, parle-t-on. */
function showProspect(prospect: ProspectRow, recipient: string | null): void {
  process.stdout.write('\n Prospect\n');
  line('id', prospect.id);
  line('display_name', prospect.displayName ?? '—');
  line('website_url', prospect.websiteUrl ?? '—');
  line('instagram_handle (fiche)', prospect.instagramHandle ?? '—');
  line('identity_review (rail auto)', prospect.identityReview ?? '—');

  process.stdout.write('\n Canal\n');
  line('transport', TRANSPORT);
  line('recipient', recipient === null ? '—' : `@${recipient}`);
}

async function showManifests(
  sql: Awaited<ReturnType<typeof getSql>>,
  prospectId: string,
): Promise<void> {
  const manifests = await sql.query<{
    id: string;
    status: string;
    transport: string | null;
    recipient: string;
    identityReview: string;
  }>(
    `select id, status, transport, recipient, identity_review as "identityReview"
       from r6b_dispatch_manifests
      where prospect_id = $1 and transport = $2
      order by created_at desc`,
    [prospectId, TRANSPORT],
  );
  process.stdout.write(`\n Manifestes ${TRANSPORT} de ce prospect (${manifests.length})\n`);
  if (manifests.length === 0) process.stdout.write('  (aucun)\n');
  for (const manifest of manifests) {
    process.stdout.write(
      `  ${manifest.status.padEnd(12)} @${manifest.recipient.padEnd(22)} ` +
        `identity_review=${manifest.identityReview.padEnd(14)} ${manifest.id}\n`,
    );
  }
}

async function showHistory(sql: Awaited<ReturnType<typeof getSql>>, prospectId: string): Promise<void> {
  const history = await listChannelIdentityDecisions(sql, prospectId);
  process.stdout.write(`\n Décisions humaines d’identité de canal (${history.length})\n`);
  if (history.length === 0) process.stdout.write('  (aucune)\n');
  for (const row of history) {
    process.stdout.write(
      `  ${row.decision.padEnd(10)} ${row.transport.padEnd(14)} @${row.recipient.padEnd(22)} ` +
        `par ${row.decidedBy} le ${row.decidedAt}\n` +
        `             motif : ${row.reason}\n` +
        (row.evidenceUrl === null ? '' : `             preuve : ${row.evidenceUrl}\n`) +
        `             identité automatique au moment de la décision : ${row.automaticIdentityReview ?? '—'}\n`,
    );
  }
}

async function status(prospectId: string): Promise<void> {
  const sql = await getSql();
  try {
    const prospect = await loadProspect(sql, prospectId);
    process.stdout.write('\nIG4.2 — identité de canal (lecture seule, rien n’est écrit)\n');
    showProspect(prospect, null);
    await showManifests(sql, prospectId);
    await showHistory(sql, prospectId);
    process.stdout.write('\n');
  } finally {
    await sql.close();
  }
}

async function decide(args: Args, decision: ChannelIdentityDecisionValue): Promise<void> {
  const recipient = normalizeInstagramRecipient(args.handle as string);
  const sql = await getSql();
  try {
    const prospect = await loadProspect(sql, args.prospectId);

    process.stdout.write(`\nIG4.2 — décision humaine d’identité de canal : ${decision}\n`);
    showProspect(prospect, recipient);
    await showManifests(sql, args.prospectId);

    const result = await recordChannelIdentityDecision(sql, {
      prospectId: args.prospectId,
      transport: TRANSPORT,
      recipient,
      decision,
      reason: args.reason as string,
      evidenceUrl: args.evidenceUrl,
      decidedBy: args.as as string,
    });

    process.stdout.write(
      `\n ${result.created ? 'Décision inscrite' : 'Décision déjà inscrite — aucune seconde ligne créée'}\n`,
    );
    line('decision_id', result.decision.id);
    line('decision', result.decision.decision);
    line('recipient', `@${result.decision.recipient}`);
    line('decided_by', result.decision.decidedBy);
    line('decided_at', result.decision.decidedAt);
    line('reason_sha256', result.decision.reasonSha256);
    line('evidence_url', result.decision.evidenceUrl ?? '—');
    line('identity_review (rail auto)', `${result.decision.automaticIdentityReview ?? '—'} — INCHANGÉ`);
    line('décision précédente', result.previous === null ? 'aucune' : result.previous.decision);

    await showHistory(sql, args.prospectId);

    // Relu depuis la base, et non déduit de ce qu'on vient d'écrire : c'est
    // cette lecture-là que le gate fera.
    const effective = await loadEffectiveChannelIdentityDecision(sql, {
      prospectId: args.prospectId,
      transport: TRANSPORT,
      recipient,
    });
    process.stdout.write('\n Décision qui fait foi pour ce canal\n');
    line('decision', effective?.decision ?? '—');
    line('decided_by', effective?.decidedBy ?? '—');

    process.stdout.write(
      '\nAucun message n’a été envoyé, aucun outreach_event écrit, aucune autorisation canari créée,\n' +
        'et l’arrêt global n’a pas été touché. `prospects.identity_review` non plus : cette décision\n' +
        'porte sur la provenance du CANAL, pas sur une identité légale SIREN/SIRET.\n' +
        `Prochaine étape : « npm run ig:queue -- --check --manifest-id <uuid> ».\n\n`,
    );
  } finally {
    await sql.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'status') return status(args.prospectId);
  return decide(args, args.command === 'confirm' ? 'CONFIRMED' : 'REJECTED');
}

main().catch((error: unknown) => {
  if (error instanceof ChannelIdentityError) {
    process.stderr.write(`REFUSÉ [${error.code}] ${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
