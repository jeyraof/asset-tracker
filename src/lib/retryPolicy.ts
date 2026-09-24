/**
 * Provider-agnostic transient-failure classification shared by broker clients.
 * Logical (broker-specific) rate-limit codes are composed in by each client;
 * this module only understands transport-level signals (HTTP status, network
 * exceptions) plus the `Retry-After` hint and the fetch timeout signal.
 */

import { errorStatus } from "./errors";

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Process-wide retry counter. Isolates are reused across invocations, so the
 * orchestrator resets it at the start of each run and reads it at the end.
 */
let retryCounter = 0;

export function recordRetry(): void {
  retryCounter += 1;
}

/** Returns and resets the retry counter. */
export function takeRetries(): number {
  const value = retryCounter;
  retryCounter = 0;
  return value;
}

/** True for fetch network failures and aborted (timed out) requests. */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  if (error instanceof TypeError) return true;
  return false;
}

/** HTTP 429/5xx or a transport-level error: safe to retry with backoff. */
export function isTransientHttp(error: unknown): boolean {
  if (isNetworkError(error)) return true;
  const status = errorStatus(error);
  if (status === undefined) return false;
  return status === 429 || (status >= 500 && status <= 599);
}

/** Parses a `Retry-After` header (delta-seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return clampRetryAfter(Math.max(0, seconds) * 1000);
  }

  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return clampRetryAfter(Math.max(0, date - now));
  return undefined;
}

function clampRetryAfter(ms: number): number {
  return Math.min(MAX_RETRY_AFTER_MS, Math.round(ms));
}

/** Reads a `retryAfterMs` hint attached to an error, if any. */
export function retryAfterMsOf(error: unknown): number | undefined {
  if (error && typeof error === "object" && "retryAfterMs" in error) {
    const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * An `AbortSignal` that fires after `timeoutMs`, so a hung broker connection
 * fails fast and becomes retryable. Returns `undefined` where unsupported.
 */
export function requestSignal(timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS): AbortSignal | undefined {
  if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") {
    return undefined;
  }
  return AbortSignal.timeout(timeoutMs);
}
