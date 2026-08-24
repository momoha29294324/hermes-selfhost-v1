#!/usr/bin/env tsx
/**
 * R6B-D2.1 §3 / §14 — la vérification d'un sous-compte CRM, en lecture seule.
 *
 *   npm run r6b:crm:verify                                  # observe, ne confirme rien
 *   npm run r6b:crm:verify -- --pipeline <id>                # quand il y en a plusieurs
 *   npm run r6b:crm:verify -- --confirm --as "un opérateur"       # confirme, une fois
 *
 * Sans `--confirm`, la commande ne fait que LIRE chez le fournisseur : le
 * sous-compte, ses pipelines, ses étapes, ses champs personnalisés. Elle
 * conserve localement les identifiants d'étape (§3) et propose une
 * correspondance état → étape. La destination reste `UNCONFIRMED`, donc aucune
 * projection n'est possible.
 *
 * `--confirm` est la SEULE porte vers une écriture ultérieure. Elle exige
 * `--as <nom>` : une destination que personne n'a nommément validée est
 * exactement ce que la mission interdit. Elle ne crée toujours ni contact, ni
 * opportunité, ni note — elle autorise seulement une projection future.
 */
import { getSql } from '@/lib/db';
import { CRM_ENV_KEYS, CRM_ADAPTERS, resolveCrmDestination } from '@/lib/crm/resolve';
import { verifyCrmDestination, type VerifyResult } from '@/lib/crm/verify';
import { env } from '@/lib/env';

class VerifyArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifyArgError';
  }
}

interface VerifyArgs {
  readonly pipelineId: string | null;
  readonly confirm: boolean;
  readonly confirmedBy: string | null;
  readonly note: string | null;
}

function parseArgs(argv: readonly string[]): VerifyArgs {
  let pipelineId: string | null = null;
  let confirm = false;
  let confirmedBy: string | null = null;
  let note: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '--pipeline') {
      if (!next) throw new VerifyArgError('--pipeline attend un identifiant');
      pipelineId = next;
      i += 1;
      continue;
    }
    if (arg === '--as') {
      if (!next) throw new VerifyArgError('--as attend un nom');
      confirmedBy = next;
      i += 1;
      continue;
    }
    if (arg === '--note') {
      if (!next) throw new VerifyArgError('--note attend un texte');
      note = next;
      i += 1;
      continue;
    }
    if (arg === '--confirm') {
      confirm = true;
      continue;
    }
    throw new VerifyArgError(`option inconnue : ${arg}`);
  }

  if (confirm && (confirmedBy === null || confirmedBy.trim().length === 0)) {
    throw new VerifyArgError(
      '--confirm exige --as "<votre nom>" : une destination CRM que personne n’a nommément\n' +
        'confirmée ne peut pas recevoir de prospects Hermes.',
    );
  }

  return { pipelineId, confirm, confirmedBy, note };
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(26)} ${value}\n`);
}

function report(result: VerifyResult, confirmRequested: boolean): void {
  process.stdout.write('\nR6B-D2.1 — VÉRIFICATION CRM (lecture seule chez le fournisseur)\n');
  line('sous-compte', `${result.probe.locationName ?? '(nom non rendu)'} (${result.probe.locationId})`);
  line('pipelines vus', String(result.probe.pipelines.length));
  line('champs personnalisés vus', String(result.probe.customFields.length));
  line(
    'pipeline retenu',
    result.pipeline === null ? 'AUCUN' : `${result.pipeline.pipelineName} (${result.pipeline.pipelineId})`,
  );

  if (result.pipeline !== null) {
    process.stdout.write('\n  ÉTAPES OBSERVÉES (identifiants conservés localement)\n');
    for (const stage of result.pipeline.stages) {
      process.stdout.write(`    ${String(stage.position ?? '?').padStart(2)}. ${stage.stageName} [${stage.stageId}]\n`);
    }
  }

  process.stdout.write('\n  CORRESPONDANCE PROPOSÉE (état commercial → étape)\n');
  for (const proposal of result.proposals) {
    process.stdout.write(
      `    ${proposal.state.padEnd(16)} → ${
        proposal.stage === null ? `INTROUVABLE (« ${proposal.label} »)` : `${proposal.stage.stageName} [${proposal.stage.stageId}]`
      }\n`,
    );
  }
  process.stdout.write('    REVIEW_REQUIRED  → aucune, par conception (§6)\n');

  const mapped = Object.entries(result.fieldMap);
  process.stdout.write(`\n  CHAMPS PERSONNALISÉS RECONNUS : ${mapped.length}\n`);
  for (const [field, binding] of mapped) process.stdout.write(`    ${field.padEnd(22)} ${binding.key}\n`);

  if (result.blockers.length > 0) {
    process.stdout.write('\n  À CORRIGER AVANT DE POUVOIR CONFIRMER\n');
    for (const blocker of result.blockers) process.stdout.write(`    - ${blocker}\n`);
  }

  process.stdout.write(`\n  STATUT DE LA DESTINATION : ${result.destination.status}\n`);
  if (result.confirmed) {
    process.stdout.write(
      `  Confirmée par ${result.destination.confirmedBy}. Les projections en attente peuvent\n` +
        '  désormais être appliquées avec « npm run r6b:crm:sync -- --apply ».\n',
    );
  } else if (confirmRequested) {
    process.stdout.write('  NON confirmée : corriger les points ci-dessus, puis relancer avec --confirm.\n');
  } else {
    process.stdout.write(
      '  Observation seulement. Aucune projection n’est possible tant que la destination\n' +
        '  n’est pas confirmée : relancer avec « --confirm --as "<votre nom>" » APRÈS avoir\n' +
        '  vérifié que ce sous-compte appartient bien à Hermes.\n',
    );
  }

  process.stdout.write(
    '\n  Aucun contact, aucune opportunité, aucune note n’a été créée chez le fournisseur.\n' +
      '  Aucun message n’a été envoyé.\n\n',
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = await getSql();

  try {
    const providerName = (env(CRM_ENV_KEYS.provider) ?? '').trim();
    const locationId = (env(CRM_ENV_KEYS.locationId) ?? '').trim();
    const factory = CRM_ADAPTERS[providerName];

    if (providerName.length === 0 || locationId.length === 0 || factory === undefined) {
      // La résolution complète dit exactement ce qui manque, et le dit sans
      // divulguer la moindre valeur.
      const resolution = await resolveCrmDestination(sql);
      process.stderr.write(
        `\nImpossible de vérifier : ${resolution.configured ? 'configuration incohérente' : resolution.reason}\n\n`,
      );
      process.exitCode = 1;
      return;
    }

    const built = factory();
    if (!built.ok) {
      process.stderr.write(`\nIdentifiants absents : ${built.missing.join(', ')}\n\n`);
      process.exitCode = 1;
      return;
    }

    const result = await verifyCrmDestination(sql, built.provider, locationId, {
      ...(args.pipelineId === null ? {} : { pipelineId: args.pipelineId }),
      ...(args.confirm && args.confirmedBy !== null ? { confirmedBy: args.confirmedBy } : {}),
      ...(args.note === null ? {} : { note: args.note }),
    });
    report(result, args.confirm);
    if (args.confirm && !result.confirmed) process.exitCode = 2;
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof VerifyArgError) {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
