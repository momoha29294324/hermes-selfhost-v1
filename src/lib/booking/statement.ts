/**
 * HERMES-NATIVE-BOOKING-R1 §6/§11/§12 — ce qu'un texte a le DROIT d'affirmer
 * d'un rendez-vous.
 *
 * ---------------------------------------------------------------------------
 * La propriété que ce fichier tient
 * ---------------------------------------------------------------------------
 * §11, en toutes lettres : « Hermes ne dit jamais "c'est réservé" » quand ça ne
 * l'est pas. C'est la seule affirmation de tout ce round qui, si elle était
 * fausse, coûterait quelque chose à un vrai commerçant — il bloquerait une
 * demi-heure de sa journée pour un rendez-vous qui n'existe nulle part.
 *
 * Une consigne de prompt ne peut pas la tenir : un modèle à qui l'on montre un
 * créneau libre écrira « c'est noté » une fois sur cinquante, et les
 * quarante-neuf autres fois ne prouvent rien. La garde est donc du CODE, elle
 * relit le texte ÉCRIT, et elle est branchée là où les garde-fous du dépôt le
 * sont déjà — `evaluateConversationDraft`, dont le verdict `blocked` empêche
 * l'envoi.
 *
 * Quatre constats, tous BLOQUANTS, et chacun ferme une manière différente de
 * mentir :
 *
 *   * `booking_claim_without_reservation` — le texte confirme, rien n'est
 *     réservé. Le mensonge direct ;
 *   * `booking_confirmation_missing` — un rendez-vous a été RÉSERVÉ et le texte
 *     ne le dit pas. Le silence coûteux : le créneau est pris dans l'agenda et
 *     la personne ne le sait pas ;
 *   * `booking_slot_mismatch` — le texte nomme un créneau différent de celui
 *     qui est réservé. Les deux parties ne parlent pas du même rendez-vous ;
 *   * `booking_slot_not_offered` — le texte nomme un créneau que le moteur n'a
 *     jamais rendu. C'est §6 : les créneaux viennent de l'agenda, jamais du
 *     modèle.
 *
 * ---------------------------------------------------------------------------
 * Ce que la garde ne fait PAS
 * ---------------------------------------------------------------------------
 * Elle ne juge ni le style, ni la politesse, ni la longueur — `checkNaturalness`
 * s'en charge et n'a pas bougé. Elle ne lit pas le message du prospect : les
 * dates qu'IL écrit ne sont pas des affirmations que NOUS faisons.
 */

import type { Interval } from '@/lib/booking/availability';
import type { Appointment } from '@/lib/booking/store';
import {
  calendarDateOf,
  mentionedSlots,
  mentionedTimes,
  minuteOfDayOf,
  sameCalendarDate,
} from '@/lib/booking/temporal';
import type { GuardrailFlag } from '@/lib/pipeline/guardrails';

/**
 * Les tournures par lesquelles un texte AFFIRME qu'un rendez-vous est pris.
 *
 * Tutoiement et vouvoiement ensemble, dès l'écriture. C'est le trou que
 * `detectPerformanceClaims` et `UNSUBSCRIBE_PATTERNS` ont porté chacun leur
 * tour — un lexique écrit au vouvoiement devenu aveugle le jour où Hermes a
 * appris à tutoyer — et il ne sert à rien de le rouvrir une troisième fois.
 *
 * Le texte est comparé accents retirés : `\b` est ASCII en JavaScript.
 */
const STRONG_CLAIM_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bc'?est\s+(reserve|bloque|cale|confirme)\b/u,
  /\bje\s+(te|vous)\s+(l'?ai\s+)?(reserve|bloque|cale|confirme)\b/u,
  /\bje\s+(bloque|reserve|cale)\b/u,
  /\bj'?ai\s+(reserve|bloque|cale)\b/u,
  /\brendez-?\s?vous\s+(reserve|confirme|pris|note|enregistre)\b/u,
  /\bcreneau\s+(reserve|confirme|bloque|pris)\b/u,
]);

/**
 * Les tournures qui n'affirment une réservation QUE si un créneau est nommé.
 *
 * « C'est noté » est, dans neuf conversations sur dix, un simple « j'ai
 * compris » — et le traiter comme une confirmation de rendez-vous ferait
 * bloquer des tours parfaitement ordinaires. « C'est noté pour mercredi
 * 15 h », en revanche, est une confirmation sur laquelle la personne va
 * organiser sa journée.
 *
 * La distinction n'est donc pas dans le verbe, elle est dans la présence d'un
 * CRÉNEAU ou d'un mot de rendez-vous. C'est le même raffinement que
 * `resolvePriceSubject` a apporté à la demande de prix : une garde qui refuse
 * trop finit par être desserrée en bloc, ce qui coûte plus cher que de la
 * poser juste.
 */
const WEAK_CLAIM_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bc'?est\s+(note|valide|enregistre)\b/u,
  /\bje\s+(te|vous)\s+(l'?ai\s+)?note\b/u,
  /\bje\s+note\b/u,
  /\bj'?ai\s+note\b/u,
  /\bon\s+est\s+(cale|bon)\b/u,
  /\bnote\s+pour\b/u,
]);

/** Les mots qui font d'une phrase une phrase de rendez-vous. */
const APPOINTMENT_NOUN = /\b(rendez-?\s?vous|rdv|creneau|appel)\b/u;

function normalizeForMatching(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/[‘’ʼ]/gu, "'")
    .toLowerCase();
}

/** Ce texte affirme-t-il qu'un rendez-vous est pris ? */
export function claimsReservation(body: string): boolean {
  const normalized = normalizeForMatching(body);
  if (STRONG_CLAIM_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  if (!WEAK_CLAIM_PATTERNS.some((pattern) => pattern.test(normalized))) return false;
  return APPOINTMENT_NOUN.test(normalized) || mentionedTimes(body).length > 0;
}

export interface BookingStatementContext {
  /** Le rendez-vous réellement écrit à ce tour, ou `null` s'il n'y en a pas. */
  readonly booked: Appointment | null;
  /**
   * Les créneaux que le runtime a CALCULÉS pour ce tour — proposition ou
   * alternatives. Le texte n'a le droit d'en nommer aucun autre.
   *
   * Vide sur un tour sans agenda : la garde des créneaux ne s'applique alors
   * pas, et seule celle de l'affirmation reste active — elle, toujours.
   */
  readonly offered: readonly Interval[];
  readonly timezone: string;
  /** L'horloge, paramètre et jamais lecture — « demain » se lit contre elle. */
  readonly now: Date;
  /**
   * Ce tour vient-il d'ÉCRIRE ce rendez-vous ?
   *
   * Sépare deux devoirs qu'on confondrait sinon. Un rendez-vous écrit à ce tour
   * DOIT être nommé — sinon le créneau est pris dans l'agenda et la personne ne
   * le sait pas. Un rendez-vous qui existait déjà autorise seulement qu'on en
   * parle : exiger qu'il soit nommé à chaque tour transformerait chaque message
   * suivant en rappel de rendez-vous.
   */
  readonly writtenThisTurn?: boolean;
}

function flag(code: string, message: string, excerpt: string | null = null): GuardrailFlag {
  return excerpt === null
    ? { code, message, blocking: true }
    : { code, message, blocking: true, excerpt };
}

/**
 * Relit ce que le modèle vient d'écrire, et refuse ce qu'il n'avait pas le
 * droit d'affirmer.
 *
 * L'ordre des constats va du plus grave au plus circonstanciel, et ils
 * s'additionnent : un texte peut à la fois confirmer sans réservation et nommer
 * un créneau inventé, et un opérateur qui relit doit voir les deux.
 */
export function checkBookingStatement(
  body: string,
  context: BookingStatementContext,
): GuardrailFlag[] {
  const flags: GuardrailFlag[] = [];
  const { booked, timezone, now } = context;

  // ---- 1. Confirmer sans avoir réservé ------------------------------------
  if (booked === null && claimsReservation(body)) {
    flags.push(
      flag(
        'booking_claim_without_reservation',
        'le texte affirme qu’un rendez-vous est pris alors qu’aucun n’a été écrit en base',
      ),
    );
  }

  // ---- 2. Réserver sans le dire -------------------------------------------
  if (booked !== null) {
    const bookedStart = new Date(booked.startsAt);
    const bookedMinute = minuteOfDayOf(bookedStart, timezone);
    const bookedDate = calendarDateOf(bookedStart, timezone);

    const times = mentionedTimes(body);
    if (context.writtenThisTurn === true && !times.includes(bookedMinute)) {
      flags.push(
        flag(
          'booking_confirmation_missing',
          `un rendez-vous a été réservé (${booked.startsAt}) et le texte ne nomme pas son heure — ` +
            'le créneau est pris dans l’agenda et la personne ne le sait pas',
        ),
      );
    }

    // ---- 3. Nommer un AUTRE créneau que celui qui est réservé --------------
    //
    // Une date mentionnée qui n'est pas celle du rendez-vous est un désaccord
    // entre ce que la base porte et ce que la personne va lire. L'heure seule
    // (« c'est calé pour 15h ») ne déclenche rien : elle est vraie.
    for (const mention of mentionedSlots(body, now, timezone)) {
      if (!sameCalendarDate(mention.date, bookedDate) || mention.minuteOfDay !== bookedMinute) {
        flags.push(
          flag(
            'booking_slot_mismatch',
            `le texte nomme un créneau qui n’est pas celui réservé (${booked.startsAt})`,
            mention.excerpt,
          ),
        );
      }
    }
  }

  // ---- 4. Inventer un créneau ---------------------------------------------
  //
  // §6 — les créneaux viennent du moteur de disponibilité. L'ensemble autorisé
  // est celui que le runtime a calculé pour CE tour, plus, s'il existe, le
  // rendez-vous réservé. Un texte qui ne nomme aucun créneau ne déclenche rien.
  const allowed: Interval[] = [...context.offered];
  if (booked !== null) {
    allowed.push({ startsAt: new Date(booked.startsAt), endsAt: new Date(booked.endsAt) });
  }
  if (allowed.length > 0) {
    const allowedSlots = allowed.map((slot) => ({
      date: calendarDateOf(slot.startsAt, timezone),
      minuteOfDay: minuteOfDayOf(slot.startsAt, timezone),
    }));
    for (const mention of mentionedSlots(body, now, timezone)) {
      const known = allowedSlots.some(
        (slot) =>
          sameCalendarDate(slot.date, mention.date) && slot.minuteOfDay === mention.minuteOfDay,
      );
      if (!known) {
        flags.push(
          flag(
            'booking_slot_not_offered',
            'le texte propose un créneau que le moteur de disponibilité n’a pas rendu — ' +
              'un créneau ne s’invente pas',
            mention.excerpt,
          ),
        );
      }
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// L'écriture d'un créneau, en français
// ---------------------------------------------------------------------------

const SLOT_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function slotFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = SLOT_FORMATTERS.get(timezone);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat('fr-FR', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  SLOT_FORMATTERS.set(timezone, created);
  return created;
}

/**
 * « mercredi 26 août à 15h00 » — la forme que le PROMPT reçoit.
 *
 * Rendue par `Intl` en français plutôt que par une table de noms de jours
 * écrite ici : le dépôt refuse la géographie et le vocabulaire en dur, et
 * `Intl` connaît déjà les deux.
 *
 * Ce n'est pas la phrase que le modèle recopiera — il écrira « mercredi à 15h »
 * s'il trouve cela plus naturel, et il en a le droit. Ce qui est vérifié
 * ensuite n'est pas la chaîne, c'est le CRÉNEAU qu'elle désigne
 * (`checkBookingStatement`), ce qui laisse le style libre sans laisser la date
 * libre.
 */
export function formatSlot(interval: Interval, timezone: string): string {
  const parts = slotFormatter(timezone).formatToParts(interval.startsAt);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${read('weekday')} ${read('day')} ${read('month')} à ${read('hour')}h${read('minute')}`;
}

// ---------------------------------------------------------------------------
// La durée ANNONCÉE — deux formes, une seule source
// ---------------------------------------------------------------------------

/**
 * Ce qu'on dit de la durée, en prose : « 20 à 25 minutes ».
 *
 * Destinée au PROMPT. Le français parlé dit « de 20 à 25 minutes », pas
 * « 20–25 minutes » — un tiret dans un DM sonne comme une fiche produit.
 *
 * Quand les deux bornes coïncident, aucune fausse fourchette n'est écrite :
 * « 25 minutes », et rien d'autre.
 */
export function presentedDurationSentence(policy: {
  readonly presentedDuration: { readonly minMinutes: number; readonly maxMinutes: number };
}): string {
  const { minMinutes, maxMinutes } = policy.presentedDuration;
  return minMinutes === maxMinutes
    ? `${String(maxMinutes)} minutes`
    : `${String(minMinutes)} à ${String(maxMinutes)} minutes`;
}

/**
 * La même chose en compact : « 20–25 min ».
 *
 * Destinée au CRM, où la place est comptée. Dérivée des MÊMES deux nombres que
 * la forme en prose : deux fonctions, une seule source, donc aucune dérive
 * possible entre ce qu'un prospect lit et ce qu'un opérateur lit.
 */
export function presentedDurationLabel(policy: {
  readonly presentedDuration: { readonly minMinutes: number; readonly maxMinutes: number };
}): string {
  const { minMinutes, maxMinutes } = policy.presentedDuration;
  return minMinutes === maxMinutes
    ? `${String(maxMinutes)} min`
    : `${String(minMinutes)}–${String(maxMinutes)} min`;
}
