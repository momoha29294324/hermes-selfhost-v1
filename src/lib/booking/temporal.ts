/**
 * HERMES-NATIVE-BOOKING-R1 §7/§8/§9 — « mercredi à 18 h » devient un INSTANT,
 * ou ne devient rien.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi c'est du CODE et pas un prompt
 * ---------------------------------------------------------------------------
 * Le dépôt tient depuis R6B que « toute logique déterministe reste du code
 * testé, jamais un prompt ». Une date en est une : elle a une réponse exacte,
 * elle se rejoue, et elle décide d'un fait extérieur — un rendez-vous inscrit
 * dans l'agenda d'un vrai commerçant. Demander à un modèle de calculer « le
 * prochain mercredi » ferait dépendre cette inscription de son humeur, et le
 * jour où il se tromperait d'une semaine, rien dans le dépôt ne le verrait.
 *
 * Le modèle garde ce qu'il fait mieux que n'importe quel lexique : dire si la
 * personne ACCEPTE, CONTRE-PROPOSE, DÉCALE ou ANNULE (`intent.ts`). Il ne dit
 * jamais quel jour on est.
 *
 * ---------------------------------------------------------------------------
 * Fail-closed, et le mot a un sens précis ici
 * ---------------------------------------------------------------------------
 * Ce module ne rend un instant QUE lorsqu'une seule lecture sûre existe. Tout
 * le reste porte un refus NOMMÉ, et un refus n'est jamais une panne : c'est la
 * matière d'une question de clarification. Les cinq classes que §8 de la
 * mission nomme sont toutes représentées, plus celles que la lecture réelle a
 * fait apparaître :
 *
 *     « mercredi »               → TIME_MISSING
 *     « vers 3h »                → MERIDIEM_AMBIGUOUS
 *     « le 12 »                  → MONTH_AMBIGUOUS
 *     « demain en fin de journée » → VAGUE_PERIOD
 *     « mercredi ou jeudi »      → MULTIPLE_CANDIDATES
 *     « mercredi » un mercredi   → WEEKDAY_TODAY_AMBIGUOUS
 *     « mercredi prochain »      → NEXT_OCCURRENCE_AMBIGUOUS
 *
 * Aucune de ces lectures ne devient un rendez-vous. Une seule réserve.
 *
 * ---------------------------------------------------------------------------
 * L'horloge est un PARAMÈTRE
 * ---------------------------------------------------------------------------
 * §9 : aucun `new Date()` n'est appelé ici, et aucun fuseau n'est écrit en dur.
 * « demain » est fonction de `now` et de `timezone`, et de rien d'autre — c'est
 * ce qui rend les tests déterministes le 3 janvier comme le 31 décembre, à
 * 23 h 59 comme à midi.
 */

import { zonedParts, zonedWallClockToUtc } from '@/lib/time/zoned';

/** Pourquoi une expression de temps ne devient pas un instant. */
export type TemporalRefusal =
  /** Une date est là, aucune heure ne l'est. */
  | 'TIME_MISSING'
  /** Une heure est là, aucune date ne l'est. */
  | 'DATE_MISSING'
  /** 1 h – 6 h sans « du matin » ni « du soir » : deux lectures possibles. */
  | 'MERIDIEM_AMBIGUOUS'
  /** « le 12 » : le mois n'est pas dit. */
  | 'MONTH_AMBIGUOUS'
  /** « en fin de journée », « la semaine prochaine » : trop large pour un créneau. */
  | 'VAGUE_PERIOD'
  /** Deux dates ou deux heures distinctes dans la même phrase. */
  | 'MULTIPLE_CANDIDATES'
  /** « mercredi », dit un mercredi : aujourd'hui ou dans sept jours ? */
  | 'WEEKDAY_TODAY_AMBIGUOUS'
  /** « mercredi prochain » : celui qui vient, ou celui de la semaine d'après ? */
  | 'NEXT_OCCURRENCE_AMBIGUOUS'
  /** « 25h », « 14h75 » : lisible comme heure, mais impossible. */
  | 'TIME_OUT_OF_RANGE'
  /** « 32 janvier » : lisible comme date, mais impossible. */
  | 'DATE_OUT_OF_RANGE'
  /**
   * L'heure murale demandée N'EXISTE PAS ce jour-là.
   *
   * Une seule cause réelle : la nuit du passage à l'heure d'été, où l'horloge
   * saute de 02 h 00 à 03 h 00 et où « 02 h 30 » ne désigne aucun instant.
   */
  | 'LOCAL_TIME_DOES_NOT_EXIST';

export interface CalendarDate {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  readonly day: number;
}

export type DateReading =
  | { readonly kind: 'RESOLVED'; readonly date: CalendarDate }
  | { readonly kind: 'ABSENT' }
  | { readonly kind: 'AMBIGUOUS'; readonly refusal: TemporalRefusal };

export type TimeReading =
  | { readonly kind: 'RESOLVED'; readonly minuteOfDay: number }
  | { readonly kind: 'ABSENT' }
  | { readonly kind: 'AMBIGUOUS'; readonly refusal: TemporalRefusal };

export interface TemporalReading {
  readonly date: DateReading;
  readonly time: TimeReading;
  /** Les fragments qui ont produit cette lecture. Pour le journal de §21. */
  readonly evidence: readonly string[];
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Accents retirés, apostrophes unifiées, minuscules.
 *
 * Le dépôt le fait déjà partout (`naturalness.ts`, `utteranceScope.ts`), pour
 * la raison qui vaut ici aussi : `\b` est ASCII en JavaScript, et une frontière
 * de mot posée devant « après » ne se déclencherait pas.
 */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/[‘’ʼ]/gu, "'")
    .toLowerCase();
}

const ISO_WEEKDAYS: Readonly<Record<string, number>> = Object.freeze({
  lundi: 1,
  mardi: 2,
  mercredi: 3,
  jeudi: 4,
  vendredi: 5,
  samedi: 6,
  dimanche: 7,
});

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  janvier: 1,
  fevrier: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  decembre: 12,
});

/**
 * Les périodes trop larges pour porter un créneau.
 *
 * Elles ne sont lues QUE lorsqu'aucune heure explicite n'a été trouvée : dans
 * « vendredi matin vers 10h30 », « matin » qualifie une heure qui existe, et la
 * traiter comme vague refuserait une demande parfaitement précise — c'est
 * exactement le cas que la mission cite en exemple de ce qu'il faut savoir
 * réserver.
 */
const VAGUE_PERIOD_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bfin\s+de\s+(journee|matinee|semaine|mois)\b/u,
  /\bdebut\s+(de\s+)?(journee|matinee|semaine|mois|d'apres-midi)\b/u,
  /\bdans\s+la\s+(journee|matinee|semaine|soiree)\b/u,
  /\ben\s+(matinee|soiree|fin\s+de\s+journee)\b/u,
  /\bapres-?\s?midi\b/u,
  /\bsemaine\s+prochaine\b/u,
  /\bcette\s+semaine\b/u,
  /\bweek-?\s?end\b/u,
  /\bce\s+soir\b/u,
  /\bce\s+matin\b/u,
  /\bdans\s+la\s+nuit\b/u,
  /\bminuit\b/u,
]);

/** Les qualificatifs qui lèvent l'ambiguïté 1 h – 6 h. */
const MORNING_QUALIFIER = /\bdu\s+mat(in)?\b/u;
const AFTERNOON_QUALIFIER = /\b(de\s+l'?\s?apres-?\s?midi|de\s+l'?\s?aprem)\b/u;
const EVENING_QUALIFIER = /\bdu\s+soir\b/u;

// ---------------------------------------------------------------------------
// L'heure
// ---------------------------------------------------------------------------

interface RawTime {
  readonly hour: number;
  readonly minute: number;
  readonly excerpt: string;
  /** Position dans le texte normalisé. Sert à APPARIER une heure à une date. */
  readonly index: number;
}

/**
 * Toutes les heures EXPLICITES du texte.
 *
 * Trois formes, et seulement trois : « 15h », « 15h30 » (avec ou sans espaces,
 * avec « heure(s) » écrit en toutes lettres), « 15:30 », et le mot « midi ».
 * Un nombre nu n'est jamais une heure — « j'ai 3 salariés » ne doit pas
 * proposer un rendez-vous à 3 h.
 */
function readRawTimes(normalized: string): RawTime[] {
  const found: RawTime[] = [];

  for (const match of normalized.matchAll(/\b(\d{1,2})\s*(?:h|heures?)\s*(\d{1,2})?\b/gu)) {
    const hour = Number.parseInt(match[1] ?? '', 10);
    const minuteRaw = match[2];
    const minute = minuteRaw === undefined ? 0 : Number.parseInt(minuteRaw, 10);
    found.push({ hour, minute, excerpt: match[0].trim(), index: match.index ?? 0 });
  }

  for (const match of normalized.matchAll(/\b(\d{1,2})\s*:\s*(\d{2})\b/gu)) {
    found.push({
      hour: Number.parseInt(match[1] ?? '', 10),
      minute: Number.parseInt(match[2] ?? '', 10),
      excerpt: match[0].trim(),
      index: match.index ?? 0,
    });
  }

  // « midi » — mais jamais celui d'« après-midi », qui est une période et non
  // une heure. La forme composée est retirée avant la recherche.
  const withoutAfternoon = normalized.replace(/\bapres-?\s?midi\b/gu, ' ');
  const noon = withoutAfternoon.match(/\bmidi\b/u);
  if (noon !== null) {
    found.push({ hour: 12, minute: 0, excerpt: 'midi', index: noon.index ?? 0 });
  }

  return found;
}

function readTime(normalized: string): TimeReading & { readonly evidence: readonly string[] } {
  const raw = readRawTimes(normalized);

  if (raw.length === 0) {
    // Aucune heure explicite : c'est ici, et seulement ici, qu'une période
    // large refuse. Avec une heure, « matin » n'est qu'un qualificatif.
    if (VAGUE_PERIOD_PATTERNS.some((pattern) => pattern.test(normalized))) {
      return Object.freeze({
        kind: 'AMBIGUOUS' as const,
        refusal: 'VAGUE_PERIOD' as const,
        evidence: Object.freeze([]),
      });
    }
    return Object.freeze({ kind: 'ABSENT' as const, evidence: Object.freeze([]) });
  }

  const morning = MORNING_QUALIFIER.test(normalized);
  const afternoon = AFTERNOON_QUALIFIER.test(normalized);
  const evening = EVENING_QUALIFIER.test(normalized);

  const resolved: { minuteOfDay: number; excerpt: string }[] = [];
  for (const entry of raw) {
    if (entry.hour > 23 || entry.minute > 59) {
      return Object.freeze({
        kind: 'AMBIGUOUS' as const,
        refusal: 'TIME_OUT_OF_RANGE' as const,
        evidence: Object.freeze([entry.excerpt]),
      });
    }

    let hour = entry.hour;
    if (hour <= 6) {
      // La bande vraiment ambiguë du français parlé : « on se cale vers 3h »
      // peut vouloir dire 3 h ou 15 h, et se tromper d'un demi-tour d'horloge
      // sur un rendez-vous est la faute la plus coûteuse de ce module.
      if (afternoon || evening) hour += 12;
      else if (!morning) {
        return Object.freeze({
          kind: 'AMBIGUOUS' as const,
          refusal: 'MERIDIEM_AMBIGUOUS' as const,
          evidence: Object.freeze([entry.excerpt]),
        });
      }
    } else if (hour < 12 && (afternoon || evening)) {
      // « 7h du soir » : le français y préfère « 19h », mais la forme existe et
      // elle n'est pas ambiguë — le qualificatif tranche.
      hour += 12;
    }

    resolved.push({ minuteOfDay: hour * 60 + entry.minute, excerpt: entry.excerpt });
  }

  const distinct = [...new Set(resolved.map((entry) => entry.minuteOfDay))];
  if (distinct.length > 1) {
    return Object.freeze({
      kind: 'AMBIGUOUS' as const,
      refusal: 'MULTIPLE_CANDIDATES' as const,
      evidence: Object.freeze(resolved.map((entry) => entry.excerpt)),
    });
  }

  return Object.freeze({
    kind: 'RESOLVED' as const,
    minuteOfDay: distinct[0] as number,
    evidence: Object.freeze(resolved.map((entry) => entry.excerpt)),
  });
}

// ---------------------------------------------------------------------------
// La date
// ---------------------------------------------------------------------------

function addDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return Object.freeze({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

function isoWeekdayOf(date: CalendarDate): number {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

function isRealDate(date: CalendarDate): boolean {
  const probe = new Date(Date.UTC(date.year, date.month - 1, date.day));
  return (
    probe.getUTCFullYear() === date.year &&
    probe.getUTCMonth() + 1 === date.month &&
    probe.getUTCDate() === date.day
  );
}

function sameDate(a: CalendarDate, b: CalendarDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

interface DateCandidate {
  readonly date: CalendarDate | null;
  readonly refusal: TemporalRefusal | null;
  readonly excerpt: string;
  /** Position dans le texte normalisé. Sert à APPARIER une date à une heure. */
  readonly index: number;
}

/**
 * Toutes les dates du texte, résolues contre le jour LOCAL de `now`.
 *
 * Chaque forme rend soit une date, soit un refus nommé. La déduplication a lieu
 * ensuite : « mercredi 26 août » porte deux formes qui désignent le même jour,
 * et les compter comme deux candidats refuserait une phrase parfaitement claire.
 */
function readDateCandidates(normalized: string, today: CalendarDate): DateCandidate[] {
  const candidates: DateCandidate[] = [];

  // ---- 1. Les relatifs, du plus long au plus court ------------------------
  //
  // « après-demain » contient « demain ». Le chercher d'abord, et retirer sa
  // trace, évite de compter deux jours différents pour un seul mot.
  let residue = normalized;
  const afterTomorrow = residue.match(/\bapres-?\s?demain\b/u);
  if (afterTomorrow !== null) {
    candidates.push({
      date: addDays(today, 2),
      refusal: null,
      excerpt: 'apres-demain',
      index: afterTomorrow.index ?? 0,
    });
    // Remplacé par des espaces de MÊME longueur : les positions déjà relevées
    // et celles qu'on relèvera ensuite doivent rester comparables entre elles.
    residue = residue.replace(/\bapres-?\s?demain\b/gu, (m) => ' '.repeat(m.length));
  }
  const tomorrow = residue.match(/\bdemain\b/u);
  if (tomorrow !== null) {
    candidates.push({ date: addDays(today, 1), refusal: null, excerpt: 'demain', index: tomorrow.index ?? 0 });
    residue = residue.replace(/\bdemain\b/gu, (m) => ' '.repeat(m.length));
  }
  const todayMatch = residue.match(/\baujourd'?\s?hui\b/u);
  if (todayMatch !== null) {
    candidates.push({ date: today, refusal: null, excerpt: "aujourd'hui", index: todayMatch.index ?? 0 });
    residue = residue.replace(/\baujourd'?\s?hui\b/gu, (m) => ' '.repeat(m.length));
  }

  // ---- 2. Le jour de la semaine ------------------------------------------
  for (const [name, iso] of Object.entries(ISO_WEEKDAYS)) {
    const pattern = new RegExp(`\\b${name}\\b`, 'u');
    const hit = residue.match(pattern);
    if (hit === null) continue;
    const at = hit.index ?? 0;

    // « mercredi prochain » : l'usage français est réellement partagé entre
    // « celui qui vient » et « celui de la semaine d'après ». Refuser coûte une
    // question ; deviner coûte un rendez-vous à la mauvaise semaine.
    if (new RegExp(`\\b${name}\\s+prochain\\b`, 'u').test(residue)) {
      candidates.push({
        date: null,
        refusal: 'NEXT_OCCURRENCE_AMBIGUOUS',
        excerpt: `${name} prochain`,
        index: at,
      });
      continue;
    }

    const todayIso = isoWeekdayOf(today);
    if (todayIso === iso) {
      // Dit un mercredi, « mercredi » peut désigner aujourd'hui ou dans sept
      // jours. Aucune des deux lectures ne l'emporte assez pour réserver.
      candidates.push({ date: null, refusal: 'WEEKDAY_TODAY_AMBIGUOUS', excerpt: name, index: at });
      continue;
    }
    const delta = (iso - todayIso + 7) % 7;
    candidates.push({ date: addDays(today, delta), refusal: null, excerpt: name, index: at });
  }

  // ---- 3. « 26 août », « 26 aout 2026 » -----------------------------------
  for (const match of residue.matchAll(
    /\b(\d{1,2})\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)(?:\s+(\d{4}))?\b/gu,
  )) {
    const day = Number.parseInt(match[1] ?? '', 10);
    const month = MONTHS[match[2] ?? ''] as number;
    const explicitYear = match[3] === undefined ? null : Number.parseInt(match[3], 10);
    const excerpt = match[0].trim();
    const at = match.index ?? 0;

    if (explicitYear !== null) {
      const date = { year: explicitYear, month, day };
      candidates.push(
        isRealDate(date)
          ? { date: Object.freeze(date), refusal: null, excerpt, index: at }
          : { date: null, refusal: 'DATE_OUT_OF_RANGE', excerpt, index: at },
      );
      continue;
    }
    // Sans année : celle en cours si la date n'est pas passée, la suivante
    // sinon. Aucune supposition n'est faite au-delà — l'horizon de la politique
    // refusera de toute façon une date trop lointaine.
    const thisYear = { year: today.year, month, day };
    if (!isRealDate(thisYear)) {
      candidates.push({ date: null, refusal: 'DATE_OUT_OF_RANGE', excerpt, index: at });
      continue;
    }
    const passed =
      thisYear.month < today.month || (thisYear.month === today.month && thisYear.day < today.day);
    const chosen = passed ? { year: today.year + 1, month, day } : thisYear;
    candidates.push(
      isRealDate(chosen)
        ? { date: Object.freeze(chosen), refusal: null, excerpt, index: at }
        : { date: null, refusal: 'DATE_OUT_OF_RANGE', excerpt, index: at },
    );
  }

  // ---- 4. « 26/08 », « 26/08/2026 » ---------------------------------------
  for (const match of residue.matchAll(/\b(\d{1,2})[/](\d{1,2})(?:[/](\d{2,4}))?\b/gu)) {
    const day = Number.parseInt(match[1] ?? '', 10);
    const month = Number.parseInt(match[2] ?? '', 10);
    const rawYear = match[3];
    const excerpt = match[0].trim();
    const at = match.index ?? 0;
    const year =
      rawYear === undefined
        ? today.year
        : rawYear.length === 2
          ? 2_000 + Number.parseInt(rawYear, 10)
          : Number.parseInt(rawYear, 10);
    const date = { year, month, day };
    if (!isRealDate(date)) {
      candidates.push({ date: null, refusal: 'DATE_OUT_OF_RANGE', excerpt, index: at });
      continue;
    }
    const passed =
      rawYear === undefined &&
      (month < today.month || (month === today.month && day < today.day));
    candidates.push({
      date: Object.freeze(passed ? { year: year + 1, month, day } : date),
      refusal: null,
      excerpt,
      index: at,
    });
  }

  // ---- 5. « le 12 » — le mois n'est pas dit -------------------------------
  //
  // Cherché sur le RÉSIDU, donc jamais sur le « 26 » d'un « 26 août » déjà lu.
  const bareDay = residue
    .replace(
      /\b\d{1,2}\s+(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)(\s+\d{4})?\b/gu,
      ' ',
    )
    .replace(/\b\d{1,2}[/]\d{1,2}([/]\d{2,4})?\b/gu, ' ')
    .replace(/\b\d{1,2}\s*(?:h|heures?)\s*\d{0,2}\b/gu, ' ')
    .replace(/\b\d{1,2}\s*:\s*\d{2}\b/gu, ' ');
  const bare = bareDay.match(/\ble\s+(\d{1,2})\b/u);
  if (bare !== null) {
    candidates.push({
      date: null,
      refusal: 'MONTH_AMBIGUOUS',
      excerpt: bare[0].trim(),
      index: bare.index ?? 0,
    });
  }

  return candidates;
}

function readDate(normalized: string, today: CalendarDate): DateReading & { readonly evidence: readonly string[] } {
  const candidates = readDateCandidates(normalized, today);

  if (candidates.length === 0) {
    return Object.freeze({ kind: 'ABSENT' as const, evidence: Object.freeze([]) });
  }

  const refused = candidates.find((entry) => entry.refusal !== null);
  const dates = candidates.filter((entry) => entry.date !== null);

  // Un refus l'emporte sur une résolution : « mercredi ou le 12 » ne réserve
  // pas mercredi au motif qu'une des deux lectures aboutissait.
  if (refused !== undefined) {
    return Object.freeze({
      kind: 'AMBIGUOUS' as const,
      refusal: refused.refusal as TemporalRefusal,
      evidence: Object.freeze(candidates.map((entry) => entry.excerpt)),
    });
  }

  const distinct: CalendarDate[] = [];
  for (const entry of dates) {
    const date = entry.date as CalendarDate;
    if (!distinct.some((seen) => sameDate(seen, date))) distinct.push(date);
  }

  if (distinct.length > 1) {
    return Object.freeze({
      kind: 'AMBIGUOUS' as const,
      refusal: 'MULTIPLE_CANDIDATES' as const,
      evidence: Object.freeze(candidates.map((entry) => entry.excerpt)),
    });
  }

  return Object.freeze({
    kind: 'RESOLVED' as const,
    date: distinct[0] as CalendarDate,
    evidence: Object.freeze(candidates.map((entry) => entry.excerpt)),
  });
}

// ---------------------------------------------------------------------------
// La lecture, puis l'instant
// ---------------------------------------------------------------------------

/**
 * Ce que le texte dit du temps — date d'un côté, heure de l'autre.
 *
 * Les deux moitiés sont rendues SÉPARÉMENT, et c'est ce qui permet à
 * `intent.ts` de compléter l'une par les créneaux déjà proposés sans jamais
 * compléter l'autre par une supposition : « mercredi » (heure absente) se
 * résout contre un créneau proposé ce mercredi-là, alors que « vers 3h »
 * (heure AMBIGUË) ne se résout contre rien du tout.
 */
export function readTemporal(text: string, now: Date, timezone: string): TemporalReading {
  const normalized = normalize(text);
  const local = zonedParts(now, timezone);
  const today: CalendarDate = Object.freeze({
    year: local.year,
    month: local.month,
    day: local.day,
  });

  const date = readDate(normalized, today);
  const time = readTime(normalized);

  return Object.freeze({
    date: date.kind === 'RESOLVED'
      ? Object.freeze({ kind: 'RESOLVED' as const, date: date.date })
      : date.kind === 'AMBIGUOUS'
        ? Object.freeze({ kind: 'AMBIGUOUS' as const, refusal: date.refusal })
        : Object.freeze({ kind: 'ABSENT' as const }),
    time: time.kind === 'RESOLVED'
      ? Object.freeze({ kind: 'RESOLVED' as const, minuteOfDay: time.minuteOfDay })
      : time.kind === 'AMBIGUOUS'
        ? Object.freeze({ kind: 'AMBIGUOUS' as const, refusal: time.refusal })
        : Object.freeze({ kind: 'ABSENT' as const }),
    evidence: Object.freeze([...date.evidence, ...time.evidence]),
  });
}

/**
 * L'instant que cette date et cette heure désignent dans ce fuseau.
 *
 * `zonedWallClockToUtc` porte toute la connaissance de l'heure d'été. Aux
 * minutes SAUTÉES d'un passage à l'heure d'été, il rend la première
 * milliseconde où l'horloge murale demandée existe réellement ; le contrôle de
 * disponibilité juge ensuite cet instant-là, ce qui est le comportement voulu —
 * on ne commence jamais plus tôt que demandé.
 */
export function instantOf(
  date: CalendarDate,
  minuteOfDay: number,
  timezone: string,
): Date | null {
  const instant = zonedWallClockToUtc(date.year, date.month, date.day, minuteOfDay, timezone);

  // Le VOYAGE RETOUR, et il n'est pas décoratif.
  //
  // `zonedWallClockToUtc` est un point fixe. Sur une heure murale qui existe, il
  // converge et le retour est exact. Sur une heure SAUTÉE — 02 h 30 le dernier
  // dimanche de mars en Europe —, aucune réponse n'est exacte, et il rend un
  // instant dont l'horloge locale affiche autre chose que ce qu'on a demandé
  // (mesuré : 02 h 30 le 29 mars 2026 rend un instant qui vaut 01 h 30 locale).
  //
  // Pour une OUVERTURE de fenêtre — l'usage de l'ordonnanceur Instagram, qui
  // partage cette fonction — c'est sans conséquence : on ouvre une minute plus
  // tôt ou plus tard un jour par an. Pour un RENDEZ-VOUS, c'en est une : on
  // inscrirait 01 h 30 dans l'agenda d'un vrai commerçant en lui disant 02 h 30.
  //
  // On refuse donc, plutôt que de substituer. Le prix est une question de
  // clarification une nuit par an ; le prix inverse est un rendez-vous manqué.
  const roundTrip = zonedParts(instant, timezone);
  const matches =
    roundTrip.year === date.year &&
    roundTrip.month === date.month &&
    roundTrip.day === date.day &&
    roundTrip.minuteOfDay === minuteOfDay;

  return matches ? instant : null;
}

// ---------------------------------------------------------------------------
// Ce que NOTRE texte mentionne — la garde anti-invention
// ---------------------------------------------------------------------------

/** Un couple date + heure lu dans un texte, avec ce qui l'a produit. */
export interface MentionedSlot {
  readonly date: CalendarDate;
  readonly minuteOfDay: number;
  readonly excerpt: string;
}

/**
 * Tous les créneaux qu'un texte DÉSIGNE, appariés.
 *
 * Écrit pour relire NOS propres brouillons, pas ceux du prospect : §6 de la
 * mission exige que les créneaux proposés viennent du moteur et jamais du
 * modèle, et une garde ne peut le vérifier que si elle sait lire « mercredi
 * 15 h ou jeudi 11 h » comme DEUX créneaux et non comme deux dates et deux
 * heures en vrac. Le contrôle par ensembles laisserait passer le produit croisé
 * — « mercredi 11 h ou jeudi 15 h » —, qui est faux tout en n'inventant aucun
 * nombre.
 *
 * L'appariement est positionnel et volontairement simple : chaque date prend
 * l'heure la plus proche qui la SUIT, faute de quoi la plus proche qui la
 * précède. C'est la manière dont le français écrit un créneau (« jeudi à 11h »,
 * plus rarement « à 11h jeudi »), et une phrase trop tordue pour cette règle
 * rendra un couple faux — donc un REFUS, jamais une acceptation.
 *
 * Les lectures ambiguës sont ignorées plutôt que rendues : ce module répond ici
 * à « qu'est-ce que ce texte affirme ? », et « vers 3 h » n'affirme rien de
 * précis. La garde qui l'appelle refuse par ailleurs tout créneau qu'elle ne
 * retrouve pas dans ce qui a été calculé.
 */
export function mentionedSlots(text: string, now: Date, timezone: string): readonly MentionedSlot[] {
  const normalized = normalize(text);
  const local = zonedParts(now, timezone);
  const today: CalendarDate = Object.freeze({
    year: local.year,
    month: local.month,
    day: local.day,
  });

  const dates = readDateCandidates(normalized, today)
    .filter((entry) => entry.date !== null)
    .sort((a, b) => a.index - b.index);

  const morning = MORNING_QUALIFIER.test(normalized);
  const afternoon = AFTERNOON_QUALIFIER.test(normalized);
  const evening = EVENING_QUALIFIER.test(normalized);

  const times = readRawTimes(normalized)
    .map((entry) => {
      if (entry.hour > 23 || entry.minute > 59) return null;
      let hour = entry.hour;
      if (hour <= 6) {
        if (afternoon || evening) hour += 12;
        else if (!morning) return null;
      } else if (hour < 12 && (afternoon || evening)) {
        hour += 12;
      }
      return { minuteOfDay: hour * 60 + entry.minute, index: entry.index, excerpt: entry.excerpt };
    })
    .filter((entry): entry is { minuteOfDay: number; index: number; excerpt: string } => entry !== null)
    .sort((a, b) => a.index - b.index);

  if (dates.length === 0 || times.length === 0) return Object.freeze([]);

  const slots: MentionedSlot[] = [];
  for (const entry of dates) {
    const after = times.find((time) => time.index > entry.index);
    const before = [...times].reverse().find((time) => time.index < entry.index);
    const chosen = after ?? before;
    if (chosen === undefined) continue;
    slots.push(
      Object.freeze({
        date: entry.date as CalendarDate,
        minuteOfDay: chosen.minuteOfDay,
        excerpt: `${entry.excerpt} ${chosen.excerpt}`.trim(),
      }),
    );
  }
  return Object.freeze(slots);
}

/**
 * Toutes les heures qu'un texte affirme, sans les apparier à une date.
 *
 * Complète `mentionedSlots` : une confirmation peut ne nommer que l'heure
 * (« c'est calé pour 15 h »), et une garde qui n'aurait que l'appariement ne
 * verrait alors rien du tout — donc laisserait passer n'importe quelle heure.
 */
export function mentionedTimes(text: string): readonly number[] {
  const normalized = normalize(text);
  const morning = MORNING_QUALIFIER.test(normalized);
  const afternoon = AFTERNOON_QUALIFIER.test(normalized);
  const evening = EVENING_QUALIFIER.test(normalized);

  const minutes: number[] = [];
  for (const entry of readRawTimes(normalized)) {
    if (entry.hour > 23 || entry.minute > 59) continue;
    let hour = entry.hour;
    if (hour <= 6) {
      if (afternoon || evening) hour += 12;
      else if (!morning) continue;
    } else if (hour < 12 && (afternoon || evening)) {
      hour += 12;
    }
    minutes.push(hour * 60 + entry.minute);
  }
  return Object.freeze([...new Set(minutes)]);
}

/** Le jour local d'un instant, dans le vocabulaire de ce module. */
export function calendarDateOf(instant: Date, timezone: string): CalendarDate {
  const local = zonedParts(instant, timezone);
  return Object.freeze({ year: local.year, month: local.month, day: local.day });
}

/** Les minutes depuis minuit local d'un instant. */
export function minuteOfDayOf(instant: Date, timezone: string): number {
  return zonedParts(instant, timezone).minuteOfDay;
}

export function sameCalendarDate(a: CalendarDate, b: CalendarDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}
