/**
 * LEARNING-R1 §10, §16 (du gate) — les features D'AVANT l'envoi, et rien d'autre.
 *
 * Une boucle d'apprentissage sur le ciblage se trompe d'une seule façon
 * intéressante : elle regarde une donnée écrite APRÈS l'envoi et croit qu'elle
 * prédisait le résultat. « Les prospects dont l'état vaut INTERESTED répondent
 * mieux » est une tautologie parfaite, et un rapport qui la produit a l'air
 * d'avoir trouvé quelque chose.
 *
 * D'où le seul mécanisme du fichier : `latestBefore`. Toute feature est lue
 * comme « la dernière valeur écrite au plus tard à l'instant de l'envoi ». La
 * date de coupure est celle de l'`outreach_event` — un fait, pas un paramètre.
 * Ce n'est pas une discipline de requête : la fonction est pure, elle est
 * testée isolément, et rien ici ne lit `prospects.score` (colonne MUTABLE, dont
 * la valeur d'aujourd'hui ne dit rien de celle d'hier) alors que
 * `prospect_scores` porte des lignes horodatées qui, elles, le disent.
 *
 * Aucune feature n'est inventée. Une source absente vaut `null` — pas « false »,
 * pas « faible », pas une valeur plausible (CLAUDE.md §2).
 */

import { containsPitch, proposesCall } from '@/lib/conversation/naturalness';
import { normalizeForMatching } from '@/lib/conversation/text';

// ---------------------------------------------------------------------------
// La primitive anti-fuite
// ---------------------------------------------------------------------------

export interface TimestampedValue<T> {
  /** ISO 8601. L'instant où la ligne a été écrite. */
  readonly at: string;
  readonly value: T;
}

/**
 * La dernière valeur écrite au plus tard à la coupure.
 *
 * Rend `null` quand aucune ligne n'est antérieure — c'est-à-dire quand la
 * feature n'existait pas au moment où le message est parti. Ce `null` est une
 * information : il dit qu'on a envoyé sans savoir, ce qui est précisément le
 * genre de chose qu'un rapport de ciblage doit pouvoir montrer.
 */
export function latestBefore<T>(rows: readonly TimestampedValue<T>[], cutoffIso: string): T | null {
  const cutoff = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoff)) return null;
  let best: TimestampedValue<T> | null = null;
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || at > cutoff) continue;
    if (best === null || Date.parse(best.at) <= at) best = row;
  }
  return best === null ? null : best.value;
}

// ---------------------------------------------------------------------------
// Les buckets d'audience
// ---------------------------------------------------------------------------

/**
 * Des tranches de LECTURE, pas un seuil d'éligibilité.
 *
 * §11 interdit de toucher au seuil d'audience, et rien ici ne le touche :
 * ces bornes servent à grouper des lignes dans un tableau, elles n'entrent dans
 * aucune décision d'envoi et ne sont lues par aucun rail. Les nommer ici plutôt
 * que de réutiliser un seuil de politique évite justement qu'un ajustement de
 * rapport ressemble un jour à un ajustement de politique.
 */
export type AudienceBucket = 'UNDER_500' | 'FROM_500_TO_2K' | 'FROM_2K_TO_10K' | 'OVER_10K';

export function audienceBucketOf(followers: number | null): AudienceBucket | null {
  if (followers === null) return null;
  if (followers < 500) return 'UNDER_500';
  if (followers < 2_000) return 'FROM_500_TO_2K';
  if (followers < 10_000) return 'FROM_2K_TO_10K';
  return 'OVER_10K';
}

// ---------------------------------------------------------------------------
// La famille de message
// ---------------------------------------------------------------------------

/**
 * De quelle FAMILLE relève le message réellement parti.
 *
 * Dérivée du texte approuvé — figé, verrouillé avant l'envoi, donc sans risque
 * de fuite. Le `hook_type` du manifeste n'est pas utilisé : c'est une phrase
 * libre écrite par un modèle, différente à chaque prospect, donc impossible à
 * grouper. Ce qu'on veut comparer, c'est la FORME du message ; elle se lit dans
 * le message.
 *
 * L'ordre des tests est une priorité, pas une liste : un message qui cite une
 * preuve ET pose une question est d'abord un message à preuve, parce que c'est
 * la preuve qui change la réaction.
 */
export type MessageFamily = 'PROOF_LED' | 'CALL_LED' | 'PITCH_LED' | 'QUESTION_OPENER' | 'PLAIN';

/** L'unique preuve chiffrée autorisée par CLAUDE.md, reconnue telle quelle. */
const PROOF_PATTERN = /\b(3\s?500|3500)\s?€|\bnous avons d[ée]j[àa] g[ée]n[ée]r[ée]\b/i;

export function messageFamilyOf(approvedText: string | null): MessageFamily | null {
  // Pas de texte approuvé, pas de famille. Rendre `PLAIN` sur une absence
  // rangerait dans le même groupe « message sans rien de particulier » et
  // « message qu'on n'a pas su relire » — deux populations différentes.
  if (approvedText === null || approvedText.trim().length === 0) return null;
  const normalized = normalizeForMatching(approvedText);
  if (PROOF_PATTERN.test(normalized)) return 'PROOF_LED';
  if (proposesCall(approvedText)) return 'CALL_LED';
  if (containsPitch(approvedText)) return 'PITCH_LED';
  if (/\?/.test(approvedText)) return 'QUESTION_OPENER';
  return 'PLAIN';
}

// ---------------------------------------------------------------------------
// Les features
// ---------------------------------------------------------------------------

/**
 * Ce qu'on savait d'un prospect à l'instant où le message est parti.
 *
 * Chaque champ est soit une valeur observée, soit `null`. Il n'y a pas de
 * troisième cas, et surtout pas de valeur par défaut : « pas de site » et « on
 * n'a pas regardé » sont deux faits différents, et le second ne doit pas se
 * déguiser en premier.
 */
export interface PreSendFeatures {
  readonly prospectId: string;
  /** La coupure. Toute feature lui est antérieure ou égale. */
  readonly sentAt: string;
  readonly channel: string;
  readonly score: number | null;
  readonly scoreBand: string | null;
  readonly followers: number | null;
  readonly audienceBucket: AudienceBucket | null;
  /** Observé via une ligne `prospect_evidence`, pas via une colonne mutable. */
  readonly websitePresence: boolean | null;
  readonly googlePresence: boolean | null;
  readonly icpVerdict: string | null;
  readonly nicheVerdict: string | null;
  readonly identityReview: string | null;
  /** Un angle avait-il été calculé avant l'envoi ? */
  readonly hasAngle: boolean;
  readonly messageFamily: MessageFamily | null;
  readonly niche: string | null;
  readonly zone: string | null;
}

export interface FeatureSources {
  readonly prospectId: string;
  readonly sentAt: string;
  readonly channel: string;
  readonly approvedText: string | null;
  readonly scores: readonly TimestampedValue<{ total: number | null; band: string | null }>[];
  readonly audience: readonly TimestampedValue<{ followers: number | null }>[];
  readonly icp: readonly TimestampedValue<{ verdict: string }>[];
  readonly classifications: readonly TimestampedValue<{ verdict: string }>[];
  readonly angles: readonly TimestampedValue<{ present: true }>[];
  /** Les champs `prospect_evidence` observés, horodatés. */
  readonly evidenceFields: readonly TimestampedValue<{ field: string }>[];
  readonly identityReview: string | null;
  readonly niche: string | null;
  readonly zone: string | null;
}

/**
 * Les champs d'evidence qui PROUVENT une présence.
 *
 * Une présence Google se prouve par un `google_place_id` observé, pas par une
 * note ou un nombre d'avis — ceux-là peuvent exister sans que la fiche ait été
 * réellement rattachée. La liste est courte à dessein.
 */
const WEBSITE_EVIDENCE_FIELDS = new Set(['website_url', 'domain']);
const GOOGLE_EVIDENCE_FIELDS = new Set(['google_place_id']);

function presenceBefore(
  fields: readonly TimestampedValue<{ field: string }>[],
  cutoffIso: string,
  wanted: ReadonlySet<string>,
): boolean | null {
  const cutoff = Date.parse(cutoffIso);
  if (!Number.isFinite(cutoff)) return null;
  const before = fields.filter((row) => {
    const at = Date.parse(row.at);
    return Number.isFinite(at) && at <= cutoff;
  });
  // Aucune evidence antérieure du tout : on n'a rien regardé, donc on ne sait
  // pas. Répondre `false` ici serait affirmer une absence non vérifiée.
  if (before.length === 0) return null;
  return before.some((row) => wanted.has(row.value.field));
}

/** Assemble les features. Aucune lecture de base : la fonction est pure. */
export function buildPreSendFeatures(sources: FeatureSources): PreSendFeatures {
  const score = latestBefore(sources.scores, sources.sentAt);
  const audience = latestBefore(sources.audience, sources.sentAt);
  const icp = latestBefore(sources.icp, sources.sentAt);
  const classification = latestBefore(sources.classifications, sources.sentAt);
  const angle = latestBefore(sources.angles, sources.sentAt);
  const followers = audience?.followers ?? null;

  return Object.freeze({
    prospectId: sources.prospectId,
    sentAt: sources.sentAt,
    channel: sources.channel,
    score: score?.total ?? null,
    scoreBand: score?.band ?? null,
    followers,
    audienceBucket: audienceBucketOf(followers),
    websitePresence: presenceBefore(sources.evidenceFields, sources.sentAt, WEBSITE_EVIDENCE_FIELDS),
    googlePresence: presenceBefore(sources.evidenceFields, sources.sentAt, GOOGLE_EVIDENCE_FIELDS),
    icpVerdict: icp?.verdict ?? null,
    nicheVerdict: classification?.verdict ?? null,
    identityReview: sources.identityReview,
    hasAngle: angle !== null,
    messageFamily: messageFamilyOf(sources.approvedText),
    niche: sources.niche,
    zone: sources.zone,
  });
}

// ---------------------------------------------------------------------------
// Les axes de segmentation
// ---------------------------------------------------------------------------

/** Les axes qu'un rapport sait croiser avec une issue. */
export const SEGMENT_KEYS = [
  'channel',
  'scoreBand',
  'audienceBucket',
  'websitePresence',
  'googlePresence',
  'icpVerdict',
  'messageFamily',
  'niche',
  'zone',
] as const;

export type SegmentKey = (typeof SEGMENT_KEYS)[number];

/**
 * La valeur d'un axe, sous forme de libellé.
 *
 * `null` reste `null` et devient le libellé `UNKNOWN` : un prospect dont on
 * ignorait le site au moment de l'envoi appartient à un groupe réel — celui des
 * prospects contactés sans cette information — et l'effacer ferait disparaître
 * la moitié du corpus des tableaux.
 */
export function segmentValue(features: PreSendFeatures, key: SegmentKey): string {
  switch (key) {
    case 'channel':
      return features.channel;
    case 'scoreBand':
      return features.scoreBand ?? 'UNKNOWN';
    case 'audienceBucket':
      return features.audienceBucket ?? 'UNKNOWN';
    case 'websitePresence':
      return features.websitePresence === null ? 'UNKNOWN' : features.websitePresence ? 'YES' : 'NO';
    case 'googlePresence':
      return features.googlePresence === null ? 'UNKNOWN' : features.googlePresence ? 'YES' : 'NO';
    case 'icpVerdict':
      return features.icpVerdict ?? 'UNKNOWN';
    case 'messageFamily':
      return features.messageFamily ?? 'UNKNOWN';
    case 'niche':
      return features.niche ?? 'UNKNOWN';
    case 'zone':
      return features.zone ?? 'UNKNOWN';
  }
}
