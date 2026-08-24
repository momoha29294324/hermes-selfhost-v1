#!/usr/bin/env tsx
/**
 * ICP-R1 §4 — l'audit d'éligibilité du corpus.
 *
 *   npm run icp:audit                                   # rapport seul, n'écrit RIEN
 *   npm run icp:audit -- --prospect <uuid>              # un prospect
 *   npm run icp:audit -- --apply --as "Operator Example" # archive les verdicts déterministes
 *   npm run icp:audit -- --decide <uuid> --verdict GOOD_ICP --as "Operator Example" --reason "…"
 *
 * Le défaut est volontairement inerte. La mission demande de « produire une
 * proposition de corrections et n'appliquer que celles qui sont déterministes
 * et sourcées » : le rapport est la proposition, `--apply` archive les verdicts
 * — qui sont des lignes NOUVELLES dans un journal append-only, jamais une
 * réécriture d'un score, d'un stage ou d'un manifeste existant.
 *
 * Ce que cette commande ne fait jamais : supprimer un manifeste verrouillé,
 * changer un `stage`, recalculer un score, ou contacter qui que ce soit.
 */
import { getSql } from '@/lib/db';
import { loadConfiguredIcpProfile } from '@/lib/config/load';
import { logger } from '@/lib/logging/logger';
import {
  loadIcpInputs,
  loadLatestIcpAssessments,
  recordIcpAssessment,
} from '@/lib/pipeline/icpAssessment';
import { evaluateIcpEligibility, type IcpAssessment, type IcpVerdict } from '@/lib/pipeline/icpEligibility';

interface Args {
  prospectId: string | null;
  apply: boolean;
  as: string | null;
  decide: string | null;
  verdict: IcpVerdict | null;
  reason: string | null;
  showAll: boolean;
}

const VERDICTS: readonly IcpVerdict[] = ['GOOD_ICP', 'REVIEW_REQUIRED', 'NOT_TARGET'];

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    prospectId: null,
    apply: false,
    as: null,
    decide: null,
    verdict: null,
    reason: null,
    showAll: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--prospect':
        args.prospectId = argv[++i] ?? '';
        break;
      case '--apply':
        args.apply = true;
        break;
      case '--as':
        args.as = argv[++i] ?? '';
        break;
      case '--decide':
        args.decide = argv[++i] ?? '';
        break;
      case '--verdict': {
        const value = argv[++i] ?? '';
        if (!VERDICTS.includes(value as IcpVerdict)) {
          throw new Error(`--verdict attend ${VERDICTS.join(' | ')}, reçu « ${value} »`);
        }
        args.verdict = value as IcpVerdict;
        break;
      }
      case '--reason':
        args.reason = argv[++i] ?? '';
        break;
      case '--all':
        args.showAll = true;
        break;
      default:
        throw new Error(`option inconnue : « ${String(token)} »`);
    }
  }
  if (args.apply && (args.as === null || args.as.trim().length === 0)) {
    throw new Error('--apply exige --as "<nom>" — un verdict archivé porte le nom de qui l’a lancé');
  }
  if (args.decide !== null) {
    if (args.verdict === null) throw new Error('--decide exige --verdict');
    if (args.as === null || args.as.trim().length === 0) {
      throw new Error('--decide exige --as "<nom>" — une décision humaine porte un nom d’humain');
    }
    if (args.reason === null || args.reason.trim().length === 0) {
      throw new Error('--decide exige --reason "<motif>" — une décision sans motif n’est pas contestable');
    }
  }
  return args;
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(26)} ${value}\n`);
}

const VERDICT_LABEL: Readonly<Record<IcpVerdict, string>> = Object.freeze({
  GOOD_ICP: 'GOOD_ICP',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  NOT_TARGET: 'NOT_TARGET',
});

interface Row {
  prospectId: string;
  displayName: string;
  assessment: IcpAssessment;
}

/**
 * La décision humaine : une ligne de plus dans le journal, jamais une
 * correction de la précédente. Le verdict automatique qu'elle contredit reste
 * lisible juste à côté, avec sa date — c'est ce qui distingue « un humain a
 * tranché » de « quelqu'un a effacé ».
 */
async function runDecision(args: Args): Promise<void> {
  const sql = await getSql();
  try {
    const profile = loadConfiguredIcpProfile();
    const inputs = await loadIcpInputs(sql, [args.decide!]);
    const input = inputs[0];
    if (!input) throw new Error(`prospect ${args.decide} introuvable`);

    // Le verdict automatique est recalculé et rendu à l'écran : un humain qui
    // décide doit voir ce qu'il contredit, à l'instant où il le contredit.
    const automatic = evaluateIcpEligibility({ subject: input.subject, evidence: input.evidence, profile });

    const decision: IcpAssessment = Object.freeze({
      ...automatic,
      verdict: args.verdict!,
      reason: args.reason!,
      reasons: Object.freeze([args.reason!, `contredit le verdict déterministe « ${automatic.verdict} » : ${automatic.reason}`]),
    });

    const id = await recordIcpAssessment(sql, {
      prospectId: args.decide!,
      assessment: decision,
      decidedBy: 'human',
      assessedBy: args.as!.trim(),
    });

    process.stdout.write('\nICP-R1 — décision humaine archivée\n');
    line('prospect', `${input.subject.displayName} (${args.decide})`);
    line('verdict_deterministe', `${automatic.verdict} — ${automatic.reason}`);
    line('verdict_humain', `${args.verdict}`);
    line('motif', args.reason!);
    line('par', args.as!.trim());
    line('assessment_id', id);
    process.stdout.write('\nAucun score, stage ou manifeste modifié.\n\n');
  } finally {
    await sql.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.decide !== null) {
    await runDecision(args);
    return;
  }

  const sql = await getSql();
  try {
    const profile = loadConfiguredIcpProfile();
    const inputs = await loadIcpInputs(sql, args.prospectId === null ? undefined : [args.prospectId]);

    const rows: Row[] = [];
    for (const input of inputs) {
      rows.push({
        prospectId: input.prospectId,
        displayName: input.subject.displayName,
        assessment: evaluateIcpEligibility({ subject: input.subject, evidence: input.evidence, profile }),
      });
    }

    const previous = await loadLatestIcpAssessments(sql, rows.map((row) => row.prospectId));

    const counts: Record<IcpVerdict, number> = { GOOD_ICP: 0, REVIEW_REQUIRED: 0, NOT_TARGET: 0 };
    for (const row of rows) counts[row.assessment.verdict] += 1;

    // Les prospects dont le verdict COMPTE le plus : ceux qui portent déjà un
    // manifeste verrouillé, c'est-à-dire ceux qu'un humain a déjà déclarés
    // prêts à contacter.
    const locked = await sql.query<{ prospectId: string; manifestId: string; transport: string; recipient: string }>(
      `select prospect_id as "prospectId", id as "manifestId", transport, recipient
         from r6b_dispatch_manifests where status = 'LOCKED'`,
    );
    const lockedByProspect = new Map(locked.map((row) => [row.prospectId, row]));

    process.stdout.write('\nICP-R1 — audit d’éligibilité du corpus\n');
    line('profil', `${profile.key} v${profile.version}`);
    line('prospects évalués', String(rows.length));
    line('GOOD_ICP', String(counts.GOOD_ICP));
    line('REVIEW_REQUIRED', String(counts.REVIEW_REQUIRED));
    line('NOT_TARGET', String(counts.NOT_TARGET));
    line('mode', args.apply ? `ÉCRITURE (--as ${args.as})` : 'RAPPORT SEUL — rien n’est écrit');

    const flagged = rows
      .filter((row) => row.assessment.verdict !== 'GOOD_ICP' && row.assessment.signals.length > 0)
      .sort((a, b) => (a.assessment.verdict === 'NOT_TARGET' ? -1 : 1) - (b.assessment.verdict === 'NOT_TARGET' ? -1 : 1));

    process.stdout.write(`\n── Prospects portant au moins un signal (${flagged.length}) ──\n`);
    for (const row of flagged) {
      const lockedRow = lockedByProspect.get(row.prospectId);
      process.stdout.write(`\n[${VERDICT_LABEL[row.assessment.verdict]}] ${row.displayName}\n`);
      line('prospect_id', row.prospectId);
      line('couverture', row.assessment.coverage);
      line('sources_fortes', String(row.assessment.strongSourceCount));
      line('motif', row.assessment.reason);
      if (lockedRow) {
        line('manifeste_verrouillé', `${lockedRow.manifestId} (${lockedRow.transport} → ${lockedRow.recipient})`);
      }
      for (const signal of row.assessment.signals) {
        process.stdout.write(
          `      · [${signal.severity}/${signal.kind}] ${signal.label} — « ${signal.matched} »\n` +
            `        champ=${signal.field} evidence=${signal.evidenceId ?? '—'} source=${signal.sourceUrl ?? '—'}\n` +
            `        « ${signal.excerpt} »\n`,
        );
      }
      const before = previous.get(row.prospectId);
      if (before) line('verdict_précédent', `${before.verdict} (${before.decidedBy}, ${before.createdAt})`);
    }

    if (args.showAll) {
      process.stdout.write('\n── Tous les verdicts ──\n');
      for (const row of rows) {
        process.stdout.write(`  ${VERDICT_LABEL[row.assessment.verdict].padEnd(16)} ${row.displayName}\n`);
      }
    }

    // Les manifestes verrouillés sur un prospect désormais écarté : signalés,
    // JAMAIS supprimés. Effacer la preuve d'une erreur n'est pas la corriger.
    const lockedFlagged = flagged.filter((row) => lockedByProspect.has(row.prospectId));
    if (lockedFlagged.length > 0) {
      process.stdout.write(`\n── Manifestes verrouillés à revoir par un humain (${lockedFlagged.length}) ──\n`);
      for (const row of lockedFlagged) {
        const lockedRow = lockedByProspect.get(row.prospectId)!;
        process.stdout.write(
          `  ${VERDICT_LABEL[row.assessment.verdict].padEnd(16)} ${row.displayName} — manifeste ${lockedRow.manifestId} (${lockedRow.transport})\n`,
        );
      }
      process.stdout.write(
        '  Ces manifestes ne sont ni supprimés ni superseded par cette commande : la décision appartient à un humain.\n',
      );
    }

    if (args.apply) {
      let written = 0;
      let skipped = 0;
      for (const row of rows) {
        const before = previous.get(row.prospectId);
        // Un verdict inchangé n'est pas ré-archivé : le journal doit raconter
        // ce qui a CHANGÉ, pas répéter chaque exécution. Une décision humaine
        // antérieure n'est jamais écrasée — on ne réécrit rien, on s'abstient.
        if (before && before.verdict === row.assessment.verdict && before.profileVersion === profile.version) {
          skipped += 1;
          continue;
        }
        await recordIcpAssessment(sql, {
          prospectId: row.prospectId,
          assessment: row.assessment,
          decidedBy: 'deterministic',
          assessedBy: args.as!.trim(),
        });
        written += 1;
      }
      process.stdout.write(`\n── Écriture ──\n`);
      line('verdicts archivés', String(written));
      line('inchangés (ignorés)', String(skipped));
      logger.info('icp.audit.applied', { written, skipped, profile: profile.key, version: profile.version });
    }

    process.stdout.write('\nAucun envoi, aucun manifeste créé ou supprimé, aucun score modifié.\n\n');
    if (counts.NOT_TARGET > 0) process.exitCode = 0;
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
