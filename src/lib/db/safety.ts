import type { Sql } from '@/lib/db/sql';

/**
 * Garde-fous entre un outil de mesure et un corpus qu'on a mis des semaines à
 * constituer.
 *
 * Le §27 du gate R3 demande deux choses distinctes, et elles se traitent
 * différemment :
 *
 *   - **une commande de mesure ne doit rien écrire.** `assertReadOnlyStatement`
 *     le vérifie au niveau de l'instruction, pas de l'intention. Un benchmark
 *     qui « ne devait pas écrire » et qui écrit quand même est exactement ce
 *     contre quoi une revue de code ne protège pas ;
 *   - **une commande destructrice doit savoir ce qu'elle détruit.** C'est le
 *     chemin qui a coûté cher : `db:reset` supprime le répertoire Postgres
 *     entier, sans rien lire d'abord, donc sans jamais pouvoir dire « il y
 *     avait 257 prospects là-dedans ». Compter avant d'effacer transforme une
 *     erreur silencieuse en refus explicite.
 */

/** Le drapeau à taper en toutes lettres pour détruire un corpus non vide. */
export const DESTROY_CORPUS_FLAG = '--i-know-this-destroys-the-corpus';

export interface CorpusFootprint {
  prospects: number;
  evidence: number;
  messages: number;
  campaigns: number;
}

export function corpusIsEmpty(footprint: CorpusFootprint): boolean {
  return footprint.prospects === 0 && footprint.evidence === 0 && footprint.messages === 0;
}

/** Ce qu'il y a à perdre. Lecture seule, tolérante à un schéma absent. */
export async function corpusFootprint(sql: Sql): Promise<CorpusFootprint> {
  const empty: CorpusFootprint = { prospects: 0, evidence: 0, messages: 0, campaigns: 0 };
  try {
    const rows = await sql.query<{
      prospects: string;
      evidence: string;
      messages: string;
      campaigns: string;
    }>(
      `select (select count(*) from prospects)::text          as prospects,
              (select count(*) from prospect_evidence)::text  as evidence,
              (select count(*) from outreach_messages)::text  as messages,
              (select count(*) from campaigns)::text          as campaigns`,
    );
    const row = rows[0];
    if (!row) return empty;
    return {
      prospects: Number.parseInt(row.prospects, 10),
      evidence: Number.parseInt(row.evidence, 10),
      messages: Number.parseInt(row.messages, 10),
      campaigns: Number.parseInt(row.campaigns, 10),
    };
  } catch {
    // Base neuve, tables absentes : il n'y a rien à protéger.
    return empty;
  }
}

export class CorpusProtectedError extends Error {
  constructor(readonly footprint: CorpusFootprint) {
    super(
      `Refus de détruire un corpus existant : ${footprint.prospects} prospect(s), ` +
        `${footprint.evidence} evidence(s), ${footprint.messages} message(s) sur ${footprint.campaigns} campagne(s). ` +
        `Relancez avec ${DESTROY_CORPUS_FLAG} si c'est réellement voulu.`,
    );
    this.name = 'CorpusProtectedError';
  }
}

/**
 * Autorise ou refuse une destruction.
 *
 * Une base vide part sans cérémonie — refuser là n'apporterait rien et
 * pousserait à prendre l'habitude de passer le drapeau.
 */
export function assertCorpusDestructionAllowed(footprint: CorpusFootprint, argv: readonly string[]): void {
  if (corpusIsEmpty(footprint)) return;
  if (argv.includes(DESTROY_CORPUS_FLAG)) return;
  throw new CorpusProtectedError(footprint);
}

/**
 * Mots-clés qui modifient des données ou un schéma.
 *
 * `insert` en fait partie : un outil de mesure qui insère une ligne de journal
 * modifie ce qu'il mesure. Les rails, eux, n'utilisent pas cette fonction —
 * ils écrivent parce que c'est leur travail.
 */
const MUTATING = /\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|merge|copy|vacuum|refresh)\b/i;

export class NotReadOnlyError extends Error {
  constructor(label: string, statement: string) {
    super(`« ${label} » doit être en lecture seule ; instruction refusée : ${statement.slice(0, 120)}`);
    this.name = 'NotReadOnlyError';
  }
}

/**
 * Vérifie qu'une instruction ne peut que lire.
 *
 * Volontairement syntaxique et strict : commencer par `select` ne suffit pas,
 * parce que `select … ; delete …` commence aussi par `select`, et parce qu'une
 * CTE peut écrire (`with x as (delete … returning *) select …`). La règle est
 * donc : commence par select/with/explain, ET ne contient aucun mot-clé de
 * mutation, ET ne contient qu'une seule instruction.
 */
export function assertReadOnlyStatement(statement: string, label = 'mesure'): void {
  const trimmed = statement.trim();
  if (!/^(select|with|explain)\b/i.test(trimmed)) throw new NotReadOnlyError(label, trimmed);

  // HERMES-SEMANTIC-GROUNDING-R1 — les COMMENTAIRES sont neutralisés AVANT le
  // reste, et ce n'est pas cosmétique.
  //
  // Le défaut avait été relevé et laissé ouvert par
  // HERMES-TRIAL-IMPLEMENTATION-ROUTING-R1 : la recherche du point-virgule
  // séparateur passait AVANT toute neutralisation, si bien qu'un « ; » écrit
  // dans un commentaire SQL — ou le mot « update » dans une phrase française
  // expliquant une requête — faisait refuser une lecture parfaitement licite.
  // `npm run conversation:autonomy` en était la victime, alors que ses requêtes
  // ne font que lire.
  //
  // L'ordre correct est : chaînes, puis commentaires, puis instruction. Les
  // chaînes d'abord parce qu'un « -- » à l'intérieur d'un littéral n'ouvre
  // aucun commentaire ; les commentaires ensuite parce qu'ils ne s'exécutent
  // pas. Le contrôle ne devient pas plus indulgent sur ce qui S'EXÉCUTE : il
  // cesse de juger ce qui ne s'exécute pas.
  const withoutStrings = trimmed.replace(/'([^']|'')*'/g, "''");
  const withoutComments = withoutStrings
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');

  // Une seule instruction : un point-virgule final est toléré, pas un séparateur.
  const withoutTrailing = withoutComments.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) throw new NotReadOnlyError(label, trimmed);

  if (MUTATING.test(withoutTrailing)) throw new NotReadOnlyError(label, trimmed);
}

/** Exécute une requête après avoir vérifié qu'elle ne peut que lire. */
export async function readOnlyQuery<T = Record<string, unknown>>(
  sql: Sql,
  statement: string,
  params?: readonly unknown[],
  label = 'mesure',
): Promise<T[]> {
  assertReadOnlyStatement(statement, label);
  return sql.query<T>(statement, params);
}
