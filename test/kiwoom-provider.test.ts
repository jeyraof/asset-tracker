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
});
