import { env } from '@/lib/env';
import { departmentsForRadius, matchesGeography } from '@/lib/geo/geo';
import { nameSimilarity, normalizeDomain, normalizePhone, normalizeUrl } from '@/lib/identity/normalize';
import type { HttpClient } from '@/lib/http/client';
import type { DiscoveredBusiness, DiscoveryContext, DiscoverySource } from '@/lib/discovery/types';

/**
 * recherche-entreprises.api.gouv.fr — the official French company registry search.
 *
 * Why it is the backbone of discovery:
 *   - open data, no API key, explicitly meant for programmatic use
 *   - SIREN gives every prospect a strong, stable identity key (dedup for free)
 *   - legal name, brand (enseigne), address, coordinates, activity code, creation
 *     date and headcount bracket are all first-party facts we can cite
 *
 * What it does NOT provide: website, social handles, reviews. Those come from
 * enrichment sources, or stay null.
 */

interface SireneSiege {
  siret?: string | null;
  adresse?: string | null;
  code_postal?: string | null;
  libelle_commune?: string | null;
  departement?: string | null;
  region?: string | null;
  latitude?: string | null;
  longitude?: string | null;
  liste_enseignes?: string[] | null;
  nom_commercial?: string | null;
  activite_principale?: string | null;
  etat_administratif?: string | null;
}

interface SireneResult {
  siren?: string;
  nom_complet?: string;
  nom_raison_sociale?: string | null;
  sigle?: string | null;
  activite_principale?: string | null;
  date_creation?: string | null;
  tranche_effectif_salarie?: string | null;
  nature_juridique?: string | null;
  etat_administratif?: string | null;
  categorie_entreprise?: string | null;
  nombre_etablissements_ouverts?: number | null;
  dirigeants?: unknown;
  complements?: Record<string, unknown> | null;
  siege?: SireneSiege | null;
}

interface SireneResponse {
  results?: SireneResult[];
  total_results?: number;
  page?: number;
  total_pages?: number;
}

interface SireneOptions {
  perPage: number;
  maxPages: number;
  onlyActive: boolean;
  queries?: string[];
}

function parseOptions(raw: Record<string, unknown>): SireneOptions {
  const perPageRaw = Number(raw['perPage'] ?? 25);
  return {
    // The API caps page size at 25.
    perPage: Number.isFinite(perPageRaw) ? Math.min(25, Math.max(1, Math.trunc(perPageRaw))) : 25,
    maxPages: Number.isFinite(Number(raw['maxPages'])) ? Math.max(1, Number(raw['maxPages'])) : 3,
    onlyActive: raw['onlyActive'] !== false,
    queries: Array.isArray(raw['queries']) ? (raw['queries'] as string[]) : undefined,
  };
}

function num(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class SireneDiscoverySource implements DiscoverySource {
  readonly provider = 'sirene';

  availability() {
    return { ok: true };
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveredBusiness[]> {
    const options = parseOptions(ctx.source.options);
    const baseUrl = env('OUTBOUND_SIRENE_BASE_URL', 'https://recherche-entreprises.api.gouv.fr') as string;
    const queries = options.queries ?? ctx.niche.searchQueries;
    const geoFilters = await this.geoFilters(ctx);

    const found = new Map<string, DiscoveredBusiness>();

    outer: for (const query of queries) {
      for (const filter of geoFilters) {
        for (let page = 1; page <= options.maxPages; page += 1) {
          if (ctx.shouldStop() || found.size >= ctx.source.maxResults) break outer;

          const params = new URLSearchParams({
            q: query,
            page: String(page),
            per_page: String(options.perPage),
          });
          if (options.onlyActive) params.set('etat_administratif', 'A');
          for (const [key, value] of Object.entries(filter)) params.set(key, value);

          const url = `${baseUrl}/search?${params.toString()}`;
          let payload: SireneResponse;
          try {
            payload = await ctx.http.getJson<SireneResponse>(url, { timeoutMs: 25_000 });
          } catch (error) {
            ctx.logger.warn('sirene.query_failed', {
              query,
              page,
              filter,
              error: error instanceof Error ? error.message : String(error),
            });
            break;
          }

          const results = payload.results ?? [];
          for (const result of results) {
            const business = sireneToBusiness(result, query, url);
            if (!business) continue;
            if (
              !matchesGeography(ctx.campaign.geography, {
                latitude: business.latitude ?? null,
                longitude: business.longitude ?? null,
                department: business.department ?? null,
                region: business.region ?? null,
                city: business.city ?? null,
                postalCode: business.postalCode ?? null,
              })
            ) {
              continue;
            }
            const key = business.externalId ?? `${business.name}|${business.city ?? ''}`;
            if (!found.has(key)) found.set(key, business);
          }

          ctx.logger.debug('sirene.page', {
            query,
            page,
            filter,
            got: results.length,
            total: payload.total_results ?? null,
            kept: found.size,
          });

          if (results.length < options.perPage) break;
          if (payload.total_pages !== undefined && page >= payload.total_pages) break;
        }
      }
    }

    return [...found.values()];
  }

  /**
   * Turns the campaign geography into registry query filters.
   * The registry cannot filter by radius, so a radius campaign is expressed as the
   * departments the circle touches and then narrowed precisely, client-side, by
   * distance in `matchesGeography`.
   */
  private async geoFilters(ctx: DiscoveryContext): Promise<Record<string, string>[]> {
    const geo = ctx.campaign.geography;
    switch (geo.mode) {
      case 'national':
        return [{}];
      case 'department':
        return geo.departments.map((departement) => ({ departement }));
      case 'region':
        return geo.regions.map((region) => ({ region }));
      case 'cities': {
        // With a postcode the registry filters server-side. Without one we issue a
        // single unfiltered query and let `matchesGeography` narrow by city name.
        const filters: Record<string, string>[] = [];
        let needsUnfiltered = false;
        for (const city of geo.cities) {
          if (city.postalCode) filters.push({ code_postal: city.postalCode });
          else needsUnfiltered = true;
        }
        if (needsUnfiltered) filters.push({});
        return filters;
      }
      case 'radius': {
        const departments = await departmentsForRadius(ctx.http, geo.center, geo.radiusKm);
        ctx.logger.info('sirene.radius_departments', { departments, center: geo.center.label });
        return departments.length > 0 ? departments.map((departement) => ({ departement })) : [{}];
      }
      default:
        return [{}];
    }
  }

}

export function sireneToBusiness(
  result: SireneResult,
  query: string,
  sourceUrl: string,
): DiscoveredBusiness | null {
  {
    const siren = result.siren?.trim();
    const name = (result.nom_complet ?? result.nom_raison_sociale ?? '').trim();
    if (!siren || !name) return null;

    const siege = result.siege ?? {};
    const enseigne =
      siege.liste_enseignes?.find((value) => value && value.trim().length > 0) ??
      siege.nom_commercial ??
      null;

    return {
      provider: 'sirene',
      externalId: siren,
      sourceUrl: `https://annuaire-entreprises.data.gouv.fr/entreprise/${siren}`,
      observedAt: new Date().toISOString(),
      name: enseigne?.trim() || name,
      legalName: result.nom_raison_sociale ?? name,
      brandName: enseigne,
      registryId: siren,
      registryCode: result.activite_principale ?? siege.activite_principale ?? null,
      country: 'FR',
      addressLine: siege.adresse ?? null,
      postalCode: siege.code_postal ?? null,
      city: siege.libelle_commune ?? null,
      department: siege.departement ?? null,
      region: siege.region ?? null,
      latitude: num(siege.latitude),
      longitude: num(siege.longitude),
      websiteUrl: null,
      phone: null,
      email: null,
      attributes: {
        query,
        queryUrl: sourceUrl,
        siret: siege.siret ?? null,
        dateCreation: result.date_creation ?? null,
        trancheEffectif: result.tranche_effectif_salarie ?? null,
        natureJuridique: result.nature_juridique ?? null,
        categorieEntreprise: result.categorie_entreprise ?? null,
        etatAdministratif: result.etat_administratif ?? null,
        etablissementsOuverts: result.nombre_etablissements_ouverts ?? null,
        siegeActivite: siege.activite_principale ?? null,
        estEntrepreneurIndividuel: result.complements?.['est_entrepreneur_individuel'] ?? null,
        dirigeantsCount: Array.isArray(result.dirigeants) ? result.dirigeants.length : null,
      },
      raw: result,
    };
  }
}

/**
 * Looks up one business in the registry by trading name and town.
 *
 * This is the identification half of the "Google → registre" step: a Places
 * candidate carries a name we may not keep, so the name is used as a QUERY and
 * what comes back — SIREN, legal name, address, activity code — is French open
 * data that we may keep, cite and score on. Nothing Google-sourced survives the
 * call.
 *
 * Returns the closest name match above `minSimilarity`, or null. Deliberately
 * strict: attaching the wrong SIREN is worse than attaching none, because a
 * wrong legal identity poisons every downstream claim about the business.
 */
export async function lookupRegistryByName(
  http: HttpClient,
  hint: { name: string; city?: string | null; postalCode?: string | null; minSimilarity?: number },
): Promise<{ business: DiscoveredBusiness; similarity: number } | null> {
  const baseUrl = env('OUTBOUND_SIRENE_BASE_URL', 'https://recherche-entreprises.api.gouv.fr') as string;
  const minSimilarity = hint.minSimilarity ?? 0.72;
  const params = new URLSearchParams({
    q: [hint.name, hint.city ?? ''].filter(Boolean).join(' ').trim(),
    page: '1',
    per_page: '10',
    etat_administratif: 'A',
  });
  if (hint.postalCode) params.set('code_postal', hint.postalCode);

  const url = `${baseUrl}/search?${params.toString()}`;
  let payload: SireneResponse;
  try {
    payload = await http.getJson<SireneResponse>(url, { timeoutMs: 25_000 });
  } catch {
    return null;
  }

  let best: { business: DiscoveredBusiness; similarity: number } | null = null;
  for (const result of payload.results ?? []) {
    const business = sireneToBusiness(result, hint.name, url);
    if (!business) continue;
    const similarity = Math.max(
      nameSimilarity(hint.name, business.name),
      nameSimilarity(hint.name, business.legalName ?? ''),
      nameSimilarity(hint.name, business.brandName ?? ''),
    );
    if (similarity < minSimilarity) continue;
    if (!best || similarity > best.similarity) best = { business, similarity };
  }
  return best;
}

/** Exposed for tests: normalisation applied to registry-provided contact data. */
export const sireneNormalizers = { normalizeDomain, normalizePhone, normalizeUrl };
