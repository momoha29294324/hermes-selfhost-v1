import type { Sql } from '@/lib/db/sql';
import type { InstagramRailConfig } from '@/lib/config/schema';
import { logger } from '@/lib/logging/logger';
import { DispatchBlockedError, resolveDispatchTarget } from '@/lib/pipeline/r6bDispatcher';
import { loadManifestApprovalProvenance } from '@/lib/pipeline/autonomousApproval';
import {
  armCanaryAuthorization,
  CanaryAuthorizationError,
  listCanaryAuthorizations,
  loadCanaryForManifest,
  revokeCanaryAuthorization,
} from '@/lib/instagram/canary';
import {
  evaluateItemAutonomously,
  type AutonomousCandidate,
} from '@/lib/instagram/autonomousCandidate';
import {
  AUTONOMOUS_POLICY_VERSION,
  isAutoSendEligible,
} from '@/lib/instagram/autonomousPolicy';
import { AUTONOMOUS_RAIL_ACTOR } from '@/lib/instagram/autonomousDispatch';
import {
  claimNextInstagramJob,
  finalizeInstagramJob,
  InstagramQueueError,
  recoverExpiredLeases,
} from '@/lib/instagram/queue';
import { evaluateSafety, loadSafetySnapshot } from '@/lib/instagram/safety';
import { evaluateSchedule, loadScheduleSnapshot } from '@/lib/instagram/scheduler';
import { runInstagramLiveCanary, type LiveCanaryResult, type LiveCanaryStatus } from '@/lib/instagram/liveWorker';
import type { CodeRevisionSentinel } from '@/lib/inbound/codeRevision';
import type { InstagramReadOnlyRail } from '@/lib/instagram/rail';
import {
  CLAIMABLE_JOB_STATUSES,
  SESSION_STATE_BLOCK_CODE,
  isHardStopSessionState,
  isTerminalSkip,
  type InstagramBlockCode,
  type InstagramSkipReason,
} from '@/lib/instagram/types';

/**
 * HERMES-AUTONOMOUS-R2 §6/§7/§8 — le worker LIVE autonome.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module AJOUTE, et surtout ce qu'il n'ajoute pas
 * ---------------------------------------------------------------------------
 * Il n'y a pas de seconde file, pas de second ordonnanceur, pas de seconde
 * primitive d'envoi, pas de second compteur de plafonds et pas de seconde
 * preuve de livraison. Tout cela existe déjà et reste PROPRIÉTAIRE de son
 * domaine : `ig_dispatch_jobs` porte les intentions, `evaluateSchedule` décide
 * du moment, `reserveExternalEffectSlot` compte les tentatives sous verrou,
 * `runInstagramLiveCanary` fait l'unique clic et `adjudicateDelivery` dit s'il
 * a produit quelque chose.
 *
 * Ce module apporte exactement deux choses :
 *
 *   1. une BOUCLE — `runInstagramLiveCanary` ne sait traiter qu'un job désigné
 *      par son manifeste, et refuse d'en connaître un second. C'est une bonne
 *      propriété pour un canari ; il fallait donc quelqu'un pour choisir les
 *      manifestes, un par un, et s'arrêter au bon moment ;
 *
 *   2. une ÉLIGIBILITÉ AUTONOME — la condition, absente jusqu'ici, sous
 *      laquelle un effet peut avoir lieu sans qu'un humain ait relu CE message.
 *
 * ---------------------------------------------------------------------------
 * §7 — ce que « éligible au worker autonome » veut dire
 * ---------------------------------------------------------------------------
 * Cinq conditions, toutes nécessaires, et aucune n'est un réglage :
 *
 *   * le manifeste porte une approbation dont `actor_kind` vaut
 *     `AUTONOMOUS_POLICY`. Un manifeste approuvé par un humain n'entre PAS ici
 *     — non pas parce qu'on s'en méfie, mais parce qu'il a été approuvé sous un
 *     autre régime, et que ce régime a son propre chemin (`ig:live`) ;
 *   * la politique autonome est REJOUÉE sur l'état courant, et rend
 *     `AUTO_SEND_ELIGIBLE`. Pas « l'a rendu à l'enfilement » : maintenant ;
 *   * l'arrêt global est levé, et les plafonds passent ;
 *   * l'ordonnanceur dit que c'est l'heure ;
 *   * toutes les gardes pré-effet du rail LIVE passent, inchangées.
 *
 * Un job dont on ne sait pas répondre à l'une de ces questions n'est pas traité.
 * L'ambiguïté ne s'arbitre pas ici : elle bloque.
 */

// ---------------------------------------------------------------------------
// Résultat
// ---------------------------------------------------------------------------

export type AutonomousJobStatus = LiveCanaryStatus | 'POLICY_REFUSED' | 'NOT_AUTONOMOUS';

export interface AutonomousJobOutcome {
  readonly jobId: string;
  readonly manifestId: string;
  readonly prospectId: string;
  readonly handle: string;
  readonly status: AutonomousJobStatus;
  readonly reasonCode: string;
  readonly detail: string;
  readonly externalEffectAttempted: boolean;
}

export type AutonomousRunStop =
  /** Plus aucun job autonome dû. */
  | 'QUEUE_EMPTY'
  /**
   * L'arrêt global, un plafond, l'espacement, la fenêtre — ou le profil
   * navigateur tenu par l'autre rail. Le reste attend son heure. Le `stopCode`
   * dit laquelle de ces portes s'est refermée.
   */
  | 'SAFETY'
  /** Une session dégradée ou un challenge : le rail s'arrête net, comme partout ailleurs. */
  | 'HARD_STOP'
  /** Le plafond d'effets de CETTE exécution. */
  | 'RUN_CEILING';

/**
 * HERMES-AUTONOMOUS-R3 §4 — POURQUOI cette exécution s'est arrêtée, dans un
 * vocabulaire fermé qu'un opérateur peut lire sans relire une phrase.
 *
 * Ce n'est PAS une seconde décision : chaque valeur est la TRADUCTION d'un
 * verdict déjà rendu par son propriétaire — `evaluateSafety` pour l'arrêt
 * global et les plafonds d'exécution, `evaluateSchedule` pour la fenêtre, les
 * plafonds d'envoi et la cadence. Aucun seuil n'est relu ici, aucun refus n'est
 * requalifié, et un refus que ce module ne saurait pas nommer devient
 * `BLOCKED_SAFETY` — jamais un feu vert.
 *
 * `BLOCKED_KILL_SWITCH` existe séparément parce que c'est le seul refus qu'un
 * humain lève à la main : le confondre avec un plafond ferait attendre
 * l'écoulement du temps devant une porte que seule une décision ouvre.
 */
export type AutonomousStopCode =
  | 'QUEUE_EMPTY'
  | 'BLOCKED_KILL_SWITCH'
  /**
   * Le profil navigateur était tenu par l'autre runtime Hermes (la relève
   * entrante). Ni un refus de sûreté, ni une panne : les deux rails partagent
   * une session Instagram unique, et l'un des deux passe forcément après
   * l'autre. Nommé à part pour qu'un opérateur qui lit une série de tours sans
   * effet sache laquelle des deux choses il regarde — une porte fermée, ou une
   * file d'attente d'une minute.
   */
  | 'BROWSER_PROFILE_BUSY'
  | 'BLOCKED_OUTSIDE_WINDOW'
  | 'BLOCKED_DAILY_CAP'
  | 'BLOCKED_HOURLY_CAP'
  | 'BLOCKED_COOLDOWN'
  | 'BLOCKED_SAFETY'
  | 'HARD_STOP'
  | 'RUN_CEILING';

/**
 * La traduction des refus d'ordonnancement. Partielle et assumée : les motifs
 * qui n'y figurent pas ne sont pas rendus par `evaluateSchedule`, et s'ils le
 * devenaient un jour ils tomberaient sur `BLOCKED_SAFETY` — le côté fermé.
 */
const SCHEDULE_STOP_CODE: Readonly<Partial<Record<InstagramSkipReason, AutonomousStopCode>>> =
  Object.freeze({
    kill_switch: 'BLOCKED_KILL_SWITCH',
    outside_window: 'BLOCKED_OUTSIDE_WINDOW',
    daily_cap: 'BLOCKED_DAILY_CAP',
    hourly_cap: 'BLOCKED_HOURLY_CAP',
    cooldown: 'BLOCKED_COOLDOWN',
  });

/**
 * La même traduction, pour les refus d'`evaluateSafety`.
 *
 * Deux tables et non une, parce que ce sont deux vocabulaires distincts —
 * `InstagramBlockCode` d'un côté, `InstagramSkipReason` de l'autre. Les fondre
 * demanderait d'en inventer un troisième, et un vocabulaire de plus est
 * exactement ce que ce dépôt refuse.
 */
const SAFETY_STOP_CODE: Readonly<Partial<Record<InstagramBlockCode, AutonomousStopCode>>> =
  Object.freeze({
    IG_KILL_SWITCH_ENGAGED: 'BLOCKED_KILL_SWITCH',
    IG_CAP_DAILY_SENT: 'BLOCKED_DAILY_CAP',
    IG_CAP_HOURLY_SENT: 'BLOCKED_HOURLY_CAP',
    IG_CAP_MIN_INTERVAL: 'BLOCKED_COOLDOWN',
  });

export interface AutonomousRunResult {
  readonly workerId: string;
  readonly stop: AutonomousRunStop;
  /** §4 — le motif canonique, lisible par un opérateur et par un test. */
  readonly stopCode: AutonomousStopCode;
  readonly stopDetail: string;
  readonly outcomes: readonly AutonomousJobOutcome[];
  readonly effects: number;
  readonly sent: number;
  readonly queueRemaining: number;
  readonly nextEligibleAt: string | null;
  readonly durationMs: number;
}

export interface AutonomousLiveInput {
  readonly sql: Sql;
  readonly config: InstagramRailConfig;
  readonly workerId: string;
  /**
   * Le plafond d'effets de cette exécution, en plus des plafonds durables.
   *
   * Il ne REMPLACE aucun plafond : les vrais (10/24 h, 3/h, 15 min) vivent dans
   * `reserveExternalEffectSlot`, sous verrou, et refuseraient de toute façon.
   * Celui-ci borne une invocation, pour qu'un runtime qui repart en boucle ne
   * puisse pas transformer une seule exécution en rafale si un jour les autres
   * cessaient de mordre.
   */
  readonly maxEffects: number;
  /** §6 — parcourir jusqu'au dernier point sans cliquer. */
  readonly previewOnly: boolean;
  /**
   * L'horloge, injectable — le MÊME joint que `RunInput.now` du worker DRY-RUN
   * (IG4.3), et pour la même raison.
   *
   * L'ordonnanceur n'a jamais lu l'heure lui-même : `evaluateSchedule` prend
   * `now` en paramètre. Ce qui manquait était de le lui passer depuis ici — un
   * test qui veut observer un refus « hors fenêtre » nommait sinon l'horloge
   * murale de la machine, et la suite passait le matin pour échouer le samedi.
   *
   * La fenêtre de production ne bouge pas d'un pouce : elle reste celle de
   * `config/instagram.json`, et `outside_window` refuse réellement hors fenêtre.
   */
  readonly now?: () => Date;
}

export interface AutonomousLiveDeps {
  readonly rail: InstagramReadOnlyRail;
}

/** Un plafond dur de boucle, indépendant de toute configuration. */
const RUN_CEILING = 10;

/**
 * La durée de vie d'une autorisation MACHINE : trois minutes.
 *
 * Deux ordres de grandeur sous le plafond humain (deux heures), et c'est
 * délibéré. Une autorisation humaine doit survivre au temps qu'un humain met à
 * revenir devant son terminal ; celle-ci est armée par le worker lui-même, à
 * l'instant où il s'apprête à agir, et n'a besoin de couvrir que l'ouverture du
 * navigateur et la saisie. Tout ce qu'elle dure en plus est du temps pendant
 * lequel une autorisation valide existe sans que personne ne la surveille.
 */
const AUTONOMOUS_CANARY_TTL_MS = 3 * 60 * 1000;

interface DueJobRow {
  readonly jobId: string;
  readonly manifestId: string;
  readonly prospectId: string;
  readonly batchItemId: string;
  readonly expectedHandle: string;
  readonly actorKind: string;
}

/**
 * Les jobs QUE CE WORKER A LE DROIT DE REGARDER, et eux seuls.
 *
 * La restriction `v.actor_kind = 'AUTONOMOUS_POLICY'` est dans le `where`, pas
 * dans une vérification qui suivrait : un manifeste humain n'est pas « ignoré
 * par le worker autonome », il est HORS de sa requête. La différence compte le
 * jour où quelqu'un ajoute une branche entre la lecture et la vérification.
 */
const DUE_AUTONOMOUS_JOBS = `
  select j.id             as "jobId",
         j.manifest_id    as "manifestId",
         j.prospect_id    as "prospectId",
         m.batch_item_id  as "batchItemId",
         j.expected_handle as "expectedHandle",
         v.actor_kind     as "actorKind"
    from ig_dispatch_jobs j
    join r6b_dispatch_manifests m on m.id = j.manifest_id
    join r6b_batch_votes v        on v.id = m.approval_vote_id
   where j.status = any($1::text[])
     and j.not_before <= now()
     and j.external_effect_attempted = false
     and m.status = 'LOCKED'
     and v.actor_kind = 'AUTONOMOUS_POLICY'
     and not (j.id = any($2::uuid[]))
   order by j.not_before asc, j.created_at asc`;

/**
 * Empruntée à `types.ts`, jamais recopiée. Une seconde liste de statuts
 * réclamables divergerait de la première le jour où l'une des deux changerait,
 * et le rail se mettrait à reprendre — ou à ignorer — des jobs sans que
 * personne ne l'ait décidé.
 */
const CLAIMABLE = [...CLAIMABLE_JOB_STATUSES];

export async function runAutonomousLiveWorker(
  input: AutonomousLiveInput,
  deps: AutonomousLiveDeps,
): Promise<AutonomousRunResult> {
  const { sql, config, workerId } = input;
  const clock = input.now ?? ((): Date => new Date());
  const started = Date.now();
  const log = logger.child({ rail: 'instagram', kind: 'AUTONOMOUS_LIVE', workerId });
  const outcomes: AutonomousJobOutcome[] = [];
  const seen: string[] = [];

  let stop: AutonomousRunStop = 'QUEUE_EMPTY';
  let stopCode: AutonomousStopCode = 'QUEUE_EMPTY';
  let stopDetail = 'aucun job autonome dû';
  let effects = 0;

  const ceiling = Math.max(0, Math.min(input.maxEffects, RUN_CEILING));

  // Reprise des baux abandonnés AVANT toute prise : un redémarrage après crash
  // ne doit pas laisser un job réputé « en cours » bloquer la file. Ceux qui
  // avaient déjà tenté un effet reviennent en `REVIEW_REQUIRED` et ne seront
  // jamais repris — c'est `recoverExpiredLeases` qui le garantit, ici comme
  // ailleurs, et c'est ce qui rend un redémarrage sans doublon.
  const recovered = await recoverExpiredLeases(sql);
  if (recovered.length > 0) {
    log.warn('instagram.autonomous.lease_recovered', {
      recovered: recovered.length,
      reviewRequired: recovered.filter((row) => row.status === 'REVIEW_REQUIRED').length,
    });
  }

  for (;;) {
    if (effects >= ceiling) {
      stop = 'RUN_CEILING';
      stopCode = 'RUN_CEILING';
      stopDetail = `${String(effects)} effet(s) sur cette exécution — plafond de boucle atteint`;
      break;
    }

    // ---- L'arrêt global et les plafonds, relus à CHAQUE tour ---------------
    //
    // Relus et non mémorisés : entre deux jobs, un humain a pu réarmer l'arrêt,
    // et c'est précisément le cas que le kill-switch existe pour servir. Un
    // worker qui aurait lu l'état une fois au démarrage continuerait d'envoyer
    // pendant tout le reste de la boucle.
    const snapshot = await loadSafetySnapshot(sql, config);
    const safety = evaluateSafety(snapshot, config);
    if (!safety.allowed && !input.previewOnly) {
      stop = 'SAFETY';
      // Le code vient du verdict, pas d'une relecture des compteurs.
      stopCode = SAFETY_STOP_CODE[safety.code] ?? 'BLOCKED_SAFETY';
      stopDetail = safety.reason;
      break;
    }

    const scheduleSnapshot = await loadScheduleSnapshot(sql, config);
    // `killSwitch` reste à son défaut `'enforce'` : la posture stricte est
    // celle du chemin LIVE, et le mode autonome n'est pas une raison de la
    // relâcher — c'est même la seule raison qu'il y avait de l'écrire.
    const schedule = evaluateSchedule({ snapshot: scheduleSnapshot, config, now: clock() });
    if (!schedule.allowed && !input.previewOnly) {
      stop = 'SAFETY';
      stopCode = SCHEDULE_STOP_CODE[schedule.reason] ?? 'BLOCKED_SAFETY';
      stopDetail = schedule.detail;
      break;
    }

    const due = await sql.query<DueJobRow>(DUE_AUTONOMOUS_JOBS, [[...CLAIMABLE], seen]);
    const next = due[0];
    if (next === undefined) {
      stop = 'QUEUE_EMPTY';
      stopCode = 'QUEUE_EMPTY';
      stopDetail = 'aucun job autonome dû';
      break;
    }
    seen.push(next.jobId);

    const outcome = await processOne(input, deps, next, log);
    outcomes.push(outcome);
    if (outcome.externalEffectAttempted) effects += 1;

    if (isHardStop(outcome)) {
      stop = 'HARD_STOP';
      stopCode = 'HARD_STOP';
      stopDetail = outcome.detail;
      break;
    }

    // Profil occupé : on arrête le TOUR, pas le runtime.
    //
    // Sans ce `break`, la boucle passerait au job suivant, qui trouverait le
    // même profil tenu par le même processus, et ainsi de suite : un tour
    // produirait autant de refus qu'il y a de jobs dus, tous pour une seule et
    // même cause. Ce n'est pas une panne — le tour suivant, dans une minute,
    // retrouvera très probablement le profil libre.
    if (outcome.reasonCode === 'IG_BROWSER_PROFILE_BUSY') {
      stop = 'SAFETY';
      stopCode = 'BROWSER_PROFILE_BUSY';
      stopDetail = outcome.detail;
      break;
    }
  }

  const remaining = await sql.query<{ n: string; next: string | null }>(
    `select count(*)::text as n, min(j.not_before)::text as next
       from ig_dispatch_jobs j
       join r6b_dispatch_manifests m on m.id = j.manifest_id
       join r6b_batch_votes v        on v.id = m.approval_vote_id
      where j.status = any($1::text[])
        and j.external_effect_attempted = false
        and m.status = 'LOCKED'
        and v.actor_kind = 'AUTONOMOUS_POLICY'`,
    [[...CLAIMABLE]],
  );

  return {
    workerId,
    stop,
    stopCode,
    stopDetail,
    outcomes,
    effects,
    sent: outcomes.filter((o) => o.status === 'SENT').length,
    queueRemaining: Number(remaining[0]?.n ?? 0),
    nextEligibleAt: remaining[0]?.next ?? null,
    durationMs: Date.now() - started,
  };
}

/**
 * Un job : vérifier la provenance, rejouer la politique, armer, cliquer.
 */
async function processOne(
  input: AutonomousLiveInput,
  deps: AutonomousLiveDeps,
  row: DueJobRow,
  log: ReturnType<typeof logger.child>,
): Promise<AutonomousJobOutcome> {
  const { sql, config, workerId } = input;
  const clock = input.now ?? ((): Date => new Date());
  const base = {
    jobId: row.jobId,
    manifestId: row.manifestId,
    prospectId: row.prospectId,
    handle: row.expectedHandle,
  } as const;

  // ---- §7 La provenance de l'approbation, relue par son propriétaire -------
  //
  // Redondante avec le `where` de la requête, et gardée pour cette raison : la
  // requête choisit, celle-ci VÉRIFIE, et une garde qui ne tient que par la
  // rédaction d'un `select` disparaît au premier refactor.
  const provenance = await loadManifestApprovalProvenance(sql, row.manifestId);
  if (provenance === null || provenance.actorKind !== 'AUTONOMOUS_POLICY') {
    return {
      ...base,
      status: 'NOT_AUTONOMOUS',
      reasonCode: 'IG_NOT_AUTONOMOUS_APPROVAL',
      detail:
        `le manifeste ${row.manifestId} porte une approbation ` +
        `« ${provenance?.actorKind ?? 'inconnue'} » — le worker autonome n'agit que sur les siennes`,
      externalEffectAttempted: false,
    };
  }

  // ---- §5 La POLITIQUE qui a approuvé, et pas seulement « une machine » ----
  //
  // `actor_kind` répond à « qui a décidé » ; il ne répond pas à « sous quelles
  // règles ». Une approbation inscrite par une politique ANTÉRIEURE a été
  // rendue sur des portes qui ne sont plus celles d'aujourd'hui — la rejouer
  // aujourd'hui reviendrait à faire couvrir un envoi par un texte de loi
  // abrogé. Comparé à la CONSTANTE, jamais à un littéral : incrémenter
  // `AUTONOMOUS_POLICY_VERSION` en changeant une porte referme donc
  // automatiquement cette porte-ci, sans que personne n'ait à y penser.
  //
  // Redondant avec le fait que la même exécution rejoue la politique juste
  // après : cette garde-ci parle de l'APPROBATION écrite en base, l'autre de
  // l'état courant du prospect. Les deux peuvent diverger, et c'est le cas où
  // il ne faut pas envoyer.
  if (provenance.policyVersion !== AUTONOMOUS_POLICY_VERSION) {
    return {
      ...base,
      status: 'NOT_AUTONOMOUS',
      reasonCode: 'IG_NOT_AUTONOMOUS_APPROVAL',
      detail:
        `le manifeste ${row.manifestId} porte une approbation machine de la politique ` +
        `« ${provenance.policyVersion ?? 'inconnue'} », et ce worker n'exécute que ` +
        `« ${AUTONOMOUS_POLICY_VERSION} » — une approbation rendue sous d'autres règles ne les couvre pas`,
      externalEffectAttempted: false,
    };
  }

  // ---- §8 La politique, rejouée sur l'état courant -------------------------
  const candidate = await evaluateItemAutonomously(sql, row.batchItemId, {
    ignoreManifestId: row.manifestId,
  });
  const refusal = policyRefusal(candidate);
  if (refusal !== null) {
    await parkJob(sql, config, workerId, row.jobId, refusal.skipReason, refusal.detail);
    log.warn('instagram.autonomous.policy_refused_before_effect', {
      jobId: row.jobId,
      gate: refusal.gate,
      skipReason: refusal.skipReason,
    });
    return {
      ...base,
      status: 'POLICY_REFUSED',
      reasonCode: `IG_AUTONOMOUS_${refusal.skipReason.toUpperCase()}`,
      detail: refusal.detail,
      externalEffectAttempted: false,
    };
  }

  // ---- L'autorisation d'effet, armée par la politique, et nommée telle -----
  //
  // Armée MAINTENANT, pas à l'enfilement : une autorisation qui attendrait des
  // heures dans la file serait une porte ouverte sans surveillance. Trois
  // minutes suffisent à ce qui va suivre.
  //
  // L'enveloppe vient de `resolveDispatchTarget`, donc du manifeste relu et
  // revalidé — aucune valeur d'identité ne transite par ce module.
  try {
    const existing = await loadCanaryForManifest(sql, row.manifestId);
    if (existing === null) {
      const { envelope } = await resolveDispatchTarget(sql, row.manifestId, 'LIVE');
      await armCanaryAuthorization(sql, {
        envelope,
        action: 'first_touch_dm',
        armedBy: AUTONOMOUS_RAIL_ACTOR,
        armedByKind: 'AUTONOMOUS_POLICY',
        policyVersion: AUTONOMOUS_POLICY_VERSION,
        reason:
          `politique autonome ${AUTONOMOUS_POLICY_VERSION} : toutes les portes déterministes vertes, ` +
          'rejouées immédiatement avant l’armement',
        ttlMs: AUTONOMOUS_CANARY_TTL_MS,
      });
    } else if (existing.armedByKind !== 'AUTONOMOUS_POLICY') {
      return {
        ...base,
        status: 'NOT_AUTONOMOUS',
        reasonCode: 'IG_CANARY_NOT_AUTONOMOUS',
        detail:
          `le manifeste ${row.manifestId} porte une autorisation armée par un humain ` +
          `(${existing.armedBy}) — le rail autonome ne consomme pas celle de quelqu'un d'autre`,
        externalEffectAttempted: false,
      };
    }
  } catch (error) {
    if (error instanceof CanaryAuthorizationError || error instanceof DispatchBlockedError) {
      return {
        ...base,
        status: 'BLOCKED',
        reasonCode: error instanceof DispatchBlockedError ? error.code : error.code,
        detail: error.message,
        externalEffectAttempted: false,
      };
    }
    throw error;
  }

  // ---- L'envoi, par le rail existant, inchangé -----------------------------
  const result: LiveCanaryResult = await runInstagramLiveCanary(
    {
      sql,
      config,
      workerId,
      mode: 'LIVE',
      manifestId: row.manifestId,
      action: 'first_touch_dm',
      previewOnly: input.previewOnly,
    },
    {
      rail: deps.rail,
      /**
       * §8 — le dernier avis, à l'instant où il ne reste plus rien derrière.
       *
       * La politique a déjà été rejouée quelques secondes plus tôt ; elle l'est
       * une fois de plus ici parce que « quelques secondes » n'est pas
       * « immédiatement », et parce que ce qui s'est intercalé entre les deux —
       * l'ouverture d'un navigateur, une session, une vérification d'identité —
       * dure justement le temps qu'il faut à une autre exécution pour joindre
       * ce commerce.
       *
       * Lever ici annule le clic sans rien dépenser.
       */
      beforeExternalEffect: async () => {
        // §6 — l'ARRÊT GLOBAL et l'ORDONNANCEUR, relus ICI et pas seulement au
        // début du cycle.
        //
        // Entre les deux, il s'est écoulé le temps d'ouvrir un navigateur, de
        // vérifier une session et de rapprocher une identité — quelques
        // dizaines de secondes pendant lesquelles un humain a pu voir quelque
        // chose et réarmer l'arrêt d'urgence. Un worker qui ne relirait qu'au
        // début transformerait ce geste en « le prochain job sera épargné »,
        // alors que celui qu'il regardait part quand même.
        //
        // Lever ici ne dépense rien : le crochet précède la consommation de
        // l'autorisation et la réservation du créneau. La garde est donc
        // gratuite tant qu'elle passe, et totale quand elle refuse.
        const lateSafety = evaluateSafety(await loadSafetySnapshot(sql, config), config);
        if (!lateSafety.allowed) {
          throw new InstagramQueueError(
            lateSafety.code,
            `refus de dernière seconde [sûreté] : ${lateSafety.reason} — aucun clic`,
          );
        }
        const lateSchedule = evaluateSchedule({
          snapshot: await loadScheduleSnapshot(sql, config),
          config,
          now: clock(),
        });
        if (!lateSchedule.allowed) {
          throw new InstagramQueueError(
            'IG_AUTONOMOUS_POLICY_REFUSED',
            `refus de dernière seconde [ordonnanceur/${lateSchedule.reason}] : ${lateSchedule.detail} — aucun clic`,
          );
        }

        // §8 — puis la politique, sur l'état courant du prospect.
        const fresh = await evaluateItemAutonomously(sql, row.batchItemId, {
          ignoreManifestId: row.manifestId,
        });
        const late = policyRefusal(fresh);
        if (late !== null) {
          throw new InstagramQueueError(
            'IG_AUTONOMOUS_POLICY_REFUSED',
            `refus de dernière seconde [${late.gate}] : ${late.detail} — aucun clic`,
          );
        }
      },
    },
  );

  return {
    ...base,
    status: result.status,
    reasonCode: result.reasonCode,
    detail: result.detail,
    externalEffectAttempted: result.externalEffectAttempted,
  };
}

interface PolicyRefusal {
  readonly gate: string;
  readonly detail: string;
  readonly skipReason: InstagramSkipReason;
}

/**
 * La politique refuse-t-elle ? Fail-closed dans les deux cas limites.
 *
 * Un item disparu (`null`) refuse : « je n'ai pas trouvé » n'est pas « rien ne
 * s'y oppose ». Une décision éligible mais sans motif nommé refuserait aussi —
 * elle ne peut pas exister, et la traiter comme un feu vert serait accorder à
 * un état impossible le bénéfice du doute.
 */
function policyRefusal(candidate: AutonomousCandidate | null): PolicyRefusal | null {
  if (candidate === null) {
    return {
      gate: 'item',
      detail: 'l’item de batch qui portait ce manifeste est introuvable — la politique ne peut rien confirmer',
      skipReason: 'review_required',
    };
  }
  if (isAutoSendEligible(candidate.decision)) return null;
  return {
    gate: candidate.decision.gate,
    detail: candidate.decision.detail,
    skipReason: candidate.decision.reason ?? 'review_required',
  };
}

/**
 * Range un job que la politique refuse, sans effet et sans le perdre.
 *
 * Le motif est écrit dans le vocabulaire partagé ; c'est `finalizeInstagramJob`
 * qui en DÉDUIT la classe, donc ce module ne choisit pas si son refus est
 * temporaire. Un motif reconsidérable laisse le job dans la file avec un
 * `not_before` repoussé ; un motif terminal le clôt pour de bon.
 */
async function parkJob(
  sql: Sql,
  config: InstagramRailConfig,
  workerId: string,
  jobId: string,
  skipReason: InstagramSkipReason,
  detail: string,
): Promise<void> {
  const claimed = await claimNextInstagramJob(sql, { workerId, leaseMs: config.queue.leaseMs, jobId });
  if (claimed === null || claimed.claimToken === null) return;

  // La classe n'est pas choisie ici : `skipClassOf` la connaît, et c'est elle
  // qui décide si ce refus attend son heure ou clôt le job. Un module qui
  // trancherait lui-même finirait par inscrire un opt-out comme reportable.
  //
  // `INELIGIBLE` plutôt que `BLOCKED` pour un refus terminal : c'est le seul
  // statut absorbant qui affirme AUSSI que rien n'a été tenté, et la base
  // l'impose (`ig_job_ineligible_has_no_effect`, 0039). C'est exactement ce
  // qu'un refus de politique décrit.
  const terminal = isTerminalSkip(skipReason);

  await finalizeInstagramJob(sql, {
    jobId,
    claimToken: claimed.claimToken,
    status: terminal ? 'INELIGIBLE' : 'SKIPPED',
    reasonCode: 'IG_AUTONOMOUS_POLICY_REFUSED',
    detail,
    skipReason,
    notBeforeMs: terminal ? undefined : config.schedule.defaultBackoffMs,
  });
}

/**
 * Ce refus doit-il arrêter la BOUCLE, et pas seulement ce job ?
 *
 * Oui pour les états de session qu'`isHardStopSessionState` nomme déjà —
 * challenge, captcha, compte bloqué. Ce sont des messages qu'Instagram adresse
 * à un humain, et enchaîner sur le job suivant reviendrait à les ignorer un par
 * un, ce qui est la façon la plus sûre de transformer une demande de
 * vérification en blocage durable.
 *
 * La liste est DÉRIVÉE de `SESSION_STATE_BLOCK_CODE`, pas réécrite : un état
 * d'arrêt ajouté plus tard sera respecté ici sans que personne n'y pense.
 */
const HARD_STOP_CODES: readonly string[] = Object.entries(SESSION_STATE_BLOCK_CODE)
  .filter(([state]) => isHardStopSessionState(state as never))
  .map(([, code]) => code);

function isHardStop(outcome: AutonomousJobOutcome): boolean {
  return HARD_STOP_CODES.includes(outcome.reasonCode);
}

// ---------------------------------------------------------------------------
// HERMES-AUTONOMOUS-R3 §3 — le RUNTIME durable
// ---------------------------------------------------------------------------

/**
 * Ce que cette boucle est, et surtout ce qu'elle n'est pas.
 *
 * Elle N'EST PAS un second ordonnanceur. Elle ne sait pas si un envoi est
 * permis, elle ne connaît ni fenêtre, ni plafond, ni cadence, ni arrêt global,
 * et elle ne lit aucun compteur. Tout cela reste la propriété de
 * `evaluateSafety` et `evaluateSchedule`, à l'intérieur de
 * `runAutonomousLiveWorker`, relu à chaque tour.
 *
 * Elle est exactement une chose : REDEMANDER PLUS TARD. `runAutonomousLiveWorker`
 * traite les jobs dus puis rend la main — c'est une bonne propriété, elle borne
 * une invocation. Un runtime durable a besoin de quelqu'un pour la rappeler, et
 * ce quelqu'un ne doit pas avoir d'opinion sur ce qu'elle décidera.
 *
 * Le délai entre deux tours est donc une CADENCE DE SONDAGE, pas une décision :
 * il vient de la file elle-même (`nextEligibleAt`, c'est-à-dire le `not_before`
 * du prochain job autonome), borné par un plancher pour ne pas tourner à vide
 * et par un plafond pour rester réactif. Se tromper sur ce nombre ne peut
 * produire ni un envoi de plus, ni un envoi plus tôt : au pire un tour de plus
 * qui se fera refuser par les gardes, au pire un tour de moins qui attendra.
 */

/** Plancher de sondage par défaut : une minute. */
export const AUTONOMOUS_IDLE_POLL_MS = 60_000;

/** Plafond d'attente entre deux tours : un quart d'heure. */
export const AUTONOMOUS_MAX_IDLE_MS = 15 * 60 * 1000;

export type AutonomousRuntimeStop =
  /** SIGINT / SIGTERM, ou tout autre `abort()` : arrêt propre demandé. */
  | 'ABORTED'
  /** Le nombre de tours demandé a été atteint. C'est le mode `--once`. */
  | 'MAX_CYCLES'
  /** Un challenge, un captcha, un compte bloqué : le rail ne réessaie pas seul. */
  | 'HARD_STOP'
  /**
   * HERMES-MULTI-TURN-CANARY-R1 — le dépôt a changé sous ce processus.
   *
   * Node charge le code UNE fois. Un `--loop` démarré avant un correctif
   * continue d'appliquer les constantes de son démarrage, indéfiniment : c'est
   * exactement ce qui a fait écraser, le 23 août 2026, une analyse canonique
   * par la lecture d'un runtime périmé (HERMES-ACTIVE-ANALYSIS-VERSION-CONFLICT-R1).
   * Le rail entrant portait déjà cette sentinelle ; le worker SORTANT ne l'avait
   * pas, alors que c'est lui qui ENVOIE.
   */
  | 'CODE_REVISION_CHANGED';

export interface AutonomousRuntimeOptions {
  /** Câblé sur SIGINT/SIGTERM par la CLI, sur un contrôleur par les tests. */
  readonly signal: AbortSignal;
  /** `null` = jusqu'à l'arrêt. `1` = un tour borné (`--once`). */
  readonly maxCycles: number | null;
  /** Plancher de la cadence de sondage. Voir l'en-tête : ce n'est pas une politique. */
  readonly idlePollMs?: number;
  /** Joint de test : remplace l'attente réelle, sans changer la boucle. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /**
   * La sentinelle de révision du dépôt. ABSENTE par défaut, et l'absence ne
   * change rien : sans elle, la boucle se comporte exactement comme avant.
   *
   * Ce n'est PAS un rechargement à chaud — la seule conséquence possible est un
   * ARRÊT, avant un tour, donc avant qu'un DM ne parte sous des règles que
   * personne ne relit plus. La règle opératoire prime toujours sur l'outil :
   * après un changement de version de politique, on redémarre les loops.
   */
  readonly codeRevision?: CodeRevisionSentinel;
}

export interface AutonomousRuntimeReport {
  readonly workerId: string;
  readonly cycles: readonly AutonomousRunResult[];
  readonly stoppedBy: AutonomousRuntimeStop;
  readonly effects: number;
  readonly sent: number;
  /** Autorisations MACHINE encore armées, refermées à la sortie. Jamais celles d'un humain. */
  readonly revokedAuthorizations: number;
  readonly durationMs: number;
}

/**
 * Le runtime : `runAutonomousLiveWorker`, rappelé jusqu'à ce qu'on l'arrête.
 *
 * L'arrêt gracieux est vérifié AVANT chaque tour et PENDANT chaque attente : un
 * SIGTERM reçu pendant une attente de quinze minutes ne fait pas attendre
 * quinze minutes. Il n'interrompt jamais un tour en cours — un job réclamé doit
 * pouvoir écrire son verdict, sinon son bail traînerait jusqu'à expiration.
 */
export async function runAutonomousLiveRuntime(
  input: AutonomousLiveInput,
  deps: AutonomousLiveDeps,
  options: AutonomousRuntimeOptions,
): Promise<AutonomousRuntimeReport> {
  const { sql, workerId } = input;
  const clock = input.now ?? ((): Date => new Date());
  const started = Date.now();
  const log = logger.child({ rail: 'instagram', kind: 'AUTONOMOUS_RUNTIME', workerId });
  const cycles: AutonomousRunResult[] = [];
  const idlePollMs = clampIdle(options.idlePollMs ?? AUTONOMOUS_IDLE_POLL_MS);
  const sleep = options.sleep ?? waitFor;

  let stoppedBy: AutonomousRuntimeStop = 'ABORTED';

  try {
    for (;;) {
      if (options.signal.aborted) {
        stoppedBy = 'ABORTED';
        break;
      }
      if (options.maxCycles !== null && cycles.length >= options.maxCycles) {
        stoppedBy = 'MAX_CYCLES';
        break;
      }

      // AVANT le tour, et non après : un processus qui tourne sous un code
      // périmé ne doit pas envoyer un DM de plus « pour finir ce qu'il a
      // commencé ». Rien n'a encore été réclamé, donc rien n'est laissé à
      // moitié — et le bail du profil n'a pas été pris.
      if (options.codeRevision?.hasDrifted() === true) {
        log.warn('instagram.autonomous.runtime.code_revision_changed', {
          startedAt: options.codeRevision.startedAt,
          current: options.codeRevision.current(),
        });
        stoppedBy = 'CODE_REVISION_CHANGED';
        break;
      }

      const result = await runAutonomousLiveWorker(input, deps);

      // Le navigateur est refermé ENTRE deux tours, et c'est ce qui rend le
      // partage du profil possible.
      //
      // Le rail ouvre son contexte paresseusement et le garde pour toute la vie
      // de l'objet. Dans un runtime `--loop`, cet objet vit jusqu'au SIGTERM :
      // le premier tour qui aurait ouvert Chromium aurait donc gardé le profil
      // — et son bail — pour toujours, et la relève entrante n'aurait plus
      // jamais eu son tour. Un worker qui sonde une fois par minute n'a aucune
      // raison de tenir un navigateur ouvert 24 h sur 24 sur une session
      // partagée ; il le rouvre quand il a quelque chose à faire.
      //
      // Sans effet quand rien n'a été ouvert — l'arrêt global, un plafond ou
      // une file vide sortent AVANT le navigateur, et `close()` ne fait alors
      // rien du tout.
      await deps.rail.close().catch((error: unknown) => {
        log.warn('instagram.autonomous.rail_close_failed', {
          detail: error instanceof Error ? error.message : String(error),
        });
      });

      cycles.push(result);
      log.info('instagram.autonomous.cycle', {
        stop: result.stop,
        stopCode: result.stopCode,
        effects: result.effects,
        sent: result.sent,
        queueRemaining: result.queueRemaining,
      });

      if (result.stop === 'HARD_STOP') {
        stoppedBy = 'HARD_STOP';
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

      await sleep(nextCycleDelayMs(result, idlePollMs, clock().getTime()), options.signal);
    }
  } finally {
    // §2 — un arrêt propre ne laisse pas d'autorisation ouverte derrière lui.
    // Dans un `finally` : même sur une levée, même sur un SIGTERM au milieu
    // d'un tour. Voir `revokeStillArmedAutonomousAuthorizations` pour ce qui
    // n'est PAS refermé ici.
    //
    // L'arrêt global, lui, n'est PAS réengagé (§2). En R3 il cesse d'être une
    // autorisation par invocation pour devenir l'arrêt d'urgence du runtime :
    // un processus qui le réarmerait en sortant obligerait un humain à le
    // relever après chaque redémarrage, et ferait de « le runtime a redémarré »
    // un synonyme de « le rail est fermé ».
  }

  const revokedAuthorizations = await revokeStillArmedAutonomousAuthorizations(sql);

  return Object.freeze({
    workerId,
    cycles: Object.freeze([...cycles]),
    stoppedBy,
    effects: cycles.reduce((total, cycle) => total + cycle.effects, 0),
    sent: cycles.reduce((total, cycle) => total + cycle.sent, 0),
    revokedAuthorizations,
    durationMs: Date.now() - started,
  });
}

/**
 * Referme les autorisations encore ARMÉES par la POLITIQUE, et elles seules.
 *
 * Le filtre `armedByKind === 'AUTONOMOUS_POLICY'` n'est pas une précaution de
 * politesse : une autorisation humaine armée pour `ig:live` vit dans la même
 * table, et un runtime autonome qui la révoquerait annulerait l'envoi qu'un
 * humain venait de préparer — sans le lui dire, et sans possibilité de le
 * refaire, puisqu'un manifeste ne porte qu'une autorisation dans son histoire.
 *
 * Une révocation qui échoue n'empêche pas les suivantes ni la sortie : au pire
 * l'autorisation expire d'elle-même (trois minutes) et le balayage la ferme.
 */
export async function revokeStillArmedAutonomousAuthorizations(sql: Sql): Promise<number> {
  const all = await listCanaryAuthorizations(sql, 200).catch(() => []);
  let revoked = 0;
  for (const auth of all) {
    if (auth.state !== 'ARMED') continue;
    if (auth.armedByKind !== 'AUTONOMOUS_POLICY') continue;
    const closed = await revokeCanaryAuthorization(sql, {
      id: auth.id,
      revokedBy: AUTONOMOUS_RAIL_ACTOR,
      reason:
        'fin du runtime autonome — une autorisation d’effet ne survit pas au processus qui l’a armée',
    }).catch(() => null);
    if (closed !== null) revoked += 1;
  }
  return revoked;
}

/** Le plancher de sondage, borné pour qu'une faute de frappe ne fasse pas tourner à vide. */
function clampIdle(ms: number): number {
  if (!Number.isFinite(ms)) return AUTONOMOUS_IDLE_POLL_MS;
  return Math.min(Math.max(Math.trunc(ms), 1_000), AUTONOMOUS_MAX_IDLE_MS);
}

/**
 * Combien attendre avant de REDEMANDER — voir l'en-tête de section : ce nombre
 * n'autorise rien et n'avance rien.
 *
 * `nextEligibleAt` est le `not_before` du prochain job autonome, calculé par la
 * file. Quand il est dans le futur, attendre jusque-là évite des tours qui se
 * feraient refuser pour « pas encore dû ». Quand il est nul ou déjà passé —
 * file vide, ou job dû mais bloqué par une garde — le plancher s'applique.
 */
export function nextCycleDelayMs(
  result: AutonomousRunResult,
  idlePollMs: number,
  nowMs: number,
): number {
  if (result.nextEligibleAt === null) return idlePollMs;
  const due = Date.parse(result.nextEligibleAt);
  if (!Number.isFinite(due)) return idlePollMs;
  return Math.min(Math.max(due - nowMs, idlePollMs), AUTONOMOUS_MAX_IDLE_MS);
}

/**
 * Une attente qui se laisse interrompre.
 *
 * Le `timer` est retiré dès la résolution : un runtime qui laisserait derrière
 * lui un `setTimeout` de quinze minutes maintiendrait le processus vivant
 * quinze minutes après un SIGTERM, ce qui est exactement le contraire d'un
 * arrêt propre.
 */
function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
