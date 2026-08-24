import { defaultSleep } from '@/lib/util/retry';
import type { Logger } from '@/lib/logging/logger';

/**
 * Mise en forme du débit, par fournisseur.
 *
 * Le benchmark R1 a montré le problème : sur un run de 60 prospects, cinq
 * moteurs sur neuf avaient ouvert leur disjoncteur avant la fin. Le rail
 * n'était pas mal écrit, il était mal cadencé — tous les appels partaient aussi
 * vite que la boucle les produisait, et un fournisseur public gratuit répond à
 * ça en fermant la porte.
 *
 * Ce que fait ce fichier : une file par fournisseur, une concurrence basse, un
 * espacement minimal, un peu de gigue, et une mise au repos après des échecs
 * répétés.
 *
 * Ce qu'il ne fait pas, et ne fera pas : contourner quoi que ce soit. La gigue
 * n'est pas là pour ressembler à un humain — elle est là pour que deux boucles
 * indépendantes ne tapent pas la même seconde. Le repos n'est pas une attente
 * avant de réessayer plus discrètement : c'est un arrêt. Un fournisseur qui
 * refuse est un fournisseur qu'on laisse tranquille, et le rapport le dit.
 *
 * Horloge, sommeil et aléa sont injectables : la cadence est une logique
 * déterministe, donc elle est testée comme telle.
 */

export interface ProviderLimits {
  /** Appels simultanés autorisés. Bas par défaut : ce sont des services gratuits. */
  concurrency: number;
  /** Délai minimal entre deux démarrages d'appel. */
  minIntervalMs: number;
  /** Gigue ajoutée à l'espacement, pour désynchroniser deux boucles. */
  jitterMs: number;
  /** Échecs consécutifs avant mise au repos. */
  failureThreshold: number;
  /** Durée du repos. Pendant ce temps, le fournisseur n'est plus appelé. */
  cooldownMs: number;
  /** Plafond d'appels sur la durée de vie de l'ordonnanceur. 0 = pas de plafond. */
  maxCalls: number;
}

export const DEFAULT_LIMITS: ProviderLimits = {
  concurrency: 1,
  minIntervalMs: 1_100,
  jitterMs: 250,
  failureThreshold: 4,
  cooldownMs: 120_000,
  maxCalls: 0,
};

export interface ProviderState {
  provider: string;
  calls: number;
  failures: number;
  consecutiveFailures: number;
  /** Horodatage de fin de repos, ou null quand le fournisseur est disponible. */
  cooldownUntil: number | null;
  totalWaitMs: number;
  totalDurationMs: number;
  lastError: string | null;
}

/** Levé quand un fournisseur est au repos ou a épuisé son plafond d'appels. */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: 'cooldown' | 'max_calls',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

interface Queue {
  limits: ProviderLimits;
  state: ProviderState;
  /** Créneaux occupés : promesses en cours, bornées par `concurrency`. */
  active: Set<Promise<unknown>>;
  /** Chaîne d'attente garantissant l'espacement entre démarrages. */
  gate: Promise<void>;
  lastStartedAt: number;
}

export interface ProviderSchedulerDeps {
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Réglages par fournisseur, fusionnés avec les valeurs par défaut. */
  limits?: Record<string, Partial<ProviderLimits>>;
  defaults?: Partial<ProviderLimits>;
}

export class ProviderScheduler {
  private readonly queues = new Map<string, Queue>();
  private readonly logger: Logger | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly defaults: ProviderLimits;
  private readonly overrides: Record<string, Partial<ProviderLimits>>;

  constructor(deps: ProviderSchedulerDeps = {}) {
    this.logger = deps.logger ?? null;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.defaults = { ...DEFAULT_LIMITS, ...deps.defaults };
    this.overrides = deps.limits ?? {};
  }

  configure(provider: string, limits: Partial<ProviderLimits>): void {
    const queue = this.queueFor(provider);
    queue.limits = { ...queue.limits, ...limits };
  }

  private queueFor(provider: string): Queue {
    let queue = this.queues.get(provider);
    if (!queue) {
      queue = {
        limits: { ...this.defaults, ...(this.overrides[provider] ?? {}) },
        state: {
          provider,
          calls: 0,
          failures: 0,
          consecutiveFailures: 0,
          cooldownUntil: null,
          totalWaitMs: 0,
          totalDurationMs: 0,
          lastError: null,
        },
        active: new Set(),
        gate: Promise.resolve(),
        lastStartedAt: 0,
      };
      this.queues.set(provider, queue);
    }
    return queue;
  }

  /** Vrai quand un appel serait accepté maintenant. Lecture, sans effet. */
  available(provider: string): { ok: boolean; reason?: string } {
    const queue = this.queueFor(provider);
    if (queue.state.cooldownUntil !== null && this.now() < queue.state.cooldownUntil) {
      const seconds = Math.ceil((queue.state.cooldownUntil - this.now()) / 1000);
      return { ok: false, reason: `${provider} au repos encore ${seconds} s` };
    }
    if (queue.limits.maxCalls > 0 && queue.state.calls >= queue.limits.maxCalls) {
      return { ok: false, reason: `${provider} a atteint son plafond de ${queue.limits.maxCalls} appels` };
    }
    return { ok: true };
  }

  /**
   * Exécute `fn` sous la cadence du fournisseur.
   *
   * Lève `ProviderUnavailableError` sans appeler `fn` quand le fournisseur est
   * au repos : c'est l'appelant qui décide si cela dégrade son rail ou l'arrête.
   */
  async run<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const queue = this.queueFor(provider);
    const availability = this.available(provider);
    if (!availability.ok) {
      const kind = queue.state.cooldownUntil !== null && this.now() < queue.state.cooldownUntil ? 'cooldown' : 'max_calls';
      throw new ProviderUnavailableError(provider, kind, availability.reason ?? `${provider} indisponible`);
    }

    // Repos terminé : on repart d'une ardoise propre plutôt que de rouvrir à un
    // échec du plafond précédent.
    if (queue.state.cooldownUntil !== null && this.now() >= queue.state.cooldownUntil) {
      queue.state.cooldownUntil = null;
      queue.state.consecutiveFailures = 0;
    }

    // --- concurrence : attendre qu'un créneau se libère
    while (queue.active.size >= Math.max(1, queue.limits.concurrency)) {
      await Promise.race([...queue.active]).catch(() => undefined);
    }

    // --- espacement : sérialisé par une chaîne de promesses, comme HttpClient
    const waitStartedAt = this.now();
    const previous = queue.gate;
    let release!: () => void;
    queue.gate = previous.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await previous;

    const jitter = Math.round(queue.limits.jitterMs * this.random());
    const due = queue.lastStartedAt + queue.limits.minIntervalMs + jitter;
    const wait = due - this.now();
    if (wait > 0) await this.sleep(wait);
    queue.lastStartedAt = this.now();
    queue.state.totalWaitMs += this.now() - waitStartedAt;
    // Libère la porte au tick suivant pour que l'appelant suivant reparte du
    // `lastStartedAt` qu'on vient d'écrire.
    setTimeout(() => release(), 0);

    // --- exécution
    const startedAt = this.now();
    const task = (async () => fn())();
    queue.active.add(task);
    queue.state.calls += 1;

    try {
      const result = await task;
      queue.state.consecutiveFailures = 0;
      queue.state.totalDurationMs += this.now() - startedAt;
      return result;
    } catch (error) {
      queue.state.failures += 1;
      queue.state.consecutiveFailures += 1;
      queue.state.totalDurationMs += this.now() - startedAt;
      queue.state.lastError = error instanceof Error ? error.message : String(error);
      if (queue.state.consecutiveFailures >= queue.limits.failureThreshold) {
        queue.state.cooldownUntil = this.now() + queue.limits.cooldownMs;
        this.logger?.warn('scheduler.cooldown', {
          provider,
          consecutiveFailures: queue.state.consecutiveFailures,
          cooldownMs: queue.limits.cooldownMs,
        });
      }
      throw error;
    } finally {
      queue.active.delete(task);
    }
  }

  state(provider: string): ProviderState {
    return { ...this.queueFor(provider).state };
  }

  snapshot(): ProviderState[] {
    return [...this.queues.values()].map((queue) => ({ ...queue.state }));
  }
}
