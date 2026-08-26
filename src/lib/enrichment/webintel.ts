import { env, envBool, envInt } from '@/lib/env';
import { HttpClient } from '@/lib/http/client';
import {
  isPlatformDomain,
  nameSimilarity,
  normalizeDomain,
  normalizeFacebookUrl,
  normalizeInstagramHandle,
  normalizeUrl,
} from '@/lib/identity/normalize';
import { evidenceForPage, summariseCrawl, type CrawlResult } from '@/lib/enrichment/websiteCrawl';
import type { SearchHit, WebSearchProvider } from '@/lib/enrichment/webSearch';
import type { NicheConfig } from '@/lib/config/schema';
import type { Logger } from '@/lib/logging/logger';
import type { EvidenceInput } from '@/lib/repo/types';
import type { PageFacts } from '@/lib/enrichment/websiteExtract';

/**
 * Client for the private Web Intelligence worker you host yourself.
 *
 * The worker searches, resolves and crawls; this file decides what any of that
 * is allowed to change about a prospect. That split is deliberate. The worker
 * proposes a domain with a score; nothing is written here until this side has
 * independently re-checked the name match with the app's own `nameSimilarity`.
 * Two agreeing judgements from two codebases is a much weaker claim to get
 * wrong than one — and a wrong domain poisons every downstream fact.
 *
 * Cost: zero. The worker uses a self-hosted SearXNG and its own crawler. No
 * paid API is called from here, and none is configured.
 */

// ---------------------------------------------------------------------------
// Wire types (mirrors services/webintel/src/types.ts)
// ---------------------------------------------------------------------------
export type ResolutionStatus = 'confirmed' | 'probable' | 'uncertain' | 'not_found';

export interface WebIntelWebsiteCandidate {
  url: string;
  domain: string;
  title: string;
  snippet: string;
  score: number;
  signals: string[];
  engines: string[];
  verification: {
    fetched: boolean;
    nameOnPage: boolean;
    cityOnPage: boolean;
    phoneOnPage: boolean;
    registryIdOnPage: boolean;
    reason: string;
  } | null;
}

export interface WebIntelSocialCandidate {
  platform: 'instagram' | 'facebook';
  handle: string;
  url: string;
  score: number;
  signals: string[];
}

export interface WebIntelResolveResponse {
  status: ResolutionStatus;
  confidence: number;
  officialWebsite: WebIntelWebsiteCandidate | null;
  instagram: WebIntelSocialCandidate | null;
  facebook: WebIntelSocialCandidate | null;
  candidates: WebIntelWebsiteCandidate[];
  socialCandidates: WebIntelSocialCandidate[];
  queriesRun: string[];
  reason: string;
  durationMs: number;
  observedAt: string;
}

export interface WebIntelFunnelObservation {
  key: string;
  value: string;
  sourceUrl: string;
  confidence: number;
}

export interface WebIntelPage {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  contentType: string | null;
  html: string;
  bytes: number;
  renderedWith: 'http' | 'browser';
  browserFallbackReason: string | null;
  fromCache: boolean;
  observedAt: string;
}

export interface WebIntelCrawlResponse {
  startUrl: string;
  allowedHost: string;
  pages: WebIntelPage[];
  skippedByRobots: string[];
  failed: { url: string; reason: string }[];
  funnel: {
    observed: WebIntelFunnelObservation[];
    checkedButNotObserved: string[];
    pagesAnalysed: string[];
  };
  durationMs: number;
  budgetExhausted: 'pages' | 'depth' | 'time' | null;
  observedAt: string;
}

export interface WebIntelSearchResponse {
  results: { url: string; title: string; snippet: string; engine: string; rank: number }[];
  enginesQueried: string[];
  enginesUnresponsive: { engine: string; reason: string }[];
  enginesSkipped: string[];
  fromCache: boolean;
}

export interface WebIntelHealth {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  uptimeMs: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
export class WebIntelClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly http: HttpClient;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl: string; token: string; http?: HttpClient; timeoutMs?: number }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    // A dedicated client: no shared cache (the worker keeps its own, on disk
    // next to the pages it fetched) and no per-host spacing, because the peer
    // is our own service on the tailnet, not somebody else's website.
    this.http = options.http ?? new HttpClient({ sql: null, minHostIntervalMs: 0 });
    this.timeoutMs = options.timeoutMs ?? envInt('OUTBOUND_WEBINTEL_TIMEOUT_MS', 180_000);
  }

  private async post<T>(path: string, payload: unknown, timeoutMs?: number): Promise<T> {
    const response = await this.http.request(`${this.baseUrl}${path}`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      timeoutMs: timeoutMs ?? this.timeoutMs,
      attempts: 2,
      noCache: true,
      maxBytes: 12_000_000,
    });
    if (!response.ok) {
      throw new Error(`webintel ${path} → HTTP ${response.status}: ${response.body.slice(0, 200)}`);
    }
    return JSON.parse(response.body) as T;
  }

  async health(): Promise<WebIntelHealth> {
    const response = await this.http.get(`${this.baseUrl}/health`, {
      timeoutMs: 10_000,
      attempts: 1,
      noCache: true,
    });
    if (!response.ok) throw new Error(`webintel /health → HTTP ${response.status}`);
    return JSON.parse(response.body) as WebIntelHealth;
  }

  search(query: string, limit: number): Promise<WebIntelSearchResponse> {
    return this.post<WebIntelSearchResponse>('/search', { query, limit }, 60_000);
  }

  resolveBusiness(input: BusinessResolutionInput): Promise<WebIntelResolveResponse> {
    return this.post<WebIntelResolveResponse>('/resolve-business', {
      name: input.name,
      country: input.country ?? 'FR',
      city: input.city,
      postalCode: input.postalCode,
      addressLine: input.addressLine,
      registryId: input.registryId,
      phone: input.phone,
      nicheHints: input.nicheHints,
      verify: true,
      noCache: input.noCache ?? false,
    });
  }

  crawl(url: string, options: { maxPages?: number; maxDepth?: number } = {}): Promise<WebIntelCrawlResponse> {
    return this.post<WebIntelCrawlResponse>('/crawl', {
      url,
      maxPages: options.maxPages ?? 6,
      maxDepth: options.maxDepth ?? 2,
      includeHtml: true,
    });
  }
}

export interface BusinessResolutionInput {
  name: string;
  /** Where the business trades. A name-perfect match on a foreign ccTLD is a
   *  different company in a different market, and the resolver treats it so. */
  country?: string | null;
  city: string | null;
  postalCode?: string | null;
  addressLine?: string | null;
  registryId?: string | null;
  phone?: string | null;
  nicheHints?: string[];
  /** Re-query the engines instead of replaying cached results. Used by the
   *  benchmark when the measurement itself has to be fresh. */
  noCache?: boolean;
}

// ---------------------------------------------------------------------------
// Search provider port
// ---------------------------------------------------------------------------
export function webIntelConfigured(): { ok: boolean; reason?: string } {
  if (!env('OUTBOUND_WEBINTEL_URL')) return { ok: false, reason: 'OUTBOUND_WEBINTEL_URL is not set' };
  if (!env('OUTBOUND_WEBINTEL_TOKEN')) return { ok: false, reason: 'OUTBOUND_WEBINTEL_TOKEN is not set' };
  return { ok: true };
}

export function createWebIntelClient(http?: HttpClient): WebIntelClient | null {
  if (!webIntelConfigured().ok) return null;
  return new WebIntelClient({
    baseUrl: env('OUTBOUND_WEBINTEL_URL') as string,
    token: env('OUTBOUND_WEBINTEL_TOKEN') as string,
    ...(http ? { http } : {}),
  });
}

export class WebIntelSearchProvider implements WebSearchProvider {
  readonly name = 'webintel';
  private readonly client: WebIntelClient | null;

  constructor(http?: HttpClient) {
    this.client = createWebIntelClient(http);
  }

  availability(): { ok: boolean; reason?: string } {
    return webIntelConfigured();
  }

  async search(query: string, limit: number): Promise<SearchHit[]> {
    if (!this.client) return [];
    const response = await this.client.search(query, limit);
    return response.results.map((hit) => ({ url: hit.url, title: hit.title, snippet: hit.snippet }));
  }
}

// ---------------------------------------------------------------------------
// Resolution decision
// ---------------------------------------------------------------------------
export interface WebIntelDecision {
  /** Website to attach to the prospect, or null when nothing is safe to attach. */
  attachWebsiteUrl: string | null;
  attachDomain: string | null;
  attachInstagram: string | null;
  attachFacebook: string | null;
  status: ResolutionStatus;
  confidence: number;
  reason: string;
  evidence: EvidenceInput[];
}

/** How close the app's own reading of the name must be before anything is attached. */
export const LOCAL_NAME_GUARD = 0.55;

/** The readable part of a domain, as a name-like string. */
export function domainCoreAsName(domain: string): string {
  const core = domain.split('.')[0] ?? '';
  return core.replace(/[-_]+/g, ' ').trim();
}

/**
 * Second opinion on the worker's proposal, computed here with this app's own
 * similarity function. Returns why it refused, so the refusal is auditable.
 */
export function localNameGuard(
  businessName: string,
  candidate: { domain: string; title: string },
): { ok: boolean; score: number; reason: string } {
  const domain = normalizeDomain(candidate.domain);
  if (!domain) return { ok: false, score: 0, reason: 'domaine illisible' };
  if (isPlatformDomain(domain)) {
    return { ok: false, score: 0, reason: `${domain} est une plateforme, pas un site d'entreprise` };
  }
  const score = Math.max(
    nameSimilarity(businessName, domainCoreAsName(domain)),
    nameSimilarity(businessName, candidate.title),
  );
  if (score < LOCAL_NAME_GUARD) {
    return {
      ok: false,
      score,
      reason: `contre-vérification locale du nom insuffisante (${score.toFixed(2)} < ${LOCAL_NAME_GUARD})`,
    };
  }
  return { ok: true, score, reason: `contre-vérification locale du nom : ${score.toFixed(2)}` };
}

/**
 * Turns a worker resolution into a decision plus evidence.
 *
 * `confirmed` attaches. `probable` only attaches when
 * OUTBOUND_WEBINTEL_ATTACH_PROBABLE=1, because a probable domain is still a
 * guess and a guess written into `prospects.website_url` stops looking like one
 * as soon as it is read again. Everything else is recorded as a candidate and
 * left unattached — findable by a human, invisible to the message generator.
 */
export function decideFromResolution(
  businessName: string,
  resolution: WebIntelResolveResponse,
  options: { attachProbable?: boolean } = {},
): WebIntelDecision {
  const attachProbable = options.attachProbable ?? envBool('OUTBOUND_WEBINTEL_ATTACH_PROBABLE', false);
  const evidence: EvidenceInput[] = [];
  const observedAt = resolution.observedAt;

  evidence.push({
    field: 'webintel_resolution',
    valueText: `${resolution.status} (${resolution.confidence.toFixed(2)}) — ${resolution.reason}`,
    valueJson: {
      status: resolution.status,
      confidence: resolution.confidence,
      reason: resolution.reason,
      queries: resolution.queriesRun,
      candidates: resolution.candidates.slice(0, 5).map((candidate) => ({
        domain: candidate.domain,
        score: candidate.score,
        signals: candidate.signals,
      })),
    },
    provider: 'webintel',
    method: 'derived',
    confidence: 1,
    observedAt,
  });

  const website = resolution.officialWebsite;
  let attachWebsiteUrl: string | null = null;
  let attachDomain: string | null = null;
  let reason = resolution.reason;

  if (website) {
    const guard = localNameGuard(businessName, website);
    const statusAllows = resolution.status === 'confirmed' || (resolution.status === 'probable' && attachProbable);

    if (guard.ok && statusAllows) {
      attachWebsiteUrl = normalizeUrl(website.url);
      attachDomain = normalizeDomain(website.url);
      reason = `${resolution.reason} ; ${guard.reason}`;
      evidence.push({
        field: 'website_url',
        valueText: attachWebsiteUrl ?? website.url,
        valueJson: { signals: website.signals, verification: website.verification },
        provider: 'webintel',
        method: 'api',
        sourceUrl: website.url,
        confidence: Math.min(1, website.score),
        observedAt,
      });
    } else {
      reason = guard.ok
        ? `${resolution.reason} — non rattaché (statut « ${resolution.status} »)`
        : `${resolution.reason} — non rattaché : ${guard.reason}`;
      evidence.push({
        field: 'website_candidate',
        valueText: `${website.domain} (${website.score.toFixed(2)}) — non rattaché : ${reason}`,
        valueJson: { url: website.url, score: website.score, signals: website.signals },
        provider: 'webintel',
        method: 'derived',
        sourceUrl: website.url,
        confidence: Math.min(1, website.score),
        observedAt,
      });
    }
  } else {
    evidence.push({
      field: 'website_lookup',
      valueText: `aucun site résolu (${resolution.status}) : ${resolution.reason}`,
      provider: 'webintel',
      method: 'derived',
      confidence: 1,
      observedAt,
    });
  }

  // Recorded whatever the outcome. Without this row, "no Instagram found" and
  // "an Instagram was found and judged too weak" look identical afterwards —
  // and on a campaign whose channel is Instagram DM, that is the difference
  // between a dead end and a threshold to revisit.
  evidence.push({
    field: 'webintel_social_candidates',
    valueText:
      resolution.socialCandidates.length === 0
        ? 'aucun profil social remonté par la recherche'
        : resolution.socialCandidates
            .map((candidate) => `${candidate.platform}:${candidate.handle} (${candidate.score.toFixed(2)})`)
            .join(', '),
    valueJson: resolution.socialCandidates,
    provider: 'webintel',
    method: 'derived',
    confidence: 1,
    observedAt,
  });

  const attachInstagram = pickSocialHandle(businessName, resolution.instagram, 'instagram');
  const attachFacebook = pickSocialHandle(businessName, resolution.facebook, 'facebook');

  if (attachInstagram) {
    evidence.push({
      field: 'instagram_handle',
      valueText: attachInstagram,
      provider: 'webintel',
      method: 'api',
      sourceUrl: resolution.instagram?.url ?? null,
      confidence: resolution.instagram?.score ?? 0.6,
      observedAt,
    });
  } else if (resolution.instagram) {
    evidence.push({
      field: 'instagram_candidate',
      valueText: `${resolution.instagram.handle} (${resolution.instagram.score.toFixed(2)}) — non rattaché`,
      provider: 'webintel',
      method: 'derived',
      sourceUrl: resolution.instagram.url,
      observedAt,
    });
  }

  if (attachFacebook) {
    evidence.push({
      field: 'facebook_url',
      valueText: attachFacebook,
      provider: 'webintel',
      method: 'api',
      sourceUrl: resolution.facebook?.url ?? null,
      confidence: resolution.facebook?.score ?? 0.6,
      observedAt,
    });
  } else if (resolution.facebook) {
    evidence.push({
      field: 'facebook_candidate',
      valueText: `${resolution.facebook.handle} (${resolution.facebook.score.toFixed(2)}) — non rattaché`,
      provider: 'webintel',
      method: 'derived',
      sourceUrl: resolution.facebook.url,
      observedAt,
    });
  }

  return {
    attachWebsiteUrl,
    attachDomain,
    attachInstagram,
    attachFacebook,
    status: resolution.status,
    confidence: resolution.confidence,
    reason,
    evidence,
  };
}

function pickSocialHandle(
  businessName: string,
  candidate: WebIntelSocialCandidate | null,
  platform: 'instagram' | 'facebook',
): string | null {
  if (!candidate) return null;
  // Same second opinion as for websites: the handle must look like the name to
  // this codebase too, not only to the worker.
  const score = nameSimilarity(businessName, candidate.handle.replace(/[._-]+/g, ' '));
  if (score < LOCAL_NAME_GUARD) return null;
  return platform === 'instagram'
    ? normalizeInstagramHandle(candidate.handle)
    : normalizeFacebookUrl(candidate.url);
}

// ---------------------------------------------------------------------------
// Crawl through the worker
// ---------------------------------------------------------------------------
export interface WebIntelCrawlOutcome extends CrawlResult {
  browserFallbacks: number;
  budgetExhausted: string | null;
  funnelObserved: number;
}

/**
 * Runs the worker's crawl and feeds the HTML through the *existing* extraction.
 *
 * Nothing about how a page becomes evidence changes here — `evidenceForPage`
 * and `summariseCrawl` are the same functions the direct crawler uses. Only the
 * transport differs. The funnel signals are added alongside as new fields that
 * no scoring signal reads, so the commercial judgement is unchanged and the
 * before/after comparison stays honest.
 */
export function evidenceFromWebIntelCrawl(
  response: WebIntelCrawlResponse,
  niche: NicheConfig,
): WebIntelCrawlOutcome {
  const facts: PageFacts[] = [];
  const evidence: EvidenceInput[] = [];
  const pagesCrawled: string[] = [];
  let browserFallbacks = 0;

  for (const page of response.pages) {
    if (!page.ok || !page.html) continue;
    if (page.renderedWith === 'browser') browserFallbacks += 1;
    const extracted = evidenceForPage(page.html, page.finalUrl, niche);
    facts.push(extracted.facts);
    pagesCrawled.push(page.finalUrl);
    evidence.push(...extracted.evidence);
  }

  const summary = summariseCrawl(facts, pagesCrawled, response.startUrl, niche);
  evidence.push(...summary.evidence);

  if (response.funnel.observed.length > 0) {
    evidence.push({
      field: 'funnel_observed',
      valueText: response.funnel.observed.map((item) => `${item.key}: ${item.value}`).join(' | '),
      valueJson: response.funnel.observed,
      provider: 'webintel',
      method: 'crawl',
      sourceUrl: pagesCrawled[0] ?? response.startUrl,
      confidence: 0.9,
      observedAt: response.observedAt,
    });
  }
  if (response.funnel.checkedButNotObserved.length > 0) {
    evidence.push({
      field: 'funnel_not_observed',
      // The wording is the point: this records what was looked for and not
      // seen on the pages read. It is never a claim that the business lacks it.
      valueText:
        `signaux cherchés et non observés sur les ${response.funnel.pagesAnalysed.length} page(s) lue(s) ` +
        `— absence d'observation, pas absence constatée : ` +
        response.funnel.checkedButNotObserved.join(', '),
      valueJson: {
        notObserved: response.funnel.checkedButNotObserved,
        pagesAnalysed: response.funnel.pagesAnalysed,
        meaning: 'not_observed_on_crawled_pages',
      },
      provider: 'webintel',
      method: 'derived',
      sourceUrl: pagesCrawled[0] ?? response.startUrl,
      confidence: 1,
      observedAt: response.observedAt,
    });
  }
  if (browserFallbacks > 0) {
    evidence.push({
      field: 'crawl_render_mode',
      valueText: `${browserFallbacks} page(s) lisibles seulement après rendu navigateur`,
      valueJson: response.pages
        .filter((page) => page.renderedWith === 'browser')
        .map((page) => ({ url: page.finalUrl, reason: page.browserFallbackReason })),
      provider: 'webintel',
      method: 'derived',
      sourceUrl: pagesCrawled[0] ?? response.startUrl,
      observedAt: response.observedAt,
    });
  }

  return {
    pagesCrawled,
    skippedByRobots: response.skippedByRobots,
    facts,
    evidence,
    contact: summary.contact,
    browserFallbacks,
    budgetExhausted: response.budgetExhausted,
    funnelObserved: response.funnel.observed.length,
  };
}

/** Convenience wrapper used by the pipeline. */
export async function crawlViaWebIntel(
  client: WebIntelClient,
  logger: Logger,
  websiteUrl: string,
  niche: NicheConfig,
  maxPages: number,
): Promise<WebIntelCrawlOutcome | null> {
  try {
    const response = await client.crawl(websiteUrl, { maxPages });
    const outcome = evidenceFromWebIntelCrawl(response, niche);
    logger.info('webintel.crawl_done', {
      url: websiteUrl,
      pages: outcome.pagesCrawled.length,
      browserFallbacks: outcome.browserFallbacks,
      funnelObserved: outcome.funnelObserved,
      durationMs: response.durationMs,
    });
    return outcome;
  } catch (error) {
    logger.warn('webintel.crawl_failed', {
      url: websiteUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
