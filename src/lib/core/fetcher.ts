import "server-only";
import type { SourceId } from "./types";

/**
 * One HTTP path for every provider, so timeouts, caching and failure semantics
 * are identical across sources.
 *
 * Failure policy: a provider call NEVER throws for an upstream problem. It
 * returns `{ ok: false }` with a reason, the provider returns an empty list,
 * and the UI renders an explicit empty/stale state. The only thing that throws
 * is a programming error.
 */

export type FetchOutcome<T> =
  | { readonly ok: true; readonly data: T; readonly fetchedAt: string }
  | {
      readonly ok: false;
      readonly reason: "not_configured" | "http_error" | "timeout" | "bad_payload";
      readonly detail: string;
      readonly status?: number;
      /**
       * The error body, truncated. Kept because the status code alone is not
       * enough to tell operators apart: YouTube returns 400 for both an invalid
       * key and an exhausted quota, and only the body's `reason` field
       * distinguishes them. The /status page reads this.
       */
      readonly errorBody?: string;
    };

/** Error bodies are for diagnostics, never for display. Cap what we keep. */
const MAX_ERROR_BODY_CHARS = 500;

export interface FetchOptions {
  readonly source: SourceId;
  readonly url: string;
  readonly headers?: Record<string, string>;
  /** Next.js ISR window in seconds. */
  readonly revalidate: number;
  /** Cache tag so a rail can be revalidated on demand. */
  readonly tags?: readonly string[];
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Transient connection failures get retried; real answers do not.
 *
 * This exists because of a concrete, measured problem: some Indian ISPs
 * (Airtel confirmed) reset TLS connections to `api.themoviedb.org` on SNI
 * inspection, intermittently. Measured 4 successes in 12 attempts from the
 * development machine — the connection is reset mid-handshake, so it surfaces
 * as ECONNRESET rather than any HTTP status.
 *
 * A reset is not an answer, so retrying it is correct rather than papering over
 * anything. What is NEVER retried is an actual HTTP response: a 401 means the
 * token is wrong and retrying it three times just wastes three round trips and
 * muddies the error. Only 429 and 5xx — the statuses that explicitly mean "ask
 * again" — are retried alongside connection failures.
 */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;

const isRetryableStatus = (status: number): boolean =>
  status === 429 || (status >= 500 && status < 600);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchJson<T>(opts: FetchOptions): Promise<FetchOutcome<T>> {
  let last: FetchOutcome<T> = {
    ok: false,
    reason: "bad_payload",
    detail: `${opts.source}: no attempt was made`,
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    last = await attemptFetchJson<T>(opts);
    if (last.ok) return last;

    const retryable =
      last.reason === "timeout" ||
      last.reason === "bad_payload" ||
      (last.reason === "http_error" && isRetryableStatus(last.status ?? 0));

    if (!retryable || attempt === MAX_ATTEMPTS) return last;

    // Linear backoff. The failures being worked around are per-connection, so
    // waiting long does not help — reconnecting promptly does.
    await sleep(RETRY_BASE_MS * attempt);
  }

  return last;
}

async function attemptFetchJson<T>(opts: FetchOptions): Promise<FetchOutcome<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(opts.url, {
      headers: { accept: "application/json", ...opts.headers },
      signal: controller.signal,
      next: { revalidate: opts.revalidate, tags: opts.tags ? [...opts.tags] : undefined },
    });

    if (!response.ok) {
      // Read the body before discarding it — see MAX_ERROR_BODY_CHARS above.
      let errorBody: string | undefined;
      try {
        errorBody = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
      } catch {
        errorBody = undefined;
      }
      return {
        ok: false,
        reason: "http_error",
        status: response.status,
        detail: `${opts.source} responded ${response.status} ${response.statusText}`,
        errorBody,
      };
    }

    const data = (await response.json()) as T;
    return { ok: true, data, fetchedAt: new Date().toISOString() };
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      reason: isAbort ? "timeout" : "bad_payload",
      detail:
        error instanceof Error ? `${opts.source}: ${error.message}` : `${opts.source}: unknown error`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Timed variant used by healthCheck, so the status page can show latency. */
export async function timedFetchJson<T>(
  opts: FetchOptions,
): Promise<{ outcome: FetchOutcome<T>; latencyMs: number }> {
  const start = Date.now();
  const outcome = await fetchJson<T>(opts);
  return { outcome, latencyMs: Date.now() - start };
}

export function buildUrl(
  base: string,
  params: Record<string, string | number | boolean | undefined>,
): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}
