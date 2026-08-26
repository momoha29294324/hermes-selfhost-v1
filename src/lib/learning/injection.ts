/**
 * LEARNING-R1 §20 — l'adaptateur vers le Conversation Brain, ÉTEINT par défaut.
 *
 * Ce fichier prépare la seule chose que §20 demande : un point d'entrée par
 * lequel un futur round pourra faire lire au cerveau ce que la boucle a appris.
 * Il ne l'allume pas. Trois propriétés le tiennent :
 *
 *   1. **Le défaut est `false`, et il est lu à chaque appel.** `envBool(…,
 *      false)` : une variable absente, vide ou mal orthographiée laisse
 *      l'injection éteinte. Il n'y a pas de valeur par défaut « pratique ».
 *
 *   2. **Éteint, la fonction rend `null`.** Pas un objet vide, pas un bloc
 *      vide : `null`. C'est ce qui permet au cerveau de n'ajouter *aucune*
 *      ligne à son prompt — pas même une ligne blanche — et donc de produire
 *      exactement le prompt d'avant cette mission (§25.27).
 *
 *   3. **Allumé, la fonction peut TOUJOURS rendre `null`.** Une dimension de
 *      style dont le statut vaut `INSUFFICIENT_DATA` ne produit aucune
 *      directive, et une injection sans directive ni exemplar n'existe pas.
 *      C'est §11 et §12 appliqués au bon endroit : l'apprentissage n'entre dans
 *      la rédaction que lorsqu'il repose sur quelque chose, jamais parce qu'un
 *      drapeau est levé.
 *
 * Ce que ce fichier N'a pas : aucun import de rédaction, aucun accès base,
 * aucun modèle. Il transforme des mesures en phrases de prompt, rien de plus.
 */

import { envBool } from '@/lib/env';
import type { Exemplar } from '@/lib/learning/exemplars';
import type { OfferReadiness } from '@/lib/learning/offer';
import type { OperatorConversationStyle } from '@/lib/learning/voiceProfile';

export const LEARNING_INJECTION_ENV = 'OUTBOUND_LEARNING_INJECTION_ENABLED';

/** Vrai uniquement si la variable est explicitement positionnée. */
export function learningInjectionEnabled(): boolean {
  return envBool(LEARNING_INJECTION_ENV, false);
}

export interface LearningInjection {
  /** Des consignes de rédaction, dérivées de corrections répétées. */
  readonly styleDirectives: readonly string[];
  /** Les exemplars pertinents, PAR RÉFÉRENCE — jamais leur contenu (§22). */
  readonly exemplarRefs: readonly string[];
  /** La maturité pour l'offre, lue sur le tour courant. */
  readonly offerReadiness: OfferReadiness | null;
}

export interface LearningInjectionInput {
  readonly style: OperatorConversationStyle;
  readonly exemplars: readonly Exemplar[];
  readonly offerReadiness: OfferReadiness | null;
  /**
   * Force l'état du drapeau, pour les tests.
   *
   * Absent en production : la valeur vient de l'environnement, comme partout
   * ailleurs dans le dépôt.
   */
  readonly enabled?: boolean;
}

/** Combien d'exemplars au plus dans un prompt. Trois suffisent à donner le ton. */
export const MAX_INJECTED_EXEMPLARS = 3;

/**
 * Traduit une dimension soutenue en consigne.
 *
 * Une dimension `UNKNOWN` ne produit rien : il n'y a pas de phrase honnête à
 * écrire à partir de « on ne sait pas ». Une dimension `EARLY_SIGNAL` en
 * produit une, prudente — et l'effectif reste visible dans le rapport, pas dans
 * le prompt : un modèle à qui on écrit « n=7 » n'en fait rien de bon.
 */
function directivesFor(style: OperatorConversationStyle): string[] {
  const lines: string[] = [];

  // §3 — seule une dimension fondée sur des RÉÉCRITURES devient une consigne.
  // Une dimension `VALIDATED_ONLY` dit ce qu'un humain a laissé passer, pas ce
  // qu'il préfère ; l'écrire dans un prompt ferait apprendre au modèle sa
  // propre voix en croyant apprendre celle d'un opérateur.
  const supported = (dimension: { value: unknown; basis: string }): boolean =>
    dimension.value !== 'UNKNOWN' && dimension.basis === 'REWRITTEN';

  if (supported(style.preferredLength)) {
    lines.push(`Longueur observée des réponses retenues : ${style.preferredLength.value}.`);
  }
  if (supported(style.maxQuestions)) {
    lines.push(`Jamais plus de ${style.maxQuestions.value} question(s) dans un tour.`);
  }
  if (style.genericOpeningTolerance.value === 'REMOVES') {
    lines.push("N'ouvre pas par un accusé de réception générique : il est systématiquement coupé.");
  }
  if (style.conversationalFrench.value === 'REMOVES') {
    lines.push('Aucune formule de plaquette : elles sont systématiquement retirées.');
  }
  if (style.pitchDirectness.value === 'LOW') {
    lines.push("N'empile pas d'argumentaire : il est le plus souvent retiré.");
  }
  if (style.ctaAggressiveness.value === 'LOW') {
    lines.push("Ne propose pas d'échange de ta propre initiative : la proposition est le plus souvent retirée.");
  }

  return lines;
}

/**
 * Construit l'injection, ou rend `null`.
 *
 * `null` est le cas NORMAL de ce round. Il signifie « le cerveau ne change
 * rien », et c'est ce qui rend la mission réversible sans revert : éteindre la
 * variable suffit.
 */
export function buildLearningInjection(input: LearningInjectionInput): LearningInjection | null {
  const enabled = input.enabled ?? learningInjectionEnabled();
  if (!enabled) return null;

  const styleDirectives = directivesFor(input.style);
  const exemplarRefs = input.exemplars.slice(0, MAX_INJECTED_EXEMPLARS).map((exemplar) => exemplar.prospectId);

  if (styleDirectives.length === 0 && exemplarRefs.length === 0) return null;

  return Object.freeze({
    styleDirectives: Object.freeze(styleDirectives),
    exemplarRefs: Object.freeze(exemplarRefs),
    offerReadiness: input.offerReadiness,
  });
}

/**
 * Rend le bloc que le prompt lirait.
 *
 * La maturité pour l'offre est transmise comme une OBSERVATION, jamais comme
 * une autorisation : le bloc ne dit pas « tu peux présenter l'offre », il dit
 * ce que le tour porte. §16 réserve la décision à un round ultérieur, et une
 * phrase permissive glissée ici la prendrait à sa place.
 */
export function renderLearningBlock(injection: LearningInjection): string {
  const lines: string[] = ['CE QUI A ÉTÉ OBSERVÉ SUR LES CORRECTIONS PRÉCÉDENTES'];
  for (const directive of injection.styleDirectives) lines.push(`- ${directive}`);
  if (injection.exemplarRefs.length > 0) {
    lines.push(`- conversations comparables déjà observées : ${injection.exemplarRefs.length}`);
  }
  if (injection.offerReadiness !== null) {
    lines.push(
      `- maturité de ce tour pour une explication de l'offre : ${injection.offerReadiness} (observation, pas une autorisation)`,
    );
  }
  return lines.join('\n');
}
