import { describe, expect, it } from "vitest";
import { KisProvider } from "../src/providers/kis";
import { parseKisCredentials } from "../src/providers/kis/credentials";
import type { AccountConfig } from "../src/domain/types";
import { RateLimiter } from "../src/lib/rateLimit";
import { createFakeKv, createFetchMock, jsonResponse } from "./helpers";

const CREDENTIALS = parseKisCredentials(
  JSON.stringify({
    "11111111-01": { appkey: "KEY-A", appsecret: "SECRET-A" },
    "22222222-01": { appkey: "KEY-B", appsecret: "SECRET-B" },
  }),
);

function account(externalId: string): AccountConfig {
  return {
    id: 1,
    provider: "kis",
    env: "prod",
    externalId,
    country: "KR",
    currency: "KRW",
    name: null,
    active: true,
    meta: {},
  };
}

function createProvider() {
  const fake = createFakeKv();
  const mock = createFetchMock((url, init) => {
    if (url.includes("/oauth2/tokenP")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { appkey?: string };
      return jsonResponse({
        access_token: `TOKEN-${body.appkey}`,
        token_type: "Bearer",
        expires_in: 86400,
      });
    }
    if (url.includes("inquire-daily-ccld")) return jsonResponse({ rt_cd: "0", output1: [] });
    return jsonResponse({ rt_cd: "0", output1: [], output2: [] });
  });

  const provider = new KisProvider({
    environment: "prod",
    baseUrl: "https://example.test",
    cache: fake.kv,
    rateLimiter: new RateLimiter(0),
    debug: false,
    credentials: CREDENTIALS,
    fetchImpl: mock.fetchImpl,
  });

  return { provider, mock };
}

describe("KisProvider per-account credentials", () => {
  it("authenticates each account with its own app key", async () => {
    const { provider, mock } = createProvider();

    await provider.getBalance(account("11111111-01"), "2026-09-20");
    await provider.getBalance(account("22222222-01"), "2026-09-20");

    const apiCalls = mock.calls.filter((call) => !call.url.includes("/oauth2/tokenP"));
    expect(apiCalls[0]?.init?.headers).toMatchObject({ appkey: "KEY-A" });
    expect(apiCalls[1]?.init?.headers).toMatchObject({ appkey: "KEY-B" });
    expect(mock.calls.filter((call) => call.url.includes("/oauth2/tokenP"))).toHaveLength(2);
  });

  it("throws when an account has no credentials", async () => {
    const { provider } = createProvider();
    await expect(provider.getBalance(account("99999999-01"), "2026-09-20")).rejects.toThrow(
      /No KIS credentials/,
    );
  });

  it("reuses a valid credential for account-less market data", async () => {
    const { provider, mock } = createProvider();

    await provider.getBalance(account("11111111-01"), "2026-09-20");
    await provider.getDailyQuotes([{ market: "KRX", symbol: "005930" }], "2026-09-20");

    const quoteCall = mock.calls.find((call) => call.url.includes("inquire-daily-itemchartprice"));
    expect(quoteCall?.init?.headers).toMatchObject({ appkey: "KEY-A" });
  });

  it("pins daily quotes to KRX regular session with unadjusted prices", async () => {
    const { provider, mock } = createProvider();

    await provider.getDailyQuotes([{ market: "KRX", symbol: "005930" }], "2026-09-20");

    const call = mock.calls.find((c) => c.url.includes("inquire-daily-itemchartprice"));
    const url = new URL(call?.url ?? "");
    expect(url.searchParams.get("FID_COND_MRKT_DIV_CODE")).toBe("J");
    expect(url.searchParams.get("FID_ORG_ADJ_PRC")).toBe("1");
  });

  it("includes NXT fills when querying trade history", async () => {
    const { provider, mock } = createProvider();

    await provider.getTrades(account("11111111-01"), "2026-09-18", "2026-09-20");

    const call = mock.calls.find((c) => c.url.includes("inquire-daily-ccld"));
    const url = new URL(call?.url ?? "");
    expect(url.searchParams.get("EXCG_ID_DVSN_CD")).toBe("ALL");
  });
});
