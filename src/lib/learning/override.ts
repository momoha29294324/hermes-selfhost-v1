/**
 * LEARNING-R1 §6 — ce qu'un opérateur a changé, dit en ABSTRAIT.
 *
 * Le cœur de la mission tient dans une distinction que ce fichier matérialise :
 * on n'apprend pas « le texte d'un opérateur », on apprend **la transformation**
 * qu'il applique au brouillon. La différence n'est pas cosmétique.
 *
 *   * un texte appris deviendrait un gabarit, et un gabarit réécrit le même
 *     message à tout le monde — exactement ce que CONVERSATION-R1.1 a passé un
 *     round à défaire ;
 *   * une transformation apprise se rejoue sur un contexte NEUF : « il coupe
 *     l'ouverture générique » vaut pour un message qui n'a pas encore été écrit.
 *
 * D'où la forme de la sortie : une liste de codes d'énumération, plus des
 * compteurs. Aucun fragment de phrase, aucun diff brut (§6, §22). Ce qui est
 * conservé tient en trente octets et se relit dans six mois ; un diff mot à mot
 * tiendrait en trois kilo-octets et ne se relirait jamais.
 *
 * Les lexiques ne sont pas redéfinis ici. Ils sont IMPORTÉS du contrôle de
 * naturalité, parce que deux lexiques concurrents finiraient par diverger et
 * que ce serait alors le plus indulgent qui gagnerait.
 */

import {
  containsPitch,
  measureDraft,
  openingFamily,
  proposesCall,
  containsCorporateJargon,
  type DraftMetrics,
} from '@/lib/conversation/naturalness';
import { concreteAnchors } from '@/lib/conversation/naturalness';
import { detectAddressMode } from '@/lib/conversation/style';

/**
 * Les transformations reconnues.
 *
 * Elles vont par paires opposées, et c'est délibéré : un système qui ne saurait
 * détecter que « plus court » apprendrait qu'un opérateur raccourcit toujours,
 * puisqu'il n'aurait pas le vocabulaire pour observer le contraire. Une boucle
 * d'apprentissage qui ne peut pas se contredire ne mesure rien.
 */
export type OverrideDelta =
  | 'SHORTER'
  | 'LONGER'
  | 'QUESTIONS_REMOVED'
  | 'QUESTIONS_ADDED'
  | 'GENERIC_OPENING_REMOVED'
  | 'GENERIC_OPENING_ADDED'
  | 'PITCH_REMOVED'
  | 'PITCH_ADDED'
  | 'CTA_REMOVED'
  | 'CTA_ADDED'
  | 'VOCABULARY_SIMPLIFIED'
  | 'VOCABULARY_ENRICHED'
  | 'ADDRESS_MODE_TO_TU'
  | 'ADDRESS_MODE_TO_VOUS'
  | 'EMOJI_ADDED'
  | 'EMOJI_REMOVED'
  | 'CONCRETE_DETAIL_ADDED'
  | 'CONCRETE_DETAIL_REMOVED'
  | 'STRUCTURE_SHORTENED'
  | 'STRUCTURE_EXPANDED';

export const OVERRIDE_DELTAS: readonly OverrideDelta[] = Object.freeze([
  'SHORTER',
  'LONGER',
  'QUESTIONS_REMOVED',
  'QUESTIONS_ADDED',
  'GENERIC_OPENING_REMOVED',
  'GENERIC_OPENING_ADDED',
  'PITCH_REMOVED',
  'PITCH_ADDED',
  'CTA_REMOVED',
  'CTA_ADDED',
  'VOCABULARY_SIMPLIFIED',
  'VOCABULARY_ENRICHED',
  'ADDRESS_MODE_TO_TU',
  'ADDRESS_MODE_TO_VOUS',
  'EMOJI_ADDED',
  'EMOJI_REMOVED',
  'CONCRETE_DETAIL_ADDED',
  'CONCRETE_DETAIL_REMOVED',
  'STRUCTURE_SHORTENED',
  'STRUCTURE_EXPANDED',
]);

/**
 * Le bruit sous lequel une différence de longueur n'en est pas une.
 *
 * Dix pour cent : réécrire « je vous propose » en « je propose » raccourcit de
 * quelques caractères sans rien dire d'une préférence. Sans ce plancher, le
 * profil de style se remplirait de `SHORTER` qui ne signifient que « il a
 * retouché une phrase ».
 */
export const LENGTH_NOISE_RATIO = 0.1;

export interface OverrideComparison {
  /** Les transformations observées. Ordre stable : celui de `OVERRIDE_DELTAS`. */
  readonly deltas: readonly OverrideDelta[];
  readonly draft: DraftMetrics;
  readonly sent: DraftMetrics;
  /** Rapport de longueur, sent/draft. 1 = même longueur. */
  readonly lengthRatio: number;
  /** Vrai quand rien de reconnaissable n'a changé — une retouche de surface. */
  readonly cosmeticOnly: boolean;
}

function push(list: OverrideDelta[], delta: OverrideDelta): void {
  if (!list.includes(delta)) list.push(delta);
}

/**
 * Compare un brouillon et le texte réellement retenu.
 *
 * Fonction pure, sans modèle : CLAUDE.md impose que la logique décidable soit
 * du code testé, et « le message final compte-t-il moins de questions » est
 * décidable. Elle ne rend jamais d'exception : deux textes vides produisent une
 * comparaison vide, pas une erreur.
 */
export function compareOverride(draftBody: string, sentBody: string): OverrideComparison {
  const draft = measureDraft(draftBody);
  const sent = measureDraft(sentBody);
  const deltas: OverrideDelta[] = [];

  // --- longueur -----------------------------------------------------------
  const ratio = draft.chars === 0 ? 1 : sent.chars / draft.chars;
  if (ratio <= 1 - LENGTH_NOISE_RATIO) push(deltas, 'SHORTER');
  else if (ratio >= 1 + LENGTH_NOISE_RATIO) push(deltas, 'LONGER');

  // --- structure ----------------------------------------------------------
  if (sent.sentences < draft.sentences) push(deltas, 'STRUCTURE_SHORTENED');
  else if (sent.sentences > draft.sentences) push(deltas, 'STRUCTURE_EXPANDED');

  // --- questions ----------------------------------------------------------
  if (sent.questions < draft.questions) push(deltas, 'QUESTIONS_REMOVED');
  else if (sent.questions > draft.questions) push(deltas, 'QUESTIONS_ADDED');

  // --- ouverture générique ------------------------------------------------
  const draftOpening = openingFamily(draftBody);
  const sentOpening = openingFamily(sentBody);
  if (draftOpening !== null && sentOpening === null) push(deltas, 'GENERIC_OPENING_REMOVED');
  else if (draftOpening === null && sentOpening !== null) push(deltas, 'GENERIC_OPENING_ADDED');

  // --- argumentaire -------------------------------------------------------
  const draftPitch = containsPitch(draftBody);
  const sentPitch = containsPitch(sentBody);
  if (draftPitch && !sentPitch) push(deltas, 'PITCH_REMOVED');
  else if (!draftPitch && sentPitch) push(deltas, 'PITCH_ADDED');

  // --- proposition d'échange ---------------------------------------------
  const draftCall = proposesCall(draftBody);
  const sentCall = proposesCall(sentBody);
  if (draftCall && !sentCall) push(deltas, 'CTA_REMOVED');
  else if (!draftCall && sentCall) push(deltas, 'CTA_ADDED');

  // --- registre -----------------------------------------------------------
  // « Vocabulaire simplifié » se lit sur le jargon de plaquette, pas sur la
  // longueur des mots : raccourcir un texte n'est pas le simplifier, et un
  // compteur de syllabes classerait « acquisition » comme un mot difficile
  // dans un métier où c'est le mot juste.
  const draftJargon = containsCorporateJargon(draftBody);
  const sentJargon = containsCorporateJargon(sentBody);
  if (draftJargon && !sentJargon) push(deltas, 'VOCABULARY_SIMPLIFIED');
  else if (!draftJargon && sentJargon) push(deltas, 'VOCABULARY_ENRICHED');

  // --- tutoiement ---------------------------------------------------------
  const draftAddress = detectAddressMode(draftBody);
  const sentAddress = detectAddressMode(sentBody);
  if (draftAddress === 'VOUS' && sentAddress === 'TU') push(deltas, 'ADDRESS_MODE_TO_TU');
  else if (draftAddress === 'TU' && sentAddress === 'VOUS') push(deltas, 'ADDRESS_MODE_TO_VOUS');

  // --- emoji --------------------------------------------------------------
  if (sent.emojis > draft.emojis) push(deltas, 'EMOJI_ADDED');
  else if (sent.emojis < draft.emojis) push(deltas, 'EMOJI_REMOVED');

  // --- détail concret -----------------------------------------------------
  // Les ancres sont les mots porteurs du texte. En gagner prouve qu'un élément
  // précis a été ajouté ; en perdre, qu'une généralité a remplacé un détail.
  const draftAnchors = new Set(concreteAnchors(draftBody));
  const sentAnchors = new Set(concreteAnchors(sentBody));
  const added = [...sentAnchors].filter((anchor) => !draftAnchors.has(anchor));
  const removed = [...draftAnchors].filter((anchor) => !sentAnchors.has(anchor));
  if (added.length > removed.length) push(deltas, 'CONCRETE_DETAIL_ADDED');
  else if (removed.length > added.length) push(deltas, 'CONCRETE_DETAIL_REMOVED');

  const ordered = OVERRIDE_DELTAS.filter((delta) => deltas.includes(delta));

  return Object.freeze({
    deltas: Object.freeze(ordered),
    draft,
    sent,
    lengthRatio: ratio,
    cosmeticOnly: ordered.length === 0,
  });
}
