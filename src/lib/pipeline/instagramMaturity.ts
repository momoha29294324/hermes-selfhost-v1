/**
 * R7.2 §11–§12 — le vocabulaire de la maturité d'acquisition Instagram.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce module existe avant la collecte
 * ---------------------------------------------------------------------------
 * R7.1 s'est arrêté sur une conclusion négative et assumée : le moteur ne sait
 * pas déprioriser correctement un artisan dont la maturité vit sur Instagram,
 * parce que nous ne stockons que son handle. Aucune pondération ne corrige ce
 * manque — seule une collecte le peut.
 *
 * Ce module ne collecte rien et ne branche aucun modèle de vision. Il fixe le
 * VOCABULAIRE dans lequel la réponse sera écrite, pour que la spécification
 * R7.3 soit calibrable dès maintenant et pour que le jeu de revue humaine
 * puisse déjà AFFICHER le trou plutôt que de le taire.
 *
 * ---------------------------------------------------------------------------
 * Ce que le vocabulaire refuse
 * ---------------------------------------------------------------------------
 * Fermé, et `UNKNOWN` en fait partie de plein droit : c'est aujourd'hui la
 * seule valeur que nos données permettent d'écrire, et c'est la réponse
 * honnête. Un classement qui n'aurait pas de case « je ne sais pas » forcerait
 * une supposition — exactement ce que le §2 de CLAUDE.md interdit.
 *
 * Le nombre d'abonnés n'est PAS un critère et n'apparaît volontairement dans
 * aucune règle de ce fichier. Il peut être observé comme contexte ; il ne dit
 * rien de la qualité commerciale d'un compte, et un seuil d'abonnés est
 * précisément le raccourci que R7 existe pour ne pas prendre.
 */

/** Les six seules valeurs qu'une classification pourra porter. */
export const VISUAL_MATURITY_LEVELS = [
  'AMATEUR',
  'BASIC',
  'CONSISTENT',
  'PROFESSIONAL',
  'HIGHLY_MATURE',
  'UNKNOWN',
] as const;

export type VisualMaturityLevel = (typeof VISUAL_MATURITY_LEVELS)[number];

/**
 * Les signaux que R7.3 devra collecter pour qu'une classification soit possible.
 *
 * Fermé lui aussi : un signal absent d'ici ne peut pas apparaître dans une
 * explication, et un signal présent ici sans collecteur reste `null` — jamais
 * une valeur par défaut.
 */
export const INSTAGRAM_SIGNALS = [
  'post_count',
  'last_post_at',
  'posting_cadence',
  'profile_completeness',
  'bio_cta',
  'highlights',
  'visual_consistency',
  'follower_count',
] as const;

export type InstagramSignal = (typeof INSTAGRAM_SIGNALS)[number];

/**
 * Ce qu'un compte Instagram nous aura appris, une fois collecté.
 *
 * Tout est `null` par défaut, et `null` veut dire « jamais collecté » — pas
 * « zéro ». Un compte sans publication et un compte jamais ouvert ne sont pas
 * la même chose, et c'est la distinction qui porte toute la valeur du round.
 */
export interface InstagramObservations {
  readonly postCount?: number | null;
  /** Date de la dernière publication observée. */
  readonly lastPostAt?: Date | null;
  /** Publications par mois sur la fenêtre récente observée. */
  readonly postsPerMonth?: number | null;
  /** Part des éléments de profil renseignés, 0..1 (nom, bio, lien, catégorie…). */
  readonly profileCompleteness?: number | null;
  /** La bio porte-t-elle un appel à l'action lisible ? */
  readonly bioHasCta?: boolean | null;
  readonly highlightCount?: number | null;
  /**
   * Cohérence visuelle du feed, 0..1. C'est le seul signal qui demandera un
   * jugement plutôt qu'un comptage — d'où sa confiance nécessairement plus
   * basse, et d'où l'interdiction qu'il décide seul.
   */
  readonly visualConsistency?: number | null;
  /** Contexte uniquement. Aucune règle de ce module ne le lit. */
  readonly followerCount?: number | null;
}

export interface VisualMaturityAssessment {
  readonly level: VisualMaturityLevel;
  /** Les faits qui portent le niveau. Vide quand le niveau est `UNKNOWN`. */
  readonly evidence: readonly string[];
  readonly confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
  /** Les signaux qu'il aurait fallu pour trancher. La liste de courses de R7.3. */
  readonly missing: readonly InstagramSignal[];
}

/**
 * Les signaux sans lesquels aucun niveau ne peut être écrit.
 *
 * Trois comptages, aucun jugement : c'est délibéré. Un niveau qui reposerait
 * d'abord sur `visualConsistency` serait une opinion déguisée en mesure, et il
 * dériverait à chaque changement de modèle.
 */
const REQUIRED_SIGNALS: readonly InstagramSignal[] = ['post_count', 'last_post_at', 'posting_cadence'];

/**
 * Classe un compte — ou refuse de le faire.
 *
 * Aujourd'hui, sur la totalité du corpus, cette fonction rend `UNKNOWN` : aucun
 * rail ne remplit `InstagramObservations`. C'est le résultat attendu et il est
 * publié tel quel dans le jeu de revue. Les seuils ci-dessous sont un point de
 * départ explicite, à corriger comme le reste après la revue humaine — ils ne
 * sont branchés sur aucune décision commerciale et n'écrivent nulle part.
 */
export function classifyVisualMaturity(observations: InstagramObservations = {}): VisualMaturityAssessment {
  const missing: InstagramSignal[] = [];
  if (observations.postCount === undefined || observations.postCount === null) missing.push('post_count');
  if (observations.lastPostAt === undefined || observations.lastPostAt === null) missing.push('last_post_at');
  if (observations.postsPerMonth === undefined || observations.postsPerMonth === null) missing.push('posting_cadence');
  if (observations.profileCompleteness === undefined || observations.profileCompleteness === null) {
    missing.push('profile_completeness');
  }
  if (observations.bioHasCta === undefined || observations.bioHasCta === null) missing.push('bio_cta');
  if (observations.highlightCount === undefined || observations.highlightCount === null) missing.push('highlights');
  if (observations.visualConsistency === undefined || observations.visualConsistency === null) {
    missing.push('visual_consistency');
  }

  const blocked = REQUIRED_SIGNALS.filter((signal) => missing.includes(signal));
  if (blocked.length > 0) {
    return { level: 'UNKNOWN', evidence: [], confidence: 'NONE', missing };
  }

  const postCount = observations.postCount ?? 0;
  const perMonth = observations.postsPerMonth ?? 0;
  const completeness = observations.profileCompleteness ?? 0;
  const consistency = observations.visualConsistency ?? 0;
  const highlights = observations.highlightCount ?? 0;

  const evidence = [
    `${postCount} publication(s)`,
    `${perMonth.toFixed(1)} publication(s)/mois sur la fenêtre observée`,
    `profil renseigné à ${Math.round(completeness * 100)} %`,
  ];
  if (observations.bioHasCta === true) evidence.push('appel à l’action lisible dans la bio');
  if (highlights > 0) evidence.push(`${highlights} story(s) à la une`);
  if (observations.visualConsistency !== undefined && observations.visualConsistency !== null) {
    evidence.push(`cohérence visuelle ${Math.round(consistency * 100)} %`);
  }

  const level: VisualMaturityLevel =
    postCount >= 300 && perMonth >= 4 && completeness >= 0.8 && consistency >= 0.75
      ? 'HIGHLY_MATURE'
      : postCount >= 100 && perMonth >= 2 && completeness >= 0.6
        ? 'PROFESSIONAL'
        : postCount >= 30 && perMonth >= 1
          ? 'CONSISTENT'
          : postCount >= 10
            ? 'BASIC'
            : 'AMATEUR';

  // La confiance suit la couverture, jamais la netteté du verdict.
  const optional: readonly InstagramSignal[] = ['profile_completeness', 'bio_cta', 'highlights', 'visual_consistency'];
  const observedOptional = optional.filter((signal) => !missing.includes(signal)).length;
  const confidence: VisualMaturityAssessment['confidence'] =
    observedOptional === optional.length ? 'HIGH' : observedOptional >= 2 ? 'MEDIUM' : 'LOW';

  return { level, evidence, confidence, missing };
}

/** La ligne à afficher tant que rien n'est collecté. Dire le trou, pas le taire. */
export function describeInstagramGap(assessment: VisualMaturityAssessment): string {
  if (assessment.level !== 'UNKNOWN') {
    return `${assessment.level} (confiance ${assessment.confidence}) — ${assessment.evidence.join(' ; ')}`;
  }
  return `UNKNOWN — jamais collecté (${assessment.missing.join(', ')})`;
}
