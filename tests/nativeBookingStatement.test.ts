import { describe, expect, it } from 'vitest';
import { checkBookingStatement, claimsReservation, formatSlot } from '@/lib/booking/statement';
import type { Appointment } from '@/lib/booking/store';
import { slot, TEST_TZ } from './support/bookingPolicy';

/**
 * HERMES-NATIVE-BOOKING-R1 §6/§11/§12 — « Hermes ne dit jamais "c'est
 * réservé" » quand ça ne l'est pas.
 *
 * C'est la seule affirmation de ce round qui coûterait quelque chose à un vrai
 * commerçant si elle était fausse : il bloquerait une demi-heure de sa journée
 * pour un rendez-vous qui n'existe nulle part.
 */

const NOW = new Date('2026-08-24T09:00:00.000Z'); // lundi 24 août, 11 h Paris
const WEDNESDAY_15H = slot('2026-08-26T13:00:00.000Z');
const THURSDAY_11H = slot('2026-08-27T09:00:00.000Z');

function booked(interval = WEDNESDAY_15H): Appointment {
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
    confirmationState: 'PENDING',
    confirmedAt: null,
    cancelledAt: null,
    cancelledReason: null,
    createdBy: 'hermes',
    createdAt: NOW.toISOString(),
  };
}

function codes(flags: readonly { code: string }[]): string[] {
  return flags.map((flag) => flag.code);
}

describe('§11 — affirmer une réservation qu’on n’a pas', () => {
  it('« c’est réservé » sans rendez-vous est BLOQUANT', () => {
    const flags = checkBookingStatement('Parfait, c’est réservé pour mercredi à 15h 👍', {
      booked: null,
      offered: [],
      timezone: TEST_TZ,
      now: NOW,
    });
    expect(codes(flags)).toContain('booking_claim_without_reservation');
    expect(flags.every((flag) => flag.blocking)).toBe(true);
  });

  it('les formes usuelles sont toutes attrapées', () => {
    for (const text of [
      'C’est calé pour mercredi 15h.',
      'Je te bloque le créneau.',
      'Je vous confirme le rendez-vous.',
      'J’ai réservé mercredi.',
      'Rendez-vous confirmé.',
      'C’est noté pour mercredi à 15h.',
    ]) {
      expect(claimsReservation(text), text).toBe(true);
    }
  });

  it('« c’est noté » SEUL n’est pas une confirmation de rendez-vous', () => {
    // Neuf fois sur dix, c'est « j'ai compris ». Le traiter comme une
    // confirmation bloquerait des tours parfaitement ordinaires.
    expect(claimsReservation('C’est noté, je te laisse revenir vers moi.')).toBe(false);
    expect(
      checkBookingStatement('C’est noté, merci pour ta réponse.', {
        booked: null,
        offered: [],
        timezone: TEST_TZ,
        now: NOW,
      }),
    ).toHaveLength(0);
  });

  it('un tour ordinaire sans agenda ne déclenche rien', () => {
    expect(
      checkBookingStatement('Et tes clients te trouvent plutôt par Instagram ou par le bouche à oreille ?', {
        booked: null,
        offered: [],
        timezone: TEST_TZ,
        now: NOW,
      }),
    ).toHaveLength(0);
  });
});

describe('§12 — réserver sans le dire', () => {
  it('un rendez-vous ÉCRIT que le texte ne nomme pas est BLOQUANT', () => {
    const flags = checkBookingStatement('Super, à très vite alors !', {
      booked: booked(),
      offered: [WEDNESDAY_15H],
      timezone: TEST_TZ,
      now: NOW,
      writtenThisTurn: true,
    });
    expect(codes(flags)).toContain('booking_confirmation_missing');
  });

  it('nommer l’heure suffit — le style reste libre', () => {
    const flags = checkBookingStatement('Parfait, c’est calé pour mercredi à 15h.', {
      booked: booked(),
      offered: [WEDNESDAY_15H],
      timezone: TEST_TZ,
      now: NOW,
      writtenThisTurn: true,
    });
    expect(flags).toHaveLength(0);
  });

  it('« 15:00 » compte autant que « 15h »', () => {
    const flags = checkBookingStatement('C’est réservé mercredi 15:00.', {
      booked: booked(),
      offered: [WEDNESDAY_15H],
      timezone: TEST_TZ,
      now: NOW,
      writtenThisTurn: true,
    });
    expect(flags).toHaveLength(0);
  });

  it('un rendez-vous ANCIEN n’a pas à être renommé à chaque tour', () => {
    const flags = checkBookingStatement('Oui bien sûr, je te réponds là-dessus.', {
      booked: booked(),
      offered: [],
      timezone: TEST_TZ,
      now: NOW,
      writtenThisTurn: false,
    });
    expect(codes(flags)).not.toContain('booking_confirmation_missing');
  });
});

describe('§12 — nommer un AUTRE créneau que celui qui est réservé', () => {
  it('confirmer 18 h quand 15 h est réservé est BLOQUANT', () => {
    const flags = checkBookingStatement('C’est réservé pour mercredi à 18h.', {
      booked: booked(),
      offered: [WEDNESDAY_15H],
      timezone: TEST_TZ,
      now: NOW,
      writtenThisTurn: true,
    });
    expect(codes(flags)).toContain('booking_slot_mismatch');
  });

  it('confirmer le bon jour à la bonne heure ne déclenche rien', () => {
    const flags = checkBookingStatement('C’est bon pour mercredi 26 août à 15h.', {
      booked: booked(),
      offered: [WEDNESDAY_15H],
      timezone: TEST_TZ,
      now: NOW,
      writtenThisTurn: true,
    });
    expect(flags).toHaveLength(0);
  });
});

describe('§6 — un créneau ne s’invente pas', () => {
  it('proposer un créneau que le moteur n’a pas rendu est BLOQUANT', () => {
    const flags = checkBookingStatement('Je peux te proposer mercredi à 16h ?', {
      booked: null,
      offered: [WEDNESDAY_15H, THURSDAY_11H],
      timezone: TEST_TZ,
      now: NOW,
    });
    expect(codes(flags)).toContain('booking_slot_not_offered');
  });

  it('proposer exactement les créneaux calculés ne déclenche rien', () => {
    const flags = checkBookingStatement(
      'Je peux te proposer mercredi à 15h ou jeudi vers 11h, tu préfères lequel ?',
      { booked: null, offered: [WEDNESDAY_15H, THURSDAY_11H], timezone: TEST_TZ, now: NOW },
    );
    expect(flags).toHaveLength(0);
  });

  it('le produit CROISÉ des créneaux proposés est refusé', () => {
    // Les nombres et les jours sont tous « autorisés » pris séparément — c'est
    // exactement le cas qu'un contrôle par ensembles laisserait passer.
    const flags = checkBookingStatement(
      'Je peux te proposer mercredi à 11h ou jeudi vers 15h ?',
      { booked: null, offered: [WEDNESDAY_15H, THURSDAY_11H], timezone: TEST_TZ, now: NOW },
    );
    expect(codes(flags)).toContain('booking_slot_not_offered');
  });

  it('un tour SANS agenda n’interdit aucune date — on ne juge pas ce qu’on n’a pas calculé', () => {
    const flags = checkBookingStatement('Tu m’avais dit que mardi 18 août était chargé.', {
      booked: null,
      offered: [],
      timezone: TEST_TZ,
      now: NOW,
    });
    expect(flags).toHaveLength(0);
  });
});

describe('l’écriture d’un créneau', () => {
  it('rend une forme française lisible, dans le fuseau demandé', () => {
    expect(formatSlot(WEDNESDAY_15H, TEST_TZ)).toBe('mercredi 26 août à 15h00');
  });

  it('suit le changement d’heure', () => {
    // 2 décembre 2026, 15 h Paris = 14 h UTC.
    expect(formatSlot(slot('2026-12-02T14:00:00.000Z'), TEST_TZ)).toBe('mercredi 2 décembre à 15h00');
  });
});
