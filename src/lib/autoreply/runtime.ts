/**
 * HERMES-AUTO-REPLY-PRODUCTION-R1 §4 — le RUNTIME durable d'auto-réponse.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module AJOUTE, et surtout ce qu'il n'ajoute pas
 * ---------------------------------------------------------------------------
 * Il n'y a pas de seconde file, pas de second ordonnanceur, pas de seconde
 * primitive d'envoi, pas de second compteur de plafonds, pas de second verrou
 * d'effet et pas de seconde preuve de remise. Tout cela existe et reste
 * PROPRIÉTAIRE de son domaine : `hermes_conversation_plans` porte les
 * intentions, `evaluateConversationEffectGate` relit toutes les portes avant le
 * clic, `reserveConversationEffectSlot` compte sous le verrou partagé,
 * `sendThreadReply` fait l'unique geste, `judgeReplyOutcome` dit s'il a produit
 * quelque chose.
 *
 * Ce module apporte exactement trois choses, et c'est tout :
 *
 *   1. une BOUCLE — `executeConversationReply` ne sait draîner qu'un plan, et
 *      `planConversationReply` n'avait qu'un appelant, le runner du canari,
 *      qui regardait UNE coquille désignée par identifiant. Il fallait
 *      quelqu'un pour choisir les conversations, une par une ;
 *
 *   2. un PÉRIMÈTRE — `assessAutoReplyEligibility`, la condition, absente
 *      jusqu'ici, sous laquelle une conversation appartient au rail autonome ;
 *
 *   3. une FRONTIÈRE — l'instant d'activation, sans lequel allumer un runtime
 *      aurait traité tout l'historique comme du travail en retard.
 *
 * ---------------------------------------------------------------------------
 * Le NAVIGATEUR n'est jamais tenu pendant une attente
 * ---------------------------------------------------------------------------
 * C'est l'idiome que `autonomousLiveWorker` porte déjà mot pour mot, et que le
 * canari a dû apprendre après un interblocage complet : trois runtimes Hermes
 * partagent UN profil Chromium sous bail exclusif. Un long-vivant qui garde le
 * bail pendant qu'il attend n'empêche pas seulement les autres de travailler —
 * il empêche d'arriver le message qu'il attend lui-même.
 *
 * Le cycle est donc : lire sans navigateur → prendre le bail au moment
 * d'agir → agir → RENDRE le bail → attendre sans navigateur. Le rail est
 * refermé dans un `finally`, après CHAQUE tour, y compris quand ce tour lève.
 *
 * ---------------------------------------------------------------------------
 * Un « pas encore » n'est pas INSCRIT
 * ---------------------------------------------------------------------------
 * `recordConversationPlan` inscrit un `AUTO_REPLY_SKIP` en `CANCELLED`,
 * c'est-à-dire dans un statut ABSORBANT, sous une clé qui porte la
 * compréhension du tour et les règles du moment. Un refus qui dit « pas
 * ENCORE » — la salve est ouverte, le brouillon s'écrit — inscrirait donc une
 * intention close, sous une clé que rien ne fera changer, sur un tour qui
 * allait devenir répondable cinq minutes plus tard.
 *
 * Le canari ne l'a jamais rencontré : il tournait sous une politique réactive
 * dont le silence de salve valait quelques dizaines de secondes. En production
 * il vaut cinq minutes, et la relève entrante passe toutes les cinq minutes —
 * un tour sur deux serait mort avant d'avoir été jugé, silencieusement.
 *
 * Ce runtime n'inscrit donc que ce qui DÉCIDE quelque chose : une éligibilité
 * (plan vivant), une escalade (`BLOCKED`, §8), un arrêt (`CANCELLED`). Un
 * `AUTO_REPLY_SKIP` est OBSERVÉ, compté, journalisé — et le tour reste
 * candidat. Aucune porte n'est desserrée au passage : le tour repassera par
 * `decideAutonomousReply` en entier, sur des faits neufs.
 *
 * ---------------------------------------------------------------------------
 * Aucune exception nominative
 * ---------------------------------------------------------------------------
 * Ce module ne connaît ni prospect, ni compte, ni campagne, ni coquille, et
 * n'importe pas `controlledSelfTest` : aucun jeton de cadence n'est résolu, donc
 * l'espacement minimal de production s'applique à TOUTE conversation, sans
 * exception. Un test lit cette source pour le confirmer.
 */

import {
  assessRolloutBudget,
  countActivationEffects,
  loadActiveAutoReplyActivation,
  type AutoReplyActivation,
} from '@/lib/autoreply/activation';
import {
  assessAutoReplyEligibility,
  loadAutoReplyCandidates,
  loadAutoReplyEligibilityFacts,
  type AutoReplyCandidate,
} from '@/lib/autoreply/eligibility';
import {
  isEffectOutcome,
  outcomeForDecision,
  outcomeForEligibilityRefusal,
  outcomeForExecution,
  type AutoReplyOutcome,
} from '@/lib/autoreply/outcome';
import { assessInboundMessage } from '@/lib/conversation/assessment';
import { assessPlanReclaim } from '@/lib/conversation/plan';
import { planConversationReply } from '@/lib/conversation/planning';
import { executeConversationReply } from '@/lib/conversation/replyExecution';
import type { ConversationPolicyConfig, InstagramRailConfig } from '@/lib/config/schema';
import type { CodeRevisionSentinel } from '@/lib/inbound/codeRevision';
import type { Sql } from '@/lib/db/sql';
import type { InstagramReplyRail } from '@/lib/instagram/replyRail';
import { logger } from '@/lib/logging/logger';

/** La cadence de SONDAGE au repos. Pas une autorisation : une fréquence de lecture. */
export const AUTO_REPLY_IDLE_POLL_MS = 60_000;

/** Combien de conversations un cycle REGARDE. Regarder est du SQL pur et gratuit. */
export const AUTO_REPLY_CANDIDATE_LIMIT = 25;

/** Combien d'effets un cycle peut produire. Les plafonds Instagram restent devant. */
export const AUTO_REPLY_MAX_EFFECTS_PER_CYCLE = 1;

export type AutoReplyMode = 'PLAN' | 'PREVIEW' | 'LIVE';

export interface AutoReplyTurnResult {
  readonly inboundMessageId: string;
  readonly prospectId: string;
  readonly displayName: string;
  readonly handle: string | null;
  readonly receivedAt: string;
  readonly outcome: AutoReplyOutcome;
  readonly reasonCode: string;
  readonly detail: string;
  readonly planId: string | null;
  readonly externalEffectAttempted: boolean;
}

export interface AutoReplyCycleResult {
  readonly outcome: AutoReplyOutcome;
  readonly detail: string;
  readonly activation: AutoReplyActivation | null;
  readonly candidates: number;
  readonly turns: readonly AutoReplyTurnResult[];
  readonly effects: number;
  readonly sent: number;
  /** Ce qui reste du budget de déploiement. `null` : aucune borne. */
  readonly rolloutRemaining: number | null;
}

export interface AutoReplyInput {
  readonly sql: Sql;
  readonly config: InstagramRailConfig;
  readonly conversation: ConversationPolicyConfig;
  readonly workerId: string;
  readonly mode: AutoReplyMode;
  readonly candidateLimit?: number;
  readonly maxEffectsPerCycle?: number;
  readonly now?: () => Date;
}

export interface AutoReplyDeps {
  /**
   * Le rail de réponse. `null` en mode PLAN, et c'est le TYPE qui le dit :
   * un mode qui ne peut pas agir ne reçoit pas d'objet capable d'agir.
   */
  readonly rail: InstagramReplyRail | null;
}

/**
 * UN cycle : lire l'activation, choisir les conversations, en traiter au plus
 * `maxEffectsPerCycle`, rendre le navigateur.
 *
 * Rend toujours un résultat, jamais une exception métier : un refus de
 * politique, une contention de profil, une panne de navigateur sont des
 * RÉSULTATS. Seules les erreurs de programmation remontent.
 */
export async function runAutoReplyCycle(
  input: AutoReplyInput,
  deps: AutoReplyDeps,
): Promise<AutoReplyCycleResult> {
  const { sql, mode } = input;
  const clock = input.now ?? ((): Date => new Date());
  const log = logger.child({ rail: 'autoreply', workerId: input.workerId, mode });

  // ---- 1. Le rail est-il armé ? -------------------------------------------
  const activation = await loadActiveAutoReplyActivation(sql);
  if (activation === null) {
    return cycle('RUNTIME_NOT_ACTIVATED', 'aucune activation vivante — le rail est au repos', null, [], null);
  }

  // ---- 2. Le budget de DÉPLOIEMENT ----------------------------------------
  const budget = assessRolloutBudget(activation, await countActivationEffects(sql, activation));
  if (!budget.open) {
    return cycle('ROLLOUT_BUDGET_EXHAUSTED', budget.detail, activation, [], 0);
  }

  // ---- 3. Les conversations du PÉRIMÈTRE ----------------------------------
  const candidates = await loadAutoReplyCandidates(sql, {
    frontierAt: activation.frontierAt,
    limit: input.candidateLimit ?? AUTO_REPLY_CANDIDATE_LIMIT,
  });
  if (candidates.length === 0) {
    return cycle(
      'NO_ELIGIBLE_CONVERSATION',
      `aucune conversation dans le périmètre autonome depuis la frontière (${activation.frontierAt})`,
      activation,
      [],
      budget.remaining,
    );
  }

  const maxEffects = Math.max(0, input.maxEffectsPerCycle ?? AUTO_REPLY_MAX_EFFECTS_PER_CYCLE);
  const ceiling = budget.remaining === null ? maxEffects : Math.min(maxEffects, budget.remaining);

  const turns: AutoReplyTurnResult[] = [];
  let effects = 0;
  let sent = 0;

  for (const candidate of candidates) {
    const turn = await runTurn(input, deps, activation, candidate, clock, effects >= ceiling);
    turns.push(turn);
    if (turn.externalEffectAttempted) effects += 1;
    if (turn.outcome === 'AUTO_REPLIED') sent += 1;
    log.info('autoreply.turn', {
      inboundMessageId: turn.inboundMessageId,
      outcome: turn.outcome,
      reasonCode: turn.reasonCode,
      planId: turn.planId,
    });
  }

  // L'issue du CYCLE est celle du tour le plus significatif : un effet s'il y
  // en a eu un, sinon le premier refus qui n'est pas « rien à faire ».
  const headline =
    turns.find((turn) => isEffectOutcome(turn.outcome)) ??
    turns.find((turn) => turn.outcome !== 'NOT_ELIGIBLE') ??
    turns[0];

  return Object.freeze({
    outcome: headline?.outcome ?? 'NO_ELIGIBLE_CONVERSATION',
    detail: headline?.detail ?? 'aucun tour traité',
    activation,
    candidates: candidates.length,
    turns: Object.freeze(turns),
    effects,
    sent,
    rolloutRemaining: budget.remaining,
  });

  function cycle(
    outcome: AutoReplyOutcome,
    detail: string,
    act: AutoReplyActivation | null,
    turnResults: readonly AutoReplyTurnResult[],
    remaining: number | null,
  ): AutoReplyCycleResult {
    return Object.freeze({
      outcome,
      detail,
      activation: act,
      candidates: 0,
      turns: Object.freeze([...turnResults]),
      effects: 0,
      sent: 0,
      rolloutRemaining: remaining,
    });
  }
}

/**
 * UN tour : périmètre, évaluation, intention, exécution.
 *
 * `effectCeilingReached` n'écarte que l'EXÉCUTION. L'évaluation et l'inscription
 * ont lieu quand même, et c'est voulu : une escalade doit être visible pour un
 * opérateur même le jour où le plafond de déploiement est atteint. Ce qui est
 * borné, c'est ce qui touche le monde.
 */
async function runTurn(
  input: AutoReplyInput,
  deps: AutoReplyDeps,
  activation: AutoReplyActivation,
  candidate: AutoReplyCandidate,
  clock: () => Date,
  effectCeilingReached: boolean,
): Promise<AutoReplyTurnResult> {
  const { sql, mode } = input;

  const base = {
    inboundMessageId: candidate.inboundMessageId,
    prospectId: candidate.prospectId,
    displayName: candidate.displayName,
    handle: candidate.handle,
    receivedAt: candidate.receivedAt,
  } as const;

  const done = (
    outcome: AutoReplyOutcome,
    reasonCode: string,
    detail: string,
    planId: string | null = null,
    externalEffectAttempted = false,
  ): AutoReplyTurnResult =>
    Object.freeze({ ...base, outcome, reasonCode, detail, planId, externalEffectAttempted });

  // ---- 1. Le PÉRIMÈTRE, relu message par message --------------------------
  //
  // La requête de sélection est déjà positive ; cette relecture n'est donc pas
  // un doublon utile par hasard : elle nomme le refus, et elle est la SEULE
  // autorité. Un jour où les deux divergeraient, c'est elle qui refuse.
  const facts = await loadAutoReplyEligibilityFacts(
    sql,
    candidate.inboundMessageId,
    activation.frontierAt,
  );
  if (facts === null) {
    return done('NOT_ELIGIBLE', 'ELIGIBILITY_FACTS_MISSING', 'le message a disparu entre la sélection et sa relecture');
  }
  const eligibility = assessAutoReplyEligibility(facts);
  if (!eligibility.eligible) {
    return done(outcomeForEligibilityRefusal(eligibility.refusal), eligibility.refusal, eligibility.detail);
  }

  // ---- 2. L'ÉVALUATION — déterministe, aucun modèle -----------------------
  const assessment = await assessInboundMessage(sql, candidate.inboundMessageId, {
    config: input.conversation,
    now: clock(),
  });
  if (assessment === null) {
    return done(
      'DEFERRED_NOT_YET',
      'ASSESSMENT_UNAVAILABLE',
      'message, corrélation ou lecture absents — le rail entrant n’a pas fini son travail',
    );
  }

  const decision = assessment.autonomous;

  // ---- 3. Un « pas encore » n'est pas INSCRIT -----------------------------
  if (decision.outcome === 'AUTO_REPLY_SKIP') {
    return done(
      'DEFERRED_NOT_YET',
      decision.reason ?? 'auto_reply_skip',
      `${decision.detail} — aucune intention inscrite : ce tour reste candidat`,
    );
  }

  // ---- 4. L'INTENTION, inscrite telle que la politique l'a rendue ---------
  const recorded = await planConversationReply(sql, assessment);
  const plan = recorded.plan;

  if (decision.outcome !== 'AUTO_REPLY_ELIGIBLE') {
    return done(
      outcomeForDecision(decision.outcome),
      decision.reason ?? decision.outcome,
      `${decision.detail} [plan ${plan.id}, ${plan.status}]`,
      plan.id,
    );
  }

  // ---- 5. Le registre laisse-t-il ce plan repartir ? ----------------------
  const reclaim = assessPlanReclaim(plan, clock());
  if (reclaim.class === 'TERMINAL') {
    return done('HARD_BLOCKED_SAFETY', reclaim.refusal, reclaim.detail, plan.id, plan.externalEffectAttempted);
  }
  if (reclaim.class === 'PENDING') {
    // Le délai humain, ou le bail d'un autre worker. On n'ATTEND PAS : attendre
    // ici garderait le processus (et bientôt le navigateur) devant une horloge,
    // alors que le cycle suivant repassera de lui-même. C'est ce qui garantit
    // qu'aucun bail n'est tenu pendant une attente.
    return done('WAITING_HUMAN_DELAY', reclaim.refusal, `${reclaim.detail} (pas avant ${plan.notBefore})`, plan.id);
  }

  if (mode === 'PLAN') {
    return done(
      'WAITING_HUMAN_DELAY',
      'PLAN_MODE',
      `mode PLAN : le plan ${plan.id} est dû, aucun rail n’a été construit`,
      plan.id,
    );
  }
  if (effectCeilingReached) {
    return done(
      'WAITING_HUMAN_DELAY',
      'CYCLE_EFFECT_CEILING',
      `le plafond d’effets de ce cycle est atteint — le plan ${plan.id} attend le cycle suivant`,
      plan.id,
    );
  }

  const rail = deps.rail;
  if (rail === null) {
    return done('WAITING_HUMAN_DELAY', 'NO_RAIL', 'aucun rail de réponse n’a été fourni', plan.id);
  }

  // ---- 6. L'EXÉCUTION, et le navigateur rendu quoi qu'il arrive -----------
  let outcome: Awaited<ReturnType<typeof executeConversationReply>>;
  try {
    outcome = await executeConversationReply(
      {
        sql,
        config: input.config,
        conversation: input.conversation,
        workerId: input.workerId,
        mode: mode === 'PREVIEW' ? 'PREVIEW' : 'LIVE',
        planId: plan.id,
        // UN cycle, UNE horloge.
        //
        // Ce paramètre manquait, et le cycle lisait donc deux instants : celui
        // qu'on lui donne pour évaluer le message, et l'heure réelle pour
        // relire la fenêtre d'envoi dans le crochet pré-effet. En production
        // les deux valent `new Date()` et l'écart est invisible ; sous une
        // horloge injectée, la fenêtre se jugeait sur l'heure du mur, si bien
        // que dix scénarios ne passaient qu'entre 9 h et 20 h un jour ouvré.
        // Un cycle doit raisonner sur un seul instant, pour la même raison
        // qu'un plan porte sa marque de fraîcheur.
        now: input.now,
        // Aucun jeton de cadence. La politique de PRODUCTION s'applique à
        // toute conversation, y compris à celles qu'un test contrôlé a
        // inscrites ailleurs : ce module ne sait pas en résoudre un.
      },
      { rail },
    );
  } finally {
    // Le bail du profil, rendu ENTRE deux tours. Sans effet quand rien n'a été
    // ouvert : un refus pré-effet sort AVANT le navigateur, et `close()` ne
    // fait alors rien du tout.
    await rail.close().catch((error: unknown) => {
      logger.warn('autoreply.rail_close_failed', {
        workerId: input.workerId,
        detail: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return done(
    outcomeForExecution(outcome.status, outcome.reasonCode),
    outcome.reasonCode,
    outcome.detail,
    outcome.planId ?? plan.id,
    outcome.externalEffectAttempted,
  );
}

// ---------------------------------------------------------------------------
// Le runtime durable
// ---------------------------------------------------------------------------

export type AutoReplyRuntimeStop =
  | 'ABORTED'
  | 'MAX_CYCLES'
  | 'CODE_REVISION_CHANGED'
  | 'RUNTIME_NOT_ACTIVATED';

export interface AutoReplyRuntimeOptions {
  readonly signal: AbortSignal;
  readonly maxCycles: number | null;
  readonly idlePollMs?: number;
  readonly codeRevision?: CodeRevisionSentinel;
  /**
   * Sortir quand aucune activation ne vit ? Vrai pour `--once`, faux pour
   * `--loop` : un runtime durable doit pouvoir attendre qu'un opérateur arme
   * le rail sans qu'on ait à le relancer.
   */
  readonly stopWhenInactive?: boolean;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly onCycle?: (cycle: AutoReplyCycleResult, index: number) => Promise<void> | void;
}

export interface AutoReplyRuntimeReport {
  readonly workerId: string;
  readonly cycles: readonly AutoReplyCycleResult[];
  readonly stoppedBy: AutoReplyRuntimeStop;
  readonly effects: number;
  readonly sent: number;
  readonly durationMs: number;
}

async function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * `runAutoReplyCycle`, rappelé jusqu'à ce qu'on l'arrête.
 *
 * L'arrêt gracieux est vérifié AVANT chaque cycle et PENDANT chaque attente :
 * un SIGTERM reçu pendant une minute d'attente ne fait pas attendre une minute.
 * Il n'interrompt jamais un tour en cours — un plan réclamé doit pouvoir écrire
 * son verdict, sinon son bail traînerait jusqu'à expiration.
 *
 * La sentinelle de révision est relue AVANT le cycle, donc avant qu'un DM ne
 * parte et avant que le bail du profil ne soit pris : un processus qui tourne
 * sous du code périmé ne doit pas envoyer un message de plus « pour finir ce
 * qu'il a commencé ». Sa seule conséquence possible est un arrêt.
 */
export async function runAutoReplyRuntime(
  input: AutoReplyInput,
  deps: AutoReplyDeps,
  options: AutoReplyRuntimeOptions,
): Promise<AutoReplyRuntimeReport> {
  const started = Date.now();
  const log = logger.child({ rail: 'autoreply', kind: 'RUNTIME', workerId: input.workerId });
  const cycles: AutoReplyCycleResult[] = [];
  const idlePollMs = Math.max(1_000, options.idlePollMs ?? AUTO_REPLY_IDLE_POLL_MS);
  const sleep = options.sleep ?? waitFor;
  let stoppedBy: AutoReplyRuntimeStop = 'ABORTED';

  for (;;) {
    if (options.signal.aborted) {
      stoppedBy = 'ABORTED';
      break;
    }
    if (options.maxCycles !== null && cycles.length >= options.maxCycles) {
      stoppedBy = 'MAX_CYCLES';
      break;
    }
    if (options.codeRevision?.hasDrifted() === true) {
      log.warn('autoreply.runtime.code_revision_changed', {
        startedAt: options.codeRevision.startedAt,
        current: options.codeRevision.current(),
      });
      stoppedBy = 'CODE_REVISION_CHANGED';
      break;
    }

    const result = await runAutoReplyCycle(input, deps);
    cycles.push(result);
    if (options.onCycle !== undefined) await options.onCycle(result, cycles.length - 1);

    log.info('autoreply.cycle', {
      outcome: result.outcome,
      candidates: result.candidates,
      effects: result.effects,
      sent: result.sent,
    });

    if (result.outcome === 'RUNTIME_NOT_ACTIVATED' && options.stopWhenInactive === true) {
      stoppedBy = 'RUNTIME_NOT_ACTIVATED';
      break;
    }
    if (options.signal.aborted) {
      stoppedBy = 'ABORTED';
      break;
    }
    if (options.maxCycles !== null && cycles.length >= options.maxCycles) {
      stoppedBy = 'MAX_CYCLES';
      break;
    }

    await sleep(idlePollMs, options.signal);
  }

  return Object.freeze({
    workerId: input.workerId,
    cycles: Object.freeze(cycles),
    stoppedBy,
    effects: cycles.reduce((total, cycle) => total + cycle.effects, 0),
    sent: cycles.reduce((total, cycle) => total + cycle.sent, 0),
    durationMs: Date.now() - started,
  });
}
