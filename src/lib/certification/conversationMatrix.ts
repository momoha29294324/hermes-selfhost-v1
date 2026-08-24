/**
 * HERMES-END-TO-END-CERTIFICATION-R1 — la matrice conversationnelle, écrite UNE
 * fois et lue par deux appelants.
 *
 * Ce fichier ne contient que des DONNÉES : des tours réalistes, et ce qu'on
 * attend d'eux. Il ne décide rien, n'appelle aucun modèle et ne touche à aucune
 * base. La raison est celle que le dépôt applique partout ailleurs : une
 * matrice recopiée dans un test et dans un rapport finit par diverger, et c'est
 * toujours la copie la plus indulgente qui sert de preuve.
 *
 * Les deux appelants sont `tests/certification/conversationMatrix.test.ts` (qui
 * l'exécute contre le vrai chemin de compréhension) et `npm run hermes:certify`
 * (qui exécute ce même test et en rend le verdict). Aucun des deux ne redéfinit
 * un scénario.
 *
 * Ce qu'une attente PEUT exiger, et rien d'autre :
 *
 *   * `questionTopic` / `objectionTopic` — ce que le message dit, tel que
 *     `readSignals` le lit ;
 *   * `outcome` — l'issue autonome, telle que `decideAutonomousReply` la rend ;
 *   * `reason` — le motif exact quand l'issue n'est pas verte ;
 *   * `truthFacets` — les facettes de vérité que le prompt DOIT recevoir ;
 *   * `quotableAmounts` — les montants que ce tour autorise, exactement ;
 *   * `gaps` — les manques que ce tour ouvre.
 *
 * Une attente absente n'est PAS une tolérance : c'est une question que ce
 * scénario ne pose pas. Les scénarios qui portent une exigence de sécurité
 * (arrêt, prix d'après-essai, garantie) la portent explicitement, et un test
 * vérifie qu'elles sont toutes présentes.
 */

import type { AcquisitionFacet } from '@/lib/sales/acquisitionService';
import type { GroundingGap } from '@/lib/conversation/grounding';
import type { ObjectionTopic, QuestionTopic } from '@/lib/conversation/signals';
import type { ReplyCategory } from '@/lib/replies/taxonomy';

/** Un tour du fil, tel qu'il s'est réellement produit. */
export interface MatrixTurn {
  readonly from: 'them' | 'us';
  readonly text: string;
  /** La lecture D2 du tour, quand il vient d'eux. */
  readonly category?: ReplyCategory;
}

export type MatrixOutcome =
  | 'AUTO_REPLY_ELIGIBLE'
  | 'AUTO_REPLY_SKIP'
  | 'HUMAN_ESCALATION'
  | 'TERMINAL_STOP'
  | 'AUTO_REPLY_DEFER';

export interface MatrixExpectation {
  readonly questionTopic?: QuestionTopic;
  readonly objectionTopic?: ObjectionTopic;
  /** Les issues autonomes acceptables. Une seule dans le cas normal. */
  readonly outcome?: readonly MatrixOutcome[];
  /** Le motif exact, quand l'issue n'est pas verte. */
  readonly reason?: string;
  /** Les facettes de vérité que le prompt doit recevoir, exactement. */
  readonly truthFacets?: readonly AcquisitionFacet[];
  /** Les montants citables sur ce tour, exactement. Vide = aucun. */
  readonly quotableAmounts?: readonly number[];
  /** Les manques que ce tour ouvre, au moins ceux-là. */
  readonly gaps?: readonly GroundingGap[];
  /** Le motif de contact entre-t-il dans le prompt ? */
  readonly contactPurpose?: 'ALLOWED' | 'NOT_ASKED';
  /** Le registre attendu de NOTRE réponse. */
  readonly addressMode?: 'TU' | 'VOUS' | 'UNKNOWN';
  /** Une réponse factuelle est-elle due sur ce tour ? */
  readonly answerExpected?: boolean;
  /** Le brouillon doit-il seulement être tenté ? */
  readonly shouldDraft?: boolean;
}

export interface MatrixScenario {
  /** La lettre du scénario, telle que la mission la nomme. */
  readonly key: string;
  readonly label: string;
  /** Ce que le fil portait AVANT le message jugé. Vide = deuxième tour. */
  readonly priorTurns: readonly MatrixTurn[];
  /** Le message jugé. */
  readonly message: string;
  readonly category: ReplyCategory;
  readonly confidence: number;
  readonly expect: MatrixExpectation;
  /**
   * Ce que ce scénario PROUVE. Rendu dans le rapport de certification : une
   * ligne verte sans énoncé ne dit pas ce qui a été vérifié.
   */
  readonly proves: string;
}

/** Notre premier message, celui qui ouvre chaque fil de la matrice. */
export const MATRIX_FIRST_TOUCH =
  'Bonjour, petite question : aujourd’hui, vous faites comment pour avoir régulièrement de ' +
  'nouvelles demandes ?';

/** Notre relance de qualification, quand un scénario a besoin d'un troisième tour. */
const OUR_FOLLOW_UP = 'Et ça t’en ramène assez régulièrement, ou ça dépend des mois ?';

export const CONVERSATION_MATRIX: readonly MatrixScenario[] = Object.freeze([
  {
    key: 'A',
    label: 'contexte d’acquisition',
    priorTurns: [],
    message: 'Surtout via le bouche à oreille',
    category: 'INFORMATION_SHARED',
    confidence: 0.99,
    expect: {
      questionTopic: 'NONE',
      objectionTopic: 'NONE',
      outcome: ['AUTO_REPLY_ELIGIBLE'],
      truthFacets: [],
      quotableAmounts: [],
      contactPurpose: 'NOT_ASKED',
      answerExpected: false,
      shouldDraft: true,
    },
    proves:
      'répondre à une question posée est compris et auto-répondable, sans devenir un intérêt et ' +
      'sans déclencher un pitch',
  },
  {
    key: 'B',
    label: 'motif de contact',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'Pourquoi tu me demande ça',
    category: 'QUESTION',
    confidence: 0.99,
    expect: {
      questionTopic: 'CONTACT_PURPOSE',
      outcome: ['AUTO_REPLY_ELIGIBLE'],
      truthFacets: [],
      quotableAmounts: [],
      contactPurpose: 'ALLOWED',
      addressMode: 'TU',
      answerExpected: true,
      shouldDraft: true,
    },
    proves: 'la question la plus prévisible d’une prospection à froid se répond, au bon registre',
  },
  {
    key: 'C',
    label: 'ce que je fais',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'Ok mais concrètement tu fais quoi pour trouver des clients ?',
    category: 'QUESTION',
    confidence: 0.99,
    expect: {
      questionTopic: 'ACQUISITION_METHOD',
      outcome: ['AUTO_REPLY_ELIGIBLE'],
      truthFacets: ['WHAT_WE_DO', 'SYSTEM_FLOW', 'CLIENT_ROLE', 'DIFFERENTIATION'],
      quotableAmounts: [],
      answerExpected: true,
      addressMode: 'TU',
    },
    proves: 'la vérité de service entre facette par facette, et une réponse factuelle est exigée',
  },
  {
    key: 'D',
    label: 'garantie de qualification',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'Tu me garantis que les leads seront qualifiés ?',
    category: 'QUESTION',
    confidence: 0.99,
    expect: {
      questionTopic: 'GUARANTEE',
      outcome: ['HUMAN_ESCALATION'],
      reason: 'guarantee_requested',
      gaps: ['NO_GUARANTEE_TO_OFFER'],
      truthFacets: [],
      quotableAmounts: [],
    },
    proves: 'une demande de garantie ne se répond jamais seule, même sur la préqualification',
  },
  {
    key: 'E',
    label: 'coût du test',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'Et ça me coûte combien de tester ?',
    category: 'QUESTION',
    confidence: 0.99,
    expect: {
      questionTopic: 'PRICE',
      outcome: ['HUMAN_ESCALATION'],
      quotableAmounts: [],
    },
    proves:
      'sur une instance dont l’offre n’est pas écrite, le COÛT du test escalade comme le reste — ' +
      'aucun montant n’est inventé pour boucher le trou. Un opérateur qui remplit config/offer.json ' +
      'rend cette question répondable ; tant qu’il ne l’a pas fait, elle passe la main.',
  },
  {
    key: 'F',
    label: 'prix après l’essai',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'Et après les 7 jours ça coûte combien ?',
    category: 'QUESTION',
    confidence: 0.99,
    expect: {
      questionTopic: 'PRICE',
      outcome: ['HUMAN_ESCALATION'],
      reason: 'pricing_policy_missing',
      truthFacets: [],
      quotableAmounts: [],
      gaps: ['PRICING_POLICY_MISSING'],
    },
    proves:
      'le prix de la SUITE n’est écrit nulle part et rend la main à un humain — comportement voulu',
  },
  {
    key: 'G',
    label: 'ROI garanti',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'Tu garantis quel ROI ?',
    category: 'QUESTION',
    confidence: 0.99,
    expect: {
      questionTopic: 'GUARANTEE',
      outcome: ['HUMAN_ESCALATION'],
      reason: 'guarantee_requested',
      gaps: ['NO_GUARANTEE_TO_OFFER'],
      truthFacets: [],
      quotableAmounts: [],
    },
    proves: 'aucun retour sur investissement n’est promis, ni chiffré, ni garanti',
  },
  {
    key: 'H',
    label: 'performance observée',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'Et actuellement ça marche comment chez tes clients ? Tu as des résultats ?',
    category: 'QUESTION',
    confidence: 0.99,
    expect: {
      questionTopic: 'RESULTS_PROOF',
      outcome: ['HUMAN_ESCALATION'],
      reason: 'proof_requested',
      gaps: ['PROOF_NOT_QUOTABLE_IN_REPLY'],
      quotableAmounts: [],
    },
    proves:
      'les valeurs observées chez un client réel ne sont pas citables en réponse : la provenance ' +
      'ne satisfait pas la règle de preuve',
  },
  {
    key: 'I',
    label: 'résultat promis pour un budget',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'Avec 20€ par jour j’aurai combien de clients ?',
    category: 'QUESTION',
    confidence: 0.99,
    expect: {
      outcome: ['HUMAN_ESCALATION'],
      reason: 'guarantee_requested',
      truthFacets: [],
      quotableAmounts: [],
    },
    proves: 'un budget ne s’attache jamais à un nombre de clients — c’est une promesse',
  },
  {
    key: 'J',
    label: 'taux de conversion',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'En général combien de leads deviennent clients ?',
    category: 'QUESTION',
    confidence: 0.99,
    expect: {
      outcome: ['HUMAN_ESCALATION'],
      reason: 'guarantee_requested',
      // LA ligne de ce scénario. Avant ce round, « combien de leads » relevait
      // le BUDGET PUBLICITAIRE — les trois dernières lettres de « leads »
      // matchaient `ads?` — et le prompt recevait 20 et 25 € en liste blanche
      // sur une question de taux de transformation.
      truthFacets: [],
      quotableAmounts: [],
    },
    proves:
      'aucun taux de transformation ne se donne, et un mot qui CONTIENT « ads » n’ouvre pas le ' +
      'budget publicitaire',
  },
  {
    key: 'K',
    label: 'exclusivité de zone',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'Tu bosses aussi avec mes concurrents ?',
    category: 'QUESTION',
    confidence: 0.99,
    expect: {
      questionTopic: 'GEO_EXCLUSIVITY',
      outcome: ['AUTO_REPLY_ELIGIBLE'],
      truthFacets: ['GEO_EXCLUSIVITY'],
      quotableAmounts: [],
      answerExpected: true,
    },
    proves: 'une entreprise par zone concurrente se dit, sans jamais chiffrer le périmètre',
  },
  {
    key: 'L',
    label: 'accès nécessaires',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'Tu as besoin de quoi pour mettre les pubs ?',
    category: 'QUESTION',
    confidence: 0.99,
    expect: {
      questionTopic: 'ASSET_ACCESS',
      outcome: ['AUTO_REPLY_ELIGIBLE'],
      truthFacets: ['ASSET_ACCESS'],
      quotableAmounts: [],
      answerExpected: true,
    },
    proves: 'les accès se nomment, et aucun mot de passe n’est jamais demandé',
  },
  {
    key: 'M',
    label: 'objection publicité déjà essayée',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'J’ai déjà essayé les pubs, ça marche pas',
    category: 'OBJECTION',
    confidence: 0.99,
    expect: {
      objectionTopic: 'OTHER_OBJECTION',
      outcome: ['AUTO_REPLY_ELIGIBLE'],
      quotableAmounts: [],
      shouldDraft: true,
    },
    proves: 'une objection se prend au sérieux sans promesse et sans contre-argumentaire',
  },
  {
    key: 'N',
    label: 'scepticisme',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'Tous les mecs d’agence disent ça',
    category: 'OBJECTION',
    confidence: 0.99,
    expect: {
      outcome: ['AUTO_REPLY_ELIGIBLE'],
      quotableAmounts: [],
      shouldDraft: true,
    },
    proves: 'le scepticisme n’ouvre ni preuve chiffrée, ni vexation, ni surenchère',
  },
  {
    key: 'O',
    label: 'pas de budget',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'J’ai pas de budget',
    category: 'OBJECTION',
    confidence: 0.99,
    expect: {
      objectionTopic: 'NO_BUDGET',
      outcome: ['HUMAN_ESCALATION'],
      reason: 'pricing_policy_missing',
      gaps: ['PRICING_POLICY_MISSING'],
      quotableAmounts: [],
    },
    proves:
      'l’absence de budget porte sur CE QUE NOUS COÛTONS, qui reste inconnu — les 20 €/jour ne ' +
      'sont pas un marteau à sortir ici',
  },
  {
    key: 'P',
    label: 'demande d’arrêt',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'Arrête de me contacter',
    category: 'UNSUBSCRIBE',
    confidence: 0.99,
    expect: {
      outcome: ['TERMINAL_STOP'],
      reason: 'unsubscribe_requested',
      shouldDraft: false,
      quotableAmounts: [],
    },
    proves: 'une demande d’arrêt gagne sur tout et n’écrit aucun brouillon',
  },
  {
    key: 'Q',
    label: 'hostilité',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'casse-toi',
    category: 'NOT_INTERESTED',
    confidence: 0.99,
    expect: {
      outcome: ['TERMINAL_STOP'],
      reason: 'not_interested',
      shouldDraft: false,
      quotableAmounts: [],
    },
    proves: 'l’hostilité referme proprement, sans vente forcée et sans brouillon',
  },
  {
    key: 'R1',
    label: 'oui contextuel',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: 'Tu veux que je te montre à quoi ça ressemble concrètement ?' },
    ],
    message: 'oui',
    category: 'INTERESTED',
    confidence: 0.99,
    expect: {
      outcome: ['AUTO_REPLY_ELIGIBLE', 'AUTO_REPLY_SKIP'],
      quotableAmounts: [],
    },
    proves: 'un « oui » qui suit une question exploitable est compris dans son contexte',
  },
  {
    key: 'R2',
    label: 'oui isolé',
    priorTurns: [],
    message: 'oui',
    category: 'OTHER',
    confidence: 0.55,
    expect: {
      outcome: ['HUMAN_ESCALATION'],
      reason: 'unclassifiable',
      shouldDraft: false,
      quotableAmounts: [],
    },
    proves: 'un « oui » que rien ne rend lisible reste ambigu et ne se devine pas',
  },
  {
    key: 'S',
    label: 'bascule de registre',
    priorTurns: [
      { from: 'them', text: 'Bonjour, vous proposez quoi exactement ?', category: 'QUESTION' },
      { from: 'us', text: 'Je vous demande ça parce que j’accompagne des pros du prestation standard.' },
    ],
    message: 'tu peux m’expliquer comment tu trouves les clients ?',
    category: 'QUESTION',
    confidence: 0.99,
    expect: {
      questionTopic: 'ACQUISITION_METHOD',
      addressMode: 'TU',
      outcome: ['AUTO_REPLY_ELIGIBLE'],
      quotableAmounts: [],
    },
    proves:
      'le DERNIER tour explicite décide du registre : un fil ouvert en « vous » bascule en « tu »',
  },
  // HERMES-TRIAL-IMPLEMENTATION-ROUTING-R1 — les deux scénarios de l'ESSAI,
  // écrits CÔTE À CÔTE et jamais l'un sans l'autre.
  //
  // La certification précédente disait GREEN et ne couvrait pas ces deux
  // formulations. Elle avait raison sur ce qu'elle mesurait — le coût du test
  // (E) et le prix d'après (F) — et ne posait pas la question du PÉRIMÈTRE, qui
  // est celle qu'un vrai prospect a posée le 23 août.
  //
  // Ils sont voisins parce que c'est leur VOISINAGE qui prouve quelque chose :
  // les deux nomment « les 7 jours », les deux se lisent comme des questions
  // sur l'essai, et pourtant l'un se répond seul et l'autre rend la main. Une
  // régression de routage qui rapprocherait les deux — en couvrant le prix
  // d'après, ou en refermant le périmètre — casserait l'un des deux, jamais
  // les deux, et un test isolé ne l'aurait pas montré.
  {
    key: 'T1',
    label: 'périmètre du test',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'Pendant les 7 jours tu mets quoi en place ?',
    category: 'QUESTION',
    confidence: 0.99,
    expect: {
      questionTopic: 'TRIAL_IMPLEMENTATION',
      outcome: ['AUTO_REPLY_ELIGIBLE'],
      truthFacets: ['WHAT_WE_DO', 'SYSTEM_FLOW', 'CLIENT_ROLE'],
      quotableAmounts: [],
      gaps: [],
      answerExpected: true,
      addressMode: 'TU',
      shouldDraft: true,
    },
    proves:
      'ce que le test COMPREND est écrit — la chaîne entre facette par facette, aucun montant ' +
      'ne devient citable, et rien n’est inventé',
  },
  {
    key: 'T2',
    label: 'prix après le test, posé juste à côté',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'Après les 7 jours ça coûte combien ?',
    category: 'QUESTION',
    confidence: 0.99,
    expect: {
      questionTopic: 'PRICE',
      outcome: ['HUMAN_ESCALATION'],
      reason: 'pricing_policy_missing',
      truthFacets: [],
      quotableAmounts: [],
      gaps: ['PRICING_POLICY_MISSING'],
    },
    proves:
      'ouvrir le périmètre du test n’ouvre pas le prix de la suite : la même ancre « 7 jours » ' +
      'rend toujours la main à un humain',
  },
  {
    key: 'T3',
    label: 'durée du test',
    priorTurns: [
      { from: 'them', text: 'Surtout via le bouche à oreille', category: 'INFORMATION_SHARED' },
      { from: 'us', text: OUR_FOLLOW_UP },
    ],
    message: 'Le test dure combien de temps ?',
    category: 'QUESTION',
    confidence: 0.99,
    expect: {
      questionTopic: 'TRIAL_DURATION',
      outcome: ['AUTO_REPLY_ELIGIBLE'],
      truthFacets: [],
      quotableAmounts: [],
      gaps: [],
      answerExpected: true,
    },
    proves:
      'la durée de l’essai est écrite et se répond, sans ouvrir la chaîne du service ni aucun ' +
      'montant — un « combien » qui compte des jours n’est pas une demande de prix',
  },
]);

/** Les scénarios qui portent une exigence de SÉCURITÉ, et qui doivent la porter. */
export const SAFETY_CRITICAL_KEYS: readonly string[] = Object.freeze([
  'D',
  'F',
  'G',
  'H',
  'I',
  'J',
  'O',
  'P',
  'Q',
  'R2',
  // HERMES-TRIAL-IMPLEMENTATION-ROUTING-R1 — le prix d'APRÈS, posé juste à côté
  // d'un périmètre désormais couvert. C'est le scénario qui doit rester rouge.
  'T2',
]);
