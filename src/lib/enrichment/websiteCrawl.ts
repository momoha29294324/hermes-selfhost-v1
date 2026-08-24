import { HttpClient } from '@/lib/http/client';
import {
  extractPageFacts,
  matchVocabulary,
  stripTags,
  websiteQualityScore,
  ctaQualityScore,
  type PageFacts,
} from '@/lib/enrichment/websiteExtract';
import {
  normalizeEmail,
  isVendorHandle,
  normalizeInstagramHandle,
  normalizePhone,
  normalizeFacebookUrl,
} from '@/lib/identity/normalize';
import type { NicheConfig } from '@/lib/config/schema';
import type { Logger } from '@/lib/logging/logger';
import type { EvidenceInput } from '@/lib/repo/types';

export interface CrawlResult {
  pagesCrawled: string[];
  skippedByRobots: string[];
  facts: PageFacts[];
  evidence: EvidenceInput[];
  contact: {
    email: string | null;
    phone: string | null;
    instagramHandle: string | null;
    facebookUrl: string | null;
  };
}

/**
 * Turns one fetched page into facts and evidence.
 *
 * Extracted from the crawl loop so that pages read directly and pages read
 * through the Web Intelligence worker produce *identical* evidence. That
 * identity is what makes the before/after benchmark meaningful: if the two
 * paths extracted differently, a change in score could not be attributed to
 * better data rather than a different ruler.
 */
export function evidenceForPage(
  html: string,
  pageUrl: string,
  niche: NicheConfig,
): { facts: PageFacts; evidence: EvidenceInput[] } {
  const facts = extractPageFacts(html, pageUrl);
  const evidence: EvidenceInput[] = [];
  const pageText = stripTags(html);
  const services = matchVocabulary(pageText, niche.serviceTerms);
  const premium = matchVocabulary(pageText, niche.premiumTerms);

  if (facts.title) {
    evidence.push({
      field: 'website_title',
      valueText: facts.title,
      provider: 'website',
      method: 'crawl',
      sourceUrl: pageUrl,
    });
  }
  if (facts.description) {
    evidence.push({
      field: 'website_description',
      valueText: facts.description,
      provider: 'website',
      method: 'crawl',
      sourceUrl: pageUrl,
    });
  }
  if (services.length > 0) {
    evidence.push({
      field: 'services',
      valueJson: services,
      valueText: services.join(', '),
      provider: 'website',
      method: 'crawl',
      sourceUrl: pageUrl,
    });
  }
  if (premium.length > 0) {
    evidence.push({
      field: 'premium_services',
      valueJson: premium,
      valueText: premium.join(', '),
      provider: 'website',
      method: 'crawl',
      sourceUrl: pageUrl,
    });
  }
  if (facts.bookingProviders.length > 0) {
    evidence.push({
      field: 'booking_system',
      valueJson: facts.bookingProviders,
      valueText: facts.bookingProviders.join(', '),
      provider: 'website',
      method: 'crawl',
      sourceUrl: pageUrl,
    });
  }
  if (facts.ctaTexts.length > 0) {
    evidence.push({
      field: 'cta',
      valueJson: facts.ctaTexts,
      valueText: facts.ctaTexts.join(' | '),
      provider: 'website',
      method: 'crawl',
      sourceUrl: pageUrl,
    });
  }
  if (facts.priceMentions.length > 0) {
    evidence.push({
      field: 'price_mentions',
      valueJson: facts.priceMentions,
      valueText: facts.priceMentions.slice(0, 5).join(', '),
      provider: 'website',
      method: 'crawl',
      sourceUrl: pageUrl,
    });
  }
  if (facts.headings.length > 0) {
    evidence.push({
      field: 'website_headings',
      valueJson: facts.headings.slice(0, 10),
      provider: 'website',
      method: 'crawl',
      sourceUrl: pageUrl,
    });
  }

  return { facts, evidence };
}

/**
 * Derives the contact channels and the two quality ratios from a whole crawl.
 * Shared by the direct crawler and the Web Intelligence path for the same
 * reason as `evidenceForPage`.
 */
export function summariseCrawl(
  facts: PageFacts[],
  pagesCrawled: string[],
  websiteUrl: string,
  niche: NicheConfig,
): { evidence: EvidenceInput[]; contact: CrawlResult['contact'] } {
  const evidence: EvidenceInput[] = [];

  const email = firstValid(facts.flatMap((page) => page.emails), normalizeEmail);
  const phone = firstValid(facts.flatMap((page) => page.phones), (value) => normalizePhone(value));
  /**
   * Le premier compte trouvé sur la page n'est pas toujours celui de
   * l'entreprise : un pied de page « Créé avec Wix » place `@wixstudio` avant
   * le compte du artisan. Sur une campagne dont le canal est le DM Instagram,
   * écrire ce handle reviendrait à préparer un message pour l'éditeur du site.
   */
  const instagramHandle = firstValid(
    facts.flatMap((page) => page.instagram),
    (value) => {
      const handle = normalizeInstagramHandle(value);
      return handle && !isVendorHandle(handle) ? handle : null;
    },
  );
  const facebookUrl = firstValid(
    facts.flatMap((page) => page.facebook.map((slug) => `https://www.facebook.com/${slug}`)),
    (value) => {
      const url = normalizeFacebookUrl(value);
      if (!url) return null;
      const slug = url.split('/').filter(Boolean).pop() ?? '';
      return isVendorHandle(slug) ? null : url;
    },
  );

  const source = pagesCrawled[0] ?? websiteUrl;
  if (email) {
    evidence.push({ field: 'email', valueText: email, provider: 'website', method: 'crawl', sourceUrl: source });
  }
  if (phone) {
    evidence.push({ field: 'phone', valueText: phone, provider: 'website', method: 'crawl', sourceUrl: source });
  }
  if (instagramHandle) {
    evidence.push({
      field: 'instagram_handle',
      valueText: instagramHandle,
      provider: 'website',
      method: 'crawl',
      sourceUrl: source,
    });
  }
  if (facebookUrl) {
    evidence.push({
      field: 'facebook_url',
      valueText: facebookUrl,
      provider: 'website',
      method: 'crawl',
      sourceUrl: source,
    });
  }

  if (facts.length > 0) {
    const quality = websiteQualityScore(facts, niche.serviceTerms);
    const cta = ctaQualityScore(facts);
    evidence.push({
      field: 'website_quality',
      valueJson: { ratio: quality.ratio, reasons: quality.reasons, pages: pagesCrawled },
      valueText: `${Math.round(quality.ratio * 100)}%`,
      provider: 'website',
      method: 'derived',
      sourceUrl: source,
      confidence: 0.8,
    });
    evidence.push({
      field: 'cta_quality',
      valueJson: { ratio: cta.ratio, reasons: cta.reasons },
      valueText: `${Math.round(cta.ratio * 100)}%`,
      provider: 'website',
      method: 'derived',
      sourceUrl: source,
      confidence: 0.8,
    });
  }

  return { evidence, contact: { email, phone, instagramHandle, facebookUrl } };
}

/**
 * Crawls a prospect's own website: the home page plus a few genuinely relevant
 * internal pages (contact, tarifs, prestations). robots.txt is honoured, the
 * User-Agent is identifiable, and every extracted fact carries the page it came
 * from so a message can never cite something that was not read.
 */
export async function crawlWebsite(
  http: HttpClient,
  websiteUrl: string,
  niche: NicheConfig,
  logger: Logger,
  maxPages = 3,
): Promise<CrawlResult> {
  const pagesCrawled: string[] = [];
  const skippedByRobots: string[] = [];
  const facts: PageFacts[] = [];
  const evidence: EvidenceInput[] = [];

  const queue: string[] = [websiteUrl];
  const seen = new Set<string>();

  while (queue.length > 0 && pagesCrawled.length < maxPages) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    let allowed: boolean;
    try {
      allowed = await http.isAllowedByRobots(url);
    } catch {
      allowed = true;
    }
    if (!allowed) {
      skippedByRobots.push(url);
      logger.info('crawl.robots_disallow', { url });
      continue;
    }

    try {
      const response = await http.get(url, { timeoutMs: 20_000, attempts: 2 });
      if (!response.ok || !(response.contentType ?? '').includes('html')) {
        logger.debug('crawl.skip_non_html', { url, status: response.status });
        continue;
      }
      const page = evidenceForPage(response.body, response.url, niche);
      facts.push(page.facts);
      pagesCrawled.push(response.url);
      evidence.push(...page.evidence);

      for (const link of page.facts.internalLinks) {
        if (!seen.has(link) && queue.length + pagesCrawled.length < maxPages + 4) queue.push(link);
      }
    } catch (error) {
      logger.warn('crawl.page_failed', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const summary = summariseCrawl(facts, pagesCrawled, websiteUrl, niche);
  evidence.push(...summary.evidence);

  return {
    pagesCrawled,
    skippedByRobots,
    facts,
    evidence,
    contact: summary.contact,
  };
}

function firstValid<T>(values: string[], normalize: (value: string) => T | null): T | null {
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized) return normalized;
  }
  return null;
}
