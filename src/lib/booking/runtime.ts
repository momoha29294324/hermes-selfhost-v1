/**
 * HERMES-NATIVE-BOOKING-R1 §12/§13/§21 — l'ORDRE des effets, et le journal.
 *
 * ---------------------------------------------------------------------------
 * L'ordre, qui est tout le sujet
 * ---------------------------------------------------------------------------
 * §12 fixe la séquence, et ce module est le seul endroit qui la connaît :
 *
 *     1. comprendre l'accord            → le modèle, dans le tour unifié
 *     2. déterminer le créneau exact    → `temporal.ts`
 *     3. pre-booking recheck            → `availability.ts`, ICI, juste avant
 *     4. réserver atomiquement          → `store.ts`, la contrainte d'exclusion
 *     5. obtenir un booking_id durable  → la ligne rendue
 *     6. générer/valider la confirmation→ `statement.ts`, chez l'appelant
 *     7. envoyer le DM                  → le rail de réponse, plus tard
 *     8. journaliser                    → ici, quoi qu'il arrive
 *
 * Les points 3 et 4 ne sont PAS séparés par du code applicatif : le recheck sert
 * à choisir quoi dire, la garantie vient de la base. C'est la distinction que
 * §5 impose — un `select` suivi d'un `insert` ne garantit rien, quel que soit le
 * soin mis entre les deux.
 *
 * ---------------------------------------------------------------------------
 * Ce module n'envoie RIEN
 * ---------------------------------------------------------------------------
 * Aucun import de provider, de navigateur ni de primitive d'envoi. Il écrit
 * dans trois tables qui ne portent ni texte, ni destinataire. Le DM part
 * ailleurs, plus tard, et seulement si tout le reste du dépôt l'autorise —
 * arrêt global, plafonds, fenêtre, crochet pré-effet.
 */

import { createHash } from 'node:crypto';
import type { Interval } from '@/lib/booking/availability';
import { nextAvailableSlots } from '@/lib/booking/availability';
import {
  decideBookingTurn,
  type BookingIntent,
  type BookingTurnDecision,
  type ClarificationReason,
} from '@/lib/booking/intent';
import {
  BookingStoreRefusal,
  NATIVE_BOOKING_POLICY_VERSION,
  cancelAppointment,
  loadBusyIntervals,
  loadLatestProposal,
  loadLiveAppointment,
  recordBookingEvent,
  recordProposal,
  rescheduleAppointment,
  reserveAppointment,
  type Appointment,
  type BookingProposal,
} from '@/lib/booking/store';
import type { BookingPolicyConfig } from '@/lib/config/schema';
import type { Sql } from '@/lib/db/sql';

/** L'identité d'une conversation, au format `<canal>:<prospect>`. */
export function conversationKeyFor(channel: string, prospectId: string): string {
  return `${channel}:${prospectId}`;
}

export interface BookingTurnRef {
  readonly prospectId: string;
  readonly channel: 'instagram_dm' | 'email';
  /** Le message reçu qui déclenche ce tour. */
  readonly triggerInboundMessageId: string | null;
  /** Qui écrit. Un nom, jamais « le système ». */
  readonly actor: string;
}

/**
 * Ce que la base dit de l'agenda AVANT que le tour ne décide quoi que ce soit.
 *
 * Lu une seule fois par tour et partagé par le prompt et la décision : deux
 * lectures de la même question finiraient par diverger, et c'est toujours la
 * plus indulgente qui gagnerait — ici, celle qui croit un créneau libre.
 */
export interface BookingSnapshot {
  readonly policy: BookingPolicyConfig;
  readonly liveAppointment: Appointment | null;
  readonly latestProposal: BookingProposal | null;
  readonly busy: readonly Interval[];
  /** Les créneaux libres, calculés. Ce sont les SEULS proposables. */
  readonly freeSlots: readonly Interval[];
}

/**
 * Lit l'agenda pour ce prospect, sans rien décider ni rien écrire.
 *
 * La fenêtre lue est exactement l'horizon de la politique : au-delà, aucun
 * créneau ne serait réservable de toute façon, et lire l'agenda entier
 * n'ajouterait que du volume.
 */
export async function loadBookingSnapshot(
  sql: Sql,
  ref: BookingTurnRef,
  policy: BookingPolicyConfig,
  now: Date,
): Promise<BookingSnapshot> {
  const horizon = new Date(now.getTime() + policy.maxHorizonDays * 24 * 60 * 60_000);
  const [liveAppointment, latestProposal, busy] = await Promise.all([
    loadLiveAppointment(sql, ref.prospectId),
    loadLatestProposal(sql, ref.prospectId),
    loadBusyIntervals(sql, { from: now, to: horizon }),
  ]);
  const input = { policy, now, busy };
  return Object.freeze({
    policy,
    liveAppointment,
    latestProposal,
    busy,
    freeSlots: nextAvailableSlots(input, policy.maxProposedSlots),
  });
}

/**
 * L'agenda vu de l'extérieur quand la base ne répond pas.
 *
 * Fail-closed : aucun créneau libre, aucun rendez-vous, aucune proposition.
 * Un agenda illisible ne propose rien et ne réserve rien — c'est le refus, pas
 * une panne. La même discipline que `understandConversation` applique déjà à sa
 * lecture de `booking_destinations`.
 */
export function emptyBookingSnapshot(policy: BookingPolicyConfig): BookingSnapshot {
  return Object.freeze({
    policy,
    liveAppointment: null,
    latestProposal: null,
    busy: Object.freeze([]),
    freeSlots: Object.freeze([]),
  });
}

// ---------------------------------------------------------------------------
// L'idempotence
// ---------------------------------------------------------------------------

/**
 * §13 — la clé d'un rendez-vous.
 *
 * Elle porte le déclencheur, le créneau RÉSOLU, le genre d'écriture et la
 * version de politique. Chacun compte :
 *
 *   * le déclencheur — rejouer le même message reçu ne crée pas un second
 *     rendez-vous, ce qui rend un redémarrage sans conséquence ;
 *   * le créneau — un message reclassé qui aboutit à un AUTRE créneau est une
 *     décision différente, et doit pouvoir s'écrire ;
 *   * le genre — réserver et déplacer ne sont pas le même geste ;
 *   * la version — une écriture rendue sous d'autres règles ne couvre pas les
 *     règles d'aujourd'hui, exactement comme la clé d'un plan.
 *
 * Hachée pour tenir dans la colonne sans tronquer un identifiant au milieu.
 */
export function bookingIdempotencyKey(input: {
  readonly prospectId: string;
  readonly triggerInboundMessageId: string | null;
  readonly startsAt: Date;
  readonly kind: 'BOOK' | 'RESCHEDULE';
}): string {
  const raw = [
    NATIVE_BOOKING_POLICY_VERSION,
    input.kind,
    input.prospectId,
    input.triggerInboundMessageId ?? 'no-trigger',
    input.startsAt.toISOString(),
  ].join('/');
  return `${input.kind}:${createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 48)}`;
}

// ---------------------------------------------------------------------------
// Le résultat d'un tour
// ---------------------------------------------------------------------------

/** Ce qui s'est réellement passé, dans un vocabulaire fermé. */
export type BookingOutcomeKind =
  | 'NO_BOOKING'
  | 'PROPOSED'
  | 'BOOKED'
  | 'RESCHEDULED'
  | 'CANCELLED'
  | 'ALREADY_BOOKED'
  | 'CLARIFICATION_REQUIRED'
  | 'SLOT_UNAVAILABLE'
  | 'WRITE_REFUSED';

export interface BookingTurnOutcome {
  readonly kind: BookingOutcomeKind;
  /** Le rendez-vous vivant APRÈS ce tour, s'il y en a un. */
  readonly appointment: Appointment | null;
  /** Le rendez-vous que ce tour a écrit. `null` s'il n'a rien écrit. */
  readonly written: Appointment | null;
  /** Celui qu'il a remplacé ou annulé. */
  readonly previous: Appointment | null;
  /** Les créneaux que le texte a le droit de nommer. Jamais d'autres. */
  readonly offered: readonly Interval[];
  /** Le créneau demandé et perdu, pour la réécriture. */
  readonly lostSlot: Interval | null;
  readonly clarification: ClarificationReason | null;
  readonly errorCode: string | null;
}

function outcome(partial: Partial<BookingTurnOutcome> & { kind: BookingOutcomeKind }): BookingTurnOutcome {
  return Object.freeze({
    appointment: null,
    written: null,
    previous: null,
    offered: Object.freeze([]),
    lostSlot: null,
    clarification: null,
    errorCode: null,
    ...partial,
  });
}

export interface CommitBookingInput {
  readonly ref: BookingTurnRef;
  readonly snapshot: BookingSnapshot;
  readonly intent: BookingIntent;
  readonly utterance: string;
  readonly now: Date;
  /** §19 — `QUALIFIED_FOR_CALL`, recopié et jamais recalculé ici. */
  readonly mayPropose: boolean;
}

/**
 * Décide, écrit, et journalise. Dans cet ordre, et une seule fois par tour.
 *
 * Toute sortie passe par `recordBookingEvent` — y compris « rien à faire ».
 * §21 demande de pouvoir reconstruire une décision ; un journal qui ne
 * consignerait que les succès répondrait à toutes les questions sauf la seule
 * qu'on pose vraiment, qui est « pourquoi ce prospect n'a-t-il PAS de
 * rendez-vous ? ».
 *
 * Les refus d'écriture ne lèvent pas : ils deviennent `WRITE_REFUSED` ou
 * `SLOT_UNAVAILABLE`, avec des alternatives. Un créneau perdu est une chose
 * normale — c'est la course de §5 vue depuis le perdant — et la conversation
 * doit continuer, pas s'interrompre.
 */
export async function commitBookingTurn(
  sql: Sql,
  input: CommitBookingInput,
): Promise<BookingTurnOutcome> {
  const { ref, snapshot, now } = input;
  const conversationKey = conversationKeyFor(ref.channel, ref.prospectId);
  const decision: BookingTurnDecision = decideBookingTurn({
    intent: input.intent,
    utterance: input.utterance,
    policy: snapshot.policy,
    now,
    busy: snapshot.busy,
    liveAppointment: snapshot.liveAppointment,
    latestProposal: snapshot.latestProposal,
    mayPropose: input.mayPropose,
  });

  const excerpt = decision.evidence.join(' ').slice(0, 200) || null;
  const journal = async (
    entry: {
      readonly outcome: BookingOutcomeKind;
      readonly appointmentId?: string | null;
      readonly previousAppointmentId?: string | null;
      readonly resolved?: Interval | null;
      readonly availabilityVerdict?: string | null;
      readonly ambiguityReason?: string | null;
      readonly errorCode?: string | null;
    },
  ): Promise<void> => {
    await recordBookingEvent(sql, {
      prospectId: ref.prospectId,
      conversationKey,
      triggerInboundMessageId: ref.triggerInboundMessageId,
      appointmentId: entry.appointmentId ?? null,
      previousAppointmentId: entry.previousAppointmentId ?? null,
      intent: input.intent,
      outcome: entry.outcome,
      requestedExcerpt: excerpt,
      requestedTimezone: snapshot.policy.timezone,
      resolvedStartsAt: entry.resolved?.startsAt ?? null,
      resolvedEndsAt: entry.resolved?.endsAt ?? null,
      availabilityVerdict: entry.availabilityVerdict ?? null,
      ambiguityReason: entry.ambiguityReason ?? null,
      errorCode: entry.errorCode ?? null,
    });
  };

  const action = decision.action;

  switch (action.kind) {
    case 'NO_BOOKING': {
      await journal({ outcome: 'NO_BOOKING' });
      return outcome({ kind: 'NO_BOOKING', appointment: snapshot.liveAppointment });
    }

    case 'CLARIFY': {
      await journal({ outcome: 'CLARIFICATION_REQUIRED', ambiguityReason: action.reason });
      return outcome({
        kind: 'CLARIFICATION_REQUIRED',
        appointment: snapshot.liveAppointment,
        clarification: action.reason,
      });
    }

    case 'ALREADY_BOOKED': {
      await journal({ outcome: 'ALREADY_BOOKED', appointmentId: action.appointment.id });
      return outcome({
        kind: 'ALREADY_BOOKED',
        appointment: action.appointment,
        offered: Object.freeze([
          {
            startsAt: new Date(action.appointment.startsAt),
            endsAt: new Date(action.appointment.endsAt),
          },
        ]),
      });
    }

    case 'PROPOSE_SLOTS': {
      if (action.slots.length === 0) {
        await journal({ outcome: 'NO_BOOKING', availabilityVerdict: 'NO_FREE_SLOT' });
        return outcome({ kind: 'NO_BOOKING' });
      }
      // §11 — l'enregistrement d'une proposition ne réserve RIEN. Aucune ligne
      // écrite ici n'entre dans la contrainte d'exclusion.
      await recordProposal(sql, {
        prospectId: ref.prospectId,
        conversationKey,
        triggerInboundMessageId: ref.triggerInboundMessageId,
        calendarKey: snapshot.policy.calendarKey,
        timezone: snapshot.policy.timezone,
        slots: action.slots,
      });
      await journal({ outcome: 'PROPOSED', resolved: action.slots[0] ?? null });
      return outcome({ kind: 'PROPOSED', offered: action.slots });
    }

    case 'UNAVAILABLE': {
      await journal({
        outcome: 'SLOT_UNAVAILABLE',
        resolved: action.requested,
        availabilityVerdict: action.refusal,
      });
      // Les alternatives deviennent la nouvelle proposition : sans cela, un
      // « ok pour la première » au tour suivant ne se rattacherait à rien.
      if (action.alternatives.length > 0) {
        await recordProposal(sql, {
          prospectId: ref.prospectId,
          conversationKey,
          triggerInboundMessageId: ref.triggerInboundMessageId,
          calendarKey: snapshot.policy.calendarKey,
          timezone: snapshot.policy.timezone,
          slots: action.alternatives,
        });
      }
      return outcome({
        kind: 'SLOT_UNAVAILABLE',
        appointment: snapshot.liveAppointment,
        offered: action.alternatives,
        lostSlot: action.requested,
      });
    }

    case 'CANCEL': {
      const cancelled = await cancelAppointment(sql, {
        appointmentId: action.previous.id,
        at: now,
        reason: 'annulation demandée par le prospect',
      });
      await journal({ outcome: 'CANCELLED', previousAppointmentId: cancelled.id });
      return outcome({ kind: 'CANCELLED', previous: cancelled, appointment: null });
    }

    case 'BOOK': {
      try {
        const result = await reserveAppointment(sql, {
          prospectId: ref.prospectId,
          calendarKey: snapshot.policy.calendarKey,
          conversationKey,
          interval: action.interval,
          timezone: snapshot.policy.timezone,
          source: 'instagram_hermes',
          triggerInboundMessageId: ref.triggerInboundMessageId,
          idempotencyKey: bookingIdempotencyKey({
            prospectId: ref.prospectId,
            triggerInboundMessageId: ref.triggerInboundMessageId,
            startsAt: action.interval.startsAt,
            kind: 'BOOK',
          }),
          createdBy: ref.actor,
        });
        await journal({
          outcome: 'BOOKED',
          appointmentId: result.appointment.id,
          resolved: action.interval,
          availabilityVerdict: 'AVAILABLE',
        });
        return outcome({
          kind: 'BOOKED',
          appointment: result.appointment,
          written: result.appointment,
          offered: Object.freeze([action.interval]),
        });
      } catch (error) {
        return failedWrite(error, action.interval);
      }
    }

    case 'RESCHEDULE': {
      try {
        const result = await rescheduleAppointment(sql, {
          prospectId: ref.prospectId,
          calendarKey: snapshot.policy.calendarKey,
          conversationKey,
          interval: action.interval,
          timezone: snapshot.policy.timezone,
          source: 'instagram_hermes',
          triggerInboundMessageId: ref.triggerInboundMessageId,
          idempotencyKey: bookingIdempotencyKey({
            prospectId: ref.prospectId,
            triggerInboundMessageId: ref.triggerInboundMessageId,
            startsAt: action.interval.startsAt,
            kind: 'RESCHEDULE',
          }),
          createdBy: ref.actor,
          previousAppointmentId: action.previous.id,
          at: now,
          reason: 'report demandé par le prospect',
        });
        await journal({
          outcome: 'RESCHEDULED',
          appointmentId: result.appointment.id,
          previousAppointmentId: action.previous.id,
          resolved: action.interval,
          availabilityVerdict: 'AVAILABLE',
        });
        return outcome({
          kind: 'RESCHEDULED',
          appointment: result.appointment,
          written: result.appointment,
          previous: action.previous,
          offered: Object.freeze([action.interval]),
        });
      } catch (error) {
        return failedWrite(error, action.interval);
      }
    }
  }

  /**
   * Un refus d'écriture devient une CONVERSATION, jamais une exception.
   *
   * `SLOT_TAKEN` est le cas normal de §5 vu depuis le perdant : quelqu'un a pris
   * le créneau entre la lecture et l'écriture. On repropose. Tout le reste est
   * un refus qu'on ne sait pas transformer en phrase, et il ressort tel quel —
   * le texte, lui, ne pourra rien affirmer, `checkBookingStatement` s'en charge.
   */
  async function failedWrite(error: unknown, requested: Interval): Promise<BookingTurnOutcome> {
    if (!(error instanceof BookingStoreRefusal)) throw error;

    const alternatives = nextAvailableSlots(
      { policy: snapshot.policy, now, busy: snapshot.busy },
      snapshot.policy.maxProposedSlots,
    ).filter((slot) => slot.startsAt.getTime() !== requested.startsAt.getTime());

    await journal({
      outcome: error.code === 'SLOT_TAKEN' ? 'SLOT_UNAVAILABLE' : 'WRITE_REFUSED',
      resolved: requested,
      errorCode: error.code,
    });

    if (alternatives.length > 0) {
      await recordProposal(sql, {
        prospectId: ref.prospectId,
        conversationKey,
        triggerInboundMessageId: ref.triggerInboundMessageId,
        calendarKey: snapshot.policy.calendarKey,
        timezone: snapshot.policy.timezone,
        slots: alternatives,
      });
    }

    return outcome({
      kind: error.code === 'SLOT_TAKEN' ? 'SLOT_UNAVAILABLE' : 'WRITE_REFUSED',
      appointment: snapshot.liveAppointment,
      offered: alternatives,
      lostSlot: requested,
      errorCode: error.code,
    });
  }
}
