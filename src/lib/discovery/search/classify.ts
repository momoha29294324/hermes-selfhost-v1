import {
  isPlatformDomain,
  nameSimilarity,
  normalizeDomain,
  normalizeFacebookUrl,
  normalizeInstagramHandle,
  normalizeName,
  stripAccents,
} from '@/lib/identity/normalize';
import type { SearchHit } from '@/lib/enrichment/webSearch';

/**
 * Trier ce qu'un moteur renvoie.
 *
 * Une page de résultats pour « "X Atelier" Lyon » contient rarement le site de
 * X en premier. Elle contient d'abord ce qui est optimisé pour être trouvé : des
 * annuaires, des agrégateurs, des sites de données d'entreprises qui republient
 * le registre, parfois un article. Le site de l'entreprise, quand il existe, est
 * quelque part au milieu.
 *
 * Ce fichier ne décide pas à qui appartient un domaine — c'est le travail du
 * vérificateur R3, et il ne change pas. Il décide seulement de **ce que chaque
 * résultat est** : un site propre possible, un profil social, un annuaire, du
 * bruit. La distinction compte parce qu'elle gouverne la suite : un site propre
 * part en vérification d'identité, un profil social part en rapprochement de
 * compte, un annuaire ne devient jamais ni l'un ni l'autre.
 *
 * L'erreur qu'il faut rendre impossible est précise : confondre
 * `societe.com/x-atelier` avec le site de X Atelier. La page porte le nom, la
 * ville, le SIREN — elle satisferait plusieurs signaux du vérificateur — et elle
 * n'appartient pas à l'entreprise. Un annuaire écarté ici ne peut plus être
 * confirmé par erreur plus loin.
 */

export type CandidateKind = 'own_site' | 'social' | 'directory' | 'noise';

/**
 * Domaines qui republient des entreprises sans être aucune d'elles.
 *
 * Annuaires, agrégateurs et republieurs du registre français, plus les
 * encyclopédies et plateformes de contenu. La liste est explicite plutôt que
 * devinée : une heuristique du genre « beaucoup de chiffres dans l'URL » se
 * trompe dans les deux sens, et se tromper en écartant le vrai site est le coût
 * qu'on ne veut pas payer.
 *
 * Elle vit ici et non dans la configuration de campagne parce qu'elle ne dépend
 * ni de la niche ni de la géographie — ce sont des plateformes, au même titre
 * que `PLATFORM_DOMAINS` dans `identity/normalize.ts`.
 */
export const DIRECTORY_DOMAINS = new Set([
  // Républieurs du registre / données d'entreprises
  'societe.com',
  'pappers.fr',
  'verif.com',
  'infogreffe.fr',
  'bilansgratuits.fr',
  'annuaire-entreprises.data.gouv.fr',
  'data.gouv.fr',
  'bodacc.fr',
  'demo-69-exemple.fr',
  'manageo.fr',
  'dirigeant.com',
  'entreprises.lefigaro.fr',
  'kompass.com',
  'europages.fr',
  'opendatasoft.com',
  'net-entreprises.fr',
  'l-entreprise.fr',
  'annuaire-mairie.fr',
  'infonet.fr',
  'b-reputation.com',
  'sirene.fr',
  // Annuaires locaux et avis
  'justacote.com',
  'cylex-france.fr',
  'cylex.fr',
  '118000.fr',
  '118712.fr',
  'hotfrog.fr',
  'pagespro.com',
  'lesbonsartisans.fr',
  'starofservice.com',
  'plus-que-pro.fr',
  'tripadvisor.fr',
  'tripadvisor.com',
  'petitscommerces.fr',
  'nosavis.fr',
  'avis-verifies.com',
  'guide-artisans.fr',
  'allo-artisans.fr',
  'lecomparateurassurance.com',
  // Petites annonces et places de marché
  'leboncoin.fr',
  'ebay.fr',
  'amazon.fr',
  'vinted.fr',
  // Contenu et encyclopédies
  'wikipedia.org',
  'wikiwand.com',
  'medium.com',
  'blogspot.com',
  'wordpress.com',
  'over-blog.com',
  'skyrock.com',
  'reddit.com',
  'quora.com',
  'scribd.com',
  'slideshare.net',
  'issuu.com',
  'youtube.com',
  'dailymotion.com',
  'pinterest.fr',
  'pinterest.com',
  // Emploi et formation, souvent remontés sur un nom d'entreprise
  'indeed.fr',
  'pole-emploi.fr',
  'francetravail.fr',
  'welcometothejungle.com',
  'glassdoor.fr',
  'jobijoba.com',
  'optioncarriere.com',
]);

/** Sous-domaines et hôtes de commodité qui ne sont le site de personne. */
const NOISE_HOST_PATTERNS = [
  /^translate\./i,
  /^webcache\./i,
  /^cache\./i,
  /^amp\./i,
  /\.pdf$/i,
];

/**
 * Domaines qui se DÉCLARENT annuaire dans leur propre nom.
 *
 * Ajouté après le premier benchmark live, qui a produit exactement le cas que
 * cette règle attrape : `demo-08.example.com` proposé pour un prospect
 * nommé « CAR ATELIER ». La liste explicite ne pouvait pas le connaître — il
 * n'existe pas d'inventaire des annuaires de niche — et le candidat n'a été
 * écarté qu'en aval, par le risque d'homonymie du vérificateur.
 *
 * Compter là-dessus serait fragile : le verdict `probable` tenait à un cheveu, et
 * un annuaire dont le nom contient l'enseigne recherchée obtiendrait un bon
 * accord de nom. Mieux vaut le refuser à l'étage prévu pour ça.
 *
 * Le motif exige le mot en début de domaine ou entouré de séparateurs, pour
 * qu'une entreprise dont le nom contient « guide » ou « top » ne soit pas
 * écartée : `demo-21-exemple.fr` reste un site propre possible, là où
 * `demo-08.example.com` ne l'est pas.
 */
const DIRECTORY_NAME_PATTERNS = [
  /(^|[-.])annuaire([-.]|$)/i,
  /(^|[-.])annuaires([-.]|$)/i,
  /(^|[-.])pagesjaunes([-.]|$)/i,
  /(^|[-.])comparateur([-.]|$)/i,
  /(^|[-.])trouver[-.]?(un|une|mon|ma)([-.]|$)/i,
  /(^|[-.])avis[-.]clients?([-.]|$)/i,
  /(^|[-.])classement[-.]des([-.]|$)/i,
];

/**
 * Vrai quand le domaine republie des entreprises au lieu d'en être une.
 *
 * Teste aussi les domaines parents, pour qu'un sous-domaine
 * (`x.societe.com`, `fr.wikipedia.org`) soit écarté comme son parent.
 */
export function isDirectoryDomain(domain: string | null): boolean {
  if (!domain) return false;
  const value = domain.toLowerCase();
  if (DIRECTORY_DOMAINS.has(value)) return true;
  const parts = value.split('.');
  for (let i = 1; i < parts.length - 1; i += 1) {
    if (DIRECTORY_DOMAINS.has(parts.slice(i).join('.'))) return true;
  }
  // Un annuaire que la liste ne connaît pas, mais qui se nomme lui-même.
  return DIRECTORY_NAME_PATTERNS.some((pattern) => pattern.test(value));
}

export interface SearchCandidate {
  kind: CandidateKind;
  url: string;
  domain: string | null;
  /** Position du résultat dans la page, 1-indexée. Mesure de qualité (§16). */
  rank: number;
  /** Variante de requête qui l'a produit. */
  variant: string;
  /** Renseigné pour `kind === 'social'`. */
  instagramHandle: string | null;
  facebookUrl: string | null;
  /** Pourquoi ce classement. Sert le rapport, pas la décision. */
  reason: string;
}

/**
 * Classe un résultat unique.
 *
 * Ne lit ni le titre ni la description pour décider : l'URL suffit, et s'en
 * tenir à l'URL évite que le contenu d'un résultat n'influence une décision
 * qu'il ne devrait pas influencer. Les deux champs restent disponibles pour le
 * rapprochement social, où ils servent d'indice transitoire et ne sont jamais
 * écrits (voir `terms.ts`).
 */
export function classifyHit(hit: SearchHit, rank: number, variant: string): SearchCandidate {
  const base = { url: hit.url, rank, variant, instagramHandle: null, facebookUrl: null };

  let parsed: URL | null = null;
  try {
    parsed = new URL(hit.url);
  } catch {
    return { ...base, kind: 'noise', domain: null, reason: 'URL illisible' };
  }

  if (NOISE_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname) || pattern.test(parsed.pathname))) {
    return { ...base, kind: 'noise', domain: null, reason: 'hôte de commodité ou fichier' };
  }

  const domain = normalizeDomain(hit.url);
  if (!domain) return { ...base, kind: 'noise', domain: null, reason: 'domaine illisible' };

  const instagram = normalizeInstagramHandle(hit.url);
  if (instagram) {
    return { ...base, kind: 'social', domain, instagramHandle: instagram, reason: `profil Instagram @${instagram}` };
  }

  const facebook = normalizeFacebookUrl(hit.url);
  if (facebook) {
    return { ...base, kind: 'social', domain, facebookUrl: facebook, reason: 'page Facebook' };
  }

  if (isDirectoryDomain(domain)) {
    return { ...base, kind: 'directory', domain, reason: `${domain} republie des entreprises` };
  }

  // Une plateforme qui n'est ni Instagram ni Facebook : ni site propre, ni
  // compte exploitable par nos rails. Google Maps et PagesJaunes atterrissent
  // ici, et c'est le bon endroit.
  if (isPlatformDomain(domain)) {
    return { ...base, kind: 'directory', domain, reason: `${domain} est une plateforme` };
  }

  return { ...base, kind: 'own_site', domain, reason: 'site propre possible' };
}

/**
 * Classe une page de résultats et déduplique par domaine.
 *
 * Le premier rang d'un domaine est conservé : c'est la position à laquelle le
 * moteur a réellement proposé ce site, et donc la seule qui mesure sa
 * pertinence. Garder aussi les rangs suivants gonflerait le bruit sans rien
 * apprendre.
 */
export function classifyHits(hits: SearchHit[], variant: string): SearchCandidate[] {
  const candidates: SearchCandidate[] = [];
  const seenDomains = new Set<string>();
  const seenSocial = new Set<string>();

  for (const [index, hit] of hits.entries()) {
    const candidate = classifyHit(hit, index + 1, variant);

    if (candidate.kind === 'social') {
      const key = candidate.instagramHandle ?? candidate.facebookUrl ?? candidate.url;
      if (seenSocial.has(key)) continue;
      seenSocial.add(key);
      candidates.push(candidate);
      continue;
    }

    if (candidate.domain) {
      if (seenDomains.has(candidate.domain)) continue;
      seenDomains.add(candidate.domain);
    }
    candidates.push(candidate);
  }

  return candidates;
}

/**
 * Un profil social peut-il être rattaché à ce prospect ?
 *
 * Le §7 du gate demande de ne pas fusionner un handle générique sur une simple
 * ressemblance, et c'est la bonne prudence : `@atelier_lyon` ressemble à
 * n'importe quel artisan lyonnais. La règle appliquée ici est donc qu'une
 * ressemblance de nom ne suffit jamais seule — il faut un second signal
 * cohérent :
 *
 *   - le domaine déjà confirmé du prospect apparaît dans le profil, ou
 *   - la ville du prospect apparaît dans le titre ou la description, ou
 *   - le téléphone du prospect apparaît.
 *
 * Le titre et la description sont lus en mémoire pour cette décision et ne sont
 * pas conservés : c'est l'exception « transient storage required for operation »
 * des conditions Brave.
 */
export interface SocialMatchInput {
  prospect: {
    displayName: string;
    brandName?: string | null;
    city?: string | null;
    phone?: string | null;
    domain?: string | null;
  };
  handle: string;
  /** Titre et description du résultat, transitoires. */
  context: string;
}

export interface SocialMatch {
  attachable: boolean;
  nameScore: number;
  corroboration: string[];
  reason: string;
}

/** Ressemblance de nom minimale pour qu'un handle mérite un examen. */
export const SOCIAL_NAME_FLOOR = 0.6;

export function matchSocialProfile(input: SocialMatchInput): SocialMatch {
  const names = [input.prospect.brandName, input.prospect.displayName]
    .map((value) => (value ?? '').trim())
    .filter((value) => value.length > 0);

  // Un handle s'écrit sans espace : `xatelier`, `x_atelier`, `x.atelier`.
  // On rétablit les séparateurs pour comparer des mots à des mots.
  const spacedHandle = input.handle.replace(/[._-]+/g, ' ');
  const nameScore = Math.max(0, ...names.map((name) => nameSimilarity(name, spacedHandle)));

  const haystack = stripAccents(input.context).toLowerCase();
  const corroboration: string[] = [];

  const city = (input.prospect.city ?? '').trim();
  if (city && haystack.includes(stripAccents(city).toLowerCase())) {
    corroboration.push(`ville « ${city} » citée`);
  }

  const domain = (input.prospect.domain ?? '').trim().toLowerCase();
  if (domain && haystack.includes(domain)) corroboration.push(`domaine ${domain} cité`);

  const phoneDigits = (input.prospect.phone ?? '').replace(/\D/g, '');
  if (phoneDigits.length >= 9) {
    const contextDigits = haystack.replace(/\D/g, '');
    if (contextDigits.includes(phoneDigits.slice(-9))) corroboration.push('téléphone cité');
  }

  /**
   * Un nom qui concorde presque parfaitement ET une corroboration : rattachable.
   * Un nom seul, même excellent, ne l'est pas — c'est exactement le cas de
   * l'homonyme, et le prix d'une erreur ici est un message qui parle du compte
   * de quelqu'un d'autre.
   */
  const attachable = nameScore >= SOCIAL_NAME_FLOOR && corroboration.length >= 1;

  return {
    attachable,
    nameScore: Number(nameScore.toFixed(3)),
    corroboration,
    reason: attachable
      ? `@${input.handle} : nom ${nameScore.toFixed(2)} + ${corroboration.join(', ')}`
      : nameScore < SOCIAL_NAME_FLOOR
        ? `@${input.handle} : nom trop éloigné (${nameScore.toFixed(2)})`
        : `@${input.handle} : nom ${nameScore.toFixed(2)} mais rien ne corrobore`,
  };
}

/** Le nom du prospect, tel qu'il servira de repère de lisibilité dans le rapport. */
export function normalizedProspectName(displayName: string, brandName?: string | null): string {
  return normalizeName((brandName ?? '').trim() || displayName);
}
