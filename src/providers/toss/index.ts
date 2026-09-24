import type { Env } from "../../env";
import type {
  AccountConfig,
  BalanceResult,
  BrokerProvider,
  DailyQuote,
  InstrumentRef,
  QuoteFailure,
  QuoteFetchResult,
  TradeFill,
} from "../../domain/types";
import { addDays } from "../../lib/dates";
import { describeError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { num } from "../../lib/parse";
import { RateLimiter } from "../../lib/rateLimit";
import { TossClient } from "./client";
import { parseTossCredentials, type TossCredentials } from "./credentials";
import { KRX, TOSS_PROVIDER_ID, US, currencyOf, mapTossBalance } from "./endpoints/holdings";
import { mapTossCandle } from "./endpoints/candles";
import { mapTossOrders } from "./endpoints/orders";
import { TOSS_BASE_URL, TOSS_PATHS } from "./tr-ids";
import type {
  TossBuyingPower,
  TossCandlePage,
  TossHoldingsOverview,
  TossOrder,
  TossPaginatedOrders,
} from "./types";

const DEFAULT_ENV = "prod";
/** Minimum gap between Toss calls (groups allow 1–20 TPS; stay conservative). */
const CALL_INTERVAL_MS = 300;
/** How many days of daily candles to (re)load per instrument on each sync. */
const QUOTE_LOOKBACK_DAYS = 7;
const MAX_ORDER_PAGES = 20;
const ORDER_PAGE_LIMIT = 100;

export interface TossProviderDeps {
  environment: string;
  baseUrl: string;
  cache: KVNamespace;
  /** Shared across accounts so calls are serialized regardless of credential. */
  rateLimiter: RateLimiter;
  credentials: TossCredentials;
  relaySecret?: string;
  debug: boolean;
  fetchImpl?: typeof fetch;
}

/** US (미국주식) rows are registered as `<accountSeq>-us` with `meta.product="us"`. */
export function isUsAccount(account: Pick<AccountConfig, "meta">): boolean {
  return account.meta?.["product"] === "us";
}

function accountSeqOf(account: Pick<AccountConfig, "externalId" | "meta">): number | null {
  const value = account.meta?.["accountSeq"];
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numeric) ? numeric : null;
}

export class TossProvider implements BrokerProvider {
  readonly id = TOSS_PROVIDER_ID;
  readonly defaultMarket = KRX;
  readonly defaultCountry = "KR";
  readonly defaultCurrency = "KRW";

  private readonly client: TossClient;

  constructor(private readonly deps: TossProviderDeps) {
    this.client = new TossClient({
      baseUrl: deps.baseUrl,
      clientId: deps.credentials.clientId,
      clientSecret: deps.credentials.clientSecret,
      env: deps.environment,
      cache: deps.cache,
      rateLimiter: deps.rateLimiter,
      relaySecret: deps.relaySecret,
      debug: deps.debug,
      fetchImpl: deps.fetchImpl,
    });
  }

  supportsMarket(market: string): boolean {
    return market === KRX || market === US;
  }

  async getBalance(account: AccountConfig, date: string): Promise<BalanceResult> {
    const accountSeq = accountSeqOf(account);
    if (accountSeq === null) {
      throw new Error(`Toss account "${account.externalId}" is missing meta.accountSeq`);
    }

    const market = isUsAccount(account) ? US : KRX;
    const currency = currencyOf(market);

    const overview = await this.client.request<TossHoldingsOverview>("GET", TOSS_PATHS.holdings, {
      accountSeq,
    });

    // Cash is not part of holdings; approximate 예수금 with the cash buying power.
    let depositTotal: number | null = null;
    try {
      const buyingPower = await this.client.request<TossBuyingPower>(
        "GET",
        TOSS_PATHS.buyingPower,
        { params: { currency }, accountSeq },
      );
      depositTotal = num(buyingPower.cashBuyingPower);
    } catch (error) {
      logger.warn("failed to fetch toss buying power", {
        account: account.externalId,
        market,
        error: describeError(error).message,
      });
    }

    return mapTossBalance(overview, { market, currency, date, depositTotal });
  }

  async getTrades(account: AccountConfig, from: string, to: string): Promise<TradeFill[]> {
    const accountSeq = accountSeqOf(account);
    if (accountSeq === null) {
      throw new Error(`Toss account "${account.externalId}" is missing meta.accountSeq`);
    }

    const market = isUsAccount(account) ? US : KRX;
    const currency = currencyOf(market);

    const orders: TossOrder[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_ORDER_PAGES; page += 1) {
      const result = await this.client.request<TossPaginatedOrders>("GET", TOSS_PATHS.orders, {
        params: { status: "CLOSED", from, to, limit: ORDER_PAGE_LIMIT, cursor },
        accountSeq,
      });
      orders.push(...(result.orders ?? []));
      if (!result.hasNext || !result.nextCursor) break;
      cursor = result.nextCursor;
    }

    return mapTossOrders(orders, { market, currency });
  }

  async getDailyQuotes(instruments: InstrumentRef[], date: string): Promise<QuoteFetchResult> {
    const from = addDays(date, -(QUOTE_LOOKBACK_DAYS - 1));
    const quotes: DailyQuote[] = [];
    const failures: QuoteFailure[] = [];

    for (const instrument of instruments) {
      if (!this.supportsMarket(instrument.market)) continue;
      try {
        const currency = currencyOf(instrument.market);
        const page = await this.client.request<TossCandlePage>("GET", TOSS_PATHS.candles, {
          params: {
            symbol: instrument.symbol,
            interval: "1d",
            // Keep prices unadjusted so they match real fills (KIS/Kiwoom policy).
            adjusted: false,
            count: QUOTE_LOOKBACK_DAYS * 2,
          },
        });
        quotes.push(
          ...(page.candles ?? [])
            .map((candle) => mapTossCandle(candle, instrument.symbol, instrument.market, currency))
            .filter((quote): quote is DailyQuote => quote !== null)
            .filter((quote) => quote.date >= from && quote.date <= date),
        );
      } catch (error) {
        const details = describeError(error);
        failures.push({ ref: instrument, ...details });
        logger.warn("failed to fetch toss daily quote", {
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
}

export function createTossProvider(env: Env): BrokerProvider {
  const credentials = parseTossCredentials(env.TOSS_CREDENTIALS);
  if (!credentials) {
    throw new Error("Toss credentials missing: set TOSS_CREDENTIALS");
  }

  return new TossProvider({
    environment: DEFAULT_ENV,
    baseUrl: env.TOSS_BASE_URL ?? TOSS_BASE_URL,
    cache: env.CACHE,
    rateLimiter: new RateLimiter(CALL_INTERVAL_MS),
    credentials,
    relaySecret: env.TOSS_RELAY_SECRET,
    debug: env.DEBUG_TOSS === "1",
  });
}
