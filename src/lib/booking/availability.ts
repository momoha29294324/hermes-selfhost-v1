/**
 * HERMES-NATIVE-BOOKING-R1 §2/§3 — le MOTEUR DE DISPONIBILITÉ.
 *
 * Il répond à deux questions, et à aucune autre :
 *
 *     « cet INTERVALLE est-il réservable ? »
 *     « quels sont les N prochains intervalles réservables ? »
 *
 * ---------------------------------------------------------------------------
 * Ce qu'il n'est pas
 * ---------------------------------------------------------------------------
 * Il ne lit rien, n'écrit rien, n'appelle aucun modèle et n'importe ni base ni
 * provider. Sa clôture d'imports est `@/lib/time/zoned` et le type de la
 * configuration — c'est ce qui rend vérifiable qu'aucun créneau ne peut être
 * INVENTÉ par un modèle : le seul endroit du dépôt qui sait dire « mercredi
 * 15 h est libre » est ce fichier, et il ne parle pas.
 *
 * Les rendez-vous DÉJÀ pris lui sont passés en paramètre (`busy`). Il ne va pas
 * les chercher : la lecture appartient au store, la décision appartient ici, et
 * la garantie d'unicité appartient à la contrainte d'exclusion de 0061. Trois
 * couches, trois responsabilités, et la plus basse est celle qui tient — un
 * moteur pur ne peut RIEN garantir contre la concurrence, et prétendre le
 * contraire serait la faute que §5 de la mission nomme.
 *
 * ---------------------------------------------------------------------------
 * L'intervalle ENTIER, jamais l'heure de début
 * ---------------------------------------------------------------------------
 * §3 : la disponibilité se calcule sur `[startsAt, endsAt)`. Un rendez-vous de
 * trente minutes commencé à 19 h 50 dans une fenêtre qui ferme à 20 h n'est pas
 * disponible, même si 19 h 50 l'est. Le contrôle est donc fait minute par
 * fenêtre sur toute la durée, en heure LOCALE — ce qui traverse correctement
 * minuit et les changements d'heure, parce que `zonedParts` les connaît.
 *
 * ---------------------------------------------------------------------------
 * Fail-closed
 * ---------------------------------------------------------------------------
 * Tout refus est nommé, et le défaut est le refus : une durée nulle, un
 * instant illisible, un horizon dépassé, un préavis non tenu, un chevauchement,
 * une fenêtre absente. Aucun code ne rend « disponible » par omission.
 */

import type { BookingPolicyConfig } from '@/lib/config/schema';
import { zonedParts } from '@/lib/time/zoned';

/** Un intervalle fermé à gauche, ouvert à droite. La même convention que 0061. */
export interface Interval {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/** Pourquoi un créneau est refusé. Des codes, jamais des phrases libres. */
export type AvailabilityRefusal =
  /** L'intervalle est mal formé (fin ≤ début, instant illisible). */
  | 'INTERVAL_INVALID'
  /** Le créneau commence maintenant ou avant. §10, invariant dur. */
  | 'IN_THE_PAST'
  /** Le créneau est trop proche : le préavis minimal n'est pas tenu. */
  | 'NOTICE_TOO_SHORT'
  /** Le créneau est au-delà de l'horizon qu'on accepte de fixer. */
  | 'BEYOND_HORIZON'
  /** Une partie de l'intervalle tombe hors des fenêtres hebdomadaires. */
  | 'OUTSIDE_AVAILABILITY'
  /** Une partie de l'intervalle tombe dans une indisponibilité déclarée. */
  | 'BLACKED_OUT'
  /** Un rendez-vous confirmé occupe déjà tout ou partie de l'intervalle. */
  | 'ALREADY_BOOKED';

export type AvailabilityVerdict =
  | { readonly available: true; readonly interval: Interval }
  | { readonly available: false; readonly refusal: AvailabilityRefusal; readonly detail: string };

const MINUTE_MS = 60_000;

function frozenRefusal(refusal: AvailabilityRefusal, detail: string): AvailabilityVerdict {
  return Object.freeze({ available: false as const, refusal, detail });
}

/**
 * L'intervalle qu'un début produit, à la durée de la politique.
 *
 * Une fonction plutôt qu'une addition recopiée : la durée est la valeur que §3
 * de la mission demande de ne PAS disperser, et un seul endroit sait la lire.
 */
export function intervalFor(startsAt: Date, policy: BookingPolicyConfig): Interval {
  return Object.freeze({
    startsAt,
    endsAt: new Date(startsAt.getTime() + policy.appointmentDurationMinutes * MINUTE_MS),
  });
}

/**
 * Cette MINUTE locale tombe-t-elle dans une fenêtre hebdomadaire ?
 *
 * Lue en heure locale du fuseau de la politique, jour ISO compris. C'est le
 * seul endroit où une fenêtre est interprétée, et il ne connaît aucune
 * géographie : le fuseau est une chaîne IANA passée telle quelle à `Intl`.
 */
function minuteIsOpen(instant: Date, policy: BookingPolicyConfig): boolean {
  const local = zonedParts(instant, policy.timezone);
  return policy.weeklyWindows.some(
    (window) =>
      window.days.includes(local.isoWeekday) &&
      local.minuteOfDay >= window.startMinute &&
      local.minuteOfDay < window.endMinute,
  );
}

/**
 * Toutes les minutes de l'intervalle sont-elles ouvertes ?
 *
 * Le balayage est minute par minute plutôt que « début et fin » : une fenêtre
 * qui ferme à midi et rouvre à 14 h laisserait passer un rendez-vous de 11 h 45
 * à 14 h 15 si l'on ne regardait que les deux bouts. Le coût est borné par la
 * durée du rendez-vous (au plus 480 minutes par le schéma), donc négligeable,
 * et la propriété obtenue est exacte plutôt qu'approchée.
 *
 * La dernière minute n'est pas testée : l'intervalle est ouvert à droite, et
 * exiger que la minute de FIN soit ouverte refuserait un rendez-vous qui se
 * termine pile à la fermeture — c'est-à-dire le cas nominal.
 */
function windowCoversInterval(interval: Interval, policy: BookingPolicyConfig): boolean {
  for (let t = interval.startsAt.getTime(); t < interval.endsAt.getTime(); t += MINUTE_MS) {
    if (!minuteIsOpen(new Date(t), policy)) return false;
  }
  return true;
}

/** Deux intervalles se chevauchent-ils ? Convention `[début, fin)`, comme 0061. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime();
}

export interface AvailabilityInput {
  readonly policy: BookingPolicyConfig;
  readonly now: Date;
  /** Les rendez-vous CONFIRMÉS déjà connus. Lus ailleurs, jamais ici. */
  readonly busy: readonly Interval[];
}

/**
 * Ce créneau est-il réservable ?
 *
 * L'ordre des portes est celui du coût et de la dureté : ce qui est faux par
 * construction d'abord (intervalle mal formé), ce qui est faux quoi qu'il
 * arrive ensuite (le passé, §10), puis les bornes de politique, puis les
 * fenêtres, puis l'occupation.
 *
 * `IN_THE_PAST` est séparé de `NOTICE_TOO_SHORT` bien que le second implique
 * presque toujours le premier : un opérateur qui lit « préavis trop court »
 * sait qu'il peut baisser une borne, là où « dans le passé » ne se règle par
 * aucune configuration.
 */
export function checkAvailability(
  interval: Interval,
  input: AvailabilityInput,
): AvailabilityVerdict {
  const { policy, now } = input;
  const start = interval.startsAt.getTime();
  const end = interval.endsAt.getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return frozenRefusal('INTERVAL_INVALID', 'intervalle mal formé : la fin doit suivre le début');
  }

  // §10 — invariant dur. Un créneau qui commence maintenant ou avant n'est pas
  // un rendez-vous à venir.
  if (start <= now.getTime()) {
    return frozenRefusal('IN_THE_PAST', `${interval.startsAt.toISOString()} est déjà passé`);
  }

  const noticeMs = policy.minNoticeMinutes * MINUTE_MS;
  if (start - now.getTime() < noticeMs) {
    return frozenRefusal(
      'NOTICE_TOO_SHORT',
      `moins de ${policy.minNoticeMinutes} min de préavis avant ${interval.startsAt.toISOString()}`,
    );
  }

  const horizonMs = policy.maxHorizonDays * 24 * 60 * MINUTE_MS;
  if (start - now.getTime() > horizonMs) {
    return frozenRefusal(
      'BEYOND_HORIZON',
      `au-delà de l'horizon de ${policy.maxHorizonDays} jours`,
    );
  }

  if (!windowCoversInterval(interval, policy)) {
    return frozenRefusal(
      'OUTSIDE_AVAILABILITY',
      `l'intervalle sort des fenêtres déclarées (${policy.timezone})`,
    );
  }

  for (const blackout of policy.blackouts) {
    const span: Interval = {
      startsAt: new Date(blackout.startsAt),
      endsAt: new Date(blackout.endsAt),
    };
    if (!Number.isFinite(span.startsAt.getTime()) || !Number.isFinite(span.endsAt.getTime())) {
      // Fail-closed : une indisponibilité illisible refuse tout, plutôt que de
      // s'effacer silencieusement. Une ligne mal saisie ne doit pas ouvrir un
      // agenda que quelqu'un croyait fermé.
      return frozenRefusal('BLACKED_OUT', 'indisponibilité déclarée illisible — refus par défaut');
    }
    if (overlaps(interval, span)) {
      return frozenRefusal(
        'BLACKED_OUT',
        `indisponibilité déclarée${blackout.reason === undefined ? '' : ` (${blackout.reason})`}`,
      );
    }
  }

  for (const taken of input.busy) {
    if (overlaps(interval, taken)) {
      return frozenRefusal(
        'ALREADY_BOOKED',
        `chevauche un rendez-vous confirmé (${taken.startsAt.toISOString()})`,
      );
    }
  }

  return Object.freeze({ available: true as const, interval: Object.freeze(interval) });
}

/**
 * Les N prochains créneaux réservables.
 *
 * Le balayage part du premier instant qui tient le préavis, ARRONDI EN AVANT au
 * pas de la grille locale — jamais en arrière, ce qui produirait un créneau
 * trop proche. La grille est locale au fuseau (minutes depuis minuit), pas
 * absolue : sur un pas de 30 minutes, on propose 14 h 00 et 14 h 30 heure de
 * Paris, et non 14 h 07 parce que l'époque Unix tombait ainsi.
 *
 * Deux protections contre la boucle infinie, toutes deux nécessaires : la borne
 * d'horizon (la seule qui compte métier) et un plafond d'itérations (le filet,
 * pour qu'une configuration absurde s'arrête au lieu de tourner).
 *
 * Rend une liste éventuellement VIDE. Un agenda plein est une réponse, et
 * fabriquer un créneau pour ne pas rendre le tableau vide serait exactement la
 * faute que §6 de la mission interdit.
 */
export function nextAvailableSlots(
  input: AvailabilityInput,
  count: number,
): readonly Interval[] {
  const { policy, now } = input;
  if (count <= 0) return Object.freeze([]);

  const step = policy.slotGranularityMinutes * MINUTE_MS;
  const earliest = now.getTime() + policy.minNoticeMinutes * MINUTE_MS;
  const horizon = now.getTime() + policy.maxHorizonDays * 24 * 60 * MINUTE_MS;

  // L'arrondi se fait sur l'horloge LOCALE : on lit la minute du jour au plus
  // tôt possible, on la remonte au multiple suivant du pas, et on ajoute la
  // différence à l'instant. Passer par `zonedWallClockToUtc` serait plus direct
  // mais changerait de jour au mauvais moment lors d'un changement d'heure ;
  // ajouter un delta de minutes à un instant est exact partout.
  const localAtEarliest = zonedParts(new Date(earliest), policy.timezone);
  const remainder = localAtEarliest.minuteOfDay % policy.slotGranularityMinutes;
  const alignment = remainder === 0 ? 0 : (policy.slotGranularityMinutes - remainder) * MINUTE_MS;
  let cursor = earliest + alignment;
  // L'arrondi peut avoir laissé des secondes ou des millisecondes du `now`
  // d'origine. Les retirer rend les créneaux proposés lisibles (« 15:00 » et
  // non « 15:00:37,412 ») et déterministes.
  cursor -= cursor % MINUTE_MS;

  const found: Interval[] = [];
  const maxIterations = 20_000;
  for (let i = 0; i < maxIterations && cursor <= horizon && found.length < count; i += 1) {
    const candidate = intervalFor(new Date(cursor), policy);
    const verdict = checkAvailability(candidate, input);
    if (verdict.available) found.push(verdict.interval);
    cursor += step;
  }

  return Object.freeze(found);
}
