/**
 * Bounded retry for integration HTTP calls that may answer 429 or a transient
 * 5xx. Honors `Retry-After` (seconds or HTTP date) when present, otherwise
 * backs off exponentially with jitter, and stops as soon as `signal` aborts.
 * Everything else (4xx, a 2xx, a JSON body) is the caller's business — this
 * helper only decides WHEN to call `fetch` again.
 */
const DEFAULT_ATTEMPTS = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

export interface FetchRetryOptions {
  /** Total attempts including the first; defaults to 5. */
  attempts?: number;
  signal?: AbortSignal;
  /**
   * Reads at most about this many bytes of a retryable response's body before
   * cancelling it (Task-1441 P7a, H2), so a large retry body is never held;
   * unset, the body is drained whole as before. It is never parsed either way.
   */
  retryBodyLimitBytes?: number;
  /** Called before each wait so a long export can surface "rate limited, retrying". */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    status: number;
  }) => void;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
let sleepImpl = defaultSleep;

/** Test-only seam: replace the wait so retry tests do not sleep for real. */
export function setRetrySleepForTests(
  impl: ((ms: number, signal?: AbortSignal) => Promise<void>) | null,
): void {
  sleepImpl = impl ?? defaultSleep;
}

function abortError(): Error {
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  return error;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** Milliseconds to wait before attempt `attempt` (1-based count of failures so far). */
export function retryDelayMs(
  attempt: number,
  retryAfterHeader: string | null,
): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(MAX_DELAY_MS, Math.ceil(seconds * 1000));
    const at = Date.parse(retryAfterHeader);
    if (Number.isFinite(at))
      return Math.min(MAX_DELAY_MS, Math.max(0, at - Date.now()));
  }
  const exponential = BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * BASE_DELAY_MS);
  return Math.min(MAX_DELAY_MS, exponential + jitter);
}

/**
 * `fetch` that retries rate-limit and transient upstream failures. A network
 * error counts as transient too. The final failed response (or the last
 * network error) is returned/thrown unchanged so callers keep their own
 * status handling.
 */
export async function fetchWithRetry(
  url: URL | string,
  init: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError();
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        ...init,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (response && !isRetryableStatus(response.status)) return response;
    if (attempt === attempts) {
      if (response) return response;
      throw lastError ?? new Error("fetchWithRetry exhausted attempts.");
    }
    const delayMs = retryDelayMs(
      attempt,
      response?.headers.get("retry-after") ?? null,
    );
    options.onRetry?.({ attempt, delayMs, status: response?.status ?? 0 });
    if (response) await discardRetryBody(response, options);
    await sleepImpl(delayMs, options.signal);
  }
  throw lastError ?? new Error("fetchWithRetry exhausted attempts.");
}

/**
 * A retryable response's body, discarded before the wait. Unbounded, it is
 * drained so the connection can be reused. Bounded, it is read until the
 * limit or its end, then cancelled. A read failure is ignored either way; an
 * abort during the bounded read cancels it and throws the abort.
 */
async function discardRetryBody(
  response: Response,
  options: FetchRetryOptions,
): Promise<void> {
  const limit = options.retryBodyLimitBytes;
  if (limit === undefined) {
    await response.text().catch(() => undefined);
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    let read = 0;
    while (read < limit) {
      const next = await reader.read();
      if (next.done) break;
      read += next.value.byteLength;
    }
  } catch {
    if (options.signal?.aborted) throw abortError();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** A request deadline that also ends when the caller's `signal` aborts. */
export function deadlineSignal(
  timeoutMs: number,
  signal?: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
