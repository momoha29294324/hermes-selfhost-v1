import { describe, expect, it } from 'vitest';
import {
  instantOf,
  mentionedSlots,
  mentionedTimes,
  readTemporal,
} from '@/lib/booking/temporal';
import { TEST_TZ } from './support/bookingPolicy';

/**
 * HERMES-NATIVE-BOOKING-R1 §7/§8/§9 — de la langue à un instant, ou à un refus
 * nommé.
 *
 * `now` est un paramètre partout : ce fichier est vert quel que soit le jour et
 * l'heure où il tourne, et c'est exactement ce que §9 demande.
 */

// Lundi 24 août 2026, 11 h 00 à Paris.
const NOW = new Date('2026-08-24T09:00:00.000Z');

function date(text: string): string {
  const reading = readTemporal(text, NOW, TEST_TZ);
  if (reading.date.kind === 'RESOLVED') {
    const d = reading.date.date;
    return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
  }
  return reading.date.kind === 'AMBIGUOUS' ? reading.date.refusal : 'ABSENT';
}

function time(text: string): string {
  const reading = readTemporal(text, NOW, TEST_TZ);
  if (reading.time.kind === 'RESOLVED') return String(reading.time.minuteOfDay);
  return reading.time.kind === 'AMBIGUOUS' ? reading.time.refusal : 'ABSENT';
}

describe('§7 — les formulations que la mission exige de comprendre', () => {
  it('« Mercredi 15h ça me va »', () => {
    expect(date('Mercredi 15h ça me va.')).toBe('2026-08-26');
    expect(time('Mercredi 15h ça me va.')).toBe(String(15 * 60));
  });

  it('« Je préférerais mercredi vers 18h »', () => {
    expect(date('Je préférerais mercredi vers 18h.')).toBe('2026-08-26');
    expect(time('Je préférerais mercredi vers 18h.')).toBe(String(18 * 60));
  });

  it('« Demain vers 14h »', () => {
    expect(date('Demain vers 14h')).toBe('2026-08-25');
    expect(time('Demain vers 14h')).toBe(String(14 * 60));
  });

  it('« Vendredi matin vers 10h30 » — « matin » qualifie, il ne rend pas vague', () => {
    expect(date('Vendredi matin vers 10h30')).toBe('2026-08-28');
    expect(time('Vendredi matin vers 10h30')).toBe(String(10 * 60 + 30));
  });

  it('« Plutôt jeudi à 17h ça serait possible ? »', () => {
    expect(date('Plutôt jeudi à 17h ça serait possible ?')).toBe('2026-08-27');
    expect(time('Plutôt jeudi à 17h ça serait possible ?')).toBe(String(17 * 60));
  });

  it('une date écrite DEUX fois ne compte qu’une : « mercredi 26 août à 15h »', () => {
    expect(date('mercredi 26 août à 15h')).toBe('2026-08-26');
    expect(time('mercredi 26 août à 15h')).toBe(String(15 * 60));
  });

  it('« le 26/08 à 9h » — la forme numérique', () => {
    expect(date('le 26/08 à 9h')).toBe('2026-08-26');
    expect(time('le 26/08 à 9h')).toBe(String(9 * 60));
  });

  it('« après-demain à midi » — et « midi » n’est pas « après-midi »', () => {
    expect(date('après-demain à midi')).toBe('2026-08-26');
    expect(time('après-demain à midi')).toBe(String(12 * 60));
  });
});

describe('§8 — l’ambiguïté ne devient JAMAIS un rendez-vous', () => {
  it('« mercredi » — l’heure manque', () => {
    expect(date('mercredi')).toBe('2026-08-26');
    expect(time('mercredi')).toBe('ABSENT');
  });

  it('« vers 3h » — le demi-tour d’horloge', () => {
    expect(time('on se cale vers 3h ?')).toBe('MERIDIEM_AMBIGUOUS');
  });

  it('« à 5h du matin » et « à 5h de l’après-midi » sont, eux, sans ambiguïté', () => {
    expect(time('à 5h du matin')).toBe(String(5 * 60));
    expect(time('à 5h de l’après-midi')).toBe(String(17 * 60));
  });

  it('« le 12 » — le mois manque', () => {
    expect(date('on dit le 12 ?')).toBe('MONTH_AMBIGUOUS');
  });

  it('« demain en fin de journée » — la plage est trop large', () => {
    expect(date('demain en fin de journée')).toBe('2026-08-25');
    expect(time('demain en fin de journée')).toBe('VAGUE_PERIOD');
  });

  it('« ce soir » — vague, et sans date', () => {
    expect(time('ce soir ?')).toBe('VAGUE_PERIOD');
  });

  it('« la semaine prochaine » — aucun jour désigné', () => {
    expect(time('plutôt la semaine prochaine')).toBe('VAGUE_PERIOD');
  });

  it('« mercredi ou jeudi » — deux dates', () => {
    expect(date('mercredi ou jeudi ?')).toBe('MULTIPLE_CANDIDATES');
  });

  it('« 15h ou 18h » — deux heures', () => {
    expect(time('15h ou 18h ?')).toBe('MULTIPLE_CANDIDATES');
  });

  it('un refus l’emporte sur une résolution dans la même phrase', () => {
    expect(date('mercredi ou le 12 ?')).toBe('MONTH_AMBIGUOUS');
  });

  it('« mercredi prochain » — l’usage français est partagé, donc on demande', () => {
    expect(date('mercredi prochain à 15h')).toBe('NEXT_OCCURRENCE_AMBIGUOUS');
  });

  it('un jour de la semaine dit LE JOUR MÊME est ambigu', () => {
    // NOW est un lundi.
    expect(date('lundi à 15h')).toBe('WEEKDAY_TODAY_AMBIGUOUS');
  });

  it('« 25h » et « 14h75 » sont hors bornes, pas des heures', () => {
    expect(time('à 25h')).toBe('TIME_OUT_OF_RANGE');
    expect(time('à 14h75')).toBe('TIME_OUT_OF_RANGE');
  });

  it('« 32 janvier » n’existe pas', () => {
    expect(date('le 32 janvier')).toBe('DATE_OUT_OF_RANGE');
  });
});

describe('§7 — un nombre nu n’est jamais une heure', () => {
  it('« j’ai 3 salariés et 2 camions » ne désigne aucun moment', () => {
    expect(date('j’ai 3 salariés et 2 camions')).toBe('ABSENT');
    expect(time('j’ai 3 salariés et 2 camions')).toBe('ABSENT');
  });

  it('« ça me va » ne désigne aucun moment', () => {
    expect(date('ça me va')).toBe('ABSENT');
    expect(time('ça me va')).toBe('ABSENT');
  });

  it('un prix ne devient pas une heure', () => {
    expect(time('tu prends combien, 300 € par mois ?')).toBe('ABSENT');
  });
});

describe('§9 — le temps relatif se lit contre `now`, jamais contre l’horloge réelle', () => {
  it('« demain » suit le jour LOCAL, pas le jour UTC', () => {
    // 23 h 30 à Paris le 24 août = 21 h 30 UTC. « demain » = le 25.
    const lateEvening = new Date('2026-08-24T21:30:00.000Z');
    const reading = readTemporal('demain à 15h', lateEvening, TEST_TZ);
    expect(reading.date.kind === 'RESOLVED' && reading.date.date.day).toBe(25);
  });

  it('un instant juste APRÈS minuit local change de jour', () => {
    // 00 h 30 à Paris le 25 août = 22 h 30 UTC le 24.
    const justAfterMidnight = new Date('2026-08-24T22:30:00.000Z');
    const reading = readTemporal('demain à 15h', justAfterMidnight, TEST_TZ);
    expect(reading.date.kind === 'RESOLVED' && reading.date.date.day).toBe(26);
  });

  it('une date sans année déjà passée bascule sur l’année suivante', () => {
    const reading = readTemporal('le 3 janvier à 10h', NOW, TEST_TZ);
    expect(reading.date.kind === 'RESOLVED' && reading.date.date.year).toBe(2027);
  });
});

describe('§9 — l’instant, et le changement d’heure', () => {
  it('15 h à Paris en août vaut 13 h UTC', () => {
    expect(instantOf({ year: 2026, month: 8, day: 26 }, 15 * 60, TEST_TZ)?.toISOString()).toBe(
      '2026-08-26T13:00:00.000Z',
    );
  });

  it('15 h à Paris en décembre vaut 14 h UTC', () => {
    expect(instantOf({ year: 2026, month: 12, day: 2 }, 15 * 60, TEST_TZ)?.toISOString()).toBe(
      '2026-12-02T14:00:00.000Z',
    );
  });

  it('une heure SAUTÉE par le passage à l’heure d’été est REFUSÉE, pas substituée', () => {
    // 29 mars 2026 : l'horloge passe de 02 h 00 à 03 h 00. 02 h 30 n'existe pas.
    // Le point fixe rend un instant qui vaut 01 h 30 locale — donc PAS ce qui a
    // été demandé. Substituer inscrirait 01 h 30 dans l'agenda en annonçant
    // 02 h 30 ; on rend `null`, et l'appelant demande une précision.
    expect(instantOf({ year: 2026, month: 3, day: 29 }, 2 * 60 + 30, TEST_TZ)).toBeNull();
  });

  it('l’heure juste APRÈS le saut existe, et elle est rendue', () => {
    expect(instantOf({ year: 2026, month: 3, day: 29 }, 3 * 60, TEST_TZ)?.toISOString()).toBe(
      '2026-03-29T01:00:00.000Z',
    );
  });

  it('l’heure juste AVANT le saut existe aussi', () => {
    expect(instantOf({ year: 2026, month: 3, day: 29 }, 60, TEST_TZ)?.toISOString()).toBe(
      '2026-03-29T00:00:00.000Z',
    );
  });
});

describe('§6 — ce que NOTRE texte mentionne, pour la garde anti-invention', () => {
  it('« mercredi 15h ou jeudi 11h » est lu comme DEUX créneaux appariés', () => {
    const slots = mentionedSlots('mercredi à 15h ou jeudi vers 11h ?', NOW, TEST_TZ);
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({ minuteOfDay: 15 * 60 });
    expect(slots[0]!.date.day).toBe(26);
    expect(slots[1]).toMatchObject({ minuteOfDay: 11 * 60 });
    expect(slots[1]!.date.day).toBe(27);
  });

  it('le produit CROISÉ est distingué de l’original', () => {
    const crossed = mentionedSlots('mercredi à 11h ou jeudi vers 15h ?', NOW, TEST_TZ);
    expect(crossed[0]).toMatchObject({ minuteOfDay: 11 * 60 });
    expect(crossed[0]!.date.day).toBe(26);
  });

  it('une heure sans date est vue par `mentionedTimes` et pas par `mentionedSlots`', () => {
    expect(mentionedTimes('c’est calé pour 15h')).toEqual([15 * 60]);
    expect(mentionedSlots('c’est calé pour 15h', NOW, TEST_TZ)).toHaveLength(0);
  });

  it('« jeudi à 11h » écrit dans l’autre ordre est apparié quand même', () => {
    const slots = mentionedSlots('à 11h jeudi ?', NOW, TEST_TZ);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ minuteOfDay: 11 * 60 });
  });
});
