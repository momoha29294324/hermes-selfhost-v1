/**
 * LEARNING-R1 §25.25, §25.26 — la lecture seule, imposée par la syntaxe.
 *
 * Extrait du CLI pour une raison de test : un module qui appelle `main()` au
 * chargement ne s'importe pas depuis un test sans l'exécuter. La garde
 * elle-même doit être vérifiable, donc elle vit ici, et le CLI l'importe.
 *
 * `exec` et `transaction` lèvent plutôt que de rendre un no-op. Un no-op
 * silencieux ferait passer une future écriture pour un succès, ce qui est pire
 * qu'une erreur bruyante : personne ne la remarquerait.
 */

import { assertReadOnlyStatement } from '@/lib/db/safety';
import type { Sql } from '@/lib/db/sql';

export function readOnlySql(sql: Sql, label = 'learning:report'): Sql {
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
