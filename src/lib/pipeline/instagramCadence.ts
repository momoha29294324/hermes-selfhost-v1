import { deriveLastPostAt, type ObservedPost } from '@/lib/pipeline/instagramObservation';

/**
 * R7.3C §16 — la cadence de publication, par une méthode qu'on peut contester.
 *
 * ---------------------------------------------------------------------------
 * Le contrat : publier l'échantillon avant le verdict
 * ---------------------------------------------------------------------------
 * Une cadence est une extrapolation. Elle n'a de valeur que si l'on peut voir
 * SUR QUOI elle a été calculée — d'où les cinq champs que la mission exige et
 * que ce module rend systématiquement, y compris quand la classe vaut `UNKNOWN` :
 * taille de l'échantillon, plus récent, plus ancien, empan, estimation.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi (n − 1) et non n
 * ---------------------------------------------------------------------------
 * Douze publications observées sur soixante jours ne décrivent pas douze
 * intervalles, elles en décrivent onze : la fenêtre est BORNÉE PAR les deux
 * publications extrêmes, pas ouverte à leurs côtés. Diviser n par l'empan
 * surestime donc systématiquement la cadence, et l'erreur est d'autant plus
 * grosse que l'échantillon est petit — c'est-à-dire exactement là où elle se
 * verrait le moins.
 *
 * ---------------------------------------------------------------------------
 * Ce que l'échantillon tronqué change, et ne change pas
 * ---------------------------------------------------------------------------
 * L'observation ne voit que le haut de la grille : les publications les plus
 * RÉCENTES. La cadence calculée est donc celle de la période récente, et non une
 * moyenne de vie du compte. C'est le bon choix pour la question posée (« est-ce
 * un canal vivant ? ») et c'est un biais qu'il faut nommer plutôt que corriger :
 * un compte à 889 publications qui n'en a fait aucune depuis un an doit sortir
 * `INACTIVE`, pas « 3 par mois en moyenne depuis 2019 ».
 *
 * ---------------------------------------------------------------------------
 * Les seuils, et l'engagement qui va avec
 * ---------------------------------------------------------------------------
 * Ils sont écrits ici une fois, exportés, et épinglés par des tests. Ils n'ont
 * PAS été choisis en regardant un prospect : ils découpent des régimes de
 * publication ordinaires (quotidien, hebdomadaire, mensuel, muet) et ils ont été
 * fixés avant la première collecte réelle. Les déplacer pour changer le rang d'un
 * compte donné serait de l'ajustement rétrospectif, et ce serait visible dans le
 * diff — c'est le but de les avoir nommés.
 */

export const CADENCE_CLASSES = ['INACTIVE', 'SPORADIC', 'ACTIVE', 'HIGH_FREQUENCY', 'UNKNOWN'] as const;
export type CadenceClass = (typeof CADENCE_CLASSES)[number];

export const CADENCE_RULES = {
  /** En deçà, aucun intervalle n'est mesurable et la réponse est `UNKNOWN`. */
  minimumSample: 3,
  /** Un empan trop court fait exploser l'extrapolation : trois posts en une heure ne font pas 2 000/mois. */
  minimumSpanDays: 7,
  /** Silence au-delà duquel la récence l'emporte sur tout historique. */
  inactiveAfterDays: 180,
  /** ≥ 12 publications / 30 j ≈ trois par semaine. */
  highFrequencyPer30d: 12,
  /** ≥ 4 / 30 j ≈ une par semaine. */
  activePer30d: 4,
} as const;

export interface CadenceEstimate {
  readonly cadence: CadenceClass;
  /** Publications horodatées et non épinglées retenues. */
  readonly sampleSize: number;
  readonly newestObservedAt: string | null;
  readonly oldestObservedAt: string | null;
  readonly observedSpanDays: number | null;
  readonly postsPer30dEstimate: number | null;
  readonly daysSinceLastPost: number | null;
  /** La phrase qui explique le verdict. Publiée telle quelle dans les rapports. */
  readonly method: string;
}

const DAY_MS = 86_400_000;

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Estime la cadence, ou refuse de le faire.
 *
 * `now` est injectée : la récence dépend de l'heure, et un moteur dont le verdict
 * change au fil de la journée ne serait ni rejouable ni comparable d'un rapport
 * à l'autre.
 */
export function estimateCadence(posts: readonly ObservedPost[], now: Date): CadenceEstimate {
  const dated = posts
    .filter((post) => !post.pinned && post.takenAt !== null)
    .map((post) => new Date(post.takenAt as string))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  const empty: CadenceEstimate = {
    cadence: 'UNKNOWN',
    sampleSize: 0,
    newestObservedAt: null,
    oldestObservedAt: null,
    observedSpanDays: null,
    postsPer30dEstimate: null,
    daysSinceLastPost: null,
    method: 'aucune publication horodatée observée — la cadence reste inconnue, pas nulle',
  };
  if (dated.length === 0) return empty;

  const oldest = dated[0];
  const newest = dated[dated.length - 1];
  if (oldest === undefined || newest === undefined) return empty;

  const lastPost = deriveLastPostAt(posts) ?? newest;
  const daysSinceLastPost = round((now.getTime() - lastPost.getTime()) / DAY_MS, 1);
  const spanDays = round((newest.getTime() - oldest.getTime()) / DAY_MS, 2);

  const base = {
    sampleSize: dated.length,
    newestObservedAt: newest.toISOString(),
    oldestObservedAt: oldest.toISOString(),
    observedSpanDays: spanDays,
    daysSinceLastPost,
  };

  /**
   * La récence d'abord, et elle peut trancher SEULE.
   *
   * Un compte muet depuis six mois est inactif, que son historique ait été
   * dense ou clairsemé — et cette conclusion ne demande qu'UNE date réellement
   * observée, donc elle est plus solide que n'importe quelle extrapolation.
   */
  if (daysSinceLastPost > CADENCE_RULES.inactiveAfterDays) {
    return {
      ...base,
      cadence: 'INACTIVE',
      postsPer30dEstimate: null,
      method:
        `dernière publication observée il y a ${daysSinceLastPost} jours ` +
        `(> ${CADENCE_RULES.inactiveAfterDays}) — la récence tranche seule, sans extrapolation`,
    };
  }

  if (dated.length < CADENCE_RULES.minimumSample) {
    return {
      ...base,
      cadence: 'UNKNOWN',
      postsPer30dEstimate: null,
      method:
        `${dated.length} publication(s) horodatée(s) — moins que le minimum de ` +
        `${CADENCE_RULES.minimumSample} : aucune estimation honnête n’est possible`,
    };
  }
  if (spanDays < CADENCE_RULES.minimumSpanDays) {
    return {
      ...base,
      cadence: 'UNKNOWN',
      postsPer30dEstimate: null,
      method:
        `empan observé de ${spanDays} jour(s) — sous le minimum de ${CADENCE_RULES.minimumSpanDays} : ` +
        'extrapoler une cadence mensuelle depuis une fenêtre aussi courte fabriquerait un nombre, pas une mesure',
    };
  }

  // (n − 1) intervalles entre n publications, ramenés à 30 jours.
  const per30d = round(((dated.length - 1) / spanDays) * 30, 2);
  const cadence: CadenceClass =
    per30d >= CADENCE_RULES.highFrequencyPer30d
      ? 'HIGH_FREQUENCY'
      : per30d >= CADENCE_RULES.activePer30d
        ? 'ACTIVE'
        : 'SPORADIC';

  return {
    ...base,
    cadence,
    postsPer30dEstimate: per30d,
    method:
      `${dated.length} publications sur ${spanDays} jours, soit ${dated.length - 1} intervalle(s) → ` +
      `${per30d}/30 j ; dernière il y a ${daysSinceLastPost} jour(s)`,
  };
}
