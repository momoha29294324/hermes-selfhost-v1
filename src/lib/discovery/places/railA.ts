import { stripAccents } from '@/lib/identity/normalize';
import { matchesGeography, tileDisc, type SearchArea } from '@/lib/geo/geo';
import { PlacesBudgetExceededError } from '@/lib/discovery/places/budget';
import { PLACES_MASKS } from '@/lib/discovery/places/fieldMask';
import {
  hasTier,
  linkCandidateToProspect,
  loadCandidate,
  purgeExpiredLocations,
  rememberPlaceId,
  markTierFetched,
  setCandidateStatus,
  setCandidateResolution,
  gradeResolution,
  RESOLUTION_PROSPECTABLE,
  type PlaceResolution,
} from '@/lib/discovery/places/retention';
import { lookupRegistryByName } from '@/lib/discovery/sources/sirene';
import type { PlacesClient } from '@/lib/discovery/places/client';
import type { CampaignConfig, NicheConfig } from '@/lib/config/schema';
import type { DiscoveredBusiness } from '@/lib/discovery/types';
import type { HttpClient } from '@/lib/http/client';
import type { Logger } from '@/lib/logging/logger';
import type { ProspectRepository } from '@/lib/repo/prospects';
import type { Sql } from '@/lib/db/sql';

/**
 * Rail A — commercial discovery through Google Places.
 *
 * The shape of this stage is dictated by a constraint, not by taste: Places
 * content may not be stored. Only the place ID may be kept indefinitely, and
 * latitude/longitude for thirty days. Names, addresses, phones, websites and
 * ratings carry no caching permission at all, and copying business names and
 * addresses is named as prohibited scraping in the Terms of Service.
 *
 * So Places answers "where should we look", never "what do we know". Each stage
 * pays for the cheapest field mask that can eliminate candidates, and the last
 * stage buys two pointers — the business's own website and phone — which are
 * used to make an INDEPENDENT source speak. What ends up in the database is
 * what the registry and the company's own website said..
 *
 * A candidate nobody independent can identify does not become a prospect. It
 * stays a place ID with a reason, and it is counted — "found but unidentifiable"
 * is a measurement, not a hole in the funnel.
 */

export interface PlacesRailOptions {
  sql: Sql;
  repo: ProspectRepository;
  http: HttpClient;
  client: PlacesClient;
  logger: Logger;
  campaign: CampaignConfig;
  campaignId: string;
  runId: string | null;
  niche: NicheConfig;
  /** Hard ceiling on candidates carried into the paid stages. */
  maxCandidates: number;
  /** Radius of each search tile, in km. Smaller = better coverage, more calls. */
  tileRadiusKm: number;
  /** Overrides the niche's search queries. See `placesDiscoverySchema.queries`. */
  queries?: readonly string[];
  /** Identify a candidate through its website / the registry. */
  identify?: PlaceIdentifier;
}

/**
 * How a place candidate acquires a storable identity.
 *
 * Injected so the pipeline can hand in the WebIntel-backed implementation while
 * tests hand in a deterministic one — the same dependency-injection stance the
 * rest of the repository takes towards the network.
 */
export type PlaceIdentifier = (input: {
  placeId: string;
  /** TRANSIENT Google hints. Usable as query terms; never persisted verbatim. */
  nameHint: string | null;
  websiteUri: string | null;
  phoneHint: string | null;
  /**
   * Always null since R2.1 — the rail no longer requests Places coordinates at
   * all. Kept in the contract so an identifier that once received them fails to
   * compile rather than silently reading a value that is no longer there.
   */
  latitude: null;
  longitude: null;
}) => Promise<DiscoveredBusiness | null>;

export interface PlacesRailStats {
  queriesIssued: number;
  areasSearched: number;
  rawResults: number;
  distinctPlaceIds: number;
  newPlaceIds: number;
  locatedCalls: number;
  rejectedOutOfArea: number;
  qualifyCalls: number;
  rejectedOutOfNiche: number;
  rejectedClosed: number;
  pointerCalls: number;
  withWebsite: number;
  identified: number;
  unidentified: number;
  identifiedViaWebsite: number;
  identifiedViaRegistry: number;
  /** §14 of the gate: where the funnel leaks, not just whether it leaked. */
  resolution: Record<PlaceResolution, number>;
  prospectsCreated: number;
  prospectsMerged: number;
  expiredLocationsPurged: number;
  stoppedReason: string | null;
}

function emptyStats(): PlacesRailStats {
  return {
    queriesIssued: 0,
    areasSearched: 0,
    rawResults: 0,
    distinctPlaceIds: 0,
    newPlaceIds: 0,
    locatedCalls: 0,
    rejectedOutOfArea: 0,
    qualifyCalls: 0,
    rejectedOutOfNiche: 0,
    rejectedClosed: 0,
    pointerCalls: 0,
    withWebsite: 0,
    identified: 0,
    unidentified: 0,
    identifiedViaWebsite: 0,
    identifiedViaRegistry: 0,
    resolution: { confirmed: 0, probable: 0, uncertain: 0, not_found: 0 },
    prospectsCreated: 0,
    prospectsMerged: 0,
    expiredLocationsPurged: 0,
    stoppedReason: null,
  };
}

/**
 * Turns a campaign geography into the circular areas Places can bias towards.
 *
 * Text Search returns at most 60 results per query. A dense metropolitan area
 * holds far more artisans than that, so a single query cannot enumerate it.
 * The supported answer is to ask smaller questions — a grid of genuine,
 * narrower searches — not to try to page past the documented ceiling.
 */
export function searchAreasFor(campaign: CampaignConfig, tileRadiusKm: number): SearchArea[] {
  const geo = campaign.geography;
  if (geo.mode === 'radius') {
    return tileDisc(geo.center, geo.radiusKm, tileRadiusKm);
  }
  if (geo.mode === 'cities') {
    // Without coordinates a town can still be searched by name; the tile is a
    // bias, and `matchesGeography` remains the authority on what is kept.
    return geo.cities.map((city) => ({
      label: city.postalCode ? `${city.name} ${city.postalCode}` : city.name,
      center: { latitude: 0, longitude: 0 },
      radiusKm: tileRadiusKm,
    }));
  }
  // A department, a region or the whole country cannot be swept responsibly
  // through a place-search bias. Rail A refuses rather than issuing thousands of
  // calls; rail B covers those geographies through the registry.
  return [];
}

const CLOSED_STATUSES = new Set(['CLOSED_PERMANENTLY', 'CLOSED_TEMPORARILY']);

/**
 * Cheap, local pre-filter on Google's own category vocabulary.
 *
 * Runs on transient data and writes nothing. Its only job is to stop a candidate
 * before the next, more expensive stage — the full niche judgement stays with
 * `classifyDeterministic` and the LLM, on evidence we are allowed to keep.
 */
export function plausibleForNiche(
  hints: { types: string[]; name?: string | null; primaryType?: string | null },
  niche: NicheConfig,
): boolean {
  const haystack = stripAccents(
    [...hints.types, hints.primaryType ?? '', hints.name ?? ''].join(' ').replace(/_/g, ' '),
  ).toLowerCase();
  if (!haystack.trim()) return true;

  for (const term of niche.negativeTerms) {
    const normalized = stripAccents(term).toLowerCase().trim();
    if (normalized && haystack.includes(normalized)) return false;
  }
  for (const term of [...niche.positiveTerms, ...niche.adjacentTerms, ...niche.serviceTerms]) {
    const normalized = stripAccents(term).toLowerCase().trim();
    if (normalized && haystack.includes(normalized)) return true;
  }
  // Google's own category vocabulary for the trade, kept alongside the niche
  // config because it is Google taxonomy rather than business vocabulary.
  return ['atelier', 'car repair', 'auto parts', 'car dealer'].some((type) => haystack.includes(type));
}

export async function runPlacesRail(options: PlacesRailOptions): Promise<PlacesRailStats> {
  const { sql, repo, client, logger, campaign, campaignId, runId, niche } = options;
  const stats = emptyStats();

  // The 30-day lease is honoured at the start of every run, so it holds even if
  // no scheduled job ever exists.
  stats.expiredLocationsPurged = await purgeExpiredLocations(sql);

  const areas = searchAreasFor(campaign, options.tileRadiusKm);
  if (areas.length === 0) {
    stats.stoppedReason =
      `géographie « ${campaign.geography.mode} » non balayable par Places : rail commercial ignoré, rail registre conservé`;
    logger.warn('places.geography_unsupported', { mode: campaign.geography.mode });
    return stats;
  }

  const seen = new Set<string>();

  // ------------------------------------------------------------- stage 1: IDs
  try {
    const queries = options.queries ?? niche.searchQueries;
    outer: for (const query of queries) {
      for (const area of areas) {
        stats.areasSearched += 1;
        let pageToken: string | undefined;
        for (let page = 0; ; page += 1) {
          if (seen.size >= options.maxCandidates) break outer;

          const result = await client.searchText(query, area, {
            regionCode: campaign.geography.country ?? 'FR',
            languageCode: niche.language,
            ...(pageToken ? { pageToken } : {}),
          });
          stats.queriesIssued += 1;
          stats.rawResults += result.hits.length;

          let fresh = 0;
          let duplicates = 0;
          for (const hit of result.hits) {
            if (seen.has(hit.placeId)) {
              duplicates += 1;
              continue;
            }
            seen.add(hit.placeId);
            const inserted = await rememberPlaceId(sql, campaignId, hit.placeId);
            if (inserted) {
              stats.newPlaceIds += 1;
              fresh += 1;
            } else {
              duplicates += 1;
            }
          }

          await logQuery(sql, {
            runId,
            campaignId,
            provider: 'google_places',
            query,
            areaLabel: area.label,
            page,
            pageToken: Boolean(pageToken),
            rawResults: result.hits.length,
            newCandidates: fresh,
            duplicates,
          });

          // Terminate on the absence of a token, never on a hard-coded result
          // count: the documented ceiling is explicitly "subject to change".
          if (!result.nextPageToken) break;
          pageToken = result.nextPageToken;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof PlacesBudgetExceededError)) throw error;
    stats.stoppedReason = error.message;
    logger.warn('places.budget_stop', { stage: 'discovery', scope: error.scope });
  }

  stats.distinctPlaceIds = seen.size;
  const candidates = [...seen].slice(0, options.maxCandidates);

  // --------------------------------------------- stages 2-4, candidate by candidate
  for (const placeId of candidates) {
    try {
      const stored = await loadCandidate(sql, placeId);
      // A verdict already reached is a verdict we do not pay for twice. What is
      // remembered is our own judgement, never the Google content behind it.
      if (stored?.status === 'rejected' || stored?.status === 'identified') continue;

      // ---- stage 2: what kind of place is it (Essentials)
      //
      // Geography is NOT decided here. Google restricted the search server-side
      // (`locationRestriction`), and the precise check runs after identification
      // on the address an independent source gives — never by testing Places
      // coordinates against the campaign area. See la documentation d’installation §4.
      let types: string[] = [];
      if (!hasTier(stored, 'locate')) {
        const categories = await client.fetchCategories(placeId);
        stats.locatedCalls += 1;
        types = categories.types;
        await markTierFetched(sql, placeId, 'locate');
      }

      if (!plausibleForNiche({ types }, niche)) {
        stats.rejectedOutOfNiche += 1;
        await setCandidateStatus(sql, placeId, 'rejected', 'catégorie incompatible avec la niche');
        continue;
      }
      await setCandidateStatus(sql, placeId, 'in_area');

      // ---- stage 3: what is it called, is it open (Pro)
      const hints = await client.fetchIdentityHints(placeId);
      stats.qualifyCalls += 1;
      await markTierFetched(sql, placeId, 'qualify');

      if (hints.businessStatus && CLOSED_STATUSES.has(hints.businessStatus)) {
        stats.rejectedClosed += 1;
        await setCandidateStatus(sql, placeId, 'rejected', 'établissement fermé');
        continue;
      }
      if (!plausibleForNiche({ types, name: hints.displayName, primaryType: hints.primaryType }, niche)) {
        stats.rejectedOutOfNiche += 1;
        await setCandidateStatus(sql, placeId, 'rejected', 'nom et catégorie hors niche');
        continue;
      }
      await setCandidateStatus(sql, placeId, 'qualified');

      // ---- stage 4: pointers towards sources we may keep (Enterprise)
      const pointers = await client.fetchPointers(placeId);
      stats.pointerCalls += 1;
      await markTierFetched(sql, placeId, 'identify');
      if (pointers.websiteUri) stats.withWebsite += 1;

      // ---- identification by an independent source
      const identifier = options.identify ?? defaultIdentifier(options);
      const business = await identifier({
        placeId,
        nameHint: hints.displayName,
        websiteUri: pointers.websiteUri,
        phoneHint: pointers.phone,
        latitude: null,
        longitude: null,
      });

      if (!business) {
        stats.unidentified += 1;
        stats.resolution.not_found += 1;
        await setCandidateResolution(sql, placeId, 'not_found', {
          provider: null,
          confidence: 0,
          sourceUrl: null,
        });
        await setCandidateStatus(
          sql,
          placeId,
          'unidentified',
          'aucune source indépendante (site ou registre) n’a permis d’identifier l’établissement',
        );
        continue;
      }

      // ---- how strong is that identification
      //
      // An identifier returning *something* is not the same as an identifier
      // being right. A weak match is the homonym trap in another costume: it
      // would attach a Google trading name to somebody else's SIREN, which is a
      // wrong prospect and a laundered Google value at once. So a match below
      // the usable threshold is recorded and dropped, not written.
      const similarity = confidenceOf(business);
      const graded = gradeResolution({
        matched: true,
        similarity,
        hasRegistryId: Boolean(business.registryId),
      });
      stats.resolution[graded.resolution] += 1;
      await setCandidateResolution(sql, placeId, graded.resolution, {
        provider: business.provider,
        confidence: graded.confidence,
        sourceUrl: business.sourceUrl,
      });

      if (!RESOLUTION_PROSPECTABLE.includes(graded.resolution)) {
        stats.unidentified += 1;
        await setCandidateStatus(
          sql,
          placeId,
          'unidentified',
          `identification trop incertaine (${graded.confidence.toFixed(2)}) pour créer un prospect`,
        );
        continue;
      }

      // ---- geography, decided on the INDEPENDENT address
      //
      // This is the check R2 ran at stage 2 on Places coordinates. It moved here
      // for two reasons, and the second matters more than the first: EEA ToS
      // §3.3.2(c)(iv) puts containment analysis on Places coordinates out of
      // bounds, and the registry's own postal address is simply better evidence
      // of where a business trades than a map pin we are not allowed to reason
      // over. A candidate Google returned from a tile corner just outside the
      // campaign radius is dropped here, at the cost of the calls already spent.
      if (
        !matchesGeography(campaign.geography, {
          latitude: business.latitude ?? null,
          longitude: business.longitude ?? null,
          city: business.city ?? null,
          postalCode: business.postalCode ?? null,
          department: business.department ?? null,
          region: business.region ?? null,
        })
      ) {
        stats.rejectedOutOfArea += 1;
        await setCandidateStatus(sql, placeId, 'rejected', 'hors zone de campagne (adresse indépendante)');
        continue;
      }

      stats.identified += 1;
      if (business.provider === 'website') stats.identifiedViaWebsite += 1;
      if (business.provider === 'sirene') stats.identifiedViaRegistry += 1;

      const upsert = await repo.upsertDiscovered(campaignId, business);
      if (upsert.created) stats.prospectsCreated += 1;
      else stats.prospectsMerged += 1;

      await repo.recordDiscoveryOrigin(campaignId, upsert.prospectId, {
        provider: 'google_places',
        rail: 'commercial',
        externalId: placeId,
      });
      await repo.recordDiscoveryOrigin(campaignId, upsert.prospectId, {
        provider: business.provider,
        rail: 'commercial',
        externalId: business.externalId,
      });
      await linkCandidateToProspect(sql, placeId, upsert.prospectId);
    } catch (error) {
      if (error instanceof PlacesBudgetExceededError) {
        stats.stoppedReason = error.message;
        logger.warn('places.budget_stop', { stage: 'details', scope: error.scope });
        break;
      }
      logger.warn('places.candidate_failed', {
        placeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return stats;
}

/**
 * The registry-first identifier.
 *
 * Uses the Google trading name purely as a search term against the French
 * company registry, and keeps what the registry answers. The place ID travels
 * with the result so the two rails converge on one canonical business, but no
 * Google-sourced value is ever written.
 */
export function defaultIdentifier(options: Pick<PlacesRailOptions, 'http' | 'logger'>): PlaceIdentifier {
  return async (input) => {
    if (!input.nameHint) return null;
    const match = await lookupRegistryByName(options.http, { name: input.nameHint });
    if (!match) return null;
    options.logger.info('places.identified_via_registry', {
      placeId: input.placeId,
      similarity: Number(match.similarity.toFixed(2)),
    });
    return {
      ...match.business,
      // The join key, and the only Places value on this object.
      googlePlaceId: input.placeId,
      sourceUrl: match.business.sourceUrl,
    };
  };
}

/**
 * How strongly the identifier believes its own answer.
 *
 * The registry path records the name agreement it accepted on; the website path
 * has already cleared `LOCAL_NAME_GUARD` before returning anything, so reaching
 * here at all is its evidence. A business that carries neither marker is treated
 * as barely-passing rather than as certain — an identifier that does not say how
 * sure it is has not earned `confirmed`.
 */
export function confidenceOf(business: DiscoveredBusiness): number {
  const recorded = business.attributes?.['registryNameSimilarity'];
  if (typeof recorded === 'number' && Number.isFinite(recorded)) return recorded;
  if (business.provider === 'website') return 0.85;
  return 0.7;
}

async function logQuery(
  sql: Sql,
  entry: {
    runId: string | null;
    campaignId: string;
    provider: string;
    query: string;
    areaLabel: string | null;
    page: number;
    pageToken: boolean;
    rawResults: number;
    newCandidates: number;
    duplicates: number;
  },
): Promise<void> {
  await sql.query(
    `insert into discovery_queries
       (run_id, campaign_id, provider, query, area_label, page, page_token,
        raw_results, new_candidates, duplicates)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      entry.runId,
      entry.campaignId,
      entry.provider,
      entry.query,
      entry.areaLabel,
      entry.page,
      entry.pageToken,
      entry.rawResults,
      entry.newCandidates,
      entry.duplicates,
    ],
  );
}

/** Exposed so tests and the report can assert which masks the rail actually uses. */
export const RAIL_A_MASKS = {
  discovery: PLACES_MASKS.discovery(),
  locate: PLACES_MASKS.locate(),
  qualify: PLACES_MASKS.qualify(),
  identify: PLACES_MASKS.identify(),
} as const;
