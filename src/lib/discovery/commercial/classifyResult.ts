import {
  isPlatformDomain,
  normalizeDomain,
  normalizeFacebookUrl,
  normalizeInstagramHandle,
} from '@/lib/identity/normalize';
import { isDirectoryDomain } from '@/lib/discovery/search/classify';
import type { SearchHit } from '@/lib/enrichment/webSearch';

/**
 * Ce qu'un résultat EST — sept réponses possibles (§5).
 *
 * R4 en distinguait quatre, ce qui suffisait à sa question : « ce résultat
 * peut-il être le site de l'entreprise que je cherche ? ». R5 ne cherche
 * personne en particulier, donc les catégories doivent porter davantage :
 * savoir qu'un résultat est une place de marché plutôt qu'un annuaire ne change
 * rien à la décision immédiate — les deux sont écartés — mais change ce que le
 * rapport peut dire du bruit qu'un terme rapporte, et donc quel terme mérite
 * d'être repayé au prochain run.
 *
 * ---------------------------------------------------------------------------
 * On classe le DOMAINE, pas la page
 * ---------------------------------------------------------------------------
 * Une seule exception : les domaines qui SONT des éditeurs (presse, plateformes
 * de blog). Ailleurs, `demo-66-exemple.fr/blog/2024/05/mon-article` reste un
 * `official_site`, et c'est délibéré. La page est bien un article ; le domaine
 * est bien celui d'une entreprise, et c'est le domaine que l'étape suivante va
 * ouvrir — à sa racine. Classer cette URL en `article` supprimerait une
 * entreprise réelle du corpus parce qu'elle a un blog.
 *
 * ---------------------------------------------------------------------------
 * `uncertain` n'est pas une catégorie de repli
 * ---------------------------------------------------------------------------
 * Elle a une population précise : les présences qui appartiennent bien à
 * l'entreprise mais qui vivent chez un hébergeur (`x.wixsite.com`,
 * `x.business.site`) ou qui ne sont qu'un aiguillage (`linktr.ee/x`). Les
 * traiter en `official_site` ferait croire à un site propre là où il n'y a ni
 * mentions légales, ni domaine, ni parcours à lire. Les traiter en `directory`
 * serait faux dans l'autre sens : ces pages n'appartiennent à personne d'autre
 * qu'à l'entreprise. Elles méritent une revue humaine, ce que ce nom dit.
 *
 * Comme en R4, la décision ne lit ni le titre ni la description : l'URL suffit,
 * et s'en tenir à l'URL évite qu'un extrait de moteur — que nous n'avons pas le
 * droit de conserver — n'entre dans une décision persistée.
 */

export type CommercialResultKind =
  | 'official_site'
  | 'social_profile'
  | 'directory'
  | 'article'
  | 'marketplace'
  | 'irrelevant'
  | 'uncertain';

/**
 * Places de marché et petites annonces.
 *
 * Séparées des annuaires parce qu'elles produisent un bruit de nature
 * différente : un annuaire republie l'entreprise (nom, ville, SIREN) et peut
 * donc tromper un vérificateur d'identité ; une place de marché republie un
 * *produit*, et n'a jamais l'air d'être le site de qui que ce soit. Le premier
 * est un risque, le second une perte de temps — et un terme qui ramène surtout
 * des produits n'est pas mal formulé, il désigne autre chose que ce que nous
 * cherchons.
 */
export const MARKETPLACE_DOMAINS = new Set([
  'leboncoin.fr',
  'amazon.fr',
  'amazon.com',
  'ebay.fr',
  'ebay.com',
  'cdiscount.com',
  'fnac.com',
  'rakuten.com',
  'aliexpress.com',
  'alibaba.com',
  'vinted.fr',
  'etsy.com',
  'temu.com',
  'shein.com',
  'backmarket.fr',
  'manomano.fr',
  'darty.com',
  'boulanger.com',
  'oscaro.com',
  'mister-auto.com',
  'norauto.fr',
  'feuvert.fr',
  'roady.fr',
  'autobacs.fr',
  /**
   * Places de marché de **services**, ajoutées après le premier pilote R5 qui
   * les a produites : `allovoisins.com` a été promue en prospect. Elles sont
   * plus trompeuses que les places de marché de produits, parce qu'elles
   * ressemblent à une entreprise de service local — elles ont des prestations,
   * des avis, un formulaire de devis. Ce qu'elles vendent est la mise en
   * relation, jamais la prestation.
   */
  'allovoisins.com',
  'wecasa.fr',
  'needhelp.com',
  'jemepropose.com',
  'frizbiz.com',
  'yoojo.fr',
  'mesdepanneurs.fr',
  'travaux.com',
  'quotatis.fr',
  'habitatpresto.com',
]);

/**
 * Éditeurs : presse, agrégateurs d'actualité, plateformes de publication.
 *
 * La liste est explicite plutôt que devinée, pour la même raison que la liste
 * d'annuaires de R4 : une heuristique du type « le chemin contient une date »
 * se trompe dans les deux sens, et se tromper en écartant le vrai site est le
 * coût qu'on refuse de payer.
 */
export const MEDIA_DOMAINS = new Set([
  'lemonde.fr',
  'lefigaro.fr',
  'liberation.fr',
  'leparisien.fr',
  'ouest-france.fr',
  'sudouest.fr',
  'lavoixdunord.fr',
  'ladepeche.fr',
  'nicematin.com',
  'leprogres.fr',
  'lyonmag.com',
  'lyoncapitale.fr',
  'bienpublic.com',
  'estrepublicain.fr',
  'francebleu.fr',
  'franceinfo.fr',
  'francetvinfo.fr',
  'bfmtv.com',
  'actu.fr',
  '20minutes.fr',
  'huffingtonpost.fr',
  'capital.fr',
  'lesechos.fr',
  'usinenouvelle.com',
  'largus.fr',
  'caradisiac.com',
  'autoplus.fr',
  'automobile-magazine.fr',
  'turbo.fr',
  'motor1.com',
  'medium.com',
  'blogspot.com',
  'wordpress.com',
  'over-blog.com',
  'substack.com',
  'wikipedia.org',
  'wikiwand.com',
]);

/**
 * Hébergeurs de pages : la présence appartient à l'entreprise, le domaine non.
 *
 * Un site sur `wixsite.com` est un vrai site commercial et se lit très bien ;
 * ce qu'il n'a pas, c'est un domaine à vérifier, des mentions légales
 * exploitables et une identité que RDAP puisse attribuer. D'où `uncertain` :
 * une revue humaine tranchera, la machine ne le fera pas seule.
 */
export const HOSTED_PAGE_DOMAINS = new Set([
  'wixsite.com',
  'business.site',
  'sites.google.com',
  'weebly.com',
  'jimdosite.com',
  'jimdo.com',
  'e-monsite.com',
  'wordpress.com',
  'webnode.fr',
  'strikingly.com',
  'myshopify.com',
  'systeme.io',
  'linktr.ee',
  'beacons.ai',
  'bio.link',
  'taplink.cc',
  'campsite.bio',
]);

/** Réseaux sociaux : une présence détenue par l'entreprise, jamais son site. */
export const SOCIAL_DOMAINS = new Set([
  'instagram.com',
  'facebook.com',
  'tiktok.com',
  'linkedin.com',
  'x.com',
  'twitter.com',
  'youtube.com',
  'snapchat.com',
  'pinterest.fr',
  'pinterest.com',
  'threads.net',
]);

/**
 * Ce qui n'est le site de personne et n'apprend rien : fichiers, hôtes de
 * commodité, portails de l'administration, moteurs.
 */
const IRRELEVANT_HOST_PATTERNS = [
  /^translate\./i,
  /^webcache\./i,
  /^cache\./i,
  /^amp\./i,
  /^\d+\.\d+\.\d+\.\d+$/,
];

const IRRELEVANT_PATH_PATTERNS = [/\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|webp|svg|mp4)$/i];

/**
 * Cartes et portails d'itinéraires.
 *
 * Ajoutés après le premier pilote, qui a fait sonder `fr.mappy.com` comme s'il
 * s'agissait d'un artisan. Une carte liste des établissements sans en être
 * aucun — exactement la définition d'un annuaire, et `isPlatformDomain` ne les
 * connaissait pas tous.
 */
export const MAP_DOMAINS = new Set([
  'mappy.com',
  'viamichelin.fr',
  'viamichelin.com',
  'openstreetmap.org',
  'waze.com',
  'here.com',
  'tomtom.com',
  'petitfute.com',
  'lafourchette.com',
  'yellowpages.fr',
]);

export const INSTITUTIONAL_DOMAINS = new Set([
  'service-public.fr',
  'urssaf.fr',
  'impots.gouv.fr',
  'legifrance.gouv.fr',
  'insee.fr',
  'cci.fr',
  'bpifrance.fr',
  'francenum.gouv.fr',
  'ademe.fr',
]);

function domainInSet(domain: string, set: ReadonlySet<string>): boolean {
  if (set.has(domain)) return true;
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i += 1) {
    if (set.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

export interface ClassifiedResult {
  kind: CommercialResultKind;
  url: string;
  domain: string | null;
  /** Position dans la page de résultats, 1-indexée. */
  rank: number;
  instagramHandle: string | null;
  facebookUrl: string | null;
  /** Pourquoi ce classement. Sert le rapport et la revue, jamais la décision suivante. */
  reason: string;
}

/** Classe une URL. Ne lit ni le titre ni la description : voir le préambule. */
export function classifyCommercialHit(hit: SearchHit, rank: number): ClassifiedResult {
  const base = { url: hit.url, rank, instagramHandle: null, facebookUrl: null };

  let parsed: URL | null = null;
  try {
    parsed = new URL(hit.url);
  } catch {
    return { ...base, kind: 'irrelevant', domain: null, reason: 'URL illisible' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ...base, kind: 'irrelevant', domain: null, reason: `protocole ${parsed.protocol} ignoré` };
  }
  if (IRRELEVANT_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname))) {
    return { ...base, kind: 'irrelevant', domain: null, reason: 'hôte de commodité ou adresse IP' };
  }
  if (IRRELEVANT_PATH_PATTERNS.some((pattern) => pattern.test(parsed.pathname))) {
    return { ...base, kind: 'irrelevant', domain: null, reason: 'fichier, pas une page' };
  }

  const domain = normalizeDomain(hit.url);
  if (!domain) return { ...base, kind: 'irrelevant', domain: null, reason: 'domaine illisible' };

  // L'ordre compte : Instagram et Facebook sont aussi des « plateformes », et
  // ce sont les deux seules dont nous savons extraire un identifiant utilisable.
  const instagram = normalizeInstagramHandle(hit.url);
  if (instagram) {
    return {
      ...base,
      kind: 'social_profile',
      domain,
      instagramHandle: instagram,
      reason: `profil Instagram @${instagram}`,
    };
  }
  const facebook = normalizeFacebookUrl(hit.url);
  if (facebook) {
    return { ...base, kind: 'social_profile', domain, facebookUrl: facebook, reason: 'page Facebook' };
  }
  if (domainInSet(domain, SOCIAL_DOMAINS)) {
    return { ...base, kind: 'social_profile', domain, reason: `profil ${domain}, sans identifiant exploitable` };
  }

  if (domainInSet(domain, HOSTED_PAGE_DOMAINS)) {
    return {
      ...base,
      kind: 'uncertain',
      domain,
      reason: `page hébergée sur ${domain} : présence de l’entreprise, pas un domaine à vérifier`,
    };
  }
  if (domainInSet(domain, MARKETPLACE_DOMAINS)) {
    return { ...base, kind: 'marketplace', domain, reason: `${domain} vend des produits, pas un service local` };
  }
  if (domainInSet(domain, MEDIA_DOMAINS)) {
    return { ...base, kind: 'article', domain, reason: `${domain} publie des articles` };
  }
  if (domainInSet(domain, MAP_DOMAINS)) {
    return { ...base, kind: 'directory', domain, reason: `${domain} référence des établissements sans en être un` };
  }
  if (domainInSet(domain, INSTITUTIONAL_DOMAINS)) {
    return { ...base, kind: 'irrelevant', domain, reason: `${domain} est un portail institutionnel` };
  }
  if (isDirectoryDomain(domain)) {
    return { ...base, kind: 'directory', domain, reason: `${domain} republie des entreprises` };
  }
  if (isPlatformDomain(domain)) {
    return { ...base, kind: 'directory', domain, reason: `${domain} est une plateforme` };
  }

  return { ...base, kind: 'official_site', domain, reason: 'site propre possible' };
}

/**
 * Classe une page de résultats.
 *
 * Contrairement à R4, **aucune déduplication par domaine ici**. Le rail R4
 * cherchait un site pour un prospect donné : deux URLs du même domaine étaient
 * une redondance. R5 groupe ensuite les résultats en entreprises, et deux pages
 * d'un même domaine sont deux preuves que ce domaine existe et deux URLs à
 * proposer à la relecture. Dédupliquer ici perdrait cette information avant
 * qu'elle ne serve. Le regroupement s'en charge, et lui seul.
 */
export function classifyCommercialHits(hits: readonly SearchHit[]): ClassifiedResult[] {
  return hits.map((hit, index) => classifyCommercialHit(hit, index + 1));
}

export const COMMERCIAL_RESULT_KINDS: readonly CommercialResultKind[] = [
  'official_site',
  'social_profile',
  'directory',
  'article',
  'marketplace',
  'irrelevant',
  'uncertain',
];

/** Un décompte par catégorie, pour mesurer ce qu'un terme rapporte réellement. */
export function countByKind(results: readonly ClassifiedResult[]): Record<CommercialResultKind, number> {
  const counts: Record<CommercialResultKind, number> = {
    official_site: 0,
    social_profile: 0,
    directory: 0,
    article: 0,
    marketplace: 0,
    irrelevant: 0,
    uncertain: 0,
  };
  for (const result of results) counts[result.kind] += 1;
  return counts;
}

/** Additionne deux décomptes. Existe pour que `noUncheckedIndexedAccess` reste tenu. */
export function addKindCounts(
  target: Record<CommercialResultKind, number>,
  source: Record<CommercialResultKind, number>,
): void {
  for (const kind of COMMERCIAL_RESULT_KINDS) target[kind] += source[kind];
}
