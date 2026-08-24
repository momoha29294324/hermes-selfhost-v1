#!/usr/bin/env tsx
/**
 * IG5.2A — le RUNTIME de la relève entrante Instagram, 24/7.
 *
 *   npm run ig:inbound:run -- --plan            # ce qui serait fait, sans rien faire
 *   npm run ig:inbound:run -- --once            # un tour, puis on sort
 *   npm run ig:inbound:run -- --loop            # jusqu'à SIGINT / SIGTERM
 *   npm run ig:inbound:run -- --loop --max-ticks 3
 *
 * ---------------------------------------------------------------------------
 * Ce que cette commande ne peut pas faire
 * ---------------------------------------------------------------------------
 *
 * Envoyer. Répondre. Marquer un fil comme lu. Suivre, aimer, commenter. Comme
 * `ig:inbound:poll`, et pour les mêmes trois raisons structurelles : le rail
 * construit ici n'expose aucune de ces méthodes (erreur de compilation), le
 * runtime ET le collecteur refusent de tourner si l'objet reçu en expose une
 * malgré tout, et la garde réseau du contexte refuse qu'une requête d'effet
 * SORTE du processus — `IGDirectTextSendMutation` comme les deux
 * `useIGDMarkThreadAsRead*Mutation` sont refusées avant d'atteindre Instagram.
 *
 * ---------------------------------------------------------------------------
 * 24/7, et désarmé par défaut
 * ---------------------------------------------------------------------------
 *
 * Aucune fenêtre horaire, aucun jour ouvré, aucun fuseau : un prospect qui
 * répond samedi à 03:00 est détecté samedi à 03:00. Le kill-switch sortant
 * n'est ni lu ni consulté — il arrête les EFFETS, et lire n'en est pas un.
 *
 * En revanche `inbound.enabled` vaut `false` au dépôt : sans un diff ou une
 * variable d'environnement, cette commande dit ce qu'elle ferait et sort.
 */
import { hostname } from 'node:os';
import { getSql } from '@/lib/db';
import { loadInstagramRail } from '@/lib/config/load';
import { logger } from '@/lib/logging/logger';
import { createCodeRevisionSentinel } from '@/lib/inbound/codeRevision';
import { ModelRouter } from '@/lib/models/router';
import { resolveCrmDestination } from '@/lib/crm/resolve';
import { createReplyProcessingStep } from '@/lib/inbound/instagramDownstream';
import {
  InboundRuntimeConfigError,
  decideInboundTick,
  loadInboundRuntimeState,
  resolveInboundRuntimeConfig,
  runInboundRuntimeLoop,
  type InboundRuntimeConfig,
  type InboundTickResult,
} from '@/lib/inbound/instagramRuntime';
import { PlaywrightInstagramInboundRail } from '@/lib/instagram/playwrightInboundRail';
import { forbiddenMethodsOn } from '@/lib/instagram/inboundRail';
import { hasSendPrimitive } from '@/lib/instagram/rail';

class ArgError extends Error {}

interface Args {
  readonly mode: 'plan' | 'once' | 'loop';
  readonly maxTicks: number | null;
  readonly headed: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let mode: Args['mode'] | null = null;
  let maxTicks: number | null = null;
  let headed = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--plan' || arg === '--once' || arg === '--loop') {
      if (mode !== null) throw new ArgError('--plan, --once et --loop sont exclusifs');
      mode = arg.slice(2) as Args['mode'];
      continue;
    }
    if (arg === '--max-ticks') {
      const raw = argv[i + 1];
      i += 1;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1 || value > 10_000) {
        throw new ArgError('--max-ticks attend un entier entre 1 et 10000');
      }
      maxTicks = value;
      continue;
    }
    if (arg === '--headed') {
      headed = true;
      continue;
    }
    throw new ArgError(`option inconnue : ${String(arg)}`);
  }

  // `--plan` par défaut : le mode qui n'ouvre rien. Un runtime dont le défaut
  // serait « tourne » démarrerait par accident.
  return { mode: mode ?? 'plan', maxTicks, headed };
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(30)} ${value}\n`);
}

function describeConfig(config: InboundRuntimeConfig): void {
  process.stdout.write('\n Configuration du runtime\n');
  line('enabled', config.enabled ? 'true' : 'false — aucune relève ne sera tentée');
  line('account_handle', config.accountHandle === null ? '— (à renseigner)' : `@${config.accountHandle}`);
  line('poll_interval_ms', String(config.pollIntervalMs));
  line('lease_ms', String(config.leaseMs));
  line('retry_backoff_ms', String(config.retryBackoffMs));
  line('max_backoff_ms', String(config.maxBackoffMs));
  line('awaiting_human_backoff_ms', String(config.awaitingHumanBackoffMs));
  line('max_threads_per_poll', String(config.maxThreadsPerPoll));
  line('downstream_limit', String(config.downstreamLimit));
  line('fenêtre de collecte', '24/7 — la fenêtre cold outbound ne s’applique pas à la lecture');
  line('kill-switch sortant', 'non consulté — il arrête les effets, pas la lecture');
}

function reportTick(tick: InboundTickResult, index: number): void {
  process.stdout.write(`\n[${index + 1}] ${tick.decision.verdict} → ${tick.outcome}\n`);
  line('raison', tick.decision.reason);
  line('poll_id', tick.pollId ?? '—');
  line('session_state', tick.sessionState ?? '—');
  if (tick.report !== null) {
    line('lignes vues', String(tick.report.rowsSeen));
    line('fils lus', String(tick.report.threadsRead));
    line('bulles observées', String(tick.report.messagesObserved));
    line('réponses nouvelles', String(tick.report.ingested));
    line('réponses déjà connues', String(tick.report.alreadyKnown));
    line('requêtes d’écriture bloquées', String(tick.report.blockedWriteRequests));
  }
  if (tick.downstream !== null) line('aval', tick.downstream.detail);
  if (tick.failureDetail !== null) line('panne', tick.failureDetail.slice(0, 200));
  if (tick.needsHuman) {
    process.stdout.write(
      '  ⚠ INTERVENTION HUMAINE REQUISE — la session doit être refaite ; le runtime ne contourne rien.\n',
    );
  }
  if (tick.decision.nextAttemptAt !== null) {
    line('prochaine tentative', tick.decision.nextAttemptAt.toISOString());
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const railConfig = loadInstagramRail();
  const config = resolveInboundRuntimeConfig(railConfig, process.env);

  process.stdout.write('\nIG5.2A — RUNTIME DE RELÈVE ENTRANTE INSTAGRAM (lecture seule)\n');
  describeConfig(config);

  const sql = await getSql();
  try {
    if (args.mode === 'plan') {
      const state = config.accountHandle === null ? null : await loadInboundRuntimeState(sql, config.accountHandle);
      const decision = decideInboundTick({
        state:
          state ?? {
            accountHandle: '',
            running: null,
            lastTerminal: null,
            lastSuccessful: null,
            consecutiveFailures: 0,
          },
        config,
        now: new Date(),
      });
      process.stdout.write('\n Décision à cet instant\n');
      line('verdict', decision.verdict);
      line('raison', decision.reason);
      line('attente_ms', String(decision.waitMs));
      line('prochaine tentative', decision.nextAttemptAt?.toISOString() ?? '—');
      line('intervention humaine', decision.needsHuman ? 'REQUISE' : 'non');
      if (state?.running != null) {
        line('bail détenu par', state.running.polledBy);
        line('bail échoit à', state.running.leaseExpiresAt.toISOString());
      }
      line('tours non réussis d’affilée', String(state?.consecutiveFailures ?? 0));
      process.stdout.write(
        '\nAucun navigateur ouvert, aucune ligne écrite. Lancer --once ou --loop pour relever.\n\n',
      );
      return;
    }

    if (!config.enabled) {
      // Fail-closed, et le dire précisément : ce n'est pas une panne, c'est le
      // défaut du dépôt. IG5.2A n'active rien.
      process.stdout.write(
        '\nLe runtime entrant est DÉSARMÉ (inbound.enabled = false).\n' +
          'Aucune relève n’est tentée. Pour l’armer : config/instagram.json → inbound.enabled,\n' +
          'ou OUTBOUND_IG_INBOUND_ENABLED=1 le temps d’une invocation.\n\n',
      );
      process.exitCode = 3;
      return;
    }
    if (config.accountHandle === null) {
      throw new ArgError(
        'aucun compte à relever : renseigner config/instagram.json → inbound.accountHandle, ' +
          'ou OUTBOUND_IG_INBOUND_ACCOUNT — aucun compte n’est deviné depuis la session ouverte',
      );
    }

    const controller = new AbortController();
    let stopping = false;
    const stop = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      process.stdout.write(`\n${signal} reçu — arrêt gracieux après le tour en cours.\n`);
      controller.abort();
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));

    const router = new ModelRouter({ sql, logger });
    const crm = await resolveCrmDestination(sql);
    const screenshotDir = `${railConfig.session.profileDir.replace(/\/profile$/, '')}/inbound-screenshots`;

    const report = await runInboundRuntimeLoop(
      sql,
      {
        polledBy: `runtime:${hostname()}:${process.pid}`,
        logger: logger.child({ cli: 'ig-inbound-run' }),
        signal: controller.signal,
        // HERMES-ACTIVE-ANALYSIS-VERSION-CONFLICT-R1 — la boucle s'arrête si le
        // dépôt bouge sous elle. Câblée ici parce que c'est la CLI qui sait où
        // vit le dépôt ; elle ne peut produire qu'un arrêt.
        codeRevision: createCodeRevisionSentinel(process.cwd()),
        downstream: createReplyProcessingStep(router, { limit: config.downstreamLimit, crm }),
        // Le profil partagé avec le worker sortant : le tour prend son bail
        // avant d'ouvrir une ligne de relève, pour qu'une contention ne laisse
        // aucune trace d'échec. Voir `InboundTickDeps.profileDir`.
        profileDir: railConfig.session.profileDir,
        railFactory: () => {
          const rail = new PlaywrightInstagramInboundRail({
            config: railConfig,
            workerId: `ig-inbound-${process.pid}`,
            headless: !args.headed,
            screenshotDir,
          });
          // La preuve, à chaque tour, sur l'objet et non sur le type.
          const forbidden = forbiddenMethodsOn(rail);
          if (hasSendPrimitive(rail) || forbidden.length > 0) {
            throw new Error(
              `le rail entrant expose une capacité d'action (${forbidden.join(', ') || 'primitive d’envoi'}) — ` +
                'relève refusée',
            );
          }
          return rail;
        },
      },
      config,
      { maxTicks: args.mode === 'once' ? 1 : args.maxTicks },
    );

    report.ticks.forEach(reportTick);

    process.stdout.write('\n Bilan\n');
    line('tours', String(report.ticks.length));
    line('relèves ouvertes', String(report.polls));
    line('réponses nouvelles', String(report.ingested));
    line('classifiées', String(report.classified));
    line('brouillons (PROPOSED max)', String(report.drafted));
    line('arrêté par', report.stoppedBy);

    if (report.stoppedBy === 'CODE_REVISION_CHANGED') {
      process.stdout.write(
        '\nLe dépôt a changé depuis le démarrage de ce processus.\n' +
          'Node garde le code chargé à son lancement : continuer aurait classifié sous les\n' +
          'constantes d’hier, et écarté des conclusions rendues par un processus à jour.\n' +
          'Relancer « npm run ig:inbound:run -- --loop » pour reprendre sous la version courante.\n',
      );
      process.exitCode = 5;
    }

    process.stdout.write('\nAucun envoi, aucune réponse, aucun accusé de lecture.\n\n');
    if (report.ticks.some((tick) => tick.needsHuman)) process.exitCode = 4;
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof ArgError || error instanceof InboundRuntimeConfigError ? 1 : 2;
});
