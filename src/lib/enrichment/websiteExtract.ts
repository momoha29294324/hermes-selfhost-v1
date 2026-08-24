import { stripAccents } from '@/lib/identity/normalize';

/**
 * HTML fact extraction. Pure string work, no network: every function here is
 * unit-testable and returns only what it actually saw in the markup.
 */

export interface PageFacts {
  title: string | null;
  description: string | null;
  emails: string[];
  phones: string[];
  instagram: string[];
  facebook: string[];
  tiktok: string[];
  whatsapp: boolean;
  hasContactForm: boolean;
  hasTelLink: boolean;
  hasMailtoLink: boolean;
  bookingProviders: string[];
  ctaTexts: string[];
  priceMentions: string[];
  headings: string[];
  textLength: number;
  internalLinks: string[];

  // --- R5 : ce qu'il faut de plus pour décrire un parcours, pas seulement le noter
  /**
   * Nombre de champs à remplir dans les formulaires de la page.
   *
   * Un formulaire n'est pas un formulaire : trois champs se remplissent d'une
   * main sur un téléphone, douze font partir le visiteur. Le compte est donc la
   * mesure utile, et `hasContactForm` seul ne pouvait pas la donner.
   */
  formFieldCount: number;
  /**
   * Vrai quand un formulaire ou un appel à l'action demande explicitement un
   * devis, par opposition à un « contactez-nous » générique. La distinction est
   * commerciale : un devis est une intention d'achat qualifiée.
   */
  quoteRequest: boolean;
  /** Chemin de conversation Instagram exposé sur la page (lien DM). */
  instagramDm: boolean;
  /**
   * Marques de réassurance réellement lues : avis, labels, garanties,
   * certifications. Le mot trouvé, jamais une note inventée.
   */
  trustSignals: string[];
}

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
];

const CTA_PATTERNS = [
  /prendre rendez-?vous/i,
  /r[ée]server(?: en ligne)?/i,
  /demander un devis/i,
  /devis gratuit/i,
  /contactez-?nous/i,
  /appelez-?nous/i,
  /prendre contact/i,
  /obtenir un devis/i,
];

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    /**
     * Entités numériques.
     *
     * Ajouté après le premier pilote R5, qui a produit le nom d'entreprise
     * « Nett auto &#8211; L'exigence du détail ». `&#8211;` est un simple tiret
     * cadratin, et il est resté tel quel jusque dans un brouillon de message.
     * Les entités nommées étaient traitées une par une ; la forme numérique ne
     * l'était pas du tout, alors qu'elle est celle que produisent la plupart
     * des CMS français.
     */
    .replace(/&#(\d{1,6});/g, (_match, code: string) => decodeCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_match, code: string) => decodeCodePoint(Number.parseInt(code, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Un point de code, ou une chaîne vide s'il est hors des bornes valides. */
function decodeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

export function extractPageFacts(html: string, pageUrl: string): PageFacts {
  const text = stripTags(html);

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
  const description =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i)?.[1]?.trim() ??
    html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i)?.[1]?.trim() ??
    null;

  const mailtos = [...html.matchAll(/mailto:([^"'>\s?]+)/gi)].map((m) => m[1] ?? '');
  const plainEmails = [...text.matchAll(/[\w.+-]+@[\w-]+\.[a-zA-Z]{2,10}/g)].map((m) => m[0]);

  const telLinks = [...html.matchAll(/tel:([+\d][\d\s().-]{6,})/gi)].map((m) => m[1] ?? '');
  const plainPhones = [...text.matchAll(/(?:0|\+33\s?|0033\s?)[1-9](?:[\s.-]?\d{2}){4}/g)].map((m) => m[0]);

  const instagram = [...html.matchAll(/https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{2,30})/gi)].map(
    (m) => m[1] ?? '',
  );
  const facebook = [...html.matchAll(/https?:\/\/(?:www\.)?facebook\.com\/([A-Za-z0-9_.\-]{2,40})/gi)].map(
    (m) => m[1] ?? '',
  );
  const tiktok = [...html.matchAll(/https?:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9_.]{2,30})/gi)].map(
    (m) => m[1] ?? '',
  );

  const bookingProviders = BOOKING_SIGNATURES.filter(([, pattern]) => pattern.test(html)).map(([name]) => name);

  const ctaTexts = unique(
    CTA_PATTERNS.flatMap((pattern) => {
      const match = text.match(pattern);
      return match ? [match[0]] : [];
    }),
  );

  const priceMentions = unique(
    [...text.matchAll(/\d{2,5}\s?(?:€|EUR\b|euros\b)/gi)].map((m) => m[0].trim()).slice(0, 12),
  );

  const headings = unique(
    [...html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)]
      .map((m) => stripTags(m[1] ?? ''))
      .filter((value) => value.length > 2)
      .slice(0, 20),
  );

  const hasContactForm =
    /<form[\s\S]{0,4000}?(type=["']email["']|name=["'][^"']*(mail|tel|phone|message)[^"']*["'])/i.test(html);

  const internalLinks = extractInternalLinks(html, pageUrl);

  const formFieldCount = countFormFields(html);
  const quoteRequest =
    QUOTE_PATTERNS.some((pattern) => pattern.test(text)) ||
    /<form[^>]+(action|id|name|class)=["'][^"']*devis[^"']*["']/i.test(html);
  const instagramDm = /ig\.me\/m\/|instagram\.com\/direct\b/i.test(html);
  const trustSignals = unique(
    TRUST_PATTERNS.flatMap((pattern) => {
      const match = text.match(pattern);
      return match ? [match[0].toLowerCase()] : [];
    }),
  );

  return {
    title,
    description,
    emails: unique([...mailtos, ...plainEmails].map((value) => value.toLowerCase())),
    phones: unique([...telLinks, ...plainPhones].map((value) => value.trim())),
    instagram: unique(instagram.map((value) => value.toLowerCase())),
    facebook: unique(facebook),
    tiktok: unique(tiktok),
    whatsapp: /wa\.me\/|api\.whatsapp\.com/i.test(html),
    hasContactForm,
    hasTelLink: telLinks.length > 0,
    hasMailtoLink: mailtos.length > 0,
    bookingProviders,
    ctaTexts,
    priceMentions,
    headings,
    textLength: text.length,
    internalLinks,
    formFieldCount,
    quoteRequest,
    instagramDm,
    trustSignals,
  };
}

const QUOTE_PATTERNS = [/demander? un devis/i, /devis gratuit/i, /obtenir un devis/i, /demande de devis/i];

/**
 * Marques de réassurance.
 *
 * Ce qui est retenu est **le mot lu sur la page**, pas ce qu'il vaut : « avis
 * clients » écrit dans un titre prouve que l'entreprise met en avant sa preuve
 * sociale, il ne prouve rien sur la qualité de ces avis. Confondre les deux
 * serait affirmer une donnée que nous n'avons pas observée.
 */
const TRUST_PATTERNS = [
  /avis (?:clients?|google|vérifi[ée]s?)/i,
  /\bt[ée]moignages?\b/i,
  /\bgarantie\b/i,
  /\bassur[ée]\b/i,
  /\bcertifi[ée]\b/i,
  /\bcertification\b/i,
  /\bagr[ée][ée]\b/i,
  /\blabel\b/i,
  /\bpartenaire officiel\b/i,
  /\bavant\s*\/?\s*apr[èe]s\b/i,
  /\bnos r[ée]alisations\b/i,
];

/**
 * Compte les champs à remplir des formulaires de la page.
 *
 * Les champs cachés et les boutons sont exclus : ils ne coûtent rien au
 * visiteur, et les inclure ferait passer un formulaire de trois champs pour un
 * formulaire de huit dès que le site utilise un jeton anti-spam.
 */
export function countFormFields(html: string): number {
  let count = 0;
  for (const form of html.matchAll(/<form[\s\S]*?<\/form>/gi)) {
    const body = form[0];
    for (const field of body.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
      const tag = field[0];
      if (/type=["'](hidden|submit|button|image|reset)["']/i.test(tag)) continue;
      count += 1;
    }
  }
  return count;
}

const INTERESTING_PATH =
  /(contact|tarif|prix|prestation|service|offre|a-propos|apropos|about|realisation|galerie|avis)/i;

export function extractInternalLinks(html: string, pageUrl: string): string[] {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }
  const links = new Set<string>();
  for (const match of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    const href = match[1];
    if (!href) continue;
    let absolute: URL;
    try {
      absolute = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (absolute.origin !== origin) continue;
    if (!INTERESTING_PATH.test(absolute.pathname)) continue;
    if (/\.(pdf|jpg|jpeg|png|webp|svg|zip|mp4)$/i.test(absolute.pathname)) continue;
    absolute.hash = '';
    links.add(absolute.toString());
  }
  return [...links].slice(0, 12);
}

/** Terms from the niche vocabulary that genuinely appear in the page text. */
export function matchVocabulary(text: string, terms: string[]): string[] {
  const haystack = stripAccents(text).toLowerCase();
  const found: string[] = [];
  for (const term of terms) {
    const needle = stripAccents(term).toLowerCase().trim();
    if (needle.length < 3) continue;
    if (haystack.includes(needle)) found.push(term);
  }
  return [...new Set(found)];
}

/**
 * Commercial quality of a site, from observable structure only.
 * Returns a 0..1 ratio plus the reasons, so the score stays explainable.
 */
export function websiteQualityScore(facts: PageFacts[], serviceTerms: string[]): {
  ratio: number;
  reasons: string[];
} {
  if (facts.length === 0) return { ratio: 0, reasons: [] };
  const reasons: string[] = [];
  let points = 0;
  const max = 6;

  const totalText = facts.reduce((sum, page) => sum + page.textLength, 0);
  if (totalText > 1500) {
    points += 1;
    reasons.push('contenu éditorial substantiel');
  }
  if (facts.some((page) => page.title && page.title.length > 10)) {
    points += 1;
    reasons.push('titre de page renseigné');
  }
  if (facts.some((page) => page.description)) {
    points += 1;
    reasons.push('meta description présente');
  }
  if (facts.length > 1) {
    points += 1;
    reasons.push('plusieurs pages de contenu (services / contact)');
  }
  const services = matchVocabulary(
    facts.map((page) => `${page.title ?? ''} ${page.description ?? ''} ${page.headings.join(' ')}`).join(' '),
    serviceTerms,
  );
  if (services.length >= 3) {
    points += 1;
    reasons.push(`prestations détaillées (${services.slice(0, 4).join(', ')})`);
  }
  if (facts.some((page) => page.priceMentions.length > 0)) {
    points += 1;
    reasons.push('tarifs affichés');
  }

  return { ratio: points / max, reasons };
}

export function ctaQualityScore(facts: PageFacts[]): { ratio: number; reasons: string[] } {
  if (facts.length === 0) return { ratio: 0, reasons: [] };
  const reasons: string[] = [];
  let points = 0;
  const max = 4;

  if (facts.some((page) => page.ctaTexts.length > 0)) {
    points += 1;
    reasons.push(`appel à l'action explicite (${facts.flatMap((p) => p.ctaTexts)[0]})`);
  }
  if (facts.some((page) => page.hasTelLink)) {
    points += 1;
    reasons.push('numéro cliquable');
  }
  if (facts.some((page) => page.hasContactForm)) {
    points += 1;
    reasons.push('formulaire de contact');
  }
  if (facts.some((page) => page.hasMailtoLink || page.whatsapp)) {
    points += 1;
    reasons.push('contact direct (email ou WhatsApp)');
  }

  return { ratio: points / max, reasons };
}
