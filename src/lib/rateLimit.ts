export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializes calls and enforces a minimum interval between them.
 * Broker API rate limits are usually per app key, so a single limiter
 * instance should be shared by every call made with that key (in-isolate).
 */
export class RateLimiter {
  private lastAt = 0;

  constructor(private readonly minIntervalMs: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const waitFor = this.lastAt + this.minIntervalMs - now;
    if (waitFor > 0) await sleep(waitFor);
    this.lastAt = Date.now();
  }
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry: (error: unknown) => boolean;
  /** Called before each retry with the 1-based attempt number about to start. */
  onRetry?: (attempt: number, error: unknown) => void;
  /** Overrides the backoff delay (e.g. to honor a `Retry-After` hint). */
  delayFor?: (error: unknown, attempt: number, fallbackMs: number) => number;
}

/** Retries `fn` with exponential backoff + jitter. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= options.retries || !options.shouldRetry(error)) throw error;
      const base = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
      const delay = Math.max(0, options.delayFor?.(error, attempt + 1, base) ?? base);
      await sleep(delay + Math.random() * options.baseDelayMs);
      attempt += 1;
      options.onRetry?.(attempt, error);
    }
  }
}
