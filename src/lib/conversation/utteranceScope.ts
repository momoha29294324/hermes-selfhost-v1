/**
 * HERMES-SEMANTIC-GROUNDING-R1 — QUI demande, et QUAND.
 *
 * ---------------------------------------------------------------------------
 * Le défaut, mesuré et non supposé
 * ---------------------------------------------------------------------------
 * Le 23 août 2026 à 17:33, un prospect a écrit :
 *
 *   « Surtout du prestation standard intérieur, j'avais surtout des gens qui demandaient
 *     le prix puis répondait plus »
 *
 * D2 avait compris (`INFORMATION_SHARED`, 0,99), le brouillon était juste, et
 * la conversation a fini en `HUMAN_ESCALATION:pricing_policy_missing`. Le motif
 * était faux : personne ne nous demandait un prix. Le prospect RACONTAIT que
 * ses propres clients lui en demandaient un, autrefois — ce qui est exactement
 * l'information qu'une prospection cherche à obtenir.
 *
 * Ce n'était pas un défaut de lexique. `readCommercialDemands` a parfaitement
 * reconnu le mot « prix » ; ce qu'elle n'avait aucun moyen de savoir, c'est
 * DANS QUELLE BOUCHE il était. Le dépôt tenait « ce message contient une
 * demande » et « ce message ADRESSE une demande » pour une seule proposition.
 * La première était vraie, la seconde fausse.
 *
 * Ce trou est une CLASSE, pas un cas. Les mêmes phrases coûtent le même faux
 * refus sur la garantie (« mon ancienne agence me garantissait 20 leads »), sur
 * le pourcentage (« mon ancien prestataire prenait 20 % »), sur le
 * remboursement (« si quelqu'un me demandait un remboursement… »), et sur la
 * négation (« je ne te demande pas de garantie »).
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module ajoute, et ce qu'il n'ajoute pas
 * ---------------------------------------------------------------------------
 * Il n'ajoute AUCUN lexique commercial : il ne sait pas ce qu'est un prix, une
 * garantie ou un budget, et il ne contient aucun mot de vente. Il répond à une
 * seule question, de nature grammaticale : **à quel CADRE D'ÉNONCIATION
 * appartient cette portion de phrase ?**
 *
 * Il est délibérément écrit comme du CODE et non comme une consigne de prompt.
 * CLAUDE.md : « toute logique déterministe reste du code testé, jamais un
 * prompt ». Une porte qui décide qu'un tour part sans relecture humaine ne peut
 * pas dépendre de l'humeur d'un modèle — et une matrice de cent paraphrases ne
 * peut être rejouée à chaque `npm run validate` que si elle est gratuite.
 *
 * ---------------------------------------------------------------------------
 * Fail-closed, et le mot a un sens précis ici
 * ---------------------------------------------------------------------------
 * Le cadre par DÉFAUT est `CURRENT`. Une portion de phrase dont on n'arrive à
 * rien dire est traitée comme une demande adressée à nous, donc escalade comme
 * avant ce round. Seule une PREUVE POSITIVE de rapport, de citation, de
 * négation ou d'hypothèse écarte l'escalade — et une preuve de demande
 * courante (deuxième personne au présent, interrogation directe, demande à la
 * première personne) l'emporte sur toutes les autres.
 *
 * Autrement dit : ce module ne peut RETIRER une escalade que sur une preuve, et
 * ne peut jamais en retirer une sur un doute. Si on le supprimait, le
 * comportement retomberait mot pour mot sur celui d'avant.
 */

import { normalizeForMatching } from '@/lib/conversation/text';

// ---------------------------------------------------------------------------
// Le vocabulaire
// ---------------------------------------------------------------------------

/**
 * Le cadre d'énonciation d'une portion de message.
 *
 * Cinq membres, dont un seul autorise une escalade commerciale. Les quatre
 * autres décrivent des façons de PARLER d'une demande sans la formuler.
 */
export type UtteranceFrame =
  /** La personne demande, maintenant, à nous. Le défaut, et le seul qui engage. */
  | 'CURRENT'
  /** Elle rapporte ce que quelqu'un d'autre a demandé, ou ce qui se passait avant. */
  | 'REPORTED'
  /** Elle cite des mots entre guillemets. */
  | 'QUOTED'
  /** Elle dit qu'elle ne demande PAS cela. */
  | 'NEGATED'
  /** Elle envisage un cas de figure (« si… », « au cas où… »). */
  | 'HYPOTHETICAL';

/**
 * Les indices grammaticaux relevés, nommés.
 *
 * Ce sont EUX qui partent dans les rapports et dans les tests, jamais un
 * extrait du message : un motif nommé se discute, un bout de phrase recopié
 * dans un journal est une fuite de contenu de plus.
 */
export type ScopeMarker =
  | 'SECOND_PERSON'
  | 'INTERROGATIVE'
  | 'FIRST_PERSON_REQUEST'
  | 'IMPERATIVE_REQUEST'
  | 'PAST_TENSE'
  | 'PAST_TIME_REFERENCE'
  | 'THIRD_PARTY_SUBJECT'
  | 'REPORTED_SPEECH'
  | 'FORMER_PROVIDER'
  | 'NEGATION'
  | 'CONDITIONAL'
  | 'QUOTATION'
  /**
   * HERMES-MULTI-TURN-BURSTS-R1 — cette portion CONTINUE la précédente.
   *
   * Elle ne porte aucun indice à elle : ni deuxième personne, ni interrogation,
   * ni demande, ni temps du passé, ni tiers. C'est un groupe nominal nu — « le
   * prix » — qui n'a de sens que collé à ce qui le précède.
   */
  | 'CONTINUATION';

export interface ScopedClause {
  /** Le texte normalisé de la portion. Jamais rendu dans un journal. */
  readonly text: string;
  /** Bornes dans le texte NORMALISÉ, pour situer un motif reconnu ailleurs. */
  readonly start: number;
  readonly end: number;
  readonly frame: UtteranceFrame;
  readonly markers: readonly ScopeMarker[];
}

export interface QuotedSpan {
  readonly start: number;
  readonly end: number;
}

export interface UtteranceScope {
  /** Le texte tel que les lexiques du dépôt le lisent (`normalizeForMatching`). */
  readonly normalized: string;
  readonly clauses: readonly ScopedClause[];
  /** Les portions entre guillemets, en bornes du texte normalisé. */
  readonly quoted: readonly QuotedSpan[];
  /** Au moins une portion de ce message ADRESSE quelque chose. */
  readonly hasCurrentClause: boolean;
}

// ---------------------------------------------------------------------------
// Les bornes de mot, en Unicode
// ---------------------------------------------------------------------------

/**
 * `\b` de JavaScript ne connaît que `[A-Za-z0-9_]` : devant « à l'époque » ou
 * « été », il exige une frontière entre une espace et une lettre accentuée, ce
 * qui n'existe pas. Le dépôt raconte déjà ce défaut dans `commercialPolicy.ts`
 * et dans `signals.ts` ; la correction est la même, et elle est un sur-ensemble
 * strict du comportement correct sur un mot ASCII.
 */
const WORD_START = '(?<![\\p{L}\\p{N}_])';
const WORD_END = '(?![\\p{L}\\p{N}_])';

function marker(alternatives: string): RegExp {
  return new RegExp(`${WORD_START}(?:${alternatives})${WORD_END}`, 'iu');
}

/** Comme `marker`, mais sans borne de fin : l'alternative porte son propre suffixe. */
function markerOpenEnd(alternatives: string): RegExp {
  return new RegExp(`${WORD_START}(?:${alternatives})`, 'iu');
}

// ---------------------------------------------------------------------------
// L'élision, écrite une fois
// ---------------------------------------------------------------------------

/**
 * Une apostrophe, ou l'espace qui la remplace quand un clavier l'a mangée.
 *
 * Mesuré, pas supposé : le corpus de mutations écrit « j ai », « c est »,
 * « m a » et « l an dernier », qui sont des formes réellement produites sur
 * mobile. Sans cette tolérance, `PAST_COMPOUND` et `REPORTED_SPEECH` cessaient
 * de reconnaître un passé composé dès qu'une apostrophe manquait — et le cadre
 * retombait sur `CURRENT`, c'est-à-dire sur une escalade de trop.
 */
const AP = "['\\s]";

// ---------------------------------------------------------------------------
// Les indices de DEMANDE COURANTE — ils l'emportent sur tout le reste
// ---------------------------------------------------------------------------

/**
 * La deuxième personne SUJET : « tu », « vous ».
 *
 * Séparée des autres formes parce qu'elle seule décide de la PORTÉE d'une
 * négation. « Je ne te demande pas de garantie » et « Tu ne garantis pas de
 * résultat ? » portent la même négation et le même « garantie ». Ce qui les
 * distingue est le sujet du verbe nié : dans le premier, c'est la personne qui
 * écrit — elle renonce à demander ; dans le second, c'est NOUS — elle nous
 * interroge sur ce que nous offrons.
 */
const SECOND_PERSON_SUBJECT = marker("tu|vous|t'as|t'es");

/**
 * La deuxième personne, toutes formes — pronoms et possessifs.
 *
 * Les possessifs comptent, et ce n'est pas évident : « ton tarif », « vos
 * frais », « tes conditions » désignent CE QUE NOUS proposons, puisque c'est un
 * prospect qui écrit. Un prospect ne dit jamais « tes clients » de ses propres
 * clients ; il dit « mes clients ».
 */
const SECOND_PERSON = marker("tu|vous|toi|te|t'as|t'es|ton|ta|tes|votre|vos");

/**
 * L'interrogation.
 *
 * Le point d'interrogation est traité à part (il porte sur la PHRASE, pas sur
 * la portion) ; ici on ne reconnaît que les mots interrogatifs, qui sont
 * locaux à leur proposition.
 */
const INTERROGATIVE_WORD = new RegExp(
  `${WORD_START}(?:combien|quel|quels|quelle|quelles|comment|pourquoi|` +
    `est[- ]ce${AP}?que|est[- ]ce|qu${AP}est[- ]ce|c${AP}est\\s+quoi|` +
    `quand\\s+est[- ]ce)${WORD_END}`,
  'iu',
);

/**
 * Une demande formulée à la première personne.
 *
 * Bornée aux DEUX bouts, et c'est le point : sans borne de fin, « je demande »
 * matcherait dans « je demandais toujours un acompte », c'est-à-dire dans un
 * récit. Le conditionnel de politesse (« j'aimerais », « je voudrais ») est ici
 * un indice de DEMANDE et surtout pas d'hypothèse — c'est la raison pour
 * laquelle `CONDITIONAL` exige « si » et ne se contente jamais d'une
 * terminaison verbale.
 *
 * L'imparfait de politesse (« je voulais savoir ») est ici aussi, et il n'est
 * PAS neutralisé par le passé : c'est la formulation la plus banale d'une
 * demande polie en français, et la lire comme un récit serait le faux négatif
 * le plus coûteux que ce module puisse produire.
 */
const FIRST_PERSON_REQUEST = new RegExp(
  `${WORD_START}(?:j${AP}aimerais|j${AP}aimerai|j${AP}aurais\\s+(?:aim[ée]|voulu)|` +
    `je\\s+voudrais|je\\s+souhaite|je\\s+souhaitais|je\\s+veux|je\\s+cherche|` +
    `je\\s+me\\s+demande|je\\s+me\\s+demandais|je\\s+demande|` +
    `je\\s+voulais|je\\s+voulais\\s+savoir|je\\s+veux\\s+savoir|` +
    `j${AP}ai\\s+besoin|il\\s+me\\s+faut|j${AP}allais\\s+(?:te|vous)\\s+demander)${WORD_END}`,
  'iu',
);

/** « Dis-moi », « donne-moi », « explique-moi », « peux-tu ». */
const IMPERATIVE_REQUEST = marker(
  "dis[- ]moi|dites[- ]moi|donne[- ]moi|donnez[- ]moi|explique[- ]moi|expliquez[- ]moi|" +
    "envoie[- ]moi|envoyez[- ]moi|peux[- ]tu|pouvez[- ]vous|pourrais[- ]tu|pourriez[- ]vous",
);

// ---------------------------------------------------------------------------
// Les indices de RAPPORT
// ---------------------------------------------------------------------------

/**
 * L'IMPARFAIT, reconnu par sa morphologie — mais bordé des deux côtés.
 *
 * Une détection naïve (« tout mot en -ait ») attrape « fait », « parfait »,
 * « souhait », « sait », et une détection en -ais attrape « mais », « jamais »,
 * « frais », « français ». Le défaut serait celui que ce module existe pour
 * corriger, à l'envers : un mot pris pour une grammaire.
 *
 * Deux bornes le tiennent, et elles sont de nature différente :
 *
 *   1. **une liste de non-verbes** — les noms et adjectifs qui portent ces
 *      terminaisons sont peu nombreux et se listent ;
 *   2. **les terminaisons du CONDITIONNEL** — `-erait`, `-irait`, `-drait`,
 *      `-urait`, `-rrait` et leurs variantes. « Ça serait combien ? » est une
 *      demande de prix parfaitement actuelle, et la lire comme un récit
 *      neutraliserait l'interrogation. C'est le faux négatif dangereux, donc
 *      celui qu'on ferme en premier.
 *
 * La comparaison se fait sans accents : « opérait » et « operait » sont le même
 * mot pour un clavier pressé.
 */
const IMPARFAIT_SHAPE = /(?<![\p{L}\p{N}_])(\p{L}{4,}?(?:ais|ait|aient))(?![\p{L}\p{N}_])/giu;

/** Les terminaisons qui appartiennent au CONDITIONNEL, jamais à l'imparfait. */
const CONDITIONAL_ENDING = /(?:erais?|eraient|irais?|iraient|rrais?|rraient|drais?|draient|urais?|uraient)$/u;

/** Les noms et adjectifs qui portent une terminaison d'imparfait sans en être. */
const NOT_A_VERB: ReadonlySet<string> = new Set([
  'mais', 'jamais', 'desormais', 'francais', 'anglais', 'frais', 'vrais', 'epais',
  'essais', 'delais', 'relais', 'balais', 'biais', 'palais', 'marais', 'quais',
  'niais', 'sais', 'fais', 'vais', 'dais', 'lais',
  'fait', 'faits', 'refait', 'defait', 'bienfait', 'contrefait', 'satisfait',
  'insatisfait', 'parfait', 'imparfait', 'forfait', 'souhait', 'souhaits', 'lait',
  'plait', 'trait', 'traits', 'extrait', 'extraits', 'portrait', 'retrait',
  'attrait', 'distrait', 'abstrait', 'surfait', 'sait', 'parait', 'connait',
  'disparait', 'apparait', 'reconnait', 'nait', 'accroit', 'jamait',
]);

function withoutAccents(word: string): string {
  return word.normalize('NFD').replace(/[̀-ͯ]/gu, '').toLowerCase();
}

/** Le texte porte-t-il au moins un verbe à l'imparfait ? */
function hasImparfait(text: string): boolean {
  IMPARFAIT_SHAPE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPARFAIT_SHAPE.exec(text)) !== null) {
    const word = withoutAccents(match[1] ?? '');
    if (word.length === 0) continue;
    if (NOT_A_VERB.has(word)) continue;
    if (CONDITIONAL_ENDING.test(word)) continue;
    return true;
  }
  return false;
}

/**
 * Les formes passées ÉNUMÉRÉES, en plus de la morphologie.
 *
 * Elles couvrent ce que `hasImparfait` ne peut pas voir : les participes et les
 * formes irrégulières. Une forme absente coûte au pire une escalade de trop —
 * c'est-à-dire le comportement d'avant ce round.
 */
const PAST_TENSE = marker(
  'avait|avaient|avais|[ée]tait|[ée]taient|[ée]tais|' +
    'demandait|demandaient|demandais|r[ée]clamait|r[ée]clamaient|' +
    'disait|disaient|disais|posait|posaient|r[ée]pondait|r[ée]pondaient|' +
    'garantissait|garantissaient|promettait|promettaient|' +
    'faisait|faisaient|faisais',
);

/**
 * Le passé composé, reconnu par son AUXILIAIRE à la première ou à la troisième
 * personne, jamais à la deuxième.
 *
 * « Tu as fait quoi ? » est une question sur NOTRE passé : c'est une demande
 * courante, et la traiter comme un rapport la ferait passer sous le radar. La
 * deuxième personne est donc absente de cette liste, délibérément.
 */
const PAST_COMPOUND = new RegExp(
  `${WORD_START}(?:j${AP}ai|on\\s+a|il\\s+a|elle\\s+a|ils\\s+ont|elles\\s+ont|nous\\s+avons|` +
    `on\\s+m${AP}a|ils\\s+m${AP}ont|il\\s+m${AP}a|elle\\s+m${AP}a)` +
    // Au plus deux mots entre l'auxiliaire et le participe (« j'ai déjà essayé »).
    `(?:\\s+[\\p{L}'-]+){0,2}\\s+` +
    // Une liste de participes, ÉNUMÉRÉE pour la même raison que NOT_A_VERB : une
    // terminaison en -i attraperait « souci », « merci », « ici ».
    '(?:essay[ée]|test[ée]|demand[ée]|dit|fait|pris|mis|eu|pay[ée]|d[ée]pens[ée]|' +
    'utilis[ée]|travaill[ée]|boss[ée]|lanc[ée]|arr[êe]t[ée]|march[ée]|fonctionn[ée]|' +
    'propos[ée]|garanti|promis|factur[ée]|vendu|achet[ée]|r[ée]pondu|appel[ée]|' +
    '[ée]crit|re[çc]u|vu|parl[ée]|pass[ée]|contact[ée]|essaye|teste|rembours[ée])' +
    `(?:e?s?)${WORD_END}`,
  'iu',
);

/**
 * Ce qui situe explicitement dans le passé.
 *
 * « avant » y figure, mais PAS « avant de » ni « avant que » : ceux-là ouvrent
 * une proposition tournée vers la suite. Mesuré, pas supposé — « j'aimerais
 * connaître le tarif avant d'aller plus loin » est une demande de prix, et le
 * « avant » nu la faisait lire comme un souvenir.
 */
const PAST_TIME_REFERENCE = new RegExp(
  `${WORD_START}(?:avant(?!\\s*(?:de|d${AP}|que|qu${AP}|tout|toute)(?![\\p{L}]))(?![\\p{L}])|` +
    `auparavant|autrefois|` +
    `[àa]\\s+l${AP}[ée]poque|par\\s+le\\s+pass[ée]|` +
    `il\\s+y\\s+a\\s+\\d+\\s*(?:ans?|mois|semaines?|jours?)|` +
    `l${AP}an\\s+dernier|l${AP}ann[ée]e\\s+derni[èe]re|le\\s+mois\\s+dernier|` +
    `la\\s+derni[èe]re\\s+fois|[àa]\\s+une\\s+[ée]poque)`,
  'iu',
);

/** Un prestataire, une agence ou un outil ANTÉRIEUR. */
const FORMER_PROVIDER = new RegExp(
  `${WORD_START}(?:mon|ma|mes|ton|ta|tes|votre|vos|l${AP}|le|la|les|un|une|des)\\s*` +
    `(?:ancien|ancienne|anciens|anciennes|` +
    `pr[ée]c[ée]dent|pr[ée]c[ée]dente|dernier|derni[èe]re|ex)[\\p{L}-]*` +
    `|(?:mon|ma|mes)\\s+ex(?![\\p{L}])`,
  'iu',
);

/**
 * Un sujet qui n'est ni nous, ni la personne qui écrit.
 *
 * C'est le pivot du cas réel : « des gens qui demandaient le prix ». Le sujet
 * n'est pas le prospect, et il n'est surtout pas nous.
 *
 * « on » n'y figure PAS, et c'est une décision : « on peut se parler ? » est une
 * demande on ne peut plus actuelle. Les tournures impersonnelles qui rapportent
 * vraiment (« on me demande », « on m'a dit ») sont couvertes par
 * `REPORTED_SPEECH`, qui les reconnaît à leur objet à la première personne.
 */
const THIRD_PARTY_SUBJECT = markerOpenEnd(
  "(?:mes|les|des|ces|certains|beaucoup\\s+de|plein\\s+de|pas\\s+mal\\s+de)\\s+" +
    "(?:anciens?\\s+|nouveaux?\\s+|vieux\\s+|premiers?\\s+)?" +
    "(?:clients?|prospects?|leads?|contacts?|gens|personnes?|acheteurs?|curieux|" +
    "particuliers?|pros?|professionnels?|entreprises?|bo[îi]tes?|concurrents?|" +
    "coll[èe]gues|confr[èe]res?|agences?|prestataires?|fournisseurs?)" +
    "|(?:ils|elles)(?![\\p{L}])" +
    "|quelqu'un|quelqu\\s+un|personne(?![\\p{L}])|un\\s+gars|un\\s+mec|un\\s+type|" +
    "un\\s+confr[èe]re|le\\s+gars|le\\s+mec|" +
    "mon\\s+(?:agence|prestataire|fournisseur|freelance|community\\s+manager|associ[ée])",
);

/**
 * Le discours rapporté, reconnu par son OBJET à la première personne.
 *
 * « Ils me demandent », « on m'a demandé », « les gens me demandaient » : le
 * clitique « me » / « m' » / « nous » devant un verbe de parole dit que la
 * demande visait la personne qui écrit, pas nous. C'est vrai à tous les temps,
 * ce qui est exactement ce qu'il faut : « on me demande souvent le prix » est
 * un fait sur leur activité, pas une question posée à Hermes.
 */
const REPORTED_SPEECH = new RegExp(
  `${WORD_START}(?:(?:me|m${AP}|nous)\\s*(?:a|ont|avait|avaient)?\\s*` +
    `(?:demand|r[ée]clam|dis|dit|disai|pos|questionn|parl|r[ée]pond|[ée]cri|garanti|promis|promett)` +
    `|on\\s+(?:me|m${AP})\\s*(?:a\\s+)?(?:demand|dit|r[ée]clam|garanti)` +
    `|(?:qui|que)\\s+(?:me|m${AP}|nous)\\s*(?:demand|r[ée]clam|dis)` +
    // « les gens veulent toujours savoir combien ça coûte » — une question, mais
    // pas la leur : elle est posée à EUX, et le verbe le dit.
    `|(?:veulent|voulaient|veut|voulait|cherchent|cherchaient|aiment|adorent|` +
    `demandent|r[ée]clament)\\s+(?:[\\p{L}'-]+\\s+){0,2}?` +
    `(?:savoir|conna[îi]tre|combien|le\\s+prix|les\\s+prix|un\\s+prix|le\\s+tarif))`,
  'iu',
);

// ---------------------------------------------------------------------------
// Négation et hypothèse
// ---------------------------------------------------------------------------

/** La particule « ne » / « n' », et la négation orale qui s'en passe. */
const NEGATION = new RegExp(
  `${WORD_START}(?:n${AP}|ne(?![\\p{L}]))[^.!?]{0,30}?${WORD_START}(?:pas|plus|jamais|aucune?|rien)${WORD_END}` +
    // « je te demande pas LE prix » — sans « ne », comme on parle.
    `|${WORD_START}(?:pas|plus|jamais)\\s+(?:de(?![\\p{L}])|d${AP}|le(?![\\p{L}])|la(?![\\p{L}])|` +
    `les(?![\\p{L}])|l${AP}|un(?![\\p{L}])|une(?![\\p{L}])|encore(?![\\p{L}])|` +
    `ton(?![\\p{L}])|ta(?![\\p{L}])|tes(?![\\p{L}])|votre(?![\\p{L}])|vos(?![\\p{L}])|` +
    `ce(?![\\p{L}])|cette(?![\\p{L}])|ces(?![\\p{L}]))` +
    `|${WORD_START}aucune?${WORD_END}`,
  'iu',
);

/**
 * L'hypothèse exige « si » ou une formule d'hypothèse EXPLICITE.
 *
 * Une terminaison en -rais / -rait ne suffit surtout pas : « j'aimerais
 * connaître vos tarifs » est une demande de prix parfaitement réelle, et la
 * lire comme une hypothèse serait le faux NÉGATIF le plus dangereux que ce
 * module pourrait produire — l'inverse exact du défaut qu'il corrige.
 */
const CONDITIONAL = new RegExp(
  `${WORD_START}(?:si(?![\\p{L}])|au\\s+cas\\s+o[ùu]|` +
    `imagine|imaginons|supposons|admettons|mettons\\s+que|` +
    `dans\\s+l${AP}hypoth[èe]se|[àa]\\s+supposer)`,
  'iu',
);

// ---------------------------------------------------------------------------
// Le découpage
// ---------------------------------------------------------------------------

/** Ce qui termine une PHRASE. Le terminateur reste avec la portion de gauche. */
const SENTENCE_TERMINATORS = new Set(['.', '!', '?', '…', ';', '\n', '\r']);

/**
 * Les connecteurs qui ouvrent une nouvelle PROPOSITION.
 *
 * Le connecteur part avec la proposition qu'il introduit : « si » doit se
 * trouver dans la portion hypothétique, « qui » dans la relative. Sans cela,
 * « si quelqu'un me demandait un remboursement » perdrait son « si » et le
 * cadre serait faux.
 *
 * Volontairement large — un découpage trop fin ne coûte rien ici : chaque
 * portion est jugée sur ses propres indices, et une portion sans indice retombe
 * sur `CURRENT`, c'est-à-dire sur le comportement d'avant ce round.
 */
const CLAUSE_CONNECTORS: readonly string[] = Object.freeze([
  'parce que',
  'alors que',
  'tandis que',
  'sauf que',
  'par contre',
  'mais',
  'puis',
  'ensuite',
  'donc',
  'car',
  'puisque',
  'lorsque',
  'quand',
  'si',
  'qui',
  'que',
  "qu'",
  'dont',
  'où',
  'et',
  'ou',
]);

const CONNECTOR_PATTERN = new RegExp(
  `${WORD_START}(?:${CLAUSE_CONNECTORS.map((word) => word.replace(/'/g, "'")).join('|')})${WORD_END}`,
  'giu',
);

interface RawSegment {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** La phrase à laquelle cette portion appartient. */
  readonly sentence: number;
  /** Cette portion est-elle la DERNIÈRE de sa phrase ? */
  readonly sentenceFinal: boolean;
  /** La phrase se termine-t-elle par un point d'interrogation ? */
  readonly sentenceIsQuestion: boolean;
}

/** Découpe en phrases, en conservant les bornes dans le texte normalisé. */
function splitSentences(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char !== undefined && SENTENCE_TERMINATORS.has(char)) {
      // Absorbe une suite de terminateurs (« ?! », « ... »).
      let end = i + 1;
      while (end < text.length && SENTENCE_TERMINATORS.has(text[end] ?? '')) end += 1;
      if (end > start) out.push({ start, end });
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) out.push({ start, end: text.length });
  return out.filter((span) => text.slice(span.start, span.end).trim().length > 0);
}

/** Découpe une phrase en propositions, sur les virgules et les connecteurs. */
function splitClauses(text: string, from: number, to: number): { start: number; end: number }[] {
  const boundaries = new Set<number>([from]);

  for (let i = from; i < to; i += 1) {
    const char = text[i];
    if (char === ',' || char === ':' || char === '(' || char === ')') boundaries.add(i + 1);
  }

  const slice = text.slice(from, to);
  CONNECTOR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CONNECTOR_PATTERN.exec(slice)) !== null) {
    const at = from + match.index;
    if (at > from) boundaries.add(at);
    if (match.index === CONNECTOR_PATTERN.lastIndex) CONNECTOR_PATTERN.lastIndex += 1;
  }

  const sorted = [...boundaries].sort((a, b) => a - b);
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const start = sorted[i] ?? from;
    const end = sorted[i + 1] ?? to;
    if (end > start && text.slice(start, end).trim().length > 0) spans.push({ start, end });
  }
  return spans.length > 0 ? spans : [{ start: from, end: to }];
}

/**
 * Cette portion se termine-t-elle sur une frontière SOUPLE ?
 *
 * Souple = un saut de ligne, c'est-à-dire une bulle qui s'arrête sans que la
 * personne ait fermé sa phrase. Un point, un point d'interrogation, un point
 * d'exclamation, un point-virgule ou une virgule sont des frontières DURES :
 * elles closent ce qui précède, et ce qui suit ouvre autre chose.
 */
function endsOnSoftBoundary(clauseText: string): boolean {
  const trimmed = clauseText.replace(/[ \t]+$/u, '');
  return trimmed.endsWith('\n') || trimmed.endsWith('\r');
}

function segment(text: string): RawSegment[] {
  const out: RawSegment[] = [];
  const sentences = splitSentences(text);
  sentences.forEach((sentence, index) => {
    const body = text.slice(sentence.start, sentence.end);
    const isQuestion = /\?/.test(body);
    const clauses = splitClauses(text, sentence.start, sentence.end);
    clauses.forEach((clause, position) => {
      out.push({
        text: text.slice(clause.start, clause.end),
        start: clause.start,
        end: clause.end,
        sentence: index,
        sentenceFinal: position === clauses.length - 1,
        sentenceIsQuestion: isQuestion,
      });
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Les guillemets
// ---------------------------------------------------------------------------

/**
 * Les portions du texte qui sont des CITATIONS.
 *
 * Deux conditions, et il en faut une seule : soit un verbe de parole précède le
 * guillemet ouvrant dans la même phrase, soit la citation porte au moins quatre
 * mots. Sans cela, « ton "tarif" » — des guillemets d'insistance autour d'un
 * seul mot — ferait passer une vraie question pour une citation, et c'est le
 * faux négatif qu'on ne veut pas.
 */
const QUOTE_INTRODUCER = /(?:dit|disait|écrit|ecrit|écrivait|ecrivait|demandé|demande|demandait|répondu|repondu|message|texto|sms)\s*[:,]?\s*$/iu;

function quotedSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const pairs: readonly (readonly [string, string])[] = [
    ['«', '»'],
    ['"', '"'],
  ];
  for (const [open, close] of pairs) {
    let cursor = 0;
    for (;;) {
      const start = text.indexOf(open, cursor);
      if (start < 0) break;
      const end = text.indexOf(close, start + 1);
      if (end < 0) break;
      const inner = text.slice(start + 1, end);
      const before = text.slice(Math.max(0, start - 40), start);
      const words = inner.trim().split(/\s+/u).filter((word) => word.length > 0).length;
      if (words >= 4 || QUOTE_INTRODUCER.test(before)) {
        spans.push({ start, end: end + 1 });
      }
      cursor = end + 1;
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Le jugement
// ---------------------------------------------------------------------------

function frameOfSegment(
  raw: RawSegment,
  quoted: readonly { start: number; end: number }[],
): { frame: UtteranceFrame; markers: ScopeMarker[] } {
  const body = raw.text;
  const markers: ScopeMarker[] = [];

  const middle = Math.floor((raw.start + raw.end) / 2);
  const inQuote = quoted.some((span) => middle >= span.start && middle < span.end);
  if (inQuote) markers.push('QUOTATION');

  // --- les indices de rapport ---------------------------------------------
  const past = hasImparfait(body) || PAST_TENSE.test(body) || PAST_COMPOUND.test(body);
  if (past) markers.push('PAST_TENSE');
  if (PAST_TIME_REFERENCE.test(body)) markers.push('PAST_TIME_REFERENCE');
  if (FORMER_PROVIDER.test(body)) markers.push('FORMER_PROVIDER');
  if (THIRD_PARTY_SUBJECT.test(body)) markers.push('THIRD_PARTY_SUBJECT');
  if (REPORTED_SPEECH.test(body)) markers.push('REPORTED_SPEECH');

  const reported =
    markers.includes('REPORTED_SPEECH') ||
    markers.includes('FORMER_PROVIDER') ||
    markers.includes('PAST_TIME_REFERENCE') ||
    markers.includes('THIRD_PARTY_SUBJECT') ||
    past;

  // --- les indices de demande courante -------------------------------------
  const secondSubject = SECOND_PERSON_SUBJECT.test(body);
  if (SECOND_PERSON.test(body)) markers.push('SECOND_PERSON');
  if (FIRST_PERSON_REQUEST.test(body)) markers.push('FIRST_PERSON_REQUEST');
  if (IMPERATIVE_REQUEST.test(body)) markers.push('IMPERATIVE_REQUEST');

  // --- la négation, et sa PORTÉE -------------------------------------------
  //
  // « Je ne te demande pas de garantie » renonce à demander ; « Tu ne garantis
  // pas de résultat ? » interroge. La négation ne referme donc une demande que
  // lorsque le sujet du verbe nié n'est PAS nous : dès qu'un « tu » ou un
  // « vous » sujet est là, la phrase parle de ce que nous offrons, et le côté
  // sûr est de la lire comme une demande.
  const negation = NEGATION.test(body);
  if (negation) markers.push('NEGATION');
  const negatedRequest = negation && !secondSubject;

  const addressedToUs =
    markers.includes('SECOND_PERSON') ||
    markers.includes('FIRST_PERSON_REQUEST') ||
    markers.includes('IMPERATIVE_REQUEST');

  // Le passé et le discours rapporté NEUTRALISENT l'interrogation : « les
  // clients me demandaient combien ça coûtait » porte « combien » sans poser la
  // moindre question à Hermes. Un sujet TIERS fait de même, sauf si l'on nous
  // parle en même temps — « ils facturent combien chez vous ? » nous vise, et
  // le « vous » le dit.
  const reportContext =
    markers.includes('REPORTED_SPEECH') ||
    past ||
    (markers.includes('THIRD_PARTY_SUBJECT') && !addressedToUs);

  const interrogative =
    (INTERROGATIVE_WORD.test(body) || (raw.sentenceIsQuestion && raw.sentenceFinal)) &&
    !reportContext;
  if (interrogative) markers.push('INTERROGATIVE');

  const current =
    interrogative ||
    markers.includes('IMPERATIVE_REQUEST') ||
    ((markers.includes('SECOND_PERSON') || markers.includes('FIRST_PERSON_REQUEST')) &&
      !negatedRequest);

  const conditional = CONDITIONAL.test(body);
  if (conditional) markers.push('CONDITIONAL');

  // --- l'ordre EST la politique --------------------------------------------
  //
  // La citation d'abord : « un client m'a écrit "c'est combien ?" » porte une
  // interrogation qui n'est pas la sienne.
  //
  // La demande courante ensuite, et avant tout le reste : c'est elle qui rend
  // ce module incapable de manquer une vraie question. Les trois cadres qui
  // suivent ne peuvent s'appliquer qu'à une portion où PERSONNE ne demande
  // rien à personne, ce qui est exactement la condition d'un rapport.
  if (markers.includes('QUOTATION')) return { frame: 'QUOTED', markers };
  if (current) return { frame: 'CURRENT', markers };
  if (conditional) return { frame: 'HYPOTHETICAL', markers };
  if (negatedRequest) return { frame: 'NEGATED', markers };
  if (reported) return { frame: 'REPORTED', markers };
  return { frame: 'CURRENT', markers };
}

/**
 * Lit le cadre d'énonciation de chaque portion d'un message.
 *
 * Fonction PURE. Elle ne reçoit qu'un texte : ni prospect, ni coquille, ni
 * cadence, ni configuration. Il n'existe donc aucune donnée depuis laquelle une
 * exception pourrait être écrite, et un test lit cette source pour le
 * confirmer.
 */
export function scopeUtterance(text: string): UtteranceScope {
  const normalized = normalizeForMatching(text);
  const quoted = quotedSpans(normalized);
  const judged = segment(normalized).map((raw) => {
    const verdict = frameOfSegment(raw, quoted);
    return {
      text: raw.text,
      start: raw.start,
      end: raw.end,
      frame: verdict.frame,
      markers: [...verdict.markers] as ScopeMarker[],
    };
  });

  // -------------------------------------------------------------------------
  // HERMES-MULTI-TURN-BURSTS-R1 — la CONTINUATION par-dessus un saut de ligne
  // -------------------------------------------------------------------------
  //
  // Le défaut, mesuré : « ils demandaient le prix puis répondaient plus » écrit
  // d'un trait se lit REPORTED et n'escalade pas — c'est ce que R12 a corrigé.
  // La MÊME phrase écrite en trois bulles escaladait en `EXACT_PRICE [CURRENT]`,
  // parce que `\n` est un terminateur de phrase : « le prix » devenait une
  // portion autonome, sans sujet ni verbe, et une portion sans indice vaut
  // CURRENT par défaut.
  //
  // Ce n'est pas né avec les salves — un prospect qui écrit un DM sur deux
  // lignes le déclenchait déjà. Mais agréger les bulles fait passer ce cas de
  // « rare » à « chaque prise de parole en plusieurs bulles », donc il devient
  // la règle plutôt que l'exception, et il doit être fermé ici.
  //
  // La règle est étroite, et chacune de ses trois conditions retire un risque :
  //
  //   1. la portion ne porte AUCUN indice. Toute preuve de parole courante —
  //      deuxième personne, interrogation, demande à la première personne,
  //      impératif — produit un marqueur, donc une portion sans marqueur n'a
  //      littéralement rien qui la rattache au présent. « ça coûte combien ? »
  //      porte INTERROGATIVE et n'est donc JAMAIS une continuation ;
  //
  //   2. la frontière est SOUPLE — un saut de ligne, jamais un point, un point
  //      d'interrogation ou une virgule. Une bulle qui suit une phrase
  //      terminée ouvre autre chose ; une bulle qui suit un saut de ligne
  //      poursuit ;
  //
  //   3. la portion précédente n'est pas déjà CURRENT. Hériter de CURRENT ne
  //      changerait rien, et le dire ainsi rend visible que cette passe ne peut
  //      QU'écarter une escalade née d'un défaut de découpage — jamais en
  //      fabriquer une.
  //
  // Le sens ne bouge donc que dans un cas : un groupe nominal nu qui suit une
  // portion rapportée, citée, niée ou hypothétique. Il en hérite, ce qui est ce
  // qu'un lecteur humain fait sans y penser.
  for (let index = 1; index < judged.length; index += 1) {
    const clause = judged[index];
    const previous = judged[index - 1];
    if (clause === undefined || previous === undefined) continue;
    if (clause.markers.length > 0) continue;
    if (previous.frame === 'CURRENT') continue;
    if (!endsOnSoftBoundary(previous.text)) continue;
    clause.frame = previous.frame;
    clause.markers = ['CONTINUATION'];
  }

  const clauses = judged.map((clause) =>
    Object.freeze({
      text: clause.text,
      start: clause.start,
      end: clause.end,
      frame: clause.frame,
      markers: Object.freeze([...clause.markers]),
    }),
  );

  return Object.freeze({
    normalized,
    clauses: Object.freeze(clauses),
    quoted: Object.freeze(quoted.map((span) => Object.freeze({ start: span.start, end: span.end }))),
    hasCurrentClause: clauses.some((clause) => clause.frame === 'CURRENT'),
  });
}

/**
 * Le cadre de la portion qui contient l'indice `index` du texte normalisé.
 *
 * Fail-closed : un index hors de toute portion rend `CURRENT`, c'est-à-dire le
 * comportement d'avant ce round.
 */
export function frameAt(scope: UtteranceScope, index: number): UtteranceFrame {
  // La citation se lit à l'INDICE et passe devant la proposition : le découpage
  // en phrases coupe « … « c'est combien ? » » en deux, si bien qu'une portion
  // entière n'est presque jamais contenue dans les guillemets alors que le mot
  // reconnu, lui, l'est.
  for (const span of scope.quoted) {
    if (index >= span.start && index < span.end) return 'QUOTED';
  }
  for (const clause of scope.clauses) {
    if (index >= clause.start && index < clause.end) return clause.frame;
  }
  return 'CURRENT';
}

/**
 * Le cadre du PREMIER endroit où `pattern` matche, ou `null` s'il ne matche pas.
 *
 * Le motif est appliqué au texte NORMALISÉ, celui-là même que les lexiques du
 * dépôt lisent : les indices se correspondent donc exactement, sans qu'aucun
 * décalage n'ait à être calculé.
 *
 * Quand un motif matche à PLUSIEURS endroits, le cadre retenu est le plus
 * engageant — `CURRENT` dès qu'une occurrence est courante. « Mes clients
 * demandaient le prix, et toi tu factures combien ? » demande bel et bien un
 * prix.
 */
export function frameOfPattern(scope: UtteranceScope, pattern: RegExp): UtteranceFrame | null {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let match: RegExpExecArray | null;
  let best: UtteranceFrame | null = null;
  while ((match = global.exec(scope.normalized)) !== null) {
    const frame = frameAt(scope, match.index);
    if (frame === 'CURRENT') return 'CURRENT';
    if (best === null) best = frame;
    if (match.index === global.lastIndex) global.lastIndex += 1;
  }
  return best;
}

/** Un cadre autorise-t-il une demande commerciale à ENGAGER quelque chose ? */
export function frameEngages(frame: UtteranceFrame): boolean {
  return frame === 'CURRENT';
}
