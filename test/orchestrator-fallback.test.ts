import { describe, expect, it } from "vitest";
import { syncQuotesWithFallback, type SyncReport } from "../src/sync/orchestrator";
import type { BrokerProvider, DailyQuote } from "../src/domain/types";
import type { QuoteAssignment } from "../src/sync/quoteSources";

const db = {
  batch: async () => [],
  prepare: () => {
    throw new Error("unexpected db.prepare (providers returned no quotes)");
  },
} as unknown as D1Database;

function provider(id: string, quotes: () => Promise<DailyQuote[]>, calls: string[]): BrokerProvider {
  return {
    id,
    defaultMarket: "KRX",
    defaultCountry: "KR",
    defaultCurrency: "KRW",
    supportsMarket: () => true,
    getBalance: async () => {
      throw new Error("unused");
    },
    getTrades: async () => [],
    getDailyQuotes: async () => {
      calls.push(id);
      return quotes();
    },
  };
}

function report(): SyncReport {
  return {
    runId: "run-1",
    date: "2026-09-20",
    lookbackDays: 7,
    status: "success",
    accounts: [],
    quotes: [],
    errors: [],
    durationMs: 0,
  };
}

const assignments: QuoteAssignment[] = [
  { ref: { market: "KRX", symbol: "005930" }, candidates: ["kis", "kiwoom"] },
  { ref: { market: "KRX", symbol: "000660" }, candidates: ["kis", "kiwoom"] },
];

describe("syncQuotesWithFallback", () => {
  it("falls back to the next provider when the first fails", async () => {
    const calls: string[] = [];
    const available = new Map<string, BrokerProvider>([
      [
        "kis",
        provider("kis", async () => {
          throw new Error("kis down");
        }, calls),
      ],
      ["kiwoom", provider("kiwoom", async () => [], calls)],
    ]);
    const result = report();

    await syncQuotesWithFallback(db, assignments, available, result, "run-1", "2026-09-20");

    expect(calls).toEqual(["kis", "kiwoom"]);
    expect(result.quotes).toEqual([{ provider: "kiwoom", instruments: 2, quotes: 0 }]);
    expect(result.errors).toEqual([]);
  });

  it("records an error per instrument only after all candidates fail", async () => {
    const calls: string[] = [];
    const failing = (id: string) =>
      provider(
        id,
        async () => {
          throw new Error(`${id} down`);
        },
        calls,
      );
    const available = new Map<string, BrokerProvider>([
      ["kis", failing("kis")],
      ["kiwoom", failing("kiwoom")],
    ]);
    const result = report();

    await syncQuotesWithFallback(db, assignments, available, result, "run-1", "2026-09-20");

    expect(calls).toEqual(["kis", "kiwoom"]);
    expect(result.quotes).toEqual([]);
    expect(result.errors.map((e) => e.scope)).toEqual(["quotes:kiwoom", "quotes:kiwoom"]);
  });

  it("fetches each instrument once when the first provider succeeds", async () => {
    const calls: string[] = [];
    const available = new Map<string, BrokerProvider>([
      ["kis", provider("kis", async () => [], calls)],
      ["kiwoom", provider("kiwoom", async () => [], calls)],
    ]);
    const result = report();

    await syncQuotesWithFallback(db, assignments, available, result, "run-1", "2026-09-20");

    expect(calls).toEqual(["kis"]);
    expect(result.quotes).toEqual([{ provider: "kis", instruments: 2, quotes: 0 }]);
  });
});
