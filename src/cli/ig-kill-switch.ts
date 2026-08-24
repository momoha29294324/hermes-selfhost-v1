#!/usr/bin/env tsx
/**
 * IG-R1 §5 — l'arrêt global Instagram.
 *
 *   npm run ig:kill-switch                                           # lire
 *   npm run ig:kill-switch -- --engage  --as "<nom>" --reason "..."  # armer
 *   npm run ig:kill-switch -- --release --as "<nom>" --reason "..."  # lever
 *
 * L'arrêt est armé par défaut : tant qu'aucune ligne `ig_kill_switch` n'existe,
 * le rail refuse tout travail Instagram. Le lever demande donc une écriture
 * explicite, nominative et motivée — jamais une variable d'environnement, qui
 * se glisserait dans un `.env` sans laisser de trace de qui l'a décidé.
 *
 * Lever l'arrêt n'autorise AUCUN envoi : aucun adapter LIVE Instagram n'existe
 * dans ce dépôt. Cela autorise seulement un DRY-RUN à ouvrir un navigateur.
 */
import { getSql } from '@/lib/db';
import { loadKillSwitch, setKillSwitch } from '@/lib/instagram/safety';

interface Args {
  action: 'read' | 'engage' | 'release';
  as: string;
  reason: string;
}

function parseArgs(argv: readonly string[]): Args {
  let action: Args['action'] = 'read';
  let as = '';
  let reason = '';
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--engage') action = 'engage';
    else if (token === '--release') action = 'release';
    else if (token === '--as') as = argv[++i] ?? '';
    else if (token === '--reason') reason = argv[++i] ?? '';
    else throw new Error(`option inconnue : « ${String(token)} »`);
  }
  if (action !== 'read') {
    if (as.trim().length === 0) throw new Error('--as "<nom>" est obligatoire — un arrêt se positionne au nom de quelqu’un');
    if (reason.trim().length === 0) throw new Error('--reason "<motif>" est obligatoire');
  }
  return { action, as: as.trim(), reason: reason.trim() };
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(20)} ${value}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sql = await getSql();
  try {
    const state =
      args.action === 'read'
        ? await loadKillSwitch(sql)
        : await setKillSwitch(sql, { engaged: args.action === 'engage', setBy: args.as, reason: args.reason });

    process.stdout.write('\nIG-R1 — arrêt global Instagram\n');
    line('engaged', String(state.engaged));
    line('source', state.fromDefault ? 'défaut (aucune ligne) — fail-closed' : 'décision explicite');
    line('set_by', state.setBy ?? '—');
    line('reason', state.reason ?? '—');
    line('updated_at', state.updatedAt ?? '—');
    process.stdout.write(
      state.engaged
        ? '\nAucun travail Instagram n’est autorisé, file pleine ou non.\n\n'
        : '\nUn DRY-RUN peut ouvrir un navigateur. Aucun envoi n’est possible pour autant : ' +
            'aucun adapter LIVE Instagram n’existe dans ce dépôt.\n\n',
    );
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
