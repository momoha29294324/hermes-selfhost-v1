/**
 * HERMES-SALES-KNOWLEDGE-R1 §18, §19 — la RÉCUPÉRATION, bornée et déterministe.
 *
 * ---------------------------------------------------------------------------
 * §18 — récupérer, pas apprendre
 * ---------------------------------------------------------------------------
 * Aucun modèle n'est entraîné, ré-entraîné ni ajusté par ce round. Ce qui se
 * passe est plus simple et bien plus vérifiable : à chaque tour, on choisit
 * quelques principes pertinents et on les montre au modèle, comme on lui montre
 * déjà l'état de la conversation et les faits observés.
 *
 * La conséquence pratique est qu'un principe retiré de la bibliothèque cesse
 * d'agir au tour suivant. Rien n'est absorbé, rien ne persiste dans des poids
 * que personne ne sait relire.
 *
 * ---------------------------------------------------------------------------
 * §19 — pourquoi si peu
 * ---------------------------------------------------------------------------
 * Quatre principes au maximum. Ce n'est pas une limite de coût — le prompt en
 * supporterait quarante — c'est une limite d'EFFET. Un modèle à qui l'on donne
 * quarante consignes n'en suit aucune en particulier ; il en suit la moyenne,
 * et la moyenne de quarante conseils de vente est un message d'agence. Le
 * dépôt a déjà fait cette observation ailleurs, pour les exemplars, et s'était
 * arrêté à trois.
 *
 * Trois propriétés tiennent la sélection :
 *
 *   * **la pertinence** — l'étape du tour d'abord, le sujet ensuite ;
 *   * **la diversité** — au plus UN principe par sujet. Deux principes qui
 *     disent la même chose sous deux angles ne valent pas deux consignes : ils
 *     valent une consigne répétée, ce qui est exactement le défaut que §19
 *     appelle « duplicate principles spammed » ;
 *   * **le déterminisme** — à égalité, l'identifiant tranche. Deux appels avec
 *     les mêmes entrées rendent la même liste, sans quoi comparer deux
 *     rédactions n'apprendrait rien.
 */

import type { ObjectionTopic, QuestionTopic } from '@/lib/conversation/signals';
import type { ConversationGoal } from '@/lib/conversation/state';
import type { OfferStage } from '@/lib/conversation/offerProgression';
import type { AppointmentQualification } from '@/lib/sales/objective';
import type { PrincipleStage, SalesPrinciple } from '@/lib/sales/schema';
import type { SalesLibrary } from '@/lib/sales/library';

/** Combien de principes au plus dans un prompt. */
export const MAX_INJECTED_PRINCIPLES = 4;

export interface RetrievalContext {
  readonly goal: ConversationGoal;
  readonly offerStage: OfferStage;
  readonly questionTopic: QuestionTopic;
  readonly objectionTopic: ObjectionTopic;
  readonly appointmentQualification: AppointmentQualification;
}

/**
 * L'étape de la SOURCE qui correspond à ce tour.
 *
 * C'est la seule traduction entre le vocabulaire du dépôt (`ConversationGoal`,
 * `OfferStage`) et celui de la bibliothèque (`PrincipleStage`). Elle vit ici,
 * en un seul endroit, parce qu'une correspondance dispersée finirait par
 * diverger — et qu'une vidéo n'a pas à renommer les états de notre machine.
 *
 * `null` signifie « aucun principe n'a sa place dans ce tour ». Ce n'est pas un
 * défaut : une conversation qu'on referme ou qu'un humain reprend n'a pas
 * besoin de conseils de vente, et lui en donner serait précisément le mauvais
 * moment.
 */
export function salesStageFor(context: RetrievalContext): PrincipleStage | null {
  if (context.goal === 'AWAIT_HUMAN' || context.goal === 'ACKNOWLEDGE_AND_CLOSE') return null;
  if (context.offerStage === 'HOLD') return null;

  // Une objection posée l'emporte : y répondre est le travail du tour, quel que
  // soit le palier commercial par ailleurs.
  if (context.goal === 'HANDLE_OBJECTION' || context.objectionTopic !== 'NONE') return 'OBJECTION';

  if (
    context.offerStage === 'PROPOSE_CALL' ||
    context.goal === 'PROPOSE_CALL' ||
    context.appointmentQualification === 'QUALIFIED_FOR_CALL'
  ) {
    return 'APPOINTMENT';
  }

  if (context.offerStage === 'EXPLAIN_OFFER' || context.offerStage === 'EXPLAIN_MODEL') {
    return 'OFFER';
  }
  if (context.offerStage === 'EXPLORE_NEED' || context.goal === 'QUALIFY_LIGHTLY') {
    return 'QUALIFICATION';
  }
  return 'CONVERSATION';
}

/**
 * Les étapes SECONDAIRES, qui apportent le fond transversal.
 *
 * `CONVERSATION` en fait partout partie : les principes qui y vivent — le
 * registre du canal, le cadre plutôt que le script, l'échelle des pas — sont
 * vrais à tous les paliers, et les réserver à un seul les rendrait
 * inaccessibles là où ils servent le plus.
 */
function secondaryStages(primary: PrincipleStage): readonly PrincipleStage[] {
  if (primary === 'CONVERSATION') return ['FIRST_TOUCH'];
  if (primary === 'APPOINTMENT') return ['CONVERSATION'];
  if (primary === 'OFFER') return ['CONVERSATION', 'APPOINTMENT'];
  if (primary === 'OBJECTION') return ['CONVERSATION', 'OFFER'];
  if (primary === 'QUALIFICATION') return ['CONVERSATION', 'FIRST_TOUCH'];
  return ['CONVERSATION'];
}

/**
 * Les sujets de principe qu'une demande du prospect rend particulièrement
 * pertinents.
 *
 * Une table courte et explicite plutôt qu'une similarité calculée : on veut
 * pouvoir dire POURQUOI un principe est remonté, et « le score cosinus était
 * élevé » n'est pas une réponse qu'un opérateur peut vérifier.
 */
const QUESTION_AFFINITY: Readonly<Partial<Record<QuestionTopic, readonly string[]>>> = Object.freeze({
  CALL_REQUEST: ['GET_TO_THE_CALL', 'CALL_FRAMING'],
  HOW_IT_WORKS: ['VALUE_FIRST', 'RISK_REVERSAL'],
  WHAT_YOU_DO: ['VALUE_FIRST', 'CHANNEL_NATURE'],
  MORE_INFO: ['VALUE_FIRST', 'RISK_REVERSAL'],
  PRICE: ['RISK_REVERSAL'],
  GUARANTEE: ['RISK_REVERSAL'],
  RESULTS_PROOF: ['VALUE_FIRST'],
});

const OBJECTION_AFFINITY: Readonly<Partial<Record<ObjectionTopic, readonly string[]>>> =
  Object.freeze({
    TRUST: ['EXISTING_NOISE', 'NON_THREATENING_POSTURE'],
    ALREADY_HAS_PROVIDER: ['RISK_REVERSAL'],
    ALREADY_DOES_ADS: ['RISK_REVERSAL'],
    NO_TIME: ['SHORT_FOLLOW_UP'],
  });

function affinityTopics(context: RetrievalContext): ReadonlySet<string> {
  const topics = new Set<string>();
  for (const topic of QUESTION_AFFINITY[context.questionTopic] ?? []) topics.add(topic);
  for (const topic of OBJECTION_AFFINITY[context.objectionTopic] ?? []) topics.add(topic);
  return topics;
}

interface Scored {
  readonly principle: SalesPrinciple;
  readonly score: number;
}

/**
 * Choisit les principes à montrer au modèle pour CE tour.
 *
 * Ne lit que `library.injectable` — les principes écartés ne sont pas filtrés
 * ici, ils n'y sont pas (§20, garanti par le schéma). Un principe rejeté ne
 * peut donc pas remonter, même si un futur appelant oubliait un filtre.
 *
 * Rend un tableau vide plutôt que `null` quand rien ne convient : c'est une
 * liste, et une liste vide se traite sans branche particulière chez l'appelant.
 */
export function retrieveSalesPrinciples(
  library: SalesLibrary,
  context: RetrievalContext,
  max: number = MAX_INJECTED_PRINCIPLES,
): readonly SalesPrinciple[] {
  const primary = salesStageFor(context);
  if (primary === null) return Object.freeze([]);
  if (library.injectable.length === 0) return Object.freeze([]);

  const secondary = new Set(secondaryStages(primary));
  const affinity = affinityTopics(context);

  const scored: Scored[] = [];
  for (const principle of library.injectable) {
    let score = 0;
    if (principle.stage === primary) score += 3;
    else if (secondary.has(principle.stage)) score += 1;
    else continue; // hors sujet : un principe d'opérations n'aide aucun tour

    if (affinity.has(principle.topic)) score += 2;
    // À pertinence égale, ce qui est vrai TEL QUEL passe devant ce qui a dû
    // être transposé : une adaptation porte une part de notre interprétation,
    // un ADOPT porte la source seule.
    if (principle.classification === 'ADOPT') score += 1;
    if (principle.confidence === 'HIGH') score += 1;

    scored.push({ principle, score });
  }

  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.principle.id.localeCompare(b.principle.id)));

  // La diversité, appliquée au SUJET et non à l'étape : deux principes de la
  // même étape peuvent dire deux choses utiles, deux principes du même sujet
  // disent la même chose deux fois.
  const chosen: SalesPrinciple[] = [];
  const seenTopics = new Set<string>();
  for (const entry of scored) {
    if (chosen.length >= max) break;
    if (seenTopics.has(entry.principle.topic)) continue;
    seenTopics.add(entry.principle.topic);
    chosen.push(entry.principle);
  }

  return Object.freeze(chosen);
}
