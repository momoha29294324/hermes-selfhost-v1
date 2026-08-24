#!/usr/bin/env tsx
/**
 * Sauvegarde de la base, quel que soit le backend.
 *
 * Le choix du mécanisme suit la déclaration de `@/lib/db/config`, pas une
 * variable devinée ici : `pg_dump` pour PostgreSQL, snapshot du datadir pour
 * PGlite. Les deux écrivent dans `OUTBOUND_BACKUP_DIR` avec un manifeste et un
 * SHA-256, et appliquent la même rétention.
 */
import { resolve } from 'node:path';
import { env, envInt } from '@/lib/env';
import { resolveDbConfig, describeDbConfig } from '@/lib/db/config';
import { backupPgliteDataDir } from '@/lib/db/backup';
import { backupPostgres } from '@/lib/db/backupPostgres';
import { logger } from '@/lib/logging/logger';

async function main(): Promise<void> {
  const config = resolveDbConfig();
  const backupsDir = resolve(process.cwd(), env('OUTBOUND_BACKUP_DIR', './var/backups') as string);
  const retention = envInt('OUTBOUND_BACKUP_RETENTION', 14);

  const result =
    config.backend === 'postgres'
      ? await backupPostgres(config, backupsDir, { retention })
      : await backupPgliteDataDir(config.dataDir, backupsDir, { retention });

  logger.info('db.backup.done', { ...describeDbConfig(config), file: result.file, sha256: result.sha256 });
}

main().catch((error: unknown) => {
  logger.error('db.backup.failed', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
