import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgliteSql } from '@/lib/db/pglite';
import { migrate } from '@/lib/db/migrate';
import { createLogger } from '@/lib/logging/logger';
import { ModelRouter } from '@/lib/models/router';
import { LlmError, type LlmProvider } from '@/lib/models/types';
import { instagramRailSchema } from '@/lib/config/schema';
import { castR6bVote } from '@/lib/pipeline/r6bBatch';
import { lockManifestForItem } from '@/lib/pipeline/r6bDispatch';
import { classifyAdjudicationRequest } from '@/lib/instagram/readOnlyGuard';
import { isInsideWindow } from '@/lib/instagram/scheduler';
import { forbiddenMethodsOn, type InstagramInboundRail } from '@/lib/instagram/inboundRail';
import { hasSendPrimitive } from '@/lib/instagram/rail';
import { openInboundPoll, persistInstagramInboundMessage } from '@/lib/inbound/instagramIntake';
import { instagramMessageFingerprint } from '@/lib/instagram/inboundThread';
import { createReplyProcessingStep } from '@/lib/inbound/instagramDownstream';
import { loadInboundRuntimeStatus } from '@/lib/inbound/instagramRuntimeStatus';
import {
  HUMAN_REQUIRED_OUTCOMES,
  INBOUND_RUNTIME_ENV_KEYS,
  InboundRuntimeConfigError,
  MIN_TICK_SPACING_MS,
  PROFILE_BUSY_RETRY_MS,
  cadenceClassOf,
  classifyCollectError,
  classifyCollectReport,
  countConsecutiveFailures,
  decideInboundTick,
  isSuccessfulPoll,
  loadInboundRuntimeState,
  nextAttemptDelayMs,
  resolveInboundRuntimeConfig,
  runInboundRuntimeLoop,
  runInboundTick,
  type InboundRuntimeConfig,
  type InboundRuntimeState,
  type TerminalPoll,
} from '@/lib/inbound/instagramRuntime';
import type { CollectReport } from '@/lib/inbound/instagramCollector';
import type { CrmResolution } from '@/lib/crm/types';
import type { Sql } from '@/lib/db/sql';
import { InstagramInboundError } from '@/lib/inbound/instagramIntake';
import {
  inspectInstagramBrowserLease,
  instagramBrowserLeasePath,
} from '@/lib/instagram/browserProfileLease';
import { InstagramRailError } from '@/lib/instagram/rail';
import { FakeInstagramInboundRail, domMessage as message, makeThread } from './support/instagramInboundFixture';
import { makeProspectInstagramEligible } from './support/instagramEligibility';
import { turnAnswer } from './support/turnAnswer';

/**
 * IG5.2A — le RUNTIME de la relève entrante : cadence, propriété, reprise.
 *
 * Aucun test de ce fichier n'ouvre de navigateur, ne joint Instagram, ni ne lit
 * l'heure réelle. La cadence est exercée sur des instants FOURNIS, ce qui est
 * la seule façon d'affirmer « samedi à 03:00 aussi » sans attendre samedi.
 *
 * Les entreprises, comptes et textes sont fictifs.
 */

const logger = createLogger({ test: 'ig5.2a-runtime' });
const ACCOUNT = 'hermes.test';
const HANDLE = 'atelier.test';
const FIRST_TOUCH = 'Bonjour, comment vos clients vous trouvent aujourd’hui ?';

let sql: Sql;
let dir: string;
let campaignId: string;

const NO_CRM: CrmResolution = {
  configured: false,
  kind: 'NOT_CONFIGURED',
  reason: 'aucune destination CRM configurée pour Hermes',
  missing: ['OUTBOUND_CRM_PROVIDER'],
};

// ---------------------------------------------------------------------------
// Constructeurs
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<InboundRuntimeConfig> = {}): InboundRuntimeConfig {
  return Object.freeze({
    enabled: true,
    accountHandle: ACCOUNT,
    formerAccountHandles: [],
    pollIntervalMs: 300_000,
    leaseMs: 300_000,
    maxThreadsPerPoll: 10,
    retryBackoffMs: 600_000,
    maxBackoffMs: 3_600_000,
    awaitingHumanBackoffMs: 1_800_000,
    downstreamLimit: 50,
    ...overrides,
  });
}

function terminal(overrides: Partial<TerminalPoll> = {}): TerminalPoll {
  return Object.freeze({
    pollId: 'poll-1',
    status: 'COMPLETED' as const,
    startedAt: new Date('2026-08-15T00:00:00Z'),
    finishedAt: new Date('2026-08-15T00:00:30Z'),
    sessionState: 'SESSION_READY' as const,
    inboxReadability: 'INBOX_READABLE' as const,
    messagesIngested: 0,
    detail: null,
    ...overrides,
  });
}

function state(overrides: Partial<InboundRuntimeState> = {}): InboundRuntimeState {
  return Object.freeze({
    accountHandle: ACCOUNT,
    running: null,
    lastTerminal: null,
    lastSuccessful: null,
    consecutiveFailures: 0,
    ...overrides,
  });
}

function report(overrides: Partial<CollectReport> = {}): CollectReport {
  return Object.freeze({
    pollId: 'poll-1',
    accountHandle: ACCOUNT,
    sessionState: 'SESSION_READY',
    readability: 'INBOX_READABLE' as const,
    stopReason: null,
    rowsSeen: 1,
    threadListReadable: true,
    threadListSize: 1,
    threadsRead: 1,
    threadsNotOpened: 0,
    threadsUnreadable: 0,
    threadsSkipped: 0,
    messagesObserved: 1,
    outgoingSkipped: 0,
    unknownDirectionSkipped: 0,
    unidentifiedSenderSkipped: 0,
    preOutreachSkipped: 0,
    noOutreachSkipped: 0,
    nonTextSkipped: 0,
    ingested: 1,
    alreadyKnown: 0,
    threadsBound: 0,
    correlated: Object.freeze([]),
    replyStatuses: Object.freeze([]),
    threadLedger: Object.freeze([]),
    blockedWriteRequests: 0,
    truncatedThreads: 0,
    durationMs: 42,
    ...overrides,
  });
}


// ---------------------------------------------------------------------------
// 1. Configuration — le défaut est DÉSARMÉ, et l'environnement l'emporte
// ---------------------------------------------------------------------------

describe('IG5.2A §11 — configuration du runtime', () => {
  // IG5 R4 — le dépôt ne livre plus le runtime désarmé : la relève est ACTIVE,
  // et c'est un fait de configuration qu'un test doit énoncer plutôt que
  // laisser deviner. Le défaut du SCHÉMA, lui, reste `false` — le test suivant
  // s'en charge, et la distinction est exactement le sujet : armer demande un
  // diff, désarmer aussi.
  //
  // HERMES-IDENTITY-CANONICALIZATION-R1 §5 — le compte relevé est `hermes__`.
  // C'est le nom que porte AUJOURD'HUI le compte sous lequel la session est
  // ouverte ; `hermesagency_` est le nom qu'il portait avant le 22 août 2026
  // et vit désormais dans `formerAccountHandles`, où il rattache les lignes
  // déjà écrites sans prétendre décrire la session courante.
  it('le dépôt livre la relève DÉSARMÉE et sans compte — la cadence, elle, est écrite', () => {
    const parsed = instagramRailSchema.parse(
      JSON.parse(readFileSync(resolve(process.cwd(), 'config/instagram.json'), 'utf8')),
    );
    // Une instance fraîche ne relève RIEN : personne n'a encore dit quel
    // compte lui appartient, et relever la boîte de quelqu'un d'autre n'est
    // pas un défaut acceptable.
    expect(parsed.inbound.enabled).toBe(false);
    expect(parsed.inbound.accountHandle).toBe('UNCONFIGURED');
    expect(parsed.inbound.formerAccountHandles).toEqual([]);
    // La cadence d'IG5.2A, conservée telle quelle : R4 active un runtime, il
    // n'en réajuste pas l'arithmétique.
    expect(parsed.inbound.pollIntervalMs).toBe(300_000);
    expect(parsed.inbound.retryBackoffMs).toBe(600_000);
    expect(parsed.inbound.maxBackoffMs).toBe(3_600_000);
    expect(parsed.inbound.awaitingHumanBackoffMs).toBe(1_800_000);
  });

  it('armé sans compte nommé est une configuration IMPOSSIBLE à livrer', () => {
    // L'invariant que R4 rend non régressable : `enabled` sans
    // `accountHandle` ferait démarrer un runtime qui devrait ensuite deviner
    // quelle boîte relever. Le runtime refuse de deviner (`NO_ACCOUNT`), mais
    // le refuser au démarrage d'un service supervisé, c'est un LaunchAgent qui
    // redémarre en boucle sans jamais rien relever. On le constate ici, sur le
    // fichier réellement livré.
    const parsed = instagramRailSchema.parse(
      JSON.parse(readFileSync(resolve(process.cwd(), 'config/instagram.json'), 'utf8')),
    );
    if (parsed.inbound.enabled) expect(parsed.inbound.accountHandle).not.toBeNull();

    // Et la même incohérence, posée à la décision : c'est bien un refus, pas
    // un repli sur un compte hérité de la session ouverte.
    const decision = decideInboundTick({
      state: {
        accountHandle: '',
        running: null,
        lastTerminal: null,
        lastSuccessful: null,
        consecutiveFailures: 0,
      },
      config: resolveInboundRuntimeConfig(
        instagramRailSchema.parse({
          session: {},
          caps: {},
          queue: {},
          schedule: { windows: [{ days: [1], startMinute: 540, endMinute: 1080 }] },
          inbound: { enabled: true },
        }),
        {},
      ),
      now: new Date('2026-08-21T06:00:00.000Z'),
    });
    expect(decision.verdict).toBe('NO_ACCOUNT');
    expect(decision.needsHuman).toBe(true);
  });

  it('le LaunchAgent R4 ne déclare AUCUN intervalle — la cadence reste au runtime', () => {
    // Le seul point où un second ordonnanceur pourrait naître : un
    // `StartInterval` dans le plist relancerait le processus toutes les N
    // secondes, en parallèle du recul que le runtime calcule déjà. Le gabarit
    // versionné est lu ici pour que la question soit tranchée par un test et
    // non par une relecture.
    const plist = readFileSync(
      resolve(process.cwd(), 'deploy/launchd/com.hermes.ig-inbound.plist'),
      'utf8',
    );
    expect(plist).not.toMatch(/<key>StartInterval<\/key>/);
    expect(plist).not.toMatch(/<key>StartCalendarInterval<\/key>/);
    // Ce qu'il déclare, en revanche : la reprise après un crash, et rien après
    // une sortie propre — sans quoi « désarmé » deviendrait « redémarre ».
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);

    // Le lanceur, lui, n'ordonnance rien non plus : aucun `sleep`, aucune
    // boucle. Il donne un PATH et exec le runtime.
    const runner = readFileSync(resolve(process.cwd(), 'scripts/ig-inbound-runtime.sh'), 'utf8');
    expect(runner).toMatch(/exec .*npm" run ig:inbound:run -- --loop/);
    expect(runner).not.toMatch(/^\s*sleep /m);
    expect(runner).not.toMatch(/^\s*while /m);
  });

  it('les défauts du schéma tiennent même quand le bloc inbound est absent', () => {
    const parsed = instagramRailSchema.parse({
      session: {},
      caps: {},
      queue: {},
      schedule: { windows: [{ days: [1], startMinute: 540, endMinute: 1080 }] },
    });
    expect(parsed.inbound.enabled).toBe(false);
    expect(parsed.inbound.pollIntervalMs).toBe(300_000);
    expect(parsed.inbound.retryBackoffMs).toBe(600_000);
    expect(parsed.inbound.awaitingHumanBackoffMs).toBe(1_800_000);
  });

  it('aucune cadence sous la minute n’est acceptable, même écrite à la main', () => {
    const attempt = (): unknown =>
      instagramRailSchema.parse({
        session: {},
        caps: {},
        queue: {},
        schedule: { windows: [{ days: [1], startMinute: 540, endMinute: 1080 }] },
        inbound: { pollIntervalMs: 30_000 },
      });
    expect(attempt).toThrow();
  });

  it('un plafond de recul sous son plancher est refusé au chargement, pas corrigé', () => {
    const attempt = (): unknown =>
      instagramRailSchema.parse({
        session: {},
        caps: {},
        queue: {},
        schedule: { windows: [{ days: [1], startMinute: 540, endMinute: 1080 }] },
        inbound: { retryBackoffMs: 600_000, maxBackoffMs: 120_000 },
      });
    expect(attempt).toThrow(/maxBackoffMs/);
  });

  it('l’environnement l’emporte sur le fichier, et rien d’autre ne l’emporte', () => {
    const base = instagramRailSchema.parse({
      session: {},
      caps: {},
      queue: {},
      schedule: { windows: [{ days: [1], startMinute: 540, endMinute: 1080 }] },
      inbound: { accountHandle: 'depuis.le.fichier' },
    });

    const fromFile = resolveInboundRuntimeConfig(base, {});
    expect(fromFile.enabled).toBe(false);
    expect(fromFile.accountHandle).toBe('depuis.le.fichier');

    const fromEnv = resolveInboundRuntimeConfig(base, {
      [INBOUND_RUNTIME_ENV_KEYS.enabled]: '1',
      [INBOUND_RUNTIME_ENV_KEYS.account]: '@depuis.env',
      [INBOUND_RUNTIME_ENV_KEYS.intervalMs]: '120000',
    });
    expect(fromEnv.enabled).toBe(true);
    expect(fromEnv.accountHandle).toBe('depuis.env');
    expect(fromEnv.pollIntervalMs).toBe(120_000);
  });

  it('une valeur d’environnement incomprise est une erreur, jamais un repli silencieux', () => {
    const base = instagramRailSchema.parse({
      session: {},
      caps: {},
      queue: {},
      schedule: { windows: [{ days: [1], startMinute: 540, endMinute: 1080 }] },
    });
    expect(() => resolveInboundRuntimeConfig(base, { [INBOUND_RUNTIME_ENV_KEYS.enabled]: 'peut-être' })).toThrow(
      InboundRuntimeConfigError,
    );
    expect(() => resolveInboundRuntimeConfig(base, { [INBOUND_RUNTIME_ENV_KEYS.intervalMs]: '5000' })).toThrow(
      InboundRuntimeConfigError,
    );
    expect(() => resolveInboundRuntimeConfig(base, { [INBOUND_RUNTIME_ENV_KEYS.account]: 'un handle invalide' })).toThrow(
      InboundRuntimeConfigError,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. La collecte est 24/7 — prouvé sur des instants, pas affirmé
// ---------------------------------------------------------------------------

describe('IG5.2A §2/§12 — la lecture ne connaît ni jour ouvré ni fenêtre', () => {
  // Quatre instants que la fenêtre cold outbound (lun–ven 09:00–20:00
  // Europe/Paris) traite très différemment : le premier est dedans, les trois
  // autres sont dehors — dont un samedi à 3 h du matin.
  const INSTANTS: readonly (readonly [string, string])[] = [
    ['lundi 10:00 — dans la fenêtre sortante', '2026-08-17T10:00:00+02:00'],
    ['lundi 23:30 — hors fenêtre', '2026-08-17T23:30:00+02:00'],
    ['samedi 03:00 — hors fenêtre, week-end', '2026-08-15T03:00:00+02:00'],
    ['dimanche 18:00 — hors fenêtre, week-end', '2026-08-16T18:00:00+02:00'],
  ];

  for (const [label, iso] of INSTANTS) {
    it(`${label} : un tour dû est autorisé`, () => {
      const now = new Date(iso);
      const decision = decideInboundTick({
        state: state({ lastTerminal: terminal({ finishedAt: new Date(now.getTime() - 360_000) }) }),
        config: makeConfig(),
        now,
      });
      expect(decision.verdict).toBe('POLL');
      expect(decision.waitMs).toBe(0);
    });

    it(`${label} : un tour NON dû attend, pour la même raison partout`, () => {
      const now = new Date(iso);
      const decision = decideInboundTick({
        state: state({ lastTerminal: terminal({ finishedAt: new Date(now.getTime() - 60_000) }) }),
        config: makeConfig(),
        now,
      });
      // Le refus est « pas encore », jamais « pas aujourd'hui ».
      expect(decision.verdict).toBe('NOT_DUE');
      expect(decision.waitMs).toBe(240_000);
    });
  }

  it('la décision ne dépend QUE du temps écoulé — quatre jours, un seul verdict', () => {
    const verdicts = INSTANTS.map(([, iso]) => {
      const now = new Date(iso);
      return decideInboundTick({
        state: state({ lastTerminal: terminal({ finishedAt: new Date(now.getTime() - 300_001) }) }),
        config: makeConfig(),
        now,
      }).verdict;
    });
    expect(new Set(verdicts)).toEqual(new Set(['POLL']));
  });

  it('le premier tour d’un compte jamais relevé est dû immédiatement', () => {
    const decision = decideInboundTick({
      state: state(),
      config: makeConfig(),
      now: new Date('2026-08-15T03:00:00+02:00'),
    });
    expect(decision.verdict).toBe('POLL');
  });

  it('IG5 R4 §7 — les deux fenêtres sont confrontées : fermée dehors, ouverte dedans', () => {
    // Les tests précédents affirment le 24/7 sur des instants CHOISIS. Celui-ci
    // fait l'autre moitié du travail : il interroge l'ordonnanceur SORTANT réel,
    // avec la fenêtre réellement livrée (`config/instagram.json`), et vérifie
    // que là où il dit « fermé », la relève dit quand même « relève ».
    //
    // C'est ce qui rend la confusion des deux fenêtres impossible à réintroduire
    // sans faire tomber un test : si un jour la lecture héritait de la fenêtre
    // cold outbound, trois de ces quatre instants basculeraient.
    const railConfig = instagramRailSchema.parse(
      JSON.parse(readFileSync(resolve(process.cwd(), 'config/instagram.json'), 'utf8')),
    );
    // La relève est livrée DÉSARMÉE ; ce test parle de la FENÊTRE, pas de
    // l'armement. On l'arme donc en mémoire, pour ce test seulement, afin que
    // le verdict rendu porte bien sur l'heure et non sur le drapeau.
    const inbound = { ...resolveInboundRuntimeConfig(railConfig, {}), enabled: true };

    let closedInstants = 0;
    for (const [label, iso] of INSTANTS) {
      const now = new Date(iso);
      const outboundOpen = isInsideWindow(now, railConfig.schedule);
      if (!outboundOpen) closedInstants += 1;

      const decision = decideInboundTick({
        state: {
          accountHandle: inbound.accountHandle ?? '',
          running: null,
          lastTerminal: terminal({ finishedAt: new Date(now.getTime() - inbound.pollIntervalMs - 1_000) }),
          lastSuccessful: null,
          consecutiveFailures: 0,
        },
        config: inbound,
        now,
      });
      expect(`${label} → ${decision.verdict}`).toBe(`${label} → POLL`);
    }

    // Et la fenêtre sortante, elle, n'a pas été élargie en passant : trois de
    // ces quatre instants lui restent fermés. Sans cette ligne, le test
    // passerait aussi le jour où quelqu'un ouvrirait l'outbound 24/7.
    expect(closedInstants).toBe(3);
    expect(isInsideWindow(new Date('2026-08-17T10:00:00+02:00'), railConfig.schedule)).toBe(true);
  });

  it('le runtime entrant n’importe NI l’ordonnanceur sortant, NI le kill-switch', () => {
    // Une propriété structurelle se vérifie sur le SOURCE : une revue humaine
    // oublie, un test non. Ce qui est interdit ici, c'est que la lecture puisse
    // un jour être branchée sur la fenêtre sortante « pour uniformiser ».
    const source = readFileSync(resolve(process.cwd(), 'src/lib/inbound/instagramRuntime.ts'), 'utf8');

    // Les commentaires sont RETIRÉS avant la vérification, et c'est nécessaire :
    // ce fichier explique par écrit ce qu'il n'importe pas, en nommant les
    // symboles. Chercher dans la prose ferait échouer le test sur sa propre
    // documentation — et pousserait à mal la rédiger pour faire passer un test.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const imports = code
      .split('\n')
      .filter((row) => row.startsWith('import '))
      .join('\n');
    expect(imports).not.toMatch(/instagram\/scheduler/);
    expect(imports).not.toMatch(/instagram\/safety/);
    expect(imports).not.toMatch(/instagram\/queue/);
    for (const forbidden of [
      'evaluateSchedule',
      'nextWindowOpening',
      'evaluateEffectCaps',
      'loadSafetySnapshot',
      'ig_kill_switch',
      'ig_dispatch_jobs',
      'schedule_window',
      'timeZone',
      'Intl',
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Cadence, recul, et l'invariant « illisible ≠ vide »
// ---------------------------------------------------------------------------

describe('IG5.2A §5/§6 — cadence, recul, fail-closed', () => {
  it('un tour COMPLETED dont la boîte était ILLISIBLE n’est PAS un succès', () => {
    const poll = terminal({ status: 'COMPLETED', inboxReadability: 'INBOX_UNREADABLE' });
    // C'est l'invariant central de la mission : « je n'ai pas su lire » ne peut
    // pas hériter de la cadence de « il n'y avait rien ».
    expect(isSuccessfulPoll(poll)).toBe(false);
    expect(cadenceClassOf(poll)).toBe('TRANSIENT_FAILURE');
  });

  it('un tour COMPLETED et lisible est le seul succès', () => {
    expect(isSuccessfulPoll(terminal())).toBe(true);
    expect(cadenceClassOf(terminal())).toBe('HEALTHY');
  });

  for (const sessionState of ['LOGIN_REQUIRED', 'SESSION_EXPIRED', 'CHALLENGE', 'CAPTCHA', 'BLOCKED'] as const) {
    it(`${sessionState} demande un HUMAIN — jamais un rejeu serré`, () => {
      const poll = terminal({ status: 'FAILED', sessionState, inboxReadability: 'INBOX_UNREADABLE' });
      expect(cadenceClassOf(poll)).toBe('AWAITING_HUMAN');

      const decision = decideInboundTick({
        state: state({ lastTerminal: poll, consecutiveFailures: 1 }),
        config: makeConfig(),
        now: new Date(poll.finishedAt.getTime() + 60_000),
      });
      expect(decision.verdict).toBe('AWAITING_HUMAN');
      expect(decision.needsHuman).toBe(true);
      // 30 minutes, pas 10 secondes : marteler un défi de sécurité ressemblerait
      // à un contournement, et n'en serait pas un moins mauvais pour autant.
      expect(decision.waitMs).toBe(1_800_000 - 60_000);
    });
  }

  it('le recul transitoire double à chaque échec et plafonne', () => {
    const config = makeConfig({ retryBackoffMs: 600_000, maxBackoffMs: 3_600_000 });
    expect(nextAttemptDelayMs('TRANSIENT_FAILURE', 1, config)).toBe(600_000);
    expect(nextAttemptDelayMs('TRANSIENT_FAILURE', 2, config)).toBe(1_200_000);
    expect(nextAttemptDelayMs('TRANSIENT_FAILURE', 3, config)).toBe(2_400_000);
    expect(nextAttemptDelayMs('TRANSIENT_FAILURE', 4, config)).toBe(3_600_000);
    // Plafonné : dix échecs de plus n'endorment pas le rail pour la journée.
    expect(nextAttemptDelayMs('TRANSIENT_FAILURE', 14, config)).toBe(3_600_000);
    expect(nextAttemptDelayMs('HEALTHY', 9, config)).toBe(300_000);
  });

  it('le recul est déterministe : aucun aléa, deux runtimes attendent la même chose', () => {
    const config = makeConfig();
    const first = decideInboundTick({
      state: state({ lastTerminal: terminal({ status: 'FAILED', sessionState: 'UNKNOWN' }), consecutiveFailures: 3 }),
      config,
      now: new Date('2026-08-15T00:01:00Z'),
    });
    const second = decideInboundTick({
      state: state({ lastTerminal: terminal({ status: 'FAILED', sessionState: 'UNKNOWN' }), consecutiveFailures: 3 }),
      config,
      now: new Date('2026-08-15T00:01:00Z'),
    });
    expect(first.verdict).toBe('BACKOFF');
    expect(first.nextAttemptAt?.toISOString()).toBe(second.nextAttemptAt?.toISOString());
  });

  it('un recul écoulé rend la main : le rail n’est jamais définitivement arrêté', () => {
    const poll = terminal({ status: 'FAILED', sessionState: 'LOGIN_REQUIRED', inboxReadability: 'INBOX_UNREADABLE' });
    const decision = decideInboundTick({
      state: state({ lastTerminal: poll, consecutiveFailures: 5 }),
      config: makeConfig(),
      now: new Date(poll.finishedAt.getTime() + 1_800_001),
    });
    // Revérifier n'est pas contourner : un humain a pu refaire la session.
    expect(decision.verdict).toBe('POLL');
  });

  it('les échecs consécutifs se comptent depuis le plus récent, et un succès remet à zéro', () => {
    const failure = terminal({ status: 'FAILED', inboxReadability: 'INBOX_UNREADABLE' });
    expect(countConsecutiveFailures([failure, failure, terminal(), failure])).toBe(2);
    expect(countConsecutiveFailures([terminal(), failure])).toBe(0);
    expect(countConsecutiveFailures([])).toBe(0);
  });

  it('un runtime désarmé ne décide rien d’autre que « désarmé »', () => {
    const decision = decideInboundTick({
      state: state(),
      config: makeConfig({ enabled: false }),
      now: new Date('2026-08-15T03:00:00+02:00'),
    });
    expect(decision.verdict).toBe('RUNTIME_DISABLED');
  });

  it('sans compte nommé, aucun compte n’est deviné', () => {
    const decision = decideInboundTick({
      state: state(),
      config: makeConfig({ accountHandle: null }),
      now: new Date('2026-08-15T03:00:00+02:00'),
    });
    expect(decision.verdict).toBe('NO_ACCOUNT');
    expect(decision.needsHuman).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. La taxonomie des issues
// ---------------------------------------------------------------------------

describe('IG5.2A §5 — la taxonomie ne transforme jamais une panne en boîte vide', () => {
  it('une boîte illisible rend INBOX_UNREADABLE, pas SUCCESS à zéro message', () => {
    const outcome = classifyCollectReport(
      report({ readability: 'INBOX_UNREADABLE', rowsSeen: 0, threadsRead: 0, messagesObserved: 0, ingested: 0 }),
    );
    expect(outcome).toBe('INBOX_UNREADABLE');
    expect(outcome).not.toBe('SUCCESS');
  });

  it('une session à refaire rend LOGIN_REQUIRED, et devance la lisibilité', () => {
    expect(classifyCollectReport(report({ sessionState: 'LOGIN_REQUIRED', readability: 'INBOX_UNREADABLE' }))).toBe(
      'LOGIN_REQUIRED',
    );
    expect(classifyCollectReport(report({ sessionState: 'SESSION_EXPIRED', readability: 'INBOX_UNREADABLE' }))).toBe(
      'LOGIN_REQUIRED',
    );
  });

  for (const sessionState of ['CHALLENGE', 'CAPTCHA', 'BLOCKED'] as const) {
    it(`${sessionState} rend SESSION_BLOCKED — arrêt franc`, () => {
      expect(classifyCollectReport(report({ sessionState, readability: 'INBOX_UNREADABLE' }))).toBe('SESSION_BLOCKED');
    });
  }

  it('une boîte lue dont aucun fil ouvert n’a été compris rend PARSE_FAILURE', () => {
    expect(classifyCollectReport(report({ rowsSeen: 3, threadsRead: 0, threadsUnreadable: 3 }))).toBe('PARSE_FAILURE');
  });

  it('une récolte tronquée ou une direction indécidable rend PARTIAL_OBSERVATION', () => {
    expect(classifyCollectReport(report({ truncatedThreads: 1 }))).toBe('PARTIAL_OBSERVATION');
    expect(classifyCollectReport(report({ unknownDirectionSkipped: 1 }))).toBe('PARTIAL_OBSERVATION');
    expect(classifyCollectReport(report({ rowsSeen: 2, threadsRead: 0, threadsNotOpened: 2 }))).toBe(
      'PARTIAL_OBSERVATION',
    );
  });

  it('une boîte vide et bien lue est un SUCCESS, et se distingue de tout ce qui précède', () => {
    expect(
      classifyCollectReport(report({ rowsSeen: 0, threadsRead: 0, messagesObserved: 0, ingested: 0 })),
    ).toBe('SUCCESS');
  });

  it('les exceptions sont NOMMÉES : file prise, écriture ratée, navigateur mort', () => {
    expect(classifyCollectError(new InstagramInboundError('IG_INBOUND_POLL_RUNNING', 'x'))).toBe(
      'POLL_ALREADY_RUNNING',
    );
    expect(classifyCollectError(new InstagramInboundError('IG_INBOUND_POLL_LOST', 'x'))).toBe('PERSIST_FAILURE');
    expect(classifyCollectError(new InstagramInboundError('IG_INBOUND_PERSIST_FAILED', 'x'))).toBe('PERSIST_FAILURE');
    expect(classifyCollectError(new Error('Target page, context or browser has been closed'))).toBe('BROWSER_FAILURE');
  });

  it('seules deux issues réclament un humain', () => {
    expect([...HUMAN_REQUIRED_OUTCOMES].sort()).toEqual(['LOGIN_REQUIRED', 'SESSION_BLOCKED']);
  });
});

// ---------------------------------------------------------------------------
// 5. Lecture seule — non-régression, à l'identique du rail IG5.1
// ---------------------------------------------------------------------------

describe('IG5.2A §7 — le runtime n’a aucune capacité d’action', () => {
  const guard = (operation: string): ReturnType<typeof classifyAdjudicationRequest> =>
    classifyAdjudicationRequest({
      url: 'https://www.instagram.com/api/graphql',
      method: 'POST',
      postData: `fb_api_req_friendly_name=${operation}&doc_id=1&variables={}&mutation=1`,
    });

  it('IGDirectTextSendMutation → DENY sous la garde du rail entrant', () => {
    const decision = guard('IGDirectTextSendMutation');
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe('graphql_effect');
  });

  it('useIGDMarkThreadAsReadMutation → DENY', () => {
    expect(guard('useIGDMarkThreadAsReadMutation').allowed).toBe(false);
  });

  it('useIGDMarkThreadAsReadValidationMutation → DENY', () => {
    expect(guard('useIGDMarkThreadAsReadValidationMutation').allowed).toBe(false);
  });

  it('une mutation INCONNUE est refusée — la garde n’a pas de liste de mutations tolérées', () => {
    // IG5 R4 §6 : la relève devient continue, donc la question n'est plus
    // « ces trois mutations sont-elles bloquées » mais « qu'est-ce qui passe ».
    // Le nom n'entre dans aucune décision : ce qui est refusé, c'est le fait
    // d'être une mutation. Un nom qu'Instagram n'a pas encore inventé est donc
    // déjà refusé aujourd'hui.
    for (const operation of [
      'MutationQueQuelquUnInventeraDemain',
      'IGDirectThreadReactionMutation',
      'PolarisFollowMutation',
      'IGDirectTextSendMutationV2',
      'useIGDMarkThreadAsReadMutationNext',
    ]) {
      const decision = guard(operation);
      expect(`${operation}:${String(decision.allowed)}`).toBe(`${operation}:false`);
      expect(decision.rule).toBe('graphql_effect');
    }
  });

  it('un POST vers un chemin de messagerie est refusé sans même être nommé', () => {
    const decision = classifyAdjudicationRequest({
      url: 'https://www.instagram.com/direct/t/17999/',
      method: 'POST',
      postData: null,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe('effect_path');
  });

  it('le rail entrant simulé n’expose aucune méthode d’action', () => {
    const rail = new FakeInstagramInboundRail([{ accountHandle: ACCOUNT, threads: [] }]);
    expect(forbiddenMethodsOn(rail)).toEqual([]);
    expect(hasSendPrimitive(rail)).toBe(false);
  });

  it('un rail qui saurait envoyer fait ÉCHOUER le tour, il ne l’exécute pas en silence', async () => {
    class RailWithSend extends FakeInstagramInboundRail {
      async sendFirstTouchDm(): Promise<never> {
        throw new Error('jamais appelé');
      }
    }
    const rail = new RailWithSend([{ accountHandle: ACCOUNT, threads: [] }]);
    expect(forbiddenMethodsOn(rail)).toContain('sendFirstTouchDm');
    expect(hasSendPrimitive(rail)).toBe(true);

    const result = await runInboundTick(
      sql,
      { railFactory: () => rail as unknown as InstagramInboundRail, polledBy: 'test', logger },
      makeConfig(),
    );
    expect(result.outcome).toBe('BROWSER_FAILURE');
    expect(result.failureDetail).toContain('sendFirstTouchDm');
    // Et surtout : aucun tour n'a été ouvert, donc rien n'a été lu.
    expect(result.pollId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hermes-ig5-runtime-'));
  sql = await createPgliteSql(dir);
  await migrate(sql);
  const rows = await sql.query<{ id: string }>(
    `insert into campaigns (slug, name, niche_key, config) values ($1,$2,$3,$4) returning id`,
    ['example-ig5-runtime-test', 'Test', 'example-services', '{}'],
  );
  campaignId = rows[0]!.id;
});

afterAll(async () => {
  await sql.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await sql.exec('truncate table prospects, r6b_batches, ig_inbound_polls, do_not_contact cascade');
});

/** Un prospect réellement contacté sur Instagram : manifeste verrouillé + outreach_event. */
async function contacted(handle = HANDLE, text = FIRST_TOUCH): Promise<string> {
  const prospect = await sql.query<{ id: string }>(
    `insert into prospects (campaign_id, canonical_key, display_name, instagram_handle, website_url, score, score_band)
     values ($1,$2,'ATELIER TEST',$3,'https://example.com',74,'A') returning id`,
    [campaignId, `prospect-${handle}-${Math.random()}`, handle],
  );
  const prospectId = prospect[0]!.id;
  await sql.query(
    `insert into prospect_evidence (prospect_id, field, value_text, provider, method, source_url, confidence)
     values ($1,'instagram_handle',$2,'website','crawl','https://example.com',1.0)`,
    [prospectId, handle],
  );
  const batch = await sql.query<{ id: string }>(
    `insert into r6b_batches (slug, campaign_id) values ($1,$2) returning id`,
    [`batch-${Math.random()}`, campaignId],
  );
  const item = await sql.query<{ id: string }>(
    `insert into r6b_batch_items (batch_id, prospect_id, item_index, original_draft, contact_channels)
     values ($1,$2,1,'brouillon',$3) returning id`,
    [batch[0]!.id, prospectId, JSON.stringify(['instagram'])],
  );
  await castR6bVote(sql, { itemId: item[0]!.id, verdict: 'SEND', approvedText: text, note: null });
  await makeProspectInstagramEligible(sql, prospectId);
  const manifest = await lockManifestForItem(sql, { itemId: item[0]!.id, transport: 'instagram_dm' });
  await sql.query(
    `insert into outreach_events (prospect_id, kind, channel, payload, manifest_id, occurred_at)
     values ($1,'sent','instagram_dm','{}'::jsonb,$2,'2026-08-14T09:00:00Z')`,
    [manifest.prospectId, manifest.id],
  );
  return manifest.prospectId;
}

function makeRouter(script: { classify?: unknown; draft?: unknown }): ModelRouter {
  const provider: LlmProvider = {
    name: 'codex',
    availability: () => ({ ok: true }),
    generate: async (request) => {
      if (script.classify === undefined && script.draft === undefined) {
        throw new LlmError(`aucun script pour ${request.task}`, 'provider_error');
      }
      return { text: JSON.stringify(turnAnswer(script.classify, script.draft)) };
    },
  };
  return new ModelRouter({ sql, logger, providers: { codex: provider } });
}

const INTERESTED = {
  category: 'INTERESTED',
  confidence: 0.93,
  reasoning_summary: 'réponse classée INTERESTED sur la base du texte reçu.',
  evidence_excerpts: [],
};
const DRAFT_ANSWER = {
  body: 'Merci pour votre retour, je vous propose un échange court quand cela vous arrange.',
  rationale: 'Réponse courte, sans chiffre ni promesse.',
  used_facts: [],
};

function railFor(threads: readonly ReturnType<typeof makeThread>[], overrides: Record<string, unknown> = {}) {
  return (): InstagramInboundRail =>
    new FakeInstagramInboundRail([{ accountHandle: ACCOUNT, threads, ...overrides }]);
}

// ---------------------------------------------------------------------------
// 6. Un tour complet, sur une vraie base
// ---------------------------------------------------------------------------

describe('IG5.2A §4/§8 — un tour : propriété, observation, ingestion, aval', () => {
  it('un tour dû relève, ingère, puis fait tourner l’aval jusqu’au brouillon PROPOSED', async () => {
    await contacted();
    const thread = makeThread({
      threadId: '111',
      counterpartyHandle: HANDLE,
      messages: [message(FIRST_TOUCH, 'OUTGOING', 0), message('Oui je suis intéressé', 'INCOMING', 1)],
    });
    const router = makeRouter({ classify: INTERESTED, draft: DRAFT_ANSWER });

    const tick = await runInboundTick(
      sql,
      {
        railFactory: railFor([thread]),
        polledBy: 'test:runtime',
        logger,
        downstream: createReplyProcessingStep(router, { limit: 50, crm: NO_CRM }),
      },
      makeConfig(),
    );

    expect(tick.decision.verdict).toBe('POLL');
    expect(tick.outcome).toBe('SUCCESS');
    expect(tick.report?.ingested).toBe(1);
    expect(tick.downstream?.classified).toBe(1);
    expect(tick.downstream?.drafted).toBe(1);

    // Le brouillon existe et n'est rien d'autre qu'une proposition.
    const drafts = await sql.query<{ status: string }>(`select status from r6b_reply_drafts`);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.status).toBe('PROPOSED');

    // Le tour est TERMINAL : pas de RUNNING abandonné.
    const polls = await sql.query<{ status: string; finishedAt: string | null }>(
      `select status, finished_at as "finishedAt" from ig_inbound_polls`,
    );
    expect(polls).toHaveLength(1);
    expect(polls[0]!.status).toBe('COMPLETED');
    expect(polls[0]!.finishedAt).not.toBeNull();
  });

  it('un tour non dû n’ouvre aucun navigateur et n’écrit aucune ligne', async () => {
    const first = await runInboundTick(
      sql,
      { railFactory: railFor([]), polledBy: 'test', logger },
      makeConfig(),
    );
    expect(first.decision.verdict).toBe('POLL');

    const second = await runInboundTick(
      sql,
      { railFactory: railFor([]), polledBy: 'test', logger },
      makeConfig(),
    );
    expect(second.decision.verdict).toBe('NOT_DUE');
    expect(second.outcome).toBe('SKIPPED');
    expect(second.pollId).toBeNull();

    const polls = await sql.query<{ n: string }>(`select count(*) as n from ig_inbound_polls`);
    expect(Number(polls[0]!.n)).toBe(1);
  });

  it('un second collecteur ne fait PAS un second balayage tant que le bail court', async () => {
    // Le premier tour est ouvert et jamais fermé : c'est exactement l'état d'un
    // collecteur en train de relever.
    const pollId = await openInboundPoll(sql, { accountHandle: ACCOUNT, polledBy: 'collecteur-A', leaseMs: 300_000 });

    const tick = await runInboundTick(
      sql,
      { railFactory: railFor([]), polledBy: 'collecteur-B', logger },
      makeConfig(),
    );

    expect(tick.decision.verdict).toBe('POLL_ALREADY_RUNNING');
    expect(tick.decision.reason).toContain('collecteur-A');
    expect(tick.pollId).toBeNull();

    // Aucun second tour n'a été ouvert : la ligne de A est toujours seule.
    const polls = await sql.query<{ id: string }>(`select id from ig_inbound_polls`);
    expect(polls.map((row) => row.id)).toEqual([pollId]);
  });

  it('la boîte illisible n’est jamais rapportée comme une boîte vide', async () => {
    const tick = await runInboundTick(
      sql,
      {
        railFactory: railFor([], { readability: 'INBOX_UNREADABLE', stopReason: 'aucune ligne comprise' }),
        polledBy: 'test',
        logger,
      },
      makeConfig(),
    );

    expect(tick.outcome).toBe('INBOX_UNREADABLE');
    expect(tick.failureDetail).not.toBeNull();

    // Et la cadence en tient compte : le tour suivant recule au lieu de revenir
    // dans cinq minutes.
    const after = await loadInboundRuntimeState(sql, ACCOUNT);
    expect(after.consecutiveFailures).toBe(1);
    expect(after.lastSuccessful).toBeNull();
    const decision = decideInboundTick({
      state: after,
      config: makeConfig(),
      now: new Date(after.lastTerminal!.finishedAt.getTime() + 300_001),
    });
    expect(decision.verdict).toBe('BACKOFF');
  });

  it('une session à refaire remonte comme telle, et réclame un humain', async () => {
    const tick = await runInboundTick(
      sql,
      {
        railFactory: railFor([], { sessionState: 'LOGIN_REQUIRED', readability: 'INBOX_UNREADABLE' }),
        polledBy: 'test',
        logger,
      },
      makeConfig(),
    );
    expect(tick.outcome).toBe('LOGIN_REQUIRED');
    expect(tick.needsHuman).toBe(true);

    const status = await loadInboundRuntimeStatus(sql, makeConfig(), new Date());
    expect(status.decision.verdict).toBe('AWAITING_HUMAN');
    expect(status.decision.needsHuman).toBe(true);
    expect(status.state?.lastSuccessful).toBeNull();
  });

  it('un navigateur qui meurt clôt le tour en FAILED — aucun RUNNING abandonné', async () => {
    const tick = await runInboundTick(
      sql,
      {
        railFactory: (): InstagramInboundRail => ({
          ensureSession: async () => ({ state: 'SESSION_READY' as const, detail: 'x' }),
          observeInbox: async () => {
            throw new Error('Target page, context or browser has been closed');
          },
          close: async () => undefined,
        }),
        polledBy: 'test',
        logger,
      },
      makeConfig(),
    );

    expect(tick.outcome).toBe('BROWSER_FAILURE');
    const polls = await sql.query<{ status: string; finishedAt: string | null }>(
      `select status, finished_at as "finishedAt" from ig_inbound_polls`,
    );
    expect(polls).toHaveLength(1);
    expect(polls[0]!.status).toBe('FAILED');
    expect(polls[0]!.finishedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Reprise — les points de crash, un par un
// ---------------------------------------------------------------------------

describe('IG5.2A §9 — rejeu et reprise après interruption', () => {
  it('un tour rejoué à l’identique ne crée aucun doublon', async () => {
    await contacted();
    const thread = makeThread({
      threadId: '111',
      counterpartyHandle: HANDLE,
      messages: [message('Oui je suis intéressé', 'INCOMING')],
    });
    const config = makeConfig();

    const first = await runInboundTick(sql, { railFactory: railFor([thread]), polledBy: 't', logger }, config);
    // Le second tour est FORCÉ (cadence ignorée) en le rendant dû : c'est le cas
    // « la boîte n'a pas bougé », qui doit dédupliquer.
    await sql.query(`update ig_inbound_polls set finished_at = finished_at - interval '1 hour'`);
    const second = await runInboundTick(sql, { railFactory: railFor([thread]), polledBy: 't', logger }, config);

    expect(first.report?.ingested).toBe(1);
    expect(second.report?.ingested).toBe(0);
    expect(second.report?.alreadyKnown).toBe(1);

    const rows = await sql.query<{ n: string }>(
      `select count(*) as n from r6b_inbound_messages where provider = 'instagram'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('crash APRÈS ingestion : le tour orphelin est clos, sans réécrire son histoire, et rien n’est ingéré deux fois', async () => {
    await contacted();
    const text = 'Oui je suis intéressé';

    // L'état exact que laisse un collecteur tué : un tour RUNNING, une réponse
    // déjà écrite sous lui, et un bail qui va expirer.
    const orphan = await openInboundPoll(sql, { accountHandle: ACCOUNT, polledBy: 'collecteur-mort', leaseMs: 30_000 });
    const fingerprint = instagramMessageFingerprint({
      accountHandle: ACCOUNT,
      threadId: '111',
      senderHandle: HANDLE,
      occurrenceIndex: 0,
      text,
    });
    await persistInstagramInboundMessage(sql, {
      accountHandle: ACCOUNT,
      threadId: '111',
      senderHandle: HANDLE,
      fingerprint,
      receivedAt: new Date('2026-08-15T08:00:00Z'),
      bodyText: text,
      bodySha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      correlation: {
        status: 'UNMATCHED',
        method: null,
        manifestId: null,
        outreachEventId: null,
        prospectId: null,
        evidence: {
          channel: 'instagram' as const,
          threadId: '111',
          senderHandle: HANDLE,
          accountHandle: ACCOUNT,
          threadBindings: [],
          handleCandidates: [],
          priorSendCount: 0,
          observation: {
            directionBasis: 'geometry' as const,
            occurrenceIndex: 0,
            receivedAtBasis: 'observed_at' as const,
            rowAgeMs: null,
            providerMessageId: null,
          },
          notes: ['crash simulé, avant la corrélation'],
        },
      },
    });
    await sql.query(`update ig_inbound_polls set lease_expires_at = now() - interval '1 minute' where id = $1`, [
      orphan,
    ]);

    const thread = makeThread({
      threadId: '111',
      counterpartyHandle: HANDLE,
      messages: [message(text, 'INCOMING')],
    });
    const tick = await runInboundTick(sql, { railFactory: railFor([thread]), polledBy: 'repreneur', logger }, makeConfig());

    // Le tour reprend, et voit la réponse comme DÉJÀ CONNUE.
    expect(tick.outcome).toBe('SUCCESS');
    expect(tick.report?.ingested).toBe(0);
    expect(tick.report?.alreadyKnown).toBe(1);

    const rows = await sql.query<{ n: string }>(
      `select count(*) as n from r6b_inbound_messages where provider = 'instagram'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);

    // L'ANCIEN tour n'est pas réécrit : il est clos comme ce qu'il est, un tour
    // dont le bail a expiré, et ses compteurs restent ceux qu'il avait.
    const old = await sql.query<{ status: string; detail: string | null; threadsRead: number }>(
      `select status, detail, threads_read as "threadsRead" from ig_inbound_polls where id = $1`,
      [orphan],
    );
    expect(old[0]!.status).toBe('FAILED');
    expect(old[0]!.detail).toContain('bail expiré');
    expect(old[0]!.threadsRead).toBe(0);

    // Et le nouveau tour est une LIGNE NOUVELLE, pas l'ancienne recyclée.
    expect(tick.pollId).not.toBe(orphan);
  });

  it('crash APRÈS r6b_inbound_messages : la classification est reprise, une seule fois', async () => {
    await contacted();
    const thread = makeThread({
      threadId: '111',
      counterpartyHandle: HANDLE,
      messages: [message(FIRST_TOUCH, 'OUTGOING', 0), message('Oui je suis intéressé', 'INCOMING', 1)],
    });

    // Tour 1 SANS aval : c'est le crash entre l'ingestion et la classification.
    const ingestOnly = await runInboundTick(sql, { railFactory: railFor([thread]), polledBy: 't', logger }, makeConfig());
    expect(ingestOnly.report?.ingested).toBe(1);
    expect(ingestOnly.downstream).toBeNull();

    const before = await loadInboundRuntimeStatus(sql, makeConfig(), new Date());
    expect(before.backlog.unprocessed).toBe(1);
    expect(before.backlog.classified).toBe(0);

    // Tour 2 avec aval : la réponse en retard est rattrapée sans avoir été
    // relevée à nouveau — c'est le point de §8.
    const router = makeRouter({ classify: INTERESTED, draft: DRAFT_ANSWER });
    await sql.query(`update ig_inbound_polls set finished_at = finished_at - interval '1 hour'`);
    const resumed = await runInboundTick(
      sql,
      {
        railFactory: railFor([thread]),
        polledBy: 't',
        logger,
        downstream: createReplyProcessingStep(router, { limit: 50, crm: NO_CRM }),
      },
      makeConfig(),
    );
    expect(resumed.downstream?.classified).toBe(1);

    const after = await loadInboundRuntimeStatus(sql, makeConfig(), new Date());
    expect(after.backlog.unprocessed).toBe(0);
    expect(after.backlog.classified).toBe(1);
    expect(after.backlog.drafted).toBe(1);
  });

  it('crash APRÈS transition et APRÈS brouillon : aucun second arrêt, aucun second brouillon', async () => {
    const prospectId = await contacted();
    const thread = makeThread({
      threadId: '111',
      counterpartyHandle: HANDLE,
      messages: [message(FIRST_TOUCH, 'OUTGOING', 0), message('Oui je suis intéressé', 'INCOMING', 1)],
    });
    const router = makeRouter({ classify: INTERESTED, draft: DRAFT_ANSWER });
    const downstream = createReplyProcessingStep(router, { limit: 50, crm: NO_CRM });
    const config = makeConfig();

    await runInboundTick(sql, { railFactory: railFor([thread]), polledBy: 't', logger, downstream }, config);

    const snapshot = async (): Promise<Record<string, number>> => {
      const rows = await sql.query<{ analyses: string; drafts: string; transitions: string; state: string | null }>(
        `select (select count(*)::text from r6b_reply_analyses)                    as analyses,
                (select count(*)::text from r6b_reply_drafts)                      as drafts,
                (select count(*)::text from r6b_prospect_state_transitions)        as transitions,
                (select state from r6b_prospect_outreach_states where prospect_id = $1) as state`,
        [prospectId],
      );
      return {
        analyses: Number(rows[0]!.analyses),
        drafts: Number(rows[0]!.drafts),
        transitions: Number(rows[0]!.transitions),
      };
    };

    const first = await snapshot();
    expect(first.analyses).toBe(1);
    expect(first.drafts).toBe(1);

    // Deux reprises de plus. Le runtime repasse `includeAnalyzed`, donc il
    // RELIT ce dossier à chaque tour : c'est précisément ce qui doit être
    // gratuit.
    for (let i = 0; i < 2; i += 1) {
      await sql.query(`update ig_inbound_polls set finished_at = finished_at - interval '1 hour'`);
      const again = await runInboundTick(
        sql,
        { railFactory: railFor([thread]), polledBy: 't', logger, downstream },
        config,
      );
      expect(again.downstream?.classified).toBe(0);
      expect(again.downstream?.drafted).toBe(0);
    }

    expect(await snapshot()).toEqual(first);
  });

  it('un aval en panne ne perd pas la relève, et n’arrête pas le runtime', async () => {
    await contacted();
    const thread = makeThread({
      threadId: '111',
      counterpartyHandle: HANDLE,
      messages: [message('Oui je suis intéressé', 'INCOMING')],
    });

    const tick = await runInboundTick(
      sql,
      {
        railFactory: railFor([thread]),
        polledBy: 't',
        logger,
        downstream: async () => {
          throw new Error('modèle indisponible');
        },
      },
      makeConfig(),
    );

    // La relève a abouti, l'aval est signalé en échec, et la réponse reste en
    // retard — donc rattrapable.
    expect(tick.outcome).toBe('SUCCESS');
    expect(tick.report?.ingested).toBe(1);
    expect(tick.downstream?.failures).toBe(1);
    expect(tick.downstream?.detail).toContain('modèle indisponible');

    const status = await loadInboundRuntimeStatus(sql, makeConfig(), new Date());
    expect(status.backlog.unprocessed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. La boucle
// ---------------------------------------------------------------------------

describe('IG5.2A §3/§6 — la boucle : cadence tenue, aucun busy-wait, arrêt gracieux', () => {
  it('deux tours consécutifs : le premier relève, le second attend l’intervalle', async () => {
    const sleeps: number[] = [];
    const report = await runInboundRuntimeLoop(
      sql,
      {
        railFactory: railFor([]),
        polledBy: 'boucle',
        logger,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      makeConfig(),
      { maxTicks: 2 },
    );

    expect(report.ticks).toHaveLength(2);
    expect(report.ticks[0]!.decision.verdict).toBe('POLL');
    expect(report.ticks[1]!.decision.verdict).toBe('NOT_DUE');
    expect(report.stoppedBy).toBe('MAX_TICKS');
    expect(report.polls).toBe(1);

    // Aucune itération à vide : même quand la décision rend 0, la boucle
    // s'endort au moins le plancher.
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(MIN_TICK_SPACING_MS);
  });

  it('l’attente vient de la décision : après un échec, elle vaut le recul', async () => {
    const sleeps: number[] = [];
    await runInboundRuntimeLoop(
      sql,
      {
        railFactory: railFor([], { readability: 'INBOX_UNREADABLE' }),
        polledBy: 'boucle',
        logger,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      makeConfig(),
      { maxTicks: 3 },
    );

    // Tour 1 : relève ratée. Tour 2 : recul (10 min). Tour 3 : recul encore.
    // La valeur exacte dépend de l'instant réel de fin de tour, donc on borne
    // plutôt qu'on n'égale — mais l'ordre de grandeur, lui, est vérifié.
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    const last = sleeps[sleeps.length - 1]!;
    expect(last).toBeGreaterThan(500_000);
    expect(last).toBeLessThanOrEqual(600_000);
  });

  it('un SIGTERM pendant l’attente arrête la boucle après le tour en cours', async () => {
    const controller = new AbortController();
    const report = await runInboundRuntimeLoop(
      sql,
      {
        railFactory: railFor([]),
        polledBy: 'boucle',
        logger,
        signal: controller.signal,
        sleep: async () => {
          controller.abort();
        },
      },
      makeConfig(),
      { maxTicks: 10 },
    );

    expect(report.stoppedBy).toBe('ABORTED');
    expect(report.ticks).toHaveLength(1);
    // Le tour commencé est allé au bout : il n'a aucun effet externe à
    // interrompre, et l'abandonner laisserait une ligne RUNNING de plus.
    const polls = await sql.query<{ status: string }>(`select status from ig_inbound_polls`);
    expect(polls.map((row) => row.status)).toEqual(['COMPLETED']);
  });

  it('un runtime désarmé sort tout de suite, sans ouvrir de tour', async () => {
    // IG5 R4 §9.1 — « aucune requête Instagram » se prouve à la source : le
    // rail n'est jamais CONSTRUIT. Compter zéro tour en base ne dirait que
    // « rien n'a été écrit » ; un navigateur ouvert puis refermé aurait déjà
    // joint Instagram avec la session du compte relevé.
    let railsBuilt = 0;
    const countingFactory = (): InstagramInboundRail => {
      railsBuilt += 1;
      return new FakeInstagramInboundRail([{ accountHandle: ACCOUNT, threads: [] }]);
    };

    const report = await runInboundRuntimeLoop(
      sql,
      { railFactory: countingFactory, polledBy: 'boucle', logger, sleep: async () => undefined },
      makeConfig({ enabled: false }),
      { maxTicks: 5 },
    );
    expect(report.stoppedBy).toBe('RUNTIME_DISABLED');
    expect(report.ticks).toHaveLength(1);
    expect(report.polls).toBe(0);
    expect(railsBuilt).toBe(0);

    const polls = await sql.query<{ n: string }>(`select count(*) as n from ig_inbound_polls`);
    expect(Number(polls[0]!.n)).toBe(0);
  });

  it('IG5 R4 §9.2 — armé et nommé, la boucle relève VRAIMENT et tient sa cadence', async () => {
    // Le pendant du test précédent, et le seul qui décrive ce que R4 met en
    // service : un runtime armé, un compte nommé, et une boucle qui ouvre un
    // tour puis attend l'intervalle plutôt que d'enchaîner.
    const waits: number[] = [];
    const report = await runInboundRuntimeLoop(
      sql,
      {
        railFactory: railFor([]),
        polledBy: 'launchd',
        logger,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
      makeConfig({ enabled: true, accountHandle: ACCOUNT }),
      { maxTicks: 2 },
    );

    expect(report.stoppedBy).toBe('MAX_TICKS');
    expect(report.polls).toBe(1);
    expect(report.ticks[0]?.outcome).toBe('SUCCESS');
    // Le second tour n'ouvre rien : il constate que le premier vient de finir.
    expect(report.ticks[1]?.decision.verdict).toBe('NOT_DUE');
    // Et l'attente est celle de la configuration, pas une constante du code.
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[0]).toBeLessThanOrEqual(300_000);

    const polls = await sql.query<{ n: string; status: string }>(
      `select count(*)::text as n, max(status) as status from ig_inbound_polls`,
    );
    expect(Number(polls[0]!.n)).toBe(1);
    expect(polls[0]!.status).toBe('COMPLETED');
  });

  it('sans compte nommé, la boucle sort plutôt que de deviner', async () => {
    const report = await runInboundRuntimeLoop(
      sql,
      { railFactory: railFor([]), polledBy: 'boucle', logger, sleep: async () => undefined },
      makeConfig({ accountHandle: null }),
      { maxTicks: 5 },
    );
    expect(report.stoppedBy).toBe('NO_ACCOUNT');
    expect(report.polls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Statut
// ---------------------------------------------------------------------------

describe('IG5.2A §10 — le statut distingue « rien » de « on ne sait pas »', () => {
  it('jamais relevé : tout est nul, et rien ne ressemble à un succès', async () => {
    const status = await loadInboundRuntimeStatus(sql, makeConfig(), new Date('2026-08-15T03:00:00+02:00'));
    expect(status.state?.lastTerminal).toBeNull();
    expect(status.state?.lastSuccessful).toBeNull();
    expect(status.decision.verdict).toBe('POLL');
    expect(status.observations.inboundMessages).toBe(0);
    expect(status.backlog.unprocessed).toBe(0);
  });

  it('un rail qui échoue en boucle a un « dernier tour » frais et AUCUN dernier succès', async () => {
    const config = makeConfig();
    await runInboundTick(sql, { railFactory: railFor([], { readability: 'INBOX_UNREADABLE' }), polledBy: 't', logger }, config);

    const status = await loadInboundRuntimeStatus(sql, config, new Date());
    expect(status.state?.lastTerminal).not.toBeNull();
    // La ligne qui empêche un statut rassurant et faux.
    expect(status.state?.lastSuccessful).toBeNull();
    expect(status.state?.consecutiveFailures).toBe(1);
  });

  it('après un tour réussi, le dernier succès existe et le compteur d’échecs retombe', async () => {
    const config = makeConfig();
    await runInboundTick(sql, { railFactory: railFor([], { readability: 'INBOX_UNREADABLE' }), polledBy: 't', logger }, config);
    await sql.query(`update ig_inbound_polls set finished_at = finished_at - interval '1 hour'`);
    await runInboundTick(sql, { railFactory: railFor([]), polledBy: 't', logger }, config);

    const status = await loadInboundRuntimeStatus(sql, config, new Date());
    expect(status.state?.lastSuccessful).not.toBeNull();
    expect(status.state?.consecutiveFailures).toBe(0);
    expect(status.decision.verdict).toBe('NOT_DUE');
  });

  it('le retard compté par le statut est celui que l’aval ira chercher', async () => {
    await contacted();
    const thread = makeThread({
      threadId: '111',
      counterpartyHandle: HANDLE,
      messages: [message(FIRST_TOUCH, 'OUTGOING', 0), message('Oui je suis intéressé', 'INCOMING', 1)],
    });
    await runInboundTick(sql, { railFactory: railFor([thread]), polledBy: 't', logger }, makeConfig());

    const status = await loadInboundRuntimeStatus(sql, makeConfig(), new Date());
    expect(status.observations.inboundMessages).toBe(1);
    expect(status.observations.correlated).toBe(1);
    expect(status.backlog.unprocessed).toBe(1);
    expect(status.backlog.classified).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Le PROFIL NAVIGATEUR partagé avec le worker sortant
// ---------------------------------------------------------------------------

/**
 * IG5 + HERMES — les deux rails, une seule session Instagram.
 *
 * La relève entrante et le worker sortant lisent le même `session.profileDir`.
 * Le rail refuse d'ouvrir Chromium sur un profil déjà tenu ; ce qui est éprouvé
 * ici, c'est ce que le TOUR fait de ce refus : renoncer avant d'ouvrir sa ligne
 * de relève, donc sans inscrire d'échec, sans ralentir la cadence, et sans
 * qu'un humain ait à intervenir.
 */
describe('profil navigateur partagé avec le rail sortant', () => {
  let profileDir: string;

  beforeEach(() => {
    profileDir = join(mkdtempSync(join(tmpdir(), 'ig-inbound-profile-')), 'profile');
  });

  /** Le worker sortant, simulé par ce qu'il laisse : un bail nommant un autre processus vivant. */
  function outboundHoldsProfile(): () => void {
    const file = instagramBrowserLeasePath(profileDir);
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        pid: 1,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
        cmd: 'ig:autonomous:worker --loop',
      }),
    );
    return () => rmSync(file, { force: true });
  }

  it('profil occupé : aucun rail fabriqué, aucune ligne de relève, aucun échec', async () => {
    await contacted();
    const thread = makeThread({
      threadId: '111',
      counterpartyHandle: HANDLE,
      messages: [message('Oui je suis intéressé', 'INCOMING')],
    });

    let railsBuilt = 0;
    const release = outboundHoldsProfile();
    try {
      const tick = await runInboundTick(
        sql,
        {
          profileDir,
          railFactory: () => {
            railsBuilt += 1;
            return railFor([thread])();
          },
          polledBy: 't',
          logger,
        },
        makeConfig(),
      );

      expect(tick.outcome).toBe('BROWSER_PROFILE_BUSY');
      // La décision, elle, disait bien « relève » : ce n'est pas la cadence qui
      // a refusé, c'est la ressource qui manquait.
      expect(tick.decision.verdict).toBe('POLL');
      expect(tick.pollId).toBeNull();
      expect(railsBuilt).toBe(0);
      expect(tick.needsHuman).toBe(false);
    } finally {
      release();
    }

    // Rien en base : ni tour ouvert, ni tour échoué. C'est ce qui empêche une
    // contention de faire grossir `consecutiveFailures` et donc le recul.
    const polls = await sql.query<{ n: string }>(`select count(*) as n from ig_inbound_polls`);
    expect(Number(polls[0]!.n)).toBe(0);
    const state = await loadInboundRuntimeState(sql, ACCOUNT);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastTerminal).toBeNull();
  });

  it('l’aval tourne QUAND MÊME : une réponse déjà persistée n’attend pas le profil', async () => {
    // L'invariant de ce fichier : l'aval ne dépend pas de la réussite de la
    // relève. Un profil occupé ne doit pas devenir la seule situation où une
    // réponse déjà écrite reste non classée.
    await contacted();
    let downstreamCalls = 0;
    const release = outboundHoldsProfile();
    try {
      const tick = await runInboundTick(
        sql,
        {
          profileDir,
          railFactory: railFor([]),
          polledBy: 't',
          logger,
          downstream: async () => {
            downstreamCalls += 1;
            return Object.freeze({
              candidates: 0,
              classified: 0,
              drafted: 0,
              absorbed: 0,
              failures: 0,
              detail: 'rien à faire',
            });
          },
        },
        makeConfig(),
      );
      expect(tick.outcome).toBe('BROWSER_PROFILE_BUSY');
      expect(downstreamCalls).toBe(1);
    } finally {
      release();
    }
  });

  it('le profil rendu, le tour suivant relève normalement', async () => {
    await contacted();
    const thread = makeThread({
      threadId: '111',
      counterpartyHandle: HANDLE,
      messages: [message('Oui je suis intéressé', 'INCOMING')],
    });
    const config = makeConfig();

    const release = outboundHoldsProfile();
    const blocked = await runInboundTick(
      sql,
      { profileDir, railFactory: railFor([thread]), polledBy: 't', logger },
      config,
    );
    expect(blocked.outcome).toBe('BROWSER_PROFILE_BUSY');

    release();

    const passed = await runInboundTick(
      sql,
      { profileDir, railFactory: railFor([thread]), polledBy: 't', logger },
      config,
    );
    expect(passed.outcome).toBe('SUCCESS');
    expect(passed.report?.ingested).toBe(1);
    // Et le bail a été rendu : le tour ne garde pas le profil après son
    // navigateur.
    expect(inspectInstagramBrowserLease(profileDir).held).toBe(false);
  });

  it('le tour prend le bail dès le début du tour, avant même de fabriquer son rail', async () => {
    await contacted();
    const held: boolean[] = [];

    const tick = await runInboundTick(
      sql,
      {
        profileDir,
        railFactory: () => {
          // Observé DEPUIS la fabrique : à cet instant, le tour tient déjà le
          // profil, donc le worker sortant ne peut plus l'ouvrir.
          held.push(inspectInstagramBrowserLease(profileDir).held);
          return railFor([])();
        },
        polledBy: 't',
        logger,
      },
      makeConfig(),
    );

    expect(held).toEqual([true]);
    expect(tick.outcome).not.toBe('BROWSER_PROFILE_BUSY');
    // Rendu à la fin du tour : le profil n'est pas gardé entre deux relèves.
    expect(inspectInstagramBrowserLease(profileDir).held).toBe(false);
  });

  it('une fabrique de rail qui REFUSE ne garde pas le profil en otage', async () => {
    // La fabrique lève quand le rail qu'on lui confie expose une capacité
    // d'action : ce refus doit rester bruyant, il ne se classe pas en issue de
    // tour. Mais il ne doit pas non plus laisser le profil réputé occupé pour
    // toujours — le worker sortant attendrait alors un navigateur qui n'a
    // jamais été ouvert.
    await contacted();

    await expect(
      runInboundTick(
        sql,
        {
          profileDir,
          railFactory: () => {
            throw new Error('le rail entrant expose une capacité d’action');
          },
          polledBy: 't',
          logger,
        },
        makeConfig(),
      ),
    ).rejects.toThrow('capacité d’action');

    expect(inspectInstagramBrowserLease(profileDir).held).toBe(false);
  });

  it('une contention remontée du rail est nommée, pas confondue avec une panne', () => {
    // Le filet, pour un tour auquel aucun `profileDir` n'aurait été fourni.
    expect(
      classifyCollectError(new InstagramRailError('IG_BROWSER_PROFILE_BUSY', 'profil tenu ailleurs')),
    ).toBe('BROWSER_PROFILE_BUSY');
    expect(classifyCollectError(new InstagramRailError('IG_BROWSER_LAUNCH_FAILED', 'chromium absent'))).toBe(
      'BROWSER_FAILURE',
    );
  });

  it('un profil occupé ne réveille pas la boucle chaque seconde', async () => {
    // Le tour n'a rien observé et rien écrit : la décision suivante redirait
    // « relève » indéfiniment, et le plancher d'une seconde ferait tourner la
    // boucle à vide pendant toute la relève du worker sortant.
    await contacted();
    const slept: number[] = [];
    const release = outboundHoldsProfile();
    try {
      await runInboundRuntimeLoop(
        sql,
        {
          profileDir,
          railFactory: railFor([]),
          polledBy: 't',
          logger,
          sleep: async (ms: number) => {
            slept.push(ms);
          },
        },
        makeConfig(),
        { maxTicks: 2 },
      );
    } finally {
      release();
    }

    expect(slept).toEqual([PROFILE_BUSY_RETRY_MS]);
    expect(PROFILE_BUSY_RETRY_MS).toBeGreaterThan(MIN_TICK_SPACING_MS);
  });
});

// ---------------------------------------------------------------------------
// HERMES-IDENTITY-CANONICALIZATION-R1 §6 — un compte renommé ne relit pas sa
// boîte comme si elle était neuve
// ---------------------------------------------------------------------------

describe('§6 — renommer le compte ne réingère pas ce qui a déjà été lu', () => {
  const ANCIEN = 'ancien.nom.du.compte';
  const NOUVEAU = 'nouveau.nom.du.compte';

  function unmatched(threadId: string, accountHandle: string): Parameters<
    typeof persistInstagramInboundMessage
  >[1]['correlation'] {
    return {
      status: 'UNMATCHED',
      method: null,
      manifestId: null,
      outreachEventId: null,
      prospectId: null,
      evidence: {
        channel: 'instagram' as const,
        threadId,
        senderHandle: HANDLE,
        accountHandle,
        threadBindings: [],
        handleCandidates: [],
        priorSendCount: 0,
        observation: {
          directionBasis: 'geometry' as const,
          occurrenceIndex: 0,
          receivedAtBasis: 'observed_at' as const,
          rowAgeMs: null,
          providerMessageId: null,
        },
        notes: [],
      },
    };
  }

  async function ingest(
    account: string,
    threadId: string,
    text: string,
    priorAccounts: readonly string[],
  ): Promise<{ id: string; created: boolean }> {
    const key = (handle: string): string =>
      instagramMessageFingerprint({
        accountHandle: handle,
        threadId,
        senderHandle: HANDLE,
        occurrenceIndex: 0,
        text,
      });
    return await persistInstagramInboundMessage(sql, {
      accountHandle: account,
      threadId,
      senderHandle: HANDLE,
      fingerprint: key(account),
      receivedAt: new Date('2026-08-21T12:35:31.828Z'),
      bodyText: text,
      bodySha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      correlation: unmatched(threadId, account),
      priorKeys: priorAccounts.map((handle) => ({ mailbox: handle, fingerprint: key(handle) })),
    });
  }

  it('le message relu sous le NOUVEAU nom est reconnu, pas réécrit', async () => {
    // Ce qui s'est réellement produit le 22 août 2026 : la clé d'unicité est
    // `(provider, mailbox, provider_message_id)`, `mailbox` est le nom du jour,
    // et l'empreinte elle-même est calculée à partir de lui. Renommer changeait
    // les deux, et la première relève sous le nouveau nom a réingéré ce qui
    // était déjà là — analyses et brouillons compris.
    const threadId = '424242424242';
    const text = 'bonjour, vous faites quoi exactement ?';

    const first = await ingest(ANCIEN, threadId, text, []);
    expect(first.created).toBe(true);

    const second = await ingest(NOUVEAU, threadId, text, [ANCIEN]);
    expect(second.created).toBe(false);
    // Et c'est bien LA MÊME ligne — pas une nouvelle qui lui ressemble.
    expect(second.id).toBe(first.id);

    const rows = await sql.query<{ mailbox: string }>(
      `select mailbox from r6b_inbound_messages where provider_thread_id = $1`,
      [threadId],
    );
    expect(rows).toHaveLength(1);
    // La ligne historique n'est pas réécrite : elle dit sous quel nom elle a
    // été lue, et elle continue de le dire.
    expect(rows[0]?.mailbox).toBe(ANCIEN);
  });

  it('sans ancien nom déclaré, le même message est réingéré — c’est le défaut d’avant', async () => {
    const threadId = '515151515151';
    const text = 'et vos délais, c’est quoi ?';

    expect((await ingest(ANCIEN, threadId, text, [])).created).toBe(true);
    expect((await ingest(NOUVEAU, threadId, text, [])).created).toBe(true);

    const rows = await sql.query<{ mailbox: string }>(
      `select mailbox from r6b_inbound_messages where provider_thread_id = $1 order by mailbox`,
      [threadId],
    );
    expect(rows.map((row) => row.mailbox)).toEqual([ANCIEN, NOUVEAU]);
  });

  it('un ancien nom qui n’a jamais rien lu ne fusionne rien', async () => {
    const threadId = '626262626262';
    const text = 'vous intervenez sur Bordeaux ?';

    const only = await ingest(NOUVEAU, threadId, text, ['un.nom.jamais.utilise']);
    expect(only.created).toBe(true);

    const rows = await sql.query<{ mailbox: string }>(
      `select mailbox from r6b_inbound_messages where provider_thread_id = $1`,
      [threadId],
    );
    expect(rows.map((row) => row.mailbox)).toEqual([NOUVEAU]);
  });
});
