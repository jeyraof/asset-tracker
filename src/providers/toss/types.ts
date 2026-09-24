/**
 * Raw Toss Securities Open API response shapes.
 *
 * Amounts/prices/quantities arrive as JSON **strings** (BigDecimal), so they are
 * typed as `TossNumeric` and normalized through `num()` in the mappers.
 */

export type TossNumeric = string | number;

/** Error envelope: `{ "error": { requestId, code, message, data } }`. */
export interface TossErrorBody {
  error?: {
    requestId?: string;
    code?: string;
    message?: string;
    data?: unknown;
  };
}

export interface TossTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  [key: string]: unknown;
}

export interface TossAccount {
  accountNo?: string;
  accountSeq?: number;
  accountType?: string;
  [key: string]: unknown;
}

/** Stock master row (`GET /api/v1/stocks`), used to name trades. */
export interface TossStock {
  symbol?: string;
  name?: string;
  englishName?: string;
  [key: string]: unknown;
}

/** `{krw, usd?}` — a per-currency aggregate. */
export interface TossPrice {
  krw?: TossNumeric;
  usd?: TossNumeric | null;
}

export interface TossMarketValue {
  purchaseAmount?: TossNumeric;
  amount?: TossNumeric;
  amountAfterCost?: TossNumeric;
}

export interface TossProfitLoss {
  amount?: TossNumeric;
  amountAfterCost?: TossNumeric;
  /** Decimal ratio (0.1077 = 10.77%). */
  rate?: TossNumeric;
  rateAfterCost?: TossNumeric;
}

export interface TossCost {
  commission?: TossNumeric;
  tax?: TossNumeric | null;
}

export interface TossHoldingsItem {
  symbol?: string;
  name?: string;
  /** "KR" | "US". */
  marketCountry?: string;
  /** "KRW" | "USD". */
  currency?: string;
  quantity?: TossNumeric;
  lastPrice?: TossNumeric;
  averagePurchasePrice?: TossNumeric;
  marketValue?: TossMarketValue;
  profitLoss?: TossProfitLoss;
  cost?: TossCost;
}

export interface TossHoldingsOverview {
  /** 투자원금 (per currency). */
  totalPurchaseAmount?: TossPrice;
  marketValue?: { amount?: TossPrice; amountAfterCost?: TossPrice };
  profitLoss?: {
    amount?: TossPrice;
    amountAfterCost?: TossPrice;
    rate?: TossNumeric;
    rateAfterCost?: TossNumeric;
  };
  items?: TossHoldingsItem[];
}

export interface TossOrderExecution {
  filledQuantity?: TossNumeric;
  averageFilledPrice?: TossNumeric | null;
  filledAmount?: TossNumeric;
  commission?: TossNumeric;
  tax?: TossNumeric;
  /** ISO 8601 (KST). */
  filledAt?: string;
  /** YYYY-MM-DD (KST). */
  settlementDate?: string | null;
}

export interface TossOrder {
  orderId?: string;
  symbol?: string;
  /** "BUY" | "SELL". */
  side?: string;
  orderType?: string;
  timeInForce?: string;
  status?: string;
  price?: TossNumeric | null;
  quantity?: TossNumeric;
  orderAmount?: TossNumeric | null;
  currency?: string;
  /** ISO 8601 (KST). */
  orderedAt?: string;
  canceledAt?: string | null;
  execution?: TossOrderExecution;
}

export interface TossPaginatedOrders {
  orders?: TossOrder[];
  nextCursor?: string | null;
  hasNext?: boolean;
}

export interface TossBuyingPower {
  currency?: string;
  cashBuyingPower?: TossNumeric;
}

export interface TossCandle {
  /** ISO 8601; for `1d` it is the trading day at local midnight. */
  timestamp?: string;
  openPrice?: TossNumeric;
  highPrice?: TossNumeric;
  lowPrice?: TossNumeric;
  closePrice?: TossNumeric;
  volume?: TossNumeric;
  currency?: string;
}

export interface TossCandlePage {
  candles?: TossCandle[];
  nextBefore?: string | null;
}
