/**
 * L'HORLOGE MURALE d'un fuseau, et son inverse. Une seule implémentation.
 *
 * Ce module ne contient rien de neuf : il EXTRAIT `zonedParts` et
 * `zonedWallClockToUtc` de `instagram/scheduler.ts`, où ils vivaient depuis
 * IG3, sans changer une ligne de leur comportement.
 *
 * L'extraction a une raison précise et une seule. L'ordonnanceur importe la
 * base, les plafonds et la table de sûreté ; le moteur de disponibilité de
 * HERMES-NATIVE-BOOKING-R1 doit rester PUR — aucune lecture, aucun effet, aucun
 * import de provider — pour que sa clôture d'imports prouve ce que sa
 * documentation affirme. Recopier les deux fonctions aurait produit une seconde
 * arithmétique du temps, et deux arithmétiques du temps divergent toujours sur
 * la même chose : le jour du changement d'heure.
 *
 * `scheduler.ts` les réexporte, si bien qu'aucun appelant existant ne change.
 */

export interface ZonedParts {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  readonly day: number;
  /** ISO : 1 = lundi … 7 = dimanche, comme `config.schedule.windows[].days`. */
  readonly isoWeekday: number;
  /** Minutes depuis minuit local. */
  readonly minuteOfDay: number;
}

const WEEKDAY_TO_ISO: Readonly<Record<string, number>> = Object.freeze({
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
});

/**
 * Le seul endroit du dépôt qui traduit un instant en heure locale.
 *
 * `Intl.DateTimeFormat` plutôt qu'un décalage stocké : un décalage fixe se
 * trompe deux fois par an, et se tromperait précisément le jour où une fenêtre
 * compte le plus. `Intl` connaît la base tzdata du système et gère l'heure
 * d'été sans que ce fichier ait à savoir qu'elle existe.
 *
 * Le formateur est mémoïsé par fuseau : le construire coûte cher, et les
 * appelants l'appellent en boucle quand ils cherchent la prochaine ouverture.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  formatterCache.set(timezone, created);
  return created;
}

export function zonedParts(instant: Date, timezone: string): ZonedParts {
  const parts = formatterFor(timezone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';

  const isoWeekday = WEEKDAY_TO_ISO[read('weekday')];
  if (isoWeekday === undefined) {
    // Un fuseau invalide fait lever `Intl` avant d'arriver ici ; ce refus couvre
    // le cas d'un environnement dont la locale rendrait un jour inconnu. Deviner
    // « lundi » ouvrirait une fenêtre que personne n'a décidée.
    throw new Error(`fuseau « ${timezone} » : jour de semaine illisible (« ${read('weekday')} »)`);
  }

  // `Intl` rend « 24 » pour minuit dans certaines locales en hour12:false.
  const hour = Number.parseInt(read('hour'), 10) % 24;

  return Object.freeze({
    year: Number.parseInt(read('year'), 10),
    month: Number.parseInt(read('month'), 10),
    day: Number.parseInt(read('day'), 10),
    isoWeekday,
    minuteOfDay: hour * 60 + Number.parseInt(read('minute'), 10),
  });
}

/**
 * L'opération inverse : l'instant UTC auquel l'horloge murale du fuseau
 * affiche cette date et cette minute.
 *
 * Il n'existe pas de primitive standard pour cela, d'où le point fixe : on
 * suppose d'abord que l'horloge murale EST de l'UTC, on mesure l'écart réel à
 * cet instant, on corrige, et on recommence. Deux itérations suffisent partout
 * (la seconde ne sert qu'aux instants situés juste au bord d'un changement
 * d'heure, où l'écart mesuré au premier essai est celui de l'ancien régime).
 *
 * Aux heures « sautées » d'un passage à l'heure d'été (02:30 le dernier
 * dimanche de mars en Europe), aucune réponse n'est exacte : le point fixe rend
 * alors l'instant immédiatement après le saut, c'est-à-dire la première
 * milliseconde où la minute demandée existe réellement. C'est le comportement
 * souhaitable pour une OUVERTURE de fenêtre — on n'ouvre jamais plus tôt que
 * demandé — et c'est celui dont HERMES-NATIVE-BOOKING-R1 a besoin : un créneau
 * demandé à une heure qui n'existe pas ne peut pas commencer avant qu'elle
 * n'existe.
 */
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timezone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, 0, minuteOfDay, 0, 0);
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const seen = zonedParts(new Date(guess), timezone);
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, 0, seen.minuteOfDay, 0, 0);
    const offset = seenAsUtc - guess;
    const next = wall - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}
