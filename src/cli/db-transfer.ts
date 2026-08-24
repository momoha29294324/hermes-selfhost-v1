#!/usr/bin/env tsx
/**
 * Transfert du corpus PGlite vers PostgreSQL (DB1, phase 2).
 *
 *   npm run db:transfer -- --check          # compare seulement, n'écrit rien
 *   npm run db:transfer -- --execute        # sauvegarde, transfère, vérifie
 *
 * La source est toujours le datadir PGlite (`OUTBOUND_DB_DIR`, défaut
 * `./var/pgdata`). La cible est toujours `OUTBOUND_DATABASE_URL`. Les deux
 * doivent être renseignées explicitement : cette commande ne devine pas quelle
 * base elle est en train d'écraser.
 *
 * Fail-closed par construction :
 *   - rien ne s'exécute sans `--execute` ;
 *   - une sauvegarde PGlite précède obligatoirement l'écriture (sauf
 *     `--skip-backup`, qui doit être tapé en toutes lettres) ;
 *   - la cible doit être migrée et vide ;
 *   - le transfert entier est une seule transaction ;
 *   - la vérification finale compare deux empreintes complètes, et un écart
 *     unique suffit à faire sortir la commande en erreur.
 *
 * Aucun effet outbound : cette commande ne lit et n'écrit que des lignes.
 */
import { resolve } from 'node:path';
import { env, envInt } from '@/lib/env';
import { openSql } from '@/lib/db';
import { resolveDbConfig, describeDbConfig, type PostgresConfig } from '@/lib/db/config';
import { backupPgliteDataDir } from '@/lib/db/backup';
import { migrate } from '@/lib/db/migrate';
import { transferCorpus } from '@/lib/db/transfer';
import { snapshotDatabase, compareSnapshots } from '@/lib/db/transferAudit';
import type { Sql } from '@/lib/db/sql';
import { logger } from '@/lib/logging/logger';

/**
 * Empreinte des artefacts commerciaux du pilote R6B.
 *
 * Le checksum par table couvre déjà ces lignes, mais il les couvre de façon
 * anonyme : il dit « quelque chose a changé », pas « l'envoi réel de
 * Cleanyourcar69 a changé ». Cette sonde nomme ce qui doit survivre au
 * transfert, pour que le rapport puisse l'affirmer plutôt que le supposer.
 */
async function pilotFingerprint(sql: Sql): Promise<string> {
  const rows = await sql.query<Record<string, unknown>>(
    `select p.display_name,
            p.id::text                      as prospect_id,
            m.id::text                      as manifest_id,
            m.status                        as manifest_status,
            a.status                        as send_status,
            a.transport,
            a.recipient,
            a.provider,
            a.provider_message_id,
            a.provider_rfc_message_id,
            a.approved_text_sha256,
            a.transport_payload_sha256,
            (select count(*) from outreach_messages om where om.prospect_id = p.id)::bigint as messages
       from r6b_live_send_attempts a
       join r6b_dispatch_manifests m on m.id = a.manifest_id
       join prospects p on p.id = m.prospect_id
      order by a.completed_at nulls last, a.id`,
  );
  return JSON.stringify(rows);
}

interface TargetState {
  readonly serverVersion: string;
  readonly role: string;
  readonly database: string;
  readonly tables: number;
  readonly hasLedger: boolean;
}

/**
 * Ce que la cible est, avant de lui demander ce qu'elle contient.
 *
 * Sans cette lecture, un `--check` contre une base neuve se terminait sur
 * `relation "schema_migrations" does not exist` — une erreur exacte et
 * inutilisable, qui ressemble à une panne alors qu'elle décrit l'état normal
 * d'une cible pas encore migrée. Or c'est précisément l'état dans lequel se
 * trouve toute cible la première fois qu'on la vise.
 */
async function inspectTarget(sql: Sql): Promise<TargetState> {
  const rows = await sql.query<{
    server_version: string;
    role: string;
    database: string;
    tables: number;
    has_ledger: boolean;
  }>(
    `select current_setting('server_version')                  as server_version,
            current_user                                       as role,
            current_database()                                 as database,
            (select count(*)::int from pg_class c
               join pg_namespace ns on ns.oid = c.relnamespace
              where ns.nspname = 'public' and c.relkind = 'r') as tables,
            to_regclass('public.schema_migrations') is not null as has_ledger`,
  );
  const row = rows[0];
  if (!row) throw new Error('La cible n\'a répondu à aucune ligne sur la requête d\'état.');
  return {
    serverVersion: row.server_version,
    role: row.role,
    database: row.database,
    tables: row.tables,
    hasLedger: row.has_ledger,
  };
}

function parseArgs(argv: readonly string[]) {
  return {
    execute: argv.includes('--execute'),
    check: argv.includes('--check'),
    skipBackup: argv.includes('--skip-backup'),
    migrateTarget: argv.includes('--migrate-target'),
    resetTarget: argv.includes('--reset-target'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.execute && !args.check) {
    throw new Error('Précisez --check (comparaison seule) ou --execute (transfert réel).');
  }

  // La cible est décrite par l'environnement courant ; elle DOIT être Postgres.
  const targetConfig = resolveDbConfig();
  if (targetConfig.backend !== 'postgres') {
    throw new Error(
      'La cible du transfert doit être PostgreSQL. Renseignez OUTBOUND_DATABASE_URL ' +
        '(et OUTBOUND_DB_BACKEND=postgres) avant de lancer cette commande.',
    );
  }
  const sourceDir = resolve(process.cwd(), env('OUTBOUND_DB_DIR', './var/pgdata') as string);

  logger.info('db.transfer.plan', {
    source: { backend: 'pglite', dataDir: sourceDir },
    target: describeDbConfig(targetConfig),
    mode: args.execute ? 'execute' : 'check',
  });

  // ------------------------------------------------------------------
  // Sauvegarde d'abord. Une reprise n'a de valeur que si l'état d'avant
  // existe encore ailleurs. La sauvegarde prend le verrou du datadir, donc
  // elle se fait AVANT d'ouvrir la source pour la lecture.
  // ------------------------------------------------------------------
  if (args.execute && !args.skipBackup) {
    const backupsDir = resolve(process.cwd(), env('OUTBOUND_BACKUP_DIR', './var/backups') as string);
    const backup = await backupPgliteDataDir(sourceDir, backupsDir, {
      retention: envInt('OUTBOUND_BACKUP_RETENTION', 14),
    });
    logger.info('db.transfer.backup', { file: backup.file, sha256: backup.sha256, sizeBytes: backup.sizeBytes });
  }

  /**
   * La cible s'ouvre DANS le `try`, et c'est délibéré.
   *
   * Ouvrir les deux avant lui laissait un trou : si la connexion à la cible
   * échouait — mauvais certificat, mot de passe refusé, hôte injoignable — le
   * `finally` n'était jamais atteint, la source PGlite restait ouverte, et sa
   * poignée gardait la boucle d'événements vivante. Le processus ne sortait
   * donc pas : il affichait son erreur puis restait pendu indéfiniment, en
   * conservant le verrou du datadir. Observé, dix minutes durant, sur un échec
   * de vérification TLS.
   *
   * Une erreur de connexion doit rendre la main tout de suite, pas immobiliser
   * le datadir jusqu'à ce que quelqu'un tue le processus.
   */
  const source = await openSql({ backend: 'pglite', dataDir: sourceDir });
  let target: Sql | null = null;

  try {
    target = await openSql(targetConfig as PostgresConfig);

    // La connexion a abouti : TLS, authentification et pooler sont validés.
    // C'est la première information utile de la commande, et elle mérite d'être
    // affirmée avant tout le reste.
    const state = await inspectTarget(target);
    logger.info('db.transfer.target_state', { ...state });

    if (args.migrateTarget) {
      const executed = await migrate(target);
      logger.info('db.transfer.target_migrated', { executed, count: executed.length });
    } else if (!state.hasLedger) {
      throw new Error(
        `Connexion établie (PostgreSQL ${state.serverVersion}, base « ${state.database} », ` +
          `rôle « ${state.role} », ${state.tables} table(s) dans public), mais la cible ne porte ` +
          'aucun schéma : la table schema_migrations est absente.\n' +
          "Ce n'est pas une panne — c'est l'état normal d'une base neuve.\n" +
          'Pour appliquer les 28 migrations puis comparer : ajoutez --migrate-target.',
      );
    }

    if (args.execute) {
      const report = await transferCorpus(source, target, {
        allowNonEmptyTarget: args.resetTarget,
        onProgress: (table, rows) => logger.info('db.transfer.table', { table, rows }),
      });
      logger.info('db.transfer.copied', {
        tables: report.tables.length,
        totalRows: report.totalRows,
        foreignKeysRestored: report.foreignKeysRestored,
      });
    }

    // ------------------------------------------------------------------
    // Vérification : la même empreinte des deux côtés, ou rien.
    // ------------------------------------------------------------------
    const sourceSnapshot = await snapshotDatabase(source);
    const targetSnapshot = await snapshotDatabase(target);
    const comparison = compareSnapshots(sourceSnapshot, targetSnapshot);

    const sourcePilot = await pilotFingerprint(source);
    const targetPilot = await pilotFingerprint(target);
    const pilotIdentical = sourcePilot === targetPilot;

    for (const diff of comparison.differences.slice(0, 40)) {
      logger.warn('db.transfer.difference', {
        kind: diff.kind,
        subject: diff.subject,
        source: diff.source,
        target: diff.target,
      });
    }

    logger.info('db.transfer.verified', {
      identical: comparison.identical,
      differences: comparison.differences.length,
      tablesCompared: comparison.tablesCompared,
      rowsCompared: comparison.rowsCompared,
      constraints: sourceSnapshot.constraints.length,
      indexes: sourceSnapshot.indexes.length,
      migrations: sourceSnapshot.migrations.length,
      pilotArtifactsIdentical: pilotIdentical,
    });

    if (!comparison.identical || !pilotIdentical) {
      throw new Error(
        `Vérification en échec : ${comparison.differences.length} écart(s) de structure/contenu` +
          `${pilotIdentical ? '' : ', et les artefacts du pilote R6B diffèrent'}. ` +
          'Ne basculez pas sur cette cible.',
      );
    }

    process.stdout.write(
      `✅ ${comparison.rowsCompared} lignes sur ${comparison.tablesCompared} tables — ` +
        `checksums, contraintes (${sourceSnapshot.constraints.length}), index ` +
        `(${sourceSnapshot.indexes.length}) et migrations (${sourceSnapshot.migrations.length}) identiques.\n` +
        `✅ Artefacts du pilote R6B (manifeste, envoi réel, provider message id, RFC Message-ID) identiques.\n`,
    );
  } finally {
    // Fermer la source même si la cible n'a jamais pu s'ouvrir : c'est elle qui
    // détient le verrou du datadir et qui maintient la boucle d'événements.
    // Les erreurs de fermeture sont avalées pour ne pas masquer l'erreur
    // d'origine, qui est celle que l'opérateur doit lire.
    await source.close().catch(() => undefined);
    await target?.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  logger.error('db.transfer.failed', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
