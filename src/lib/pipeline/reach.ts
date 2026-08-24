import type { EvidenceLike } from '@/lib/pipeline/score';
import type { ProspectRow } from '@/lib/repo/types';

/**
 * The two measurements R2 exists to move, plus the one it exists to keep
 * separate from quality.
 *
 * None of these feeds the commercial score. They answer "what can we see and
 * what can we do", not "is this a good prospect" — a distinction the mission
 * insists on, because a small excellent artisan who is hard to observe is not
 * a bad prospect, only a poorly documented one.
 *
 * All three are deterministic functions of observations. No prompt, no model.
 */

export type ContactChannel = 'email' | 'phone' | 'website' | 'instagram' | 'facebook';

/** Evidence fields that prove part of a commercial path was actually read. */
const FUNNEL_FIELDS = new Set([
  'funnel_observed',
  'funnel_not_observed',
  'cta_quality',
  'booking_system',
  'website_quality',
]);

/**
 * A crawl that read pages. Distinguishes "we looked and saw no CTA" from "we
 * never opened the site", which is the difference between an observation and a
 * gap — and the whole point of `funnel_observable`.
 */
const CRAWL_PROOF_FIELDS = new Set(['website_quality', 'cta_quality', 'funnel_observed', 'funnel_not_observed']);

export interface ReachAssessment {
  contactable: boolean;
  channels: ContactChannel[];
  funnelObservable: boolean;
  funnelSignalCount: number;
  /**
   * 0–100. How visible this business is from the outside, right now.
   * Explicitly NOT business quality: it is the observability of the business,
   * and a low value is a statement about our data, not about the company.
   */
  commercialVisibility: number;
  /** Why the visibility landed where it did, for the dashboard and the report. */
  visibilityReasons: string[];
}

export interface ReachInput {
  prospect: Pick<
    ProspectRow,
    'email' | 'phone' | 'website_url' | 'instagram_handle' | 'facebook_url' | 'google_place_id' | 'registry_id'
  >;
  evidence: EvidenceLike[];
}

/**
 * A prospect is contactable when at least one professional, publicly usable
 * channel exists. This is a measurement only — nothing in this repository sends
 * anything, and `OUTBOUND_ALLOW_SENDING` stays 0.
 */
export function contactChannels(prospect: ReachInput['prospect']): ContactChannel[] {
  const channels: ContactChannel[] = [];
  if (prospect.email) channels.push('email');
  if (prospect.phone) channels.push('phone');
  if (prospect.website_url) channels.push('website');
  if (prospect.instagram_handle) channels.push('instagram');
  if (prospect.facebook_url) channels.push('facebook');
  return channels;
}

/**
 * True only when enough of the commercial path was actually read to judge part
 * of it. A registry row carrying a SIREN and an address is not a funnel.
 *
 * The bar is deliberately "a page was read", not "a funnel signal was found":
 * a site we crawled that offers no way to book is a highly informative
 * observation, and the most interesting kind of prospect.
 */
export function funnelObservability(evidence: EvidenceLike[]): { observable: boolean; signalCount: number } {
  let crawlProof = false;
  let signalCount = 0;
  for (const item of evidence) {
    if (CRAWL_PROOF_FIELDS.has(item.field)) crawlProof = true;
    if (FUNNEL_FIELDS.has(item.field)) signalCount += 1;
  }
  return { observable: crawlProof, signalCount };
}

/**
 * Commercial visibility — how observable the business is, weighted by how much
 * each channel actually reveals about how it sells.
 *
 * A crawled website dominates because it is the only source that shows the
 * commercial path. Being listed on a map is worth a little: it proves the
 * business is findable, nothing more. Nothing here is a quality judgement, and
 * a prospect that scores 15 may still be the best one in the corpus.
 */
export function commercialVisibility(input: ReachInput): { score: number; reasons: string[] } {
  const { prospect, evidence } = input;
  const { observable } = funnelObservability(evidence);
  const reasons: string[] = [];
  let score = 0;

  if (observable) {
    score += 40;
    reasons.push('site lu : parcours commercial observable');
  } else if (prospect.website_url) {
    score += 15;
    reasons.push('site connu mais non lu');
  }

  if (prospect.instagram_handle) {
    score += 20;
    reasons.push('compte Instagram identifié');
  }
  if (prospect.facebook_url) {
    score += 10;
    reasons.push('page Facebook identifiée');
  }
  if (prospect.phone) {
    score += 10;
    reasons.push('téléphone public');
  }
  if (prospect.email) {
    score += 10;
    reasons.push('email public');
  }
  if (prospect.google_place_id) {
    score += 5;
    reasons.push('établissement référencé sur une carte');
  }
  if (prospect.registry_id) {
    score += 5;
    reasons.push('identité légale résolue');
  }

  if (reasons.length === 0) reasons.push('aucun canal observable pour l’instant');
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

export function assessReach(input: ReachInput): ReachAssessment {
  const channels = contactChannels(input.prospect);
  const funnel = funnelObservability(input.evidence);
  const visibility = commercialVisibility(input);
  return {
    contactable: channels.length > 0,
    channels,
    funnelObservable: funnel.observable,
    funnelSignalCount: funnel.signalCount,
    commercialVisibility: visibility.score,
    visibilityReasons: visibility.reasons,
  };
}

/**
 * The R2 headline: qualified AND reachable AND legible.
 *
 * "How many businesses did we find" is not the question. "How many real,
 * in-niche artisans do we understand well enough to contact intelligently" is.
 */
export function isQualifiedContactableObservable(
  prospect: Pick<ProspectRow, 'niche_verdict'> & ReachInput['prospect'],
  evidence: EvidenceLike[],
): boolean {
  if (prospect.niche_verdict !== 'in_niche') return false;
  const reach = assessReach({ prospect, evidence });
  return reach.contactable && reach.funnelObservable;
}
