#!/usr/bin/env tsx
/**
 * R6B-D2 §13 — le traitement déterministe, une fois, puis on sort.
 *
 *   npm run r6b:replies:process
 *   npm run r6b:replies:process -- --limit 10
 *   npm run r6b:replies:process -- --resume       # reprend un aval incomplet
 *   npm run r6b:replies:process -- --inbound <id>  # UN message, et rien d'autre
 *
 * Lit les réponses corrélées non traitées, classe, persiste, transitionne
 * l'état commercial, projette vers le CRM s'il en existe un, lève une alerte,
 * rédige un brouillon quand c'est pertinent, s'arrête.
 *
 * Ce que cette commande NE PEUT PAS faire, et pas parce qu'un drapeau est à 0 :
 * elle n'importe aucun provider d'envoi, aucune identité d'expéditeur, aucun
 * client Gmail. Les modules qu'elle appelle n'en importent aucun non plus. Un
 * brouillon rédigé ici naît `PROPOSED` et le reste — il n'existe aucun statut
 * d'envoi dans le schéma, donc aucun endroit où en écrire un.
 */
import { getSql } from '@/lib/db';
import { logger } from '@/lib/logging/logger';
import { ModelRouter } from '@/lib/models/router';
import { resolveCrmDestination } from '@/lib/crm/resolve';
import { processNewReplies, type ProcessReport } from '@/lib/replies/process';

class ProcessArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessArgError';
  }
}

interface ProcessArgs {
  readonly limit: number;
  readonly resume: boolean;
  /**
   * HERMES-CONTEXTUAL-REPLY-CLASSIFICATION-R1 — relire UN tour nommé.
   *
   * Après un correctif de classification, la question de l'opérateur n'est pas
   * « reprends tout » mais « relis CE message ». `--resume` répondait à la
   * première : il rejouerait chaque conversation déjà analysée, y compris
   * celles de vrais prospects que personne n'a demandé de rouvrir.
   *
   * Aucun pouvoir n'est ajouté avec ce drapeau : c'est le MÊME `processReply`,
   * les mêmes gardes, la même idempotence. Il ne fait que borner le lot.
   */
  readonly inbound: string | null;
}

function parseArgs(argv: readonly string[]): ProcessArgs {
  let limit = 50;
  let resume = false;
  let inbound: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '--limit') {
      const parsed = Number.parseInt(next ?? '', 10);
      if (!Number.isFinite(parsed) || parsed < 1) throw new ProcessArgError('--limit attend un entier ≥ 1');
      limit = Math.min(500, parsed);
      i += 1;
      continue;
    }
    if (arg === '--resume') {
      resume = true;
      continue;
    }
    if (arg === '--inbound') {
      if (next === undefined || next.startsWith('--')) {
        throw new ProcessArgError('--inbound attend un identifiant de message entrant');
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(next)) {
        throw new ProcessArgError('--inbound attend un UUID');
      }
      inbound = next;
      i += 1;
      continue;
    }
    throw new ProcessArgError(`option inconnue : ${arg}`);
  }

  if (inbound !== null && resume) {
    throw new ProcessArgError('--inbound et --resume ne se combinent pas : l’un vise un message, l’autre le lot');
  }

  return { limit, resume, inbound };
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(24)} ${value}\n`);
}

function report(result: ProcessReport): void {
  process.stdout.write('\nR6B-D2 — TRAITEMENT DES RÉPONSES\n');
  line('candidats', String(result.candidates));
  line('traités', String(result.processed.length));
  line('classifiés', String(result.classified));
  line('brouillons rédigés', String(result.drafted));
  line('dossiers CRM locaux', String(result.localCrmRecords));
  line('écritures CRM externes', String(result.crmWrites));
  line('alertes levées', String(result.alertsRaised));
  line('ignorés', String(result.skipped.length));
  line('échecs', String(result.failures.length));
  line('CRM externe', result.externalCrmConfigured ? 'configuré' : 'aucun (optionnel)');
  line('canal d’alerte', result.alertProviderConfigured ? 'configuré' : 'AUCUN (file interne)');
  line(
    'ombre conversation',
    result.conversationShadowEnabled
      ? `active — ${result.conversationShadowObserved} comparaison(s)`
      : 'éteinte (OUTBOUND_CONVERSATION_SHADOW_ENABLED=0)',
  );

  if (!result.externalCrmConfigured) {
    process.stdout.write(`\n  CRM : ${result.crmDetail}\n`);
    process.stdout.write('  Voir « npm run r6b:crm:status » pour l’état de la copie externe optionnelle.\n');
  }

  for (const entry of result.processed) {
    process.stdout.write(
      `\n  ${entry.company} — ${entry.classification} (${entry.confidence.toFixed(2)}) [${entry.correlationStatus}]\n`,
    );
    line('    état', `${entry.stateFrom ?? '∅'} → ${entry.stateTo ?? '(inchangé)'}${entry.stateApplied ? '' : ' (non appliqué)'}`);
    line('    suppression', entry.suppressed ? 'oui' : 'non');
    line('    brouillon', entry.draftId === null ? (entry.draftFailure ?? 'sans objet') : entry.draftId);
    line('    CRM', entry.crmStatus === null ? 'sans objet' : `${entry.crmStatus} — ${entry.crmDetail ?? ''}`);
    line('    alerte', entry.alertId ?? 'sans objet');
    const shadow = entry.conversationShadow;
    if (shadow !== null) {
      // L'ombre ne dit jamais « fais ceci » : elle dit ce qu'elle aurait
      // proposé, et à quel point c'était plus court. Rien n'en découle.
      line(
        '    ombre',
        `${shadow.status} — legacy ${shadow.legacy?.chars ?? '—'} car. / ${shadow.legacy?.naturalnessVerdict ?? '—'}` +
          ` vs conversation ${shadow.conversation?.chars ?? '—'} car. / ${shadow.conversation?.naturalnessVerdict ?? '—'}`,
      );
    }
  }

  for (const entry of result.skipped) {
    process.stdout.write(`\n  ignoré ${entry.inboundMessageId} : ${entry.reason}\n`);
  }
  for (const entry of result.failures) {
    process.stderr.write(`\n  échec [${entry.stage}] ${entry.inboundMessageId} : ${entry.reason}\n`);
  }
  if (result.failures.length > 0) {
    process.stderr.write(
      '\n  Aucun état n’a bougé pour ces messages : ils restent non traités et la prochaine\n' +
        '  exécution réessaiera. Rien n’a été conclu à moitié.\n',
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = await getSql();

  try {
    const router = new ModelRouter({ sql, logger });
    const crm = await resolveCrmDestination(sql);

    const result = await processNewReplies(
      sql,
      router,
      { crm, alertProviderConfigured: false },
      { limit: args.limit, includeAnalyzed: args.resume, only: args.inbound },
    );
    report(result);

    process.stdout.write('\nAucun envoi. Aucun message sortant. Aucune modification de la boîte Gmail.\n\n');
    if (result.failures.length > 0) process.exitCode = 2;
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ProcessArgError) {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
