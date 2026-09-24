import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { FxRate, FxSource } from "../src/domain/types";

const { sources } = vi.hoisted(() => ({ sources: new Map<string, FxSource>() }));

vi.mock("../src/fx/registry", () => ({
  listKnownFxSources: () => [...sources.keys()],
  getFxSource: (id: string) => {
    const source = sources.get(id);
    if (!source) throw new Error(`no fake source for ${id}`);
    return source;
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

function fakeSource(id: string, rate: FxRate | null): FxSource {
  return { id, getFxRate: async () => rate };
}

const USD_KRW: FxRate = {
  base: "USD",
  quote: "KRW",
  date: "2026-09-23",
  rate: 1385.5,
  provider: "koreaexim",
  source: "koreaexim-deal-bas-r",
  raw: {},
};

beforeEach(() => sources.clear());

describe("syncFxRates", () => {
  it("stores the rate and reports the source's quote date", async () => {
    sources.set("koreaexim", fakeSource("koreaexim", USD_KRW));
    const { db, binds } = createFakeDb();

    const report = await syncFxRates({ DB: db } as unknown as Env);

    expect(report.date).toBe(kstDate());
    expect(report.rates).toEqual([
      { source: "koreaexim", base: "USD", quote: "KRW", rate: 1385.5, date: "2026-09-23" },
    ]);
    expect(report.errors).toEqual([]);
    expect(binds).toHaveLength(1);
    expect(binds[0]?.slice(0, 4)).toEqual(["USD", "KRW", "2026-09-23", 1385.5]);
  });

  it("reports a null rate when the source has no data", async () => {
    sources.set("koreaexim", fakeSource("koreaexim", null));
    const { db, binds } = createFakeDb();

    const report = await syncFxRates({ DB: db } as unknown as Env);

    expect(report.rates).toEqual([
      { source: "koreaexim", base: "USD", quote: "KRW", rate: null, date: null },
    ]);
    expect(report.errors).toEqual([]);
    expect(binds).toHaveLength(0);
  });

  it("records a source error and keeps going", async () => {
    sources.set("koreaexim", {
      id: "koreaexim",
      getFxRate: async () => {
        throw new Error("fx down");
      },
    });
    const { db } = createFakeDb();

    const report = await syncFxRates({ DB: db } as unknown as Env);

    expect(report.rates).toEqual([]);
    expect(report.errors).toEqual([{ scope: "fx:koreaexim", message: "fx down" }]);
  });

  it("surfaces source construction errors only when explicitly requested", async () => {
    const { db } = createFakeDb();

    const implicit = await syncFxRates({ DB: db } as unknown as Env);
    expect(implicit.errors).toEqual([]);

    const explicit = await syncFxRates({ DB: db } as unknown as Env, { source: "koreaexim" });
    expect(explicit.errors[0]).toMatchObject({ scope: "source:koreaexim" });
  });
});
