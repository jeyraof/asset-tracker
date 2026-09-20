import { fromCompactDate } from "../../../lib/dates";
import { num, str } from "../../../lib/parse";
import type {
  BalanceResult,
  BalanceSummary,
  DailyQuote,
  HoldingSnapshot,
  TradeFill,
  TradeSide,
} from "../../../domain/types";
import type {
  KiwoomBalanceResponse,
  KiwoomCandleRaw,
  KiwoomDailyChartResponse,
  KiwoomDepositResponse,
  KiwoomHoldingRaw,
  KiwoomTradeHistoryRaw,
  KiwoomTradeHistoryResponse,
} from "../types";

export const KRX = "KRX";
export const KRX_GOLD = "KRX-GOLD";
export const KRW = "KRW";
export const KIWOOM_PROVIDER_ID = "kiwoom";

/**
 * Normalizes a Kiwoom symbol to the plain KRX 6-char code.
 *
 * Codes may carry an exchange suffix (`039490_NX` = NXT, `039490_AL` =
 * unified) and a security-type prefix (A: 주식, J: ELW, Q: ETN), e.g.
 * `A005930`, `A0199C0` (new-format codes may contain letters). Since quotes
 * are pinned to KRX regular session, drop the suffix, then strip only the
 * leading prefix; never drop characters inside the 6-char code.
 */
export function stripSymbol(code: string | undefined | null): string | null {
  const value = str(code);
  if (!value) return null;
  const withoutExchange = value.replace(/_(NX|AL)$/, "");
  if (withoutExchange.length === 7 && /^[AJQ]/.test(withoutExchange)) {
    return withoutExchange.slice(1);
  }
  return withoutExchange;
}

export function sideOf(value: string | null): TradeSide | null {
  if (!value) return null;
  if (value.includes("매수")) return "BUY";
  if (value.includes("매도")) return "SELL";
  return null;
}

function mapHolding(raw: KiwoomHoldingRaw): HoldingSnapshot | null {
  const symbol = stripSymbol(raw.stk_cd);
  if (!symbol) return null;

  return {
    market: KRX,
    symbol,
    productName: str(raw.stk_nm),
    currency: KRW,
    quantity: num(raw.rmnd_qty) ?? 0,
    avgPrice: num(raw.pur_pric),
    purchaseAmount: num(raw.pur_amt),
    currentPrice: num(raw.cur_prc),
    evalAmount: num(raw.evlt_amt),
    evalPflsAmount: num(raw.evltv_prft),
    evalPflsRate: num(raw.prft_rt),
    raw,
  };
}

function mapSummary(
  balance: KiwoomBalanceResponse,
  deposit: KiwoomDepositResponse,
): BalanceSummary {
  const totalEvalAmount = num(balance.tot_evlt_amt);
  return {
    currency: KRW,
    depositTotal: num(deposit.entr),
    nextDaySettlement: num(deposit.d1_entra),
    totalEvalAmount,
    securitiesEvalAmount: totalEvalAmount,
    purchaseAmountTotal: num(balance.tot_pur_amt),
    evalPflsAmount: num(balance.tot_evlt_pl),
    netAssetAmount: num(balance.prsm_dpst_aset_amt),
    raw: { balance, deposit },
  };
}

/** Maps a (paginated) balance + deposit response pair to the normalized model. */
export function mapDomesticBalance(
  balance: KiwoomBalanceResponse,
  deposit: KiwoomDepositResponse,
  date: string,
): BalanceResult {
  const holdings = (balance.acnt_evlt_remn_indv_tot ?? [])
    .map(mapHolding)
    .filter((holding): holding is HoldingSnapshot => holding !== null);

  return { date, summary: mapSummary(balance, deposit), holdings };
}

/** `trde_qty_jwa_cnt` is "거래수량/좌수"; take the numeric head. */
function parseQuantity(value: string | undefined | null): number | null {
  const raw = str(value);
  if (!raw) return null;
  const head = raw.split("/")[0] ?? "";
  const parsed = num(head);
  return parsed === null ? null : Math.abs(parsed);
}

function mapTradeRow(raw: KiwoomTradeHistoryRaw, market: string): TradeFill | null {
  const side = sideOf(str(raw.io_tp_nm)) ?? sideOf(str(raw.rmrk_nm));
  if (!side) return null;

  const quantity = parseQuantity(raw.trde_qty_jwa_cnt) ?? 0;
  if (quantity <= 0) return null;

  const symbol = stripSymbol(raw.stk_cd);
  const externalId = str(raw.trde_no);
  const tradeDate = str(raw.trde_dt) ?? str(raw.cntr_dt);
  if (!symbol || !externalId || !tradeDate || tradeDate.length !== 8) return null;

  return {
    date: fromCompactDate(tradeDate),
    externalId,
    market,
    symbol,
    productName: str(raw.stk_nm),
    side,
    quantity,
    avgPrice: num(raw.trde_unit),
    amount: num(raw.trde_amt),
    currency: KRW,
    orderTime: str(raw.proc_tm),
    raw,
  };
}

/**
 * Maps domestic trades from the date-range trade history (kt00015), keeping only
 * buys/sells with executed quantity. One call covers the whole window.
 */
export function mapDomesticTrades(
  body: Pick<KiwoomTradeHistoryResponse, "trst_ovrl_trde_prps_array">,
  market: string = KRX,
): TradeFill[] {
  return (body.trst_ovrl_trde_prps_array ?? [])
    .map((row) => mapTradeRow(row, market))
    .filter((fill): fill is TradeFill => fill !== null);
}

function mapCandle(raw: KiwoomCandleRaw, symbol: string): DailyQuote | null {
  const rawDate = str(raw.dt);
  if (!rawDate || rawDate.length !== 8) return null;

  return {
    market: KRX,
    symbol,
    date: fromCompactDate(rawDate),
    open: num(raw.open_pric),
    high: num(raw.high_pric),
    low: num(raw.low_pric),
    close: num(raw.cur_prc),
    volume: num(raw.trde_qty),
    currency: KRW,
    provider: KIWOOM_PROVIDER_ID,
    source: "kiwoom-daily-chart",
    raw,
  };
}

export function mapDomesticDailyQuotes(
  body: Pick<KiwoomDailyChartResponse, "stk_dt_pole_chart_qry">,
  symbol: string,
): DailyQuote[] {
  return (body.stk_dt_pole_chart_qry ?? [])
    .map((candle) => mapCandle(candle, symbol))
    .filter((quote): quote is DailyQuote => quote !== null);
}
