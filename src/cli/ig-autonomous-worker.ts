#!/usr/bin/env tsx
/**
 * HERMES-AUTONOMOUS-R3 — l'EXÉCUTABLE du worker LIVE autonome.
 *
 *   npm run ig:autonomous:worker -- --once              # un cycle borné, puis on sort
 *   npm run ig:autonomous:worker -- --once --preview    # le chemin entier, sans cliquer
 *   npm run ig:autonomous:worker -- --loop              # runtime durable, jusqu'à SIGINT/SIGTERM
 *   npm run ig:autonomous:worker -- --loop --max-cycles 3 --poll-ms 60000
 *
 * ---------------------------------------------------------------------------
 * Ce fichier ne contient AUCUNE règle
 * ---------------------------------------------------------------------------
 * Il n'y a ici ni file, ni ordonnanceur, ni plafond, ni politique, ni primitive
 * d'envoi, ni décision d'éligibilité. Tout cela vit dans le domaine et y reste :
 * `runAutonomousLiveWorker` choisit les manifestes et rejoue la politique,
 * `runAutonomousLiveRuntime` se contente de le rappeler, `evaluateSchedule`
 * décide du moment, `reserveExternalEffectSlot` compte sous verrou,
 * `runInstagramLiveCanary` fait l'unique clic.
 *
 * Ce que cette commande apporte, et rien d'autre : la configuration canonique,
 * la connexion canonique, un navigateur, des signaux, et un rapport.
 *
 * ---------------------------------------------------------------------------
 * Ce qu'elle ne fait pas, et pourquoi
 * ---------------------------------------------------------------------------
 *
 * 1. **Elle ne lève JAMAIS l'arrêt global.** Il n'existe aucune option pour le
 *    faire, et le code ne l'importe même pas en écriture. Un exécutable capable
 *    d'ouvrir sa propre porte n'est pas gardé par cette porte.
 *
 * 2. **Elle ne le RÉENGAGE pas non plus en sortant** — et c'est le point qui
 *    change depuis `ig:live`. Là-bas, l'arrêt global était l'autorisation d'UNE
 *    invocation : le `finally` refermait derrière lui, et c'était juste. Ici,
 *    il devient l'ARRÊT D'URGENCE d'un runtime qui tourne. Un processus qui le
 *    réarmerait en sortant obligerait un humain à le relever après chaque
 *    redémarrage, et transformerait « le runtime a redémarré » en « le rail est
 *    fermé ». Le lever et le rabattre restent deux gestes d'opérateur, tracés
 *    nominativement dans `ig_kill_switch`.
 *
 * 3. **Elle referme en revanche les autorisations d'effet encore armées**, et
 *    seulement celles de la POLITIQUE (`armed_by_kind = AUTONOMOUS_POLICY`).
 *    Celle qu'un humain aurait armée pour `ig:live` ne lui appartient pas.
 *
 * 4. **Elle n'a ni `--send`, ni `--all`, ni `--batch`, ni `--manifest-id`.** Le
 *    parseur refuse tout ce qu'il ne connaît pas : ajouter un envoi en masse
 *    demanderait de l'écrire ici, dans un diff relu.
 */
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { getSql } from '@/lib/db';
import { loadInstagramRail } from '@/lib/config/load';
import { logger } from '@/lib/logging/logger';
import { PlaywrightInstagramLiveRail } from '@/lib/instagram/playwrightLiveRail';
import { loadKillSwitch } from '@/lib/instagram/safety';
import { reportRefusalTrace } from '@/lib/instagram/refusalTrace';
import {
  AUTONOMOUS_IDLE_POLL_MS,
  runAutonomousLiveRuntime,
  type AutonomousRunResult,
  type AutonomousRuntimeReport,
} from '@/lib/instagram/autonomousLiveWorker';
import { createCodeRevisionSentinel } from '@/lib/inbound/codeRevision';
import { AUTONOMOUS_POLICY_VERSION } from '@/lib/instagram/autonomousPolicy';

const SCREENSHOT_DIR = 'var/instagram/screenshots';
const REFUSAL_TRACE_DIR = 'var/instagram/refusal-traces';

class ArgError extends Error {}

interface Args {
  readonly mode: 'once' | 'loop';
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
      case '--once':
      case '--loop':
        if (mode !== null) throw new ArgError('--once et --loop sont exclusifs');
        mode = token === '--once' ? 'once' : 'loop';
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
        maxEffects = integer(argv[++i], '--max-effects', 0, 10);
        break;
      case '--poll-ms':
        pollMs = integer(argv[++i], '--poll-ms', 1_000, 900_000);
        break;
      default:
        throw new ArgError(
          `option inconnue : « ${String(token)} » — cette commande n'a ni --send, ni --all, ` +
            'ni --batch, ni --manifest-id, et ne sait pas lever l’arrêt global',
        );
    }
  }

  // Aucun mode par défaut. Un runtime dont le défaut serait « tourne »
  // démarrerait par accident, et celui-ci peut produire un effet réel.
  if (mode === null) {
    throw new ArgError('choisir exactement un mode : --once (un cycle borné) ou --loop (runtime durable)');
  }
  if (mode === 'once' && maxCycles !== null) {
    throw new ArgError('--max-cycles n’a de sens qu’avec --loop — --once vaut exactement un cycle');
  }
  return { mode, preview, headed, maxCycles, maxEffects, pollMs };
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(28)} ${value}\n`);
}

function reportCycle(cycle: AutonomousRunResult, index: number): void {
  process.stdout.write(`\n[cycle ${String(index + 1)}] ${cycle.stopCode}\n`);
  line('stop', cycle.stop);
  line('detail', cycle.stopDetail.slice(0, 300));
  line('effets externes', String(cycle.effects));
  line('envois prouvés', String(cycle.sent));
  line('reste en file', String(cycle.queueRemaining));
  line('prochain dû', cycle.nextEligibleAt ?? '—');
  for (const outcome of cycle.outcomes) {
    process.stdout.write(
      `    @${outcome.handle.padEnd(28)} ${outcome.status.padEnd(16)} ${outcome.reasonCode}\n` +
        `      ${outcome.detail.slice(0, 220)}\n`,
    );
  }
}

function reportRun(report: AutonomousRuntimeReport): void {
  process.stdout.write('\nHERMES-AUTONOMOUS-R3 — bilan\n');
  line('worker_id', report.workerId);
  line('cycles', String(report.cycles.length));
  line('arrêté par', report.stoppedBy);
  line('effets externes', String(report.effects));
  line('envois prouvés', String(report.sent));
  line('autorisations révoquées', String(report.revokedAuthorizations));
  line('durée_ms', String(report.durationMs));
  line('arrêt global', 'NON réengagé — c’est l’arrêt d’urgence de l’opérateur, pas un verrou de session');

  if (report.stoppedBy === 'CODE_REVISION_CHANGED') {
    process.stdout.write(
      '\nLe dépôt a changé depuis le démarrage de ce processus.\n' +
        'Node garde le code chargé à son lancement : continuer aurait ENVOYÉ sous les\n' +
        'constantes d’hier — plafonds, politique autonome, version d’approbation.\n' +
        'Relancer « npm run ig:autonomous:worker -- --loop » pour reprendre sous la version courante.\n',
    );
  }
}

/**
 * Le code de sortie, choisi pour qu'un superviseur puisse en faire quelque
 * chose sans lire le texte.
 *
 *   0 — cycle(s) terminé(s), rien d'anormal ;
 *   2 — arrêt dur (challenge, captcha, compte bloqué) : un humain doit regarder ;
 *   3 — l'arrêt global était armé, donc zéro effet. Ce n'est pas une panne ;
 *   5 — le dépôt a changé sous le processus : relancer. Même code que le rail
 *       entrant, pour qu'un superviseur n'ait qu'une règle à connaître.
 */
function exitCodeFor(report: AutonomousRuntimeReport): number {
  if (report.stoppedBy === 'HARD_STOP') return 2;
  // Même code que le rail entrant, pour qu'un superviseur n'ait qu'une règle à
  // connaître : « 5 = relance-moi, je tourne sous du code périmé ».
  if (report.stoppedBy === 'CODE_REVISION_CHANGED') return 5;
  const last = report.cycles[report.cycles.length - 1];
  if (report.effects === 0 && last !== undefined && last.stopCode === 'BLOCKED_KILL_SWITCH') return 3;
  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadInstagramRail();
  const sql = await getSql();
  const workerId = `ig-autonomous/${hostname()}/pid-${String(process.pid)}`;
  let exitCode = 0;

  try {
    // Lu et AFFICHÉ avant toute chose, jamais imposé ici : c'est le domaine qui
    // l'oppose, à chaque cycle. L'afficher évite seulement qu'un opérateur
    // regarde une sortie vide en se demandant pourquoi.
    const killSwitch = await loadKillSwitch(sql);
    process.stdout.write('\nHERMES-AUTONOMOUS-R3 — WORKER LIVE AUTONOME\n');
    line('mode', args.mode === 'once' ? '--once (un cycle borné)' : '--loop (runtime durable)');
    line('effet', args.preview ? 'APERÇU — aucun clic possible' : 'LIVE — un clic est possible');
    line('politique', AUTONOMOUS_POLICY_VERSION);
    line('provenance exigée', 'AUTONOMOUS_POLICY — un manifeste humain est ignoré');
    line('plafond d’effets/cycle', String(args.maxEffects ?? config.queue.maxJobsPerRun));
    line('cadence de sondage_ms', String(args.pollMs ?? AUTONOMOUS_IDLE_POLL_MS));
    line('arrêt global', killSwitch.engaged ? 'ARMÉ → BLOCKED_KILL_SWITCH, 0 effet' : 'levé');
    line('arrêt global posé par', killSwitch.setBy ?? '— (défaut fail-closed)');

    const controller = new AbortController();
    let stopping = false;
    const stop = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      process.stdout.write(`\n${signal} reçu — arrêt propre après le cycle en cours.\n`);
      controller.abort();
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));

    const rail = new PlaywrightInstagramLiveRail({
      config,
      headless: args.headed ? false : config.session.headless,
      screenshotDir: resolve(process.cwd(), SCREENSHOT_DIR),
      workerId,
    });

    let report: AutonomousRuntimeReport | null = null;
    let failure: unknown = null;
    try {
      report = await runAutonomousLiveRuntime(
        {
          sql,
          config,
          workerId,
          maxEffects: args.maxEffects ?? config.queue.maxJobsPerRun,
          previewOnly: args.preview,
        },
        { rail },
        {
          signal: controller.signal,
          maxCycles: args.mode === 'once' ? 1 : args.maxCycles,
          ...(args.pollMs === null ? {} : { idlePollMs: args.pollMs }),
          // Le rail ENTRANT portait déjà cette sentinelle ; le worker sortant
          // ne l'avait pas, alors que c'est lui qui envoie. Un `--loop` démarré
          // avant un correctif de politique continuait d'appliquer les
          // constantes de son démarrage, sans que rien ne le dise.
          codeRevision: createCodeRevisionSentinel(process.cwd()),
        },
      );
      report.cycles.forEach(reportCycle);
      reportRun(report);
      line('clics_navigateur', String(rail.clickCount));
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // La trace de NOS refus réseau, quoi qu'il arrive, et sans jamais lever :
      // c'est elle qui rend un `DELIVERY_FAILED` explicable.
      try {
        reportRefusalTrace(
          (chunk) => process.stdout.write(chunk),
          resolve(process.cwd(), REFUSAL_TRACE_DIR),
          {
            mode: args.preview ? 'preview' : 'live',
            subject: `autonomous:${args.mode}`,
            workerId,
            outcome:
              failure !== null
                ? failure instanceof Error
                  ? `THROWN:${failure.name}`
                  : 'THROWN:unknown'
                : (report?.stoppedBy ?? 'NO_RESULT'),
          },
          rail.refusalSnapshot(),
        );
      } catch {
        /* Une trace manquée ne doit pas empêcher la fermeture du navigateur. */
      }
      await rail.close().catch((error: unknown) => {
        logger.warn('instagram.autonomous.rail_close_failed', {
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    }

    process.stdout.write('\n');
    exitCode = exitCodeFor(report);
  } finally {
    await sql.close();
  }

  // Posé APRÈS la fermeture de la base, et jamais avant.
  //
  // PGlite est un Postgres compilé en WebAssembly : sa fermeture passe par
  // `proc_exit(0)`, et le runtime Emscripten traduit ce zéro en
  // `process.exitCode = 0`. Un code posé plus tôt serait donc silencieusement
  // effacé — un `--once` qui rendrait « l'arrêt global était armé » sortirait
  // en disant « tout va bien », ce qu'un superviseur croirait.
  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof ArgError ? 1 : 2;
});
