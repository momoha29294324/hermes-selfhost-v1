/**
 * LEARNING-R1 §7 — OPERATOR_CONVERSATION_STYLE, un profil de CORRECTIONS.
 *
 * Ce profil ne décrit pas une personne. Il décrit ce qui se passe entre un
 * brouillon et le texte retenu, agrégé sur plusieurs tours. La distinction
 * n'est pas de la prudence rhétorique, elle change le type : aucune dimension
 * ici ne peut porter un âge, une origine, un trait de caractère ou un état de
 * santé (§22) — les dimensions sont des énumérations de rédaction, et il n'y a
 * pas de champ libre pour y glisser autre chose.
 *
 * Chaque dimension vaut `UNKNOWN` par défaut et ne le quitte que si l'effectif
 * le permet (§12). C'est la même règle que `StyleProfile` applique au prospect
 * depuis CONVERSATION-R1, pour la même raison : « un opérateur préfère les messages
 * courts » observé une fois est une anecdote, et une anecdote inscrite dans un
 * profil se met à gouverner toutes les rédactions suivantes.
 *
 * Aucun texte n'entre dans le profil. Les entrées sont des mesures et des codes
 * de transformation, produits par `compareOverride`.
 */

import type { DraftMetrics } from '@/lib/conversation/naturalness';
import type { Formality } from '@/lib/conversation/style';
import type { OverrideDelta } from '@/lib/learning/override';
import { rate, statusForSample, type Rate, type SignalStatus } from '@/lib/learning/sufficiency';

// ---------------------------------------------------------------------------
// Les dimensions
// ---------------------------------------------------------------------------

export type PreferredLength = 'VERY_SHORT' | 'SHORT' | 'MEDIUM' | 'LONG';

/**
 * Sur quoi une dimension repose — et c'est §3 de la mission, en un type.
 *
 * « un opérateur préfère les messages courts » et « un opérateur a validé des messages
 * moyens » ne sont pas la même affirmation. La première demande qu'il ait
 * RÉÉCRIT quelque chose ; la seconde dit seulement qu'il a laissé passer ce
 * qu'un modèle avait produit. Confondre les deux fait apprendre au système sa
 * propre voix en croyant apprendre celle d'un opérateur — l'erreur exacte que §3
 * décrit, appliquée au style au lieu de la performance.
 *
 *   REWRITTEN      — au moins un texte retenu diffère du brouillon. Préférence.
 *   VALIDATED_ONLY — tous les textes retenus sont ceux du modèle. Tolérance.
 *   NONE           — rien d'observé.
 */
export type DimensionBasis = 'REWRITTEN' | 'VALIDATED_ONLY' | 'NONE';
export type Tolerance = 'REMOVES' | 'KEEPS';
export type Intensity = 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * Une dimension observée, avec de quoi la contester.
 *
 * `value` vaut `UNKNOWN` tant que `status` est `INSUFFICIENT_DATA` : il n'y a
 * pas de chemin par lequel une valeur sortirait d'ici sans son effectif.
 */
export interface StyleDimension<T> {
  readonly value: T | 'UNKNOWN';
  readonly sample: Rate;
  readonly status: SignalStatus;
  /** Préférence ou simple tolérance. Jamais deviné : compté. */
  readonly basis: DimensionBasis;
}

export interface OperatorConversationStyle {
  /** La longueur des textes RETENUS, pas celle des brouillons. */
  readonly preferredLength: StyleDimension<PreferredLength>;
  /** Le plus grand nombre de questions observé dans un texte retenu. */
  readonly maxQuestions: StyleDimension<number>;
  /** Coupe-t-il les ouvertures d'accusé de réception que le modèle écrit ? */
  readonly genericOpeningTolerance: StyleDimension<Tolerance>;
  /** À quel point l'argumentaire survit à la relecture. */
  readonly pitchDirectness: StyleDimension<Intensity>;
  readonly preferredFormality: StyleDimension<Formality>;
  /** Garde-t-il un accusé de réception quand il en écrit un ? */
  readonly useOfAcknowledgements: StyleDimension<Tolerance>;
  /** À quel point la proposition d'échange survit à la relecture. */
  readonly ctaAggressiveness: StyleDimension<Intensity>;
  /** Le jargon de plaquette survit-il ? `REMOVES` = français conversationnel. */
  readonly conversationalFrench: StyleDimension<Tolerance>;
  /** Tours échangés avant que l'offre soit expliquée. Médiane. */
  readonly averageTurnsBeforePitch: StyleDimension<number>;
  /** Tours échangés avant qu'un échange soit proposé. Médiane. */
  readonly averageTurnsBeforeCall: StyleDimension<number>;
  /** Combien de couples brouillon/texte retenu ont nourri ce profil. */
  readonly observedOverrides: number;
  /** Combien de textes humains ont été mesurés, brouillon ou non. */
  readonly observedHumanTexts: number;
}

/** Une correction observée, réduite à ce que le profil consomme. */
export interface OverrideObservation {
  readonly deltas: readonly OverrideDelta[];
  /** Les mesures du texte RETENU. */
  readonly sent: DraftMetrics;
  /** Vrai quand le brouillon portait déjà la chose qu'on mesure. */
  readonly draftHadGenericOpening: boolean;
  readonly draftHadPitch: boolean;
  readonly draftHadCall: boolean;
  readonly draftHadJargon: boolean;
  readonly sentHadGenericOpening: boolean;
  /**
   * Le texte retenu diffère-t-il du brouillon, ne serait-ce que d'un caractère ?
   *
   * C'est la question qui sépare une préférence d'une tolérance, et elle se
   * pose sur les TEXTES, pas sur les transformations reconnues : un humain qui
   * retouche un mot a fait un choix, même si aucun code de `OverrideDelta` ne
   * sait le nommer. Compter ce cas comme « il n'a rien changé » rendrait
   * invisible la seule chose qu'on cherche.
   */
  readonly rewritten: boolean;
}

/** Un texte humain sans brouillon en face. Il nourrit la longueur, rien d'autre. */
export interface HumanTextObservation {
  readonly sent: DraftMetrics;
}

export interface VoiceProfileInput {
  readonly overrides: readonly OverrideObservation[];
  readonly humanTexts: readonly HumanTextObservation[];
  /** Nombre de tours avant explication de l'offre, un par conversation observée. */
  readonly turnsBeforePitch: readonly number[];
  /** Nombre de tours avant proposition d'échange, un par conversation observée. */
  readonly turnsBeforeCall: readonly number[];
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

const UNKNOWN_DIMENSION = <T>(sample: Rate, basis: DimensionBasis = 'NONE'): StyleDimension<T> =>
  Object.freeze({ value: 'UNKNOWN' as const, sample, status: sample.status, basis });

/**
 * La provenance DOMINANTE d'un corpus de textes retenus.
 *
 * Pas « au moins un a été réécrit » : un seul message retouché parmi trente
 * approuvés ne transforme pas vingt-neuf approbations en préférences. La
 * bascule se fait à la majorité, ce qui donne la lecture juste dans les deux
 * cas extrêmes et la lecture prudente entre les deux.
 */
function basisOf(observations: readonly OverrideObservation[]): DimensionBasis {
  if (observations.length === 0) return 'NONE';
  const rewritten = observations.filter((item) => item.rewritten).length;
  return rewritten * 2 >= observations.length ? 'REWRITTEN' : 'VALIDATED_ONLY';
}

/**
 * Une dimension binaire : « il retire » contre « il garde ».
 *
 * Le dénominateur est le nombre d'OCCASIONS, pas le nombre de tours : on ne
 * peut pas observer qu'un opérateur retire une ouverture générique sur un
 * brouillon qui n'en portait pas. Compter ces tours-là au dénominateur ferait
 * baisser le taux à mesure que le modèle s'améliore — la mesure dirait alors le
 * contraire de ce qui se passe.
 */
function toleranceDimension(removals: number, occasions: number): StyleDimension<Tolerance> {
  const sample = rate(removals, occasions);
  if (sample.status === 'INSUFFICIENT_DATA' || sample.value === null) {
    return UNKNOWN_DIMENSION(sample, occasions === 0 ? 'NONE' : 'REWRITTEN');
  }
  return Object.freeze({
    value: sample.value >= 0.5 ? 'REMOVES' : 'KEEPS',
    status: sample.status,
    sample,
    basis: 'REWRITTEN' as const,
  });
}

/**
 * Une dimension d'intensité : à quel point une chose SURVIT à la relecture.
 *
 * `HIGH` veut dire « ce que le modèle propose reste » — donc un argumentaire
 * direct assumé. `LOW` veut dire « il le coupe presque toujours ».
 */
function intensityDimension(survivals: number, occasions: number): StyleDimension<Intensity> {
  const sample = rate(survivals, occasions);
  if (sample.status === 'INSUFFICIENT_DATA' || sample.value === null) {
    return UNKNOWN_DIMENSION(sample, occasions === 0 ? 'NONE' : 'REWRITTEN');
  }
  const value: Intensity = sample.value >= 0.66 ? 'HIGH' : sample.value >= 0.33 ? 'MEDIUM' : 'LOW';
  return Object.freeze({ value, status: sample.status, sample, basis: 'REWRITTEN' as const });
}

/**
 * Les bandes de longueur des textes RETENUS.
 *
 * Les bornes valent pour un message de conversation, pas pour un premier
 * message : 80 caractères, c'est « ok, et ça vous ramène des demandes ? » ;
 * au-delà de 500, on n'est plus dans un DM. Elles sont écrites ici plutôt
 * qu'importées du budget de naturalité parce que celui-ci répond à une autre
 * question — « quelle longueur ce tour justifie-t-il » — et qu'aligner les deux
 * ferait croire qu'une observation valide une consigne.
 */
export function lengthBandOf(chars: number): PreferredLength {
  if (chars < 80) return 'VERY_SHORT';
  if (chars < 200) return 'SHORT';
  if (chars < 500) return 'MEDIUM';
  return 'LONG';
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const low = sorted[middle - 1];
  const high = sorted[middle];
  if (low === undefined || high === undefined) return null;
  return (low + high) / 2;
}

/**
 * Une dimension numérique fondée sur une médiane.
 *
 * La médiane plutôt que la moyenne : un unique message de 900 caractères
 * déplacerait une moyenne calculée sur cinq observations, et la préférence
 * observée deviendrait celle de l'exception.
 */
function medianDimension(values: readonly number[], basis: DimensionBasis): StyleDimension<number> {
  const sample = rate(values.length, values.length);
  const status = statusForSample(values.length, sample.interval);
  const stamped: Rate = Object.freeze({ ...sample, status });
  const value = median(values);
  if (status === 'INSUFFICIENT_DATA' || value === null) return UNKNOWN_DIMENSION(stamped, basis);
  return Object.freeze({ value, status, sample: stamped, basis });
}

/**
 * Construit le profil. Fonction pure : mêmes observations, même profil.
 */
export function buildOperatorStyleProfile(input: VoiceProfileInput): OperatorConversationStyle {
  const { overrides, humanTexts } = input;

  const allSent = [...overrides.map((item) => item.sent), ...humanTexts.map((item) => item.sent)];

  /**
   * Les couples où un humain a RÉELLEMENT réécrit.
   *
   * Toutes les dimensions qui affirment quelque chose sur le geste d'un opérateur
   * — il coupe, il garde, il simplifie — sont calculées sur ce sous-ensemble et
   * sur aucun autre. Les calculer sur l'ensemble reviendrait à mesurer ce que
   * le modèle écrit et à l'attribuer à un opérateur : sur un corpus où il approuve
   * sans rien changer, « il retire les ouvertures génériques » ne dirait
   * qu'une chose — que le modèle n'en écrit pas.
   */
  const rewritten = overrides.filter((item) => item.rewritten);
  const contentBasis = basisOf(overrides);

  // --- longueur ----------------------------------------------------------
  const lengthSample = rate(allSent.length, allSent.length);
  const lengthStatus = statusForSample(allSent.length, lengthSample.interval);
  const medianChars = median(allSent.map((metrics) => metrics.chars));
  const preferredLength: StyleDimension<PreferredLength> =
    lengthStatus === 'INSUFFICIENT_DATA' || medianChars === null
      ? UNKNOWN_DIMENSION(Object.freeze({ ...lengthSample, status: lengthStatus }), contentBasis)
      : Object.freeze({
          value: lengthBandOf(medianChars),
          status: lengthStatus,
          sample: Object.freeze({ ...lengthSample, status: lengthStatus }),
          basis: contentBasis,
        });

  // --- questions ---------------------------------------------------------
  const questionCounts = allSent.map((metrics) => metrics.questions);
  const questionSample = rate(questionCounts.length, questionCounts.length);
  const questionStatus = statusForSample(questionCounts.length, questionSample.interval);
  const maxQuestions: StyleDimension<number> =
    questionStatus === 'INSUFFICIENT_DATA' || questionCounts.length === 0
      ? UNKNOWN_DIMENSION(Object.freeze({ ...questionSample, status: questionStatus }), contentBasis)
      : Object.freeze({
          value: Math.max(...questionCounts),
          status: questionStatus,
          sample: Object.freeze({ ...questionSample, status: questionStatus }),
          basis: contentBasis,
        });

  // --- occasions et survies ---------------------------------------------
  const openingOccasions = rewritten.filter((item) => item.draftHadGenericOpening).length;
  const openingRemovals = rewritten.filter((item) => item.deltas.includes('GENERIC_OPENING_REMOVED')).length;

  const pitchOccasions = rewritten.filter((item) => item.draftHadPitch).length;
  const pitchSurvivals = pitchOccasions - rewritten.filter((item) => item.deltas.includes('PITCH_REMOVED')).length;

  const callOccasions = rewritten.filter((item) => item.draftHadCall).length;
  const callSurvivals = callOccasions - rewritten.filter((item) => item.deltas.includes('CTA_REMOVED')).length;

  const jargonOccasions = rewritten.filter((item) => item.draftHadJargon).length;
  const jargonRemovals = rewritten.filter((item) => item.deltas.includes('VOCABULARY_SIMPLIFIED')).length;

  // Un accusé de réception qu'il ÉCRIT lui-même, là où le brouillon n'en avait
  // pas, dit l'inverse de « il coupe les ouvertures » — et les deux peuvent
  // coexister selon le tour. On les mesure séparément plutôt que d'en déduire
  // l'un de l'autre.
  const acknowledgementOccasions = rewritten.length;
  const acknowledgementKept = rewritten.filter((item) => item.sentHadGenericOpening).length;

  // --- registre ----------------------------------------------------------
  // La formalité retenue se lit sur le jargon : un texte sans formule de
  // plaquette est au mieux NEUTRAL, jamais FORMAL. C'est une lecture partielle
  // et elle est assumée — deviner « CASUAL » demanderait de lire le tutoiement,
  // qui n'est pas observable sur un corpus où le vouvoiement est la norme du
  // métier.
  const formalitySample = rate(jargonOccasions - jargonRemovals, rewritten.length);
  const preferredFormality: StyleDimension<Formality> =
    formalitySample.status === 'INSUFFICIENT_DATA' || formalitySample.value === null
      ? UNKNOWN_DIMENSION(formalitySample, rewritten.length === 0 ? 'NONE' : 'REWRITTEN')
      : Object.freeze({
          value: formalitySample.value >= 0.5 ? ('FORMAL' as const) : ('NEUTRAL' as const),
          status: formalitySample.status,
          sample: formalitySample,
          basis: 'REWRITTEN' as const,
        });

  return Object.freeze({
    preferredLength,
    maxQuestions,
    genericOpeningTolerance: toleranceDimension(openingRemovals, openingOccasions),
    pitchDirectness: intensityDimension(pitchSurvivals, pitchOccasions),
    preferredFormality,
    useOfAcknowledgements: toleranceDimension(
      acknowledgementOccasions - acknowledgementKept,
      acknowledgementOccasions,
    ),
    ctaAggressiveness: intensityDimension(callSurvivals, callOccasions),
    conversationalFrench: toleranceDimension(jargonRemovals, jargonOccasions),
    averageTurnsBeforePitch: medianDimension(input.turnsBeforePitch, 'VALIDATED_ONLY'),
    averageTurnsBeforeCall: medianDimension(input.turnsBeforeCall, 'VALIDATED_ONLY'),
    observedOverrides: overrides.length,
    observedHumanTexts: allSent.length,
  });
}

/** Le profil vide : rien n'a été observé, et le type le dit partout. */
export const EMPTY_STYLE_LEARNING: OperatorConversationStyle = buildOperatorStyleProfile({
  overrides: [],
  humanTexts: [],
  turnsBeforePitch: [],
  turnsBeforeCall: [],
});
