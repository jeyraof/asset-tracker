import { describe, expect, it } from "vitest";
import { tradesEnabled } from "../src/sync/orchestrator";
import type { AccountConfig } from "../src/domain/types";

function account(meta: Record<string, unknown>): AccountConfig {
  return {
    id: 1,
    provider: "kis",
    env: "prod",
    externalId: "12345678-01",
    country: "KR",
    currency: "KRW",
    name: null,
    active: true,
    meta,
  };
}

describe("tradesEnabled", () => {
  it("defaults to enabled", () => {
    expect(tradesEnabled(account({}))).toBe(true);
    expect(tradesEnabled(account({ trades: true }))).toBe(true);
    expect(tradesEnabled(account({ trades: "no" }))).toBe(true);
  });

  it("is disabled only when meta.trades is exactly false", () => {
    expect(tradesEnabled(account({ trades: false }))).toBe(false);
  });
});
