/**
 * Normalisation primitives used by identity resolution and evidence storage.
 * Pure functions, no IO — heavily unit-tested because deduplication depends on them.
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
 * Annuaires et agrégateurs. Pas des plateformes au sens social, mais jamais le
 * site d'une entreprise non plus : une fiche *parle* de l'entreprise, elle ne
 * lui appartient pas.
 *
 * L'application n'en avait pas besoin tant que seul le worker classait des
 * candidats. R7.2B.1 a changé cela : sur les 34 domaines `probable` laissés en
 * suspens par R7.2, une fiche d'annuaire qui publie le SIREN du prospect
 * ressemble, signal pour signal, au site de l'entreprise — et le vérificateur
 * d'identité y verrait une preuve d'appartenance. La liste doit donc exister
 * des deux côtés, et `tests/webintel/parity.test.ts` échoue le jour où elles
 * divergent.
 */
export const DIRECTORY_DOMAINS = new Set([
  // Observés dans le benchmark du 2026-08-09 comme meilleur candidat d'un
  // prospect. Chacun est une fiche à propos de l'entreprise, jamais l'entreprise.
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

const LEGAL_TOKENS = new Set([
  'sarl', 'sas', 'sasu', 'eurl', 'sci', 'snc', 'sa', 'ei', 'eirl', 'scop', 'sarlu',
  'entreprise', 'ste', 'societe', 'sté', 'monsieur', 'madame', 'mr', 'mme',
  'auto-entrepreneur', 'autoentrepreneur', 'micro-entreprise',
]);

export function stripAccents(input: string): string {
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

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

function inDomainSet(domain: string, set: ReadonlySet<string>): boolean {
  if (set.has(domain)) return true;
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i += 1) {
    if (set.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

export function isPlatformDomain(domain: string | null): boolean {
  if (!domain) return false;
  return inDomainSet(domain, PLATFORM_DOMAINS);
}

/** Vrai quand le domaine sert des fiches sur des entreprises, pas une entreprise. */
export function isDirectoryDomain(domain: string | null): boolean {
  if (!domain) return false;
  return inDomainSet(domain, DIRECTORY_DOMAINS);
}

export function normalizeUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let raw = input.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const url = new URL(raw);
    url.hash = '';
    // Drop tracking params; keep everything else so paths stay meaningful.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * Une chaîne de chiffres déjà en forme internationale (indicatif inclus, sans
 * `+`). Le `0` national français ne doit jamais survivre après l'indicatif
 * `33` — `+330...` est une adresse invalide, injoignable telle quelle. Quand
 * il est présent et que le reste est un numéro national à 10 chiffres sans
 * ambiguïté, il est retiré ; sinon la valeur est refusée plutôt que devinée
 * (fail closed).
 */
function normalizeInternationalDigits(digits: string): string | null {
  if (digits.startsWith('33')) {
    const national = digits.slice(2);
    if (national.startsWith('0')) {
      return national.length === 10 ? `+33${national.slice(1)}` : null;
    }
    return national.length === 9 ? `+33${national}` : null;
  }
  return `+${digits}`;
}

/** French-aware phone normalisation to E.164. Returns null when not confident. */
export function normalizePhone(input: string | null | undefined, country = 'FR'): string | null {
  if (!input) return null;
  const digits = input.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) {
    const rest = digits.slice(1).replace(/\D/g, '');
    if (rest.length < 8 || rest.length > 15) return null;
    return normalizeInternationalDigits(rest);
  }
  let plain = digits.replace(/\D/g, '');
  if (plain.startsWith('00') && plain.length >= 10) plain = plain.slice(2);
  if (plain.length >= 10 && plain.startsWith('33')) {
    return normalizeInternationalDigits(plain);
  }
  if (country === 'FR') {
    if (plain.length === 10 && plain.startsWith('0')) return `+33${plain.slice(1)}`;
    if (plain.length === 9 && !plain.startsWith('0')) return `+33${plain}`;
  }
  return null;
}

export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const value = input.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value)) return null;
  // Reject obvious asset filenames captured by naive regexes.
  if (/\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(value)) return null;
  return value;
}

const INSTAGRAM_RESERVED = new Set([
  'p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'about', 'developer',
  'legal', 'directory', 'tv', 'direct', 'privacy', 'terms', 'graphql',
]);

/**
 * Comptes sociaux qui figurent sur un site sans appartenir à l'entreprise.
 *
 * Le pilote R5 a attribué `@wixstudio` à un prospect : le lien vient du pied de
 * page « Créé avec Wix », pas de l'entreprise. Comme la campagne a pour canal le
 * DM Instagram, la conséquence n'est pas cosmétique — c'est un message adressé à
 * l'éditeur du site plutôt qu'au artisan.
 *
 * La liste est explicite plutôt que devinée. Une heuristique du genre « le
 * handle ne ressemble pas au nom du site » se tromperait dans les deux sens, et
 * se tromper en écartant le vrai compte est le coût qu'on ne veut pas payer :
 * beaucoup d'artisans tiennent leur compte sous un pseudonyme sans rapport avec
 * leur enseigne.
 */
export const VENDOR_SOCIAL_HANDLES = new Set([
  'wixstudio', 'wix', 'wixcom', 'squarespace', 'shopify', 'wordpress', 'wordpressdotcom',
  'webflow', 'weebly', 'jimdo', 'godaddy', 'hostinger', 'ionos', 'ovhcloud', 'ovh',
  'google', 'googlefrance', 'meta', 'facebook', 'instagram', 'canva', 'mailchimp',
  'stripe', 'paypal', 'shopifyfrance', 'systeme.io', 'systemeio',
]);

/**
 * Vrai quand un identifiant social appartient manifestement à un prestataire.
 *
 * Utilisé au moment de choisir quel compte rattacher à un prospect, jamais au
 * moment de normaliser : `@wix` reste un handle valide, il n'est simplement pas
 * celui de l'entreprise dont on lit le site.
 */
export function isVendorHandle(handle: string | null): boolean {
  if (!handle) return false;
  return VENDOR_SOCIAL_HANDLES.has(handle.trim().toLowerCase().replace(/^@/, ''));
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

/**
 * Segments qui ne sont pas des identifiants de page mais des morceaux de la
 * STRUCTURE d'URL de Facebook.
 *
 * R7-PILOT — la liste s'est allongée après un faux doublon observé sur le
 * corpus. `facebook.com/people/AJ-Atelier/61553328322589/` rendait
 * « people », c'est-à-dire le préfixe commun à TOUTES les pages de ce format.
 * Cinq entreprises sans rapport partageaient donc le même identifiant Facebook
 * en base, et se proposaient mutuellement à la fusion — trois d'entre elles
 * portaient déjà `dedupe_status = 'needs_review'` pour cette seule raison.
 *
 * Un préfixe structurel n'est pas une identité faible : c'en est zéro. Rendre
 * `null` est donc la seule réponse honnête, et c'est déjà ce que faisait
 * `sharer` ou `profile.php`.
 */
const FACEBOOK_STRUCTURAL_SEGMENTS: ReadonlySet<string> = new Set([
  'sharer',
  'sharer.php',
  'plugins',
  'tr',
  'dialog',
  'login',
  'profile.php',
  'people',
  'pages',
  'pg',
  'groups',
  'events',
  'watch',
  'story.php',
  'photo.php',
  'permalink.php',
  'search',
  'hashtag',
]);

export function normalizeFacebookUrl(input: string | null | undefined): string | null {
  if (!input) return null;

  // `/people/<Nom-Affiché>/<id numérique>/` — le seul segment stable est l'id.
  // Le nom affiché change quand l'entreprise le change ; l'id, jamais.
  const people = input.match(/facebook\.com\/people\/[^/]+\/(\d{5,})/i);
  if (people?.[1]) return `https://www.facebook.com/${people[1]}`;

  const match = input.match(/facebook\.com\/([A-Za-z0-9_.\-]+)/i);
  const slug = match?.[1];
  if (!slug) return null;
  if (FACEBOOK_STRUCTURAL_SEGMENTS.has(slug.toLowerCase())) return null;
  return `https://www.facebook.com/${slug}`;
}

export function normalizeRegistryId(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  if (digits.length === 9 || digits.length === 14) return digits;
  return null;
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

/**
 * Blended name similarity.
 *
 * Two readings are combined and the stronger wins:
 *   - token view: overlap, containment ("Demo Delta" inside "Demo Delta Ville")
 *     and edit distance;
 *   - compact view: the same names with all separators removed, which rescues
 *     "A.M ATELIER" vs "Demo Delta". It is capped just under the merge
 *     threshold so a one-character difference ("Detail Auto 68"/"69") can never
 *     auto-merge on spelling alone.
 */
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
