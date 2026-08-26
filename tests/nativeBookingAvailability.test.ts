import { describe, expect, it } from 'vitest';
import {
  checkAvailability,
  intervalFor,
  nextAvailableSlots,
  overlaps,
} from '@/lib/booking/availability';
import { minuteOfDayOf } from '@/lib/booking/temporal';
import { slot, testBookingPolicy, TEST_TZ } from './support/bookingPolicy';

/**
 * HERMES-NATIVE-BOOKING-R1 §2/§3/§9/§10 — le moteur de disponibilité.
 *
 * Aucun test n'écrit, aucun n'envoie : le module sous test n'importe ni base,
 * ni provider. `now` est un paramètre partout — c'est ce qui rend ce fichier
 * vert le 3 janvier comme le 31 décembre, à midi comme à 23 h 59.
 */

// Lundi 24 août 2026, 09 h 00 UTC = 11 h 00 à Paris.
const NOW = new Date('2026-08-24T09:00:00.000Z');

describe('§10 — aucune réservation dans le passé', () => {
  it('un créneau qui commence avant maintenant est refusé', () => {
    const verdict = checkAvailability(slot('2026-08-24T08:00:00.000Z'), {
      policy: testBookingPolicy(),
      now: NOW,
      busy: [],
    });
    expect(verdict.available).toBe(false);
    expect(verdict.available === false && verdict.refusal).toBe('IN_THE_PAST');
  });

  it('un créneau qui commence EXACTEMENT maintenant est refusé — pas « à venir »', () => {
    const verdict = checkAvailability({ startsAt: NOW, endsAt: new Date(NOW.getTime() + 1_800_000) }, {
      policy: testBookingPolicy({ minNoticeMinutes: 0 }),
      now: NOW,
      busy: [],
    });
    expect(verdict.available === false && verdict.refusal).toBe('IN_THE_PAST');
  });

  it('le préavis est un refus DISTINCT du passé — il se règle par configuration', () => {
    const inOneHour = slot('2026-08-24T10:00:00.000Z');
    expect(
      checkAvailability(inOneHour, { policy: testBookingPolicy(), now: NOW, busy: [] }),
    ).toMatchObject({ available: false, refusal: 'NOTICE_TOO_SHORT' });

    expect(
      checkAvailability(inOneHour, {
        policy: testBookingPolicy({ minNoticeMinutes: 30 }),
        now: NOW,
        busy: [],
      }),
    ).toMatchObject({ available: true });
  });
});

describe('§3 — la disponibilité porte sur l’INTERVALLE, pas sur l’heure de début', () => {
  it('un rendez-vous qui DÉBORDE de la fenêtre est refusé, même si son début y est', () => {
    // Fenêtre 09 h – 18 h locales. Un créneau de 60 min à 17 h 30 finit à 18 h 30.
    const policy = testBookingPolicy({
      appointmentDurationMinutes: 60,
      weeklyWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], startMinute: 540, endMinute: 1_080 }],
    });
    // 17 h 30 Paris = 15 h 30 UTC en août.
    const late = intervalFor(new Date('2026-08-25T15:30:00.000Z'), policy);
    expect(checkAvailability(late, { policy, now: NOW, busy: [] })).toMatchObject({
      available: false,
      refusal: 'OUTSIDE_AVAILABILITY',
    });

    // Le même créneau une heure plus tôt tient entièrement.
    const fits = intervalFor(new Date('2026-08-25T14:30:00.000Z'), policy);
    expect(checkAvailability(fits, { policy, now: NOW, busy: [] })).toMatchObject({
      available: true,
    });
  });

  it('un rendez-vous qui finit PILE à la fermeture est accepté', () => {
    const policy = testBookingPolicy({
      appointmentDurationMinutes: 30,
      weeklyWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], startMinute: 540, endMinute: 1_080 }],
    });
    // 17 h 30 → 18 h 00 Paris.
    const edge = intervalFor(new Date('2026-08-25T15:30:00.000Z'), policy);
    expect(checkAvailability(edge, { policy, now: NOW, busy: [] })).toMatchObject({
      available: true,
    });
  });

  it('un rendez-vous qui enjambe une PAUSE de midi est refusé', () => {
    const policy = testBookingPolicy({
      appointmentDurationMinutes: 60,
      weeklyWindows: [
        { days: [1, 2, 3, 4, 5, 6, 7], startMinute: 540, endMinute: 720 },
        { days: [1, 2, 3, 4, 5, 6, 7], startMinute: 840, endMinute: 1_080 },
      ],
    });
    // 11 h 45 – 12 h 45 Paris : commence ouvert, finit ouvert, traverse fermé.
    const straddling = intervalFor(new Date('2026-08-25T09:45:00.000Z'), policy);
    expect(checkAvailability(straddling, { policy, now: NOW, busy: [] })).toMatchObject({
      available: false,
      refusal: 'OUTSIDE_AVAILABILITY',
    });
  });
});

describe('§5 — le chevauchement, convention [début, fin)', () => {
  it('deux créneaux qui se TOUCHENT ne se chevauchent pas', () => {
    expect(overlaps(slot('2026-09-01T10:00:00.000Z'), slot('2026-09-01T10:30:00.000Z'))).toBe(false);
  });

  it('un chevauchement d’une minute en est un', () => {
    expect(overlaps(slot('2026-09-01T10:00:00.000Z'), slot('2026-09-01T10:29:00.000Z'))).toBe(true);
  });

  it('un créneau occupé refuse, et le créneau adjacent passe', () => {
    const busy = [slot('2026-09-01T10:00:00.000Z')];
    const input = { policy: testBookingPolicy(), now: NOW, busy };
    expect(checkAvailability(slot('2026-09-01T10:15:00.000Z'), input)).toMatchObject({
      available: false,
      refusal: 'ALREADY_BOOKED',
    });
    expect(checkAvailability(slot('2026-09-01T10:30:00.000Z'), input)).toMatchObject({
      available: true,
    });
  });
});

describe('§22 — les indisponibilités ponctuelles', () => {
  it('un blackout refuse le créneau qu’il recouvre', () => {
    const policy = testBookingPolicy({
      blackouts: [{ startsAt: '2026-09-03T10:00:00.000Z', endsAt: '2026-09-03T15:00:00.000Z' }],
    });
    expect(
      checkAvailability(slot('2026-09-03T12:00:00.000Z'), { policy, now: NOW, busy: [] }),
    ).toMatchObject({ available: false, refusal: 'BLACKED_OUT' });
    expect(
      checkAvailability(slot('2026-09-03T15:00:00.000Z'), { policy, now: NOW, busy: [] }),
    ).toMatchObject({ available: true });
  });

  it('un blackout ILLISIBLE refuse tout — fail-closed', () => {
    const policy = testBookingPolicy({
      blackouts: [{ startsAt: 'pas une date', endsAt: 'pas une date non plus' }],
    });
    expect(
      checkAvailability(slot('2026-09-03T12:00:00.000Z'), { policy, now: NOW, busy: [] }),
    ).toMatchObject({ available: false, refusal: 'BLACKED_OUT' });
  });
});

describe('§6 — les créneaux proposés viennent du moteur', () => {
  it('les créneaux rendus sont libres, alignés sur la grille LOCALE, et futurs', () => {
    const policy = testBookingPolicy({ minNoticeMinutes: 60, slotGranularityMinutes: 30 });
    const slots = nextAvailableSlots({ policy, now: NOW, busy: [] }, 3);
    expect(slots).toHaveLength(3);
    for (const entry of slots) {
      expect(entry.startsAt.getTime()).toBeGreaterThan(NOW.getTime());
      // Heure locale sur une demi-heure pile.
      expect(minuteOfDayOf(entry.startsAt, TEST_TZ) % 30).toBe(0);
      expect(checkAvailability(entry, { policy, now: NOW, busy: [] })).toMatchObject({
        available: true,
      });
    }
  });

  it('un agenda PLEIN rend une liste vide — on n’invente pas un créneau', () => {
    const policy = testBookingPolicy({
      minNoticeMinutes: 0,
      maxHorizonDays: 1,
      weeklyWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], startMinute: 660, endMinute: 720 }],
    });
    // 11 h – 12 h locales aujourd'hui et demain, entièrement occupées.
    const busy = [
      slot('2026-08-24T09:00:00.000Z', 60),
      slot('2026-08-25T09:00:00.000Z', 60),
    ];
    expect(nextAvailableSlots({ policy, now: NOW, busy }, 2)).toHaveLength(0);
  });

  it('les créneaux occupés sont sautés, pas décalés', () => {
    const policy = testBookingPolicy({ minNoticeMinutes: 60 });
    const free = nextAvailableSlots({ policy, now: NOW, busy: [] }, 1);
    const first = free[0]!;
    const withBusy = nextAvailableSlots({ policy, now: NOW, busy: [first] }, 1);
    expect(withBusy[0]!.startsAt.getTime()).toBeGreaterThan(first.startsAt.getTime());
  });
});

describe('§24 — le changement d’heure Europe/Paris', () => {
  it('le passage à l’heure d’HIVER : 02 h 30 existe deux fois, et la fenêtre reste juste', () => {
    // 25 octobre 2026, 03 h 00 locales → 02 h 00 (recul d'une heure).
    const policy = testBookingPolicy({
      minNoticeMinutes: 0,
      maxHorizonDays: 90,
      weeklyWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 1_440 }],
    });
    const now = new Date('2026-10-24T12:00:00.000Z');
    // 00 h 30 UTC ce jour-là = 02 h 30 locale (CEST, avant le recul).
    const before = slot('2026-10-25T00:30:00.000Z');
    // 01 h 30 UTC = 02 h 30 locale (CET, après le recul). Deux instants, une
    // même horloge murale — et les deux sont réservables séparément.
    const after = slot('2026-10-25T01:30:00.000Z');
    expect(checkAvailability(before, { policy, now, busy: [] })).toMatchObject({ available: true });
    expect(checkAvailability(after, { policy, now, busy: [] })).toMatchObject({ available: true });
    // Et ils ne se chevauchent pas : ce sont bien deux heures distinctes.
    expect(overlaps(before, after)).toBe(false);
  });

  it('le passage à l’heure d’ÉTÉ : la durée réelle d’une journée change, l’horizon non', () => {
    // 29 mars 2026 : 02 h 00 → 03 h 00. La journée fait 23 heures.
    const policy = testBookingPolicy({
      minNoticeMinutes: 0,
      maxHorizonDays: 30,
      weeklyWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], startMinute: 540, endMinute: 1_080 }],
    });
    const now = new Date('2026-03-28T12:00:00.000Z');
    // 10 h 00 locales le lendemain du saut = 08 h 00 UTC (CEST, UTC+2).
    const morningAfter = slot('2026-03-29T08:00:00.000Z');
    expect(checkAvailability(morningAfter, { policy, now, busy: [] })).toMatchObject({
      available: true,
    });
    // Le même instant lu comme s'il n'y avait pas eu de saut (UTC+1) serait
    // 09 h 00 locale — aussi dans la fenêtre. Le test qui DISCRIMINE est
    // celui-ci : 08 h 30 locale n'est PAS dans la fenêtre 09 h – 18 h.
    const tooEarly = slot('2026-03-29T06:30:00.000Z');
    expect(checkAvailability(tooEarly, { policy, now, busy: [] })).toMatchObject({
      available: false,
      refusal: 'OUTSIDE_AVAILABILITY',
    });
  });

  it('les créneaux proposés autour du saut restent alignés sur l’horloge LOCALE', () => {
    const policy = testBookingPolicy({
      minNoticeMinutes: 0,
      maxHorizonDays: 5,
      slotGranularityMinutes: 60,
      weeklyWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], startMinute: 540, endMinute: 1_080 }],
    });
    const now = new Date('2026-03-29T07:05:00.000Z'); // 09 h 05 locale, jour du saut
    const slots = nextAvailableSlots({ policy, now, busy: [] }, 3);
    for (const entry of slots) {
      expect(minuteOfDayOf(entry.startsAt, TEST_TZ) % 60).toBe(0);
    }
  });
});

describe('§9 — le déterminisme', () => {
  it('deux appels avec le même `now` rendent exactement les mêmes créneaux', () => {
    const policy = testBookingPolicy();
    const first = nextAvailableSlots({ policy, now: NOW, busy: [] }, 3);
    const second = nextAvailableSlots({ policy, now: NOW, busy: [] }, 3);
    expect(first.map((s) => s.startsAt.toISOString())).toEqual(
      second.map((s) => s.startsAt.toISOString()),
    );
  });

  it('l’horizon borne le balayage : au-delà, rien', () => {
    const policy = testBookingPolicy({
      maxHorizonDays: 1,
      minNoticeMinutes: 0,
      weeklyWindows: [{ days: [6], startMinute: 540, endMinute: 600 }],
    });
    // NOW est un lundi ; le prochain samedi est hors de l'horizon d'un jour.
    expect(nextAvailableSlots({ policy, now: NOW, busy: [] }, 2)).toHaveLength(0);
  });
});
