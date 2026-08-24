import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserPool,
  BrowserUnavailable,
  reapTrackedProcesses,
  type PwBrowser,
  type PwBrowserServer,
  type PwContext,
  type PwLauncher,
  type PwPage,
  type PwRoute,
} from '../../services/webintel/src/browser';
import { createLogger } from '../../services/webintel/src/log';

const silent = createLogger('error', {}, () => undefined);

/**
 * A Playwright stand-in whose every step can be made to hang or fail.
 *
 * The Sprint 1 incident was a child process that outlived its timeout. These
 * tests exist to make that failure impossible to reintroduce silently: the
 * assertions are about what happens to the *process*, not about the HTML.
 */
interface FakeOptions {
  hangOnClose?: boolean;
  hangOnGoto?: boolean;
  failConnect?: boolean;
  failLaunch?: boolean;
  content?: string;
}

function makeLauncher(options: FakeOptions = {}) {
  const state = {
    killed: 0,
    serverClosed: 0,
    browserClosed: 0,
    launches: 0,
    pagesClosed: 0,
    contextsClosed: 0,
    routed: [] as string[],
    aborted: [] as string[],
    pid: 424242,
  };

  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

  const page: PwPage = {
    goto: async (url) => {
      if (options.hangOnGoto) return never();
      return { status: () => 200, url: () => url };
    },
    content: async () => options.content ?? '<html><body>rendu</body></html>',
    url: () => 'https://exemple.fr/',
    close: async () => {
      state.pagesClosed += 1;
    },
    waitForTimeout: async () => undefined,
  };

  const context: PwContext = {
    newPage: async () => page,
    route: async (_pattern, handler) => {
      // Exercise the request filter with one safe and one internal URL.
      for (const target of ['https://exemple.fr/app.js', 'http://169.254.169.254/latest/']) {
        const route: PwRoute = {
          request: () => ({ url: () => target, resourceType: () => 'script' }),
          abort: async () => {
            state.aborted.push(target);
          },
          continue: async () => {
            state.routed.push(target);
          },
        };
        await handler(route);
      }
    },
    close: async () => {
      state.contextsClosed += 1;
    },
  };

  const browser: PwBrowser = {
    newContext: async () => context,
    close: async () => {
      if (options.hangOnClose) return never();
      state.browserClosed += 1;
    },
    isConnected: () => true,
  };

  const server: PwBrowserServer = {
    process: () => ({ pid: state.pid }),
    wsEndpoint: () => 'ws://127.0.0.1:1234/fake',
    close: async () => {
      if (options.hangOnClose) return never();
      state.serverClosed += 1;
    },
    kill: async () => {
      state.killed += 1;
    },
  };

  const launcher: PwLauncher = {
    launchServer: async () => {
      state.launches += 1;
      if (options.failLaunch) throw new Error('chromium introuvable');
      return server;
    },
    connect: async () => {
      if (options.failConnect) throw new Error('ws refusé');
      return browser;
    },
  };

  return { launcher, state };
}

function pool(launcher: PwLauncher, overrides: Partial<ConstructorParameters<typeof BrowserPool>[0]> = {}) {
  return new BrowserPool({
    enabled: true,
    maxContexts: 1,
    navTimeoutMs: 1_000,
    hardKillMs: 200,
    idleShutdownMs: 0,
    executablePath: null,
    logger: silent,
    launcher,
    ...overrides,
  });
}

afterEach(() => {
  reapTrackedProcesses();
  vi.restoreAllMocks();
});

describe('BrowserPool', () => {
  it('rend une page et referme proprement', async () => {
    const { launcher, state } = makeLauncher();
    const browsers = pool(launcher);

    const result = await browsers.render('https://exemple.fr/');
    expect(result.html).toContain('rendu');
    expect(result.status).toBe(200);
    expect(state.pagesClosed).toBe(1);
    expect(state.contextsClosed).toBe(1);

    await browsers.shutdown();
    expect(state.serverClosed).toBe(1);
    expect(state.killed).toBe(0);
  });

  it('refuse de naviguer vers une URL interdite avant même de lancer le navigateur', async () => {
    const { launcher, state } = makeLauncher();
    const browsers = pool(launcher);
    await expect(browsers.render('http://127.0.0.1:8088/')).rejects.toThrow(/hôte refusé/);
    expect(state.launches).toBe(0);
  });

  it('applique les règles SSRF aux requêtes du navigateur lui-même', async () => {
    const { launcher, state } = makeLauncher();
    const browsers = pool(launcher);
    await browsers.render('https://exemple.fr/');
    // The script from the site is a script (blocked as a resource type is not
    // in play here), but the metadata endpoint is refused outright.
    expect(state.aborted).toContain('http://169.254.169.254/latest/');
    await browsers.shutdown();
  });

  it('tue le processus quand la fermeture ne rend jamais la main', async () => {
    const { launcher, state } = makeLauncher({ hangOnClose: true });
    const browsers = pool(launcher);
    await browsers.render('https://exemple.fr/');

    await browsers.shutdown();

    // Graceful close hung; the pool did not wait for it forever.
    expect(state.serverClosed).toBe(0);
    expect(state.killed).toBe(1);
    expect(browsers.stats()['hardKills']).toBe(1);
  });

  it('ne laisse pas de processus derrière lui quand la navigation expire', async () => {
    const { launcher, state } = makeLauncher({ hangOnGoto: true });
    const browsers = pool(launcher, { navTimeoutMs: 150 });

    await expect(browsers.render('https://exemple.fr/')).rejects.toThrow(BrowserUnavailable);

    // The whole point: a hung navigation destroys the browser rather than
    // leaving it — and the pool's process registry is empty afterwards.
    expect(state.serverClosed + state.killed).toBeGreaterThan(0);
    expect(browsers.stats()['trackedPids']).toBe(0);
    expect(browsers.stats()['failures']).toBe(1);
  });

  it('nettoie le processus quand la connexion échoue après le lancement', async () => {
    const { launcher, state } = makeLauncher({ failConnect: true });
    const browsers = pool(launcher);

    await expect(browsers.render('https://exemple.fr/')).rejects.toThrow(BrowserUnavailable);
    // Launched but never connected: exactly the window where a process becomes
    // an orphan if the pid was not registered first.
    expect(state.launches).toBe(1);
    expect(state.serverClosed + state.killed).toBeGreaterThan(0);
    expect(browsers.stats()['trackedPids']).toBe(0);
  });

  it('relance un navigateur après un échec plutôt que de réutiliser un état inconnu', async () => {
    const { launcher, state } = makeLauncher({ hangOnGoto: true });
    const browsers = pool(launcher, { navTimeoutMs: 100 });
    await expect(browsers.render('https://exemple.fr/')).rejects.toThrow();
    await expect(browsers.render('https://exemple.fr/')).rejects.toThrow();
    expect(state.launches).toBe(2);
  });

  it('refuse de rendre quand le navigateur est désactivé', async () => {
    const { launcher, state } = makeLauncher();
    const browsers = pool(launcher, { enabled: false });
    await expect(browsers.render('https://exemple.fr/')).rejects.toThrow(/désactivé/);
    expect(state.launches).toBe(0);
  });

  it('remonte un lancement impossible sans laisser de trace', async () => {
    const { launcher } = makeLauncher({ failLaunch: true });
    const browsers = pool(launcher);
    await expect(browsers.render('https://exemple.fr/')).rejects.toThrow(BrowserUnavailable);
    expect(browsers.stats()['trackedPids']).toBe(0);
  });

  it('sérialise les rendus jusqu’à la limite de contextes', async () => {
    const { launcher } = makeLauncher();
    const browsers = pool(launcher, { maxContexts: 1 });
    const results = await Promise.all([
      browsers.render('https://exemple.fr/a'),
      browsers.render('https://exemple.fr/b'),
      browsers.render('https://exemple.fr/c'),
    ]);
    expect(results).toHaveLength(3);
    expect(browsers.stats()['active']).toBe(0);
    expect(browsers.stats()['renders']).toBe(3);
    await browsers.shutdown();
  });

  it('shutdown est idempotent', async () => {
    const { launcher } = makeLauncher();
    const browsers = pool(launcher);
    await browsers.render('https://exemple.fr/');
    await browsers.shutdown();
    await expect(browsers.shutdown()).resolves.toBeUndefined();
  });
});

describe('reapTrackedProcesses', () => {
  it('envoie SIGKILL aux pid encore suivis et vide le registre', async () => {
    const { launcher, state } = makeLauncher({ hangOnClose: true });
    const browsers = pool(launcher);
    await browsers.render('https://exemple.fr/');
    expect(browsers.stats()['trackedPids']).toBe(1);

    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const killed = reapTrackedProcesses();

    expect(killed).toBe(1);
    // Negative pid first: that targets the process group, which is what catches
    // the renderer children Chromium forks.
    expect(kill).toHaveBeenCalledWith(-state.pid, 'SIGKILL');
    expect(reapTrackedProcesses()).toBe(0);
  });
});
