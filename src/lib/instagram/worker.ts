import type { Sql } from '@/lib/db/sql';
import type { InstagramRailConfig } from '@/lib/config/schema';
import { logger } from '@/lib/logging/logger';
import { DispatchBlockedError, insertDispatchAttempt, resolveDispatchTarget } from '@/lib/pipeline/r6bDispatcher';
import { DRY_RUN_ADAPTERS, type DryRunPreview } from '@/lib/pipeline/r6bTransportAdapters';
import { getLiveReadiness } from '@/lib/pipeline/r6bTransportPayload';
import { decideIdentity } from '@/lib/instagram/identity';
import {
  closeBrowserSession,
  recordBrowserSession,
  recordIdentityCheck,
  recordJobEvent,
  type JobEventStatus,
} from '@/lib/instagram/events';
import {
  claimNextInstagramJob,
  detectJobManifestDrift,
  finalizeInstagramJob,
  recoverExpiredLeases,
  type InstagramJob,
} from '@/lib/instagram/queue';
import { evaluateWorkloadCaps, loadSafetySnapshot } from '@/lib/instagram/safety';
import {
  evaluateSchedule,
  loadScheduleSnapshot,
  nextAttemptAt,
  type ScheduleDecision,
} from '@/lib/instagram/scheduler';
import {
  hasSendPrimitive,
  InstagramRailError,
  LIVE_SEND_PRIMITIVE,
  type InstagramReadOnlyRail,
  type InstagramSessionStatus,
} from '@/lib/instagram/rail';
import {
  IDENTITY_VERDICT_BLOCK_CODE,
  SESSION_STATE_BLOCK_CODE,
  isHardStopSessionState,
  isUsableSessionState,
  skipClassOf,
  type GateRecord,
  type InstagramIdentityVerdict,
  type InstagramJobStatus,
  type InstagramMode,
  type InstagramReasonCode,
  type InstagramSessionState,
  type InstagramSkipClass,
  type InstagramSkipReason,
} from '@/lib/instagram/types';

/**
 * IG-R1 §6 / IG3 §6 — le worker DRY-RUN, en conditions de production.
 *
 * Ce qu'il fait : prendre un job, revalider l'intention approuvée, évaluer les
 * gardes, décider de l'ordonnancement, ouvrir la session persistante, ouvrir le
 * profil exact, vérifier l'identité, calculer le message qui PARTIRAIT, et
 * journaliser chaque étape.
 *
 * Ce qu'il ne peut pas faire, et pourquoi ce n'est pas une promesse :
 *
 *   * il ne reçoit qu'un `InstagramReadOnlyRail`, qui n'expose aucune méthode
 *     capable d'agir (`rail.ts`) — il n'y a rien à appeler pour envoyer ;
 *   * un envoi Instagram existe désormais (IG2), et ce worker le VÉRIFIE au
 *     lieu de le supposer : si l'objet qu'on lui passe expose la primitive
 *     d'envoi, il refuse de tourner plutôt que de s'en servir
 *     (`hasSendPrimitive`) ;
 *   * ses écritures d'audit déclarent `externalEffectAttempted: false`, sous une
 *     contrainte de base qui refuse la ligne si un DRY_RUN prétendait le
 *     contraire (0029, élargie en 0039) ;
 *   * il n'importe ni n'écrit `outreach_events`. Un DRY-RUN n'est pas un
 *     contact, et aucun KPI ne doit prendre un aperçu pour une prise de contact.
 *
 * IG3 — ce qui a changé, et pourquoi
 * -----------------------------------
 * Le worker DRY-RUN ne pouvait pas tourner : `evaluateSafety` lui opposait
 * l'arrêt global, armé par défaut. Une garde d'ENVOI barrait un chemin qui
 * n'envoie pas — donc le seul chemin qui permettait de vérifier le rail sans
 * rien risquer était aussi le seul qu'on ne pouvait jamais emprunter.
 *
 * La correction n'est pas de relâcher la garde mais de la RANGER. Les gardes
 * qui bornent un effet (arrêt global, plafonds, cadence) sont désormais
 * évaluées par l'ordonnanceur et, ici, PROJETÉES : elles disent ce qui se
 * passerait en LIVE, et l'aperçu continue. Celles qui bornent le travail
 * (échecs consécutifs, sessions mortes) restent opposables, parce qu'un rail en
 * panne le reste qu'on l'observe ou qu'on l'utilise.
 *
 * L'arrêt global fait exception à l'exception : il est projeté, jamais opposé,
 * exactement parce que ce chemin ne peut produire aucun effet. La fenêtre
 * horaire et les plafonds, eux, sont OPPOSÉS même ici — sans quoi le dry-run
 * cesserait d'être une répétition fidèle et le « et quand » de la mission
 * n'aurait aucune valeur.
 */

export interface WorkerDeps {
  /** Injecté, jamais construit ici : le domaine n'ouvre pas de navigateur de lui-même. */
  readonly rail: InstagramReadOnlyRail;
}

export interface RunInput {
  readonly sql: Sql;
  readonly config: InstagramRailConfig;
  readonly workerId: string;
  readonly mode: InstagramMode;
  /** Restreint l'exécution à un job précis. Absent : la file, dans l'ordre. */
  readonly jobId?: string;
  readonly maxJobs?: number;
  /**
   * IG3 §9 — vider la file : continuer tant qu'un job est dû, au lieu de
   * s'arrêter à `maxJobsPerRun`. Reste borné par `DRAIN_CEILING`, et le
   * dépassement est journalisé — une troncature silencieuse se lirait comme
   * « la file est vide » alors qu'elle ne l'est pas.
   */
  readonly drain?: boolean;
  /** L'horloge de l'ordonnanceur. Injectable pour que les fenêtres soient testables. */
  readonly now?: () => Date;
}

const DRAIN_CEILING = 500;

/** Ce que le worker aurait fait s'il avait eu le droit d'agir. */
export interface LiveProjection {
  /** `true` si rien, dans le temps, ne se serait opposé à un envoi à cet instant. */
  readonly wouldProceed: boolean;
  readonly blockedBy: InstagramSkipReason | null;
  readonly detail: string;
  /** Quand la condition qui refuse aurait cessé d'être vraie. */
  readonly nextEligibleAt: string | null;
}

export interface JobOutcome {
  readonly jobId: string;
  readonly manifestId: string;
  readonly prospectId: string;
  readonly expectedHandle: string;
  readonly observedHandle: string | null;
  readonly idempotencyKey: string;
  /** Le statut journalisé dans `ig_job_events`. */
  readonly status: JobEventStatus;
  /**
   * L'état dans lequel le job est reparti — ou s'est arrêté pour toujours.
   *
   * `PENDING` et `CLAIMED` en sont exclus par le type : le premier est l'état
   * d'un job jamais traité, le second celui d'un bail en cours. Un traitement
   * qui rendrait l'un des deux prétendrait n'avoir pas eu lieu.
   */
  readonly jobStatus: Exclude<InstagramJobStatus, 'PENDING' | 'CLAIMED'>;
  readonly reasonCode: InstagramReasonCode;
  readonly detail: string;
  readonly sessionState: InstagramSessionState | null;
  readonly gates: readonly GateRecord[];
  readonly eventId: string;
  readonly durationMs: number;
  /** IG3 §8 — le motif de report ou de refus, et sa durée de vie. */
  readonly skipReason: InstagramSkipReason | null;
  readonly skipClass: InstagramSkipClass | null;
  /** Quand ce job redeviendra réclamable. `null` s'il ne le redeviendra jamais. */
  readonly nextAttemptAt: string | null;
  /** Le message qui partirait, calculé par le même adapter qu'un envoi réel. `null` si on n'est jamais allé si loin. */
  readonly preview: DryRunPreview | null;
  readonly liveReady: boolean | null;
  readonly missingForLive: readonly string[] | null;
  /** IG3 §6 — ce que le LIVE aurait fait, et quand. */
  readonly liveProjection: LiveProjection | null;
  readonly screenshotPath: string | null;
  /** `true` quand ce job impose l'arrêt de toute l'exécution (challenge, captcha, blocage). */
  readonly hardStop: boolean;
}

export interface RunResult {
  readonly workerId: string;
  readonly mode: InstagramMode;
  readonly recoveredLeases: number;
  readonly reviewRequired: number;
  readonly outcomes: readonly JobOutcome[];
  readonly sessionId: string | null;
  readonly sessionState: InstagramSessionState | null;
  readonly stoppedEarly: string | null;
  /** `true` si `--drain` s'est arrêté sur son plafond plutôt que sur une file vide. */
  readonly drainTruncated: boolean;
  /** Invariant de la mission, calculé et non affirmé : aucun effet Instagram. */
  readonly externalEffects: 0;
}

/** Mémorise la session : un navigateur par exécution, jamais un par prospect. */
class SessionHolder {
  private status: InstagramSessionStatus | null = null;
  private id: string | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly rail: InstagramReadOnlyRail,
    private readonly workerId: string,
  ) {}

  get sessionId(): string | null {
    return this.id;
  }

  get sessionState(): InstagramSessionState | null {
    return this.status?.state ?? null;
  }

  async ensure(): Promise<InstagramSessionStatus> {
    if (this.status) return this.status;
    const status = await this.rail.ensureSession();
    this.id = await recordBrowserSession(this.sql, {
      workerId: this.workerId,
      profileLabel: status.profileLabel,
      headless: status.headless,
      state: status.state,
      detail: status.detail,
    });
    this.status = status;
    return status;
  }

  async close(): Promise<void> {
    if (this.id) await closeBrowserSession(this.sql, this.id);
  }
}

/**
 * Traduction état de session → motif de report. Un état non exploitable n'est
 * jamais terminal : une session se reconnecte, et le job qui l'attendait n'a
 * rien à voir avec la panne.
 */
const SESSION_STATE_SKIP_REASON: Readonly<Record<Exclude<InstagramSessionState, 'SESSION_READY'>, InstagramSkipReason>> =
  Object.freeze({
    LOGIN_REQUIRED: 'login_required',
    SESSION_EXPIRED: 'session_unavailable',
    // Il manque bien une connexion — celle du BON compte. Le job est reporté
    // et non brûlé : ce n'est pas lui qui a un problème, c'est la session.
    SESSION_WRONG_ACCOUNT: 'login_required',
    UNKNOWN: 'session_unavailable',
    CHALLENGE: 'challenge',
    CAPTCHA: 'challenge',
    BLOCKED: 'challenge',
  });

/**
 * Traduction verdict d'identité → motif, et c'est ici que se joue la
 * distinction que la mission demande au §8.
 *
 * `MISMATCH` et `AMBIGUOUS` sont TERMINAUX : le compte visible n'est pas — ou
 * n'est pas sûrement — celui qu'un humain a approuvé. Réessayer ne produira pas
 * une autre réponse, et « réessayer jusqu'à ce que ça corresponde » est
 * exactement la façon dont on finit par écrire au mauvais compte.
 *
 * `NOT_FOUND` et `UNAVAILABLE` sont TEMPORAIRES : un profil momentanément
 * injoignable ou une page qu'on n'a pas su lire décrivent l'état du RÉSEAU, pas
 * celui de la cible.
 */
const IDENTITY_VERDICT_SKIP_REASON: Readonly<
  Record<Exclude<InstagramIdentityVerdict, 'MATCH'>, InstagramSkipReason>
> = Object.freeze({
  MISMATCH: 'identity_failure',
  AMBIGUOUS: 'identity_failure',
  NOT_FOUND: 'target_unreachable',
  UNAVAILABLE: 'target_unreachable',
});

/**
 * Les refus R6B qui portent sur la PERSONNE, donc définitifs côté file. Les
 * autres décrivent un manifeste réparable et n'ont pas à condamner un prospect.
 */
const R6B_TERMINAL_SKIP_REASON: Readonly<Record<string, InstagramSkipReason>> = Object.freeze({
  RECIPIENT_SUPPRESSED: 'opt_out',
  PROSPECT_STATE_BLOCKS_OUTBOUND: 'prospect_inactive',
});

/**
 * Traite un job déjà pris. Ne prend ni ne relâche le bail — l'appelant s'en
 * charge, pour que la prise atomique et le traitement restent deux
 * responsabilités séparables (et testables séparément).
 */
async function processClaimedJob(
  input: RunInput,
  deps: WorkerDeps,
  session: SessionHolder,
  job: InstagramJob,
): Promise<JobOutcome> {
  const { sql, config, workerId, mode } = input;
  const now = input.now ?? ((): Date => new Date());
  const started = Date.now();
  const gates: GateRecord[] = [];
  let observedHandle: string | null = null;
  let sessionState: InstagramSessionState | null = null;
  let preview: DryRunPreview | null = null;
  let liveReady: boolean | null = null;
  let missingForLive: readonly string[] | null = null;
  let liveProjection: LiveProjection | null = null;
  let screenshotPath: string | null = null;
  /**
   * La date de reprise que l'ordonnanceur a calculée, quand il en a calculé
   * une. Nulle pour tous les autres motifs de report, qui n'ont pas d'échéance
   * connue et retombent donc sur `defaultBackoffMs`.
   */
  let scheduleNextEligible: Date | null = null;

  /**
   * Clôt le traitement : journalise l'événement, puis calcule ce que le job
   * devient.
   *
   * `skipReason` porte toute la sémantique. Son absence veut dire « rien à
   * reporter » ; sa présence détermine, par `skipClassOf` et lui seul, si le
   * job repart dans la file ou s'y arrête pour de bon. L'appelant ne choisit
   * jamais la classe — c'est la garantie que la mission §8 demande.
   */
  const finish = async (
    eventStatus: JobEventStatus,
    reasonCode: InstagramReasonCode,
    detail: string,
    options: { skipReason?: InstagramSkipReason; hardStop?: boolean } = {},
  ): Promise<JobOutcome> => {
    const durationMs = Date.now() - started;
    const skipReason = options.skipReason ?? null;
    const skipClass = skipReason === null ? null : skipClassOf(skipReason);

    // La replanification. Un motif terminal n'en reçoit aucune — et ne peut pas
    // en recevoir : la base refuserait un motif TERMINAL sur un statut resté
    // réclamable.
    const nextAttempt =
      skipReason === null || skipClass === 'TERMINAL'
        ? null
        : nextAttemptAt({
            now: now(),
            decision: {
              allowed: false,
              reason: skipReason,
              detail,
              nextEligibleAt: scheduleNextEligible,
              gates: [],
            },
            config,
            idempotencyKey: job.idempotencyKey,
          });

    const jobStatus: Exclude<InstagramJobStatus, 'PENDING' | 'CLAIMED'> =
      eventStatus === 'DRY_RUN_COMPLETED'
        ? 'DRY_RUN_VALIDATED'
        : eventStatus === 'FAILED'
          ? 'FAILED'
          : skipClass === 'TERMINAL'
            ? 'INELIGIBLE'
            : 'SKIPPED';

    const eventId = await recordJobEvent(sql, {
      jobId: job.id,
      manifestId: job.manifestId,
      prospectId: job.prospectId,
      sessionId: session.sessionId,
      workerId,
      mode,
      status: eventStatus,
      reasonCode,
      idempotencyKey: job.idempotencyKey,
      expectedHandle: job.expectedHandle,
      observedHandle,
      sessionState,
      gates,
      durationMs,
      detail,
      // Un DRY-RUN ne peut rien tenter, et le dit à la base plutôt que de la
      // laisser le supposer. La contrainte `ig_job_event_dry_run_has_no_effect`
      // (0029/0039) refuserait la ligne si ce booléen mentait.
      externalEffectAttempted: false,
      canaryAuthorizationId: null,
      skipReason,
      nextEligibleAt: nextAttempt,
    });

    return {
      jobId: job.id,
      manifestId: job.manifestId,
      prospectId: job.prospectId,
      expectedHandle: job.expectedHandle,
      observedHandle,
      idempotencyKey: job.idempotencyKey,
      status: eventStatus,
      jobStatus,
      reasonCode,
      detail,
      sessionState,
      gates: Object.freeze([...gates]),
      eventId,
      durationMs,
      skipReason,
      skipClass,
      nextAttemptAt: nextAttempt?.toISOString() ?? null,
      preview,
      liveReady,
      missingForLive,
      liveProjection,
      screenshotPath,
      hardStop: options.hardStop === true,
    };
  };

  // ---- 1. Mode ------------------------------------------------------------
  // Refusé d'emblée, avant toute lecture : LIVE n'est pas un mode dégradé de ce
  // worker. Un envoi réel a son propre chemin (`liveWorker.ts`), sa propre
  // autorisation nominative et son propre rail ; router un LIVE par ici ferait
  // d'un chemin de vérification un chemin d'envoi.
  if (mode !== 'DRY_RUN') {
    gates.push({ gate: 'mode', verdict: 'BLOCK', detail: `mode « ${mode} »` });
    return finish(
      'BLOCKED',
      'IG_LIVE_NOT_ON_THIS_PATH',
      'ce worker ne fait que des DRY_RUN — un envoi réel passe par le canari mono-manifeste, jamais par ici',
      { skipReason: 'rail_failure', hardStop: true },
    );
  }
  gates.push({ gate: 'mode', verdict: 'PASS', detail: 'DRY_RUN' });

  // IG2 — la garde structurelle, posée sur l'objet réellement reçu et non sur
  // une constante globale du dépôt. La question utile n'a jamais été
  // « quelqu'un a-t-il écrit du code d'envoi quelque part ? » mais « MOI,
  // ai-je de quoi envoyer ? » — et la seconde reste vérifiable après le diff
  // qui répond « oui » à la première.
  if (hasSendPrimitive(deps.rail)) {
    gates.push({ gate: 'no_send_primitive', verdict: 'BLOCK', detail: `le rail expose ${LIVE_SEND_PRIMITIVE}` });
    return finish(
      'BLOCKED',
      'IG_LIVE_RAIL_ON_DRY_RUN_PATH',
      `le rail fourni expose ${LIVE_SEND_PRIMITIVE} — un worker DRY-RUN refuse de tenir un objet capable d’agir`,
      { skipReason: 'rail_failure', hardStop: true },
    );
  }
  gates.push({ gate: 'no_send_primitive', verdict: 'PASS', detail: 'rail en lecture seule' });

  // ---- 2. Les gardes qui bornent le TRAVAIL, opposables ici ---------------
  const safetySnapshot = await loadSafetySnapshot(sql, config);
  const workload = evaluateWorkloadCaps(safetySnapshot, config);
  gates.push(...workload.gates);
  if (!workload.allowed) {
    return finish('BLOCKED', workload.code, workload.reason, {
      skipReason: workload.code === 'IG_CAP_SESSION_FAILURES' ? 'session_failures' : 'consecutive_failures',
    });
  }

  // ---- 3. L'ordonnancement : maintenant, ou quand ? -----------------------
  //
  // `killSwitch: 'project'` — l'arrêt global est évalué, journalisé comme un
  // refus, et l'aperçu continue. Voir l'en-tête de ce fichier : c'est légitime
  // ici et nulle part ailleurs, parce que ce chemin ne peut produire aucun
  // effet. La fenêtre, les plafonds et la cadence, eux, sont OPPOSÉS — un
  // dry-run qui les ignorerait ne répéterait plus rien.
  const scheduleSnapshot = await loadScheduleSnapshot(sql, config);
  const schedule: ScheduleDecision = evaluateSchedule({
    now: now(),
    snapshot: scheduleSnapshot,
    config,
    killSwitch: 'project',
  });
  gates.push(...schedule.gates);

  liveProjection = Object.freeze({
    wouldProceed: schedule.allowed && !safetySnapshot.killSwitch.engaged,
    blockedBy: schedule.allowed ? (safetySnapshot.killSwitch.engaged ? 'kill_switch' : null) : schedule.reason,
    detail: schedule.allowed
      ? safetySnapshot.killSwitch.engaged
        ? 'arrêt global armé — un LIVE serait refusé ici même si le calendrier le permettait'
        : 'aucune contrainte de temps ne s’y opposerait'
      : schedule.detail,
    nextEligibleAt: schedule.allowed ? null : (schedule.nextEligibleAt?.toISOString() ?? null),
  });

  if (!schedule.allowed) {
    scheduleNextEligible = schedule.nextEligibleAt;
    return finish('SKIPPED', 'IG_SCHEDULE_DEFERRED', schedule.detail, { skipReason: schedule.reason });
  }

  // ---- 4. L'intention approuvée, revalidée intégralement ------------------
  let envelope;
  try {
    ({ envelope } = await resolveDispatchTarget(sql, job.manifestId, 'DRY_RUN'));
  } catch (error) {
    if (error instanceof DispatchBlockedError) {
      gates.push({ gate: 'manifest', verdict: 'BLOCK', detail: error.code });
      return finish('BLOCKED', error.code, error.message, {
        skipReason: R6B_TERMINAL_SKIP_REASON[error.code] ?? 'manifest_drift',
      });
    }
    throw error;
  }
  gates.push({ gate: 'manifest', verdict: 'PASS', detail: `manifeste ${envelope.manifestId} LOCKED et courant` });

  if (envelope.transport !== 'instagram_dm') {
    gates.push({ gate: 'transport', verdict: 'BLOCK', detail: envelope.transport });
    return finish(
      'BLOCKED',
      'IG_TRANSPORT_NOT_INSTAGRAM',
      `manifeste ${envelope.manifestId} : transport « ${envelope.transport} » — ce rail n'exécute que des instagram_dm`,
      { skipReason: 'payload_unavailable' },
    );
  }
  gates.push({ gate: 'transport', verdict: 'PASS', detail: 'instagram_dm' });

  const drift = detectJobManifestDrift(job, envelope);
  if (drift !== null) {
    gates.push({ gate: 'job_manifest_drift', verdict: 'BLOCK', detail: drift });
    return finish(
      'BLOCKED',
      'IG_JOB_MANIFEST_DRIFT',
      `le manifeste a changé depuis l'enfilement du job (${drift}) — une cible qui bouge n'est pas une cible validée`,
      { skipReason: 'manifest_drift' },
    );
  }
  gates.push({ gate: 'job_manifest_drift', verdict: 'PASS', detail: 'handle et empreintes inchangés' });

  // ---- 5. Session --------------------------------------------------------
  let status: InstagramSessionStatus;
  try {
    status = await session.ensure();
  } catch (error) {
    if (error instanceof InstagramRailError) {
      gates.push({ gate: 'session', verdict: 'BLOCK', detail: error.code });
      // Le profil tenu par l'autre runtime n'est ni une panne, ni un arrêt dur.
      // Sans `skipReason`, le job reste réclamable tel quel et repartira au
      // tour suivant : il n'y a rien à replanifier, puisque rien n'a été tenté.
      // Un `hardStop` ici aurait arrêté toute l'exécution sur une contention
      // que la boucle suivante résout d'elle-même.
      if (error.code === 'IG_BROWSER_PROFILE_BUSY') {
        return finish('BLOCKED', error.code, error.message);
      }
      return finish('FAILED', error.code, error.message, { skipReason: 'rail_failure', hardStop: true });
    }
    throw error;
  }
  sessionState = status.state;

  if (!isUsableSessionState(status.state)) {
    const code = SESSION_STATE_BLOCK_CODE[status.state];
    gates.push({ gate: 'session', verdict: 'BLOCK', detail: status.state });
    return finish('BLOCKED', code, `session ${status.state} : ${status.detail}`, {
      skipReason: SESSION_STATE_SKIP_REASON[status.state],
      hardStop: isHardStopSessionState(status.state),
    });
  }
  gates.push({ gate: 'session', verdict: 'PASS', detail: 'SESSION_READY' });

  // ---- 6. Profil exact et identité ---------------------------------------
  let observation;
  try {
    observation = await deps.rail.openProfile(job.expectedHandle);
  } catch (error) {
    if (error instanceof InstagramRailError) {
      gates.push({ gate: 'profile', verdict: 'BLOCK', detail: error.code });
      if (error.code === 'IG_BROWSER_PROFILE_BUSY') {
        return finish('BLOCKED', error.code, error.message);
      }
      return finish('FAILED', error.code, error.message, { skipReason: 'target_unreachable' });
    }
    throw error;
  }
  screenshotPath = observation.screenshotPath;

  // L'état de session peut se dégrader SUR la page de profil : un mur de
  // connexion ou un challenge n'apparaît parfois qu'ici. Relu, jamais hérité.
  sessionState = observation.sessionState;
  if (!isUsableSessionState(observation.sessionState)) {
    const code = SESSION_STATE_BLOCK_CODE[observation.sessionState];
    gates.push({ gate: 'session_on_profile', verdict: 'BLOCK', detail: observation.sessionState });
    return finish('BLOCKED', code, `la page de profil a rendu un état ${observation.sessionState}`, {
      skipReason: SESSION_STATE_SKIP_REASON[observation.sessionState],
      hardStop: isHardStopSessionState(observation.sessionState),
    });
  }
  gates.push({ gate: 'session_on_profile', verdict: 'PASS', detail: 'SESSION_READY' });

  const identity = decideIdentity({
    expectedHandle: job.expectedHandle,
    signals: observation.signals,
    profileMissing: observation.profileMissing,
    redirected: observation.redirected,
  });
  observedHandle = identity.observedHandle;

  await recordIdentityCheck(sql, {
    jobId: job.id,
    manifestId: job.manifestId,
    prospectId: job.prospectId,
    sessionId: session.sessionId,
    expectedHandle: job.expectedHandle,
    observedHandle: identity.observedHandle,
    observedUrl: observation.finalUrl,
    redirected: observation.redirected,
    verdict: identity.verdict,
    signals: observation.signals,
    detail: identity.detail,
  });

  if (identity.verdict !== 'MATCH') {
    gates.push({ gate: 'identity', verdict: 'BLOCK', detail: identity.verdict });
    return finish('BLOCKED', IDENTITY_VERDICT_BLOCK_CODE[identity.verdict], identity.detail, {
      skipReason: IDENTITY_VERDICT_SKIP_REASON[identity.verdict],
    });
  }
  gates.push({ gate: 'identity', verdict: 'PASS', detail: identity.detail });

  // ---- 7. Le message qui partirait ---------------------------------------
  // Calculé par l'adapter qui servirait à un envoi, pas par une reconstruction
  // parallèle : ce que le DRY-RUN montre est exactement ce qu'un futur canari
  // recevrait en entrée.
  preview = DRY_RUN_ADAPTERS.instagram_dm.dryRun(envelope);
  const readiness = getLiveReadiness(envelope);
  liveReady = readiness.ready;
  missingForLive = readiness.missing;

  // Le dry-run rejoint le journal R6B, au même titre qu'un dry-run email : les
  // deux transports partagent une seule table d'audit de dispatch.
  await insertDispatchAttempt(sql, {
    requestedManifestId: job.manifestId,
    manifestId: envelope.manifestId,
    mode: 'DRY_RUN',
    transport: envelope.transport,
    recipient: envelope.recipient,
    approvedTextSha256: envelope.approvedTextSha256,
    transportPayloadSha256: envelope.transportPayloadSha256,
    liveReady: readiness.ready,
    missingForLive: readiness.missing,
    status: 'DRY_RUN_OK',
    errorCode: null,
    networkAttempted: false,
    sent: false,
    provider: null,
    providerMessageId: null,
    liveAttemptId: null,
  });

  return finish(
    'DRY_RUN_COMPLETED',
    'IG_DRY_RUN_OK',
    `identité confirmée sur ${observation.finalUrl} — message calculé, rien envoyé`,
  );
}

/**
 * Exécute la file en DRY-RUN.
 *
 * Séquentiel par construction : un job à la fois, dans une seule session
 * navigateur. L'architecture reste multi-worker — la prise est atomique et
 * chaque worker porte son identité — mais une exécution n'ouvre qu'un
 * navigateur.
 *
 * L'exécution s'arrête net sur un arrêt dur (challenge, CAPTCHA, blocage,
 * navigateur mort) : insister devant un message qu'Instagram adresse à un
 * humain serait exactement ce que la mission interdit.
 */
export async function runInstagramDryRun(input: RunInput, deps: WorkerDeps): Promise<RunResult> {
  const { sql, config, workerId, mode } = input;
  const log = logger.child({ rail: 'instagram', workerId, mode });

  // Avant toute prise : les baux abandonnés. Un job dont le worker est mort
  // sans effet externe retourne dans la file ; avec effet externe, il part en
  // REVIEW_REQUIRED et n'est plus jamais repris automatiquement.
  const recovered = await recoverExpiredLeases(sql);
  const reviewRequired = recovered.filter((row) => row.status === 'REVIEW_REQUIRED').length;
  if (recovered.length > 0) {
    log.warn('instagram.lease.recovered', { recovered: recovered.length, reviewRequired });
  }
  // IG3 §10 — une reprise ambiguë devient un événement durable. Sans lui, le
  // seul témoin d'un job renvoyé à un humain serait son statut, c'est-à-dire un
  // état sans date ni auteur.
  for (const lease of recovered.filter((row) => row.status === 'REVIEW_REQUIRED')) {
    await recordJobEvent(sql, {
      jobId: lease.id,
      manifestId: lease.manifestId,
      prospectId: lease.prospectId,
      sessionId: null,
      workerId,
      mode: 'DRY_RUN',
      status: 'REVIEW_REQUIRED',
      reasonCode: 'IG_LEASE_EXPIRED_AFTER_EFFECT',
      idempotencyKey: lease.idempotencyKey,
      expectedHandle: lease.expectedHandle,
      observedHandle: null,
      sessionState: null,
      gates: [],
      durationMs: null,
      detail: 'bail expiré après une tentative d’effet externe — issue inconnue, tranchage humain requis',
      externalEffectAttempted: false,
      canaryAuthorizationId: null,
      skipReason: 'review_required',
      nextEligibleAt: null,
    });
  }

  const session = new SessionHolder(sql, deps.rail, workerId);
  const outcomes: JobOutcome[] = [];
  const seen: string[] = [];
  let stoppedEarly: string | null = null;
  let drainTruncated = false;
  const maxJobs = input.maxJobs ?? (input.drain === true ? DRAIN_CEILING : config.queue.maxJobsPerRun);

  try {
    for (let processed = 0; processed < maxJobs; processed += 1) {
      const job = await claimNextInstagramJob(sql, {
        workerId,
        leaseMs: config.queue.leaseMs,
        excludeJobIds: seen,
        ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
      });
      if (!job) break;
      if (job.claimToken === null) {
        // Impossible : la contrainte `ig_job_claim_lease_coherent` l'interdit.
        // Refuser bruyamment plutôt que continuer sans pouvoir clore le bail.
        throw new Error(`job ${job.id} pris sans jeton de bail — état incohérent`);
      }

      seen.push(job.id);

      // IG3 §10 — la prise devient un fait daté. Un `CLAIMED` sans conclusion
      // est la signature exacte d'un worker mort en cours de route, et c'est la
      // seule trace qui survive à un processus tué.
      await recordJobEvent(sql, {
        jobId: job.id,
        manifestId: job.manifestId,
        prospectId: job.prospectId,
        sessionId: session.sessionId,
        workerId,
        mode,
        status: 'CLAIMED',
        reasonCode: 'IG_DRY_RUN_OK',
        idempotencyKey: job.idempotencyKey,
        expectedHandle: job.expectedHandle,
        observedHandle: null,
        sessionState: session.sessionState,
        gates: [],
        durationMs: null,
        detail: `bail pris jusqu’à ${job.leaseExpiresAt ?? 'inconnu'} (tentative n°${String(job.attempts)})`,
        externalEffectAttempted: false,
        canaryAuthorizationId: null,
        skipReason: null,
        nextEligibleAt: null,
      });
      await recordJobEvent(sql, {
        jobId: job.id,
        manifestId: job.manifestId,
        prospectId: job.prospectId,
        sessionId: session.sessionId,
        workerId,
        mode,
        status: 'DRY_RUN_STARTED',
        reasonCode: 'IG_DRY_RUN_OK',
        idempotencyKey: job.idempotencyKey,
        expectedHandle: job.expectedHandle,
        observedHandle: null,
        sessionState: session.sessionState,
        gates: [],
        durationMs: null,
        detail: 'début du traitement — aucune primitive d’envoi disponible sur ce chemin',
        externalEffectAttempted: false,
        canaryAuthorizationId: null,
        skipReason: null,
        nextEligibleAt: null,
      });

      const outcome = await processClaimedJob(input, deps, session, job);
      outcomes.push(outcome);

      // IG3 §1 — l'intervalle de cadence n'est PAS facturé ici, et ce worker ne
      // peut pas le facturer : il ne produit aucun effet externe. Ce qui décide
      // de `not_before` est le motif de report, et lui seul.
      const released = await finalizeInstagramJob(sql, {
        jobId: job.id,
        claimToken: job.claimToken,
        status: outcome.jobStatus,
        reasonCode: outcome.reasonCode,
        detail: outcome.detail.slice(0, 1000),
        notBeforeMs: 0,
        ...(outcome.nextAttemptAt === null ? {} : { notBefore: new Date(outcome.nextAttemptAt) }),
        skipReason: outcome.skipReason,
        ...(outcome.liveProjection?.nextEligibleAt == null
          ? {}
          : { plannedFor: new Date(outcome.liveProjection.nextEligibleAt) }),
        markDryRun: outcome.status === 'DRY_RUN_COMPLETED',
      });
      if (!released) {
        log.warn('instagram.job.lease_lost', { jobId: job.id });
      }

      log.info('instagram.job.done', {
        jobId: job.id,
        manifestId: job.manifestId,
        expectedHandle: job.expectedHandle,
        observedHandle: outcome.observedHandle,
        status: outcome.status,
        jobStatus: outcome.jobStatus,
        reasonCode: outcome.reasonCode,
        skipReason: outcome.skipReason,
        nextAttemptAt: outcome.nextAttemptAt,
        sessionState: outcome.sessionState,
        idempotencyKey: outcome.idempotencyKey,
        durationMs: outcome.durationMs,
        externalEffectAttempted: false,
      });

      if (outcome.hardStop) {
        stoppedEarly = outcome.reasonCode;
        log.error('instagram.run.hard_stop', { reasonCode: outcome.reasonCode, detail: outcome.detail });
        break;
      }
      if (input.jobId !== undefined) break;
    }
    // Le plafond a-t-il mordu ? La boucle sort soit sur une file vide (le
    // `break` ci-dessus), soit sur `processed === maxJobs`. Dans le second cas
    // on ne SAIT PAS s'il restait du travail — et une file partiellement
    // traitée qui ressemblerait à une file vide est exactement la troncature
    // silencieuse qu'il ne faut pas laisser passer.
    drainTruncated = input.drain === true && outcomes.length >= maxJobs;
    if (drainTruncated) log.warn('instagram.run.drain_truncated', { maxJobs, processed: outcomes.length });
  } finally {
    await session.close();
    await deps.rail.close().catch(() => undefined);
  }

  return {
    workerId,
    mode,
    recoveredLeases: recovered.length,
    reviewRequired,
    outcomes,
    sessionId: session.sessionId,
    sessionState: session.sessionState,
    stoppedEarly,
    drainTruncated,
    externalEffects: 0,
  };
}
