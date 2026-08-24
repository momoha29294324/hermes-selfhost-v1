import { stripAccents } from '@/lib/identity/normalize';
import type { AdjacentActivityFamily, NicheConfig } from '@/lib/config/schema';

/**
 * R7.7 §6 — « le atelier est-il le MÉTIER, ou une ligne de service ? »
 *
 * ---------------------------------------------------------------------------
 * Le défaut, nommé sur des cas réels
 * ---------------------------------------------------------------------------
 * `classify.ts` répond `in_niche` dès qu'un terme positif apparaît quelque part
 * et qu'aucun terme négatif ne le contredit. Tout le texte du site est versé
 * dans un seul sac, et un seul mot suffit :
 *
 *   demo-07.example.com  un CENTRE DE FORMATION. Ses titres disent
 *                               « Apprenez le atelier », « Nos formations »,
 *                               « Diplôme ». Il ne lave aucune voiture pour un
 *                               client — et le crawler lui a pourtant extrait
 *                               « vente de produits, lustrage, boutique en ligne », parce que
 *                               c'est le programme qu'il ENSEIGNE ;
 *   demo-25-exemple.fr          reprogrammation moteur, échappement, châssis ;
 *   db-performance.fr           « Centre de reprogrammation », poids lourds,
 *                               engins agricoles, jet-ski ;
 *   demo-67-exemple.fr                  concessionnaire de véhicules d'occasion, dont
 *                               la description annonce « Dépôt-vente, atelier,
 *                               révision ».
 *
 * Les quatre sont sortis `in_niche` ou `adjacent` avec un fit suffisant pour
 * rester dans la file, et les quatre ont été jugés NOT_TARGET par l'humain.
 *
 * ---------------------------------------------------------------------------
 * Ce qui les sépare : le CADRE, pas le vocabulaire
 * ---------------------------------------------------------------------------
 * La liste de prestations extraite par mot-clé ne dit pas ce qu'une entreprise
 * FAIT : elle dit quel vocabulaire est apparu. Sur un site de formation, ce
 * vocabulaire est celui du programme ; sur un site de concessionnaire, celui
 * d'un service annexe.
 *
 * Ce qu'une entreprise déclare ÊTRE vit ailleurs, dans ce qu'on appelle ici le
 * CADRE : le titre de ses pages, leur description, leurs titres de section.
 * C'est l'endroit qu'un dirigeant écrit pour se présenter, et c'est le seul du
 * corpus où « Apprenez le atelier » se distingue de « Nous lavons votre
 * voiture ». Ce module ne lit donc QUE le cadre, et refuse explicitement la
 * liste de prestations comme preuve d'activité.
 *
 * `site_identity_declarations` est écarté du cadre pour la même raison, et le
 * cas mérite d'être dit : ce champ contient une phrase produite par NOTRE
 * crawler — « vocabulaire du métier présent (atelier, …) ». La lire comme une
 * déclaration du site ferait raisonner le moteur sur sa propre conclusion.
 *
 * ---------------------------------------------------------------------------
 * Quatre états, dont un qui existe pour ne rejeter personne à tort
 * ---------------------------------------------------------------------------
 *   CORE_ACTIVITY        le cadre déclare le métier, et rien d'adjacent ;
 *   ADJACENT_WITH_CORE   le cadre déclare le métier ET une activité voisine.
 *                        Une entreprise a le droit d'avoir deux métiers, et le
 *                        §6 de la mission l'exige : « ne rejette pas naïvement
 *                        un vrai artisan parce qu'il propose aussi autre
 *                        chose ». Cet état QUALIFIE, il n'exclut pas ;
 *   ADJACENT_ONLY        le cadre ne déclare QUE des activités voisines ;
 *   UNPROVEN             le cadre a été lu et ne déclare rien de reconnaissable.
 *                        Quelqu'un a regardé sans pouvoir conclure : une preuve
 *                        partielle, pas une absence de preuve ;
 *   UNKNOWN              aucun cadre lu. `null` en aval — le poids quitte le
 *                        dénominateur, personne ne perd de point.
 *
 * La distinction UNPROVEN / UNKNOWN est celle que R7.3B §8 a déjà tranchée pour
 * l'identité légale, mot pour mot et pour la même raison : sans elle, l'ABSENCE
 * DE CONTRE-PREUVE rend le même verdict que la PREUVE, et un prospect dont
 * personne n'a établi le métier obtient la note de celui dont le métier est
 * démontré. C'est la mécanique du fit à 100, et elle est ici traitée à sa
 * seconde source.
 *
 * ---------------------------------------------------------------------------
 * Aucun correctif par nom ni par domaine
 * ---------------------------------------------------------------------------
 * Le vocabulaire vit intégralement dans `config/niches/`, par FAMILLE
 * d'activité voisine — formation, performance, transport de personnes,
 * location, garage, vente, prestation industriel, produits, réseau. Une famille est
 * une catégorie de métier, jamais une entreprise. Aucune règle de ce fichier ne
 * nomme un prospect, un domaine ou une marque, et aucune ne le peut : le module
 * ne reçoit pas le nom du prospect.
 */

export type CoreActivityVerdict =
  | 'CORE_ACTIVITY'
  | 'ADJACENT_WITH_CORE'
  | 'ADJACENT_ONLY'
  | 'UNPROVEN'
  | 'UNKNOWN';

export interface CoreActivityEvidenceLike {
  readonly field: string;
  readonly value_text: string | null;
  readonly value_json: unknown;
}

export interface CoreActivityHit {
  /** `core` ou la clé de la famille adjacente. */
  readonly key: string;
  readonly phrase: string;
  readonly field: string;
}

export interface CoreActivityAssessment {
  readonly verdict: CoreActivityVerdict;
  readonly reason: string;
  /** Termes de métier distincts trouvés dans le cadre. */
  readonly coreTerms: readonly string[];
  /** Familles voisines distinctes trouvées dans le cadre. */
  readonly adjacentFamilies: readonly string[];
  readonly hits: readonly CoreActivityHit[];
  /** Le cadre a-t-il été lu du tout ? */
  readonly frameRead: boolean;
}

/**
 * Les champs qui portent ce qu'une entreprise déclare ÊTRE.
 *
 * `services` et `premium_services` en sont volontairement absents : ce sont des
 * extractions par mot-clé, et c'est exactement par elles que le centre de
 * formation ressemblait à un atelier.
 */
const FRAME_FIELDS: readonly string[] = [
  'website_title',
  'website_description',
  'website_headings',
  'osm_category',
];

/**
 * Le CADRE se lit à deux niveaux, et le second n'a pas la valeur du premier.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi le titre a le dernier mot
 * ---------------------------------------------------------------------------
 * Le `<title>` d'une page est la phrase la plus délibérée d'un site : c'est
 * celle qui s'affiche dans un onglet, dans un résultat de recherche, dans un
 * partage. Un dirigeant y met ce qu'il EST. Les descriptions et les titres de
 * section, eux, décrivent aussi ce qu'il PROPOSE — et une ligne de service y
 * apparaît au même rang qu'un métier.
 *
 * La distinction n'est pas théorique, elle est ce qui sépare quatre cas réels
 * de leurs homonymes :
 *
 *   « Apprendre le atelier Auto »                    formation
 *   « Demo Romeo | Entretien, Réparation »      performance
 *   « DB Performance - Centre de reprogrammation »     performance
 *   « DEMONOVEMBER LYON EST - Véhicules neufs et occasion » vente
 *
 * Aucun de ces titres ne nomme le métier ; tous les quatre en emploient le
 * vocabulaire plus bas, dans un programme de cours ou une liste de services
 * annexes. Face à eux :
 *
 *   « Centre prestation premium à Lyon — Atelier »
 *   « Prestation standard Voiture Lyon à partir de 55 € »
 *
 * Un titre qui nomme une activité voisine SANS nommer le métier est donc lu
 * comme le cadre réel de l'entreprise, et le vocabulaire trouvé plus bas ne
 * suffit plus à rétablir un métier que la vitrine ne revendique pas.
 *
 * La règle ne s'applique JAMAIS à un titre muet — une marque seule, « Sublim
 * Car 74 », ne dit rien et ne doit rien décider. Dans ce cas le corps du cadre
 * garde la parole, et la lecture non rejetante l'emporte. C'est la garantie du
 * §6 : « ne rejette pas naïvement un vrai artisan parce qu'il propose aussi
 * autre chose ».
 */
const HEADLINE_FIELDS: readonly string[] = ['website_title', 'osm_category'];

function normalize(raw: string): string {
  const flattened = stripAccents(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return flattened.length === 0 ? '' : ` ${flattened} `;
}

function readable(row: CoreActivityEvidenceLike): string {
  const text = row.value_text ?? '';
  if (row.value_json === null || row.value_json === undefined) return text;
  if (Array.isArray(row.value_json)) {
    return [text, ...row.value_json.filter((item): item is string => typeof item === 'string')].join(' ');
  }
  if (typeof row.value_json === 'string') return `${text} ${row.value_json}`;
  return text;
}

/** Le terme est-il présent, sur des frontières de mots ? */
function contains(haystack: string, phrase: string): boolean {
  const needle = normalize(phrase);
  return needle.length > 2 && haystack.includes(needle);
}

export interface CoreActivityInput {
  readonly evidence: readonly CoreActivityEvidenceLike[];
  readonly niche: NicheConfig;
}

export function assessCoreActivity(input: CoreActivityInput): CoreActivityAssessment {
  const { evidence, niche } = input;
  const families: readonly AdjacentActivityFamily[] = niche.adjacentActivityFamilies;
  const coreVocabulary = niche.coreActivityTerms.length > 0 ? niche.coreActivityTerms : niche.positiveTerms;

  const hits: CoreActivityHit[] = [];
  const coreTerms = new Set<string>();
  const adjacentFamilies = new Set<string>();
  let frameRead = false;
  let headlineCore = 0;
  let headlineAdjacent = 0;

  for (const row of evidence) {
    if (!FRAME_FIELDS.includes(row.field)) continue;
    const raw = readable(row);
    if (raw.trim().length === 0) continue;
    const text = normalize(raw);
    if (text.trim().length === 0) continue;
    frameRead = true;

    /**
     * Les contextes neutralisants sont RETIRÉS avant toute recherche, et l'ordre
     * compte : « formation atelier » doit fermer la porte au « atelier » qui
     * s'y trouve, sans quoi tout site de formation serait aussi un site de
     * métier. Une famille adjacente déclare donc ses propres phrases COMPLÈTES,
     * et elles sont cherchées avant d'être ôtées du texte.
     */
    let residual = text;
    for (const family of families) {
      for (const phrase of family.phrases) {
        if (!contains(residual, phrase)) continue;
        adjacentFamilies.add(family.key);
        hits.push({ key: family.key, phrase, field: row.field });
        if (HEADLINE_FIELDS.includes(row.field)) headlineAdjacent += 1;
        residual = residual.split(normalize(phrase).trim()).join(' ');
      }
    }

    for (const term of coreVocabulary) {
      if (!contains(residual, term)) continue;
      coreTerms.add(term);
      hits.push({ key: 'core', phrase: term, field: row.field });
      if (HEADLINE_FIELDS.includes(row.field)) headlineCore += 1;
    }
  }

  const core = coreTerms.size;
  const adjacent = adjacentFamilies.size;
  const familyList = [...adjacentFamilies].sort();

  if (!frameRead) {
    return {
      verdict: 'UNKNOWN',
      reason: 'aucune page de présentation lue — l’activité déclarée reste inconnue',
      coreTerms: [],
      adjacentFamilies: [],
      hits: [],
      frameRead: false,
    };
  }

  if (core > 0 && adjacent === 0) {
    return {
      verdict: 'CORE_ACTIVITY',
      reason: `activité déclarée dans les titres et descriptions du site (${[...coreTerms].slice(0, 4).join(', ')})`,
      coreTerms: [...coreTerms],
      adjacentFamilies: [],
      hits,
      frameRead: true,
    };
  }

  if (core > 0 && headlineCore === 0 && headlineAdjacent > 0) {
    return {
      verdict: 'ADJACENT_ONLY',
      reason:
        `la vitrine du site ne nomme qu’une activité voisine (${familyList.join(', ')}) ; ` +
        `le vocabulaire du métier (${[...coreTerms].slice(0, 3).join(', ')}) n’apparaît que plus bas, ` +
        'là où vivent aussi un programme de cours et une liste de services annexes',
      coreTerms: [...coreTerms],
      adjacentFamilies: familyList,
      hits,
      frameRead: true,
    };
  }

  if (core > 0) {
    return {
      verdict: 'ADJACENT_WITH_CORE',
      reason:
        `activité déclarée (${[...coreTerms].slice(0, 3).join(', ')}) aux côtés de ` +
        `${familyList.length} activité(s) voisine(s) : ${familyList.join(', ')}`,
      coreTerms: [...coreTerms],
      adjacentFamilies: familyList,
      hits,
      frameRead: true,
    };
  }

  if (adjacent > 0) {
    return {
      verdict: 'ADJACENT_ONLY',
      reason:
        `le site ne se présente que par une activité voisine : ${familyList.join(', ')} — ` +
        'aucun terme du métier dans ses titres, descriptions ou sections',
      coreTerms: [],
      adjacentFamilies: familyList,
      hits,
      frameRead: true,
    };
  }

  return {
    verdict: 'UNPROVEN',
    reason:
      'pages de présentation lues, mais elles ne déclarent ni le métier ni une activité voisine — ' +
      'quelqu’un a regardé sans pouvoir conclure',
    coreTerms: [],
    adjacentFamilies: [],
    hits,
    frameRead: true,
  };
}
