#!/usr/bin/env tsx
/**
 * IG2 §3 — l'autorisation canari, armée, consultée ou révoquée à la main.
 *
 *   npm run ig:canary -- --status
 *   npm run ig:canary -- --arm --manifest-id <uuid> --handle <handle> \
 *                        --as "Prénom Nom" --reason "…" [--ttl-minutes 30]
 *   npm run ig:canary -- --revoke --as "Prénom Nom" --reason "…"
 *
 * Ce que cette commande NE fait pas : envoyer. Armer donne le droit de tenter
 * un effet, une fois, pendant une fenêtre courte ; l'effet, lui, demande une
 * seconde commande, un arrêt global levé, et toutes les gardes du §5.
 *
 * `--handle` n'est pas la source du destinataire : il sert à CONFIRMER ce que
 * le manifeste porte déjà. Un désaccord refuse l'armement plutôt que de suivre
 * l'un des deux — c'est la même règle que partout dans ce dépôt, une donnée ne
 * s'invente pas au moment de s'en servir.
 */
import { getSql } from '@/lib/db';
import { resolveDispatchTarget, DispatchBlockedError } from '@/lib/pipeline/r6bDispatcher';
import { getLiveReadiness } from '@/lib/pipeline/r6bTransportPayload';
import {
  armCanaryAuthorization,
  CanaryAuthorizationError,
  DEFAULT_CANARY_TTL_MS,
  expireStaleCanaryAuthorizations,
  listCanaryAuthorizations,
  listCanaryHistory,
  MAX_CANARY_TTL_MS,
  revokeCanaryAuthorization,
  type CanaryAuthorization,
} from '@/lib/instagram/canary';
import { loadInstagramJobForManifest } from '@/lib/instagram/queue';
import { loadKillSwitch } from '@/lib/instagram/safety';

interface Args {
  mode: 'status' | 'arm' | 'revoke';
  manifestId: string | null;
  handle: string | null;
  as: string | null;
  reason: string | null;
  ttlMinutes: number | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { mode: 'status', manifestId: null, handle: null, as: null, reason: null, ttlMinutes: null };
  let modeSet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--status':
        args.mode = 'status';
        modeSet = true;
        break;
      case '--arm':
        args.mode = 'arm';
        modeSet = true;
        break;
      case '--revoke':
        args.mode = 'revoke';
        modeSet = true;
        break;
      case '--manifest-id':
        args.manifestId = argv[++i] ?? '';
        break;
      case '--handle':
        args.handle = argv[++i] ?? '';
        break;
      case '--as':
        args.as = argv[++i] ?? '';
        break;
      case '--reason':
        args.reason = argv[++i] ?? '';
        break;
      case '--ttl-minutes':
        args.ttlMinutes = Number.parseInt(argv[++i] ?? '', 10);
        break;
      default:
        throw new Error(`option inconnue : « ${String(token)} »`);
    }
  }
  if (!modeSet) args.mode = 'status';
  if (args.mode === 'arm') {
    if (!args.manifestId) throw new Error('--arm exige --manifest-id');
    if (!args.handle) throw new Error('--arm exige --handle (confirmation du destinataire figé)');
    if (!args.as) throw new Error('--arm exige --as « Prénom Nom » — un envoi s’autorise au nom de quelqu’un');
    if (!args.reason) throw new Error('--arm exige --reason');
    if (args.ttlMinutes !== null && (!Number.isFinite(args.ttlMinutes) || args.ttlMinutes < 1)) {
      throw new Error('--ttl-minutes attend un entier ≥ 1');
    }
  }
  if (args.mode === 'revoke') {
    if (!args.as) throw new Error('--revoke exige --as');
    if (!args.reason) throw new Error('--revoke exige --reason');
  }
  return args;
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(26)} ${value}\n`);
}

function report(auth: CanaryAuthorization): void {
  line('authorization_id', auth.id);
  line('state', auth.state);
  line('manifest_id', auth.manifestId);
  line('action', auth.action);
  line('transport', auth.transport);
  line('expected_handle', auth.expectedHandle);
  line('approved_text_sha256', auth.approvedTextSha256);
  line('payload_sha256', auth.transportPayloadSha256);
  line('armed_by', auth.armedBy);
  line('reason', auth.reason);
  line('external_attempts', `${auth.externalAttemptsUsed}/${auth.maxExternalAttempts}`);
  line('armed_at', auth.armedAt);
  line('expires_at', auth.expiresAt);
  if (auth.consumedAt !== null) line('consumed_at', `${auth.consumedAt} par ${auth.consumedBy ?? '—'}`);
  if (auth.consumedJobId !== null) line('consumed_job_id', auth.consumedJobId);
  if (auth.closedAt !== null) line('closed_at', `${auth.closedAt} par ${auth.closedBy ?? '—'} : ${auth.closedReason ?? '—'}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = await getSql();

  try {
    const expired = await expireStaleCanaryAuthorizations(sql);
    if (expired > 0) process.stdout.write(`\n${expired} autorisation(s) échue(s) passée(s) en EXPIRED.\n`);

    if (args.mode === 'status') {
      const killSwitch = await loadKillSwitch(sql);
      process.stdout.write('\nIG2 — autorisations canari\n');
      line('kill_switch_engaged', String(killSwitch.engaged));
      const all = await listCanaryAuthorizations(sql);
      if (all.length === 0) {
        process.stdout.write('\n  aucune autorisation — aucun envoi Instagram n’est possible.\n\n');
        return;
      }
      for (const auth of all) {
        process.stdout.write('\n');
        report(auth);
      }
      process.stdout.write('\n');
      return;
    }

    if (args.mode === 'revoke') {
      const all = await listCanaryAuthorizations(sql);
      const armed = all.filter((auth) => auth.state === 'ARMED');
      if (armed.length === 0) {
        process.stdout.write('\nAucune autorisation armée — rien à révoquer.\n\n');
        return;
      }
      for (const auth of armed) {
        const revoked = await revokeCanaryAuthorization(sql, {
          id: auth.id,
          revokedBy: args.as ?? '',
          reason: args.reason ?? '',
        });
        process.stdout.write('\nIG2 — autorisation révoquée\n');
        if (revoked !== null) report(revoked);
      }
      process.stdout.write('\n');
      return;
    }

    // ---- Armement ---------------------------------------------------------
    const manifestId = args.manifestId ?? '';

    // Le manifeste est relu et revalidé par le MÊME chemin qu'un envoi : statut
    // LOCKED, unicité, empreintes recalculées, forme du destinataire,
    // suppression, état commercial. Armer sur un manifeste qui ne passerait pas
    // ces gardes serait armer sur une cible que le canari refusera de toute
    // façon — autant le dire maintenant.
    const { envelope } = await resolveDispatchTarget(sql, manifestId, 'LIVE');

    if (envelope.recipient.toLowerCase() !== (args.handle ?? '').trim().toLowerCase().replace(/^@/, '')) {
      throw new Error(
        `--handle « ${args.handle} » ne correspond pas au destinataire figé « ${envelope.recipient} » — ` +
          'armement refusé : la confirmation doit confirmer, pas corriger',
      );
    }

    const readiness = getLiveReadiness(envelope);
    if (!readiness.ready) {
      throw new Error(`manifeste incomplet pour un envoi réel (manque : ${readiness.missing.join(', ')})`);
    }

    const job = await loadInstagramJobForManifest(sql, envelope.manifestId, 'first_touch_dm');
    if (job === null) {
      throw new Error(`aucun job Instagram enfilé pour ${envelope.manifestId} — enfiler d'abord (npm run ig:enqueue)`);
    }
    if (job.externalEffectAttempted) {
      throw new Error(
        `le job ${job.id} porte déjà une tentative d'effet externe (${job.externalEffectStartedAt ?? 'date inconnue'}) — ` +
          'aucun réarmement : une tentative ne se rejoue pas',
      );
    }
    if (job.status === 'SENT') {
      throw new Error(`le job ${job.id} est déjà SENT — armer serait autoriser un second message`);
    }

    // Une autorisation encore armée bloque : il faut la révoquer, donc décider.
    // Les autorisations closes (consommées sans effet, expirées, révoquées) ne
    // bloquent pas — c'est le drapeau d'effet du job qui ferme la porte, et
    // `armCanaryAuthorization` le vérifie (0032).
    const history = await listCanaryHistory(sql, envelope.manifestId);
    const stillArmed = history.find((auth) => auth.state === 'ARMED');
    if (stillArmed !== undefined) {
      process.stdout.write('\nUne autorisation est déjà armée pour ce manifeste :\n');
      report(stillArmed);
      throw new Error('armement refusé — révoquer l’autorisation existante d’abord (npm run ig:canary -- --revoke).');
    }
    if (history.length > 0) {
      process.stdout.write(`\n${history.length} armement(s) antérieur(s) sur ce manifeste, aucun n’a produit d’effet :\n`);
      for (const auth of history) {
        line(`  ${auth.armedAt}`, `${auth.state} · ${auth.externalAttemptsUsed}/${auth.maxExternalAttempts} · par ${auth.armedBy}`);
      }
    }

    const ttlMs = args.ttlMinutes === null ? DEFAULT_CANARY_TTL_MS : args.ttlMinutes * 60_000;
    const armed = await armCanaryAuthorization(sql, {
      envelope,
      action: 'first_touch_dm',
      armedBy: args.as ?? '',
      reason: args.reason ?? '',
      ttlMs,
    });

    process.stdout.write('\nIG2 — autorisation canari ARMÉE\n');
    report(armed);
    line('job_id', job.id);
    line('ttl_max_ms', String(MAX_CANARY_TTL_MS));
    process.stdout.write(
      '\nCeci n’envoie rien. Un effet exige en plus : arrêt global levé, plafonds verts, ' +
        'session prête, identité MATCH, et la commande « npm run ig:live -- --live ».\n\n',
    );
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  const message =
    error instanceof DispatchBlockedError
      ? `${error.code} — ${error.message}`
      : error instanceof CanaryAuthorizationError
        ? `${error.code} — ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
