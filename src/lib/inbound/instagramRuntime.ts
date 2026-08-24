import { setTimeout as delay } from 'node:timers/promises';
import type { Sql } from '@/lib/db/sql';
import type { InstagramRailConfig } from '@/lib/config/schema';
import { logger as rootLogger, type Logger } from '@/lib/logging/logger';
import { collectInstagramInbound, type CollectReport } from '@/lib/inbound/instagramCollector';
import { InstagramInboundError } from '@/lib/inbound/instagramIntake';
import type { CodeRevisionSentinel } from '@/lib/inbound/codeRevision';
import { forbiddenMethodsOn, type InstagramInboundRail } from '@/lib/instagram/inboundRail';
import { hasSendPrimitive, InstagramRailError } from '@/lib/instagram/rail';
import {
  acquireInstagramBrowserLease,
  InstagramBrowserProfileBusyError,
  type InstagramBrowserLease,
} from '@/lib/instagram/browserProfileLease';
import { HARD_STOP_SESSION_STATES, type InstagramSessionState } from '@/lib/instagram/types';

/**
 * IG5.2A — le RUNTIME de la relève entrante : quand relever, qui relève, et
 * que faire de ce qui a été lu.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module n'est pas
 * ---------------------------------------------------------------------------
 *
 * Ce n'est pas un second framework de workers. Le dépôt en a déjà un pour le
 * SORTANT (`ig_dispatch_jobs`, `instagram/scheduler`, `instagram/worker`) et il
 * est délibérément ignoré ici — il répond à une autre question. Ce module
 * n'introduit ni file, ni bus, ni table de jobs : la primitive de propriété
 * existe déjà (`ig_inbound_polls`, IG5.1, verrou par index partiel + bail), et
 * la reprise de l'aval existe déjà (`loadUnprocessedCorrelatedInbound`, qui
 * définit le retard comme « une réponse corrélée sans analyse vivante »).
 *
 * Ce module n'ajoute donc AUCUNE migration. C'est un choix, pas un oubli :
 * tout ce que §10 demande d'afficher — dernier tour, dernier tour réussi,
 * dernière panne, détenteur du bail, échéance, retard — se dérive de
 * `ig_inbound_polls` et de `r6b_inbound_messages`. Une table de « ticks »
 * aurait été une quatrième source de vérité sur un état que ces deux-là
 * disent déjà, et aurait ajouté une migration à appliquer après le canari
 * alors que le plan n'en prévoit qu'une (0042).
 *
 * ---------------------------------------------------------------------------
 * 24/7, et rien ne peut le brancher sur la fenêtre sortante
 * ---------------------------------------------------------------------------
 *
 * Ce fichier n'importe ni `@/lib/instagram/scheduler`, ni `evaluateSchedule`,
 * ni `nextWindowOpening`, ni `evaluateEffectCaps`, ni `ig_kill_switch`. Ce
 * n'est pas une consigne de revue : il n'y a rien à débrancher, et un test
 * lit le SOURCE de ce fichier pour le vérifier.
 *
 * La raison tient en une phrase : la fenêtre « lun–ven 09:00–20:00 » existe
 * parce qu'un premier message commercial reçu à 3 h du matin est un mauvais
 * premier message. Rien de cela ne s'applique à LIRE. Un prospect qui répond
 * samedi à 03:00 doit être détecté samedi à 03:00 — attendre lundi 09:00 pour
 * le SAVOIR ne protège personne, cela ne fait que retarder la réponse d'un
 * humain. Le kill-switch obéit à la même distinction : il arrête les EFFETS
 * SORTANTS, et la lecture n'en est pas un.
 *
 * ---------------------------------------------------------------------------
 * L'invariant qui a déjà coûté cher
 * ---------------------------------------------------------------------------
 *
 * « Je n'ai pas su lire » n'est jamais « il n'y avait rien ». Une boîte
 * illisible, une session expirée, un défi de sécurité : aucun de ces trois
 * états ne produit un tour réussi à zéro message. Ils produisent des issues
 * NOMMÉES, qui changent la cadence et qui remontent dans le statut. C'est la
 * leçon du faux `DELIVERY_FAILED` du 14 août (IG2.4), appliquée à l'entrant.
 */

// ---------------------------------------------------------------------------
// 1. La configuration du runtime
// ---------------------------------------------------------------------------

/**
 * Les valeurs qui pilotent la cadence, une fois la configuration et
 * l'environnement fusionnés.
 *
 * Séparée de `InstagramRailConfig` pour une raison précise : elle est
 * SÉRIALISABLE et se passe telle quelle à `decideInboundTick`, qui est pure.
 * Aucun test de cadence n'a donc besoin de lire `config/instagram.json`.
 */
export interface InboundRuntimeConfig {
  /** Désarmé par défaut. Aucune activation réelle n'a lieu en IG5.2A. */
  readonly enabled: boolean;
  /** Le compte qui relève — le NÔTRE, tel qu'il s'appelle AUJOURD'HUI. `null` interdit de démarrer. */
  readonly accountHandle: string | null;
  /**
   * HERMES-IDENTITY-CANONICALIZATION-R1 §6 — les noms précédents du MÊME
   * compte. Ils ne servent qu'à ne pas réingérer ce qui a déjà été lu sous
   * l'un d'eux ; aucune ligne n'est jamais écrite sous un ancien nom.
   *
   * Pas de surcharge par environnement, contrairement à `accountHandle` : une
   * fusion d'identités doit passer par un diff que quelqu'un signe, pas par une
   * variable qu'on exporte pour un tour.
   */
  readonly formerAccountHandles: readonly string[];
  /** Délai entre la FIN d'un tour réussi et le suivant. Jamais depuis son début. */
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  readonly maxThreadsPerPoll: number;
  /** Premier palier de recul après une panne transitoire. Doublé à chaque échec consécutif. */
  readonly retryBackoffMs: number;
  /** Plafond du recul exponentiel. Un rail en panne ne s'endort jamais plus que cela. */
  readonly maxBackoffMs: number;
  /**
   * Recul devant un état qui demande un HUMAIN (session à refaire, défi,
   * blocage). Ce n'est pas un contournement : c'est l'intervalle auquel on
   * revérifie si quelqu'un a réparé la session, et il est long exprès.
   */
  readonly awaitingHumanBackoffMs: number;
  /** Bornes de l'aval traité après chaque tour. */
  readonly downstreamLimit: number;
}

/** Les variables d'environnement que le runtime accepte. Aucune ne porte de secret. */
export const INBOUND_RUNTIME_ENV_KEYS = Object.freeze({
  enabled: 'OUTBOUND_IG_INBOUND_ENABLED',
  account: 'OUTBOUND_IG_INBOUND_ACCOUNT',
  intervalMs: 'OUTBOUND_IG_INBOUND_INTERVAL_MS',
} as const);

export class InboundRuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboundRuntimeConfigError';
  }
}

function parsePositiveInt(raw: string, key: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InboundRuntimeConfigError(`${key} attend un entier entre ${min} et ${max} — reçu « ${raw} »`);
  }
  return value;
}

/**
 * Fusionne `config/instagram.json` et l'environnement, dans cet ordre.
 *
 * `env` est un PARAMÈTRE et non `process.env` lu en cachette : c'est ce qui
 * rend la précédence testable sans muter l'environnement du processus de test.
 *
 * Un booléen d'environnement n'accepte que `0`/`1`/`true`/`false`. Une valeur
 * qu'on ne comprend pas est une erreur, jamais un repli sur « désactivé » —
 * croire que le runtime est arrêté alors qu'il tourne, ou l'inverse, est
 * exactement ce qu'un défaut silencieux produirait.
 */
export function resolveInboundRuntimeConfig(
  config: InstagramRailConfig,
  env: Readonly<Record<string, string | undefined>> = {},
): InboundRuntimeConfig {
  const inbound = config.inbound;

  let enabled = inbound.enabled;
  const rawEnabled = env[INBOUND_RUNTIME_ENV_KEYS.enabled];
  if (rawEnabled !== undefined && rawEnabled.trim().length > 0) {
    const normalized = rawEnabled.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true') enabled = true;
    else if (normalized === '0' || normalized === 'false') enabled = false;
    else {
      throw new InboundRuntimeConfigError(
        `${INBOUND_RUNTIME_ENV_KEYS.enabled} attend 0/1/true/false — reçu « ${rawEnabled} »`,
      );
    }
  }

  let accountHandle = inbound.accountHandle;
  const rawAccount = env[INBOUND_RUNTIME_ENV_KEYS.account];
  if (rawAccount !== undefined && rawAccount.trim().length > 0) {
    const candidate = rawAccount.trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9._]{1,30}$/.test(candidate)) {
      throw new InboundRuntimeConfigError(
        `${INBOUND_RUNTIME_ENV_KEYS.account} attend un handle Instagram — reçu « ${rawAccount} »`,
      );
    }
    accountHandle = candidate;
  }

  let pollIntervalMs = inbound.pollIntervalMs;
  const rawInterval = env[INBOUND_RUNTIME_ENV_KEYS.intervalMs];
  if (rawInterval !== undefined && rawInterval.trim().length > 0) {
    pollIntervalMs = parsePositiveInt(rawInterval.trim(), INBOUND_RUNTIME_ENV_KEYS.intervalMs, 60_000, 3_600_000);
  }

  return Object.freeze({
    enabled,
    accountHandle,
    formerAccountHandles: Object.freeze([...inbound.formerAccountHandles]),
    pollIntervalMs,
    leaseMs: inbound.leaseMs,
    maxThreadsPerPoll: inbound.maxThreadsPerPoll,
    retryBackoffMs: inbound.retryBackoffMs,
    maxBackoffMs: Math.max(inbound.maxBackoffMs, inbound.retryBackoffMs),
    awaitingHumanBackoffMs: inbound.awaitingHumanBackoffMs,
    downstreamLimit: inbound.downstreamLimit,
  });
}

// ---------------------------------------------------------------------------
// 2. L'état durable, tel qu'il est LU
// ---------------------------------------------------------------------------

export interface RunningPoll {
  readonly pollId: string;
  readonly polledBy: string;
  readonly startedAt: Date;
  readonly leaseExpiresAt: Date;
}

export interface TerminalPoll {
  readonly pollId: string;
  readonly status: 'COMPLETED' | 'FAILED';
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly sessionState: InstagramSessionState | null;
  readonly inboxReadability: 'INBOX_READABLE' | 'INBOX_UNREADABLE' | null;
  readonly messagesIngested: number;
  readonly detail: string | null;
}

/** Ce que le runtime a besoin de savoir pour décider, et rien de plus. */
export interface InboundRuntimeState {
  readonly accountHandle: string;
  /** Le tour en cours, s'il en existe un. Au plus un, garanti par l'index partiel unique. */
  readonly running: RunningPoll | null;
  /** Le dernier tour terminé, réussi ou non. */
  readonly lastTerminal: TerminalPoll | null;
  /** Le dernier tour RÉUSSI. Distinct du précédent, et c'est tout l'intérêt. */
  readonly lastSuccessful: TerminalPoll | null;
  /** Tours non réussis consécutifs, en partant du plus récent. Pilote le recul exponentiel. */
  readonly consecutiveFailures: number;
}

/**
 * Un tour a-t-il RÉUSSI ?
 *
 * `COMPLETED` ne suffit pas. Le collecteur clôt en `COMPLETED` un tour où la
 * session a rendu `LOGIN_REQUIRED` ou dont la boîte n'a pas été comprise — il
 * a fait son travail, qui est de consigner ce qu'il a vu. Le runtime, lui, doit
 * traiter ces deux cas comme des échecs de CADENCE : les relancer à la même
 * fréquence qu'un succès reviendrait à marteler une boîte qu'on ne sait pas
 * lire.
 *
 * D'où la définition, en deux termes et pas un : terminé SANS erreur, ET boîte
 * effectivement lisible.
 */
export function isSuccessfulPoll(poll: TerminalPoll): boolean {
  return poll.status === 'COMPLETED' && poll.inboxReadability === 'INBOX_READABLE';
}

/** Combien de tours d'affilée le rail n'a-t-il pas su relever ? Le plus récent d'abord. */
export function countConsecutiveFailures(terminals: readonly TerminalPoll[]): number {
  let count = 0;
  for (const poll of terminals) {
    if (isSuccessfulPoll(poll)) break;
    count += 1;
  }
  return count;
}

/** Combien de tours terminés on relit pour compter les échecs. Le recul plafonne bien avant. */
const TERMINAL_HISTORY_DEPTH = 25;

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

interface PollRow {
  id: string;
  status: string;
  polledBy: string;
  startedAt: string | Date;
  finishedAt: string | Date | null;
  leaseExpiresAt: string | Date;
  sessionState: string | null;
  inboxReadability: string | null;
  messagesIngested: number;
  detail: string | null;
}

const POLL_COLUMNS = `id, status, polled_by as "polledBy",
        started_at as "startedAt", finished_at as "finishedAt",
        lease_expires_at as "leaseExpiresAt",
        session_state as "sessionState", inbox_readability as "inboxReadability",
        messages_ingested as "messagesIngested", detail`;

function toTerminal(row: PollRow): TerminalPoll {
  return Object.freeze({
    pollId: row.id,
    status: row.status === 'FAILED' ? ('FAILED' as const) : ('COMPLETED' as const),
    startedAt: toDate(row.startedAt),
    finishedAt: toDate(row.finishedAt ?? row.startedAt),
    sessionState: (row.sessionState as InstagramSessionState | null) ?? null,
    inboxReadability: (row.inboxReadability as 'INBOX_READABLE' | 'INBOX_UNREADABLE' | null) ?? null,
    messagesIngested: Number(row.messagesIngested),
    detail: row.detail,
  });
}

/**
 * Lit l'état du rail pour un compte. Trois requêtes, aucune écriture.
 *
 * Le tour `RUNNING` est lu SANS filtrer sur l'échéance du bail : un bail expiré
 * reste un fait à afficher (« ce processus est mort »), et c'est
 * `decideInboundTick` — pas cette lecture — qui décide s'il fait obstacle.
 * Mélanger les deux ferait disparaître du statut la seule trace d'un collecteur
 * tué.
 */
export async function loadInboundRuntimeState(sql: Sql, accountHandle: string): Promise<InboundRuntimeState> {
  const runningRows = await sql.query<PollRow>(
    `select ${POLL_COLUMNS} from ig_inbound_polls
      where account_handle = $1 and status = 'RUNNING'
      order by started_at desc limit 1`,
    [accountHandle],
  );
  const terminalRows = await sql.query<PollRow>(
    `select ${POLL_COLUMNS} from ig_inbound_polls
      where account_handle = $1 and status in ('COMPLETED', 'FAILED')
      order by finished_at desc limit $2`,
    [accountHandle, TERMINAL_HISTORY_DEPTH],
  );
  const successRows = await sql.query<PollRow>(
    `select ${POLL_COLUMNS} from ig_inbound_polls
      where account_handle = $1 and status = 'COMPLETED' and inbox_readability = 'INBOX_READABLE'
      order by finished_at desc limit 1`,
    [accountHandle],
  );

  const runningRow = runningRows[0];
  const terminals = terminalRows.map(toTerminal);
  const successRow = successRows[0];

  return Object.freeze({
    accountHandle,
    running:
      runningRow === undefined
        ? null
        : Object.freeze({
            pollId: runningRow.id,
            polledBy: runningRow.polledBy,
            startedAt: toDate(runningRow.startedAt),
            leaseExpiresAt: toDate(runningRow.leaseExpiresAt),
          }),
    lastTerminal: terminals[0] ?? null,
    lastSuccessful: successRow === undefined ? null : toTerminal(successRow),
    consecutiveFailures: countConsecutiveFailures(terminals),
  });
}

// ---------------------------------------------------------------------------
// 3. La cadence — une fonction pure, sans horloge implicite
// ---------------------------------------------------------------------------

/**
 * La classe de cadence d'un tour terminé.
 *
 * Trois valeurs, et elles se DÉDUISENT de la ligne en base — pas d'un état que
 * le runtime aurait mémorisé. C'est ce qui garantit qu'un runtime redémarré
 * reprend exactement la cadence qu'un runtime jamais tué aurait tenue.
 */
export type PollCadenceClass = 'HEALTHY' | 'TRANSIENT_FAILURE' | 'AWAITING_HUMAN';

/** Les états de session devant lesquels seul un humain peut débloquer la situation. */
export const HUMAN_INTERVENTION_SESSION_STATES: readonly InstagramSessionState[] = Object.freeze([
  'LOGIN_REQUIRED',
  'SESSION_EXPIRED',
  ...HARD_STOP_SESSION_STATES,
]);

export function cadenceClassOf(poll: TerminalPoll): PollCadenceClass {
  if (isSuccessfulPoll(poll)) return 'HEALTHY';
  if (poll.sessionState !== null && HUMAN_INTERVENTION_SESSION_STATES.includes(poll.sessionState)) {
    return 'AWAITING_HUMAN';
  }
  return 'TRANSIENT_FAILURE';
}

/**
 * Le délai avant la prochaine tentative, à partir de la FIN du dernier tour.
 *
 * Depuis la fin, jamais depuis le début : un tour qui dure quatre minutes
 * suivi d'un intervalle compté depuis son début rouvrirait un navigateur une
 * minute après en avoir fermé un. Ce n'est pas un « polling agressif » par
 * configuration, c'en est un par arithmétique.
 *
 * Le recul transitoire double à chaque échec consécutif et plafonne. Il n'y a
 * pas d'aléa : deux collecteurs dans le même état attendent la même chose, et
 * un test peut donc affirmer une date.
 */
export function nextAttemptDelayMs(
  cadence: PollCadenceClass,
  consecutiveFailures: number,
  config: InboundRuntimeConfig,
): number {
  if (cadence === 'HEALTHY') return config.pollIntervalMs;
  if (cadence === 'AWAITING_HUMAN') return config.awaitingHumanBackoffMs;
  const steps = Math.max(0, Math.min(consecutiveFailures - 1, 16));
  return Math.min(config.retryBackoffMs * 2 ** steps, config.maxBackoffMs);
}

export type InboundTickVerdict =
  | 'POLL'
  | 'RUNTIME_DISABLED'
  | 'NO_ACCOUNT'
  | 'NOT_DUE'
  | 'POLL_ALREADY_RUNNING'
  | 'BACKOFF'
  | 'AWAITING_HUMAN';

export interface InboundTickDecision {
  readonly verdict: InboundTickVerdict;
  /** Quand la prochaine tentative sera permise. `null` quand aucune ne le sera sans un humain. */
  readonly nextAttemptAt: Date | null;
  /** Combien de millisecondes attendre. `0` quand le tour est dû. */
  readonly waitMs: number;
  readonly reason: string;
  /** Un humain doit intervenir — l'attente seule ne débloquera rien. */
  readonly needsHuman: boolean;
}

export interface DecideInput {
  readonly state: InboundRuntimeState;
  readonly config: InboundRuntimeConfig;
  readonly now: Date;
}

/**
 * « À cet instant, faut-il relever ? »
 *
 * Aucun `Date.now()`, aucune fenêtre horaire, aucun jour de la semaine, aucun
 * fuseau. Les seules entrées sont un état lu, une configuration et un instant
 * fourni — ce qui rend la propriété 24/7 démontrable plutôt qu'affirmée : les
 * tests passent lundi 10:00, lundi 23:30, samedi 03:00 et dimanche 18:00 le
 * même instant relatif, et obtiennent la même décision.
 */
export function decideInboundTick(input: DecideInput): InboundTickDecision {
  const { state, config, now } = input;

  if (!config.enabled) {
    return Object.freeze({
      verdict: 'RUNTIME_DISABLED' as const,
      nextAttemptAt: null,
      waitMs: 0,
      reason: 'le runtime entrant est désarmé (inbound.enabled = false) — aucune relève n’est tentée',
      needsHuman: false,
    });
  }
  if (config.accountHandle === null) {
    return Object.freeze({
      verdict: 'NO_ACCOUNT' as const,
      nextAttemptAt: null,
      waitMs: 0,
      reason: 'aucun compte à relever : renseigner inbound.accountHandle — aucun compte n’est deviné',
      needsHuman: true,
    });
  }

  // Un tour en cours dont le bail court encore appartient à quelqu'un d'autre.
  // On ne lui prend pas sa place et on ne fait pas un second balayage : on
  // attend son échéance, qui est la seule date à laquelle il pourra être repris.
  const running = state.running;
  if (running !== null && running.leaseExpiresAt.getTime() > now.getTime()) {
    return Object.freeze({
      verdict: 'POLL_ALREADY_RUNNING' as const,
      nextAttemptAt: running.leaseExpiresAt,
      waitMs: running.leaseExpiresAt.getTime() - now.getTime(),
      reason:
        `un tour est déjà en cours pour @${state.accountHandle} (${running.pollId}, tenu par ` +
        `« ${running.polledBy} ») — aucun second balayage n’est lancé`,
      needsHuman: false,
    });
  }

  const last = state.lastTerminal;
  if (last === null) {
    return Object.freeze({
      verdict: 'POLL' as const,
      nextAttemptAt: null,
      waitMs: 0,
      reason: 'aucune relève enregistrée pour ce compte — le premier tour est dû',
      needsHuman: false,
    });
  }

  const cadence = cadenceClassOf(last);
  const delayMs = nextAttemptDelayMs(cadence, state.consecutiveFailures, config);
  const nextAttemptAt = new Date(last.finishedAt.getTime() + delayMs);
  const waitMs = nextAttemptAt.getTime() - now.getTime();

  if (waitMs <= 0) {
    return Object.freeze({
      verdict: 'POLL' as const,
      nextAttemptAt: null,
      waitMs: 0,
      reason:
        cadence === 'HEALTHY'
          ? `le dernier tour réussi date de ${last.finishedAt.toISOString()} — le suivant est dû`
          : `le recul (${cadence}) est écoulé depuis ${nextAttemptAt.toISOString()} — nouvelle tentative`,
      needsHuman: false,
    });
  }

  if (cadence === 'AWAITING_HUMAN') {
    return Object.freeze({
      verdict: 'AWAITING_HUMAN' as const,
      nextAttemptAt,
      waitMs,
      reason:
        `le dernier tour a rendu ${last.sessionState ?? 'UNKNOWN'} — la session doit être refaite par un ` +
        'humain ; le runtime ne contourne rien et se contentera de revérifier',
      needsHuman: true,
    });
  }
  if (cadence === 'TRANSIENT_FAILURE') {
    return Object.freeze({
      verdict: 'BACKOFF' as const,
      nextAttemptAt,
      waitMs,
      reason: `${state.consecutiveFailures} tour(s) non réussi(s) d’affilée — recul de ${delayMs} ms`,
      needsHuman: false,
    });
  }
  return Object.freeze({
    verdict: 'NOT_DUE' as const,
    nextAttemptAt,
    waitMs,
    reason: `prochain tour à ${nextAttemptAt.toISOString()} (cadence ${config.pollIntervalMs} ms)`,
    needsHuman: false,
  });
}

// ---------------------------------------------------------------------------
// 4. La taxonomie des issues d'un tour
// ---------------------------------------------------------------------------

/**
 * Ce qu'un tour a rendu. Plus fine que la classe de cadence, exprès : deux
 * issues peuvent mériter la même cadence sans mériter le même message à
 * l'opérateur.
 *
 * Aucune ne signifie « zéro nouveau message » par défaut. `SUCCESS` le
 * signifie ; `INBOX_UNREADABLE`, `LOGIN_REQUIRED`, `SESSION_BLOCKED`,
 * `BROWSER_FAILURE` et `PARSE_FAILURE` disent explicitement le contraire —
 * on ne sait pas.
 */
export type InboundTickOutcome =
  /** Boîte lue, tout ce qui a été vu a été compris. */
  | 'SUCCESS'
  /** Boîte lue, mais une partie ne l'a pas été (fil illisible, récolte tronquée, bulle indécidable). */
  | 'PARTIAL_OBSERVATION'
  /** Boîte lue, et AUCUN des fils ouverts n'a pu être compris. */
  | 'PARSE_FAILURE'
  /** La liste de conversations n'a pas été comprise. Ce n'est pas une boîte vide. */
  | 'INBOX_UNREADABLE'
  /** La session n'est plus authentifiée. Un humain doit la refaire. */
  | 'LOGIN_REQUIRED'
  /** Défi, CAPTCHA ou blocage : arrêt franc, aucun contournement. */
  | 'SESSION_BLOCKED'
  /** Le navigateur ou le rail a levé. */
  | 'BROWSER_FAILURE'
  /** L'écriture des observations a échoué. */
  | 'PERSIST_FAILURE'
  /** Un autre collecteur détenait le tour. */
  | 'POLL_ALREADY_RUNNING'
  /**
   * Le profil navigateur était tenu par l'autre runtime Hermes (le worker
   * sortant). Frère jumeau de `POLL_ALREADY_RUNNING` : quelqu'un d'autre tient
   * la ressource, personne n'est en panne. Aucune ligne de relève n'est
   * ouverte, donc aucun échec n'est compté et le recul exponentiel ne bouge
   * pas — un tour perdu contre l'autre rail ne doit pas ralentir la relève.
   */
  | 'BROWSER_PROFILE_BUSY'
  /** Le tour n'a pas été tenté : le runtime est désarmé, pas dû, en recul, ou en attente d'un humain. */
  | 'SKIPPED';

export const INBOUND_TICK_OUTCOMES: readonly InboundTickOutcome[] = Object.freeze([
  'SUCCESS',
  'PARTIAL_OBSERVATION',
  'PARSE_FAILURE',
  'INBOX_UNREADABLE',
  'LOGIN_REQUIRED',
  'SESSION_BLOCKED',
  'BROWSER_FAILURE',
  'PERSIST_FAILURE',
  'POLL_ALREADY_RUNNING',
  'BROWSER_PROFILE_BUSY',
  'SKIPPED',
]);

/** Les issues devant lesquelles seule une action humaine change quelque chose. */
export const HUMAN_REQUIRED_OUTCOMES: readonly InboundTickOutcome[] = Object.freeze([
  'LOGIN_REQUIRED',
  'SESSION_BLOCKED',
]);

/**
 * Classe un relevé abouti.
 *
 * L'ordre des tests n'est pas décoratif : la session est interrogée AVANT la
 * lisibilité, parce qu'une boîte illisible dont la session est expirée doit
 * dire « refais ta session », pas « la page a changé ».
 */
export function classifyCollectReport(report: CollectReport): InboundTickOutcome {
  const sessionState = report.sessionState as InstagramSessionState;
  if (HARD_STOP_SESSION_STATES.includes(sessionState)) return 'SESSION_BLOCKED';
  if (sessionState === 'LOGIN_REQUIRED' || sessionState === 'SESSION_EXPIRED') return 'LOGIN_REQUIRED';
  if (report.readability === 'INBOX_UNREADABLE') return 'INBOX_UNREADABLE';

  const openable = report.rowsSeen - report.threadsSkipped;
  if (report.threadsRead === 0 && report.threadsUnreadable > 0) return 'PARSE_FAILURE';
  const degraded =
    report.threadsUnreadable > 0 ||
    report.truncatedThreads > 0 ||
    report.unknownDirectionSkipped > 0 ||
    (openable > 0 && report.threadsRead === 0);
  return degraded ? 'PARTIAL_OBSERVATION' : 'SUCCESS';
}

/** Classe une exception. Une panne nommée vaut mieux qu'une trace de pile dans un statut. */
export function classifyCollectError(error: unknown): InboundTickOutcome {
  if (error instanceof InstagramInboundError) {
    if (error.code === 'IG_INBOUND_POLL_RUNNING') return 'POLL_ALREADY_RUNNING';
    return 'PERSIST_FAILURE';
  }
  // Le filet, pour le cas où le bail n'aurait PAS été pris en amont (aucun
  // `profileDir` fourni au tour). `runInboundTick` le prend normalement avant
  // d'ouvrir la ligne de relève, précisément pour qu'une contention ne laisse
  // aucune trace d'échec en base ; si elle remonte quand même d'ici, elle est
  // au moins nommée pour ce qu'elle est.
  if (error instanceof InstagramRailError && error.code === 'IG_BROWSER_PROFILE_BUSY') {
    return 'BROWSER_PROFILE_BUSY';
  }
  return 'BROWSER_FAILURE';
}

// ---------------------------------------------------------------------------
// 5. L'aval — branché, jamais réécrit
// ---------------------------------------------------------------------------

/**
 * Ce que le runtime rapporte de l'aval. Volontairement étroit : le runtime
 * n'interprète pas ce que la classification a décidé, il compte.
 */
export interface DownstreamReport {
  readonly candidates: number;
  readonly classified: number;
  readonly drafted: number;
  /**
   * HERMES-MULTI-TURN-BURSTS-R1 — les bulles LUES dans le tour qui les clôt.
   *
   * Compté, jamais interprété : un opérateur qui voit `classified=1` sur trois
   * messages neufs doit pouvoir lire « et deux bulles ont été absorbées »
   * plutôt que de conclure que deux messages ont été perdus.
   */
  readonly absorbed: number;
  readonly failures: number;
  readonly detail: string;
}

/**
 * L'étape aval, injectée.
 *
 * Injectée et non importée en dur pour une raison qui n'est pas du confort de
 * test : elle appelle un MODÈLE. Un runtime qui construirait lui-même son
 * `ModelRouter` ne pourrait pas être exercé sans une configuration de modèles,
 * et les tests de cadence et de reprise n'ont rien à voir avec un LLM.
 *
 * `src/cli/ig-inbound-run.ts` la câble sur `processNewReplies` — c'est-à-dire
 * exactement le chemin de `npm run r6b:replies:process`, sans un octet de
 * duplication : même classification, même machine à états, même arrêt de
 * séquence, même projection CRM, même brouillon plafonné à `PROPOSED`.
 */
export type DownstreamStep = (sql: Sql) => Promise<DownstreamReport>;

// ---------------------------------------------------------------------------
// 6. Un tour complet
// ---------------------------------------------------------------------------

export interface InboundTickResult {
  readonly decision: InboundTickDecision;
  readonly outcome: InboundTickOutcome;
  /** `null` quand aucun tour n'a été ouvert. */
  readonly pollId: string | null;
  readonly sessionState: InstagramSessionState | null;
  readonly report: CollectReport | null;
  readonly downstream: DownstreamReport | null;
  /** La panne, nommée. `null` quand il n'y en a pas eu. */
  readonly failureDetail: string | null;
  readonly needsHuman: boolean;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

export interface InboundTickDeps {
  /**
   * Fabrique un rail NEUF par tour. Un contexte navigateur gardé ouvert des
   * heures est une fuite ; le fermer à chaque tour est le comportement sûr, et
   * c'est aussi ce qui garantit qu'une session cassée est re-diagnostiquée
   * plutôt qu'héritée.
   */
  readonly railFactory: () => InstagramInboundRail | Promise<InstagramInboundRail>;
  /**
   * Le profil navigateur partagé, pour prendre son bail AVANT d'ouvrir la
   * ligne de relève.
   *
   * Le rail le reprend de toute façon au moment d'ouvrir Chromium — c'est LÀ
   * qu'est la garantie, et aucun chemin ne la contourne. Le prendre ici en
   * plus sert autre chose : `collectInstagramInbound` inscrit une ligne
   * `ig_inbound_polls` AVANT de toucher au navigateur, et une ligne finie en
   * `FAILED` compte dans `consecutiveFailures`, donc dans le recul
   * exponentiel. Sans ce bail-ci, perdre la course contre le worker sortant
   * ralentirait la relève entrante comme si Instagram nous avait refusés.
   * Avec, le tour renonce avant d'écrire quoi que ce soit.
   *
   * Optionnel : un tour dont le rail est un double de test n'ouvre aucun
   * navigateur et n'a aucun profil à réserver.
   */
  readonly profileDir?: string;
  readonly downstream?: DownstreamStep;
  readonly logger?: Logger;
  readonly now?: () => Date;
  /** Qui relève. Inscrit dans `ig_inbound_polls.polled_by`, donc visible dans le statut. */
  readonly polledBy: string;
}

function skipped(decision: InboundTickDecision, at: Date): InboundTickResult {
  return Object.freeze({
    decision,
    outcome: 'SKIPPED' as const,
    pollId: null,
    sessionState: null,
    report: null,
    downstream: null,
    failureDetail: null,
    needsHuman: decision.needsHuman,
    startedAt: at,
    finishedAt: at,
  });
}

/**
 * Un tour : décider, prendre la propriété, observer, ingérer, puis traiter
 * l'aval.
 *
 * ---------------------------------------------------------------------------
 * L'aval tourne MÊME quand la relève a échoué
 * ---------------------------------------------------------------------------
 *
 * C'est délibéré et c'est la réponse à « message persisté mais jamais
 * processé ». Un collecteur tué entre l'écriture d'une réponse et sa
 * classification laisse une ligne `r6b_inbound_messages` corrélée sans analyse
 * vivante. Si l'aval n'était lancé qu'après un relevé RÉUSSI, cette réponse
 * resterait invisible tant que la boîte serait illisible — c'est-à-dire
 * précisément dans la situation où l'on en aurait le plus besoin.
 *
 * Le rattrapage ne coûte rien quand il n'y a rien à rattraper :
 * `loadUnprocessedCorrelatedInbound` rend une liste vide, et aucun modèle n'est
 * appelé.
 */
export async function runInboundTick(
  sql: Sql,
  deps: InboundTickDeps,
  config: InboundRuntimeConfig,
): Promise<InboundTickResult> {
  const log = deps.logger ?? rootLogger.child({ rail: 'instagram-inbound-runtime' });
  const now = deps.now ?? ((): Date => new Date());
  const startedAt = now();

  const accountHandle = config.accountHandle;
  const state =
    accountHandle === null
      ? Object.freeze({
          accountHandle: '',
          running: null,
          lastTerminal: null,
          lastSuccessful: null,
          consecutiveFailures: 0,
        })
      : await loadInboundRuntimeState(sql, accountHandle);

  const decision = decideInboundTick({ state, config, now: startedAt });
  if (decision.verdict !== 'POLL' || accountHandle === null) {
    log.info('instagram.inbound.tick.skipped', { verdict: decision.verdict, reason: decision.reason });
    return skipped(decision, startedAt);
  }

  let outcome: InboundTickOutcome = 'BROWSER_FAILURE';
  let pollId: string | null = null;
  let report: CollectReport | null = null;
  let failureDetail: string | null = null;
  let sessionState: InstagramSessionState | null = null;

  // Le bail du profil, AVANT le rail et avant la ligne de relève. Voir
  // `InboundTickDeps.profileDir` : ce n'est pas la garantie, c'est ce qui
  // évite qu'une contention normale ressemble à une panne dans le journal.
  let lease: InstagramBrowserLease | null = null;
  let profileBusy: InstagramBrowserProfileBusyError | null = null;
  if (deps.profileDir !== undefined) {
    try {
      lease = acquireInstagramBrowserLease(deps.profileDir);
    } catch (error) {
      if (!(error instanceof InstagramBrowserProfileBusyError)) throw error;
      profileBusy = error;
      log.info('instagram.inbound.tick.profile_busy', {
        holderPid: error.holder.pid,
        heldSince: error.holder.startedAt,
      });
    }
  }

  // Profil occupé : aucun rail n'est fabriqué, aucun navigateur n'est ouvert,
  // aucune ligne de relève n'est écrite. On ne rend pas la main pour autant —
  // l'aval tourne quand même, quelques lignes plus bas, pour la raison donnée
  // en tête de cette fonction : une réponse déjà persistée mais pas encore
  // classée ne doit pas attendre que la boîte redevienne lisible.
  if (profileBusy !== null) {
    outcome = 'BROWSER_PROFILE_BUSY';
    failureDetail = profileBusy.message;
  } else {
    // La fabrique AVANT le `try`, mais pas avant le bail : si elle lève — elle
    // le fait quand le rail qu'on lui a confié expose une capacité d'action, et
    // ce refus-là doit rester bruyant — le bail doit repartir avec elle. Sans
    // ce `catch`, un rail mal formé laisserait le profil réputé occupé jusqu'à
    // la fin du processus, et le worker sortant attendrait un navigateur qui
    // n'a jamais été ouvert.
    let rail: InstagramInboundRail;
    try {
      rail = await deps.railFactory();
    } catch (error) {
      lease?.release();
      throw error;
    }

    try {
      // Les deux mêmes questions qu'à la CLI, posées à l'OBJET reçu et non au
      // type : un type dit ce qu'on croit avoir. Le collecteur les repose de son
      // côté ; ce n'est pas une redondance, c'est la troisième barrière de §7 qui
      // ne dépend d'aucune discipline d'appelant.
      const forbidden = forbiddenMethodsOn(rail);
      if (hasSendPrimitive(rail) || forbidden.length > 0) {
        throw new Error(
          `le rail entrant expose une capacité d'action (${forbidden.join(', ') || 'primitive d’envoi'}) — ` +
            'relève refusée',
        );
      }

      report = await collectInstagramInbound(
        sql,
        { rail, logger: log, now: deps.now },
        {
          accountHandle,
          formerAccountHandles: config.formerAccountHandles,
          polledBy: deps.polledBy,
          maxThreads: config.maxThreadsPerPoll,
          leaseMs: config.leaseMs,
        },
      );
      pollId = report.pollId;
      sessionState = report.sessionState as InstagramSessionState;
      outcome = classifyCollectReport(report);
      if (outcome !== 'SUCCESS') failureDetail = report.stopReason ?? `relève ${outcome}`;
    } catch (error) {
      outcome = classifyCollectError(error);
      failureDetail = error instanceof Error ? error.message : String(error);
      log.warn('instagram.inbound.tick.failed', { outcome, detail: failureDetail });
    } finally {
      try {
        await rail.close().catch(() => undefined);
      } finally {
        // Après le rail, jamais avant : Chromium écrit dans le profil jusqu'à
        // sa fermeture, et un bail rendu plus tôt inviterait l'autre runtime à
        // ouvrir le même répertoire pendant qu'il s'y écrit encore.
        lease?.release();
      }
    }
  }

  let downstream: DownstreamReport | null = null;
  if (deps.downstream !== undefined) {
    try {
      downstream = await deps.downstream(sql);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.error('instagram.inbound.tick.downstream_failed', { detail });
      downstream = Object.freeze({
        candidates: 0,
        classified: 0,
        drafted: 0,
        absorbed: 0,
        failures: 1,
        detail: `aval interrompu : ${detail}`,
      });
    }
  }

  const finishedAt = now();
  log.info('instagram.inbound.tick', {
    outcome,
    pollId,
    ingested: report?.ingested ?? 0,
    classified: downstream?.classified ?? 0,
    drafted: downstream?.drafted ?? 0,
  });

  return Object.freeze({
    decision,
    outcome,
    pollId,
    sessionState,
    report,
    downstream,
    failureDetail,
    needsHuman: HUMAN_REQUIRED_OUTCOMES.includes(outcome),
    startedAt,
    finishedAt,
  });
}

// ---------------------------------------------------------------------------
// 7. La boucle 24/7
// ---------------------------------------------------------------------------

/**
 * Le plancher d'attente entre deux tours, en millisecondes.
 *
 * Il n'existe que pour rendre une boucle occupée IMPOSSIBLE, même si l'état lu
 * devenait incohérent (horloge reculée, ligne effacée sous les pieds du
 * runtime). Dans le régime nominal il n'est jamais atteint : la plus petite
 * attente réelle est `pollIntervalMs`, dont le minimum configurable est
 * 60 000 ms.
 */
export const MIN_TICK_SPACING_MS = 1_000;

/**
 * Le délai avant de redemander un profil que l'autre rail tenait.
 *
 * Ce n'est PAS une cadence de relève, et c'est la distinction qui compte : la
 * cadence appartient toujours à `decideInboundTick`, qui la relit en base au
 * tour suivant. Ceci est un délai de reprise sur conflit de RESSOURCE, dans un
 * état qui n'existait pas avant le bail — le tour n'a rien observé, rien écrit,
 * et n'a donc rien décidé de la suite.
 *
 * Pourquoi pas le plancher d'une seconde : le worker sortant garde son
 * navigateur ouvert le temps d'un tour, soit des dizaines de secondes. Redemander
 * chaque seconde produirait des dizaines de tours à vide — chacun relisant la
 * base et relançant l'aval — pour une seule attente. Pourquoi pas
 * `pollIntervalMs` non plus : perdre une course de vingt secondes ne doit pas
 * coûter cinq minutes de retard sur un message entrant. Quinze secondes tient
 * les deux bouts.
 */
export const PROFILE_BUSY_RETRY_MS = 15_000;

export type RuntimeStopReason =
  | 'ABORTED'
  | 'MAX_TICKS'
  | 'RUNTIME_DISABLED'
  | 'NO_ACCOUNT'
  /**
   * HERMES-ACTIVE-ANALYSIS-VERSION-CONFLICT-R1 — le code du dépôt a changé
   * depuis le démarrage de ce processus. Ce n'est pas une panne : c'est le
   * refus de continuer à classifier avec les constantes d'hier. Un humain
   * relance, et le tour suivant est rendu sous la version canonique.
   */
  | 'CODE_REVISION_CHANGED';

export interface InboundRuntimeReport {
  readonly ticks: readonly InboundTickResult[];
  readonly stoppedBy: RuntimeStopReason;
  readonly polls: number;
  readonly ingested: number;
  readonly classified: number;
  readonly drafted: number;
}

export interface InboundRuntimeLoopDeps extends InboundTickDeps {
  /** L'arrêt gracieux. Câblé sur SIGINT/SIGTERM par la CLI, sur un test par les tests. */
  readonly signal?: AbortSignal;
  /** Injectable pour que les tests n'attendent jamais réellement. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * La sentinelle de révision — HERMES-ACTIVE-ANALYSIS-VERSION-CONFLICT-R1.
   *
   * Absente, la boucle se comporte exactement comme avant : c'est la CLI qui
   * la câble, parce que c'est elle qui sait où vit le dépôt. Elle ne peut
   * produire qu'un ARRÊT, jamais un traitement de plus, jamais un traitement
   * plus tôt.
   */
  readonly codeRevision?: CodeRevisionSentinel;
}

export interface InboundRuntimeLoopOptions {
  /** `null` = tourner jusqu'à l'arrêt. Un entier = s'arrêter après N tours (tests, smoke). */
  readonly maxTicks: number | null;
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // Un `AbortError` n'est pas une panne : c'est l'arrêt demandé. La boucle
    // le relira sur le signal lui-même.
  }
}

/**
 * La boucle.
 *
 * Elle ne mémorise rien entre deux tours : chaque itération relit l'état et
 * redemande la décision. C'est plus de requêtes (trois, toutes les quelques
 * minutes) et c'est le prix d'une propriété qui compte davantage — un runtime
 * redémarré, un second collecteur, ou le même collecteur après une panne
 * tiennent tous exactement la même cadence, parce qu'aucun ne raisonne sur une
 * variable qu'il serait seul à connaître.
 *
 * L'arrêt est vérifié AVANT le tour et pendant l'attente : un SIGTERM reçu
 * pendant une relève laisse le tour finir (il n'a aucun effet externe à
 * interrompre, et l'abandonner laisserait une ligne `RUNNING` de plus), puis
 * sort.
 */
export async function runInboundRuntimeLoop(
  sql: Sql,
  deps: InboundRuntimeLoopDeps,
  config: InboundRuntimeConfig,
  options: InboundRuntimeLoopOptions = { maxTicks: null },
): Promise<InboundRuntimeReport> {
  const log = deps.logger ?? rootLogger.child({ rail: 'instagram-inbound-runtime' });
  const sleep = deps.sleep ?? defaultSleep;
  const ticks: InboundTickResult[] = [];
  let stoppedBy: RuntimeStopReason = 'ABORTED';
  // Une fonction et non `deps.signal?.aborted` en ligne : lu deux fois dans la
  // même portée, TypeScript garderait la première narrowing et déclarerait la
  // seconde lecture impossible — alors que tout l'intérêt est qu'elle ait
  // changé entre les deux.
  const aborted = (): boolean => deps.signal?.aborted === true;

  while (options.maxTicks === null || ticks.length < options.maxTicks) {
    if (aborted()) {
      stoppedBy = 'ABORTED';
      break;
    }

    // AVANT le tour, et non après : un processus qui tourne sous un code
    // périmé ne doit pas classifier une fois de plus « pour finir ce qu'il a
    // commencé ». Rien n'a encore été relevé, donc rien n'est laissé à moitié.
    if (deps.codeRevision?.hasDrifted() === true) {
      log.warn('instagram.inbound.runtime.code_revision_changed', {
        startedAt: deps.codeRevision.startedAt,
        current: deps.codeRevision.current(),
      });
      stoppedBy = 'CODE_REVISION_CHANGED';
      break;
    }

    const tick = await runInboundTick(sql, deps, config);
    ticks.push(tick);

    if (tick.decision.verdict === 'RUNTIME_DISABLED') {
      stoppedBy = 'RUNTIME_DISABLED';
      break;
    }
    if (tick.decision.verdict === 'NO_ACCOUNT') {
      stoppedBy = 'NO_ACCOUNT';
      break;
    }
    if (aborted()) {
      stoppedBy = 'ABORTED';
      break;
    }
    if (options.maxTicks !== null && ticks.length >= options.maxTicks) {
      stoppedBy = 'MAX_TICKS';
      break;
    }

    // L'attente vient de la DÉCISION, pas d'une constante : après un tour dû
    // elle vaut 0, la prochaine itération relit l'état, obtient `NOT_DUE` et
    // s'endort pour la bonne durée. Le plancher rend l'itération à vide
    // impossible même dans ce cas.
    //
    // Sauf sur un profil occupé : là, la décision disait « relève », et elle
    // avait raison — c'est la RESSOURCE qui manquait, pas l'heure. Rien n'a été
    // observé ni écrit, donc l'état en base est exactement celui d'avant et la
    // décision suivante redirait « relève » dans une seconde, indéfiniment.
    // Voir `PROFILE_BUSY_RETRY_MS`.
    const waitMs =
      tick.outcome === 'BROWSER_PROFILE_BUSY'
        ? PROFILE_BUSY_RETRY_MS
        : Math.max(tick.decision.waitMs, MIN_TICK_SPACING_MS);
    log.debug('instagram.inbound.runtime.sleep', { waitMs, verdict: tick.decision.verdict });
    await sleep(waitMs, deps.signal);
  }

  if (options.maxTicks !== null && ticks.length >= options.maxTicks && stoppedBy === 'ABORTED') {
    stoppedBy = 'MAX_TICKS';
  }

  return Object.freeze({
    ticks: Object.freeze(ticks),
    stoppedBy,
    polls: ticks.filter((tick) => tick.pollId !== null).length,
    ingested: ticks.reduce((sum, tick) => sum + (tick.report?.ingested ?? 0), 0),
    classified: ticks.reduce((sum, tick) => sum + (tick.downstream?.classified ?? 0), 0),
    drafted: ticks.reduce((sum, tick) => sum + (tick.downstream?.drafted ?? 0), 0),
  });
}
