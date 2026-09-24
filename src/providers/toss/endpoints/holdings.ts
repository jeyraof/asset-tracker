import { num, str } from "../../../lib/parse";
import type { BalanceResult, BalanceSummary, HoldingSnapshot } from "../../../domain/types";
import type { TossHoldingsItem, TossHoldingsOverview, TossPrice } from "../types";

export const KRX = "KRX";
export const US = "US";
export const KRW = "KRW";
export const USD = "USD";
export const TOSS_PROVIDER_ID = "toss";

/** Maps Toss `marketCountry` (KR/US) to the normalized market id. */
export function marketOf(country: string | null | undefined): string | null {
  const value = str(country);
  if (value === "KR") return KRX;
  if (value === "US") return US;
  return null;
}

export function marketCountryOf(market: string): string | null {
  if (market === KRX) return "KR";
  if (market === US) return "US";
  return null;
}

export function currencyOf(market: string): string {
  return market === US ? USD : KRW;
}

function priceFor(price: TossPrice | undefined, currency: string): number | null {
  if (!price || typeof price !== "object") return null;
  return num(currency === USD ? price.usd : price.krw);
}

function mapHolding(raw: TossHoldingsItem, market: string, currency: string): HoldingSnapshot | null {
  const symbol = str(raw.symbol);
  if (!symbol) return null;

  const profit = raw.profitLoss;
  const marketValue = raw.marketValue;
  const rate = num(profit?.rate);

  return {
    market,
    symbol,
    productName: str(raw.name),
    currency,
    quantity: num(raw.quantity) ?? 0,
    avgPrice: num(raw.averagePurchasePrice),
    purchaseAmount: num(marketValue?.purchaseAmount),
    currentPrice: num(raw.lastPrice),
    evalAmount: num(marketValue?.amount),
    evalPflsAmount: num(profit?.amount),
    // Toss reports a decimal ratio (0.1077 = 10.77%); the domain stores percent.
    evalPflsRate: rate === null ? null : rate * 100,
    raw,
  };
}

/**
 * Maps a Toss holdings overview to the normalized balance for a single market
 * (KRX or US). Toss returns both markets and per-currency totals in one call,
 * so each account row filters to its own market/currency.
 */
export function mapTossBalance(
  overview: TossHoldingsOverview,
  options: { market: string; currency: string; date: string; depositTotal: number | null },
): BalanceResult {
  const { market, currency, date, depositTotal } = options;

  const holdings = (overview.items ?? [])
    .filter((item) => marketOf(item.marketCountry) === market)
    .map((item) => mapHolding(item, market, currency))
    .filter((holding): holding is HoldingSnapshot => holding !== null);

  const evalAmount = priceFor(overview.marketValue?.amount, currency);
  const summary: BalanceSummary = {
    currency,
    depositTotal,
    nextDaySettlement: null,
    // Toss omits a currency's totals when there are no holdings in that market;
    // store 0 so an existing account row still shows a value.
    totalEvalAmount: evalAmount ?? 0,
    securitiesEvalAmount: evalAmount ?? 0,
    purchaseAmountTotal: priceFor(overview.totalPurchaseAmount, currency) ?? 0,
    evalPflsAmount: priceFor(overview.profitLoss?.amount, currency) ?? 0,
    // Toss has no net-asset field, so derive it as securities + cash (approx).
    netAssetAmount:
      evalAmount !== null || depositTotal !== null ? (evalAmount ?? 0) + (depositTotal ?? 0) : null,
    raw: overview,
  };

  return { date, summary, holdings };
}
