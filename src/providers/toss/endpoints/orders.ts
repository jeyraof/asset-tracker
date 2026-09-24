import { num, str } from "../../../lib/parse";
import type { TradeFill, TradeSide } from "../../../domain/types";
import { currencyOf } from "./holdings";
import type { TossOrder } from "../types";

function sideOf(value: string | null): TradeSide | null {
  if (value === "BUY") return "BUY";
  if (value === "SELL") return "SELL";
  return null;
}

function isoDate(value: string | null): string | null {
  if (!value) return null;
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function isoTime(value: string | null): string | null {
  if (!value) return null;
  const time = value.slice(11, 19);
  return /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : null;
}

/** Maps one filled Toss order to a normalized trade fill (null if not filled). */
export function mapTossOrder(
  raw: TossOrder,
  market: string,
  productName: string | null = null,
): TradeFill | null {
  const symbol = str(raw.symbol);
  const externalId = str(raw.orderId);
  const side = sideOf(str(raw.side));
  const quantity = num(raw.execution?.filledQuantity) ?? 0;
  const date = isoDate(str(raw.orderedAt));

  if (!symbol || !externalId || !side || quantity <= 0 || !date) return null;

  return {
    date,
    externalId,
    market,
    symbol,
    productName,
    side,
    quantity,
    avgPrice: num(raw.execution?.averageFilledPrice),
    amount: num(raw.execution?.filledAmount),
    currency: str(raw.currency) ?? currencyOf(market),
    orderTime: isoTime(str(raw.execution?.filledAt) ?? str(raw.orderedAt)),
    raw,
  };
}

/**
 * Maps a batch of orders to fills for one account, filtered by its currency.
 * `nameBySymbol` (from `GET /api/v1/stocks`) fills the product name, which the
 * order history itself does not carry.
 */
export function mapTossOrders(
  orders: readonly TossOrder[],
  options: {
    market: string;
    currency: string;
    nameBySymbol?: ReadonlyMap<string, string>;
  },
): TradeFill[] {
  const { market, currency, nameBySymbol } = options;
  return orders
    .filter((order) => (str(order.currency) ?? currencyOf(market)) === currency)
    .map((order) =>
      mapTossOrder(order, market, nameBySymbol?.get(str(order.symbol) ?? "") ?? null),
    )
    .filter((fill): fill is TradeFill => fill !== null);
}
