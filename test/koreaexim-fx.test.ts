import { describe, expect, it } from "vitest";
import { KOREAEXIM_SOURCE_ID, KoreaEximFxSource } from "../src/fx/koreaexim";
import { createFetchMock, jsonResponse } from "./helpers";

const BASE_URL = "https://oapi.koreaexim.test/site/program/financial/exchangeJSON";

function createSource(handler: Parameters<typeof createFetchMock>[0], lookbackDays = 7) {
  const mock = createFetchMock(handler);
  const source = new KoreaEximFxSource({
    apiKey: "TESTKEY",
    baseUrl: BASE_URL,
    fetchImpl: mock.fetchImpl,
    lookbackDays,
  });
  return { source, mock };
}

const USD_ROW = {
  result: 1,
  cur_unit: "USD",
  deal_bas_r: "1,385.50",
  cur_nm: "미국 달러",
};

describe("KoreaEximFxSource", () => {
  it("maps the USD deal_bas_r and uses the requested date", async () => {
    const { source, mock } = createSource(() => jsonResponse([USD_ROW]));

    const rate = await source.getFxRate("USD", "KRW", "2026-09-24");

    expect(rate).toMatchObject({
      base: "USD",
      quote: "KRW",
      date: "2026-09-24",
      rate: 1385.5,
      provider: KOREAEXIM_SOURCE_ID,
      source: "koreaexim-deal-bas-r",
    });
    const url = new URL(mock.calls[0]?.url ?? "");
    expect(url.searchParams.get("authkey")).toBe("TESTKEY");
    expect(url.searchParams.get("searchdate")).toBe("20260924");
    expect(url.searchParams.get("data")).toBe("AP01");
  });

  it("searches back to the previous business day when a date has no data", async () => {
    const { source, mock } = createSource((_url, _init, callIndex) =>
      callIndex === 0 ? jsonResponse([]) : jsonResponse([USD_ROW]),
    );

    const rate = await source.getFxRate("USD", "KRW", "2026-09-21");

    expect(rate?.date).toBe("2026-09-20");
    expect(mock.calls).toHaveLength(2);
    expect(new URL(mock.calls[1]?.url ?? "").searchParams.get("searchdate")).toBe("20260920");
  });

  it("returns null when no business day within the lookback has data", async () => {
    const { source, mock } = createSource(() => jsonResponse([]), 2);

    expect(await source.getFxRate("USD", "KRW", "2026-09-21")).toBeNull();
    expect(mock.calls).toHaveLength(3);
  });

  it("throws on an auth-key error envelope", async () => {
    const { source } = createSource(() => jsonResponse({ result: 3, result_msg: "인증키 오류" }));

    await expect(source.getFxRate("USD", "KRW", "2026-09-24")).rejects.toThrow(/auth key/);
  });

  it("returns null for unsupported currency pairs without fetching", async () => {
    const { source, mock } = createSource(() => jsonResponse([USD_ROW]));

    expect(await source.getFxRate("JPY", "KRW", "2026-09-24")).toBeNull();
    expect(mock.calls).toHaveLength(0);
  });
});
