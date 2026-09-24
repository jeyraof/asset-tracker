export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readField(error: unknown, key: string): unknown {
  if (error && typeof error === "object" && key in error) {
    return (error as Record<string, unknown>)[key];
  }
  return undefined;
}

export function errorCode(error: unknown): string | undefined {
  const value = readField(error, "code");
  return typeof value === "string" ? value : undefined;
}

/** HTTP status carried by provider errors (KisApiError / KiwoomApiError). */
export function errorStatus(error: unknown): number | undefined {
  const value = readField(error, "status");
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Request path carried by provider errors, for diagnostics. */
export function errorPath(error: unknown): string | undefined {
  const value = readField(error, "path");
  return typeof value === "string" ? value : undefined;
}

/** Attempt count attached by a client after a retried call finally failed. */
export function errorAttempts(error: unknown): number | undefined {
  const value = readField(error, "attempts");
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Attaches the attempt count to an error so the run report can record it. */
export function markAttempts<T>(error: T, attempts: number): T {
  if (error && typeof error === "object") {
    (error as Record<string, unknown>).attempts = attempts;
  }
  return error;
}

/** Structured, JSON-friendly view of an error for run reports. */
export interface ErrorDetails {
  message: string;
  status?: number;
  code?: string;
  path?: string;
  attempts?: number;
}

export function describeError(error: unknown): ErrorDetails {
  const details: ErrorDetails = { message: errorText(error) };
  const status = errorStatus(error);
  if (status !== undefined) details.status = status;
  const code = errorCode(error);
  if (code !== undefined) details.code = code;
  const path = errorPath(error);
  if (path !== undefined) details.path = path;
  const attempts = errorAttempts(error);
  if (attempts !== undefined) details.attempts = attempts;
  return details;
}
