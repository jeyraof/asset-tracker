import type { Env } from "../../env";
import { addDays, toCompactDate } from "../../lib/dates";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { str } from "../../lib/parse";
import { RateLimiter } from "../../lib/rateLimit";
import type {
  AccountConfig,
  BalanceResult,
  BrokerProvider,
  DailyQuote,
  FxRate,
  InstrumentRef,
  QuoteFailure,
  QuoteFetchResult,
  TradeFill,
} from "../../domain/types";
import { KiwoomClient } from "./client";
import {
  firstKiwoomCredentials,
  parseKiwoomCredentials,
  resolveKiwoomCredentials,
  type KiwoomCredentialMap,
  type KiwoomCredentials,
} from "./credentials";
import { isKiwoomApiError } from "./errors";
import {
  KIWOOM_API_IDS,
  KIWOOM_BASE_URLS,
  KIWOOM_PATHS,
  normalizeKiwoomEnv,
  type KiwoomEnvironment,
} from "./tr-ids";
import {
  KIWOOM_PROVIDER_ID,
  KRW,
  KRX,
  KRX_GOLD,
  mapDomesticBalance,
  mapDomesticDailyQuotes,
  mapDomesticTrades,
} from "./endpoints/domestic";
import { mapGoldBalance, mapGoldDailyQuotes, mapGoldTrades } from "./endpoints/gold";
import {
  US,
  USD,
  isUsExchange,
  mapUsBalance,
  mapUsDailyQuotes,
  mapUsFxRate,
  mapUsTrades,
} from "./endpoints/us";
import type {
  KiwoomBalanceResponse,
  KiwoomDailyChartResponse,
  KiwoomDepositResponse,
  KiwoomGoldBalanceResponse,
  KiwoomGoldDailyChartResponse,
  KiwoomGoldHoldingRaw,
  KiwoomGoldTradeHistoryResponse,
  KiwoomHoldingRaw,
  KiwoomTradeHistoryResponse,
  KiwoomUsBalanceResponse,
  KiwoomUsDailyChartResponse,
  KiwoomUsExchangeResponse,
  KiwoomUsFxRateResponse,
  KiwoomUsHoldingRaw,
  KiwoomUsTradeHistoryResponse,
} from "./types";

/** Minimum gap between Kiwoom calls (limit is ~20 TPS; stay conservative). */
const CALL_INTERVAL_MS = 300;
/** How many days of daily candles to (re)load per instrument on each sync. */
const QUOTE_LOOKBACK_DAYS = 7;

export interface KiwoomProviderDeps {
  environment: KiwoomEnvironment;
  baseUrl: string;
  cache: KVNamespace;
  /** Shared across accounts so calls are serialized regardless of app key. */
  rateLimiter: RateLimiter;
  /** Shared secret header expected by the reverse proxy, if any. */
  relaySecret?: string;
  debug: boolean;
  credentials: KiwoomCredentialMap;
  fetchImpl?: typeof fetch;
}

export class KiwoomProvider implements BrokerProvider {
  readonly id = KIWOOM_PROVIDER_ID;
  readonly defaultMarket = KRX;
  readonly defaultCountry = "KR";
  readonly defaultCurrency = KRW;

  private readonly clients = new Map<string, KiwoomClient>();
  /** First account credential seen, reused for account-less market data calls. */
  private quoteCredentials?: KiwoomCredentials;
  /** Resolved US exchange (ND/NY/NA) per ticker, shared across accounts. */
  private readonly usExchangeBySymbol = new Map<string, string>();
  /** Cached US daily candles per `${symbol}:${date}`, shared with quotes. */
  private readonly usCandlesBySymbol = new Map<string, DailyQuote[]>();

  constructor(private readonly deps: KiwoomProviderDeps) {}

  supportsMarket(market: string): boolean {
    return market === KRX || market === KRX_GOLD || market === US;
  }

  private resolveCredentials(account: AccountConfig): KiwoomCredentials {
    const credentials = resolveKiwoomCredentials(this.deps.credentials, account);
    if (!credentials) {
      throw new Error(`No Kiwoom credentials configured for account "${account.externalId}"`);
    }
    return credentials;
  }

  private clientForCredentials(credentials: KiwoomCredentials): KiwoomClient {
    let client = this.clients.get(credentials.appkey);
    if (!client) {
      client = new KiwoomClient({
        baseUrl: this.deps.baseUrl,
        appkey: credentials.appkey,
        appsecret: credentials.appsecret,
        env: this.deps.environment,
        cache: this.deps.cache,
        rateLimiter: this.deps.rateLimiter,
        relaySecret: this.deps.relaySecret,
        debug: this.deps.debug,
        fetchImpl: this.deps.fetchImpl,
      });
      this.clients.set(credentials.appkey, client);
    }
    return client;
  }

  private clientFor(account: AccountConfig): KiwoomClient {
    const credentials = this.resolveCredentials(account);
    this.quoteCredentials ??= credentials;
    return this.clientForCredentials(credentials);
  }

  /** Market data (quotes) is not account-scoped; reuse any valid credential. */
  private quoteClient(): KiwoomClient {
    const credentials = this.quoteCredentials ?? firstKiwoomCredentials(this.deps.credentials);
    if (!credentials) throw new Error("No Kiwoom credentials available for market data");
    return this.clientForCredentials(credentials);
  }

  async getBalance(account: AccountConfig, date: string): Promise<BalanceResult> {
    const client = this.clientFor(account);

    if (isUsAccount(account)) {
      return this.usBalance(client, date);
    }

    if (isGoldAccount(account)) {
      const holdings: KiwoomGoldHoldingRaw[] = [];
      let body: KiwoomGoldBalanceResponse = {};
      let isFirstPage = true;

      for await (const page of client.paginate<KiwoomGoldBalanceResponse>(
        KIWOOM_API_IDS.goldBalance,
        KIWOOM_PATHS.account,
        {},
      )) {
        if (isFirstPage) {
          body = page;
          isFirstPage = false;
        }
        holdings.push(...(page.gold_acnt_evlt_prst ?? []));
      }

      return mapGoldBalance({ ...body, gold_acnt_evlt_prst: holdings }, date);
    }

    const holdings: KiwoomHoldingRaw[] = [];
    let balance: KiwoomBalanceResponse = {};
    let isFirstPage = true;

    for await (const page of client.paginate<KiwoomBalanceResponse>(
      KIWOOM_API_IDS.balance,
      KIWOOM_PATHS.account,
      { qry_tp: "1", dmst_stex_tp: KRX },
    )) {
      if (isFirstPage) {
        balance = page;
        isFirstPage = false;
      }
      holdings.push(...(page.acnt_evlt_remn_indv_tot ?? []));
    }
    balance = { ...balance, acnt_evlt_remn_indv_tot: holdings };

    // kt00018 (balance) carries no 예수금/정산 fields (verified live), so the
    // deposit summary needs this separate kt00004 call — one extra subrequest
    // per account that cannot be folded into the balance response.
    const deposit = (
      await client.request<KiwoomDepositResponse>(
        KIWOOM_API_IDS.deposit,
        KIWOOM_PATHS.account,
        { qry_tp: "3" },
      )
    ).body;

    return mapDomesticBalance(balance, deposit, date);
  }

  /**
   * US balance (ust21070) re-valued at the regular-session close. The US market
   * is closed when this runs (KST morning), but after-hours trade may still be
   * printing, so each holding is pinned to the official close from usa06012.
   */
  private async usBalance(client: KiwoomClient, date: string): Promise<BalanceResult> {
    const holdings: KiwoomUsHoldingRaw[] = [];
    let body: KiwoomUsBalanceResponse = {};
    let isFirstPage = true;

    for await (const page of client.paginate<KiwoomUsBalanceResponse>(
      KIWOOM_API_IDS.usBalance,
      KIWOOM_PATHS.usAccount,
      {},
    )) {
      if (isFirstPage) {
        body = page;
        isFirstPage = false;
      }
      holdings.push(...(page.result_list ?? []));
    }
    body = { ...body, result_list: holdings };

    const closeBySymbol = new Map<string, number>();
    for (const raw of holdings) {
      const symbol = str(raw.stk_cd);
      if (!symbol || closeBySymbol.has(symbol)) continue;
      const candles = await this.fetchUsCandles(client, symbol, date);
      const close = candles.find((quote) => quote.date === date)?.close ?? null;
      if (close !== null) closeBySymbol.set(symbol, close);
    }

    return mapUsBalance(body, date, (symbol) => closeBySymbol.get(symbol) ?? null);
  }

  /** Resolves the exchange (ND/NY/NA) required by the US chart/quotes APIs. */
  private async resolveUsExchange(client: KiwoomClient, symbol: string): Promise<string | null> {
    const cached = this.usExchangeBySymbol.get(symbol);
    if (cached) return cached;

    try {
      const response = await client.request<KiwoomUsExchangeResponse>(
        KIWOOM_API_IDS.usExchange,
        KIWOOM_PATHS.usStockInfo,
        { stk_cd: symbol },
      );
      const exchange = str(response.body.list?.[0]?.stex_tp);
      if (isUsExchange(exchange)) {
        this.usExchangeBySymbol.set(symbol, exchange);
        return exchange;
      }
    } catch (error) {
      logger.warn("failed to resolve kiwoom US exchange", {
        symbol,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }

  /** Fetches US daily candles for the lookback window, cached across callers. */
  private async fetchUsCandles(
    client: KiwoomClient,
    symbol: string,
    date: string,
  ): Promise<DailyQuote[]> {
    const cacheKey = `${symbol}:${date}`;
    const cached = this.usCandlesBySymbol.get(cacheKey);
    if (cached) return cached;

    const exchange = await this.resolveUsExchange(client, symbol);
    if (!exchange) return [];

    const from = addDays(date, -(QUOTE_LOOKBACK_DAYS - 1));
    const quotes: DailyQuote[] = [];

    for await (const page of client.paginate<KiwoomUsDailyChartResponse>(
      KIWOOM_API_IDS.usDailyChart,
      KIWOOM_PATHS.usChart,
      {
        stex_tp: exchange,
        stk_cd: symbol,
        // `strt_dt` is an inclusive base date: candles come back descending
        // from it, so anchor on `date` (not the window start) and filter below.
        strt_dt: toCompactDate(date),
        upd_stkpc_tp: "0",
        exrt_appl_tp: "0",
      },
      2,
    )) {
      quotes.push(...mapUsDailyQuotes(page, symbol));
    }

    const filtered = quotes.filter((quote) => quote.date >= from && quote.date <= date);
    this.usCandlesBySymbol.set(cacheKey, filtered);
    return filtered;
  }

  async getTrades(account: AccountConfig, from: string, to: string): Promise<TradeFill[]> {
    const client = this.clientFor(account);
    const fills: TradeFill[] = [];

    try {
      if (isUsAccount(account)) {
        for await (const page of client.paginate<KiwoomUsTradeHistoryResponse>(
          KIWOOM_API_IDS.usTradeHistory,
          KIWOOM_PATHS.usAccount,
          {
            strt_dt: toCompactDate(from),
            end_dt: toCompactDate(to),
            tp: "3",
            stex_tp: "",
            stk_cd: "",
            krw_repl_skip_yn: "N",
          },
        )) {
          fills.push(...mapUsTrades(page));
        }
      } else if (isGoldAccount(account)) {
        for await (const page of client.paginate<KiwoomGoldTradeHistoryResponse>(
          KIWOOM_API_IDS.goldTradeHistory,
          KIWOOM_PATHS.account,
          { strt_dt: toCompactDate(from), end_dt: toCompactDate(to), tp: "3", stk_cd: "" },
        )) {
          fills.push(...mapGoldTrades(page));
        }
      } else {
        for await (const page of client.paginate<KiwoomTradeHistoryResponse>(
          KIWOOM_API_IDS.tradeHistory,
          KIWOOM_PATHS.account,
          {
            strt_dt: toCompactDate(from),
            end_dt: toCompactDate(to),
            tp: "3",
            stk_cd: "",
            crnc_cd: "",
            gds_tp: "1",
            frgn_stex_code: "",
            dmst_stex_tp: "%",
            qry_sort_tp: "1",
          },
        )) {
          fills.push(...mapDomesticTrades(page));
        }
      }
    } catch (error) {
      // Kiwoom reports an empty range as a logical error (501724 관련자료가없습니다).
      if (isKiwoomApiError(error) && error.isNoData()) return fills;
      throw error;
    }

    return fills;
  }

  async getDailyQuotes(instruments: InstrumentRef[], date: string): Promise<QuoteFetchResult> {
    const client = this.quoteClient();
    const from = addDays(date, -(QUOTE_LOOKBACK_DAYS - 1));
    const quotes: DailyQuote[] = [];
    const failures: QuoteFailure[] = [];

    for (const instrument of instruments) {
      if (!this.supportsMarket(instrument.market)) continue;
      try {
        if (instrument.market === US) {
          quotes.push(...(await this.fetchUsCandles(client, instrument.symbol, date)));
          continue;
        }

        if (instrument.market === KRX_GOLD) {
          for await (const page of client.paginate<KiwoomGoldDailyChartResponse>(
            KIWOOM_API_IDS.goldDailyChart,
            KIWOOM_PATHS.chart,
            { stk_cd: instrument.symbol, base_dt: toCompactDate(date), upd_stkpc_tp: "0" },
            2,
          )) {
            quotes.push(
              ...mapGoldDailyQuotes(page, instrument.symbol).filter(
                (quote) => quote.date >= from && quote.date <= date,
              ),
            );
          }
          continue;
        }

        for await (const page of client.paginate<KiwoomDailyChartResponse>(
          KIWOOM_API_IDS.dailyChart,
          KIWOOM_PATHS.chart,
          { stk_cd: instrument.symbol, base_dt: toCompactDate(date), upd_stkpc_tp: "0" },
          2,
        )) {
          quotes.push(
            ...mapDomesticDailyQuotes(page, instrument.symbol).filter(
              (quote) => quote.date >= from && quote.date <= date,
            ),
          );
        }
      } catch (error) {
        const details = describeError(error);
        failures.push({ ref: instrument, ...details });
        logger.warn("failed to fetch kiwoom daily quote", {
          symbol: instrument.symbol,
          market: instrument.market,
          error: details.message,
          status: details.status,
          attempts: details.attempts,
        });
      }
    }

    return { quotes, failures };
  }

  /**
   * Spot USD/KRW from the US exchange-rate endpoint (ust31301). Market data is
   * not account-scoped, so it reuses any valid credential like quotes do.
   * `exch_tp=2` is USD→KRW (1 would be KRW→USD).
   */
  async getFxRate(base: string, quote: string, date: string): Promise<FxRate | null> {
    if (base !== USD || quote !== KRW) return null;

    const client = this.quoteClient();
    const response = await client.request<KiwoomUsFxRateResponse>(
      KIWOOM_API_IDS.usFxRate,
      KIWOOM_PATHS.usFxRate,
      { exch_tp: "2" },
    );
    return mapUsFxRate(response.body, date, base, quote);
  }
}

/** Gold-spot (금현물) accounts use a different set of endpoints. */
export function isGoldAccount(account: Pick<AccountConfig, "meta">): boolean {
  return account.meta?.["product"] === "gold";
}

/** US (미국주식) accounts use the `/api/us/*` endpoints and USD. */
export function isUsAccount(account: Pick<AccountConfig, "meta">): boolean {
  return account.meta?.["product"] === "us";
}

export function createKiwoomProvider(env: Env): BrokerProvider {
  const credentials = parseKiwoomCredentials(env.KIWOOM_CREDENTIALS);
  if (credentials.size === 0) {
    throw new Error("Kiwoom credentials missing: set KIWOOM_CREDENTIALS");
  }

  const environment = normalizeKiwoomEnv(env.KIWOOM_ENV);
  const baseUrl = env.KIWOOM_BASE_URL ?? KIWOOM_BASE_URLS[environment];

  return new KiwoomProvider({
    environment,
    baseUrl,
    cache: env.CACHE,
    rateLimiter: new RateLimiter(CALL_INTERVAL_MS),
    relaySecret: env.KIWOOM_RELAY_SECRET,
    debug: env.DEBUG_KIWOOM === "1",
    credentials,
  });
}
