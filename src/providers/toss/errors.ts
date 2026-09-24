/** Toss error codes we react to (see the OpenAPI error table). */
export const TOSS_CODE = {
  INVALID_TOKEN: "invalid-token",
  EXPIRED_TOKEN: "expired-token",
  TOKEN_REVOKED: "token-revoked",
  ACCOUNT_HEADER_REQUIRED: "account-header-required",
} as const;

export interface TossApiErrorOptions {
  code?: string | null;
  status?: number;
  path?: string;
  requestId?: string;
  retryAfterMs?: number;
  body?: unknown;
}

export class TossApiError extends Error {
  readonly code: string | null;
  readonly status?: number;
  readonly path?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly body?: unknown;

  constructor(message: string, options: TossApiErrorOptions = {}) {
    super(message);
    this.name = "TossApiError";
    this.code = options.code ?? null;
    this.status = options.status;
    this.path = options.path;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs;
    this.body = options.body;
  }

  isTokenError(): boolean {
    return (
      this.code === TOSS_CODE.INVALID_TOKEN ||
      this.code === TOSS_CODE.EXPIRED_TOKEN ||
      this.code === TOSS_CODE.TOKEN_REVOKED
    );
  }
}

export function isTossApiError(error: unknown): error is TossApiError {
  return error instanceof TossApiError;
}
