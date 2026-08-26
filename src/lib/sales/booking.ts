/**
 * HERMES-BOOKING-MECHANISM-R1 — le MÉCANISME DE RÉSERVATION : ce que l'audit a
 * trouvé (rien), et le chemin déterministe qui mène malgré tout de
 * `QUALIFIED_FOR_CALL` à un rendez-vous prouvé.
 *
 * Ce fichier remplace la version de HERMES-SALES-KNOWLEDGE-R1 §24. Celle-ci
 * nommait l'absence ; celle-là la nomme ENCORE — l'audit du 22 août 2026 est
 * arrivé à la même conclusion, avec des preuves de plus — et ajoute la seule
 * chose qui manquait : un vocabulaire d'états, une machine qui les décide, et
 * une définition de la PREUVE qu'exige `APPOINTMENT_BOOKED`.
 *
 * ---------------------------------------------------------------------------
 * L'audit du 22 août 2026 — ce qui a été cherché, ce qui existe
 * ---------------------------------------------------------------------------
 * La question était : un mécanisme de réservation Hermes existe-t-il, tel
 * qu'un prospect puisse prendre un créneau dans l'agenda d'un opérateur ? Neuf
 * surfaces ont été relues, et pas depuis la mémoire :
 *
 *   * `config/` — aucune entrée de calendrier, de créneau ni de réservation.
 *     Les deux seules occurrences du mot sont `booking_system`
 *     (`config/scoring/example-v1.json`) et `no_booking_path`
 *     (`config/commercial-intelligence/example-shadow-v1.json`) : ce sont des
 *     signaux de SCORING sur le funnel du PROSPECT, l'exact inverse ;
 *   * les tables — aucune table de réservation, de calendrier ni de
 *     rendez-vous n'existait avant cette migration. `booking_system`,
 *     `booking_online` et `calendar_embed` ne sont pas des tables mais des
 *     clés de preuve site-scoped (`pipeline/evidenceQuality.ts`), toujours à
 *     propos du prospect ;
 *   * l'environnement — aucune variable de réservation, de calendrier ni de
 *     fournisseur d'agenda n'est renseignée ;
 *   * GoHighLevel — l'adapter existe (`crm/ghl.ts`), et il ne sait PAS parler
 *     de calendriers : `GhlApi` expose des locations, pipelines, champs,
 *     contacts, opportunités et notes, et zéro point d'accès de réservation.
 *     Il n'est de toute façon pas branché : aucune des trois variables
 *     `CRM_ENV_KEYS` n'est renseignée, et `r6b_crm_destinations` est VIDE —
 *     donc aucune destination CONFIRMED n'existe ;
 *   * Google — le seul OAuth du dépôt est Gmail, câblé sur
 *     `GMAIL_READONLY_SCOPE` et rien d'autre (`oauth/gmailOAuthBootstrap.ts`
 *     n'accepte pas de scope en paramètre, précisément pour ne pas pouvoir en
 *     demander un autre). Aucun scope Calendar, donc aucun agenda Google ;
 *   * Cal.com / Calendly — aucune occurrence dans le code de production.
 *     La seule du dépôt est `https://cal.example.com/hermes`, dans
 *     `tests/r6bReplies.test.ts`, où elle sert de contre-exemple à la garde
 *     de lien ;
 *   * les routes — `src/app/` porte la revue, le pilote, le CRM et les
 *     rapports R7. Aucune route de réservation, et aucune URL Hermes nulle
 *     part dans le dépôt ;
 *   * les primitives d'effet — le rail sortant remet un message, le rail de
 *     réponse écrit dans un fil. Aucune ne prend de date ;
 *   * les garde-fous — `checkReplyDraft` REFUSE tout lien (`unconfigured_link`,
 *     bloquant) avec ce motif exact : « aucun lien (calendrier, réservation,
 *     page) n'est configuré ». La garde décrivait donc déjà cette absence.
 *
 * Conclusion, inchangée : `MISSING_BOOKING_MECHANISM`. Rien n'a été fabriqué
 * pour la contourner — pas de faux lien, pas de faux identifiant d'agenda, pas
 * de fournisseur imaginaire.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce round ajoute, alors, et pourquoi ce n'est pas rien
 * ---------------------------------------------------------------------------
 * Avant lui, `QUALIFIED_FOR_CALL` menait à un seul endroit et l'absence de
 * mécanisme n'était qu'une constante. Il manquait trois choses, toutes trois
 * exprimables SANS inventer de donnée :
 *
 *   1. un vocabulaire — sept états nommés, dont l'ordre est la politique ;
 *   2. une machine déterministe qui les décide, fail-closed du haut en bas :
 *      la valeur par défaut est `NOT_READY`, et tout ce qui n'est pas prouvé
 *      redescend vers `HUMAN_CLOSE_REQUIRED`, jamais vers un rendez-vous ;
 *   3. une définition de la PREUVE. C'est le point qui coûte le plus cher à ne
 *      pas avoir : sans lui, la seule manière d'écrire « rendez-vous pris »
 *      aurait été de le déduire d'un message envoyé, ce qui produit un chiffre
 *      faux et durablement invérifiable.
 *
 * Ce module reste PUR : aucun import de base, aucun import d'effet, aucune
 * dépendance. Il ne peut donc autoriser aucun envoi — `decideAutonomousReply`
 * demeure seul juge de ce qui part, et la primitive du rail de réponse reste
 * seule capable d'écrire dans un fil.
 */

/**
 * L'état du mécanisme de prise de rendez-vous.
 *
 * Trois membres là où il y en avait un. L'élargissement n'ouvre rien par
 * lui-même : `MISSING_BOOKING_MECHANISM` reste la valeur constatée aujourd'hui,
 * et c'est une lecture de base — pas une constante — qui peut rendre les deux
 * autres. Fail-closed : toute incertitude rend `MISSING_BOOKING_MECHANISM`.
 */
export type BookingMechanism =
  /** Aucun mécanisme n'existe. L'état du dépôt au 22 août 2026. */
  | 'MISSING_BOOKING_MECHANISM'
  /** Un mécanisme est déposé mais personne ne l'a nommément confirmé. */
  | 'BOOKING_MECHANISM_UNCONFIRMED'
  /** Un mécanisme confirmé par un humain nommé, et vu répondre. */
  | 'BOOKING_MECHANISM_READY';

/**
 * L'état du mécanisme tel qu'il est CONSTATÉ dans un dépôt sans configuration.
 *
 * Conservé pour ce qu'il vaut : la valeur de repli de toute lecture qui échoue,
 * et la réponse à « que vaut ce système si la base est injoignable ? ».
 */
export const BOOKING_MECHANISM_DEFAULT: BookingMechanism = 'MISSING_BOOKING_MECHANISM';

/** La version de la politique de réservation. */
export const BOOKING_POLICY_VERSION = 'hermes-booking-r1';

/** Les surfaces inspectées, pour qu'un futur audit reparte du même endroit. */
export const BOOKING_SURFACES_AUDITED: readonly string[] = Object.freeze([
  'config/ — booking_system et no_booking_path sont du SCORING sur le prospect, pas notre agenda',
  'tables — aucune table de réservation avant 0053 ; booking_online / calendar_embed sont des clés de preuve',
  'environnement — aucune variable de réservation, de calendrier ni de fournisseur d’agenda',
  'crm/ghl.ts — GhlApi n’expose aucun point d’accès calendrier, et n’est pas configuré (r6b_crm_destinations vide)',
  'oauth/gmailOAuthBootstrap.ts — scope câblé sur gmail.readonly, aucun scope Calendar',
  'Cal.com / Calendly — absents du code de production ; la seule occurrence est un contre-exemple de test',
  'src/app/ — aucune route de réservation, aucune URL Hermes dans le dépôt',
  'primitives d’effet (rail sortant, rail de réponse) — remettent un message, ne prennent pas de date',
  'checkReplyDraft — refuse tout lien : « aucun lien (calendrier, réservation, page) n’est configuré »',
]);

/**
 * Hermes peut-il ÉCRIRE lui-même dans un agenda ?
 *
 * Rend toujours `false`, et le TYPE le dit — y compris le jour où une
 * destination sera confirmée. Ce n'est pas une précaution provisoire : même
 * avec un lien en main, Hermes PROPOSE, la personne RÉSERVE, et nous
 * OBSERVONS. Aucun de ces trois gestes n'est « Hermes crée un créneau », et
 * c'est ce qui rend la preuve du rendez-vous extérieure à nous.
 */
export function canBookAutonomously(): false {
  return false;
}

/**
 * Ce que Hermes fait à la place, et qui n'est pas rien.
 *
 * Il mène la conversation jusqu'à `QUALIFIED_FOR_CALL`, propose l'échange, et
 * — si et seulement si une destination confirmée existe — transmet le moyen de
 * réserver. Ce qu'il ne fait jamais : arrêter une date, écrire dans un agenda,
 * ou conclure. La suite appartient à un opérateur.
 */
export const BOOKING_FALLBACK =
  'Hermes propose l’échange et, quand un mécanisme confirmé existe, transmet le moyen de réserver ; ' +
  'il ne fixe aucune date, n’écrit dans aucun agenda, et passe la main à un humain (HUMAN_CLOSE_REQUIRED).';

// ---------------------------------------------------------------------------
// Le vocabulaire des états
// ---------------------------------------------------------------------------

/**
 * Où en est cette conversation entre « rien ne le justifie » et « un
 * rendez-vous existe ».
 *
 * Sept états, et l'ordre dans lequel ils sont écrits est celui de la
 * progression commerciale — sauf les deux derniers, qui sont des SORTIES et
 * peuvent survenir depuis plusieurs endroits.
 */
export type BookingLifecycleState =
  /** Rien ne justifie un échange. La réservation est inaccessible d'ici. */
  | 'NOT_READY'
  /** Un échange humain est justifié, aucune proposition n'est encore ouverte. */
  | 'QUALIFIED_FOR_CALL'
  /** La proposition est autorisée et une piste est ouverte. */
  | 'BOOKING_PROPOSED'
  /** La proposition est partie ; aucune preuve n'est encore observée. */
  | 'BOOKING_PENDING'
  /** Une preuve suffisante a été observée. Un rendez-vous EXISTE. */
  | 'APPOINTMENT_BOOKED'
  /** La personne a refusé l'échange. */
  | 'BOOKING_DECLINED'
  /** La main revient à un humain — la réussite de Hermes, pas son échec. */
  | 'HUMAN_CLOSE_REQUIRED';

/** Les états qu'une piste PERSISTÉE peut porter. Sous-ensemble strict. */
export const PERSISTED_BOOKING_STATES = Object.freeze([
  'BOOKING_PROPOSED',
  'BOOKING_PENDING',
  'APPOINTMENT_BOOKED',
  'BOOKING_DECLINED',
] as const);

export type PersistedBookingState = (typeof PERSISTED_BOOKING_STATES)[number];

/**
 * Les états qui occupent la piste VIVANTE d'un prospect.
 *
 * La même liste que l'index unique partiel de 0053, et c'est délibéré : deux
 * définitions voisines de « vivant » finiraient par diverger, et c'est la plus
 * indulgente qui gagnerait — donc celle qui autorise un doublon.
 */
export const LIVE_BOOKING_STATES: ReadonlySet<PersistedBookingState> =
  new Set<PersistedBookingState>(['BOOKING_PROPOSED', 'BOOKING_PENDING', 'APPOINTMENT_BOOKED']);

// ---------------------------------------------------------------------------
// La PREUVE d'un rendez-vous
// ---------------------------------------------------------------------------

/** D'où vient la preuve. Deux origines, toutes deux EXTÉRIEURES au brouillon. */
export type BookingEvidenceKind = 'PROVIDER_RECORD' | 'OPERATOR_ATTESTED';

/**
 * Ce qu'il faut pour écrire `APPOINTMENT_BOOKED`, et rien de moins.
 *
 * Lire cette interface, c'est lire la définition : quatre faits, tous
 * observables ailleurs qu'ici. Ce qui n'y figure PAS est aussi important —
 * il n'y a ni identifiant de message, ni empreinte de brouillon, ni horodatage
 * d'envoi. Un rendez-vous ne peut donc structurellement pas se déduire d'un
 * message parti : la fonction qui l'écrit ne reçoit pas de quoi le faire.
 */
export interface BookingProof {
  /**
   * L'identifiant du rendez-vous CHEZ LE FOURNISSEUR.
   *
   * Émis par lui, jamais par nous : un identifiant que nous aurions fabriqué
   * prouverait uniquement que nous savons écrire dans notre propre table.
   */
  readonly externalBookingRef: string;
  /** Le début du créneau, tel qu'il est fixé chez le fournisseur (ISO 8601). */
  readonly scheduledStartAt: string;
  readonly evidenceKind: BookingEvidenceKind;
  /** Qui a observé. Un nom, jamais « le système ». */
  readonly observedBy: string;
  /** Quand l'observation a eu lieu (ISO 8601). */
  readonly observedAt: string;
}

/** Pourquoi une preuve est refusée. Des codes, jamais des phrases libres. */
export type BookingProofRefusal =
  | 'PROOF_REF_MISSING'
  | 'PROOF_SCHEDULE_MISSING'
  | 'PROOF_SCHEDULE_INVALID'
  | 'PROOF_SCHEDULE_IN_PAST'
  | 'PROOF_OBSERVER_MISSING'
  | 'PROOF_OBSERVED_AT_INVALID';

export type BookingProofCheck =
  | { readonly ok: true; readonly proof: BookingProof }
  | { readonly ok: false; readonly refusals: readonly BookingProofRefusal[] };

function isIso(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

/**
 * La preuve suffit-elle ?
 *
 * Pure, déterministe, et fail-closed : chaque défaut produit un code, et le
 * moindre code suffit à refuser. `now` est un paramètre plutôt qu'une lecture
 * d'horloge, pour que le test d'un créneau passé soit reproductible.
 *
 * Le contrôle du créneau dans le FUTUR mérite d'être dit : un rendez-vous
 * « pris » pour hier n'est pas un rendez-vous à venir, c'est soit une erreur de
 * saisie, soit une observation recopiée d'un autre fil. Les deux se corrigent
 * en refusant.
 */
export function checkBookingProof(
  input: {
    readonly externalBookingRef: string;
    readonly scheduledStartAt: string;
    readonly evidenceKind: BookingEvidenceKind;
    readonly observedBy: string;
    readonly observedAt: string;
  },
  now: Date,
): BookingProofCheck {
  const refusals: BookingProofRefusal[] = [];

  const ref = input.externalBookingRef.trim();
  if (ref.length === 0) refusals.push('PROOF_REF_MISSING');

  const start = input.scheduledStartAt.trim();
  if (start.length === 0) refusals.push('PROOF_SCHEDULE_MISSING');
  else if (!isIso(start)) refusals.push('PROOF_SCHEDULE_INVALID');
  else if (Date.parse(start) <= now.getTime()) refusals.push('PROOF_SCHEDULE_IN_PAST');

  const observer = input.observedBy.trim();
  if (observer.length === 0) refusals.push('PROOF_OBSERVER_MISSING');

  const observedAt = input.observedAt.trim();
  if (!isIso(observedAt)) refusals.push('PROOF_OBSERVED_AT_INVALID');

  if (refusals.length > 0) return Object.freeze({ ok: false, refusals: Object.freeze(refusals) });

  return Object.freeze({
    ok: true,
    proof: Object.freeze({
      externalBookingRef: ref,
      scheduledStartAt: new Date(start).toISOString(),
      evidenceKind: input.evidenceKind,
      observedBy: observer,
      observedAt: new Date(observedAt).toISOString(),
    }),
  });
}

// ---------------------------------------------------------------------------
// La machine
// ---------------------------------------------------------------------------

/** La piste persistée, telle que la machine a besoin de la connaître. */
export interface BookingIntentFacts {
  readonly state: PersistedBookingState;
  readonly destinationId: string;
  /** La politique sous laquelle elle a été ouverte. */
  readonly policyVersion: string;
  /** Une proposition est-elle réellement PARTIE ? Un effet, pas un brouillon. */
  readonly proposalDelivered: boolean;
}

export interface BookingLifecycleInput {
  /**
   * Le verdict de `assessAppointmentQualification`, passé en chaîne.
   *
   * Une chaîne et non le type importé : ce module doit rester sans dépendance,
   * et l'inverse — `objective.ts` importe `booking.ts` — est le sens de lecture
   * que le dépôt avait déjà.
   */
  readonly qualification: 'NOT_READY' | 'POTENTIALLY_QUALIFIED' | 'QUALIFIED_FOR_CALL' | 'HUMAN_REVIEW';
  readonly mechanism: BookingMechanism;
  readonly intent: BookingIntentFacts | null;
  /** La personne a explicitement refusé l'échange. */
  readonly declined: boolean;
  /**
   * La conversation est-elle À JOUR ?
   *
   * `false` quand un message plus récent est arrivé depuis celui qu'on lit.
   * Proposer un créneau sur une phrase qui n'est plus la dernière est la faute
   * que `stale_reply` évite déjà pour les réponses ; il n'y a aucune raison
   * qu'un rendez-vous y échappe.
   */
  readonly conversationFresh: boolean;
}

export interface BookingLifecycleAssessment {
  readonly policyVersion: string;
  readonly state: BookingLifecycleState;
  /** La porte qui a tranché, pour qu'un verdict se relise sans l'ordre. */
  readonly gate: string;
  readonly reasons: readonly string[];
  /** Une proposition peut-elle être FAITE à ce tour ? */
  readonly mayProposeBooking: boolean;
  /** Hermes peut-il conclure ? Non, et le TYPE le dit. */
  readonly closingAllowed: false;
}

/**
 * Où en est la réservation ?
 *
 * L'ordre des portes EST la politique, et il va du plus DURABLE au plus
 * circonstanciel — même discipline que `decideAutonomousReply` et que
 * `assessAppointmentQualification`. Fail-closed : le défaut, en bas, est
 * `NOT_READY`, et aucune porte ne peut produire `APPOINTMENT_BOOKED` — cet
 * état ne s'obtient qu'en LISANT une piste qui le porte déjà, c'est-à-dire une
 * piste dont la preuve a passé `checkBookingProof` et les contraintes de 0053.
 *
 * C'est la propriété qui répond à « pas de faux BOOKED » : la machine ne sait
 * pas fabriquer cet état, elle sait seulement le constater.
 */
export function assessBookingLifecycle(
  input: BookingLifecycleInput,
): BookingLifecycleAssessment {
  const reasons: string[] = [];

  const verdict = ((): { state: BookingLifecycleState; gate: string } => {
    // ---- 1. Ce qui est déjà ÉTABLI -----------------------------------------
    //
    // Avant toute relecture de la conversation : un rendez-vous prouvé reste
    // prouvé, et un refus reste un refus. Les remettre en jeu à chaque message
    // ferait dépendre un fait observé de l'humeur du dernier texte reçu.
    if (input.intent !== null && input.intent.state === 'APPOINTMENT_BOOKED') {
      reasons.push('intent:APPOINTMENT_BOOKED');
      return { state: 'APPOINTMENT_BOOKED', gate: 'existing_intent' };
    }
    if (input.intent !== null && input.intent.state === 'BOOKING_DECLINED') {
      reasons.push('intent:BOOKING_DECLINED');
      return { state: 'BOOKING_DECLINED', gate: 'existing_intent' };
    }

    // ---- 2. La qualification, qui commande tout le reste --------------------
    //
    // C'est ici que « reply_received → booking » est rendu impossible : la
    // réservation n'est atteignable que depuis `QUALIFIED_FOR_CALL`, et cet
    // état est décidé ailleurs, par des portes qui n'ont pas bougé.
    if (input.qualification !== 'QUALIFIED_FOR_CALL') {
      reasons.push(`qualification:${input.qualification}`);
      return { state: 'NOT_READY', gate: 'qualification' };
    }

    // ---- 3. Le refus exprimé ------------------------------------------------
    if (input.declined) {
      reasons.push('declined_by_prospect');
      return { state: 'BOOKING_DECLINED', gate: 'decline' };
    }

    // ---- 4. Le MÉCANISME ----------------------------------------------------
    //
    // Fail-closed, et c'est l'état du dépôt aujourd'hui : sans destination
    // confirmée, la conversation atteint son objectif côté machine et la main
    // passe à un humain. Exactement ce que le dépôt faisait déjà — ce round ne
    // dégrade donc rien, il rend seulement la raison lisible.
    if (input.mechanism !== 'BOOKING_MECHANISM_READY') {
      reasons.push(`booking:${input.mechanism}`);
      return { state: 'HUMAN_CLOSE_REQUIRED', gate: 'booking_mechanism' };
    }

    // ---- 5. La politique qui a ouvert la piste ------------------------------
    //
    // Une piste ouverte sous d'autres règles ne couvre pas les règles
    // actuelles. Elle ne devient pas fausse pour autant : la main passe à un
    // humain, qui décidera de la rouvrir.
    if (input.intent !== null && input.intent.policyVersion !== BOOKING_POLICY_VERSION) {
      reasons.push(`policy_version_mismatch:${input.intent.policyVersion}`);
      return { state: 'HUMAN_CLOSE_REQUIRED', gate: 'policy_version' };
    }

    // ---- 6. La FRAÎCHEUR ----------------------------------------------------
    if (!input.conversationFresh) {
      reasons.push('stale_conversation');
      return { state: 'QUALIFIED_FOR_CALL', gate: 'freshness' };
    }

    // ---- 7. Une piste déjà ouverte -----------------------------------------
    //
    // Le point qui dit « envoyer un lien n'est pas un rendez-vous » : une
    // proposition PARTIE fait passer à `BOOKING_PENDING`, et cet état attend
    // une preuve qui ne viendra jamais du fait d'avoir envoyé quoi que ce soit.
    if (input.intent !== null) {
      if (input.intent.proposalDelivered) {
        reasons.push('proposal_delivered_awaiting_proof');
        return { state: 'BOOKING_PENDING', gate: 'awaiting_proof' };
      }
      reasons.push('intent_open');
      return { state: 'BOOKING_PROPOSED', gate: 'existing_intent' };
    }

    // ---- 8. La proposition est ouverte --------------------------------------
    reasons.push('mechanism_ready_and_qualified');
    return { state: 'BOOKING_PROPOSED', gate: 'proposal' };
  })();

  return Object.freeze({
    policyVersion: BOOKING_POLICY_VERSION,
    state: verdict.state,
    gate: verdict.gate,
    reasons: Object.freeze(reasons),
    mayProposeBooking: verdict.state === 'BOOKING_PROPOSED',
    closingAllowed: false as const,
  });
}

/** La forme lisible des rapports : `BOOKING_PROPOSED:proposal`. */
export function formatBookingLifecycle(assessment: BookingLifecycleAssessment): string {
  return `${assessment.state}:${assessment.gate}`;
}
