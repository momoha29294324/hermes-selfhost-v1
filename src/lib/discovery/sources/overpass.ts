import { env } from '@/lib/env';
import { boundingBox, matchesGeography } from '@/lib/geo/geo';
import {
  normalizeEmail,
  normalizeFacebookUrl,
  normalizeInstagramHandle,
  normalizePhone,
  normalizeUrl,
} from '@/lib/identity/normalize';
import type { DiscoveredBusiness, DiscoveryContext, DiscoverySource } from '@/lib/discovery/types';

/**
 * OpenStreetMap via the Overpass API.
 *
 * OSM is weak at *finding* atelier businesses (it is dominated by automatic
 * wash stations) but strong at *contact data*: when a shop is mapped, it often
 * carries website, phone, opening hours and social links. So this source runs
 * second, mostly to attach a digital footprint to registry-discovered companies.
 */

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

const NAME_REGEX =
  'detail|d[ée]tailing|esth[ée]tique auto|cosm[ée]tique auto|prestation standard|prestation standard|pr[ée]paration auto|car ?care|car ?wash|vente de produits|c[ée]ramique';

export class OverpassDiscoverySource implements DiscoverySource {
  readonly provider = 'overpass';

  availability() {
    return { ok: true };
  }

  async discover(ctx: DiscoveryContext): Promise<DiscoveredBusiness[]> {
    const areas = this.areaClauses(ctx);
    if (areas.length === 0) {
      ctx.logger.info('overpass.skipped', { reason: 'geography_not_expressible_as_area' });
      return [];
    }

    const url = env('OUTBOUND_OVERPASS_URL', 'https://overpass-api.de/api/interpreter') as string;
    const found = new Map<string, DiscoveredBusiness>();

    for (const area of areas) {
      if (ctx.shouldStop() || found.size >= ctx.source.maxResults) break;
      const query = this.buildQuery(area);
      let payload: OverpassResponse;
      try {
        const res = await ctx.http.request(url, {
          method: 'POST',
          body: new URLSearchParams({ data: query }).toString(),
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          timeoutMs: 120_000,
          attempts: 2,
          noCache: false,
        });
        if (!res.ok) {
          ctx.logger.warn('overpass.http_error', { status: res.status });
          continue;
        }
        payload = JSON.parse(res.body) as OverpassResponse;
      } catch (error) {
        ctx.logger.warn('overpass.query_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      for (const element of payload.elements ?? []) {
        const business = this.toBusiness(element);
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
        found.set(`${element.type}/${element.id}`, business);
        if (found.size >= ctx.source.maxResults) break;
      }
      ctx.logger.debug('overpass.area_done', { kept: found.size });
    }

    return [...found.values()];
  }

  /** Overpass needs a bounded area; a national sweep is refused rather than faked. */
  private areaClauses(ctx: DiscoveryContext): string[] {
    const geo = ctx.campaign.geography;
    switch (geo.mode) {
      case 'radius': {
        const box = boundingBox(geo.center, geo.radiusKm);
        return [`(${box.south},${box.west},${box.north},${box.east})`];
      }
      case 'cities':
        return geo.cities
          .filter((city) => city.name.trim().length > 0)
          .map((city) => `(area["name"="${city.name.replace(/"/g, '')}"]["boundary"="administrative"])`);
      case 'department':
        return geo.departments.map(
          (code) => `(area["ref:INSEE"="${code}"]["admin_level"="6"])`,
        );
      case 'region':
        return geo.regions.map((code) => `(area["ref:INSEE"="${code}"]["admin_level"="4"])`);
      case 'national':
        // A country-wide Overpass sweep would be abusive; registry discovery covers it.
        return [];
      default:
        return [];
    }
  }

  private buildQuery(areaClause: string): string {
    const isBbox = areaClause.startsWith('(') && /^\(-?\d/.test(areaClause);
    if (isBbox) {
      const bbox = areaClause;
      return `[out:json][timeout:90];
(
  nwr["shop"="atelier"]${bbox};
  nwr["amenity"="atelier"]${bbox};
  nwr["shop"="car_repair"]["name"~"${NAME_REGEX}",i]${bbox};
  nwr["name"~"${NAME_REGEX}",i]${bbox};
);
out center tags 400;`;
    }
    return `[out:json][timeout:120];
${areaClause}->.searchArea;
(
  nwr["shop"="atelier"](area.searchArea);
  nwr["amenity"="atelier"](area.searchArea);
  nwr["shop"="car_repair"]["name"~"${NAME_REGEX}",i](area.searchArea);
  nwr["name"~"${NAME_REGEX}",i](area.searchArea);
);
out center tags 400;`;
  }

  private toBusiness(element: OverpassElement): DiscoveredBusiness | null {
    const tags = element.tags ?? {};
    const name = tags['name']?.trim();
    if (!name) return null;

    const lat = element.lat ?? element.center?.lat ?? null;
    const lon = element.lon ?? element.center?.lon ?? null;

    const addressParts = [
      [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
      [tags['addr:postcode'], tags['addr:city']].filter(Boolean).join(' '),
    ].filter((part) => part.length > 0);

    return {
      provider: this.provider,
      externalId: `${element.type}/${element.id}`,
      sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
      observedAt: new Date().toISOString(),
      name,
      brandName: tags['brand'] ?? null,
      country: 'FR',
      addressLine: addressParts.length > 0 ? addressParts.join(', ') : null,
      postalCode: tags['addr:postcode'] ?? null,
      city: tags['addr:city'] ?? null,
      latitude: lat,
      longitude: lon,
      websiteUrl: normalizeUrl(tags['website'] ?? tags['contact:website'] ?? tags['url'] ?? null),
      phone: normalizePhone(tags['phone'] ?? tags['contact:phone'] ?? tags['contact:mobile'] ?? null),
      email: normalizeEmail(tags['email'] ?? tags['contact:email'] ?? null),
      instagramHandle: normalizeInstagramHandle(
        tags['contact:instagram'] ?? tags['instagram'] ?? null,
      ),
      facebookUrl: normalizeFacebookUrl(tags['contact:facebook'] ?? tags['facebook'] ?? null),
      attributes: {
        osmTags: tags,
        selfService: tags['self_service'] ?? null,
        automated: tags['automated'] ?? null,
        openingHours: tags['opening_hours'] ?? null,
        operator: tags['operator'] ?? null,
        shop: tags['shop'] ?? null,
        amenity: tags['amenity'] ?? null,
      },
      raw: element,
    };
  }
}
