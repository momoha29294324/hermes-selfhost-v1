import type { Sql } from '@/lib/db/sql';
import type { InstagramRailConfig } from '@/lib/config/schema';
import { logger } from '@/lib/logging/logger';
import { DispatchBlockedError, resolveDispatchTarget } from '@/lib/pipeline/r6bDispatcher';
import type { DispatchEnvelope } from '@/lib/pipeline/r6bTransportAdapters';
import { getLiveReadiness } from '@/lib/pipeline/r6bTransportPayload';
import { ensureContacted } from '@/lib/replies/state';
import { decideIdentity } from '@/lib/instagram/identity';
import { closeBrowserSession, recordBrowserSession, recordIdentityCheck, recordJobEvent } from '@/lib/instagram/events';
import {
  checkCanaryAuthorization,
  consumeCanaryReservation,
  expireStaleCanaryAuthorizations,
  loadCanaryForManifest,
  releaseCanaryReservation,
  reserveCanaryAuthorization,
  type CanaryAuthorization,
} from '@/lib/instagram/canary';
import {
  claimNextInstagramJob,
  detectJobManifestDrift,
  finalizeInstagramJob,
  loadInstagramJob,
  recoverExpiredLeases,
  reserveExternalEffectSlot,
  type InstagramJob,
} from '@/lib/instagram/queue';
import { evaluateSafety, loadSafetySnapshot } from '@/lib/instagram/safety';
import {
  hasSendPrimitive,
  InstagramRailError,
  type InstagramLiveRail,
  type InstagramReadOnlyRail,
  type InstagramSendObservation,
  type InstagramSessionStatus,
} from '@/lib/instagram/rail';
import {
  IDENTITY_VERDICT_BLOCK_CODE,
  SESSION_STATE_BLOCK_CODE,
  isHardStopSessionState,
  isUsableSessionState,
  type GateRecord,
  type InstagramAction,
  type InstagramReasonCode,
  type InstagramSessionState,
} from '@/lib/instagram/types';

/**
 * IG2 §4/§5/§7/§8 — le canari LIVE : un manifeste, une tentative, aucun rejeu.
 *
 * Ce module est le seul du dépôt qui appelle une primitive d'envoi Instagram.
 * Trois décisions le structurent, et aucune n'est un réglage.
 *
 * 1. L'ORDRE. Toutes les gardes du §5 sont revalidées ici, dans la même
 *    exécution, immédiatement avant le clic — pas héritées d'un dry-run
 *    antérieur, pas mises en cache. Puis, dans cet ordre exact :
 *    réservation atomique de l'autorisation → inscription durable de la
 *    tentative → clic. Chaque étape ne peut avoir lieu que si la précédente a
 *    été COMMISE, si bien qu'un processus tué à n'importe quel instant laisse
 *    une trace qui ne ment pas.
 *
 * 2. « ENVOYÉ » N'EST PAS « CLIQUÉ ». La primitive rend ce qu'elle a VU ; c'est
 *    `judgeSendOutcome` qui tranche, et il exige cinq observations
 *    concordantes. Tout le reste est `AMBIGUOUS` — terminal, jamais rejoué.
 *
 * 3. AUCUNE BOUCLE. Ce worker traite UN job, désigné par son manifeste. Il n'y
 *    a pas de `maxJobs`, pas de `--all`, pas de parcours de file : la fonction
 *    ne sait pas traiter un second job, même si la file en contient mille.
 */

// ---------------------------------------------------------------------------
// Résultat
// ---------------------------------------------------------------------------

export type LiveCanaryStatus =
  /** Un effet a eu lieu et il est prouvé. */
  | 'SENT'
  /** Un effet a eu lieu, la preuve manque. Attente humaine, jamais un rejeu. */
  | 'AMBIGUOUS'
  /**
   * IG2.1 §4 — un effet a eu lieu, et Instagram déclare le message non remis.
   * Une issue CONNUE, distincte de l'ambiguïté : rien n'est parti, personne n'a
   * été joint, et l'unique tentative autorisée est pourtant dépensée.
   */
  | 'DELIVERY_FAILED'
  /** Une garde a refusé. Zéro effet. */
  | 'BLOCKED'
  /** Panne technique avant tout effet. Zéro effet. */
  | 'FAILED'
  /** §6 — le chemin a été parcouru sans cliquer. Zéro effet. */
  | 'PREVIEWED';

export interface LiveCanaryResult {
  readonly status: LiveCanaryStatus;
  readonly reasonCode: InstagramReasonCode;
  readonly detail: string;
  readonly jobId: string | null;
  readonly manifestId: string;
  readonly prospectId: string | null;
  readonly expectedHandle: string | null;
  readonly observedHandle: string | null;
  readonly approvedText: string | null;
  readonly approvedTextSha256: string | null;
  readonly transportPayloadSha256: string | null;
  readonly liveReady: boolean | null;
  readonly identityVerdict: string | null;
  readonly sessionId: string | null;
  readonly sessionState: InstagramSessionState | null;
  readonly gates: readonly GateRecord[];
  readonly canary: CanaryAuthorization | null;
  /** IG2 §10 — le nombre EXACT de primitives externes appelées. 0 ou 1, jamais 2. */
  readonly externalAttempts: 0 | 1;
  readonly externalEffectAttempted: boolean;
  readonly observation: InstagramSendObservation | null;
  readonly outreachEventId: string | null;
  readonly outreachState: string | null;
  readonly eventId: string | null;
  readonly screenshotPath: string | null;
  readonly durationMs: number;
}

export interface LiveCanaryInput {
  readonly sql: Sql;
  readonly config: InstagramRailConfig;
  readonly workerId: string;
  /** Toujours `LIVE`. Le vérifier ici plutôt que le supposer : l'entrée vient d'un CLI. */
  readonly mode: string;
  /** La cible, nommée explicitement. Il n'existe aucune autre façon d'en désigner une. */
  readonly manifestId: string;
  readonly action: InstagramAction;
  /** §6 — parcourir sans cliquer. */
  readonly previewOnly: boolean;
}

export interface LiveCanaryDeps {
  /** Exigé, jamais construit ici : le domaine n'ouvre pas de navigateur de lui-même. */
  readonly rail: InstagramReadOnlyRail;
  /**
   * HERMES-AUTONOMOUS-R2 §8 — un dernier avis, à l'instant exact où il ne reste
   * plus rien entre la décision et le message.
   *
   * Appelé DANS `onBeforeExternalEffect`, avant la consommation de
   * l'autorisation et avant la réservation du créneau : lever ici n'a donc
   * dépensé ni l'une ni l'autre, et le clic n'a pas lieu. C'est le seul endroit
   * du rail où « le prospect a-t-il changé pendant qu'il attendait dans la
   * file ? » se pose sans fenêtre derrière elle.
   *
   * Absent, rien ne change : le chemin humain (`ig:live`) ne passe aucun
   * crochet et se comporte exactement comme avant. C'est le rail AUTONOME qui
   * en a besoin — ses jobs peuvent attendre des heures entre l'enfilement et
   * l'effet, sans personne pour regarder ce qui a bougé entre les deux.
   */
  readonly beforeExternalEffect?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// §8 — la preuve
// ---------------------------------------------------------------------------

export interface SendJudgement {
  /** IG2.1 §4 — trois issues, dont l'échec de livraison. Jamais un booléen. */
  readonly outcome: 'SENT' | 'DELIVERY_FAILED' | 'AMBIGUOUS';
  readonly detail: string;
  readonly missing: readonly string[];
}

/**
 * Décide si ce qui a été observé prouve un envoi. Pure — donc exerçable sur
 * chaque combinaison d'observations sans envoyer quoi que ce soit.
 *
 * Cinq conditions, toutes nécessaires :
 *
 *   1. le fil porte le handle attendu APRÈS le clic (pas seulement avant) ;
 *   2. le texte exact n'était PAS déjà présent dans le fil (sinon un message
 *      antérieur suffirait à « prouver » le nôtre) ;
 *   3. il y est maintenant ;
 *   4. le composeur s'est vidé — l'UI a accepté, le texte n'est pas resté en
 *      brouillon ;
 *   5. l'occurrence est du côté SORTANT du fil.
 *
 * Pourquoi la cinquième, alors que les quatre premières semblent suffire :
 * parce qu'elles décrivent aussi, mot pour mot, un message qu'Instagram
 * afficherait comme échoué, ou un fil où notre texte apparaîtrait pour une
 * autre raison. L'alignement est ce qu'un humain regarde pour dire « c'est
 * parti de moi » ; le rail le mesure au lieu de le supposer.
 *
 * Une observation illisible vaut `false`, jamais `true` : « je n'ai pas pu
 * lire » n'est pas « c'est bon » — même règle que `decideIdentity`.
 */
export function judgeSendOutcome(
  observation: InstagramSendObservation,
  expectedHandle: string,
): SendJudgement {
  // ---- L'échec explicite l'emporte, et c'est l'ordre qui compte ------------
  //
  // Un message qu'Instagram n'a pas remis reste affiché, aligné du côté
  // sortant, portant le texte exact : il satisfait les cinq preuves ci-dessous.
  // Si le marqueur d'échec ne passait pas d'abord, l'issue la plus dangereuse —
  // « envoyé » alors que rien n'est parti — serait précisément celle qu'on
  // écrirait.
  if (observation.deliveryVerdict === 'DELIVERY_FAILED') {
    return {
      outcome: 'DELIVERY_FAILED',
      missing: Object.freeze([...observation.deliveryFailureMarkers]),
      detail:
        'un clic a eu lieu et l’interface d’Instagram déclare le message NON REMIS ' +
        `(${observation.deliveryFailureMarkers.join(' ; ') || 'marqueur d’échec observé'}). ` +
        'Aucun SENT, aucun outreach_event, aucun rejeu : personne n’a été joint.',
    };
  }

  const missing: string[] = [];

  // ---- Une récolte illisible n'est pas une récolte vide --------------------
  //
  // Le 14 août, elle l'a été : le code qui comptait les bulles levait une
  // `ReferenceError` avant sa première mesure, le `catch` rendait une mesure
  // vide, et « je n'ai pas pu lire » est devenu « il n'y a rien ». Les deux
  // situations ont maintenant deux champs distincts, et celle-ci arrive en
  // tête parce qu'elle invalide tout ce qui suit.
  if (!observation.harvestReadableBefore) missing.push('la lecture du fil AVANT le clic n’a pas pu s’exécuter');
  if (!observation.harvestReadableAfter) missing.push('la lecture du fil APRÈS le clic n’a pas pu s’exécuter');

  if ((observation.threadHandle ?? '').toLowerCase() !== expectedHandle.toLowerCase()) {
    missing.push(`identité du fil (${observation.threadHandle ?? 'illisible'} ≠ ${expectedHandle})`);
  }
  if (observation.matchingBubblesBefore !== 0) {
    missing.push(`le texte était déjà présent ${observation.matchingBubblesBefore} fois avant le clic`);
  }
  if (observation.matchingBubblesAfter <= observation.matchingBubblesBefore) {
    missing.push('aucune occurrence nouvelle du texte exact dans le fil');
  }
  if (!observation.composerCleared) missing.push('composeur non vidé');
  if (!observation.outgoingBubbleConfirmed) missing.push('occurrence non confirmée du côté sortant');
  if (observation.deliveryVerdict !== 'SENT') {
    missing.push(`la preuve de livraison rend « ${observation.deliveryVerdict} » (${observation.scopeDetail})`);
  }
  if (observation.deliveryFailureMarkers.length > 0) {
    missing.push(`marqueur(s) d’échec accolé(s) : ${observation.deliveryFailureMarkers.join(' ; ')}`);
  }
  if (!isUsableSessionState(observation.sessionState)) {
    missing.push(`état final ${observation.sessionState}`);
  }

  if (missing.length > 0) {
    return {
      outcome: 'AMBIGUOUS',
      missing: Object.freeze(missing),
      detail:
        'un clic a eu lieu mais la preuve est incomplète — ' +
        `manque : ${missing.join(' ; ')}. Aucun SENT ne sera écrit, aucun rejeu ne sera tenté.`,
    };
  }

  return {
    outcome: 'SENT',
    missing: Object.freeze([]),
    detail:
      `bulle sortante portant le texte exact dans le fil de « ${expectedHandle} » ` +
      `(${observation.matchingBubblesBefore} → ${observation.matchingBubblesAfter}), composeur vidé, ` +
      'aucun marqueur d’échec',
  };
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

/**
 * Le canari. Une invocation = au plus un effet Instagram.
 *
 * Refuse par un résultat, jamais par une exception silencieuse : l'appelant
 * doit pouvoir distinguer « rien ne s'est passé » de « quelque chose est peut-
 * être parti », et un `throw` générique brouillerait exactement cette
 * distinction.
 */
export async function runInstagramLiveCanary(
  input: LiveCanaryInput,
  deps: LiveCanaryDeps,
): Promise<LiveCanaryResult> {
  const { sql, config, workerId } = input;
  const started = Date.now();
  const log = logger.child({ rail: 'instagram', workerId, mode: 'LIVE', manifestId: input.manifestId });
  const gates: GateRecord[] = [];

  let job: InstagramJob | null = null;
  let claimToken: string | null = null;
  let envelope: DispatchEnvelope | null = null;
  let canary: CanaryAuthorization | null = null;
  let sessionId: string | null = null;
  let sessionState: InstagramSessionState | null = null;
  let observedHandle: string | null = null;
  let identityVerdict: string | null = null;
  let liveReady: boolean | null = null;
  let screenshotPath: string | null = null;
  let externalEffectAttempted = false;
  let externalAttempts: 0 | 1 = 0;
  /**
   * IG2.1 §7 — ce worker tient-il encore une réservation non consommée ?
   *
   * Suivi ici plutôt que relu en base, parce que la question posée n’est pas
   * « quel est l’état de la ligne ? » mais « dois-je rendre la main ? ». Le
   * relâchement, lui, revérifie tout dans son where — ce drapeau ne décide
   * rien, il évite seulement une écriture inutile.
   */
  let reservationHeld = false;
  let observation: InstagramSendObservation | null = null;
  let outreachEventId: string | null = null;
  let outreachState: string | null = null;

  const pass = (gate: string, detail: string): void => {
    gates.push({ gate, verdict: 'PASS', detail });
  };

  /**
   * Clôt la tentative : journal d'audit, statut du job, bail rendu.
   *
   * Le statut du job et l'événement sont écrits ensemble et une seule fois —
   * une sortie qui oublierait l'un des deux laisserait un bail ouvert ou un
   * effet non journalisé.
   */
  const finish = async (
    status: LiveCanaryStatus,
    reasonCode: InstagramReasonCode,
    detail: string,
  ): Promise<LiveCanaryResult> => {
    const durationMs = Date.now() - started;
    let eventId: string | null = null;

    if (job !== null) {
      // Traduction issue → statut de job. `AMBIGUOUS` devient `REVIEW_REQUIRED` :
      // c'est le statut absorbant que 0029 a créé pour « on ne sait pas », et
      // qui interdit à `recoverExpiredLeases` de jamais le reprendre.
      const jobStatus =
        status === 'SENT'
          ? 'SENT'
          : status === 'AMBIGUOUS'
            ? 'REVIEW_REQUIRED'
            : status === 'DELIVERY_FAILED'
              ? 'DELIVERY_FAILED'
              : status === 'FAILED'
                ? 'FAILED'
                : 'BLOCKED';

      const eventStatus =
        status === 'SENT'
          ? 'SENT'
          : status === 'AMBIGUOUS'
            ? 'AMBIGUOUS'
            : status === 'DELIVERY_FAILED'
              ? 'DELIVERY_FAILED'
              : status === 'FAILED'
                ? 'FAILED'
                : 'BLOCKED';

      eventId = await recordJobEvent(sql, {
        jobId: job.id,
        manifestId: job.manifestId,
        prospectId: job.prospectId,
        sessionId,
        workerId,
        mode: 'LIVE',
        status: eventStatus,
        reasonCode,
        idempotencyKey: job.idempotencyKey,
        expectedHandle: job.expectedHandle,
        observedHandle,
        sessionState,
        gates,
        durationMs,
        detail: detail.slice(0, 2000),
        externalEffectAttempted,
        canaryAuthorizationId: canary?.id ?? null,
      });

      if (claimToken !== null) {
        // IG2 §1 — l'intervalle de cadence est facturé ICI, et seulement ici :
        // c'est le seul chemin qui produit un effet. Un refus survenu avant le
        // clic ne repousse rien, parce qu'il n'a rien chargé.
        const released = await finalizeInstagramJob(sql, {
          jobId: job.id,
          claimToken,
          status: jobStatus,
          reasonCode,
          detail: detail.slice(0, 1000),
          notBeforeMs: externalEffectAttempted ? config.caps.minSendIntervalMs : 0,
        });
        if (!released) log.warn('instagram.live.lease_lost', { jobId: job.id });
      }
    }

    log.info('instagram.live.done', {
      status,
      reasonCode,
      externalAttempts,
      externalEffectAttempted,
      canaryAuthorizationId: canary?.id ?? null,
      jobId: job?.id ?? null,
    });

    return Object.freeze({
      status,
      reasonCode,
      detail,
      jobId: job?.id ?? null,
      manifestId: input.manifestId,
      prospectId: job?.prospectId ?? envelope?.prospectId ?? null,
      expectedHandle: job?.expectedHandle ?? envelope?.recipient ?? null,
      observedHandle,
      approvedText: envelope?.approvedText ?? null,
      approvedTextSha256: envelope?.approvedTextSha256 ?? null,
      transportPayloadSha256: envelope?.transportPayloadSha256 ?? null,
      liveReady,
      identityVerdict,
      sessionId,
      sessionState,
      gates: Object.freeze([...gates]),
      canary,
      externalAttempts,
      externalEffectAttempted,
      observation,
      outreachEventId,
      outreachState,
      eventId,
      screenshotPath,
      durationMs: Date.now() - started,
    });
  };

  try {
    // ---- §5.1 Mode LIVE explicite ----------------------------------------
    if (input.mode !== 'LIVE') {
      gates.push({ gate: 'mode', verdict: 'BLOCK', detail: `mode « ${input.mode} »` });
      return await finish('BLOCKED', 'IG_LIVE_MODE_REQUIRED', `mode « ${input.mode} » — un envoi réel exige LIVE`);
    }
    pass('mode', 'LIVE');

    // ---- §5.2 Adapter LIVE présent ---------------------------------------
    // Vérifié sur l'objet reçu, pas sur une constante globale : la question est
    // « ai-je de quoi envoyer ? », et seule la réponse de cet objet compte.
    if (!hasSendPrimitive(deps.rail)) {
      gates.push({ gate: 'live_adapter', verdict: 'BLOCK', detail: 'rail en lecture seule' });
      return await finish(
        'BLOCKED',
        'IG_LIVE_ADAPTER_MISSING',
        'le rail fourni n’expose aucune primitive d’envoi — il n’y a rien à appeler',
      );
    }
    const liveRail: InstagramLiveRail = deps.rail;
    pass('live_adapter', 'primitive d’envoi présente');

    // ---- §5.3 Arrêt global et plafonds -----------------------------------
    // Avant toute prise de job : un rail arrêté ne réserve rien.
    const snapshot = await loadSafetySnapshot(sql, config);
    const safety = evaluateSafety(snapshot, config);
    gates.push(...safety.gates);
    if (!safety.allowed) {
      // §6 — l'aperçu RAPPORTE ces gardes, il ne s'y arrête pas, et la mission
      // le demande explicitement : « avant de libérer le kill-switch, exécuter
      // encore une fois le chemin jusqu'au dernier point ». Un aperçu qui
      // exigerait l'arrêt déjà levé imposerait d'ouvrir la porte pour vérifier
      // qu'on peut l'ouvrir.
      //
      // L'exception ne coûte rien parce qu'un aperçu ne peut pas produire
      // d'effet, et pas seulement « parce qu'il est censé ne pas le faire » :
      //
      //   * la primitive sort avant toute saisie et avant le crochet d'effet ;
      //   * le crochet qu'on lui passe LÈVE, donc un clic resterait sans trace
      //     durable — et le rail ne clique jamais après une levée ;
      //   * l'autorisation canari n'est pas consommée sur ce chemin ;
      //   * `--preview` et `--live` s'excluent au parseur.
      //
      // Elle ne s'applique qu'aux gardes de SÛRETÉ. Manifeste, dérive,
      // autorisation, session et identité arrêtent l'aperçu comme un envoi :
      // ce sont précisément ce qu'il vient vérifier.
      if (!input.previewOnly) {
        return await finish('BLOCKED', safety.code, safety.reason);
      }
      log.warn('instagram.live.preview_over_safety_gate', { code: safety.code, reason: safety.reason });
    }

    // ---- Reprise des baux abandonnés -------------------------------------
    const recovered = await recoverExpiredLeases(sql);
    if (recovered.length > 0) {
      log.warn('instagram.live.lease_recovered', {
        recovered: recovered.length,
        reviewRequired: recovered.filter((row) => row.status === 'REVIEW_REQUIRED').length,
      });
    }
    await expireStaleCanaryAuthorizations(sql);

    // ---- §5.10 Le manifeste, revalidé intégralement -----------------------
    try {
      ({ envelope } = await resolveDispatchTarget(sql, input.manifestId, 'LIVE'));
    } catch (error) {
      if (error instanceof DispatchBlockedError) {
        gates.push({ gate: 'manifest', verdict: 'BLOCK', detail: error.code });
        return await finish('BLOCKED', error.code, error.message);
      }
      throw error;
    }
    pass('manifest', `manifeste ${envelope.manifestId} LOCKED, courant, empreintes recalculées`);

    // ---- §5.11 Transport ---------------------------------------------------
    if (envelope.transport !== 'instagram_dm') {
      gates.push({ gate: 'transport', verdict: 'BLOCK', detail: envelope.transport });
      return await finish(
        'BLOCKED',
        'IG_TRANSPORT_NOT_INSTAGRAM',
        `transport « ${envelope.transport} » — ce canari n'envoie que des instagram_dm`,
      );
    }
    pass('transport', 'instagram_dm');

    // ---- §5 Manifeste complet pour un envoi réel --------------------------
    const readiness = getLiveReadiness(envelope);
    liveReady = readiness.ready;
    if (!readiness.ready) {
      gates.push({ gate: 'live_ready', verdict: 'BLOCK', detail: readiness.missing.join(', ') });
      return await finish(
        'BLOCKED',
        'IG_LIVE_MANIFEST_NOT_READY',
        `manifeste incomplet pour un envoi réel (manque : ${readiness.missing.join(', ')})`,
      );
    }
    pass('live_ready', 'aucune propriété manquante');

    // ---- Le job, pris atomiquement ----------------------------------------
    const existing = await loadJobForManifest(sql, envelope.manifestId, input.action);
    if (existing === null) {
      gates.push({ gate: 'job', verdict: 'BLOCK', detail: 'aucun job enfilé' });
      return await finish(
        'BLOCKED',
        'IG_JOB_NOT_CLAIMABLE',
        `aucun job Instagram enfilé pour le manifeste ${envelope.manifestId} — enfiler d'abord (ig:enqueue)`,
      );
    }

    // §4 — un job qui a déjà tenté un effet ne repart JAMAIS, quel que soit son
    // statut apparent. Vérifié avant la prise : inutile de poser un bail sur un
    // job qu'on ne traitera pas.
    if (existing.externalEffectAttempted) {
      job = existing;
      gates.push({ gate: 'no_prior_effect', verdict: 'BLOCK', detail: 'external_effect_attempted = true' });
      return await finish(
        'BLOCKED',
        'IG_LIVE_EFFECT_ALREADY_ATTEMPTED',
        `le job ${existing.id} porte déjà une tentative d'effet externe (${existing.externalEffectStartedAt ?? 'date inconnue'}) — ` +
          'aucun rejeu automatique, quelle qu’en soit l’issue',
      );
    }

    const claimed = await claimNextInstagramJob(sql, {
      workerId,
      leaseMs: config.queue.leaseMs,
      jobId: existing.id,
    });
    if (claimed === null || claimed.claimToken === null) {
      job = existing;
      gates.push({ gate: 'job', verdict: 'BLOCK', detail: `statut ${existing.status}` });
      return await finish(
        'BLOCKED',
        'IG_JOB_NOT_CLAIMABLE',
        `le job ${existing.id} n'est pas réclamable (statut « ${existing.status} ») — ` +
          'terminal, déjà pris par un autre worker, ou pas encore dû',
      );
    }
    job = claimed;
    claimToken = claimed.claimToken;
    pass('job', `job ${claimed.id} pris (bail ${config.queue.leaseMs} ms)`);

    // ---- §5.13 Dérive job ↔ manifeste -------------------------------------
    const drift = detectJobManifestDrift(claimed, envelope);
    if (drift !== null) {
      gates.push({ gate: 'job_manifest_drift', verdict: 'BLOCK', detail: drift });
      return await finish(
        'BLOCKED',
        'IG_JOB_MANIFEST_DRIFT',
        `le manifeste a changé depuis l'enfilement du job (${drift}) — une cible qui bouge n'est pas une cible validée`,
      );
    }
    pass('job_manifest_drift', 'handle, empreintes et prospect inchangés');

    // ---- §5.4 L'autorisation canari ---------------------------------------
    const authorization = await loadCanaryForManifest(sql, envelope.manifestId);
    const verdict = checkCanaryAuthorization({
      authorization,
      manifestId: envelope.manifestId,
      action: input.action,
      expectedHandle: envelope.recipient,
      approvedTextSha256: envelope.approvedTextSha256,
      transportPayloadSha256: envelope.transportPayloadSha256,
      now: Date.now(),
    });
    if (!verdict.ok) {
      gates.push({ gate: 'canary_authorization', verdict: 'BLOCK', detail: verdict.code });
      return await finish('BLOCKED', verdict.code, verdict.reason);
    }
    canary = verdict.authorization;
    pass('canary_authorization', `autorisation ${canary.id} armée par ${canary.armedBy}, échéance ${canary.expiresAt}`);

    // ---- §5.14 Session ----------------------------------------------------
    let status: InstagramSessionStatus;
    try {
      status = await liveRail.ensureSession();
    } catch (error) {
      if (error instanceof InstagramRailError) {
        gates.push({ gate: 'session', verdict: 'BLOCK', detail: error.code });
        // Un profil occupé n'est pas un échec de rail, et la nuance n'est pas
        // cosmétique : `FAILED` alimente `consecutive_failures`, dont le plafond
        // (3) ferme le rail. Trois tours perdus contre la relève entrante — ce
        // que la cadence rend banal — auraient donc suffi à arrêter l'envoi en
        // affirmant qu'Instagram nous refusait, alors qu'aucun navigateur n'a
        // été ouvert. `BLOCKED` dit ce qui s'est vraiment passé : un refus, et
        // le job repart en file pour un tour ultérieur.
        return await finish(
          error.code === 'IG_BROWSER_PROFILE_BUSY' ? 'BLOCKED' : 'FAILED',
          error.code,
          error.message,
        );
      }
      throw error;
    }
    sessionId = await recordBrowserSession(sql, {
      workerId,
      profileLabel: status.profileLabel,
      headless: status.headless,
      state: status.state,
      detail: status.detail,
    });
    sessionState = status.state;
    if (!isUsableSessionState(status.state)) {
      gates.push({ gate: 'session', verdict: 'BLOCK', detail: status.state });
      return await finish('BLOCKED', SESSION_STATE_BLOCK_CODE[status.state], `session ${status.state} : ${status.detail}`);
    }
    pass('session', 'SESSION_READY');

    // ---- §5.16/§5.17 Profil exact et identité -----------------------------
    let profile;
    try {
      profile = await liveRail.openProfile(claimed.expectedHandle);
    } catch (error) {
      if (error instanceof InstagramRailError) {
        gates.push({ gate: 'profile', verdict: 'BLOCK', detail: error.code });
        return await finish(
          error.code === 'IG_BROWSER_PROFILE_BUSY' ? 'BLOCKED' : 'FAILED',
          error.code,
          error.message,
        );
      }
      throw error;
    }
    screenshotPath = profile.screenshotPath;
    sessionState = profile.sessionState;

    // §5.15 — challenge / captcha / blocage, relus SUR la page de profil.
    if (!isUsableSessionState(profile.sessionState)) {
      gates.push({ gate: 'session_on_profile', verdict: 'BLOCK', detail: profile.sessionState });
      return await finish(
        'BLOCKED',
        SESSION_STATE_BLOCK_CODE[profile.sessionState],
        `la page de profil a rendu un état ${profile.sessionState}` +
          (isHardStopSessionState(profile.sessionState)
            ? ' — arrêt dur : ce message d’Instagram s’adresse à un humain, le rail n’insiste pas'
            : ''),
      );
    }
    pass('session_on_profile', 'SESSION_READY');

    const identity = decideIdentity({
      expectedHandle: claimed.expectedHandle,
      signals: profile.signals,
      profileMissing: profile.profileMissing,
      redirected: profile.redirected,
    });
    observedHandle = identity.observedHandle;
    identityVerdict = identity.verdict;
    await recordIdentityCheck(sql, {
      jobId: claimed.id,
      manifestId: claimed.manifestId,
      prospectId: claimed.prospectId,
      sessionId,
      expectedHandle: claimed.expectedHandle,
      observedHandle: identity.observedHandle,
      observedUrl: profile.finalUrl,
      redirected: profile.redirected,
      verdict: identity.verdict,
      signals: profile.signals,
      detail: identity.detail,
    });
    if (identity.verdict !== 'MATCH') {
      gates.push({ gate: 'identity', verdict: 'BLOCK', detail: identity.verdict });
      return await finish('BLOCKED', IDENTITY_VERDICT_BLOCK_CODE[identity.verdict], identity.detail);
    }
    pass('identity', identity.detail);

    // ---- §6 L'aperçu s'arrête avant toute saisie --------------------------
    if (input.previewOnly) {
      const preview = await liveRail.sendFirstTouchDm({
        expectedHandle: claimed.expectedHandle,
        body: envelope.approvedText,
        stopAfter: 'thread',
        onBeforeExternalEffect: async () => {
          // Inatteignable : `previewOnly` sort avant. Écrit quand même, parce
          // qu'un crochet d'effet qui ne ferait rien serait un piège pour le
          // prochain diff.
          throw new Error('aperçu : aucun effet externe ne peut être journalisé');
        },
      });
      if (preview.kind === 'NOT_ATTEMPTED') {
        gates.push({ gate: 'composer', verdict: 'BLOCK', detail: preview.code });
        sessionState = preview.sessionState;
        if (preview.screenshotPath !== null) screenshotPath = preview.screenshotPath;
        return await finish('BLOCKED', preview.code, preview.detail);
      }
      if (preview.kind !== 'PREVIEWED') {
        // Impossible : `stopAfter: 'thread'` interdit toute autre branche.
        // Refuser bruyamment plutôt que d'interpréter.
        throw new Error(`aperçu : la primitive a rendu « ${preview.kind} » — état incohérent`);
      }
      sessionState = preview.sessionState;
      if (preview.screenshotPath !== null) screenshotPath = preview.screenshotPath;
      pass('composer', `fil ${preview.threadUrl ?? '—'} ouvert sur « ${preview.threadHandle ?? '—'} »`);
      pass('external_effect', 'aucun — aperçu');
      return await finish('PREVIEWED', 'IG_DRY_RUN_OK', preview.detail);
    }

    // ---- §3/§7 La réservation atomique ------------------------------------
    //
    // Le verrou qui départage deux workers, et RIEN de plus : elle prend la
    // main, elle ne dépense pas la tentative. C'est la correction d'IG2.1 §7 —
    // le 14 août, cette instruction consommait, et trois autorisations ont été
    // dépensées par des tentatives arrêtées avant le moindre octet.
    //
    // Tout ce que `checkCanaryAuthorization` a vérifié est revérifié dans le
    // `where` : la lecture qui l'a nourri appartient déjà au passé.
    const reserved = await reserveCanaryAuthorization(sql, {
      authorizationId: canary.id,
      jobId: claimed.id,
      workerId,
      manifestId: envelope.manifestId,
      expectedHandle: envelope.recipient,
      approvedTextSha256: envelope.approvedTextSha256,
      transportPayloadSha256: envelope.transportPayloadSha256,
    });
    if (reserved === null) {
      gates.push({ gate: 'canary_reservation', verdict: 'BLOCK', detail: 'réservation perdue' });
      return await finish(
        'BLOCKED',
        'IG_CANARY_RESERVATION_LOST',
        `l'autorisation ${canary.id} n'a pas pu être réservée — un autre worker l'a prise, ` +
          'elle a expiré, ou la cible a bougé entre la vérification et la réservation',
      );
    }
    canary = reserved;
    reservationHeld = true;
    pass(
      'canary_reservation',
      `autorisation ${reserved.id} réservée (${reserved.externalAttemptsUsed}/${reserved.maxExternalAttempts} tentative comptée)`,
    );

    // ---- §4/§7 Le journal, puis l'unique clic ------------------------------
    const capturedJobId = claimed.id;
    const capturedCanaryId = reserved.id;
    let send;
    try {
      send = await liveRail.sendFirstTouchDm({
        expectedHandle: claimed.expectedHandle,
        body: envelope.approvedText,
        stopAfter: null,
        onBeforeExternalEffect: async () => {
          // §8 — le dernier avis, AVANT toute dépense.
          //
          // En tête du crochet et pas ailleurs : ce qui suit consomme
          // l'autorisation et réserve le créneau, deux écritures qu'un refus
          // tardif ne saurait pas défaire. Lever ici ne coûte rien — ni
          // autorisation dépensée, ni tentative comptée, ni clic — et
          // l'exception remonte jusqu'au `catch` ci-dessous, qui constatera
          // `externalEffectAttempted === false` et conclura « zéro effet ».
          if (deps.beforeExternalEffect !== undefined) {
            await deps.beforeExternalEffect();
          }

          // IG2.1 §7 — l'instant irréversible, et son ORDRE.
          //
          // La consommation d'abord : elle est ce qui départage définitivement,
          // et un échec ici doit empêcher le clic. Le drapeau du job ensuite,
          // dans sa propre écriture, committé avant que l'appelant clique — un
          // processus tué entre les deux laisse une autorisation dépensée sur un
          // job qui n'a rien tenté, ce qui est le sens prudent de l'erreur.
          //
          // Les deux écritures précèdent le clic ; si l'une échoue, l'exception
          // remonte et la primitive ne clique pas. L'ordre n'est pas une
          // convention, c'est le flot de contrôle.
          const spent = await consumeCanaryReservation(sql, {
            authorizationId: capturedCanaryId,
            jobId: capturedJobId,
            workerId,
          });
          if (spent === null) {
            throw new InstagramRailError(
              'IG_RAIL_ERROR',
              `l'autorisation ${capturedCanaryId} n'a pas pu être consommée à l'instant du clic — ` +
                'réservation perdue, expirée ou déjà dépensée : aucun clic',
            );
          }
          canary = spent;
          reservationHeld = false;

          // IG3 §5 — la réservation transactionnelle a remplacé l'inscription
          // nue. Elle fait la même chose (poser le drapeau AVANT le clic, dans
          // sa propre transaction committée) et une de plus : elle recompte les
          // plafonds sous un verrou du compte émetteur, sur les TENTATIVES
          // d'effet et non sur les envois réussis.
          //
          // Ce dernier point est celui qui ferme la course. `evaluateSafety`,
          // évalué plus haut, compte des `SENT` : deux workers arrivés ici à la
          // même milliseconde n'en verraient aucun — le premier n'a pas encore
          // cliqué — et passeraient tous les deux. Ici, le second attend le
          // verrou, recompte, voit la tentative du premier, et refuse.
          //
          // Dans ce dépôt la course est déjà impossible par ailleurs (une seule
          // autorisation canari peut être armée à la fois, index unique partiel
          // 0031). La garde est posée quand même : elle survivra au jour où
          // cette autorisation cessera d'être unique.
          await reserveExternalEffectSlot(sql, config, {
            jobId: capturedJobId,
            canaryAuthorizationId: capturedCanaryId,
          });
          externalEffectAttempted = true;
          externalAttempts = 1;
          log.warn('instagram.live.external_effect_starting', { jobId: capturedJobId, canaryId: capturedCanaryId });
        },
      });
    } catch (error) {
      // §4 — après le drapeau, plus aucun rejeu : une panne survenue pendant le
      // clic laisse une issue INCONNUE, pas une issue nulle.
      const message = error instanceof Error ? error.message : String(error);
      if (externalEffectAttempted) {
        gates.push({ gate: 'external_effect', verdict: 'BLOCK', detail: 'panne après le drapeau' });
        return await finish(
          'AMBIGUOUS',
          'IG_LIVE_AMBIGUOUS',
          `panne pendant la primitive d'envoi, après inscription de la tentative : ${message}. ` +
            'Issue inconnue — aucun rejeu, tranchage humain requis.',
        );
      }
      gates.push({ gate: 'external_effect', verdict: 'BLOCK', detail: 'panne avant le drapeau' });
      return await finish(
        'FAILED',
        error instanceof InstagramRailError ? error.code : 'IG_RAIL_ERROR',
        `panne avant toute tentative d'effet : ${message}`,
      );
    }

    if (send.kind === 'NOT_ATTEMPTED') {
      // IG2.1 §7 — la primitive a renoncé AVANT le clic : zéro octet, zéro
      // effet. L'autorisation est rendue à l'état armé plutôt que dépensée, et
      // le `finally` s'en charge (il couvre aussi les pannes).
      //
      // Ce que cela ne rouvre pas : l'échéance courte, l'unicité de
      // l'autorisation vivante et la révocation systématique en fin de commande
      // ne bougent pas. Reprendre coûte toujours une décision d'humain ; ce qui
      // change est que le compteur d'effets externes cesse de compter des
      // renoncements.
      sessionState = send.sessionState;
      if (send.screenshotPath !== null) screenshotPath = send.screenshotPath;
      gates.push({ gate: 'composer', verdict: 'BLOCK', detail: send.code });
      return await finish('BLOCKED', send.code, send.detail);
    }
    if (send.kind === 'PREVIEWED' || send.kind === 'DRAFT_READY') {
      throw new Error(`envoi : la primitive a rendu « ${send.kind} » — état incohérent`);
    }

    observation = send.observation;
    sessionState = observation.sessionState;
    if (observation.screenshotPath !== null) screenshotPath = observation.screenshotPath;
    pass('external_effect', 'une primitive externe appelée, une seule');

    // ---- §8 La preuve, ou l'ambiguïté -------------------------------------
    const judgement = judgeSendOutcome(observation, claimed.expectedHandle);
    if (judgement.outcome === 'DELIVERY_FAILED') {
      // Terminal, et AUCUN `outreach_event` : la table qui atteste qu'un humain
      // a été joint n'a rien à dire d'un message qu'Instagram n'a pas remis.
      // Aucun rejeu non plus — recommencer serait un second message décidé par
      // personne, sur une autorisation déjà dépensée.
      gates.push({ gate: 'send_proof', verdict: 'BLOCK', detail: judgement.missing.join(' ; ') || 'échec de livraison' });
      return await finish('DELIVERY_FAILED', 'IG_LIVE_DELIVERY_FAILED', judgement.detail);
    }
    if (judgement.outcome === 'AMBIGUOUS') {
      gates.push({ gate: 'send_proof', verdict: 'BLOCK', detail: judgement.missing.join(' ; ') });
      return await finish('AMBIGUOUS', 'IG_LIVE_AMBIGUOUS', judgement.detail);
    }
    pass('send_proof', judgement.detail);

    // ---- §10 L'unique outreach_event et l'état commercial ------------------
    const outcome = await recordSentOutcome(sql, {
      envelope,
      job: claimed,
      canaryId: reserved.id,
      threadUrl: observation.threadUrl,
    });
    outreachEventId = outcome.outreachEventId;
    outreachState = outcome.outreachState;

    return await finish('SENT', 'IG_LIVE_SENT', judgement.detail);
  } finally {
    // IG2.1 §7 — rendre la main si on la tient encore.
    //
    // Ce chemin couvre tous les arrêts strictement antérieurs au clic : refus
    // de la primitive, panne, exception inattendue. Il est SÛR par construction
    // et pas par prudence d’appelant : releaseCanaryReservation exige
    // state = 'RESERVED', et une autorisation consommée porte 'CONSUMED' — il
    // n’existe donc aucun chemin où un relâchement rouvrirait le droit
    // d’envoyer après un effet.
    if (reservationHeld && canary !== null && job !== null && !externalEffectAttempted) {
      const released = await releaseCanaryReservation(sql, {
        authorizationId: canary.id,
        jobId: job.id,
        workerId,
      }).catch(() => null);
      if (released !== null) {
        canary = released;
        log.info('instagram.live.canary_released', {
          canaryId: released.id,
          detail: 'arrêt avant tout effet externe — autorisation rendue, aucune tentative comptée',
        });
      }
    }
    if (sessionId !== null) await closeBrowserSession(sql, sessionId).catch(() => undefined);
    await deps.rail.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Écritures terminales
// ---------------------------------------------------------------------------

async function loadJobForManifest(
  sql: Sql,
  manifestId: string,
  action: InstagramAction,
): Promise<InstagramJob | null> {
  const rows = await sql.query<{ id: string }>(
    `select id from ig_dispatch_jobs where manifest_id = $1 and action = $2`,
    [manifestId, action],
  );
  const id = rows[0]?.id;
  if (id === undefined) return null;
  return loadInstagramJob(sql, id);
}

interface SentOutcome {
  readonly outreachEventId: string;
  readonly outreachState: string | null;
}

/**
 * IG2 §10 — inscrit le contact, exactement une fois.
 *
 * `outreach_events` est LA table canonique du « un humain a été joint », celle
 * que la vue CRM et le gate lisent déjà. Elle reçoit donc le DM au même titre
 * qu'un email : même `kind = 'sent'`, même `manifest_id`, et `channel =
 * 'instagram_dm'` — le vocabulaire des transports R6B, pas un nouveau. La
 * timeline CRM le reflète sans qu'une ligne de `src/lib/crm` change.
 *
 * L'unicité ne dépend pas de ce code mais de l'index
 * `outreach_events_one_sent_per_manifest_idx` (0023), qui refuserait un second
 * événement pour le même manifeste quel que soit le chemin qui l'écrit.
 *
 * Ce qui n'est PAS écrit ici, et pourquoi : `r6b_dispatch_attempts`. Ce journal
 * est celui du dispatcher à provider, et ses contraintes le disent — un `SENT`
 * y exige `provider_message_id` et `live_attempt_id` (0023,
 * `r6b_dispatch_attempt_sent_has_receipt`). Un DM envoyé depuis un navigateur
 * n'a ni reçu provider ni ligne de réservation email : l'y forcer demanderait
 * d'affaiblir une contrainte qui protège le chemin email, ou d'inventer un
 * identifiant. Le journal d'Instagram est `ig_job_events`, qui porte la même
 * exigence dans SON vocabulaire (statut `SENT`, effet externe, autorisation
 * canari rattachée) — et c'est là que la tentative est inscrite.
 *
 * L'état commercial passe par `ensureContacted`, c'est-à-dire par la machine à
 * états existante : la mission interdit d'en reconstruire une parallèle pour
 * Instagram, et il n'y en a pas.
 */
async function recordSentOutcome(
  sql: Sql,
  input: {
    envelope: DispatchEnvelope;
    job: InstagramJob;
    canaryId: string;
    threadUrl: string | null;
  },
): Promise<SentOutcome> {
  const { envelope, job } = input;

  const outreachEventId = await sql.transaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `insert into outreach_events (prospect_id, kind, channel, payload, manifest_id)
       values ($1,'sent',$2,$3::jsonb,$4)
       returning id`,
      [
        envelope.prospectId,
        envelope.transport,
        JSON.stringify({
          rail: 'instagram',
          action: job.action,
          recipient: envelope.recipient,
          approved_text_sha256: envelope.approvedTextSha256,
          transport_payload_sha256: envelope.transportPayloadSha256,
          idempotency_key: job.idempotencyKey,
          ig_job_id: job.id,
          canary_authorization_id: input.canaryId,
          thread_url: input.threadUrl,
        }),
        envelope.manifestId,
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('outreach_events insert did not return a row');
    return id;
  });

  // Hors transaction, et volontairement : `ensureContacted` est idempotent et
  // rend un résultat plutôt qu'une exception. Un état commercial qui échouerait
  // ne doit pas annuler la preuve qu'un message est parti — le fait est
  // irréversible, sa projection ne l'est pas.
  const transition = await ensureContacted(sql, envelope.prospectId, outreachEventId);
  return { outreachEventId, outreachState: transition?.toState ?? null };
}
