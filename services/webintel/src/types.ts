/**
 * Wire contract between hermes and the Web Intelligence worker.
 *
 * Every payload that carries a fact also carries where the fact came from.
 * There is no field in here that means "this business does not have X" — the
 * worker can only report what it observed, and the absence of an observation is
 * reported as such (`checkedButNotObserved`), never as an absence in the world.
 */

export type ResolutionStatus = 'confirmed' | 'probable' | 'uncertain' | 'not_found';

export interface Provenance {
  /** Where the observation was read. */
  sourceUrl: string;
  /** How it was obtained: which subsystem, and which upstream when relevant. */
  provider: string;
  method: 'search' | 'fetch' | 'crawl' | 'render' | 'derived';
  observedAt: string;
  confidence?: number;
}

// ---------------------------------------------------------------------------
// /search
// ---------------------------------------------------------------------------
export interface SearchRequest {
  query: string;
  limit?: number;
  locale?: string;
  /** Restrict to a subset of the configured engines. */
  engines?: string[];
  noCache?: boolean;
}

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  engine: string;
  rank: number;
}

export interface SearchResponse {
  query: string;
  results: SearchHit[];
  enginesQueried: string[];
  enginesUnresponsive: { engine: string; reason: string }[];
  /** Engines withheld because their circuit breaker is open. */
  enginesSkipped: string[];
  fromCache: boolean;
  observedAt: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// /fetch
// ---------------------------------------------------------------------------
export interface FetchRequest {
  url: string;
  timeoutMs?: number;
  /** Ask for a browser render even when plain HTTP returned something. */
  render?: boolean;
  /** Skip the robots.txt check. Refused unless the caller is trusted config. */
  ignoreRobots?: boolean;
  noCache?: boolean;
  maxBytes?: number;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  contentType: string | null;
  html: string;
  bytes: number;
  truncated: boolean;
  renderedWith: 'http' | 'browser';
  /** Set when the HTTP body looked like an empty JS shell. */
  browserFallbackReason: string | null;
  fromCache: boolean;
  durationMs: number;
  observedAt: string;
}

export interface FetchResponse {
  page: FetchedPage | null;
  robotsAllowed: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// /crawl
// ---------------------------------------------------------------------------
export interface CrawlRequest {
  url: string;
  maxPages?: number;
  maxDepth?: number;
  timeoutMs?: number;
  /** Host the crawl may not leave. Defaults to the host of `url`. */
  allowedHost?: string;
  noCache?: boolean;
  /** Include the raw HTML of each page in the response. */
  includeHtml?: boolean;
}

export interface CrawlResponse {
  startUrl: string;
  allowedHost: string;
  pages: FetchedPage[];
  skippedByRobots: string[];
  failed: { url: string; reason: string }[];
  funnel: FunnelReport;
  durationMs: number;
  budgetExhausted: 'pages' | 'depth' | 'time' | null;
  observedAt: string;
}

// ---------------------------------------------------------------------------
// Funnel extraction
// ---------------------------------------------------------------------------
export type FunnelSignalKey =
  | 'cta_primary'
  | 'cta_phone'
  | 'cta_whatsapp'
  | 'cta_instagram'
  | 'cta_facebook'
  | 'cta_email'
  | 'form_contact'
  | 'form_quote'
  | 'booking_online'
  | 'calendar_embed'
  | 'checkout'
  | 'page_services'
  | 'page_pricing'
  | 'price_displayed'
  | 'social_proof'
  | 'reviews_embedded'
  | 'faq'
  | 'promo_offer'
  | 'analytics_google'
  | 'tag_manager'
  | 'pixel_meta'
  | 'pixel_tiktok'
  | 'session_recording';

export interface FunnelObservation {
  key: FunnelSignalKey;
  /** What was actually seen — a CTA label, a provider name, a script host. */
  value: string;
  sourceUrl: string;
  confidence: number;
}

export interface FunnelReport {
  observed: FunnelObservation[];
  /**
   * Signals the extractor looked for on the pages it read and did not see.
   *
   * This is NOT a statement about the business. `booking_online` in this list
   * means `booking_not_observed_on_crawled_pages`, never
   * `company_has_no_booking_system`.
   */
  checkedButNotObserved: FunnelSignalKey[];
  pagesAnalysed: string[];
}

// ---------------------------------------------------------------------------
// /extract
// ---------------------------------------------------------------------------
export interface ExtractRequest {
  html?: string;
  url?: string;
  sourceUrl?: string;
}

export interface ExtractResponse {
  sourceUrl: string;
  funnel: FunnelReport;
  contacts: {
    emails: string[];
    phones: string[];
    instagram: string[];
    facebook: string[];
    tiktok: string[];
    whatsapp: string[];
  };
  title: string | null;
  description: string | null;
  headings: string[];
  observedAt: string;
}

// ---------------------------------------------------------------------------
// /resolve-business
// ---------------------------------------------------------------------------
export interface ResolveRequest {
  name: string;
  /** ISO country the business trades in. Drives the ccTLD relevance check. */
  country?: string | null;
  city?: string | null;
  postalCode?: string | null;
  addressLine?: string | null;
  registryId?: string | null;
  phone?: string | null;
  /** Extra words that describe the trade, from the campaign's niche config. */
  nicheHints?: string[];
  /** Fetch the leading candidate to corroborate it. On by default. */
  verify?: boolean;
  noCache?: boolean;
}

export interface WebsiteCandidate {
  url: string;
  domain: string;
  title: string;
  snippet: string;
  score: number;
  signals: string[];
  engines: string[];
  /** Filled once the candidate page has actually been read. */
  verification: {
    fetched: boolean;
    nameOnPage: boolean;
    cityOnPage: boolean;
    phoneOnPage: boolean;
    registryIdOnPage: boolean;
    reason: string;
  } | null;
}

export interface SocialCandidate {
  platform: 'instagram' | 'facebook';
  handle: string;
  url: string;
  score: number;
  signals: string[];
}

export interface ResolveResponse {
  query: { name: string; city: string | null };
  status: ResolutionStatus;
  confidence: number;
  officialWebsite: WebsiteCandidate | null;
  instagram: SocialCandidate | null;
  facebook: SocialCandidate | null;
  candidates: WebsiteCandidate[];
  socialCandidates: SocialCandidate[];
  queriesRun: string[];
  evidence: Provenance[];
  /** Why the resolver stopped where it did — always populated. */
  reason: string;
  durationMs: number;
  observedAt: string;
}

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------
export interface ComponentHealth {
  status: 'ok' | 'degraded' | 'down' | 'disabled';
  detail: string;
  [key: string]: unknown;
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  uptimeMs: number;
  components?: {
    search: ComponentHealth;
    crawler: ComponentHealth;
    browser: ComponentHealth;
    cache: ComponentHealth;
  };
  breakers?: Record<string, { state: string; failures: number; openedAt: string | null }>;
}
