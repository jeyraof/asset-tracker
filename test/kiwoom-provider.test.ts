import { describe, expect, it } from "vitest";
import { KiwoomProvider } from "../src/providers/kiwoom";
import { parseKiwoomCredentials } from "../src/providers/kiwoom/credentials";
import type { AccountConfig } from "../src/domain/types";
import { RateLimiter } from "../src/lib/rateLimit";
import { createFakeKv, createFetchMock, jsonResponse } from "./helpers";

const CREDENTIALS = parseKiwoomCredentials(
  JSON.stringify({
    "12345678": { appkey: "KEY-A", appsecret: "SECRET-A" },
    "87654321": { appkey: "KEY-B", appsecret: "SECRET-B" },
  }),
);

function account(externalId: string, credKey: string): AccountConfig {
  return {
    id: 1,
    provider: "kiwoom",
    env: "prod",
    externalId,
    country: "KR",
    currency: "KRW",
    name: null,
    active: true,
    meta: { acctNo: externalId, credKey },
  };
}

function goldAccount(externalId: string, credKey: string): AccountConfig {
  return { ...account(externalId, credKey), meta: { acctNo: externalId, credKey, product: "gold" } };
}

function usAccount(externalId: string, credKey: string): AccountConfig {
  return {
    ...account(externalId, credKey),
    externalId: `${externalId}-us`,
    country: "US",
    currency: "USD",
    meta: { acctNo: externalId, credKey, product: "us" },
  };
}

function createProvider(relaySecret?: string) {
  const fake = createFakeKv();
  const mock = createFetchMock((url, init) => {
    if (url.includes("/oauth2/token")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { appkey?: string };
      return jsonResponse({
        token: `TOKEN-${body.appkey}`,
        token_type: "bearer",
        expires_dt: "20991231235959",
        return_code: 0,
      });
    }
    const apiId = (init?.headers as Record<string, string> | undefined)?.["api-id"];
    if (apiId === "kt00018") {
      return jsonResponse({
        return_code: 0,
        tot_pur_amt: "1000",
        tot_evlt_amt: "1100",
        tot_evlt_pl: "100",
        prsm_dpst_aset_amt: "2000",
        acnt_evlt_remn_indv_tot: [
          {
            stk_cd: "A005930",
            stk_nm: "삼성전자",
            rmnd_qty: "10",
            pur_pric: "100",
            cur_prc: "110",
            evlt_amt: "1100",
            evltv_prft: "100",
            prft_rt: "10.0",
            pur_amt: "1000",
          },
        ],
      });
    }
    if (apiId === "kt00001") return jsonResponse({ return_code: 0, entr: "500", d1_entra: "490" });
    if (apiId === "kt00015") {
      return jsonResponse({
        return_code: 0,
        trst_ovrl_trde_prps_array: [
          {
            trde_dt: "20260918",
            trde_no: "000000001",
            io_tp_nm: "매수",
            rmrk_nm: "장내매수",
            stk_cd: "A069500",
            stk_nm: "KODEX 200",
            trde_qty_jwa_cnt: "1",
            trde_unit: "4900",
            trde_amt: "4900",
            proc_tm: "13:05:43",
          },
        ],
      });
    }
    if (apiId === "ka10081") {
      return jsonResponse({
        return_code: 0,
        stk_cd: "005930",
        stk_dt_pole_chart_qry: [
          { cur_prc: "70100", trde_qty: "9263135", dt: "20260919", open_pric: "69800", high_pric: "70500", low_pric: "69600" },
          { cur_prc: "70000", dt: "20260801" },
        ],
      });
    }
    if (apiId === "kt50020") {
      return jsonResponse({
        return_code: 0,
        tot_entr: "000000000008482",
        tot_est_amt: "000000003374425",
        tot_book_amt2: "000000003481900",
        tot_dep_amt: "000000003382407",
        gold_acnt_evlt_prst: [
          {
            stk_cd: "M04020000",
            stk_nm: "금 99.99_1Kg",
            real_qty: "000000000002",
            avg_prc: "000000152385",
            cur_prc: "000000151780",
            est_amt: "000000301569",
            est_lspft: "-00000003201",
            est_ratio: "-1.0503",
            book_amt2: "000000304770",
          },
        ],
      });
    }
    if (apiId === "kt50032") {
      return jsonResponse({
        return_code: 0,
        gold_trde_hist: [
          {
            deal_dt: "20260918",
            deal_no: "000000001",
            rmrk_nm: "금현물매수",
            deal_qty: "000000000000001",
            uv_exrt: "140000",
            deal_amt: "000000000140000",
            proc_time: "13:20:37",
            stk_cd: "M04020000",
            stk_nm: "금 99.99_1Kg",
          },
        ],
      });
    }
    if (apiId === "ka50081") {
      return jsonResponse({
        return_code: 0,
        gds_day_chart_qry: [
          { cur_prc: "195310", acc_trde_qty: "148033", dt: "20260919", open_pric: "193450", high_pric: "195380", low_pric: "193450" },
          { cur_prc: "1", dt: "20260101" },
        ],
      });
    }
    if (apiId === "ust21070") {
      return jsonResponse({
        return_code: 0,
        crnc_code: "USD",
        tot_evlt_amt: "108719.8000",
        tot_prch_amt: "111453.3212",
        tot_pl_amt: "-3283.9512",
        tot_pl_rt: "-2.94",
        result_list: [
          {
            stex_nm: "미국",
            crnc_code: "USD",
            stk_cd: "AAPL",
            frgn_stk_nm: "애플",
            poss_qty: "000000000395",
            frgn_stk_book_uv: "282.1603",
            frgn_stk_book_amt: "111453.3212",
            now_pric: "275.2400",
            evlt_amt: "108719.8000",
            pl_amt: "-3283.9512",
            pl_rt: "-2.94",
            exch_rate: "1524.50",
          },
        ],
      });
    }
    if (apiId === "usa10098") {
      return jsonResponse({
        return_code: 0,
        list: [{ stex_tp: "ND", stk_cd: "AAPL", stk_nm: "엔비디아", mkgb: "NASDAQ" }],
      });
    }
    if (apiId === "usa06012") {
      return jsonResponse({
        return_code: 0,
        result_list: [
          {
            cur_prc: "270.0000",
            open_pric: "268.0000",
            high_pric: "272.0000",
            low_pric: "267.0000",
            acc_trde_qty: "1000000",
            dt: "20260920",
          },
          { cur_prc: "200.0000", dt: "20260101" },
        ],
      });
    }
    if (apiId === "ust21100") {
      return jsonResponse({
        return_code: 0,
        result_list: [
          {
            deal_dt: "20260918",
            deal_kind_nm: "매매",
            rmrk_nm: "매수",
            deal_no: "000000001",
            stk_cd: "BAC",
            stk_nm: "뱅크오브아메리카",
            deal_qty: "20",
            uv_exrt: "54.1300",
            fc_deal_amt: "1082.60",
            crnc_code: "USD",
            proc_time: "08:25:42",
          },
        ],
      });
    }
    if (apiId === "ust31301") {
      return jsonResponse({ return_code: 0, aplc_exrt: "1524.50", exrt_tp_nm: "달러->원화" });
    }
    return jsonResponse({ return_code: 0 });
  });

  const provider = new KiwoomProvider({
    environment: "prod",
    baseUrl: "https://kiwoom-api.example.test",
    cache: fake.kv,
    rateLimiter: new RateLimiter(0),
    relaySecret,
    debug: false,
    credentials: CREDENTIALS,
    fetchImpl: mock.fetchImpl,
  });

  return { provider, mock, fake };
}

function apiCalls(mock: ReturnType<typeof createFetchMock>) {
  return mock.calls.filter((call) => !call.url.includes("/oauth2/token"));
}

describe("KiwoomProvider", () => {
  it("authenticates each account with its own app key", async () => {
    const { provider, mock } = createProvider();

    await provider.getBalance(account("12345678", "12345678"), "2026-09-20");
    await provider.getBalance(account("87654321", "87654321"), "2026-09-20");

    const calls = apiCalls(mock);
    const authHeaders = calls.map((call) => (call.init?.headers as Record<string, string>)["authorization"]);
    expect(authHeaders).toContain("Bearer TOKEN-KEY-A");
    expect(authHeaders).toContain("Bearer TOKEN-KEY-B");
    expect(mock.calls.filter((call) => call.url.includes("/oauth2/token"))).toHaveLength(2);
  });

  it("throws when an account has no credentials", async () => {
    const { provider } = createProvider();
    await expect(
      provider.getBalance(
        { ...account("99999999", "99999999"), meta: {} },
        "2026-09-20",
      ),
    ).rejects.toThrow(/No Kiwoom credentials/);
  });

  it("maps balance and deposit into a normalized snapshot", async () => {
    const { provider } = createProvider();

    const result = await provider.getBalance(account("12345678", "12345678"), "2026-09-20");

    expect(result.date).toBe("2026-09-20");
    expect(result.summary.depositTotal).toBe(500);
    expect(result.summary.totalEvalAmount).toBe(1100);
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({ symbol: "005930", quantity: 10, currentPrice: 110 });
  });

  it("fetches fills over the window in one range call", async () => {
    const { provider, mock } = createProvider();

    const trades = await provider.getTrades(account("12345678", "12345678"), "2026-09-18", "2026-09-20");

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ date: "2026-09-18", symbol: "069500", side: "BUY", quantity: 1 });
    const ids = apiCalls(mock).map((call) => (call.init?.headers as Record<string, string>)["api-id"]);
    expect(ids).toEqual(["kt00015"]);
  });

  it("maps quotes and drops candles outside the lookback window", async () => {
    const { provider } = createProvider();

    const quotes = await provider.getDailyQuotes([{ market: "KRX", symbol: "005930" }], "2026-09-20");

    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ symbol: "005930", date: "2026-09-19", close: 70100 });
  });

  it("sends the relay secret header when configured", async () => {
    const { provider, mock } = createProvider("relay-secret");

    await provider.getBalance(account("12345678", "12345678"), "2026-09-20");

    expect(apiCalls(mock)[0]?.init?.headers).toMatchObject({ "X-Kiwoom-Relay": "relay-secret" });
  });

  it("uses gold endpoints for a gold-spot account", async () => {
    const { provider, mock } = createProvider();

    const result = await provider.getBalance(goldAccount("8765432180", "87654321"), "2026-09-20");

    expect(result.holdings[0]).toMatchObject({ market: "KRX-GOLD", symbol: "M04020000", quantity: 2 });
    const ids = apiCalls(mock).map((call) => (call.init?.headers as Record<string, string>)["api-id"]);
    expect(ids).toContain("kt50020");
    expect(ids).not.toContain("kt00018");
  });

  it("fetches gold fills via kt50032", async () => {
    const { provider, mock } = createProvider();

    const trades = await provider.getTrades(goldAccount("8765432180", "87654321"), "2026-09-18", "2026-09-20");

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ market: "KRX-GOLD", symbol: "M04020000", side: "BUY", quantity: 1 });
    const ids = apiCalls(mock).map((call) => (call.init?.headers as Record<string, string>)["api-id"]);
    expect(ids).toEqual(["kt50032"]);
  });

  it("routes KRX-GOLD quotes to ka50081", async () => {
    const { provider, mock } = createProvider();

    const quotes = await provider.getDailyQuotes([{ market: "KRX-GOLD", symbol: "M04020000" }], "2026-09-20");

    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      market: "KRX-GOLD",
      symbol: "M04020000",
      date: "2026-09-19",
      close: 195310,
      volume: 148033,
    });
    const ids = apiCalls(mock).map((call) => (call.init?.headers as Record<string, string>)["api-id"]);
    expect(ids).toContain("ka50081");
    expect(ids).not.toContain("ka10081");
  });

  it("supports the US market", () => {
    const { provider } = createProvider();
    expect(provider.supportsMarket("US")).toBe(true);
  });

  it("uses US endpoints and pins valuation to the regular close", async () => {
    const { provider, mock } = createProvider();

    const result = await provider.getBalance(usAccount("12345678", "12345678"), "2026-09-20");

    expect(result.summary.currency).toBe("USD");
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]).toMatchObject({
      market: "US",
      symbol: "AAPL",
      productName: "애플",
      currency: "USD",
      quantity: 395,
      avgPrice: 282.1603,
      purchaseAmount: 111453.3212,
      currentPrice: 270,
    });
    expect(result.holdings[0]?.evalAmount).toBeCloseTo(395 * 270, 5);
    expect(result.summary.totalEvalAmount).toBeCloseTo(106650, 5);

    const ids = apiCalls(mock).map((call) => (call.init?.headers as Record<string, string>)["api-id"]);
    expect(ids).toContain("ust21070");
    expect(ids).toContain("usa10098");
    expect(ids).toContain("usa06012");
    expect(ids).not.toContain("kt00018");
  });

  it("fetches US fills via ust21100", async () => {
    const { provider, mock } = createProvider();

    const trades = await provider.getTrades(usAccount("12345678", "12345678"), "2026-09-18", "2026-09-20");

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      date: "2026-09-18",
      externalId: "000000001",
      market: "US",
      symbol: "BAC",
      side: "BUY",
      quantity: 20,
      avgPrice: 54.13,
      amount: 1082.6,
      currency: "USD",
      orderTime: "08:25:42",
    });
    const ids = apiCalls(mock).map((call) => (call.init?.headers as Record<string, string>)["api-id"]);
    expect(ids).toEqual(["ust21100"]);
    const body = JSON.parse(String(apiCalls(mock)[0]?.init?.body));
    expect(body).toMatchObject({ tp: "3", krw_repl_skip_yn: "N" });
  });

  it("routes US quotes to usa06012 after an exchange lookup", async () => {
    const { provider, mock } = createProvider();

    const quotes = await provider.getDailyQuotes([{ market: "US", symbol: "AAPL" }], "2026-09-20");

    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({
      market: "US",
      symbol: "AAPL",
      date: "2026-09-20",
      close: 270,
      volume: 1000000,
      currency: "USD",
      source: "kiwoom-us-daily-chart",
    });
    const ids = apiCalls(mock).map((call) => (call.init?.headers as Record<string, string>)["api-id"]);
    expect(ids).toContain("usa10098");
    expect(ids).toContain("usa06012");
    expect(ids).not.toContain("ka10081");

    const chartCall = apiCalls(mock).find(
      (call) => (call.init?.headers as Record<string, string>)["api-id"] === "usa06012",
    );
    const chartBody = JSON.parse(String(chartCall?.init?.body));
    expect(chartBody).toMatchObject({
      stex_tp: "ND",
      stk_cd: "AAPL",
      strt_dt: "20260920",
      upd_stkpc_tp: "0",
      exrt_appl_tp: "0",
    });
  });

  it("fetches the US FX rate via ust31301", async () => {
    const { provider, mock } = createProvider();

    const rate = await provider.getFxRate("USD", "KRW", "2026-09-21");

    expect(rate).toMatchObject({
      base: "USD",
      quote: "KRW",
      date: "2026-09-21",
      rate: 1524.5,
      provider: "kiwoom",
      source: "kiwoom-us-fx-rate",
    });
    const call = apiCalls(mock).find(
      (entry) => (entry.init?.headers as Record<string, string>)["api-id"] === "ust31301",
    );
    expect(call?.url).toBe("https://kiwoom-api.example.test/api/us/exchange");
    expect(JSON.parse(String(call?.init?.body))).toMatchObject({ exch_tp: "2" });
  });

  it("returns no FX rate for unsupported pairs", async () => {
    const { provider, mock } = createProvider();

    expect(await provider.getFxRate("JPY", "KRW", "2026-09-21")).toBeNull();
    expect(apiCalls(mock)).toHaveLength(0);
  });
});
