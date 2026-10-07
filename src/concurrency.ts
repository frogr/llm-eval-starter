import { ProviderError } from "./providers/errors";

/**
 * Like Promise.all(items.map(fn)) but with at most `limit` in flight.
 * Results keep input order. Provider rate limits make this non-optional.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  onRetry?: (err: Error, attempt: number) => void;
}

/**
 * Retry retryable ProviderErrors with exponential backoff and jitter.
 * Anything else (bad API key, malformed request, bugs) fails immediately:
 * retrying those just burns time.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<{ value: T; retries: number }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await fn(), retries: attempt - 1 };
    } catch (err) {
      const retryable = err instanceof ProviderError && err.retryable;
      if (!retryable || attempt >= opts.attempts) throw err;
      opts.onRetry?.(err as Error, attempt);
      const delay = opts.baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
