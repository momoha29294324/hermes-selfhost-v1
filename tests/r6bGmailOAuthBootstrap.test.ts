import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '@/lib/http/client';
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
import { GMAIL_READONLY_SCOPE, assertReadOnlyScope, GmailScopeError } from '@/lib/inbound/gmailProvider';

/**
 * R6B-D1.2 — inscription OAuth Gmail, entièrement sans réseau.
 *
 * Comme `gmailProvider.ts`, aucun test ici n'ouvre de connexion réelle : le
 * transport est toujours un `HttpClient` dont `fetchImpl` est remplacé par un
 * faux, ce qui exerce le VRAI code d'échange de jetons et de vérification —
 * pas une maquette de celui-ci.
 */

const CLIENT_SECRET = 'client-secret-de-test-jamais-reel';
const REFRESH_TOKEN = 'refresh-token-de-test-jamais-reel';
const ACCESS_TOKEN = 'access-token-de-test-jamais-reel';
const CODE = 'code-de-test';
const EXPECTED_ACCOUNT = 'operatoragency@example.com';

function fakeHttp(handler: (url: string, init: RequestInit | undefined) => Response): HttpClient {
  return new HttpClient({
    fetchImpl: (async (url: string, init?: RequestInit) => handler(url, init)) as unknown as typeof fetch,
  });
}

// ---------------------------------------------------------------------------
// JSON client "Desktop" — accepté / refusé
// ---------------------------------------------------------------------------

describe('parseInstalledClientJson', () => {
  it('accepte un JSON client "Desktop" (installed)', () => {
    const raw = JSON.stringify({
      installed: {
        client_id: 'abc.apps.googleusercontent.com',
        client_secret: CLIENT_SECRET,
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
      },
    });
    const result = parseInstalledClientJson(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.client.clientId).toBe('abc.apps.googleusercontent.com');
      expect(result.client.clientSecret).toBe(CLIENT_SECRET);
    }
  });

  it('refuse un JSON client "web" (non-installed)', () => {
    const raw = JSON.stringify({
      web: { client_id: 'abc.apps.googleusercontent.com', client_secret: CLIENT_SECRET },
    });
    const result = parseInstalledClientJson(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/web/);
  });

  it('refuse un JSON sans clé "installed" ni "web"', () => {
    const result = parseInstalledClientJson(JSON.stringify({ foo: 'bar' }));
    expect(result.ok).toBe(false);
  });

  it('refuse un JSON illisible', () => {
    const result = parseInstalledClientJson('{ pas du json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/illisible/);
  });

  it('refuse un client "installed" sans client_secret', () => {
    const raw = JSON.stringify({ installed: { client_id: 'abc.apps.googleusercontent.com' } });
    const result = parseInstalledClientJson(raw);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PKCE / state
// ---------------------------------------------------------------------------

describe('generatePkce / generateState', () => {
  it('produit un verifier et un challenge distincts, dérivés (S256)', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(a.verifier);
    expect(a.challenge.length).toBeGreaterThan(20);
  });

  it('produit un state différent à chaque appel', () => {
    expect(generateState()).not.toBe(generateState());
  });
});

// ---------------------------------------------------------------------------
// URL de consentement — la portée est câblée, jamais paramétrable
// ---------------------------------------------------------------------------

describe('buildAuthUrl', () => {
  it('ne demande que gmail.readonly, en offline + consent, avec PKCE S256', () => {
    const url = new URL(
      buildAuthUrl({
        authUri: 'https://accounts.google.com/o/oauth2/auth',
        clientId: 'client-id',
        redirectUri: 'http://127.0.0.1:12345/oauth2callback',
        codeChallenge: 'challenge',
        state: 'state-123',
        loginHint: EXPECTED_ACCOUNT,
      }),
    );
    expect(url.searchParams.get('scope')).toBe(GMAIL_READONLY_SCOPE);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('login_hint')).toBe(EXPECTED_ACCOUNT);
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:12345/oauth2callback');
  });
});

// ---------------------------------------------------------------------------
// Échange du code — succès, refus, refresh_token absent
// ---------------------------------------------------------------------------

describe('exchangeCodeForTokens', () => {
  it('lit access_token, refresh_token et scope de la réponse', async () => {
    const http = fakeHttp(() =>
      new Response(
        JSON.stringify({
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
          scope: GMAIL_READONLY_SCOPE,
          expires_in: 3599,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const tokens = await exchangeCodeForTokens({
      http,
      tokenUri: 'https://oauth2.googleapis.com/token',
      clientId: 'client-id',
      clientSecret: CLIENT_SECRET,
      code: CODE,
      codeVerifier: 'verifier',
      redirectUri: 'http://127.0.0.1:12345/oauth2callback',
    });
    expect(tokens.accessToken).toBe(ACCESS_TOKEN);
    expect(tokens.refreshToken).toBe(REFRESH_TOKEN);
    expect(tokens.scope).toBe(GMAIL_READONLY_SCOPE);
  });

  it('lève sur un échange refusé (statut non-2xx)', async () => {
    const http = fakeHttp(() => new Response('invalid_grant', { status: 400 }));
    await expect(
      exchangeCodeForTokens({
        http,
        tokenUri: 'https://oauth2.googleapis.com/token',
        clientId: 'client-id',
        clientSecret: CLIENT_SECRET,
        code: CODE,
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1:12345/oauth2callback',
      }),
    ).rejects.toThrow(GmailOAuthBootstrapError);
  });

  it('refresh_token absent → assertRefreshTokenPresent échoue proprement (fail-closed)', () => {
    const tokens: OAuthTokens = {
      accessToken: ACCESS_TOKEN,
      refreshToken: null,
      scope: GMAIL_READONLY_SCOPE,
      expiresIn: 3600,
    };
    expect(() => assertRefreshTokenPresent(tokens)).toThrow(GmailOAuthBootstrapError);
    try {
      assertRefreshTokenPresent(tokens);
    } catch (error) {
      expect(error).toBeInstanceOf(GmailOAuthBootstrapError);
      expect((error as GmailOAuthBootstrapError).code).toBe('no_refresh_token');
    }
  });

  it('refresh_token présent → assertRefreshTokenPresent le renvoie', () => {
    const tokens: OAuthTokens = {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      scope: GMAIL_READONLY_SCOPE,
      expiresIn: 3600,
    };
    expect(assertRefreshTokenPresent(tokens)).toBe(REFRESH_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Portée — gmail.readonly seul accepté, toute portée d'écriture refusée
// ---------------------------------------------------------------------------

describe('assertReadOnlyScope (partagé avec gmailProvider) appliqué au bootstrap', () => {
  it('accepte gmail.readonly seul', () => {
    expect(() => assertReadOnlyScope(GMAIL_READONLY_SCOPE)).not.toThrow();
  });

  it.each(['https://mail.google.com/', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose'])(
    'refuse une portée d’écriture accordée en plus (%s)',
    (writeScope) => {
      expect(() => assertReadOnlyScope(`${GMAIL_READONLY_SCOPE} ${writeScope}`)).toThrow(GmailScopeError);
    },
  );

  it('refuse une portée sans aucune lecture', () => {
    expect(() => assertReadOnlyScope('https://www.googleapis.com/auth/calendar')).toThrow(GmailScopeError);
  });
});

// ---------------------------------------------------------------------------
// Identité du compte autorisé
// ---------------------------------------------------------------------------

describe('fetchAuthorizedEmail / assertAuthorizedAccount', () => {
  it('lit emailAddress depuis users.getProfile', async () => {
    const http = fakeHttp(() =>
      new Response(JSON.stringify({ emailAddress: EXPECTED_ACCOUNT, historyId: '123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const email = await fetchAuthorizedEmail({ http, accessToken: ACCESS_TOKEN });
    expect(email).toBe(EXPECTED_ACCOUNT);
  });

  it('rend null si le profil est illisible', async () => {
    const http = fakeHttp(() => new Response('nope', { status: 403 }));
    const email = await fetchAuthorizedEmail({ http, accessToken: ACCESS_TOKEN });
    expect(email).toBeNull();
  });

  it('accepte le compte attendu, insensible à la casse', () => {
    expect(() => assertAuthorizedAccount('OperatorAgency@Example.com', EXPECTED_ACCOUNT)).not.toThrow();
  });

  it('refuse un compte différent de celui attendu', () => {
    expect(() => assertAuthorizedAccount('autre-compte@gmail.com', EXPECTED_ACCOUNT)).toThrow(GmailOAuthBootstrapError);
    try {
      assertAuthorizedAccount('autre-compte@gmail.com', EXPECTED_ACCOUNT);
    } catch (error) {
      expect((error as GmailOAuthBootstrapError).code).toBe('account_mismatch');
    }
  });

  it('refuse un compte illisible (null)', () => {
    expect(() => assertAuthorizedAccount(null, EXPECTED_ACCOUNT)).toThrow(GmailOAuthBootstrapError);
  });
});

// ---------------------------------------------------------------------------
// Révocation
// ---------------------------------------------------------------------------

describe('revokeToken', () => {
  it('ne lève pas sur un succès', async () => {
    const http = fakeHttp(() => new Response('', { status: 200 }));
    await expect(revokeToken(http, ACCESS_TOKEN)).resolves.toBeUndefined();
  });

  it('lève sur un échec de révocation', async () => {
    const http = fakeHttp(() => new Response('', { status: 400 }));
    await expect(revokeToken(http, ACCESS_TOKEN)).rejects.toThrow(GmailOAuthBootstrapError);
  });
});

// ---------------------------------------------------------------------------
// .env — préserve tout ce qui n'est pas géré, jamais d'écrasement sauvage
// ---------------------------------------------------------------------------

describe('upsertEnvVars', () => {
  const updates = {
    GMAIL_OAUTH_CLIENT_ID: 'id-nouveau',
    GMAIL_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    GMAIL_OAUTH_REFRESH_TOKEN: REFRESH_TOKEN,
    GMAIL_INBOX_ADDRESS: EXPECTED_ACCOUNT,
  };

  it('ajoute les variables absentes sans toucher au reste', () => {
    const existing = ['# commentaire', 'OUTBOUND_ALLOW_SENDING=0', 'RESEND_API_KEY=ne-pas-toucher', ''].join('\n');
    const result = upsertEnvVars(existing, updates);
    expect(result).toContain('# commentaire');
    expect(result).toContain('OUTBOUND_ALLOW_SENDING=0');
    expect(result).toContain('RESEND_API_KEY=ne-pas-toucher');
    for (const [key, value] of Object.entries(updates)) expect(result).toContain(`${key}=${value}`);
  });

  it('remplace une valeur GMAIL_* déjà présente sans dupliquer la ligne', () => {
    const existing = ['GMAIL_OAUTH_CLIENT_ID=ancienne-valeur', 'OUTBOUND_ALLOW_SENDING=0'].join('\n');
    const result = upsertEnvVars(existing, updates);
    const occurrences = result.split('\n').filter((line) => line.startsWith('GMAIL_OAUTH_CLIENT_ID='));
    expect(occurrences).toEqual([`GMAIL_OAUTH_CLIENT_ID=${updates.GMAIL_OAUTH_CLIENT_ID}`]);
    expect(result).toContain('OUTBOUND_ALLOW_SENDING=0');
  });

  it('ignore les lignes commentées portant un nom de variable géré', () => {
    const existing = '# GMAIL_OAUTH_CLIENT_ID=exemple-commente';
    const result = upsertEnvVars(existing, updates);
    expect(result).toContain('# GMAIL_OAUTH_CLIENT_ID=exemple-commente');
    expect(result).toContain(`GMAIL_OAUTH_CLIENT_ID=${updates.GMAIL_OAUTH_CLIENT_ID}`);
  });

  it('part d’un fichier vide sans planter', () => {
    const result = upsertEnvVars('', updates);
    for (const [key, value] of Object.entries(updates)) expect(result).toContain(`${key}=${value}`);
  });
});

// ---------------------------------------------------------------------------
// .env reste ignoré par Git
// ---------------------------------------------------------------------------

describe('gitignoreCoversEnv', () => {
  it('reconnaît une ligne ".env" exacte', () => {
    expect(gitignoreCoversEnv(['node_modules', '.env', '.next'].join('\n'))).toBe(true);
  });

  it('rend false si .env n’apparaît pas', () => {
    expect(gitignoreCoversEnv(['node_modules', '.next'].join('\n'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Aucune valeur de secret journalisée
// ---------------------------------------------------------------------------

describe('aucun secret journalisé', () => {
  it('parseInstalledClientJson, exchangeCodeForTokens et upsertEnvVars n’écrivent jamais sur stdout/console', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      parseInstalledClientJson(
        JSON.stringify({ installed: { client_id: 'id', client_secret: CLIENT_SECRET } }),
      );
      const http = fakeHttp(() =>
        new Response(
          JSON.stringify({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, scope: GMAIL_READONLY_SCOPE, expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      await exchangeCodeForTokens({
        http,
        tokenUri: 'https://oauth2.googleapis.com/token',
        clientId: 'client-id',
        clientSecret: CLIENT_SECRET,
        code: CODE,
        codeVerifier: 'verifier',
        redirectUri: 'http://127.0.0.1:1/oauth2callback',
      });
      upsertEnvVars('', { GMAIL_OAUTH_REFRESH_TOKEN: REFRESH_TOKEN });

      const allOutput = [...stdoutSpy.mock.calls, ...consoleSpy.mock.calls].map((call) => String(call[0])).join('\n');
      expect(allOutput).not.toContain(CLIENT_SECRET);
      expect(allOutput).not.toContain(REFRESH_TOKEN);
      expect(allOutput).not.toContain(ACCESS_TOKEN);
    } finally {
      stdoutSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});
