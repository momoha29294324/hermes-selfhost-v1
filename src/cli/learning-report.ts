#!/usr/bin/env tsx
/**
 * LEARNING-R1 §18, §25.25, §25.26 — le rapport d'apprentissage, EN LECTURE SEULE.
 *
 *   npm run learning:report
 *   npm run learning:report -- --json
 *
 * ---------------------------------------------------------------------------
 * Ce que cette commande ne peut pas faire, et ce qui l'en empêche
 * ---------------------------------------------------------------------------
 *
 *   * **Elle n'écrit pas.** La connexion passe par un `Sql` enveloppé qui
 *     refuse toute instruction non-SELECT au niveau de la SYNTAXE
 *     (`assertReadOnlyStatement`), et dont `exec` et `transaction` lèvent. Ce
 *     n'est pas une convention de relecture : une écriture n'atteint pas le
 *     serveur. Le même patron que `conversation:shadow`, pour la même raison.
 *
 *   * **Elle n'appelle aucun modèle.** Toute la boucle est déterministe —
 *     comparaison de textes, comptage, intervalles de Wilson. Aucun
 *     `ModelRouter` n'entre dans la clôture d'imports, donc pas de ligne
 *     `model_runs`, pas de coût, pas de latence, et un rapport reproductible.
 *
 *   * **Elle n'envoie rien.** Aucun provider, aucun rail Instagram, aucun
 *     kill-switch, et aucune lecture de l'autorisation d'envoi globale dans sa
 *     clôture d'imports — un test la parcourt fichier par fichier et refuse
 *     jusqu'au NOM de cette variable, y compris dans un commentaire. Le nom
 *     n'est donc pas écrit ici : une garde qu'on désarme pour pouvoir parler
 *     d'elle ne garde plus rien.
 *
 *   * **Elle ne modifie aucune politique.** Elle rend des `LEARNING_PROPOSAL`,
 *     et c'est le seul genre de sortie qui existe : aucune variante « appliquer
 *     la règle » n'a de type dans ce dépôt, donc aucune n'a de code.
 */
import { getSql } from '@/lib/db';
import { readOnlySql } from '@/lib/learning/readOnly';
import { buildLearningReport } from '@/lib/learning/report';
import { renderLearningReport } from '@/lib/learning/render';

class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

interface Args {
  readonly json: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    throw new ArgError(`option inconnue : ${arg}`);
  }
  return { json };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = readOnlySql(await getSql());
  try {
    const report = await buildLearningReport(sql);
    process.stdout.write(
      args.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderLearningReport(report)}\n`,
    );
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
