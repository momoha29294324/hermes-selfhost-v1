/**
 * HERMES-TRIAL-COST-VS-POST-TRIAL-PRICING-R1 — À QUOI le prix demandé se
 * rapporte-t-il ?
 *
 * ---------------------------------------------------------------------------
 * Le défaut, mesuré et non supposé
 * ---------------------------------------------------------------------------
 * Le 23 août 2026 à 12:18, un prospect a écrit : « Et ça me coûte combien de
 * tester ? ». D2 avait compris (`QUESTION`, 0,99). La conversation a fini en
 * `HUMAN_ESCALATION:pricing_policy_missing`.
 *
 * Le motif était FAUX, et il l'était deux fois :
 *
 *   1. `commercialPolicy.ts` a relevé `EXACT_PRICE` sur « coûte combien », et
 *      `DEMAND_ESCALATION.EXACT_PRICE` vaut `pricing_policy_missing`
 *      inconditionnellement. La table ne se demande pas de QUEL prix on parle ;
 *   2. `grounding.ts` a ouvert `PRICING_POLICY_MISSING` parce que
 *      `signals.questionTopic` valait `PRICE`, pour la même raison.
 *
 * Or le prix demandé n'était pas le nôtre après l'essai — celui-là n'est
 * effectivement écrit nulle part. C'était le coût du TEST, et ce dépôt le
 * porte depuis `HERMES-SALES-KNOWLEDGE-R1` (sept jours, aucun frais de service
 * Hermes, budget publicitaire à la charge du prospect) puis depuis
 * `HERMES-ACQUISITION-SERVICE-TRUTH-R1` (un départ autour de 20 € par jour,
 * une zone raisonnable de 20 à 25 €). Escalader là-dessus faisait attendre un
 * humain pour deux faits déjà écrits, signés et datés.
 *
 * Le lexique `TRIAL_TERMS` ne rattrapait rien : son ancre est
 * `tests?(?![\p{L}])`, qui refuse « tester » — un verbe, c'est-à-dire la forme
 * sous laquelle un humain pose réellement cette question.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module ajoute, et ce qu'il n'ajoute pas
 * ---------------------------------------------------------------------------
 * Il n'ajoute AUCUNE vérité commerciale. Il ne contient ni prix, ni fourchette,
 * ni pourcentage : les deux seuls montants qu'il sait rendre sont LUS depuis
 * `HERMES_TRIAL` et `HERMES_AD_BUDGET`, jamais recopiés. Le jour où ces
 * constantes changent, ce module change avec elles ; le jour où elles se
 * vident, il referme tout seul.
 *
 * Ce qu'il ajoute est une QUESTION que personne ne posait : « ce prix, c'est le
 * prix de quoi ? ». Trois réponses portent une vérité canonique ou son absence,
 * une quatrième dit qu'on n'a pas su lire — et elle refuse.
 *
 * ---------------------------------------------------------------------------
 * L'ordre est la politique, et il est fail-closed
 * ---------------------------------------------------------------------------
 * `POST_TRIAL` passe DEVANT l'ancre d'essai, et c'est tout le module. « Ça
 * coûte combien après les 7 jours ? » nomme l'essai et demande pourtant ce qui
 * vient APRÈS lui — le seul prix que ce dépôt n'a pas. Si l'ancre d'essai
 * l'emportait, la question la plus dangereuse de la liste deviendrait la mieux
 * couverte.
 *
 * Les trois autres bords penchent du même côté :
 *
 *   * pas de marqueur de PRIX du tout → `UNRESOLVED`. Ce module ne se prononce
 *     que sur un message qui parle réellement d'argent ; « je vais tester avec
 *     quelqu'un d'autre » n'est pas une question de coût, et lui ouvrir la
 *     vérité de l'essai reviendrait à pitcher sur un mot ;
 *   * une ancre de budget publicitaire exige un mot de PUBLICITÉ. « Quel budget
 *     nécessaire ? » nu reste `UNRESOLVED`, donc escalade : « budget » seul ne
 *     dit pas si l'on parle de ce que le prospect verse à Meta ou de ce qu'il
 *     nous verse à nous ;
 *   * `covered` n'est pas un littéral. Il est CALCULÉ depuis les constantes de
 *     vérité, si bien qu'un sujet cesse d'être couvert dès que la vérité qui le
 *     couvrait disparaît, sans que personne ait à y penser.
 */

import { frameOfPattern, scopeUtterance } from '@/lib/conversation/utteranceScope';
import { AD_BUDGET_QUOTABLE_AMOUNTS } from '@/lib/sales/acquisitionService';
import { HERMES_TRIAL, TRIAL_FACTS } from '@/lib/sales/offer';

/**
 * L'identifiant de cette lecture, distinct des sept qui existaient.
 *
 * Elle répond à une question qu'aucune autre ne pose : non pas « que
 * proposons-nous ? » ni « qu'avons-nous le droit d'engager ? », mais « de quel
 * prix parle-t-on ? ». Partager une étiquette ferait couvrir l'une par les
 * décisions rendues sous l'autre.
 */
export const PRICE_SUBJECT_VERSION = 'hermes-price-subject-r2';

/**
 * Le sujet auquel une demande de prix se rapporte.
 *
 * Quatre membres, dont deux seulement sont couverts aujourd'hui. Le type ne dit
 * PAS qui est couvert — `priceSubjectCoverage` le calcule depuis les vérités —
 * pour que « ce sujet existe » et « une réponse existe » restent deux choses
 * distinctes, comme elles le sont dans la réalité commerciale.
 */
export type PriceSubject =
  /** Ce que coûte le TEST de sept jours. Couvert : `HERMES_TRIAL` l'écrit. */
  | 'TRIAL_COST'
  /** Le budget PUBLICITAIRE du prospect. Couvert : `HERMES_AD_BUDGET` l'écrit. */
  | 'AD_BUDGET'
  /**
   * Ce que Hermes facture APRÈS l'essai — abonnement, mensualité, suite.
   *
   * Jamais couvert, et ce membre existe pour que ce refus-là porte son nom.
   * `UNRESOLVED` dirait « on n'a pas su lire » ; ici on a très bien lu, et la
   * réponse n'existe pas.
   */
  | 'POST_TRIAL_PRICE'
  /**
   * Aucun sujet lisible — y compris parce que le message ne parle pas d'argent.
   *
   * Le défaut, et il refuse. C'est le sens de fail-closed ici : l'absence de
   * preuve qu'on parlait de l'essai n'est pas une preuve du contraire.
   */
  | 'UNRESOLVED';

export interface PriceSubjectReading {
  readonly subject: PriceSubject;
  /** Le libellé rendu dans les rapports. Jamais un extrait du message. */
  readonly label: string;
  /** Une vérité canonique couvre-t-elle ce sujet ? Calculé, jamais écrit. */
  readonly covered: boolean;
  /**
   * Les montants en euros que CE sujet rend citables.
   *
   * Vides sur tout sujet non couvert. Composés depuis les constantes de vérité,
   * jamais recopiés — un chiffre recopié diverge de sa source le jour où la
   * source change, et personne ne s'en aperçoit sauf le prospect à qui on
   * annonce l'ancien.
   */
  readonly quotableAmounts: readonly number[];
}

// ---------------------------------------------------------------------------
// Ce que les vérités couvrent réellement
// ---------------------------------------------------------------------------

/**
 * Les montants citables quand la question porte sur le COÛT DU TEST.
 *
 * Le budget publicitaire en fait partie, et ce n'est pas une largesse : c'est
 * la seule dépense réelle des sept jours. Répondre « ça ne coûte rien » sans
 * elle serait le mensonge par omission que `checkTrialStatement` existe pour
 * attraper.
 *
 * Zéro y est, et il vient de `HERMES_TRIAL.hermesServiceFeeDuringTrial`.
 * `sales/offer.ts` argumentait de ne jamais écrire « 0 € » ; l'argument tenait
 * tant qu'AUCUN montant n'était citable, parce qu'un zéro isolé se lisait
 * « gratuit ». Il ne tient plus dès lors que la même phrase porte le budget
 * publicitaire : « 0 € de frais de service, le budget pub reste à toi » est
 * plus clair, pas moins, que sa version sans chiffre. Le prompt continue
 * néanmoins de préférer les mots — la garde AUTORISE, elle n'oblige pas.
 */
const TRIAL_COST_AMOUNTS: readonly number[] = Object.freeze([
  ...new Set<number>([
    HERMES_TRIAL.hermesServiceFeeDuringTrial,
    ...AD_BUDGET_QUOTABLE_AMOUNTS,
  ]),
]);

/**
 * Ce que chaque sujet rend citable, ou rien.
 *
 * `Record` complet et non partiel : ajouter un membre à `PriceSubject` sans
 * dire ce qu'il couvre devient une erreur de compilation, et non un `undefined`
 * que la lecture sauterait en silence.
 */
const SUBJECT_AMOUNTS: Readonly<Record<PriceSubject, readonly number[]>> = Object.freeze({
  // Couvert si — et seulement si — les DEUX vérités sont là. L'essai sans le
  // budget publicitaire n'est pas une réponse à « combien ça coûte de tester ».
  TRIAL_COST:
    TRIAL_FACTS.length > 0 && AD_BUDGET_QUOTABLE_AMOUNTS.length > 0
      ? TRIAL_COST_AMOUNTS
      : Object.freeze([]),
  AD_BUDGET: AD_BUDGET_QUOTABLE_AMOUNTS,
  POST_TRIAL_PRICE: Object.freeze([]),
  UNRESOLVED: Object.freeze([]),
});

/**
 * Ce sujet porte-t-il une vérité canonique ?
 *
 * Dérivé de la présence de montants citables, donc des constantes de vérité
 * elles-mêmes. Vider `HERMES_AD_BUDGET` referme `AD_BUDGET` et `TRIAL_COST`
 * du même geste, sans qu'aucune ligne d'ici n'ait à être relue.
 */
export function priceSubjectCovered(subject: PriceSubject): boolean {
  return SUBJECT_AMOUNTS[subject].length > 0;
}

// ---------------------------------------------------------------------------
// Lire un message
// ---------------------------------------------------------------------------

/** La frontière de mot en Unicode. Même raison que `commercialPolicy.ts`. */
const WORD_START = '(?<![\\p{L}\\p{N}_])';

/**
 * Ce message parle-t-il d'ARGENT ?
 *
 * La condition d'entrée du module, et elle est là pour l'empêcher de se
 * prononcer sur des messages qui ne lui ont rien demandé. Sans elle,
 * « je préfère tester par moi-même » rendrait `TRIAL_COST`, ouvrirait la
 * vérité de l'essai dans le prompt et transformerait un refus poli en
 * argumentaire — exactement le réflexe que `CONVERSATION_FRAME` interdit.
 *
 * Volontairement large : un faux positif coûte au pire une lecture de sujet qui
 * finira en `UNRESOLVED`, donc le comportement d'avant ce round.
 */
const PRICE_MARKER = new RegExp(
  // HERMES-TRIAL-IMPLEMENTATION-ROUTING-R1 — « combien de temps » n'est pas
  // une question d'argent, et ce module se prononçait dessus.
  //
  // Mesuré, pas supposé : « Le test dure combien de temps ? » passait cette
  // porte sur le `combien` nu, puis relevait l'ancre d'essai, donc rendait
  // `TRIAL_COST` — un sujet COUVERT, qui ouvre la facette du budget
  // publicitaire et rend 20, 25 et 0 citables. Sur une question de DURÉE. Le
  // module aurait mis dans les mains du modèle trois montants que personne
  // n'avait demandés, et la garde de contenu les aurait laissés passer
  // puisqu'ils lui étaient présentés comme approuvés pour ce tour.
  //
  // C'est la même exclusion que `commercialPolicy.ts` et `signals.ts`
  // portent déjà — un « combien » qui compte des unités de temps ne compte
  // pas des euros —, appliquée au troisième endroit qui la posait. Elle ne
  // peut que matcher MOINS ; « ça coûte combien ? » et « c'est combien ? »
  // sont inchangés, le premier par `co[ûu]t\w*` et le second par le `combien`
  // que rien ne suit.
  `${WORD_START}(?:combien(?!\\s+de\\s+(?:temps|jours?|semaines?|mois))|prix|tarifs?|co[ûu]t\\w*|factur\\w*|payer?|paie|paies|paye|payes|payez|` +
    `pay[ée]e?s?|d[ée]bours\\w*|gratuit\\w*|cher\\b|devis|honoraires|budgets?|euros?|€|` +
    // HERMES-SEMANTIC-GROUNDING-R1 — un abonnement, une mensualité et un
    // forfait SONT des montants. `POST_TRIAL_MARKER` les connaissait déjà comme
    // marqueurs de « la suite » ; l'entrée du module, elle, ne les voyait pas,
    // si bien que « c'est quoi ton abonnement mensuel ? » sortait en
    // `UNRESOLVED` au lieu de `POST_TRIAL_PRICE`. Les deux lectures disent
    // désormais la même chose.
    `abonnements?|mensualit[ée]s?|forfaits?|` +
    `[çc]a\\s+me\\s+co[ûu]te|d[ée]penser?|investir)`,
  'iu',
);

/**
 * Le marqueur qui dit « ce prix, c'est celui d'APRÈS ».
 *
 * Le plus important des trois, et le seul dont un faux négatif coûterait
 * quelque chose de grave : laisser passer « c'est combien ensuite ? » pour une
 * question sur l'essai ferait répondre « rien pendant sept jours » à quelqu'un
 * qui demandait le prix de la suite. Il est donc large, et il passe devant tout.
 *
 * « après » y figure nu. C'est délibéré : dans une conversation commerciale, un
 * « après » qui accompagne une question d'argent parle de la suite neuf fois
 * sur dix, et la dixième coûte une escalade — c'est-à-dire le comportement que
 * ce round remplace, pas une régression.
 */
const POST_TRIAL_MARKER = new RegExp(
  `${WORD_START}(?:apr[èe]s|ensuite|par\\s+la\\s+suite|pour\\s+la\\s+suite|plus\\s+tard|` +
    `au\\s+bout\\s+(?:de|des)|[àa]\\s+la\\s+fin|une\\s+fois\\s+(?:le\\s+test|l'essai|les\\s+(?:7|sept)\\s*jours)|` +
    `si\\s+(?:je|on)\\s+continue|pour\\s+continuer|continuer\\s+apr[èe]s|si\\s+[çc]a\\s+continue|` +
    `par\\s+mois|mensuel\\w*|chaque\\s+mois|au\\s+mois\\b|[àa]\\s+l'ann[ée]e|annuel\\w*|` +
    `r[ée]current\\w*|abonnements?|forfaits?|setup\\b|mise\\s+en\\s+place)`,
  'iu',
);

/**
 * L'ancre de l'ESSAI, et la forme verbale qui manquait.
 *
 * `TRIAL_TERMS` (`commercialPolicy.ts`) borne son ancre par
 * `tests?(?![\p{L}])`, ce qui refuse « tester », « testé », « essayer ». Cette
 * borne protège ce lexique-là d'attraper « testimonial » ou « essaie » ; ici la
 * lecture est déjà conditionnée à un marqueur de prix, donc la borne peut
 * s'ouvrir aux verbes sans que le sens se dilue. C'est cette ouverture, et elle
 * seule, qui fait lire « ça me coûte combien de tester ».
 */
const TRIAL_MARKER = new RegExp(
  `${WORD_START}(?:(?:7|sept)\\s*jours?|essai\\w*|essaye\\w*|essayer|test\\w*|` +
    `p[ée]riode\\s+(?:de\\s+(?:test|d[ée]couverte)|d'essai)|phase\\s+de\\s+test)`,
  'iu',
);

/**
 * L'ancre du budget PUBLICITAIRE.
 *
 * Elle exige un mot de publicité, jamais « budget » seul. Ce resserrement est
 * le point : « quel budget ? » nu ne dit pas si l'on parle de ce que le
 * prospect verse à Meta — écrit — ou de ce qu'il nous verse à nous — pas écrit.
 * Devant cette ambiguïté, on refuse.
 */
const AD_MARKER = new RegExp(
  `${WORD_START}(?:pub(?![\\p{L}])|pubs(?![\\p{L}])|publicit[ée]\\w*|ads?(?![\\p{L}])|annonces?|` +
    `campagnes?|meta\\b|facebook|instagram|insta\\b)`,
  'iu',
);

const LABELS: Readonly<Record<PriceSubject, string>> = Object.freeze({
  TRIAL_COST: 'le coût du test',
  AD_BUDGET: 'le budget publicitaire',
  POST_TRIAL_PRICE: 'le prix après le test',
  UNRESOLVED: 'un prix dont le sujet n’est pas lisible',
});

function reading(subject: PriceSubject): PriceSubjectReading {
  const amounts = SUBJECT_AMOUNTS[subject];
  return Object.freeze({
    subject,
    label: LABELS[subject],
    covered: amounts.length > 0,
    quotableAmounts: amounts,
  });
}

/**
 * De quel prix ce message parle-t-il ?
 *
 * Pure, sans état, sans réseau, sans modèle. C'est délibéré : cette lecture
 * décide si un montant part vers un prospect réel, et une porte qui décide cela
 * n'est pas un prompt (règle de ce dépôt : « toute logique déterministe reste
 * du code testé »).
 *
 * L'ordre des quatre tests EST la politique :
 *
 *   1. pas d'argent dans le message      → `UNRESOLVED`
 *   2. un marqueur d'APRÈS               → `POST_TRIAL_PRICE`   (jamais couvert)
 *   3. une ancre d'ESSAI                 → `TRIAL_COST`
 *   4. une ancre de PUBLICITÉ            → `AD_BUDGET`
 *   5. sinon                             → `UNRESOLVED`
 */
export function resolvePriceSubject(text: string): PriceSubjectReading {
  // HERMES-SEMANTIC-GROUNDING-R1 — le marqueur d'argent doit être dans une
  // portion qui ADRESSE quelque chose.
  //
  // « Mes clients me demandaient combien coûtait un prestation standard complet » parle
  // d'argent sans rien nous demander. Sans cette borne, le sujet se serait
  // résolu en `TRIAL_COST` ou `AD_BUDGET` — c'est-à-dire en sujets COUVERTS —
  // et aurait rendu 0, 20 et 25 € citables sur un tour où personne n'avait posé
  // de question. La borne ne peut que refuser DAVANTAGE : un sujet non résolu
  // n'est pas couvert, donc escalade, c'est-à-dire le comportement d'avant.
  const scope = scopeUtterance(text);
  const body = scope.normalized;
  if (frameOfPattern(scope, PRICE_MARKER) !== 'CURRENT') return reading('UNRESOLVED');
  if (POST_TRIAL_MARKER.test(body)) return reading('POST_TRIAL_PRICE');
  if (TRIAL_MARKER.test(body)) return reading('TRIAL_COST');
  if (AD_MARKER.test(body)) return reading('AD_BUDGET');
  return reading('UNRESOLVED');
}
