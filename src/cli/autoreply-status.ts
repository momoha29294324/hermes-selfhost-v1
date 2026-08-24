#!/usr/bin/env tsx
/**
 * HERMES-AUTO-REPLY-PRODUCTION-R1 §5/§8 — l'état du rail d'auto-réponse, pour
 * un opérateur.
 *
 *   npm run autoreply:status                 # les quatre états, plus les escalades
 *   npm run autoreply:status -- --json       # sortie machine
 *   npm run autoreply:status -- --escalations 50
 *
 * ---------------------------------------------------------------------------
 * Les quatre questions, séparées
 * ---------------------------------------------------------------------------
 * « Le rail répond-il tout seul ? » n'est pas une question mais quatre, et les
 * confondre coûte cher dans les deux sens :
 *
 *   CONFIGURÉ   une activation vit-elle, et jusqu'à quel budget ?
 *   VIVANT      les processus battent-ils, sous quelle révision ?
 *   PERMIS      l'arrêt global, les plafonds, la fenêtre laissent-ils passer ?
 *   EN ATTENTE  quels plans attendent, quelle escalade attend un humain ?
 *
 * Un plafond atteint n'est pas un runtime cassé. Un processus qui tourne n'est
 * pas un envoi autorisé. Cette commande ne les agrège jamais en un feu vert.
 *
 * Elle n'écrit rien, n'ouvre aucun navigateur, n'importe aucun provider,
 * aucun rail, aucune primitive d'envoi, et pas `setKillSwitch`.
 */
import { resolve } from 'node:path';
import { getSql } from '@/lib/db';
import { loadInstagramRail } from '@/lib/config/load';
import { loadAutoReplyStatus, type AutoReplyStatus } from '@/lib/autoreply/status';
import { isHeartbeatFresh } from '@/lib/autoreply/heartbeat';

class ArgError extends Error {}

/**
 * Au-delà de quel silence un battement cesse d'être frais.
 *
 * Cinq minutes : cinq fois la cadence de sondage par défaut du runtime. Un
 * seuil d'AFFICHAGE, pas une règle — aucune porte ne le lit, et le changer ne
 * change rien à ce qui part.
 */
const HEARTBEAT_STALE_AFTER_MS = 5 * 60 * 1000;

/** Idem pour la relève entrante, dont la cadence nominale est de cinq minutes. */
const INBOUND_STALE_AFTER_MS = 20 * 60 * 1000;

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const field = (label: string, value: string): void => {
  out(`  ${label.padEnd(30)} ${value}`);
};

function ageOf(iso: string | null, now: Date): string {
  if (iso === null) return 'jamais';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'illisible';
  const minutes = Math.round((now.getTime() - at) / 60_000);
  return `${iso} (il y a ${String(minutes)} min)`;
}

function render(status: AutoReplyStatus, now: Date): void {
  out('');
  out('HERMES — RAIL D’AUTO-RÉPONSE');

  out('');
  out(' 1. CONFIGURÉ — le rail est-il armé ?');
  if (status.activation === null) {
    field('AUTO_REPLY_ACTIVATED', 'NO — état de repos, aucune conversation traitée');
  } else {
    field('AUTO_REPLY_ACTIVATED', 'YES');
    field('frontière', status.activation.frontierAt);
    field('armée par', `${status.activation.activatedBy} le ${status.activation.activatedAt}`);
    field(
      'budget de déploiement',
      status.activation.maxEffects === null
        ? 'aucune borne'
        : `${String(status.effectsSinceFrontier)}/${String(status.activation.maxEffects)}`,
    );
    field('budget', status.rollout?.open === true ? `OUVERT — ${status.rollout.detail}` : `ÉPUISÉ — ${status.rollout?.detail ?? '—'}`);
  }

  out('');
  out(' 2. VIVANT — les processus battent-ils ?');
  field('révision du dépôt', status.codeRevision?.slice(0, 12) ?? '— (illisible)');
  const fresh = status.heartbeats.filter((beat) => isHeartbeatFresh(beat, now, HEARTBEAT_STALE_AFTER_MS));
  field('AUTO_REPLY_WORKER_ALIVE', fresh.length > 0 ? `YES (${String(fresh.length)})` : 'NO');
  for (const beat of status.heartbeats.slice(0, 5)) {
    const live = isHeartbeatFresh(beat, now, HEARTBEAT_STALE_AFTER_MS);
    out(
      `    ${live ? '●' : '○'} ${beat.workerId.padEnd(34)} ${beat.mode.padEnd(8)} ` +
        `cycles=${String(beat.cycles)} ${beat.lastOutcome}`,
    );
    out(
      `      vu ${beat.lastSeenAt}${beat.stoppedAt === null ? '' : ` · arrêté ${beat.stoppedAt} (${beat.stoppedBy ?? '—'})`}` +
        `${beat.codeRevision === null ? '' : ` · rév ${beat.codeRevision.slice(0, 12)}`}`,
    );
  }
  const inboundFresh =
    status.inbound.lastSuccessfulAt !== null &&
    now.getTime() - Date.parse(status.inbound.lastSuccessfulAt) <= INBOUND_STALE_AFTER_MS;
  field('INBOUND_WORKER_ALIVE', inboundFresh ? 'YES' : 'NO — dernière relève réussie trop ancienne');
  field('dernière relève réussie', ageOf(status.inbound.lastSuccessfulAt, now));
  field('dernier tour', `${status.inbound.lastStatus ?? '—'} / ${status.inbound.lastReadability ?? '—'}`);
  field('échecs consécutifs', String(status.inbound.consecutiveFailures));
  field(
    'relève en cours',
    status.inbound.runningSince === null ? 'non' : `${status.inbound.runningBy ?? '?'} depuis ${status.inbound.runningSince}`,
  );
  field(
    'bail du profil navigateur',
    status.browserLease.held
      ? `TENU par pid ${String(status.browserLease.holder?.pid ?? 0)} (${status.browserLease.holder?.cmd ?? '?'})`
      : 'libre',
  );

  out('');
  out(' 3. PERMIS — un envoi est-il autorisé en ce moment ?');
  field('arrêt global', status.killSwitchEngaged ? `ARMÉ (par ${status.killSwitchSetBy ?? '—'})` : 'levé');
  field('plafond 24 h', `${String(status.sentLastDay)}/${String(status.dailyCap)}`);
  field('plafond 1 h', `${String(status.sentLastHour)}/${String(status.hourlyCap)}`);
  field('fenêtre', status.windowOpen ? 'ouverte' : `fermée — ${status.scheduleDetail}`);
  field(
    'verdict de sûreté',
    status.safety.allowed ? 'PASSANT' : `BLOQUÉ [${status.safety.code ?? '—'}] ${status.safety.reason ?? ''}`,
  );
  field('prochain envoi possible', status.nextEligibleAt ?? (status.windowOpen ? 'maintenant, si tout le reste passe' : '—'));
  out('');
  out('    « bloqué par un plafond » n’est PAS « le runtime est cassé » :');
  out('    la fenêtre glissante se vide toute seule, personne n’a rien à faire.');

  out('');
  out(' 4. EN ATTENTE — que reste-t-il à faire ?');
  field('plans vivants', String(status.livePlans));
  field('plans sous bail', String(status.claimedPlans));
  if (status.latestDecision !== null) {
    const decision = status.latestDecision;
    field(
      'dernière décision',
      `${decision.decision}${decision.decisionReason === null ? '' : `:${decision.decisionReason}`} ` +
        `[${decision.status}] ${decision.displayName} — ${decision.createdAt}`,
    );
  } else {
    field('dernière décision', 'aucune');
  }
  if (status.latestEffect !== null) {
    const effect = status.latestEffect;
    field(
      'dernier effet externe',
      `${effect.status} [${effect.reasonCode}] @${effect.targetHandle} — ${effect.createdAt}` +
        `${effect.deliveryConfirmed ? ' · remise PROUVÉE' : ''}`,
    );
  } else {
    field('dernier effet externe', 'aucun');
  }

  out('');
  out(` 5. ESCALADES — ${String(status.openEscalations)} en attente d’un humain`);
  if (status.escalations.length === 0) {
    out('    aucune');
  }
  for (const escalation of status.escalations) {
    out('');
    out(
      `    ${escalation.supersededByNewerTurn ? '·' : '▸'} ${escalation.displayName} ` +
        `@${escalation.handle ?? '—'} — ${escalation.createdAt}` +
        `${escalation.supersededByNewerTurn ? '   [dépassée par un tour plus récent]' : ''}`,
    );
    out(`      fil            ${escalation.threadId ?? '—'}`);
    out(`      reçu           ${escalation.receivedAt ?? '—'}`);
    out(`      compris comme  ${escalation.classification ?? '—'} (${escalation.confidence?.toFixed(2) ?? '—'})`);
    out(`      porte          ${escalation.gate} / ${escalation.reason ?? '—'}`);
    out(`      message        « ${escalation.inboundText.replace(/\s+/g, ' ').slice(0, 220)} »`);
    out(`      motif          ${(escalation.detail ?? '—').replace(/\s+/g, ' ').slice(0, 220)}`);
    if (escalation.draftBody !== null) {
      out(`      brouillon      [${escalation.draftStatus ?? '—'}] « ${escalation.draftBody.slice(0, 220)} »`);
    } else {
      out('      brouillon      aucun');
    }
    out(`      plan           ${escalation.planId}`);
  }
  out('');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let json = false;
  let escalationLimit = 20;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--escalations') {
      const parsed = Number.parseInt(argv[i + 1] ?? '', 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        throw new ArgError('--escalations attend un entier entre 1 et 100');
      }
      escalationLimit = parsed;
      i += 1;
      continue;
    }
    throw new ArgError(`option inconnue : « ${arg} »`);
  }

  const config = loadInstagramRail();
  const sql = await getSql();
  try {
    const now = new Date();
    const status = await loadAutoReplyStatus(sql, config, {
      root: resolve(process.cwd()),
      now,
      escalationLimit,
    });
    if (json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return;
    }
    render(status, now);
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof ArgError ? 1 : 2;
});
