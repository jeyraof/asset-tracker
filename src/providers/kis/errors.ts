/** Well-known KIS error codes we need to react to. */
export const KIS_MSG = {
  /** Access token may only be issued once per minute. */
  TOKEN_RATE_LIMIT: "EGW00133",
  /** Invalid/expired access token. */
  TOKEN_INVALID: "EGW00121",
  /** Access token period expired. */
  TOKEN_EXPIRED: "EGW00123",
  /** Per-second call limit exceeded. */
  RATE_LIMIT: "EGW00201",
} as const;

export interface KisApiErrorOptions {
  msgCd?: string | null;
  rtCd?: string | null;
  path?: string;
  trId?: string;
  status?: number;
  body?: unknown;
}

export class KisApiError extends Error {
  readonly msgCd: string | null;
  readonly rtCd: string | null;
  readonly path?: string;
  readonly trId?: string;
  readonly status?: number;
  readonly body?: unknown;

  constructor(message: string, options: KisApiErrorOptions = {}) {
    super(message);
    this.name = "KisApiError";
    this.msgCd = options.msgCd ?? null;
    this.rtCd = options.rtCd ?? null;
    this.path = options.path;
    this.trId = options.trId;
    this.status = options.status;
    this.body = options.body;
  }

  isTokenError(): boolean {
    return this.msgCd === KIS_MSG.TOKEN_INVALID || this.msgCd === KIS_MSG.TOKEN_EXPIRED;
  }

  isRateLimit(): boolean {
    return this.msgCd === KIS_MSG.RATE_LIMIT || this.msgCd === KIS_MSG.TOKEN_RATE_LIMIT;
  }

  /** Generic accessor so provider-agnostic code can surface the error code. */
  get code(): string | null {
    return this.msgCd;
  }
}

export function isKisApiError(error: unknown): error is KisApiError {
  return error instanceof KisApiError;
}
