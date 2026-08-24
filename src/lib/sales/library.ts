/**
 * HERMES-SALES-KNOWLEDGE-R1 §10, §20, §37 — le CHARGEMENT de la bibliothèque,
 * et son extinction propre quand elle n'est pas là.
 *
 * ---------------------------------------------------------------------------
 * §20 — fail-closed veut dire « comme avant », pas « en panne »
 * ---------------------------------------------------------------------------
 * Une bibliothèque de vente est un CONFORT. Le Conversation Brain a écrit des
 * brouillons pendant des mois sans elle, sous des gardes qui ne la connaissent
 * pas, et il doit continuer à le faire si elle disparaît. C'est la différence
 * entre une dépendance et un apport : un apport qui casse ce qu'il devait
 * améliorer n'a rien apporté.
 *
 * Concrètement, `loadSalesKnowledge` ne lève JAMAIS. Fichier absent, JSON
 * illisible, schéma invalide, principe malformé : le résultat est une
 * bibliothèque VIDE portant la raison. Le cerveau n'ajoute alors aucune ligne à
 * son prompt — pas une ligne blanche — et produit exactement ce qu'il produisait
 * avant cette mission.
 *
 * Cette indulgence a une contrepartie, sans laquelle elle serait dangereuse :
 * un test charge le corpus réel et EXIGE qu'il soit valide. Un fichier cassé ne
 * fait donc pas tomber la production, mais il fait tomber `npm run validate`.
 * L'erreur est vue par un développeur, pas par un prospect.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi le JSON est la source de vérité, et pas un module TypeScript
 * ---------------------------------------------------------------------------
 * Un corpus de quarante-trois principes écrit en TypeScript serait plus rapide
 * à charger et se typerait tout seul. Il serait aussi indistinguable du CODE,
 * et c'est exactement ce qu'on ne veut pas : ces principes sont des DONNÉES
 * empruntées à quelqu'un d'extérieur, versionnées à côté de l'artefact qui les
 * justifie, relisibles par quelqu'un qui n'écrit pas de TypeScript. Les mettre
 * dans `src/` ferait croire qu'ils ont l'autorité du reste de `src/`.
 *
 * La lecture est faite UNE fois et mémorisée. Le corpus ne change pas pendant
 * qu'un processus tourne.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  SALES_KNOWLEDGE_VERSION,
  injectablePrinciple,
  salesPrincipleFileSchema,
  salesSourceSchema,
  type SalesPrinciple,
  type SalesSource,
} from '@/lib/sales/schema';

export const SALES_KNOWLEDGE_ROOT = resolve(process.cwd(), 'knowledge', 'sales');

/**
 * Pourquoi la bibliothèque est vide, quand elle l'est.
 *
 * `null` = elle ne l'est pas. Les autres valeurs sont des CONSTATS, jamais des
 * erreurs à traiter : chacune décrit une installation où le cerveau doit
 * continuer à fonctionner sans rien dire de particulier.
 */
export type SalesLibraryGap =
  /** Le répertoire `knowledge/sales` n'existe pas. */
  | 'LIBRARY_ABSENT'
  /** Il existe, et ne contient aucune source lisible. */
  | 'NO_SOURCE'
  /** Une source existe, mais aucun principe n'a pu être lu. */
  | 'NO_PRINCIPLE'
  /** Un fichier est illisible, hors schéma, ou porte un identifiant en double. */
  | 'INVALID_CONTENT';

export interface SalesLibrary {
  readonly version: string;
  readonly sources: readonly SalesSource[];
  readonly principles: readonly SalesPrinciple[];
  /**
   * Les seuls principes qui peuvent atteindre un prompt.
   *
   * Calculés ICI, une fois, plutôt qu'à chaque tour : un filtre appliqué au
   * chargement ne peut pas être oublié par un appelant, là où un filtre appliqué
   * à la récupération peut l'être par le prochain chemin de lecture qu'on
   * écrira.
   */
  readonly injectable: readonly SalesPrinciple[];
  readonly gap: SalesLibraryGap | null;
  /** Le détail du défaut, pour un journal. Jamais rendu à un modèle. */
  readonly gapDetail: string | null;
}

function emptyLibrary(gap: SalesLibraryGap, detail: string): SalesLibrary {
  return Object.freeze({
    version: SALES_KNOWLEDGE_VERSION,
    sources: Object.freeze([]),
    principles: Object.freeze([]),
    injectable: Object.freeze([]),
    gap,
    gapDetail: detail,
  });
}

function readJsonSafely(path: string, problems: string[]): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(`${path} : ${error instanceof Error ? error.message : 'illisible'}`);
    return null;
  }
}

function jsonEntries(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
}

/**
 * Lit une bibliothèque depuis un répertoire donné.
 *
 * Les fichiers de principes sont appariés à leur source par `sourceId`. Un
 * fichier ORPHELIN — dont la source n'existe pas — est écarté en entier : un
 * principe sans source n'a pas de provenance, et un principe sans provenance
 * n'est pas un principe (§12). Le silence serait pire que le rejet, donc le
 * défaut est enregistré dans `gapDetail`.
 */
function readLibraryAt(root: string): SalesLibrary {
  if (!existsSync(root)) return emptyLibrary('LIBRARY_ABSENT', `aucun répertoire ${root}`);

  const problems: string[] = [];
  const sources: SalesSource[] = [];

  for (const entry of jsonEntries(resolve(root, 'sources'))) {
    const parsed = salesSourceSchema.safeParse(
      readJsonSafely(resolve(root, 'sources', entry), problems),
    );
    if (parsed.success) sources.push(parsed.data);
    else problems.push(`${entry} : ${parsed.error.issues[0]?.message ?? 'schéma invalide'}`);
  }

  if (sources.length === 0) {
    return emptyLibrary(
      'NO_SOURCE',
      problems.length > 0 ? problems.join(' ; ') : 'aucun fichier de source lisible',
    );
  }

  const knownSources = new Set(sources.map((source) => source.id));
  const principles: SalesPrinciple[] = [];

  for (const entry of jsonEntries(resolve(root, 'principles'))) {
    const parsed = salesPrincipleFileSchema.safeParse(
      readJsonSafely(resolve(root, 'principles', entry), problems),
    );
    if (!parsed.success) {
      problems.push(`${entry} : ${parsed.error.issues[0]?.message ?? 'schéma invalide'}`);
      continue;
    }
    if (!knownSources.has(parsed.data.sourceId)) {
      problems.push(`${entry} : source « ${parsed.data.sourceId} » inconnue — fichier écarté`);
      continue;
    }
    principles.push(...parsed.data.principles);
  }

  if (principles.length === 0) {
    return emptyLibrary(
      'NO_PRINCIPLE',
      problems.length > 0 ? problems.join(' ; ') : 'aucun principe lisible',
    );
  }

  // Un identifiant en double ferait que « ce principe » désignerait deux
  // choses, donc que la provenance rendue dans un rapport serait fausse une
  // fois sur deux. La bibliothèque entière est refusée : sur une question de
  // provenance, il n'y a pas de moitié acceptable.
  const seen = new Set<string>();
  for (const principle of principles) {
    if (seen.has(principle.id)) {
      return emptyLibrary('INVALID_CONTENT', `identifiant de principe en double : ${principle.id}`);
    }
    seen.add(principle.id);
  }

  return Object.freeze({
    version: SALES_KNOWLEDGE_VERSION,
    sources: Object.freeze(sources),
    principles: Object.freeze(principles),
    injectable: Object.freeze(principles.filter(injectablePrinciple)),
    gap: problems.length > 0 ? 'INVALID_CONTENT' : null,
    gapDetail: problems.length > 0 ? problems.join(' ; ') : null,
  });
}

let cached: SalesLibrary | null = null;

/**
 * La bibliothèque canonique, chargée au plus une fois.
 *
 * Ne lève jamais : une exception inattendue pendant la lecture rend une
 * bibliothèque vide plutôt que de remonter dans un chemin de rédaction. Le
 * `catch` large est volontaire et c'est le seul du module — il existe
 * précisément pour que ce fichier ne puisse pas devenir un point de panne.
 */
export function loadSalesKnowledge(): SalesLibrary {
  if (cached !== null) return cached;
  try {
    cached = readLibraryAt(SALES_KNOWLEDGE_ROOT);
  } catch (error) {
    cached = emptyLibrary(
      'INVALID_CONTENT',
      error instanceof Error ? error.message : 'lecture impossible',
    );
  }
  return cached;
}

/** Vide le cache. Réservé aux tests. */
export function resetSalesKnowledgeCache(): void {
  cached = null;
}

/**
 * Charge une bibliothèque depuis un répertoire ARBITRAIRE, sans cache et sans
 * toucher au cache canonique.
 *
 * Existe pour une seule raison : éprouver `LIBRARY_ABSENT`, `NO_SOURCE`,
 * `NO_PRINCIPLE` et `INVALID_CONTENT` sur de vrais répertoires. Les simuler par
 * injection donnerait un test qui vérifie la simulation.
 */
export function loadSalesKnowledgeFrom(root: string): SalesLibrary {
  try {
    return readLibraryAt(root);
  } catch (error) {
    return emptyLibrary(
      'INVALID_CONTENT',
      error instanceof Error ? error.message : 'lecture impossible',
    );
  }
}
