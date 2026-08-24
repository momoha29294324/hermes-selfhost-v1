#!/usr/bin/env tsx
/**
 * HERMES-AUTO-REPLY-PRODUCTION-R1 §4 — l'EXÉCUTABLE du runtime d'auto-réponse.
 *
 *   npm run autoreply:worker -- --plan               # ce qui serait fait, sans rail
 *   npm run autoreply:worker -- --once --preview     # le chemin entier, sans clic
 *   npm run autoreply:worker -- --once               # un cycle, un effet possible
 *   npm run autoreply:worker -- --loop               # runtime durable, jusqu'à SIGINT/SIGTERM
 *   npm run autoreply:worker -- --loop --poll-ms 60000 --max-effects 1
 *
 * ---------------------------------------------------------------------------
 * Ce fichier ne contient AUCUNE règle
 * ---------------------------------------------------------------------------
 * Il n'y a ici ni file, ni ordonnanceur, ni plafond, ni politique, ni primitive
 * d'envoi, ni décision d'éligibilité. Tout cela vit dans le domaine et y reste :
 * `loadActiveAutoReplyActivation` dit si le rail est armé,
 * `assessAutoReplyEligibility` dit quelles conversations lui appartiennent,
 * `decideAutonomousReply` dit si le contenu peut partir,
 * `evaluateConversationEffectGate` relit toutes les portes avant le clic,
 * `reserveConversationEffectSlot` compte sous le verrou, `sendThreadReply` fait
 * l'unique geste.
 *
 * Ce que cette commande apporte, et rien d'autre : la configuration canonique,
 * la connexion canonique, un navigateur, des signaux, un battement de cœur et
 * un rapport.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'elle ne fait pas, et pourquoi
 * ---------------------------------------------------------------------------
 *
 * 1. **Elle ne lève JAMAIS l'arrêt global.** Aucune option, et `setKillSwitch`
 *    n'est pas importé. Un exécutable capable d'ouvrir sa propre porte n'est
 *    pas gardé par cette porte.
 *
 * 2. **Elle ne l'arme pas non plus en sortant.** Comme le worker sortant :
 *    l'arrêt global est l'arrêt d'URGENCE d'un runtime qui tourne, pas
 *    l'autorisation d'une invocation. Un processus qui le réarmerait en
 *    sortant transformerait « le runtime a redémarré » en « le rail est
 *    fermé ».
 *
 * 3. **Elle ne s'active pas elle-même.** Sans activation vivante, elle le DIT
 *    et ne traite rien. Armer la frontière est un geste séparé, nominatif
 *    (`npm run autoreply:activation -- --activate --as "<nom>"`), et cette
 *    commande n'importe pas `activateAutoReply`.
 *
 * 4. **Elle n'a ni `--all`, ni `--batch`, ni `--prospect`, ni `--handle`, ni
 *    `--force`.** Le parseur refuse tout ce qu'il ne connaît pas : viser
 *    quelqu'un en particulier demanderait de l'écrire ici, dans un diff relu.
 *
 * 5. **Elle ne tient jamais le navigateur pendant une attente.** Le rail est
 *    refermé après chaque tour, dans un `finally`, et une invariante le
 *    vérifie avant chaque sommeil. C'est ce qui rend la coexistence avec la
 *    relève entrante et le worker sortant possible sur un profil unique.
 */
import { hostname } from 'node:os';
import { getSql } from '@/lib/db';
import { loadConversationPolicy, loadInstagramRail } from '@/lib/config/load';
import { logger } from '@/lib/logging/logger';
import { PlaywrightInstagramReplyRail } from '@/lib/instagram/playwrightReplyRail';
import { inspectInstagramBrowserLease } from '@/lib/instagram/browserProfileLease';
import { loadKillSwitch } from '@/lib/instagram/safety';
import { createCodeRevisionSentinel } from '@/lib/inbound/codeRevision';
import { CONVERSATION_POLICY_VERSION } from '@/lib/conversation/autonomy';
import {
  AUTO_REPLY_IDLE_POLL_MS,
  AUTO_REPLY_MAX_EFFECTS_PER_CYCLE,
  runAutoReplyRuntime,
  type AutoReplyCycleResult,
  type AutoReplyMode,
  type AutoReplyRuntimeReport,
} from '@/lib/autoreply/runtime';
import {
  closeAutoReplyHeartbeat,
  recordAutoReplyHeartbeat,
} from '@/lib/autoreply/heartbeat';
import type { InstagramReplyRail } from '@/lib/instagram/replyRail';

class ArgError extends Error {}

interface Args {
  readonly mode: 'plan' | 'once' | 'loop';
  readonly preview: boolean;
  readonly headed: boolean;
  readonly maxCycles: number | null;
  readonly maxEffects: number | null;
  readonly pollMs: number | null;
}

function integer(raw: string | undefined, option: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ArgError(`${option} attend un entier entre ${String(min)} et ${String(max)}`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): Args {
  let mode: Args['mode'] | null = null;
  let preview = false;
  let headed = false;
  let maxCycles: number | null = null;
  let maxEffects: number | null = null;
  let pollMs: number | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--plan':
      case '--once':
      case '--loop':
        if (mode !== null) throw new ArgError('--plan, --once et --loop sont exclusifs');
        mode = token.slice(2) as Args['mode'];
        break;
      case '--preview':
        preview = true;
        break;
      case '--headed':
        headed = true;
        break;
      case '--max-cycles':
        maxCycles = integer(argv[++i], '--max-cycles', 1, 10_000);
        break;
      case '--max-effects':
        maxEffects = integer(argv[++i], '--max-effects', 0, 5);
        break;
      case '--poll-ms':
        pollMs = integer(argv[++i], '--poll-ms', 5_000, 900_000);
        break;
      default:
        throw new ArgError(
          `option inconnue : « ${String(token)} » — cette commande n'a ni --all, ni --batch, ` +
            'ni --prospect, ni --handle, ni --force, et ne sait pas lever l’arrêt global',
        );
    }
  }

  // `--plan` par défaut : le mode qui n'ouvre rien. Un runtime dont le défaut
  // serait « tourne » démarrerait par accident, et celui-ci peut envoyer.
  if (mode === null) mode = 'plan';
  if (mode !== 'loop' && maxCycles !== null) {
    throw new ArgError('--max-cycles n’a de sens qu’avec --loop');
  }
  return { mode, preview, headed, maxCycles, maxEffects, pollMs };
}

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const field = (label: string, value: string): void => {
  out(`  ${label.padEnd(30)} ${value}`);
};

function reportCycle(cycle: AutoReplyCycleResult, index: number): void {
  out('');
  out(`[cycle ${String(index + 1)}] ${cycle.outcome}`);
  field('détail', cycle.detail.slice(0, 260));
  field('conversations regardées', String(cycle.candidates));
  field('effets externes', String(cycle.effects));
  field('réponses remises', String(cycle.sent));
  field(
    'budget de déploiement',
    cycle.rolloutRemaining === null ? 'aucune borne' : `${String(cycle.rolloutRemaining)} restant(s)`,
  );
  for (const turn of cycle.turns) {
    out(
      `    @${(turn.handle ?? turn.displayName).slice(0, 26).padEnd(26)} ${turn.outcome.padEnd(26)} ${turn.reasonCode}`,
    );
    out(`      ${turn.detail.slice(0, 200)}`);
  }
}

/**
 * Le code de sortie, choisi pour qu'un superviseur puisse en faire quelque
 * chose sans lire le texte. Les mêmes valeurs que les deux autres runtimes :
 *
 *   0 — cycle(s) terminé(s), rien d'anormal ;
 *   3 — le rail n'est pas armé (aucune activation). Ce n'est pas une panne ;
 *   5 — le dépôt a changé sous le processus : relancer.
 */
function exitCodeFor(report: AutoReplyRuntimeReport): number {
  if (report.stoppedBy === 'CODE_REVISION_CHANGED') return 5;
  if (report.stoppedBy === 'RUNTIME_NOT_ACTIVATED') return 3;
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadInstagramRail();
  const conversation = loadConversationPolicy();
  const sql = await getSql();
  const workerId = `autoreply/${hostname()}/pid-${String(process.pid)}`;
  const sentinel = createCodeRevisionSentinel(process.cwd());
  const mode: AutoReplyMode = args.mode === 'plan' ? 'PLAN' : args.preview ? 'PREVIEW' : 'LIVE';
  const log = logger.child({ rail: 'autoreply', workerId });
  let exitCode = 0;

  try {
    const killSwitch = await loadKillSwitch(sql);
    out('');
    out('HERMES-AUTO-REPLY-PRODUCTION-R1 — RUNTIME D’AUTO-RÉPONSE');
    field('mode', args.mode === 'plan' ? '--plan (aucun rail construit)' : args.mode === 'once' ? '--once' : '--loop');
    field('effet', mode === 'LIVE' ? 'LIVE — un clic est possible' : 'AUCUN — ce mode ne peut pas cliquer');
    field('politique de conversation', CONVERSATION_POLICY_VERSION);
    field('plafond d’effets/cycle', String(args.maxEffects ?? AUTO_REPLY_MAX_EFFECTS_PER_CYCLE));
    field('cadence de sondage_ms', String(args.pollMs ?? AUTO_REPLY_IDLE_POLL_MS));
    field(
      'plafonds de VOLUME',
      `INCHANGÉS — ${String(config.caps.dailySentCap)}/j, ${String(config.caps.hourlySentCap)}/h, ` +
        `${String(config.caps.minSendIntervalMs)} ms d’espacement`,
    );
    field('arrêt global', killSwitch.engaged ? 'ARMÉ → aucun effet' : 'levé');
    field('révision du dépôt', sentinel.startedAt?.slice(0, 12) ?? '— (hors dépôt Git)');

    const controller = new AbortController();
    let stopping = false;
    const stop = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      out('');
      out(`  ${signal} reçu — arrêt propre après le cycle en cours.`);
      controller.abort();
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));

    // Le rail n'existe QUE si un effet est concevable. En mode `--plan`, il n'y
    // a pas d'objet capable d'agir dans ce processus — c'est le type qui le
    // dit, pas une précaution.
    const rail: InstagramReplyRail | null =
      args.mode === 'plan'
        ? null
        : new PlaywrightInstagramReplyRail({
            config,
            workerId,
            headless: args.headed ? false : config.session.headless,
          });

    let report: AutoReplyRuntimeReport;
    try {
      report = await runAutoReplyRuntime(
        {
          sql,
          config,
          conversation,
          workerId,
          mode,
          ...(args.maxEffects === null ? {} : { maxEffectsPerCycle: args.maxEffects }),
        },
        { rail },
        {
          signal: controller.signal,
          maxCycles: args.mode === 'loop' ? args.maxCycles : 1,
          ...(args.pollMs === null ? {} : { idlePollMs: args.pollMs }),
          // Un `--loop` doit pouvoir attendre qu'un opérateur arme le rail.
          // Un `--once`/`--plan` n'a rien à attendre : il le dit et sort.
          stopWhenInactive: args.mode !== 'loop',
          codeRevision: sentinel,
          onCycle: async (cycle, index) => {
            reportCycle(cycle, index);
            // Le battement, écrit APRÈS le cycle : il décrit ce qui vient
            // d'avoir lieu, jamais une intention. Une panne d'écriture ne doit
            // pas faire échouer un tour qui, lui, s'est bien passé.
            try {
              await recordAutoReplyHeartbeat(sql, {
                workerId,
                host: hostname(),
                pid: process.pid,
                mode,
                codeRevision: sentinel.startedAt,
                cycles: index + 1,
                effects: cycle.effects,
                lastOutcome: cycle.outcome,
                lastDetail: cycle.detail,
              });
            } catch (error: unknown) {
              log.warn('autoreply.heartbeat_failed', {
                detail: error instanceof Error ? error.message : String(error),
              });
            }
            // L'INVARIANT : on n'attend jamais en tenant le profil.
            const lease = inspectInstagramBrowserLease(config.session.profileDir);
            if (lease.heldByThisProcess) {
              log.warn('autoreply.lease_held_while_idle', { profileDir: config.session.profileDir });
              await rail?.close().catch(() => undefined);
            }
          },
        },
      );
    } finally {
      await rail?.close().catch((error: unknown) => {
        log.warn('autoreply.rail_close_failed', {
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    }

    out('');
    out('HERMES-AUTO-REPLY-PRODUCTION-R1 — bilan');
    field('worker_id', report.workerId);
    field('cycles', String(report.cycles.length));
    field('arrêté par', report.stoppedBy);
    field('effets externes', String(report.effects));
    field('réponses remises', String(report.sent));
    field('durée_ms', String(report.durationMs));
    field('arrêt global', 'NON touché — ni levé, ni réarmé');
    field(
      'profil navigateur',
      inspectInstagramBrowserLease(config.session.profileDir).held ? 'TENU (par un autre runtime)' : 'libre',
    );

    if (report.stoppedBy === 'CODE_REVISION_CHANGED') {
      out('');
      out('Le dépôt a changé depuis le démarrage de ce processus.');
      out('Node garde le code chargé à son lancement : continuer aurait répondu sous les');
      out('constantes d’hier — politique, consigne de rédaction, plafonds.');
      out('Relancer « npm run autoreply:worker -- --loop » pour reprendre sous la version courante.');
    }
    if (report.stoppedBy === 'RUNTIME_NOT_ACTIVATED') {
      out('');
      out('Le rail d’auto-réponse n’est pas armé — c’est l’état de repos du dépôt.');
      out('Pour l’armer : npm run autoreply:activation -- --activate --as "<nom>" --reason "<motif>" --max-effects <n>');
    }

    await closeAutoReplyHeartbeat(sql, workerId, report.stoppedBy).catch(() => undefined);
    exitCode = exitCodeFor(report);
    out('');
  } finally {
    await sql.close();
  }

  // Posé APRÈS la fermeture de la base, jamais avant : PGlite traduit sa
  // fermeture en `process.exitCode = 0`, ce qui effacerait un code posé plus tôt.
  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof ArgError ? 1 : 2;
});
