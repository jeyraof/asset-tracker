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
  const statements: { sql: string; args: unknown[] }[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        statements.push({ sql, args });
        return { run: async () => ({}) };
      },
    }),
    batch: async () => [],
  } as unknown as D1Database;
  return { db, statements };
}

function bySql(statements: { sql: string; args: unknown[] }[], needle: string) {
  return statements.filter((statement) => statement.sql.includes(needle));
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
  it("records the run, the rate, and reports the quote date", async () => {
    sources.set("koreaexim", fakeSource("koreaexim", USD_KRW));
    const { db, statements } = createFakeDb();

    const report = await syncFxRates({ DB: db } as unknown as Env);

    expect(report.date).toBe(kstDate());
    expect(report.status).toBe("success");
    expect(report.rates).toEqual([
      { source: "koreaexim", base: "USD", quote: "KRW", rate: 1385.5, date: "2026-09-23" },
    ]);
    expect(report.errors).toEqual([]);

    const start = bySql(statements, "INSERT INTO sync_runs");
    expect(start[0]?.args).toEqual([report.runId, "koreaexim", "cron", "fx"]);

    const rate = bySql(statements, "INSERT INTO fx_rates");
    expect(rate[0]?.args.slice(0, 4)).toEqual(["USD", "KRW", "2026-09-23", 1385.5]);

    const finish = bySql(statements, "UPDATE sync_runs");
    expect(finish[0]?.args[0]).toBe("success");
    expect(finish[0]?.args[2]).toBe(report.runId);
  });

  it("uses the given origin as the run source", async () => {
    sources.set("koreaexim", fakeSource("koreaexim", USD_KRW));
    const { db, statements } = createFakeDb();

    await syncFxRates({ DB: db } as unknown as Env, { source: "http" });

    expect(bySql(statements, "INSERT INTO sync_runs")[0]?.args[2]).toBe("http");
  });

  it("reports a null rate as success with no rate row", async () => {
    sources.set("koreaexim", fakeSource("koreaexim", null));
    const { db, statements } = createFakeDb();

    const report = await syncFxRates({ DB: db } as unknown as Env);

    expect(report.rates).toEqual([
      { source: "koreaexim", base: "USD", quote: "KRW", rate: null, date: null },
    ]);
    expect(report.errors).toEqual([]);
    expect(report.status).toBe("success");
    expect(bySql(statements, "INSERT INTO fx_rates")).toHaveLength(0);
  });

  it("records a source error, persists it, and fails the run", async () => {
    sources.set("koreaexim", {
      id: "koreaexim",
      getFxRate: async () => {
        throw new Error("fx down");
      },
    });
    const { db, statements } = createFakeDb();

    const report = await syncFxRates({ DB: db } as unknown as Env);

    expect(report.rates).toEqual([]);
    expect(report.errors).toEqual([{ scope: "fx:koreaexim", message: "fx down" }]);
    expect(report.status).toBe("failed");
    expect(bySql(statements, "UPDATE sync_runs")[0]?.args[0]).toBe("failed");
    expect(bySql(statements, "INSERT INTO sync_errors")).toHaveLength(1);
  });

  it("surfaces source construction errors only when explicitly requested", async () => {
    const { db } = createFakeDb();

    const implicit = await syncFxRates({ DB: db } as unknown as Env, { fxSource: undefined });
    expect(implicit.errors).toEqual([]);

    const explicit = await syncFxRates({ DB: db } as unknown as Env, { fxSource: "koreaexim" });
    expect(explicit.errors[0]).toMatchObject({ scope: "source:koreaexim" });
  });
});
