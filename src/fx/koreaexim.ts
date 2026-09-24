import type { FxRate, FxSource } from "../domain/types";
import { addDays, toCompactDate } from "../lib/dates";
import { markAttempts } from "../lib/errors";
import { withRetry } from "../lib/rateLimit";
import { isTransientHttp, requestSignal, retryAfterMsOf } from "../lib/retryPolicy";

export const KOREAEXIM_SOURCE_ID = "koreaexim";

const DEFAULT_BASE_URL = "https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON";
/** `AP01` = 현재환율 (매매기준율). */
const DATA_TYPE = "AP01";
const USD = "USD";
const KRW = "KRW";
/** Business days back to search when today's rate is not published yet. */
const DEFAULT_LOOKBACK_DAYS = 7;

interface KoreaEximRow {
  result?: number | string;
  cur_unit?: string;
  deal_bas_r?: string;
  cur_nm?: string;
  [key: string]: unknown;
}

class KoreaEximError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly body?: unknown;

  constructor(message: string, options: { status?: number; code?: string; body?: unknown } = {}) {
    super(message);
    this.name = "KoreaEximError";
    this.status = options.status;
    this.code = options.code;
    this.body = options.body;
  }
}

export interface KoreaEximFxSourceOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** How many days back to search for the latest published business day. */
  lookbackDays?: number;
}

/**
 * Korea Eximbank (한국수출입은행) reference FX source: the daily 매매기준율
 * (`deal_bas_r`) for USD→KRW. It is published around 11:00 KST on business
 * days, so this searches back from `searchDate` to the most recent business
 * day that has data (weekends/holidays have none). The returned `date` is that
 * business day, not the requested date.
 */
export class KoreaEximFxSource implements FxSource {
  readonly id = KOREAEXIM_SOURCE_ID;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly lookbackDays: number;

  constructor(private readonly options: KoreaEximFxSourceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  }

  async getFxRate(base: string, quote: string, searchDate: string): Promise<FxRate | null> {
    if (base !== USD || quote !== KRW) return null;

    for (let offset = 0; offset <= this.lookbackDays; offset += 1) {
      const date = addDays(searchDate, -offset);
      const rows = await this.fetchRows(date);
      const usd = rows.find((row) => row.cur_unit === USD);
      const rate = parseDealBasRate(usd?.deal_bas_r);
      if (rate !== null) {
        return {
          base,
          quote,
          date,
          rate,
          provider: this.id,
          source: "koreaexim-deal-bas-r",
          raw: usd,
        };
      }
    }
    return null;
  }

  private async fetchRows(date: string): Promise<KoreaEximRow[]> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("authkey", this.options.apiKey);
    url.searchParams.set("searchdate", toCompactDate(date));
    url.searchParams.set("data", DATA_TYPE);

    // Call via a local reference (Workers throws "Illegal invocation" otherwise).
    const doFetch = this.fetchImpl;
    let attempts = 0;

    return withRetry(
      async () => {
        const response = await doFetch(url.toString(), { method: "GET", signal: requestSignal() });
        const text = await response.text();

        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw new KoreaEximError("Failed to parse Korea Eximbank response", {
            status: response.status,
            body: text,
          });
        }

        if (!response.ok) {
          throw new KoreaEximError(`Korea Eximbank HTTP ${response.status}`, {
            status: response.status,
            body,
          });
        }

        return interpretBody(body);
      },
      {
        retries: 3,
        baseDelayMs: 500,
        maxDelayMs: 4_000,
        shouldRetry: isTransientHttp,
        onRetry: () => {
          attempts += 1;
        },
        delayFor: (error, _attempt, fallbackMs) => retryAfterMsOf(error) ?? fallbackMs,
      },
    ).catch((error: unknown) => {
      throw markAttempts(error, attempts + 1);
    });
  }
}

/**
 * The API returns an array of rows on success, `null`/`[]` on non-business days
 * (or before ~11:00 KST), and a `{ result }` envelope on errors:
 * 2 = data code error, 3 = auth key error, 4 = daily quota exceeded.
 */
function interpretBody(body: unknown): KoreaEximRow[] {
  if (Array.isArray(body)) return body as KoreaEximRow[];

  const result = body && typeof body === "object" ? (body as { result?: unknown }).result : undefined;
  if (result === 3) throw new KoreaEximError("Korea Eximbank auth key is invalid", { code: "3", body });
  if (result === 4) {
    throw new KoreaEximError("Korea Eximbank daily call quota exceeded", { code: "4", body });
  }
  if (result === 2) throw new KoreaEximError("Korea Eximbank data code error", { code: "2", body });

  return [];
}

function parseDealBasRate(value: string | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number(value.replaceAll(",", "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
