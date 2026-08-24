import { env, envBool } from '@/lib/env';
import { HttpError, type HttpClient } from '@/lib/http/client';
import { PLACES_MASKS, type MaskPlan } from '@/lib/discovery/places/fieldMask';
import { PlacesBudget, PlacesBudgetExceededError } from '@/lib/discovery/places/budget';
import { assertEeaUseAllowed, eeaStance, type EeaStance } from '@/lib/discovery/places/eea';
import { boundingBox, type Point } from '@/lib/geo/geo';
import type { Logger } from '@/lib/logging/logger';

/**
 * A thin, budgeted client for the Places API (New).
 *
 * Everything this client returns is TRANSIENT unless the type says otherwise.
 * The only value in here that may reach the database is `placeId`, plus a
 * location under a 30-day lease. See la documentation d’installation for why, and
 * `src/lib/discovery/places/retention.ts` for how that lease is enforced.
 *
 * The client never logs a response body and never logs the key — a Places
 * payload is Google Maps Content, and a log file is storage.
 */

const PLACES_HOST = 'https://places.googleapis.com';

export interface PlacesAvailability {
  ok: boolean;
  reason?: string;
}

export function placesAvailability(): PlacesAvailability {
  if (!envBool('GOOGLE_PLACES_ENABLED', false)) {
    return {
      ok: false,
      reason: 'GOOGLE_PLACES_ENABLED is 0 (Places is opt-in — see la documentation d’installation)',
    };
  }
  if (!env('OUTBOUND_GOOGLE_PLACES_KEY')) {
    return { ok: false, reason: 'OUTBOUND_GOOGLE_PLACES_KEY is not set' };
  }
  // Reported as unavailable rather than as a per-call failure: without a declared
  // permitted use the rail can only reach stage 1, which discovers place IDs it
  // can never qualify. Surfacing that up front beats failing 30 times in a row.
  const stance = eeaStance();
  if (!stance.restrictedContentAllowed) {
    return { ok: false, reason: stance.reason };
  }
  return { ok: true };
}

/** Stage 1 output. `placeId` is the only durably storable Places value. */
export interface PlaceIdHit {
  placeId: string;
}

/**
 * Stage 2 output. TRANSIENT — category vocabulary, used in-process then dropped.
 *
 * R2 carried latitude/longitude here too. R2.1 does not request them: see
 * `PLACES_MASKS.locate` and la documentation d’installation §4.
 */
export interface PlaceCategories {
  placeId: string;
  types: string[];
}

/** Stage 3 output. Every field TRANSIENT. */
export interface PlaceIdentityHints {
  placeId: string;
  displayName: string | null;
  primaryType: string | null;
  businessStatus: string | null;
}

/** Stage 4 output. Every field TRANSIENT — pointers towards sources we may keep. */
export interface PlacePointers {
  placeId: string;
  websiteUri: string | null;
  phone: string | null;
}

export interface SearchTextPage {
  hits: PlaceIdHit[];
  nextPageToken: string | null;
}

export interface PlacesClientOptions {
  http: HttpClient;
  budget: PlacesBudget;
  logger: Logger;
  timeoutMs?: number;
  /** Injected so a test can state a stance instead of mutating the environment. */
  eea?: EeaStance;
}

interface SearchTextResponse {
  places?: { id?: string }[];
  nextPageToken?: string;
}

interface PlaceDetailsResponse {
  id?: string;
  types?: string[];
  displayName?: { text?: string };
  primaryType?: string;
  businessStatus?: string;
  websiteUri?: string;
  nationalPhoneNumber?: string;
}

export class PlacesClient {
  private readonly http: HttpClient;
  private readonly budget: PlacesBudget;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly eea: EeaStance;

  constructor(options: PlacesClientOptions) {
    this.http = options.http;
    this.budget = options.budget;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.eea = options.eea ?? eeaStance();
  }

  /**
   * Stage 1 — Text Search restricted to place IDs.
   *
   * Billed at Text Search Essentials (IDs Only): no charge, no monthly cap. The
   * `nextPageToken` field must be IN the mask or the token never comes back and
   * the 60-result ceiling silently becomes 20.
   *
   * Google refuses a paged request whose parameters changed between pages, so the
   * body is built once and only the token varies.
   *
   * `locationRestriction`, not `locationBias`. The two differ in who enforces the
   * geography: a bias is a preference and lets out-of-area results through, which
   * R2 then filtered by testing Places coordinates against the campaign area —
   * the containment analysis EEA ToS §3.3.2(c)(iv) speaks to. A restriction is
   * enforced by Google ("the region which the results must be within"), so the
   * geography is settled before any coordinate reaches us. Text Search accepts a
   * restriction only as a rectangular viewport, so a tile's disc is passed as its
   * bounding box; the slight over-inclusion at the corners is harmless because the
   * precise geography check runs later, on the address an independent source gives.
   */
  async searchText(
    query: string,
    area: { center: Point; radiusKm: number; label: string },
    options: { regionCode: string; languageCode: string; pageToken?: string },
  ): Promise<SearchTextPage> {
    const plan = PLACES_MASKS.discovery();
    const box = boundingBox(area.center, area.radiusKm);
    const body = JSON.stringify({
      textQuery: query,
      languageCode: options.languageCode,
      regionCode: options.regionCode,
      locationRestriction: {
        rectangle: {
          low: { latitude: box.south, longitude: box.west },
          high: { latitude: box.north, longitude: box.east },
        },
      },
      pageSize: 20,
      ...(options.pageToken ? { pageToken: options.pageToken } : {}),
    });

    const payload = await this.call<SearchTextResponse>(plan, `${PLACES_HOST}/v1/places:searchText`, {
      method: 'POST',
      body,
      query,
      areaLabel: area.label,
    });

    const hits = (payload.places ?? [])
      .map((place) => place.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map((placeId) => ({ placeId }));

    return { hits, nextPageToken: payload.nextPageToken ?? null };
  }

  /** Stage 2 — Place Details Essentials: Google's category vocabulary for the place. */
  async fetchCategories(placeId: string): Promise<PlaceCategories> {
    const plan = PLACES_MASKS.locate();
    const payload = await this.details(plan, placeId);
    return { placeId, types: payload.types ?? [] };
  }

  /** Stage 3 — Place Details Pro: the trading name and whether it still trades. */
  async fetchIdentityHints(placeId: string): Promise<PlaceIdentityHints> {
    const plan = PLACES_MASKS.qualify();
    const payload = await this.details(plan, placeId);
    return {
      placeId,
      displayName: payload.displayName?.text?.trim() || null,
      primaryType: payload.primaryType ?? null,
      businessStatus: payload.businessStatus ?? null,
    };
  }

  /** Stage 4 — Place Details Enterprise: the two pointers worth paying for. */
  async fetchPointers(placeId: string): Promise<PlacePointers> {
    const plan = PLACES_MASKS.identify();
    const payload = await this.details(plan, placeId);
    return {
      placeId,
      websiteUri: payload.websiteUri ?? null,
      phone: payload.nationalPhoneNumber ?? null,
    };
  }

  private async details(plan: MaskPlan, placeId: string): Promise<PlaceDetailsResponse> {
    return this.call<PlaceDetailsResponse>(
      plan,
      `${PLACES_HOST}/v1/places/${encodeURIComponent(placeId)}`,
      { method: 'GET', query: null, areaLabel: null },
    );
  }

  private async call<T>(
    plan: MaskPlan,
    url: string,
    options: { method: 'GET' | 'POST'; body?: string; query: string | null; areaLabel: string | null },
  ): Promise<T> {
    const key = env('OUTBOUND_GOOGLE_PLACES_KEY');
    if (!key) throw new Error('OUTBOUND_GOOGLE_PLACES_KEY is not set');

    // Compliance before cost. A call that carries restricted content is refused
    // whether or not it would have been billed: EEA Service Specific Terms §15.2
    // is about the USE of that content, and a free call uses it just as much.
    assertEeaUseAllowed(plan.fields, this.eea);

    // Permission second: nothing leaves the process before the ledger allows it.
    await this.budget.assertCanSpend(plan);

    const billable = plan.envelope !== 'free';
    try {
      const response = await this.http.request(url, {
        method: options.method,
        ...(options.body ? { body: options.body } : {}),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-goog-api-key': key,
          'x-goog-fieldmask': plan.header,
        },
        timeoutMs: this.timeoutMs,
        attempts: 2,
        // Places content may not be cached, so the shared http_cache is bypassed
        // unconditionally. What we avoid re-fetching is tracked per place ID in
        // google_place_candidates instead — our own verdicts, not Google's data.
        noCache: true,
      });

      if (!response.ok) {
        await this.budget.record(plan, {
          billable,
          cacheHit: false,
          resultsCount: 0,
          query: options.query,
          areaLabel: options.areaLabel,
          httpStatus: response.status,
          error: `HTTP ${response.status}`,
        });
        throw new HttpError(`Places HTTP ${response.status}`, response.status, url);
      }

      const parsed = JSON.parse(response.body) as T;
      const resultsCount = Array.isArray((parsed as { places?: unknown[] }).places)
        ? ((parsed as { places: unknown[] }).places.length ?? 0)
        : 1;

      await this.budget.record(plan, {
        billable,
        cacheHit: false,
        resultsCount,
        query: options.query,
        areaLabel: options.areaLabel,
        httpStatus: response.status,
        error: null,
      });

      this.logger.info('places.call', {
        endpoint: plan.endpoint,
        tier: plan.tier,
        sku: plan.sku,
        billable,
        results: resultsCount,
      });

      return parsed;
    } catch (error) {
      if (error instanceof PlacesBudgetExceededError) throw error;
      if (error instanceof HttpError) throw error;
      await this.budget.record(plan, {
        billable,
        cacheHit: false,
        resultsCount: 0,
        query: options.query,
        areaLabel: options.areaLabel,
        httpStatus: null,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
