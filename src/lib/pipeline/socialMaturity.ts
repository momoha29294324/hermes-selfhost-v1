import { estimateCadence, type CadenceEstimate } from '@/lib/pipeline/instagramCadence';
import { classifyFreshness, type Freshness, type ProfileObservation } from '@/lib/pipeline/instagramObservation';
import {
  bandOf,
  foldWeightedContributions,
  type AxisBand,
  type AxisConfidence,
  type ConfidenceThresholds,
  type WeightedContribution,
} from '@/lib/pipeline/weightedAxis';
import type { VisualMaturityLevel } from '@/lib/pipeline/instagramMaturity';

/**
 * R7.3C §17, §23, §24 — la MATURITÉ D'ACQUISITION SOCIALE, tenue à part de
 * la maturité web.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi un axe séparé, et non un contributeur de plus
 * ---------------------------------------------------------------------------
 * La tentation évidente était d'ajouter `social_acquisition_maturity` aux neuf
 * contributeurs de `acquisitionMaturity`. Ça aurait produit UN nombre, et ce
 * nombre aurait effacé la seule information que le round cherche :
 *
 *     WEB MATURITY    LOW
 *     SOCIAL MATURITY HIGH
 *
 * Cette configuration-là est un fait commercial, pas une moyenne. Elle décrit
 * une entreprise qui sait se montrer et ne sait pas convertir — c'est-à-dire
 * exactement le prospect que R7.1 classait mal. Fondre les deux axes rendrait
 * « moyennement mature » et l'on perdrait la phrase.
 *
 * ---------------------------------------------------------------------------
 * Ce que cet axe NE dit pas (§24)
 * ---------------------------------------------------------------------------
 * `SOCIAL MATURITY HIGH` n'implique PAS `NEED = 0`. Un compte Instagram tenu,
 * régulier, avec des « à la une » travaillés, en face d'un site sans réservation,
 * sans devis et sans mesure, décrit un manque commercial RÉEL — pas son absence.
 * Cet axe mesure une capacité déjà en place sur un canal ; le besoin se mesure
 * ailleurs, sur ce qui manque, et rien ici n'y touche.
 *
 * ---------------------------------------------------------------------------
 * Le nombre d'abonnés n'apparaît nulle part (§13)
 * ---------------------------------------------------------------------------
 * Ni dans les contributeurs, ni dans les seuils, ni dans une pondération de
 * confiance. Il est collecté comme CONTEXTE et il s'arrête là. Un test le vérifie
 * en faisant varier `followersCount` de 12 à 100 000 sur des observations par
 * ailleurs identiques : ni le score, ni la bande, ni la confiance, ni une seule
 * preuve publiée ne bougent. L'interdiction est donc exécutée, pas seulement
 * écrite.
 */

/** §17 — les signaux de complétude, INDÉPENDANTS les uns des autres. */
export interface ProfileCompletenessSignals {
  /** `null` partout signifie « non lisible », jamais « absent ». */
  readonly bioPresent: boolean | null;
  readonly websitePresent: boolean | null;
  readonly categoryPresent: boolean | null;
  readonly contactCtaPresent: boolean | null;
  readonly highlightsPresent: boolean | null;
  readonly highlightsCount: number | null;
}

export interface SocialMaturityWeights {
  readonly posting_recency: number;
  readonly posting_cadence: number;
  readonly profile_completeness: number;
  readonly highlights: number;
  readonly visual_maturity: number;
}

export interface SocialMaturityConfig {
  readonly key: string;
  readonly version: string;
  readonly weights: SocialMaturityWeights;
  readonly confidence: ConfidenceThresholds;
  /**
   * §22 — la maturité visuelle entre-t-elle dans l'axe ?
   *
   * Un interrupteur explicite plutôt qu'un choix implicite : la classification
   * visuelle est un jugement d'agent, et un round doit pouvoir mesurer ce que
   * l'axe vaut SANS elle avant de mesurer ce qu'elle lui ajoute. Les deux
   * réglages sont comparés dans le rapport, jamais choisis en silence.
   */
  readonly includeVisualMaturity: boolean;
  /**
   * Part minimale du poids de l'axe qui doit avoir été RÉELLEMENT observée pour
   * qu'un score soit écrit. Voir le plancher de couverture dans
   * `assessSocialMaturity`.
   */
  readonly minimumCoverage: number;
}

export interface SocialMaturityResult {
  readonly key: 'socialAcquisitionMaturity';
  readonly score: number | null;
  readonly band: AxisBand;
  readonly confidence: AxisConfidence;
  readonly coverage: number;
  readonly contributions: readonly WeightedContribution[];
  readonly missing: readonly string[];
  readonly reasons: readonly string[];
  /** L'échantillon sur lequel la cadence a été estimée, republié tel quel. */
  readonly cadence: CadenceEstimate;
  readonly completeness: ProfileCompletenessSignals;
  /** §34 — l'âge de l'observation, exposé à côté du verdict qu'elle porte. */
  readonly freshness: Freshness;
  readonly observedAt: string | null;
  /** L'état de collecte, republié : un score sans son état se lit comme une certitude. */
  readonly observationState: ProfileObservation['state'] | 'NOT_COLLECTED';
}

/**
 * Recopiés en clair pour être contestables. Ils découpent des régimes
 * ordinaires, pas des prospects : « publié cette semaine », « ce mois-ci », « ce
 * trimestre », « ce semestre », « plus rien ».
 */
export const RECENCY_STEPS: readonly { readonly withinDays: number; readonly ratio: number; readonly label: string }[] = [
  { withinDays: 7, ratio: 1, label: 'publication de moins d’une semaine' },
  { withinDays: 30, ratio: 0.8, label: 'publication de moins d’un mois' },
  { withinDays: 90, ratio: 0.5, label: 'publication de moins d’un trimestre' },
  { withinDays: 180, ratio: 0.2, label: 'publication de moins de six mois' },
];

/**
 * R7.4 — exporté pour que l'ÉCART d'acquisition sociale se calcule avec les
 * mêmes ratios que la maturité, et non avec un second barème.
 *
 * Deux barèmes pour « ce compte est-il vivant ? » divergeraient, et la
 * divergence porterait sur la seule chose que R7.4 ajoute : un signal capable de
 * FAIRE MONTER un prospect. Le miroir doit refléter exactement ce qu'il inverse.
 */
export const CADENCE_RATIOS: Readonly<Record<CadenceEstimate['cadence'], number | null>> = {
  HIGH_FREQUENCY: 1,
  ACTIVE: 0.75,
  SPORADIC: 0.35,
  INACTIVE: 0,
  UNKNOWN: null,
};

const VISUAL_RATIOS: Readonly<Record<VisualMaturityLevel, number | null>> = {
  HIGHLY_MATURE: 1,
  PROFESSIONAL: 0.8,
  CONSISTENT: 0.55,
  BASIC: 0.3,
  AMATEUR: 0.1,
  UNKNOWN: null,
};

/**
 * Extrait les signaux de complétude d'une observation.
 *
 * Un fait absent de `facts` n'a pas été lu : il rend `null`. Un fait lu et vide
 * rend `false`. Les deux ne sont pas la même chose, et c'est la distinction que
 * tout ce round défend.
 */
export function completenessOf(observation: ProfileObservation): ProfileCompletenessSignals {
  const { facts } = observation;
  const nonEmpty = (value: string | undefined): boolean | null =>
    value === undefined ? null : value.trim().length > 0;

  return {
    bioPresent: nonEmpty(facts.biography?.value),
    websitePresent: nonEmpty(facts.externalWebsite?.value),
    categoryPresent: nonEmpty(facts.category?.value),
    contactCtaPresent: facts.contactCtaPresent?.value ?? null,
    highlightsPresent: facts.highlightsPresent?.value ?? null,
    highlightsCount: facts.highlightsCount?.value ?? null,
  };
}

/** La part de signaux de complétude PRÉSENTS parmi ceux réellement lus. */
function completenessRatio(signals: ProfileCompletenessSignals): { ratio: number | null; detail: string } {
  const checked: { key: string; present: boolean }[] = [];
  const push = (key: string, value: boolean | null): void => {
    if (value !== null) checked.push({ key, present: value });
  };
  push('bio', signals.bioPresent);
  push('site', signals.websitePresent);
  push('catégorie', signals.categoryPresent);
  push('bouton de contact', signals.contactCtaPresent);

  if (checked.length === 0) {
    return { ratio: null, detail: 'aucun élément de profil lisible — complétude inconnue' };
  }
  const present = checked.filter((entry) => entry.present);
  const absent = checked.filter((entry) => !entry.present);
  return {
    ratio: present.length / checked.length,
    detail:
      `${present.length}/${checked.length} élément(s) de profil renseigné(s)` +
      (present.length > 0 ? ` : ${present.map((entry) => entry.key).join(', ')}` : '') +
      (absent.length > 0 ? ` ; absent(s) : ${absent.map((entry) => entry.key).join(', ')}` : ''),
  };
}

export interface SocialMaturityInput {
  readonly observation: ProfileObservation;
  readonly visualMaturity: VisualMaturityLevel | null;
  readonly config: SocialMaturityConfig;
  readonly now: Date;
}

/**
 * Les états dans lesquels AUCUN score social n'est écrit.
 *
 * Un compte privé n'est pas un compte inactif, un handle introuvable ne dit rien
 * de l'entreprise, et une contradiction d'identité interdit d'attribuer quoi que
 * ce soit à ce prospect. Dans ces cas, l'axe rend `null` avec son motif — il
 * quitte donc le calcul au lieu de le tirer vers le bas.
 */
const NO_SCORE_STATES: readonly ProfileObservation['state'][] = [
  'PRIVATE',
  'NOT_FOUND',
  'LOGIN_REQUIRED',
  'CHALLENGE',
  'RATE_LIMITED',
  'SESSION_BLOCKED',
  'IDENTITY_CONTRADICTION',
  'UNREADABLE',
];

export function assessSocialMaturity(input: SocialMaturityInput): SocialMaturityResult {
  const { observation, config, now } = input;
  const cadence = estimateCadence(observation.posts, now);
  const completeness = completenessOf(observation);
  const freshness = classifyFreshness(observation.observedAt, now);

  const shell = {
    key: 'socialAcquisitionMaturity' as const,
    cadence,
    completeness,
    freshness,
    observedAt: observation.observedAt,
    observationState: observation.state,
  };

  const noScore = (reason: string): SocialMaturityResult => ({
    ...shell,
    score: null,
    band: 'UNKNOWN',
    confidence: 'NONE',
    coverage: 0,
    contributions: [],
    missing: ['posting_recency', 'posting_cadence', 'profile_completeness', 'highlights', 'visual_maturity'],
    reasons: [reason],
  });

  if (NO_SCORE_STATES.includes(observation.state)) {
    return noScore(`état de collecte ${observation.state} — aucun score social ne peut être écrit : ${observation.stateDetail}`);
  }

  /**
   * §10 — l'attribution exige une identité CORROBORÉE, pas seulement lisible.
   *
   * Le cas qui a rendu ce garde-fou nécessaire est réel : un prospect dont le
   * site est bâti sur un gabarit portait, comme preuve de handle, le compte
   * Instagram de l'éditeur du gabarit. Le rail a ouvert exactement le compte
   * demandé, l'a lu sans incident, et l'état valait donc `PARTIAL` — un état
   * parfaitement sain. Sans ce test, la maturité sociale d'un éditeur de
   * logiciel à 308 000 abonnés serait entrée au crédit d'un artisan.
   *
   * Un état de collecte dit « avons-nous pu lire ? ». L'identité dit « avons-nous
   * le droit d'attribuer ? ». Les deux sont nécessaires, et le second ne se
   * déduit pas du premier.
   */
  if (observation.identity.verdict !== 'MATCH') {
    return noScore(
      `identité ${observation.identity.verdict} — rien de ce profil n’est attribué à ce prospect : ${observation.identity.reason}`,
    );
  }

  const contributions: WeightedContribution[] = [];

  const days = cadence.daysSinceLastPost;
  const step = days === null ? undefined : RECENCY_STEPS.find((entry) => days <= entry.withinDays);
  contributions.push({
    key: 'posting_recency',
    weight: config.weights.posting_recency,
    ratio: days === null ? null : (step?.ratio ?? 0),
    detail:
      days === null
        ? 'aucune date de publication observée — récence inconnue, pas nulle'
        : `${step?.label ?? 'aucune publication depuis plus de six mois'} (${days} j)`,
  });

  contributions.push({
    key: 'posting_cadence',
    weight: config.weights.posting_cadence,
    ratio: CADENCE_RATIOS[cadence.cadence],
    detail: `cadence ${cadence.cadence} — ${cadence.method}`,
  });

  const completenessScore = completenessRatio(completeness);
  contributions.push({
    key: 'profile_completeness',
    weight: config.weights.profile_completeness,
    ratio: completenessScore.ratio,
    detail: completenessScore.detail,
  });

  /**
   * §18 — la présence, et au plus le nombre apparent. Jamais l'ouverture d'une
   * story : `highlightsPresent === null` vaut `UNKNOWN` et sort du dénominateur.
   */
  const highlightsCount = completeness.highlightsCount;
  contributions.push({
    key: 'highlights',
    weight: config.weights.highlights,
    ratio:
      completeness.highlightsPresent === null
        ? null
        : !completeness.highlightsPresent
          ? 0
          : highlightsCount === null
            ? 0.6
            : highlightsCount >= 3
              ? 1
              : 0.6,
    detail:
      completeness.highlightsPresent === null
        ? 'présence de stories à la une non établie depuis le profil — inconnue, jamais supposée absente'
        : completeness.highlightsPresent
          ? `${highlightsCount ?? 'nombre inconnu de'} story(s) à la une`
          : 'aucune story à la une visible sur le profil',
  });

  if (config.includeVisualMaturity) {
    const level = input.visualMaturity;
    contributions.push({
      key: 'visual_maturity',
      weight: config.weights.visual_maturity,
      ratio: level === null ? null : VISUAL_RATIOS[level],
      detail: level === null ? 'aucune revue visuelle enregistrée' : `maturité visuelle ${level}`,
    });
  }

  const fold = foldWeightedContributions(contributions, config.confidence);

  /**
   * Le PLANCHER DE COUVERTURE — le garde-fou que la première collecte réelle a
   * rendu indispensable.
   *
   * ---------------------------------------------------------------------------
   * Ce qui s'est passé sans lui
   * ---------------------------------------------------------------------------
   * En collecte anonyme, Instagram ne sert aucun horodatage : `posting_recency`
   * et `posting_cadence` — 64 % du poids de l'axe — sont absents pour TOUS les
   * profils. Ne restaient que la complétude, les à la une et la maturité
   * visuelle. Un compte dont la bio et le site sont renseignés et qui affiche
   * trois à la une obtenait alors, en toute logique arithmétique,
   * **100/100 en confiance LOW** : tout ce qui était mesurable était présent, et
   * ce « tout » valait un quart de l'axe.
   *
   * Branché sur la priorité, ce 100 retirait jusqu'à 27 points à chaque prospect
   * observé — 32 baisses, 0 hausse. Une démotion générale, appliquée sur la foi
   * d'un axe mesuré au quart.
   *
   * ---------------------------------------------------------------------------
   * Pourquoi un plancher plutôt qu'un rééquilibrage des poids
   * ---------------------------------------------------------------------------
   * Rééquilibrer aurait fait disparaître le symptôme en gardant la faute :
   * l'axe aurait continué d'affirmer une maturité d'acquisition sans avoir
   * observé la moindre publication. Or « ce compte est-il vivant ? » n'est pas un
   * détail de pondération — c'est la question. Un profil complet et muet depuis
   * deux ans n'est pas une acquisition structurée.
   *
   * Le plancher exige donc qu'au moins l'un des deux COMPTAGES ait été observé.
   * En deçà, l'axe rend `null` : il quitte le calcul au lieu de le tirer, ce qui
   * est exactement le tri-état appliqué partout ailleurs dans R7.
   *
   * Les contributions restent publiées — on voit ce qui a été mesuré, et pourquoi
   * cela n'a pas suffi.
   */
  if (fold.coverage < config.minimumCoverage) {
    return {
      ...shell,
      contributions,
      score: null,
      band: 'UNKNOWN',
      confidence: fold.confidence,
      coverage: fold.coverage,
      missing: fold.missing,
      reasons: [
        `couverture ${fold.coverage} sous le plancher de ${config.minimumCoverage} — ` +
          'aucun des deux comptages (récence, cadence) n’a été observé. ' +
          'Un profil renseigné n’est pas une acquisition structurée tant qu’on n’a pas vu s’il publie.',
      ],
    };
  }

  return { ...shell, contributions, ...fold, band: bandOf(fold.score) };
}

/**
 * L'axe pour un prospect dont Instagram n'a JAMAIS été ouvert.
 *
 * Distinct d'un score nul et distinct d'un échec de collecte : c'est le cas de
 * 244 des 286 prospects, et le confondre avec « social faible » ferait monter
 * artificiellement tout prospect sans compte connu.
 */
export function notCollectedSocialMaturity(now: Date): SocialMaturityResult {
  return {
    key: 'socialAcquisitionMaturity',
    score: null,
    band: 'UNKNOWN',
    confidence: 'NONE',
    coverage: 0,
    contributions: [],
    missing: ['posting_recency', 'posting_cadence', 'profile_completeness', 'highlights', 'visual_maturity'],
    reasons: ['aucune observation Instagram — jamais collecté, ni haut ni bas'],
    cadence: estimateCadence([], now),
    completeness: {
      bioPresent: null,
      websitePresent: null,
      categoryPresent: null,
      contactCtaPresent: null,
      highlightsPresent: null,
      highlightsCount: null,
    },
    freshness: 'UNKNOWN',
    observedAt: null,
    observationState: 'NOT_COLLECTED',
  };
}
