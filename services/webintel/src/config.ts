/**
 * Worker configuration. Every value is an environment variable so the systemd
 * unit is the single place where behaviour is set on le serveur.
 *
 * Nothing here is ever logged: `describeConfig()` returns the shape of the
 * config, with the auth token reduced to whether one exists.
 */

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value === '' ? fallback : value;
}

function int(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function list(env: Env, key: string, fallback: string[]): string[] {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Engines enabled by default, in the order they were measured to answer from
 * le serveur. Kept in sync with deploy/selfhost/searxng/settings.yml — that file
 * is the outer bound, this list is what a request actually asks for.
 */
export const DEFAULT_SEARCH_ENGINES = [
  'bing',
  'duckduckgo',
  'duckduckgo web',
  'yep',
  'gabanza',
  'reloado',
  'privacywall',
  'infospace',
  'mojeek',
];

export interface WebIntelConfig {
  version: string;
  /** Interface the API binds to. Never 0.0.0.0 in production. */
  host: string;
  port: number;
  authToken: string;
  requestTimeoutMs: number;
  maxBodyBytes: number;

  searxngUrl: string;
  searxngTimeoutMs: number;
  searchEngines: string[];
  searchLocale: string;

  userAgent: string;
  crawlerContact: string;
  fetchTimeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  minHostIntervalMs: number;
  respectRobots: boolean;

  crawlMaxPages: number;
  crawlMaxDepth: number;
  crawlBudgetMs: number;
  maxConcurrentCrawls: number;

  browserEnabled: boolean;
  browserMaxContexts: number;
  browserNavTimeoutMs: number;
  browserHardKillMs: number;
  browserIdleShutdownMs: number;
  browserExecutablePath: string | null;

  cacheDir: string;
  cacheTtlSearchMs: number;
  cacheTtlPageMs: number;
  cacheTtlResolveMs: number;
  cacheMaxEntryBytes: number;

  breakerFailureThreshold: number;
  breakerCooldownMs: number;

  logLevel: LogLevel;
}

export function loadConfig(env: Env = process.env): WebIntelConfig {
  const contact = str(env, 'WEBINTEL_CRAWLER_CONTACT', 'contact@hermes.agency');
  const rawLevel = str(env, 'WEBINTEL_LOG_LEVEL', 'info');
  const logLevel: LogLevel = (LOG_LEVELS as readonly string[]).includes(rawLevel)
    ? (rawLevel as LogLevel)
    : 'info';

  return {
    version: str(env, 'WEBINTEL_VERSION', '0.1.0'),
    host: str(env, 'WEBINTEL_HOST', '127.0.0.1'),
    port: int(env, 'WEBINTEL_PORT', 8099),
    authToken: str(env, 'WEBINTEL_TOKEN', ''),
    requestTimeoutMs: int(env, 'WEBINTEL_REQUEST_TIMEOUT_MS', 120_000),
    maxBodyBytes: int(env, 'WEBINTEL_MAX_BODY_BYTES', 2_000_000),

    searxngUrl: str(env, 'WEBINTEL_SEARXNG_URL', 'http://127.0.0.1:8088'),
    searxngTimeoutMs: int(env, 'WEBINTEL_SEARXNG_TIMEOUT_MS', 25_000),
    searchEngines: list(env, 'WEBINTEL_SEARCH_ENGINES', DEFAULT_SEARCH_ENGINES),
    searchLocale: str(env, 'WEBINTEL_SEARCH_LOCALE', 'fr'),

    userAgent: str(env, 'WEBINTEL_USER_AGENT', `HermesWebIntelBot/0.1 (+${contact})`),
    crawlerContact: contact,
    fetchTimeoutMs: int(env, 'WEBINTEL_FETCH_TIMEOUT_MS', 20_000),
    maxResponseBytes: int(env, 'WEBINTEL_MAX_RESPONSE_BYTES', 1_500_000),
    maxRedirects: int(env, 'WEBINTEL_MAX_REDIRECTS', 5),
    minHostIntervalMs: int(env, 'WEBINTEL_MIN_HOST_INTERVAL_MS', 1_100),
    respectRobots: bool(env, 'WEBINTEL_RESPECT_ROBOTS', true),

    crawlMaxPages: int(env, 'WEBINTEL_CRAWL_MAX_PAGES', 6),
    crawlMaxDepth: int(env, 'WEBINTEL_CRAWL_MAX_DEPTH', 2),
    crawlBudgetMs: int(env, 'WEBINTEL_CRAWL_BUDGET_MS', 90_000),
    maxConcurrentCrawls: int(env, 'WEBINTEL_MAX_CONCURRENT_CRAWLS', 2),

    browserEnabled: bool(env, 'WEBINTEL_BROWSER_ENABLED', true),
    // 6 cores and ~3.5 GiB free on a host that already runs a dozen services:
    // one page at a time is the honest ceiling here.
    browserMaxContexts: int(env, 'WEBINTEL_BROWSER_MAX_CONTEXTS', 1),
    browserNavTimeoutMs: int(env, 'WEBINTEL_BROWSER_NAV_TIMEOUT_MS', 25_000),
    browserHardKillMs: int(env, 'WEBINTEL_BROWSER_HARD_KILL_MS', 10_000),
    browserIdleShutdownMs: int(env, 'WEBINTEL_BROWSER_IDLE_SHUTDOWN_MS', 120_000),
    browserExecutablePath: str(env, 'WEBINTEL_BROWSER_EXECUTABLE', '') || null,

    cacheDir: str(env, 'WEBINTEL_CACHE_DIR', '/var/lib/hermes-webintel/cache'),
    cacheTtlSearchMs: int(env, 'WEBINTEL_CACHE_TTL_SEARCH_MS', 12 * 60 * 60 * 1000),
    cacheTtlPageMs: int(env, 'WEBINTEL_CACHE_TTL_PAGE_MS', 7 * 24 * 60 * 60 * 1000),
    cacheTtlResolveMs: int(env, 'WEBINTEL_CACHE_TTL_RESOLVE_MS', 14 * 24 * 60 * 60 * 1000),
    cacheMaxEntryBytes: int(env, 'WEBINTEL_CACHE_MAX_ENTRY_BYTES', 4_000_000),

    breakerFailureThreshold: int(env, 'WEBINTEL_BREAKER_FAILURES', 3),
    breakerCooldownMs: int(env, 'WEBINTEL_BREAKER_COOLDOWN_MS', 10 * 60 * 1000),

    logLevel,
  };
}

/** Safe to log: no token, no secret, just the operating shape. */
export function describeConfig(config: WebIntelConfig): Record<string, unknown> {
  return {
    version: config.version,
    bind: `${config.host}:${config.port}`,
    authTokenConfigured: config.authToken.length > 0,
    searxngUrl: config.searxngUrl,
    searchEngines: config.searchEngines.length,
    browserEnabled: config.browserEnabled,
    browserMaxContexts: config.browserMaxContexts,
    crawlMaxPages: config.crawlMaxPages,
    crawlMaxDepth: config.crawlMaxDepth,
    respectRobots: config.respectRobots,
    cacheDir: config.cacheDir,
  };
}
