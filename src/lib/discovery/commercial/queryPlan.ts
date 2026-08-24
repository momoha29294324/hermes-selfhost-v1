import { stripAccents } from '@/lib/identity/normalize';
import type { CommercialDiscoveryConfig, GeographyConfig, NicheConfig } from '@/lib/config/schema';

/**
 * R5 — la question change de sens.
 *
 * Les quatre rails précédents partaient d'une entreprise connue et cherchaient
 * son site : « voici SARL X à Lyon, où est-elle sur le web ? ». R4-S a mesuré
 * ce que cette question rapporte encore — 60 requêtes Serper sur les cinquante
 * entreprises que Brave n'avait pas résolues, zéro site supplémentaire. Le
 * verdict n'est pas que l'index est mauvais : il est que **ces entreprises-là
 * n'ont pas de présence web à trouver.**
 *
 * Ce module pose donc l'autre question, celle qu'un client poserait :
 *
 *     « qui fait ce métier ici ? »
 *
 * Et la différence de rendement est structurelle, pas marginale. Chercher
 * `"SARL DUPONT AUTO" Lyon` ne peut réussir que si Dupont a un site ET que ce
 * site porte ce nom. Chercher `atelier automobile Lyon` réussit dès qu'une
 * entreprise du métier est indexée à Lyon — et une entreprise indexée sur cette
 * requête est, par construction, une entreprise commercialement active. Le
 * corpus obtenu est donc biaisé, et c'est exactement le biais recherché : nous
 * ne voulons pas les entreprises invisibles, nous voulons celles qui vendent.
 *
 * ---------------------------------------------------------------------------
 * Trois décisions à défendre
 * ---------------------------------------------------------------------------
 *
 * **Le plan est ordonné par palier, pas par zone.** Toutes les requêtes `core`
 * de toutes les zones passent avant la première `secondary`. Un run interrompu
 * — plafond de budget, clé refusée — a donc couvert les trois zones de façon
 * comparable, au lieu d'avoir épuisé Lyon et jamais interrogé Dijon. Un corpus
 * tronqué par l'ordre de parcours ne représente ni la zone ni rien d'autre ;
 * c'est la leçon que le mini-gate R2.1 avait déjà tirée du tuilage Places.
 *
 * **La déduplication porte sur l'ensemble des mots, pas sur la chaîne.**
 * `atelier automobile Lyon` et `Lyon atelier automobile` sont la même
 * question posée deux fois, et un index y répond pratiquement pareil. Les
 * distinguer ferait payer deux fois pour apprendre la même chose — ce que le §3
 * du gate interdit nommément. La normalisation retire aussi les accents, parce
 * que `esthétique` et `esthetique` sont deux orthographes d'un seul mot.
 *
 * **Aucune géographie n'est écrite ici.** Les zones sont dérivées de la
 * `geography` de la campagne, qui est un fichier de configuration. Écrire
 * « Lyon » dans ce module rendrait le rail faux pour la campagne suivante, et
 * c'est une règle du dépôt, pas une préférence de style.
 */

export type CommercialQueryTier = 'core' | 'secondary' | 'service_specific' | 'in_scope';

/** L'ordre de dépense : rendement décroissant, arrêt possible entre deux paliers. */
export const TIER_ORDER: readonly CommercialQueryTier[] = ['in_scope', 'core', 'secondary', 'service_specific'];

/**
 * Une zone de prospection.
 *
 * Volontairement une chaîne libre et non un point géographique : ce que nous
 * mettons dans une requête est le nom qu'une entreprise écrit sur son site.
 * Personne n'écrit « 45.76 N, 4.85 E », et presque personne n'écrit « Rhône » —
 * on écrit sa ville. C'est le même raisonnement qui a fait exclure le
 * département des requêtes du rail R4 (`search/queryPlan.ts`).
 */
export interface CommercialZone {
  label: string;
  /** Renseigné quand la configuration le donne : sert au rapprochement, jamais à la requête. */
  postalCode: string | null;
}

export interface CommercialQuery {
  tier: CommercialQueryTier;
  term: string;
  zone: string;
  query: string;
  /** Clé de déduplication : les mots de la requête, normalisés et triés. */
  key: string;
  /** Pourquoi cette requête existe. Recopié dans le registre de dépense. */
  rationale: string;
}

const TIER_RATIONALE: Readonly<Record<CommercialQueryTier, string>> = {
  core: 'le mot du métier, celui que le professionnel écrit sur sa page d’accueil',
  secondary: 'le mot que le client tape, souvent absent du vocabulaire du métier',
  service_specific: 'une prestation précise : peu de rappel, mais très qualifié',
  in_scope:
    'le geste de PRESTATION STANDARD lui-même, dans les mots du client — le seul palier qui ne ramène pas ' +
    'd’ateliers de protection, parce qu’il ne leur emprunte aucun vocabulaire',
};

/**
 * Les zones d'une campagne, telles que sa géographie les décrit.
 *
 * Chaque mode donne le libellé que l'on peut raisonnablement écrire dans une
 * requête, et `radius` est le cas intéressant : le rayon sert à filtrer un
 * résultat, il ne se tape pas. Ce qui se tape est le libellé du centre, que la
 * configuration nomme déjà (« Lyon Part-Dieu »).
 *
 * `national` ne rend aucune zone. Ce n'est pas un oubli : une requête sans lieu
 * ramène les mêmes dix marques nationales quel que soit le terme, et un rail
 * qui prétendrait couvrir la France entière avec dix requêtes mentirait sur sa
 * couverture. Une campagne nationale doit énumérer ses villes.
 */
export function zonesFromGeography(geography: GeographyConfig): CommercialZone[] {
  switch (geography.mode) {
    case 'cities':
      return geography.cities.map((city) => ({
        label: city.name,
        postalCode: city.postalCode ?? null,
      }));
    case 'radius':
      return [{ label: geography.center.label, postalCode: null }];
    case 'department':
      return geography.departments.map((code) => ({ label: code, postalCode: null }));
    case 'region':
      return geography.regions.map((name) => ({ label: name, postalCode: null }));
    case 'national':
      return [];
    default:
      return [];
  }
}

/** Les mots d'une requête, sans accent, sans ponctuation, triés — sa vraie identité. */
export function queryKey(query: string): string {
  return stripAccents(query)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 0)
    .sort()
    .join(' ');
}

export function termsForTier(niche: NicheConfig, tier: CommercialQueryTier): string[] {
  switch (tier) {
    case 'core':
      return niche.commercialQueries.core;
    case 'secondary':
      return niche.commercialQueries.secondary;
    case 'service_specific':
      return niche.commercialQueries.serviceSpecific;
    case 'in_scope':
      return niche.commercialQueries.inScope;
    default:
      return [];
  }
}

export interface CommercialPlanOptions {
  tiers: readonly CommercialQueryTier[];
  maxTermsPerTier: number;
  /** Plafond dur de requêtes. Le plan est tronqué ici, pas au moment de payer. */
  maxQueries: number;
}

/**
 * Construit le plan complet, ordonné et sans doublon.
 *
 * Pur et sans réseau : le coût exact d'un run se connaît donc **avant** de le
 * lancer, ce qui est la seule façon honnête d'annoncer un plafond. Un plan
 * calculé au fil de l'eau ne se vérifie qu'après la facture.
 */
export function buildCommercialQueryPlan(
  niche: NicheConfig,
  zones: readonly CommercialZone[],
  options: CommercialPlanOptions,
): CommercialQuery[] {
  const planned: CommercialQuery[] = [];
  const seen = new Set<string>();

  for (const tier of TIER_ORDER) {
    if (!options.tiers.includes(tier)) continue;
    const terms = termsForTier(niche, tier).slice(0, options.maxTermsPerTier);

    for (const zone of zones) {
      for (const term of terms) {
        const trimmedTerm = term.trim();
        const trimmedZone = zone.label.trim();
        if (!trimmedTerm || !trimmedZone) continue;

        const query = `${trimmedTerm} ${trimmedZone}`;
        const key = queryKey(query);
        if (seen.has(key)) continue;
        seen.add(key);

        planned.push({
          tier,
          term: trimmedTerm,
          zone: trimmedZone,
          query,
          key,
          rationale: TIER_RATIONALE[tier],
        });
        if (planned.length >= options.maxQueries) return planned;
      }
    }
  }

  return planned;
}

/** Le plan que cette campagne produirait, options lues dans sa configuration. */
export function planFromConfig(
  niche: NicheConfig,
  geography: GeographyConfig,
  config: CommercialDiscoveryConfig,
): CommercialQuery[] {
  return buildCommercialQueryPlan(niche, zonesFromGeography(geography), {
    tiers: config.tiers,
    maxTermsPerTier: config.maxTermsPerTier,
    maxQueries: config.maxQueries,
  });
}
