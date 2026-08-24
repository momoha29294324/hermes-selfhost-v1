/**
 * HERMES-SEMANTIC-GROUNDING-R1 — le corpus SÉMANTIQUE, écrit une fois et lu par
 * deux appelants.
 *
 * Ce fichier ne contient que des DONNÉES : des tours écrits comme un prospect
 * les écrit, et ce qu'on attend d'eux. Il ne décide rien, n'appelle aucun
 * modèle et ne touche à aucune base — même règle que
 * `certification/conversationMatrix.ts`, et pour la même raison : un corpus
 * recopié dans un test et dans un rapport finit par diverger, et c'est toujours
 * la copie la plus indulgente qui sert de preuve.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce corpus éprouve, et ce qu'il n'éprouve pas
 * ---------------------------------------------------------------------------
 * Une seule question : **une demande commerciale est-elle ADRESSÉE, ou
 * seulement ÉVOQUÉE ?** Il n'éprouve ni le style, ni la longueur, ni le
 * routage des vérités — trois choses que `conversationMatrix.ts` couvre déjà.
 *
 * Deux moitiés, et elles ne se valent pas :
 *
 *   * `escalates: true` — une demande RÉELLE. Un faux négatif ici laisse partir
 *     seule une réponse sur un prix, une garantie ou un remboursement que
 *     personne n'a écrits. C'est la moitié dangereuse ;
 *   * `escalates: false` — une évocation. Un faux positif ici fait attendre un
 *     humain pour une question que personne n'a posée. C'est la moitié qui
 *     coûte des conversations.
 *
 * ---------------------------------------------------------------------------
 * Les paraphrases ne sont PAS recopiées des incidents
 * ---------------------------------------------------------------------------
 * Les treize tours réellement observés vivent dans `REAL_CANARY_CORPUS`, à
 * part, et portent leur identifiant de message. Tout le reste a été écrit pour
 * ce corpus : c'est ce qui permet de dire qu'un test ne se contente pas de
 * reconnaître les phrases qu'on lui a montrées. Un lexique taillé sur les
 * exemples passerait la première liste et échouerait sur la seconde.
 */

import type { CommercialEscalationReason } from '@/lib/conversation/commercialPolicy';
import type { UtteranceFrame } from '@/lib/conversation/utteranceScope';
import type { PriceSubject } from '@/lib/sales/priceSubject';

/**
 * La famille sémantique d'un cas.
 *
 * Elle sert à deux choses : lire un échec (« toutes les négations tombent »
 * plutôt que « le cas 47 tombe »), et vérifier qu'aucune famille n'est vide —
 * un corpus qui perdrait sa moitié dangereuse passerait au vert sans rien
 * prouver.
 */
export type SemanticFamily =
  | 'DIRECT_PRICE'
  | 'HISTORICAL_PRICE'
  | 'DIRECT_GUARANTEE'
  | 'HISTORICAL_GUARANTEE'
  | 'DIRECT_REFUND'
  | 'HYPOTHETICAL_REFUND'
  | 'DIRECT_DURATION'
  | 'THIRD_PARTY_DURATION'
  | 'DIRECT_BUDGET'
  | 'PAST_BUDGET'
  | 'DIRECT_SERVICE'
  | 'OLD_PROVIDER'
  | 'NEGATED_REQUEST'
  | 'QUOTED_REQUEST'
  | 'COMPARISON'
  | 'AMBIGUOUS';

export interface SemanticCase {
  readonly key: string;
  readonly label: string;
  /** Le message, tel qu'un prospect l'écrirait. */
  readonly text: string;
  readonly family: SemanticFamily;
  /** Le cadre attendu à l'endroit où le motif commercial est reconnu. */
  readonly frame: UtteranceFrame;
  /** Ce tour doit-il écarter la réponse autonome pour raison commerciale ? */
  readonly escalates: boolean;
  /** Le motif exact, quand il escalade. */
  readonly reason?: CommercialEscalationReason;
  /** Le sujet du prix, quand le cas en porte un et qu'on veut le fixer. */
  readonly priceSubject?: PriceSubject;
}

/**
 * Les tours RÉELLEMENT observés sur le fil contrôlé, avec leur identifiant.
 *
 * Ils ne sont pas des paraphrases : ce sont les messages exacts, recopiés de
 * `r6b_inbound_messages`, fautes comprises. Un test qui les rejouerait
 * « proprement » ne prouverait rien du monde réel.
 */
export interface RealCanaryCase {
  readonly inboundMessageId: string;
  readonly at: string;
  readonly text: string;
  /** Ce que ce tour doit produire, commercialement. */
  readonly escalates: boolean;
  readonly reason?: CommercialEscalationReason;
  /** Ce qui s'était réellement passé le 23 août 2026, pour mémoire. */
  readonly historicalOutcome: string;
}

/**
 * Cette édition n'embarque AUCUN corpus de conversation réelle.
 *
 * Les tours réellement échangés par une instance — leur texte, leur
 * identifiant de message, leur horodatage — appartiennent à celle-ci et aux
 * personnes qui les ont écrits. Ils ne se distribuent pas. Ce qui reste,
 * `SEMANTIC_CORPUS`, a été ÉCRIT pour ce test : c'est ce qui permet de dire
 * qu'il ne se contente pas de reconnaître des phrases déjà vues.
 */
export const REAL_CANARY_CORPUS: readonly RealCanaryCase[] = Object.freeze([]);

/**
 * Le corpus de PARAPHRASES, écrit pour ce round.
 *
 * Chaque famille porte des cas des deux bords. L'appariement est délibéré : la
 * paire « demande directe » / « mention historique » d'un même sujet est la
 * seule façon de prouver qu'on distingue un ACTE d'un RÉCIT, plutôt que de
 * reconnaître un vocabulaire.
 */
export const SEMANTIC_CORPUS: readonly SemanticCase[] = Object.freeze([
  // ---- PRIX : la demande directe -----------------------------------------
  {
    key: 'P1',
    label: 'prix nu',
    text: 'Ducoup ça coûte combien par mois ?',
    family: 'DIRECT_PRICE',
    frame: 'CURRENT',
    escalates: true,
    reason: 'pricing_policy_missing',
    priceSubject: 'POST_TRIAL_PRICE',
  },
  {
    key: 'P2',
    label: 'tarif au vouvoiement',
    text: 'Quels sont vos tarifs pour ce genre de prestation ?',
    family: 'DIRECT_PRICE',
    frame: 'CURRENT',
    escalates: true,
    reason: 'pricing_policy_missing',
  },
  {
    key: 'P3',
    label: 'demande polie au conditionnel',
    text: "J'aimerais connaître le tarif avant d'aller plus loin",
    family: 'DIRECT_PRICE',
    frame: 'CURRENT',
    escalates: true,
    reason: 'pricing_policy_missing',
  },
  {
    key: 'P4',
    label: 'abonnement après le test',
    text: "C'est quoi ton abonnement mensuel une fois l'essai fini ?",
    family: 'DIRECT_PRICE',
    frame: 'CURRENT',
    escalates: true,
    reason: 'pricing_policy_missing',
    priceSubject: 'POST_TRIAL_PRICE',
  },
  {
    key: 'P5',
    label: 'devis',
    text: 'Tu peux me faire un devis ?',
    family: 'DIRECT_PRICE',
    frame: 'CURRENT',
    escalates: true,
    reason: 'pricing_policy_missing',
  },
  {
    key: 'P6',
    label: 'prix sans ponctuation',
    text: 'et le prix cest quoi exactement',
    family: 'DIRECT_PRICE',
    frame: 'CURRENT',
    escalates: true,
    reason: 'pricing_policy_missing',
  },
  {
    key: 'P7',
    label: 'honoraires',
    text: 'Tes honoraires ils sont de combien après ?',
    family: 'DIRECT_PRICE',
    frame: 'CURRENT',
    escalates: true,
    reason: 'pricing_policy_missing',
    priceSubject: 'POST_TRIAL_PRICE',
  },
  {
    key: 'P8',
    label: 'setup',
    text: "Il y a des frais de mise en place à prévoir ?",
    family: 'DIRECT_PRICE',
    frame: 'CURRENT',
    escalates: true,
    reason: 'pricing_policy_missing',
  },

  // ---- PRIX : la mention historique --------------------------------------
  {
    key: 'H1',
    label: 'clients passés qui demandaient un prix',
    text: "Mes anciens contacts me demandaient toujours le tarif et disparaissaient après",
    family: 'HISTORICAL_PRICE',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'H2',
    label: 'ce que le prospect facturait',
    text: 'Avant je facturais 90 balles le prestation complet',
    family: 'HISTORICAL_PRICE',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'H3',
    label: 'gens qui trouvent ça cher',
    text: "Les gens trouvaient ça trop cher à l'époque",
    family: 'HISTORICAL_PRICE',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'H4',
    label: 'demande de prix reçue par le prospect, au présent',
    text: 'On me demande souvent le prix dès le premier message',
    family: 'HISTORICAL_PRICE',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'H5',
    label: 'clientèle qui veut savoir combien',
    text: 'Les particuliers veulent toujours savoir combien ça coûte avant de venir',
    family: 'HISTORICAL_PRICE',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'H6',
    label: 'devis envoyés par le prospect',
    text: "J'envoyais des devis à tout le monde et ça ne donnait rien",
    family: 'HISTORICAL_PRICE',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'H7',
    label: 'budget dépensé autrefois',
    text: "Le mois dernier j'ai dépensé une fortune pour zéro résultat",
    family: 'HISTORICAL_PRICE',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'H8',
    label: 'prix pratiqué par des concurrents',
    text: 'Les concurrents cassaient les prix dans le secteur',
    family: 'HISTORICAL_PRICE',
    frame: 'REPORTED',
    escalates: false,
  },

  // ---- GARANTIE ------------------------------------------------------------
  {
    key: 'G1',
    label: 'garantie demandée',
    text: 'Tu garantis combien de clients par mois ?',
    family: 'DIRECT_GUARANTEE',
    frame: 'CURRENT',
    escalates: true,
    reason: 'guarantee_requested',
  },
  {
    key: 'G2',
    label: 'garantie au vouvoiement',
    text: 'Vous garantissez un résultat ou pas ?',
    family: 'DIRECT_GUARANTEE',
    frame: 'CURRENT',
    escalates: true,
    reason: 'guarantee_requested',
  },
  {
    key: 'G3',
    label: 'garantie exigée sans point d’interrogation',
    text: "J'ai besoin d'une garantie écrite avant de signer quoi que ce soit",
    family: 'DIRECT_GUARANTEE',
    frame: 'CURRENT',
    escalates: true,
    reason: 'guarantee_requested',
  },
  {
    key: 'G4',
    label: 'engagement de résultat',
    text: 'Tu me garantis des résultats sous un mois ?',
    family: 'DIRECT_GUARANTEE',
    frame: 'CURRENT',
    escalates: true,
    reason: 'guarantee_requested',
  },
  {
    key: 'HG1',
    label: 'garantie promise par un ancien prestataire',
    text: "Mon ancienne agence me garantissait 20 demandes par mois, j'en ai eu trois",
    family: 'HISTORICAL_GUARANTEE',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'HG2',
    label: 'promesse d’un commercial passé',
    text: "Le gars qui m'avait démarché promettait monts et merveilles",
    family: 'HISTORICAL_GUARANTEE',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'HG3',
    label: 'garantie qu’un tiers exigeait',
    text: 'Mes clients voulaient une garantie sur le résultat du traitement',
    family: 'HISTORICAL_GUARANTEE',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'HG4',
    label: 'garantie évoquée au passé composé',
    text: "On m'a déjà garanti des résultats et ça n'a rien donné",
    family: 'HISTORICAL_GUARANTEE',
    frame: 'REPORTED',
    escalates: false,
  },

  // ---- REMBOURSEMENT -------------------------------------------------------
  {
    key: 'R1',
    label: 'remboursement demandé',
    text: 'Tu me rembourses si ça ne marche pas ?',
    family: 'DIRECT_REFUND',
    frame: 'CURRENT',
    escalates: true,
  },
  {
    key: 'R2',
    label: 'remboursement au vouvoiement',
    text: 'Vous remboursez en cas de non-résultat ?',
    family: 'DIRECT_REFUND',
    frame: 'CURRENT',
    escalates: true,
  },
  {
    key: 'HR1',
    label: 'remboursement envisagé, pas demandé',
    text: "Si un client me réclamait un remboursement je ne saurais pas quoi lui dire",
    family: 'HYPOTHETICAL_REFUND',
    frame: 'HYPOTHETICAL',
    escalates: false,
  },
  {
    key: 'HR2',
    label: 'remboursement raconté',
    text: "L'an dernier j'ai dû rembourser deux clients mécontents",
    family: 'HYPOTHETICAL_REFUND',
    frame: 'REPORTED',
    escalates: false,
  },

  // ---- DURÉE ---------------------------------------------------------------
  {
    key: 'D1',
    label: 'durée du test',
    text: 'Le test dure combien de jours exactement ?',
    family: 'DIRECT_DURATION',
    frame: 'CURRENT',
    escalates: false,
  },
  {
    key: 'D2',
    label: 'délai de résultat',
    text: 'En combien de temps on voit les premiers résultats ?',
    family: 'DIRECT_DURATION',
    frame: 'CURRENT',
    escalates: false,
  },
  {
    key: 'TD1',
    label: 'durée demandée par des tiers',
    text: 'Mes clients me demandaient toujours combien de temps ça prenait',
    family: 'THIRD_PARTY_DURATION',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'TD2',
    label: 'durée d’un ancien contrat',
    text: "Mon ancien contrat courait sur douze mois, j'ai détesté",
    family: 'THIRD_PARTY_DURATION',
    frame: 'REPORTED',
    escalates: false,
  },

  // ---- BUDGET PUBLICITAIRE -------------------------------------------------
  {
    key: 'B1',
    label: 'budget pub demandé',
    text: 'Il faut mettre combien par jour en pub pour démarrer ?',
    family: 'DIRECT_BUDGET',
    frame: 'CURRENT',
    escalates: false,
    priceSubject: 'AD_BUDGET',
  },
  {
    key: 'B2',
    label: 'budget pub, forme plurielle',
    text: 'Quel budget sur les pubs Meta au départ ?',
    family: 'DIRECT_BUDGET',
    frame: 'CURRENT',
    escalates: false,
    priceSubject: 'AD_BUDGET',
  },
  {
    key: 'PB1',
    label: 'budget dépensé autrefois',
    text: "À l'époque je mettais 300 euros par mois dans les pubs Facebook",
    family: 'PAST_BUDGET',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'PB2',
    label: 'budget d’un tiers',
    text: 'Un confrère dépensait 1000 euros par mois en publicité',
    family: 'PAST_BUDGET',
    frame: 'REPORTED',
    escalates: false,
  },

  // ---- SERVICE -------------------------------------------------------------
  {
    key: 'S1',
    label: 'ce que nous faisons',
    text: 'Concrètement tu mets quoi en place pour trouver des clients ?',
    family: 'DIRECT_SERVICE',
    frame: 'CURRENT',
    escalates: false,
  },
  {
    key: 'S2',
    label: 'canal utilisé',
    text: 'Tu passes par quelle plateforme pour les campagnes ?',
    family: 'DIRECT_SERVICE',
    frame: 'CURRENT',
    escalates: false,
  },
  {
    key: 'OP1',
    label: 'ce que faisait l’ancien prestataire',
    text: "Mon ancien prestataire prenait 20% sur chaque dossier",
    family: 'OLD_PROVIDER',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'OP2',
    label: 'ce que faisait une agence passée',
    text: 'La dernière agence facturait un abonnement mensuel énorme',
    family: 'OLD_PROVIDER',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'OP3',
    label: 'ancien freelance et son pourcentage',
    text: "Mon ex-community manager me prenait une commission sur les ventes",
    family: 'OLD_PROVIDER',
    frame: 'REPORTED',
    escalates: false,
  },

  // ---- NÉGATION ------------------------------------------------------------
  {
    key: 'N1',
    label: 'garantie explicitement non demandée',
    text: "Je ne te demande pas de garantie, je veux juste comprendre",
    family: 'NEGATED_REQUEST',
    frame: 'NEGATED',
    escalates: false,
  },
  {
    key: 'N2',
    label: 'prix explicitement non demandé',
    text: "Je te demande pas le prix tout de suite",
    family: 'NEGATED_REQUEST',
    frame: 'NEGATED',
    escalates: false,
  },
  {
    key: 'N3',
    label: 'négation qui ne couvre pas la question',
    text: "Je ne suis pas pressé, mais tu factures combien ensuite ?",
    family: 'NEGATED_REQUEST',
    frame: 'CURRENT',
    escalates: true,
    reason: 'pricing_policy_missing',
  },
  {
    key: 'N4',
    label: 'question négative reste une question',
    text: 'Tu ne garantis pas de résultat alors ?',
    family: 'NEGATED_REQUEST',
    frame: 'CURRENT',
    escalates: true,
    reason: 'guarantee_requested',
  },

  // ---- CITATION ------------------------------------------------------------
  {
    key: 'Q1',
    label: 'message d’un client recopié',
    text: 'Un client m’a écrit « c’est combien pour un prestation standard complet ? » et j’ai jamais répondu',
    family: 'QUOTED_REQUEST',
    frame: 'QUOTED',
    escalates: false,
  },
  {
    key: 'Q2',
    label: 'phrase type recopiée',
    text: 'Ils écrivent tous « vous garantissez le résultat sur les sièges ? » en premier',
    family: 'QUOTED_REQUEST',
    frame: 'QUOTED',
    escalates: false,
  },

  // ---- COMPARAISON ---------------------------------------------------------
  {
    key: 'C1',
    label: 'comparaison avec un ancien prestataire',
    text: "Contrairement à mon ancienne agence qui facturait à l'heure, je veux comprendre avant",
    family: 'COMPARISON',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'C2',
    label: 'comparaison qui contient une vraie question',
    text: "L'agence d'avant prenait 15%, et toi tu prends combien ?",
    family: 'COMPARISON',
    frame: 'CURRENT',
    escalates: true,
  },

  // ---- RÉSULTATS PROMIS ----------------------------------------------------
  {
    key: 'E1',
    label: 'nombre de clients demandé',
    text: 'Tu me ramènes combien de clients par mois ?',
    family: 'DIRECT_GUARANTEE',
    frame: 'CURRENT',
    escalates: true,
  },
  {
    key: 'E2',
    label: 'ROI demandé',
    text: 'Je fais quel retour sur investissement avec ça ?',
    family: 'DIRECT_GUARANTEE',
    frame: 'CURRENT',
    escalates: true,
  },
  {
    key: 'HE1',
    label: 'résultats d’un ancien prestataire',
    text: "L'agence précédente m'avait promis trente demandes par mois",
    family: 'HISTORICAL_GUARANTEE',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'HE2',
    label: 'résultats obtenus par le prospect lui-même',
    text: 'À une époque je sortais vingt prestations par semaine sans rien faire',
    family: 'HISTORICAL_GUARANTEE',
    frame: 'REPORTED',
    escalates: false,
  },

  // ---- ENGAGEMENT ----------------------------------------------------------
  {
    key: 'K1',
    label: 'engagement demandé',
    text: "Il y a un engagement de combien de mois ?",
    family: 'DIRECT_PRICE',
    frame: 'CURRENT',
    escalates: true,
    reason: 'contract_terms_requested',
  },
  {
    key: 'K2',
    label: 'résiliation demandée',
    text: 'Je peux arrêter quand je veux ou il y a un préavis ?',
    family: 'DIRECT_PRICE',
    frame: 'CURRENT',
    escalates: true,
  },
  {
    key: 'HK1',
    label: 'engagement subi autrefois',
    text: "J'étais engagé douze mois avec eux et je ne pouvais rien faire",
    family: 'OLD_PROVIDER',
    frame: 'REPORTED',
    escalates: false,
  },

  // ---- EXCLUSIVITÉ ET RENDEZ-VOUS ------------------------------------------
  {
    key: 'X1',
    label: 'exclusivité demandée',
    text: 'Tu bosses aussi avec mon concurrent du coin ?',
    family: 'DIRECT_SERVICE',
    frame: 'CURRENT',
    escalates: false,
  },
  {
    key: 'X2',
    label: 'rendez-vous proposé par le prospect',
    text: 'On peut se parler cinq minutes cette semaine ?',
    family: 'DIRECT_SERVICE',
    frame: 'CURRENT',
    escalates: false,
  },
  {
    key: 'HX1',
    label: 'appel raconté',
    text: "Un commercial m'avait appelé trois fois pour me vendre ça",
    family: 'OLD_PROVIDER',
    frame: 'REPORTED',
    escalates: false,
  },

  // ---- INFORMATION PARTAGÉE, LE CAS LE PLUS FRÉQUENT -----------------------
  {
    key: 'I1',
    label: 'canal d’acquisition livré',
    text: 'Surtout le bouche à oreille et un peu Google',
    family: 'HISTORICAL_PRICE',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'I2',
    label: 'volume livré',
    text: 'Je tourne à une dizaine de véhicules par semaine en ce moment',
    family: 'HISTORICAL_PRICE',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'I3',
    label: 'prestation livrée',
    text: 'Surtout de l’intérieur et un peu de prestation extérieur',
    family: 'HISTORICAL_PRICE',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'I4',
    label: 'ancienneté livrée',
    text: 'Ça fait onze ans que j’exerce dans le secteur',
    family: 'HISTORICAL_PRICE',
    frame: 'REPORTED',
    escalates: false,
  },

  // ---- OBJECTIONS : elles restent COURANTES malgré le passé ----------------
  {
    key: 'O1',
    label: 'mauvaise expérience de la pub',
    text: "J'ai déjà essayé les pubs et ça n'a rien donné du tout",
    family: 'COMPARISON',
    frame: 'REPORTED',
    escalates: false,
  },
  {
    key: 'O2',
    label: 'prestataire en place',
    text: "J'ai déjà quelqu'un qui s'occupe de ça pour moi",
    family: 'COMPARISON',
    frame: 'REPORTED',
    escalates: false,
  },

  // ---- AMBIGU : le doute escalade -----------------------------------------
  {
    key: 'A1',
    label: 'prix évoqué sans cadre lisible',
    text: 'Le prix',
    family: 'AMBIGUOUS',
    frame: 'CURRENT',
    escalates: true,
    reason: 'pricing_policy_missing',
  },
  {
    key: 'A2',
    label: 'garantie évoquée sans cadre lisible',
    text: 'Et la garantie',
    family: 'AMBIGUOUS',
    frame: 'CURRENT',
    escalates: true,
    reason: 'guarantee_requested',
  },
  {
    key: 'A3',
    label: 'pourcentage nu',
    text: 'Le pourcentage sur les ventes',
    family: 'AMBIGUOUS',
    frame: 'CURRENT',
    escalates: true,
  },
]);

// ---------------------------------------------------------------------------
// Les mutations
// ---------------------------------------------------------------------------

/**
 * Les déformations qu'un vrai clavier produit, appliquées DÉTERMINISTIQUEMENT.
 *
 * Elles servent à prouver qu'on distingue une grammaire et non un vocabulaire :
 * un lexique taillé sur les exemples se casse dès qu'on retire les accents, et
 * un test qui ne le vérifierait pas laisserait croire l'inverse.
 *
 * Aucune mutation n'a le droit de changer le SENS. « prix » → « tarif » et
 * « pub » → « publicité » sont des synonymes stricts dans ce domaine ; retirer
 * les accents, la ponctuation ou les apostrophes ne change rien du tout. C'est
 * précisément ce qui rend l'attente identique à celle du cas d'origine.
 */
export interface Mutation {
  readonly name: string;
  readonly apply: (text: string) => string;
}

const stripAccents = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');

export const MUTATIONS: readonly Mutation[] = Object.freeze([
  { name: 'identité', apply: (text) => text },
  { name: 'sans accents', apply: stripAccents },
  { name: 'sans apostrophes', apply: (text) => text.replace(/['’]/g, ' ') },
  { name: 'sans ponctuation finale', apply: (text) => text.replace(/\s*[?!.]+\s*$/u, '') },
  { name: 'tout en minuscules', apply: (text) => text.toLowerCase() },
  {
    name: 'apostrophe typographique',
    apply: (text) => text.replace(/'/g, '’'),
  },
  {
    name: 'synonymes de prix',
    apply: (text) =>
      text
        .replace(/(?<![\p{L}])prix(?![\p{L}])/giu, 'tarif')
        .replace(/(?<![\p{L}])tarifs(?![\p{L}])/giu, 'prix'),
  },
  {
    name: 'synonymes de publicité',
    apply: (text) =>
      text
        .replace(/(?<![\p{L}])pubs(?![\p{L}])/giu, 'publicités')
        .replace(/(?<![\p{L}])pub(?![\p{L}])/giu, 'publicité'),
  },
  {
    name: 'espaces multiples',
    apply: (text) => text.replace(/ /g, '  '),
  },
]);

/** Le corpus complet, mutations comprises. Déterministe, donc rejouable. */
export function expandedSemanticCorpus(): readonly (SemanticCase & { readonly mutation: string })[] {
  const out: (SemanticCase & { mutation: string })[] = [];
  for (const base of SEMANTIC_CORPUS) {
    for (const mutation of MUTATIONS) {
      const text = mutation.apply(base.text);
      out.push({ ...base, key: `${base.key}/${mutation.name}`, text, mutation: mutation.name });
    }
  }
  return Object.freeze(out);
}
