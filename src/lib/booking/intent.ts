/**
 * HERMES-NATIVE-BOOKING-R1 §7/§11/§18/§19 — de « ce que la personne veut » à
 * « ce que le runtime va faire ».
 *
 * ---------------------------------------------------------------------------
 * Le partage, et pourquoi il tombe là
 * ---------------------------------------------------------------------------
 * Le MODÈLE dit l'INTENTION : accepter, contre-proposer, décaler, annuler,
 * demander des disponibilités, ou rien de tout cela. C'est un jugement de sens,
 * la seule chose qu'un lexique fait mal — « ok ça marche » et « ok mais
 * pourquoi ? » ne se distinguent pas au mot près.
 *
 * Le CODE dit tout le reste : quel instant est désigné (`temporal.ts`), s'il
 * est libre (`availability.ts`), et ce qui doit être écrit (ici). Aucun créneau
 * ne peut donc être INVENTÉ par un modèle : `PROPOSE_SLOTS` ne porte que des
 * intervalles rendus par le moteur, et `BOOK` ne porte qu'un intervalle que le
 * moteur vient de déclarer libre.
 *
 * Ce module est PUR. Il ne lit rien, n'écrit rien et n'appelle aucun modèle :
 * la lecture (rendez-vous vivant, dernière proposition, créneaux occupés) lui
 * est passée, et l'écriture appartient à `runtime.ts`. C'est ce qui permet de
 * l'éprouver sur des états que les données réelles ne produiront pas de sitôt.
 *
 * ---------------------------------------------------------------------------
 * §19 — ne pas forcer un rendez-vous à chaque message
 * ---------------------------------------------------------------------------
 * `PROPOSE_SLOTS` ne naît JAMAIS d'un tour ordinaire. Il exige `mayPropose` —
 * c'est-à-dire `QUALIFIED_FOR_CALL`, la barre que `assessAppointmentQualification`
 * tenait déjà avant ce round et qui n'a pas bougé d'un cran — ET l'une de deux
 * choses : la personne demande nos disponibilités, ou aucune proposition n'a
 * encore été faite dans cette conversation. Un prospect qui pose encore des
 * questions reçoit donc des réponses, pas « mercredi 15 h ? » à chaque tour.
 *
 * C'est la même règle que `CTA_TOO_EARLY` applique au texte (« un échange a
 * déjà été proposé dans ce fil et rien ne le redemande »), appliquée cette
 * fois à l'agenda.
 */

import {
  checkAvailability,
  intervalFor,
  nextAvailableSlots,
  type AvailabilityInput,
  type AvailabilityRefusal,
  type Interval,
} from '@/lib/booking/availability';
import type { Appointment, BookingProposal } from '@/lib/booking/store';
import { instantOf, readTemporal, type TemporalRefusal } from '@/lib/booking/temporal';
import type { BookingPolicyConfig } from '@/lib/config/schema';
import { zonedParts } from '@/lib/time/zoned';

/**
 * Ce que le modèle a compris du tour, côté agenda.
 *
 * Volontairement court. Chaque membre de plus est une case qu'un modèle peut
 * choisir par erreur, et les six qui suivent couvrent tout ce que §18 de la
 * mission demande de distinguer. « pas encore prêt à prendre RDV » n'a pas de
 * membre : c'est `NONE`, et c'est le cas le plus fréquent.
 */
export const BOOKING_INTENTS = Object.freeze([
  'NONE',
  'ASK_AVAILABILITY',
  'ACCEPT_PROPOSAL',
  'PROPOSE_TIME',
  'RESCHEDULE',
  'CANCEL',
] as const);

export type BookingIntent = (typeof BOOKING_INTENTS)[number];

export function isBookingIntent(value: unknown): value is BookingIntent {
  return typeof value === 'string' && (BOOKING_INTENTS as readonly string[]).includes(value);
}

/** Pourquoi on demande une précision plutôt que de réserver. */
export type ClarificationReason =
  | TemporalRefusal
  /** Une acceptation sans créneau identifiable, et rien à quoi la rattacher. */
  | 'NO_SLOT_IDENTIFIED'
  /** Plusieurs créneaux proposés correspondent — lequel ? */
  | 'PROPOSAL_AMBIGUOUS'
  /** Un report demandé sans nouvelle heure. */
  | 'RESCHEDULE_TIME_MISSING'
  /** Une annulation ou un report demandés sans rendez-vous à toucher. */
  | 'NO_LIVE_APPOINTMENT';

export type BookingAction =
  /** Rien de calendaire à faire à ce tour. Le cas de loin le plus fréquent. */
  | { readonly kind: 'NO_BOOKING' }
  /** Proposer ces créneaux — calculés, jamais inventés. Peut être vide. */
  | { readonly kind: 'PROPOSE_SLOTS'; readonly slots: readonly Interval[] }
  /** Demander une précision. Aucune écriture. */
  | { readonly kind: 'CLARIFY'; readonly reason: ClarificationReason }
  /** Réserver cet intervalle. Le moteur vient de le déclarer libre. */
  | {
      readonly kind: 'BOOK';
      readonly interval: Interval;
      /** Le créneau venait-il de NOTRE proposition ? Pour le journal de §21. */
      readonly fromProposal: boolean;
    }
  /** Déplacer le rendez-vous vivant vers cet intervalle. */
  | {
      readonly kind: 'RESCHEDULE';
      readonly interval: Interval;
      readonly previous: Appointment;
    }
  /** Annuler le rendez-vous vivant. */
  | { readonly kind: 'CANCEL'; readonly previous: Appointment }
  /** Le créneau demandé n'est pas disponible. Des alternatives sont jointes. */
  | {
      readonly kind: 'UNAVAILABLE';
      readonly requested: Interval;
      readonly refusal: AvailabilityRefusal;
      readonly alternatives: readonly Interval[];
    }
  /** Le créneau demandé est CELUI qui est déjà réservé. Rien à écrire. */
  | { readonly kind: 'ALREADY_BOOKED'; readonly appointment: Appointment };

export interface BookingTurnInput {
  readonly intent: BookingIntent;
  /** Le tour logique entier (la salve), jamais la dernière bulle seule. */
  readonly utterance: string;
  readonly policy: BookingPolicyConfig;
  readonly now: Date;
  /** Les créneaux CONFIRMÉS de l'agenda, lus ailleurs. */
  readonly busy: readonly Interval[];
  /** Le rendez-vous vivant de ce prospect, s'il en a un. */
  readonly liveAppointment: Appointment | null;
  /** La dernière proposition qu'on lui a faite, s'il y en a une. */
  readonly latestProposal: BookingProposal | null;
  /**
   * §19 — la conversation justifie-t-elle qu'on propose un échange ?
   *
   * C'est `assessAppointmentQualification(...) === 'QUALIFIED_FOR_CALL'`,
   * recopié plutôt que recalculé : ce module n'a pas à connaître les portes
   * commerciales, et deux lectures de la même question finiraient par diverger.
   */
  readonly mayPropose: boolean;
}

export interface BookingTurnDecision {
  readonly action: BookingAction;
  /** Les fragments de texte qui ont porté le temps. Pour le journal de §21. */
  readonly evidence: readonly string[];
}

function decision(action: BookingAction, evidence: readonly string[]): BookingTurnDecision {
  return Object.freeze({ action, evidence: Object.freeze([...evidence]) });
}

function availabilityInput(input: BookingTurnInput): AvailabilityInput {
  return { policy: input.policy, now: input.now, busy: input.busy };
}

function alternativesFor(input: BookingTurnInput): readonly Interval[] {
  return nextAvailableSlots(availabilityInput(input), input.policy.maxProposedSlots);
}

function sameInstant(a: Date, b: string | Date): boolean {
  return a.getTime() === new Date(b).getTime();
}

// ---------------------------------------------------------------------------
// Du texte à l'intervalle demandé
// ---------------------------------------------------------------------------

type RequestedInterval =
  | { readonly kind: 'RESOLVED'; readonly interval: Interval; readonly fromProposal: boolean }
  | { readonly kind: 'CLARIFY'; readonly reason: ClarificationReason }
  | { readonly kind: 'ABSENT' };

/**
 * Quel créneau la personne désigne-t-elle ?
 *
 * La lecture du texte est complétée — jamais devinée — par les créneaux qu'on
 * vient de proposer. La distinction est celle qui rend ce module sûr :
 *
 *   * une moitié ABSENTE se complète (« mercredi » quand un seul créneau
 *     proposé tombe ce mercredi-là : la personne a été parfaitement claire) ;
 *   * une moitié AMBIGUË ne se complète JAMAIS (« vers 3h » reste « vers 3h »,
 *     même si un créneau proposé tombe à 15 h — le compléter reviendrait à
 *     choisir pour elle entre 3 h et 15 h).
 *
 * C'est la même asymétrie que le dépôt applique partout : ce qui manque peut
 * être cherché ailleurs, ce qui est douteux reste douteux.
 */
function resolveRequestedInterval(input: BookingTurnInput): RequestedInterval {
  const reading = readTemporal(input.utterance, input.now, input.policy.timezone);

  if (reading.date.kind === 'AMBIGUOUS') {
    return Object.freeze({ kind: 'CLARIFY' as const, reason: reading.date.refusal });
  }
  if (reading.time.kind === 'AMBIGUOUS') {
    return Object.freeze({ kind: 'CLARIFY' as const, reason: reading.time.refusal });
  }

  const proposed = input.latestProposal?.slots ?? [];

  if (reading.date.kind === 'RESOLVED' && reading.time.kind === 'RESOLVED') {
    const startsAt = instantOf(reading.date.date, reading.time.minuteOfDay, input.policy.timezone);
    if (startsAt === null) {
      // L'heure murale demandée n'existe pas ce jour-là (nuit du passage à
      // l'heure d'été). On demande, on ne substitue pas.
      return Object.freeze({ kind: 'CLARIFY' as const, reason: 'LOCAL_TIME_DOES_NOT_EXIST' as const });
    }
    const fromProposal = proposed.some((slot) => sameInstant(startsAt, slot.startsAt));
    return Object.freeze({
      kind: 'RESOLVED' as const,
      interval: intervalFor(startsAt, input.policy),
      fromProposal,
    });
  }

  if (reading.date.kind === 'RESOLVED') {
    // Une date, pas d'heure. Un seul créneau proposé ce jour-là lève le doute.
    const target = reading.date.date;
    const sameDay = proposed.filter((slot) => {
      const local = zonedParts(slot.startsAt, input.policy.timezone);
      return local.year === target.year && local.month === target.month && local.day === target.day;
    });
    if (sameDay.length === 1) {
      return Object.freeze({
        kind: 'RESOLVED' as const,
        interval: sameDay[0] as Interval,
        fromProposal: true,
      });
    }
    return Object.freeze({
      kind: 'CLARIFY' as const,
      reason: sameDay.length === 0 ? ('TIME_MISSING' as const) : ('PROPOSAL_AMBIGUOUS' as const),
    });
  }

  if (reading.time.kind === 'RESOLVED') {
    // Une heure, pas de date. Un seul créneau proposé à cette heure lève le
    // doute ; sinon on NE suppose PAS « aujourd'hui », qui serait la supposition
    // la plus coûteuse de toutes.
    const minute = reading.time.minuteOfDay;
    const sameTime = proposed.filter(
      (slot) => zonedParts(slot.startsAt, input.policy.timezone).minuteOfDay === minute,
    );
    if (sameTime.length === 1) {
      return Object.freeze({
        kind: 'RESOLVED' as const,
        interval: sameTime[0] as Interval,
        fromProposal: true,
      });
    }
    return Object.freeze({
      kind: 'CLARIFY' as const,
      reason: sameTime.length === 0 ? ('DATE_MISSING' as const) : ('PROPOSAL_AMBIGUOUS' as const),
    });
  }

  return Object.freeze({ kind: 'ABSENT' as const });
}

/**
 * L'intervalle demandé, confronté à la disponibilité RÉELLE.
 *
 * §11 — c'est ici que « proposer n'est pas réserver » devient opérationnel :
 * un créneau qui vient de NOTRE proposition repasse exactement le même contrôle
 * qu'un créneau inventé par le prospect. Une proposition faite il y a trois
 * heures et prise depuis par quelqu'un d'autre sort donc en `UNAVAILABLE`, avec
 * des alternatives, et jamais en confirmation.
 */
function bookOrRefuse(
  input: BookingTurnInput,
  interval: Interval,
  fromProposal: boolean,
  evidence: readonly string[],
): BookingTurnDecision {
  const verdict = checkAvailability(interval, availabilityInput(input));
  if (!verdict.available) {
    return decision(
      Object.freeze({
        kind: 'UNAVAILABLE' as const,
        requested: interval,
        refusal: verdict.refusal,
        alternatives: alternativesFor(input),
      }),
      evidence,
    );
  }
  return decision(
    Object.freeze({ kind: 'BOOK' as const, interval: verdict.interval, fromProposal }),
    evidence,
  );
}

// ---------------------------------------------------------------------------
// La décision
// ---------------------------------------------------------------------------

/**
 * Que fait-on de ce tour, côté agenda ?
 *
 * L'ordre des portes est celui de la dureté, comme partout dans ce dépôt : ce
 * qui RETIRE un rendez-vous d'abord (annuler, déplacer), ce qui en ajoute
 * ensuite, ce qui n'engage rien à la fin. Une annulation ne doit jamais être
 * lue comme une contre-proposition parce qu'elle contenait une heure.
 */
export function decideBookingTurn(input: BookingTurnInput): BookingTurnDecision {
  const reading = readTemporal(input.utterance, input.now, input.policy.timezone);
  const evidence = reading.evidence;

  // ---- 1. ANNULER --------------------------------------------------------
  if (input.intent === 'CANCEL') {
    if (input.liveAppointment === null) {
      return decision(
        Object.freeze({ kind: 'CLARIFY' as const, reason: 'NO_LIVE_APPOINTMENT' as const }),
        evidence,
      );
    }
    return decision(
      Object.freeze({ kind: 'CANCEL' as const, previous: input.liveAppointment }),
      evidence,
    );
  }

  // ---- 2. DÉPLACER -------------------------------------------------------
  //
  // Deux chemins y mènent, et c'est voulu : l'intention explicite (« on peut
  // décaler ? ») et une acceptation ou une contre-proposition arrivant alors
  // qu'un rendez-vous existe déjà (« finalement plutôt 18 h ? »). Le second est
  // le cas réel que §14 de la mission cite, et le traiter comme une réservation
  // neuve buterait sur « un seul vivant par prospect » — c'est-à-dire échouerait
  // sur un index au lieu de faire ce que la personne demande.
  const wantsMove =
    input.intent === 'RESCHEDULE' ||
    (input.liveAppointment !== null &&
      (input.intent === 'ACCEPT_PROPOSAL' || input.intent === 'PROPOSE_TIME'));

  if (wantsMove) {
    if (input.liveAppointment === null) {
      // « on peut décaler ? » sans rendez-vous : on ne fabrique pas ce qu'on
      // n'a pas. Si une heure est donnée, elle sera lue au tour suivant comme
      // une demande neuve.
      return decision(
        Object.freeze({ kind: 'CLARIFY' as const, reason: 'NO_LIVE_APPOINTMENT' as const }),
        evidence,
      );
    }

    const requested = resolveRequestedInterval(input);
    if (requested.kind === 'CLARIFY') {
      return decision(
        Object.freeze({ kind: 'CLARIFY' as const, reason: requested.reason }),
        evidence,
      );
    }
    if (requested.kind === 'ABSENT') {
      return decision(
        Object.freeze({ kind: 'CLARIFY' as const, reason: 'RESCHEDULE_TIME_MISSING' as const }),
        evidence,
      );
    }

    // Le créneau demandé EST celui qu'on a déjà : rien à écrire, et surtout pas
    // un report vers soi-même — qui annulerait puis réinsérerait un rendez-vous
    // sans raison, en changeant son identifiant sous les yeux de l'opérateur.
    if (sameInstant(requested.interval.startsAt, input.liveAppointment.startsAt)) {
      return decision(
        Object.freeze({ kind: 'ALREADY_BOOKED' as const, appointment: input.liveAppointment }),
        evidence,
      );
    }

    // La disponibilité du NOUVEAU créneau se juge sans compter l'ancien : il va
    // être libéré dans la même transaction. Sans ce retrait, décaler de 15 h à
    // 15 h 15 serait refusé par notre propre rendez-vous.
    const withoutMine: AvailabilityInput = {
      policy: input.policy,
      now: input.now,
      busy: input.busy.filter(
        (slot) => !sameInstant(slot.startsAt, (input.liveAppointment as Appointment).startsAt),
      ),
    };
    const verdict = checkAvailability(requested.interval, withoutMine);
    if (!verdict.available) {
      return decision(
        Object.freeze({
          kind: 'UNAVAILABLE' as const,
          requested: requested.interval,
          refusal: verdict.refusal,
          alternatives: nextAvailableSlots(withoutMine, input.policy.maxProposedSlots),
        }),
        evidence,
      );
    }
    return decision(
      Object.freeze({
        kind: 'RESCHEDULE' as const,
        interval: verdict.interval,
        previous: input.liveAppointment,
      }),
      evidence,
    );
  }

  // ---- 3. RÉSERVER -------------------------------------------------------
  if (input.intent === 'ACCEPT_PROPOSAL' || input.intent === 'PROPOSE_TIME') {
    const requested = resolveRequestedInterval(input);
    if (requested.kind === 'CLARIFY') {
      return decision(
        Object.freeze({ kind: 'CLARIFY' as const, reason: requested.reason }),
        evidence,
      );
    }
    if (requested.kind === 'ABSENT') {
      // « ça me va » : sans heure ET sans date, la seule lecture sûre est celle
      // d'une proposition qui n'en comptait qu'une. Deux créneaux proposés et
      // un « ok » ne désignent rien.
      const proposed = input.latestProposal?.slots ?? [];
      if (input.intent === 'ACCEPT_PROPOSAL' && proposed.length === 1) {
        return bookOrRefuse(input, proposed[0] as Interval, true, evidence);
      }
      return decision(
        Object.freeze({
          kind: 'CLARIFY' as const,
          reason: proposed.length > 1 ? ('PROPOSAL_AMBIGUOUS' as const) : ('NO_SLOT_IDENTIFIED' as const),
        }),
        evidence,
      );
    }
    return bookOrRefuse(input, requested.interval, requested.fromProposal, evidence);
  }

  // ---- 4. PROPOSER -------------------------------------------------------
  //
  // §19 — jamais sur un tour ordinaire. Un rendez-vous vivant ferme la porte :
  // proposer des créneaux à quelqu'un dont le rendez-vous est déjà pris est la
  // manière la plus rapide de le lui faire perdre.
  if (input.liveAppointment !== null) {
    return decision(Object.freeze({ kind: 'NO_BOOKING' as const }), evidence);
  }
  if (!input.mayPropose) {
    return decision(Object.freeze({ kind: 'NO_BOOKING' as const }), evidence);
  }
  const asked = input.intent === 'ASK_AVAILABILITY';
  const neverProposed = input.latestProposal === null;
  if (!asked && !neverProposed) {
    return decision(Object.freeze({ kind: 'NO_BOOKING' as const }), evidence);
  }

  return decision(
    Object.freeze({
      kind: 'PROPOSE_SLOTS' as const,
      slots: nextAvailableSlots(availabilityInput(input), input.policy.maxProposedSlots),
    }),
    evidence,
  );
}
