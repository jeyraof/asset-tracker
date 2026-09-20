import { RateLimiter, withRetry } from "../../lib/rateLimit";
import { logger } from "../../lib/logger";
import { getAccessToken, invalidateAccessToken } from "./auth";
import { isKisApiError, KisApiError } from "./errors";
import type { KisEnvelope } from "./types";
import type { KisEnvironment } from "./tr-ids";

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

export interface KisCallResult<T> {
  body: T;
  /** Response `tr_cont` header: "" | "M" | "F" | "D" | "E". */
  trCont: string | null;
}

export interface KisClientOptions {
  baseUrl: string;
  appkey: string;
  appsecret: string;
  env: KisEnvironment;
  cache: KVNamespace;
  rateLimiter: RateLimiter;
  fetchImpl?: typeof fetch;
  debug?: boolean;
}

export interface KisRequestInit {
  params?: QueryParams;
  headers?: Record<string, string>;
}

const RETRY_ON = (error: unknown): boolean => isKisApiError(error) && error.isRateLimit();

export class KisClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: KisClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get<T>(path: string, trId: string, params?: QueryParams, headers?: Record<string, string>) {
    return this.request<T>("GET", path, trId, { params, headers });
  }

  async request<T>(
    method: string,
    path: string,
    trId: string,
    init: KisRequestInit,
  ): Promise<KisCallResult<T>> {
    return withRetry(
      async () => {
        await this.options.rateLimiter.wait();
        const token = await getAccessToken({
          baseUrl: this.options.baseUrl,
          appkey: this.options.appkey,
          appsecret: this.options.appsecret,
          env: this.options.env,
          cache: this.options.cache,
          fetchImpl: this.fetchImpl,
        });

        const url = new URL(path, this.options.baseUrl);
        for (const [key, value] of Object.entries(init.params ?? {})) {
          if (value === undefined || value === null) continue;
          url.searchParams.set(key, String(value));
        }

        // Call via a local reference: `fetch` throws an Illegal invocation error
        // in Workers if invoked as a method (wrong `this`).
        const doFetch = this.fetchImpl;
        if (this.options.debug) {
          logger.info("kis request", {
            method,
            path,
            trId,
            cano: init.params?.["CANO"],
            prdtCd: init.params?.["ACNT_PRDT_CD"],
            tokenPrefix: token.slice(0, 12),
          });
        }
        const response = await doFetch(url.toString(), {
          method,
          headers: {
            "content-type": "application/json; charset=utf-8",
            authorization: `Bearer ${token}`,
            appkey: this.options.appkey,
            appsecret: this.options.appsecret,
            tr_id: trId,
            custtype: "P",
            ...init.headers,
          },
        });

        const text = await response.text();
        let body: T & KisEnvelope;
        try {
          body = JSON.parse(text) as T & KisEnvelope;
        } catch {
          throw new KisApiError("Failed to parse KIS response", {
            path,
            trId,
            status: response.status,
            body: text,
          });
        }

        const rtCd = body.rt_cd;
        if (rtCd !== undefined && rtCd !== "0") {
          throw new KisApiError(body.msg1 ?? "KIS API error", {
            msgCd: body.msg_cd ?? null,
            rtCd,
            path,
            trId,
            status: response.status,
            body,
          });
        }

        return { body, trCont: response.headers.get("tr_cont") };
      },
      {
        retries: 3,
        baseDelayMs: 500,
        maxDelayMs: 4_000,
        shouldRetry: RETRY_ON,
      },
    ).catch(async (error: unknown) => {
      if (error instanceof KisApiError && error.isTokenError()) {
        await invalidateAccessToken(this.options.cache, this.options.env, this.options.appkey);
      }
      throw error;
    });
  }

  /**
   * Iterates a paginated KIS endpoint using `tr_cont` + context-area params.
   * Yields each page body.
   */
  async *paginate<T extends KisEnvelope>(
    path: string,
    trId: string,
    baseParams: QueryParams,
    options: {
      fkKey?: string;
      nkKey?: string;
      fkResponseKey?: string;
      nkResponseKey?: string;
      maxPages?: number;
    } = {},
  ): AsyncGenerator<T, void, void> {
    const fkKey = options.fkKey ?? "CTX_AREA_FK100";
    const nkKey = options.nkKey ?? "CTX_AREA_NK100";
    const fkResponseKey = options.fkResponseKey ?? "ctx_area_fk100";
    const nkResponseKey = options.nkResponseKey ?? "ctx_area_nk100";
    const maxPages = options.maxPages ?? 20;

    let fk = "";
    let nk = "";

    for (let page = 0; page < maxPages; page += 1) {
      const params: QueryParams = { ...baseParams, [fkKey]: fk, [nkKey]: nk };
      const { body, trCont } = await this.get<T>(
        path,
        trId,
        params,
        page === 0 ? undefined : { tr_cont: "N" },
      );

      yield body;

      if (trCont !== "M" && trCont !== "F") break;
      fk = String(body[fkResponseKey] ?? "");
      nk = String(body[nkResponseKey] ?? "");
    }
  }
}
