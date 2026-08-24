/**
 * Search adapter over the dedicated SearXNG instance.
 *
 * The engine list is pinned per request rather than left to the instance's
 * defaults, for one reason: it makes the circuit breaker meaningful. When an
 * engine starts refusing traffic, it is dropped from the *request*, so the
 * remaining engines answer at full speed instead of waiting on a known-dead one
 * — which is exactly what §13 of the brief asks for. SearXNG reports failures
 * per engine in `unresponsive_engines`, and that is what feeds the breakers.
 *
 * This adapter never falls back to querying an engine directly. If SearXNG is
 * down, search is down, and the pipeline records that rather than improvising.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { BreakerRegistry } from './breaker.js';
import { DiskCache } from './cache.js';
import type { Logger } from './log.js';
import { errorMessage } from './log.js';
import type { SearchHit, SearchResponse } from './types.js';

interface SearxngResult {
  url?: string;
  title?: string;
  content?: string;
  engine?: string;
  engines?: string[];
  score?: number;
}

interface SearxngPayload {
  query?: string;
  results?: SearxngResult[];
  unresponsive_engines?: [string, string][];
}

export interface SearchClientOptions {
  baseUrl: string;
  timeoutMs: number;
  defaultEngines: string[];
  locale: string;
  cache: DiskCache;
  cacheTtlMs: number;
  breakers: BreakerRegistry;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export const SEARXNG_BREAKER_KEY = 'searxng';

export class SearchClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SearchClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Engines currently allowed, in configured order. */
  availableEngines(): { allowed: string[]; skipped: string[] } {
    return mapBreakerKeys(
      this.options.breakers.filterAllowed(this.options.defaultEngines.map((engine) => `engine:${engine}`)),
    );
  }

  async search(
    query: string,
    options: { limit?: number; engines?: string[]; locale?: string; noCache?: boolean } = {},
  ): Promise<SearchResponse> {
    const started = Date.now();
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
    const locale = options.locale ?? this.options.locale;
    const requested = options.engines ?? this.options.defaultEngines;

    const { allowed, skipped } = mapBreakerKeys(
      this.options.breakers.filterAllowed(requested.map((engine) => `engine:${engine}`)),
    );

    if (allowed.length === 0) {
      this.options.logger.warn('search.all_engines_open', { query, skipped });
      return {
        query,
        results: [],
        enginesQueried: [],
        enginesUnresponsive: [],
        enginesSkipped: skipped,
        fromCache: false,
        observedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      };
    }

    const cacheKey = DiskCache.key('search', query, locale, limit, allowed.join(','));
    if (!options.noCache) {
      const cached = await this.options.cache.get<SearchResponse>(cacheKey);
      if (cached) {
        this.options.logger.debug('search.cache_hit', { query, results: cached.results.length });
        return { ...cached, fromCache: true, durationMs: Date.now() - started };
      }
    }

    if (!this.options.breakers.allows(SEARXNG_BREAKER_KEY)) {
      this.options.logger.warn('search.searxng_breaker_open', { query });
      return {
        query,
        results: [],
        enginesQueried: [],
        enginesUnresponsive: [{ engine: 'searxng', reason: 'circuit_open' }],
        enginesSkipped: skipped,
        fromCache: false,
        observedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      };
    }

    const url = new URL('/search', this.options.baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('language', locale);
    url.searchParams.set('safesearch', '0');
    url.searchParams.set('engines', allowed.join(','));

    let payload: SearxngPayload;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await this.fetchImpl(url.toString(), {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`SearXNG HTTP ${response.status}`);
      payload = (await response.json()) as SearxngPayload;
      this.options.breakers.success(SEARXNG_BREAKER_KEY);
    } catch (error) {
      const message = errorMessage(error);
      const state = this.options.breakers.failure(SEARXNG_BREAKER_KEY, message);
      this.options.logger.error('search.failed', { query, error: message, breaker: state });
      return {
        query,
        results: [],
        enginesQueried: allowed,
        enginesUnresponsive: [{ engine: 'searxng', reason: message }],
        enginesSkipped: skipped,
        fromCache: false,
        observedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }

    const unresponsive = (payload.unresponsive_engines ?? []).map(([engine, reason]) => ({
      engine,
      reason: reason ?? 'unknown',
    }));

    // Feed the breakers: an engine that answered is healthy, one that refused
    // counts against it. Three refusals in a row and it stops being asked.
    const failureReason = new Map(unresponsive.map((item) => [item.engine, item.reason]));
    for (const engine of allowed) {
      const reason = failureReason.get(engine);
      if (reason === undefined) this.options.breakers.success(`engine:${engine}`);
      else this.options.breakers.failure(`engine:${engine}`, reason);
    }

    const results = normaliseResults(payload.results ?? [], limit);
    const response: SearchResponse = {
      query,
      results,
      enginesQueried: allowed,
      enginesUnresponsive: unresponsive,
      enginesSkipped: skipped,
      fromCache: false,
      observedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };

    await this.options.cache.set(cacheKey, 'search', response, this.options.cacheTtlMs);
    this.options.logger.info('search.done', {
      query,
      results: results.length,
      engines: allowed.length,
      unresponsive: unresponsive.length,
      skipped: skipped.length,
      durationMs: response.durationMs,
    });
    return response;
  }

  /** Runs several queries in sequence, with a short pause between them. */
  async searchMany(
    queries: string[],
    options: { limit?: number; locale?: string; noCache?: boolean; pauseMs?: number } = {},
  ): Promise<SearchResponse[]> {
    const out: SearchResponse[] = [];
    for (const [index, query] of queries.entries()) {
      if (index > 0 && (options.pauseMs ?? 400) > 0) await delay(options.pauseMs ?? 400);
      out.push(await this.search(query, options));
    }
    return out;
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await this.fetchImpl(new URL('/healthz', this.options.baseUrl).toString(), {
        signal: controller.signal,
      });
      if (response.ok) return { ok: true, detail: `SearXNG ${response.status}` };
      return { ok: false, detail: `SearXNG HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, detail: errorMessage(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function mapBreakerKeys(input: { allowed: string[]; skipped: string[] }): {
  allowed: string[];
  skipped: string[];
} {
  const strip = (key: string): string => key.replace(/^engine:/, '');
  return { allowed: input.allowed.map(strip), skipped: input.skipped.map(strip) };
}

/**
 * Normalises SearXNG results into ranked hits.
 *
 * Deduplicates on the URL, keeping the best rank, and records every engine that
 * surfaced it — agreement between independent engines is a genuine signal that
 * the business resolver uses later.
 */
export function normaliseResults(results: SearxngResult[], limit: number): SearchHit[] {
  const byUrl = new Map<string, SearchHit & { engines: Set<string> }>();
  let rank = 0;

  for (const item of results) {
    const url = (item.url ?? '').trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) continue;

    rank += 1;
    const existing = byUrl.get(url);
    const engineNames = [item.engine, ...(item.engines ?? [])].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );

    if (existing) {
      for (const name of engineNames) existing.engines.add(name);
      if (!existing.snippet && item.content) existing.snippet = item.content.trim();
      continue;
    }

    byUrl.set(url, {
      url,
      title: (item.title ?? '').trim(),
      snippet: (item.content ?? '').trim(),
      engine: engineNames[0] ?? 'unknown',
      rank,
      engines: new Set(engineNames),
    });
  }

  return [...byUrl.values()]
    .sort((a, b) => b.engines.size - a.engines.size || a.rank - b.rank)
    .slice(0, limit)
    .map((hit, index) => ({
      url: hit.url,
      title: hit.title,
      snippet: hit.snippet,
      engine: [...hit.engines].join('+'),
      rank: index + 1,
    }));
}
