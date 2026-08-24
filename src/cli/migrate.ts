#!/usr/bin/env tsx
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSql, resetSqlCache, resolveDbConfig, describeDbConfig } from '@/lib/db';
import { assertCorpusDestructionAllowed, corpusFootprint } from '@/lib/db/safety';
import { migrate } from '@/lib/db/migrate';
import { logger } from '@/lib/logging/logger';

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const config = resolveDbConfig();

  if (reset) {
    // `--reset` supprime un répertoire de données : la seule cible qu'il sait
    // détruire proprement est le datadir embarqué. Sur un serveur Postgres,
    // remettre la base à zéro relève de l'administration du serveur (drop /
    // create database), pas d'un `rmSync` côté application.
    if (config.backend !== 'pglite') {
      throw new Error(
        '--reset ne fonctionne que sur le pilote PGlite. Le backend courant est ' +
          `${config.backend} — recréez la base côté serveur si c'est réellement voulu.`,
      );
    }
    const dir = resolve(process.cwd(), config.dataDir);
    if (existsSync(dir)) {
      /**
       * Compter avant d'effacer.
       *
       * `--reset` supprimait le répertoire Postgres sans jamais l'ouvrir : la
       * commande ne pouvait donc pas savoir qu'elle détruisait un corpus, et
       * l'opérateur l'apprenait après. Une lecture de plus suffit à changer une
       * perte silencieuse en refus explicite qui dit ce qu'il protège.
       */
      const existing = await getSql();
      const footprint = await corpusFootprint(existing);
      await existing.close();
      resetSqlCache();
      assertCorpusDestructionAllowed(footprint, process.argv);

      rmSync(dir, { recursive: true, force: true });
      logger.warn('db.reset', { dir, destroyed: footprint });
    }
    resetSqlCache();
  }

  const sql = await getSql();
  const executed = await migrate(sql);
  logger.info('migration.done', {
    ...describeDbConfig(config),
    executed,
    count: executed.length,
  });
  await sql.close();
}

main().catch((error: unknown) => {
  logger.error('migration.failed', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
