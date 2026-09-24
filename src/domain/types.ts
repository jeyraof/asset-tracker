/**
 * Broker/provider-agnostic domain model.
 *
 * Everything the sync engine consumes is normalized into these types, so
 * adding a new broker or country only requires a new `BrokerProvider`
 * implementation under `src/providers/<id>/`.
 */

export type Market = string;
export type Country = string;
export type Currency = string;
export type TradeSide = "BUY" | "SELL";

/** An account as declared by a provider (before it is persisted). */
export interface ProviderAccount {
  provider: string;
  env: string;
  /** Stable identifier inside the provider, e.g. KIS `"12345678-01"`. */
  externalId: string;
  country: Country;
  currency: Currency;
  name: string | null;
  meta: Record<string, unknown>;
}

/** A persisted account row. */
export interface AccountConfig extends ProviderAccount {
  id: number;
  active: boolean;
  /**
   * User-set display name. When present it overrides `name` for presentation;
   * when empty/absent, callers fall back to `name`, then `externalId`.
   */
  alias?: string | null;
}

export interface BalanceSummary {
  currency: Currency;
  depositTotal: number | null;
  nextDaySettlement: number | null;
  totalEvalAmount: number | null;
  securitiesEvalAmount: number | null;
  purchaseAmountTotal: number | null;
  evalPflsAmount: number | null;
  netAssetAmount: number | null;
  raw: unknown;
}

export interface HoldingSnapshot {
  market: Market;
  symbol: string;
  productName: string | null;
  currency: Currency;
  quantity: number;
  avgPrice: number | null;
  purchaseAmount: number | null;
  currentPrice: number | null;
  evalAmount: number | null;
  evalPflsAmount: number | null;
  evalPflsRate: number | null;
  raw: unknown;
}

export interface BalanceResult {
  /** YYYY-MM-DD (KST) snapshot date. */
  date: string;
  summary: BalanceSummary;
  holdings: HoldingSnapshot[];
}

export interface TradeFill {
  /** YYYY-MM-DD trade (order) date. */
  date: string;
  /** Provider order id, used for de-duplication (KIS `odno`). */
  externalId: string;
  market: Market;
  symbol: string;
  productName: string | null;
  side: TradeSide;
  quantity: number;
  avgPrice: number | null;
  amount: number | null;
  currency: Currency;
  orderTime: string | null;
  raw: unknown;
}

export interface InstrumentRef {
  market: Market;
  symbol: string;
}

export interface DailyQuote {
  market: Market;
  symbol: string;
  /** YYYY-MM-DD of the actual trading session (from the provider). */
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  currency: Currency;
  /** Provider id that produced the quote, e.g. "kis". */
  provider: string;
  source: string;
  raw: unknown;
}

/** A single instrument whose quote fetch failed, with transport details. */
export interface QuoteFailure {
  ref: InstrumentRef;
  message: string;
  status?: number;
  code?: string;
  attempts?: number;
  path?: string;
}

/**
 * Result of a quote batch: successful quotes plus per-instrument failures.
 * Providers never throw for a single instrument — callers (and the fallback
 * orchestrator) need the partial result and the list of instruments to retry.
 */
export interface QuoteFetchResult {
  quotes: DailyQuote[];
  failures: QuoteFailure[];
}

export interface FxRate {
  /** Base currency, e.g. "USD". */
  base: Currency;
  /** Quote currency, e.g. "KRW". */
  quote: Currency;
  /** YYYY-MM-DD the rate applies to. */
  date: string;
  rate: number;
  /** Provider id that produced the rate, e.g. "kiwoom". */
  provider: string;
  source: string;
  raw: unknown;
}

/**
 * The contract every broker integration implements.
 * The sync engine knows nothing beyond this interface.
 */
export interface BrokerProvider {
  readonly id: string;
  readonly defaultMarket: Market;
  readonly defaultCountry: Country;
  readonly defaultCurrency: Currency;

  supportsMarket(market: Market): boolean;

  /** Balance summary + holdings for `date` (YYYY-MM-DD). */
  getBalance(account: AccountConfig, date: string): Promise<BalanceResult>;

  /** Quantity-changing fills (buys/sells) between `from` and `to`, inclusive. */
  getTrades(account: AccountConfig, from: string, to: string): Promise<TradeFill[]>;

  /** Daily OHLC quotes as of `date` for the given instruments. */
  getDailyQuotes(instruments: InstrumentRef[], date: string): Promise<QuoteFetchResult>;

  /**
   * Optional spot FX rate for a currency pair as of `date`. Providers that have
   * no FX endpoint simply omit it; the separate FX task skips them.
   */
  getFxRate?(base: Currency, quote: Currency, date: string): Promise<FxRate | null>;
}
