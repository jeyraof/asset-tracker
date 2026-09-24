import { describe, expect, it } from "vitest";
import { TossProvider } from "../src/providers/toss";
import { RateLimiter } from "../src/lib/rateLimit";
import type { AccountConfig } from "../src/domain/types";
import { createFakeKv, createFetchMock, jsonResponse } from "./helpers";

const TOKEN = { access_token: "TOKEN", token_type: "bearer", expires_in: 3600 };

function account(seq: number, product?: "us"): AccountConfig {
  const us = product === "us";
  return {
    id: 1,
    provider: "toss",
    env: "prod",
    externalId: us ? `${seq}-us` : String(seq),
    country: us ? "US" : "KR",
    currency: us ? "USD" : "KRW",
    name: null,
    active: true,
    meta: us ? { accountSeq: seq, product: "us" } : { accountSeq: seq },
  };
}

function createProvider(handler: Parameters<typeof createFetchMock>[0]) {
  const fake = createFakeKv();
  const mock = createFetchMock(handler);
  const provider = new TossProvider({
    environment: "prod",
    baseUrl: "https://toss.test",
    cache: fake.kv,
    rateLimiter: new RateLimiter(0),
    credentials: { clientId: "CID", clientSecret: "SEC" },
    relaySecret: "relay",
    debug: false,
    fetchImpl: mock.fetchImpl,
  });
  return { provider, mock };
}

const OVERVIEW = {
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

function baseHandler(url: string, init?: RequestInit) {
  if (url.includes("/oauth2/token")) return jsonResponse(TOKEN);
  if (url.includes("/api/v1/holdings")) return jsonResponse({ result: OVERVIEW });
  if (url.includes("/api/v1/buying-power")) {
    const currency = new URL(url).searchParams.get("currency");
    // Toss returns numbers as strings.
    return jsonResponse({
      result: { currency, cashBuyingPower: currency === "USD" ? "123.45" : "987654" },
    });
  }
  if (url.includes("/api/v1/orders")) {
    return jsonResponse({
      result: {
        orders: [
          {
            orderId: "o1",
            symbol: "005930",
            side: "BUY",
            currency: "KRW",
            orderedAt: "2026-09-18T09:01:02+09:00",
            execution: { filledQuantity: 10, averageFilledPrice: 70000, filledAmount: 700000 },
          },
        ],
        hasNext: false,
      },
    });
  }
  if (url.includes("/api/v1/candles")) {
    return jsonResponse({
      result: {
        candles: [
          { timestamp: "2026-09-19T00:00:00+09:00", openPrice: 1, highPrice: 2, lowPrice: 0.5, closePrice: 1.5, volume: 100, currency: "KRW" },
        ],
      },
    });
  }
  return jsonResponse({ error: { code: "edge-blocked", message: "unexpected" } }, {}, 404);
}

describe("TossProvider", () => {
  it("maps a KRX balance and approximates the deposit", async () => {
    const { provider, mock } = createProvider(baseHandler);

    const result = await provider.getBalance(account(1), "2026-09-20");

    expect(result.summary).toMatchObject({
      currency: "KRW",
      depositTotal: 987654,
      totalEvalAmount: 1_100_000,
      netAssetAmount: 2_087_654,
    });
    expect(result.holdings.map((holding) => holding.symbol)).toEqual(["005930"]);

    const holdingsCall = mock.calls.find((entry) => entry.url.includes("/api/v1/holdings"));
    expect(holdingsCall?.init?.headers).toMatchObject({ "X-Tossinvest-Account": "1" });
  });

  it("maps a US balance with USD totals and buying power", async () => {
    const { provider } = createProvider(baseHandler);

    const result = await provider.getBalance(account(1, "us"), "2026-09-20");

    expect(result.summary).toMatchObject({
      currency: "USD",
      depositTotal: 123.45,
      totalEvalAmount: 550,
      netAssetAmount: 673.45,
    });
    expect(result.holdings.map((holding) => holding.symbol)).toEqual(["AAPL"]);
  });

  it("maps filled orders of the account's currency", async () => {
    const { provider } = createProvider(baseHandler);

    const trades = await provider.getTrades(account(1), "2026-09-14", "2026-09-20");

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ externalId: "o1", market: "KRX", side: "BUY", quantity: 10 });
  });

  it("maps daily candles into quotes", async () => {
    const { provider } = createProvider(baseHandler);

    const result = await provider.getDailyQuotes([{ market: "KRX", symbol: "005930" }], "2026-09-20");

    expect(result.failures).toEqual([]);
    expect(result.quotes).toHaveLength(1);
    expect(result.quotes[0]).toMatchObject({ market: "KRX", symbol: "005930", date: "2026-09-19", close: 1.5 });
  });

  it("records a quote failure without throwing", async () => {
    const { provider } = createProvider((url) => {
      if (url.includes("/oauth2/token")) return jsonResponse(TOKEN);
      return jsonResponse({ error: { code: "stock-not-found", message: "nope" } }, {}, 404);
    });

    const result = await provider.getDailyQuotes([{ market: "KRX", symbol: "999999" }], "2026-09-20");

    expect(result.quotes).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.ref.symbol).toBe("999999");
  });
});
