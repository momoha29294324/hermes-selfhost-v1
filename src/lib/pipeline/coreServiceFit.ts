import { stripAccents } from '@/lib/identity/normalize';
import type { NicheConfig, ServiceSpecialistFamily } from '@/lib/config/schema';

/**
 * HERMES-TARGETING-R1 §9-§13 — « le prestation standard est-il le métier, ou la
 * protection ? »
 *
 * ---------------------------------------------------------------------------
 * La question que `coreActivity` ne pose pas
 * ---------------------------------------------------------------------------
 * `coreActivity.ts` répond déjà à « cette entreprise fait-elle ce métier, ou un
 * métier VOISIN ? » — formation, mécanique, VTC, concession. Elle le fait bien,
 * et rien ici ne la remplace.
 *
 * Mais un centre de pose de film REVENTE n'est voisin de rien : il est DANS
 * l'prestation premium, il emploie exactement notre vocabulaire — boutique en ligne,
 * vente de produits, protection — et `coreActivity` le range donc en `CORE_ACTIVITY`,
 * ce qui est vrai. Deux prospects réels sont passés par là :
 *
 *   un site dont tous les titres disent « Protection Boutique en ligne Autos » et
 *   « Traitement Boutique en ligne voiture », sans un seul mot de prestation ;
 *
 *   un autre dont la vitrine annonce « Entreprise spécialisée dans le
 *   Traitement Boutique en ligne », et dont les pages parlent de REVENTE, de XPEL et de
 *   films de vitrage — le mot « atelier » n'y apparaissant guère qu'au fil de
 *   sa propre enseigne.
 *
 * Les deux ont été contactés. Les deux sont hors de la cible : ce que nous
 * savons faire s'adresse à un artisan du prestation standard qui veut plus de demandes,
 * pas à un atelier de protection premium dont le panier, le cycle de vente et
 * la clientèle sont autres.
 *
 * ---------------------------------------------------------------------------
 * Ce que ce module ne fait PAS
 * ---------------------------------------------------------------------------
 * Il n'exclut pas la boutique en ligne, ni le vente de produits, ni la protection. §9 est
 * explicite : un prestataire a le droit d'en proposer, et ces prestations « ne
 * doivent pas forcément définir son business principal ». Ce qui est mesuré
 * n'est donc pas la PRÉSENCE du vocabulaire de protection, c'est sa
 * DOMINANCE — et la vitrine (`<title>`) pèse deux fois le corps, pour la raison
 * déjà établie par `coreActivity` : le titre est la phrase la plus délibérée
 * d'un site.
 *
 * Aucune règle ne nomme un prospect, un compte, un domaine ou une marque. Le
 * module ne reçoit ni le nom du prospect ni son handle, et ne pourrait donc pas
 * en tenir compte même par accident. Tout le vocabulaire vit dans
 * `config/niches/`, par FAMILLE de spécialité.
 */

export type CoreServiceFitVerdict =
  /** Le prestation standard/atelier classique est ce que l'entreprise met en avant. */
  | 'CORE_FIT'
  /** Les deux cohabitent sans qu'aucun ne domine. Un doute, pas un refus. */
  | 'MIXED'
  /** La vitrine est celle d'un spécialiste de la protection, du film ou du revente. */
  | 'SPECIALIST_OUT_OF_SCOPE'
  /** Le cadre n'a pas été lu, ou n'en dit rien de reconnaissable. */
  | 'UNKNOWN';

export interface CoreServiceFitEvidenceLike {
  readonly field: string;
  readonly value_text: string | null;
  readonly value_json: unknown;
}

export interface CoreServiceFitHit {
  /** `in_scope` ou la clé de la famille de spécialité. */
  readonly key: string;
  readonly phrase: string;
  readonly field: string;
  /** Trouvé dans la vitrine (`<title>`, catégorie) plutôt que dans le corps ? */
  readonly headline: boolean;
}

export interface CoreServiceFitAssessment {
  readonly verdict: CoreServiceFitVerdict;
  readonly reason: string;
  /** Termes de prestation standard/atelier classique distincts trouvés dans le cadre. */
  readonly inScopeTerms: readonly string[];
  /** Familles de spécialité distinctes trouvées dans le cadre. */
  readonly specialistFamilies: readonly string[];
  readonly hits: readonly CoreServiceFitHit[];
  readonly frameRead: boolean;
  /** Le poids retenu de chaque côté — publié pour qu'un refus se relise. */
  readonly inScopeWeight: number;
  readonly specialistWeight: number;
}

/**
 * Les mêmes champs de CADRE que `coreActivity`, et pour la même raison :
 * `services` et `premium_services` sont des extractions par mot-clé, donc du
 * vocabulaire présent, jamais une déclaration d'activité. Les lire ici ferait
 * d'un prestataire qui propose la boutique en ligne un spécialiste de la boutique en ligne — soit
 * exactement l'erreur inverse de celle qu'on corrige.
 */
const FRAME_FIELDS: readonly string[] = [
  'website_title',
  'website_description',
  'website_headings',
  'osm_category',
  'instagram_category',
];

/** La vitrine. Ce qu'un dirigeant écrit pour dire ce qu'il EST. */
const HEADLINE_FIELDS: readonly string[] = ['website_title', 'osm_category', 'instagram_category'];

const HEADLINE_WEIGHT = 2;
const BODY_WEIGHT = 1;

/**
 * À partir de combien de familles de spécialité une vitrine mixte bascule.
 *
 * Deux, et pas une : proposer la boutique en ligne À CÔTÉ du prestation standard est le cas
 * normal d'un bon prospect (§9), et une seule famille ne prouve donc rien.
 * Empiler REVENTE + boutique en ligne, ou revente + vitrage, décrit autre chose — un
 * atelier dont l'offre EST la protection, quel que soit le mot de prestation standard
 * qu'il garde dans son enseigne.
 */
const SPECIALIST_FAMILY_DOMINANCE = 2;

function normalize(raw: string): string {
  const flattened = stripAccents(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return flattened.length === 0 ? '' : ` ${flattened} `;
}

function readable(row: CoreServiceFitEvidenceLike): string {
  const text = row.value_text ?? '';
  if (row.value_json === null || row.value_json === undefined) return text;
  if (Array.isArray(row.value_json)) {
    return [text, ...row.value_json.filter((item): item is string => typeof item === 'string')].join(' ');
  }
  if (typeof row.value_json === 'string') return `${text} ${row.value_json}`;
  return text;
}

function contains(haystack: string, phrase: string): boolean {
  const needle = normalize(phrase);
  return needle.length > 2 && haystack.includes(needle);
}

export interface CoreServiceFitInput {
  readonly evidence: readonly CoreServiceFitEvidenceLike[];
  readonly niche: NicheConfig;
}

/**
 * Le poids d'un côté, compté par PHRASE DISTINCTE et jamais par occurrence.
 *
 * Un crawler qui a lu six pages a écrit six lignes `website_title`, et compter
 * les occurrences ferait donc du nombre de pages une mesure d'activité. Une
 * phrase vue à la fois en vitrine et dans le corps compte une fois, au poids de
 * la vitrine.
 */
function weigh(levels: ReadonlyMap<string, boolean>): number {
  let total = 0;
  for (const headline of levels.values()) total += headline ? HEADLINE_WEIGHT : BODY_WEIGHT;
  return total;
}

export function assessCoreServiceFit(input: CoreServiceFitInput): CoreServiceFitAssessment {
  const { evidence, niche } = input;
  const fit = niche.coreServiceFit;
  const families: readonly ServiceSpecialistFamily[] = fit.specialistFamilies;

  const empty = (verdict: CoreServiceFitVerdict, reason: string, frameRead: boolean): CoreServiceFitAssessment =>
    Object.freeze({
      verdict,
      reason,
      inScopeTerms: Object.freeze([]),
      specialistFamilies: Object.freeze([]),
      hits: Object.freeze([]),
      frameRead,
      inScopeWeight: 0,
      specialistWeight: 0,
    });

  // Une niche qui n'a pas déclaré ce vocabulaire ne rend pas `CORE_FIT` par
  // défaut : elle rend `UNKNOWN`, qui n'autorise aucun envoi automatique (§13).
  // Un défaut permissif ferait qu'ajouter une niche ouvrirait silencieusement
  // l'envoi sur elle.
  if (fit.inScopeTerms.length === 0 || families.length === 0) {
    return empty(
      'UNKNOWN',
      `la niche « ${niche.key} » ne déclare pas de vocabulaire coreServiceFit — rien n’est mesuré, donc rien n’est conclu`,
      false,
    );
  }

  const hits: CoreServiceFitHit[] = [];
  /** phrase → vue en vitrine ? */
  const inScope = new Map<string, boolean>();
  /** famille → vue en vitrine ? */
  const specialist = new Map<string, boolean>();
  let frameRead = false;
  let headlineRead = false;

  for (const row of evidence) {
    if (!FRAME_FIELDS.includes(row.field)) continue;
    const raw = readable(row);
    if (raw.trim().length === 0) continue;
    const text = normalize(raw);
    if (text.trim().length === 0) continue;
    frameRead = true;
    const headline = HEADLINE_FIELDS.includes(row.field);
    if (headline) headlineRead = true;

    // Les phrases de spécialité sont cherchées PUIS retirées, exactement comme
    // `coreActivity` retire les familles voisines : « protection boutique en ligne »
    // contient « boutique en ligne », et le laisser en place ferait compter deux fois
    // la même déclaration. Le prestation standard est cherché sur le résidu.
    let residual = text;
    for (const family of families) {
      for (const phrase of family.phrases) {
        if (!contains(residual, phrase)) continue;
        specialist.set(family.key, (specialist.get(family.key) ?? false) || headline);
        hits.push({ key: family.key, phrase, field: row.field, headline });
        residual = residual.split(normalize(phrase).trim()).join(' ');
      }
    }

    for (const term of fit.inScopeTerms) {
      if (!contains(residual, term)) continue;
      inScope.set(term, (inScope.get(term) ?? false) || headline);
      hits.push({ key: 'in_scope', phrase: term, field: row.field, headline });
    }
  }

  const inScopeTerms = [...inScope.keys()].sort();
  const specialistFamilies = [...specialist.keys()].sort();
  const inScopeWeight = weigh(inScope);
  const specialistWeight = weigh(specialist);
  const headlineInScope = [...inScope.values()].filter(Boolean).length;

  const decided = (verdict: CoreServiceFitVerdict, reason: string): CoreServiceFitAssessment =>
    Object.freeze({
      verdict,
      reason,
      inScopeTerms: Object.freeze(inScopeTerms),
      specialistFamilies: Object.freeze(specialistFamilies),
      hits: Object.freeze(hits),
      frameRead,
      inScopeWeight,
      specialistWeight,
    });

  if (!frameRead) {
    return empty('UNKNOWN', 'aucune page de présentation lue — la prestation principale reste inconnue', false);
  }

  if (inScope.size === 0 && specialist.size === 0) {
    return decided(
      'UNKNOWN',
      'cadre lu, mais il ne déclare ni prestation de prestation standard ni spécialité de protection — ' +
        'quelqu’un a regardé sans pouvoir conclure',
    );
  }

  if (specialist.size === 0) {
    return decided(
      'CORE_FIT',
      `la vitrine ne déclare que du prestation standard / atelier classique (${inScopeTerms.slice(0, 4).join(', ')})`,
    );
  }

  if (inScope.size === 0) {
    return decided(
      'SPECIALIST_OUT_OF_SCOPE',
      `le cadre ne déclare que de la protection spécialisée (${specialistFamilies.join(', ')}) — ` +
        'aucun terme de prestation standard ou de atelier classique dans ses titres, descriptions ou sections',
    );
  }

  // Les deux sont là. C'est ici que se joue toute la différence entre « un
  // prestataire qui propose aussi la boutique en ligne » et « un centre de protection qui
  // a gardé le mot atelier dans son enseigne ».
  if (headlineRead && headlineInScope === 0) {
    return decided(
      'SPECIALIST_OUT_OF_SCOPE',
      `la vitrine ne nomme qu’une spécialité de protection (${specialistFamilies.join(', ')}) ; ` +
        `le vocabulaire du prestation standard (${inScopeTerms.slice(0, 3).join(', ')}) n’apparaît que plus bas`,
    );
  }

  if (specialistFamilies.length >= SPECIALIST_FAMILY_DOMINANCE && specialistWeight > inScopeWeight) {
    return decided(
      'SPECIALIST_OUT_OF_SCOPE',
      `${String(specialistFamilies.length)} spécialités de protection déclarées ` +
        `(${specialistFamilies.join(', ')}), d’un poids ${String(specialistWeight)} contre ` +
        `${String(inScopeWeight)} pour le prestation standard — l’offre EST la protection`,
    );
  }

  if (headlineInScope > 0 && inScopeWeight >= specialistWeight) {
    return decided(
      'CORE_FIT',
      `la vitrine déclare le prestation standard (${inScopeTerms.slice(0, 3).join(', ')}) et ` +
        `${specialistFamilies.join(', ')} n’y figure qu’en prestation secondaire`,
    );
  }

  return decided(
    'MIXED',
    `prestation standard (poids ${String(inScopeWeight)}) et protection spécialisée (poids ${String(specialistWeight)}, ` +
      `${specialistFamilies.join(', ')}) cohabitent sans qu’aucun ne domine — rien n’est tranché`,
  );
}

/**
 * Le verdict autorise-t-il un envoi AUTOMATIQUE ?
 *
 * Écrit comme une égalité stricte à l'unique valeur positive, comme
 * `isAutoSendEligible` : une cinquième valeur ajoutée un jour serait
 * non-envoyante par défaut. `MIXED` et `UNKNOWN` sont des doutes, et §13 dit ce
 * qu'un doute vaut en mode autonome — pas un envoi.
 */
export function serviceFitAllowsAutoSend(verdict: CoreServiceFitVerdict): boolean {
  return verdict === 'CORE_FIT';
}
