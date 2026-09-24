import { describe, expect, it } from "vitest";
import { currencyOf, mapTossBalance, marketOf } from "../src/providers/toss/endpoints/holdings";
import { mapTossOrder, mapTossOrders } from "../src/providers/toss/endpoints/orders";
import { mapTossCandle } from "../src/providers/toss/endpoints/candles";
import type { TossHoldingsOverview, TossOrder } from "../src/providers/toss/types";

describe("marketOf / currencyOf", () => {
  it("maps KR/US and rejects others", () => {
    expect(marketOf("KR")).toBe("KRX");
    expect(marketOf("US")).toBe("US");
    expect(marketOf("JP")).toBeNull();
    expect(currencyOf("KRX")).toBe("KRW");
    expect(currencyOf("US")).toBe("USD");
  });
});

const OVERVIEW: TossHoldingsOverview = {
  totalPurchaseAmount: { krw: 1_000_000, usd: 500 },
  marketValue: { amount: { krw: 1_100_000, usd: 550 } },
  profitLoss: { amount: { krw: 100_000, usd: 50 }, rate: 0.1 },
  items: [
    {
      symbol: "005930",
      name: "삼성전자",
      marketCountry: "KR",
      currency: "KRW",
      quantity: 10,
      lastPrice: 70000,
      averagePurchasePrice: 65000,
      marketValue: { purchaseAmount: 650000, amount: 700000 },
      profitLoss: { amount: 50000, rate: 0.0769 },
    },
    {
      symbol: "AAPL",
      name: "애플",
      marketCountry: "US",
      currency: "USD",
      quantity: 2,
      lastPrice: 275,
      averagePurchasePrice: 250,
      marketValue: { purchaseAmount: 500, amount: 550 },
      profitLoss: { amount: 50, rate: 0.1 },
    },
  ],
};

describe("mapTossBalance", () => {
  it("filters to the KRX market and uses KRW totals", () => {
    const result = mapTossBalance(OVERVIEW, {
      market: "KRX",
      currency: "KRW",
      date: "2026-09-20",
      depositTotal: 1234,
    });

    expect(result.holdings.map((holding) => holding.symbol)).toEqual(["005930"]);
    expect(result.summary).toMatchObject({
      currency: "KRW",
      depositTotal: 1234,
      purchaseAmountTotal: 1_000_000,
      totalEvalAmount: 1_100_000,
      securitiesEvalAmount: 1_100_000,
      evalPflsAmount: 100_000,
      netAssetAmount: 1_101_234,
    });
    expect(result.holdings[0]).toMatchObject({
      market: "KRX",
      currency: "KRW",
      quantity: 10,
      avgPrice: 65000,
      evalAmount: 700000,
      evalPflsAmount: 50000,
    });
    expect(result.holdings[0]?.evalPflsRate).toBeCloseTo(7.69, 4);
  });

  it("filters to the US market and uses USD totals", () => {
    const result = mapTossBalance(OVERVIEW, {
      market: "US",
      currency: "USD",
      date: "2026-09-20",
      depositTotal: null,
    });

    expect(result.holdings.map((holding) => holding.symbol)).toEqual(["AAPL"]);
    expect(result.summary).toMatchObject({
      currency: "USD",
      depositTotal: null,
      purchaseAmountTotal: 500,
      totalEvalAmount: 550,
      evalPflsAmount: 50,
      netAssetAmount: 550,
    });
    expect(result.holdings[0]?.evalPflsRate).toBeCloseTo(10, 4);
  });

  it("uses 0 for missing per-currency totals and derives net asset from cash", () => {
    const empty: TossHoldingsOverview = {
      totalPurchaseAmount: { krw: 1_000_000, usd: null },
      marketValue: { amount: { krw: 1_000_000, usd: null } },
      profitLoss: { amount: { krw: 0, usd: null } },
      items: [],
    };

    const result = mapTossBalance(empty, {
      market: "US",
      currency: "USD",
      date: "2026-09-25",
      depositTotal: 7.62,
    });

    expect(result.summary).toMatchObject({
      currency: "USD",
      depositTotal: 7.62,
      totalEvalAmount: 0,
      securitiesEvalAmount: 0,
      purchaseAmountTotal: 0,
      evalPflsAmount: 0,
      netAssetAmount: 7.62,
    });
  });

  it("keeps net asset null when neither securities nor cash are known", () => {
    const result = mapTossBalance(
      { items: [] },
      { market: "KRX", currency: "KRW", date: "2026-09-25", depositTotal: null },
    );

    expect(result.summary.netAssetAmount).toBeNull();
  });
});

const ORDERS: TossOrder[] = [
  {
    orderId: "o1",
    symbol: "005930",
    side: "BUY",
    currency: "KRW",
    orderedAt: "2026-09-18T09:01:02+09:00",
    execution: {
      filledQuantity: 10,
      averageFilledPrice: 70000,
      filledAmount: 700000,
      filledAt: "2026-09-18T09:01:05+09:00",
    },
  },
  {
    orderId: "o2",
    symbol: "005930",
    side: "SELL",
    currency: "KRW",
    orderedAt: "2026-09-19T10:00:00+09:00",
    execution: { filledQuantity: 0 },
  },
  {
    orderId: "o3",
    symbol: "AAPL",
    side: "BUY",
    currency: "USD",
    orderedAt: "2026-09-19T23:00:00+09:00",
    execution: { filledQuantity: 2, averageFilledPrice: 275, filledAmount: 550 },
  },
];

describe("mapTossOrders", () => {
  it("keeps only filled orders of the account's currency", () => {
    const fills = mapTossOrders(ORDERS, { market: "KRX", currency: "KRW" });
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      externalId: "o1",
      market: "KRX",
      side: "BUY",
      quantity: 10,
      avgPrice: 70000,
      amount: 700000,
      date: "2026-09-18",
      orderTime: "09:01:05",
    });
  });

  it("maps US fills separately", () => {
    const fills = mapTossOrders(ORDERS, { market: "US", currency: "USD" });
    expect(fills.map((fill) => fill.externalId)).toEqual(["o3"]);
  });

  it("returns null for an unfilled order", () => {
    expect(mapTossOrder({ orderId: "x", symbol: "005930", side: "BUY", execution: { filledQuantity: 0 } }, "KRX")).toBeNull();
  });
});

describe("mapTossCandle", () => {
  it("maps a daily candle", () => {
    const quote = mapTossCandle(
      {
        timestamp: "2026-09-19T00:00:00+09:00",
        openPrice: 1,
        highPrice: 2,
        lowPrice: 0.5,
        closePrice: 1.5,
        volume: 100,
        currency: "KRW",
      },
      "005930",
      "KRX",
      "KRW",
    );

    expect(quote).toMatchObject({
      market: "KRX",
      symbol: "005930",
      date: "2026-09-19",
      open: 1,
      close: 1.5,
      volume: 100,
      provider: "toss",
      source: "toss-daily-candle",
    });
  });
});
