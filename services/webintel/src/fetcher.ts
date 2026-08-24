/**
 * Guarded HTTP layer.
 *
 * Everything the worker pulls from the open web goes through here, so this is
 * where the non-negotiables live: SSRF checks at connect time, a hard byte cap,
 * a hard deadline, manual redirect handling with revalidation at every hop,
 * per-host spacing, robots.txt, and an identifiable User-Agent that carries a
 * contact address.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { assertSafeUrl, classifyAddress, SsrfError } from './ssrf.js';
import { isPathAllowed, crawlDelayMs } from './robots.js';
import { DiskCache } from './cache.js';
import type { Logger } from './log.js';
import { errorMessage } from './log.js';

export interface FetchOutcome {
  finalUrl: string;
  status: number;
  ok: boolean;
  contentType: string | null;
  body: string;
  bytes: number;
  truncated: boolean;
  redirects: string[];
  durationMs: number;
}

export class FetchFailure extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly url: string,
  ) {
    super(message);
    this.name = 'FetchFailure';
  }
}

/**
 * DNS lookup that refuses to hand a private address to the socket.
 *
 * This is deliberately installed on the *connect* path rather than run as a
 * pre-flight check: a pre-flight lookup and the socket's own lookup are two
 * separate resolutions, and an attacker who controls the authoritative server
 * can answer them differently. Validating the resolution the socket actually
 * uses closes that window.
 */
export type DnsLookupImpl = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

export function createGuardedLookup(
  onBlocked?: (hostname: string, address: string, reason: string) => void,
  lookupImpl: DnsLookupImpl = dnsLookup as DnsLookupImpl,
): LookupFunction {
  return (hostname, options, callback) => {
    const allOptions = { ...options, all: true } as LookupAllOptions;
    lookupImpl(hostname, allOptions, (error, addresses: LookupAddress[]) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0) {
        callback(new SsrfError(`aucune adresse pour ${hostname}`, hostname, 'no_address'), '', 0);
        return;
      }
      for (const entry of list) {
        const verdict = classifyAddress(entry.address);
        if (verdict.blocked) {
          onBlocked?.(hostname, entry.address, verdict.reason);
          callback(
            new SsrfError(
              `adresse refusée pour ${hostname} (${verdict.reason})`,
              hostname,
              verdict.reason,
            ),
            '',
            0,
          );
          return;
        }
      }
      if (options.all === true) {
        callback(null, list);
        return;
      }
      const first = list[0] as LookupAddress;
      callback(null, first.address, first.family);
    });
  };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Validates a redirect destination.
 *
 * This is why redirects are followed by hand. `redirect: 'follow'` would let a
 * perfectly public URL bounce the request onto 127.0.0.1 or 169.254.169.254 with
 * no second check — the destination is chosen by whoever owns the first hop.
 * Throws `SsrfError` for an unsafe target and `FetchFailure` for a malformed one.
 */
export function nextRedirectUrl(location: string | null | undefined, current: URL): URL {
  if (!location) {
    throw new FetchFailure('redirection sans Location', 'bad_redirect', current.toString());
  }
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new FetchFailure(
      `Location illisible: ${location.slice(0, 120)}`,
      'bad_redirect',
      current.toString(),
    );
  }
  assertSafeUrl(next.toString());
  return next;
}

export interface FetcherOptions {
  userAgent: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  minHostIntervalMs: number;
  respectRobots: boolean;
  cache: DiskCache;
  logger: Logger;
}

export class Fetcher {
  private readonly agent: Agent;
  private readonly hostQueues = new Map<string, Promise<void>>();
  private readonly lastCallAt = new Map<string, number>();
  private readonly robotsMemo = new Map<string, string | null>();
  private ssrfBlocks = 0;

  constructor(private readonly options: FetcherOptions) {
    this.agent = new Agent({
      connect: {
        lookup: createGuardedLookup((hostname, address, reason) => {
          this.ssrfBlocks += 1;
          this.options.logger.warn('ssrf.blocked', { hostname, address, reason });
        }),
        timeout: Math.min(10_000, options.timeoutMs),
      },
      headersTimeout: options.timeoutMs,
      bodyTimeout: options.timeoutMs,
      connections: 8,
      pipelining: 1,
    });
  }

  get blockedBySsrf(): number {
    return this.ssrfBlocks;
  }

  async close(): Promise<void> {
    await this.agent.close().catch(() => undefined);
  }

  /** Serialises calls per host and enforces a minimum spacing between them. */
  private async rateLimit(host: string, minIntervalMs: number): Promise<void> {
    const previous = this.hostQueues.get(host) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.hostQueues.set(
      host,
      previous.then(() => gate),
    );
    await previous;
    const last = this.lastCallAt.get(host) ?? 0;
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastCallAt.set(host, Date.now());
    setTimeout(release, 0);
  }

  /**
   * Fetches a URL, following redirects by hand so every hop is revalidated.
   * `redirect: 'follow'` would let a public URL bounce us onto 127.0.0.1.
   */
  async fetch(
    rawUrl: string,
    options: { timeoutMs?: number; maxBytes?: number; accept?: string } = {},
  ): Promise<FetchOutcome> {
    const started = Date.now();
    const deadline = started + (options.timeoutMs ?? this.options.timeoutMs);
    const maxBytes = options.maxBytes ?? this.options.maxResponseBytes;
    const redirects: string[] = [];

    let current = assertSafeUrl(rawUrl);

    for (let hop = 0; hop <= this.options.maxRedirects; hop += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new FetchFailure('délai dépassé avant la requête', 'timeout', current.toString());
      }

      await this.rateLimit(current.host, await this.hostInterval(current));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
      let response;
      try {
        response = await undiciFetch(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          dispatcher: this.agent,
          headers: {
            'user-agent': this.options.userAgent,
            accept: options.accept ?? 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5',
            'accept-language': 'fr-FR,fr;q=0.9,en;q=0.5',
          },
        });
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof SsrfError) throw error;
        const cause = (error as { cause?: unknown }).cause;
        if (cause instanceof SsrfError) throw cause;
        const aborted = controller.signal.aborted;
        throw new FetchFailure(
          errorMessage(error),
          aborted ? 'timeout' : 'network_error',
          current.toString(),
        );
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        clearTimeout(timer);
        const next = nextRedirectUrl(location, current);
        redirects.push(next.toString());
        current = next;
        continue;
      }

      try {
        const { text, bytes, truncated } = await readCapped(response.body, maxBytes);
        return {
          finalUrl: response.url || current.toString(),
          status: response.status,
          ok: response.status >= 200 && response.status < 300,
          contentType: response.headers.get('content-type'),
          body: text,
          bytes,
          truncated,
          redirects,
          durationMs: Date.now() - started,
        };
      } finally {
        clearTimeout(timer);
      }
    }

    throw new FetchFailure(
      `plus de ${this.options.maxRedirects} redirections`,
      'too_many_redirects',
      current.toString(),
    );
  }

  /** Per-host spacing, raised when robots.txt asks for a longer Crawl-delay. */
  private async hostInterval(url: URL): Promise<number> {
    if (!this.options.respectRobots) return this.options.minHostIntervalMs;
    const robots = this.robotsMemo.get(url.origin);
    if (robots === undefined || robots === null) return this.options.minHostIntervalMs;
    const declared = crawlDelayMs(robots);
    if (declared === null) return this.options.minHostIntervalMs;
    // Honour the site's request, but never let it stall the run for minutes.
    return Math.min(Math.max(declared, this.options.minHostIntervalMs), 10_000);
  }

  /**
   * robots.txt for the origin, cached on disk. An unreadable or absent file is
   * treated as "allowed", which is what RFC 9309 prescribes.
   */
  async robotsFor(origin: string): Promise<string | null> {
    const memo = this.robotsMemo.get(origin);
    if (memo !== undefined) return memo;

    const cacheKey = DiskCache.key('robots', origin);
    const cached = await this.options.cache.get<{ body: string | null }>(cacheKey);
    if (cached) {
      this.robotsMemo.set(origin, cached.body);
      return cached.body;
    }

    let body: string | null = null;
    try {
      const outcome = await this.fetch(`${origin}/robots.txt`, {
        timeoutMs: 8_000,
        maxBytes: 200_000,
        accept: 'text/plain,*/*;q=0.8',
      });
      body = outcome.ok ? outcome.body : null;
    } catch (error) {
      this.options.logger.debug('robots.unavailable', { origin, error: errorMessage(error) });
      body = null;
    }
    this.robotsMemo.set(origin, body);
    await this.options.cache.set(cacheKey, 'robots', { body }, 24 * 60 * 60 * 1000);
    return body;
  }

  /**
   * Throws `SsrfError` for a refused URL rather than reporting it as a robots
   * denial. Conflating the two would put "robots.txt interdit cette page" in
   * the logs for a blocked loopback address — a false explanation is worse than
   * no explanation.
   */
  async isAllowedByRobots(rawUrl: string): Promise<boolean> {
    const url = assertSafeUrl(rawUrl);
    if (!this.options.respectRobots) return true;
    const robots = await this.robotsFor(url.origin);
    if (!robots) return true;
    return isPathAllowed(robots, url.pathname || '/');
  }
}

/**
 * Structural view of a byte stream. Kept minimal so both the DOM
 * `ReadableStream` and undici's own type satisfy it, and so a test can pass a
 * hand-rolled stream without constructing either.
 */
export interface ByteStream {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    cancel(): Promise<void>;
  };
}

/** Reads a response body up to `maxBytes`, then stops pulling from the socket. */
export async function readCapped(
  body: ByteStream | null,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!body) return { text: '', bytes: 0, truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { text: buffer.subarray(0, maxBytes).toString('utf8'), bytes: total, truncated };
}
