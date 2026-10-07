/** An error from a model provider. `retryable` tells the runner whether to try again. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** 408, 409, 429 and 5xx (incl. Anthropic's 529 "overloaded") are worth retrying. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** POST JSON and turn HTTP/network failures into ProviderErrors. */
export async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    // Network errors and timeouts.
    throw new ProviderError(`request failed: ${(err as Error).message}`, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(`HTTP ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 300)}`, isRetryableStatus(res.status), res.status);
  }
  return res.json();
}
