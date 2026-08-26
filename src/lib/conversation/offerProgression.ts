/**
 * HERMES-CONVERSATION-R2 §9 à §13 — amener l'offre sans la pousser, et refuser
 * d'inventer ce que personne n'a écrit.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module décide, et ce qu'il ne décide pas
 * ---------------------------------------------------------------------------
 * Il décide OÙ EN EST la conversation sur l'échelle commerciale — comprendre,
 * creuser, expliquer, parler du modèle, proposer un échange — et ce que ce
 * palier autorise à dire. Il ne rédige rien : aucune phrase de vente ne vit
 * ici, aucun gabarit, aucun exemple figé. §10 est explicite (« ne hardcode pas
 * cet exemple comme template ») et le type de sortie le tient : il n'a aucun
 * champ textuel.
 *
 * Il ne recalcule pas non plus la maturité : `assessOfferReadiness`
 * (LEARNING-R1) la lit déjà, sur les signaux de `readSignals`. Un second
 * barème « pour la progression » serait une seconde lecture du même message,
 * et les deux finiraient par se contredire au cas limite.
 *
 * ---------------------------------------------------------------------------
 * §11 — le modèle de rémunération, et pourquoi il ne peut pas partir seul
 * ---------------------------------------------------------------------------
 * « Nos intérêts sont alignés : notre rémunération dépend des résultats » est
 * un POSITIONNEMENT qu'un opérateur envisage, et c'est légitime. Ce n'est pas une
 * tournure : c'est une condition commerciale. Tant que ses termes exacts — sur
 * quoi porte la rémunération, à partir de quand, avec quelle contrepartie —
 * n'existent nulle part dans ce dépôt, une machine qui l'écrirait engagerait
 * quelque chose que personne ne sait honorer.
 *
 * Le dépôt a été inspecté pour cette mission : il porte `case_studies` (une
 * preuve chiffrée, canonique, autorisée au PREMIER contact seulement), les
 * campagnes et les niches — et AUCUNE politique tarifaire ni contractuelle.
 * `COMMERCIAL_POLICY_STATUS` vaut donc `MISSING`, en toutes lettres et comme
 * un littéral de type : le jour où cette politique existera, il faudra changer
 * la signature, donc passer par une revue, plutôt que basculer une condition.
 *
 * La conséquence est mécanique et vit dans `autonomy.ts` : un tour qui appelle
 * le modèle commercial ne s'envoie pas tout seul, il escalade.
 */

import type { PriceSubjectReading } from '@/lib/sales/priceSubject';
import type { ConversationSignals } from '@/lib/conversation/signals';
import type { ConversationState } from '@/lib/conversation/state';
import { assessOfferReadiness, type OfferReadiness } from '@/lib/learning/offer';
import type { ReplyCategory } from '@/lib/replies/taxonomy';

// ---------------------------------------------------------------------------
// L'état de la politique commerciale
// ---------------------------------------------------------------------------

/**
 * Existe-t-il, dans ce dépôt, des conditions commerciales opposables ?
 *
 * Une union à une seule valeur aujourd'hui. Ce n'est pas une maladresse : elle
 * documente une ABSENCE constatée, et elle rend impossible d'écrire une branche
 * « si la politique existe » qui compilerait sans que la politique existe.
 */
export type CommercialPolicyStatus = 'MISSING';

/**
 * L'état constaté au 21 août 2026.
 *
 * Cherché dans `config/` (campagnes, niches, ICP, scoring), dans les tables
 * (`case_studies` porte une preuve, pas un contrat) et dans les garde-fous
 * (`allowedCaseStudyClaim` vaut `null` en réponse). Rien n'y définit un prix,
 * une fourchette, une garantie, une durée d'engagement ni un modèle de
 * rémunération.
 */
export const COMMERCIAL_POLICY_STATUS: CommercialPolicyStatus = 'MISSING';

// ---------------------------------------------------------------------------
// L'échelle
// ---------------------------------------------------------------------------

/**
 * Le palier commercial du tour à venir.
 *
 * Une ÉCHELLE, pas un script : §9 interdit explicitement de dérouler des étapes
 * par nombre de messages. Le palier se lit sur ce que la personne vient de
 * dire, pas sur un compteur — quelqu'un qui demande le prix au deuxième message
 * est mûr, quelqu'un qui répond poliment au sixième ne l'est pas.
 */
export type OfferStage =
  /** On ne sait pas encore de quoi cette personne a besoin. */
  | 'UNDERSTAND_SITUATION'
  /** Un besoin se dessine : creuser d'un cran, sans pitcher. */
  | 'EXPLORE_NEED'
  /** Le moment d'expliquer ce que Hermes fait, court et concret. */
  | 'EXPLAIN_OFFER'
  /** La question porte sur le modèle commercial : prix, garantie, conditions. */
  | 'EXPLAIN_MODEL'
  /** Le contexte est mûr : proposer un échange. */
  | 'PROPOSE_CALL'
  /** Rien à avancer : la conversation est close ou un humain l'a reprise. */
  | 'HOLD';

export interface OfferProgression {
  readonly readiness: OfferReadiness;
  readonly stage: OfferStage;
  /** Des codes, jamais des phrases libres : ils entrent dans des rapports. */
  readonly reasons: readonly string[];
  /**
   * Le palier demande-t-il des conditions commerciales que le dépôt n'a pas ?
   *
   * `true` ⇒ la réponse honnête n'est pas rédigeable sans inventer, et
   * `autonomy.ts` escalade. C'est un CONSTAT, pas une interdiction de plus :
   * l'interdiction, elle, vit dans les garde-fous et dans le grounding.
   */
  readonly needsCommercialPolicy: boolean;
  /** L'état de la politique, transporté pour que les rapports le disent. */
  readonly commercialPolicy: CommercialPolicyStatus;
  /**
   * §11/§12 — l'autorisation de mentionner un modèle à la performance.
   *
   * Littéral `false`, comme dans `assessOfferReadiness` et pour la même raison :
   * aucune branche ne peut produire `true`, et c'est le TYPE qui le dit.
   */
  readonly performanceModelMentionAllowed: false;
  /** Un prix peut-il être annoncé ? Non, et le type le dit. */
  readonly pricingAnswerable: false;
  /** Une garantie peut-elle être offerte ? Non, et le type le dit. */
  readonly guaranteeAnswerable: false;
}

export interface OfferProgressionInput {
  readonly category: ReplyCategory;
  readonly signals: ConversationSignals;
  readonly state: ConversationState;
  /**
   * HERMES-TRIAL-COST-VS-POST-TRIAL-PRICING-R1 §8 — le sujet du PRIX demandé.
   *
   * Optionnel, et l'omettre reproduit le comportement d'avant ce round au
   * champ près : sans lui, toute question de prix réclame des conditions
   * commerciales, comme sous r4.
   *
   * Il existe parce que ce module portait la QUATRIÈME cause du faux refus du
   * 23 août. `questionTopic === 'PRICE'` faisait passer le palier en
   * `EXPLAIN_MODEL`, donc `needsCommercialPolicy` à vrai, donc
   * `HUMAN_ESCALATION:commercial_policy_missing` — un cran après les trois
   * portes déjà corrigées, et pour la même raison qu'elles.
   */
  readonly priceSubject?: PriceSubjectReading | null;
}

/** Les questions qui portent sur le MODÈLE commercial et pas sur le métier. */
const MODEL_QUESTION_TOPICS: ReadonlySet<ConversationSignals['questionTopic']> = new Set([
  'PRICE',
  'GUARANTEE',
]);

/**
 * Les questions auxquelles une explication de l'offre répond réellement.
 *
 * HERMES-ACQUISITION-SERVICE-TRUTH-R1 — trois sujets s'ajoutent, et trois
 * restent dehors.
 *
 * Entrent : « concrètement tu fais quoi ? », « qu'est-ce qui se passe quand un
 * lead arrive ? » et « tu fais Google Ads ? ». Les trois demandent qu'on
 * explique le service, et c'est la définition de ce palier.
 *
 * Restent dehors : le budget publicitaire, les accès et l'exclusivité. Ce sont
 * des questions de MODALITÉ posées par quelqu'un qui n'a pas forcément demandé
 * ce qu'on fait, et les traiter comme un feu vert pour expliquer l'offre
 * transformerait « tu bosses avec mon concurrent ? » en occasion de pitcher.
 * Elles gardent donc le palier que leur maturité rend, et leur réponse vient de
 * la facette correspondante — pas du palier.
 */
const OFFER_QUESTION_TOPICS: ReadonlySet<ConversationSignals['questionTopic']> = new Set([
  'WHAT_YOU_DO',
  'WHO_ARE_YOU',
  'HOW_IT_WORKS',
  'MORE_INFO',
  'ACQUISITION_METHOD',
  'LEAD_HANDLING',
  'SEARCH_ADS',
  // HERMES-TRIAL-IMPLEMENTATION-ROUTING-R1 — les deux sujets de l'essai
  // entrent ici, et surtout PAS dans `MODEL_QUESTION_TOPICS`.
  //
  // La différence porte tout. `EXPLAIN_MODEL` pose `needsCommercialPolicy` à
  // vrai — « la réponse honnête n'est pas rédigeable » — et fait escalader le
  // tour. C'est exact d'une question de prix d'après-essai ; c'est faux de
  // « pendant les 7 jours tu mets quoi en place ? », dont la réponse est écrite
  // à deux endroits : `TRIAL_FACTS` et `ACQUISITION_TRUTH`.
  //
  // `EXPLAIN_OFFER` est le palier juste : on demande ce que l'offre contient,
  // et c'est ce palier qui autorise l'essai à entrer dans le prompt.
  'TRIAL_IMPLEMENTATION',
  'TRIAL_DURATION',
]);

/**
 * Lit le palier commercial du tour.
 *
 * L'ordre des tests EST la politique, et il se lit de haut en bas : une
 * conversation close n'a pas de palier ; une demande d'échange l'emporte sur
 * tout le reste, parce que faire patienter quelqu'un qui veut parler est la
 * seule erreur vraiment coûteuse ; une question sur le modèle passe avant une
 * explication de l'offre, parce que répondre à côté pour « avancer » est la
 * faute la plus fréquente d'un commercial, humain comme machine.
 */
export function assessOfferProgression(input: OfferProgressionInput): OfferProgression {
  const { category, signals, state } = input;
  const readinessAssessment = assessOfferReadiness({
    category,
    signals,
    coveredTopics: state.coveredTopics,
  });
  const readiness = readinessAssessment.readiness;
  const reasons = [...readinessAssessment.reasons];

  const closed =
    state.humanNeeded ||
    state.goal === 'ACKNOWLEDGE_AND_CLOSE' ||
    state.goal === 'AWAIT_HUMAN' ||
    category === 'NOT_INTERESTED' ||
    category === 'UNSUBSCRIBE' ||
    category === 'AUTO_REPLY' ||
    category === 'BOUNCE';

  // §8 — une question de PRIX dont le sujet porte une vérité canonique.
  // Fail-closed sur les trois bords : pas de sujet passé, sujet non couvert, ou
  // objection de budget ⇒ faux, donc le comportement d'avant ce round.
  const pricingCoveredByTruth =
    signals.questionTopic === 'PRICE' &&
    signals.objectionTopic !== 'NO_BUDGET' &&
    (input.priceSubject?.covered ?? false);

  const stage = ((): OfferStage => {
    if (closed) {
      reasons.push('conversation_closed_or_human');
      return 'HOLD';
    }
    if (MODEL_QUESTION_TOPICS.has(signals.questionTopic) || signals.objectionTopic === 'NO_BUDGET') {
      reasons.push(`model_question:${signals.questionTopic}`);
      return 'EXPLAIN_MODEL';
    }
    if (signals.explicitCallRequest) {
      reasons.push('explicit_call_request');
      return 'PROPOSE_CALL';
    }
    if (readiness === 'HIGH' && signals.callReadiness === 'HIGH') {
      reasons.push('readiness_high_and_call_ready');
      return 'PROPOSE_CALL';
    }
    if (OFFER_QUESTION_TOPICS.has(signals.questionTopic)) {
      reasons.push(`offer_question:${signals.questionTopic}`);
      return 'EXPLAIN_OFFER';
    }
    // §9 — sans question directe, l'offre ne s'explique qu'une fois un besoin
    // établi. Un simple « oui » ne suffit pas, et c'est ce que `MEDIUM` dit :
    // quelque chose s'est dit, pas encore assez pour pitcher.
    if (readiness === 'HIGH') {
      reasons.push('readiness_high');
      return 'EXPLAIN_OFFER';
    }
    if (readiness === 'MEDIUM') {
      reasons.push('readiness_medium');
      return 'EXPLORE_NEED';
    }
    reasons.push('readiness_low');
    return 'UNDERSTAND_SITUATION';
  })();

  return Object.freeze({
    readiness,
    stage,
    reasons: Object.freeze(reasons),
    // Le palier « modèle » est le seul qui réclame des conditions commerciales.
    // Un prospect qui demande « c'est combien ? » ne veut pas une explication du
    // métier : il veut un chiffre — et il n'y en a pas, SAUF quand le chiffre
    // demandé est un de ceux que ce dépôt a écrits.
    //
    // §8 — le palier ne bouge PAS pour autant, et c'est voulu : `EXPLAIN_MODEL`
    // reste la bonne lecture d'une question de prix, et c'est lui qui autorise
    // l'essai à entrer dans le prompt (`trialDisclosure`). Ce qui change est le
    // CONSTAT qu'il porte — « la réponse honnête n'est pas rédigeable » — et ce
    // constat est faux quand une vérité canonique couvre le sujet demandé.
    //
    // Deux bords restent fermés : une objection de budget ne se raffine pas —
    // « je n'ai pas le budget » porte sur ce que NOUS coûtons —, et une
    // question de garantie non plus, puisqu'elle n'est pas une question de prix.
    needsCommercialPolicy: stage === 'EXPLAIN_MODEL' && !pricingCoveredByTruth,
    commercialPolicy: COMMERCIAL_POLICY_STATUS,
    performanceModelMentionAllowed: false as const,
    pricingAnswerable: false as const,
    guaranteeAnswerable: false as const,
  });
}

/**
 * §12 — le palier autorise-t-il seulement d'ÉVOQUER un modèle à la performance ?
 *
 * Rend toujours `false`, et deux raisons s'y superposent : la maturité ne peut
 * jamais être `LOW` pour ce sujet (§12), et les conditions n'existent pas
 * (§11). La fonction existe pour que le refus soit APPELABLE — un futur round
 * qui écrirait la politique commerciale devra la modifier, et le compilateur
 * lui montrera tous les appelants concernés.
 */
export function performanceModelAllowed(_progression: OfferProgression): false {
  return false;
}
