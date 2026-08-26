import type { DispatchBlockCode } from '@/lib/pipeline/r6bDispatcher';

/**
 * IG-R1 — le vocabulaire du rail Instagram.
 *
 * Ce module ne contient que des types et des constantes. Aucun import de base
 * de données, aucun import de Playwright, aucune I/O : il peut être lu par
 * n'importe quelle couche sans rien entraîner derrière lui.
 *
 * Les unions ci-dessous sont fermées à dessein. Un code de refus qui serait un
 * `string` libre laisserait un appelant inventer « OK_PROBABLY » ; ici, tout
 * refus doit avoir été nommé dans un diff.
 */

/** Le seul mode que ce dépôt sait exécuter pour Instagram. Voir `INSTAGRAM_MODES`. */
export type InstagramMode = 'DRY_RUN' | 'LIVE';

/**
 * La seule action connue du rail. Ni `follow`, ni `like`, ni `comment`, ni
 * `profile_update` : ces valeurs n'existent pas dans la taxonomie, donc aucun
 * job ne peut les porter et la base les refuserait (0029,
 * `ig_dispatch_jobs.action`).
 */
export type InstagramAction = 'first_touch_dm';

export const INSTAGRAM_ACTIONS: readonly InstagramAction[] = ['first_touch_dm'];

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * L'état d'une session navigateur, tel que le rail l'a CONSTATÉ — jamais
 * supposé. `UNKNOWN` est un état de plein droit : il vaut mieux dire « je ne
 * sais pas » que classer par défaut dans « prêt ».
 */
export type InstagramSessionState =
  | 'SESSION_READY'
  | 'LOGIN_REQUIRED'
  | 'SESSION_EXPIRED'
  /**
   * Une session parfaitement valide — mais celle de QUELQU'UN D'AUTRE.
   *
   * Cet état est né d'un fait, pas d'une précaution. Le 24 août 2026, le
   * bootstrap a rendu `SESSION_READY` sur une session
   * authentifiée comme `bot72882552562736`, alors que le compte de Hermes est
   * `hermes__`. Rien n'avait menti : la session ÉTAIT prête, et les marqueurs
   * d'authentification étaient bien là. Ce que personne ne demandait, c'est
   * À QUI elle appartenait — « connecté » et « connecté sous notre nom »
   * étaient tenus pour une seule proposition.
   *
   * Il est distinct de `LOGIN_REQUIRED` parce que l'action à mener l'est : il
   * ne manque pas une connexion, il en manque la BONNE, et se reconnecter sans
   * écarter d'abord le profil ramène au même endroit.
   */
  | 'SESSION_WRONG_ACCOUNT'
  | 'CHALLENGE'
  | 'CAPTCHA'
  | 'BLOCKED'
  | 'UNKNOWN';

export const INSTAGRAM_SESSION_STATES: readonly InstagramSessionState[] = [
  'SESSION_READY',
  'LOGIN_REQUIRED',
  'SESSION_EXPIRED',
  'SESSION_WRONG_ACCOUNT',
  'CHALLENGE',
  'CAPTCHA',
  'BLOCKED',
  'UNKNOWN',
];

/**
 * Les états devant lesquels le rail s'arrête net et ne réessaie pas.
 *
 * Un challenge, un CAPTCHA ou un blocage sont des messages d'Instagram
 * adressés à un humain. Les traiter comme des erreurs transitoires reviendrait
 * à insister — c'est-à-dire, exactement, à contourner. Le rail les remonte à
 * un opérateur et s'arrête ; aucune résolution automatique n'existe dans ce dépôt,
 * ni ne doit y être ajoutée (mission IG-R1 §1 : aucun bypass CAPTCHA, aucun
 * contournement de challenge, aucun fingerprint spoofing, aucun proxy rotatif,
 * aucune technique anti-détection).
 *
 * `SESSION_WRONG_ACCOUNT` les rejoint pour une raison différente et non moins
 * ferme : recharger la page ne changera jamais l'identité du compte connecté.
 * Réessayer n'est pas seulement inutile, c'est trompeur — cela donnerait
 * l'apparence d'une panne passagère à ce qui demande un geste humain.
 */
export const HARD_STOP_SESSION_STATES: readonly InstagramSessionState[] = [
  'CHALLENGE',
  'CAPTCHA',
  'BLOCKED',
  'SESSION_WRONG_ACCOUNT',
];

export function isHardStopSessionState(state: InstagramSessionState): boolean {
  return HARD_STOP_SESSION_STATES.includes(state);
}

/** Le seul état qui autorise la suite. Tous les autres refusent, y compris `UNKNOWN`. */
export function isUsableSessionState(state: InstagramSessionState): state is 'SESSION_READY' {
  return state === 'SESSION_READY';
}

// ---------------------------------------------------------------------------
// Identité
// ---------------------------------------------------------------------------

/**
 * Le verdict d'une vérification d'identité. Un seul autorise la suite.
 *
 * `UNAVAILABLE` mérite son existence propre : « je n'ai pas pu vérifier » n'est
 * ni un `MATCH` (ce serait une invention) ni un `MISMATCH` (ce serait une
 * accusation). C'est un refus qui dit la vérité sur sa cause.
 */
export type InstagramIdentityVerdict = 'MATCH' | 'MISMATCH' | 'NOT_FOUND' | 'AMBIGUOUS' | 'UNAVAILABLE';

/** Un indice d'identité observé, nommé, avec sa valeur brute ou son absence. */
export interface InstagramIdentitySignal {
  /** D'où vient l'indice : URL canonique finale, balise `og:url`, en-tête du profil. */
  readonly name: 'canonical_url' | 'og_url' | 'profile_header';
  /** Le handle extrait, ou `null` si l'indice n'a pas pu être lu. */
  readonly handle: string | null;
  /** Ce qui a été lu tel quel, borné, pour qu'un humain puisse contester le verdict. */
  readonly raw: string | null;
}

// ---------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------

export type InstagramJobStatus =
  | 'PENDING'
  | 'CLAIMED'
  | 'DRY_RUN_VALIDATED'
  /** IG3 §8 — reporté par l'ordonnanceur. Réclamable, et `not_before` dit quand. */
  | 'SKIPPED'
  | 'BLOCKED'
  | 'FAILED'
  | 'SENT'
  | 'REVIEW_REQUIRED'
  /** IG2.1 §4 — Instagram a refusé de remettre le message. Rien n'est parti. */
  | 'DELIVERY_FAILED'
  /** IG3 §2 — refusé pour une raison métier, définitivement, sans rien avoir tenté. */
  | 'INELIGIBLE';

/**
 * Les quatre statuts absorbants. Un job qui les atteint ne repart jamais dans la
 * file : `SENT` parce qu'une intention réalisée ne se rejoue pas,
 * `REVIEW_REQUIRED` parce qu'un « on ne sait pas » se tranche par un humain,
 * pas par un nouvel essai (mission IG-R1 §4), `DELIVERY_FAILED` — ajouté par
 * IG2.1 — parce qu'un échec de livraison est une issue CONNUE, pas une panne
 * transitoire, et `INELIGIBLE` — ajouté par IG3 — parce qu'un refus métier ne
 * change pas d'avis tout seul.
 *
 * Le troisième point mérite d'être dit franchement, parce qu'il va contre
 * l'intuition : un message qu'Instagram n'a pas remis se retente d'un clic dans
 * l'interface, et un rail qui le ferait tout seul serait « utile ». Ce serait
 * aussi un rail qui envoie un second message sans qu'aucun humain ne l'ait
 * redécidé, sur une cible dont l'unique autorisation est déjà dépensée. Le
 * rejeu, s'il a lieu un jour, passera par un nouvel armement nominatif.
 *
 * Le quatrième aussi : `INELIGIBLE` est le seul absorbant qui n'a jamais rien
 * tenté, et la base l'impose (`ig_job_ineligible_has_no_effect`, 0039).
 */
export const TERMINAL_JOB_STATUSES: readonly InstagramJobStatus[] = [
  'SENT',
  'REVIEW_REQUIRED',
  'DELIVERY_FAILED',
  'INELIGIBLE',
];

/**
 * Les statuts depuis lesquels un job peut être repris.
 *
 * `CLAIMED` n'y figure pas : un bail en cours n'est pas réclamable, et un bail
 * EXPIRÉ ne l'est qu'après examen de `external_effect_attempted` — décision
 * qui appartient à `recoverExpiredLeases`, pas à une simple liste.
 *
 * `SKIPPED` y figure, et c'est tout le sens du mot : un report attend son heure
 * dans `not_before`, il ne sort pas de la file.
 */
export const CLAIMABLE_JOB_STATUSES: readonly InstagramJobStatus[] = [
  'PENDING',
  'DRY_RUN_VALIDATED',
  'BLOCKED',
  'FAILED',
  'SKIPPED',
];

export function isTerminalJobStatus(status: InstagramJobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/**
 * IG3 §1 — l'état de file tel qu'un opérateur le lit, dérivé et jamais stocké.
 *
 * `SCHEDULED` n'est pas un statut de plus en base, et c'est délibéré : un job
 * « programmé » est exactement un job réclamable dont `not_before` est dans le
 * futur. Le matérialiser en colonne créerait une seconde vérité qu'un
 * `now()` qui passe rendrait fausse sans que personne n'écrive une ligne — le
 * genre d'état qui ment entre deux réveils du worker.
 */
export type InstagramQueueState = InstagramJobStatus | 'SCHEDULED';

export function deriveQueueState(
  status: InstagramJobStatus,
  notBefore: string | Date,
  now: Date,
): InstagramQueueState {
  if (!CLAIMABLE_JOB_STATUSES.includes(status)) return status;
  const due = notBefore instanceof Date ? notBefore : new Date(notBefore);
  return due.getTime() > now.getTime() ? 'SCHEDULED' : status;
}

// ---------------------------------------------------------------------------
// Reports et refus (IG3 §8)
// ---------------------------------------------------------------------------

/**
 * Pourquoi un job n'a pas été traité maintenant, dans un vocabulaire fermé.
 *
 * La liste est celle de la mission §8, plus les motifs que l'éligibilité
 * (§2) sait prononcer. Identique, mot pour mot, à la contrainte `check` de
 * `ig_dispatch_jobs.last_skip_reason` et `ig_job_events.skip_reason` (0039) :
 * une valeur inventée ne compile pas, et si elle compilait la base la
 * refuserait.
 */
export type InstagramSkipReason =
  // --- Ordonnancement : vrai maintenant, faux plus tard ---------------------
  | 'not_due_yet'
  | 'outside_window'
  | 'hourly_cap'
  | 'daily_cap'
  | 'cooldown'
  | 'kill_switch'
  | 'consecutive_failures'
  | 'session_failures'
  // --- Rail : une panne ou un état qu'une reconnexion peut changer ----------
  | 'login_required'
  | 'session_unavailable'
  | 'challenge'
  | 'target_unreachable'
  | 'composer_unavailable'
  | 'manifest_drift'
  | 'rail_failure'
  // --- Métier : vrai tant qu'un humain n'a pas redécidé ---------------------
  | 'identity_failure'
  | 'duplicate'
  | 'already_contacted'
  | 'review_required'
  | 'opt_out'
  | 'icp_not_target'
  /**
   * R7.6-GATE — l'audience sociale ATTRIBUÉE dépasse le créneau que nous
   * savons servir. Nommé à part d'`icp_not_target` : une entreprise trop
   * grande n'est pas une franchise, et un refus déguisé en un autre se
   * relit de travers six mois plus tard.
   */
  | 'audience_out_of_scope'
  /**
   * HERMES-AUTONOMOUS-R2 — l'audience attribuée est SOUS le seuil canonique,
   * mais assez près pour qu'un envoi AUTOMATIQUE ne s'y engage pas.
   *
   * Distinct d'`audience_out_of_scope`, et volontairement TEMPORARY : le
   * prospect n'est pas hors créneau, il est trop près du bord pour qu'une
   * mesure vieillissante suffise à décider sans personne. Une observation plus
   * récente le rouvre — vers l'éligibilité, ou vers le refus terminal.
   */
  | 'audience_borderline'
  /**
   * HERMES-SERVICE-SCOPE-TARGETING-R1 §3 — ce commerce commercialise une prestation
   * NON-PRESTATION STANDARD (REVENTE, boutique en ligne, revente, vente de produits, mécanique, formation…).
   *
   * Nommé à part d'`icp_not_target`, et la distinction porte : `icp_not_target`
   * dit « ce n'est pas le bon TYPE d'entreprise » (une franchise, un réseau),
   * celui-ci dit « c'est la bonne famille d'entreprise et la mauvaise OFFRE ».
   * Deux refus différents sous un seul mot se compteraient ensemble et se
   * reliraient de travers six mois plus tard.
   */
  | 'service_scope_not_in_scope_only'
  /**
   * §17 — aucune ancre observée ne place ce commerce sur le marché français.
   *
   * TEMPORAIRE, et c'est tout le sens du mot : nous ne savons pas qu'il est
   * hors marché, nous savons que nous ne savons pas. `prospects.country` ne
   * répond pas — il vaut « FR » pour tout le corpus parce qu'il est écrit en
   * dur à la découverte. Une mention légale lue plus tard rouvre le prospect.
   */
  | 'market_scope_unknown'
  | 'prospect_inactive'
  | 'payload_unavailable'
  | 'identity_provenance_missing'
  /**
   * HERMES-MANIFEST-OPERATOR-RETIREMENT-R1 — une personne nommée a RETIRÉ cette
   * intention, avant tout effet extérieur.
   *
   * Le seul motif de cette liste qui ne parle ni du prospect, ni de la
   * plateforme, ni d'une panne : il parle de NOUS. Le prospect peut être
   * parfaitement éligible et l'identité confirmée — c'est le TEXTE, ou la
   * décision de l'envoyer, qu'on ne veut plus. Réutiliser `review_required`
   * aurait mis en file d'attente humaine une ligne qui ne pose aucune question,
   * et `icp_not_target` aurait accusé le prospect d'un défaut qui n'est pas le
   * sien.
   *
   * TERMINAL sans hésitation : une intention retirée par quelqu'un ne se rouvre
   * pas parce que l'horloge tourne. Ce qui repart, s'il doit repartir, est une
   * intention NEUVE — brouillon, vote, manifeste, job — qui repasse toutes les
   * portes comme la première fois.
   */
  | 'operator_retired';

/**
 * Un report qui attend son heure, ou un refus qui n'en attend aucune.
 *
 * Toute la mission §8 tient dans cette distinction : « un skip temporaire ne
 * doit pas devenir terminal par erreur ; un blocage métier terminal ne doit pas
 * être rejoué ». Elle n'est pas laissée au jugement de l'appelant — la table
 * ci-dessous est exhaustive par le type, et la base refuse d'inscrire un motif
 * TERMINAL sur un job resté réclamable (`ig_job_terminal_skip_is_absorbing`).
 */
export type InstagramSkipClass = 'TEMPORARY' | 'TERMINAL';

export const SKIP_REASON_CLASS: Readonly<Record<InstagramSkipReason, InstagramSkipClass>> = Object.freeze({
  not_due_yet: 'TEMPORARY',
  outside_window: 'TEMPORARY',
  hourly_cap: 'TEMPORARY',
  daily_cap: 'TEMPORARY',
  cooldown: 'TEMPORARY',
  kill_switch: 'TEMPORARY',
  consecutive_failures: 'TEMPORARY',
  session_failures: 'TEMPORARY',
  login_required: 'TEMPORARY',
  session_unavailable: 'TEMPORARY',
  // Un challenge est un message d'Instagram adressé à un humain. TEMPORARY dit
  // « le job reste dans la file » ; il ne dit pas « on réessaie tout de suite ».
  // C'est le worker qui s'arrête net (`hardStop`), et un humain qui rouvre.
  challenge: 'TEMPORARY',
  target_unreachable: 'TEMPORARY',
  composer_unavailable: 'TEMPORARY',
  // Une dérive de manifeste se répare : quelqu'un reverrouille la bonne cible.
  // Le job attend cette décision plutôt que de mourir avec elle.
  manifest_drift: 'TEMPORARY',
  rail_failure: 'TEMPORARY',
  // L'identité ne correspond plus à ce qui a été approuvé : le compte a été
  // renommé, ou n'a jamais été le bon. Aucun nouvel essai ne changera cela.
  identity_failure: 'TERMINAL',
  duplicate: 'TERMINAL',
  already_contacted: 'TERMINAL',
  review_required: 'TERMINAL',
  opt_out: 'TERMINAL',
  icp_not_target: 'TERMINAL',
  // Une entreprise ne redevient pas plus petite au prochain essai.
  audience_out_of_scope: 'TERMINAL',
  // Une marge de confiance, pas un verdict : une mesure plus récente tranche
  // dans un sens ou dans l'autre, donc le prospect reste dans la file.
  audience_borderline: 'TEMPORARY',
  // Une entreprise qui vend du REVENTE ne cesse pas d'en vendre au prochain essai.
  // Si son offre change vraiment, c'est une nouvelle décision — pas un rejeu.
  service_scope_not_in_scope_only: 'TERMINAL',
  // Une absence d'observation ne condamne personne (CLAUDE.md §2) : le job
  // reste dans la file, et une preuve d'ancrage le rouvre.
  market_scope_unknown: 'TEMPORARY',
  prospect_inactive: 'TERMINAL',
  // Un geste humain ne s'annule pas tout seul au prochain réveil du worker.
  operator_retired: 'TERMINAL',
  payload_unavailable: 'TERMINAL',
  identity_provenance_missing: 'TERMINAL',
});

export function skipClassOf(reason: InstagramSkipReason): InstagramSkipClass {
  return SKIP_REASON_CLASS[reason];
}

export function isTerminalSkip(reason: InstagramSkipReason): boolean {
  return SKIP_REASON_CLASS[reason] === 'TERMINAL';
}

// ---------------------------------------------------------------------------
// Motifs
// ---------------------------------------------------------------------------

/**
 * Tout ce que le rail sait refuser, et rien d'autre.
 *
 * Les codes empruntés à R6B (`MANIFEST_*`, `RECIPIENT_*`, `TRANSPORT_*`,
 * `APPROVED_TEXT_*`) ne sont pas redéclarés ici : le worker relaie tel quel le
 * `DispatchBlockCode` levé par `resolveDispatchTarget`. Deux tables de codes
 * seraient deux vocabulaires, et l'un des deux finirait par mentir.
 */
export type InstagramBlockCode =
  /** L'arrêt global est armé. Fermé par défaut : une base sans ligne vaut « armé ». */
  | 'IG_KILL_SWITCH_ENGAGED'
  /**
   * Le profil navigateur est déjà ouvert par l'autre runtime Hermes (relève
   * entrante ou worker sortant). Un REFUS, jamais un échec : aucun navigateur
   * n'a été ouvert, aucune session n'a été jugée, et le job repart en file
   * pour un tour ultérieur. Le classer parmi les échecs ferait grossir
   * `consecutive_failures` sur une contention parfaitement normale, et
   * finirait par fermer le rail sans qu'il ait rien de cassé.
   */
  | 'IG_BROWSER_PROFILE_BUSY'
  /**
   * HERMES-AUTONOMOUS-R2 §7/§8 — la politique autonome, rejouée sur l'état
   * courant, refuse ce prospect. Le MOTIF exact vit dans `skip_reason` ; ce
   * code dit seulement d'où vient le refus, et donc qu'aucun humain n'a été
   * consulté ni ne l'a été à tort.
   */
  | 'IG_AUTONOMOUS_POLICY_REFUSED'
  /**
   * §7 — ce manifeste n'a pas été approuvé par la politique autonome, ou son
   * autorisation d'effet a été armée par quelqu'un d'autre. Le worker autonome
   * n'agit que sur ses propres décisions : un manifeste humain garde son
   * chemin humain (`ig:live`).
   */
  | 'IG_NOT_AUTONOMOUS_APPROVAL'
  /** Un LIVE a été demandé au worker DRY-RUN. L'envoi a son chemin, ce n'est pas celui-ci. */
  | 'IG_LIVE_NOT_ON_THIS_PATH'
  /** Le worker DRY-RUN s'est vu confier un rail capable d'agir. Il refuse de le tenir. */
  | 'IG_LIVE_RAIL_ON_DRY_RUN_PATH'
  // --- Chemin LIVE (IG2) --------------------------------------------------
  /** Le worker canari a reçu autre chose que `LIVE`. */
  | 'IG_LIVE_MODE_REQUIRED'
  /** Le worker canari a reçu un rail sans primitive d'envoi : il n'y a rien à appeler. */
  | 'IG_LIVE_ADAPTER_MISSING'
  /** Le manifeste n'a pas tout ce qu'un envoi réel exige (`getLiveReadiness`). */
  | 'IG_LIVE_MANIFEST_NOT_READY'
  /** Le job porte déjà `external_effect_attempted` : plus jamais de rejeu automatique. */
  | 'IG_LIVE_EFFECT_ALREADY_ATTEMPTED'
  // --- Autorisation canari (IG2 §3) ---------------------------------------
  | 'IG_CANARY_NOT_ARMED'
  | 'IG_CANARY_EXPIRED'
  | 'IG_CANARY_CONSUMED'
  | 'IG_CANARY_REVOKED'
  | 'IG_CANARY_MANIFEST_MISMATCH'
  | 'IG_CANARY_ACTION_MISMATCH'
  | 'IG_CANARY_HANDLE_MISMATCH'
  | 'IG_CANARY_PAYLOAD_DRIFT'
  /** La réservation atomique a été perdue : un autre worker l'a prise d'abord. */
  | 'IG_CANARY_RESERVATION_LOST'
  /** IG2.1 §7 — un worker tient déjà la main sur cette autorisation. Zéro effet. */
  | 'IG_CANARY_RESERVED_ELSEWHERE'
  /** IG2.1 §7 — la réservation n'a pas pu être consommée à l'instant du clic. Zéro effet. */
  | 'IG_CANARY_CONSUMPTION_LOST'
  // --- Refus de la primitive, AVANT tout clic (IG2 §2) --------------------
  | 'IG_SEND_SESSION_LOST'
  | 'IG_SEND_THREAD_IDENTITY_UNCONFIRMED'
  | 'IG_SEND_COMPOSER_NOT_FOUND'
  | 'IG_SEND_PAYLOAD_NOT_ENTERED'
  | 'IG_SEND_CONTROL_NOT_FOUND'
  /** Le manifeste n'est pas un manifeste Instagram. */
  | 'IG_TRANSPORT_NOT_INSTAGRAM'
  /** Le manifeste a bougé depuis l'enfilement du job (handle ou empreinte). */
  | 'IG_JOB_MANIFEST_DRIFT'
  /** Le job visé n'est pas réclamable (terminal, déjà pris, ou pas encore dû). */
  | 'IG_JOB_NOT_CLAIMABLE'
  // --- Plafonds -----------------------------------------------------------
  | 'IG_CAP_DAILY_SENT'
  | 'IG_CAP_HOURLY_SENT'
  | 'IG_CAP_MIN_INTERVAL'
  | 'IG_CAP_CONSECUTIVE_FAILURES'
  | 'IG_CAP_SESSION_FAILURES'
  // --- Session ------------------------------------------------------------
  | 'IG_SESSION_LOGIN_REQUIRED'
  | 'IG_SESSION_EXPIRED'
  | 'IG_SESSION_CHALLENGE'
  | 'IG_SESSION_CAPTCHA'
  | 'IG_SESSION_BLOCKED'
  | 'IG_SESSION_WRONG_ACCOUNT'
  | 'IG_SESSION_UNKNOWN'
  // --- Identité -----------------------------------------------------------
  | 'IG_IDENTITY_MISMATCH'
  | 'IG_IDENTITY_NOT_FOUND'
  | 'IG_IDENTITY_AMBIGUOUS'
  | 'IG_IDENTITY_UNAVAILABLE';

/** Pannes techniques : le rail n'a pas pu conclure, personne n'a été contacté. */
export type InstagramFailureCode = 'IG_BROWSER_LAUNCH_FAILED' | 'IG_NAVIGATION_FAILED' | 'IG_RAIL_ERROR';

/**
 * Motifs écrits par la reprise de bail, jamais par un worker : le premier
 * remet un job dans la file, le second le fige en attente d'un humain.
 */
export type InstagramRecoveryCode = 'IG_LEASE_EXPIRED' | 'IG_LEASE_EXPIRED_AFTER_EFFECT';

/**
 * Tout motif que le rail sait écrire.
 *
 * `DispatchBlockCode` en fait partie explicitement : quand `resolveDispatchTarget`
 * refuse un manifeste, le rail relaie SON code plutôt que d'en fabriquer un
 * équivalent. L'union reste donc fermée — un motif inventé ne compile pas.
 */
export type InstagramReasonCode =
  | InstagramBlockCode
  | InstagramFailureCode
  | InstagramRecoveryCode
  | DispatchBlockCode
  /** Le seul motif de succès du rail : une vérification menée jusqu'au bout, sans rien envoyer. */
  | 'IG_DRY_RUN_OK'
  /** IG2 §8 — un clic ET une preuve UI suffisante. Jamais l'un sans l'autre. */
  | 'IG_LIVE_SENT'
  /** IG2 §8 — un clic a eu lieu, la preuve manque. Terminal, jamais rejoué. */
  | 'IG_LIVE_AMBIGUOUS'
  /**
   * IG2.1 §4 — un clic a eu lieu et l'UI d'Instagram dit explicitement que le
   * message n'a pas été remis. Terminal, jamais rejoué, et surtout : aucun
   * `outreach_event`, parce que personne n'a été joint.
   */
  | 'IG_LIVE_DELIVERY_FAILED'
  /** IG2.1 §5 — une adjudication a confirmé, après coup, un envoi déjà effectué. */
  | 'IG_LIVE_SENT_RECONCILED'
  /**
   * IG3 §8 — l'ordonnanceur a reporté ce job. Le motif exact vit dans
   * `skip_reason` et l'heure de reprise dans `next_eligible_at` : ce code dit
   * seulement « ce n'est pas un refus, c'est un report ».
   */
  | 'IG_SCHEDULE_DEFERRED'
  /**
   * IG3 §2 — l'éligibilité a refusé, définitivement. `skip_reason` nomme la
   * porte qui a refusé ; le job est absorbant et ne sera jamais repris.
   */
  | 'IG_ELIGIBILITY_REFUSED'
  /** IG3 §2 — les dix portes d'éligibilité sont franchies. Le seul motif d'entrée en file. */
  | 'IG_ELIGIBLE'
  /**
   * HERMES-MANIFEST-OPERATOR-RETIREMENT-R1 — l'intention a été retirée par un
   * opérateur nommé, avant tout effet extérieur. Le manifeste passe
   * `SUPERSEDED`, le job devient absorbant, et rien n'est supprimé.
   */
  | 'IG_MANIFEST_RETIRED_BY_OPERATOR';

/** Traduction état de session → motif de refus. Exhaustive par construction. */
export const SESSION_STATE_BLOCK_CODE: Readonly<Record<Exclude<InstagramSessionState, 'SESSION_READY'>, InstagramBlockCode>> =
  Object.freeze({
    LOGIN_REQUIRED: 'IG_SESSION_LOGIN_REQUIRED',
    SESSION_EXPIRED: 'IG_SESSION_EXPIRED',
    SESSION_WRONG_ACCOUNT: 'IG_SESSION_WRONG_ACCOUNT',
    CHALLENGE: 'IG_SESSION_CHALLENGE',
    CAPTCHA: 'IG_SESSION_CAPTCHA',
    BLOCKED: 'IG_SESSION_BLOCKED',
    UNKNOWN: 'IG_SESSION_UNKNOWN',
  });

/** Traduction verdict d'identité → motif de refus. `MATCH` n'y figure pas : il ne refuse rien. */
export const IDENTITY_VERDICT_BLOCK_CODE: Readonly<
  Record<Exclude<InstagramIdentityVerdict, 'MATCH'>, InstagramBlockCode>
> = Object.freeze({
  MISMATCH: 'IG_IDENTITY_MISMATCH',
  NOT_FOUND: 'IG_IDENTITY_NOT_FOUND',
  AMBIGUOUS: 'IG_IDENTITY_AMBIGUOUS',
  UNAVAILABLE: 'IG_IDENTITY_UNAVAILABLE',
});

/** Une garde évaluée et son verdict, tel que journalisé dans `ig_job_events.gates`. */
export interface GateRecord {
  readonly gate: string;
  readonly verdict: 'PASS' | 'BLOCK';
  readonly detail?: string;
}
