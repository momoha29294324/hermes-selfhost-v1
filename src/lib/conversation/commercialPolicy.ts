/**
 * HERMES-REPLY-DELIVERY-R1 §1 — la POLITIQUE COMMERCIALE canonique, versionnée,
 * et le seul endroit qui dise ce que Hermes a le droit d'engager.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi ce fichier existe
 * ---------------------------------------------------------------------------
 * HERMES-CONVERSATION-R2 s'était arrêté sur un constat écrit noir sur blanc
 * (§11 de son compte rendu) : sans politique commerciale canonique, tout tour
 * qui touche au prix, à la garantie ou au modèle de rémunération escalade. Ce
 * n'est pas faux — c'est simplement dispersé. Les règles vivaient à trois
 * endroits qui ne se connaissaient pas :
 *
 *   * `grounding.ts` nommait les MANQUES (`PRICING_POLICY_MISSING`, …) et
 *     rédigeait l'interdiction destinée au prompt ;
 *   * `autonomy.ts` portait une table privée traduisant ces manques en refus ;
 *   * `learning/offer.ts` portait le lexique des promesses interdites.
 *
 * Trois endroits, trois raisons de diverger, et aucune version commune : rien
 * ne permettait de dire « cette réponse est partie sous CETTE politique ». Ce
 * module ne remplace aucun des trois — il les NOMME et les rassemble derrière
 * une version unique, qui s'inscrit dans chaque effet.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module ne fait pas, et ne fera pas
 * ---------------------------------------------------------------------------
 * Il n'invente AUCUNE grille tarifaire. Il ne contient ni prix, ni fourchette,
 * ni pourcentage, ni durée d'engagement, ni condition d'un modèle à la
 * performance — parce que ces choses n'existent pas dans ce dépôt, et qu'un
 * fichier qui les écrirait les créerait. Ce qu'il contient est l'inverse : la
 * liste de ce qui ne peut PAS être dit sans qu'un humain l'ait décidé.
 *
 * ---------------------------------------------------------------------------
 * Deux lectures, deux directions
 * ---------------------------------------------------------------------------
 * La politique se lit dans les deux sens, et les deux sont nécessaires :
 *
 *   1. **ce que le prospect DEMANDE** — `readCommercialDemands` lit le message
 *      entrant et nomme les demandes qui engagent des conditions commerciales.
 *      Fail-closed : une demande reconnue écarte l'autonomie, quelle que soit
 *      la qualité du brouillon ;
 *   2. **ce que le brouillon ÉCRIRAIT** — `forbiddenCommercialClaims`, qui est
 *      le lexique existant, nommé ici et non recopié.
 *
 * Pourquoi la première lecture est LEXICALE et ne se contente pas du
 * `questionTopic` déjà calculé : parce que `readSignals` ne retient qu'UN sujet
 * par message, et qu'une ligne écrase l'autre. « Vous prenez combien de % ? On
 * peut s'appeler ? » sort de `readSignals` en `CALL_REQUEST` — la demande
 * d'appel écrase la question de prix (`signals.ts`, `if (explicitCallRequest)
 * questionTopic = 'CALL_REQUEST'`). Le manque `PRICING_POLICY_MISSING` n'est
 * alors jamais ouvert, et la porte de grounding laisse passer. Une politique
 * commerciale qui dépendrait d'un sujet unique serait donc contournable par
 * une phrase de plus, sans que personne n'ait rien désactivé.
 *
 * La lecture d'ici est CUMULATIVE : elle rend TOUTES les demandes reconnues, et
 * la première suffit à écarter. C'est la seule forme qui ne se laisse pas
 * diluer.
 */

import { detectPerformanceClaims } from '@/lib/learning/offer';
import {
  resolvePriceSubject,
  type PriceSubject,
  type PriceSubjectReading,
} from '@/lib/sales/priceSubject';
import {
  UNCOVERED_CURRENT_REQUESTS,
  type CurrentRequestTopic,
} from '@/lib/conversation/currentRequest';
import {
  frameEngages,
  frameOfPattern,
  scopeUtterance,
  type UtteranceFrame,
} from '@/lib/conversation/utteranceScope';
import type { ConversationSignals } from '@/lib/conversation/signals';
import type { GroundingGap } from '@/lib/conversation/grounding';

/**
 * L'identifiant de CETTE politique commerciale.
 *
 * Distinct de `CONVERSATION_POLICY_VERSION` (qui gouverne « peut-on répondre
 * seul ? ») et d'`AUTONOMOUS_POLICY_VERSION` (qui gouverne « à qui écrire ? »).
 * Trois questions, trois versions : partager une étiquette ferait couvrir l'une
 * par les décisions rendues sous l'autre.
 *
 * Toute modification des listes ci-dessous demande de l'incrémenter. C'est ce
 * qui referme les effets rendus sous les règles d'hier : un plan porte la
 * version sous laquelle il a été jugé, et le worker refuse d'exécuter ce qui a
 * été décidé sous une autre.
 */
export const COMMERCIAL_POLICY_VERSION = 'hermes-commercial-r7';

/**
 * HERMES-SALES-KNOWLEDGE-R1 §6 — pourquoi r2, et ce que r1 voulait dire.
 *
 * `hermes-commercial-r1` disait une chose simple et vraie à sa date : ce dépôt
 * ne porte AUCUNE condition commerciale, donc toute demande qui en engage une
 * revient à un humain. Ce texte n'est pas amendé — il est REMPLACÉ, et l'ancien
 * garde son sens pour les décisions rendues sous lui.
 *
 * Une chose, et une seule, a changé le 22 août 2026 : un essai de sept jours
 * existe, pendant lequel Hermes ne facture pas ses frais de service, le budget
 * publicitaire restant à la charge du prospect (`sales/offer.ts`). Il devient
 * donc possible de répondre honnêtement à « qu'est-ce que je paie pendant le
 * test ? » — et cette question-là cesse d'escalader.
 *
 * Tout le reste escalade EXACTEMENT comme avant : le prix après l'essai,
 * l'abonnement, le pourcentage, l'engagement, le remboursement, le budget
 * minimum, la garantie. La liste des inconnues reste, de loin, la plus longue
 * des deux.
 *
 * L'incrément referme par construction les décisions rendues sous r1 : ce
 * qu'on s'autorise à engager a changé, donc un tour jugé sous l'ancienne
 * politique se rejuge avant de partir.
 */

/**
 * HERMES-CONTACT-PURPOSE-R1 §1 — pourquoi r3, et ce que r2 ne disait pas.
 *
 * r2 décrivait ce que Hermes peut ENGAGER. Il ne disait rien de ce que Hermes
 * peut EXPLIQUER de sa propre démarche — et l'omission était invisible tant que
 * personne ne posait la question. Le 23 août 2026, quelqu'un l'a posée :
 * « Pourquoi tu me demande ça ». Le dépôt a répondu qu'il ne savait pas, ce qui
 * était vrai et absurde à la fois : la seule chose dont un démarcheur soit
 * l'unique source est la raison pour laquelle il écrit.
 *
 * Une entrée de plus au périmètre autonome, donc, et une seule. Elle
 * n'autorise AUCUN engagement supplémentaire : les limites de la section
 * suivante sont inchangées mot pour mot, `DEMAND_ESCALATION` est inchangée,
 * `TRIAL_TERMS` reste la seule demande commerciale répondable, et un prix, une
 * garantie ou un pourcentage escaladent exactement comme sous r2.
 *
 * L'incrément referme les décisions rendues sous r2 : le périmètre a bougé,
 * donc un tour jugé sous l'ancien se rejuge avant de partir.
 */

/**
 * HERMES-ACQUISITION-SERVICE-TRUTH-R1 §1 — pourquoi r4, et ce qui bascule.
 *
 * UNE demande change de camp, et une seule : `AD_SPEND_AMOUNT`. Jusqu'ici,
 * « quel budget faut-il pour commencer ? » escaladait en
 * `pricing_policy_missing`, et le motif était exact — personne n'avait écrit ce
 * budget. L'opérateur l'a écrit le 23 août 2026
 * (`sales/acquisitionService.ts` : un départ typique autour de 20 € par jour,
 * une zone raisonnable de 20 à 25 €, qui bouge ensuite selon les
 * statistiques). Escalader là-dessus ferait attendre un humain pour un fait
 * désormais écrit.
 *
 * Le passage à `null` n'est pas une tolérance : c'est le mécanisme que ce
 * fichier avait prévu et écrit noir sur blanc dès r2 — « le jour où le prix
 * après essai sera écrit, une seconde entrée passera à `null`, et ce sera de la
 * même façon, parce qu'une réponse existera ». C'est ce jour-là, pour une autre
 * entrée.
 *
 * Ce qui ne bouge PAS : `EXACT_PRICE` reste plus fort. « ça coûte combien et
 * quel budget pub ? » relève les DEUX demandes, la lecture reste cumulative, et
 * la première qui engage l'emporte — donc ce message escalade toujours. Ce que
 * le prospect nous paie reste inconnu ; seul ce qu'il paie à Meta est écrit.
 *
 * Deux entrées de lexique s'ajoutent par ailleurs à `PROOF_REQUEST`, et elles
 * RESSERRENT : le coût par demande, le retour sur investissement chiffré et le
 * taux de conversion sont désormais nommés. Ils tombaient en `OTHER_QUESTION`,
 * donc en `topic_not_covered` — vrai, mais muet : un opérateur y lisait « la
 * donnée manque » là où il fallait lire « on nous demande une preuve chiffrée,
 * et aucune n'est citable en réponse ».
 *
 * L'incrément referme les décisions rendues sous r3 : ce qu'on s'autorise à
 * engager a changé, donc un tour jugé sous l'ancienne politique se rejuge avant
 * de partir.
 */

/**
 * HERMES-TRIAL-COST-VS-POST-TRIAL-PRICING-R1 §1 — pourquoi r5, et ce qui
 * change dans la lecture d'une demande de prix.
 *
 * AUCUNE demande ne change de camp cette fois-ci. Ce qui change est plus
 * profond : `EXACT_PRICE` cesse d'être une réponse à lui tout seul.
 *
 * Jusqu'ici, cette table répondait à « de quoi parle-t-on ? » par une étiquette
 * et s'arrêtait là. « Ça coûte combien ? » relevait `EXACT_PRICE`, et
 * `EXACT_PRICE` escaladait, point. Le 23 août 2026, « Et ça me coûte combien de
 * tester ? » a donc fini en `HUMAN_ESCALATION:pricing_policy_missing` alors que
 * la réponse est écrite depuis deux rounds — sept jours, aucun frais de service
 * Hermes, budget publicitaire au prospect, autour de 20 à 25 € par jour.
 *
 * Le défaut n'était pas dans le lexique : il était dans l'idée qu'« une demande
 * contient un montant » suffise à conclure « la réponse est inconnue ». Ce sont
 * deux propositions différentes, et ce dépôt les confondait.
 *
 * Une demande de prix porte désormais un SUJET (`sales/priceSubject.ts`), et
 * l'escalade se lit sur le couple :
 *
 *     EXACT_PRICE + TRIAL_COST        + vérité de l'essai      → répondable
 *     EXACT_PRICE + AD_BUDGET         + vérité de budget       → répondable
 *     EXACT_PRICE + POST_TRIAL_PRICE  + rien d'écrit           → escalade
 *     EXACT_PRICE + UNRESOLVED        + on n'a pas su lire     → escalade
 *
 * Ce que cela n'ouvre PAS, et qui mérite d'être dit en toutes lettres :
 *
 *   * `DEMAND_ESCALATION` n'a pas bougé d'une entrée. Elle reste le DÉFAUT, et
 *     ce défaut reste l'escalade : le raffinement ci-dessous ne peut que partir
 *     d'elle, jamais s'y substituer. Une lecture de sujet qui échoue retombe
 *     donc exactement sur le comportement d'avant ce round ;
 *   * le raffinement ne touche QUE `EXACT_PRICE`. `PERCENTAGE_OR_FEE`,
 *     `CONTRACT_COMMITMENT`, `GUARANTEE`, `GUARANTEED_OUTCOME`,
 *     `PERFORMANCE_MODEL` et `PROOF_REQUEST` escaladent mot pour mot comme sous
 *     r4, quel que soit le sujet lu ;
 *   * la lecture reste CUMULATIVE. « Ça coûte combien de tester, et tu prends
 *     quel pourcentage ? » relève les deux demandes, `firstEscalatingDemand`
 *     retient la seconde, et le tour escalade — comme avant.
 *
 * L'incrément referme les décisions rendues sous r4 : ce qu'on s'autorise à
 * engager a changé, donc un tour jugé sous l'ancienne politique se rejuge avant
 * de partir.
 */

// ---------------------------------------------------------------------------
// 1. Ce que Hermes PEUT faire seul
// ---------------------------------------------------------------------------

/**
 * Le périmètre autonome, énoncé positivement.
 *
 * Une liste positive plutôt qu'une absence d'interdiction : « tout ce qui n'est
 * pas interdit est permis » se relit mal six mois plus tard, et se relit
 * surtout comme une invitation à ajouter un cas.
 *
 * Ces entrées ne sont pas exécutables — ce ne sont pas des portes. Elles sont
 * ce que le prompt reprend et ce qu'un rapport affiche, pour qu'« autonome »
 * désigne toujours la même chose dans la tête de tout le monde. Ce qui décide
 * vraiment, ce sont les refus de la section 2, et les gardes de `autonomy.ts`.
 */
export const AUTONOMOUS_COMMERCIAL_SCOPE: readonly string[] = Object.freeze([
  'comprendre la situation décrite par le prospect et la lui refléter sans la reformuler en argumentaire',
  'qualifier son besoin : ce qu’il vend, à qui, et ce qui coince aujourd’hui',
  'approfondir LÉGÈREMENT — une question à la fois, jamais un questionnaire',
  'expliquer de manière GÉNÉRALE ce que Hermes fait, sans chiffrer et sans promettre',
  'dire que l’accompagnement dépend de la situation de l’entreprise — ce qui est vrai, et ce qui est la ' +
    'raison honnête pour laquelle aucun montant n’est donné ici',
  'proposer un échange quand la maturité du tour le justifie (CALL_READINESS)',
  // HERMES-SALES-KNOWLEDGE-R1 §7 — la seule entrée neuve de r2.
  'expliquer le test de sept jours quand la conversation l’appelle : durée, absence de frais de ' +
    'service Hermes sur la période, et budget publicitaire à la charge du prospect — les trois ' +
    'ensemble ou aucun des trois',
  // HERMES-CONTACT-PURPOSE-R1 §1 — la seule entrée neuve de r3.
  'dire POURQUOI ce contact a lieu quand on le demande : à quel type d’entreprises on écrit, ce ' +
    'qu’on cherchait à comprendre, et le fait qu’un échange de vive voix est la suite visée si le ' +
    'sujet est pertinent — sans chiffrer, sans promettre, et sans affirmer que l’entreprise a un ' +
    'problème',
  // HERMES-ACQUISITION-SERVICE-TRUTH-R1 §1 — les entrées neuves de r4.
  'dire CE QU’ON FAIT quand on le demande : les publicités Meta (Facebook, Instagram), les ' +
    'campagnes locales, le formulaire, la préqualification, le CRM et le suivi — et le fait que ' +
    'rappeler, vendre et fixer le rendez-vous restent au client',
  'donner le BUDGET PUBLICITAIRE de départ quand on le demande, tel qu’il est écrit — sans jamais ' +
    'le présenter comme suffisant, ni le relier à un résultat',
  'dire qu’on ne travaille qu’avec une entreprise par zone commerciale réellement concurrente, sans ' +
    'chiffrer ce périmètre',
  'dire quels accès seront nécessaires, sans jamais en demander un dans la conversation',
  // HERMES-TRIAL-COST-VS-POST-TRIAL-PRICING-R1 §1 — la seule entrée neuve de r5.
  'dire ce que COÛTE LE TEST quand on le demande : sa durée, l’absence de frais de service Hermes ' +
    'sur la période, et le budget publicitaire à la charge du prospect avec son ordre de départ écrit ' +
    '— les trois ensemble ou aucun des trois, et jamais le prix de ce qui vient après',
]);

/**
 * Ce que le périmètre autonome n'accorde PAS, même quand la conversation s'y
 * prête et que le brouillon est excellent.
 *
 * Exportée pour le prompt et pour les rapports, à côté du périmètre : les deux
 * listes se lisent ensemble ou ne se lisent pas.
 */
export const AUTONOMOUS_COMMERCIAL_LIMITS: readonly string[] = Object.freeze([
  'aucun prix, aucune fourchette, aucun « à partir de », aucun ordre de grandeur',
  'aucun pourcentage, aucune commission, aucuns frais, aucun montant de quelque nature',
  'aucune durée d’engagement, aucune condition de résiliation, aucun terme contractuel',
  'aucune garantie, de résultat ou de remboursement',
  'aucun nombre promis de leads, de clients, de rendez-vous ou d’euros',
  'aucune condition d’un modèle à la performance — ce sont des contrats, pas des tournures',
  'aucune preuve chiffrée : la phrase canonique des case studies n’est pas citable en RÉPONSE',
  // §9 — la confusion que r2 rend possible, et qu'il faut donc interdire par écrit.
  'aucun « gratuit », « sans frais », « sans risque », « sans engagement » : le test n’est aucune ' +
    'de ces choses, puisque le prospect finance ses annonces dès le premier jour',
  // HERMES-ACQUISITION-SERVICE-TRUTH-R1 §6 — cette limite se resserre au lieu de
  // disparaître. r3 interdisait TOUT montant de budget publicitaire, parce
  // qu'aucun n'était écrit. Deux le sont maintenant, et eux seuls ; les
  // relier à un résultat reste interdit, et c'est là que vivait le vrai
  // danger — « avec 20 € par jour tu auras des clients » est une promesse,
  // pas un budget.
  'aucun montant de budget publicitaire autre que le départ écrit dans la vérité de service — et ' +
    'jamais présenté comme suffisant, ni relié à un nombre de demandes, de clients ou de rendez-vous',
  'aucun coût par demande, aucun retour sur investissement, aucun taux de conversion, même observé ' +
    'ailleurs : ce sont des preuves chiffrées, et aucune n’est citable en RÉPONSE',
  'aucun délai de résultat, même approximatif, même précédé de « en général »',
  'aucun périmètre chiffré d’exclusivité : ni kilomètres, ni département, ni région, ni national',
  'aucun prix, aucune condition APRÈS les sept jours : rien n’est écrit, donc rien ne se dit',
  // HERMES-TRIAL-COST-VS-POST-TRIAL-PRICING-R1 §1 — le pendant de l'entrée
  // neuve du périmètre. Savoir dire ce que coûte le test rend la confusion
  // possible ; elle est donc interdite par écrit avant de l'être par le code.
  'aucun glissement du coût du TEST vers le prix de la SUITE : ce qui est écrit vaut pour les sept ' +
    'jours et pour eux seuls, et « et après ? » est une question à laquelle on ne répond pas ici',
]);

// ---------------------------------------------------------------------------
// 2. Ce que le prospect DEMANDE, et qui rend la main à un humain
// ---------------------------------------------------------------------------

/**
 * Les demandes qui engagent des conditions commerciales que personne n'a
 * écrites.
 *
 * Nommées par ce qu'elles DEMANDENT, pas par ce qu'on répondrait : c'est ce qui
 * permet de les relire dans un rapport sans reconstituer la conversation.
 */
export type CommercialDemand =
  /** Un montant : prix, tarif, devis, honoraires, « c'est combien ». */
  | 'EXACT_PRICE'
  /** Une part : pourcentage, commission, frais, marge. */
  | 'PERCENTAGE_OR_FEE'
  /** Un contrat : engagement, durée, préavis, résiliation, exclusivité. */
  | 'CONTRACT_COMMITMENT'
  /** Une garantie : garanti, remboursé, « si ça marche pas ». */
  | 'GUARANTEE'
  /** Un résultat promis : combien de leads, de clients, quel ROI. */
  | 'GUARANTEED_OUTCOME'
  /** Les conditions d'un modèle à la performance. */
  | 'PERFORMANCE_MODEL'
  /** Une preuve commerciale : résultats chiffrés, références, étude de cas. */
  | 'PROOF_REQUEST'
  /**
   * Les conditions du TEST de sept jours — et la seule demande de cette liste
   * à laquelle Hermes puisse répondre seul.
   *
   * Elle est ici, dans le même lexique que les autres, plutôt que dans un
   * module à part : la question « qu'est-ce que je paie pendant le test ? » est
   * une demande commerciale au même titre que « c'est combien ? », et la lire
   * ailleurs créerait un second endroit où décider ce qui s'engage. Ce qui la
   * distingue n'est pas sa nature, c'est le fait qu'une réponse vraie existe.
   */
  | 'TRIAL_TERMS'
  /**
   * Un montant de BUDGET PUBLICITAIRE — minimum, recommandé, journalier.
   *
   * §29 la nomme explicitement, et elle avait besoin d'un membre à elle. Sans
   * lui, « il faut un budget pub minimum pendant le test ? » ne relevait
   * AUCUNE demande : le lexique des prix ne connaît que nos honoraires, et la
   * question porte sur ce que le prospect dépense chez un tiers. Le trou a été
   * mesuré, pas supposé — et il était exactement au mauvais endroit, puisque
   * ce montant-là est la seule dépense réelle du test.
   *
   * Elle escalade. Dire au prospect ce qu'il reste à sa charge est un fait ;
   * lui dire combien y mettre est un conseil que personne n'a écrit.
   */
  | 'AD_SPEND_AMOUNT';

/**
 * Les motifs de refus que cette politique peut produire.
 *
 * Un sous-ensemble littéral d'`AutonomousReplyReason` (`autonomy.ts`), écrit
 * ici plutôt qu'importé pour une raison précise : `autonomy.ts` importe CE
 * module. Un import de valeur en retour ferait un cycle, et un `import type`
 * suffirait au compilateur tout en laissant croire à un lecteur que les deux
 * fichiers se tiennent par la main. L'assignabilité est vérifiée à
 * l'utilisation, chez l'appelant, ce qui est exactement l'endroit où une
 * divergence casserait la compilation.
 */
export type CommercialEscalationReason =
  | 'pricing_policy_missing'
  | 'guarantee_requested'
  | 'proof_requested'
  | 'topic_not_covered'
  | 'commercial_policy_missing'
  | 'contract_terms_requested'
  | 'performance_model_requested';

/**
 * La frontière de mot, en UNICODE et non en ASCII.
 *
 * `\b` de JavaScript ne connaît que `[A-Za-z0-9_]`. Devant « à la
 * performance », « ça coûte » ou « études de cas », il exige donc une
 * frontière entre une espace et une lettre accentuée — deux caractères qui ne
 * sont NI l'un ni l'autre des « mots » à ses yeux. Il n'y a pas de frontière,
 * et le motif ne matche jamais.
 *
 * Ce défaut est exactement celui que `text.ts` raconte pour les apostrophes :
 * il marche sur les exemples écrits en ASCII et échoue en silence sur les vrais
 * messages, c'est-à-dire à l'envers de ce qu'on veut. Les tests l'ont attrapé
 * sur « Vous travaillez à la performance ? », qui ne déclenchait rien.
 *
 * Un lookbehind Unicode le corrige : « ce qui précède n'est ni une lettre, ni
 * un chiffre ». Il s'applique à l'ENTRÉE du motif, là où le défaut vivait ; la
 * sortie garde ses `\b` explicites quand l'alternative se termine en ASCII, et
 * s'en passe sinon — une frontière de fin absente coûte au pire une escalade de
 * trop, ce qui est le côté sûr.
 */
const WORD_START = '(?<![\\p{L}\\p{N}_])';

/** Compose une alternative en motif borné à gauche, insensible à la casse. */
function demandPattern(alternatives: string): RegExp {
  return new RegExp(`${WORD_START}(?:${alternatives})`, 'iu');
}

/**
 * HERMES-END-TO-END-CERTIFICATION-R1 — un SAUT DE MOTS, et ce qui doit suivre.
 *
 * `[^.!?]{0,N}` se lit « saute jusqu'à N caractères sans quitter la phrase ».
 * Écrit nu, il laisse le motif suivant commencer AU MILIEU d'un mot, parce que
 * `demandPattern` ne borne que l'ENTRÉE de l'alternation entière — pas chacun
 * de ses morceaux internes.
 *
 * Le défaut a été mesuré, pas supposé, et il est le même que celui de
 * `signals.ts` : `AD_SPEND_AMOUNT` portait `combien` + un saut nu +
 * `(?:de\s+)?(?:pub\b|…|ads?\b|…)`, si bien que « En général combien de leads
 * deviennent clients ? » relevait une demande de BUDGET PUBLICITAIRE — le saut
 * consomme « de le » et le motif matche les trois dernières lettres de
 * « leads ». Les deux lexiques portaient le même trou parce qu'ils sont deux
 * copies de la même question ; ils sont refermés ensemble, et un test de
 * cohérence les tient désormais côte à côte.
 *
 * Chaque saut est donc suivi, dans le motif lui-même, du même lookbehind que
 * `WORD_START` : ce qui suit commence sur une frontière de mot. Le motif ne
 * peut qu'en matcher MOINS. L'ancre est écrite en toutes lettres plutôt que
 * produite par une fonction — ces lexiques sont des chaînes concaténées, pas
 * des littéraux de gabarit, et une interpolation y serait recopiée telle
 * quelle.
 */

/**
 * Le lexique des demandes, et le seul du dépôt à porter cette question.
 *
 * Chaque entrée porte son libellé lisible : c'est LUI qui part dans les
 * rapports et dans `decision_detail`, jamais le texte du prospect ni la source
 * de l'expression régulière. Un motif nommé se discute ; un extrait de message
 * recopié dans un journal est une fuite de contenu de plus.
 *
 * Volontairement plus large que `QUESTION_PATTERNS` de `signals.ts`, et sans
 * ordre de priorité pour le FOND : ici on ne CHOISIT pas un sujet, on relève
 * tout ce qui engage. L'ordre ne sert qu'au libellé rendu en premier.
 *
 * Un faux positif coûte une escalade — c'est-à-dire le comportement d'avant ce
 * round. Un faux négatif coûte une phrase que personne n'a validée, envoyée
 * seule, à un prospect réel.
 */
const DEMAND_PATTERNS: ReadonlyArray<readonly [CommercialDemand, string, RegExp]> = [
  // ---- Les conditions du test — la seule demande RÉPONDABLE ---------------
  //
  // En TÊTE, et l'ordre est le sujet. Il ne relâche rien : la lecture reste
  // cumulative, et une demande répondable n'efface aucune de celles qui
  // suivent. Ce que la position décide est le LIBELLÉ rendu en premier, donc ce
  // qu'un rapport affiche.
  //
  // La conséquence est fine et elle est voulue. Comparez deux messages :
  //
  //   « pendant les 7 jours je paye quoi ? »    → TRIAL_TERMS seul → répondable
  //   « pendant les 7 jours je paye combien ? » → TRIAL_TERMS + EXACT_PRICE
  //                                               → escalade sur EXACT_PRICE
  //
  // Ce n'est pas une subtilité gratuite. « quoi » demande la NATURE de ce qui
  // est dû, et nous la connaissons : nos frais de service ne courent pas, le
  // budget publicitaire reste au prospect. « combien » demande un MONTANT, et
  // le seul montant en jeu pendant le test est un budget publicitaire —
  // précisément ce qu'aucune politique n'a chiffré (§29). La lecture cumulative
  // produit donc le bon comportement toute seule, sans qu'une règle spéciale
  // ait à distinguer les deux.
  [
    'TRIAL_TERMS',
    'question sur les conditions du test',
    demandPattern(
      "(?:(?:7|sept)\\s*jours?|essais?(?![\\p{L}])|tests?(?![\\p{L}])|p[ée]riode\\s+(?:de\\s+test|d'essai)|" +
        'phase\\s+de\\s+test)' +
        "[^.!?]{0,50}(?<![\\p{L}\\p{N}_])(?:paie|paye|payer|pay[ée]e?s?|d[ée]bours|co[ûu]tes?|co[ûu]ts?|charge|" +
        'factur\\w*|compris|inclus|gratuit|avance)' +
        '|' +
        "(?:paie|paye|payer|pay[ée]e?s?|d[ée]bours|co[ûu]tes?|charge|factur\\w*|compris|inclus)" +
        "[^.!?]{0,50}(?<![\\p{L}\\p{N}_])(?:(?:7|sept)\\s*jours?|essais?(?![\\p{L}])|tests?(?![\\p{L}])|" +
        "p[ée]riode\\s+(?:de\\s+test|d'essai)|phase\\s+de\\s+test)",
    ),
  ],

  // ---- Le budget publicitaire du prospect ---------------------------------
  //
  // AVANT le lexique des prix, parce qu'il est plus précis : un rapport qui
  // dirait « demande de prix » sur « quel budget pub faut-il ? » ferait chercher
  // une grille tarifaire là où il manque une recommandation d'investissement.
  [
    'AD_SPEND_AMOUNT',
    'demande de budget publicitaire',
    demandPattern(
      "(?:quel|quels|quelle|combien\\s+de)\\s+budgets?" +
        '|budgets?[^.!?]{0,40}(?<![\\p{L}\\p{N}_])(?:minimum|minimal|mini\\b|conseill\\w*|recommand\\w*|' +
        "pr[ée]voir|n[ée]cessaire|par\\s+jour|journalier|mensuel|par\\s+mois)" +
        "|(?:mettre|investir|pr[ée]voir|d[ée]penser)[^.!?]{0,25}(?<![\\p{L}\\p{N}_])combien" +
        "|combien[^.!?]{0,25}(?<![\\p{L}\\p{N}_])(?:de\\s+)?(?:pub\\b|publicit[ée]\\w*|ads?\\b|annonces?)",
    ),
  ],

  // ---- Un montant ---------------------------------------------------------
  //
  // « combien » nu, SAUF quand il compte des leads ou des clients : cette
  // demande-là escalade aussi, mais sous un autre nom, et un rapport qui dirait
  // « demande de prix » sur « combien de clients par mois ? » se relirait de
  // travers.
  //
  // HERMES-ACQUISITION-SERVICE-TRUTH-R1 §6 — une exclusion de plus, et elle ne
  // fait PLUS seulement choisir l'étiquette. « je dois mettre combien EN PUB ? »
  // ne demandait déjà pas nos honoraires ; sous r3 cela ne changeait rien,
  // puisque les deux demandes escaladaient. Sous r4, le budget publicitaire est
  // écrit et répondable, donc l'exclusion change l'ISSUE — il faut le dire
  // plutôt que le laisser découvrir.
  //
  // Elle reste étroite à dessein : seul « combien » suivi d'un mot qui NOMME la
  // dépense publicitaire est exclu. « je dois mettre combien ? » sans ce mot
  // reste une demande de prix, et « ça coûte combien en pub ? » escalade
  // toujours — `co[ûu]te?nt?` est une alternative distincte, que rien ici ne
  // touche.
  [
    'EXACT_PRICE',
    'demande de prix',
    demandPattern(
      "prix|tarifs?|factur\\w*|honoraires|devis|co[ûu]te?nt?\\b|c'est\\s+cher|" +
        // HERMES-TRIAL-IMPLEMENTATION-ROUTING-R1 — deux unités de DURÉE
        // rejoignent la liste des choses qu'on compte sans parler d'argent.
        //
        // « C'est sur combien de jours l'essai ? » relevait `EXACT_PRICE`, donc
        // escaladait en `pricing_policy_missing` — un motif faux : on demandait
        // une durée, pas un montant, et cette durée est écrite. `temps` était
        // déjà exclu pour exactement cette raison ; `jours` et `semaines` sont
        // la même unité sous un autre mot.
        //
        // « combien par mois » n'est PAS touché : l'exclusion ne porte que sur
        // la forme « combien DE <unité> », et un prix mensuel se demande sans
        // le « de ».
        'combien(?!\\s+(?:de\\s+(?:leads?|clients?|rendez[- ]vous|rdv|contacts?|appels?|temps|' +
        // HERMES-SEMANTIC-GROUNDING-R1 — « combien de MOIS » compte une durée,
        // pas des euros. Même exclusion que `temps`, `jours` et `semaines`, et
        // elle a la même cause : le corpus a mesuré que « il y a un engagement
        // de combien de mois ? » relevait une demande de PRIX, donc rendait
        // « aucune politique tarifaire » sur une question de contrat. Les deux
        // escaladent — le motif, lui, était faux.
        //
        // « combien PAR mois » n'est pas touché : l'exclusion ne porte que sur
        // la forme « combien DE <unité> », et un prix mensuel se demande sans
        // le « de ».
        'jours?|semaines?|mois|budget|' +
        'pub|publicit[ée]\\w*|%|pour\\s?cent)|' +
        'en\\s+(?:pub|publicit[ée]\\w*|ads?)|par\\s+jour\\s+en\\s+pub))',
    ),
  ],
  [
    'EXACT_PRICE',
    'demande de fourchette',
    demandPattern(
      'fourchette|ordre\\s+de\\s+grandeur|[àa]\\s+partir\\s+de\\s+combien|entre\\s+combien|' +
        'budget\\s+(?:n[ée]cessaire|[àa]\\s+pr[ée]voir)',
    ),
  ],
  // HERMES-SEMANTIC-GROUNDING-R1 — le prix RÉCURRENT, qui n'était nommé nulle
  // part.
  //
  // Le trou a été mesuré par le corpus sémantique, pas supposé : « c'est quoi
  // ton abonnement mensuel une fois l'essai fini ? » ne relevait AUCUNE demande
  // — ni prix (le lexique ne connaît que « prix », « tarif », « combien »), ni
  // engagement — et ne pouvait donc pas escalader. C'est exactement la demande
  // que ce dépôt ne sait PAS satisfaire : le prix d'après l'essai. Un faux
  // négatif ici laisse partir seule une réponse sur un montant que personne n'a
  // écrit, ce qui est la faute la plus grave de la liste.
  //
  // `POST_TRIAL_MARKER` (`sales/priceSubject.ts`) connaissait déjà ces mots, ce
  // qui rendait le trou invisible : le SUJET du prix se lisait « après l'essai »
  // dès qu'une autre demande était relevée, et jamais quand celle-ci était la
  // seule. Les deux lexiques disent désormais la même chose, et un test les
  // tient côte à côte.
  [
    'EXACT_PRICE',
    'demande de prix récurrent',
    demandPattern("abonnements?|mensualit[ée]s?|forfaits?|par\\s+mois\\s+[çc]a\\s+fait"),
  ],

  // ---- Une part -----------------------------------------------------------
  [
    'PERCENTAGE_OR_FEE',
    'demande de pourcentage',
    demandPattern('\\d{0,3}\\s*%|pourcentage|pour\\s?cent\\b'),
  ],
  ['PERCENTAGE_OR_FEE', 'demande de commission', demandPattern('commissions?\\b')],
  [
    'PERCENTAGE_OR_FEE',
    'demande de frais',
    demandPattern("frais\\s+(?:de|d')|vos\\s+frais|quels\\s+frais|marge\\b"),
  ],

  // ---- Un contrat ---------------------------------------------------------
  [
    'CONTRACT_COMMITMENT',
    'demande d’engagement contractuel',
    demandPattern('engagements?\\b|engager\\s+sur|contrats?\\b|contractuel\\w*'),
  ],
  [
    'CONTRACT_COMMITMENT',
    'demande de durée ou de sortie',
    demandPattern(
      "dur[ée]e\\s+(?:minimum|minimale|d'engagement)|pr[ée]avis|r[ée]silia\\w*|r[ée]silier|" +
        'exclusivit[ée]|clauses?\\b',
    ),
  ],

  // ---- Une garantie -------------------------------------------------------
  ['GUARANTEE', 'demande de garantie', demandPattern('garanti\\w*|garantissez|assurez[- ]vous\\s+que')],
  [
    'GUARANTEE',
    'demande de remboursement',
    demandPattern(
      'rembours\\w*|satisfait\\s+ou|si\\s+(?:[çc]a|cela)\\s+(?:ne\\s+)?(?:marche|fonctionne)\\s+pas',
    ),
  ],

  // ---- Un résultat promis -------------------------------------------------
  [
    'GUARANTEED_OUTCOME',
    'demande de volume promis',
    demandPattern(
      'combien\\s+de\\s+(?:leads?|clients?|rendez[- ]vous|rdv|contacts?|appels?)|' +
        'nombre\\s+de\\s+(?:leads?|clients?)|\\d+\\s+(?:leads?|clients?)\\s+par',
    ),
  ],
  [
    'GUARANTEED_OUTCOME',
    'demande de retour sur investissement',
    demandPattern(
      'roi\\b|retour\\s+sur\\s+investissement|rentab\\w*|' +
        '[çc]a\\s+rapporte\\s+combien',
    ),
  ],

  // ---- Un modèle de rémunération ------------------------------------------
  [
    'PERFORMANCE_MODEL',
    'demande sur le modèle à la performance',
    demandPattern(
      '[àa]\\s+la\\s+performance|au\\s+r[ée]sultat\\b|au\\s+succ[èe]s|success\\s+fee|' +
        'vous\\s+vous\\s+r[ée]mun[ée]rez|comment\\s+vous\\s+(?:vous\\s+)?(?:payez|r[ée]mun[ée]rez)|' +
        'vous\\s+prenez\\s+quoi',
    ),
  ],
  [
    'PERFORMANCE_MODEL',
    'demande de conditions de paiement',
    demandPattern('paiements?\\b|payer\\s+(?:quand|comment)|facturation'),
  ],

  // ---- Une preuve ---------------------------------------------------------
  [
    'PROOF_REQUEST',
    'demande de preuve chiffrée',
    demandPattern(
      'preuves?\\b|r[ée]sultats?\\s+(?:concrets?|chiffr[ée]s?|obtenus)|chiffres?\\b|statistiques?\\b|' +
        'des\\s+r[ée]sultats\\b',
    ),
  ],
  // HERMES-ACQUISITION-SERVICE-TRUTH-R1 §7 — les métriques, nommées.
  //
  // Elles ne relevaient AUCUNE demande : le lexique des preuves connaît le mot
  // « résultats », pas le vocabulaire du praticien. « Quel CPL ? » et « c'est
  // quoi ton taux de conversion ? » tombaient donc en `OTHER_QUESTION`, donc en
  // `topic_not_covered` — un refus juste sous un motif muet.
  //
  // Elles escaladent, et c'est le point de §7 : des valeurs sont OBSERVÉES sur
  // un cas réel (`sales/performanceEvidence.ts`), aucune n'a la provenance que
  // la règle de preuve de ce dépôt exige, et aucune preuve chiffrée n'est de
  // toute façon citable en réponse. Un chiffre observé chez quelqu'un d'autre
  // n'est promis à personne.
  [
    'PROOF_REQUEST',
    'demande de métrique chiffrée',
    demandPattern(
      'cpl(?![\\p{L}\\p{N}])|cpa(?![\\p{L}\\p{N}])|roas(?![\\p{L}\\p{N}])|' +
        'co[ûu]t\\s+par\\s+(?:lead|contact|demande|acquisition|client|rendez[- ]vous)|' +
        'prix\\s+(?:du|par)\\s+lead|' +
        'taux\\s+de\\s+(?:conversion|transformation|closing|clic|r[ée]ponse)',
    ),
  ],
  [
    'PROOF_REQUEST',
    'demande de références',
    demandPattern(
      'r[ée]f[ée]rences?\\b|t[ée]moignages?\\b|[ée]tudes?\\s+de\\s+cas|case\\s+study|' +
        'avis\\s+clients?\\b|portfolio|exemples?\\s+de\\s+clients?|vous\\s+avez\\s+d[ée]j[àa]\\s+fait',
    ),
  ],
];

/**
 * Ce que chaque demande rend impossible de répondre seul.
 *
 * `Record` complet et non partiel : ajouter un membre à `CommercialDemand` sans
 * dire ce qu'il escalade devient une erreur de compilation, et non un
 * `undefined` que la boucle sauterait en silence — c'est le défaut exact que la
 * table partielle de `autonomy.ts` rendait possible.
 */
/**
 * Ce que chaque demande DÉCLENCHE.
 *
 * `null` — et une seule entrée le porte — signifie « la politique commerciale
 * porte une réponse vraie à cette demande ». Ce n'est pas une exemption : c'est
 * l'existence d'un fait. Le jour où le prix après essai sera écrit, une seconde
 * entrée passera à `null`, et ce sera de la même façon — parce qu'une réponse
 * existera, pas parce qu'on aura décidé de tolérer.
 *
 * `Record` complet et non partiel : ajouter un membre à `CommercialDemand` sans
 * dire ce qu'il déclenche devient une erreur de compilation, et non un
 * `undefined` que la boucle sauterait en silence.
 */
export const DEMAND_ESCALATION: Readonly<
  Record<CommercialDemand, CommercialEscalationReason | null>
> = Object.freeze({
  EXACT_PRICE: 'pricing_policy_missing',
  PERCENTAGE_OR_FEE: 'pricing_policy_missing',
  CONTRACT_COMMITMENT: 'contract_terms_requested',
  GUARANTEE: 'guarantee_requested',
  GUARANTEED_OUTCOME: 'guarantee_requested',
  PERFORMANCE_MODEL: 'performance_model_requested',
  PROOF_REQUEST: 'proof_requested',
  TRIAL_TERMS: null,
  // HERMES-ACQUISITION-SERVICE-TRUTH-R1 §6 — la SECONDE entrée à passer à
  // `null`, et par le mécanisme que ce fichier avait prévu : une réponse vraie
  // existe désormais (`sales/acquisitionService.ts`, facette `AD_BUDGET`).
  //
  // Ce n'est pas une exemption. Le message qui demande AUSSI un prix, un
  // pourcentage ou une garantie relève ces demandes-là en plus, la lecture
  // reste cumulative, et `firstEscalatingDemand` retient la première qui
  // engage — donc il escalade comme avant.
  AD_SPEND_AMOUNT: null,
});

/** Ce que chaque manque de grounding rend impossible de répondre seul. */
export const GAP_ESCALATION: Readonly<Partial<Record<GroundingGap, CommercialEscalationReason>>> =
  Object.freeze({
    PRICING_POLICY_MISSING: 'pricing_policy_missing',
    NO_GUARANTEE_TO_OFFER: 'guarantee_requested',
    PROOF_NOT_QUOTABLE_IN_REPLY: 'proof_requested',
    TOPIC_NOT_COVERED_BY_DATA: 'topic_not_covered',
  });

export interface CommercialDemandFinding {
  readonly demand: CommercialDemand;
  /** Le libellé du motif reconnu. Jamais un extrait du message. */
  readonly label: string;
  /** `null` quand la politique porte une réponse vraie à cette demande. */
  readonly reason: CommercialEscalationReason | null;
  /**
   * Hermes peut-il répondre seul à cette demande ?
   *
   * Redondant avec `reason === null`, et gardé pour cette raison : un appelant
   * qui lit `answerable` dit ce qu'il veut savoir, là où `reason === null` se
   * relit de travers — on croit lire « aucune raison de refuser » alors qu'on
   * lit « aucune raison d'escalader ». Sur une question qui décide ce qui part
   * vers un prospect, l'ambiguïté de lecture n'est pas acceptable.
   */
  readonly answerable: boolean;
  /**
   * HERMES-TRIAL-COST-VS-POST-TRIAL-PRICING-R1 §2 — le SUJET du prix demandé.
   *
   * `null` sur toute demande qui n'est pas `EXACT_PRICE` : les autres ne
   * portent pas cette question, et leur inventer un sujet ferait croire qu'un
   * raffinement les concerne. Sur `EXACT_PRICE`, il dit à quoi le montant
   * demandé se rapporte — et c'est lui qui explique pourquoi cette demande-ci a
   * escaladé quand la même étiquette, hier, ne l'a pas fait.
   */
  readonly priceSubject: PriceSubject | null;
  /**
   * HERMES-SEMANTIC-GROUNDING-R1 — DANS QUELLE BOUCHE ce motif a été reconnu.
   *
   * `CURRENT` veut dire « cette personne nous demande cela, maintenant ». Les
   * quatre autres cadres décrivent des façons de PARLER d'une demande sans la
   * formuler : rapporter celle d'un tiers, citer, nier, envisager.
   *
   * Il ne remplace pas `reason` et ne le corrige pas : `reason` continue de
   * dire « ce que cette demande coûterait si elle nous était adressée », ce qui
   * reste vrai et reste ce qu'un rapport doit lire. C'est
   * `firstEscalatingDemand` — la seule fonction qu'une porte a le droit
   * d'appeler — qui refuse d'escalader sur un cadre non courant.
   */
  readonly frame: UtteranceFrame;
}

/**
 * §2 — la lecture RAFFINÉE d'une demande, sujet compris.
 *
 * Elle part TOUJOURS de `DEMAND_ESCALATION`, qui reste le défaut et reste
 * l'escalade. Le raffinement ne peut donc qu'annuler une escalade là où une
 * vérité canonique existe, jamais en créer une nouvelle ni en manquer une : si
 * cette fonction disparaissait, le comportement retomberait mot pour mot sur
 * celui de r4.
 *
 * `EXACT_PRICE` et lui seul. Les autres demandes traversent sans être relues —
 * un pourcentage reste un pourcentage quel que soit ce qu'il rémunère, et lui
 * chercher un sujet ouvrirait une porte que personne n'a demandée.
 */
function refineDemand(
  demand: CommercialDemand,
  label: string,
  price: PriceSubjectReading,
  frame: UtteranceFrame,
): CommercialDemandFinding {
  const fallback = DEMAND_ESCALATION[demand];
  if (demand !== 'EXACT_PRICE') {
    return Object.freeze({
      demand,
      label,
      reason: fallback,
      answerable: fallback === null,
      priceSubject: null,
      frame,
    });
  }

  // Couvert : une vérité canonique répond à CE sujet-là. Le libellé porte le
  // sujet, pour qu'un rapport dise « demande de prix — le coût du test » plutôt
  // que de laisser un lecteur reconstituer la conversation.
  const reason = price.covered ? null : fallback;
  return Object.freeze({
    demand,
    label: `${label} — ${price.label}`,
    reason,
    answerable: reason === null,
    priceSubject: price.subject,
    frame,
  });
}

/**
 * HERMES-SEMANTIC-GROUNDING-R1 — la demande que le MODÈLE a nommée, quand le
 * lexique l'a manquée.
 *
 * ---------------------------------------------------------------------------
 * Une seconde opinion, et une seule direction
 * ---------------------------------------------------------------------------
 * Le lexique est un lexique : il reconnaît des mots. Le corpus sémantique de ce
 * round a mesuré ce qu'il ne voit pas — « c'est quoi ton abonnement mensuel une
 * fois l'essai fini ? » ne relevait AUCUNE demande avant qu'on lui apprenne le
 * mot « abonnement ». Il en reste, et il en restera : une langue ne se ferme
 * pas.
 *
 * Cette fonction lit la conclusion du modèle sur la demande COURANTE et la
 * traduit en demande commerciale — mais dans une seule direction. Elle ne peut
 * qu'AJOUTER une escalade, jamais en retirer une, et seulement sur les sujets
 * qu'aucune vérité de ce dépôt ne couvre (`UNCOVERED_CURRENT_REQUESTS`).
 *
 * Le côté sûr est celui-là, et il n'est pas symétrique : un modèle qui dirait à
 * tort « elle demande un prix » coûte une escalade, c'est-à-dire le
 * comportement d'avant ce round. Un modèle qui dirait à tort « elle ne demande
 * rien » ne coûte rien, parce qu'on ne l'écoute pas dans ce sens-là — le cadre
 * d'énonciation, lui, est lu par du code testé.
 *
 * Le cadre rendu est `CURRENT` : c'est la définition même de ce champ. Un
 * modèle qui nomme une demande courante affirme qu'elle nous est adressée.
 */
export function demandFromCurrentRequest(
  topic: CurrentRequestTopic | null,
): CommercialDemandFinding | null {
  if (topic === null) return null;
  if (!UNCOVERED_CURRENT_REQUESTS.has(topic)) return null;

  const mapping: Readonly<Record<string, readonly [CommercialDemand, string]>> = {
    POST_TRIAL_PRICE: ['EXACT_PRICE', 'demande de prix après l’essai, lue par le modèle'],
    PERCENTAGE_OR_FEE: ['PERCENTAGE_OR_FEE', 'demande de part ou de frais, lue par le modèle'],
    GUARANTEE: ['GUARANTEE', 'demande de garantie, lue par le modèle'],
    REFUND: ['GUARANTEE', 'demande de remboursement, lue par le modèle'],
    COMMITMENT: ['CONTRACT_COMMITMENT', 'demande d’engagement, lue par le modèle'],
    EXPECTED_RESULTS: ['GUARANTEED_OUTCOME', 'demande de résultat promis, lue par le modèle'],
  };
  const entry = mapping[topic];
  if (entry === undefined) return null;

  const [demand, label] = entry;
  const reason = DEMAND_ESCALATION[demand];
  return Object.freeze({
    demand,
    label,
    reason,
    answerable: reason === null,
    priceSubject: null,
    frame: 'CURRENT' as const,
  });
}

/**
 * La première demande qui ÉCARTE l'autonomie, ou `null`.
 *
 * C'est la seule question qu'une porte a le droit de poser à cette liste. La
 * distinction avec `firstCommercialDemand` est exactement celle qui compte :
 * « de quoi ce message parle-t-il, commercialement ? » n'est pas « ce message
 * empêche-t-il de répondre seul ? », et confondre les deux ferait escalader un
 * prospect qui demande simplement ce qu'il paie pendant le test.
 */
export function firstEscalatingDemand(
  findings: readonly CommercialDemandFinding[],
): CommercialDemandFinding | null {
  // HERMES-SEMANTIC-GROUNDING-R1 — le CADRE passe avant le motif.
  //
  // Une demande dont le cadre n'est pas `CURRENT` n'a été adressée à personne
  // ici : elle est rapportée, citée, niée ou envisagée. Escalader dessus fait
  // attendre un humain pour une question que le prospect n'a pas posée — et
  // c'est exactement ce qui est arrivé le 23 août 2026 sur « j'avais des gens
  // qui demandaient le prix ».
  //
  // La condition est une CONJONCTION, dans cet ordre : le cadre d'abord, le
  // motif ensuite. Supprimer `frameEngages` referait escalader tout ce qui
  // escaladait avant, sans rien ouvrir de neuf : c'est le sens de fail-closed
  // ici, et un test le vérifie en rejouant la liste sans le cadre.
  return findings.find((finding) => frameEngages(finding.frame) && finding.reason !== null) ?? null;
}

/**
 * Relève toutes les demandes commerciales d'un message entrant.
 *
 * Le texte est normalisé avant lecture — même raison que `signals.ts` : les
 * claviers réels produisent l'apostrophe typographique, les lexiques sont
 * écrits à l'apostrophe droite, et sans normalisation la détection marcherait
 * sur les textes de test et échouerait en silence sur les vrais messages.
 *
 * Rend au plus une entrée par `CommercialDemand` : deux formulations de la même
 * demande sont la même demande, et les compter deux fois ne rendrait pas le
 * refus plus vrai. La première formulation reconnue donne le libellé.
 */
export function readCommercialDemands(text: string): readonly CommercialDemandFinding[] {
  // HERMES-SEMANTIC-GROUNDING-R1 — le message est découpé UNE fois, et les
  // motifs sont situés dedans plutôt que testés à plat.
  //
  // `scope.normalized` est exactement ce que `normalizeForMatching` rendait :
  // les lexiques lisent le même texte qu'avant, aux mêmes indices, et le
  // découpage ne fait qu'ajouter une réponse à « où ce mot a-t-il été
  // reconnu ? ».
  const scope = scopeUtterance(text);
  // §2 — le sujet est lu UNE fois, sur le texte entier, et partagé par toutes
  // les demandes relevées. Le relire par demande donnerait le même résultat et
  // laisserait croire qu'un sujet peut différer d'une étiquette à l'autre dans
  // le même message : c'est le message qui porte le sujet, pas l'étiquette.
  const price = resolvePriceSubject(text);
  const seen = new Set<CommercialDemand>();
  const findings: CommercialDemandFinding[] = [];
  for (const [demand, label, pattern] of DEMAND_PATTERNS) {
    if (seen.has(demand)) continue;
    const frame = frameOfPattern(scope, pattern);
    if (frame === null) continue;
    seen.add(demand);
    findings.push(refineDemand(demand, label, price, frame));
  }
  return Object.freeze(findings);
}

/**
 * La demande commerciale qui écarte l'autonomie, ou `null`.
 *
 * L'ordre de `DEMAND_PATTERNS` décide laquelle est nommée quand il y en a
 * plusieurs. Ce n'est pas un arbitrage de fond — toutes escaladent — mais un
 * choix de LISIBILITÉ : un rapport qui dit « demande de prix » sur un message
 * qui demande un prix ET une garantie apprend plus qu'un rapport qui aurait
 * choisi la seconde au hasard de l'implémentation.
 */
export function firstCommercialDemand(text: string): CommercialDemandFinding | null {
  return readCommercialDemands(text)[0] ?? null;
}

/**
 * §1 — la demande commerciale portée par les SIGNAUX déjà lus.
 *
 * Complète `readCommercialDemands` plutôt que de la remplacer : les signaux
 * viennent d'une lecture orientée par la conclusion D2, le lexique d'ici d'une
 * lecture brute. Les deux se trompent différemment, et c'est précisément
 * pourquoi les deux sont appelées.
 *
 * HERMES-SEMANTIC-GROUNDING-R1 — le cadre rendu ici est `CURRENT`, et ce n'est
 * pas une dispense : `readSignals` ne retient plus un sujet de QUESTION qu'une
 * portion COURANTE ne porte pas. Un sujet lu par les signaux est donc courant
 * par construction, et l'écrire en toutes lettres vaut mieux que de le
 * recalculer une seconde fois — deux lectures voisines de la même question
 * finissent par diverger, et c'est toujours la plus indulgente qui gagne.
 */
export function signalCommercialDemand(
  signals: ConversationSignals,
  text?: string,
): CommercialDemandFinding | null {
  if (signals.questionTopic === 'PRICE' || signals.objectionTopic === 'NO_BUDGET') {
    // §2 — la lecture par signaux se raffine comme la lecture lexicale, et sous
    // DEUX conditions, toutes deux fail-closed.
    //
    // La première est l'existence du texte. Cette fonction a longtemps travaillé
    // sur les seuls signaux ; un appelant qui ne le passe pas obtient donc
    // l'escalade d'avant ce round, sans qu'aucun sujet ne soit deviné.
    //
    // La seconde est que l'objection de budget NE se raffine PAS. « Je n'ai pas
    // le budget » n'est pas une question sur le coût du test : c'est un refus
    // qui porte sur ce que nous coûterions, c'est-à-dire précisément ce que
    // personne n'a écrit. Lui appliquer la vérité de l'essai répondrait à côté.
    const price =
      text !== undefined && signals.objectionTopic !== 'NO_BUDGET'
        ? resolvePriceSubject(text)
        : null;
    if (price !== null && price.covered) {
      return Object.freeze({
        demand: 'EXACT_PRICE' as const,
        label: `sujet de prix lu par les signaux — ${price.label}`,
        reason: null,
        answerable: true,
        priceSubject: price.subject,
        frame: 'CURRENT' as const,
      });
    }
    return Object.freeze({
      demand: 'EXACT_PRICE' as const,
      label:
        price === null
          ? 'sujet de prix lu par les signaux'
          : `sujet de prix lu par les signaux — ${price.label}`,
      reason: DEMAND_ESCALATION.EXACT_PRICE,
      answerable: false,
      priceSubject: price?.subject ?? null,
      frame: 'CURRENT' as const,
    });
  }
  if (signals.questionTopic === 'GUARANTEE') {
    return Object.freeze({
      demand: 'GUARANTEE' as const,
      label: 'sujet de garantie lu par les signaux',
      reason: DEMAND_ESCALATION.GUARANTEE,
      answerable: false,
      priceSubject: null,
      frame: 'CURRENT' as const,
    });
  }
  if (signals.questionTopic === 'RESULTS_PROOF') {
    return Object.freeze({
      demand: 'PROOF_REQUEST' as const,
      label: 'sujet de preuve lu par les signaux',
      reason: DEMAND_ESCALATION.PROOF_REQUEST,
      answerable: false,
      priceSubject: null,
      frame: 'CURRENT' as const,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. Ce que le brouillon ÉCRIRAIT
// ---------------------------------------------------------------------------

/**
 * Les promesses qu'aucune politique n'a définies, détectées dans un texte que
 * NOUS écririons.
 *
 * C'est `detectPerformanceClaims` (`learning/offer.ts`), nommée ici et non
 * recopiée. Un second lexique finirait par répondre non d'un côté et oui de
 * l'autre sur la même phrase, et c'est toujours le plus indulgent qui
 * gagnerait — le fichier d'origine le dit déjà, mot pour mot, et ce round s'y
 * range plutôt que d'ouvrir l'exception.
 *
 * Les cinq formulations que la mission met explicitement sur la table — « vous
 * ne payez que si… », « gratuit jusqu'aux résultats », « aucun risque »,
 * « résultats garantis », « X clients garantis » — y sont toutes couvertes, et
 * un test le vérifie phrase par phrase plutôt que sur parole.
 */
export function forbiddenCommercialClaims(text: string): readonly string[] {
  return detectPerformanceClaims(text);
}

// ---------------------------------------------------------------------------
// 4. Ce que le prompt en lit
// ---------------------------------------------------------------------------

/**
 * La politique, rendue pour un prompt.
 *
 * Une seule source : si les listes changent, le prompt change avec elles. C'est
 * l'exigence « ne disperse pas ses règles dans plusieurs prompts non
 * traçables » prise au mot — il n'y a pas de texte de politique ailleurs qu'ici.
 */
export function renderCommercialPolicyBlock(): string {
  const lines: string[] = [
    `POLITIQUE COMMERCIALE (${COMMERCIAL_POLICY_VERSION}) — CE QUE TU PEUX ENGAGER`,
    '',
    'Tu peux, seul :',
  ];
  for (const entry of AUTONOMOUS_COMMERCIAL_SCOPE) lines.push(`- ${entry}`);
  lines.push('', 'Tu ne peux PAS, jamais, même si on te le demande directement :');
  for (const entry of AUTONOMOUS_COMMERCIAL_LIMITS) lines.push(`- ${entry}`);
  lines.push(
    '',
    'Si la question porte sur l’un de ces points, ne réponds pas à côté et n’invente pas de',
    'condition : dis honnêtement que cela dépend de la situation et que tu préfères en parler.',
    'Un humain reprendra la main — c’est une issue normale, pas un échec.',
  );
  return lines.join('\n');
}
