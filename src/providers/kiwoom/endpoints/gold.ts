import { fromCompactDate } from "../../../lib/dates";
import { num, str } from "../../../lib/parse";
import type {
  BalanceResult,
  BalanceSummary,
  DailyQuote,
  HoldingSnapshot,
  TradeFill,
} from "../../../domain/types";
import {
  KIWOOM_PROVIDER_ID,
  KRW,
  KRX_GOLD,
  sideOf,
} from "./domestic";
import type {
  KiwoomGoldBalanceResponse,
  KiwoomGoldCandleRaw,
  KiwoomGoldDailyChartResponse,
  KiwoomGoldHoldingRaw,
  KiwoomGoldTradeRaw,
  KiwoomGoldTradeHistoryResponse,
} from "../types";

function mapGoldHolding(raw: KiwoomGoldHoldingRaw): HoldingSnapshot | null {
  const symbol = str(raw.stk_cd);
  if (!symbol) return null;

  return {
    market: KRX_GOLD,
    symbol,
    productName: str(raw.stk_nm),
    currency: KRW,
    quantity: num(raw.real_qty) ?? 0,
    avgPrice: num(raw.avg_prc),
    purchaseAmount: num(raw.book_amt2),
    currentPrice: num(raw.cur_prc),
    evalAmount: num(raw.est_amt),
    evalPflsAmount: num(raw.est_lspft),
    evalPflsRate: num(raw.est_ratio),
    raw,
  };
}

function mapGoldSummary(
  body: KiwoomGoldBalanceResponse,
  evalPflsAmount: number | null,
): BalanceSummary {
  const totalEvalAmount = num(body.tot_est_amt);
  return {
    currency: KRW,
    depositTotal: num(body.tot_entr),
    nextDaySettlement: null,
    totalEvalAmount,
    securitiesEvalAmount: totalEvalAmount,
    purchaseAmountTotal: num(body.tot_book_amt2),
    evalPflsAmount,
    netAssetAmount: num(body.tot_dep_amt),
    raw: body,
  };
}

/** Maps a gold-spot balance response (kt50020) to the normalized model. */
export function mapGoldBalance(body: KiwoomGoldBalanceResponse, date: string): BalanceResult {
  const holdings = (body.gold_acnt_evlt_prst ?? [])
    .map(mapGoldHolding)
    .filter((holding): holding is HoldingSnapshot => holding !== null);

  const pfls = holdings.reduce<number | null>((sum, holding) => {
    if (holding.evalPflsAmount === null) return sum;
    return (sum ?? 0) + holding.evalPflsAmount;
  }, null);

  return { date, summary: mapGoldSummary(body, pfls), holdings };
}

function mapGoldCandle(raw: KiwoomGoldCandleRaw, symbol: string): DailyQuote | null {
  const rawDate = str(raw.dt);
  if (!rawDate || rawDate.length !== 8) return null;

  return {
    market: KRX_GOLD,
    symbol,
    date: fromCompactDate(rawDate),
    open: num(raw.open_pric),
    high: num(raw.high_pric),
    low: num(raw.low_pric),
    close: num(raw.cur_prc),
    volume: num(raw.acc_trde_qty),
    currency: KRW,
    provider: KIWOOM_PROVIDER_ID,
    source: "kiwoom-gold-daily-chart",
    raw,
  };
}

export function mapGoldDailyQuotes(
  body: Pick<KiwoomGoldDailyChartResponse, "gds_day_chart_qry">,
  symbol: string,
): DailyQuote[] {
  return (body.gds_day_chart_qry ?? [])
    .map((candle) => mapGoldCandle(candle, symbol))
    .filter((quote): quote is DailyQuote => quote !== null);
}

function mapGoldTradeRow(raw: KiwoomGoldTradeRaw, market: string): TradeFill | null {
  const side = sideOf(str(raw.rmrk_nm));
  if (!side) return null;

  const quantity = Math.abs(num(raw.deal_qty) ?? 0);
  if (quantity <= 0) return null;

  const symbol = str(raw.stk_cd);
  const externalId = str(raw.deal_no);
  const tradeDate = str(raw.deal_dt) ?? str(raw.cntr_dt);
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
    amount: num(raw.deal_amt),
    currency: KRW,
    orderTime: str(raw.proc_time),
    raw,
  };
}

/**
 * Maps gold-spot trades from the date-range trade history (kt50032), keeping
 * only buys/sells with executed quantity.
 */
export function mapGoldTrades(
  body: Pick<KiwoomGoldTradeHistoryResponse, "gold_trde_hist">,
  market: string = KRX_GOLD,
): TradeFill[] {
  return (body.gold_trde_hist ?? [])
    .map((row) => mapGoldTradeRow(row, market))
    .filter((fill): fill is TradeFill => fill !== null);
}
