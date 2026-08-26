#!/usr/bin/env tsx
import { getSql } from '@/lib/db';
import { readCodeRevision } from '@/lib/inbound/codeRevision';
import {
  findLockedManifestsByHandle,
  retireDispatchIntent,
  type RetireManifestResult,
} from '@/lib/instagram/manifestRetirement';

/**
 * HERMES-MANIFEST-OPERATOR-RETIREMENT-R1 — la seule porte pour retirer une
 * intention de dispatch avant tout effet extérieur.
 *
 *   npm run ig:manifest:retire -- --manifest <uuid> --as "<nom>" --reason "<motif>"
 *   npm run ig:manifest:retire -- --handle wash.lh  --as "<nom>" --reason "<motif>"
 *   … --apply                                        # écrit réellement
 *
 * SIMULATION par défaut : sans `--apply`, rien n'est écrit et la commande
 * affiche le message qui ne partirait plus. C'est le même défaut que
 * `replies:analysis:retire` et `ig:queue:invalidate`, et pour la même raison —
 * un geste irréversible se lit avant de se poser.
 *
 * Ce que cette commande NE FAIT PAS : elle n'envoie rien, n'importe aucun
 * provider ni aucun rail, n'ouvre aucun navigateur, ne supprime aucune ligne,
 * et ne sait pas lever l'arrêt global — elle ne l'interroge même pas.
 */

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const operator = arg('as');
  const reason = arg('reason');
  const manifestArg = arg('manifest');
  const handleArg = arg('handle');

  if (operator === null || operator.trim().length < 2) {
    throw new Error('--as "<nom de l’opérateur>" est obligatoire : un retrait porte le nom de qui le décide.');
  }
  if (reason === null || reason.trim().length < 8) {
    throw new Error('--reason "<motif>" est obligatoire : un retrait sans motif écrit est illisible dans six mois.');
  }
  if ((manifestArg === null) === (handleArg === null)) {
    throw new Error('exactement UNE cible : --manifest <uuid> OU --handle <compte>.');
  }

  const sql = await getSql();
  try {
    let manifestId = manifestArg;
    if (manifestId === null && handleArg !== null) {
      const found = await findLockedManifestsByHandle(sql, handleArg);
      if (found.length === 0) {
        throw new Error(`aucun manifeste LOCKED ne vise @${handleArg.replace(/^@/, '')}`);
      }
      if (found.length > 1) {
        throw new Error(
          `${String(found.length)} manifestes LOCKED visent @${handleArg.replace(/^@/, '')} — ` +
            `nommer celui qu’on retire : ${found.join(', ')}`,
        );
      }
      manifestId = found[0]!;
    }

    const result = await retireDispatchIntent(sql, {
      manifestId: manifestId!,
      operator,
      reason,
      apply,
      codeRevision: readCodeRevision(process.cwd()),
    });

    render(result, apply);
    if (result.outcome === 'REFUSED') process.exitCode = 1;
  } finally {
    await sql.close();
  }
}

function render(result: RetireManifestResult, apply: boolean): void {
  out('');
  out(`HERMES-MANIFEST-OPERATOR-RETIREMENT-R1 — ${apply ? 'APPLIQUÉ' : 'SIMULATION'}`);
  out('');

  if (result.outcome === 'REFUSED') {
    out(`  REFUS   ${result.refusal}`);
    out(`  ${result.detail}`);
    out('');
    return;
  }

  const i = result.intent;
  out(`  manifeste          ${i.manifestId}  (${i.previousManifestStatus})`);
  out(`  job                ${i.jobId ?? '—'}${i.previousJobStatus === null ? '' : `  (${i.previousJobStatus})`}`);
  out(`  prospect           ${i.businessName} — @${i.handle}`);
  out(`  révision de rédaction  ${i.generationCodeRevision ?? 'non observée'}`);
  out(`  empreinte du texte     ${i.retiredTextSha256}`);
  out('');
  out('  message retiré :');
  for (const line of i.retiredText.split('\n')) out(`    ${line}`);
  out('');
  out(`  ${result.outcome} — ${result.detail}`);
  if (result.outcome !== 'ALREADY_RETIRED' && result.retirementId !== null) {
    out(`  journal            ${result.retirementId}`);
  }
  if (result.outcome === 'PLANNED') {
    out('');
    out('  Rien n’a été écrit. Pour appliquer, rejouer la même commande avec --apply.');
  }
  out('');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
