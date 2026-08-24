import {
  isPlatformDomain,
  nameSimilarity,
  normalizeCity,
  normalizeDomain,
  normalizeEmail,
  normalizeFacebookUrl,
  normalizeInstagramHandle,
  normalizeName,
  normalizePhone,
  normalizeRegistryId,
} from '@/lib/identity/normalize';
import { haversineKm } from '@/lib/geo/geo';

export type IdentityKind =
  | 'registry_id'
  | 'domain'
  | 'email'
  | 'phone'
  | 'instagram'
  | 'facebook'
  | 'google_place_id'
  | 'name_city';

export interface IdentityKey {
  kind: IdentityKind;
  value: string;
  /** How much this key alone proves "same business". 1.0 = decisive. */
  weight: number;
}

/** Keys that, on their own, are considered proof of the same business. */
export const DECISIVE_KINDS: ReadonlySet<IdentityKind> = new Set([
  'registry_id',
  'domain',
  'google_place_id',
  'instagram',
  'email',
]);

export interface IdentityInput {
  name?: string | null;
  brandName?: string | null;
  legalName?: string | null;
  registryId?: string | null;
  domain?: string | null;
  websiteUrl?: string | null;
  email?: string | null;
  phone?: string | null;
  instagramHandle?: string | null;
  facebookUrl?: string | null;
  googlePlaceId?: string | null;
  city?: string | null;
  postalCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export function identityKeys(input: IdentityInput): IdentityKey[] {
  const keys: IdentityKey[] = [];
  const push = (kind: IdentityKind, value: string | null, weight: number): void => {
    if (!value) return;
    if (keys.some((k) => k.kind === kind && k.value === value)) return;
    keys.push({ kind, value, weight });
  };

  push('registry_id', normalizeRegistryId(input.registryId), 1);

  const domain = normalizeDomain(input.domain ?? input.websiteUrl ?? null);
  if (domain && !isPlatformDomain(domain)) push('domain', domain, 0.95);

  push('email', normalizeEmail(input.email), 0.9);
  push('phone', normalizePhone(input.phone), 0.8);
  push('instagram', normalizeInstagramHandle(input.instagramHandle), 0.9);

  const facebook = normalizeFacebookUrl(input.facebookUrl);
  if (facebook) push('facebook', facebook.toLowerCase(), 0.8);

  push('google_place_id', input.googlePlaceId ?? null, 1);

  const name = normalizeName(input.brandName ?? input.name ?? input.legalName ?? null);
  const city = normalizeCity(input.city);
  if (name && (city || input.postalCode)) {
    push('name_city', `${name}|${city || input.postalCode}`, 0.55);
  }

  return keys;
}

/** The identity used as the prospect's canonical_key, strongest first. */
export function canonicalKey(keys: IdentityKey[], fallback: string): string {
  const order: IdentityKind[] = [
    'registry_id',
    'google_place_id',
    'domain',
    'instagram',
    'email',
    'phone',
    'name_city',
  ];
  for (const kind of order) {
    const match = keys.find((key) => key.kind === kind);
    if (match) return `${kind}:${match.value}`;
  }
  return `raw:${fallback}`;
}

export interface FuzzyCandidate {
  id: string;
  displayName: string;
  brandName?: string | null;
  legalName?: string | null;
  city?: string | null;
  postalCode?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface SimilarityVerdict {
  decision: 'same' | 'review' | 'different';
  similarity: number;
  signals: Record<string, unknown>;
}

export const SAME_THRESHOLD = 0.92;
// Deliberately low: everything between the two thresholds becomes a review item,
// and a review item costs a click, whereas a wrong merge silently loses a prospect.
export const REVIEW_THRESHOLD = 0.66;

/**
 * Beyond this, two coordinate pairs are not the same address.
 *
 * Two kilometres is generous on purpose: registry coordinates are often the
 * declared head office rather than the workshop, and geocoders disagree by
 * hundreds of metres. What it does catch is the case that matters — two
 * genuinely different businesses that happen to share a trading name in the
 * same city.
 */
export const LOCATION_CONFLICT_KM = 2;

/**
 * True when two records carry location data that actively disagrees.
 *
 * This is not the negation of "location agrees". Missing data never
 * contradicts: a record with no postcode and no coordinates conflicts with
 * nothing, because absence is not evidence. Only two *present* and *different*
 * observations count.
 *
 * It exists because a shared name + city was, on its own, enough to merge two
 * prospects. In a registry-first corpus that was tolerable — homonyms were
 * rare. A Places-first corpus enumerates every business in a dense area, where
 * two independent "PRESTATION AUTO" in the same city is ordinary, and a wrong merge
 * silently destroys one of them.
 */
export function locationContradicts(
  a: { postalCode?: string | null; latitude?: number | null; longitude?: number | null },
  b: { postalCode?: string | null; latitude?: number | null; longitude?: number | null },
): boolean {
  if (a.postalCode && b.postalCode && a.postalCode !== b.postalCode) return true;
  const km = distanceKm(a, b);
  return km !== null && km > LOCATION_CONFLICT_KM;
}

/**
 * Fuzzy match used only when no decisive key is shared. Deliberately conservative:
 * anything between the two thresholds becomes a review item rather than a merge,
 * because a wrong merge silently destroys a prospect.
 */
export function compareFuzzy(a: IdentityInput, b: FuzzyCandidate): SimilarityVerdict {
  const nameA = a.brandName ?? a.name ?? a.legalName ?? '';
  const nameB = b.brandName ?? b.displayName ?? b.legalName ?? '';
  const nameScore = nameSimilarity(nameA, nameB);

  const cityA = normalizeCity(a.city);
  const cityB = normalizeCity(b.city);
  const sameCity = Boolean(cityA && cityB && cityA === cityB);
  const samePostal = Boolean(a.postalCode && b.postalCode && a.postalCode === b.postalCode);

  const km = distanceKm(a, b);
  const closeBy = km !== null && km <= 1;
  const signals: Record<string, unknown> = { nameScore, sameCity, samePostal, distanceKm: km };

  const locationAgrees = sameCity || samePostal || closeBy;
  if (!locationAgrees && cityA && cityB && cityA !== cityB) {
    signals['cityConflict'] = true;
  }

  const similarity = nameScore;
  if (locationContradicts(a, b)) {
    // Same name, incompatible address: two businesses, or two branches worth
    // keeping apart. Either way, never an automatic merge.
    signals['locationConflict'] = true;
    return { decision: nameScore >= REVIEW_THRESHOLD ? 'review' : 'different', similarity, signals };
  }
  if (nameScore >= SAME_THRESHOLD && locationAgrees) {
    return { decision: 'same', similarity, signals };
  }
  if (nameScore >= REVIEW_THRESHOLD && (locationAgrees || !cityA || !cityB)) {
    return { decision: 'review', similarity, signals };
  }
  return { decision: 'different', similarity, signals };
}

/** Distance helper reused by the geographic side of fuzzy matching. */
export function distanceKm(
  a: { latitude?: number | null; longitude?: number | null },
  b: { latitude?: number | null; longitude?: number | null },
): number | null {
  if (a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) {
    return null;
  }
  return haversineKm(
    { latitude: a.latitude, longitude: a.longitude },
    { latitude: b.latitude, longitude: b.longitude },
  );
}
