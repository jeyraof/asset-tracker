import { RateLimiter, withRetry } from "../../lib/rateLimit";
import { logger } from "../../lib/logger";
import { getKiwoomAccessToken, invalidateKiwoomToken } from "./auth";
import { isKiwoomApiError, KiwoomApiError, normalizeKiwoomReturnCode } from "./errors";
import type { KiwoomEnvironment } from "./tr-ids";
import type { KiwoomEnvelope } from "./types";

export interface KiwoomCallResult<T> {
  body: T;
  /** Response `cont-yn` header: "Y" when more pages are available. */
  contYn: string | null;
  nextKey: string | null;
}

export interface KiwoomClientOptions {
  baseUrl: string;
  appkey: string;
  appsecret: string;
  env: KiwoomEnvironment;
  cache: KVNamespace;
  rateLimiter: RateLimiter;
  /** Shared secret header expected by the reverse proxy, if any. */
  relaySecret?: string;
  fetchImpl?: typeof fetch;
  debug?: boolean;
}

export interface KiwoomRequestInit {
  contYn?: string;
  nextKey?: string;
}

export class KiwoomClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: KiwoomClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T extends KiwoomEnvelope>(
    apiId: string,
    path: string,
    body: Record<string, unknown>,
    init: KiwoomRequestInit = {},
  ): Promise<KiwoomCallResult<T>> {
    return this.execute<T>(apiId, path, body, init, true);
  }

  /** Iterates a paginated Kiwoom endpoint using `cont-yn` + `next-key`. */
  async *paginate<T extends KiwoomEnvelope>(
    apiId: string,
    path: string,
    body: Record<string, unknown>,
    maxPages = 20,
  ): AsyncGenerator<T, void, void> {
    let contYn: string | undefined;
    let nextKey: string | undefined;

    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.request<T>(apiId, path, body, { contYn, nextKey });
      yield result.body;

      if (result.contYn !== "Y") break;
      contYn = "Y";
      nextKey = result.nextKey ?? "";
    }
  }

  private async execute<T extends KiwoomEnvelope>(
    apiId: string,
    path: string,
    body: Record<string, unknown>,
    init: KiwoomRequestInit,
    allowTokenRetry: boolean,
  ): Promise<KiwoomCallResult<T>> {
    return withRetry(
      () => this.perform<T>(apiId, path, body, init, allowTokenRetry),
      {
        retries: 3,
        baseDelayMs: 600,
        maxDelayMs: 4_000,
        shouldRetry: (error) => isKiwoomApiError(error) && error.isRateLimit(),
      },
    );
  }

  private async perform<T extends KiwoomEnvelope>(
    apiId: string,
    path: string,
    body: Record<string, unknown>,
    init: KiwoomRequestInit,
    allowTokenRetry: boolean,
  ): Promise<KiwoomCallResult<T>> {
    await this.options.rateLimiter.wait();

    const token = await getKiwoomAccessToken({
      baseUrl: this.options.baseUrl,
      appkey: this.options.appkey,
      appsecret: this.options.appsecret,
      env: this.options.env,
      cache: this.options.cache,
      relaySecret: this.options.relaySecret,
      fetchImpl: this.fetchImpl,
    });

    const headers: Record<string, string> = {
      "content-type": "application/json;charset=UTF-8",
      "api-id": apiId,
      authorization: `Bearer ${token}`,
    };
    if (this.options.relaySecret) headers["X-Kiwoom-Relay"] = this.options.relaySecret;
    if (init.contYn) headers["cont-yn"] = init.contYn;
    if (init.nextKey !== undefined) headers["next-key"] = init.nextKey;

    // Call via a local reference: `fetch` throws an Illegal invocation error
    // in Workers if invoked as a method (wrong `this`).
    const doFetch = this.fetchImpl;
    if (this.options.debug) {
      logger.info("kiwoom request", { apiId, path });
    }

    const response = await doFetch(new URL(path, this.options.baseUrl).toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const text = await response.text();
    let parsed: T;
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      throw new KiwoomApiError("Failed to parse Kiwoom response", {
        path,
        apiId,
        status: response.status,
        body: text,
      });
    }

    const returnCode = normalizeKiwoomReturnCode(parsed.return_code, parsed.return_msg);
    if (!response.ok || (returnCode !== null && returnCode !== 0)) {
      const error = new KiwoomApiError(parsed.return_msg ?? "Kiwoom API error", {
        returnCode,
        path,
        apiId,
        status: response.status,
        body: parsed,
      });

      if (allowTokenRetry && error.isTokenError()) {
        await invalidateKiwoomToken(this.options.cache, this.options.env, this.options.appkey);
        return this.execute<T>(apiId, path, body, init, false);
      }
      throw error;
    }

    return {
      body: parsed,
      contYn: response.headers.get("cont-yn"),
      nextKey: response.headers.get("next-key"),
    };
  }
}
