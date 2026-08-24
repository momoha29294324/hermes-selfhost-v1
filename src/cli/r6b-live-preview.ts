#!/usr/bin/env tsx
/**
 * R6B-C.2B.1 §10 — la preview humaine finale du seul manifeste armé.
 *
 *   npm run r6b:preview
 *   npm run r6b:preview -- --manifest-id <uuid>
 *
 * Ce que cette commande fait : elle reconstruit, par le code exact du chemin
 * LIVE, la requête que Resend recevrait — puis l'affiche en entier.
 *
 * Ce qu'elle ne fait pas, et ne peut pas faire :
 *
 *   * aucun réseau — elle ne construit aucun provider (`ResendProvider` n'est
 *     même pas importé ici) ;
 *   * aucune écriture — pas de `r6b_dispatch_attempts`, pas de
 *     `r6b_live_send_attempts`, pas d'`outreach_events` : elle ne passe par
 *     aucune fonction qui écrit ;
 *   * aucun armement — ni `OUTBOUND_ALLOW_SENDING`, ni
 *     `OUTBOUND_LIVE_MANIFEST_ID` ne sont touchés, et les lire ne les change
 *     pas.
 *
 * Le corps est imprimé mot pour mot, jamais résumé ni tronqué : le point de
 * cette commande est précisément que un opérateur lise ce qui partira, et non un
 * résumé de ce qui partira.
 */
import { getSql } from '@/lib/db';
import { env } from '@/lib/env';
import { loadManifestById } from '@/lib/pipeline/r6bDispatch';
import { buildDispatchEnvelope } from '@/lib/pipeline/r6bDispatcher';
import {
  buildEmailSendRequest,
  deriveIdempotencyKey,
  hashProviderPayload,
  validateSenderIdentity,
  PROVIDER_IDEMPOTENCY_WINDOW_MS,
} from '@/lib/pipeline/r6bLiveEmail';
import { R6B_LIVE_ARMED_MANIFEST_ID } from '@/lib/pipeline/r6bLiveDispatch';
import { getLiveReadiness } from '@/lib/pipeline/r6bTransportPayload';

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(26)} ${value}\n`);
}

function rule(): void {
  process.stdout.write(`${'─'.repeat(78)}\n`);
}

/** Le seul argument accepté, et il est facultatif. Aucune autre cible n'existe. */
function parseManifestId(argv: readonly string[]): string {
  if (argv.length === 0) return R6B_LIVE_ARMED_MANIFEST_ID;
  if (argv.length === 2 && argv[0] === '--manifest-id' && argv[1] !== undefined) return argv[1].trim();
  throw new Error('usage : npm run r6b:preview [-- --manifest-id <uuid>]');
}

async function main(): Promise<void> {
  const manifestId = parseManifestId(process.argv.slice(2));

  const sql = await getSql();
  try {
    const manifest = await loadManifestById(sql, manifestId);
    if (!manifest) {
      process.stderr.write(`\nAucun manifeste ${manifestId}.\n\n`);
      process.exitCode = 1;
      return;
    }

    // Le même constructeur d'enveloppe que le dispatcher : une preview qui
    // recalculerait le contenu à sa façon ne prouverait rien de ce qui partira.
    const envelope = buildDispatchEnvelope(manifest);

    const identity = validateSenderIdentity(env('OUTBOUND_EMAIL_FROM'), env('OUTBOUND_EMAIL_REPLY_TO'));
    if (!identity.ok) {
      process.stderr.write(`\nIDENTITÉ D’EXPÉDITEUR INVALIDE : ${identity.reason}\n\n`);
      process.exitCode = 1;
      return;
    }

    const request = buildEmailSendRequest(envelope, identity.identity);
    const providerPayloadSha256 = hashProviderPayload(request);
    const readiness = getLiveReadiness(envelope);
    const armed = manifestId === R6B_LIVE_ARMED_MANIFEST_ID;

    process.stdout.write('\n');
    rule();
    process.stdout.write('  R6B-C.2B.1 — PREVIEW LIVE FINALE (lecture seule, aucun réseau)\n');
    rule();

    line('MANIFEST ID', envelope.manifestId);
    line('manifest armé', armed ? 'OUI — c’est le seul manifeste envoyable' : 'NON — ce manifeste ne peut pas partir');
    process.stdout.write('\n');

    line('FROM', request.from);
    line('REPLY-TO', request.reply_to);
    line('TO', request.to);
    line('SUBJECT', request.subject);

    process.stdout.write('\n');
    rule();
    process.stdout.write('  BODY EXACT — mot pour mot, tel que Resend le recevra\n');
    rule();
    // Écrit brut, sans indentation ni reformatage : toute mise en forme
    // ajoutée ici ferait lire à un opérateur autre chose que ce qui partira.
    process.stdout.write(`${request.text}\n`);
    rule();
    process.stdout.write(`  (${request.text.length} caractères, aucun HTML, aucune signature, aucun tracking)\n`);
    rule();

    process.stdout.write('\n');
    line('approved_text_sha256', envelope.approvedTextSha256);
    line('transport_payload_sha256', envelope.transportPayloadSha256);
    line('provider_payload_sha256', providerPayloadSha256);
    process.stdout.write('\n');
    line('Idempotency-Key', deriveIdempotencyKey(envelope.manifestId));
    line('fenêtre idempotence', `${PROVIDER_IDEMPOTENCY_WINDOW_MS / 3_600_000} h après la réservation`);

    process.stdout.write('\n');
    line('champs envoyés', Object.keys(request).sort().join(', '));
    line('LIVE READY', readiness.ready ? 'true' : `false (manque : ${readiness.missing.join(', ')})`);

    // L'état d'armement est affiché parce qu'il est la question suivante, pas
    // parce que cette commande y touche.
    process.stdout.write('\n');
    line('OUTBOUND_ALLOW_SENDING', env('OUTBOUND_ALLOW_SENDING') ?? '(absent)');
    line('OUTBOUND_LIVE_MANIFEST_ID', env('OUTBOUND_LIVE_MANIFEST_ID') ?? '(absent)');

    process.stdout.write(
      '\nAucun envoi, aucune connexion réseau, aucune écriture en base, aucun armement.\n' +
        'Cette commande lit et affiche ; elle n’autorise rien.\n\n',
    );
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
