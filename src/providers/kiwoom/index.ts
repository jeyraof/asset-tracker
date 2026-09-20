import type { Env } from "../../env";
import { addDays, toCompactDate } from "../../lib/dates";
import { logger } from "../../lib/logger";
import { RateLimiter } from "../../lib/rateLimit";
import type {
  AccountConfig,
  BalanceResult,
  BrokerProvider,
  DailyQuote,
  InstrumentRef,
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

  constructor(private readonly deps: KiwoomProviderDeps) {}

  supportsMarket(market: string): boolean {
    return market === KRX || market === KRX_GOLD;
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

    const deposit = (
      await client.request<KiwoomDepositResponse>(
        KIWOOM_API_IDS.deposit,
        KIWOOM_PATHS.account,
        { qry_tp: "3" },
      )
    ).body;

    return mapDomesticBalance(balance, deposit, date);
  }

  async getTrades(account: AccountConfig, from: string, to: string): Promise<TradeFill[]> {
    const client = this.clientFor(account);
    const fills: TradeFill[] = [];

    try {
      if (isGoldAccount(account)) {
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

  async getDailyQuotes(instruments: InstrumentRef[], date: string): Promise<DailyQuote[]> {
    const client = this.quoteClient();
    const from = addDays(date, -(QUOTE_LOOKBACK_DAYS - 1));
    const quotes: DailyQuote[] = [];

    for (const instrument of instruments) {
      if (!this.supportsMarket(instrument.market)) continue;
      try {
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
        logger.warn("failed to fetch kiwoom daily quote", {
          symbol: instrument.symbol,
          market: instrument.market,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return quotes;
  }
}

/** Gold-spot (금현물) accounts use a different set of endpoints. */
export function isGoldAccount(account: Pick<AccountConfig, "meta">): boolean {
  return account.meta?.["product"] === "gold";
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
