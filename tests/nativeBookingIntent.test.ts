import { describe, expect, it } from 'vitest';
import { decideBookingTurn, type BookingTurnInput } from '@/lib/booking/intent';
import type { Appointment, BookingProposal } from '@/lib/booking/store';
import { slot, testBookingPolicy, TEST_TZ } from './support/bookingPolicy';

/**
 * HERMES-NATIVE-BOOKING-R1 §7/§11/§14/§15/§19 — ce que le runtime DÉCIDE de
 * faire d'un tour.
 *
 * Module PUR : aucun test ici n'ouvre de base et aucun n'écrit. C'est ce qui
 * permet d'éprouver des états que les données réelles ne produiront pas de
 * sitôt — un créneau perdu entre la proposition et l'acceptation, par exemple.
 */

// Lundi 24 août 2026, 11 h 00 à Paris.
const NOW = new Date('2026-08-24T09:00:00.000Z');

const WEDNESDAY_15H = slot('2026-08-26T13:00:00.000Z'); // mercredi 15 h Paris
const THURSDAY_11H = slot('2026-08-27T09:00:00.000Z'); // jeudi 11 h Paris
const WEDNESDAY_18H = slot('2026-08-26T16:00:00.000Z'); // mercredi 18 h Paris

function appointment(interval: { startsAt: Date; endsAt: Date }): Appointment {
  return {
    id: 'appt-1',
    prospectId: 'p-1',
    calendarKey: 'test-calendar',
    conversationKey: 'instagram_dm:p-1',
    startsAt: interval.startsAt.toISOString(),
    endsAt: interval.endsAt.toISOString(),
    timezone: TEST_TZ,
    status: 'CONFIRMED',
    source: 'instagram_hermes',
    triggerInboundMessageId: null,
    idempotencyKey: 'k',
    policyVersion: 'hermes-native-booking-r1',
    supersedesId: null,
    confirmationState: 'DELIVERED',
    confirmedAt: NOW.toISOString(),
    cancelledAt: null,
    cancelledReason: null,
    createdBy: 'hermes',
    createdAt: NOW.toISOString(),
  };
}

function proposal(slots: readonly { startsAt: Date; endsAt: Date }[]): BookingProposal {
  return {
    id: 'prop-1',
    prospectId: 'p-1',
    conversationKey: 'instagram_dm:p-1',
    triggerInboundMessageId: null,
    calendarKey: 'test-calendar',
    timezone: TEST_TZ,
    slots,
    proposedAt: NOW.toISOString(),
  };
}

function turn(overrides: Partial<BookingTurnInput>): BookingTurnInput {
  return {
    intent: 'NONE',
    utterance: '',
    policy: testBookingPolicy(),
    now: NOW,
    busy: [],
    liveAppointment: null,
    latestProposal: null,
    mayPropose: false,
    ...overrides,
  };
}

describe('§24 — nominal : Hermes propose, le prospect accepte', () => {
  it('une conversation qualifiée reçoit des créneaux CALCULÉS', () => {
    const decision = decideBookingTurn(
      turn({ intent: 'ASK_AVAILABILITY', utterance: 'tu es dispo quand ?', mayPropose: true }),
    );
    expect(decision.action.kind).toBe('PROPOSE_SLOTS');
    expect(decision.action.kind === 'PROPOSE_SLOTS' && decision.action.slots.length).toBe(2);
  });

  it('« mercredi 15h ça me va » sur un créneau proposé et libre → RÉSERVER', () => {
    const decision = decideBookingTurn(
      turn({
        intent: 'ACCEPT_PROPOSAL',
        utterance: 'Mercredi 15h ça me va.',
        latestProposal: proposal([WEDNESDAY_15H, THURSDAY_11H]),
      }),
    );
    expect(decision.action.kind).toBe('BOOK');
    if (decision.action.kind !== 'BOOK') throw new Error('unreachable');
    expect(decision.action.interval.startsAt.toISOString()).toBe(WEDNESDAY_15H.startsAt.toISOString());
    expect(decision.action.fromProposal).toBe(true);
  });

  it('« mercredi » seul, quand UN seul créneau proposé tombe ce jour-là, suffit', () => {
    const decision = decideBookingTurn(
      turn({
        intent: 'ACCEPT_PROPOSAL',
        utterance: 'mercredi c’est parfait',
        latestProposal: proposal([WEDNESDAY_15H, THURSDAY_11H]),
      }),
    );
    expect(decision.action.kind).toBe('BOOK');
    expect(
      decision.action.kind === 'BOOK' && decision.action.interval.startsAt.toISOString(),
    ).toBe(WEDNESDAY_15H.startsAt.toISOString());
  });

  it('« ok ça marche » sur UNE seule proposition suffit', () => {
    const decision = decideBookingTurn(
      turn({
        intent: 'ACCEPT_PROPOSAL',
        utterance: 'ok ça marche',
        latestProposal: proposal([WEDNESDAY_15H]),
      }),
    );
    expect(decision.action.kind).toBe('BOOK');
  });

  it('« ok ça marche » sur DEUX propositions ne désigne rien', () => {
    const decision = decideBookingTurn(
      turn({
        intent: 'ACCEPT_PROPOSAL',
        utterance: 'ok ça marche',
        latestProposal: proposal([WEDNESDAY_15H, THURSDAY_11H]),
      }),
    );
    expect(decision.action).toMatchObject({ kind: 'CLARIFY', reason: 'PROPOSAL_AMBIGUOUS' });
  });
});

describe('§24 — contre-proposition du prospect', () => {
  it('« je préférerais mercredi vers 18h », libre → RÉSERVER 18 h', () => {
    const decision = decideBookingTurn(
      turn({
        intent: 'PROPOSE_TIME',
        utterance: 'Je préférerais mercredi vers 18h.',
        latestProposal: proposal([WEDNESDAY_15H, THURSDAY_11H]),
      }),
    );
    expect(decision.action.kind).toBe('BOOK');
    if (decision.action.kind !== 'BOOK') throw new Error('unreachable');
    expect(decision.action.interval.startsAt.toISOString()).toBe(WEDNESDAY_18H.startsAt.toISOString());
    // Ce créneau ne venait PAS de nous : le journal doit pouvoir le dire.
    expect(decision.action.fromProposal).toBe(false);
  });

  it('un créneau proposé par le prospect passe les MÊMES contrôles', () => {
    const decision = decideBookingTurn(
      turn({
        intent: 'PROPOSE_TIME',
        // Dimanche 30 août 4 h du matin : hors de la fenêtre déclarée.
        utterance: 'dimanche à 4h du matin ?',
        policy: testBookingPolicy({
          weeklyWindows: [{ days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1_200 }],
        }),
      }),
    );
    expect(decision.action).toMatchObject({ kind: 'UNAVAILABLE', refusal: 'OUTSIDE_AVAILABILITY' });
  });
});

describe('§24 — le créneau demandé est occupé', () => {
  it('aucune confirmation, et des alternatives CALCULÉES', () => {
    const decision = decideBookingTurn(
      turn({
        intent: 'PROPOSE_TIME',
        utterance: 'mercredi à 15h ?',
        busy: [WEDNESDAY_15H],
      }),
    );
    expect(decision.action.kind).toBe('UNAVAILABLE');
    if (decision.action.kind !== 'UNAVAILABLE') throw new Error('unreachable');
    expect(decision.action.refusal).toBe('ALREADY_BOOKED');
    expect(decision.action.alternatives.length).toBeGreaterThan(0);
    for (const alt of decision.action.alternatives) {
      expect(alt.startsAt.toISOString()).not.toBe(WEDNESDAY_15H.startsAt.toISOString());
    }
  });
});

describe('§11 — proposer n’est pas réserver : le créneau PÉRIMÉ', () => {
  it('accepter un créneau proposé mais pris entre-temps ne confirme RIEN', () => {
    const decision = decideBookingTurn(
      turn({
        intent: 'ACCEPT_PROPOSAL',
        utterance: 'Mercredi 15h ça me va.',
        latestProposal: proposal([WEDNESDAY_15H, THURSDAY_11H]),
        // Quelqu'un d'autre l'a pris depuis la proposition.
        busy: [WEDNESDAY_15H],
      }),
    );
    expect(decision.action).toMatchObject({ kind: 'UNAVAILABLE', refusal: 'ALREADY_BOOKED' });
  });

  it('accepter un créneau proposé devenu PASSÉ ne confirme rien non plus', () => {
    // L'accord arrive SANS redire la date — c'est le cas où le créneau périmé
    // vient entièrement de notre proposition, donc celui qui peut mentir.
    const decision = decideBookingTurn(
      turn({
        intent: 'ACCEPT_PROPOSAL',
        utterance: 'ok ça marche',
        latestProposal: proposal([WEDNESDAY_15H]),
        // On est désormais après le créneau proposé.
        now: new Date('2026-08-27T09:00:00.000Z'),
      }),
    );
    expect(decision.action).toMatchObject({ kind: 'UNAVAILABLE', refusal: 'IN_THE_PAST' });
  });

  it('en revanche, REDIRE « mercredi 15h » un jeudi désigne le mercredi SUIVANT', () => {
    // Ce n'est pas un créneau périmé : c'est une demande neuve, que le prospect
    // a formulée lui-même, et qui doit être honorée.
    const decision = decideBookingTurn(
      turn({
        intent: 'ACCEPT_PROPOSAL',
        utterance: 'ok pour mercredi 15h',
        latestProposal: proposal([WEDNESDAY_15H]),
        now: new Date('2026-08-27T09:00:00.000Z'),
      }),
    );
    expect(decision.action.kind).toBe('BOOK');
    expect(
      decision.action.kind === 'BOOK' && decision.action.interval.startsAt.toISOString(),
    ).toBe('2026-09-02T13:00:00.000Z');
  });
});

describe('§8 — l’ambiguïté demande, elle ne réserve pas', () => {
  it('« mercredi » sans proposition correspondante demande l’heure', () => {
    const decision = decideBookingTurn(
      turn({ intent: 'PROPOSE_TIME', utterance: 'mercredi ?' }),
    );
    expect(decision.action).toMatchObject({ kind: 'CLARIFY', reason: 'TIME_MISSING' });
  });

  it('« vers 3h » ne se complète JAMAIS par une proposition', () => {
    const decision = decideBookingTurn(
      turn({
        intent: 'PROPOSE_TIME',
        utterance: 'on peut se caler vers 3h ?',
        // Un créneau proposé à 15 h existe : le compléter serait choisir à sa place.
        latestProposal: proposal([slot('2026-08-26T13:00:00.000Z')]),
      }),
    );
    expect(decision.action).toMatchObject({ kind: 'CLARIFY', reason: 'MERIDIEM_AMBIGUOUS' });
  });

  it('« le 12 » demande le mois', () => {
    expect(
      decideBookingTurn(turn({ intent: 'PROPOSE_TIME', utterance: 'le 12 à 15h ?' })).action,
    ).toMatchObject({ kind: 'CLARIFY', reason: 'MONTH_AMBIGUOUS' });
  });

  it('« demain en fin de journée » demande une heure', () => {
    expect(
      decideBookingTurn(turn({ intent: 'PROPOSE_TIME', utterance: 'demain en fin de journée' }))
        .action,
    ).toMatchObject({ kind: 'CLARIFY', reason: 'VAGUE_PERIOD' });
  });

  it('une heure sans date ne devient PAS « aujourd’hui »', () => {
    expect(
      decideBookingTurn(turn({ intent: 'PROPOSE_TIME', utterance: 'à 15h ?' })).action,
    ).toMatchObject({ kind: 'CLARIFY', reason: 'DATE_MISSING' });
  });
});

describe('§14 — le report', () => {
  it('« finalement plutôt 18h ? » avec un rendez-vous vivant → REPORT', () => {
    const decision = decideBookingTurn(
      turn({
        intent: 'PROPOSE_TIME',
        utterance: 'finalement plutôt mercredi 18h ?',
        liveAppointment: appointment(WEDNESDAY_15H),
        busy: [WEDNESDAY_15H],
      }),
    );
    expect(decision.action.kind).toBe('RESCHEDULE');
    if (decision.action.kind !== 'RESCHEDULE') throw new Error('unreachable');
    expect(decision.action.interval.startsAt.toISOString()).toBe(WEDNESDAY_18H.startsAt.toISOString());
    expect(decision.action.previous.id).toBe('appt-1');
  });

  it('un report vers son PROPRE créneau ne déplace rien', () => {
    const decision = decideBookingTurn(
      turn({
        intent: 'RESCHEDULE',
        utterance: 'on reste sur mercredi 15h ?',
        liveAppointment: appointment(WEDNESDAY_15H),
        busy: [WEDNESDAY_15H],
      }),
    );
    expect(decision.action.kind).toBe('ALREADY_BOOKED');
  });

  it('un décalage COURT n’est pas bloqué par son propre rendez-vous', () => {
    // 15 h 00 → 15 h 15 : les deux intervalles se chevauchent, mais l'ancien
    // est libéré dans la même transaction.
    const decision = decideBookingTurn(
      turn({
        intent: 'RESCHEDULE',
        utterance: 'on peut décaler à mercredi 15h15 ?',
        liveAppointment: appointment(WEDNESDAY_15H),
        busy: [WEDNESDAY_15H],
      }),
    );
    expect(decision.action.kind).toBe('RESCHEDULE');
  });

  it('« on peut décaler ? » sans nouvelle heure demande laquelle', () => {
    expect(
      decideBookingTurn(
        turn({
          intent: 'RESCHEDULE',
          utterance: 'on peut décaler ?',
          liveAppointment: appointment(WEDNESDAY_15H),
        }),
      ).action,
    ).toMatchObject({ kind: 'CLARIFY', reason: 'RESCHEDULE_TIME_MISSING' });
  });

  it('un report sans rendez-vous vivant ne fabrique rien', () => {
    expect(
      decideBookingTurn(turn({ intent: 'RESCHEDULE', utterance: 'on décale à jeudi 11h ?' })).action,
    ).toMatchObject({ kind: 'CLARIFY', reason: 'NO_LIVE_APPOINTMENT' });
  });

  it('un report vers un créneau OCCUPÉ par quelqu’un d’autre propose des alternatives', () => {
    const decision = decideBookingTurn(
      turn({
        intent: 'RESCHEDULE',
        utterance: 'plutôt jeudi à 11h ?',
        liveAppointment: appointment(WEDNESDAY_15H),
        busy: [WEDNESDAY_15H, THURSDAY_11H],
      }),
    );
    expect(decision.action).toMatchObject({ kind: 'UNAVAILABLE', refusal: 'ALREADY_BOOKED' });
  });
});

describe('§15 — l’annulation', () => {
  it('une annulation avec rendez-vous vivant l’annule', () => {
    const decision = decideBookingTurn(
      turn({
        intent: 'CANCEL',
        utterance: 'je dois annuler finalement',
        liveAppointment: appointment(WEDNESDAY_15H),
      }),
    );
    expect(decision.action).toMatchObject({ kind: 'CANCEL' });
  });

  it('une annulation qui contient une heure reste une ANNULATION', () => {
    const decision = decideBookingTurn(
      turn({
        intent: 'CANCEL',
        utterance: 'je ne pourrai pas mercredi 15h, on laisse tomber',
        liveAppointment: appointment(WEDNESDAY_15H),
      }),
    );
    expect(decision.action.kind).toBe('CANCEL');
  });

  it('une annulation sans rendez-vous ne casse rien', () => {
    expect(
      decideBookingTurn(turn({ intent: 'CANCEL', utterance: 'j’annule' })).action,
    ).toMatchObject({ kind: 'CLARIFY', reason: 'NO_LIVE_APPOINTMENT' });
  });
});

describe('§19 — Hermes ne force pas un rendez-vous à chaque message', () => {
  it('un tour ordinaire d’une conversation NON qualifiée ne propose rien', () => {
    expect(
      decideBookingTurn(turn({ intent: 'NONE', utterance: 'ah ok je vois', mayPropose: false }))
        .action.kind,
    ).toBe('NO_BOOKING');
  });

  it('une conversation qualifiée propose UNE fois, puis se tait', () => {
    const first = decideBookingTurn(
      turn({ intent: 'NONE', utterance: 'ok', mayPropose: true }),
    );
    expect(first.action.kind).toBe('PROPOSE_SLOTS');

    const second = decideBookingTurn(
      turn({
        intent: 'NONE',
        utterance: 'et vous travaillez avec qui ?',
        mayPropose: true,
        latestProposal: proposal([WEDNESDAY_15H, THURSDAY_11H]),
      }),
    );
    expect(second.action.kind).toBe('NO_BOOKING');
  });

  it('mais une DEMANDE explicite de disponibilités repropose', () => {
    const decision = decideBookingTurn(
      turn({
        intent: 'ASK_AVAILABILITY',
        utterance: 'tu es dispo quand du coup ?',
        mayPropose: true,
        latestProposal: proposal([WEDNESDAY_15H, THURSDAY_11H]),
      }),
    );
    expect(decision.action.kind).toBe('PROPOSE_SLOTS');
  });

  it('un prospect qui a DÉJÀ un rendez-vous ne reçoit plus de créneaux', () => {
    expect(
      decideBookingTurn(
        turn({
          intent: 'ASK_AVAILABILITY',
          utterance: 'tu es dispo quand ?',
          mayPropose: true,
          liveAppointment: appointment(WEDNESDAY_15H),
          busy: [WEDNESDAY_15H],
        }),
      ).action.kind,
    ).toBe('NO_BOOKING');
  });

  it('un agenda plein propose une liste vide plutôt qu’un créneau inventé', () => {
    const decision = decideBookingTurn(
      turn({
        intent: 'ASK_AVAILABILITY',
        utterance: 'tu es dispo quand ?',
        mayPropose: true,
        policy: testBookingPolicy({
          minNoticeMinutes: 0,
          maxHorizonDays: 1,
          weeklyWindows: [{ days: [1], startMinute: 660, endMinute: 720 }],
        }),
        busy: [slot('2026-08-24T09:00:00.000Z', 60)],
      }),
    );
    expect(decision.action).toMatchObject({ kind: 'PROPOSE_SLOTS', slots: [] });
  });
});
