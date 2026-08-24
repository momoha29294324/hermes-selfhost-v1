/**
 * Private HTTP API.
 *
 * "Private" is enforced three ways, not one: the socket binds to a single
 * interface (loopback, or the host's Tailscale address), UFW only admits
 * tailscale0, and every route except the liveness probe requires a bearer token
 * compared in constant time. None of the three is sufficient alone.
 *
 * This service reads the public web and reports what it saw. It has no code
 * path that sends anything to a prospect, and it must not acquire one.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadConfig, describeConfig, type WebIntelConfig } from './config.js';
import { createLogger, errorMessage, type Logger } from './log.js';
import { BreakerRegistry } from './breaker.js';
import { DiskCache } from './cache.js';
import { Fetcher } from './fetcher.js';
import { BrowserPool } from './browser.js';
import { SearchClient } from './searxng.js';
import { PageFetcher, crawlSite } from './crawler.js';
import { resolveBusiness } from './resolve.js';
import {
  buildFunnelReport,
  extractContacts,
  extractDescription,
  extractFunnelFromPage,
  extractHeadings,
  extractTitle,
} from './extract.js';
import { SsrfError } from './ssrf.js';
import { FetchFailure } from './fetcher.js';
import { BrowserUnavailable } from './browser.js';
import type {
  CrawlRequest,
  ExtractRequest,
  ExtractResponse,
  FetchRequest,
  FetchResponse,
  HealthResponse,
  ResolveRequest,
  SearchRequest,
} from './types.js';

const startedAt = Date.now();

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'HttpProblem';
  }
}

/** Constant-time bearer comparison, so the token cannot be guessed by timing. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so the failure takes the same shape.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new HttpProblem(413, 'corps de requête trop volumineux', 'body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => reject(error));
  });
}

function parseJson<T>(raw: string): T {
  if (raw.trim().length === 0) throw new HttpProblem(400, 'corps JSON vide', 'empty_body');
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpProblem(400, 'corps JSON illisible', 'invalid_json');
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpProblem(400, `champ « ${field} » requis`, 'missing_field');
  }
  return value.trim();
}

/** Bounded concurrency, so a burst of crawls cannot swamp a shared host. */
class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.waiting.shift();
      if (next) next();
    }
  }

  get inFlight(): number {
    return this.active;
  }
}

export interface Services {
  config: WebIntelConfig;
  logger: Logger;
  breakers: BreakerRegistry;
  cache: DiskCache;
  fetcher: Fetcher;
  browser: BrowserPool;
  search: SearchClient;
  pages: PageFetcher;
  crawlLimiter: Semaphore;
}

export function createServices(config: WebIntelConfig): Services {
  const logger = createLogger(config.logLevel);
  const breakers = new BreakerRegistry({
    failureThreshold: config.breakerFailureThreshold,
    cooldownMs: config.breakerCooldownMs,
  });
  const cache = new DiskCache({ dir: config.cacheDir, maxEntryBytes: config.cacheMaxEntryBytes });
  const fetcher = new Fetcher({
    userAgent: config.userAgent,
    timeoutMs: config.fetchTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    maxRedirects: config.maxRedirects,
    minHostIntervalMs: config.minHostIntervalMs,
    respectRobots: config.respectRobots,
    cache,
    logger,
  });
  const browser = new BrowserPool({
    enabled: config.browserEnabled,
    maxContexts: config.browserMaxContexts,
    navTimeoutMs: config.browserNavTimeoutMs,
    hardKillMs: config.browserHardKillMs,
    idleShutdownMs: config.browserIdleShutdownMs,
    executablePath: config.browserExecutablePath,
    logger,
  });
  const search = new SearchClient({
    baseUrl: config.searxngUrl,
    timeoutMs: config.searxngTimeoutMs,
    defaultEngines: config.searchEngines,
    locale: config.searchLocale,
    cache,
    cacheTtlMs: config.cacheTtlSearchMs,
    breakers,
    logger,
  });
  const pages = new PageFetcher({
    fetcher,
    browser,
    cache,
    cacheTtlMs: config.cacheTtlPageMs,
    maxResponseBytes: config.maxResponseBytes,
    respectRobots: config.respectRobots,
    logger,
  });

  return {
    config,
    logger,
    breakers,
    cache,
    fetcher,
    browser,
    search,
    pages,
    crawlLimiter: new Semaphore(config.maxConcurrentCrawls),
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
async function handleSearch(services: Services, body: SearchRequest): Promise<unknown> {
  const query = requireString(body.query, 'query');
  return services.search.search(query, {
    ...(body.limit === undefined ? {} : { limit: body.limit }),
    ...(body.engines === undefined ? {} : { engines: body.engines }),
    ...(body.locale === undefined ? {} : { locale: body.locale }),
    ...(body.noCache === undefined ? {} : { noCache: body.noCache }),
  });
}

async function handleFetch(services: Services, body: FetchRequest): Promise<FetchResponse> {
  const url = requireString(body.url, 'url');
  const robotsAllowed = await services.pages.isAllowedByRobots(url);
  if (!robotsAllowed && !body.ignoreRobots) {
    return { page: null, robotsAllowed: false, error: 'robots.txt interdit cette page' };
  }
  const page = await services.pages.fetchPage(url, {
    ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
    ...(body.render === undefined ? {} : { forceRender: body.render }),
    ...(body.noCache === undefined ? {} : { noCache: body.noCache }),
    ...(body.maxBytes === undefined ? {} : { maxBytes: body.maxBytes }),
  });
  return { page, robotsAllowed, error: null };
}

async function handleCrawl(services: Services, body: CrawlRequest): Promise<unknown> {
  const url = requireString(body.url, 'url');
  const { config } = services;
  return services.crawlLimiter.run(() =>
    crawlSite(services.pages, services.logger, url, {
      maxPages: Math.min(body.maxPages ?? config.crawlMaxPages, 25),
      maxDepth: Math.min(body.maxDepth ?? config.crawlMaxDepth, 4),
      budgetMs: Math.min(body.timeoutMs ?? config.crawlBudgetMs, 240_000),
      respectRobots: config.respectRobots,
      ...(body.allowedHost === undefined ? {} : { allowedHost: body.allowedHost }),
      ...(body.noCache === undefined ? {} : { noCache: body.noCache }),
      ...(body.includeHtml === undefined ? {} : { includeHtml: body.includeHtml }),
    }),
  );
}

async function handleExtract(services: Services, body: ExtractRequest): Promise<ExtractResponse> {
  let html = body.html ?? '';
  let sourceUrl = body.sourceUrl ?? body.url ?? 'inline';

  if (!html) {
    const url = requireString(body.url, 'url (ou html)');
    const page = await services.pages.fetchPage(url);
    html = page.html;
    sourceUrl = page.finalUrl;
  }

  return {
    sourceUrl,
    funnel: buildFunnelReport([{ sourceUrl, observations: extractFunnelFromPage(html, sourceUrl) }]),
    contacts: extractContacts(html),
    title: extractTitle(html),
    description: extractDescription(html),
    headings: extractHeadings(html),
    observedAt: new Date().toISOString(),
  };
}

async function handleResolve(services: Services, body: ResolveRequest): Promise<unknown> {
  requireString(body.name, 'name');
  return resolveBusiness({ search: services.search, pages: services.pages, logger: services.logger }, body);
}

async function handleHealth(services: Services, full: boolean): Promise<HealthResponse> {
  const base: HealthResponse = {
    status: 'ok',
    version: services.config.version,
    uptimeMs: Date.now() - startedAt,
  };
  if (!full) return base;

  const searxng = await services.search.health();
  const engines = services.search.availableEngines();
  const usage = await services.cache.usage();
  const browserStats = services.browser.stats();

  const searchStatus = searxng.ok
    ? engines.allowed.length === 0
      ? 'down'
      : engines.skipped.length > 0
        ? 'degraded'
        : 'ok'
    : 'down';

  const status: HealthResponse['status'] =
    searchStatus === 'down' ? 'degraded' : services.breakers.anyOpen() ? 'degraded' : 'ok';

  return {
    ...base,
    status,
    components: {
      search: {
        status: searchStatus,
        detail: searxng.detail,
        enginesAllowed: engines.allowed,
        enginesSkipped: engines.skipped,
      },
      crawler: {
        status: 'ok',
        detail: 'HTTP fetcher opérationnel',
        ...services.pages.stats(),
        ssrfBlocked: services.fetcher.blockedBySsrf,
        crawlsInFlight: services.crawlLimiter.inFlight,
      },
      browser: {
        status: services.config.browserEnabled ? 'ok' : 'disabled',
        detail: services.config.browserEnabled
          ? `Chromium, ${services.config.browserMaxContexts} contexte(s) max`
          : 'rendu navigateur désactivé',
        ...browserStats,
      },
      cache: {
        status: 'ok',
        detail: services.config.cacheDir,
        ...usage,
        ...services.cache.getStats(),
      },
    },
    breakers: Object.fromEntries(
      Object.entries(services.breakers.snapshot()).map(([key, value]) => [
        key,
        { state: value.state, failures: value.failures, openedAt: value.openedAt },
      ]),
    ),
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
function sendJson(res: ServerResponse, status: number, payload: unknown, requestId: string): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-request-id': requestId,
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function statusForError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof HttpProblem) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof SsrfError) return { status: 400, code: `ssrf_${error.reason}`, message: error.message };
  if (error instanceof FetchFailure) {
    const status = error.reason === 'timeout' ? 504 : 502;
    return { status, code: error.reason, message: error.message };
  }
  if (error instanceof BrowserUnavailable) {
    return { status: error.reason === 'disabled' ? 501 : 503, code: `browser_${error.reason}`, message: error.message };
  }
  return { status: 500, code: 'internal_error', message: errorMessage(error) };
}

export function createApp(services: Services) {
  const { config, logger } = services;

  return createServer((req, res) => {
    const requestId = randomUUID();
    const started = Date.now();
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${config.host}:${config.port}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const requestLogger = logger.child({ requestId, method, path });

    // A request must never be able to hold a connection open forever.
    res.setTimeout(config.requestTimeoutMs + 5_000, () => {
      if (!res.headersSent) sendJson(res, 504, { error: 'request_timeout', requestId }, requestId);
      else res.end();
    });

    void (async () => {
      try {
        // Liveness is unauthenticated on purpose so an external monitor can see
        // the process is up. It exposes no data beyond that.
        if (method === 'GET' && path === '/health' && url.searchParams.get('full') !== '1') {
          sendJson(res, 200, await handleHealth(services, false), requestId);
          return;
        }

        if (config.authToken.length === 0) {
          throw new HttpProblem(500, 'WEBINTEL_TOKEN non configuré : service refusé', 'no_token_configured');
        }
        const header = req.headers['authorization'] ?? '';
        const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
        if (!provided || !tokenMatches(provided, config.authToken)) {
          requestLogger.warn('auth.rejected', { remote: req.socket.remoteAddress });
          sendJson(res, 401, { error: 'unauthorized', requestId }, requestId);
          return;
        }

        if (method === 'GET' && path === '/health') {
          sendJson(res, 200, await handleHealth(services, true), requestId);
          return;
        }
        if (method === 'GET' && path === '/diagnostics') {
          sendJson(
            res,
            200,
            {
              config: describeConfig(config),
              breakers: services.breakers.snapshot(),
              cache: { ...services.cache.getStats(), ...(await services.cache.usage()) },
              browser: services.browser.stats(),
              fetcher: { ...services.pages.stats(), ssrfBlocked: services.fetcher.blockedBySsrf },
              requestId,
            },
            requestId,
          );
          return;
        }

        if (method !== 'POST') throw new HttpProblem(405, `méthode ${method} non autorisée`, 'method_not_allowed');

        const raw = await readBody(req, config.maxBodyBytes);

        switch (path) {
          case '/search':
            sendJson(res, 200, await handleSearch(services, parseJson<SearchRequest>(raw)), requestId);
            return;
          case '/resolve-business':
            sendJson(res, 200, await handleResolve(services, parseJson<ResolveRequest>(raw)), requestId);
            return;
          case '/fetch':
            sendJson(res, 200, await handleFetch(services, parseJson<FetchRequest>(raw)), requestId);
            return;
          case '/crawl':
            sendJson(res, 200, await handleCrawl(services, parseJson<CrawlRequest>(raw)), requestId);
            return;
          case '/extract':
            sendJson(res, 200, await handleExtract(services, parseJson<ExtractRequest>(raw)), requestId);
            return;
          case '/admin/cache/purge': {
            const removed = await services.cache.purgeExpired();
            sendJson(res, 200, { purged: removed, requestId }, requestId);
            return;
          }
          case '/admin/breakers/reset': {
            services.breakers.reset();
            sendJson(res, 200, { reset: true, requestId }, requestId);
            return;
          }
          default:
            throw new HttpProblem(404, `route inconnue: ${path}`, 'not_found');
        }
      } catch (error) {
        const { status, code, message } = statusForError(error);
        const level = status >= 500 ? 'error' : 'warn';
        requestLogger[level]('request.failed', { status, code, error: message });
        if (!res.headersSent) sendJson(res, status, { error: code, message, requestId }, requestId);
        else res.end();
      } finally {
        requestLogger.info('request.done', { status: res.statusCode, durationMs: Date.now() - started });
      }
    })();
  });
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const services = createServices(config);
  const { logger } = services;

  if (config.authToken.length === 0) {
    logger.error('startup.no_token', {
      detail: 'WEBINTEL_TOKEN est vide — toutes les routes seront refusées',
    });
  }
  if (config.host === '0.0.0.0' || config.host === '::') {
    logger.error('startup.public_bind_refused', { host: config.host });
    throw new Error('WEBINTEL_HOST=0.0.0.0 est refusé : ce service ne doit pas écouter publiquement');
  }

  const server = createApp(services);
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  logger.info('startup.listening', describeConfig(config));

  // Housekeeping: expired cache entries are dropped hourly so the disk does not
  // grow without bound between campaign runs.
  const purgeTimer = setInterval(() => {
    void services.cache.purgeExpired().then((removed) => {
      if (removed > 0) logger.info('cache.purged', { removed });
    });
  }, 60 * 60 * 1000);
  purgeTimer.unref();

  const shutdown = (signal: string): void => {
    logger.info('shutdown.started', { signal });
    clearInterval(purgeTimer);
    server.close(() => undefined);
    void (async () => {
      await services.browser.shutdown().catch(() => undefined);
      await services.fetcher.close().catch(() => undefined);
      logger.info('shutdown.done', { signal });
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const entrypoint = process.argv[1];
const invokedDirectly = entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
if (invokedDirectly || process.env['WEBINTEL_AUTOSTART'] === '1') {
  main().catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
