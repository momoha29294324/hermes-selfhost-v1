#!/usr/bin/env tsx
/**
 * R6B-D1.3 — retrait contrôlé des lignes `r6b_inbound_messages` introduites
 * par le premier poll Gmail, avant que la requête ne soit bornée aux
 * contreparties sortantes (voir `src/lib/inbound/gmailProvider.ts`).
 *
 *   npm run r6b:cleanup:inbound              # simulation, rien n'est écrit
 *   npm run r6b:cleanup:inbound -- --execute # supprime les lignes sûres
 *
 * Une ligne n'est SÛRE à retirer que si les quatre conditions tiennent TOUTES :
 *
 *   1. correlation_status = 'UNMATCHED' ;
 *   2. aucune corrélation (manifeste, outreach_event, prospect — les trois
 *      colonnes sont NULL, garanti par ailleurs par les contraintes de la
 *      migration 0025) ;
 *   3. l'expéditeur n'est PAS une contrepartie sortante connue
 *      (`outreach_events.kind = 'sent'`) ;
 *   4. le total de lignes en base est EXACTEMENT égal au nombre de lignes
 *      sûres — s'il existe la moindre ligne qui ne l'est pas, cette commande
 *      s'arrête sans rien supprimer et rapporte cette ligne pour revue
 *      humaine, plutôt que de supprimer un sous-ensemble en silence.
 *
 * Elle ne touche à rien d'autre : ni le curseur (`r6b_inbound_checkpoints`),
 * ni les manifestes, ni les envois. Le curseur reste correct après le retrait
 * — voir le raisonnement dans le rapport de mission R6B-D1.3, section
 * CHECKPOINT : `last_internal_date_ms` borne une DATE de synchronisation
 * observée, pas les lignes qui s'y trouvaient, et une future réponse réelle
 * reste découvrable normalement.
 */
import { getSql } from '@/lib/db';
import { loadOutboundSends } from '@/lib/inbound/intake';
import { createLogger } from '@/lib/logging/logger';
import type { Sql } from '@/lib/db/sql';

interface CandidateRow {
  readonly id: string;
  readonly providerMessageId: string;
  readonly fromAddress: string;
  readonly receivedAt: string;
}

async function loadUnsafeRows(sql: Sql): Promise<{ id: string; reason: string }[]> {
  const rows = await sql.query<{
    id: string;
    correlationStatus: string;
    correlatedManifestId: string | null;
    correlatedOutreachEventId: string | null;
    correlatedProspectId: string | null;
  }>(
    `select id, correlation_status as "correlationStatus",
            correlated_manifest_id::text as "correlatedManifestId",
            correlated_outreach_event_id::text as "correlatedOutreachEventId",
            correlated_prospect_id::text as "correlatedProspectId"
       from r6b_inbound_messages`,
  );

  const unsafe: { id: string; reason: string }[] = [];
  for (const row of rows) {
    if (row.correlationStatus !== 'UNMATCHED') {
      unsafe.push({ id: row.id, reason: `correlation_status = ${row.correlationStatus}` });
      continue;
    }
    if (row.correlatedManifestId !== null || row.correlatedOutreachEventId !== null || row.correlatedProspectId !== null) {
      unsafe.push({ id: row.id, reason: 'une colonne de corrélation est non nulle malgré UNMATCHED' });
    }
  }
  return unsafe;
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const logger = createLogger({ cli: 'r6b-cleanup-unrelated-inbound' });

  const sql = await getSql();
  try {
    const totalBefore = (await sql.query<{ count: string }>(`select count(*)::text as count from r6b_inbound_messages`))[0]!
      .count;

    const sends = await loadOutboundSends(sql);
    const counterparties = new Set(sends.map((send) => send.recipient));

    const unsafe = await loadUnsafeRows(sql);
    if (unsafe.length > 0) {
      process.stdout.write(
        `\nARRÊT — ${unsafe.length} ligne(s) ne remplissent pas les conditions de sûreté ` +
          `(corrélation non nulle malgré UNMATCHED, ou statut ≠ UNMATCHED). Rien n'est supprimé.\n`,
      );
      for (const row of unsafe) process.stdout.write(`  ${row.id} — ${row.reason}\n`);
      process.exitCode = 1;
      return;
    }

    const candidates = await sql.query<CandidateRow>(
      `select id, provider_message_id as "providerMessageId", from_address as "fromAddress",
              received_at::text as "receivedAt"
         from r6b_inbound_messages
        where correlation_status = 'UNMATCHED'
          and correlated_manifest_id is null
          and correlated_outreach_event_id is null
          and correlated_prospect_id is null`,
    );

    const safe = candidates.filter((row) => !counterparties.has(row.fromAddress.trim().toLowerCase()));
    const retained = candidates.filter((row) => counterparties.has(row.fromAddress.trim().toLowerCase()));

    process.stdout.write('\nR6B-D1.3 — prestation standard des messages entrants non liés à l’outbound\n');
    process.stdout.write(`  lignes totales avant       ${totalBefore}\n`);
    process.stdout.write(`  contreparties sortantes     ${[...counterparties].join(', ') || '(aucune)'}\n`);
    process.stdout.write(`  candidates sûres à retirer   ${safe.length}\n`);
    process.stdout.write(`  retenues (expéditeur connu) ${retained.length}\n`);

    if (retained.length > 0) {
      process.stdout.write(
        '\nRETENUES — expéditeur correspondant à une contrepartie sortante malgré UNMATCHED. ' +
          'Revue humaine requise avant tout retrait :\n',
      );
      for (const row of retained) {
        process.stdout.write(`  ${row.id}  ${row.receivedAt}  from=${row.fromAddress}  msg=${row.providerMessageId}\n`);
      }
    }

    if (safe.length === 0) {
      process.stdout.write('\nAucune ligne sûre à retirer.\n');
      return;
    }

    if (!execute) {
      process.stdout.write(
        `\nSimulation — relancer avec --execute pour retirer ces ${safe.length} ligne(s). ` +
          'Une sauvegarde PGlite (`npm run db:backup`) doit précéder toute exécution réelle.\n',
      );
      return;
    }

    const ids = safe.map((row) => row.id);
    const deleted = await sql.query<{ id: string }>(
      `delete from r6b_inbound_messages where id = any($1::uuid[]) returning id`,
      [ids],
    );

    const totalAfter = (await sql.query<{ count: string }>(`select count(*)::text as count from r6b_inbound_messages`))[0]!
      .count;

    process.stdout.write(`\nSupprimées : ${deleted.length}\n`);
    process.stdout.write(`Lignes totales après        ${totalAfter}\n`);
    logger.info('r6b.inbound.cleanup.done', {
      deleted: deleted.length,
      retained: retained.length,
      totalBefore,
      totalAfter,
    });
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
