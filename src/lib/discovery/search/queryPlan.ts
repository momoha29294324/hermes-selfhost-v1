import { normalizeName } from '@/lib/identity/normalize';
import type { NicheConfig } from '@/lib/config/schema';

/**
 * Combien de requêtes ce prospect mérite, et dans quel ordre.
 *
 * Une requête coûte 0,005 $ et le corpus en compte 53 : le budget total du
 * benchmark tient dans une pièce de monnaie, mais la question de fond n'est pas
 * le montant. C'est qu'une recherche mal posée renvoie un annuaire, et qu'un
 * rail qui pose quatre variantes à chaque prospect paie quatre fois pour
 * apprendre la même chose.
 *
 * D'où l'escalade : les variantes sont **ordonnées par pouvoir discriminant
 * décroissant**, et le rail s'arrête dès qu'il tient un candidat plausible.
 *
 *   1. `"Enseigne" ville`            — la requête qu'un client taperait.
 *   2. `"Enseigne" <métier> ville`   — désambiguïse un nom porté ailleurs.
 *   3. `"Enseigne" <adresse>`        — l'adresse est presque unique.
 *   4. `"Raison sociale" ville`      — le nom du registre, souvent absent du web.
 *
 * Deux décisions à défendre.
 *
 * **Le nom est mis entre guillemets.** Sans eux, Brave élargit et remonte des
 * pages qui ne contiennent aucun des mots ensemble — donc des annuaires, qui
 * contiennent tout. Les guillemets sont un opérateur documenté de l'API, pas un
 * contournement.
 *
 * **Le vocabulaire du métier vient de la configuration, jamais du code.** La
 * variante 2 lit `niche.searchQueries[0]`. Écrire « atelier » ici rendrait ce
 * fichier faux pour la niche suivante, et c'est une règle du dépôt.
 *
 * Un nom trop court ou trop générique ne produit aucune variante : chercher
 * `"Auto" Lyon` ramène la ville entière, et le vérificateur R3 passerait son
 * temps à rejeter des homonymes que nous aurions payés pour recevoir.
 */

export type QueryVariant = 'name_city' | 'name_niche_city' | 'name_address' | 'legal_name_city';

export interface PlannedQuery {
  variant: QueryVariant;
  query: string;
  /**
   * Pourquoi cette variante existe. Recopié dans le registre d'usage : une
   * requête dont on ne sait plus ce qu'elle cherchait n'est pas mesurable.
   */
  rationale: string;
}

/**
 * Le département n'y figure pas, volontairement.
 *
 * Il est disponible sur chaque prospect, et l'ajouter paraîtrait gratuit. Mais
 * une entreprise n'écrit jamais « Rhône » sur son site : elle écrit sa ville.
 * Ajouter le département à une requête déjà porteuse de la ville n'augmente donc
 * pas la précision — il ajoute un mot que les pages cibles ne contiennent pas,
 * ce qui écarte le bon résultat au profit des annuaires, seuls à indexer par
 * département.
 */
export interface QueryPlanInput {
  displayName: string;
  brandName?: string | null;
  legalName?: string | null;
  city?: string | null;
  addressLine?: string | null;
}

/**
 * Longueur minimale d'un nom pour valoir une requête.
 *
 * Aligné sur `nameIsDistinctive` du vérificateur R3 : un nom que le verifier
 * refusera de trancher seul n'a pas besoin d'être payé chez Brave d'abord.
 */
export const QUERY_NAME_MIN_LENGTH = 5;

/** Le nom que le public utiliserait : l'enseigne d'abord, le nom affiché sinon. */
export function publicName(input: QueryPlanInput): string {
  const brand = (input.brandName ?? '').trim();
  return brand.length > 0 ? brand : input.displayName.trim();
}

export function nameWorthSearching(name: string): boolean {
  const normalized = normalizeName(name).replace(/\s/g, '');
  if (normalized.length < QUERY_NAME_MIN_LENGTH) return false;
  if (/^\d+$/.test(normalized)) return false;
  return true;
}

/**
 * Découpe l'adresse pour n'en garder que la rue.
 *
 * Une adresse complète recopiée dans une requête contient déjà la ville et le
 * code postal, ce qui allonge la requête sans rien ajouter. La rue seule est la
 * partie discriminante.
 */
export function streetPart(addressLine: string | null | undefined, postalCode?: string | null): string | null {
  const raw = (addressLine ?? '').trim();
  if (raw.length < 5) return null;
  const cut = raw.split(/\s*(?:,|\n)\s*/)[0] ?? raw;
  const withoutPostal = postalCode ? cut.replace(postalCode, '').trim() : cut;
  return withoutPostal.length >= 5 ? withoutPostal : null;
}

/**
 * Construit le plan, ordonné, sans doublon.
 *
 * Ne lance rien : rendre le plan pur permet de tester l'escalade sans réseau, et
 * de compter à l'avance ce qu'un run coûterait au pire.
 */
export function buildQueryPlan(
  input: QueryPlanInput,
  niche: NicheConfig,
  options: { maxQueries?: number; postalCode?: string | null } = {},
): PlannedQuery[] {
  const max = options.maxQueries ?? 3;
  const name = publicName(input);
  if (!nameWorthSearching(name)) return [];

  const city = (input.city ?? '').trim();
  const quoted = `"${name}"`;
  const nicheTerm = (niche.searchQueries[0] ?? '').trim();
  const street = streetPart(input.addressLine, options.postalCode);
  const legalName = (input.legalName ?? '').trim();

  const planned: PlannedQuery[] = [];
  const push = (variant: QueryVariant, parts: (string | null)[], rationale: string): void => {
    const query = parts.filter((part): part is string => Boolean(part && part.length > 0)).join(' ').trim();
    if (!query || planned.some((item) => item.query.toLowerCase() === query.toLowerCase())) return;
    planned.push({ variant, query, rationale });
  };

  push('name_city', [quoted, city || null], 'la requête qu’un client taperait');

  if (nicheTerm) {
    push(
      'name_niche_city',
      [quoted, nicheTerm, city || null],
      'ajoute le métier pour écarter un homonyme d’un autre secteur',
    );
  }

  if (street) {
    push('name_address', [quoted, street, city || null], 'l’adresse est presque unique');
  }

  /**
   * La raison sociale ne vaut une requête que si elle diffère réellement de
   * l'enseigne. « SARL DUPONT ATELIER » face à « Dupont Atelier » est la
   * même chaîne aux yeux d'un moteur, et la variante ne ferait que repayer la
   * première.
   */
  if (legalName && normalizeName(legalName) !== normalizeName(name) && nameWorthSearching(legalName)) {
    push('legal_name_city', [`"${legalName}"`, city || null], 'le nom du registre, parfois seul présent en ligne');
  }

  return planned.slice(0, max);
}

/**
 * L'escalade doit-elle s'arrêter ?
 *
 * Le critère est délibérément modeste : un candidat de site propre suffit à
 * arrêter les requêtes, même s'il finira rejeté par le vérificateur. La raison
 * est économique — vérifier un candidat ne coûte qu'un DNS et un GET, tous deux
 * gratuits, là où la requête suivante coûte de l'argent. Poser une question de
 * plus alors qu'on a déjà de quoi travailler serait payer pour une redondance.
 *
 * Un profil social seul n'arrête pas l'escalade : il ne donne ni funnel ni
 * mentions légales, et la variante suivante peut encore produire le site.
 */
export function shouldStopEscalating(found: { websiteCandidates: number; socialCandidates: number }): boolean {
  return found.websiteCandidates >= 1;
}
