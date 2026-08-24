/**
 * HERMES-ACQUISITION-SERVICE-TRUTH-R1 — CE QUE JE FAIS, dit une fois et
 * opposable.
 *
 * ---------------------------------------------------------------------------
 * Le trou que ce fichier bouche
 * ---------------------------------------------------------------------------
 * Le 23 août 2026, un prospect a demandé « Ok mais concrètement tu fais quoi
 * pour trouver des clients ? ». D2 a parfaitement compris (`QUESTION`, 0,99).
 * La conversation s'est arrêtée sur `HUMAN_ESCALATION:topic_not_covered`, et le
 * brouillon écrit malgré le refus disait : « Ça dépend de ce que tu as déjà en
 * place : tu veux surtout plus de réservations de particuliers ou plus de
 * demandes de pros ? ».
 *
 * Ce brouillon est passé au contrôle de naturalité (`NATURAL`). Il est pourtant
 * le pire des deux mondes : il ESQUIVE. On demande ce que tu fais, tu réponds
 * par une question. C'est le réflexe du commercial qui n'a rien à dire, et un
 * prospect le lit exactement comme ça.
 *
 * Le dépôt savait dire ce qu'il VEND (`sales/offer.ts` : le test de sept
 * jours), à QUI il écrit (`pipeline/serviceScope.ts`), ce qu'il VISE
 * (`sales/objective.ts`), POURQUOI il écrit (`sales/contactPurpose.ts`) et ce
 * qu'il ne peut PAS engager (`conversation/commercialPolicy.ts`). Il ne savait
 * pas dire ce qu'il FAIT — c'est-à-dire la deuxième question de toute
 * prospection à froid, juste après « pourquoi tu m'écris ».
 *
 * ---------------------------------------------------------------------------
 * Ce que ce fichier N'EST PAS
 * ---------------------------------------------------------------------------
 * Ce n'est pas un pitch, et ce n'est pas UN bloc. C'est une collection de
 * FACETTES indépendantes, et le prompt n'en reçoit que celles que la question
 * appelle. La raison est mesurée ailleurs dans ce dépôt et vaut ici :
 * `offer.ts` note qu'« un tour qui n'a rien à voir avec l'essai ne voit pas ce
 * bloc du tout — montrer une offre à un modèle lui donne l'idée de s'en
 * servir ». Un bloc unique de trente lignes injecté à chaque tour produirait
 * un argumentaire déclenché par la politesse d'un prospect.
 *
 * Ce n'est pas non plus une phrase à réciter. Aucune entrée n'est une
 * formulation : ce sont des faits, comme `TRIAL_FACTS` et pour la même raison
 * (`sales-source-001-p007` : le cadre, jamais le script).
 *
 * Ce n'est enfin pas une permission. Rien ici ne desserre une garde :
 * `checkReplyDraft`, `detectPerformanceClaims`, `checkNaturalness` et les
 * portes d'autonomie relisent tout derrière, à l'identique.
 *
 * ---------------------------------------------------------------------------
 * D'où vient chaque fait
 * ---------------------------------------------------------------------------
 * D'une validation nominative de l'opérateur (Operator Example, 23 août 2026),
 * pas d'une déduction faite depuis les capacités techniques du dépôt. Le rang
 * est donc le premier de `truth.ts` : `EXPLICIT_BUSINESS_POLICY`. Ce n'est ni
 * une heuristique empruntée à une vidéo, ni une inférence tirée du code — c'est
 * ce que Hermes vend.
 *
 * ---------------------------------------------------------------------------
 * Ce qui reste dehors, et volontairement
 * ---------------------------------------------------------------------------
 * Le prix après l'essai, l'abonnement, le pourcentage, les frais de mise en
 * place, l'engagement, le remboursement : inchangés, toujours inconnus, et
 * toujours escaladés par `commercialPolicy.ts`. Les performances observées
 * (CPL, ROI) vivent dans `sales/performanceEvidence.ts` et n'entrent JAMAIS
 * dans un prompt : ce sont des faits opérateur en attente de provenance, pas
 * une preuve citable.
 */

import { HERMES_OUT_OF_SCOPE } from '@/lib/sales/objective';
import { loadOfferProfile } from '@/lib/sales/offerProfile';
import type { TruthTier } from '@/lib/sales/truth';
import type { QuestionTopic } from '@/lib/conversation/signals';
// Type SEUL, et c'est nécessaire : `sales/priceSubject.ts` importe la VALEUR
// `AD_BUDGET_QUOTABLE_AMOUNTS` d'ici. Un import de valeur en retour ferait un
// cycle à l'exécution ; un import de type est effacé à la compilation.
import type { PriceSubjectReading } from '@/lib/sales/priceSubject';

/**
 * L'identifiant de la VÉRITÉ DE SERVICE.
 *
 * Une version de plus, distincte des cinq qui existaient — ciblage, réponse
 * autonome, engagement commercial, rendez-vous, motif de contact. Elle répond à
 * une sixième question : « qu'est-ce que tu fais, concrètement ? ». Partager
 * une étiquette ferait couvrir l'une par les décisions rendues sous l'autre, et
 * c'est précisément ce que la discipline de versions de ce dépôt refuse.
 */
export const ACQUISITION_SERVICE_VERSION = 'hermes-acquisition-service-r1';

/** Le rang d'autorité de ce qui suit. Le premier : une politique explicite. */
export const ACQUISITION_SERVICE_TIER: TruthTier = 'EXPLICIT_BUSINESS_POLICY';

/**
 * Le budget publicitaire de DÉPART, tel que l'opérateur l'a écrit.
 *
 * Gelé et typé comme des faits commerciaux, pas comme un réglage — même
 * raisonnement que `HERMES_TRIAL` : les mettre dans `config/` inviterait à les
 * changer sans revue, alors que chaque valeur est dite à quelqu'un.
 *
 * Ce sont les SEULS montants que ce dépôt autorise dans une réponse, et
 * uniquement quand la question porte sur le budget (`quotableAmounts`
 * ci-dessous). Tout autre montant reste bloqué par `checkReplyDraft`
 * exactement comme avant.
 */
export const HERMES_AD_BUDGET = Object.freeze({
  /** Le point de départ typique, en euros par jour. */
  typicalDailyStartEur: 20,
  /** La zone raisonnable de départ, en euros par jour. */
  reasonableDailyStartEur: Object.freeze([20, 25] as const),
});

/**
 * Les montants citables quand la question porte sur le budget publicitaire.
 *
 * Composés depuis `HERMES_AD_BUDGET` plutôt que recopiés : un chiffre recopié
 * diverge de sa source le jour où la source change, et personne ne s'en
 * aperçoit — sauf le prospect à qui on annonce l'ancien.
 */
export const AD_BUDGET_QUOTABLE_AMOUNTS: readonly number[] = Object.freeze([
  ...new Set<number>([
    HERMES_AD_BUDGET.typicalDailyStartEur,
    ...HERMES_AD_BUDGET.reasonableDailyStartEur,
  ]),
]);

/**
 * Les facettes de la vérité de service.
 *
 * Chacune répond à UNE question et se rend seule. Elles ne sont pas des
 * chapitres d'un même discours : un prospect qui demande le budget ne reçoit
 * pas la chaîne complète du système, et un prospect qui demande ce qu'on fait
 * ne reçoit pas la politique d'exclusivité.
 */
export type AcquisitionFacet =
  /** Ce que je fais concrètement : les canaux, les campagnes, les formulaires. */
  | 'WHAT_WE_DO'
  /** La chaîne, de la publicité jusqu'à la notification du client. */
  | 'SYSTEM_FLOW'
  /** Ce qui reste au client : rappeler, closer, fixer le rendez-vous, faire. */
  | 'CLIENT_ROLE'
  /** Ce qui distingue de quelqu'un qui s'arrête à « pub → lead ». */
  | 'DIFFERENTIATION'
  /** La préqualification : elle existe, elle ne garantit rien. */
  | 'LEAD_QUALIFICATION'
  /** Le budget publicitaire de départ. */
  | 'AD_BUDGET'
  /** Les accès nécessaires, et ce qu'on ne demande jamais. */
  | 'ASSET_ACCESS'
  /** Une seule entreprise par zone commerciale réellement concurrente. */
  | 'GEO_EXCLUSIVITY'
  /** Les canaux réellement poussés aujourd'hui, et ceux qui ne le sont pas. */
  | 'CHANNEL_SCOPE'
  /** Le délai de résultats : aucun n'est promis, et voilà de quoi il dépend. */
  | 'RESULT_TIMING';

export interface AcquisitionTruth {
  readonly facet: AcquisitionFacet;
  /** Des FAITS. Aucune entrée n'est une phrase à recopier. */
  readonly facts: readonly string[];
  /** Ce que dire ce fait n'autorise pas. Des interdictions, pas des nuances. */
  readonly limits: readonly string[];
}

/**
 * La vérité, facette par facette.
 *
 * `Record` complet et non partiel : ajouter une facette sans écrire ce qu'elle
 * dit devient une erreur de compilation, et non un `undefined` que la boucle de
 * rendu sauterait en silence.
 */
/**
 * La vérité, facette par facette — LUE, jamais écrite ici.
 *
 * Les `facts` viennent de `config/offer.json`, qui n'est pas livré : sur une
 * instance fraîche, chaque facette est VIDE et toute question sur le service
 * escalade. Les `limits`, elles, sont livrées : ce ne sont pas des faits
 * commerciaux mais des garde-fous de rédaction — « ne promets aucun résultat »,
 * « pas de jargon de plaquette » — et ils valent pour n'importe quelle offre.
 */
export const ACQUISITION_TRUTH: Readonly<Record<AcquisitionFacet, AcquisitionTruth>> = Object.freeze({
  WHAT_WE_DO: Object.freeze({
    facet: 'WHAT_WE_DO' as const,
    facts: Object.freeze([...(loadOfferProfile().serviceFacts['WHAT_WE_DO'] ?? [])]),
    limits: Object.freeze([
      'n’emploie AUCUNE formule de plaquette : ni « clé en main », ni « solution », ni « système scalable », ni « machine à leads », ni « acquisition multicanale », ni « infrastructure de conversion »',
      'ne déroule pas les six points : dis ce que la question demande, en une ou deux phrases',
      'ne promets aucun résultat, aucun volume, aucun délai, aucun chiffre',
      'ne dis pas que tu as regardé leur compte, leur site ou leurs publicités si rien ne t’a été donné en faits observés',
    ]),
  }),

  SYSTEM_FLOW: Object.freeze({
    facet: 'SYSTEM_FLOW' as const,
    facts: Object.freeze([...(loadOfferProfile().serviceFacts['SYSTEM_FLOW'] ?? [])]),
    limits: Object.freeze([
      'ne prétends JAMAIS que je rappelle, que je vends ou que je conclus à la place du client : c’est faux',
      'ne récite pas la chaîne comme une liste : dis-en la partie qui répond à la question',
      'aucun volume, aucun délai, aucun taux',
    ]),
  }),

  CLIENT_ROLE: Object.freeze({
    facet: 'CLIENT_ROLE' as const,
    facts: Object.freeze([...(loadOfferProfile().serviceFacts['CLIENT_ROLE'] ?? [])]),
    limits: Object.freeze([
      'ne dis pas « tu n’as plus rien à faire » : c’est faux, et c’est la promesse qui fait rater le test',
      'ne chiffre pas le délai de rappel idéal, ne donne aucun pourcentage de transformation',
    ]),
  }),

  DIFFERENTIATION: Object.freeze({
    facet: 'DIFFERENTIATION' as const,
    facts: Object.freeze([...(loadOfferProfile().serviceFacts['DIFFERENTIATION'] ?? [])]),
    limits: Object.freeze([
      'ne dénigre aucun concurrent nommé, et n’affirme rien de ce que fait leur prestataire actuel : personne ne l’a observé',
      'ne t’en sers pas pour pitcher : réponds à la différence qu’on te demande, rien de plus',
    ]),
  }),

  LEAD_QUALIFICATION: Object.freeze({
    facet: 'LEAD_QUALIFICATION' as const,
    facts: Object.freeze([...(loadOfferProfile().serviceFacts['LEAD_QUALIFICATION'] ?? [])]),
    limits: Object.freeze([
      'ne dis JAMAIS « 100 % qualifiés », « tous joignables », « que des clients sérieux » ni aucune variante',
      'ne donne aucun taux, aucun pourcentage, aucune proportion — même approximative',
      'dis honnêtement la limite plutôt que de la contourner : c’est ce qui rend le reste crédible',
    ]),
  }),

  AD_BUDGET: Object.freeze({
    facet: 'AD_BUDGET' as const,
    facts: Object.freeze([...(loadOfferProfile().serviceFacts['AD_BUDGET'] ?? [])]),
    limits: Object.freeze([
      'ne dis JAMAIS que ce budget « suffit », qu’il est « assez » ou qu’il « marche » : ce n’est ni promis ni mesuré',
      'ne relie JAMAIS ce montant à un résultat : pas de « avec ça tu auras X clients », pas de « ça te fait X demandes »',
      'ne dis JAMAIS « plus tu dépenses, plus ça marche » ; ce qu’un budget plus élevé fait, c’est rassembler des données plus vite',
      'aucun autre montant que ceux ci-dessus ne s’écrit — ni frais, ni prix, ni coût par demande',
    ]),
  }),

  ASSET_ACCESS: Object.freeze({
    facet: 'ASSET_ACCESS' as const,
    facts: Object.freeze([...(loadOfferProfile().serviceFacts['ASSET_ACCESS'] ?? [])]),
    limits: Object.freeze([
      'ne demande JAMAIS un mot de passe, un code, un identifiant ou un accès dans la conversation : cela se fait proprement, plus tard',
      'ne détaille pas une procédure d’accès dans un message : dis le principe, pas les étapes',
    ]),
  }),

  GEO_EXCLUSIVITY: Object.freeze({
    facet: 'GEO_EXCLUSIVITY' as const,
    facts: Object.freeze([...(loadOfferProfile().serviceFacts['GEO_EXCLUSIVITY'] ?? [])]),
    limits: Object.freeze([
      'n’invente AUCUN périmètre : pas de rayon en kilomètres, pas de département, pas de région, pas d’exclusivité nationale',
      'si le secteur de cette entreprise n’est pas connu, dis le principe sans le chiffrer',
      'n’affirme rien sur qui est déjà client, ni ici ni ailleurs : ce serait inventer',
      'ne présente pas cela comme une clause de contrat : aucune condition contractuelle n’est écrite',
    ]),
  }),

  CHANNEL_SCOPE: Object.freeze({
    facet: 'CHANNEL_SCOPE' as const,
    facts: Object.freeze([...(loadOfferProfile().serviceFacts['CHANNEL_SCOPE'] ?? [])]),
    limits: Object.freeze([
      'ne présente JAMAIS Google Ads, le référencement ou un autre canal comme ce que tu fais aujourd’hui',
      'n’invente aucun historique : ne dis pas que tu en as déjà fait, ni que tu n’en as jamais fait — dis ce que tu proposes maintenant',
      'si on te demande un canal que tu ne couvres pas, dis-le simplement plutôt que d’élargir',
    ]),
  }),

  RESULT_TIMING: Object.freeze({
    facet: 'RESULT_TIMING' as const,
    facts: Object.freeze([...(loadOfferProfile().serviceFacts['RESULT_TIMING'] ?? [])]),
    limits: Object.freeze([
      'ne donne AUCUN délai, même prudent, même « en général » : pas de jours, pas de semaines, pas de mois',
      'ne dis JAMAIS « plus tu dépenses, plus ça marche »',
      'ne promets pas un premier client, ni un premier rendez-vous, ni une première demande',
    ]),
  }),

});

/**
 * Ce que cette vérité ne définit PAS, et qui escalade donc toujours.
 *
 * Une liste positive de manques plutôt qu'un silence — même raison que
 * `UNDEFINED_COMMERCIAL_TERMS` : « tout ce qui n'est pas écrit est inconnu » se
 * relit comme une invitation à combler au jugé, alors qu'un trou nommé est un
 * trou qu'un modèle contourne.
 *
 * Elle n'est pas rendue dans le prompt du tour : les manques qui comptent y
 * arrivent déjà par `grounding.ts` et par `commercialPolicy.ts`. Elle existe
 * pour qu'un lecteur, et un rapport, puissent dire ce qui reste dehors.
 */
export const ACQUISITION_UNDEFINED: readonly string[] = Object.freeze([
  'le prix après l’essai, l’abonnement, le pourcentage, les frais de mise en place, l’engagement, le remboursement',
  'tout coût par demande ou retour sur investissement promis — les valeurs observées ne sont pas des promesses',
  'tout taux de conversion, de transformation ou de closing',
  'tout délai de résultat, même approximatif',
  'tout périmètre chiffré d’exclusivité tant que la zone du client n’est pas connue',
  'tout volume de demandes, de rendez-vous ou de clients',
]);

/**
 * Quelles facettes une question ouvre.
 *
 * `Partial` et non complet, et c'est le point : un sujet absent de cette table
 * n'ouvre AUCUNE facette. Le défaut est donc le silence — la vérité de service
 * n'entre pas dans le prompt tant que quelqu'un ne l'a pas demandée.
 *
 * `INFORMATION_SHARED` avec `questionTopic` à `NONE` est le cas fréquent : un
 * prospect qui répond à ce qu'on lui a demandé ne reçoit rien de tout cela.
 * Lui expliquer spontanément ce qu'on fait serait un pitch déclenché par sa
 * politesse, c'est-à-dire le réflexe que `CONVERSATION_FRAME` interdit.
 */
const FACETS_BY_TOPIC: Readonly<Partial<Record<QuestionTopic, readonly AcquisitionFacet[]>>> =
  Object.freeze({
    ACQUISITION_METHOD: Object.freeze([
      'WHAT_WE_DO',
      'SYSTEM_FLOW',
      'CLIENT_ROLE',
      'DIFFERENTIATION',
    ] as const),
    LEAD_HANDLING: Object.freeze([
      'SYSTEM_FLOW',
      'LEAD_QUALIFICATION',
      'CLIENT_ROLE',
    ] as const),
    SEARCH_ADS: Object.freeze(['CHANNEL_SCOPE', 'WHAT_WE_DO'] as const),
    AD_BUDGET: Object.freeze(['AD_BUDGET'] as const),
    ASSET_ACCESS: Object.freeze(['ASSET_ACCESS'] as const),
    GEO_EXCLUSIVITY: Object.freeze(['GEO_EXCLUSIVITY'] as const),
    RESULT_TIMING: Object.freeze(['RESULT_TIMING'] as const),
    HOW_IT_WORKS: Object.freeze(['SYSTEM_FLOW', 'CLIENT_ROLE'] as const),
    WHAT_YOU_DO: Object.freeze(['WHAT_WE_DO', 'CLIENT_ROLE'] as const),
    // HERMES-TRIAL-IMPLEMENTATION-ROUTING-R1 — « pendant les 7 jours tu mets
    // quoi en place ? ».
    //
    // Les trois mêmes facettes que `ACQUISITION_METHOD`, MOINS
    // `DIFFERENTIATION` : on ne demande pas en quoi c'est différent d'un autre
    // prestataire, on demande ce qui est installé. L'y ajouter ferait glisser
    // une réponse de périmètre vers un argumentaire comparatif — c'est-à-dire
    // un pitch déclenché par une question technique.
    //
    // La DURÉE de l'essai n'est volontairement PAS dans cette table : elle est
    // portée par `TRIAL_FACTS` (`sales/offer.ts`), que `trialDisclosure` fait
    // entrer dans le prompt sur ce sujet-là. Ouvrir des facettes de service sur
    // « le test dure combien de temps ? » ferait dérouler la chaîne complète à
    // quelqu'un qui demandait un nombre de jours.
    TRIAL_IMPLEMENTATION: Object.freeze([
      'WHAT_WE_DO',
      'SYSTEM_FLOW',
      'CLIENT_ROLE',
    ] as const),
  });

export interface AcquisitionDisclosureInput {
  /** Le sujet de la question, tel que `readSignals` l'a lu. Jamais deviné ici. */
  readonly questionTopic: QuestionTopic;
  readonly humanNeeded: boolean;
  /**
   * HERMES-TRIAL-COST-VS-POST-TRIAL-PRICING-R1 §4 — le sujet du PRIX demandé.
   *
   * Optionnel, et `null` reproduit le comportement d'avant ce round au
   * caractère près : la table des sujets décide seule, comme sous r4.
   *
   * Il existe parce que `questionTopic` ne suffisait pas. « Et ça me coûte
   * combien de tester ? » sort de `readSignals` en `PRICE` — un sujet qui
   * n'ouvre AUCUNE facette — alors que la réponse honnête exige le budget
   * publicitaire, donc la facette `AD_BUDGET` et ses montants. Sans cette
   * entrée, le modèle recevait la consigne de répondre et pas de quoi le faire.
   */
  readonly priceSubject?: PriceSubjectReading | null;
}

export interface AcquisitionDisclosure {
  /** Les facettes qui entrent dans le prompt. Vide = rien n'entre. */
  readonly facets: readonly AcquisitionFacet[];
  /**
   * Les montants en euros que CE tour autorise dans le texte.
   *
   * Vide partout sauf sur la facette du budget publicitaire, et le contenu vient
   * de `AD_BUDGET_QUOTABLE_AMOUNTS`, jamais d'un littéral recopié. Tout ce qui
   * n'est pas dans cette liste reste bloqué par `checkReplyDraft` — la garde
   * n'est pas desserrée, on lui donne la preuve approuvée qu'elle attendait.
   */
  readonly quotableAmounts: readonly number[];
}

/**
 * Décide ce que le prompt reçoit de la vérité de service, pour CE tour.
 *
 * Fail-closed sur les deux bords : un humain requis rend le silence, et un
 * sujet inconnu de la table rend le silence. Il n'existe aucune branche « dans
 * le doute, montre tout ».
 */
export function acquisitionDisclosure(input: AcquisitionDisclosureInput): AcquisitionDisclosure {
  const empty: AcquisitionDisclosure = Object.freeze({
    facets: Object.freeze([]),
    quotableAmounts: Object.freeze([]),
  });
  if (input.humanNeeded) return empty;

  // §4 — deux sources, réunies, et la seconde n'ouvre qu'UNE facette.
  //
  // `TRIAL_COST` et `AD_BUDGET` ouvrent `AD_BUDGET` et rien d'autre : un
  // prospect qui demande ce que coûte le test ne reçoit ni la chaîne complète
  // du système, ni la politique d'exclusivité. Les deux autres sujets —
  // `POST_TRIAL_PRICE` et `UNRESOLVED` — n'ouvrent RIEN, et c'est le point :
  // demander le prix de la suite ne donne accès à aucun montant.
  const price = input.priceSubject ?? null;
  const fromPrice: readonly AcquisitionFacet[] =
    price !== null && price.covered && (price.subject === 'TRIAL_COST' || price.subject === 'AD_BUDGET')
      ? Object.freeze(['AD_BUDGET' as const])
      : Object.freeze([]);

  const fromTopic = FACETS_BY_TOPIC[input.questionTopic] ?? Object.freeze([]);
  const facets = Object.freeze([...new Set<AcquisitionFacet>([...fromTopic, ...fromPrice])]);
  if (facets.length === 0) return empty;

  // Les montants viennent des vérités, jamais d'un littéral. Le sujet du prix
  // en apporte de son côté — `TRIAL_COST` ajoute le zéro des frais de service,
  // qui n'appartient pas au budget publicitaire — et l'union est la seule
  // lecture juste : la phrase honnête sur le coût du test les porte tous.
  const amounts = new Set<number>();
  if (facets.includes('AD_BUDGET')) for (const value of AD_BUDGET_QUOTABLE_AMOUNTS) amounts.add(value);
  if (price !== null) for (const value of price.quotableAmounts) amounts.add(value);

  return Object.freeze({
    facets,
    quotableAmounts: Object.freeze([...amounts]),
  });
}

/**
 * Le principe générique que le canari a rendu nécessaire.
 *
 * Il ne parle pas de publicité ni de CRM : il dit ce qu'on fait d'une question
 * dont la réponse existe. Le brouillon du 23 août était naturel, court, poli —
 * et il répondait à une question par une question. C'est une faute
 * commerciale, pas une maladresse de style, et elle mérite d'être écrite comme
 * une règle plutôt que d'être espérée.
 *
 * Le pendant déterministe vit dans `checkNaturalness`
 * (`QUESTION_WITHOUT_ANSWER`) : la consigne ci-dessous demande, le contrôle
 * mesure. Une consigne seule est suivie en moyenne ; ce qui est mesuré l'est
 * toujours.
 */
export const ANSWER_FIRST_DIRECTIVE = [
  'RÉPONDS D’ABORD',
  'On vient de te poser une question dont tu connais la réponse — elle est dans les faits ci-dessus.',
  '',
  '- commence par y RÉPONDRE, en une ou deux phrases, avec tes mots ;',
  '- ne réponds pas à une question par une question : « ça dépend de ce que tu as en place, tu veux',
  '  quoi ? » est une esquive, et elle se lit comme telle ;',
  '- « ça dépend » n’est une réponse que si tu dis ensuite DE QUOI cela dépend ;',
  '- ensuite, et seulement si cela sert la conversation, tu peux poser UNE petite question courte ;',
  '- si une partie de la question n’est pas couverte par les faits ci-dessus, dis-le simplement pour',
  '  cette partie-là, et n’invente rien pour la combler.',
].join('\n');

/**
 * La vérité de service, rendue pour un prompt.
 *
 * Une seule source : si les facettes changent, le prompt change avec elles. Ne
 * rend RIEN quand aucune facette n'est ouverte — pas un en-tête vide, pas une
 * ligne blanche — pour que le prompt d'un tour non concerné soit celui d'avant,
 * au caractère près.
 */
export function renderAcquisitionServiceBlock(
  facets: readonly AcquisitionFacet[],
): string {
  if (facets.length === 0) return '';

  const lines: string[] = [
    `CE QUE TU FAIS, CONCRÈTEMENT (${ACQUISITION_SERVICE_VERSION}) — ON VIENT DE TE LE DEMANDER`,
    '',
    'Ce sont des faits. Dis ce que la question demande, à la première personne, avec tes mots :',
  ];

  for (const facet of facets) {
    const truth = ACQUISITION_TRUTH[facet];
    lines.push('', `[${facet}]`);
    for (const fact of truth.facts) lines.push(`- ${fact}`);
    lines.push('  ce que cela n’autorise PAS :');
    for (const limit of truth.limits) lines.push(`  · ${limit}`);
  }

  lines.push('', 'Et tu ne fais toujours pas, ici comme ailleurs :');
  for (const entry of HERMES_OUT_OF_SCOPE) lines.push(`- ${entry}`);

  lines.push('', ANSWER_FIRST_DIRECTIVE);

  return lines.join('\n');
}
