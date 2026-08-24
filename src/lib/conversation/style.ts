/**
 * CONVERSATION-R1 — le profil de style, observé et jamais deviné.
 *
 * Ce fichier répond à une seule question : « comment cette personne écrit-elle,
 * d'après ce qu'elle a RÉELLEMENT écrit ? ». Trois propriétés le tiennent :
 *
 *   1. **Déterministe.** Aucun modèle n'intervient. Le même corpus produit le
 *      même profil, sur n'importe quelle machine — c'est ce qui rend les tests
 *      de §18 possibles et ce qu'impose CLAUDE.md pour toute logique décidable.
 *
 *   2. **Aucune absence non vérifiée.** Chaque dimension peut valoir `UNKNOWN`,
 *      et c'est sa valeur par défaut. « Cette personne n'utilise pas d'emoji »
 *      est une affirmation ; un unique « ok » ne la prouve pas. Sous le seuil
 *      d'évidence, la dimension reste `UNKNOWN` et la voix Hermes prend le
 *      relais (§8) plutôt qu'un trait inventé.
 *
 *   3. **Rien de personnel n'y entre.** Le profil ne contient que des valeurs
 *      d'énumération linguistiques et des compteurs. Pas un caractère du
 *      message d'origine, pas un nom, pas une adresse — et surtout aucun trait
 *      sensible (âge, origine, personnalité, milieu). §16 n'est pas une
 *      consigne de rédaction ici : le type lui-même ne peut pas les porter.
 *
 * Le corpus est limité aux messages ENTRANTS de la contrepartie. Nos propres
 * messages n'y entrent jamais : sinon le profil convergerait vers notre voix et
 * chaque tour se calquerait sur le précédent jusqu'à ne plus rien observer.
 */

import { normalizeForMatching } from '@/lib/conversation/text';

// ---------------------------------------------------------------------------
// Les dimensions
// ---------------------------------------------------------------------------

/** Le tutoiement se lit dans les mots ; il ne se devine pas. */
export type AddressMode = 'TU' | 'VOUS' | 'UNKNOWN';
export type Formality = 'CASUAL' | 'NEUTRAL' | 'FORMAL' | 'UNKNOWN';
export type LengthBand = 'VERY_SHORT' | 'SHORT' | 'MEDIUM' | 'LONG' | 'UNKNOWN';
export type SentenceShape = 'SHORT_BURSTS' | 'DEVELOPED' | 'UNKNOWN';
export type PunctuationStyle = 'MINIMAL' | 'STANDARD' | 'EXPRESSIVE' | 'UNKNOWN';
export type EmojiLevel = 'NONE' | 'LOW' | 'HIGH' | 'UNKNOWN';
export type Energy = 'SOBER' | 'RELAXED' | 'ENTHUSIASTIC' | 'UNKNOWN';
export type Directness = 'DIRECT' | 'MEASURED' | 'UNKNOWN';
export type VocabularyLevel = 'PLAIN' | 'TECHNICAL' | 'UNKNOWN';
export type AbbreviationUse = 'NONE' | 'SOME' | 'HEAVY' | 'UNKNOWN';
export type ConversationRhythm = 'SINGLE_BURST' | 'MULTI_BURST' | 'UNKNOWN';

/**
 * La confiance globale.
 *
 * Elle ne dit pas « le profil est juste », elle dit « il y a assez de matière
 * pour s'en servir ». `LOW` n'empêche jamais une réponse (§8) : elle bascule la
 * rédaction sur la voix canonique Hermes.
 */
export type StyleConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

export interface StyleProfile {
  readonly addressMode: AddressMode;
  readonly formality: Formality;
  readonly avgLength: LengthBand;
  readonly sentenceShape: SentenceShape;
  readonly punctuation: PunctuationStyle;
  readonly emojiLevel: EmojiLevel;
  readonly energy: Energy;
  readonly directness: Directness;
  readonly vocabulary: VocabularyLevel;
  readonly abbreviations: AbbreviationUse;
  readonly rhythm: ConversationRhythm;
  readonly confidence: StyleConfidence;
  /** Combien de messages ont été observés. Un compteur, pas un contenu. */
  readonly observedMessages: number;
  /** Combien de caractères au total. Sert à expliquer la confiance. */
  readonly observedChars: number;
}

/**
 * Le profil vide.
 *
 * Ce n'est pas un profil « neutre » : c'est l'aveu qu'on n'a rien observé. Il
 * est rendu tel quel quand le corpus est vide, et il est SÛR — chaque dimension
 * y vaut `UNKNOWN`, donc la rédaction retombe intégralement sur la voix
 * canonique.
 */
export const EMPTY_STYLE_PROFILE: StyleProfile = Object.freeze({
  addressMode: 'UNKNOWN',
  formality: 'UNKNOWN',
  avgLength: 'UNKNOWN',
  sentenceShape: 'UNKNOWN',
  punctuation: 'UNKNOWN',
  emojiLevel: 'UNKNOWN',
  energy: 'UNKNOWN',
  directness: 'UNKNOWN',
  vocabulary: 'UNKNOWN',
  abbreviations: 'UNKNOWN',
  rhythm: 'UNKNOWN',
  confidence: 'LOW',
  observedMessages: 0,
  observedChars: 0,
});

/** Un message observé, réduit à ce dont le profileur a besoin. */
export interface StyleSample {
  readonly text: string;
  /** ISO 8601. Sert au rythme (rafales), jamais au contenu. */
  readonly at: string;
}

// ---------------------------------------------------------------------------
// Seuils d'évidence
// ---------------------------------------------------------------------------

/**
 * En dessous, une dimension « négative » (aucun emoji, pas d'abréviation, style
 * simple) n'est pas observable : c'est une absence non vérifiée.
 *
 * 80 caractères plutôt qu'un nombre de messages : deux « ok » consécutifs ne
 * prouvent pas plus qu'un seul, tandis qu'un message de trois lignes sans
 * emoji est déjà une observation.
 */
const MIN_CHARS_FOR_NEGATIVE_CLAIM = 80;

/** Idem pour deux messages : une habitude demande une répétition. */
const MIN_MESSAGES_FOR_HABIT = 2;

const MEDIUM_CONFIDENCE_MESSAGES = 2;
const MEDIUM_CONFIDENCE_CHARS = 60;
const HIGH_CONFIDENCE_MESSAGES = 4;
const HIGH_CONFIDENCE_CHARS = 160;

/** Deux messages séparés de moins de deux minutes forment une rafale. */
const BURST_WINDOW_MS = 120_000;

// ---------------------------------------------------------------------------
// Lexiques d'observation
// ---------------------------------------------------------------------------

/**
 * Marqueurs de tutoiement. Volontairement étroits : `ton`, `ta` et `tes` sont
 * ambigus en français (« ton de la voix »), donc exclus. Mieux vaut rendre
 * `UNKNOWN` que trancher sur un homographe.
 *
 * R1.1 ajoute `te` et l'élision `t'…`. Ils manquaient, et l'oubli ne se voyait
 * pas tant que la fonction ne servait qu'à profiler quelqu'un d'autre : elle
 * relit maintenant NOS brouillons, où « et ça te ramène des clients ? » est un
 * tutoiement franc qu'aucun marqueur ne voyait. En français, `t'` n'élide que
 * `te`, `tu` ou `toi` — il n'y a pas d'homographe à craindre ici.
 */
const TU_MARKERS =
  /\b(tu|toi|te|t'as|t'es|t'avais|tutoie|tutoyer)\b|\bt'[a-zà-öø-ÿ]{2,}|\bton\s+(agence|business|équipe|site|budget|offre)\b/i;

const VOUS_MARKERS = /\b(vous|votre|vos|vous-même)\b/i;

const FORMAL_MARKERS =
  /\b(cordialement|bien à vous|sincères salutations|madame|monsieur|je vous prie|veuillez|dans l'attente|respectueusement)\b/i;

const CASUAL_MARKERS =
  /\b(salut|slt|yo|coucou|hey|ouais|ouai|nickel|carrément|grave|franchement|du coup|tranquille|cool)\b/i;

const HEDGE_MARKERS =
  /\b(peut-être|éventuellement|je pense|il me semble|si possible|a priori|sans doute|éventuel|je suppose|en principe)\b/i;

/**
 * Jargon du domaine. Sa présence est une observation ; son absence, sous le
 * seuil, n'en est pas une.
 */
const TECHNICAL_MARKERS =
  /\b(roas|cpm|cpa|cpc|ctr|tunnel|funnel|conversion|conversions|retargeting|ciblage|audience|pixel|seo|sea|landing|lead|leads|kpi|acquisition|scaling|ltv|panier moyen)\b/i;

/** Abréviations courantes du français écrit rapide. */
const ABBREVIATION_MARKERS =
  /\b(pk|pkoi|pcq|prq|bcp|svp|stp|tkt|jsp|mdr|ptdr|cad|càd|rdv|dispo|nn|qd|ct|tjs|tjrs|auj|slt|bjr|bsr|jpp|dsl|nrml)\b/i;

const ENTHUSIASM_MARKERS =
  /\b(super|génial|top|parfait|excellent|hâte|impeccable|nickel|avec plaisir|volontiers|carrément)\b/i;

/**
 * Emoji au sens large : pictogrammes, symboles, drapeaux, emoticônes ASCII
 * usuelles. On compte des occurrences, on n'en conserve aucune.
 */
const EMOJI_PATTERN =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]|:\)|:-\)|;\)|:D\b|xD\b/gu;

// ---------------------------------------------------------------------------
// Le profileur
// ---------------------------------------------------------------------------

function countMatches(text: string, pattern: RegExp): number {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return text.match(global)?.length ?? 0;
}

/**
 * Compte les emojis d'un texte. N'en conserve aucun.
 *
 * Exportée pour que le contrôle de naturalité plafonne NOTRE usage avec le même
 * motif que celui qui observe le leur — sans quoi « au plus un emoji » pourrait
 * vouloir dire deux choses selon le fichier qui le vérifie.
 */
export function countEmojis(text: string): number {
  return countMatches(normalizeForMatching(text), EMOJI_PATTERN);
}

/**
 * Lit le registre tu/vous d'un texte isolé.
 *
 * Même arbitrage qu'au profil : à égalité de marqueurs, on rend `UNKNOWN`. Sert
 * aussi à relire NOS brouillons, où l'enjeu est symétrique — vouvoyer qui
 * tutoie est aussi visible que l'inverse.
 */
export function detectAddressMode(text: string): AddressMode {
  const normalized = normalizeForMatching(text);
  const tu = countMatches(normalized, TU_MARKERS);
  const vous = countMatches(normalized, VOUS_MARKERS);
  if (tu === vous) return 'UNKNOWN';
  return tu > vous ? 'TU' : 'VOUS';
}

/**
 * HERMES-CONTACT-PURPOSE-R1 — le registre du DERNIER tour explicite.
 *
 * Ce que cette fonction remplace : un comptage global sur tout le corpus
 * entrant, aplati en une seule chaîne. Cela lisait le registre le plus
 * FRÉQUENT, ce qui n'est pas la question — la question est celui que la
 * personne emploie MAINTENANT.
 *
 * L'écart est petit et il coûte cher. Quelqu'un qui vouvoie trois fois puis
 * passe au tutoiement dit quelque chose de net : il vient de rapprocher la
 * conversation. Le comptage global rendait encore `VOUS` (3 contre 1), la
 * consigne demandait de vouvoyer, et la réponse répondait « vous » à un « tu ».
 * C'est visible en une seconde par l'intéressé, et c'est le genre de détail
 * qui fait dire « ce truc est automatique ».
 *
 * La règle est donc : **le dernier message qui tranche, tranche.** On remonte
 * du plus récent au plus ancien et on s'arrête au premier message dont le
 * registre est lisible pour lui-même.
 *
 * Ce qui ne bascule PAS, et c'est la moitié qui compte :
 *
 *   * un message AMBIGU ne renverse rien. `detectAddressMode` rend `UNKNOWN` à
 *     égalité de marqueurs — zéro contre zéro compris — et on passe alors au
 *     message précédent. Le registre DÉJÀ ÉTABLI est donc conservé, ce qui est
 *     le comportement fail-closed attendu : on ne change de registre que sur
 *     une preuve, jamais sur une absence ;
 *
 *   * un corpus sans le moindre marqueur reste `UNKNOWN`, exactement comme
 *     avant, et la voix canonique reprend le terrain (§8).
 *
 * Le corpus reste celui des messages ENTRANTS : nos propres tours n'y entrent
 * pas, sans quoi notre vouvoiement d'hier écraserait leur tutoiement d'après.
 */
export function resolveAddressMode(texts: readonly string[]): AddressMode {
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const mode = detectAddressMode(texts[index] ?? '');
    if (mode !== 'UNKNOWN') return mode;
  }
  return 'UNKNOWN';
}

export interface AddressMarkerCounts {
  readonly tu: number;
  readonly vous: number;
}

/**
 * Les marqueurs de registre, comptés séparément.
 *
 * `detectAddressMode` rend `UNKNOWN` à égalité, ce qui est le bon arbitrage
 * pour LIRE un correspondant — on ne sait pas, on ne parie pas. Ce n'est pas le
 * bon arbitrage pour relire NOTRE texte : un premier message qui vouvoie puis
 * tutoie n'est pas « indéterminé », il est incohérent, et il faut voir les deux
 * compteurs pour le dire. Même motif, deux lectures.
 */
export function countAddressMarkers(text: string): AddressMarkerCounts {
  const normalized = normalizeForMatching(text);
  return Object.freeze({
    tu: countMatches(normalized, TU_MARKERS),
    vous: countMatches(normalized, VOUS_MARKERS),
  });
}

function bandForLength(mean: number): LengthBand {
  if (mean <= 25) return 'VERY_SHORT';
  if (mean <= 90) return 'SHORT';
  if (mean <= 260) return 'MEDIUM';
  return 'LONG';
}

/**
 * Découpe naïve en phrases. Sert à mesurer un rythme, pas à comprendre.
 *
 * Exportée depuis R1.1 : le contrôle de naturalité mesure NOS brouillons avec
 * exactement la même règle que celle qui lit les messages d'en face. Deux
 * découpes différentes rendraient « ils ont écrit une phrase, on en a écrit
 * trois » incomparable, donc faux.
 */
export function countSentences(text: string): number {
  const parts = text
    .split(/[.!?…]+|\n+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return Math.max(1, parts.length);
}

export function countWords(text: string): number {
  return text.split(/\s+/u).filter((word) => word.length > 0).length;
}

function resolveConfidence(messages: number, chars: number): StyleConfidence {
  if (messages >= HIGH_CONFIDENCE_MESSAGES && chars >= HIGH_CONFIDENCE_CHARS) return 'HIGH';
  if (messages >= MEDIUM_CONFIDENCE_MESSAGES && chars >= MEDIUM_CONFIDENCE_CHARS) return 'MEDIUM';
  return 'LOW';
}

/**
 * Construit le profil.
 *
 * Ne lève jamais : un corpus vide, illisible ou fait de trois emojis reste une
 * entrée valide — elle produit simplement beaucoup d'`UNKNOWN`.
 */
export function buildStyleProfile(samples: readonly StyleSample[]): StyleProfile {
  const texts = samples.map((sample) => sample.text.trim()).filter((text) => text.length > 0);
  if (texts.length === 0) return EMPTY_STYLE_PROFILE;

  // Même raison qu'ailleurs : « t'as » et « t’as » sont le même mot.
  const joined = normalizeForMatching(texts.join('\n'));
  const totalChars = texts.reduce((sum, text) => sum + text.length, 0);
  const meanChars = totalChars / texts.length;
  const enoughForNegative = totalChars >= MIN_CHARS_FOR_NEGATIVE_CLAIM;
  const enoughForHabit = texts.length >= MIN_MESSAGES_FOR_HABIT;

  // --- tu / vous ---------------------------------------------------------
  // Le DERNIER message qui tranche, tranche (`resolveAddressMode`). Le comptage
  // global qui vivait ici lisait le registre le plus fréquent, pas le registre
  // courant : quelqu'un qui vouvoie trois fois puis tutoie se voyait encore
  // vouvoyer. Un message ambigu ne renverse rien et laisse en place le registre
  // déjà établi.
  const addressMode: AddressMode = resolveAddressMode(texts);

  // --- emojis ------------------------------------------------------------
  const emojiHits = countMatches(joined, EMOJI_PATTERN);
  const emojiPerMessage = emojiHits / texts.length;
  const emojiLevel: EmojiLevel =
    emojiPerMessage >= 1.5 ? 'HIGH' : emojiHits > 0 ? 'LOW' : enoughForNegative ? 'NONE' : 'UNKNOWN';

  // --- ponctuation -------------------------------------------------------
  const expressive = /[!?]{2,}|…|\.{3,}|!\s|!$/u.test(joined);
  const anyTerminal = /[.!?…]/u.test(joined);
  const punctuation: PunctuationStyle = expressive
    ? 'EXPRESSIVE'
    : anyTerminal
      ? 'STANDARD'
      : enoughForHabit || enoughForNegative
        ? 'MINIMAL'
        : 'UNKNOWN';

  // --- formalité ---------------------------------------------------------
  const formalHits = countMatches(joined, FORMAL_MARKERS);
  const casualHits = countMatches(joined, CASUAL_MARKERS);
  let formality: Formality = 'UNKNOWN';
  if (formalHits > casualHits) formality = 'FORMAL';
  else if (casualHits > formalHits) formality = 'CASUAL';
  else if (addressMode === 'TU') formality = 'CASUAL';
  else if (addressMode === 'VOUS' && enoughForNegative) formality = 'NEUTRAL';

  // --- vocabulaire -------------------------------------------------------
  const technicalHits = countMatches(joined, TECHNICAL_MARKERS);
  const vocabulary: VocabularyLevel =
    technicalHits > 0 ? 'TECHNICAL' : enoughForNegative ? 'PLAIN' : 'UNKNOWN';

  // --- abréviations ------------------------------------------------------
  const abbrevHits = countMatches(joined, ABBREVIATION_MARKERS);
  const abbrevPerMessage = abbrevHits / texts.length;
  const abbreviations: AbbreviationUse =
    abbrevPerMessage >= 1.5 ? 'HEAVY' : abbrevHits > 0 ? 'SOME' : enoughForNegative ? 'NONE' : 'UNKNOWN';

  // --- énergie -----------------------------------------------------------
  const enthusiasmHits = countMatches(joined, ENTHUSIASM_MARKERS);
  const exclamations = countMatches(joined, /!/u);
  let energy: Energy = 'UNKNOWN';
  if (enthusiasmHits > 0 || emojiLevel === 'HIGH' || exclamations >= 2) energy = 'ENTHUSIASTIC';
  else if (emojiLevel === 'LOW' || casualHits > 0 || exclamations === 1) energy = 'RELAXED';
  else if (enoughForNegative) energy = 'SOBER';

  // --- longueur et forme -------------------------------------------------
  const avgLength = bandForLength(meanChars);
  const meanWordsPerSentence = countWords(joined) / countSentences(joined);
  const sentenceShape: SentenceShape =
    meanWordsPerSentence <= 9 ? 'SHORT_BURSTS' : meanWordsPerSentence >= 14 ? 'DEVELOPED' : 'UNKNOWN';

  // --- directivité -------------------------------------------------------
  const hedges = countMatches(joined, HEDGE_MARKERS);
  const directness: Directness =
    hedges > 0 ? 'MEASURED' : avgLength === 'VERY_SHORT' || avgLength === 'SHORT' ? 'DIRECT' : 'UNKNOWN';

  // --- rythme ------------------------------------------------------------
  // Une rafale = deux messages rapprochés. Sans horodatage exploitable, on ne
  // conclut rien : une date illisible n'est pas une date lointaine.
  let bursts = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = Date.parse(samples[index - 1]?.at ?? '');
    const current = Date.parse(samples[index]?.at ?? '');
    if (Number.isNaN(previous) || Number.isNaN(current)) continue;
    if (current - previous <= BURST_WINDOW_MS) bursts += 1;
  }
  const rhythm: ConversationRhythm =
    bursts > 0 ? 'MULTI_BURST' : enoughForHabit ? 'SINGLE_BURST' : 'UNKNOWN';

  return Object.freeze({
    addressMode,
    formality,
    avgLength,
    sentenceShape,
    punctuation,
    emojiLevel,
    energy,
    directness,
    vocabulary,
    abbreviations,
    rhythm,
    confidence: resolveConfidence(texts.length, totalChars),
    observedMessages: texts.length,
    observedChars: totalChars,
  });
}
