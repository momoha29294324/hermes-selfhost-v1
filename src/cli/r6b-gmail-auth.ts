#!/usr/bin/env tsx
/**
 * R6B-D1.2 — inscription OAuth Gmail (lecture seule), une fois, interactive.
 *
 *   npm run r6b:gmail:auth -- --client-json ~/Downloads/client_secret_....json
 *   npm run r6b:gmail:auth -- --client-json <chemin> --write-env   # écrit .env sans invite
 *
 * Ce que fait cette commande, et seulement cela :
 *
 *   1. lit le JSON client "Desktop" téléchargé depuis Google Cloud Console —
 *      jamais son contenu n'est journalisé ;
 *   2. lance le flux OAuth natif recommandé par Google pour les applications
 *      Desktop : redirection en boucle locale (`http://127.0.0.1:<port>`,
 *      port choisi dynamiquement — le flux "out of band" est déprécié), PKCE
 *      S256, portée UNIQUE `gmail.readonly`, `access_type=offline` +
 *      `prompt=consent` pour obtenir un `refresh_token` ;
 *   3. vérifie que la portée accordée ne contient AUCUNE portée d'écriture
 *      (`assertReadOnlyScope`, partagée avec le fournisseur réel) ;
 *   4. vérifie que le compte qui a consenti est EXACTEMENT celui attendu, par
 *      un appel `users.getProfile` — couvert par `gmail.readonly`, aucune
 *      portée supplémentaire n'est demandée pour cette vérification ;
 *   5. si l'une des deux vérifications échoue, révoque le jeton obtenu avant
 *      de s'arrêter : un jeton valide pour la mauvaise identité ne doit pas
 *      traîner ;
 *   6. demande confirmation avant d'écrire quoi que ce soit dans `.env`
 *      (interactive sur un vrai terminal, ou le drapeau explicite
 *      `--write-env` sinon — comme `--live` pour `r6b-dispatch.ts`), et
 *      n'écrit jamais une valeur de secret sur la sortie standard.
 *
 * Cette commande ne lit AUCUN message Gmail, n'envoie rien, ne modifie rien
 * dans la boîte. Le seul appel Gmail qu'elle fait est `users.getProfile`,
 * une lecture de métadonnées de compte, pas de courrier.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { HttpClient } from '@/lib/http/client';
import {
  GMAIL_ENV_KEYS,
  GMAIL_READONLY_SCOPE,
  GmailScopeError,
  assertReadOnlyScope,
} from '@/lib/inbound/gmailProvider';
import {
  GmailOAuthBootstrapError,
  assertAuthorizedAccount,
  assertRefreshTokenPresent,
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchAuthorizedEmail,
  generatePkce,
  generateState,
  gitignoreCoversEnv,
  parseInstalledClientJson,
  revokeToken,
  upsertEnvVars,
  type OAuthTokens,
} from '@/lib/oauth/gmailOAuthBootstrap';

/**
 * Le SEUL compte dont cette instance est autorisée à lire la boîte Gmail.
 *
 * Il est déclaré une fois, dans l'environnement, et relu à chaque autorisation :
 * si le compte qui consent à l'écran n'est pas celui-là, le jeton est révoqué
 * plutôt que conservé. Ce n'est pas une commodité — c'est ce qui empêche
 * d'attacher par erreur la boîte personnelle de quelqu'un à un rail de
 * prospection.
 *
 * Absent, la commande REFUSE de démarrer : lire une boîte « celle qu'on
 * trouvera » n'est pas un défaut acceptable.
 */
function expectedGmailAccount(): string {
  const raw = process.env['OUTBOUND_GMAIL_ACCOUNT'];
  const trimmed = raw === undefined ? '' : raw.trim();
  if (trimmed.length === 0) {
    throw new GmailAuthArgError(
      'OUTBOUND_GMAIL_ACCOUNT est absent. Déclarer l’adresse Gmail exacte que cette instance a le droit de lire ' +
        '(voir .env.example), puis relancer.',
    );
  }
  return trimmed;
}

const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

class GmailAuthArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailAuthArgError';
  }
}

interface Args {
  readonly clientJsonPath: string;
  readonly writeEnv: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let clientJsonPath: string | null = null;
  let writeEnv = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--write-env') {
      writeEnv = true;
      continue;
    }
    const next = argv[i + 1];
    if (arg === '--client-json') {
      if (!next) throw new GmailAuthArgError('--client-json attend un chemin');
      clientJsonPath = next;
      i += 1;
      continue;
    }
    throw new GmailAuthArgError(`option inconnue : ${arg}`);
  }
  if (clientJsonPath === null) {
    throw new GmailAuthArgError(
      '--client-json <chemin> est requis — le chemin local du JSON client "Desktop" téléchargé depuis Google Cloud Console',
    );
  }
  return { clientJsonPath, writeEnv };
}

function out(message: string): void {
  process.stdout.write(`${message}\n`);
}

function err(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Ouvre le navigateur par défaut si possible. Best-effort : l'URL est toujours imprimée en secours. */
function tryOpenBrowser(url: string): void {
  if (process.platform !== 'darwin') return;
  execFile('open', [url], () => {
    // Échec silencieux : l'URL affichée reste le chemin garanti.
  });
}

interface CallbackResult {
  readonly code: string;
  readonly state: string;
}

/**
 * Démarre un serveur HTTP en boucle locale sur un port éphémère et attend
 * exactement une redirection Google. Se ferme dans tous les cas — succès,
 * refus de consentement, ou expiration du délai.
 */
async function awaitOAuthCallback(): Promise<{ redirectUri: string; result: Promise<CallbackResult> }> {
  let resolveResult!: (value: CallbackResult) => void;
  let rejectResult!: (reason: Error) => void;
  const resultPromise = new Promise<CallbackResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/oauth2callback') {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      error
        ? '<html><body>Consentement refusé. Vous pouvez fermer cet onglet.</body></html>'
        : '<html><body>Autorisation reçue. Vous pouvez fermer cet onglet.</body></html>',
    );

    clearTimeout(timeout);
    server.close();

    if (error) {
      rejectResult(new GmailOAuthBootstrapError('token_exchange_failed', `consentement refusé par Google (${error})`));
      return;
    }
    if (!code || !state) {
      rejectResult(new GmailOAuthBootstrapError('token_exchange_failed', 'redirection sans code ou sans state'));
      return;
    }
    resolveResult({ code, state });
  });

  const timeout = setTimeout(() => {
    server.close();
    rejectResult(new GmailOAuthBootstrapError('token_exchange_failed', 'délai de consentement dépassé (5 minutes)'));
  }, CONSENT_TIMEOUT_MS);
  timeout.unref();

  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const address = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;

  return { redirectUri, result: resultPromise };
}

/**
 * `--write-env` est l'équivalent, pour cette commande, du `--live` de
 * `r6b-dispatch.ts` : un geste explicite sur la ligne de commande vaut
 * confirmation, y compris quand `stdin` n'est pas un vrai terminal (le cas
 * quand cette commande est lancée par un outil qui pilote le shell). Sans ce
 * drapeau, un terminal interactif pose la question ; sans terminal ni
 * drapeau, `.env` n'est jamais touché.
 */
async function confirmEnvWrite(writeEnvFlag: boolean): Promise<boolean> {
  if (writeEnvFlag) return true;
  if (!process.stdin.isTTY) {
    err('\nSession non interactive et --write-env absent : .env NON écrit automatiquement.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('\nÉcrire ces 4 variables dans .env maintenant ? [y/N] ');
    return ['y', 'yes', 'o', 'oui'].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

/** Best-effort : une révocation qui échoue ne doit pas masquer l'erreur qui l'a déclenchée. */
async function safeRevoke(http: HttpClient, token: string): Promise<void> {
  try {
    await revokeToken(http, token);
    out('  jeton révoqué auprès de Google.');
  } catch (revokeError) {
    err(`  révocation du jeton échouée : ${revokeError instanceof Error ? revokeError.message : String(revokeError)}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const path = resolve(args.clientJsonPath);
  if (!existsSync(path)) {
    throw new GmailAuthArgError(`fichier introuvable : ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  const parsedClient = parseInstalledClientJson(raw);
  if (!parsedClient.ok) {
    err(`\nJSON CLIENT REFUSÉ — ${parsedClient.reason}\n`);
    process.exitCode = 1;
    return;
  }
  const client = parsedClient.client;
  out('Client OAuth "Desktop" accepté (contenu non journalisé).');

  const pkce = generatePkce();
  const state = generateState();
  const { redirectUri, result } = await awaitOAuthCallback();

  const authUrl = buildAuthUrl({
    authUri: client.authUri,
    clientId: client.clientId,
    redirectUri,
    codeChallenge: pkce.challenge,
    state,
    loginHint: expectedGmailAccount(),
  });

  out(`\nPortée demandée : ${GMAIL_READONLY_SCOPE} (et seulement celle-ci)`);
  out(`Compte attendu  : ${expectedGmailAccount()}`);
  out('\nOuvrez cette URL pour consentir (tentative d’ouverture automatique du navigateur) :');
  out(authUrl);
  tryOpenBrowser(authUrl);

  const callback = await result;
  if (callback.state !== state) {
    throw new GmailOAuthBootstrapError('token_exchange_failed', 'state renvoyé par Google différent de celui envoyé — abandon');
  }

  const http = new HttpClient();
  const tokens: OAuthTokens = await exchangeCodeForTokens({
    http,
    tokenUri: client.tokenUri,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    code: callback.code,
    codeVerifier: pkce.verifier,
    redirectUri,
  });

  try {
    assertReadOnlyScope(tokens.scope);
  } catch (scopeError) {
    err(`\nPORTÉE REFUSÉE — ${scopeError instanceof Error ? scopeError.message : String(scopeError)}`);
    await safeRevoke(http, tokens.accessToken);
    process.exitCode = 1;
    return;
  }

  let refreshToken: string;
  try {
    refreshToken = assertRefreshTokenPresent(tokens);
  } catch (missingRefreshError) {
    err(
      `\nAUCUN REFRESH_TOKEN — ${missingRefreshError instanceof Error ? missingRefreshError.message : String(missingRefreshError)}`,
    );
    await safeRevoke(http, tokens.accessToken);
    process.exitCode = 1;
    return;
  }

  const authorizedEmail = await fetchAuthorizedEmail({ http, accessToken: tokens.accessToken });
  try {
    assertAuthorizedAccount(authorizedEmail, expectedGmailAccount());
  } catch (accountError) {
    err(`\nCOMPTE REFUSÉ — ${accountError instanceof Error ? accountError.message : String(accountError)}`);
    await safeRevoke(http, refreshToken);
    process.exitCode = 1;
    return;
  }

  out(`\nCompte vérifié   : ${authorizedEmail}`);
  out(`Portée accordée  : ${tokens.scope}`);
  out('Refresh token    : obtenu (valeur non affichée)');

  const envUpdates: Record<string, string> = {
    [GMAIL_ENV_KEYS.clientId]: client.clientId,
    [GMAIL_ENV_KEYS.clientSecret]: client.clientSecret,
    [GMAIL_ENV_KEYS.refreshToken]: refreshToken,
    [GMAIL_ENV_KEYS.inboxAddress]: expectedGmailAccount(),
  };

  const shouldWrite = await confirmEnvWrite(args.writeEnv);
  if (!shouldWrite) {
    out('\n.env NON modifié. Variables à renseigner manuellement (valeurs jamais affichées ici) :');
    for (const key of Object.keys(envUpdates)) out(`  ${key}=`);
    out('\nRelancez cette commande pour réessayer l’écriture automatique.');
    return;
  }

  const gitignorePath = resolve(process.cwd(), '.gitignore');
  const gitignoreText = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  if (!gitignoreCoversEnv(gitignoreText)) {
    err(
      '\n.env N’EST PAS IGNORÉ PAR GIT dans ce dépôt — écriture refusée par précaution.\n' +
        'Ajoutez une ligne ".env" à .gitignore, puis relancez cette commande.',
    );
    process.exitCode = 1;
    return;
  }

  const envPath = resolve(process.cwd(), '.env');
  const existingEnv = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  writeFileSync(envPath, upsertEnvVars(existingEnv, envUpdates), 'utf8');

  out(`\n.env mis à jour : ${Object.keys(envUpdates).join(', ')}`);
  out('Valeurs jamais affichées. .env reste ignoré par Git.');
  out('\nAucun envoi, aucune lecture de message Gmail, aucune modification de boîte.');
}

main().catch((error: unknown) => {
  if (error instanceof GmailAuthArgError) {
    err(`\n${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof GmailScopeError || error instanceof GmailOAuthBootstrapError) {
    err(`\n${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  err(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
