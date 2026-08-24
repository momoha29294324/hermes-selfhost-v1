/**
 * Page fetching and bounded crawling.
 *
 * The crawl is deliberately small and ordered: a handful of pages, chosen for
 * how likely they are to carry a commercial signal (contact, devis, tarifs,
 * prestations, réservation) rather than in link order. A prospect's site is
 * read to answer a few questions, not archived.
 *
 * Three budgets bound every crawl — pages, depth and wall-clock — and whichever
 * runs out first is reported, so a thin result is never mistaken for a thin site.
 */
import { Fetcher, FetchFailure } from './fetcher.js';
import { BrowserPool, BrowserUnavailable } from './browser.js';
import { DiskCache } from './cache.js';
import {
  buildFunnelReport,
  extractFunnelFromPage,
  extractInternalLinks,
  needsBrowserRender,
} from './extract.js';
import { assertSafeUrl, SsrfError } from './ssrf.js';
import type { Logger } from './log.js';
import { errorMessage } from './log.js';
import type { CrawlResponse, FetchedPage } from './types.js';

export interface PageFetcherOptions {
  fetcher: Fetcher;
  browser: BrowserPool;
  cache: DiskCache;
  cacheTtlMs: number;
  maxResponseBytes: number;
  respectRobots: boolean;
  logger: Logger;
}

export interface FetchPageOptions {
  timeoutMs?: number;
  /** Render in a browser regardless of what HTTP returned. */
  forceRender?: boolean;
  /** Never render, even if HTTP came back as a shell. */
  noRender?: boolean;
  noCache?: boolean;
  maxBytes?: number;
}

export class PageFetcher {
  private browserFallbacks = 0;
  private httpFetches = 0;

  constructor(private readonly options: PageFetcherOptions) {}

  stats(): Record<string, number> {
    return { httpFetches: this.httpFetches, browserFallbacks: this.browserFallbacks };
  }

  /**
   * Fetches one page over HTTP, escalating to a browser render only when the
   * response is unusable without JavaScript.
   */
  async fetchPage(rawUrl: string, options: FetchPageOptions = {}): Promise<FetchedPage> {
    const url = assertSafeUrl(rawUrl);
    const started = Date.now();
    const cacheKey = DiskCache.key('page', url.toString(), options.forceRender ? 'render' : 'http');

    if (!options.noCache) {
      const cached = await this.options.cache.get<FetchedPage>(cacheKey);
      if (cached) {
        this.options.logger.debug('fetch.cache_hit', { url: url.toString() });
        return { ...cached, fromCache: true, durationMs: Date.now() - started };
      }
    }

    let page: FetchedPage;

    if (options.forceRender) {
      page = await this.render(url.toString(), started, 'forced');
    } else {
      const outcome = await this.options.fetcher.fetch(url.toString(), {
        timeoutMs: options.timeoutMs,
        maxBytes: options.maxBytes ?? this.options.maxResponseBytes,
      });
      this.httpFetches += 1;

      const isHtml = (outcome.contentType ?? '').includes('html') || outcome.body.trimStart().startsWith('<');
      const verdict = isHtml ? needsBrowserRender(outcome.body) : { needed: false, reason: null };

      if (verdict.needed && !options.noRender) {
        try {
          page = await this.render(outcome.finalUrl, started, verdict.reason ?? 'unknown');
        } catch (error) {
          // A browser that will not render must not lose the HTTP result.
          this.options.logger.warn('fetch.render_failed_keeping_http', {
            url: url.toString(),
            error: errorMessage(error),
          });
          page = httpPage(url.toString(), outcome, verdict.reason);
        }
      } else {
        page = httpPage(url.toString(), outcome, verdict.needed ? verdict.reason : null);
      }
    }

    page.durationMs = Date.now() - started;
    await this.options.cache.set(cacheKey, 'page', page, this.options.cacheTtlMs);
    return page;
  }

  private async render(url: string, started: number, reason: string): Promise<FetchedPage> {
    const result = await this.options.browser.render(url);
    this.browserFallbacks += 1;
    this.options.logger.info('fetch.browser_fallback', { url, reason, durationMs: result.durationMs });
    const bytes = Buffer.byteLength(result.html, 'utf8');
    return {
      url,
      finalUrl: result.finalUrl,
      status: result.status,
      ok: result.status === 0 || (result.status >= 200 && result.status < 300),
      contentType: 'text/html',
      html: result.html,
      bytes,
      truncated: false,
      renderedWith: 'browser',
      browserFallbackReason: reason,
      fromCache: false,
      durationMs: Date.now() - started,
      observedAt: new Date().toISOString(),
    };
  }

  async isAllowedByRobots(url: string): Promise<boolean> {
    return this.options.fetcher.isAllowedByRobots(url);
  }
}

function httpPage(
  requestedUrl: string,
  outcome: {
    finalUrl: string;
    status: number;
    ok: boolean;
    contentType: string | null;
    body: string;
    bytes: number;
    truncated: boolean;
  },
  fallbackReason: string | null,
): FetchedPage {
  return {
    url: requestedUrl,
    finalUrl: outcome.finalUrl,
    status: outcome.status,
    ok: outcome.ok,
    contentType: outcome.contentType,
    html: outcome.body,
    bytes: outcome.bytes,
    truncated: outcome.truncated,
    renderedWith: 'http',
    browserFallbackReason: fallbackReason,
    fromCache: false,
    durationMs: 0,
    observedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Crawl
// ---------------------------------------------------------------------------
export interface CrawlOptions {
  maxPages: number;
  maxDepth: number;
  budgetMs: number;
  allowedHost?: string;
  noCache?: boolean;
  includeHtml?: boolean;
  respectRobots: boolean;
}

export async function crawlSite(
  pages: PageFetcher,
  logger: Logger,
  startUrl: string,
  options: CrawlOptions,
): Promise<CrawlResponse> {
  const started = Date.now();
  const start = assertSafeUrl(startUrl);
  const allowedHost = (options.allowedHost ?? start.hostname).replace(/^www\./, '');

  const visited = new Set<string>();
  const crawled: FetchedPage[] = [];
  const skippedByRobots: string[] = [];
  const failed: { url: string; reason: string }[] = [];
  const perPage: { sourceUrl: string; observations: ReturnType<typeof extractFunnelFromPage> }[] = [];

  let budgetExhausted: CrawlResponse['budgetExhausted'] = null;
  const queue: { url: string; depth: number }[] = [{ url: start.toString(), depth: 0 }];

  while (queue.length > 0) {
    if (crawled.length >= options.maxPages) {
      budgetExhausted = 'pages';
      break;
    }
    if (Date.now() - started >= options.budgetMs) {
      budgetExhausted = 'time';
      break;
    }

    const item = queue.shift();
    if (!item) break;
    const normalised = item.url.replace(/\/$/, '') || item.url;
    if (visited.has(normalised)) continue;
    visited.add(normalised);

    // A page outside the allowed host is never fetched, whatever linked to it.
    let parsed: URL;
    try {
      parsed = assertSafeUrl(item.url);
    } catch (error) {
      failed.push({ url: item.url, reason: error instanceof SsrfError ? error.reason : 'unsafe_url' });
      continue;
    }
    if (parsed.hostname.replace(/^www\./, '') !== allowedHost) continue;

    if (options.respectRobots) {
      let allowed = true;
      try {
        allowed = await pages.isAllowedByRobots(item.url);
      } catch (error) {
        if (error instanceof SsrfError) {
          // A host that only reveals itself as private at resolution time.
          failed.push({ url: item.url, reason: error.reason });
          continue;
        }
        allowed = true; // unreadable robots.txt means allowed (RFC 9309)
      }
      if (!allowed) {
        skippedByRobots.push(item.url);
        logger.info('crawl.robots_disallow', { url: item.url });
        continue;
      }
    }

    const remaining = options.budgetMs - (Date.now() - started);
    try {
      const page = await pages.fetchPage(item.url, {
        timeoutMs: Math.max(5_000, Math.min(25_000, remaining)),
        ...(options.noCache === undefined ? {} : { noCache: options.noCache }),
      });

      if (!page.ok) {
        failed.push({ url: item.url, reason: `http_${page.status}` });
        continue;
      }
      const contentType = page.contentType ?? '';
      if (contentType && !contentType.includes('html') && !contentType.includes('xml')) {
        failed.push({ url: item.url, reason: `content_type_${contentType.split(';')[0]}` });
        continue;
      }

      crawled.push(page);
      perPage.push({ sourceUrl: page.finalUrl, observations: extractFunnelFromPage(page.html, page.finalUrl) });

      if (item.depth < options.maxDepth) {
        for (const link of extractInternalLinks(page.html, page.finalUrl, allowedHost)) {
          const key = link.replace(/\/$/, '') || link;
          if (!visited.has(key)) queue.push({ url: link, depth: item.depth + 1 });
        }
      } else if (queue.length === 0 && crawled.length < options.maxPages) {
        budgetExhausted = budgetExhausted ?? 'depth';
      }
    } catch (error) {
      const reason =
        error instanceof SsrfError
          ? error.reason
          : error instanceof FetchFailure
            ? error.reason
            : error instanceof BrowserUnavailable
              ? `browser_${error.reason}`
              : 'error';
      failed.push({ url: item.url, reason });
      logger.warn('crawl.page_failed', { url: item.url, reason, error: errorMessage(error) });
    }
  }

  const response: CrawlResponse = {
    startUrl: start.toString(),
    allowedHost,
    pages: crawled.map((page) => (options.includeHtml ? page : { ...page, html: '' })),
    skippedByRobots,
    failed,
    funnel: buildFunnelReport(perPage),
    durationMs: Date.now() - started,
    budgetExhausted,
    observedAt: new Date().toISOString(),
  };

  logger.info('crawl.done', {
    startUrl: start.toString(),
    pages: crawled.length,
    failed: failed.length,
    robotsSkipped: skippedByRobots.length,
    funnelObserved: response.funnel.observed.length,
    durationMs: response.durationMs,
    budgetExhausted,
  });

  return response;
}
