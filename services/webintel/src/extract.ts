/**
 * Funnel extraction from public HTML.
 *
 * The single most important rule in this file is what it refuses to say. Every
 * detector reports one of two things: "seen here, with the text that proves it"
 * or "looked for on the pages I read, not seen". There is no third branch that
 * concludes a business lacks something. A prospect whose booking link sits on a
 * page the crawl never reached is `booking_online` in `checkedButNotObserved` —
 * which reads `booking_not_observed`, not `has_no_booking_system`.
 *
 * Everything here is pure string work on markup that was served publicly: no
 * login, no paywall, no private endpoint.
 */
import type { FunnelObservation, FunnelReport, FunnelSignalKey } from './types.js';

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    // A response capped at maxResponseBytes almost always ends mid-tag. Left
    // in place, `<a href="/tarifs` becomes the text "/tarifs" and can trip a
    // detector on markup the page never rendered.
    .replace(/<[^>]*$/, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;|&rsquo;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&eacute;/gi, 'é')
    .replace(/&egrave;/gi, 'è')
    .replace(/\s+/g, ' ')
    .trim();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// Signal catalogue
// ---------------------------------------------------------------------------
/** Every key the extractor knows how to look for, in report order. */
export const ALL_FUNNEL_SIGNALS: FunnelSignalKey[] = [
  'cta_primary',
  'cta_phone',
  'cta_whatsapp',
  'cta_instagram',
  'cta_facebook',
  'cta_email',
  'form_contact',
  'form_quote',
  'booking_online',
  'calendar_embed',
  'checkout',
  'page_services',
  'page_pricing',
  'price_displayed',
  'social_proof',
  'reviews_embedded',
  'faq',
  'promo_offer',
  'analytics_google',
  'tag_manager',
  'pixel_meta',
  'pixel_tiktok',
  'session_recording',
];

const CTA_PATTERNS: RegExp[] = [
  /prendre rendez-?vous/i,
  /prenez rendez-?vous/i,
  /r[ée]server(?: en ligne| maintenant| votre créneau)?/i,
  /demander un devis/i,
  /devis (?:gratuit|en ligne|immédiat|personnalisé)/i,
  /obtenir un devis/i,
  /contactez-?nous/i,
  /appelez-?nous/i,
  /prendre contact/i,
  /demande de rappel/i,
  /nous [ée]crire/i,
];

const BOOKING_SIGNATURES: [string, RegExp][] = [
  ['calendly', /calendly\.com/i],
  ['planity', /planity\.com/i],
  ['treatwell', /treatwell\./i],
  ['booksy', /booksy\./i],
  ['simplybook', /simplybook\./i],
  ['koalendar', /koalendar\.com/i],
  ['reservio', /reservio\.com/i],
  ['setmore', /setmore\.com/i],
  ['acuity', /acuityscheduling\.com/i],
  ['google_reserve', /reserve\.google\.com/i],
  ['cal_com', /\bcal\.com\b/i],
  ['zenchef', /zenchef\.com/i],
  ['wisembly', /wisembly\.com/i],
  ['youcanbookme', /youcanbook\.me/i],
  ['resurva', /resurva\.com/i],
  ['fresha', /fresha\.com/i],
  ['guestonline', /guestonline\.fr/i],
  ['agendize', /agendize\.com/i],
  ['clicrdv', /clicrdv\.com/i],
  ['rendezvousonline', /rendezvousonline\.fr/i],
];

const CHECKOUT_SIGNATURES: [string, RegExp][] = [
  ['woocommerce', /woocommerce|wc-ajax|add-to-cart/i],
  ['shopify', /cdn\.shopify\.com|shopify\.com\/s\/files/i],
  ['prestashop', /prestashop/i],
  ['stripe_checkout', /checkout\.stripe\.com|js\.stripe\.com/i],
  ['paypal', /paypal\.com\/(?:sdk|checkoutnow)/i],
  ['sumup', /sumup\.(?:me|com)/i],
  ['panier', /href=["'][^"']*\/(?:panier|cart|checkout|commande)\b/i],
];

const REVIEW_WIDGET_SIGNATURES: [string, RegExp][] = [
  ['trustpilot', /trustpilot\.com\/(?:trustbox|widget)|widget\.trustpilot/i],
  ['google_reviews_widget', /elfsight\.com|sociablekit\.com|reviewsonmywebsite|trustindex\.io/i],
  ['avis_verifies', /avis-verifies\.com|netreviews/i],
  ['google_business_link', /(?:g\.page|maps\.app\.goo\.gl|search\.google\.com\/local\/reviews)/i],
];

const ANALYTICS_SIGNATURES: [FunnelSignalKey, string, RegExp][] = [
  ['analytics_google', 'gtag_js', /gtag\/js\?id=(?:G-|UA-|AW-)[A-Z0-9-]+/i],
  ['analytics_google', 'analytics_js', /google-analytics\.com\/(?:analytics|ga)\.js/i],
  ['tag_manager', 'gtm', /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/],
  ['pixel_meta', 'fbevents', /connect\.facebook\.net\/[^"']*\/fbevents\.js/i],
  ['pixel_meta', 'fbq_init', /\bfbq\s*\(\s*['"]init['"]/i],
  ['pixel_tiktok', 'tiktok_pixel', /analytics\.tiktok\.com|ttq\.load\(/i],
  ['session_recording', 'hotjar', /static\.hotjar\.com|\bhj\s*\(/i],
  ['session_recording', 'clarity', /clarity\.ms/i],
  ['session_recording', 'smartlook', /smartlook\.com/i],
  ['session_recording', 'mouseflow', /mouseflow\.com/i],
  ['session_recording', 'luckyorange', /luckyorange\.com/i],
];

/**
 * Matched against the *last path segment*, anchored.
 *
 * Matching anywhere in the raw href is how `page_services` ends up pointing at
 * `facebook.com/sharer/sharer.php?u=…nos-services…`: the word is in the string,
 * but the link is a share button. Anchoring on the final segment is what makes
 * the difference between "a page about the services" and "a URL containing the
 * word service".
 */
const SERVICES_SEGMENT = /^(nos-)?(prestations?|services?|offres?|formules?|savoir-faire)\b/i;
const PRICING_SEGMENT = /^(nos-)?(tarifs?|prix|pricing|grille-tarifaire)\b/i;
const FAQ_SEGMENT = /^(faq|questions-frequentes|questions-reponses)\b/i;
const CONTACT_SEGMENT = /^(contact|nous-contacter|contactez-nous)\b/i;
const QUOTE_SEGMENT = /^(devis|demande-de-devis|estimation)\b/i;
const BOOKING_SEGMENT = /^(reservation|reserver|rendez-vous|rdv|booking|prendre-rendez-vous)\b/i;

/** Last path segment of a URL, lowercased and de-extensioned. */
export function lastSegment(pathname: string): string {
  const segments = pathname.toLowerCase().split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  return last.replace(/\.(html?|php|aspx?)$/i, '');
}

// ---------------------------------------------------------------------------
// Contact extraction
// ---------------------------------------------------------------------------
export interface PageContacts {
  emails: string[];
  phones: string[];
  instagram: string[];
  facebook: string[];
  tiktok: string[];
  whatsapp: string[];
}

export function extractContacts(html: string): PageContacts {
  const text = stripTags(html);

  const mailtos = [...html.matchAll(/mailto:([^"'>\s?]+)/gi)].map((m) => m[1] ?? '');
  const plainEmails = [...text.matchAll(/[\w.+-]+@[\w-]+\.[a-zA-Z]{2,10}/g)].map((m) => m[0]);
  const telLinks = [...html.matchAll(/tel:([+\d][\d\s().-]{6,})/gi)].map((m) => m[1] ?? '');
  const plainPhones = [...text.matchAll(/(?:0|\+33\s?|0033\s?)[1-9](?:[\s.-]?\d{2}){4}/g)].map((m) => m[0]);

  return {
    emails: unique(
      [...mailtos, ...plainEmails]
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0 && !/\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(value)),
    ),
    phones: unique([...telLinks, ...plainPhones].map((value) => value.trim()).filter(Boolean)),
    instagram: unique(
      [...html.matchAll(/(?:https?:)?\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{2,30})/gi)].map((m) =>
        (m[1] ?? '').toLowerCase(),
      ),
    ),
    facebook: unique(
      [...html.matchAll(/(?:https?:)?\/\/(?:www\.|web\.|m\.)?facebook\.com\/([A-Za-z0-9_.\-]{2,40})/gi)].map(
        (m) => m[1] ?? '',
      ),
    ),
    tiktok: unique(
      [...html.matchAll(/(?:https?:)?\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9_.]{2,30})/gi)].map((m) =>
        (m[1] ?? '').toLowerCase(),
      ),
    ),
    whatsapp: unique(
      [...html.matchAll(/(?:https?:)?\/\/(?:wa\.me\/(\d{6,20})|api\.whatsapp\.com\/send\?phone=(\d{6,20}))/gi)].map(
        (m) => m[1] ?? m[2] ?? '',
      ),
    ).filter(Boolean),
  };
}

export function extractTitle(html: string): string | null {
  const raw = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const value = raw ? stripTags(raw) : '';
  return value.length > 0 ? value : null;
}

export function extractDescription(html: string): string | null {
  const value =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1] ??
    html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i)?.[1] ??
    null;
  return value ? value.trim() : null;
}

export function extractHeadings(html: string, limit = 20): string[] {
  return unique(
    [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
      .map((m) => stripTags(m[1] ?? ''))
      .filter((value) => value.length > 2),
  ).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Funnel detection
// ---------------------------------------------------------------------------
function push(
  out: FunnelObservation[],
  key: FunnelSignalKey,
  value: string,
  sourceUrl: string,
  confidence: number,
): void {
  out.push({ key, value: value.slice(0, 200), sourceUrl, confidence });
}

/** Signals observable on a single page. */
export function extractFunnelFromPage(html: string, sourceUrl: string): FunnelObservation[] {
  const out: FunnelObservation[] = [];
  const text = stripTags(html);

  for (const pattern of CTA_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      push(out, 'cta_primary', match[0], sourceUrl, 0.9);
      break;
    }
  }

  const telLink = html.match(/href=["']tel:([^"']+)["']/i);
  if (telLink?.[1]) push(out, 'cta_phone', telLink[1], sourceUrl, 1);

  const waLink = html.match(/href=["']((?:https?:)?\/\/(?:wa\.me|api\.whatsapp\.com)[^"']*)["']/i);
  if (waLink?.[1]) push(out, 'cta_whatsapp', waLink[1], sourceUrl, 1);

  const igLink = html.match(/href=["']((?:https?:)?\/\/(?:www\.)?instagram\.com\/[^"']+)["']/i);
  if (igLink?.[1]) push(out, 'cta_instagram', igLink[1], sourceUrl, 1);

  const fbLink = html.match(/href=["']((?:https?:)?\/\/(?:www\.|web\.|m\.)?facebook\.com\/[^"']+)["']/i);
  if (fbLink?.[1]) push(out, 'cta_facebook', fbLink[1], sourceUrl, 1);

  const mailLink = html.match(/href=["']mailto:([^"']+)["']/i);
  if (mailLink?.[1]) push(out, 'cta_email', mailLink[1], sourceUrl, 1);

  // A form counts only when it carries a field a prospect would actually fill.
  const formBlocks = [...html.matchAll(/<form[\s\S]{0,6000}?<\/form>/gi)].map((m) => m[0]);
  for (const form of formBlocks) {
    const hasContactField =
      /type=["']email["']/i.test(form) ||
      /name=["'][^"']*(mail|tel|phone|message|nom|name)[^"']*["']/i.test(form) ||
      /<textarea/i.test(form);
    if (!hasContactField) continue;
    push(out, 'form_contact', formSummary(form), sourceUrl, 0.9);
    if (/devis|estimation|chiffrage/i.test(stripTags(form))) {
      push(out, 'form_quote', 'formulaire mentionnant un devis', sourceUrl, 0.85);
    }
    break;
  }
  for (const [name, pattern] of BOOKING_SIGNATURES) {
    if (pattern.test(html)) {
      push(out, 'booking_online', name, sourceUrl, 1);
      if (new RegExp(`<iframe[^>]+src=["'][^"']*${name}`, 'i').test(html)) {
        push(out, 'calendar_embed', name, sourceUrl, 1);
      }
      break;
    }
  }
  if (!out.some((o) => o.key === 'booking_online') && /r[ée]server en ligne|réservation en ligne/i.test(text)) {
    push(out, 'booking_online', 'mention « réservation en ligne »', sourceUrl, 0.6);
  }

  for (const [name, pattern] of CHECKOUT_SIGNATURES) {
    if (pattern.test(html)) {
      push(out, 'checkout', name, sourceUrl, 0.8);
      break;
    }
  }

  const links = [...html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)]
    .map((match) => {
      const href = match[1] ?? '';
      let segment = '';
      try {
        segment = lastSegment(new URL(href, sourceUrl).pathname);
      } catch {
        segment = '';
      }
      // A short label is a navigation item; a long one is a sentence that
      // happens to contain the word.
      const rawLabel = stripTags(match[2] ?? '');
      return { href, segment, label: rawLabel.length <= 40 ? rawLabel : '' };
    })
    .filter((link) => link.segment.length > 0);

  const firstLink = (
    segmentPattern: RegExp,
    labelPattern: RegExp,
  ): { href: string; label: string } | null =>
    links.find((link) => segmentPattern.test(link.segment) || labelPattern.test(link.label)) ?? null;

  const servicesLink = firstLink(SERVICES_SEGMENT, /^(nos )?(prestations?|services?|offres?)$/i);
  if (servicesLink) push(out, 'page_services', servicesLink.label || servicesLink.href, sourceUrl, 0.85);

  const pricingLink = firstLink(PRICING_SEGMENT, /^(nos )?(tarifs?|prix)$/i);
  if (pricingLink) push(out, 'page_pricing', pricingLink.label || pricingLink.href, sourceUrl, 0.85);

  const faqLink = firstLink(FAQ_SEGMENT, /^(f\.?a\.?q\.?|questions fréquentes)$/i);
  if (faqLink) push(out, 'faq', faqLink.label || faqLink.href, sourceUrl, 0.85);
  else if (/\bf\.?a\.?q\.?\b|questions fréquentes/i.test(text)) {
    push(out, 'faq', 'section FAQ dans le texte', sourceUrl, 0.6);
  }

  if (!out.some((o) => o.key === 'form_quote')) {
    const quoteLink = firstLink(QUOTE_SEGMENT, /^(devis|demande de devis)$/i);
    if (quoteLink) push(out, 'form_quote', quoteLink.label || quoteLink.href, sourceUrl, 0.7);
  }
  if (!out.some((o) => o.key === 'booking_online')) {
    const bookingLink = firstLink(BOOKING_SEGMENT, /^(réserver|réservation|prendre rendez-vous)$/i);
    if (bookingLink) push(out, 'booking_online', bookingLink.label || bookingLink.href, sourceUrl, 0.65);
  }

  const prices = unique([...text.matchAll(/\d{1,5}(?:[.,]\d{1,2})?\s?(?:€|EUR\b|euros\b)/gi)].map((m) => m[0].trim()));
  if (prices.length > 0) {
    push(out, 'price_displayed', prices.slice(0, 6).join(', '), sourceUrl, 0.9);
  }

  const proof = text.match(/(avis (?:clients|google)|témoignages?|ils nous font confiance|nos clients parlent)/i);
  if (proof) push(out, 'social_proof', proof[0], sourceUrl, 0.8);

  for (const [name, pattern] of REVIEW_WIDGET_SIGNATURES) {
    if (pattern.test(html)) {
      push(out, 'reviews_embedded', name, sourceUrl, 0.9);
      break;
    }
  }

  const promo = text.match(
    /(-\s?\d{1,2}\s?%|\d{1,2}\s?% de (?:remise|réduction)|offre (?:spéciale|de lancement|découverte)|code promo|première (?:prestation|séance) offerte)/i,
  );
  if (promo) push(out, 'promo_offer', promo[0], sourceUrl, 0.75);

  for (const [key, name, pattern] of ANALYTICS_SIGNATURES) {
    if (!pattern.test(html)) continue;
    if (out.some((o) => o.key === key)) continue;
    push(out, key, name, sourceUrl, 1);
  }

  return out;
}

/**
 * Aggregates page-level observations into one report for a crawl.
 * `checkedButNotObserved` is the complement of what was seen — read it as
 * "<signal>_not_observed_on_the_pages_read", never as an absence in the world.
 */
export function buildFunnelReport(
  perPage: { sourceUrl: string; observations: FunnelObservation[] }[],
): FunnelReport {
  const observed: FunnelObservation[] = [];
  const seenKeys = new Set<FunnelSignalKey>();

  for (const page of perPage) {
    for (const observation of page.observations) {
      // Keep the first, strongest sighting of each signal, but record every page
      // that showed a distinct value.
      const duplicate = observed.some((o) => o.key === observation.key && o.value === observation.value);
      if (duplicate) continue;
      observed.push(observation);
      seenKeys.add(observation.key);
    }
  }

  observed.sort(
    (a, b) => ALL_FUNNEL_SIGNALS.indexOf(a.key) - ALL_FUNNEL_SIGNALS.indexOf(b.key) || b.confidence - a.confidence,
  );

  return {
    observed,
    checkedButNotObserved: ALL_FUNNEL_SIGNALS.filter((key) => !seenKeys.has(key)),
    pagesAnalysed: perPage.map((page) => page.sourceUrl),
  };
}

function formSummary(form: string): string {
  const action = form.match(/action=["']([^"']*)["']/i)?.[1] ?? '';
  const fields = [...form.matchAll(/name=["']([^"']+)["']/gi)].map((m) => m[1] ?? '').slice(0, 6);
  return `action=${action || '(vide)'} champs=${fields.join(',') || '(non nommés)'}`;
}

// ---------------------------------------------------------------------------
// Crawl support
// ---------------------------------------------------------------------------
const INTERESTING_PATH =
  /(contact|tarif|prix|prestation|service|offre|devis|reserv|rendez-?vous|booking|a-propos|apropos|about|realisation|galerie|avis|faq)/i;

/**
 * Internal links worth following. Ordered by how likely the page is to carry a
 * commercial signal, so a crawl capped at 6 pages spends its budget well.
 */
export function extractInternalLinks(html: string, pageUrl: string, allowedHost: string): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }

  const scored = new Map<string, number>();
  for (const match of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    const href = match[1];
    if (!href) continue;
    let absolute: URL;
    try {
      absolute = new URL(href, base);
    } catch {
      continue;
    }
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') continue;
    if (absolute.hostname.replace(/^www\./, '') !== allowedHost.replace(/^www\./, '')) continue;
    if (/\.(pdf|jpe?g|png|webp|svg|zip|mp4|avi|docx?|xlsx?|css|js)$/i.test(absolute.pathname)) continue;
    absolute.hash = '';
    const url = absolute.toString();
    if (url === pageUrl) continue;

    const segment = lastSegment(absolute.pathname);
    const depth = absolute.pathname.split('/').filter(Boolean).length;

    // A page named `tarifs` is worth far more than one whose slug merely
    // contains the word — the latter is usually an article.
    let weight = 0;
    if (CONTACT_SEGMENT.test(segment)) weight = 6;
    else if (QUOTE_SEGMENT.test(segment)) weight = 6;
    else if (PRICING_SEGMENT.test(segment)) weight = 6;
    else if (SERVICES_SEGMENT.test(segment)) weight = 5;
    else if (BOOKING_SEGMENT.test(segment)) weight = 5;
    else if (FAQ_SEGMENT.test(segment)) weight = 3;
    else if (INTERESTING_PATH.test(absolute.pathname)) weight = 1;
    if (weight === 0) continue;

    // Long slugs and deep paths are blog posts and case studies. They can still
    // be crawled, but only after the commercial pages.
    if (segment.length > 40) weight -= 2;
    if (depth > 2) weight -= 1;
    if (weight <= 0) continue;

    scored.set(url, Math.max(scored.get(url) ?? 0, weight));
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url)
    .slice(0, 20);
}

/**
 * Whether an HTTP response looks like an empty JavaScript shell that only a
 * browser can turn into content. Used to decide the render fallback — the
 * browser is expensive, so it must be earned, not applied by default.
 */
export function needsBrowserRender(html: string): { needed: boolean; reason: string | null } {
  const text = stripTags(html);
  if (html.trim().length === 0) return { needed: true, reason: 'empty_body' };

  if (text.length < 200) {
    const shell =
      /<div[^>]+id=["'](root|app|__next|__nuxt|q-app)["']/i.test(html) ||
      /<script[^>]+src=["'][^"']*(?:runtime|main|bundle|chunk|vendor)[.-][^"']*\.js/i.test(html);
    if (shell) return { needed: true, reason: 'js_app_shell' };
    return { needed: true, reason: 'almost_no_text' };
  }

  if (/<noscript>[\s\S]{0,400}?(activer|enable)\s+javascript/i.test(html) && text.length < 600) {
    return { needed: true, reason: 'noscript_notice' };
  }

  return { needed: false, reason: null };
}
