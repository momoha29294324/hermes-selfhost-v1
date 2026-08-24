#!/usr/bin/env tsx
/**
 * IG2.1 §2 — l'adjudication d'un canari : regarder ce que le fil montre, et
 * n'en tirer qu'une conclusion.
 *
 *   npm run ig:adjudicate -- --manifest-id <uuid>            (observation seule)
 *   npm run ig:adjudicate -- --manifest-id <uuid> --commit --as "Prénom Nom"
 *
 * Ce que cette commande ne fait pas, et ne peut pas faire
 * -------------------------------------------------------
 * Envoyer. Le rail qu'elle construit n'implémente pas `InstagramLiveRail` : il
 * n'a pas de méthode d'envoi à appeler, `hasSendPrimitive` le dit `false`, et
 * sa garde réseau refuse toute écriture sur un chemin de messagerie — y compris
 * un rejeu qu'Instagram tenterait de lui-même en rouvrant un fil dont un
 * message est resté en échec.
 *
 * Elle ne lève pas non plus l'arrêt global, ne consomme aucune autorisation
 * canari, et n'en arme aucune. Un canari adjugé reste un canari terminé.
 *
 * `--commit` : ce qu'il écrit, et ce qu'il refuse d'écrire
 * --------------------------------------------------------
 * Il inscrit le verdict observé — et lui seul. Un `DELIVERY_FAILED` n'écrit
 * aucun `outreach_event` : rien n'est parti, personne n'a été joint. Un `SENT`
 * écrit l'événement canonique manquant, exactement une fois, sous l'index
 * unique de 0023 — c'est une RÉCONCILIATION d'un effet déjà observé, pas un
 * nouvel effet. Un `AMBIGUOUS` n'écrit rien du tout et laisse le job en
 * `REVIEW_REQUIRED`.
 */
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { getSql } from '@/lib/db';
import { loadInstagramRail } from '@/lib/config/load';
import { resolveDispatchTarget } from '@/lib/pipeline/r6bDispatcher';
import { PlaywrightInstagramAdjudicationRail } from '@/lib/instagram/playwrightAdjudicationRail';
import { hasSendPrimitive } from '@/lib/instagram/rail';
import { adjudicateDelivery, describeAdjudication } from '@/lib/instagram/deliveryProof';
import { loadInstagramJobForManifest } from '@/lib/instagram/queue';
import { loadKillSwitch } from '@/lib/instagram/safety';
import { commitCanaryAdjudication, loadCanaryAdjudication } from '@/lib/instagram/adjudication';

const SCREENSHOT_DIR = 'var/instagram/screenshots';
const EVIDENCE_DIR = 'var/instagram/adjudication';

interface Args {
  manifestId: string;
  commit: boolean;
  headed: boolean;
  as: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { manifestId: '', commit: false, headed: false, as: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--manifest-id':
        if (args.manifestId !== '') throw new Error('--manifest-id ne peut être donné qu’une fois');
        args.manifestId = argv[++i] ?? '';
        break;
      case '--commit':
        args.commit = true;
        break;
      case '--headed':
        args.headed = true;
        break;
      case '--as':
        args.as = argv[++i] ?? '';
        break;
      default:
        throw new Error(`option inconnue : « ${String(token)} » — cette commande n'envoie rien et n'a aucune option d'envoi`);
    }
  }
  if (args.manifestId.trim() === '') throw new Error('--manifest-id est obligatoire');
  if (args.commit && (args.as ?? '').trim() === '') {
    throw new Error('--commit exige --as « Prénom Nom » — une adjudication se signe');
  }
  return args;
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(28)} ${value}\n`);
}

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadInstagramRail();
  const sql = await getSql();
  const workerId = `${hostname()}/pid-${process.pid}`;

  try {
    // Le manifeste est relu par le MÊME chemin qu'un envoi : ce qui est comparé
    // à l'écran doit être le texte verrouillé, pas une copie de la conversation.
    const { envelope } = await resolveDispatchTarget(sql, args.manifestId, 'LIVE');
    const job = await loadInstagramJobForManifest(sql, envelope.manifestId, 'first_touch_dm');
    if (job === null) throw new Error(`aucun job Instagram pour le manifeste ${envelope.manifestId}`);

    const killSwitch = await loadKillSwitch(sql);
    const existing = await loadCanaryAdjudication(sql, job.id);

    process.stdout.write('\nIG2.1 — adjudication (lecture seule)\n\n');
    line('manifest_id', envelope.manifestId);
    line('job_id', job.id);
    line('job_status', job.status);
    line('expected_handle', envelope.recipient);
    line('external_effect_attempted', String(job.externalEffectAttempted));
    line('external_effect_started_at', job.externalEffectStartedAt ?? '—');
    line('kill_switch', killSwitch.engaged ? 'ENGAGÉ' : 'LEVÉ');
    line('adjudication_existante', existing === null ? 'aucune' : `${existing.verdict} par ${existing.adjudicatedBy}`);

    if (!job.externalEffectAttempted) {
      throw new Error(
        `le job ${job.id} n'a jamais tenté d'effet externe — il n'y a rien à adjuger, et ouvrir le fil ` +
          'du prospect pour le constater serait une visite sans objet',
      );
    }

    const rail = new PlaywrightInstagramAdjudicationRail({
      config,
      workerId,
      headless: args.headed ? false : undefined,
      screenshotDir: resolve(process.cwd(), SCREENSHOT_DIR),
    });
    // Vérifié à l'exécution et pas seulement au type : la question posée est
    // « m'a-t-on donné plus que ce que je demande ? ».
    if (hasSendPrimitive(rail)) throw new Error('rail d’adjudication porteur d’une primitive d’envoi — refus');

    let observation;
    try {
      const session = await rail.ensureSession();
      line('session_state', session.state);
      observation = await rail.observeConversation(envelope.recipient, envelope.approvedText);
    } finally {
      await rail.close().catch(() => undefined);
    }

    const adjudication = adjudicateDelivery({
      observation,
      approvedText: envelope.approvedText,
      expectedHandle: envelope.recipient,
    });

    ensureDir(resolve(process.cwd(), EVIDENCE_DIR));
    const evidencePath = resolve(
      process.cwd(),
      EVIDENCE_DIR,
      `${envelope.recipient}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    writeFileSync(evidencePath, `${JSON.stringify({ observation, adjudication }, null, 2)}\n`, 'utf8');

    process.stdout.write('\n Ce que le fil a montré\n');
    line('thread_url', observation.threadUrl);
    line('session_state', observation.sessionState);
    line('stop_reason', observation.stopReason ?? '— (aucun arrêt)');
    if (observation.inbox !== null) {
      const inbox = observation.inbox;
      line('inbox_lisibilité', inbox.readability);
      line('inbox_présence', inbox.presence);
      line('inbox_lignes_lues', String(inbox.rowsSeen));
      line('inbox_vignettes', String(inbox.avatarCount));
      line('inbox_détail', inbox.detail);
      if (inbox.row !== null) {
        line('inbox_reconnaissance', inbox.row.basis);
        line('inbox_âge_affiché', inbox.row.ageMs === null ? 'illisible' : `${Math.round(inbox.row.ageMs / 60_000)} min`);
        line('inbox_aperçu_approuvé', String(inbox.row.previewMatchesApproved));
      }
    }
    line('open_clicks', String(observation.openClicks));
    line('blocked_write_requests', String(observation.blockedWriteRequests));
    line('nodes_récoltés', `${observation.nodes.length}${observation.truncated ? ' (TRONQUÉ)' : ''}`);
    line('composer_text', JSON.stringify(observation.composerText.slice(0, 80)));
    line('screenshot', observation.screenshotPath ?? '—');
    line('evidence_json', evidencePath);

    process.stdout.write('\n Verdict\n');
    for (const text of describeAdjudication(adjudication)) process.stdout.write(`  ${text}\n`);

    if (!args.commit) {
      process.stdout.write('\nObservation seule — aucune écriture. Ajouter --commit --as "Prénom Nom" pour inscrire.\n\n');
      return;
    }

    const committed = await commitCanaryAdjudication(sql, {
      job,
      envelope,
      adjudication,
      observation,
      adjudicatedBy: args.as ?? '',
      workerId,
    });

    process.stdout.write('\n Écriture\n');
    line('adjudication_id', committed.adjudicationId ?? '— (aucune écriture)');
    line('job_status', committed.jobStatus);
    line('event_id', committed.eventId ?? '—');
    line('outreach_event_id', committed.outreachEventId ?? '—');
    line('outreach_state', committed.outreachState ?? '—');
    line('mutation', committed.detail);
    process.stdout.write('\n');
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
