/**
 * CONVERSATION-R1.1 — écrire la prochaine phrase, pas « un bon message ».
 *
 * Ce fichier est la traduction en code d'un constat simple : un modèle à qui on
 * demande une réponse commerciale en écrit une, et une réponse commerciale ne
 * ressemble pas à ce qu'une personne envoie en DM. Elle remercie d'abord, elle
 * empile une question, un argument, une preuve et une proposition d'appel, et
 * elle fait quatre lignes là où huit mots suffisaient. Chacun de ces défauts est
 * MESURABLE, et c'est pour cela qu'ils sont ici plutôt que dans un prompt : une
 * consigne de style se respecte en moyenne, une règle se vérifie.
 *
 * Trois propriétés tiennent le fichier :
 *
 *   1. **Déterministe.** Aucun modèle n'intervient. CLAUDE.md l'impose pour
 *      toute logique décidable, et c'est aussi la seule façon d'écrire les
 *      tests de §27 : « la réponse est-elle naturelle » n'est pas testable,
 *      « la réponse fait-elle plus de deux phrases quand ils en ont écrit une »
 *      l'est.
 *
 *   2. **Contextuelle, pas lexicale.** §9 est explicite : « Merci pour votre
 *      retour » n'est pas un mot interdit. Ce qui est fautif, c'est de l'écrire
 *      PARCE QUE c'est ainsi qu'on ouvre un message, quel que soit le tour. Les
 *      ouvertures génériques sont donc bloquantes quand le tour n'appelle aucun
 *      accusé de réception, et seulement signalées quand il en appelle un
 *      (refus, report, objection). La même phrase, deux verdicts, selon l'état
 *      de la conversation.
 *
 *   3. **Aucune exigence qu'un contexte pauvre rendrait fausse.** Le rebond sur
 *      un élément concret (§11) n'est réclamé que si le dernier message EN
 *      PORTE un : réclamer un détail précis en réponse à « oui » forcerait
 *      exactement l'invention que CLAUDE.md interdit. Là où la règle pourrait
 *      pousser à inventer, elle se tait.
 *
 * Ce que ce contrôle N'EST PAS : une garde de sécurité. Les garde-fous —
 * chiffre inventé, preuve non citable, lien, promesse — restent ceux de
 * `checkReplyDraft`, et ils sont ailleurs. Confondre les deux ferait
 * ressembler un tic de style à une faute grave, et l'inverse : un jour, un
 * humain pressé apprendrait à passer outre « bloquant » parce que « bloquant »
 * veut souvent dire « trop de phrases ».
 */

import type { ConversationSignals } from '@/lib/conversation/signals';
import type { ConversationGoal, ConversationState, CoveredTopic } from '@/lib/conversation/state';
import { topicsCoveredByText } from '@/lib/conversation/state';
import { countEmojis, countSentences, countWords, detectAddressMode, type StyleProfile } from '@/lib/conversation/style';
import { normalizeForMatching } from '@/lib/conversation/text';

// ---------------------------------------------------------------------------
// Le budget de longueur
// ---------------------------------------------------------------------------

/**
 * La bande de longueur du message auquel on répond.
 *
 * Elle se lit sur le message COURANT, pas sur l'habitude du profil. §7 parle du
 * tour en cours — « si le prospect répond brièvement, Hermes doit généralement
 * répondre brièvement » — et quelqu'un qui a écrit trois pages hier et « ok »
 * aujourd'hui attend une réponse à « ok ». L'habitude sert au registre ; le
 * message courant sert à la longueur.
 */
export type ReplyLengthBand = 'VERY_SHORT' | 'SHORT' | 'MEDIUM' | 'LONG';

export interface LengthBudget {
  readonly band: ReplyLengthBand;
  readonly maxSentences: number;
  readonly maxChars: number;
  /** La longueur du message auquel on répond. Un compteur, pas un contenu. */
  readonly inboundChars: number;
}

/**
 * Les bornes par bande.
 *
 * Le plancher est à deux phrases même face à un « oui » : une réponse honnête à
 * une question de prix sans politique tarifaire (§18) ne tient pas toujours en
 * une phrase, et un budget qui rendrait la bonne réponse impossible ferait
 * choisir entre être naturel et être exact. Le plafond, lui, est bas partout —
 * c'est le défaut du dépôt qu'on corrige, pas l'inverse.
 */
const BUDGETS: Readonly<Record<ReplyLengthBand, { maxSentences: number; maxChars: number }>> = Object.freeze({
  VERY_SHORT: { maxSentences: 2, maxChars: 180 },
  SHORT: { maxSentences: 2, maxChars: 240 },
  MEDIUM: { maxSentences: 3, maxChars: 340 },
  LONG: { maxSentences: 4, maxChars: 460 },
});

function bandFor(chars: number): ReplyLengthBand {
  if (chars <= 25) return 'VERY_SHORT';
  if (chars <= 90) return 'SHORT';
  if (chars <= 260) return 'MEDIUM';
  return 'LONG';
}

/**
 * Calcule le budget du tour.
 *
 * Instagram resserre : un DM n'a ni objet, ni signature, ni paragraphe, et une
 * réponse d'email correcte y passe pour un publipostage. Le canal ne change pas
 * la bande observée — il change ce qu'on s'autorise dedans.
 */
export function computeLengthBudget(
  lastInboundText: string,
  channel: 'email' | 'instagram_dm',
): LengthBudget {
  const inboundChars = lastInboundText.trim().length;
  const band = bandFor(inboundChars);
  const base = BUDGETS[band];
  const instagram = channel === 'instagram_dm';
  return Object.freeze({
    band,
    maxSentences: instagram ? Math.min(base.maxSentences, 3) : base.maxSentences,
    maxChars: instagram ? Math.round(base.maxChars * 0.75) : base.maxChars,
    inboundChars,
  });
}

/** Rend le budget sous la forme que le modèle lit. */
export function renderLengthDirective(budget: LengthBudget): string {
  return [
    'LONGUEUR DE CE MESSAGE',
    `- au plus ${budget.maxSentences} phrase${budget.maxSentences > 1 ? 's' : ''} et environ ${budget.maxChars} caractères ;`,
    '- une seule phrase suffit souvent, et un excellent message fait parfois huit mots ;',
    '- si deux idées se présentent, garde la plus utile et laisse l’autre au tour suivant.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Les mesures
// ---------------------------------------------------------------------------

export interface DraftMetrics {
  readonly chars: number;
  readonly words: number;
  readonly sentences: number;
  readonly questions: number;
  readonly emojis: number;
}

export function measureDraft(body: string): DraftMetrics {
  const text = body.trim();
  return Object.freeze({
    chars: text.length,
    words: countWords(text),
    sentences: countSentences(text),
    questions: (text.match(/\?/g) ?? []).length,
    emojis: countEmojis(text),
  });
}

/**
 * Combien d'AFFIRMATIONS ce texte porte — c'est-à-dire de segments qui ne sont
 * pas des questions.
 *
 * `countSentences` ne suffisait pas : il compte les segments sans regarder leur
 * ponctuation finale, si bien qu'un texte fait d'une seule question compte pour
 * une phrase, comme un texte fait d'une seule affirmation.
 *
 * On découpe donc en conservant le terminateur, et un segment compte comme
 * affirmation quand il ne se termine PAS par « ? ». Un segment final sans
 * ponctuation compte aussi — « je gère les pubs Meta » sans point reste une
 * affirmation.
 *
 * `MIN_WORDS_PER_STATEMENT` écarte les résidus (« Ok. », « Oui. ») : trois mots
 * est le seuil au-dessous duquel un segment n'a pas répondu à grand-chose. Il
 * est petit à dessein — ce contrôle doit attraper l'esquive franche, pas juger
 * la densité d'une réponse.
 */
const MIN_WORDS_PER_STATEMENT = 3;

/**
 * Les segments AFFIRMATIFS d'un texte — ceux qui ne sont pas des questions et
 * qui portent assez de mots pour être autre chose qu'un résidu.
 *
 * PITCH_REPEATED-FALSE-POSITIVE-R1 — extraite de `countStatements` pour que le
 * détecteur de répétition (§16 plus bas) juge la même chose que ce compteur :
 * ce qu'un texte AFFIRME, jamais ce qu'il demande. Un mot du lexique d'offre
 * (« pub », « campagnes »…) présent dans une QUESTION n'est pas un pitch — la
 * question porte sur ce que le PROSPECT faisait, pas sur ce que Hermes fait.
 */
function statementSegments(body: string): string[] {
  const segments = body.trim().match(/[^.!?…\n]+[.!?…]*/gu) ?? [];
  return segments
    .map((segment) => segment.trim())
    .filter((trimmed) => {
      if (trimmed.length === 0) return false;
      if (/\?\s*$/u.test(trimmed)) return false;
      return countWords(trimmed.replace(/[.!?…]+$/u, '')) >= MIN_WORDS_PER_STATEMENT;
    });
}

export function countStatements(body: string): number {
  return statementSegments(body).length;
}

// ---------------------------------------------------------------------------
// Lexiques
// ---------------------------------------------------------------------------

/**
 * Les ouvertures d'accusé de réception.
 *
 * Nommées par FAMILLE et non une par une : « merci pour votre retour » et
 * « merci pour ces précisions » sont le même réflexe, et les compter comme deux
 * ouvertures différentes laisserait alterner l'une et l'autre en croyant varier.
 */
export type OpeningFamily = 'THANKS' | 'UNDERSTANDING' | 'AGREEMENT' | 'PERMISSION' | 'TRANSITION';

const OPENING_PATTERNS: ReadonlyArray<readonly [OpeningFamily, RegExp]> = [
  ['THANKS', /^(un\s+)?(grand\s+)?merci\b/i],
  ['UNDERSTANDING', /^(je\s+(vois|comprends|note)|c'est\s+not[ée]|bien\s+not[ée]|tr[èe]s\s+clair|compris)\b/i],
  ['AGREEMENT', /^(effectivement|tout\s+[àa]\s+fait|en\s+effet|absolument|parfait|tr[èe]s\s+bien)\b/i],
  ['PERMISSION', /^(permettez[- ]moi|je\s+me\s+permets|si\s+vous\s+le\s+permettez)\b/i],
  ['TRANSITION', /^(dans\s+ce\s+cas|du\s+coup,|cela\s+[ée]tant|ceci\s+dit|quoi\s+qu'il\s+en\s+soit)\b/i],
];

/**
 * Le jargon d'agence.
 *
 * Volontairement restreint à ce qui n'existe QUE dans une plaquette. §14
 * protège explicitement « cela », « concernant », « afin de », « néanmoins » :
 * ce sont des mots de français écrit, pas des marqueurs corporate, et les
 * pénaliser transformerait le contrôle en machine à parler djeune.
 */
const CORPORATE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['notre solution', /\bnotre\s+(solution|dispositif|offre)\s+(permet|vous\s+permet|est\s+con[çc]ue)/i],
  ['nous accompagnons', /\bnous\s+accompagnons\s+(les|des|nos)\b/i],
  ['seriez-vous disponible', /\bseriez[- ]vous\s+disponible\b/i],
  ['souhaitez-vous que nous', /\bsouhaitez[- ]vous\s+que\s+(nous|je)\b/i],
  ['n’hésitez pas à revenir vers', /\bn'h[ée]sitez\s+pas\s+[àa]\s+(revenir\s+vers|me\s+solliciter)/i],
  ['je reviens vers vous', /\bje\s+reviens\s+vers\s+vous\b/i],
  ['dans le cadre de notre', /\bdans\s+le\s+cadre\s+de\s+(notre|nos)\b/i],
  ['d’ores et déjà', /\bd'ores\s+et\s+d[ée]j[àa]\b/i],
  ['valeur ajoutée', /\bvaleur\s+ajout[ée]e\b/i],
  ['sur-mesure', /\b(sur[- ]mesure|clé\s+en\s+main|cl[ée]s?\s+en\s+main)\b/i],
  ['levier de croissance', /\blevier\s+(de\s+croissance|d'acquisition)\b/i],
  ['accompagnement personnalisé', /\baccompagnement\s+personnalis[ée]\b/i],
  ['prise de contact', /\bprise\s+de\s+contact\b/i],
  ['à cet effet', /\b[àa]\s+cet\s+effet\b/i],
];

/**
 * Textismes et abréviations de français écrit rapide.
 *
 * Ils sont interdits dans NOTRE texte quel que soit le style d'en face : §13
 * demande un ALIGNEMENT, pas une IMITATION. Quelqu'un qui écrit « pk » n'attend
 * pas « pk » en retour — il attend qu'on ne lui réponde pas en costume. La même
 * liste attrape la reproduction des fautes (§13) et l'inflation d'abréviations,
 * parce que c'est le même geste.
 */
const TEXTISM_PATTERN =
  /\b(pk|pkoi|pcq|prq|bcp|tkt|jsp|mdr|ptdr|nn|qd|tjs|tjrs|auj|slt|bjr|bsr|jpp|dsl|nrml|stp|c'est\s+cho|ya|jai|cest|sa\s+va|sa\s+marche|ct\s+bien)\b/i;

/** Le registre « djeune » qu'on ne s'invente pas (§13). */
const FORCED_SLANG_PATTERN =
  /\b(wesh|askip|chelou|trkl|frangin|fr[èe]ro|bg|gg|zebi|mskn|wallah|c'est\s+chanm[ée]|de\s+ouf|grave\s+de\s+ouf)\b/i;

/**
 * HERMES-TARGETING-R1 §21 — les deux lexiques ci-dessus, offerts au first
 * touch.
 *
 * Exportés comme des PRÉDICATS et non comme des expressions régulières : une
 * regex exportée finit recopiée puis modifiée d'un côté seulement, et les deux
 * chemins divergent sans que personne ne le voie. Un prédicat garde une seule
 * définition de « ce texte singe un registre » pour la conversation et pour le
 * premier message — ce qui est exactement ce que §21 demande en interdisant un
 * second moteur de message.
 */
export function containsTextism(body: string): string | null {
  return normalizeForMatching(body).match(TEXTISM_PATTERN)?.[0] ?? null;
}

export function containsForcedSlang(body: string): string | null {
  return normalizeForMatching(body).match(FORCED_SLANG_PATTERN)?.[0] ?? null;
}

/** Ce qu'une proposition d'échange ressemble, dans NOTRE texte. */
const CALL_OFFER_PATTERN =
  /\b(s'appeler|un\s+appel|un\s+[ée]change\s+(court|rapide|de)|se\s+parler|quinze\s+minutes|15\s+minutes|par\s+t[ée]l[ée]phone|de\s+vive\s+voix|on\s+se\s+cale|vous\s+[êe]tes\s+dispo)/i;

/** Ce qu'un argumentaire ressemble, dans NOTRE texte. */
const PITCH_PATTERN =
  /\b(on\s+aide|nous\s+aidons|on\s+accompagne|nous\s+accompagnons|notre\s+(offre|m[ée]tier|travail)|on\s+met\s+en\s+place|on\s+s'occupe\s+de)\b/i;

const PRICE_TALK_PATTERN = /\b(prix|tarif|tarifs|budget|co[ûu]t|montant|d[ée]pend\s+(du|de\s+la|des))\b/i;
const PROOF_TALK_PATTERN = /\b(r[ée]sultats?|preuve|preuves|r[ée]f[ée]rences?|t[ée]moignages?|clients?\s+accompagn)/i;

// ---------------------------------------------------------------------------
// Le rebond concret (§11)
// ---------------------------------------------------------------------------

/**
 * Mots vides du français, plus les mots de politesse et les adverbes de cadrage.
 *
 * Ils sont exclus des « éléments concrets » parce qu'ils n'en sont pas :
 * rebondir sur « principalement » ne dit rien à personne. La liste est
 * générique — aucun vocabulaire de niche n'y entre, et CLAUDE.md l'interdirait.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // Les mots d'accord et de refus en tête : « ouais » a cinq lettres et ne dit
  // rien de concret. Sans eux, « ouais pk pas » porterait un « élément » sur
  // lequel on demanderait de rebondir — c'est-à-dire un détail à inventer.
  'ouais', 'ouai', 'oui', 'non', 'nan', 'okay', 'voila', 'voilà', 'exact', 'carrement', 'carrément',
  'nickel', 'super', 'effectivement', 'accord', 'peut-etre', 'certes', 'deja', 'déjà',
  // Les connecteurs : « ainsi » n'est pas un élément concret, et le proposer
  // comme point d'appui inviterait à rebondir sur une charnière de phrase.
  'ainsi', 'ensuite', 'enfin', 'egalement', 'également', 'notamment', 'plutot', 'plutôt', 'ailleurs',
  'alors', 'apres', 'après', 'aucun', 'aujourd', 'aussi', 'autre', 'avec', 'avez', 'avoir', 'beaucoup',
  'bien', 'bonjour', 'bonsoir', 'cela', 'cette', 'ceux', 'chez', 'comme', 'comment', 'dans', 'depuis',
  'deux', 'dire', 'donc', 'elle', 'elles', 'encore', 'entre', 'etais', 'etait', 'etre', 'être', 'faire',
  'fais', 'fait', 'faut', 'hui', 'juste', 'leur', 'leurs', 'mais', 'merci', 'meme', 'même', 'mien',
  'moins', 'notre', 'nous', 'parce', 'pareil', 'peut', 'peux', 'plus', 'pour', 'pourquoi', 'principalement',
  'quand', 'quel', 'quelle', 'quelque', 'quelques', 'salut', 'sans', 'sont', 'suis', 'surtout', 'tous',
  'tout', 'toute', 'toutes', 'tres', 'très', 'trop', 'vais', 'votre', 'vos', 'vous', 'vraiment', 'actuellement',
]);

function tokenize(text: string): string[] {
  return normalizeForMatching(text)
    .toLowerCase()
    .split(/[^a-zà-öø-ÿ0-9]+/u)
    .filter((token) => token.length > 0);
}

/** Ramène « demandes » et « demande » à la même chose. Rien de plus ambitieux. */
function stem(token: string): string {
  return token.replace(/(?:es|s|x)$/u, '');
}

export const MAX_ANCHORS = 6;

/**
 * Les éléments concrets que le dernier message porte réellement.
 *
 * Rend des mots ET les paires de mots adjacents : « site internet » et « fiche
 * Google » disent quelque chose que « site » et « fiche » séparés ne disent
 * pas. Rend un tableau vide quand il n'y a rien de concret — « oui » ne porte
 * aucun élément, et prétendre le contraire ferait forcer un détail inventé.
 */
export function concreteAnchors(text: string): string[] {
  const tokens = tokenize(text);
  const kept: { token: string; index: number }[] = [];
  tokens.forEach((token, index) => {
    if (token.length < 4) return;
    if (STOPWORDS.has(token)) return;
    kept.push({ token, index });
  });

  const anchors: string[] = [];
  for (let i = 0; i < kept.length; i += 1) {
    const current = kept[i];
    if (current === undefined) continue;
    const next = kept[i + 1];
    if (next !== undefined && next.index === current.index + 1) {
      anchors.push(`${current.token} ${next.token}`);
    }
    anchors.push(current.token);
  }

  return [...new Set(anchors)].slice(0, MAX_ANCHORS);
}

/**
 * Comment la réponse se raccroche à ce qui vient d'être dit.
 *
 * `ANAPHOR` compte autant qu'`ANCHOR`, et c'est le point délicat : « et ça vous
 * apporte déjà des demandes ? » ne répète aucun mot du message d'en face, et
 * c'est pourtant l'exemple naturel de §11. Le français parlé reprend par un
 * pronom, pas par un copier-coller ; exiger le mot exact produirait des
 * réponses qui ressassent (« votre site internet et votre fiche Google vous
 * apportent-ils… »), c'est-à-dire l'inverse du but.
 */
export type ReboundKind = 'ANCHOR' | 'ANAPHOR' | 'NONE';

/**
 * Les reprises pronominales, reconnues par TOKEN et non par expression
 * régulière.
 *
 * `/\bça\b/` ne marche pas : « ç » n'est pas un caractère de mot au sens de
 * JavaScript, donc il n'y a aucune frontière `\b` entre l'espace et lui, et le
 * motif ne matche jamais. Le défaut est silencieux — la fonction rend `NONE`,
 * une valeur plausible — et il coûtait exactement le contraire du but : la
 * reprise la plus naturelle du français parlé passait pour une absence de
 * rebond. Même famille de piège que l'apostrophe typographique de `text.ts`.
 */
const ANAPHOR_TOKENS: ReadonlySet<string> = new Set(['ça', 'ca', 'cela', 'celui', 'celle', 'ceux']);
const ANAPHOR_ELISION = /\bc'est\b/i;

export function classifyRebound(body: string, anchors: readonly string[]): ReboundKind {
  const tokens = tokenize(body);
  const stems = new Set(tokens.map(stem));
  for (const anchor of anchors) {
    const parts = anchor.split(' ').map(stem);
    if (parts.every((part) => stems.has(part))) return 'ANCHOR';
  }
  if (tokens.some((token) => ANAPHOR_TOKENS.has(token))) return 'ANAPHOR';
  return ANAPHOR_ELISION.test(normalizeForMatching(body)) ? 'ANAPHOR' : 'NONE';
}

// ---------------------------------------------------------------------------
// Les constats
// ---------------------------------------------------------------------------

export type NaturalnessCode =
  /** Plus long que ce que le tour justifie. */
  | 'TOO_LONG'
  /** Plus de phrases que le tour ne justifie. */
  | 'TOO_MANY_SENTENCES'
  /** Plus d'une question : §8, une seule vraie question par message. */
  | 'MULTIPLE_QUESTIONS'
  /** Ouverture d'accusé de réception là où le tour n'en appelle aucun. */
  | 'GENERIC_OPENING'
  /** La même famille d'ouverture qu'un tour précédent : un gabarit, pas un style. */
  | 'OPENING_ALREADY_USED'
  /** Les trois premiers mots d'un tour précédent, à l'identique. */
  | 'TEMPLATE_REPEATED'
  /** Formule de plaquette. */
  | 'CORPORATE_JARGON'
  /** Réexplique ce que le fil a déjà couvert. */
  | 'PITCH_REPEATED'
  /** Propose un échange sans signal qui le justifie. */
  | 'CTA_TOO_EARLY'
  /** Plus d'emojis que le style observé ne le permet. */
  | 'EMOJI_INFLATION'
  /** Tutoie qui vouvoie, ou l'inverse. */
  | 'ADDRESS_MODE_MISMATCH'
  /** Reproduit une abréviation ou une faute. */
  | 'TEXTISM_OR_TYPO'
  /** Singe un registre familier que personne n'a demandé. */
  | 'FORCED_SLANG'
  /** Question + argumentaire + preuve + appel dans le même message. */
  | 'TOO_MANY_INTENTS'
  /** Ne se raccroche à rien de ce qui vient d'être dit. */
  | 'NO_CONCRETE_REBOUND'
  /**
   * HERMES-ACQUISITION-SERVICE-TRUTH-R1 — répond à une question par une
   * question, alors que la réponse existait.
   *
   * Le 23 août 2026, à « Ok mais concrètement tu fais quoi pour trouver des
   * clients ? », le modèle a écrit : « Ça dépend de ce que tu as déjà en
   * place : tu veux surtout plus de réservations de particuliers ou plus de
   * demandes de pros ? ». Court, poli, dans le bon registre — et jugé
   * `NATURAL`, parce qu'aucun contrôle ne mesurait la seule chose qui n'allait
   * pas : il n'y a pas de réponse dedans.
   *
   * C'est une faute COMMERCIALE, pas une maladresse de style, et elle a sa
   * place ici pour la même raison que `CTA_TOO_EARLY` ou `PITCH_REPEATED` :
   * ce module juge ce qui « ne ressemble pas à une conversation », et esquiver
   * une question directe n'y ressemble pas.
   *
   * Il ne se déclenche QUE lorsqu'une vérité canonique couvre le sujet
   * (`answerExpected`). Ailleurs — et c'est le cas fréquent — une réponse d'une
   * seule question est exactement ce que l'objectif `UNDERSTAND_NEED` demande,
   * et le signaler serait faux.
   */
  | 'QUESTION_WITHOUT_ANSWER';

/**
 * `BLOCKING` ne veut pas dire « dangereux ».
 *
 * Il veut dire « ce message ne partirait pas tel quel ». La sécurité vit dans
 * `checkReplyDraft` et n'a rien à voir avec cette échelle — les deux verdicts
 * restent séparés jusque dans le type de sortie.
 */
export type NaturalnessSeverity = 'BLOCKING' | 'WARNING';

export interface NaturalnessFinding {
  readonly code: NaturalnessCode;
  readonly severity: NaturalnessSeverity;
  readonly message: string;
  /** Un extrait de NOTRE texte. Jamais de celui du prospect. */
  readonly excerpt: string | null;
}

export type NaturalnessVerdict = 'NATURAL' | 'ACCEPTABLE' | 'UNNATURAL';

/**
 * HERMES-SEMANTIC-GROUNDING-R1 — ce qu'un constat de naturalité PEUT coûter.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi cette distinction n'existait pas, et pourquoi elle manquait
 * ---------------------------------------------------------------------------
 * `severity` répond à « ce message partirait-il tel quel ? ». C'est une bonne
 * question, et elle reste posée telle quelle. Elle ne répond PAS à « faut-il
 * se taire plutôt que d'envoyer ce message ? », qui est une question
 * différente — et c'est pourtant elle que `decideAutonomousReply` posait, en
 * lisant `severity` comme si les deux se confondaient.
 *
 * La conséquence a été mesurée trois fois sur le fil contrôlé : un tour
 * commercialement juste, sûr, ancré et compris a été mis en silence parce que
 * son ouverture ressemblait à celle d'un tour précédent, ou parce qu'il
 * dépassait de quelques caractères. Le silence est un choix, et sur une
 * conversation vivante c'est le plus coûteux de tous : le prospect n'a pas de
 * réponse, et personne ne sait qu'il en attendait une.
 *
 * ---------------------------------------------------------------------------
 * Deux classes, et la frontière est écrite
 * ---------------------------------------------------------------------------
 * `POLICY` — le constat porte une règle EXPLICITE du dépôt, écrite ailleurs
 * qu'ici et pour une raison qui n'est pas le style : une seule question par
 * message (§8), pas d'appel avant sa maturité (§17), répondre à ce qu'on a
 * demandé quand la réponse existe, pas de langue de plaquette. Ces quatre-là
 * refusent le tour, réécriture ou pas. Trois d'entre eux ont d'ailleurs leur
 * propre porte dans `autonomy.ts` : ce ne serait pas cohérent qu'ils soient
 * indulgents ici et fermes là-bas.
 *
 * `REPAIRABLE` — le constat porte une maladresse de forme. Il déclenche la
 * réécriture unique du cerveau (`MAX_DRAFT_ATTEMPTS`), et si elle ne suffit
 * pas, il devient un AVERTISSEMENT : le message part, un peu moins bien tourné
 * qu'on l'aurait voulu, plutôt que de ne pas partir du tout.
 *
 * Ce que cette classe n'ouvre PAS, et il faut le dire : **aucune violation de
 * sécurité ne devient réparable**. La sécurité ne vit pas dans ce fichier —
 * elle vit dans `checkReplyDraft` (chiffre non sourcé, lien, pourcentage),
 * `detectPerformanceClaims` (promesse de rémunération) et
 * `checkTrialStatement` (essai décrit à moitié). Ces trois-là refusent le tour
 * exactement comme avant, et leurs portes n'ont pas bougé d'un cran.
 */
export type NaturalnessClass = 'POLICY' | 'REPAIRABLE';

/**
 * `Record` complet et non partiel : ajouter un constat sans dire ce qu'il coûte
 * devient une erreur de compilation, et non un `undefined` que la lecture
 * sauterait en silence — auquel cas le constat neuf serait, par défaut,
 * silencieusement réparable.
 */
export const NATURALNESS_CLASS: Readonly<Record<NaturalnessCode, NaturalnessClass>> = Object.freeze({
  // --- POLICY : des règles écrites ailleurs, et qui ne sont pas du style ----
  /** §8 — une seule vraie question. `autonomy.ts` porte la même porte. */
  MULTIPLE_QUESTIONS: 'POLICY',
  /** §17 — un appel ne se propose pas avant sa maturité. Même porte ailleurs. */
  CTA_TOO_EARLY: 'POLICY',
  /** RÉPONDS D'ABORD — esquiver une question dont on a la réponse. */
  QUESTION_WITHOUT_ANSWER: 'POLICY',
  /** La langue de plaquette est interdite, pas seulement déconseillée. */
  CORPORATE_JARGON: 'POLICY',

  // --- REPAIRABLE : la forme ------------------------------------------------
  TOO_LONG: 'REPAIRABLE',
  TOO_MANY_SENTENCES: 'REPAIRABLE',
  GENERIC_OPENING: 'REPAIRABLE',
  OPENING_ALREADY_USED: 'REPAIRABLE',
  TEMPLATE_REPEATED: 'REPAIRABLE',
  PITCH_REPEATED: 'REPAIRABLE',
  EMOJI_INFLATION: 'REPAIRABLE',
  ADDRESS_MODE_MISMATCH: 'REPAIRABLE',
  TEXTISM_OR_TYPO: 'REPAIRABLE',
  FORCED_SLANG: 'REPAIRABLE',
  TOO_MANY_INTENTS: 'REPAIRABLE',
  NO_CONCRETE_REBOUND: 'REPAIRABLE',
});

export interface NaturalnessReport {
  readonly verdict: NaturalnessVerdict;
  readonly findings: readonly NaturalnessFinding[];
  readonly metrics: DraftMetrics;
  readonly budget: LengthBudget;
  readonly rebound: ReboundKind;
  readonly anchors: readonly string[];
}

export interface NaturalnessInput {
  readonly body: string;
  /** Le message auquel on répond. Sert à mesurer, jamais à être recopié. */
  readonly lastInboundText: string;
  readonly style: StyleProfile;
  readonly state: ConversationState;
  readonly signals: ConversationSignals;
  readonly channel: 'email' | 'instagram_dm';
  /** Nos tours précédents, pour détecter le gabarit qui se répète (§21). */
  readonly previousOutboundTexts: readonly string[];
  /**
   * Une vérité canonique couvre-t-elle ce qui vient d'être demandé ?
   *
   * HERMES-ACQUISITION-SERVICE-TRUTH-R1 — calculé par le cerveau
   * (`understandConversation`) depuis les blocs réellement injectés dans le
   * prompt : motif de contact, essai, vérité de service. Le contrôle et le
   * prompt lisent donc la MÊME question, ce qui évite d'exiger une réponse que
   * le modèle n'avait pas les moyens d'écrire.
   *
   * Optionnel, et absent vaut `false` : un appelant qui ne le passe pas obtient
   * exactement le rapport d'avant ce round, ce qu'un test vérifie par
   * comparaison plutôt que sur parole.
   */
  readonly answerExpected?: boolean;
}

/** Les objectifs où accuser réception a un sens : on encaisse avant de refermer. */
const ACKNOWLEDGING_GOALS: ReadonlySet<ConversationGoal> = new Set<ConversationGoal>([
  'HANDLE_OBJECTION',
  'ACKNOWLEDGE_AND_CLOSE',
  'AWAIT_HUMAN',
]);

/** Les objectifs où la conversation continue : un rebond y est attendu. */
const CONTINUING_GOALS: ReadonlySet<ConversationGoal> = new Set<ConversationGoal>([
  'UNDERSTAND_NEED',
  'QUALIFY_LIGHTLY',
  'ANSWER_QUESTION',
  'HANDLE_OBJECTION',
]);

/**
 * La famille d'ouverture d'un texte, ou `null` s'il n'ouvre pas par un réflexe.
 *
 * Exportée depuis LEARNING-R1 pour que la comparaison « brouillon vs message
 * réellement envoyé » demande « l'ouverture générique a-t-elle été retirée ? »
 * au MÊME lexique que celui qui la juge artificielle. Un second lexique
 * finirait par répondre non ici et oui là, et la correction la plus fréquente
 * de un opérateur deviendrait invisible.
 */
export function openingFamily(body: string): OpeningFamily | null {
  const head = normalizeForMatching(body).trim();
  for (const entry of OPENING_PATTERNS) {
    if (entry[1].test(head)) return entry[0];
  }
  return null;
}

/** Ce texte propose-t-il un échange ? Même motif que le contrôle de naturalité. */
export function proposesCall(body: string): boolean {
  return CALL_OFFER_PATTERN.test(normalizeForMatching(body));
}

/** Ce texte porte-t-il un argumentaire ? Même motif que le contrôle. */
export function containsPitch(body: string): boolean {
  return PITCH_PATTERN.test(normalizeForMatching(body));
}

/** Ce texte porte-t-il une formule de plaquette ? Même lexique que le contrôle. */
export function containsCorporateJargon(body: string): boolean {
  const normalized = normalizeForMatching(body);
  return CORPORATE_PATTERNS.some((entry) => entry[1].test(normalized));
}

/** Les trois premiers mots, normalisés. La signature d'un gabarit. */
function openingSignature(body: string): string {
  return tokenize(body).slice(0, 3).join(' ');
}

function excerptOf(body: string, max = 60): string {
  const text = body.trim().replace(/\s+/gu, ' ');
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Relit un brouillon et dit ce qui, dedans, ne ressemble pas à une conversation.
 *
 * Fonction pure. Ne lève jamais : un corps vide rend un rapport, pas une
 * exception — c'est au rédacteur de décider quoi en faire.
 */
export function checkNaturalness(input: NaturalnessInput): NaturalnessReport {
  const body = input.body.trim();
  const normalized = normalizeForMatching(body);
  const metrics = measureDraft(body);
  const budget = computeLengthBudget(input.lastInboundText, input.channel);
  const anchors = concreteAnchors(input.lastInboundText);
  const rebound = classifyRebound(body, anchors);
  const findings: NaturalnessFinding[] = [];

  const add = (
    code: NaturalnessCode,
    severity: NaturalnessSeverity,
    message: string,
    excerpt: string | null = null,
  ): void => {
    findings.push(Object.freeze({ code, severity, message, excerpt }));
  };

  // --- longueur ----------------------------------------------------------
  if (metrics.chars > budget.maxChars) {
    add(
      'TOO_LONG',
      'BLOCKING',
      `${metrics.chars} caractères pour un message de ${budget.inboundChars} (budget ${budget.maxChars}, bande ${budget.band})`,
    );
  }
  if (metrics.sentences > budget.maxSentences) {
    add(
      'TOO_MANY_SENTENCES',
      'BLOCKING',
      `${metrics.sentences} phrases alors que ${budget.maxSentences} suffisent sur ce tour`,
    );
  }

  // --- une seule question (§8, §15) --------------------------------------
  if (metrics.questions > 1) {
    add('MULTIPLE_QUESTIONS', 'BLOCKING', `${metrics.questions} questions dans le même message`);
  }

  // --- ouverture (§9, §10, §21) ------------------------------------------
  const family = openingFamily(body);
  if (family !== null) {
    const motivated = ACKNOWLEDGING_GOALS.has(input.state.goal);
    add(
      'GENERIC_OPENING',
      motivated ? 'WARNING' : 'BLOCKING',
      motivated
        ? `ouverture d’accusé de réception (${family}) — admissible sur ${input.state.goal}, à condition qu’elle dise quelque chose`
        : `ouverture d’accusé de réception (${family}) sans rien qui la motive sur ${input.state.goal}`,
      excerptOf(body, 32),
    );
  }

  const signature = openingSignature(body);
  for (const previous of input.previousOutboundTexts) {
    if (family !== null && openingFamily(previous) === family) {
      add(
        'OPENING_ALREADY_USED',
        'BLOCKING',
        `la même famille d’ouverture (${family}) a déjà servi dans ce fil`,
        excerptOf(body, 32),
      );
      break;
    }
  }
  if (signature.length > 0) {
    for (const previous of input.previousOutboundTexts) {
      if (openingSignature(previous) === signature) {
        add(
          'TEMPLATE_REPEATED',
          'BLOCKING',
          'les trois premiers mots reprennent mot pour mot ceux d’un tour précédent',
          excerptOf(body, 32),
        );
        break;
      }
    }
  }

  // --- jargon (§9) -------------------------------------------------------
  for (const entry of CORPORATE_PATTERNS) {
    if (entry[1].test(normalized)) {
      add('CORPORATE_JARGON', 'BLOCKING', `formule de plaquette : « ${entry[0]} »`, entry[0]);
      break;
    }
  }

  // --- répétition de ce qui est déjà couvert (§16) -----------------------
  //
  // PITCH_REPEATED-FALSE-POSITIVE-R1 — le lexique d'offre (`OFFER_EXPLAINED`,
  // `HOW_IT_WORKS_EXPLAINED`) est volontairement large pour scanner NOS tours
  // PASSÉS (coûteux d'en rater un). Appliqué tel quel au brouillon COURANT, il
  // confondait « ce texte affirme quelque chose sur notre offre » avec « ce
  // texte contient un mot du lexique », y compris dans une QUESTION — « tu
  // faisais la pub sur quelle prestation ? » n'affirme rien, elle demande, et
  // n'est donc pas un pitch quel que soit ce que le fil a déjà couvert. Seules
  // les AFFIRMATIONS du brouillon (`statementSegments`) sont donc confrontées
  // au lexique — une question pure n'en produit aucune.
  const covered = new Set<CoveredTopic>(input.state.coveredTopics);
  const draftStatements = statementSegments(body).join(' ');
  const inDraft = new Set<CoveredTopic>(topicsCoveredByText(draftStatements));
  const repeated = [...inDraft].filter(
    (topic) => covered.has(topic) && (topic === 'OFFER_EXPLAINED' || topic === 'HOW_IT_WORKS_EXPLAINED'),
  );
  if (repeated.length > 0 && input.signals.questionTopic === 'NONE') {
    // Une question RELANCE le sujet : réexpliquer l'offre à qui la demande
    // n'est pas une répétition, c'est une réponse. Sans question, c'en est une.
    add('PITCH_REPEATED', 'BLOCKING', `réexplique ce que le fil a déjà couvert : ${repeated.join(', ')}`);
  }

  // --- appel proposé trop tôt (§17) --------------------------------------
  const offersCall = CALL_OFFER_PATTERN.test(normalized);
  if (offersCall && !input.signals.explicitCallRequest) {
    if (input.signals.callReadiness === 'LOW' && input.state.goal !== 'PROPOSE_CALL') {
      add(
        'CTA_TOO_EARLY',
        'BLOCKING',
        `propose un échange alors que la maturité est LOW et l’objectif ${input.state.goal}`,
      );
    } else if (covered.has('CALL_PROPOSED')) {
      add('CTA_TOO_EARLY', 'BLOCKING', 'un échange a déjà été proposé dans ce fil et rien ne le redemande');
    }
  }

  // --- une idée par message (§8) -----------------------------------------
  const intents = [
    metrics.questions >= 1,
    PITCH_PATTERN.test(normalized),
    offersCall,
    PRICE_TALK_PATTERN.test(normalized),
    PROOF_TALK_PATTERN.test(normalized),
  ].filter(Boolean).length;
  if (intents >= 3) {
    add('TOO_MANY_INTENTS', 'BLOCKING', `${intents} intentions dans le même message ; une seule était demandée`);
  }

  // --- emojis (§13) ------------------------------------------------------
  if (metrics.emojis > 1) {
    add('EMOJI_INFLATION', 'BLOCKING', `${metrics.emojis} emojis : au plus un, quoi qu’en mette la personne`);
  } else if (metrics.emojis === 1 && input.style.emojiLevel === 'NONE') {
    add('EMOJI_INFLATION', 'BLOCKING', 'un emoji alors qu’aucun n’a été observé en face');
  } else if (metrics.emojis === 1 && input.style.emojiLevel === 'UNKNOWN') {
    add('EMOJI_INFLATION', 'WARNING', 'un emoji alors que rien n’a été observé sur ce point');
  }

  // --- tu / vous (§12) ---------------------------------------------------
  // Rien n'est signalé quand le registre d'en face n'est pas observé : §12
  // demande alors un repli neutre, pas un pari qu'on vérifierait après coup.
  const draftAddress = detectAddressMode(body);
  if (
    input.style.addressMode !== 'UNKNOWN' &&
    draftAddress !== 'UNKNOWN' &&
    draftAddress !== input.style.addressMode
  ) {
    add(
      'ADDRESS_MODE_MISMATCH',
      'BLOCKING',
      `la réponse ${draftAddress === 'TU' ? 'tutoie' : 'vouvoie'} alors que la personne ${
        input.style.addressMode === 'TU' ? 'tutoie' : 'vouvoie'
      }`,
    );
  }

  // --- imitation (§13) ---------------------------------------------------
  const textism = normalized.match(TEXTISM_PATTERN);
  if (textism) {
    add('TEXTISM_OR_TYPO', 'BLOCKING', `abréviation ou faute reproduite : « ${textism[0]} »`, textism[0]);
  }
  const slang = normalized.match(FORCED_SLANG_PATTERN);
  if (slang) {
    add('FORCED_SLANG', 'BLOCKING', `registre familier surjoué : « ${slang[0]} »`, slang[0]);
  }

  // --- rebond (§11) ------------------------------------------------------
  // Signalé, jamais bloquant : forcer un rebond quand le message d'en face
  // n'offre rien à quoi se raccrocher pousserait à inventer un détail.
  if (anchors.length > 0 && rebound === 'NONE' && CONTINUING_GOALS.has(input.state.goal)) {
    add(
      'NO_CONCRETE_REBOUND',
      'WARNING',
      'ne reprend aucun élément concret du dernier message et n’y renvoie pas non plus',
    );
  }

  // --- répondre d'abord ---------------------------------------------------
  //
  // Placé en DERNIER parmi les constats, et bloquant : une réponse qui esquive
  // une question dont on a la réponse ne part pas telle quelle. Le rédacteur la
  // réécrit une fois avec ce constat sous les yeux (`renderCorrections`), ce
  // qui est précisément la boucle que ce module existe pour alimenter.
  if (input.answerExpected === true && metrics.questions > 0 && countStatements(body) === 0) {
    add(
      'QUESTION_WITHOUT_ANSWER',
      'BLOCKING',
      'répond à une question par une question : le message ne contient aucune affirmation, alors ' +
        'que la réponse était disponible',
      excerptOf(body, 60),
    );
  }

  const blocking = findings.some((finding) => finding.severity === 'BLOCKING');
  const verdict: NaturalnessVerdict = blocking ? 'UNNATURAL' : findings.length > 0 ? 'ACCEPTABLE' : 'NATURAL';

  return Object.freeze({
    verdict,
    findings: Object.freeze(findings),
    metrics,
    budget,
    rebound,
    anchors: Object.freeze(anchors),
  });
}

/**
 * Ce que la naturalité coûte à l'ENVOI, une fois la réécriture consommée.
 *
 * Fonction pure, sans état : elle ne sait pas si une réécriture a eu lieu, et
 * c'est délibéré. `assessInboundMessage` relit un brouillon déjà écrit, sans
 * modèle et sans compteur de tentatives ; un verdict qui dépendrait du nombre
 * d'essais ne serait pas reproductible depuis la base, et deux lectures du même
 * texte donneraient deux réponses. Le cerveau réécrit UNE fois quoi qu'il
 * arrive (`MAX_DRAFT_ATTEMPTS`) ; ce qui reste ensuite est jugé ici, et
 * seulement sur sa classe.
 */
export interface NaturalnessSendGate {
  /** Les constats qui EMPÊCHENT l'envoi. Vides = ce texte peut partir. */
  readonly blocking: readonly NaturalnessCode[];
  /** Les constats gardés pour la mesure. Ils ne refusent rien. */
  readonly warnings: readonly NaturalnessCode[];
}

export function naturalnessSendGate(report: NaturalnessReport): NaturalnessSendGate {
  const blocking: NaturalnessCode[] = [];
  const warnings: NaturalnessCode[] = [];
  for (const finding of report.findings) {
    const blocks = finding.severity === 'BLOCKING' && NATURALNESS_CLASS[finding.code] === 'POLICY';
    if (blocks) blocking.push(finding.code);
    else warnings.push(finding.code);
  }
  return Object.freeze({ blocking: Object.freeze(blocking), warnings: Object.freeze(warnings) });
}

/**
 * Les constats à corriger, rendus au modèle pour sa réécriture unique.
 *
 * Ils comprennent les constats RÉPARABLES, et c'est tout le sujet : ce sont
 * précisément ceux qui, après cette tentative, ne refuseront plus le tour. Ne
 * pas les montrer reviendrait à ne jamais leur donner l'occasion d'être
 * corrigés, puis à les laisser passer — le pire des deux mondes.
 */
export function renderCorrections(report: NaturalnessReport): string {
  const blocking = report.findings.filter((finding) => finding.severity === 'BLOCKING');
  const lines = ['CE QUI N’ALLAIT PAS DANS TA PREMIÈRE VERSION — corrige et réécris'];
  for (const finding of blocking) lines.push(`- ${finding.code} : ${finding.message}`);
  lines.push(
    `- vise ${report.budget.maxSentences} phrase${report.budget.maxSentences > 1 ? 's' : ''} maximum et ${report.budget.maxChars} caractères.`,
  );
  return lines.join('\n');
}
