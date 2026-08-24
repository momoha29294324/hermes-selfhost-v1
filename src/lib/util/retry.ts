/** Bounded retry with exponential backoff and jitter. Never retries forever. */

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to fail fast (e.g. 4xx that will never succeed). */
  retryable?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const base = options.baseDelayMs ?? 500;
  const max = options.maxDelayMs ?? 8_000;
  const retryable = options.retryable ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !retryable(error)) break;
      const backoff = Math.min(max, base * 2 ** (attempt - 1));
      const delay = Math.round(backoff * (0.5 + random() * 0.5));
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Rejects with a TimeoutError when `promise` outlives `ms`. */
export class TimeoutError extends Error {
  constructor(ms: number, label: string) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(
  ms: number,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TimeoutError(ms, label)), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
