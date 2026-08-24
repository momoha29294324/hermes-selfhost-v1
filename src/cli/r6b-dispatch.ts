#!/usr/bin/env tsx
/**
 * R6B-C.1 §12 / R6B-C.2B — le seul point d'entrée d'un dispatch, un manifeste
 * à la fois.
 *
 *   npm run r6b:dispatch -- --manifest-id <uuid> --dry-run
 *   npm run r6b:dispatch -- --manifest-id <uuid> --live
 *   npm run r6b:dispatch -- --manifest-id <uuid> --reconcile
 *   npm run r6b:dispatch -- --manifest-id <uuid> --reconcile --allow-idempotent-replay
 *
 * `--dry-run` n'envoie rien et ne peut rien envoyer : il ne connaît aucun
 * provider. `--live` est le seul chemin d'envoi réel du dépôt, et il n'aboutit
 * que si les quatre conditions de la triple garde sont vraies en même temps
 * (voir `r6bLiveDispatch`) — un `.env` complet ne suffit pas, un drapeau non
 * plus. `--reconcile` ne fait que lire chez le provider.
 *
 * `--allow-idempotent-replay` (R6B-C.2B.1) ajoute au seul `--reconcile` le
 * droit de rejouer la requête d'origine À L'IDENTIQUE — même clé, même
 * payload, dans la fenêtre de 24 h de Resend. C'est le seul moyen documenté
 * d'apprendre l'identifiant d'un email dont la réponse n'est jamais revenue
 * (aucune primitive Resend ne cherche par clé d'idempotence), et il produit
 * exactement un email dans tous les cas. Il reste une option explicite parce
 * qu'il touche le réseau avec un verbe d'écriture.
 *
 * C'est ici, et seulement ici, que le vrai client Resend est construit : le
 * domaine, lui, exige qu'on lui fournisse un provider et n'en fabrique jamais.
 */
import { getSql } from '@/lib/db';
import { env, envBool } from '@/lib/env';
import { DispatchArgError, parseDispatchArgs } from '@/lib/pipeline/r6bDispatchArgs';
import { DispatchBlockedError, dispatchManifest } from '@/lib/pipeline/r6bDispatcher';
import {
  dispatchManifestLive,
  reconcileLiveAttempt,
  R6B_LIVE_ARMED_MANIFEST_ID,
  type LiveDispatchResult,
} from '@/lib/pipeline/r6bLiveDispatch';
import { readSenderIdentity, ResendProvider, SenderIdentityError } from '@/lib/pipeline/r6bLiveEmail';
import type { Sql } from '@/lib/db/sql';

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(22)} ${value}\n`);
}

async function runDryRun(sql: Sql, manifestId: string): Promise<void> {
  const result = await dispatchManifest(sql, manifestId, 'DRY_RUN');

  process.stdout.write('\nR6B-C — DRY-RUN\n');
  line('manifest_id', result.manifestId);
  line('mode', result.mode);
  line('transport', result.transport);
  line('recipient', result.recipient);
  line('approved_text_sha256', result.approvedTextSha256);
  line('transport_payload', JSON.stringify(result.preview.payloadFields));
  line('transport_payload_sha', result.transportPayloadSha256);
  line('network_attempted', String(result.networkAttempted));
  line('sent', String(result.sent));
  line('status', result.status);
  // R6B-C.2A §10 — un manifeste incomplet pour un LIVE aboutit quand même
  // en DRY_RUN_OK : le dry-run sert justement à voir ce qui manquerait.
  line('live_ready', String(result.liveReady));
  line('missing_for_live', `[${result.missingForLive.join(', ')}]`);
  line('attempt_id', result.attemptId);
  process.stdout.write('\nAucun envoi, aucune connexion réseau, aucun outreach_event.\n\n');
}

function reportLive(result: LiveDispatchResult): void {
  process.stdout.write('\nR6B-C.2B — LIVE\n');
  line('manifest_id', result.manifestId);
  line('provider', result.provider);
  line('idempotency_key', result.idempotencyKey);
  line('transport', result.transport);
  line('recipient', result.recipient);
  line('approved_text_sha256', result.approvedTextSha256);
  line('transport_payload_sha', result.transportPayloadSha256);
  line('network_attempted', String(result.networkAttempted));
  line('sent', String(result.sent));
  line('status', result.status);
  line('provider_message_id', result.providerMessageId ?? '—');
  line('outreach_event_id', result.outreachEventId ?? '—');
  line('live_attempt_id', result.liveAttemptId);
  line('attempt_id', result.attemptId);
  if (result.failureCode) line('failure_code', result.failureCode);
  if (result.detail) line('detail', result.detail);
}

async function runLive(sql: Sql, manifestId: string): Promise<number> {
  // Construits seulement maintenant : tant que la commande n'a pas demandé un
  // LIVE, aucun client capable de contacter un provider n'existe en mémoire.
  const senderIdentity = readSenderIdentity();
  const provider = ResendProvider.fromEnv();

  const result = await dispatchManifestLive(
    sql,
    manifestId,
    { provider, senderIdentity },
    {
      allowSending: envBool('OUTBOUND_ALLOW_SENDING', false),
      liveManifestId: env('OUTBOUND_LIVE_MANIFEST_ID'),
    },
  );

  reportLive(result);

  if (result.status === 'SENT') {
    process.stdout.write('\nEnvoi confirmé par le provider. Exactement un outreach_event a été créé.\n\n');
    return 0;
  }
  if (result.status === 'AMBIGUOUS') {
    process.stderr.write(
      '\nISSUE INCONNUE — le réseau a été touché et le provider n’a pas confirmé.\n' +
        'Aucun outreach_event n’a été créé et AUCUNE nouvelle tentative ne doit être lancée :\n' +
        `  npm run r6b:dispatch -- --manifest-id ${result.manifestId} --reconcile\n` +
        'puis vérification humaine si la réconciliation ne conclut pas.\n\n',
    );
    return 2;
  }
  process.stderr.write(
    `\nÉCHEC DÉFINITIF (${result.failureCode ?? 'sans code'}) — le provider a refusé la requête, aucun email créé.\n` +
      'Un nouvel essai exige un nouvel armement humain complet.\n\n',
  );
  return 1;
}

async function runReconcile(sql: Sql, manifestId: string, allowIdempotentReplay: boolean): Promise<number> {
  const senderIdentity = readSenderIdentity();
  const provider = ResendProvider.fromEnv();

  if (allowIdempotentReplay) {
    process.stderr.write(
      '\nREJEU IDEMPOTENT AUTORISÉ — la requête d’origine sera rejouée à l’identique :\n' +
        'même clé d’idempotence, même payload, dans la fenêtre de 24 h documentée par Resend.\n' +
        'Le provider renvoie alors la réponse d’origine sans réexpédier ; si la première requête\n' +
        'n’était jamais arrivée, celle-ci l’envoie — et reste le premier et unique envoi.\n',
    );
  }

  const result = await reconcileLiveAttempt(sql, manifestId, { provider, senderIdentity, allowIdempotentReplay });

  process.stdout.write(`\nR6B-C.2B.1 — RÉCONCILIATION${allowIdempotentReplay ? ' (rejeu autorisé)' : ' (lecture seule)'}\n`);
  line('manifest_id', result.manifestId);
  line('status', result.status);
  line('provider_queried', String(result.providerQueried));
  line('provider_replayed', String(result.providerReplayed));
  line('within_idem_window', String(result.withinIdempotencyWindow));
  line('live_attempt_id', result.liveAttemptId ?? '—');
  line('provider_message_id', result.providerMessageId ?? '—');
  line('outreach_event_id', result.outreachEventId ?? '—');
  if (result.diagnosticCandidates.length > 0) {
    line('diagnostic_candidates', result.diagnosticCandidates.join(', '));
    process.stdout.write(
      '  ↑ correspondance destinataire + objet uniquement : diagnostic pour un humain,\n' +
        '    jamais une preuve d’identité d’envoi — aucun statut n’en découle.\n',
    );
  }
  line('detail', result.detail);

  if (result.status === 'REQUIRES_HUMAN_RECONCILIATION') {
    process.stderr.write(
      '\nDÉCISION HUMAINE REQUISE — aucun chemin automatique ne reste ouvert.\n' +
        'Vérifier dans le tableau de bord Resend si un email est parti vers ce destinataire,\n' +
        'puis trancher à la main. Le système ne rejouera plus rien pour ce manifeste.\n\n',
    );
    return 2;
  }
  if (result.status === 'UNRESOLVED') {
    process.stderr.write('\nNON CONCLU — la tentative reste bloquante. Aucun outreach_event n’a été créé.\n\n');
    return 2;
  }
  process.stdout.write('\n');
  return 0;
}

async function main(): Promise<void> {
  const args = parseDispatchArgs(process.argv.slice(2));

  const sql = await getSql();
  try {
    if (args.mode === 'DRY_RUN') {
      await runDryRun(sql, args.manifestId);
      return;
    }
    if (args.mode === 'RECONCILE') {
      process.exitCode = await runReconcile(sql, args.manifestId, args.allowIdempotentReplay);
      return;
    }
    process.stderr.write(
      `\nMODE LIVE demandé pour ${args.manifestId}.\n` +
        `Manifeste armé de cette mission : ${R6B_LIVE_ARMED_MANIFEST_ID}.\n` +
        'Un envoi réel n’aura lieu que si mode, OUTBOUND_ALLOW_SENDING, ' +
        'OUTBOUND_LIVE_MANIFEST_ID et --manifest-id concordent tous les quatre.\n',
    );
    process.exitCode = await runLive(sql, args.manifestId);
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  if (
    error instanceof DispatchArgError ||
    error instanceof DispatchBlockedError ||
    error instanceof SenderIdentityError
  ) {
    const code = error instanceof DispatchBlockedError ? `${error.code} — ` : '';
    process.stderr.write(`\nBLOQUÉ : ${code}${error.message}\n\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
