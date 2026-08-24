/**
 * CONVERSATION-R1 — les sous-signaux, sous la taxonomie D2 et jamais à côté.
 *
 * D2 répond à « qu'est-ce que ce message VEUT dire » (`ReplyCategory`). Ce
 * fichier répond à « de quoi parle-t-il, précisément » — le sujet d'une
 * question, le sujet d'une objection, la force d'un signal d'achat, la maturité
 * d'une proposition d'échange.
 *
 * Ces deux couches ne peuvent pas se contredire parce qu'elles ne répondent pas
 * à la même question. `QUESTION` + `PRICE` est une lecture ; `QUESTION` +
 * `OBJECTION` en serait deux, et c'est exactement ce qu'on refuse : rien ici ne
 * produit ni ne corrige une `ReplyCategory`. Une seconde taxonomie concurrente
 * finirait par gagner sur la première dans un cas limite, et le système aurait
 * deux vérités sur le même message.
 *
 * Tout est déterministe (CLAUDE.md : la logique décidable est du code testé).
 * Un sujet non reconnu vaut `NONE` ou `OTHER_*` — jamais une supposition.
 */

import { normalizeForMatching } from '@/lib/conversation/text';
import { frameOfPattern, scopeUtterance, type UtteranceScope } from '@/lib/conversation/utteranceScope';
import type { ConversationThread } from '@/lib/conversation/thread';
import type { ReplyCategory } from '@/lib/replies/taxonomy';

// ---------------------------------------------------------------------------
// Les sujets
// ---------------------------------------------------------------------------

export type QuestionTopic =
  | 'WHAT_YOU_DO'
  | 'PRICE'
  | 'HOW_IT_WORKS'
  | 'RESULTS_PROOF'
  | 'GUARANTEE'
  | 'WHO_ARE_YOU'
  /**
   * HERMES-CONTACT-PURPOSE-R1 — « pourquoi tu me demandes ça ? ».
   *
   * La question la plus prévisible de toute prospection à froid, et la seule
   * qui n'avait pas de sujet. Elle tombait donc en `OTHER_QUESTION`, qui ouvre
   * `TOPIC_NOT_COVERED_BY_DATA`, donc `HUMAN_ESCALATION:topic_not_covered` —
   * un refus exact tant que le dépôt ne portait pas son motif de contact, et
   * faux depuis que `sales/contactPurpose.ts` l'écrit.
   *
   * Distinct de `WHO_ARE_YOU` (« vous êtes qui ? ») et de `WHAT_YOU_DO`
   * (« vous faites quoi ? ») : les trois se répondent avec le même motif, mais
   * un rapport qui les confondrait ferait chercher une présentation là où on
   * demandait une justification.
   */
  | 'CONTACT_PURPOSE'
  /**
   * HERMES-ACQUISITION-SERVICE-TRUTH-R1 — les six sujets qui manquaient.
   *
   * Ils ont tous coûté la même chose le 23 août 2026 : « Ok mais concrètement
   * tu fais quoi pour trouver des clients ? » n'avait AUCUN sujet, tombait donc
   * en `OTHER_QUESTION`, qui ouvre `TOPIC_NOT_COVERED_BY_DATA`, donc
   * `HUMAN_ESCALATION:topic_not_covered`.
   *
   * Le refus était exact tant que le dépôt ne savait pas dire ce qu'il fait. Il
   * est faux depuis que `sales/acquisitionService.ts` l'écrit. Ces sujets sont
   * la case qui manquait, un par question réellement distincte — et non un
   * fourre-tout : un rapport qui dirait « question sur le service » sur « quel
   * budget faut-il ? » ferait chercher une explication de métier là où on
   * demandait un montant.
   *
   * Un sept-ième cas a été délibérément laissé DEHORS : le taux de conversion.
   * Aucune vérité ne le couvre, et lui donner un sujet aurait laissé croire
   * qu'une réponse existe. Il escalade, comme avant.
   */
  /** « concrètement tu fais quoi ? », « comment tu trouves les clients ? », « tu fais de la pub ? ». */
  | 'ACQUISITION_METHOD'
  /** « quand un lead arrive je fais quoi ? », « tu les qualifies ? », « tu utilises un CRM ? ». */
  | 'LEAD_HANDLING'
  /** « tu fais Google Ads ? » — un canal que nous ne poussons pas aujourd'hui. */
  | 'SEARCH_ADS'
  /** « quel budget pour commencer ? » — le budget PUBLICITAIRE, pas nos honoraires. */
  | 'AD_BUDGET'
  /** « je dois te donner accès à quoi ? ». */
  | 'ASSET_ACCESS'
  /** « tu bosses aussi avec mon concurrent ? ». */
  | 'GEO_EXCLUSIVITY'
  /** « en combien de temps ça marche ? » — distinct de `TIMING`, qui reste générique. */
  | 'RESULT_TIMING'
  /**
   * HERMES-TRIAL-IMPLEMENTATION-ROUTING-R1 — les deux sujets de l'ESSAI qui
   * manquaient, et pourquoi ils ne pouvaient pas être un seul.
   *
   * Le 23 août 2026, « Ok concrètement pendant les 7 jours tu met quoi en
   * place ? » a fini en `HUMAN_ESCALATION:topic_not_covered`. D2 avait compris
   * (`QUESTION`, 0,99), et le brouillon écrit malgré le refus était juste. Ce
   * qui manquait n'était pas une VÉRITÉ — `TRIAL_FACTS` dit depuis
   * HERMES-SALES-KNOWLEDGE-R1 que « pendant ces sept jours, je mets en place au
   * minimum les publicités Meta et le CRM », et `ACQUISITION_TRUTH` dit la
   * chaîne complète — mais une CASE : aucun des dix-neuf sujets ne décrivait
   * « qu'est-ce que tu mets en place pendant le test ? », donc le message
   * tombait en `OTHER_QUESTION`, qui ouvre `TOPIC_NOT_COVERED_BY_DATA`.
   *
   * C'est le même trou, à la même place, que `CONTACT_PURPOSE` et
   * `ACQUISITION_METHOD` ont bouché avant eux, et il se ferme de la même
   * façon : un sujet par question réellement distincte, et une composition de
   * vérités déjà écrites plutôt qu'une vérité de plus.
   *
   * Les deux sujets sont SÉPARÉS parce que leurs réponses le sont. « Le test
   * dure combien de temps ? » se répond par la durée seule, et la vérité de
   * service n'a rien à y faire ; « pendant les 7 jours tu mets quoi en
   * place ? » se répond par la chaîne, et la durée n'y ajoute rien. Les
   * confondre ferait injecter dans le prompt, à chaque fois, la moitié dont le
   * prospect n'a pas parlé.
   *
   * Un troisième et un quatrième cas existent déjà et ne bougent PAS : le COÛT
   * du test et le prix d'APRÈS sont lus par `sales/priceSubject.ts`, qui répond
   * à une question que `questionTopic` ne pose pas — « ce prix, c'est le prix
   * de quoi ? ». Ces deux-là restent en `PRICE`, et ce round ne les touche pas.
   */
  /** « le test dure combien de temps ? », « c'est sur combien de jours l'essai ? ». */
  | 'TRIAL_DURATION'
  /** « pendant les 7 jours tu mets quoi en place ? », « le test comprend quoi ? ». */
  | 'TRIAL_IMPLEMENTATION'
  | 'MORE_INFO'
  | 'CALL_REQUEST'
  | 'TIMING'
  | 'OTHER_QUESTION'
  | 'NONE';

export type ObjectionTopic =
  | 'ALREADY_HAS_PROVIDER'
  | 'ALREADY_DOES_ADS'
  | 'NO_BUDGET'
  | 'NO_TIME'
  | 'NOT_A_PRIORITY'
  | 'TRUST'
  | 'OTHER_OBJECTION'
  | 'NONE';

export type BuyingSignal = 'NONE' | 'WEAK' | 'MODERATE' | 'STRONG';

/**
 * La maturité d'une proposition d'échange.
 *
 * Rien d'équivalent n'existait dans le dépôt : `live_ready` parle d'un
 * manifeste prêt à partir, pas d'une conversation prête pour un appel. Le
 * vocabulaire est donc neuf, et il est délibérément à trois crans — un booléen
 * forcerait à trancher « oui/non » là où le cas fréquent est « pas encore ».
 */
export type CallReadiness = 'LOW' | 'MEDIUM' | 'HIGH';

/** Ce qui doit sortir du chemin automatique, quoi que dise D2 par ailleurs. */
export type SensitiveFlag =
  | 'LEGAL_THREAT'
  | 'HOSTILE'
  | 'DATA_PRIVACY_DEMAND'
  | 'IMPERSONATION_CLAIM';

export interface ConversationSignals {
  readonly questionTopic: QuestionTopic;
  readonly objectionTopic: ObjectionTopic;
  readonly buyingSignal: BuyingSignal;
  readonly callReadiness: CallReadiness;
  readonly sensitiveFlags: readonly SensitiveFlag[];
  /** La personne a explicitement demandé un appel / un échange de vive voix. */
  readonly explicitCallRequest: boolean;
  /** Le message est trop court pour porter un sujet identifiable. */
  readonly tooShortToRead: boolean;
}

// ---------------------------------------------------------------------------
// Lexiques
// ---------------------------------------------------------------------------

/**
 * HERMES-SALES-KNOWLEDGE-R1 — la frontière de mot, en UNICODE et non en ASCII.
 *
 * Ces lexiques étaient bornés par `\b`, qui ne connaît que `[A-Za-z0-9_]`.
 * Devant « ça m'intéresse » il exige donc une frontière entre une espace et un
 * « ç » — deux caractères qui ne sont NI l'un ni l'autre des « mots » à ses
 * yeux. Il n'y a pas de frontière, et le motif ne matche jamais. Même défaut à
 * la sortie : « je suis intéressé » finit sur un « é », donc le `\b` final
 * échoue aussi.
 *
 * Le défaut a été MESURÉ, pas supposé : les deux signaux d'achat les plus
 * francs du français — « ça m'intéresse » et « je suis intéressé » — ne se
 * déclenchaient jamais tels qu'on les écrit vraiment. Ils tombaient sur la
 * variante sans accent (« ca m'interesse »), qu'aucun clavier ne produit
 * spontanément. Conséquence directe : `buyingSignal` restait sous `STRONG`,
 * `callReadiness` sous `HIGH`, et un prospect qui venait de dire oui n'était
 * pas lu comme tel — ce qui coûte exactement ce que cette mission cherche à
 * obtenir, un rendez-vous.
 *
 * C'est le défaut que `commercialPolicy.ts` raconte déjà pour ses propres
 * motifs, et la correction est la même : des lookarounds Unicode aux DEUX
 * bouts. Ils sont un sur-ensemble strict du comportement correct — sur un mot
 * ASCII, ils font exactement ce que `\b` faisait.
 *
 * Aucun vocabulaire n'est ajouté ici : seules les bornes changent.
 */
const WORD_START = '(?<![\\p{L}\\p{N}_])';
const WORD_END = '(?![\\p{L}\\p{N}_])';

/**
 * HERMES-END-TO-END-CERTIFICATION-R1 — un SAUT DE MOTS, et ce qui doit suivre.
 *
 * `[^.!?]{0,N}` se lit « saute jusqu'à N caractères sans quitter la phrase ».
 * Écrit nu, il laisse le motif suivant commencer AU MILIEU d'un mot, parce que
 * les bornes de `bounded()` n'entourent que l'alternation ENTIÈRE — pas chacun
 * de ses morceaux internes.
 *
 * Le défaut a été mesuré, pas supposé. `AD_BUDGET` portait
 * `combien` + un saut nu + `(?:de\s+)?(?:…|ads?(?![\p{L}])|…)` : devant « En général
 * combien de leads deviennent clients ? », le saut consomme « de le » et le
 * motif matche les trois dernières lettres de « leads ». La question la plus
 * banale d'une conversation commerciale — le taux de transformation — se lisait
 * donc comme une question sur le BUDGET PUBLICITAIRE, c'est-à-dire le seul
 * sujet du dépôt qui ouvre des montants citables (20 et 25 €). Trois formes
 * réelles tombaient dedans : « combien de leads par mois ? », « tu me ramènes
 * combien de leads ? », et celle du dessus.
 *
 * Chaque saut est donc suivi, dans le motif lui-même, du même lookbehind que
 * `WORD_START` : ce qui suit commence sur une frontière de mot. Le motif ne
 * peut qu'en matcher MOINS — un morceau qui commençait au milieu d'un mot ne
 * matche plus, et rien d'autre ne change. C'est le resserrement que
 * `WORD_START` avait apporté aux entrées de lexique, appliqué à l'endroit
 * qu'il avait laissé ouvert.
 *
 * L'ancre est écrite EN TOUTES LETTRES dans chaque motif plutôt que produite
 * par une fonction : ces lexiques sont des chaînes ordinaires concaténées, pas
 * des littéraux de gabarit, et une interpolation y serait recopiée telle
 * quelle — un `${…}` littéral dans une expression régulière, c'est-à-dire une
 * erreur de syntaxe à la construction. Le trajet a été fait, il ne le sera pas
 * deux fois.
 */

/** Compose une alternative en motif borné aux deux bouts, insensible à la casse. */
function bounded(alternatives: string): RegExp {
  return new RegExp(`${WORD_START}(?:${alternatives})${WORD_END}`, 'iu');
}

/**
 * HERMES-TRIAL-IMPLEMENTATION-ROUTING-R1 — l'ancre de l'ESSAI, écrite une fois.
 *
 * Recopiée depuis `sales/offer.ts` dans son esprit et non dans sa lettre : ici
 * les formes verbales sont REFUSÉES (`tests?(?![\p{L}])` exclut « tester » et
 * « testé »), parce que les deux sujets ci-dessous ne sont pas conditionnés à
 * un marqueur de prix comme l'est `sales/priceSubject.ts`. « Je vais tester
 * avec quelqu'un d'autre » et « on a testé la pub une fois » sont des refus et
 * des objections, pas des questions sur notre essai ; les lire comme telles
 * ferait pitcher sur un verbe.
 */
const TRIAL_ANCHOR_ALT =
  "(?:7|sept)\\s*jours?|essais?(?![\\p{L}])|tests?(?![\\p{L}])|" +
  "p[ée]riode\\s+(?:de\\s+(?:test|d[ée]couverte)|d'essai)|phase\\s+de\\s+test|" +
  "semaine\\s+(?:de\\s+)?(?:test|d'essai)";

/**
 * Ce qu'on MET EN PLACE, du côté du verbe.
 *
 * Une famille de verbes d'installation et une famille d'inclusion — « tu mets
 * quoi en place », « le test comprend quoi ». Les verbes d'installation
 * exigent leur sujet (`tu`/`vous`) : sans lui, « je mets en place mon propre
 * système » parlerait du prospect, pas de nous.
 */
const SETUP_VERB_ALT =
  "(?:tu|vous)\\s+(?:mets?|mettez|installes?|installez|configures?|configurez|" +
  "param[èe]tres?|param[ée]trez|g[èe]res?|g[ée]rez|fais|faites|lances?|lancez|" +
  "pr[ée]pares?|pr[ée]parez|cr[ée]es?|cr[ée]ez)" +
  "|(?:mets?|mettez|met)\\s+(?:quoi\\s+)?en\\s+place|mise\\s+en\\s+place" +
  "|compris|comprend|comprends|inclus|inclut|incluses?|contient|comporte" +
  "|il\\s+y\\s+a\\s+quoi|on\\s+a\\s+quoi";

const QUESTION_PATTERNS: ReadonlyArray<readonly [QuestionTopic, RegExp]> = [
  // L'ordre compte : le premier motif qui matche gagne. « c'est combien pour
  // savoir ce que vous faites » est d'abord une question de prix.
  //
  // HERMES-ACQUISITION-SERVICE-TRUTH-R1 — deux sujets passent DEVANT le prix, et
  // l'ordre est le sujet.
  //
  // `PRICE` s'ouvre sur `combien` nu, ce qui lui fait attraper « en combien de
  // temps ça marche ? » et « combien de budget pub par jour ? ». Les deux sont
  // des questions auxquelles une vérité répond désormais, et les laisser en
  // `PRICE` les enverrait sur `EXPLAIN_MODEL`, donc sur une escalade « aucune
  // politique tarifaire » — un motif faux dans les deux cas, puisqu'on ne
  // demandait pas nos honoraires.
  //
  // Rien n'est desserré au passage : les deux motifs ci-dessous exigent un mot
  // qui n'a rien à voir avec un tarif (« combien de temps », « budget »), et le
  // lexique des DEMANDES de `commercialPolicy.ts` — qui décide seul de ce qui
  // escalade — n'est pas touché. « c'est combien ? » reste `PRICE`.
  // HERMES-TRIAL-IMPLEMENTATION-ROUTING-R1 — la durée DE L'ESSAI, devant
  // `RESULT_TIMING`, et l'ordre est le sujet.
  //
  // « Le test dure combien de temps ? » sortait en `RESULT_TIMING`, donc
  // ouvrait la facette qui dit « je ne peux pas annoncer de délai ». C'est vrai
  // d'un RÉSULTAT et faux d'un ESSAI : sa durée est écrite depuis
  // HERMES-SALES-KNOWLEDGE-R1, elle vaut sept jours, et répondre « ça dépend »
  // à une question dont la réponse est écrite est le défaut que ce round
  // corrige, pas une prudence.
  //
  // Le motif est serré exprès : la durée et l'ancre d'essai doivent se toucher
  // (vingt caractères au plus). « En combien de temps j'ai des résultats avec
  // le test ? » les sépare de bien davantage et reste donc `RESULT_TIMING` —
  // ce qui est la bonne lecture, puisque ce qu'on y demande est un délai de
  // résultat.
  [
    'TRIAL_DURATION',
    bounded(
      "(?:dur[ée]\\w*|combien\\s+de\\s+temps|combien\\s+de\\s+jours|combien\\s+de\\s+semaines?|" +
        "sur\\s+combien|[çc]a\\s+dure)[^.!?]{0,20}(?<![\\p{L}\\p{N}_])(?:" +
        TRIAL_ANCHOR_ALT +
        ")" +
        "|(?:" +
        TRIAL_ANCHOR_ALT +
        ")[^.!?]{0,20}(?<![\\p{L}\\p{N}_])(?:dure\\w*|dur[ée]e|combien\\s+de\\s+temps|" +
        "combien\\s+de\\s+jours|combien\\s+de\\s+semaines?|c'est\\s+sur\\s+combien|" +
        "[çc]a\\s+fait\\s+combien\\s+de\\s+temps)",
    ),
  ],
  [
    'RESULT_TIMING',
    bounded(
      // « en combien de temps », « dans combien de temps », « au bout de combien de temps »
      "(?:en|dans|apr[èe]s|au\\s+bout\\s+de|sous)\\s+combien\\s+de\\s+temps" +
        // « combien de temps pour / avant / faut-il »
        "|combien\\s+de\\s+temps" +
        // « ça prend combien de temps », « ça met combien de temps »
        "|[çc]a\\s+(?:prend|met|demande)\\s+combien" +
        // « à partir de quand ça marche », « quand est-ce que ça donne des résultats »
        "|quand[^.!?]{0,25}(?<![\\p{L}\\p{N}_])(?:[çc]a\\s+(?:marche|fonctionne|donne)|premiers?\\s+r[ée]sultats?|" +
        "premi[èe]res?\\s+demandes?)" +
        "|premiers?\\s+r[ée]sultats?\\s+(?:au\\s+bout|dans|en|sous)",
    ),
  ],
  [
    'AD_BUDGET',
    bounded(
      // « quel budget », « quel budget pour commencer », « il faut quel budget »
      "(?:quel|quels|quelle|combien\\s+de)\\s+budgets?" +
        "|budgets?[^.!?]{0,40}(?<![\\p{L}\\p{N}_])(?:pour\\s+(?:commencer|d[ée]marrer|d[ée]buter)|" +
        "minimum|minimal|mini(?![\\p{L}])|conseill\\w*|recommand\\w*|pr[ée]voir|n[ée]cessaire|" +
        "par\\s+jour|journalier|mensuel|par\\s+mois|de\\s+d[ée]part)" +
        "|(?:il\\s+)?faut[^.!?]{0,25}(?<![\\p{L}\\p{N}_])budget" +
        "|(?:mettre|investir|pr[ée]voir|d[ée]penser|pr[ée]voir)[^.!?]{0,25}(?<![\\p{L}\\p{N}_])(?:combien|quel\\s+budget)" +
        "|combien[^.!?]{0,25}(?<![\\p{L}\\p{N}_])(?:de\\s+)?(?:budget|pub(?![\\p{L}])|publicit[ée]\\w*|ads?(?![\\p{L}])|annonces?)",
    ),
  ],
  // HERMES-END-TO-END-CERTIFICATION-R1 — le prix, avec l'exclusion que
  // `commercialPolicy.ts` portait déjà et que celui-ci n'avait pas.
  //
  // Ces deux lexiques posent la MÊME question — « ce message demande-t-il un
  // montant ? » — et ils en donnaient deux réponses. `EXACT_PRICE` refuse
  // « combien » quand il compte des leads, des clients, des rendez-vous ou du
  // temps ; celui-ci l'acceptait. « En général combien de leads deviennent
  // clients ? » sortait donc en `PRICE`, ce qui ouvre `PRICING_POLICY_MISSING`
  // et fait dire au prompt « le montant dépend du besoin réel » sur une
  // question qui ne portait sur aucun montant.
  //
  // L'exclusion est recopiée de `EXACT_PRICE` parce que c'est la même règle ;
  // un test de cohérence tient désormais les deux côte à côte et refuse qu'un
  // sujet `PRICE` ne relève pas la demande correspondante.
  //
  // Les bornes passent d'ASCII à Unicode au passage, et cela répare un silence :
  // `\b` devant « ça coûte » exige une frontière entre une espace et un « ç »,
  // deux caractères qui ne sont ni l'un ni l'autre des mots à ses yeux — le
  // motif ne matchait donc jamais tel qu'on l'écrit.
  [
    'PRICE',
    bounded(
      "prix|tarifs?|co[ûu]t(?:e|es|ent)?|honoraires|devis|c'est\\s+cher|" +
        "budget\\s+(?:n[ée]cessaire|[àa]\\s+pr[ée]voir)|fourchette|ordre\\s+de\\s+grandeur|" +
        "[çc]a\\s+co[ûu]te|" +
        // HERMES-TRIAL-IMPLEMENTATION-ROUTING-R1 — recopié de `EXACT_PRICE`,
        // parce que c'est la même règle et qu'un test de cohérence tient les
        // deux lexiques côte à côte. Voir le commentaire là-bas.
        'combien(?!\\s+(?:de\\s+(?:leads?|clients?|rendez[- ]vous|rdv|contacts?|appels?|temps|' +
        // HERMES-SEMANTIC-GROUNDING-R1 — « mois » rejoint les unités de DURÉE.
        'jours?|semaines?|mois|budget|' +
        'pub|publicit[ée]\\w*|%|pour\\s?cent)|' +
        'en\\s+(?:pub|publicit[ée]\\w*|ads?)|par\\s+jour\\s+en\\s+pub))',
    ),
  ],
  ['CALL_REQUEST', /\b(appel|appeler|call|téléphone|telephone|de vive voix|se parler|un point|visio|rendez-vous|rdv|dispo pour)\b/i],
  // HERMES-END-TO-END-CERTIFICATION-R1 — la garantie, à toutes ses personnes.
  //
  // Ce motif listait des formes FIGÉES et les bornait en ASCII : « garanti »,
  // « garantie », « garantissez ». Devant « Tu me garantis que les leads seront
  // qualifiés ? » et « Tu garantis quel ROI ? » — les deux façons dont un
  // prospect qui tutoie pose la question — le `\b` final tombe entre « i » et
  // « s », donc rien ne matche, donc le sujet vaut `OTHER_QUESTION`.
  //
  // La conséquence n'était pas un envoi : `commercialPolicy.ts` connaît
  // `garanti\w*` et fait escalader le tour. Elle était un MANQUE faux — le
  // prompt recevait `TOPIC_NOT_COVERED_BY_DATA` (« aucune donnée fiable ne
  // couvre ce sujet ») au lieu de `NO_GUARANTEE_TO_OFFER` (« aucune garantie
  // n'est offerte, dis-le simplement »). Deux instructions opposées sur la
  // question commerciale la plus dangereuse du dépôt.
  //
  // Le vocabulaire est aligné sur celui des DEMANDES, qui était déjà correct :
  // une racine et son suffixe, plutôt qu'une liste de conjugaisons.
  [
    'GUARANTEE',
    bounded(
      'garanti\\w*|assurez[- ]vous\\s+que|promesse\\s+de\\s+r[ée]sultat|' +
        "si\\s+[çc]a\\s+(?:ne\\s+)?(?:marche|fonctionne)\\s+pas|rembours\\w*|satisfait\\s+ou",
    ),
  ],
  ['RESULTS_PROOF', /\b(résultats|resultats|preuve|preuves|référence|references|références|témoignage|avis clients|portfolio|étude de cas|case study|exemples de clients)\b/i],
  ['HOW_IT_WORKS', /\b(comment (ça|ca) (marche|fonctionne)|comment vous (faites|procédez|procedez)|quel process|quelle méthode|méthodologie|déroulement)\b/i],
  // HERMES-CONTACT-PURPOSE-R1 — AVANT `WHO_ARE_YOU` et `WHAT_YOU_DO`, et
  // l'ordre est le sujet.
  //
  // « vous me proposez quoi ? » et « vous proposez quoi ? » sont deux questions
  // différentes à un mot près : la première demande pourquoi on l'aborde, la
  // seconde ce qu'on vend. Le second motif attraperait les deux, et le rapport
  // dirait « présentation demandée » là où quelqu'un demandait des comptes.
  // Les deux se répondent avec le même motif de contact, donc rien ne change
  // pour la décision — seul le mot inscrit change, et c'est celui qu'un humain
  // relit six mois plus tard.
  [
    'CONTACT_PURPOSE',
    bounded(
      // « pourquoi tu me demande ça », « pourquoi vous me demandez ça »
      "pourquoi[^.!?]{0,30}(?<![\\p{L}\\p{N}_])(?:demandes?|demandez)" +
        // « pourquoi tu me contactes », « pourquoi vous m'écrivez »
        "|pourquoi[^.!?]{0,30}(?<![\\p{L}\\p{N}_])(?:contactes?|contactez|[ée]cris|[ée]crivez|d[ée]rangez?)" +
        // « pourquoi tu veux savoir ça »
        '|pourquoi[^.!?]{0,20}(?<![\\p{L}\\p{N}_])(?:tu veux|vous voulez)\\s+savoir' +
        // « pourquoi ce message », « pourquoi cette question »
        '|pourquoi\\s+(?:ce|cette)\\s+(?:message|question|demande|d[ée]marche)' +
        // « c'est pour quoi ? », « c'est à quel sujet ? », « c'est quoi le but ? »
        "|c'est\\s+(?:pour\\s+quoi|[àa]\\s+quel\\s+sujet|quoi\\s+(?:le\\s+but|l'objectif))" +
        '|dans\\s+quel\\s+but|en\\s+quel\\s+honneur' +
        // « tu veux me proposer quoi », « vous me proposez quoi »
        '|(?:tu|vous)\\s+(?:me\\s+)?(?:veux|voulez)\\s+(?:me\\s+)?(?:proposer|vendre)\\s+quoi' +
        '|(?:tu|vous)\\s+me\\s+(?:proposes?|proposez|vends?|vendez)\\s+quoi' +
        // « qu'est-ce que tu me veux », « vous me voulez quoi »
        "|(?:qu'est[- ]ce\\s+que\\s+)?(?:tu\\s+me\\s+veux|vous\\s+me\\s+voulez)" +
        '|(?:tu|vous)\\s+me\\s+(?:veux|voulez)\\s+quoi' +
        // « tu cherches quoi », « vous cherchez quoi »
        '|(?:tu\\s+cherches|vous\\s+cherchez)\\s+quoi',
    ),
  ],
  // HERMES-ACQUISITION-SERVICE-TRUTH-R1 — APRÈS `CONTACT_PURPOSE`, AVANT
  // `WHO_ARE_YOU` et `WHAT_YOU_DO`, et chaque frontière porte une décision.
  //
  // Après le motif de contact : « tu me proposes quoi ? » demande pourquoi on
  // l'aborde, pas ce qu'on vend, et la précédence était déjà écrite là-haut.
  //
  // Avant `WHAT_YOU_DO` : « tu fais quoi POUR TROUVER DES CLIENTS » est plus
  // précis que « tu fais quoi », et le sujet le plus précis doit gagner — sans
  // quoi le rapport dirait « présentation demandée » là où on demandait une
  // méthode.
  //
  // À l'intérieur du bloc, `SEARCH_ADS` passe devant `ACQUISITION_METHOD` : « tu
  // fais Google Ads ? » contient le vocabulaire de la publicité et serait
  // attrapé par le second, qui répondrait « oui, je fais de la pub » à une
  // question qui portait sur un canal que nous ne poussons pas.
  [
    'SEARCH_ADS',
    bounded(
      'google\\s*ads?|adwords|google[^.!?]{0,15}(?<![\\p{L}\\p{N}_])(?:pub|publicit[ée]|annonces?|campagnes?)' +
        '|(?:pub|publicit[ée]s?|campagnes?|annonces?)[^.!?]{0,15}(?<![\\p{L}\\p{N}_])google' +
        '|liens\\s+sponsoris[ée]s|r[ée]f[ée]rencement\\s+payant|sea(?![\\p{L}])',
    ),
  ],
  // HERMES-TRIAL-IMPLEMENTATION-ROUTING-R1 — ce que le TEST comprend, APRÈS
  // `SEARCH_ADS` et AVANT `LEAD_HANDLING`, et chaque frontière porte une
  // décision.
  //
  // Après `SEARCH_ADS` : « pendant le test tu fais du Google Ads ? » demande
  // d'abord un canal que nous ne poussons pas, et c'est cette réponse-là qui
  // doit sortir.
  //
  // Avant `LEAD_HANDLING` : « le CRM est compris dans le test ? » porte le mot
  // `crm`, que `LEAD_HANDLING` attrape ; mais on demande le PÉRIMÈTRE DE
  // L'ESSAI, pas ce qui se passe quand une demande arrive. Le sujet le plus
  // précis gagne, comme partout dans cette liste.
  //
  // Tout ce qui décide vraiment reste devant : le prix, le budget, la garantie,
  // la preuve, le délai de résultat et la demande d'appel sont lus AVANT. Un
  // message qui demande un montant ou une garantie ne devient donc pas une
  // question de périmètre parce qu'il nomme l'essai.
  [
    'TRIAL_IMPLEMENTATION',
    bounded(
      "(?:" +
        TRIAL_ANCHOR_ALT +
        ")[^.!?]{0,60}(?<![\\p{L}\\p{N}_])(?:" +
        SETUP_VERB_ALT +
        ")" +
        "|(?:" +
        SETUP_VERB_ALT +
        ")[^.!?]{0,60}(?<![\\p{L}\\p{N}_])(?:" +
        TRIAL_ANCHOR_ALT +
        ")" +
        // « pendant la semaine tu gères quoi ? » — le test dure sept jours, et
        // c'est ainsi qu'un prospect le nomme quand il ne répète pas le chiffre.
        // `pendant` est exigé : « on en reparle la semaine prochaine » n'est
        // pas une question sur le périmètre de l'essai.
        "|(?:pendant|durant|sur)\\s+(?:la|cette|une)\\s+semaine[^.!?]{0,40}(?<![\\p{L}\\p{N}_])(?:" +
        SETUP_VERB_ALT +
        ")",
    ),
  ],
  [
    'LEAD_HANDLING',
    bounded(
      // « quand un lead arrive je fais quoi », « il se passe quoi quand un lead arrive »
      "(?:lead|leads|demande|demandes|contact|contacts|prospect|prospects)[^.!?]{0,30}(?<![\\p{L}\\p{N}_])" +
        "(?:arrive|arrivent|tombe|tombent|rentre|rentrent)" +
        "|(?:arrive|arrivent|se\\s+passe)[^.!?]{0,30}(?<![\\p{L}\\p{N}_])(?:lead|leads|demande|demandes)" +
        // « je dois faire quoi moi », « moi je fais quoi »
        "|(?:je\\s+dois\\s+faire\\s+quoi|moi\\s+je\\s+fais\\s+quoi|je\\s+fais\\s+quoi,?\\s+moi)" +
        "|(?:qu'est[- ]ce\\s+que\\s+)?je\\s+(?:dois|ai\\s+[àa])\\s+faire" +
        // « tu utilises un CRM », « c'est quoi ton CRM »
        "|crm(?![\\p{L}])|ghl(?![\\p{L}])|gohighlevel|logiciel\\s+de\\s+suivi" +
        // « tu les qualifies », « comment tu filtres les demandes »
        "|(?:tu|vous)\\s+(?:les\\s+)?(?:qualifies?|qualifiez|filtres?|filtrez|tries?|triez)" +
        "|(?:qualification|pr[ée]qualification|filtrage)(?![\\p{L}])" +
        "|comment[^.!?]{0,25}(?<![\\p{L}\\p{N}_])(?:filtr\\w*|tri\\w*|qualifi\\w*)" +
        // « je les reçois comment », « je reçois quoi »
        "|(?:je\\s+)?(?:re[çc]ois|r[ée]cup[èe]re)[^.!?]{0,25}(?<![\\p{L}\\p{N}_])(?:quoi|comment)",
    ),
  ],
  [
    'ASSET_ACCESS',
    bounded(
      "(?:donner|fournir|partager|ouvrir|filer)[^.!?]{0,25}(?<![\\p{L}\\p{N}_])acc[èe]s" +
        "|acc[èe]s[^.!?]{0,30}(?<![\\p{L}\\p{N}_])(?:quoi|compte|business\\s*manager|bm(?![\\p{L}])|publicitaire|page|pixel)" +
        "|business\\s*manager" +
        "|(?:tu|vous)[^.!?]{0,20}(?<![\\p{L}\\p{N}_])besoin[^.!?]{0,20}(?<![\\p{L}\\p{N}_])(?:de\\s+quoi|acc[èe]s|mon\\s+compte)" +
        "|(?:il\\s+)?(?:te|vous)\\s+faut\\s+quoi",
    ),
  ],
  [
    'GEO_EXCLUSIVITY',
    bounded(
      "concurrents?(?![\\p{L}])|concurrence(?![\\p{L}])" +
        "|(?:travaill\\w*|boss\\w*|bosses?)[^.!?]{0,40}(?<![\\p{L}\\p{N}_])(?:m[êe]me\\s+(?:zone|secteur|ville|coin|r[ée]gion)|" +
        "ma\\s+(?:zone|ville|r[ée]gion)|mon\\s+(?:secteur|coin|d[ée]partement))" +
        "|plusieurs[^.!?]{0,30}(?<![\\p{L}\\p{N}_])(?:bo[îi]tes?|entreprises?|clients?)[^.!?]{0,25}(?<![\\p{L}\\p{N}_])" +
        "(?:zone|secteur|ville|coin|r[ée]gion|d[ée]partement)" +
        "|exclusivit[ée]\\s+(?:g[ée]ographique|de\\s+zone|locale|sur\\s+(?:ma|le|la))" +
        "|(?:un\\s+)?seul[^.!?]{0,25}(?<![\\p{L}\\p{N}_])par\\s+(?:zone|secteur|ville)",
    ),
  ],
  [
    'ACQUISITION_METHOD',
    bounded(
      // « concrètement tu fais quoi », « tu fais quoi pour trouver des clients »
      "(?:concr[èe]tement|en\\s+vrai|en\\s+pratique)[^.!?]{0,30}(?<![\\p{L}\\p{N}_])(?:tu\\s+fais|vous\\s+faites|" +
        "tu\\s+proposes|vous\\s+proposez)" +
        "|(?:tu\\s+fais|vous\\s+faites)\\s+quoi[^.!?]{0,40}(?<![\\p{L}\\p{N}_])(?:trouver|clients?|demandes?|prospects?)" +
        "|comment\\s+(?:tu|vous)\\s+(?:trouves?|trouvez|ram[èe]nes?|ramenez|g[ée]n[èe]res?|g[ée]n[ée]rez|" +
        "attires?|attirez|d[ée]niches?|d[ée]nichez)[^.!?]{0,25}(?<![\\p{L}\\p{N}_])(?:clients?|demandes?|prospects?)" +
        "|comment\\s+(?:tu|vous)\\s+(?:fais|faites)\\s+(?:pour|[çc]a)" +
        // « tu fais de la pub ? », « c'est des pubs Facebook ? », « tu fais juste de la pub ? »
        //
        // HERMES-TRIAL-IMPLEMENTATION-ROUTING-R1 — deux resserrements mesurés,
        // qui ne font que MATCHER PLUS et jamais autre chose.
        //
        // `pub(?![\p{L}])` refusait « pubs » — un « s » est une lettre. « Tu
        // fais des pubs ? » ne relevait donc aucun sujet, alors que la même
        // phrase au singulier en relevait un. Et le verbe « mettre » manquait :
        // « tu mets juste les pubs ? » est la forme sous laquelle on demande si
        // notre travail s'arrête à la publicité — c'est-à-dire exactement ce à
        // quoi la facette `DIFFERENTIATION` répond.
        "|(?:tu|vous)\\s+(?:fais|faites|g[èe]res?|g[ée]rez|lances?|lancez|mets?|mettez)" +
        "[^.!?]{0,20}(?<![\\p{L}\\p{N}_])" +
        "(?:de\\s+la\\s+)?(?:pubs?(?![\\p{L}])|publicit[ée]\\w*|ads?(?![\\p{L}])|campagnes?)" +
        // « tu mets quoi en place ? », « tu gères quoi exactement ? » — la même
        // question que « concrètement tu fais quoi ? », posée avec le verbe que
        // le lexique ne connaissait pas.
        "|(?:tu|vous)\\s+(?:mets?|mettez)\\s+(?:quoi\\s+)?en\\s+place" +
        "|(?:tu|vous)\\s+(?:mets?|mettez|g[èe]res?|g[ée]rez|installes?|installez)\\s+quoi" +
        "|(?:c'est|ce\\s+sont)\\s+(?:des\\s+|de\\s+la\\s+)?(?:pubs?|publicit[ée]s?|ads?)(?![\\p{L}])" +
        "|(?:pub|publicit[ée]s?|ads?)\\s+(?:facebook|instagram|insta|meta|fb)(?![\\p{L}])" +
        "|(?:facebook|instagram|insta|meta)\\s+ads?(?![\\p{L}])" +
        // « c'est quoi ton système », « comment ça marche ton système »
        "|(?:c'est\\s+quoi|quel\\s+est)[^.!?]{0,15}(?<![\\p{L}\\p{N}_])(?:ton|votre)\\s+(?:syst[èe]me|m[ée]thode|" +
        "fonctionnement|proc[ée]d[ée]|approche)" +
        "|(?:ton|votre)\\s+syst[èe]me[^.!?]{0,20}(?<![\\p{L}\\p{N}_])(?:marche|fonctionne|c'est\\s+quoi)" +
        // « qu'est-ce qui est différent », « en quoi c'est différent »
        "|(?:qu'est[- ]ce\\s+qui|en\\s+quoi|qu'est[- ]ce\\s+que\\s+tu)[^.!?]{0,25}(?<![\\p{L}\\p{N}_])diff[ée]r\\w*" +
        "|diff[ée]rence\\s+(?:avec|par\\s+rapport)",
    ),
  ],
  ['WHO_ARE_YOU', /\b(qui (êtes|etes)[- ]vous|c'est qui|vous êtes qui|c'est quoi hermes|hermes c'est quoi|votre (société|societe|entreprise|agence) c'est)\b/i],
  // HERMES-ACQUISITION-SERVICE-TRUTH-R1 — le même motif, au TUTOIEMENT.
  //
  // Ce lexique ne connaissait que le vouvoiement. C'était sans conséquence tant
  // que Hermes vouvoyait par défaut ; ce n'en est plus une depuis que le dépôt
  // apprend à tutoyer quand le prospect tutoie — et le prospect du 23 août
  // tutoie. « tu fais quoi » tombait donc en `OTHER_QUESTION`, c'est-à-dire sur
  // une escalade, alors que le sujet est le plus banal de la prospection.
  //
  // C'est exactement le trou que `detectPerformanceClaims` portait au round
  // précédent, et il se ferme de la même façon : dans le lexique EXISTANT, sans
  // second détecteur.
  [
    'WHAT_YOU_DO',
    bounded(
      "vous\\s+faites\\s+quoi|que\\s+faites[- ]vous|vous\\s+proposez\\s+quoi|" +
        "tu\\s+fais\\s+quoi|tu\\s+proposes\\s+quoi|tu\\s+vends\\s+quoi|" +
        "c'est\\s+quoi\\s+(?:votre|ton|ta)\\s+(?:offre|service|prestation|boulot|m[ée]tier|job)|" +
        "quel\\s+service|en\\s+quoi\\s+[çc]a\\s+consiste|vous\\s+vendez\\s+quoi",
    ),
  ],
  ['MORE_INFO', /\b(plus d'infos?|plus d'informations?|en savoir plus|envoyez[- ]moi|documentation|une plaquette|des détails|des details)\b/i],
  ['TIMING', /\b(quand|délai|delai|combien de temps|sous quel délai|à partir de quand)\b/i],
];

const OBJECTION_PATTERNS: ReadonlyArray<readonly [ObjectionTopic, RegExp]> = [
  ['ALREADY_HAS_PROVIDER', /\b(j'ai déjà quelqu'un|on a déjà (quelqu'un|une agence|un prestataire)|déjà accompagné|mon agence|notre agence|quelqu'un qui (gère|s'occupe|gere))\b/i],
  ['ALREADY_DOES_ADS', /\b(je fais déjà (de la pub|des pubs|de la publicité)|on fait déjà (de la pub|des pubs)|j'ai déjà des campagnes|je gère mes pubs|on tourne déjà en ads)\b/i],
  ['NO_BUDGET', /\b(pas le budget|pas de budget|trop cher|hors budget|j'ai pas les moyens|pas les moyens|c'est au[- ]dessus de mes moyens)\b/i],
  ['NO_TIME', /\b(pas le temps|pas de temps|débordé|deborde|surchargé|surcharge de travail)\b/i],
  ['NOT_A_PRIORITY', /\b(pas (ma|une) priorité|c'est pas prioritaire|pas d'actualité|pas dans mes plans)\b/i],
  ['TRUST', /\b(arnaque|spam|démarchage|demarchage|je vous connais pas|jamais entendu parler|pas confiance|c'est du fake)\b/i],
];

const SENSITIVE_PATTERNS: ReadonlyArray<readonly [SensitiveFlag, RegExp]> = [
  ['LEGAL_THREAT', /\b(avocat|juridique|poursuite|poursuivre|plainte|tribunal|mise en demeure|cnil|amende|illégal|illegal)\b/i],
  ['DATA_PRIVACY_DEMAND', /\b(rgpd|gdpr|données personnelles|donnees personnelles|où avez[- ]vous eu|comment avez[- ]vous eu (mon|mes)|droit à l'effacement|supprimez mes données)\b/i],
  ['HOSTILE', /\b(connard|enfoiré|enfoire|ta gueule|fous[- ]moi la paix|dégage|degage|va te faire|abruti|imbécile|imbecile|foutez[- ]moi la paix)\b/i],
  ['IMPERSONATION_CLAIM', /\b(vous vous faites passer|usurpation|vous n'êtes pas (qui|celui)|faux compte)\b/i],
];

const STRONG_BUYING = bounded(
  "je suis int[ée]ress[ée]e?|[çc]a m'int[ée]resse|on y va|banco|partant|je veux|allons[- ]y|" +
    "d'accord pour|ok pour (?:un|le)",
);
const MODERATE_BUYING = bounded(
  "pourquoi pas|pk pas|volontiers|[çc]a peut m'int[ée]resser|int[ée]ressant|dites m'en plus|" +
    "je vous [ée]coute|je t'[ée]coute|[çc]a m'parle",
);
const WEAK_BUYING = /^(oui|ouais|ok|d'accord|yes|👍|ah oui)\b/i;

const EXPLICIT_CALL = bounded(
  "on (?:peut|pourrait) s'appeler|appelez[- ]moi|appelle[- ]moi|je vous appelle|je t'appelle|" +
    'un appel|un call|par t[ée]l[ée]phone|de vive voix|prenons un rdv|on se cale un',
);

/**
 * Sous ce seuil, un message ne porte pas un sujet — il porte un accord ou un
 * refus. Lui attribuer un `questionTopic` serait une lecture inventée.
 */
const MIN_CHARS_FOR_TOPIC = 8;

// ---------------------------------------------------------------------------
// La lecture
// ---------------------------------------------------------------------------

function firstMatch<T>(text: string, table: ReadonlyArray<readonly [T, RegExp]>): T | null {
  for (const entry of table) {
    if (entry[1].test(text)) return entry[0];
  }
  return null;
}

/**
 * HERMES-SEMANTIC-GROUNDING-R1 — le premier sujet reconnu dans une portion qui
 * ADRESSE quelque chose.
 *
 * Réservée aux sujets de QUESTION, et l'exclusion des objections est le sujet :
 * une objection est presque toujours au passé (« j'ai déjà essayé les pubs, ça
 * n'a jamais marché ») et elle reste une objection COURANTE. Les scoper les
 * ferait toutes disparaître. Une question, elle, est un acte : « mes clients me
 * demandaient le prix » n'en pose aucune.
 *
 * L'ordre de la table est conservé au caractère près. La seule différence est
 * qu'un motif reconnu dans une portion rapportée, citée, niée ou hypothétique
 * ne compte plus — et si aucun n'est courant, la lecture retombe sur le
 * repli d'avant (`OTHER_QUESTION` quand le message ressemble à une question),
 * c'est-à-dire sur une escalade.
 */
function firstCurrentMatch<T>(
  scope: UtteranceScope,
  table: ReadonlyArray<readonly [T, RegExp]>,
): T | null {
  for (const entry of table) {
    if (frameOfPattern(scope, entry[1]) === 'CURRENT') return entry[0];
  }
  return null;
}

function looksLikeQuestion(text: string): boolean {
  return /\?/.test(text) || /^(c'est|combien|comment|pourquoi|quoi|qui|quand|est[- ]ce)\b/i.test(text.trim());
}

/**
 * Lit les sous-signaux d'un message entrant, dans le contexte de son fil.
 *
 * `category` est la conclusion D2 déjà rendue : elle ORIENTE la lecture (on ne
 * cherche un sujet d'objection que si D2 a vu une objection) mais n'est jamais
 * recalculée ici.
 */
export function readSignals(
  text: string,
  category: ReplyCategory,
  thread: ConversationThread,
): ConversationSignals {
  // Normaliser d'abord : les lexiques ci-dessus sont écrits à l'apostrophe
  // droite, les vrais messages portent l'apostrophe typographique.
  const body = normalizeForMatching(text).trim();
  const tooShortToRead = body.length < MIN_CHARS_FOR_TOPIC;

  const sensitiveFlags = SENSITIVE_PATTERNS.filter((entry) => entry[1].test(body)).map((entry) => entry[0]);

  // HERMES-SEMANTIC-GROUNDING-R1 — le message est découpé UNE fois, et les
  // sujets de QUESTION sont situés dedans plutôt que testés à plat.
  const scope = scopeUtterance(text);

  // Une demande d'appel est un ACTE : « mes clients voulaient qu'on s'appelle »
  // n'en est pas une, et la lire comme telle ferait monter la maturité à HIGH,
  // donc ouvrirait une proposition d'échange que personne n'a demandée.
  const explicitCallRequest = frameOfPattern(scope, EXPLICIT_CALL) === 'CURRENT';

  let questionTopic: QuestionTopic = 'NONE';
  if (!tooShortToRead) {
    const matched = firstCurrentMatch(scope, QUESTION_PATTERNS);
    if (matched !== null) questionTopic = matched;
    else if (category === 'QUESTION' || looksLikeQuestion(body)) questionTopic = 'OTHER_QUESTION';
  } else if (looksLikeQuestion(body)) {
    // « combien ? » fait sept caractères et reste une question de prix.
    const matched = firstCurrentMatch(scope, QUESTION_PATTERNS);
    questionTopic = matched ?? 'OTHER_QUESTION';
  }
  if (explicitCallRequest) questionTopic = 'CALL_REQUEST';

  let objectionTopic: ObjectionTopic = 'NONE';
  const matchedObjection = firstMatch(body, OBJECTION_PATTERNS);
  if (matchedObjection !== null) objectionTopic = matchedObjection;
  else if (category === 'OBJECTION') objectionTopic = 'OTHER_OBJECTION';

  let buyingSignal: BuyingSignal = 'NONE';
  if (category === 'NOT_INTERESTED' || category === 'UNSUBSCRIBE') buyingSignal = 'NONE';
  else if (STRONG_BUYING.test(body) || explicitCallRequest) buyingSignal = 'STRONG';
  else if (MODERATE_BUYING.test(body) || category === 'INTERESTED') buyingSignal = 'MODERATE';
  else if (WEAK_BUYING.test(body) || category === 'QUESTION' || category === 'OBJECTION') buyingSignal = 'WEAK';

  return Object.freeze({
    questionTopic,
    objectionTopic,
    buyingSignal,
    callReadiness: resolveCallReadiness({ category, buyingSignal, explicitCallRequest, thread }),
    sensitiveFlags: Object.freeze(sensitiveFlags),
    explicitCallRequest,
    tooShortToRead,
  });
}

interface ReadinessInput {
  readonly category: ReplyCategory;
  readonly buyingSignal: BuyingSignal;
  readonly explicitCallRequest: boolean;
  readonly thread: ConversationThread;
}

/**
 * Décide si proposer un échange a du sens MAINTENANT.
 *
 * Deux règles portent tout :
 *
 *   1. Une demande explicite d'appel vaut `HIGH`, immédiatement et sans autre
 *      condition. Faire patienter quelqu'un qui demande à parler est la seule
 *      erreur vraiment coûteuse ici.
 *
 *   2. Un signal faible au premier tour ne vaut jamais mieux que `LOW` (§10 :
 *      « ne pas pousser un appel dès le premier signe faible »). La maturité
 *      demande soit une demande explicite, soit un échange qui a déjà eu lieu.
 *
 *   3. **R1.1 §17 — avoir répondu n'est pas un signal.** La règle d'origine
 *      faisait monter un « pourquoi pas » à `HIGH` dès qu'un seul tour avait
 *      précédé, c'est-à-dire dès le deuxième message d'une conversation. C'est
 *      la faute classique du commercial pressé : on prend la politesse pour de
 *      l'intérêt et on propose un appel à quelqu'un qui a simplement daigné
 *      répondre. Un signal MODÉRÉ demande maintenant un échange réellement
 *      engagé — deux tours reçus, pas un — ou une demande explicite. Ce qui
 *      n'a pas bougé : une demande d'appel vaut `HIGH` immédiatement, parce
 *      que faire patienter quelqu'un qui demande à parler reste la seule
 *      erreur vraiment coûteuse ici.
 */
export function resolveCallReadiness(input: ReadinessInput): CallReadiness {
  if (input.category === 'UNSUBSCRIBE' || input.category === 'NOT_INTERESTED') return 'LOW';
  if (input.explicitCallRequest) return 'HIGH';
  if (input.buyingSignal === 'STRONG') return 'HIGH';

  const exchangeStarted = input.thread.priorInboundCount >= 1;
  const exchangeAdvanced = input.thread.priorInboundCount >= 2;
  if (input.buyingSignal === 'MODERATE') return exchangeAdvanced ? 'HIGH' : 'MEDIUM';
  if (input.buyingSignal === 'WEAK' && exchangeStarted) return 'MEDIUM';
  return 'LOW';
}
