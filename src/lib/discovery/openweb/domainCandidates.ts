import { normalizeCity, normalizeName, stripAccents } from '@/lib/identity/normalize';
import type { NicheConfig } from '@/lib/config/schema';

/**
 * Fabrication de domaines candidats à partir de ce que le registre nous donne :
 * une enseigne, une raison sociale, une ville.
 *
 * C'est la partie la plus dangereuse de R3, et elle mérite d'être décrite
 * honnêtement : **ceci fabrique des hypothèses, pas des observations.** Un
 * domaine généré ici n'est rien tant que la chaîne de vérification
 * (DNS → HTTP → HTML → identité) ne l'a pas rattaché à l'entreprise. Aucune
 * fonction de ce fichier n'écrit quoi que ce soit, et aucune ne prétend savoir.
 *
 * Deux garde-fous gouvernent le reste :
 *
 *   1. **Un nom générique ne produit rien.** « PRESTATION AUTO » ne décrit pas une
 *      entreprise, il décrit un métier. `demo-29-exemple.fr` appartient
 *      statistiquement à quelqu'un d'autre, et le vérifier coûterait une
 *      requête pour, au mieux, un faux positif à écarter. Le test de
 *      généricité s'appuie sur le vocabulaire de la niche — jamais sur une
 *      liste de mots écrite en dur ici (voir CLAUDE.md).
 *
 *   2. **L'explosion combinatoire est interdite.** Le nombre de candidats est
 *      plafonné par une constante, pas par la prudence de l'appelant. Un nom de
 *      douze mots produit autant de candidats qu'un nom de deux, et
 *      `tests/openweb/domainCandidates.test.ts` en fait une propriété.
 *
 * Une subtilité qui a l'air d'un détail et n'en est pas : la généricité se juge
 * sur les jetons **distinctifs**, mais les domaines se construisent sur les
 * jetons **complets**. « Kapital Car'e » contient « care », qui appartient au
 * vocabulaire de la niche (« car care ») ; le filtrer produirait `demo-68-exemple.fr`
 * et manquerait `example.net`, qui est précisément la bonne réponse.
 */

export type DomainCandidateForm =
  | 'concat'
  | 'hyphen'
  | 'no_city'
  | 'head'
  | 'concat_city'
  | 'hyphen_city';

export interface DomainCandidate {
  /** Domaine normalisé, sans `www.`, prêt pour une résolution DNS. */
  domain: string;
  /** Étiquette lisible de la règle qui l'a produit. */
  form: DomainCandidateForm;
  /** La partie gauche, avant le point. */
  base: string;
  tld: string;
  /** Le nom d'où il sort — utile quand enseigne et raison sociale divergent. */
  fromName: string;
  /** Pourquoi il vaut une requête, en une clause lisible. */
  reason: string;
}

export interface DomainCandidateInput {
  brandName?: string | null;
  displayName?: string | null;
  legalName?: string | null;
  city?: string | null;
}

export interface DomainCandidateOptions {
  /**
   * Extensions essayées, dans l'ordre. La valeur par défaut est délibérément
   * absente : c'est la campagne qui connaît son pays, pas ce module.
   */
  tlds?: readonly string[];
  maxCandidates?: number;
}

/**
 * Plafond dur. Ce n'est pas un réglage de confort : chaque candidat coûte une
 * résolution DNS, potentiellement une requête Common Crawl et une requête HTTP
 * chez un tiers qui ne nous a rien demandé.
 */
export const MAX_DOMAIN_CANDIDATES = 8;

/** Un label DNS valide : 3 à 63 caractères, pas de tiret aux extrémités. */
const MIN_BASE_LENGTH = 3;
const MAX_BASE_LENGTH = 63;

/**
 * Extensions plausibles pour un pays donné.
 *
 * Règle ISO, pas géographie codée en dur : le ccTLD d'un pays est son code
 * ISO 3166-1 alpha-2 en minuscules. `.com` suit parce qu'une petite entreprise
 * qui n'a pas pris son ccTLD a pris celui-là.
 */
export function tldsForCountry(country: string | null | undefined): string[] {
  const code = (country ?? '').trim().toLowerCase();
  if (/^[a-z]{2}$/.test(code)) return [code, 'com'];
  return ['com'];
}

/**
 * Les jetons du vocabulaire de la niche, mot à mot.
 *
 * Le vocabulaire est fait d'expressions (« prestation standard », « car care ») ;
 * la généricité se juge mot par mot, parce qu'une enseigne emprunte des mots au
 * métier sans emprunter ses expressions.
 */
export function nicheWordSet(niche: NicheConfig): Set<string> {
  const words = new Set<string>();
  for (const term of [
    ...niche.positiveTerms,
    ...niche.adjacentTerms,
    ...niche.serviceTerms,
    ...niche.searchQueries,
  ]) {
    for (const word of stripAccents(term).toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length >= 2) words.add(word);
    }
  }
  return words;
}

function isUsableBase(base: string): boolean {
  if (base.length < MIN_BASE_LENGTH || base.length > MAX_BASE_LENGTH) return false;
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(base)) return false;
  return true;
}

interface FormPlan {
  form: DomainCandidateForm;
  base: string;
  reason: string;
}

/** The left-hand sides worth trying for one name, in order of prior likelihood. */
function formsFor(tokens: string[], cityToken: string): FormPlan[] {
  const plans: FormPlan[] = [];
  const seen = new Set<string>();
  const add = (form: DomainCandidateForm, base: string, reason: string): void => {
    if (!base || seen.has(base) || !isUsableBase(base)) return;
    seen.add(base);
    plans.push({ form, base, reason });
  };

  add('concat', tokens.join(''), 'nom accolé');
  if (tokens.length >= 2) add('hyphen', tokens.join('-'), 'nom avec tirets');

  if (cityToken && tokens.includes(cityToken)) {
    const withoutCity = tokens.filter((token) => token !== cityToken);
    if (withoutCity.length > 0) {
      add('no_city', withoutCity.join(''), 'nom sans la ville');
    }
  }

  if (tokens.length >= 3) add('head', tokens.slice(0, 2).join(''), 'deux premiers mots');

  /**
   * Un nom d'un seul mot est le cas où la génération se trompe le plus : le
   * domaine nu est presque toujours pris par quelqu'un d'autre. La variante
   * ville n'est pas un bonus de recall, c'est ce qui rend le candidat
   * distinguable d'un homonyme national.
   */
  if (tokens.length === 1 && cityToken && cityToken !== tokens[0]) {
    const single = tokens[0] ?? '';
    add('concat_city', `${single}${cityToken}`, 'nom en un mot, qualifié par la ville');
    add('hyphen_city', `${single}-${cityToken}`, 'nom en un mot, qualifié par la ville');
  }

  return plans;
}

/**
 * Fabrique les domaines candidats pour une entreprise.
 *
 * Renvoie un tableau vide — jamais une supposition faible — quand le nom ne
 * porte aucun élément distinctif, quand il est trop court, ou quand aucune
 * extension n'a été fournie.
 */
export function generateDomainCandidates(
  input: DomainCandidateInput,
  niche: NicheConfig,
  options: DomainCandidateOptions = {},
): DomainCandidate[] {
  const tlds = options.tlds ?? [];
  const max = options.maxCandidates ?? MAX_DOMAIN_CANDIDATES;
  if (tlds.length === 0 || max <= 0) return [];

  const nicheWords = nicheWordSet(niche);
  const cityToken = normalizeCity(input.city).replace(/[^a-z0-9]+/g, '');

  /**
   * Deux noms au plus. L'enseigne d'abord — c'est celle que l'entreprise
   * affiche — puis la raison sociale, qui diffère souvent et porte parfois le
   * vrai nom commercial ("SARL KC" / enseigne "Northstar Studio").
   */
  const names = [input.brandName, input.displayName, input.legalName]
    .map((name) => (name ?? '').trim())
    .filter((name) => name.length > 0);

  const plansByName: { name: string; plans: FormPlan[] }[] = [];
  const usedNames = new Set<string>();

  for (const name of names) {
    const normalized = normalizeName(name);
    if (!normalized || usedNames.has(normalized)) continue;

    const tokens = normalized.split(' ').filter((token) => token.length > 0);
    if (tokens.length === 0) continue;

    // Garde-fou de généricité : un nom entièrement fait de vocabulaire métier
    // (et/ou de la ville) ne désigne pas une entreprise en particulier.
    const distinctive = tokens.filter((token) => !nicheWords.has(token) && token !== cityToken);
    if (distinctive.length === 0) continue;

    const plans = formsFor(tokens, cityToken);
    if (plans.length === 0) continue;

    usedNames.add(normalized);
    plansByName.push({ name, plans });
    if (plansByName.length === 2) break;
  }

  if (plansByName.length === 0) return [];

  /**
   * Ordre de sortie : extension majeure, forme mineure. Le ccTLD du pays est
   * bien plus probable que `.com` pour une petite entreprise locale, donc tous
   * les candidats du premier TLD passent avant le second — le plafond coupe
   * alors dans les moins probables, pas au hasard.
   */
  const candidates: DomainCandidate[] = [];
  const seenDomains = new Set<string>();

  for (const tld of tlds) {
    for (const { name, plans } of plansByName) {
      for (const plan of plans) {
        if (candidates.length >= max) return candidates;
        const domain = `${plan.base}.${tld}`;
        if (seenDomains.has(domain)) continue;
        seenDomains.add(domain);
        candidates.push({
          domain,
          form: plan.form,
          base: plan.base,
          tld,
          fromName: name,
          reason: `${plan.reason} de « ${name} », extension .${tld}`,
        });
      }
    }
  }

  return candidates;
}
