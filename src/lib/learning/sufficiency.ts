/**
 * LEARNING-R1 §12 — ce qu'on a le droit de conclure, et à partir de combien.
 *
 * Ce fichier existe parce que la faute la plus coûteuse d'une boucle
 * d'apprentissage n'est pas de mal mesurer : c'est de conclure trop tôt. Un
 * prospect sur un qui répond fait 100 % de taux de réponse, et ce nombre est
 * exact — il ne veut simplement rien dire. Le dépôt a déjà refusé ailleurs
 * qu'une machine affirme ce qu'elle n'a pas observé ; ici on refuse qu'elle
 * affirme ce qu'elle a observé UNE fois.
 *
 * Trois propriétés :
 *
 *   1. **Un ratio ne circule jamais seul.** Le type `Rate` porte son numérateur,
 *      son dénominateur et son intervalle. Il n'existe pas de chemin par lequel
 *      un `0.5` sortirait d'ici sans son « 1/2 ».
 *
 *   2. **L'intervalle est celui de Wilson**, pas l'approximation normale. Sur
 *      les petits effectifs — c'est-à-dire exactement notre cas — l'intervalle
 *      normal produit des bornes hors [0,1] et une largeur nulle quand p vaut 0
 *      ou 1. Un intervalle qui vaut [0,0] sur 0/3 dirait « certitude » là où il
 *      n'y a rien.
 *
 *   3. **Le statut est une conséquence, pas un jugement.** `SUPPORTED_SIGNAL`
 *      demande un effectif ET un intervalle serré. Les deux, parce que 30
 *      observations dont l'intervalle va de 5 % à 45 % ne soutiennent rien.
 */

/** Le niveau de preuve d'une observation. Trois crans, jamais un booléen. */
export type SignalStatus = 'INSUFFICIENT_DATA' | 'EARLY_SIGNAL' | 'SUPPORTED_SIGNAL';

/**
 * Les seuils.
 *
 * Ils sont bas — dix, trente — parce que ce round observe une prospection qui
 * commence, pas une campagne mature. Ils restent au-dessus de ce qui permettrait
 * de conclure sur une anecdote, et c'est tout ce qu'on leur demande. Les
 * remonter plus tard est une décision humaine ; les descendre serait renoncer
 * au fichier.
 */
export const MIN_N_FOR_EARLY_SIGNAL = 10;
export const MIN_N_FOR_SUPPORTED_SIGNAL = 30;

/**
 * Au-delà de cette largeur, l'intervalle ne soutient rien.
 *
 * 0,30 laisse « entre 10 % et 40 % », qui est déjà une fourchette large ; en
 * dessous de ce niveau d'exigence, « soutenu » ne voudrait plus rien dire.
 */
export const MAX_INTERVAL_WIDTH_FOR_SUPPORTED = 0.3;

/** Le z d'un intervalle bilatéral à 95 %. */
const Z_95 = 1.959_963_984_540_054;

export interface ConfidenceInterval {
  readonly lower: number;
  readonly upper: number;
  readonly width: number;
  /** Le niveau de confiance, en clair. Une constante, dite plutôt que supposée. */
  readonly level: 0.95;
}

/**
 * Une proportion observée, avec tout ce qui permet de la relire.
 *
 * `value` vaut `null` quand le dénominateur est nul : zéro envoi ne fait pas
 * « 0 % de réponses », il fait « rien d'observé ». La distinction est celle que
 * CLAUDE.md §2 impose partout ailleurs.
 */
export interface Rate {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
  readonly interval: ConfidenceInterval | null;
  readonly status: SignalStatus;
}

/**
 * L'intervalle de Wilson.
 *
 * Choisi pour son comportement aux bords : sur 0/5 il rend environ [0 ; 0,43],
 * ce qui est la bonne lecture — « on n'a rien vu, et on n'a pas vu grand-chose
 * non plus ». L'approximation normale y rendrait [0 ; 0], donc une certitude
 * fabriquée par une formule.
 */
export function wilsonInterval(numerator: number, denominator: number, z = Z_95): ConfidenceInterval | null {
  if (denominator <= 0) return null;
  const p = numerator / denominator;
  const z2 = z * z;
  const denom = 1 + z2 / denominator;
  const centre = p + z2 / (2 * denominator);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * denominator)) / denominator);
  const lower = Math.max(0, (centre - spread) / denom);
  const upper = Math.min(1, (centre + spread) / denom);
  return Object.freeze({ lower, upper, width: upper - lower, level: 0.95 as const });
}

/**
 * Le statut d'un effectif.
 *
 * Séparé de `rate` pour être appelable sur autre chose qu'une proportion — un
 * décompte de corrections de style, par exemple, n'est pas un ratio mais obéit
 * à la même règle de prudence.
 */
export function statusForSample(denominator: number, interval: ConfidenceInterval | null): SignalStatus {
  if (denominator < MIN_N_FOR_EARLY_SIGNAL) return 'INSUFFICIENT_DATA';
  if (denominator < MIN_N_FOR_SUPPORTED_SIGNAL) return 'EARLY_SIGNAL';
  if (interval === null || interval.width > MAX_INTERVAL_WIDTH_FOR_SUPPORTED) return 'EARLY_SIGNAL';
  return 'SUPPORTED_SIGNAL';
}

/** Construit une proportion complète. Le seul constructeur de `Rate`. */
export function rate(numerator: number, denominator: number): Rate {
  if (denominator <= 0) {
    return Object.freeze({
      numerator: 0,
      denominator: 0,
      value: null,
      interval: null,
      status: 'INSUFFICIENT_DATA' as const,
    });
  }
  const interval = wilsonInterval(numerator, denominator);
  return Object.freeze({
    numerator,
    denominator,
    value: numerator / denominator,
    interval,
    status: statusForSample(denominator, interval),
  });
}

/** Rend une proportion lisible par un humain, sans jamais cacher son effectif. */
export function renderRate(value: Rate): string {
  if (value.denominator === 0) return 'n=0 (rien observé)';
  const percent = ((value.value ?? 0) * 100).toFixed(0);
  const interval = value.interval;
  const range =
    interval === null
      ? ''
      : ` [${(interval.lower * 100).toFixed(0)}–${(interval.upper * 100).toFixed(0)} %]`;
  return `${value.numerator}/${value.denominator} = ${percent} %${range} — ${value.status}`;
}
