/**
 * La même base, privée du droit d'écrire.
 *
 * ---------------------------------------------------------------------------
 * Pourquoi un module, et pas une fonction recopiée dans chaque CLI
 * ---------------------------------------------------------------------------
 * Ce garde-fou existait déjà, en local, dans `conversation-reply.ts` : le mode
 * OMBRE y enveloppe la connexion pour que son incapacité à écrire soit une
 * propriété du TRANSPORT et pas une discipline de l'appelant.
 *
 * HERMES-REAL-THREAD-PREVIEW-R1 ajoute une seconde commande qui a besoin
 * exactement de la même chose. La recopier aurait produit deux exemplaires
 * d'une garde — c'est-à-dire, tôt ou tard, deux gardes différentes, dont une
 * seule aurait reçu le prochain resserrement. Le dépôt refuse ce motif partout
 * ailleurs (`domSelectors`, `threadIdentity`, `deliveryProof`) ; il n'y a
 * aucune raison de l'accepter ici.
 *
 * ---------------------------------------------------------------------------
 * Ce que l'enveloppe rend impossible
 * ---------------------------------------------------------------------------
 *   * `query` passe d'abord par `assertReadOnlyStatement`, qui refuse au niveau
 *     de la SYNTAXE tout ce qui ne commence pas par `select` / `with` /
 *     `explain`, tout multi-instruction, et tout mot mutant hors chaîne
 *     littérale. Une écriture n'est donc pas « interdite par convention » :
 *     elle ne parvient pas au serveur ;
 *   * `exec` et `transaction` lèvent, sans condition. Ce sont les deux seules
 *     portes par lesquelles une écriture pourrait passer sans être une requête.
 *
 * `close` reste délégué : fermer n'écrit rien, et une enveloppe qui ne fermerait
 * pas fuirait une connexion à chaque invocation.
 */

import { assertReadOnlyStatement } from '@/lib/db/safety';
import type { Sql } from '@/lib/db/sql';

export function readOnlySql(sql: Sql, label: string): Sql {
  return {
    driver: sql.driver,
    async query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
      assertReadOnlyStatement(text, label);
      return sql.query<T>(text, params);
    },
    async exec(): Promise<void> {
      throw new Error(`${label} est en lecture seule : exec est refusé`);
    },
    async transaction<T>(): Promise<T> {
      throw new Error(`${label} est en lecture seule : transaction est refusée`);
    },
    async close(): Promise<void> {
      await sql.close();
    },
  };
}
