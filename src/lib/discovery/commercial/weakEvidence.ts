import { departmentFromPostcode } from '@/lib/geo/geo';
import type { SocialMatch } from '@/lib/discovery/search/classify';

/**
 * Deux indices que R4-S a rendus visibles, et le refus de leur faire dire plus
 * qu'ils ne disent (§8).
 *
 * Le benchmark Serper a produit deux observations que le résolveur ne savait
 * pas exploiter :
 *
 *   1. **l'accord inter-moteurs** — deux index indépendants proposent le même
 *      handle pour la même entreprise ;
 *   2. **le jeton géographique** — `@luxury_car_demo_account_34` pour une
 *      entreprise de Haute-Savoie.
 *
 * Les deux sont réels et les deux sont faibles. Ils ont en commun d'être des
 * indices **sur la plausibilité**, pas des preuves d'appartenance :
 *
 *   — deux moteurs qui s'accordent peuvent s'accorder sur la même erreur. Ils
 *     indexent en grande partie le même web, et un compte bien référencé sur un
 *     nom générique sera premier partout. L'accord mesure la popularité du
 *     résultat, pas sa justesse ;
 *   — le « 74 » d'un handle est le département dans la très grande majorité des
 *     cas. Il est aussi, parfois, une année de naissance, un numéro de rue, un
 *     millésime de voiture, ou le département d'origine d'un gérant installé
 *     ailleurs. Et surtout : il y a des centaines de artisans en Haute-Savoie.
 *     Savoir qu'un compte est haut-savoyard ne dit pas *lequel* il est.
 *
 * D'où la règle, qui est la raison d'être de ce module et qu'un test protège :
 *
 *     UN INDICE FAIBLE NE PEUT JAMAIS, SEUL, RATTACHER UN COMPTE.
 *
 * Ce qu'il peut faire est précis et utile : faire passer un dossier de
 * « incertain, à oublier » à « incertain, à regarder par un humain ». Le §8 cite
 * le cas et impose sa conclusion — CAR ATELIER / @demo-58-exemple.fr reste
 * `uncertain` tant que rien d'autre ne corrobore. Ce module produit exactement
 * ce verdict-là.
 */

export type WeakSignalKey = 'geo_token' | 'cross_engine' | 'geo_token_conflict';

export interface WeakSignal {
  key: WeakSignalKey;
  /** Contribution à la confiance. Bornée par `WEAK_EVIDENCE_MAX_BOOST` en cumulé. */
  weight: number;
  detail: string;
}

/**
 * Plafond cumulé des indices faibles.
 *
 * 0,2 n'est pas un réglage esthétique : le seuil de rattachement d'un compte
 * exige une corroboration explicite (ville, domaine ou téléphone cité), et
 * aucune somme d'indices faibles ne doit pouvoir s'y substituer. Le plafond est
 * la forme exécutable de cette phrase.
 */
export const WEAK_EVIDENCE_MAX_BOOST = 0.2;

/** Confiance minimale, indices faibles compris, pour mériter une revue humaine. */
export const MANUAL_REVIEW_FLOOR = 0.5;

/**
 * Le jeton numérique d'un handle, quand il en porte un exploitable.
 *
 * Deux chiffres, ou trois pour l'outre-mer. Un groupe de quatre chiffres ou
 * plus est ignoré sans exception : `@atelier2024` porte un millésime, et le
 * lire comme « département 20 » serait précisément le genre d'invention que la
 * règle 2 du dépôt interdit. Le motif exige donc que le nombre ne soit pas
 * collé à un autre chiffre.
 */
export function geoTokensOf(handle: string): string[] {
  const tokens: string[] = [];
  for (const match of handle.matchAll(/(?<!\d)(\d{2,3})(?!\d)/g)) {
    const value = match[1];
    if (value) tokens.push(value);
  }
  return tokens;
}

export interface GeoContext {
  postalCode?: string | null;
  department?: string | null;
}

/** Le département d'un prospect, du plus sûr au moins sûr. */
export function departmentOf(context: GeoContext): string | null {
  const fromPostal = departmentFromPostcode(context.postalCode ?? null);
  if (fromPostal) return fromPostal;
  const declared = (context.department ?? '').trim();
  return declared.length > 0 ? declared : null;
}

/**
 * Le handle porte-t-il le département de l'entreprise ?
 *
 * Rend aussi le cas contraire, qui vaut mieux que le silence : un handle en
 * « 69 » pour une entreprise du 74 est un argument **contre** le rapprochement.
 * Il reste faible lui aussi — une entreprise déménage, un gérant garde le
 * numéro de son département d'origine — mais l'ignorer reviendrait à ne
 * retenir des chiffres que ce qui arrange.
 */
export function geoTokenSignal(handle: string, context: GeoContext): WeakSignal | null {
  const department = departmentOf(context);
  if (!department) return null;

  const tokens = geoTokensOf(handle);
  if (tokens.length === 0) return null;

  if (tokens.includes(department)) {
    return {
      key: 'geo_token',
      weight: 0.12,
      detail: `le handle porte « ${department} », le département de l’entreprise — indice de plausibilité, pas une preuve`,
    };
  }

  // Un jeton géographique plausible (01–95) qui désigne un autre département.
  const conflicting = tokens.filter((token) => /^\d{2}$/.test(token) && Number(token) >= 1 && Number(token) <= 95);
  if (conflicting.length > 0) {
    return {
      key: 'geo_token_conflict',
      weight: -0.1,
      detail: `le handle porte « ${conflicting[0]} », qui n’est pas le département ${department} de l’entreprise`,
    };
  }

  return null;
}

/**
 * Plusieurs moteurs indépendants ont-ils proposé le même compte ?
 *
 * Le compte de fournisseurs distincts, pas d'appels : interroger deux fois le
 * même index n'est pas un accord, c'est une répétition. La distinction est
 * portée par un `Set`, donc par le type plutôt que par la discipline de
 * l'appelant.
 */
export function crossEngineSignal(providers: readonly string[]): WeakSignal | null {
  const distinct = new Set(providers.map((provider) => provider.trim().toLowerCase()).filter(Boolean));
  if (distinct.size < 2) return null;
  return {
    key: 'cross_engine',
    weight: 0.08,
    detail: `${distinct.size} moteurs indépendants proposent ce compte (${[...distinct].join(', ')}) — corrélation, pas confirmation`,
  };
}

export type SocialReviewLevel =
  /** Rattachable : la règle R4 s'est prononcée seule, sans l'aide des indices faibles. */
  | 'attachable'
  /** Assez plausible pour qu'un humain tranche. Jamais écrit sur le prospect. */
  | 'manual_review_high_confidence'
  /** Trace conservée, rien de plus. */
  | 'uncertain'
  /** Un signal contredit le rapprochement. */
  | 'rejected';

export interface SocialReview {
  level: SocialReviewLevel;
  /** Confiance du rapprochement, indices faibles compris et plafonnés. */
  confidence: number;
  /** Confiance du seul rapprochement fort, sans aucun indice faible. */
  strongConfidence: number;
  weakSignals: WeakSignal[];
  reasons: string[];
}

/**
 * Le verdict de rapprochement d'un compte, indices faibles compris.
 *
 * L'implémentation défend la règle du préambule par sa structure, pas par une
 * vérification finale : `attachable` est recopié **tel quel** depuis le
 * rapprochement fort de R4, avant même que les indices faibles ne soient
 * additionnés. Aucun chemin ne permet donc à un indice faible de produire un
 * rattachement, quel que soit son poids — même si quelqu'un en portait un à
 * 0,9 par erreur. Les seuils de R4 ne sont ni lus ni modifiés (§7).
 */
export function reviewSocialCandidate(match: SocialMatch, weakSignals: readonly WeakSignal[]): SocialReview {
  const signals = [...weakSignals];
  const rawBoost = signals.reduce((sum, signal) => sum + signal.weight, 0);
  const boost = Math.max(-WEAK_EVIDENCE_MAX_BOOST, Math.min(WEAK_EVIDENCE_MAX_BOOST, rawBoost));

  const strongConfidence = match.nameScore;
  const confidence = Math.max(0, Math.min(1, strongConfidence + boost));

  const reasons = [match.reason, ...signals.map((signal) => signal.detail)];

  if (match.attachable) {
    return { level: 'attachable', confidence, strongConfidence, weakSignals: signals, reasons };
  }

  const contradicted = signals.some((signal) => signal.weight < 0);
  if (contradicted && confidence < MANUAL_REVIEW_FLOOR) {
    return { level: 'rejected', confidence, strongConfidence, weakSignals: signals, reasons };
  }

  /**
   * La promotion vers la revue humaine exige que le rapprochement fort ait
   * déjà quelque chose à dire — un nom qui ressemble — et que les indices
   * faibles s'y ajoutent. Un nom sans rapport avec l'entreprise reste
   * `uncertain` même corroboré par trois moteurs et un département : ils
   * confirmeraient alors la popularité d'un compte qui n'est pas le bon.
   */
  const promoted = signals.some((signal) => signal.weight > 0) && confidence >= MANUAL_REVIEW_FLOOR;
  return {
    level: promoted ? 'manual_review_high_confidence' : 'uncertain',
    confidence,
    strongConfidence,
    weakSignals: signals,
    reasons,
  };
}
