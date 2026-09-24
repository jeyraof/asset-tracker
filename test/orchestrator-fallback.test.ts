import { describe, expect, it } from "vitest";
import { syncQuotesWithFallback, type SyncReport } from "../src/sync/orchestrator";
import type { BrokerProvider, DailyQuote, QuoteFetchResult, QuoteFailure } from "../src/domain/types";
import type { QuoteAssignment } from "../src/sync/quoteSources";

const db = {
  batch: async () => [],
  prepare: () => {
    throw new Error("unexpected db.prepare (providers returned no quotes)");
  },
} as unknown as D1Database;

function provider(
  id: string,
  fetch: () => Promise<Partial<QuoteFetchResult>>,
  calls: string[],
): BrokerProvider {
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
    getDailyQuotes: async (): Promise<QuoteFetchResult> => {
      calls.push(id);
      const result = await fetch();
      return { quotes: result.quotes ?? [], failures: result.failures ?? [] };
    },
  };
}

function throws(id: string, calls: string[]): BrokerProvider {
  return provider(
    id,
    async () => {
      throw new Error(`${id} down`);
    },
    calls,
  );
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
    retries: 0,
    failedSymbols: [],
    durationMs: 0,
  };
}

const assignments: QuoteAssignment[] = [
  { ref: { market: "KRX", symbol: "005930" }, candidates: ["kis", "kiwoom"] },
  { ref: { market: "KRX", symbol: "000660" }, candidates: ["kis", "kiwoom"] },
];

const failure = (symbol: string): QuoteFailure => ({
  ref: { market: "KRX", symbol },
  message: "KIS HTTP 502",
  status: 502,
  attempts: 3,
});

describe("syncQuotesWithFallback", () => {
  it("falls back to the next provider when the first fails", async () => {
    const calls: string[] = [];
    const available = new Map<string, BrokerProvider>([
      ["kis", throws("kis", calls)],
      ["kiwoom", provider("kiwoom", async () => ({ quotes: [] }), calls)],
    ]);
    const result = report();

    await syncQuotesWithFallback(db, assignments, available, result, "run-1", "2026-09-20");

    expect(calls).toEqual(["kis", "kiwoom"]);
    expect(result.quotes).toEqual([{ provider: "kiwoom", instruments: 2, quotes: 0 }]);
    expect(result.errors).toEqual([]);
  });

  it("records an error per instrument only after all candidates fail", async () => {
    const calls: string[] = [];
    const available = new Map<string, BrokerProvider>([
      ["kis", throws("kis", calls)],
      ["kiwoom", throws("kiwoom", calls)],
    ]);
    const result = report();

    await syncQuotesWithFallback(db, assignments, available, result, "run-1", "2026-09-20");

    expect(calls).toEqual(["kis", "kiwoom"]);
    expect(result.quotes).toEqual([]);
    expect(result.errors.map((e) => e.scope)).toEqual([
      "quotes:kiwoom:005930",
      "quotes:kiwoom:000660",
    ]);
  });

  it("fetches each instrument once when the first provider succeeds", async () => {
    const calls: string[] = [];
    const available = new Map<string, BrokerProvider>([
      ["kis", provider("kis", async () => ({ quotes: [] }), calls)],
      ["kiwoom", provider("kiwoom", async () => ({ quotes: [] }), calls)],
    ]);
    const result = report();

    await syncQuotesWithFallback(db, assignments, available, result, "run-1", "2026-09-20");

    expect(calls).toEqual(["kis"]);
    expect(result.quotes).toEqual([{ provider: "kis", instruments: 2, quotes: 0 }]);
  });

  it("requeues only the failed instrument to the next candidate", async () => {
    const calls: string[] = [];
    const available = new Map<string, BrokerProvider>([
      [
        "kis",
        provider(
          "kis",
          async () => ({ quotes: [], failures: [failure("005930")] }),
          calls,
        ),
      ],
      ["kiwoom", provider("kiwoom", async () => ({ quotes: [] }), calls)],
    ]);
    const result = report();

    await syncQuotesWithFallback(db, assignments, available, result, "run-1", "2026-09-20");

    expect(calls).toEqual(["kis", "kiwoom"]);
    expect(result.quotes).toEqual([
      { provider: "kis", instruments: 2, quotes: 0 },
      { provider: "kiwoom", instruments: 1, quotes: 0 },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("records a symbol error when the fallback also fails", async () => {
    const calls: string[] = [];
    const available = new Map<string, BrokerProvider>([
      [
        "kis",
        provider("kis", async () => ({ quotes: [], failures: [failure("005930")] }), calls),
      ],
      [
        "kiwoom",
        provider("kiwoom", async () => ({ quotes: [], failures: [failure("005930")] }), calls),
      ],
    ]);
    const result = report();

    await syncQuotesWithFallback(db, assignments, available, result, "run-1", "2026-09-20");

    expect(calls).toEqual(["kis", "kiwoom"]);
    expect(result.errors).toEqual([
      {
        scope: "quotes:kiwoom:005930",
        provider: "kiwoom",
        market: "KRX",
        symbol: "005930",
        message: "KIS HTTP 502",
        status: 502,
        attempts: 3,
      },
    ]);
  });
});
