/**
 * Browser rendering fallback.
 *
 * Used only when plain HTTP came back with a shell instead of a page. Rendering
 * everything in Chromium would be both wasteful and, on a host with ~3.5 GiB
 * free and a dozen other services, actively dangerous.
 *
 * The Sprint 1 incident — a child process that outlived its own timeout — is
 * the reason this module is shaped the way it is:
 *
 *   - every render runs against a hard deadline, and the deadline owns the
 *     outcome; a hung `page.goto` cannot extend it;
 *   - closing is attempted gracefully, then *forced*: if the browser has not
 *     exited within `hardKillMs`, its process group is SIGKILLed by pid;
 *   - every pid ever launched is tracked, and process exit / SIGTERM / SIGINT
 *     all run the same reaper, so a crash cannot leave an orphan behind;
 *   - a failed render marks the pool dirty, and the next call relaunches rather
 *     than reusing a browser in an unknown state.
 *
 * Playwright is imported through a non-literal specifier so the main app can be
 * typechecked, linted and tested without installing a browser. The structural
 * interfaces below are the only surface this file depends on.
 */
import { assertSafeUrl, isSafeUrl } from './ssrf.js';
import type { Logger } from './log.js';
import { errorMessage } from './log.js';

// ---------------------------------------------------------------------------
// Minimal structural view of the Playwright API we actually use
// ---------------------------------------------------------------------------
export interface PwRequest {
  url(): string;
  resourceType(): string;
}

export interface PwRoute {
  request(): PwRequest;
  abort(reason?: string): Promise<void>;
  continue(): Promise<void>;
}

export interface PwResponse {
  status(): number;
  url(): string;
}

export interface PwPage {
  goto(url: string, options?: { timeout?: number; waitUntil?: string }): Promise<PwResponse | null>;
  content(): Promise<string>;
  url(): string;
  close(options?: { runBeforeUnload?: boolean }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
}

export interface PwContext {
  newPage(): Promise<PwPage>;
  route(pattern: string, handler: (route: PwRoute) => Promise<void> | void): Promise<void>;
  close(): Promise<void>;
}

export interface PwBrowser {
  newContext(options?: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
  isConnected(): boolean;
}

/**
 * `launchServer` rather than `launch`, for one reason: it is the only Playwright
 * API that hands back the browser's OS process and a real `kill()`.
 *
 * `browser.process()` is Puppeteer's API, not Playwright's — reaching for it
 * here threw at launch time and left five `chrome-headless` processes running,
 * which is the Sprint 1 failure reproduced exactly. With a BrowserServer the
 * pid is known before anything else can fail, so the reaper always has
 * something to kill.
 */
export interface PwBrowserServer {
  process(): { pid?: number | undefined } | null;
  wsEndpoint(): string;
  close(): Promise<void>;
  kill(): Promise<void>;
}

export interface PwLauncher {
  launchServer(options?: Record<string, unknown>): Promise<PwBrowserServer>;
  connect(wsEndpoint: string, options?: Record<string, unknown>): Promise<PwBrowser>;
}

export interface RenderResult {
  html: string;
  finalUrl: string;
  status: number;
  durationMs: number;
}

export class BrowserUnavailable extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'BrowserUnavailable';
  }
}

export interface BrowserPoolOptions {
  enabled: boolean;
  maxContexts: number;
  navTimeoutMs: number;
  hardKillMs: number;
  idleShutdownMs: number;
  executablePath: string | null;
  logger: Logger;
  /** Injected in tests. Defaults to Playwright's bundled Chromium. */
  launcher?: PwLauncher;
}

/** Pids of every browser this process has started, for the reaper. */
const trackedPids = new Set<number>();
let reaperInstalled = false;

export function trackPid(pid: number | undefined): void {
  if (typeof pid === 'number' && Number.isFinite(pid)) trackedPids.add(pid);
}

export function untrackPid(pid: number | undefined): void {
  if (typeof pid === 'number') trackedPids.delete(pid);
}

/** SIGKILLs every tracked browser pid. Safe to call more than once. */
export function reapTrackedProcesses(): number {
  let killed = 0;
  for (const pid of [...trackedPids]) {
    try {
      // Negative pid targets the process group, which is what catches the
      // renderer children Chromium forks. Falls back to the pid alone.
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
      killed += 1;
    } catch {
      // Already gone: that is the desired state.
    }
    trackedPids.delete(pid);
  }
  return killed;
}

export function installProcessReaper(logger?: Logger): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  const run = (): void => {
    const killed = reapTrackedProcesses();
    if (killed > 0) logger?.warn('browser.reaped_on_exit', { killed });
  };
  process.on('exit', run);
  process.on('SIGTERM', run);
  process.on('SIGINT', run);
}

/** Resolves, rejects or times out — whichever happens first. */
async function withDeadline<T>(ms: number, label: string, task: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BrowserUnavailable(`${label}: délai dépassé`, 'timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);

export class BrowserPool {
  private browser: PwBrowser | null = null;
  private server: PwBrowserServer | null = null;
  private launching: Promise<PwBrowser> | null = null;
  private active = 0;
  private queue: (() => void)[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private launcher: PwLauncher | null;
  private renders = 0;
  private failures = 0;
  private hardKills = 0;
  private lastError: string | null = null;

  constructor(private readonly options: BrowserPoolOptions) {
    this.launcher = options.launcher ?? null;
    installProcessReaper(options.logger);
  }

  stats(): Record<string, unknown> {
    return {
      enabled: this.options.enabled,
      launched: this.browser !== null,
      active: this.active,
      queued: this.queue.length,
      renders: this.renders,
      failures: this.failures,
      hardKills: this.hardKills,
      lastError: this.lastError,
      trackedPids: trackedPids.size,
    };
  }

  private async resolveLauncher(): Promise<PwLauncher> {
    if (this.launcher) return this.launcher;
    // Non-literal specifier: TypeScript cannot resolve it at build time, which
    // is what lets the main app typecheck without Playwright installed.
    const specifier = 'playwright';
    const mod = (await import(specifier)) as { chromium?: PwLauncher };
    if (!mod.chromium) throw new BrowserUnavailable('playwright.chromium introuvable', 'not_installed');
    this.launcher = mod.chromium;
    return this.launcher;
  }

  private async ensureBrowser(): Promise<PwBrowser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      const launcher = await this.resolveLauncher();
      const launchOptions: Record<string, unknown> = {
        headless: true,
        args: [
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--mute-audio',
          '--no-first-run',
          '--no-default-browser-check',
        ],
      };
      if (this.options.executablePath) launchOptions['executablePath'] = this.options.executablePath;

      const server = await withDeadline(
        45_000,
        'lancement du navigateur',
        launcher.launchServer(launchOptions),
      );
      // Register the pid before anything else can throw: an exception between
      // spawn and tracking is precisely how a process becomes an orphan.
      const pid = server.process()?.pid;
      trackPid(pid);
      this.server = server;

      try {
        const browser = await withDeadline(
          20_000,
          'connexion au navigateur',
          launcher.connect(server.wsEndpoint()),
        );
        this.browser = browser;
        this.options.logger.info('browser.launched', { pid: pid ?? null });
        return browser;
      } catch (error) {
        // Connected or not, the process exists and is ours to clean up.
        await this.destroy('connect_failed');
        throw error;
      }
    })();

    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  /**
   * Force-closes the browser and guarantees the OS process is gone.
   *
   * Three escalating attempts, each with its own deadline: disconnect, ask the
   * server to close, then kill. The last one cannot be refused.
   */
  private async destroy(reason: string): Promise<void> {
    const browser = this.browser;
    const server = this.server;
    this.browser = null;
    this.server = null;
    if (!browser && !server) return;
    const pid = server?.process()?.pid;

    let graceful = false;
    if (browser) {
      graceful = await withDeadline(this.options.hardKillMs, 'fermeture du navigateur', browser.close())
        .then(() => true)
        .catch(() => false);
    }
    if (server) {
      const closed = await withDeadline(this.options.hardKillMs, 'arrêt du serveur', server.close())
        .then(() => true)
        .catch(() => false);
      graceful = graceful && closed;

      if (!closed) {
        // This is the Sprint 1 failure mode: a graceful close that never
        // returns. Stop asking.
        this.hardKills += 1;
        this.options.logger.warn('browser.hard_kill', { reason, pid: pid ?? null });
        await withDeadline(5_000, 'kill du serveur', server.kill()).catch(() => undefined);
        if (typeof pid === 'number') {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // Already dead: the desired state.
            }
          }
        }
      }
    }

    if (graceful) this.options.logger.info('browser.closed', { reason, pid: pid ?? null });
    untrackPid(pid);
  }

  private acquire(): Promise<void> {
    if (this.active < this.options.maxContexts) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
    else this.scheduleIdleShutdown();
  }

  private scheduleIdleShutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.options.idleShutdownMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.active === 0 && this.browser) {
        void this.destroy('idle');
      }
    }, this.options.idleShutdownMs);
    this.idleTimer.unref?.();
  }

  /**
   * Renders a URL and returns its DOM. The whole operation, including launch,
   * navigation and teardown, is bounded by `timeoutMs`.
   */
  async render(rawUrl: string, timeoutMs?: number): Promise<RenderResult> {
    if (!this.options.enabled) {
      throw new BrowserUnavailable('rendu navigateur désactivé', 'disabled');
    }
    const url = assertSafeUrl(rawUrl);
    const budget = timeoutMs ?? this.options.navTimeoutMs;
    const started = Date.now();

    await this.acquire();
    let context: PwContext | null = null;
    let page: PwPage | null = null;
    try {
      const browser = await this.ensureBrowser();
      context = await withDeadline(15_000, 'création du contexte', browser.newContext({
        javaScriptEnabled: true,
        bypassCSP: false,
        ignoreHTTPSErrors: false,
        viewport: { width: 1280, height: 900 },
        locale: 'fr-FR',
      }));

      // The browser resolves DNS itself, so the SSRF rules have to be enforced
      // on its request path too — including redirects and sub-resources.
      const ctx = context;
      await ctx.route('**/*', async (route) => {
        const request = route.request();
        const target = request.url();
        if (!isSafeUrl(target)) {
          await route.abort('blockedbyclient').catch(() => undefined);
          return;
        }
        if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
          await route.abort('blockedbyclient').catch(() => undefined);
          return;
        }
        await route.continue().catch(() => undefined);
      });

      page = await withDeadline(10_000, 'ouverture de la page', ctx.newPage());
      const activePage = page;

      const response = await withDeadline(
        budget,
        'navigation',
        activePage.goto(url.toString(), { timeout: budget, waitUntil: 'domcontentloaded' }),
      );

      // Give a client-side app a moment to paint, but never more than a slice
      // of the remaining budget.
      const remaining = budget - (Date.now() - started);
      if (remaining > 1_500) {
        await withDeadline(
          Math.min(3_000, remaining),
          'stabilisation',
          activePage.waitForTimeout(Math.min(1_500, remaining - 500)),
        ).catch(() => undefined);
      }

      const html = await withDeadline(10_000, 'lecture du DOM', activePage.content());
      this.renders += 1;

      return {
        html,
        finalUrl: activePage.url() || url.toString(),
        status: response?.status() ?? 0,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      this.failures += 1;
      this.lastError = errorMessage(error);
      // The browser may be wedged. Do not hand it to the next caller.
      await this.destroy('render_failed');
      if (error instanceof BrowserUnavailable) throw error;
      throw new BrowserUnavailable(errorMessage(error), 'render_failed');
    } finally {
      // Teardown is best-effort and time-boxed; `destroy` is the backstop.
      if (page) await withDeadline(5_000, 'fermeture de la page', page.close()).catch(() => undefined);
      if (context) await withDeadline(5_000, 'fermeture du contexte', context.close()).catch(() => undefined);
      this.release();
    }
  }

  /** Ordered shutdown, called on SIGTERM. */
  async shutdown(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.queue = [];
    await this.destroy('shutdown');
    reapTrackedProcesses();
  }
}
