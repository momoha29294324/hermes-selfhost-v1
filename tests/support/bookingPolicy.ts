/**
 * La politique de rendez-vous des TESTS.
 *
 * §3 de HERMES-NATIVE-BOOKING-R1 est explicite : les tests utilisent une durée
 * SYNTHÉTIQUE. Ils ne doivent pas dépendre de ce que l'opérateur canonique a
 * choisi — sinon changer 30 minutes en 45 casserait vingt assertions qui ne
 * parlent pas de durée, et personne n'oserait plus toucher la configuration.
 *
 * La durée est donc 30 ici parce qu'un test doit bien en choisir une, et
 * chaque test qui parle RÉELLEMENT de durée la passe lui-même.
 */

import type { BookingPolicyConfig } from '@/lib/config/schema';

export const TEST_TZ = 'Europe/Paris';

/** 24 h / 24, 7 j / 7 — l'état déclaré de l'instance canonique. */
export function testBookingPolicy(
  overrides: Partial<BookingPolicyConfig> = {},
): BookingPolicyConfig {
  return {
    calendarKey: 'test-calendar',
    timezone: TEST_TZ,
    appointmentDurationMinutes: 30,
    presentedDuration: { minMinutes: 20, maxMinutes: 30 },
    slotGranularityMinutes: 30,
    minNoticeMinutes: 120,
    maxHorizonDays: 14,
    maxProposedSlots: 2,
    weeklyWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 1_440 }],
    blackouts: [],
    ...overrides,
  };
}

/** Un intervalle, écrit court. */
export function slot(startIso: string, minutes = 30): { startsAt: Date; endsAt: Date } {
  const startsAt = new Date(startIso);
  return { startsAt, endsAt: new Date(startsAt.getTime() + minutes * 60_000) };
}
