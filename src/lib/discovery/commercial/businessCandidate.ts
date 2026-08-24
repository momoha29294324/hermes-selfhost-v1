import { nameSimilarity, normalizeName, stripAccents } from '@/lib/identity/normalize';
import type { ClassifiedResult, CommercialResultKind } from '@/lib/discovery/commercial/classifyResult';
import type { CommercialQuery } from '@/lib/discovery/commercial/queryPlan';

/**
 * D'une liste d'URLs à une liste d'entreprises (§6).
 *
 * L'erreur que ce module existe pour rendre impossible est simple à commettre
 * et coûteuse à réparer : **créer un prospect par URL**. Une seule entreprise
 * produit couramment cinq résultats — sa page d'accueil, sa page tarifs, son
 * Instagram, sa page Facebook, sa fiche sur un annuaire. Cinq prospects pour
 * une entreprise, ce n'est pas cinq fois plus de travail commercial : c'est un
 * corpus qui ment sur sa taille, une déduplication qui explose plus tard, et
 * quatre messages de trop au même destinataire.
 *
 * ---------------------------------------------------------------------------
 * Ce qui fait converger deux résultats
 * ---------------------------------------------------------------------------
 * Le domaine, d'abord : deux URLs du même domaine sont la même entreprise, sans
 * discussion. C'est le seul regroupement certain, et il fait l'essentiel du
 * travail.
 *
 * Le nom, ensuite, et seulement entre un compte social et un domaine :
 * `@xatelier` rejoint `demo-66-exemple.fr` parce que le cœur du domaine et le
 * handle sont le même mot. Le seuil est **plus haut** que celui du
 * rapprochement social de R4 (0,75 contre 0,60), et c'est délibéré : R4
 * comparait un handle au nom d'un prospect connu, avec une corroboration
 * exigée par ailleurs. Ici il n'y a rien à corroborer — nous ne connaissons
 * encore personne — donc la ressemblance doit être quasi lexicale pour valoir
 * fusion. En dessous, le compte reste une entreprise à part entière : deux
 * lignes séparées coûtent une relecture, une fusion à tort détruit une piste.
 *
 * ---------------------------------------------------------------------------
 * Un annuaire ne devient jamais une entreprise
 * ---------------------------------------------------------------------------
 * Le §5 du gate est catégorique et ce module l'applique littéralement : les
 * résultats `directory`, `article`, `marketplace` et `irrelevant` ne créent
 * aucun candidat. Ils peuvent devenir une **piste** rattachée à un candidat
 * existant — `societe.com/x-atelier` cite bien `x-atelier` — et cette
 * piste ne vaut jamais preuve : elle indique seulement qu'un tiers associe ce
 * nom à cette entreprise. Le §5 le dit ainsi : « la preuve finale doit venir
 * d'une présence appartenant réellement au business ».
 */

/** Ressemblance minimale entre un handle et le cœur d'un domaine pour fusionner. */
export const SOCIAL_SITE_CONVERGENCE = 0.75;

/** Longueur minimale d'un jeton d'identité pour qu'une piste puisse s'y rattacher. */
export const LEAD_TOKEN_MIN_LENGTH = 5;

export type CandidateForm = 'site' | 'social' | 'hosted_page';

export interface CandidateSighting {
  tier: CommercialQuery['tier'];
  zone: string;
  term: string;
  /** Rang du résultat dans la page. Mesure de pertinence du terme. */
  rank: number;
  kind: CommercialResultKind;
  url: string;
}

export interface CandidateLead {
  kind: CommercialResultKind;
  url: string;
  domain: string | null;
}

export interface CommercialBusinessCandidate {
  /** Clé canonique de regroupement. Stable d'un run à l'autre. */
  key: string;
  form: CandidateForm;
  /** Le jeton lisible qui sert de nom provisoire — jamais présenté comme le nom réel. */
  nameToken: string;
  domain: string | null;
  siteUrl: string | null;
  instagramHandle: string | null;
  facebookUrl: string | null;
  /** URLs vues, toutes catégories confondues, propres à cette entreprise. */
  ownUrls: string[];
  /** Pistes de tiers : annuaire, article, place de marché. Jamais une preuve. */
  leads: CandidateLead[];
  /** Zones dont une requête a fait apparaître cette entreprise. */
  zones: string[];
  /** Termes qui l'ont fait apparaître. */
  terms: string[];
  sightings: CandidateSighting[];
  /** Meilleur rang obtenu, toutes requêtes confondues. */
  bestRank: number;
}

export interface GroupingOutcome {
  candidates: CommercialBusinessCandidate[];
  /**
   * Résultats propres (site, social, page hébergée) qui ont rejoint un candidat
   * déjà connu. C'est le nombre de doublons que le regroupement a évités —
   * la mesure demandée au §26 sous « duplicates ».
   */
  duplicateSightings: number;
  /** Pistes de tiers rattachées à un candidat par leur URL. */
  leadsAttached: number;
  /** Pistes qui ne se rattachent à rien : mesurées, jamais promues. */
  leadsUnattached: number;
}

export interface QueryResults {
  query: CommercialQuery;
  results: readonly ClassifiedResult[];
}

/** Le cœur lisible d'un domaine : `demo-65-exemple.fr` → `x atelier`. */
export function domainCore(domain: string): string {
  const core = domain.split('.')[0] ?? domain;
  return core.replace(/[-_]+/g, ' ').trim();
}

/** Un handle lu comme des mots : `x_atelier.69` → `x atelier 69`. */
export function handleAsWords(handle: string): string {
  return handle.replace(/[._-]+/g, ' ').trim();
}

/** Premier segment de chemin — l'identité d'une page hébergée (`linktr.ee/<ici>`). */
export function hostedPageSlug(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split('/').filter((part) => part.length > 0);
    return segments[0] ?? null;
  } catch {
    return null;
  }
}

/** Forme compacte, sans accent ni séparateur : ce qu'on cherche dans une URL de tiers. */
function compactToken(value: string): string {
  return stripAccents(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

interface MutableCandidate extends CommercialBusinessCandidate {
  compact: string;
}

function facebookSlug(url: string): string | null {
  const match = url.match(/facebook\.com\/([A-Za-z0-9_.\-]+)/i);
  return match?.[1] ?? null;
}

/**
 * Regroupe les résultats classés en entreprises candidates.
 *
 * Pur, sans réseau, sans base : le regroupement se teste donc entièrement sur
 * des listes d'URLs, y compris les cas qui comptent (même entreprise vue par
 * trois requêtes différentes, compte social qui rejoint un site, annuaire qui
 * ne devient rien).
 */
export function groupIntoBusinesses(batches: readonly QueryResults[]): GroupingOutcome {
  const byKey = new Map<string, MutableCandidate>();
  const pendingLeads: { lead: CandidateLead }[] = [];
  let duplicateSightings = 0;

  const record = (
    candidate: MutableCandidate,
    query: CommercialQuery,
    result: ClassifiedResult,
    isNew: boolean,
  ): void => {
    if (!isNew) duplicateSightings += 1;
    if (!candidate.zones.includes(query.zone)) candidate.zones.push(query.zone);
    if (!candidate.terms.includes(query.term)) candidate.terms.push(query.term);
    if (!candidate.ownUrls.includes(result.url)) candidate.ownUrls.push(result.url);
    candidate.sightings.push({
      tier: query.tier,
      zone: query.zone,
      term: query.term,
      rank: result.rank,
      kind: result.kind,
      url: result.url,
    });
    candidate.bestRank = Math.min(candidate.bestRank, result.rank);
  };

  const upsert = (key: string, seed: () => MutableCandidate): { candidate: MutableCandidate; isNew: boolean } => {
    const existing = byKey.get(key);
    if (existing) return { candidate: existing, isNew: false };
    const created = seed();
    byKey.set(key, created);
    return { candidate: created, isNew: true };
  };

  for (const batch of batches) {
    for (const result of batch.results) {
      if (result.kind === 'official_site' && result.domain) {
        const key = `site:${result.domain}`;
        const { candidate, isNew } = upsert(key, () => ({
          key,
          form: 'site',
          nameToken: domainCore(result.domain as string),
          compact: compactToken(domainCore(result.domain as string)),
          domain: result.domain,
          siteUrl: `https://${result.domain}/`,
          instagramHandle: null,
          facebookUrl: null,
          ownUrls: [],
          leads: [],
          zones: [],
          terms: [],
          sightings: [],
          bestRank: result.rank,
        }));
        record(candidate, batch.query, result, isNew);
        continue;
      }

      if (result.kind === 'social_profile') {
        const handle = result.instagramHandle ?? (result.facebookUrl ? facebookSlug(result.facebookUrl) : null);
        if (!handle) {
          // Un profil dont nous ne savons pas extraire d'identifiant (TikTok,
          // LinkedIn) n'est pas exploitable par nos rails : il reste une piste.
          pendingLeads.push({ lead: { kind: result.kind, url: result.url, domain: result.domain } });
          continue;
        }
        const platform = result.instagramHandle ? 'instagram' : 'facebook';
        const key = `social:${platform}:${handle.toLowerCase()}`;
        const { candidate, isNew } = upsert(key, () => ({
          key,
          form: 'social',
          nameToken: handleAsWords(handle),
          compact: compactToken(handle),
          domain: null,
          siteUrl: null,
          instagramHandle: result.instagramHandle,
          facebookUrl: result.facebookUrl,
          ownUrls: [],
          leads: [],
          zones: [],
          terms: [],
          sightings: [],
          bestRank: result.rank,
        }));
        record(candidate, batch.query, result, isNew);
        continue;
      }

      if (result.kind === 'uncertain' && result.domain) {
        const slug = hostedPageSlug(result.url);
        const key = slug ? `hosted:${result.domain}/${slug.toLowerCase()}` : `hosted:${result.domain}`;
        const token = slug ?? domainCore(result.domain);
        const { candidate, isNew } = upsert(key, () => ({
          key,
          form: 'hosted_page',
          nameToken: handleAsWords(token),
          compact: compactToken(token),
          domain: null,
          siteUrl: result.url,
          instagramHandle: null,
          facebookUrl: null,
          ownUrls: [],
          leads: [],
          zones: [],
          terms: [],
          sightings: [],
          bestRank: result.rank,
        }));
        record(candidate, batch.query, result, isNew);
        continue;
      }

      // directory | article | marketplace | irrelevant : jamais une entreprise.
      pendingLeads.push({ lead: { kind: result.kind, url: result.url, domain: result.domain } });
    }
  }

  mergeSocialsIntoSites(byKey);

  // Les pistes sont rattachées APRÈS la fusion, pour qu'une fiche d'annuaire
  // citant `x-atelier` aille sur l'entreprise fusionnée et non sur un compte
  // qui n'existe plus comme candidat séparé.
  let leadsAttached = 0;
  const candidates = [...byKey.values()];
  for (const { lead } of pendingLeads) {
    const target = candidates.find(
      (candidate) => candidate.compact.length >= LEAD_TOKEN_MIN_LENGTH && compactToken(lead.url).includes(candidate.compact),
    );
    if (!target) continue;
    if (target.leads.some((existing) => existing.url === lead.url)) continue;
    target.leads.push(lead);
    leadsAttached += 1;
  }

  const ordered = candidates
    .map(({ compact: _compact, ...candidate }) => candidate)
    .sort((left, right) => right.sightings.length - left.sightings.length || left.bestRank - right.bestRank);

  return {
    candidates: ordered,
    duplicateSightings,
    leadsAttached,
    leadsUnattached: pendingLeads.length - leadsAttached,
  };
}

/**
 * Fait converger les comptes sociaux vers le site de la même entreprise.
 *
 * Le sens de la fusion n'est pas arbitraire : c'est toujours le compte qui
 * rejoint le site, jamais l'inverse. Un site porte un domaine, des mentions
 * légales et un parcours commercial ; un compte n'a qu'un handle. Faire du
 * compte le porteur de l'entreprise perdrait tout ce que l'étape suivante doit
 * lire.
 */
function mergeSocialsIntoSites(byKey: Map<string, MutableCandidate>): void {
  const sites = [...byKey.values()].filter((candidate) => candidate.form === 'site');
  if (sites.length === 0) return;

  for (const [key, candidate] of [...byKey.entries()]) {
    if (candidate.form !== 'social') continue;

    let best: { site: MutableCandidate; score: number } | null = null;
    for (const site of sites) {
      const score = nameSimilarity(candidate.nameToken, site.nameToken);
      if (score >= SOCIAL_SITE_CONVERGENCE && (!best || score > best.score)) best = { site, score };
    }
    if (!best) continue;

    const { site } = best;
    site.instagramHandle = site.instagramHandle ?? candidate.instagramHandle;
    site.facebookUrl = site.facebookUrl ?? candidate.facebookUrl;
    for (const url of candidate.ownUrls) if (!site.ownUrls.includes(url)) site.ownUrls.push(url);
    for (const zone of candidate.zones) if (!site.zones.includes(zone)) site.zones.push(zone);
    for (const term of candidate.terms) if (!site.terms.includes(term)) site.terms.push(term);
    site.sightings.push(...candidate.sightings);
    site.bestRank = Math.min(site.bestRank, candidate.bestRank);
    byKey.delete(key);
  }
}

/**
 * Le nom provisoire d'une entreprise, tant que son site n'a pas été lu.
 *
 * Explicitement **provisoire** : `demo-66-exemple.fr` devient « Xatelier », ce qui
 * n'est pas le nom de l'entreprise mais une chaîne dérivée d'un domaine. Rien
 * ne doit persister ce nom comme une observation — il sert à afficher une
 * ligne de rapport avant lecture du site, et le rail le remplace par le nom
 * réellement déclaré dès qu'il en a lu un.
 */
export function provisionalName(candidate: CommercialBusinessCandidate): string {
  const normalized = normalizeName(candidate.nameToken);
  if (!normalized) return candidate.nameToken;
  return normalized
    .split(' ')
    .map((word) => (word.length > 0 ? `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}` : word))
    .join(' ');
}
