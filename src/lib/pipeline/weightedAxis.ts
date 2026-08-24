/**
 * R7.3C §23 — le pli pondéré, extrait pour qu'un second axe ne le réinvente pas.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi une extraction plutôt qu'une copie
 * ---------------------------------------------------------------------------
 * `commercialIntelligence.ts` portait ce calcul depuis R7.1, et la mission
 * R7.3C demande un axe de plus — la maturité d'acquisition SOCIALE — qui doit
 * obéir exactement à la même discipline : un contributeur non observé (`null`)
 * quitte le dénominateur au lieu de valoir zéro, et la couverture devient la
 * confiance.
 *
 * Recopier vingt lignes aurait marché aujourd'hui et divergé dans six mois. La
 * divergence aurait porté sur la seule propriété que R7 défend : « ne pas savoir
 * n'est pas savoir le contraire ». Deux implémentations de cette phrase, c'est
 * une de trop.
 *
 * Le comportement est repris à l'identique — aucun seuil, aucun arrondi, aucun
 * ordre de calcul n'a été modifié. Les tests existants de l'axe commercial en
 * sont le témoin.
 */

export type AxisConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
export type AxisBand = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

/** Un contributeur retenu, avec de quoi le contester. */
export interface WeightedContribution {
  readonly key: string;
  /** `null` : non observable ici. Le poids quitte le dénominateur, il ne vaut pas zéro. */
  readonly ratio: number | null;
  readonly weight: number;
  readonly detail: string;
}

export interface ConfidenceThresholds {
  readonly high: number;
  readonly medium: number;
}

export interface WeightedAxisFold {
  /** 0..100, ou `null` quand rien n'a pu être observé. Jamais 0 par défaut. */
  readonly score: number | null;
  readonly band: AxisBand;
  readonly confidence: AxisConfidence;
  /** Part du poids total réellement observée. La mesure de ce qu'on sait. */
  readonly coverage: number;
  /** Ce qui n'a pas pu être observé — la liste de courses de la collecte suivante. */
  readonly missing: readonly string[];
  readonly reasons: readonly string[];
}

export function bandOf(score: number | null): AxisBand {
  if (score === null) return 'UNKNOWN';
  if (score >= 60) return 'HIGH';
  if (score >= 35) return 'MEDIUM';
  return 'LOW';
}

/**
 * Additionne des contributeurs pondérés en laissant les non-observés HORS du
 * dénominateur.
 *
 * C'est la même discipline que `score.ts` (`onMissing: neutral`) et pour la même
 * raison : diviser par un poids qu'on n'a pas mesuré transformerait un manque de
 * données en jugement. La différence est qu'ici la couverture n'est pas seulement
 * un garde-fou tardif — elle est PUBLIÉE, axe par axe, sous le nom de confiance.
 */
export function foldWeightedContributions(
  contributions: readonly WeightedContribution[],
  confidenceThresholds: ConfidenceThresholds,
): WeightedAxisFold {
  let earned = 0;
  let applicable = 0;
  let total = 0;
  const missing: string[] = [];
  const reasons: string[] = [];

  for (const contribution of contributions) {
    total += contribution.weight;
    if (contribution.ratio === null) {
      missing.push(contribution.key);
      continue;
    }
    applicable += contribution.weight;
    earned += contribution.ratio * contribution.weight;
    if (contribution.ratio > 0) reasons.push(contribution.detail);
  }

  const coverage = total > 0 ? applicable / total : 0;
  const score = applicable > 0 ? Math.round((earned / applicable) * 100) : null;
  const confidence: AxisConfidence =
    coverage <= 0
      ? 'NONE'
      : coverage >= confidenceThresholds.high
        ? 'HIGH'
        : coverage >= confidenceThresholds.medium
          ? 'MEDIUM'
          : 'LOW';

  return {
    score,
    band: bandOf(score),
    confidence,
    coverage: Math.round(coverage * 100) / 100,
    missing,
    reasons,
  };
}
