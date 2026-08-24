import { createHash } from 'node:crypto';
import { env, envInt } from '@/lib/env';
import { logger } from '@/lib/logging/logger';
import { withRetry, withTimeout, defaultSleep } from '@/lib/util/retry';
import type { Sql } from '@/lib/db/sql';

/**
 * Outbound HTTP with the manners this project requires:
 *   - identifiable User-Agent with a contact address
 *   - per-host rate limiting (serialised, minimum delay between calls)
 *   - robots.txt consulted before crawling a business website
 *   - bounded retries with backoff, hard timeouts
 *   - optional persistent response cache so re-runs are idempotent and cheap
 */

export interface HttpResponse {
  url: string;
  status: number;
  ok: boolean;
  body: string;
  contentType: string | null;
  fromCache: boolean;
}

export interface HttpOptions {
  timeoutMs?: number;
  attempts?: number;
  headers?: Record<string, string>;
  /**
   * `PUT` existe pour les API qui distinguent création et mise à jour
   * (l'idempotence d'une intégration CRM en dépend : sans lui, un update
   * deviendrait un second create). Comme `POST`, il n'est jamais mis en cache.
   */
  method?: 'GET' | 'POST' | 'PUT';
  body?: string;
  /**
   * Skip the cache for this call — in BOTH directions.
   *
   * It used to mean "do not read", which left the write in place: a caller that
   * asked not to be cached was cached anyway. For Places that is a compliance
   * failure rather than a performance quirk, since the payload may not be
   * stored at all, so the flag now means what its name says.
   */
  noCache?: boolean;
  /** Max bytes read from the response body. */
  maxBytes?: number;
  cacheTtlMs?: number;
  /**
   * Politique de redirection de CET appel. `follow` par défaut, ce dont a
   * besoin l'exploration du web ouvert : un site d'entreprise qui a déménagé
   * reste cette entreprise.
   *
   * Un pair interne épinglé demande l'inverse. Là, la destination EST la
   * propriété de sécurité : un 3xx doit remonter comme une réponse à refuser,
   * pas comme un saut à effectuer. `manual` rend le 3xx lui-même — refusable
   * ET lisible ; `error` le rejette comme une panne de transport.
   */
  redirect?: RequestRedirect;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 1_500_000;
const MIN_HOST_INTERVAL_MS = 1_100;

export function userAgent(): string {
  const contact = env('OUTBOUND_CRAWLER_CONTACT', 'contact@hermes.agency');
  return `HermesOutboundBot/0.1 (+${contact})`;
}

const hostQueues = new Map<string, Promise<void>>();
const lastCallAt = new Map<string, number>();

/** Serialises calls per host and enforces a minimum spacing between them. */
async function rateLimit(host: string, minIntervalMs: number): Promise<void> {
  const previous = hostQueues.get(host) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  hostQueues.set(
    host,
    previous.then(() => gate),
  );
  await previous;
  const last = lastCallAt.get(host) ?? 0;
  const wait = last + minIntervalMs - Date.now();
  if (wait > 0) await defaultSleep(wait);
  lastCallAt.set(host, Date.now());
  // Release the gate on the next tick so the following caller can proceed.
  setTimeout(release, 0);
}

export interface HttpClientDeps {
  sql?: Sql | null;
  minHostIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpClient {
  private readonly sql: Sql | null;
  private readonly minHostIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly robotsCache = new Map<string, string | null>();

  constructor(deps: HttpClientDeps = {}) {
    this.sql = deps.sql ?? null;
    this.minHostIntervalMs = deps.minHostIntervalMs ?? MIN_HOST_INTERVAL_MS;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async get(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
    return this.request(url, { ...options, method: 'GET' });
  }

  async request(url: string, options: HttpOptions = {}): Promise<HttpResponse> {
    const method = options.method ?? 'GET';
    const cacheKey = this.cacheKey(method, url, options.body);
    const ttl = options.cacheTtlMs ?? envInt('OUTBOUND_HTTP_CACHE_TTL_MS', 24 * 60 * 60 * 1000);

    if (!options.noCache && method === 'GET') {
      const cached = await this.readCache(cacheKey, ttl);
      if (cached) return cached;
    }

    const parsed = new URL(url);
    await rateLimit(parsed.host, this.minHostIntervalMs);

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const attempts = options.attempts ?? 3;

    const response = await withRetry(
      async () =>
        withTimeout(timeoutMs, `${method} ${parsed.host}`, async (signal) => {
          const res = await this.fetchImpl(url, {
            method,
            signal,
            redirect: options.redirect ?? 'follow',
            headers: {
              'user-agent': userAgent(),
              accept: options.headers?.['accept'] ?? 'text/html,application/json;q=0.9,*/*;q=0.8',
              'accept-language': 'fr-FR,fr;q=0.9,en;q=0.6',
              ...options.headers,
            },
            ...(options.body ? { body: options.body } : {}),
          });

          if (res.status === 429 || res.status >= 500) {
            throw new HttpError(`upstream ${res.status}`, res.status, url);
          }

          const body = await this.readBody(res, options.maxBytes ?? DEFAULT_MAX_BYTES);
          return {
            url: res.url || url,
            status: res.status,
            ok: res.ok,
            body,
            contentType: res.headers.get('content-type'),
            fromCache: false,
          } satisfies HttpResponse;
        }),
      {
        attempts,
        baseDelayMs: 700,
        maxDelayMs: 6_000,
        retryable: (error) => !(error instanceof HttpError && error.status !== null && error.status < 500 && error.status !== 429),
        onRetry: (error, attempt, delayMs) =>
          logger.warn('http.retry', {
            url,
            attempt,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          }),
      },
    );

    if (method === 'GET' && !options.noCache) await this.writeCache(cacheKey, response);
    return response;
  }

  /** Fetches JSON, throwing on non-2xx or unparseable payloads. */
  async getJson<T>(url: string, options: HttpOptions = {}): Promise<T> {
    const res = await this.get(url, {
      ...options,
      headers: { accept: 'application/json', ...options.headers },
    });
    if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status, url);
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new HttpError('invalid JSON payload', res.status, url);
    }
  }

  /**
   * Consults robots.txt. Returns true only when the path is allowed for our UA
   * (or when robots.txt is absent / unreadable, which the standard treats as allow).
   */
  async isAllowedByRobots(url: string): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const origin = parsed.origin;
    let robots = this.robotsCache.get(origin);
    if (robots === undefined) {
      try {
        const res = await this.get(`${origin}/robots.txt`, { timeoutMs: 8_000, attempts: 1 });
        robots = res.ok ? res.body : null;
      } catch {
        robots = null;
      }
      this.robotsCache.set(origin, robots);
    }
    if (!robots) return true;
    return isPathAllowed(robots, parsed.pathname || '/');
  }

  private async readBody(res: Response, maxBytes: number): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return res.text();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= maxBytes) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }

  private cacheKey(method: string, url: string, body?: string): string {
    return createHash('sha256').update(`${method} ${url} ${body ?? ''}`).digest('hex');
  }

  private async readCache(key: string, ttlMs: number): Promise<HttpResponse | null> {
    if (!this.sql) return null;
    const rows = await this.sql.query<{
      url: string;
      status: number;
      body: string | null;
      content_type: string | null;
      fetched_at: Date | string;
    }>('select url, status, body, content_type, fetched_at from http_cache where cache_key = $1', [key]);
    const row = rows[0];
    if (!row) return null;
    const fetchedAt = new Date(row.fetched_at).getTime();
    if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt > ttlMs) return null;
    return {
      url: row.url,
      status: row.status,
      ok: row.status >= 200 && row.status < 300,
      body: row.body ?? '',
      contentType: row.content_type,
      fromCache: true,
    };
  }

  private async writeCache(key: string, response: HttpResponse): Promise<void> {
    if (!this.sql) return;
    await this.sql.query(
      `insert into http_cache (cache_key, url, status, body, content_type, fetched_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (cache_key) do update
         set url = excluded.url, status = excluded.status, body = excluded.body,
             content_type = excluded.content_type, fetched_at = now()`,
      [key, response.url, response.status, response.body, response.contentType],
    );
  }
}

/**
 * Minimal robots.txt evaluation for our own user-agent, falling back to `*`.
 * Longest matching rule wins, Allow beats Disallow at equal length (RFC 9309).
 */
export function isPathAllowed(robotsTxt: string, path: string, agent = 'hermesoutboundbot'): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  let current: { agents: string[]; rules: { allow: boolean; pattern: string }[] } | null = null;
  let lastWasAgent = false;

  for (const rawLine of robotsTxt.split('\n')) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      if (!current) continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
    }
  }

  const specific = groups.find((g) => g.agents.some((a) => a === agent));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const group = specific ?? wildcard;
  if (!group) return true;

  let best: { allow: boolean; length: number } | null = null;
  for (const rule of group.rules) {
    if (rule.pattern === '') continue;
    if (!matchesPattern(rule.pattern, path)) continue;
    const length = rule.pattern.replace(/\*/g, '').length;
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length };
    }
  }
  return best ? best.allow : true;
}

function matchesPattern(pattern: string, path: string): boolean {
  const anchoredEnd = pattern.endsWith('$');
  const body = anchoredEnd ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const regex = new RegExp(`^${escaped}${anchoredEnd ? '$' : ''}`);
  return regex.test(path);
}
