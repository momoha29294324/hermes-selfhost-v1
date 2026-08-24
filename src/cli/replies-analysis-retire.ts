#!/usr/bin/env tsx
/**
 * HERMES-ACTIVE-ANALYSIS-VERSION-CONFLICT-R1 — la seule porte pour écarter une
 * analyse rendue par un runtime périmé.
 *
 *   npm run replies:analysis:retire -- --inbound <uuid> --as "Prénom Nom" --reason "<motif>"
 *   npm run replies:analysis:retire -- --inbound <uuid> --as "…" --reason "…" --apply
 *   npm run replies:analysis:retire -- --inbound <uuid> --as "…" --reason "…" --reinstate <uuid> --apply
 *
 * SANS `--apply`, rien n'est écrit : la commande dit ce qu'elle ferait et sort.
 * C'est le défaut, et il est du bon côté — une commande de réparation qui
 * réparerait au premier essai serait une commande qu'on lance par erreur.
 *
 * Ce que cette commande NE PEUT PAS faire, et pas parce qu'un drapeau est à 0 :
 * elle n'importe aucun provider d'envoi, aucun rail Instagram, aucun client
 * Gmail, et ne sait pas lever l'arrêt global. Elle n'écarte JAMAIS une analyse
 * rendue sous la version canonique — `retireStaleAnalysis` refuse, et ce refus
 * est du code, pas une consigne. Elle refuse aussi tout message sur lequel un
 * plan porte déjà une tentative d'effet.
 *
 * Après elle : `npm run r6b:replies:process -- --inbound <uuid>` relit le tour
 * avec le code courant.
 */
import { getSql } from '@/lib/db';
import { REPLY_CLASSIFIER_PROMPT_VERSION } from '@/lib/replies/classifier';
import { retireStaleAnalysis } from '@/lib/replies/analysisRetirement';

class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Args {
  readonly inbound: string;
  readonly operator: string;
  readonly reason: string;
  readonly reinstate: string | null;
  readonly apply: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let inbound: string | null = null;
  let operator: string | null = null;
  let reason: string | null = null;
  let reinstate: string | null = null;
  let apply = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const next = argv[i + 1];
    const value = (label: string): string => {
      if (next === undefined || next.startsWith('--')) throw new ArgError(`${label} attend une valeur`);
      i += 1;
      return next;
    };
    if (arg === '--inbound') {
      inbound = value('--inbound');
      if (!UUID.test(inbound)) throw new ArgError('--inbound attend un UUID');
      continue;
    }
    if (arg === '--as') {
      operator = value('--as');
      continue;
    }
    if (arg === '--reason') {
      reason = value('--reason');
      continue;
    }
    if (arg === '--reinstate') {
      reinstate = value('--reinstate');
      if (!UUID.test(reinstate)) throw new ArgError('--reinstate attend un UUID');
      continue;
    }
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    throw new ArgError(`option inconnue : ${arg}`);
  }

  if (inbound === null) throw new ArgError('--inbound est obligatoire');
  if (operator === null) throw new ArgError('--as "<Prénom Nom>" est obligatoire — un geste porte un nom');
  if (reason === null) throw new ArgError('--reason "<motif>" est obligatoire — il est conservé au journal');

  return { inbound, operator, reason, reinstate, apply };
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(26)} ${value}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = await getSql();
  try {
    const result = await retireStaleAnalysis(sql, {
      inboundMessageId: args.inbound,
      operator: args.operator,
      reason: args.reason,
      reinstateAnalysisId: args.reinstate,
      apply: args.apply,
    });

    process.stdout.write('\nR6B-D2 — ÉCARTER UNE ANALYSE DE VERSION PÉRIMÉE\n');
    line('message entrant', args.inbound);
    line('opérateur', args.operator);
    line('version canonique', REPLY_CLASSIFIER_PROMPT_VERSION);

    if (result.outcome === 'REFUSED') {
      line('issue', `REFUS — ${result.refusal}`);
      process.stdout.write(`\n  ${result.detail}\n\n`);
      process.exitCode = 3;
      return;
    }

    line('issue', result.outcome === 'APPLIED' ? 'APPLIQUÉ' : 'SIMULATION (aucune écriture)');
    line('analyse écartée', `${result.retired.id} (${result.retired.promptVersion})`);
    line(
      'analyse réinstallée',
      result.reinstated === null
        ? 'aucune — le retraitement en écrira une neuve'
        : `${result.reinstated.id} (${result.reinstated.promptVersion}, ` +
          `${result.reinstated.classification} ${result.reinstated.confidence.toFixed(2)})`,
    );
    line('lien de supersession dénoué', result.unlinkedSupersededBy ?? 'aucun');
    line('journal', result.journalId ?? 'aucun (simulation)');

    if (result.outcome === 'PLANNED') {
      process.stdout.write('\n  Rien n’a été écrit. Relancer avec --apply pour appliquer ce geste.\n\n');
      return;
    }
    process.stdout.write(
      `\n  Relire le tour avec le code courant :\n` +
        `    npm run r6b:replies:process -- --inbound ${args.inbound}\n\n` +
        '  Aucun envoi, aucun plan, aucun effet : cette commande n’en a pas les moyens.\n\n',
    );
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof ArgError ? 1 : 2;
});
