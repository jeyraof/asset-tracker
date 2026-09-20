import type { Env } from "../../env";
import { addDays, kstDate, toCompactDate } from "../../lib/dates";
import { logger } from "../../lib/logger";
import { RateLimiter } from "../../lib/rateLimit";
import { str } from "../../lib/parse";
import type {
  AccountConfig,
  BalanceResult,
  BrokerProvider,
  DailyQuote,
  InstrumentRef,
  TradeFill,
} from "../../domain/types";
import { KisClient } from "./client";
import {
  firstCredentials,
  parseKisCredentials,
  resolveKisCredentials,
  type KisCredentialMap,
  type KisCredentials,
} from "./credentials";
import {
  KIS_PROVIDER_ID,
  KRW,
  KRX,
  mapDomesticBalance,
  mapDomesticDailyQuotes,
  mapDomesticTrades,
} from "./endpoints/domestic";
import { cclDTrId, getTrIds, KIS_BASE_URLS, normalizeKisEnv, type KisEnvironment } from "./tr-ids";
import type {
  KisDomesticBalanceResponse,
  KisDomesticCclDResponse,
  KisDomesticDailyChartResponse,
} from "./types";

const PATHS = {
  balance: "/uapi/domestic-stock/v1/trading/inquire-balance",
  cclD: "/uapi/domestic-stock/v1/trading/inquire-daily-ccld",
  dailyChart: "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
} as const;

/**
 * Daily-chart market division: `J` = KRX (KOSPI/KOSDAQ/ETF/ETN), `NX` = NXT,
 * `UN` = unified. We pin quotes to KRX regular session only: the official
 * close is the 15:30 KRX close, and pre/after-market prices are excluded.
 */
const DAILY_CHART_MARKET_DIV = "J";

/**
 * Trade-history exchange filter: `KRX` | `NXT` | `SOR` | `ALL`. Use `ALL` so
 * fills executed on NXT are not silently dropped from positions.
 */
const TRADE_EXCHANGE_DIV = "ALL";

/** Minimum gap between KIS calls. Real accounts allow ~20 TPS; stay conservative. */
const CALL_INTERVAL_MS = 300;
/** How many days of daily candles to (re)load per instrument on each sync. */
const QUOTE_LOOKBACK_DAYS = 7;

export interface ParsedKisAccount {
  cano: string;
  prdtCd: string;
}

/** Resolves CANO / ACNT_PRDT_CD from account meta or the `"12345678-01"` external id. */
export function parseKisAccount(account: Pick<AccountConfig, "externalId" | "meta">): ParsedKisAccount {
  const externalId = account.externalId ?? "";
  const [idCano, idPrdt] = externalId.split("-");

  const cano = str(account.meta?.["cano"]) ?? str(idCano);
  const prdtCd = str(account.meta?.["prdtCd"]) ?? str(idPrdt) ?? "01";

  if (!cano || !/^\d{8}$/.test(cano)) {
    throw new Error(
      `KIS account external id must contain an 8-digit CANO (got "${account.externalId}")`,
    );
  }

  return { cano, prdtCd: prdtCd.padStart(2, "0") };
}

export interface KisProviderDeps {
  environment: KisEnvironment;
  baseUrl: string;
  cache: KVNamespace;
  /** Shared across accounts so calls are serialized regardless of app key. */
  rateLimiter: RateLimiter;
  debug: boolean;
  credentials: KisCredentialMap;
  fetchImpl?: typeof fetch;
}

export class KisProvider implements BrokerProvider {
  readonly id = KIS_PROVIDER_ID;
  readonly defaultMarket = KRX;
  readonly defaultCountry = "KR";
  readonly defaultCurrency = KRW;

  private readonly clients = new Map<string, KisClient>();
  /** First account credential seen, reused for account-less market data calls. */
  private quoteCredentials?: KisCredentials;

  constructor(private readonly deps: KisProviderDeps) {}

  supportsMarket(market: string): boolean {
    return market === KRX;
  }

  private resolveCredentials(account: AccountConfig): KisCredentials {
    const credentials = resolveKisCredentials(this.deps.credentials, account);
    if (!credentials) {
      throw new Error(`No KIS credentials configured for account "${account.externalId}"`);
    }
    return credentials;
  }

  private clientForCredentials(credentials: KisCredentials): KisClient {
    let client = this.clients.get(credentials.appkey);
    if (!client) {
      client = new KisClient({
        baseUrl: this.deps.baseUrl,
        appkey: credentials.appkey,
        appsecret: credentials.appsecret,
        env: this.deps.environment,
        cache: this.deps.cache,
        rateLimiter: this.deps.rateLimiter,
        debug: this.deps.debug,
        fetchImpl: this.deps.fetchImpl,
      });
      this.clients.set(credentials.appkey, client);
    }
    return client;
  }

  /** Client authenticated with the account's own credentials. */
  private clientFor(account: AccountConfig): KisClient {
    const credentials = this.resolveCredentials(account);
    this.quoteCredentials ??= credentials;
    return this.clientForCredentials(credentials);
  }

  /** Market data (quotes) is not account-scoped; reuse any valid credential. */
  private quoteClient(): KisClient {
    const credentials = this.quoteCredentials ?? firstCredentials(this.deps.credentials);
    if (!credentials) throw new Error("No KIS credentials available for market data");
    return this.clientForCredentials(credentials);
  }

  async getBalance(account: AccountConfig, date: string): Promise<BalanceResult> {
    const { cano, prdtCd } = parseKisAccount(account);
    const client = this.clientFor(account);
    const trId = getTrIds(this.deps.environment).domesticBalance;

    const params = {
      CANO: cano,
      ACNT_PRDT_CD: prdtCd,
      AFHR_FLPR_YN: "N",
      OFL_YN: "",
      INQR_DVSN: "02",
      UNPR_DVSN: "01",
      FUND_STTL_ICLD_YN: "N",
      FNCG_AMT_AUTO_RDPT_YN: "N",
      PRCS_DVSN: "00",
      CTX_AREA_FK100: "",
      CTX_AREA_NK100: "",
    };

    const holdings: NonNullable<KisDomesticBalanceResponse["output1"]> = [];
    let summary: KisDomesticBalanceResponse["output2"] = [];
    let isFirstPage = true;

    for await (const page of client.paginate<KisDomesticBalanceResponse>(
      PATHS.balance,
      trId,
      params,
    )) {
      if (isFirstPage) {
        summary = page.output2 ?? [];
        isFirstPage = false;
      }
      holdings.push(...(page.output1 ?? []));
    }

    return mapDomesticBalance({ output1: holdings, output2: summary }, date);
  }

  async getTrades(account: AccountConfig, from: string, to: string): Promise<TradeFill[]> {
    const { cano, prdtCd } = parseKisAccount(account);
    const client = this.clientFor(account);
    const trId = cclDTrId(this.deps.environment, from, kstDate());

    const params = {
      CANO: cano,
      ACNT_PRDT_CD: prdtCd,
      INQR_STRT_DT: toCompactDate(from),
      INQR_END_DT: toCompactDate(to),
      SLL_BUY_DVSN_CD: "00",
      CCLD_DVSN: "01",
      INQR_DVSN: "00",
      INQR_DVSN_3: "00",
      INQR_DVSN_1: "",
      PDNO: "",
      ORD_GNO_BRNO: "",
      ODNO: "",
      EXCG_ID_DVSN_CD: TRADE_EXCHANGE_DIV,
      CTX_AREA_FK100: "",
      CTX_AREA_NK100: "",
    };

    const rows: NonNullable<KisDomesticCclDResponse["output1"]> = [];
    for await (const page of client.paginate<KisDomesticCclDResponse>(
      PATHS.cclD,
      trId,
      params,
    )) {
      rows.push(...(page.output1 ?? []));
    }

    return mapDomesticTrades({ output1: rows });
  }

  async getDailyQuotes(instruments: InstrumentRef[], date: string): Promise<DailyQuote[]> {
    const client = this.quoteClient();
    const trId = getTrIds(this.deps.environment).domesticDailyChart;
    const from = addDays(date, -(QUOTE_LOOKBACK_DAYS - 1));
    const quotes: DailyQuote[] = [];

    for (const instrument of instruments) {
      if (!this.supportsMarket(instrument.market)) continue;
      try {
        const { body } = await client.get<KisDomesticDailyChartResponse>(
          PATHS.dailyChart,
          trId,
          {
            FID_COND_MRKT_DIV_CODE: DAILY_CHART_MARKET_DIV,
            FID_INPUT_ISCD: instrument.symbol,
            FID_INPUT_DATE_1: toCompactDate(from),
            FID_INPUT_DATE_2: toCompactDate(date),
            FID_PERIOD_DIV_CODE: "D",
            // "1" = unadjusted (actual traded) prices.
            FID_ORG_ADJ_PRC: "1",
          },
        );
        quotes.push(...mapDomesticDailyQuotes(body, instrument.symbol));
      } catch (error) {
        logger.warn("failed to fetch daily quote", {
          symbol: instrument.symbol,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return quotes;
  }
}

export function createKisProvider(env: Env): BrokerProvider {
  const credentials = parseKisCredentials(env.KIS_CREDENTIALS);
  if (credentials.size === 0) {
    throw new Error("KIS credentials missing: set KIS_CREDENTIALS");
  }

  const environment = normalizeKisEnv(env.KIS_ENV);
  const baseUrl = env.KIS_BASE_URL ?? KIS_BASE_URLS[environment];

  return new KisProvider({
    environment,
    baseUrl,
    cache: env.CACHE,
    rateLimiter: new RateLimiter(CALL_INTERVAL_MS),
    debug: env.DEBUG_KIS === "1",
    credentials,
  });
}
