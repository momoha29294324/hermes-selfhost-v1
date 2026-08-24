import type { GeographyConfig } from '@/lib/config/schema';
import type { HttpClient } from '@/lib/http/client';

export interface Point {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_KM = 6371.0088;

export function haversineKm(a: Point, b: Point): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Point at `distanceKm` from `origin` along `bearingDeg`. */
export function destinationPoint(origin: Point, bearingDeg: number, distanceKm: number): Point {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const toDeg = (rad: number): number => (rad * 180) / Math.PI;
  const delta = distanceKm / EARTH_RADIUS_KM;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(origin.latitude);
  const lambda1 = toRad(origin.longitude);
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta),
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );
  return { latitude: toDeg(phi2), longitude: ((toDeg(lambda2) + 540) % 360) - 180 };
}

export function boundingBox(center: Point, radiusKm: number): {
  south: number;
  west: number;
  north: number;
  east: number;
} {
  const north = destinationPoint(center, 0, radiusKm);
  const east = destinationPoint(center, 90, radiusKm);
  const south = destinationPoint(center, 180, radiusKm);
  const west = destinationPoint(center, 270, radiusKm);
  return {
    south: south.latitude,
    west: west.longitude,
    north: north.latitude,
    east: east.longitude,
  };
}

/** True when a business location satisfies the campaign geography. */
export function matchesGeography(
  geography: GeographyConfig,
  location: {
    latitude?: number | null;
    longitude?: number | null;
    department?: string | null;
    region?: string | null;
    city?: string | null;
    postalCode?: string | null;
  },
): boolean {
  switch (geography.mode) {
    case 'national':
      return true;
    case 'department':
      return location.department !== null && location.department !== undefined
        ? geography.departments.includes(location.department)
        : false;
    case 'region':
      return location.region !== null && location.region !== undefined
        ? geography.regions.includes(location.region)
        : false;
    case 'cities': {
      const city = (location.city ?? '').toLowerCase();
      return geography.cities.some((entry) => {
        if (entry.postalCode && location.postalCode) return entry.postalCode === location.postalCode;
        return city.includes(entry.name.toLowerCase());
      });
    }
    case 'radius': {
      if (location.latitude == null || location.longitude == null) return false;
      const distance = haversineKm(geography.center, {
        latitude: location.latitude,
        longitude: location.longitude,
      });
      return distance <= geography.radiusKm;
    }
    default:
      return true;
  }
}

/**
 * A circular search area. Discovery providers that take a "centre + radius" bias
 * consume these; a campaign geography is turned into one or more of them so that
 * a single area too large to be covered by one query becomes a grid of areas that
 * each are.
 */
export interface SearchArea {
  /** Human-readable, stable across runs — used as the run ledger key. */
  label: string;
  center: Point;
  radiusKm: number;
}

/**
 * Covers a disc with a grid of smaller discs.
 *
 * A provider that caps the number of results per query cannot enumerate a dense
 * city in one call. Subdividing is the only officially supported answer: each
 * tile is a legitimate, smaller query rather than an attempt to page past the cap.
 *
 * Tiles are laid out on a square lattice of side `tileRadiusKm * √2` so that the
 * inscribed squares tile the plane without gaps, then the circumscribed circles
 * overlap slightly — deliberate, since a gap loses businesses while an overlap
 * only costs a deduplicated result.
 */
export function tileDisc(center: Point, radiusKm: number, tileRadiusKm: number): SearchArea[] {
  if (tileRadiusKm <= 0) throw new Error('tileRadiusKm must be positive');
  if (tileRadiusKm >= radiusKm) {
    return [{ label: `${fixed(center.latitude)},${fixed(center.longitude)}~${radiusKm}km`, center, radiusKm }];
  }

  const step = tileRadiusKm * Math.SQRT2;
  const rings = Math.ceil(radiusKm / step);
  const areas: SearchArea[] = [];

  for (let row = -rings; row <= rings; row += 1) {
    for (let col = -rings; col <= rings; col += 1) {
      // Offset north/south first, then east/west from that latitude, so the
      // east-west step stays a true distance rather than a naive degree delta.
      const northSouth = destinationPoint(center, row >= 0 ? 0 : 180, Math.abs(row) * step);
      const tileCenter = destinationPoint(northSouth, col >= 0 ? 90 : 270, Math.abs(col) * step);
      // Keep a tile when any part of it can still intersect the requested disc.
      if (haversineKm(center, tileCenter) > radiusKm + tileRadiusKm) continue;
      areas.push({
        label: `${fixed(tileCenter.latitude)},${fixed(tileCenter.longitude)}~${tileRadiusKm}km`,
        center: tileCenter,
        radiusKm: tileRadiusKm,
      });
    }
  }

  return areas;
}

function fixed(value: number): string {
  return value.toFixed(4);
}

interface NominatimReverse {
  address?: Record<string, string>;
}

/**
 * Departments intersecting a radius, resolved by reverse-geocoding the centre and
 * eight compass points on the circle. Used to turn a "city + radius" campaign into
 * registry queries that the French company API can actually filter on.
 */
export async function departmentsForRadius(
  http: HttpClient,
  center: Point,
  radiusKm: number,
): Promise<string[]> {
  const points: Point[] = [center];
  for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
    points.push(destinationPoint(center, bearing, radiusKm));
  }

  const codes = new Set<string>();
  for (const point of points) {
    try {
      const url =
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
        `&lat=${point.latitude.toFixed(5)}&lon=${point.longitude.toFixed(5)}&zoom=8&addressdetails=1`;
      const data = await http.getJson<NominatimReverse>(url, { timeoutMs: 15_000, attempts: 2 });
      const postcode = data.address?.['postcode'];
      const code = departmentFromPostcode(postcode);
      if (code) codes.add(code);
    } catch {
      // A failed reverse lookup only narrows coverage; it must not fail the run.
    }
  }
  return [...codes].sort();
}

/** FR department code from a postcode, handling Corsica and the overseas ranges. */
export function departmentFromPostcode(postcode: string | null | undefined): string | null {
  if (!postcode) return null;
  const digits = postcode.replace(/\D/g, '');
  if (digits.length < 5) return null;
  const prefix2 = digits.slice(0, 2);
  if (prefix2 === '20') {
    const num = Number.parseInt(digits.slice(0, 5), 10);
    return num < 20200 ? '2A' : '2B';
  }
  if (['97', '98'].includes(prefix2)) return digits.slice(0, 3);
  return prefix2;
}
