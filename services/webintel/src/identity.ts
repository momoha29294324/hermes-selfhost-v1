/**
 * Name / domain / handle normalisation used by the business resolver.
 *
 * These functions are ported from the main app's src/lib/identity/normalize.ts.
 * The worker is deployed on its own, without the app's module graph, so it
 * carries its own copy — and `tests/webintel/identity.test.ts` runs both over a
 * shared corpus and fails on any disagreement, so the two cannot drift apart.
 *
 * Keeping them identical matters: hermes re-checks every domain the
 * worker proposes with its own copy before attaching it to a prospect. Two
 * independent agreeing judgements is the whole point of the second check, and
 * that only holds if both are computing the same thing.
 */

/** Domains that identify a platform, never a business's own site. */
export const PLATFORM_DOMAINS = new Set([
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'youtube.com',
  'linkedin.com',
  'x.com',
  'twitter.com',
  'google.com',
  'goo.gl',
  'maps.app.goo.gl',
  'pagesjaunes.fr',
  'linktr.ee',
  'beacons.ai',
  'wa.me',
  'snapchat.com',
  'yelp.com',
  'trustpilot.com',
  'wixsite.com',
  'business.site',
  'sites.google.com',
]);

/**
 * Directories and aggregators. Not platforms in the social sense, but never a
 * business's own site either — a resolver that accepts one of these has found
 * a listing, not a website, and the difference decides whether a message can
 * cite anything real.
 */
export const DIRECTORY_DOMAINS = new Set([
  // Observed in the 2026-08-09 benchmark as the top-ranked candidate for a
  // prospect. Each one is a listing about the business, never the business.
  'infonet.fr',
  'nosavis.com',
  'lagazettefrance.fr',
  'net1901.org',
  'artisan-en-ligne.com',
  'e-pro.fr',
  'demo-35-exemple.fr',
  'datalegal.fr',
  'allovoisins.com',
  'allogarage.fr',
  'seloger.com',
  'laposte.fr',
  'lacentrale.fr',
  'allbiz.fr',
  'yably.fr',
  'autour-de-moi.pro',
  'bgl.lu',
  'societe.com',
  'infogreffe.fr',
  'verif.com',
  'pappers.fr',
  'manageo.fr',
  'bilansgratuits.fr',
  'annuaire-entreprises.data.gouv.fr',
  'entreprises.lefigaro.fr',
  'kompass.com',
  'europages.fr',
  'cylex-france.fr',
  'yellowpages.fr',
  '118712.fr',
  'justacote.com',
  'petitesannonces.fr',
  'leboncoin.fr',
  'indeed.com',
  'welcometothejungle.com',
  'facebook.com',
  'mappy.com',
  'openstreetmap.org',
  'waze.com',
  'tripadvisor.fr',
  'tripadvisor.com',
  'wikipedia.org',
  'lesbonsartisans.fr',
  'starofservice.com',
  'proxiservice.fr',
  'hoodspot.fr',
  'annuaire.118000.fr',
  '118000.fr',
  'kelbon.com',
  'trouver-un-pro.fr',
  // R7.2B.1 — ajoutés sur observation, pas sur réputation : chacun a été
  // proposé comme meilleur candidat pour PLUSIEURS prospects distincts du
  // corpus des 34, ce qu'aucun site d'entreprise ne peut être.
  'politologue.com',      // 4 prospects
  'rubypayeur.com',       // 3 prospects
  'lavieduvillage.fr',    // 2 prospects
  'demo-23.example.net',       // 2 prospects
  'le-codepostal.com',    // 4 candidats
  'mairie.com',           // 3 candidats
  'annuaire-mairie.fr',   // 3 candidats
  'mygarages.fr',         // 3 candidats
]);

export function stripAccents(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const LEGAL_TOKENS = new Set([
  'sarl', 'sas', 'sasu', 'eurl', 'sci', 'snc', 'sa', 'ei', 'eirl', 'scop', 'sarlu',
  'entreprise', 'ste', 'societe', 'sté', 'monsieur', 'madame', 'mr', 'mme',
  'auto-entrepreneur', 'autoentrepreneur', 'micro-entreprise',
]);

/** Lowercase, accent-free, punctuation-free, legal-form-free business name. */
export function normalizeName(input: string | null | undefined): string {
  if (!input) return '';
  const base = stripAccents(input)
    .toLowerCase()
    // Apostrophes are dropped, not spaced: "Kapital Car'e" must match "Northstar Studio".
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const tokens = base.split(' ').filter((t) => t.length > 0 && !LEGAL_TOKENS.has(t));
  return tokens.join(' ').trim();
}

export function normalizeCity(input: string | null | undefined): string {
  if (!input) return '';
  return stripAccents(input)
    .toLowerCase()
    .replace(/\b(st|ste)\b/g, (m) => (m === 'st' ? 'saint' : 'sainte'))
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Returns the registrable host of a URL, or null when the URL is unusable. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let raw = input.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  if (!host.includes('.')) return null;
  return host;
}

function inSet(domain: string, set: Set<string>): boolean {
  if (set.has(domain)) return true;
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i += 1) {
    if (set.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

export function isPlatformDomain(domain: string | null): boolean {
  if (!domain) return false;
  return inSet(domain, PLATFORM_DOMAINS);
}

export function isDirectoryDomain(domain: string | null): boolean {
  if (!domain) return false;
  return inSet(domain, DIRECTORY_DOMAINS);
}

export function normalizeInstagramHandle(input: string | null | undefined): string | null {
  if (!input) return null;
  let value = input.trim();
  const match = value.match(/instagram\.com\/([A-Za-z0-9_.]+)/i);
  if (match?.[1]) value = match[1];
  value = value.replace(/^@/, '').replace(/\/+$/, '').toLowerCase();
  if (!/^[a-z0-9_.]{2,30}$/.test(value)) return null;
  if (INSTAGRAM_RESERVED.has(value)) return null;
  return value;
}

const INSTAGRAM_RESERVED = new Set([
  'p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'about', 'developer',
  'legal', 'directory', 'tv', 'direct', 'privacy', 'terms', 'graphql',
]);

const FACEBOOK_RESERVED = new Set([
  'sharer', 'plugins', 'tr', 'dialog', 'login', 'profile.php', 'pages', 'groups',
  'events', 'watch', 'marketplace', 'help', 'policies', 'legal', 'privacy',
]);

export function normalizeFacebookSlug(input: string | null | undefined): string | null {
  if (!input) return null;
  const match = input.match(/facebook\.com\/(?:pg\/)?([A-Za-z0-9_.\-]+)/i);
  const slug = match?.[1];
  if (!slug) return null;
  if (FACEBOOK_RESERVED.has(slug.toLowerCase())) return null;
  if (slug.length < 2) return null;
  return slug;
}

export function normalizePhoneDigits(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  if (digits.length < 9) return null;
  // Compare on the national significant number so 0X…, +33X… and 0033X… match.
  if (digits.startsWith('0033')) return digits.slice(4);
  if (digits.startsWith('33') && digits.length >= 11) return digits.slice(2);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

/** Jaccard similarity over word tokens. */
export function tokenSimilarity(a: string, b: string): number {
  const left = new Set(a.split(' ').filter(Boolean));
  const right = new Set(b.split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Share of the shorter name's tokens that the longer one also contains. */
export function containmentSimilarity(a: string, b: string): number {
  const left = new Set(a.split(' ').filter(Boolean));
  const right = new Set(b.split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/** Normalised Levenshtein similarity in [0,1]. */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = new Array<number>(cols);
  let current = new Array<number>(cols);
  for (let j = 0; j < cols; j += 1) previous[j] = j;
  for (let i = 1; i < rows; i += 1) {
    current[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  const distance = previous[cols - 1] ?? Math.max(a.length, b.length);
  return 1 - distance / Math.max(a.length, b.length);
}

/** Blended name similarity — see the main app's normalize.ts for the rationale. */
export function nameSimilarity(a: string, b: string): number {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;

  const tokenView =
    0.45 * tokenSimilarity(left, right) +
    0.35 * containmentSimilarity(left, right) +
    0.2 * stringSimilarity(left, right);

  const compactView = 0.95 * stringSimilarity(left.replace(/ /g, ''), right.replace(/ /g, ''));

  return Math.max(tokenView, compactView);
}

/**
 * The readable part of a domain, as a name-like string.
 * `demo-39-exemple.fr` -> `northstar studio`, `am-demo-55.example.com` -> `am demo_account_31`.
 */
export function domainCoreAsName(domain: string): string {
  const core = domain.split('.')[0] ?? '';
  return core.replace(/[-_]+/g, ' ').trim();
}

/**
 * TLDs that say nothing about where a business trades. Everything else that is
 * two letters is a country code, and a country code that is not the prospect's
 * is strong evidence of a homonym in another market.
 */
const GENERIC_TLDS = new Set([
  'com', 'net', 'org', 'info', 'biz', 'eu', 'io', 'co', 'shop', 'store', 'agency',
  'pro', 'site', 'online', 'app', 'dev', 'xyz', 'me', 'club', 'auto', 'cloud',
]);

export function topLevelDomain(domain: string): string {
  const parts = domain.split('.');
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

/**
 * How a domain's TLD relates to the country the prospect trades in.
 *
 * The first benchmark run made the case for this: `mitchkaatelier.cz` was the
 * leading candidate for seven different French prospects, purely because its
 * name matched. A Czech artisan is not a homonym problem to be resolved by
 * reading the page — it is the wrong country, and that is knowable up front.
 */
export function tldCountryMatch(
  domain: string,
  country: string | null | undefined,
): 'match' | 'generic' | 'foreign' {
  const tld = topLevelDomain(domain);
  if (GENERIC_TLDS.has(tld) || tld.length !== 2) return 'generic';
  if (!country) return 'generic';
  return tld === country.toLowerCase() ? 'match' : 'foreign';
}
