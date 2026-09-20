import { fromCompactDate } from "../../../lib/dates";
import { num, str } from "../../../lib/parse";
import type {
  BalanceResult,
  BalanceSummary,
  DailyQuote,
  FxRate,
  HoldingSnapshot,
  TradeFill,
} from "../../../domain/types";
import { KIWOOM_PROVIDER_ID, KRW, sideOf } from "./domestic";
import type {
  KiwoomUsBalanceResponse,
  KiwoomUsCandleRaw,
  KiwoomUsDailyChartResponse,
  KiwoomUsFxRateResponse,
  KiwoomUsHoldingRaw,
  KiwoomUsTradeHistoryResponse,
  KiwoomUsTradeRaw,
} from "../types";

export const US = "US";
export const USD = "USD";

/** Kiwoom US exchange codes: ND=NASDAQ, NY=NYSE, NA=AMEX. */
export type UsExchange = "ND" | "NY" | "NA";
export const US_EXCHANGES: readonly UsExchange[] = ["ND", "NY", "NA"];

export function isUsExchange(value: string | null): value is UsExchange {
  return value === "ND" || value === "NY" || value === "NA";
}

/** US tickers are plain tickers; never run them through `stripSymbol`. */
export function mapUsHolding(raw: KiwoomUsHoldingRaw): HoldingSnapshot | null {
  const symbol = str(raw.stk_cd);
  if (!symbol) return null;

  return {
    market: US,
    symbol,
    productName: str(raw.frgn_stk_nm),
    currency: USD,
    quantity: num(raw.poss_qty) ?? 0,
    avgPrice: num(raw.frgn_stk_book_uv),
    purchaseAmount: num(raw.frgn_stk_book_amt),
    currentPrice: num(raw.now_pric),
    evalAmount: num(raw.evlt_amt),
    evalPflsAmount: num(raw.pl_amt),
    evalPflsRate: num(raw.pl_rt),
    raw,
  };
}

/**
 * Re-values a holding at the regular-session close, so a snapshot taken during
 * US after-hours (KST morning) is still pinned to the official close.
 */
function applyRegularClose(holding: HoldingSnapshot, close: number | null): HoldingSnapshot {
  if (close === null || holding.quantity <= 0) return holding;

  const evalAmount = holding.quantity * close;
  const purchaseAmount = holding.purchaseAmount;
  const evalPflsAmount = purchaseAmount === null ? null : evalAmount - purchaseAmount;
  const evalPflsRate =
    purchaseAmount === null || purchaseAmount === 0
      ? null
      : ((evalAmount - purchaseAmount) / purchaseAmount) * 100;

  return { ...holding, currentPrice: close, evalAmount, evalPflsAmount, evalPflsRate };
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  let sum: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    sum = (sum ?? 0) + value;
  }
  return sum;
}

function mapUsSummary(
  body: KiwoomUsBalanceResponse,
  holdings: readonly HoldingSnapshot[],
): BalanceSummary {
  if (holdings.length === 0) {
    return {
      currency: USD,
      depositTotal: null,
      nextDaySettlement: null,
      totalEvalAmount: num(body.tot_evlt_amt),
      securitiesEvalAmount: num(body.tot_evlt_amt),
      purchaseAmountTotal: num(body.tot_prch_amt),
      evalPflsAmount: num(body.tot_pl_amt),
      netAssetAmount: num(body.tot_evlt_amt),
      raw: body,
    };
  }

  const totalEvalAmount = sumOrNull(holdings.map((holding) => holding.evalAmount));
  return {
    currency: USD,
    depositTotal: null,
    nextDaySettlement: null,
    totalEvalAmount,
    securitiesEvalAmount: totalEvalAmount,
    purchaseAmountTotal: sumOrNull(holdings.map((holding) => holding.purchaseAmount)),
    evalPflsAmount: sumOrNull(holdings.map((holding) => holding.evalPflsAmount)),
    netAssetAmount: totalEvalAmount,
    raw: body,
  };
}

/**
 * Maps a US ledger balance (ust21070) to the normalized model. When `closeFor`
 * is provided, each holding is re-valued at the regular-session close for
 * `date` (falling back to the broker's `now_pric` when no candle exists).
 */
export function mapUsBalance(
  body: KiwoomUsBalanceResponse,
  date: string,
  closeFor?: (symbol: string) => number | null,
): BalanceResult {
  const holdings = (body.result_list ?? [])
    .map(mapUsHolding)
    .filter((holding): holding is HoldingSnapshot => holding !== null)
    .map((holding) => applyRegularClose(holding, closeFor ? closeFor(holding.symbol) : null));

  return { date, summary: mapUsSummary(body, holdings), holdings };
}

function mapUsTradeRow(raw: KiwoomUsTradeRaw, market: string): TradeFill | null {
  const side = sideOf(str(raw.rmrk_nm)) ?? sideOf(str(raw.deal_kind_nm));
  if (!side) return null;

  const quantity = Math.abs(num(raw.deal_qty) ?? 0);
  if (quantity <= 0) return null;

  const symbol = str(raw.stk_cd);
  const externalId = str(raw.deal_no);
  const tradeDate = str(raw.deal_dt);
  if (!symbol || !externalId || !tradeDate || tradeDate.length !== 8) return null;

  return {
    date: fromCompactDate(tradeDate),
    externalId,
    market,
    symbol,
    productName: str(raw.stk_nm),
    side,
    quantity,
    avgPrice: num(raw.uv_exrt),
    amount: num(raw.fc_deal_amt) ?? num(raw.deal_amt),
    currency: USD,
    orderTime: str(raw.proc_time),
    raw,
  };
}

/** Maps US trades from the date-range trade history (ust21100). */
export function mapUsTrades(
  body: Pick<KiwoomUsTradeHistoryResponse, "result_list">,
  market: string = US,
): TradeFill[] {
  return (body.result_list ?? [])
    .map((row) => mapUsTradeRow(row, market))
    .filter((fill): fill is TradeFill => fill !== null);
}

function mapUsCandle(raw: KiwoomUsCandleRaw, symbol: string): DailyQuote | null {
  const rawDate = str(raw.dt);
  if (!rawDate || rawDate.length !== 8) return null;

  return {
    market: US,
    symbol,
    date: fromCompactDate(rawDate),
    open: num(raw.open_pric),
    high: num(raw.high_pric),
    low: num(raw.low_pric),
    close: num(raw.cur_prc),
    volume: num(raw.acc_trde_qty),
    currency: USD,
    provider: KIWOOM_PROVIDER_ID,
    source: "kiwoom-us-daily-chart",
    raw,
  };
}

export function mapUsDailyQuotes(
  body: Pick<KiwoomUsDailyChartResponse, "result_list">,
  symbol: string,
): DailyQuote[] {
  return (body.result_list ?? [])
    .map((candle) => mapUsCandle(candle, symbol))
    .filter((quote): quote is DailyQuote => quote !== null);
}

/**
 * Maps a US FX rate (ust31301) to the normalized model. Prefers the applied
 * rate (`aplc_exrt`), falling back to the sell/buy applied rates. The response
 * carries no date, so `date` is the caller's KST date.
 */
export function mapUsFxRate(
  body: KiwoomUsFxRateResponse,
  date: string,
  base: string = USD,
  quote: string = KRW,
): FxRate | null {
  const rate = num(body.aplc_exrt) ?? num(body.sell_aplc_exrt) ?? num(body.buy_aplc_exrt);
  if (rate === null || rate <= 0) return null;

  return {
    base,
    quote,
    date,
    rate,
    provider: KIWOOM_PROVIDER_ID,
    source: "kiwoom-us-fx-rate",
    raw: body,
  };
}
