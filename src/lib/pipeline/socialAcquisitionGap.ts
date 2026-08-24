import { estimateCadence, type CadenceEstimate } from '@/lib/pipeline/instagramCadence';
import { CADENCE_RATIOS, RECENCY_STEPS } from '@/lib/pipeline/socialMaturity';
import type { ProfileObservation } from '@/lib/pipeline/instagramObservation';
import type { SocialMaturityProfile } from '@/lib/config/schema';

/**
 * R7.4 — l'ÉCART d'acquisition sociale, qui n'est pas l'inverse de la maturité.
 *
 * ---------------------------------------------------------------------------
 * Le défaut que ce module corrige
 * ---------------------------------------------------------------------------
 * R7.3D branche l'observation Instagram sur UN seul endroit : la maturité
 * effective, par `web + blend × max(0, social − web)`. Le `max(0, …)` est
 * délibéré et reste juste — un Instagram faible ne prouve pas que le SITE ne
 * mesure rien — mais il a une conséquence que le round a mesurée sans détour :
 *
 *     22 baisses, 0 hausse, 264 inchangés.
 *
 * L'intelligence sociale ne sait donc que SOUSTRAIRE. Elle représente
 * correctement « ce compte est tenu, donc l'acquisition est déjà structurée »
 * et n'a aucun moyen de représenter la phrase symétrique que la mission R7.4
 * pose : « ce compte leur appartient, nous l'avons lu, et il ne publie plus ».
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce n'est PAS un assouplissement du `max(0, …)`
 * ---------------------------------------------------------------------------
 * L'option évidente — autoriser le social à faire BAISSER la maturité — a été
 * examinée et refusée, pour la raison exacte qui l'avait fait écrire :
 * la maturité répond à « son acquisition est-elle déjà structurée ? », et une
 * preuve d'absence sur un canal n'est pas une preuve d'absence sur l'autre.
 * Relâcher l'asymétrie ferait monter TOUT prospect au compte négligé, y compris
 * ceux dont le site mesure, vend et convertit.
 *
 * L'écart appartient donc à un autre axe : le BESOIN. Cet axe demande déjà
 * « quel manque RÉEL et OBSERVABLE savons-nous corriger ? », il exige déjà que
 * le manque soit démontré POSITIVEMENT (`checked_absent` vaut 1, `not_checked`
 * vaut `null`), et il porte déjà le miroir `gapRatio` — « ce qui a été cherché
 * et NON vu ». Un compte que l'entreprise possède, que nous avons ouvert, et
 * dont nous avons MESURÉ qu'il ne publie plus, est un manque de cette famille,
 * au même titre qu'un site lu sans tarif affiché.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module calcule, et ce qu'il ne calcule pas
 * ---------------------------------------------------------------------------
 * Il calcule la moitié OBSERVATIONNELLE de la question : « avons-nous mesuré un
 * écart, et de combien ? » Les portes qu'il applique portent toutes sur la
 * PREUVE — le compte est-il le leur, l'avons-nous lu, avons-nous vu s'il
 * publie.
 *
 * Il ne décide PAS si cet écart est un besoin commercial. Cette seconde
 * question a besoin du fit et de la capacité, qui sont des axes, et elle est
 * donc tranchée dans le moteur (`commercialIntelligence.ts`), là où les axes
 * vivent. La séparation est volontaire : « avons-nous mesuré ? » et
 * « pouvons-nous en faire quelque chose ? » sont deux questions, et les
 * confondre est précisément l'erreur que R7 existe pour ne plus commettre.
 */

/** Une porte de preuve, publiée avec son verdict pour être contestée. */
export interface SocialGapGate {
  readonly key: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface SocialChannelGap {
  /**
   * 0..1 — la part du canal social qui MANQUE, ou `null` quand une porte de
   * preuve a refusé.
   *
   * `null` est le tri-état de R7 appliqué une fois de plus : le contributeur
   * quitte le dénominateur du besoin au lieu d'y entrer à zéro. Ne pas savoir
   * si un compte est vivant n'est ni un besoin, ni son absence.
   */
  readonly ratio: number | null;
  /** L'inverse publié à côté : ce qui a été observé de vivant sur le canal. */
  readonly liveness: number | null;
  readonly detail: string;
  readonly gates: readonly SocialGapGate[];
  /** L'échantillon qui a servi, republié tel quel — un verdict sans lui se lit comme une certitude. */
  readonly cadence: CadenceEstimate;
}

/**
 * Les états de collecte dans lesquels un écart peut être MESURÉ.
 *
 * Volontairement plus étroit que la liste inverse de `socialMaturity` :
 * `NOT_FOUND` en fait partie là-bas parce qu'il ne produit aucun score, et il
 * est refusé ici pour la raison exacte qui le rend tentant — un handle
 * introuvable RESSEMBLE à un canal mort, et n'en est pas un. Nous n'avons rien
 * lu ; nous ne savons donc pas s'il publie.
 */
const READ_STATES: readonly ProfileObservation['state'][] = ['OBSERVED', 'PARTIAL'];

export interface SocialChannelGapInput {
  readonly observation: ProfileObservation;
  readonly profile: SocialMaturityProfile;
  readonly now: Date;
}

/**
 * Mesure l'écart d'acquisition sociale d'un profil observé.
 *
 * ---------------------------------------------------------------------------
 * Les trois portes de PREUVE, et pourquoi elles sont plus strictes que l'axe
 * ---------------------------------------------------------------------------
 *   identity_corroborated  le compte est-il le leur ? `MATCH` seulement. Un
 *                          `UNCORROBORATED` a déjà coûté cher une fois — le
 *                          compte Instagram de l'éditeur d'un gabarit de site
 *                          porté au crédit d'un artisan — et attribuer un
 *                          MANQUE au mauvais compte est la même faute dans
 *                          l'autre sens ;
 *   profile_read           le profil a-t-il été ouvert et lu ? Un compte privé,
 *                          introuvable ou illisible ne dit RIEN de sa vitalité ;
 *   liveness_measured      avons-nous vu s'il publie ? Les DEUX comptages —
 *                          récence et cadence — sont exigés.
 *
 * Cette dernière porte est délibérément plus stricte que le plancher de
 * couverture de l'axe social, qui se contente de l'un des deux. La raison tient
 * en une phrase, et c'est la même que celle qui a fait ajouter un quatrième
 * état à `independent_operator` en R7.3B : **une affirmation qui fait MONTER un
 * prospect doit être mieux prouvée qu'une affirmation qui le fait descendre.**
 * L'axe social ne peut que retirer de la priorité ; l'écart peut en ajouter.
 * Ils ne méritent donc pas le même niveau de preuve.
 *
 * ---------------------------------------------------------------------------
 * Le barème n'est pas nouveau — c'est le miroir de l'existant
 * ---------------------------------------------------------------------------
 * `liveness` est la moyenne des DEUX MÊMES contributeurs que l'axe social
 * (`posting_recency`, `posting_cadence`), avec LEURS ratios et LEURS poids, lus
 * dans le même fichier de profil. L'écart est `1 − liveness`, exactement comme
 * `gapRatio()` inverse `groupRatio()` partout ailleurs dans l'axe du besoin.
 *
 * Aucun seuil n'est introduit ici, et c'est le point : « INACTIVE ⇒ +20 » aurait
 * été un nombre décidé pour un effet, tandis que celui-ci n'est qu'une lecture
 * inversée de ratios écrits avant la première collecte et épinglés par des
 * tests. Les seuls signaux retenus sont les deux COMPTAGES ; ni la complétude
 * du profil, ni les stories à la une, ni la maturité visuelle n'entrent — un
 * compte soigné mais muet est le cas que ce module doit savoir dire, pas le cas
 * qu'il doit adoucir.
 *
 * `followers_count` n'apparaît nulle part, ni comme signal ni comme seuil de
 * confiance. Un compte à 40 abonnés et un compte à 13 000 abonnés, muets depuis
 * la même durée, rendent le même écart — un test l'exécute.
 */
export function assessSocialChannelGap(input: SocialChannelGapInput): SocialChannelGap {
  const { observation, profile, now } = input;
  const cadence = estimateCadence(observation.posts, now);
  const gates: SocialGapGate[] = [];

  const identityOk = observation.identity.verdict === 'MATCH';
  gates.push({
    key: 'identity_corroborated',
    passed: identityOk,
    detail: identityOk
      ? `identité MATCH — le compte @${observation.identity.observedUsername ?? observation.expectedHandle} est rattaché à ce prospect`
      : `identité ${observation.identity.verdict} — aucun écart n’est attribué à ce prospect : ${observation.identity.reason}`,
  });

  const readOk = READ_STATES.includes(observation.state);
  gates.push({
    key: 'profile_read',
    passed: readOk,
    detail: readOk
      ? `profil lu (${observation.state})`
      : `état de collecte ${observation.state} — le profil n’a pas été lu, sa vitalité reste inconnue`,
  });

  const days = cadence.daysSinceLastPost;
  const recencyRatio = days === null ? null : (RECENCY_STEPS.find((entry) => days <= entry.withinDays)?.ratio ?? 0);
  const cadenceRatio = CADENCE_RATIOS[cadence.cadence];
  const livenessMeasured = recencyRatio !== null && cadenceRatio !== null;
  gates.push({
    key: 'liveness_measured',
    passed: livenessMeasured,
    detail: livenessMeasured
      ? `récence et cadence observées — ${cadence.cadence}, dernière publication il y a ${days} j`
      : `vitalité non mesurée (récence ${days === null ? 'inconnue' : 'connue'}, cadence ${cadence.cadence}) — ` +
        'un compte dont on n’a pas vu les publications n’est ni vivant ni mort',
  });

  const refused = gates.find((gate) => !gate.passed);
  if (refused !== undefined || recencyRatio === null || cadenceRatio === null) {
    return {
      ratio: null,
      liveness: null,
      detail: refused?.detail ?? 'vitalité non mesurée',
      gates,
      cadence,
    };
  }

  const recencyWeight = profile.weights.posting_recency;
  const cadenceWeight = profile.weights.posting_cadence;
  const total = recencyWeight + cadenceWeight;
  if (total <= 0) {
    return {
      ratio: null,
      liveness: null,
      detail: 'les deux comptages pèsent zéro dans le profil social — aucun écart n’est calculable',
      gates,
      cadence,
    };
  }

  const liveness = (recencyRatio * recencyWeight + cadenceRatio * cadenceWeight) / total;
  const ratio = 1 - liveness;

  return {
    ratio: Math.round(ratio * 1000) / 1000,
    liveness: Math.round(liveness * 1000) / 1000,
    detail:
      `canal social possédé et lu : ${Math.round(liveness * 100)}% de vitalité observée ` +
      `(${cadence.cadence}, dernière publication il y a ${days} j) — ${Math.round(ratio * 100)}% d’écart`,
    gates,
    cadence,
  };
}
