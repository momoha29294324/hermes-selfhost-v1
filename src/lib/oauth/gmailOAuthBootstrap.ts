/**
 * R6B-D1.2 — logique pure de l'inscription OAuth Gmail (lecture seule).
 *
 * Tout ce fichier est sans effet de bord réseau : chaque fonction reçoit ce
 * dont elle a besoin (un `HttpClient` déjà construit, un texte de JSON déjà
 * lu) et ne construit jamais elle-même de transport. C'est ce qui permet de
 * le tester sans jamais consentir à un vrai flux OAuth ni toucher une vraie
 * boîte — exactement la séparation déjà en place dans `gmailProvider.ts`.
 *
 * Rien ici n'imprime ni ne journalise une valeur de secret (`client_secret`,
 * `access_token`, `refresh_token`, code d'autorisation). Les fonctions
 * renvoient ces valeurs à l'appelant ; c'est à l'appelant (le CLI) de ne
 * jamais les faire passer par `process.stdout` autrement que pour les écrire
 * dans `.env`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { HttpClient } from '@/lib/http/client';
import { GMAIL_READONLY_SCOPE } from '@/lib/inbound/gmailProvider';

// ---------------------------------------------------------------------------
// Le JSON client "Desktop" téléchargé depuis Google Cloud Console
// ---------------------------------------------------------------------------

export interface InstalledOAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly authUri: string;
  readonly tokenUri: string;
}

export type ParsedClientJsonResult =
  | { readonly ok: true; readonly client: InstalledOAuthClient }
  | { readonly ok: false; readonly reason: string };

const GOOGLE_AUTH_URI_DEFAULT = 'https://accounts.google.com/o/oauth2/auth';
const GOOGLE_TOKEN_URI_DEFAULT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URI = 'https://oauth2.googleapis.com/revoke';
const GMAIL_PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

/**
 * Google ne distribue qu'une forme de JSON pour un client OAuth de type
 * "Desktop" : la clé de premier niveau est `installed`. Un client "Web"
 * (clé `web`) porte un secret pensé pour un serveur confidentiel et ne
 * convient pas à ce flux — il est donc refusé, pas seulement ignoré.
 *
 * Le contenu brut n'est jamais journalisé par cette fonction ni par ses
 * appelants : seul le résultat (accepté / refusé + raison courte) l'est.
 */
export function parseInstalledClientJson(raw: string): ParsedClientJsonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'JSON illisible' };
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, reason: 'JSON invalide' };
  const root = parsed as Record<string, unknown>;

  if (!('installed' in root)) {
    const reason =
      'web' in root
        ? 'client "web" détecté — un client OAuth de type "Desktop" (installed) est requis'
        : 'clé "installed" absente — un client OAuth de type "Desktop" (installed) est requis';
    return { ok: false, reason };
  }

  const installed = root.installed;
  if (installed === null || typeof installed !== 'object') {
    return { ok: false, reason: 'clé "installed" mal formée' };
  }
  const fields = installed as Record<string, unknown>;
  const clientId = typeof fields.client_id === 'string' ? fields.client_id.trim() : '';
  const clientSecret = typeof fields.client_secret === 'string' ? fields.client_secret.trim() : '';
  if (clientId.length === 0 || clientSecret.length === 0) {
    return { ok: false, reason: 'client_id ou client_secret manquant dans le JSON "installed"' };
  }

  const authUri = typeof fields.auth_uri === 'string' && fields.auth_uri.length > 0 ? fields.auth_uri : GOOGLE_AUTH_URI_DEFAULT;
  const tokenUri = typeof fields.token_uri === 'string' && fields.token_uri.length > 0 ? fields.token_uri : GOOGLE_TOKEN_URI_DEFAULT;

  return { ok: true, client: Object.freeze({ clientId, clientSecret, authUri, tokenUri }) };
}

// ---------------------------------------------------------------------------
// PKCE et anti-CSRF — RFC 7636, flux natif/Desktop de Google
// ---------------------------------------------------------------------------

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

/** `code_verifier` haute entropie, `code_challenge` = base64url(SHA-256(verifier)) (S256, pas "plain"). */
export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return Object.freeze({ verifier, challenge });
}

/** Valeur `state` anti-CSRF, comparée mot pour mot au retour du navigateur. */
export function generateState(): string {
  return randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// L'URL de consentement
// ---------------------------------------------------------------------------

export interface AuthUrlParams {
  readonly authUri: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
  readonly loginHint?: string;
}

/**
 * `scope` est câblé sur `GMAIL_READONLY_SCOPE` et rien d'autre : la mission
 * interdit explicitement de demander `gmail.modify` / `gmail.send` /
 * `gmail.compose` / `https://mail.google.com/`, et le moyen le plus sûr de ne
 * jamais les demander par erreur est de ne pas accepter de scope en paramètre.
 *
 * `access_type=offline` + `prompt=consent` : les deux sont nécessaires pour
 * obtenir un `refresh_token` de façon fiable, y compris si ce compte Google a
 * déjà consenti à ce client par le passé.
 */
export function buildAuthUrl(params: AuthUrlParams): string {
  const url = new URL(params.authUri);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GMAIL_READONLY_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  if (params.loginHint) url.searchParams.set('login_hint', params.loginHint);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Échange du code contre les jetons
// ---------------------------------------------------------------------------

export type GmailOAuthBootstrapErrorCode =
  | 'token_exchange_failed'
  | 'no_refresh_token'
  | 'account_mismatch'
  | 'revoke_failed';

export class GmailOAuthBootstrapError extends Error {
  readonly code: GmailOAuthBootstrapErrorCode;
  constructor(code: GmailOAuthBootstrapErrorCode, message: string) {
    super(message);
    this.name = 'GmailOAuthBootstrapError';
    this.code = code;
  }
}

export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly scope: string;
  readonly expiresIn: number;
}

export interface TokenExchangeDeps {
  readonly http: HttpClient;
  readonly tokenUri: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

/**
 * `POST` unique, conforme à la documentation Google du flux "authorization
 * code" avec PKCE : `client_id` / `client_secret` / `code` / `code_verifier`
 * / `grant_type=authorization_code` / `redirect_uri`, réponse
 * `{ access_token, refresh_token?, scope, expires_in }`.
 *
 * `noCache: true` et `attempts: 1` : un code d'autorisation ne se rejoue pas
 * (Google le refuse à la seconde tentative), donc ni le cache ni une
 * réémission automatique n'ont de sens ici.
 */
export async function exchangeCodeForTokens(deps: TokenExchangeDeps): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    client_id: deps.clientId,
    client_secret: deps.clientSecret,
    code: deps.code,
    code_verifier: deps.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: deps.redirectUri,
  }).toString();

  const response = await deps.http.request(deps.tokenUri, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    attempts: 1,
    noCache: true,
  });

  if (!response.ok) {
    throw new GmailOAuthBootstrapError('token_exchange_failed', `échange de code refusé par Google (${response.status})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new GmailOAuthBootstrapError('token_exchange_failed', 'réponse de jeton illisible');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new GmailOAuthBootstrapError('token_exchange_failed', 'réponse de jeton mal formée');
  }
  const fields = parsed as Record<string, unknown>;

  const accessToken = typeof fields.access_token === 'string' && fields.access_token.length > 0 ? fields.access_token : null;
  if (accessToken === null) {
    throw new GmailOAuthBootstrapError('token_exchange_failed', 'réponse de jeton sans access_token');
  }
  const refreshToken = typeof fields.refresh_token === 'string' && fields.refresh_token.length > 0 ? fields.refresh_token : null;
  const scope = typeof fields.scope === 'string' ? fields.scope : '';
  const expiresIn = typeof fields.expires_in === 'number' && Number.isFinite(fields.expires_in) ? fields.expires_in : 3600;

  return Object.freeze({ accessToken, refreshToken, scope, expiresIn });
}

/**
 * Sans `refresh_token`, l'inscription est inutilisable : le poller a besoin
 * d'un accès durable, pas d'un jeton d'une heure. Échec net plutôt qu'un
 * demi-résultat que le CLI serait tenté d'écrire quand même.
 */
export function assertRefreshTokenPresent(tokens: OAuthTokens): string {
  if (tokens.refreshToken === null) {
    throw new GmailOAuthBootstrapError(
      'no_refresh_token',
      'aucun refresh_token reçu — révoquer l’accès existant sur https://myaccount.google.com/permissions puis relancer',
    );
  }
  return tokens.refreshToken;
}

// ---------------------------------------------------------------------------
// Vérification d'identité — le compte autorisé, pas seulement la portée
// ---------------------------------------------------------------------------

export interface ProfileFetchDeps {
  readonly http: HttpClient;
  readonly accessToken: string;
  readonly profileUrl?: string;
}

/**
 * `users.getProfile` est un appel de LECTURE couvert par `gmail.readonly` —
 * aucune portée supplémentaire n'est nécessaire pour vérifier quel compte a
 * consenti. Renvoie `null` plutôt que de lever : un profil illisible est géré
 * par `assertAuthorizedAccount`, au même endroit que le désaccord d'identité.
 */
export async function fetchAuthorizedEmail(deps: ProfileFetchDeps): Promise<string | null> {
  const response = await deps.http.request(deps.profileUrl ?? GMAIL_PROFILE_URL, {
    method: 'GET',
    headers: { authorization: `Bearer ${deps.accessToken}`, accept: 'application/json' },
    attempts: 1,
    noCache: true,
  });
  if (!response.ok) return null;
  try {
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    return typeof parsed.emailAddress === 'string' && parsed.emailAddress.length > 0 ? parsed.emailAddress : null;
  } catch {
    return null;
  }
}

/** Comparaison insensible à la casse — Gmail normalise mais ne garantit pas la casse rendue. */
export function assertAuthorizedAccount(actual: string | null, expected: string): void {
  if (actual === null) {
    throw new GmailOAuthBootstrapError('account_mismatch', 'compte autorisé illisible depuis le profil Gmail');
  }
  if (actual.trim().toLowerCase() !== expected.trim().toLowerCase()) {
    throw new GmailOAuthBootstrapError(
      'account_mismatch',
      `compte autorisé "${actual}" différent du compte attendu "${expected}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Révocation — hygiène quand un consentement s'avère inutilisable
// ---------------------------------------------------------------------------

/**
 * Révoque le jeton auprès de Google. Appelée quand la portée ou le compte ne
 * correspondent pas à ce qui était attendu : laisser traîner un jeton valide
 * pour la mauvaise identité ou une portée refusée serait pire que de
 * simplement échouer.
 */
export async function revokeToken(http: HttpClient, token: string): Promise<void> {
  const response = await http.request(GOOGLE_REVOKE_URI, {
    method: 'POST',
    body: new URLSearchParams({ token }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    attempts: 1,
    noCache: true,
  });
  if (!response.ok) {
    throw new GmailOAuthBootstrapError('revoke_failed', `révocation refusée par Google (${response.status})`);
  }
}

// ---------------------------------------------------------------------------
// `.env` — mise à jour ciblée, sans toucher au reste du fichier
// ---------------------------------------------------------------------------

/**
 * Remplace ou ajoute uniquement les clés présentes dans `updates`. Toute
 * autre ligne (commentaire, variable non listée, ligne vide) est recopiée
 * telle quelle — y compris son ordre. Les ajouts vont à la fin, précédés
 * d'une ligne vide si le fichier existant ne se terminait pas déjà par une.
 */
export function upsertEnvVars(existing: string, updates: Readonly<Record<string, string>>): string {
  const lines = existing.length > 0 ? existing.split('\n') : [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const eq = trimmed.indexOf('=');
    const key = eq > 0 && !trimmed.startsWith('#') ? trimmed.slice(0, eq).trim() : null;
    if (key !== null && Object.prototype.hasOwnProperty.call(updates, key)) {
      result.push(`${key}=${updates[key]}`);
      seen.add(key);
      continue;
    }
    result.push(rawLine);
  }

  const additions = Object.keys(updates).filter((key) => !seen.has(key));
  if (additions.length > 0) {
    if (result.length > 0 && result[result.length - 1]!.trim() !== '') result.push('');
    for (const key of additions) result.push(`${key}=${updates[key]}`);
  }

  return result.join('\n');
}

/**
 * Vérifie qu'une ligne `.gitignore` couvre `.env` exactement (le motif déjà
 * en place dans ce dépôt). Utilisée comme garde avant toute écriture : si
 * `.env` n'est pas ignoré, l'écriture d'un secret dedans serait une régression
 * de sécurité, pas un service rendu.
 */
export function gitignoreCoversEnv(gitignoreText: string): boolean {
  return gitignoreText
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line === '.env');
}
