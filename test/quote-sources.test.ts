import { describe, expect, it } from "vitest";
import { resolveQuoteCandidates, type QuoteSourceEntry } from "../src/sync/quoteSources";

const priority = ["kis", "kiwoom"];

function capability(markets: string[]) {
  return { supportsMarket: (market: string) => markets.includes(market) };
}

function available(entries: Record<string, string[]>): ReadonlyMap<string, ReturnType<typeof capability>> {
  return new Map(Object.entries(entries).map(([id, markets]) => [id, capability(markets)]));
}

function entry(market: string, symbol: string, providers: string[]): QuoteSourceEntry {
  return { ref: { market, symbol }, providers: new Set(providers) };
}

describe("resolveQuoteCandidates", () => {
  it("picks a single source per instrument in priority order", () => {
    const result = resolveQuoteCandidates(
      [entry("KRX", "005930", ["kis", "kiwoom"])],
      available({ kis: ["KRX"], kiwoom: ["KRX"] }),
      priority,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.candidates).toEqual(["kis", "kiwoom"]);
  });

  it("falls back to the next provider when a holder is unavailable", () => {
    const result = resolveQuoteCandidates(
      [entry("KRX", "005930", ["kis", "kiwoom"])],
      available({ kiwoom: ["KRX"] }),
      priority,
    );

    expect(result[0]?.candidates).toEqual(["kiwoom"]);
  });

  it("skips providers that do not support the market", () => {
    const result = resolveQuoteCandidates(
      [entry("KRX-GOLD", "M04020000", ["kis", "kiwoom"])],
      available({ kis: ["KRX"], kiwoom: ["KRX", "KRX-GOLD"] }),
      priority,
    );

    expect(result[0]?.candidates).toEqual(["kiwoom"]);
  });

  it("routes US instruments to kiwoom only", () => {
    const result = resolveQuoteCandidates(
      [entry("US", "AAPL", ["kis", "kiwoom"])],
      available({ kis: ["KRX"], kiwoom: ["KRX", "KRX-GOLD", "US"] }),
      priority,
    );

    expect(result[0]?.candidates).toEqual(["kiwoom"]);
  });

  it("drops instruments no available provider can price", () => {
    const result = resolveQuoteCandidates(
      [entry("KRX", "005930", ["kis"])],
      available({ kis: ["KRX-GOLD"] }),
      priority,
    );

    expect(result).toEqual([]);
  });

  it("returns one assignment per instrument (no cross-broker duplicates)", () => {
    const result = resolveQuoteCandidates(
      [
        entry("KRX", "005930", ["kis", "kiwoom"]),
        entry("KRX", "000660", ["kiwoom"]),
      ],
      available({ kis: ["KRX"], kiwoom: ["KRX"] }),
      priority,
    );

    expect(result.map((a) => [a.ref.symbol, a.candidates])).toEqual([
      ["005930", ["kis", "kiwoom"]],
      ["000660", ["kiwoom"]],
    ]);
  });
});
