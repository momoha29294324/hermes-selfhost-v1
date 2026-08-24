#!/usr/bin/env tsx
/**
 * IG-R1 §1 — état de la session persistante, et son bootstrap manuel.
 *
 *   npm run ig:session                       # constater l'état, sans rien ouvrir de plus
 *   npm run ig:session -- --bootstrap        # fenêtre visible, un opérateur se connecte lui-même
 *   npm run ig:session -- --bootstrap --wait-ms 600000
 *
 * Ce que le bootstrap ne fait pas : saisir un identifiant, saisir un mot de
 * passe, cliquer, résoudre un CAPTCHA, franchir un challenge. Il ouvre une
 * fenêtre sur instagram.com et attend qu'un humain s'y connecte, puis constate.
 * Aucun identifiant Instagram n'existe dans ce dépôt — ni en `.env`, ni en
 * configuration, ni en argument de commande, et il ne doit jamais y en avoir.
 *
 * Le profil navigateur (donc les cookies de session) vit sous `var/`, ignoré
 * par Git. Rien n'est journalisé de son contenu : seule la PRÉSENCE d'un
 * cookie de session est constatée.
 */
import { hostname } from 'node:os';
import { getSql } from '@/lib/db';
import { loadInstagramRail } from '@/lib/config/load';
import { recordBrowserSession } from '@/lib/instagram/events';
import { bootstrapInstagramSession, PlaywrightInstagramRail } from '@/lib/instagram/playwrightRail';
import { isHardStopSessionState } from '@/lib/instagram/types';

const DEFAULT_WAIT_MS = 300_000;

function parseArgs(argv: readonly string[]): { bootstrap: boolean; waitMs: number } {
  let bootstrap = false;
  let waitMs = DEFAULT_WAIT_MS;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--bootstrap') bootstrap = true;
    else if (token === '--wait-ms') waitMs = Number.parseInt(argv[++i] ?? '', 10);
    else throw new Error(`option inconnue : « ${String(token)} »`);
  }
  if (!Number.isFinite(waitMs) || waitMs < 10_000 || waitMs > 1_800_000) {
    throw new Error('--wait-ms attend un entier entre 10000 et 1800000');
  }
  return { bootstrap, waitMs };
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(20)} ${value}\n`);
}

/** L'action exacte à donner à un humain, selon l'état constaté. */
function nextAction(state: string): string {
  switch (state) {
    case 'SESSION_READY':
      return 'aucune — la session est utilisable.';
    case 'LOGIN_REQUIRED':
      return 'lancer « npm run ig:session -- --bootstrap » et se connecter à la main dans la fenêtre ouverte.';
    case 'SESSION_EXPIRED':
      return 'relancer « npm run ig:session -- --bootstrap » : la session existante n’est plus acceptée.';
    case 'SESSION_WRONG_ACCOUNT':
      // Se reconnecter SANS écarter le profil ramène au même compte : Instagram
      // rouvre la session déjà présente. L'ordre des deux gestes est donc la
      // moitié de l'instruction, et l'omettre la rendrait inopérante.
      return (
        'STOP. La session est valide mais appartient à un AUTRE compte. ' +
        'Écarter le profil (« mv var/instagram/profile var/instagram/profile.wrong-account-$(date -u +%Y%m%dT%H%M%SZ) »), ' +
        'puis relancer « npm run ig:session -- --bootstrap » et se connecter avec le compte de ce dépôt.'
      );
    case 'CHALLENGE':
    case 'CAPTCHA':
    case 'BLOCKED':
      return 'STOP. Traiter la demande d’Instagram à la main, dans un navigateur ordinaire. Aucun contournement, aucune relance automatique.';
    default:
      return 'état indéterminé — ne rien relancer automatiquement, constater à la main.';
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadInstagramRail();
  const workerId = `${hostname()}/pid-${process.pid}`;
  const sql = await getSql();

  try {
    if (args.bootstrap) {
      process.stdout.write('\nIG-R1 — bootstrap manuel de session\n');
      process.stdout.write('  Une fenêtre Chromium va s’ouvrir sur instagram.com.\n');
      process.stdout.write('  Connectez-vous VOUS-MÊME. Ce programme ne saisit rien et ne clique nulle part.\n\n');

      const result = await bootstrapInstagramSession({ config, workerId, waitMs: args.waitMs });
      await recordBrowserSession(sql, {
        workerId,
        profileLabel: config.session.profileLabel,
        headless: false,
        state: result.state,
        detail: result.detail,
      });

      line('state', result.state);
      line('detail', result.detail);
      line('profile_dir', result.profileDir);
      process.stdout.write(`\n  Action : ${nextAction(result.state)}\n\n`);
      if (isHardStopSessionState(result.state)) process.exitCode = 2;
      else if (result.state !== 'SESSION_READY') process.exitCode = 1;
      return;
    }

    const rail = new PlaywrightInstagramRail({ config, screenshotDir: null, workerId });
    try {
      const status = await rail.ensureSession();
      await recordBrowserSession(sql, {
        workerId,
        profileLabel: status.profileLabel,
        headless: status.headless,
        state: status.state,
        detail: status.detail,
      });

      process.stdout.write('\nIG-R1 — session persistante\n');
      line('state', status.state);
      line('detail', status.detail);
      line('profile_label', status.profileLabel);
      line('profile_dir', config.session.profileDir);
      line('headless', String(status.headless));
      process.stdout.write(`\n  Action : ${nextAction(status.state)}\n\n`);
      if (isHardStopSessionState(status.state)) process.exitCode = 2;
      else if (status.state !== 'SESSION_READY') process.exitCode = 1;
    } finally {
      await rail.close();
    }
  } finally {
    await sql.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
