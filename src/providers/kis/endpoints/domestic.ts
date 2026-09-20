import { fromCompactDate } from "../../../lib/dates";
import { num, str } from "../../../lib/parse";
import type {
  BalanceResult,
  BalanceSummary,
  DailyQuote,
  HoldingSnapshot,
  TradeFill,
} from "../../../domain/types";
import type {
  KisDomesticBalanceResponse,
  KisDomesticCandleRaw,
  KisDomesticCclDResponse,
  KisDomesticCclDRaw,
  KisDomesticDailyChartResponse,
  KisDomesticHoldingRaw,
  KisDomesticSummaryRaw,
} from "../types";

export const KRX = "KRX";
export const KRW = "KRW";
export const KIS_PROVIDER_ID = "kis";

function mapHolding(raw: KisDomesticHoldingRaw): HoldingSnapshot | null {
  const symbol = str(raw.pdno);
  if (!symbol) return null;
  return {
    market: KRX,
    symbol,
    productName: str(raw.prdt_name),
    currency: KRW,
    quantity: num(raw.hldg_qty) ?? 0,
    avgPrice: num(raw.pchs_avg_pric),
    purchaseAmount: num(raw.pchs_amt),
    currentPrice: num(raw.prpr),
    evalAmount: num(raw.evlu_amt),
    evalPflsAmount: num(raw.evlu_pfls_amt),
    evalPflsRate: num(raw.evlu_pfls_rt),
    raw,
  };
}

function mapSummary(raw: KisDomesticSummaryRaw | undefined): BalanceSummary {
  return {
    currency: KRW,
    depositTotal: num(raw?.dnca_tot_amt),
    nextDaySettlement: num(raw?.nxdy_excc_amt),
    totalEvalAmount: num(raw?.tot_evlu_amt),
    securitiesEvalAmount: num(raw?.scts_evlu_amt),
    purchaseAmountTotal: num(raw?.pchs_amt_smtl_amt),
    evalPflsAmount: num(raw?.evlu_pfls_smtl_amt),
    netAssetAmount: num(raw?.nass_amt),
    raw: raw ?? null,
  };
}

export function mapDomesticHolding(raw: KisDomesticHoldingRaw): HoldingSnapshot | null {
  return mapHolding(raw);
}

export function mapDomesticSummary(raw: KisDomesticSummaryRaw | undefined): BalanceSummary {
  return mapSummary(raw);
}

/** Maps an aggregated (already paginated) domestic balance response. */
export function mapDomesticBalance(
  body: Pick<KisDomesticBalanceResponse, "output1" | "output2">,
  date: string,
): BalanceResult {
  const holdings = (body.output1 ?? [])
    .map(mapHolding)
    .filter((holding): holding is HoldingSnapshot => holding !== null);

  return {
    date,
    summary: mapSummary(body.output2?.[0]),
    holdings,
  };
}

function mapCclDRow(raw: KisDomesticCclDRaw): TradeFill | null {
  const side = raw.sll_buy_dvsn_cd === "01" ? "SELL" : raw.sll_buy_dvsn_cd === "02" ? "BUY" : null;
  if (!side) return null;

  const quantity = num(raw.tot_ccld_qty) ?? 0;
  if (quantity <= 0) return null;

  const symbol = str(raw.pdno);
  const externalId = str(raw.odno);
  const orderDate = str(raw.ord_dt);
  if (!symbol || !externalId || !orderDate) return null;

  return {
    date: fromCompactDate(orderDate),
    externalId,
    market: KRX,
    symbol,
    productName: str(raw.prdt_name),
    side,
    quantity,
    avgPrice: num(raw.avg_prvs),
    amount: num(raw.tot_ccld_amt),
    currency: KRW,
    orderTime: str(raw.ord_tmd),
    raw,
  };
}

/**
 * Maps domestic order executions, keeping only quantity-changing fills
 * (buys/sells). Deposits, dividends, and other cash events are excluded.
 */
export function mapDomesticTrades(
  body: Pick<KisDomesticCclDResponse, "output1">,
): TradeFill[] {
  return (body.output1 ?? [])
    .map(mapCclDRow)
    .filter((fill): fill is TradeFill => fill !== null);
}

function mapCandle(
  raw: KisDomesticCandleRaw,
  symbol: string,
): DailyQuote | null {
  const rawDate = str(raw.stck_bsop_date);
  if (!rawDate || rawDate.length !== 8) return null;
  return {
    market: KRX,
    symbol,
    date: fromCompactDate(rawDate),
    open: num(raw.stck_oprc),
    high: num(raw.stck_hgpr),
    low: num(raw.stck_lwpr),
    close: num(raw.stck_clpr),
    volume: num(raw.acml_vol),
    currency: KRW,
    provider: KIS_PROVIDER_ID,
    source: "kis-daily-chart",
    raw,
  };
}

export function mapDomesticDailyQuotes(
  body: Pick<KisDomesticDailyChartResponse, "output2">,
  symbol: string,
): DailyQuote[] {
  return (body.output2 ?? [])
    .map((candle) => mapCandle(candle, symbol))
    .filter((quote): quote is DailyQuote => quote !== null);
}
