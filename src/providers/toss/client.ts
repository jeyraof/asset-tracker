import { markAttempts } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { RateLimiter, withRetry } from "../../lib/rateLimit";
import {
  isTransientHttp,
  parseRetryAfter,
  recordRetry,
  requestSignal,
  retryAfterMsOf,
} from "../../lib/retryPolicy";
import { getTossAccessToken, invalidateTossToken } from "./auth";
import { isTossApiError, TossApiError } from "./errors";
import type { TossErrorBody } from "./types";

export type TossQueryValue = string | number | boolean | null | undefined;

export interface TossCallOptions {
  params?: Record<string, TossQueryValue>;
  /** Sent as `X-Tossinvest-Account` for account/asset/order endpoints. */
  accountSeq?: number | null;
}

export interface TossClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  env: string;
  cache: KVNamespace;
  /** Shared across calls so requests are serialized. */
  rateLimiter: RateLimiter;
  /** Shared secret sent as `X-Toss-Relay` to the reverse proxy, if any. */
  relaySecret?: string;
  fetchImpl?: typeof fetch;
  debug?: boolean;
}

/**
 * Minimal Toss Open API client: OAuth2 bearer token + optional account header,
 * JSON `{ result }` envelope on success and `{ error }` on failure. Transport
 * (429/5xx/network) failures are retried; a token error re-issues once.
 */
export class TossClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TossClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T>(
    method: string,
    path: string,
    call: TossCallOptions = {},
    allowTokenRetry = true,
  ): Promise<T> {
    let attempts = 0;

    return withRetry(
      async () => {
        await this.options.rateLimiter.wait();
        const token = await getTossAccessToken({
          baseUrl: this.options.baseUrl,
          clientId: this.options.clientId,
          clientSecret: this.options.clientSecret,
          env: this.options.env,
          cache: this.options.cache,
          relaySecret: this.options.relaySecret,
          fetchImpl: this.options.fetchImpl,
        });

        const url = new URL(path, this.options.baseUrl);
        for (const [key, value] of Object.entries(call.params ?? {})) {
          if (value === undefined || value === null) continue;
          url.searchParams.set(key, String(value));
        }

        const headers: Record<string, string> = {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        };
        if (call.accountSeq !== undefined && call.accountSeq !== null) {
          headers["X-Tossinvest-Account"] = String(call.accountSeq);
        }
        if (this.options.relaySecret) headers["X-Toss-Relay"] = this.options.relaySecret;

        // Call via a local reference (Workers throws "Illegal invocation" otherwise).
        const doFetch = this.fetchImpl;
        if (this.options.debug) {
          logger.info("toss request", { method, path, accountSeq: call.accountSeq });
        }

        const response = await doFetch(url.toString(), {
          method,
          headers,
          signal: requestSignal(),
        });

        const text = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw new TossApiError("Failed to parse Toss response", {
            status: response.status,
            path,
            body: text,
            retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
          });
        }

        if (!response.ok) {
          const error = (body as TossErrorBody).error;
          throw new TossApiError(error?.message ?? `Toss HTTP ${response.status}`, {
            code: error?.code ?? null,
            status: response.status,
            path,
            requestId: error?.requestId,
            retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
            body,
          });
        }

        const result = (body as { result?: unknown }).result;
        return (result ?? body) as T;
      },
      {
        retries: 3,
        baseDelayMs: 500,
        maxDelayMs: 4_000,
        shouldRetry: isTransientHttp,
        onRetry: () => {
          attempts += 1;
          recordRetry();
        },
        delayFor: (error, _attempt, fallbackMs) => retryAfterMsOf(error) ?? fallbackMs,
      },
    ).catch(async (error: unknown) => {
      markAttempts(error, attempts + 1);
      if (allowTokenRetry && isTossApiError(error) && error.isTokenError()) {
        await invalidateTossToken(this.options.cache, this.options.env, this.options.clientId);
        return this.request<T>(method, path, call, false);
      }
      throw error;
    });
  }
}
