/** Well-known Kiwoom error codes we need to react to. */
export const KIWOOM_CODE = {
  /** Token is no longer valid. */
  TOKEN_INVALID: 8005,
  /** Token/device authentication failed. */
  TOKEN_AUTH_FAILED: 8103,
  /** Token was issued to a different IP than the one calling. */
  TOKEN_IP_MISMATCH: 8010,
  /** Per-API request quota/flow exceeded. */
  RATE_LIMIT: 1700,
  /** No data for the requested range/account (not a failure). */
  NO_DATA: 501724,
} as const;

export interface KiwoomApiErrorOptions {
  returnCode?: number | null;
  path?: string;
  apiId?: string;
  status?: number;
  body?: unknown;
  retryAfterMs?: number;
}

export class KiwoomApiError extends Error {
  readonly returnCode: number | null;
  readonly path?: string;
  readonly apiId?: string;
  readonly status?: number;
  readonly body?: unknown;
  readonly retryAfterMs?: number;

  constructor(message: string, options: KiwoomApiErrorOptions = {}) {
    super(message);
    this.name = "KiwoomApiError";
    this.returnCode = options.returnCode ?? null;
    this.path = options.path;
    this.apiId = options.apiId;
    this.status = options.status;
    this.body = options.body;
    this.retryAfterMs = options.retryAfterMs;
  }

  isTokenError(): boolean {
    return (
      this.returnCode === KIWOOM_CODE.TOKEN_INVALID ||
      this.returnCode === KIWOOM_CODE.TOKEN_AUTH_FAILED
    );
  }

  isRateLimit(): boolean {
    return this.returnCode === KIWOOM_CODE.RATE_LIMIT;
  }

  isNoData(): boolean {
    return this.returnCode === KIWOOM_CODE.NO_DATA;
  }

  /** Generic accessor so provider-agnostic code can surface the error code. */
  get code(): string | null {
    return this.returnCode === null ? null : String(this.returnCode);
  }
}

export function isKiwoomApiError(error: unknown): error is KiwoomApiError {
  return error instanceof KiwoomApiError;
}

/**
 * Kiwoom sometimes reports logical errors as `return_code` 3/other with the
 * real code embedded in `return_msg` like `[8005:...]`. Normalize to the
 * embedded code when present.
 */
export function normalizeKiwoomReturnCode(
  returnCode: number | string | undefined,
  returnMsg: string | undefined,
): number | null {
  if (typeof returnMsg === "string") {
    // e.g. "[2000](501724:관련자료가없습니다)" or "[8005:...]"
    const paren = returnMsg.match(/\((\d{3,6})\s*:/);
    if (paren) return Number(paren[1]);
    const bracket = returnMsg.match(/\[(\d{3,6})\s*:/);
    if (bracket) return Number(bracket[1]);
  }
  if (returnCode === undefined || returnCode === null || returnCode === "") return null;
  const numeric = Number(returnCode);
  return Number.isFinite(numeric) ? numeric : null;
}
