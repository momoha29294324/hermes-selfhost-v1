#!/usr/bin/env tsx
/**
 * R6B-D2 §12 — la vue opérateur, en lecture seule par défaut.
 *
 *   npm run r6b:replies                       # état complet
 *   npm run r6b:replies -- --alerts           # seulement la file d'alertes
 *   npm run r6b:replies -- --transitions      # seulement le journal d'états
 *   npm run r6b:replies -- --approve <id>     # valider un brouillon (n'envoie RIEN)
 *   npm run r6b:replies -- --edit <id> --text "…"
 *   npm run r6b:replies -- --reject <id> --note "…"
 *
 * Cette commande ne classe rien (aucun modèle n'est construit) et n'envoie
 * rien : elle n'importe aucun provider, ni d'envoi, ni de boîte mail.
 * `--approve` inscrit une décision humaine sur un brouillon et s'arrête là —
 * il n'existe dans ce dépôt aucune fonction qui lise un brouillon approuvé
 * pour l'expédier.
 */
import { getSql } from '@/lib/db';
import type { Sql } from '@/lib/db/sql';
import { loadPendingAlerts } from '@/lib/replies/alerts';
import { reviewDraft, type HumanDecision } from '@/lib/replies/draft';
import { loadReplyOverviews, loadReplySummary, loadStateTransitions } from '@/lib/replies/queries';

class RepliesArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepliesArgError';
  }
}

interface RepliesArgs {
  readonly limit: number;
  readonly alertsOnly: boolean;
  readonly transitionsOnly: boolean;
  readonly review: { readonly draftId: string; readonly decision: HumanDecision } | null;
  readonly text: string | null;
  readonly note: string | null;
  readonly reviewedBy: string;
}

function parseArgs(argv: readonly string[]): RepliesArgs {
  let limit = 20;
  let alertsOnly = false;
  let transitionsOnly = false;
  let review: RepliesArgs['review'] = null;
  let text: string | null = null;
  let note: string | null = null;
  let reviewedBy = 'operator';

  const decisions: Readonly<Record<string, HumanDecision>> = {
    '--approve': 'APPROVE',
    '--edit': 'EDIT',
    '--reject': 'REJECT',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    const decision = decisions[arg];

    if (decision) {
      if (!next) throw new RepliesArgError(`${arg} attend un identifiant de brouillon`);
      if (review !== null) throw new RepliesArgError('une seule décision à la fois');
      review = { draftId: next, decision };
      i += 1;
      continue;
    }
    if (arg === '--text') {
      if (!next) throw new RepliesArgError('--text attend un texte');
      text = next;
      i += 1;
      continue;
    }
    if (arg === '--note') {
      if (!next) throw new RepliesArgError('--note attend un texte');
      note = next;
      i += 1;
      continue;
    }
    if (arg === '--by') {
      if (!next) throw new RepliesArgError('--by attend un nom');
      reviewedBy = next;
      i += 1;
      continue;
    }
    if (arg === '--limit') {
      const parsed = Number.parseInt(next ?? '', 10);
      if (!Number.isFinite(parsed) || parsed < 1) throw new RepliesArgError('--limit attend un entier ≥ 1');
      limit = Math.min(200, parsed);
      i += 1;
      continue;
    }
    if (arg === '--alerts') {
      alertsOnly = true;
      continue;
    }
    if (arg === '--transitions') {
      transitionsOnly = true;
      continue;
    }
    if (arg === '--crm-plan') {
      // Déplacé en R6B-D2.1 : la configuration CRM a désormais sa propre
      // commande, qui lit la destination réellement confirmée en base plutôt
      // que de décrire un plan théorique. Deux vues de la même chose
      // finiraient par se contredire.
      throw new RepliesArgError('--crm-plan a été remplacé par « npm run r6b:crm:status »');
    }
    throw new RepliesArgError(`option inconnue : ${arg}`);
  }

  return { limit, alertsOnly, transitionsOnly, review, text, note, reviewedBy };
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(26)} ${value}\n`);
}

function block(text: string, indent: string): string {
  return text
    .split('\n')
    .map((row) => `${indent}${row}`)
    .join('\n');
}

async function printSummary(sql: Sql): Promise<void> {
  const summary = await loadReplySummary(sql);
  process.stdout.write('\nR6B-D2 — RÉPONSES (lecture seule, aucun envoi)\n');
  line('entrants corrélés', String(summary.correlatedInbound));
  line('analysés', String(summary.analyzed));
  line('en attente d’analyse', String(summary.awaitingAnalysis));
  line('brouillons PROPOSED', String(summary.draftsProposed));
  line('brouillons bloqués', String(summary.draftsBlocked));
  line('alertes ouvertes', String(summary.alertsOpen));
  line('projections CRM en attente', String(summary.crmPending));
  line('projections CRM appliquées', String(summary.crmApplied));
  line('adresses supprimées (D2)', String(summary.suppressedAddresses));

  const classes = Object.entries(summary.byClassification);
  line('par catégorie', classes.length === 0 ? '—' : classes.map(([k, n]) => `${k} ${n}`).join(', '));
  const states = Object.entries(summary.byState);
  line('par état commercial', states.length === 0 ? '—' : states.map(([k, n]) => `${k} ${n}`).join(', '));
}

async function printReplies(sql: Sql, limit: number): Promise<void> {
  const rows = await loadReplyOverviews(sql, limit);
  if (rows.length === 0) {
    process.stdout.write('\nAucune réponse corrélée en base.\n');
    return;
  }

  process.stdout.write(`\n${rows.length} réponse(s) :\n`);
  for (const row of rows) {
    process.stdout.write(`\n─── ${row.company} ─────────────────────────────────────\n`);
    line('reçu le', row.receivedAt);
    line('de', row.fromAddress);
    line('corrélation', `${row.correlationStatus}${row.correlationMethod ? ` (${row.correlationMethod})` : ''}`);
    line(
      'classification',
      row.classification === null
        ? '— (non analysée)'
        : `${row.classification} · confiance ${row.confidence?.toFixed(2) ?? '—'}` +
            `${row.decidedDeterministically ? ' · déterministe' : ` · ${row.analysisModel ?? '—'}`}`,
    );
    if (row.reasoningSummary !== null) line('justification', row.reasoningSummary);
    line('action recommandée', row.recommendedNextAction ?? '—');
    line('revue humaine requise', row.requiresHumanReview === null ? '—' : row.requiresHumanReview ? 'oui' : 'non');
    line('état commercial', row.outreachState ?? '—');
    line(
      'projection CRM',
      row.crmStatus === null ? '—' : `${row.crmStatus}${row.crmProvider ? ` (${row.crmProvider})` : ''}`,
    );
    if (row.crmLastError !== null) line('  erreur CRM', row.crmLastError);
    line('alerte', row.alertId === null ? '—' : `${row.alertStatus} (${row.alertId})`);

    process.stdout.write(`\n  MESSAGE ENVOYÉ${row.originalSubject ? ` — objet : ${row.originalSubject}` : ''}\n`);
    process.stdout.write(`${block(row.originalMessage.slice(0, 1200), '    ')}\n`);

    process.stdout.write(`\n  RÉPONSE REÇUE${row.subject ? ` — objet : ${row.subject}` : ''}\n`);
    process.stdout.write(`${block(row.bodyText.slice(0, 1200), '    ')}\n`);

    if (row.draftId !== null) {
      process.stdout.write(
        `\n  RÉPONSE PROPOSÉE — ${row.draftStatus}${row.draftBlocked ? ' · BLOQUÉE PAR LES GARDE-FOUS' : ''}` +
          ` (id ${row.draftId})\n`,
      );
      process.stdout.write(`${block(row.draftHumanText ?? row.draftBody ?? '', '    ')}\n`);
      process.stdout.write('    → non envoyée. Aucune commande de ce dépôt n’envoie une réponse.\n');
    }
  }
}

async function printAlerts(sql: Sql, limit: number): Promise<void> {
  const alerts = await loadPendingAlerts(sql, limit);
  process.stdout.write(`\nALERTES OUVERTES : ${alerts.length}\n`);
  for (const alert of alerts) {
    process.stdout.write(`\n  [${alert.severity}] ${alert.title} — ${alert.status} (${alert.createdAt})\n`);
    line('    action', alert.body.recommendedAction);
    line('    réponse proposée', alert.body.proposedResponseStatus);
    line('    extrait', alert.body.replyPreview.slice(0, 200).replace(/\n/g, ' ⏎ '));
  }
  if (alerts.length > 0) {
    process.stdout.write(
      '\n  Aucun canal de livraison n’est configuré : ces alertes vivent en base et se lisent ici.\n',
    );
  }
}

async function printTransitions(sql: Sql, limit: number): Promise<void> {
  const rows = await loadStateTransitions(sql, limit);
  process.stdout.write(`\nJOURNAL DES ÉTATS : ${rows.length} transition(s)\n`);
  for (const row of rows) {
    process.stdout.write(
      `  ${row.createdAt}  ${row.company}  ${row.fromState ?? '∅'} → ${row.toState}  [${row.causeKind}]\n` +
        `      ${row.reason}\n`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = await getSql();

  try {
    if (args.review !== null) {
      const draft = await reviewDraft(sql, {
        draftId: args.review.draftId,
        decision: args.review.decision,
        reviewedBy: args.reviewedBy,
        ...(args.text === null ? {} : { text: args.text }),
        ...(args.note === null ? {} : { note: args.note }),
      });
      process.stdout.write(`\nBrouillon ${draft.id} → ${draft.status}\n`);
      process.stdout.write(
        'AUCUN ENVOI N’A EU LIEU. Un brouillon approuvé reste un texte en base : ' +
          'ce dépôt n’a aucun chemin de code qui expédie une réponse.\n\n',
      );
      return;
    }

    if (args.alertsOnly) {
      await printAlerts(sql, args.limit);
      process.stdout.write('\n');
      return;
    }
    if (args.transitionsOnly) {
      await printTransitions(sql, args.limit);
      process.stdout.write('\n');
      return;
    }

    await printSummary(sql);
    await printReplies(sql, args.limit);
    await printAlerts(sql, args.limit);
    process.stdout.write('\n');
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof RepliesArgError) {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
