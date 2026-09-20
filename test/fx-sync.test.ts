import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { BrokerProvider, FxRate } from "../src/domain/types";

const { providers } = vi.hoisted(() => ({ providers: new Map<string, BrokerProvider>() }));

vi.mock("../src/providers/registry", () => ({
  listKnownProviders: () => ["kis", "kiwoom"],
  getProvider: (id: string) => {
    const provider = providers.get(id);
    if (!provider) throw new Error(`no fake provider for ${id}`);
    return provider;
  },
}));

import { kstDate } from "../src/lib/dates";
import { syncFxRates } from "../src/sync/fx";

function createFakeDb() {
  const binds: unknown[][] = [];
  const db = {
    prepare: () => ({
      bind: (...args: unknown[]) => {
        binds.push(args);
        return {};
      },
    }),
    batch: async () => [],
  } as unknown as D1Database;
  return { db, binds };
}

function baseProvider(id: string): BrokerProvider {
  return {
    id,
    defaultMarket: "US",
    defaultCountry: "US",
    defaultCurrency: "USD",
    supportsMarket: () => true,
    getBalance: async () => {
      throw new Error("unused");
    },
    getTrades: async () => [],
    getDailyQuotes: async () => [],
  };
}

function fxProvider(id: string, rate: FxRate | null): BrokerProvider {
  return {
    ...baseProvider(id),
    getFxRate: async () => rate,
  };
}

const USD_KRW: FxRate = {
  base: "USD",
  quote: "KRW",
  date: "2026-09-21",
  rate: 1524.5,
  provider: "kiwoom",
  source: "kiwoom-us-fx-rate",
  raw: {},
};

beforeEach(() => providers.clear());

describe("syncFxRates", () => {
  it("stores rates for FX-capable providers and skips the rest", async () => {
    providers.set("kis", baseProvider("kis"));
    providers.set("kiwoom", fxProvider("kiwoom", USD_KRW));
    const { db, binds } = createFakeDb();

    const report = await syncFxRates({ DB: db } as unknown as Env);

    expect(report.date).toBe(kstDate());
    expect(report.rates).toEqual([
      { provider: "kiwoom", base: "USD", quote: "KRW", rate: 1524.5 },
    ]);
    expect(report.errors).toEqual([]);
    expect(binds).toHaveLength(1);
    expect(binds[0]?.slice(0, 4)).toEqual(["USD", "KRW", "2026-09-21", 1524.5]);
  });

  it("records a per-provider error and keeps going", async () => {
    providers.set("kiwoom", {
      ...baseProvider("kiwoom"),
      getFxRate: async () => {
        throw new Error("fx down");
      },
    });
    const { db } = createFakeDb();

    const report = await syncFxRates({ DB: db } as unknown as Env);

    expect(report.rates).toEqual([]);
    expect(report.errors).toEqual([{ scope: "fx:kiwoom", message: "fx down", code: undefined }]);
  });

  it("surfaces provider construction errors only when explicitly requested", async () => {
    const { db } = createFakeDb();

    const implicit = await syncFxRates({ DB: db } as unknown as Env);
    expect(implicit.errors).toEqual([]);

    const explicit = await syncFxRates({ DB: db } as unknown as Env, { provider: "kiwoom" });
    expect(explicit.errors[0]).toMatchObject({ scope: "provider:kiwoom" });
  });
});
