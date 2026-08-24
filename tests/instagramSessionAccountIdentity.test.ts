/**
 * « Connecté » n'est pas « connecté sous notre nom ».
 *
 * Ce fichier existe à cause d'un fait daté. Le 24 août 2026, sur le serveur, le
 * bootstrap a rendu `SESSION_READY` sur une session authentifiée comme
 * `bot72882552562736`, alors que le compte de ce dépôt est `hermes__`. Rien
 * n'avait menti : la session ÉTAIT vivante, les marqueurs d'authentification
 * ÉTAIENT là. Personne ne demandait à QUI elle appartenait.
 *
 * Les cas ci-dessous fixent la seule chose qui compte : un compte tiers ne
 * franchit pas cette porte, et une identité illisible non plus.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyPageState,
  expectedAccountHandles,
  normalizeInstagramHandle,
} from '@/lib/instagram/playwrightRail';
import {
  HARD_STOP_SESSION_STATES,
  INSTAGRAM_SESSION_STATES,
  SESSION_STATE_BLOCK_CODE,
  isHardStopSessionState,
  isUsableSessionState,
} from '@/lib/instagram/types';

/** Une page saine et connectée : tout est vert SAUF, éventuellement, l'identité. */
function authenticatedPage(overrides: Partial<Parameters<typeof classifyPageState>[0]> = {}) {
  return classifyPageState({
    finalUrl: 'https://www.instagram.com/',
    text: 'Accueil Recherche Explorer Messages',
    captchaWidgets: 0,
    authenticatedMarkers: 3,
    loginControls: 0,
    hasSessionCookies: true,
    hadSessionCookies: true,
    ...overrides,
  });
}

const OURS = ['hermes__', 'hermesagency_'] as const;

describe('identité du compte connecté', () => {
  it('le cas réel du 24 août : une session vivante sous un compte tiers est REFUSÉE', () => {
    const seen = authenticatedPage({
      connectedHandle: 'bot72882552562736',
      expectedHandles: OURS,
    });

    expect(seen.state).toBe('SESSION_WRONG_ACCOUNT');
    // Le motif doit NOMMER le compte trouvé : c'est ce qui a manqué le 24 août,
    // où l'opérateur a lu « prêt » et n'avait aucun moyen de voir le problème.
    expect(seen.detail).toContain('bot72882552562736');
    expect(seen.detail).toContain('hermes__');
  });

  it('notre compte courant passe', () => {
    const seen = authenticatedPage({ connectedHandle: 'hermes__', expectedHandles: OURS });
    expect(seen.state).toBe('SESSION_READY');
  });

  it('un ANCIEN nom du même compte passe — renommer ne nous remplace pas', () => {
    const seen = authenticatedPage({ connectedHandle: 'hermesagency_', expectedHandles: OURS });
    expect(seen.state).toBe('SESSION_READY');
  });

  it('la casse et le « @ » ne font pas une identité différente', () => {
    for (const handle of ['Hermes__', '@hermes__', 'hermes__/']) {
      expect(authenticatedPage({ connectedHandle: handle, expectedHandles: OURS }).state).toBe('SESSION_READY');
    }
  });

  it('un compte ILLISIBLE ne vaut pas un feu vert — fail-closed', () => {
    const seen = authenticatedPage({ connectedHandle: null, expectedHandles: OURS });
    // Ni READY (ce serait le bug d'origine), ni WRONG_ACCOUNT (ce serait une
    // accusation sans preuve) : on ne sait pas, donc on refuse.
    expect(seen.state).toBe('UNKNOWN');
    expect(isUsableSessionState(seen.state)).toBe(false);
  });

  it('sans compte déclaré, rien n’est comparé : le comportement d’avant est conservé', () => {
    // `inbound.accountHandle` est nullable dans le schéma. Une configuration
    // qui ne nomme aucun compte ne doit pas voir son rail s'arrêter.
    expect(authenticatedPage({ connectedHandle: 'nimporte_qui', expectedHandles: [] }).state).toBe('SESSION_READY');
    expect(authenticatedPage({ connectedHandle: null, expectedHandles: [] }).state).toBe('SESSION_READY');
  });

  it('l’identité est la DERNIÈRE porte : un mur de connexion l’emporte toujours', () => {
    // Un compte tiers sur un écran de login reste un écran de login. L'ordre de
    // gravité ne doit pas être réécrit par l'ajout de cette porte.
    const seen = classifyPageState({
      finalUrl: 'https://www.instagram.com/accounts/login/',
      text: 'Connectez-vous',
      captchaWidgets: 0,
      authenticatedMarkers: 0,
      loginControls: 2,
      hasSessionCookies: false,
      hadSessionCookies: false,
      connectedHandle: 'bot72882552562736',
      expectedHandles: OURS,
    });
    expect(seen.state).toBe('LOGIN_REQUIRED');
  });

  it('un challenge l’emporte aussi — on ne discute pas d’identité devant un mur', () => {
    const seen = classifyPageState({
      finalUrl: 'https://www.instagram.com/challenge/',
      text: 'Confirmez votre identité',
      captchaWidgets: 0,
      authenticatedMarkers: 2,
      loginControls: 0,
      hasSessionCookies: true,
      hadSessionCookies: true,
      connectedHandle: 'bot72882552562736',
      expectedHandles: OURS,
    });
    expect(seen.state).toBe('CHALLENGE');
  });

  it('aucune preuve d’authentification prime encore sur l’identité', () => {
    const seen = authenticatedPage({
      authenticatedMarkers: 0,
      connectedHandle: 'hermes__',
      expectedHandles: OURS,
    });
    expect(seen.state).toBe('UNKNOWN');
  });
});

describe('SESSION_WRONG_ACCOUNT dans la taxonomie', () => {
  it('est un état déclaré', () => {
    expect(INSTAGRAM_SESSION_STATES).toContain('SESSION_WRONG_ACCOUNT');
  });

  it('est un ARRÊT NET : recharger ne changera jamais le propriétaire du compte', () => {
    expect(HARD_STOP_SESSION_STATES).toContain('SESSION_WRONG_ACCOUNT');
    expect(isHardStopSessionState('SESSION_WRONG_ACCOUNT')).toBe(true);
  });

  it('n’autorise jamais la suite', () => {
    expect(isUsableSessionState('SESSION_WRONG_ACCOUNT')).toBe(false);
  });

  it('porte son propre motif de refus, distinct de « il faut se connecter »', () => {
    expect(SESSION_STATE_BLOCK_CODE.SESSION_WRONG_ACCOUNT).toBe('IG_SESSION_WRONG_ACCOUNT');
    expect(SESSION_STATE_BLOCK_CODE.SESSION_WRONG_ACCOUNT).not.toBe(
      SESSION_STATE_BLOCK_CODE.LOGIN_REQUIRED,
    );
  });
});

describe('handles attendus', () => {
  it('réunit le nom courant et les anciens, normalisés et dédoublonnés', () => {
    expect(
      expectedAccountHandles({ accountHandle: 'Hermes__', formerAccountHandles: ['hermesagency_', 'Hermes__'] }),
    ).toEqual(['hermes__', 'hermesagency_']);
  });

  it('sans compte déclaré, la liste est vide — donc rien n’est vérifié', () => {
    expect(expectedAccountHandles({ accountHandle: null, formerAccountHandles: [] })).toEqual([]);
  });

  it('normalise sans jamais inventer', () => {
    expect(normalizeInstagramHandle('  @Hermes__/ ')).toBe('hermes__');
    expect(normalizeInstagramHandle('')).toBeNull();
    expect(normalizeInstagramHandle(null)).toBeNull();
  });
});

describe('ce que cette porte n’expose pas', () => {
  it('ne lit, ne compare et ne journalise aucun cookie', () => {
    // Un handle est un nom PUBLIC, affiché à l'écran. Le correctif ne doit pas
    // avoir introduit une lecture de `sessionid` — ni pour vérifier, ni pour
    // tracer.
    const source = readFileSync(resolve(process.cwd(), 'src/lib/instagram/playwrightRail.ts'), 'utf8');
    const reader = source.slice(
      source.indexOf('async function readConnectedHandle'),
      source.indexOf('export function normalizeInstagramHandle'),
    );
    expect(reader.length).toBeGreaterThan(0);
    expect(reader).not.toContain('sessionid');
    expect(reader).not.toContain('ds_user_id');
    expect(reader).not.toContain('cookies(');
  });

  it('ne déclare AUCUNE fonction dans le `evaluate` — sinon `__name` la tue en silence', () => {
    /**
     * Le garde-fou d'un défaut réel, et invisible par construction.
     *
     * esbuild — que `tsx` utilise — enveloppe les fonctions nommées dans un
     * helper `__name()` qui vit dans le module compilé, pas dans la page.
     * Playwright sérialise le corps du `evaluate` et le navigateur l'exécute :
     * la première fonction interne lève `ReferenceError: __name is not
     * defined`. Le 24 août 2026 c'est exactement ce qui s'est produit, et le
     * `catch` du lecteur l'a rendu MUET — « compte illisible », un refus juste
     * rendu pour une raison fausse. Fail-closed a tenu ; la lisibilité, non.
     *
     * On lit donc la source : dans le corps envoyé au navigateur, aucune
     * fonction ne se déclare.
     */
    const source = readFileSync(resolve(process.cwd(), 'src/lib/instagram/playwrightRail.ts'), 'utf8');
    const reader = source.slice(
      source.indexOf('export async function readConnectedHandle'),
      source.indexOf('/** Comparaison de handles'),
    );
    const body = reader.slice(reader.indexOf('page.evaluate(() => {'));

    // Une seule flèche : celle du callback lui-même.
    expect(body.match(/=>/g) ?? []).toHaveLength(1);
    expect(body).not.toMatch(/\bfunction\b/);
  });
});
