import { crawlWebsite } from '@/lib/enrichment/websiteCrawl';
import { crawlViaWebIntel, LOCAL_NAME_GUARD } from '@/lib/enrichment/webintel';
import { lookupRegistryByName } from '@/lib/discovery/sources/sirene';
import {
  isPlatformDomain,
  nameSimilarity,
  normalizeDomain,
  normalizeUrl,
} from '@/lib/identity/normalize';
import type { WebIntelClient } from '@/lib/enrichment/webintel';
import type { PlaceIdentifier } from '@/lib/discovery/places/railA';
import type { DiscoveredBusiness } from '@/lib/discovery/types';
import type { HttpClient } from '@/lib/http/client';
import type { Logger } from '@/lib/logging/logger';
import type { NicheConfig } from '@/lib/config/schema';

/**
 * How a Google Places candidate earns a storable identity.
 *
 * This is the load-bearing piece of the compliance design. A place candidate
 * arrives with a name, an address and a website URI that we are not allowed to
 * keep. Those values are used here as *questions* put to sources whose answers
 * we may keep:
 *
 *   1. the French company registry — open data, gives SIREN, legal name,
 *      address, activity code, age and headcount bracket;
 *   2. the company's own website — our own crawl, our own observation.
 *
 * If neither answers, the candidate does not become a prospect. Inventing a
 * display name from Google content to fill the gap is exactly what the Terms
 * forbid, and exactly what this repository's first rule forbids too.
 *
 * The registry is tried first, deliberately: it supplies the two signals a
 * Places-only prospect otherwise lacks (business age, employer status), which
 * is what keeps the score comparable between the two rails.
 */

export interface IdentifierDeps {
  http: HttpClient;
  logger: Logger;
  niche: NicheConfig;
  webintel: WebIntelClient | null;
}

export function placeIdentifier(deps: IdentifierDeps): PlaceIdentifier {
  return async (input) => {
    const viaRegistry = await identifyViaRegistry(deps, input);
    if (viaRegistry) return viaRegistry;
    return identifyViaWebsite(deps, input);
  };
}

async function identifyViaRegistry(
  deps: IdentifierDeps,
  input: Parameters<PlaceIdentifier>[0],
): Promise<DiscoveredBusiness | null> {
  if (!input.nameHint) return null;
  const match = await lookupRegistryByName(deps.http, { name: input.nameHint });
  if (!match) return null;

  deps.logger.info('places.identity_registry', {
    placeId: input.placeId,
    similarity: Number(match.similarity.toFixed(2)),
  });

  return {
    ...match.business,
    // The only Google-sourced value that travels: the join key.
    googlePlaceId: input.placeId,
    attributes: {
      ...(match.business.attributes ?? {}),
      identifiedFrom: 'registry_lookup_seeded_by_place_search',
      registryNameSimilarity: Number(match.similarity.toFixed(3)),
    },
  };
}

/**
 * Identification from the business's own site.
 *
 * The website URI came from Places, so before anything is kept the site must
 * corroborate that it belongs to the business the candidate describes — the
 * same `LOCAL_NAME_GUARD` second opinion the WebIntel resolver already applies,
 * for the same reason: a plausible-looking domain that belongs to someone else
 * poisons every later claim.
 *
 * What is persisted is the name the SITE gives itself, not the one Google gave.
 */
async function identifyViaWebsite(
  deps: IdentifierDeps,
  input: Parameters<PlaceIdentifier>[0],
): Promise<DiscoveredBusiness | null> {
  const websiteUrl = normalizeUrl(input.websiteUri);
  if (!websiteUrl) return null;
  const domain = normalizeDomain(websiteUrl);
  if (!domain || isPlatformDomain(domain)) return null;

  const crawl = deps.webintel
    ? await crawlViaWebIntel(deps.webintel, deps.logger, websiteUrl, deps.niche, 1)
    : null;
  const result = crawl ?? (await crawlWebsite(deps.http, websiteUrl, deps.niche, deps.logger, 1));
  if (result.pagesCrawled.length === 0) return null;

  const siteName = siteDeclaredName(result.evidence, domain);
  if (!siteName) return null;

  // Corroboration: the site must plausibly be this business. The hint is used
  // as a comparison string only — it is not what gets stored.
  if (input.nameHint) {
    const agreement = Math.max(
      nameSimilarity(input.nameHint, siteName),
      nameSimilarity(input.nameHint, domain.split('.')[0]?.replace(/[-_]+/g, ' ') ?? ''),
    );
    if (agreement < LOCAL_NAME_GUARD) {
      deps.logger.info('places.identity_website_rejected', {
        placeId: input.placeId,
        domain,
        agreement: Number(agreement.toFixed(2)),
      });
      return null;
    }
  }

  deps.logger.info('places.identity_website', { placeId: input.placeId, domain });

  return {
    provider: 'website',
    externalId: domain,
    sourceUrl: result.pagesCrawled[0] ?? websiteUrl,
    observedAt: new Date().toISOString(),
    name: siteName,
    country: 'FR',
    websiteUrl,
    phone: result.contact.phone,
    email: result.contact.email,
    instagramHandle: result.contact.instagramHandle,
    facebookUrl: result.contact.facebookUrl,
    googlePlaceId: input.placeId,
    attributes: { identifiedFrom: 'own_website', pagesRead: result.pagesCrawled.length },
    raw: { pagesCrawled: result.pagesCrawled },
  };
}

/**
 * The name a site gives itself.
 *
 * A page title is rarely just the business name: "Accueil | Northstar Studio -
 * Atelier automobile à Lyon" holds a navigation word, the name, and a
 * tagline. Picking the longest segment picks the tagline; picking the first
 * picks "Accueil".
 *
 * So the domain arbitrates. A company's own domain is the identifier it chose
 * for itself, which makes it the best available judge of which segment of its
 * own title is its name. Only when no segment resembles the domain does length
 * decide, and a title that merely spells the domain back is rejected as adding
 * nothing.
 */
export function siteDeclaredName(
  evidence: { field: string; value_text?: string | null; valueText?: string | null }[],
  domain: string,
): string | null {
  const titleRow = evidence.find((item) => item.field === 'website_title');
  const raw = (titleRow?.valueText ?? titleRow?.value_text ?? '').trim();
  if (!raw) return null;

  const compact = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const domainCore = domain.split('.')[0]?.replace(/[-_]+/g, ' ') ?? domain;

  const segments = raw
    .split(/[|·—–\-:]/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= 2);

  let candidate = raw.replace(/\s+/g, ' ').trim();
  if (segments.length > 0) {
    const ranked = segments
      .map((segment) => ({ segment, score: nameSimilarity(domainCore, segment) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    candidate =
      best && best.score >= 0.5
        ? best.segment
        : ([...segments].sort((a, b) => b.length - a.length)[0] ?? candidate);
  }

  if (candidate.length < 2 || candidate.length > 120) return null;
  // "monentreprise.fr" as a title tells us nothing the domain did not.
  if (compact(candidate) === compact(domain)) return null;
  return candidate;
}
