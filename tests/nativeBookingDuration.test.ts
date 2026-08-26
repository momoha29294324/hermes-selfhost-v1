import { describe, expect, it } from 'vitest';
import { intervalFor } from '@/lib/booking/availability';
import {
  presentedDurationLabel,
  presentedDurationSentence,
} from '@/lib/booking/statement';
import { renderBookingBlock } from '@/lib/booking/prompt';
import { bookingPolicySchema } from '@/lib/config/schema';
import { loadBookingPolicy } from '@/lib/config/load';
import { proposesCall } from '@/lib/conversation/naturalness';
import { slot, testBookingPolicy, TEST_TZ } from './support/bookingPolicy';

/**
 * HERMES-NATIVE-BOOKING-R1 — la durée BLOQUÉE et la durée ANNONCÉE.
 *
 * Deux valeurs distinctes et volontairement non déduites l'une de l'autre : un
 * rendez-vous annoncé « 20 à 25 minutes » occupe un bloc de 25, et la marge
 * appartient à l'opérateur. Un seul désaccord entre elles coûte quelque chose,
 * et ces tests le ferment.
 */

const BASE = {
  calendarKey: 'test',
  timezone: TEST_TZ,
  appointmentDurationMinutes: 25,
  presentedDuration: { minMinutes: 20, maxMinutes: 25 },
  slotGranularityMinutes: 30,
  minNoticeMinutes: 120,
  maxHorizonDays: 14,
  maxProposedSlots: 2,
  weeklyWindows: [{ days: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 1_440 }],
  blackouts: [],
};

/**
 * La configuration LIVRÉE avec cette édition.
 *
 * Ces tests ne pinnent AUCUN chiffre : les valeurs livrées sont des valeurs de
 * départ qu'un opérateur est censé remplacer, et un test qui les figerait
 * casserait chez la première personne qui fait ce qu'on lui demande. Ce qu'ils
 * vérifient sont les INVARIANTS que toute configuration doit tenir — y compris
 * celle qu'on livre, qui n'a aucune raison d'en être dispensée.
 */
describe('la configuration livrée tient ses propres invariants', () => {
  it('on n’annonce jamais plus long que ce qu’on bloque', () => {
    const policy = loadBookingPolicy();
    expect(policy.presentedDuration.maxMinutes).toBeLessThanOrEqual(policy.appointmentDurationMinutes);
    expect(policy.presentedDuration.minMinutes).toBeLessThanOrEqual(policy.presentedDuration.maxMinutes);
  });

  it('les heures de disponibilité sont DÉCLARÉES, jamais devinées', () => {
    const policy = loadBookingPolicy();
    // Le schéma n'a plus de repli « 24 h/24, 7 j/7 » : une instance qui oublie
    // ses heures ne peut pas se retrouver à proposer un dimanche à 3 h.
    expect(policy.weeklyWindows.length).toBeGreaterThan(0);
    for (const window of policy.weeklyWindows) {
      expect(window.endMinute).toBeGreaterThan(window.startMinute);
      expect(window.days.length).toBeGreaterThan(0);
    }
    expect(policy.timezone.length).toBeGreaterThan(2);
  });

  it('le préavis et l’horizon sont bornés des deux côtés', () => {
    const policy = loadBookingPolicy();
    expect(policy.minNoticeMinutes).toBeGreaterThan(0);
    expect(policy.maxHorizonDays).toBeGreaterThan(0);
    expect(policy.maxProposedSlots).toBeGreaterThan(0);
  });

  it('le créneau RÉSERVÉ dure ce que la configuration BLOQUE', () => {
    const policy = loadBookingPolicy();
    const start = new Date('2026-09-02T13:00:00.000Z');
    const interval = intervalFor(start, policy);
    expect(interval.endsAt.getTime() - start.getTime()).toBe(policy.appointmentDurationMinutes * 60_000);
  });
});

describe('on n’annonce JAMAIS plus long que ce qu’on bloque', () => {
  it('une durée annoncée qui dépasse le bloc est refusée AU CHARGEMENT', () => {
    const result = bookingPolicySchema.safeParse({
      ...BASE,
      appointmentDurationMinutes: 25,
      presentedDuration: { minMinutes: 20, maxMinutes: 45 },
    });
    expect(result.success).toBe(false);
  });

  it('annoncer plus COURT que le bloc est licite — c’est la marge', () => {
    const result = bookingPolicySchema.safeParse({
      ...BASE,
      appointmentDurationMinutes: 25,
      presentedDuration: { minMinutes: 20, maxMinutes: 25 },
    });
    expect(result.success).toBe(true);
  });

  it('une fourchette inversée est refusée', () => {
    const result = bookingPolicySchema.safeParse({
      ...BASE,
      presentedDuration: { minMinutes: 25, maxMinutes: 20 },
    });
    expect(result.success).toBe(false);
  });

  it('deux bornes égales n’écrivent pas de fausse fourchette', () => {
    const policy = { presentedDuration: { minMinutes: 25, maxMinutes: 25 } };
    expect(presentedDurationSentence(policy)).toBe('25 minutes');
    expect(presentedDurationLabel(policy)).toBe('25 min');
  });
});

describe('le PROMPT reçoit la durée annoncée, jamais la longueur du bloc', () => {
  it('le bloc de créneaux porte « 20 à 25 minutes »', () => {
    const rendered = renderBookingBlock({
      presentedDuration: '20 à 25 minutes',
      liveAppointment: null,
      slots: [slot('2026-09-02T13:00:00.000Z', 25)],
      timezone: TEST_TZ,
    });
    expect(rendered).toContain('20 à 25 minutes');
    // La longueur du BLOC n'a aucune raison d'être sous les yeux du modèle :
    // la lui donner l'exposerait à l'écrire.
    expect(rendered).not.toContain('bloc');
  });
});

describe('le lexique connaît la FOURCHETTE de durée', () => {
  it('« 20 à 25 minutes » est reconnu comme une proposition d’échange', () => {
    expect(proposesCall('On se cale 20 à 25 minutes cette semaine ?')).toBe(true);
    expect(proposesCall('Je te propose 20-25 minutes mercredi.')).toBe(true);
    expect(proposesCall('Un point de 20–25 min, ça te va ?')).toBe(true);
  });

  it('l’ancienne formulation reste reconnue', () => {
    expect(proposesCall('On se cale quinze minutes ?')).toBe(true);
    expect(proposesCall('15 minutes suffisent.')).toBe(true);
  });

  it('une durée NUE qui parle du service n’est pas une proposition d’échange', () => {
    // « ça prend 10 minutes à mettre en place » parle du service. Le compter
    // comme un appel bloquerait un tour parfaitement légitime.
    expect(proposesCall('La mise en place prend 10 minutes.')).toBe(false);
  });
});

describe('la politique de test reste indépendante de l’instance canonique', () => {
  it('les tests portent leur PROPRE agenda — changer la config ne les casse pas', () => {
    // La preuve n'est pas un chiffre différent, qui redeviendrait égal le jour
    // où quelqu'un modifie le fichier livré : c'est que la politique de test
    // désigne un AUTRE agenda, et qu'elle est construite et non lue.
    expect(testBookingPolicy().calendarKey).toBe('test-calendar');
    expect(testBookingPolicy().calendarKey).not.toBe(loadBookingPolicy().calendarKey);
    expect(testBookingPolicy().timezone).toBe(TEST_TZ);
  });
});
