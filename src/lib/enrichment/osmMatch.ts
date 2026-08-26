import { env } from '@/lib/env';
import { HttpClient } from '@/lib/http/client';
import { haversineKm } from '@/lib/geo/geo';
import {
  nameSimilarity,
  normalizeName,
  normalizeEmail,
  normalizeFacebookUrl,
  normalizeInstagramHandle,
  normalizePhone,
  normalizeUrl,
} from '@/lib/identity/normalize';
import type { Logger } from '@/lib/logging/logger';
import type { EvidenceInput } from '@/lib/repo/types';

/**
 * Looks the prospect up in OpenStreetMap around its registered address.
 *
 * The registry knows who a company is; OSM often knows how to reach it (website,
 * phone, opening hours, socials). A match is only accepted when the name is close
 * AND the point is nearby, so we never attach a neighbour's phone number.
 */
export interface OsmMatch {
  osmId: string;
  name: string;
  distanceKm: number;
  similarity: number;
  tags: Record<string, string>;
  evidence: EvidenceInput[];
  contact: {
    websiteUrl: string | null;
    phone: string | null;
    email: string | null;
    instagramHandle: string | null;
    facebookUrl: string | null;
  };
}

const MIN_SIMILARITY = 0.72;
const MAX_DISTANCE_KM = 2.5;

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * Distinctive words of a business name — the ones worth searching OSM for.
 *
 * Generic words are useless as a filter: half of any niche contains them. This
 * list holds words that distinguish nothing in ANY trade — legal forms, filler
 * nouns, marketing adjectives. It deliberately holds no trade vocabulary: this
 * edition knows nothing about a trade until an operator declares one, and a
 * word written here would be a niche wired into `src/`.
 *
 * Tokens are single words: `distinctiveTokens` splits on whitespace before
 * looking anything up, so a multi-word entry could never match.
 */
const GENERIC_TOKENS = new Set([
  'sarl', 'sasu', 'eurl', 'entreprise', 'societe', 'compagnie', 'company',
  'group', 'groupe', 'agence', 'agency', 'studio', 'atelier', 'maison',
  'service', 'services', 'center', 'centre', 'concept', 'expert', 'experts',
  'pro', 'prestation', 'prestations', 'france', 'french', 'international',
  'premium', 'prestige', 'elite', 'quality', 'qualite',
]);

export function distinctiveTokens(name: string): string[] {
  return normalizeName(name)
    .split(' ')
    .filter((token) => token.length >= 4 && !GENERIC_TOKENS.has(token))
    .slice(0, 2);
}

export interface OsmMatchOutcome {
  match: OsmMatch | null;
  /** True only when the provider itself failed, so the caller can trip a breaker. */
  providerFailed: boolean;
}

export async function matchOpenStreetMap(
  http: HttpClient,
  logger: Logger,
  prospect: { display_name: string; brand_name: string | null; latitude: number | null; longitude: number | null },
): Promise<OsmMatchOutcome> {
  if (prospect.latitude == null || prospect.longitude == null) return { match: null, providerFailed: false };

  // Search by the prospect's own distinctive words rather than sweeping every shop
  // around the point: in a city centre the broad version costs ~40s and times out,
  // while this returns in a couple of seconds and is far more precise.
  const tokens = distinctiveTokens(prospect.brand_name ?? prospect.display_name);
  if (tokens.length === 0) {
    logger.debug('osm_match.skipped', { reason: 'no_distinctive_token', name: prospect.display_name });
    return { match: null, providerFailed: false };
  }
  const pattern = tokens.map((token) => token.replace(/[^a-z0-9]/g, '')).join('|');

  const url = env('OUTBOUND_OVERPASS_URL', 'https://overpass-api.de/api/interpreter') as string;
  const around = `(around:2500,${prospect.latitude},${prospect.longitude})`;
  const query = `[out:json][timeout:25];
nwr["name"~"${pattern}",i]${around};
out center tags 40;`;

  let elements: OverpassElement[];
  try {
    const res = await http.request(url, {
      method: 'POST',
      body: new URLSearchParams({ data: query }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      timeoutMs: 25_000,
      attempts: 1,
    });
    if (!res.ok) return { match: null, providerFailed: true };
    elements = (JSON.parse(res.body) as { elements?: OverpassElement[] }).elements ?? [];
  } catch (error) {
    logger.warn('osm_match.failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { match: null, providerFailed: true };
  }

  const target = prospect.brand_name ?? prospect.display_name;
  let best: OsmMatch | null = null;

  for (const element of elements) {
    const tags = element.tags ?? {};
    const name = tags['name'];
    if (!name) continue;
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if (lat == null || lon == null) continue;

    const similarity = Math.max(
      nameSimilarity(target, name),
      prospect.display_name === target ? 0 : nameSimilarity(prospect.display_name, name),
    );
    const distance = haversineKm(
      { latitude: prospect.latitude, longitude: prospect.longitude },
      { latitude: lat, longitude: lon },
    );
    if (similarity < MIN_SIMILARITY || distance > MAX_DISTANCE_KM) continue;
    if (best && best.similarity >= similarity) continue;

    const sourceUrl = `https://www.openstreetmap.org/${element.type}/${element.id}`;
    const contact = {
      websiteUrl: normalizeUrl(tags['website'] ?? tags['contact:website'] ?? tags['url'] ?? null),
      phone: normalizePhone(tags['phone'] ?? tags['contact:phone'] ?? tags['contact:mobile'] ?? null),
      email: normalizeEmail(tags['email'] ?? tags['contact:email'] ?? null),
      instagramHandle: normalizeInstagramHandle(tags['contact:instagram'] ?? tags['instagram'] ?? null),
      facebookUrl: normalizeFacebookUrl(tags['contact:facebook'] ?? tags['facebook'] ?? null),
    };

    const evidence: EvidenceInput[] = [];
    const push = (field: string, value: string | null): void => {
      if (!value) return;
      evidence.push({
        field,
        valueText: value,
        provider: 'overpass',
        method: 'api',
        sourceUrl,
        confidence: Math.min(0.95, similarity),
      });
    };
    push('website_url', contact.websiteUrl);
    push('phone', contact.phone);
    push('email', contact.email);
    push('instagram_handle', contact.instagramHandle);
    push('facebook_url', contact.facebookUrl);
    push('opening_hours', tags['opening_hours'] ?? null);

    evidence.push({
      field: 'osm_category',
      valueText: [tags['shop'], tags['amenity'], tags['craft'], tags['office']].filter(Boolean).join(', ') || null,
      valueJson: tags,
      provider: 'overpass',
      method: 'api',
      sourceUrl,
      confidence: Math.min(0.95, similarity),
    });

    best = {
      osmId: `${element.type}/${element.id}`,
      name,
      distanceKm: distance,
      similarity,
      tags,
      evidence,
      contact,
    };
  }

  return { match: best, providerFailed: false };
}
