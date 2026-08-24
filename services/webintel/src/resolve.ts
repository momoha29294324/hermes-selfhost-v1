/**
 * Business resolution: from a registry row to a probable website and socials.
 *
 * The failure mode this file exists to prevent is a plausible wrong answer.
 * "DEMO MIKE ATELIER, Ansouis" and "Demo Mike Atelier, Manchester" look identical
 * to a search engine, and attaching the wrong domain would poison every fact
 * downstream — the research sheet, the angle, the message. So:
 *
 *   - scoring is deterministic and every contributing signal is reported;
 *   - a name that merely resembles the query is never enough on its own;
 *   - `confirmed` additionally requires the page to have been *read* and to
 *     corroborate the business with something other than its name;
 *   - two candidates that score within a hair of each other are downgraded to
 *     `uncertain` rather than picking the first, because that is what a
 *     homonym looks like from here.
 *
 * The caller still applies its own independent check before writing anything to
 * a prospect. This resolver proposes; it does not attach.
 */
import {
  domainCoreAsName,
  isDirectoryDomain,
  isPlatformDomain,
  nameSimilarity,
  normalizeCity,
  normalizeDomain,
  normalizeFacebookSlug,
  normalizeInstagramHandle,
  normalizeName,
  normalizePhoneDigits,
  stripAccents,
  tldCountryMatch,
  topLevelDomain,
} from './identity.js';
import { stripTags } from './extract.js';
import type { SearchClient } from './searxng.js';
import type { PageFetcher } from './crawler.js';
import type { Logger } from './log.js';
import { errorMessage } from './log.js';
import type {
  Provenance,
  ResolutionStatus,
  ResolveRequest,
  ResolveResponse,
  SearchHit,
  SocialCandidate,
  WebsiteCandidate,
} from './types.js';

/** A name this weak can never carry a resolution, whatever else agrees. */
export const MIN_NAME_SIMILARITY = 0.5;
/**
 * Below this a domain is not a weak candidate, it is noise. Kept well under
 * MIN_NAME_SIMILARITY so this filter can never change an attach decision — it
 * only keeps the reported candidate list readable.
 */
export const NOISE_FLOOR = 0.25;
export const CONFIRMED_THRESHOLD = 0.8;
export const PROBABLE_THRESHOLD = 0.65;
export const UNCERTAIN_THRESHOLD = 0.45;
/** Two leaders closer than this are treated as a homonym, not a winner. */
export const AMBIGUITY_MARGIN = 0.06;

export function buildQueries(request: ResolveRequest): string[] {
  const name = request.name.trim();
  const city = (request.city ?? '').trim();
  const quoted = `"${name.replace(/"/g, '')}"`;
  const hint = (request.nicheHints ?? [])[0];

  const queries: string[] = [];
  queries.push(city ? `${quoted} ${city}` : quoted);
  if (hint) queries.push(city ? `${quoted} ${hint} ${city}` : `${quoted} ${hint}`);
  if (request.postalCode) queries.push(`${quoted} ${request.postalCode}`);
  else if (city) queries.push(`${name} ${city} contact`);
  queries.push(city ? `${quoted} ${city} instagram` : `${quoted} instagram`);

  return [...new Set(queries)];
}

export interface Accumulated {
  hit: SearchHit;
  queries: Set<string>;
  engines: Set<string>;
}

export function accumulate(perQuery: { query: string; hits: SearchHit[] }[]): Accumulated[] {
  const byUrl = new Map<string, Accumulated>();
  for (const { query, hits } of perQuery) {
    for (const hit of hits) {
      const existing = byUrl.get(hit.url);
      if (existing) {
        existing.queries.add(query);
        for (const engine of hit.engine.split('+')) existing.engines.add(engine);
        if (!existing.hit.snippet && hit.snippet) existing.hit.snippet = hit.snippet;
        continue;
      }
      byUrl.set(hit.url, {
        hit: { ...hit },
        queries: new Set([query]),
        engines: new Set(hit.engine.split('+')),
      });
    }
  }
  return [...byUrl.values()];
}

function haystack(hits: SearchHit[]): string {
  return stripAccents(hits.map((hit) => `${hit.title} ${hit.snippet} ${hit.url}`).join(' ')).toLowerCase();
}

// ---------------------------------------------------------------------------
// Domain grouping
// ---------------------------------------------------------------------------
export interface DomainGroup {
  domain: string;
  /** The URL a caller should attach and crawl: the site root. */
  url: string;
  hits: SearchHit[];
  queries: Set<string>;
  engines: Set<string>;
}

/**
 * Collapses every hit on a domain into one candidate.
 *
 * Without this, five pages of the same site compete against each other and each
 * carries a fraction of the evidence — the real answer loses to a directory
 * listing that happened to appear once with the right postcode. Merging also
 * fixes what gets returned: a business's website is its root, not whichever
 * deep page a search engine happened to rank first.
 */
export function groupByDomain(entries: Accumulated[]): DomainGroup[] {
  const byDomain = new Map<string, DomainGroup>();

  for (const entry of entries) {
    const domain = normalizeDomain(entry.hit.url);
    if (!domain) continue;
    let url: string;
    try {
      url = new URL(entry.hit.url).origin;
    } catch {
      continue;
    }

    const existing = byDomain.get(domain);
    if (existing) {
      existing.hits.push(entry.hit);
      for (const query of entry.queries) existing.queries.add(query);
      for (const engine of entry.engines) existing.engines.add(engine);
      // Prefer https over http for the representative root.
      if (existing.url.startsWith('http://') && url.startsWith('https://')) existing.url = url;
      continue;
    }
    byDomain.set(domain, {
      domain,
      url,
      hits: [entry.hit],
      queries: new Set(entry.queries),
      engines: new Set(entry.engines),
    });
  }

  return [...byDomain.values()];
}

// ---------------------------------------------------------------------------
// Website scoring
// ---------------------------------------------------------------------------
export function scoreWebsiteCandidate(
  entry: DomainGroup,
  request: ResolveRequest,
): WebsiteCandidate | null {
  const domain = entry.domain;
  if (isPlatformDomain(domain)) return null;
  if (isDirectoryDomain(domain)) return null;

  const signals: string[] = [];
  const nameScore = Math.max(
    nameSimilarity(request.name, domainCoreAsName(domain)),
    ...entry.hits.map((hit) => nameSimilarity(request.name, hit.title)),
  );
  // Below this the domain shares an accidental letter or two with the query and
  // nothing more. It could never pass MIN_NAME_SIMILARITY, so scoring it only
  // fills the candidate list with noise a human would have to read past.
  if (nameScore < NOISE_FLOOR) return null;

  let score = 0.45 * nameScore;
  signals.push(`nom ${(nameScore * 100).toFixed(0)}%`);

  const text = haystack(entry.hits);
  const city = normalizeCity(request.city);
  if (city && text.includes(city)) {
    score += 0.15;
    signals.push(`ville « ${request.city} » citée`);
  }
  if (request.postalCode && text.includes(request.postalCode.toLowerCase())) {
    score += 0.1;
    signals.push(`code postal ${request.postalCode}`);
  }
  const phone = normalizePhoneDigits(request.phone);
  if (phone && text.replace(/\D/g, '').includes(phone)) {
    score += 0.15;
    signals.push('téléphone identique');
  }
  if (request.registryId && text.replace(/\D/g, '').includes(request.registryId.replace(/\D/g, ''))) {
    score += 0.1;
    signals.push('SIREN cité');
  }
  if (entry.engines.size >= 2) {
    score += 0.05;
    signals.push(`${entry.engines.size} moteurs concordants`);
  }
  if (entry.queries.size >= 2) {
    score += 0.05;
    signals.push(`${entry.queries.size} requêtes concordantes`);
  }
  // Country is decisive, not decorative: a name-perfect match on a foreign
  // ccTLD is a different business in a different market, and no amount of page
  // reading will turn it into this prospect.
  const tldVerdict = tldCountryMatch(domain, request.country ?? 'FR');
  if (tldVerdict === 'match') {
    score += 0.06;
    signals.push(`domaine .${(request.country ?? 'FR').toLowerCase()}`);
  } else if (tldVerdict === 'foreign') {
    score -= 0.35;
    signals.push(`domaine étranger (.${topLevelDomain(domain)}) — autre marché`);
  }

  if (entry.hits.length >= 3) {
    score += 0.04;
    signals.push(`${entry.hits.length} pages du domaine remontées`);
  }

  const best = [...entry.hits].sort(
    (a, b) => nameSimilarity(request.name, b.title) - nameSimilarity(request.name, a.title),
  )[0];

  return {
    url: entry.url,
    domain,
    title: best?.title ?? '',
    snippet: best?.snippet ?? '',
    score: Math.min(1, Number(score.toFixed(4))),
    signals,
    engines: [...entry.engines],
    verification: null,
  };
}

// ---------------------------------------------------------------------------
// Social scoring
// ---------------------------------------------------------------------------
export function scoreSocialCandidate(
  entry: Accumulated,
  request: ResolveRequest,
): SocialCandidate | null {
  const url = entry.hit.url;
  const isInstagram = /(?:^|\.)instagram\.com\//i.test(url);
  const isFacebook = /(?:^|\.)facebook\.com\//i.test(url);
  if (!isInstagram && !isFacebook) return null;

  const handle = isInstagram ? normalizeInstagramHandle(url) : normalizeFacebookSlug(url);
  if (!handle) return null;

  const signals: string[] = [];
  const handleAsName = handle.replace(/[._-]+/g, ' ');
  const nameScore = Math.max(
    nameSimilarity(request.name, handleAsName),
    nameSimilarity(request.name, entry.hit.title),
  );
  if (nameScore <= 0) return null;

  let score = 0.55 * nameScore;
  signals.push(`nom ${(nameScore * 100).toFixed(0)}%`);

  const text = haystack([entry.hit]);
  const city = normalizeCity(request.city);
  if (city && text.includes(city)) {
    score += 0.2;
    signals.push(`ville « ${request.city} » citée`);
  }
  const phone = normalizePhoneDigits(request.phone);
  if (phone && text.replace(/\D/g, '').includes(phone)) {
    score += 0.15;
    signals.push('téléphone identique');
  }
  if (entry.engines.size >= 2) {
    score += 0.05;
    signals.push(`${entry.engines.size} moteurs concordants`);
  }

  return {
    platform: isInstagram ? 'instagram' : 'facebook',
    handle,
    url: isInstagram ? `https://www.instagram.com/${handle}` : `https://www.facebook.com/${handle}`,
    score: Math.min(1, Number(score.toFixed(4))),
    signals,
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------
export interface VerificationInput {
  html: string;
  request: ResolveRequest;
}

/** Corroborates a candidate against the page it actually serves. */
export function verifyAgainstPage(input: VerificationInput): {
  nameOnPage: boolean;
  cityOnPage: boolean;
  phoneOnPage: boolean;
  registryIdOnPage: boolean;
  boost: number;
  reason: string;
} {
  const text = stripAccents(stripTags(input.html)).toLowerCase();
  const digits = text.replace(/\D/g, '');

  const wanted = normalizeName(input.request.name).split(' ').filter((t) => t.length >= 3);
  const matched = wanted.filter((token) => text.includes(token));
  // Most of the distinctive tokens must be there — one word in common is not a
  // match, it is a coincidence.
  const nameOnPage = wanted.length > 0 && matched.length >= Math.max(1, Math.ceil(wanted.length * 0.6));

  const city = normalizeCity(input.request.city);
  const cityOnPage = city.length > 2 && text.includes(city);

  const phone = normalizePhoneDigits(input.request.phone);
  const phoneOnPage = Boolean(phone && digits.includes(phone));

  const registry = (input.request.registryId ?? '').replace(/\D/g, '');
  const registryIdOnPage = registry.length >= 9 && digits.includes(registry);

  let boost = 0;
  const reasons: string[] = [];
  if (nameOnPage) {
    boost += 0.2;
    reasons.push(`nom retrouvé sur la page (${matched.length}/${wanted.length} mots)`);
  }
  if (cityOnPage) {
    boost += 0.08;
    reasons.push('ville retrouvée sur la page');
  }
  if (phoneOnPage) {
    boost += 0.12;
    reasons.push('téléphone retrouvé sur la page');
  }
  if (registryIdOnPage) {
    boost += 0.1;
    reasons.push('SIREN retrouvé sur la page');
  }
  if (reasons.length === 0) reasons.push('page lue, aucun élément corroborant');

  return { nameOnPage, cityOnPage, phoneOnPage, registryIdOnPage, boost, reason: reasons.join(' ; ') };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
export function decideStatus(
  ranked: WebsiteCandidate[],
  bestNameScore: number,
): { status: ResolutionStatus; reason: string } {
  const best = ranked[0];
  if (!best) return { status: 'not_found', reason: 'aucun candidat de site après filtrage' };

  if (bestNameScore < MIN_NAME_SIMILARITY) {
    return {
      status: 'not_found',
      reason: `similarité de nom trop faible (${(bestNameScore * 100).toFixed(0)}% < ${MIN_NAME_SIMILARITY * 100}%)`,
    };
  }

  const runnerUp = ranked[1];
  if (runnerUp && best.score - runnerUp.score < AMBIGUITY_MARGIN && runnerUp.score >= PROBABLE_THRESHOLD) {
    return {
      status: 'uncertain',
      reason: `deux candidats trop proches (${best.domain} ${best.score.toFixed(2)} vs ${runnerUp.domain} ${runnerUp.score.toFixed(2)}) — homonyme probable`,
    };
  }

  const verification = best.verification;
  const corroborated =
    verification?.fetched === true &&
    verification.nameOnPage &&
    (verification.cityOnPage || verification.phoneOnPage || verification.registryIdOnPage);

  if (best.score >= CONFIRMED_THRESHOLD && corroborated) {
    return { status: 'confirmed', reason: `score ${best.score.toFixed(2)} et page corroborante` };
  }
  if (best.score >= CONFIRMED_THRESHOLD) {
    return {
      status: 'probable',
      reason: `score ${best.score.toFixed(2)} mais la page n'a pas pu corroborer (${verification?.reason ?? 'page non lue'})`,
    };
  }
  if (best.score >= PROBABLE_THRESHOLD) {
    return { status: 'probable', reason: `score ${best.score.toFixed(2)}` };
  }
  if (best.score >= UNCERTAIN_THRESHOLD) {
    return { status: 'uncertain', reason: `score ${best.score.toFixed(2)} sous le seuil « probable »` };
  }
  return { status: 'not_found', reason: `meilleur score ${best.score.toFixed(2)} sous le seuil` };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
export interface ResolverDeps {
  search: SearchClient;
  pages: PageFetcher;
  logger: Logger;
}

export async function resolveBusiness(
  deps: ResolverDeps,
  request: ResolveRequest,
): Promise<ResolveResponse> {
  const started = Date.now();
  const observedAt = new Date().toISOString();
  const queries = buildQueries(request);
  const evidence: Provenance[] = [];

  // Pacing matters more than it looks. A 60-prospect run is ~200 queries in a
  // few minutes, and the free engines answer that with rate limits: the first
  // benchmark run tripped five of nine breakers before it finished, so its
  // second half was measured with a thinner pool than its first. Spacing the
  // queries buys a fair measurement.
  const responses = await deps.search.searchMany(queries, {
    limit: 12,
    pauseMs: 900,
    ...(request.noCache === undefined ? {} : { noCache: request.noCache }),
  });
  const perQuery = responses.map((response) => ({ query: response.query, hits: response.results }));
  const entries = accumulate(perQuery);

  for (const response of responses) {
    evidence.push({
      sourceUrl: `searxng:${encodeURIComponent(response.query)}`,
      provider: `searxng(${response.enginesQueried.join(',') || 'aucun'})`,
      method: 'search',
      observedAt: response.observedAt,
      confidence: 1,
    });
  }

  const websiteCandidates = groupByDomain(entries)
    .map((group) => scoreWebsiteCandidate(group, request))
    .filter((candidate): candidate is WebsiteCandidate => candidate !== null)
    .sort((a, b) => b.score - a.score);

  const socialCandidates = dedupeSocials(
    entries
      .map((entry) => scoreSocialCandidate(entry, request))
      .filter((candidate): candidate is SocialCandidate => candidate !== null),
  ).sort((a, b) => b.score - a.score);

  // Verify the leader — and the runner-up when the two are close, because that
  // is precisely the case where reading the page settles a homonym.
  const toVerify = new Set<string>();
  const leader = websiteCandidates[0];
  const second = websiteCandidates[1];
  if (request.verify !== false && leader && leader.score >= UNCERTAIN_THRESHOLD) {
    toVerify.add(leader.url);
    if (second && leader.score - second.score < AMBIGUITY_MARGIN) toVerify.add(second.url);
  }

  for (const candidate of websiteCandidates) {
    if (!toVerify.has(candidate.url)) continue;
    try {
      const allowed = await deps.pages.isAllowedByRobots(candidate.url);
      if (!allowed) {
        candidate.verification = {
          fetched: false,
          nameOnPage: false,
          cityOnPage: false,
          phoneOnPage: false,
          registryIdOnPage: false,
          reason: 'robots.txt interdit la lecture de cette page',
        };
        continue;
      }
      const page = await deps.pages.fetchPage(candidate.url, { timeoutMs: 20_000 });
      const result = verifyAgainstPage({ html: page.html, request });
      candidate.verification = {
        fetched: true,
        nameOnPage: result.nameOnPage,
        cityOnPage: result.cityOnPage,
        phoneOnPage: result.phoneOnPage,
        registryIdOnPage: result.registryIdOnPage,
        reason: result.reason,
      };
      candidate.score = Math.min(1, Number((candidate.score + result.boost).toFixed(4)));
      candidate.signals.push(`vérification : ${result.reason}`);
      evidence.push({
        sourceUrl: page.finalUrl,
        provider: 'webintel:verify',
        method: page.renderedWith === 'browser' ? 'render' : 'fetch',
        observedAt: page.observedAt,
        confidence: result.boost > 0 ? 0.9 : 0.4,
      });
    } catch (error) {
      candidate.verification = {
        fetched: false,
        nameOnPage: false,
        cityOnPage: false,
        phoneOnPage: false,
        registryIdOnPage: false,
        reason: `page illisible : ${errorMessage(error)}`,
      };
      deps.logger.warn('resolve.verify_failed', { url: candidate.url, error: errorMessage(error) });
    }
  }

  websiteCandidates.sort((a, b) => b.score - a.score);

  const leaderAfterVerification = websiteCandidates[0];
  const bestNameScore = leaderAfterVerification
    ? Math.max(
        nameSimilarity(request.name, domainCoreAsName(leaderAfterVerification.domain)),
        nameSimilarity(request.name, leaderAfterVerification.title),
      )
    : 0;

  const { status, reason } = decideStatus(websiteCandidates, bestNameScore);
  const officialWebsite = status === 'confirmed' || status === 'probable' ? (websiteCandidates[0] ?? null) : null;

  if (officialWebsite) {
    evidence.push({
      sourceUrl: officialWebsite.url,
      provider: 'webintel:resolve',
      method: 'derived',
      observedAt,
      confidence: officialWebsite.score,
    });
  }

  const instagram = pickSocial(socialCandidates, 'instagram');
  const facebook = pickSocial(socialCandidates, 'facebook');
  for (const social of [instagram, facebook]) {
    if (!social) continue;
    evidence.push({
      sourceUrl: social.url,
      provider: 'webintel:resolve',
      method: 'derived',
      observedAt,
      confidence: social.score,
    });
  }

  const response: ResolveResponse = {
    query: { name: request.name, city: request.city ?? null },
    status,
    confidence: websiteCandidates[0]?.score ?? 0,
    officialWebsite,
    instagram,
    facebook,
    candidates: websiteCandidates.slice(0, 8),
    socialCandidates: socialCandidates.slice(0, 8),
    queriesRun: queries,
    evidence,
    reason,
    durationMs: Date.now() - started,
    observedAt,
  };

  deps.logger.info('resolve.done', {
    name: request.name,
    city: request.city ?? null,
    status,
    confidence: response.confidence,
    candidates: websiteCandidates.length,
    socials: socialCandidates.length,
    durationMs: response.durationMs,
  });

  return response;
}

/** Merges hits pointing at the same account, keeping the strongest reading. */
export function dedupeSocials(candidates: SocialCandidate[]): SocialCandidate[] {
  const byHandle = new Map<string, SocialCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.platform}:${candidate.handle.toLowerCase()}`;
    const existing = byHandle.get(key);
    if (!existing) {
      byHandle.set(key, { ...candidate, signals: [...candidate.signals] });
      continue;
    }
    if (candidate.score > existing.score) {
      existing.score = candidate.score;
      existing.url = candidate.url;
    }
    for (const signal of candidate.signals) {
      if (!existing.signals.includes(signal)) existing.signals.push(signal);
    }
  }
  return [...byHandle.values()];
}

/** Social handles need a real name match; a city alone must never carry one. */
export const SOCIAL_MIN_SCORE = 0.6;

function pickSocial(candidates: SocialCandidate[], platform: 'instagram' | 'facebook'): SocialCandidate | null {
  const forPlatform = candidates.filter((candidate) => candidate.platform === platform);
  const best = forPlatform[0];
  if (!best || best.score < SOCIAL_MIN_SCORE) return null;
  const runnerUp = forPlatform[1];
  // Same homonym guard as for websites: two accounts that score the same are
  // not a resolution, they are a question.
  if (runnerUp && best.score - runnerUp.score < AMBIGUITY_MARGIN) return null;
  return best;
}
