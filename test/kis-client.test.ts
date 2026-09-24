import { describe, expect, it } from "vitest";
import { KisClient } from "../src/providers/kis/client";
import { KisApiError } from "../src/providers/kis/errors";
import { RateLimiter } from "../src/lib/rateLimit";
import { createFakeKv, createFetchMock, jsonResponse } from "./helpers";

function createClient(handler: Parameters<typeof createFetchMock>[0]) {
  const fake = createFakeKv();
  const mock = createFetchMock(handler);
  const client = new KisClient({
    baseUrl: "https://openapi.koreainvestment.com:9443",
    appkey: "APPKEY",
    appsecret: "APPSECRET",
    env: "prod",
    cache: fake.kv,
    rateLimiter: new RateLimiter(0),
    fetchImpl: mock.fetchImpl,
  });
  return { client, mock };
}

const TOKEN_BODY = { access_token: "TOKEN", token_type: "Bearer", expires_in: 86400 };

describe("KisClient", () => {
  it("throws KisApiError when rt_cd is not 0", async () => {
    const { client } = createClient((url) => {
      if (url.includes("/oauth2/tokenP")) return jsonResponse(TOKEN_BODY);
      return jsonResponse({ rt_cd: "1", msg_cd: "EGW00000", msg1: "boom" });
    });

    await expect(client.get("/uapi/x", "TTTC0000R", {})).rejects.toMatchObject({
      name: "KisApiError",
      msgCd: "EGW00000",
      rtCd: "1",
    });
  });

  it("paginates using tr_cont and context-area params", async () => {
    const { client, mock } = createClient((url, init, callIndex) => {
      if (url.includes("/oauth2/tokenP")) return jsonResponse(TOKEN_BODY);
      if (callIndex === 1) {
        return jsonResponse(
          { rt_cd: "0", output1: [{ pdno: "005930" }], ctx_area_fk100: "FK1", ctx_area_nk100: "NK1" },
          { tr_cont: "M" },
        );
      }
      return jsonResponse(
        { rt_cd: "0", output1: [{ pdno: "000660" }], ctx_area_fk100: "", ctx_area_nk100: "" },
        { tr_cont: "D" },
      );
    });

    const symbols: string[] = [];
    for await (const page of client.paginate<{ output1?: { pdno?: string }[] }>(
      "/uapi/domestic-stock/v1/trading/inquire-balance",
      "TTTC8434R",
      { CANO: "12345678", ACNT_PRDT_CD: "01" },
    )) {
      for (const row of page.output1 ?? []) symbols.push(row.pdno ?? "");
    }

    expect(symbols).toEqual(["005930", "000660"]);
    const apiCalls = mock.calls.filter((call) => !call.url.includes("/oauth2/tokenP"));
    expect(apiCalls).toHaveLength(2);
    expect(apiCalls[1]?.url).toContain("CTX_AREA_FK100=FK1");
    expect(apiCalls[1]?.init?.headers).toMatchObject({ tr_cont: "N" });
    expect(apiCalls[0]?.thisArg).toBeUndefined();
  });

  it("wraps non-JSON responses in a KisApiError", async () => {
    const { client } = createClient((url) => {
      if (url.includes("/oauth2/tokenP")) return jsonResponse(TOKEN_BODY);
      return new Response("<html>bad gateway</html>", { status: 502 });
    });

    await expect(client.get("/uapi/x", "TTTC0000R", {})).rejects.toBeInstanceOf(KisApiError);
  });

  it("treats a 5xx JSON body without rt_cd as an error", async () => {
    const { client } = createClient((url) => {
      if (url.includes("/oauth2/tokenP")) return jsonResponse(TOKEN_BODY);
      return jsonResponse({ msg1: "bad gateway" }, {}, 502);
    });

    await expect(client.get("/uapi/x", "TTTC0000R", {})).rejects.toMatchObject({
      name: "KisApiError",
      status: 502,
    });
  });

  it("treats a 5xx with rt_cd 0 as an error", async () => {
    const { client } = createClient((url) => {
      if (url.includes("/oauth2/tokenP")) return jsonResponse(TOKEN_BODY);
      return jsonResponse({ rt_cd: "0" }, {}, 500);
    });

    await expect(client.get("/uapi/x", "TTTC0000R", {})).rejects.toMatchObject({
      name: "KisApiError",
      status: 500,
    });
  });

  it("retries a transient 5xx and then succeeds", async () => {
    let apiCalls = 0;
    const { client } = createClient((url) => {
      if (url.includes("/oauth2/tokenP")) return jsonResponse(TOKEN_BODY);
      apiCalls += 1;
      if (apiCalls === 1) return new Response("<html>bad gateway</html>", { status: 503 });
      return jsonResponse({ rt_cd: "0", output1: [] });
    });

    const result = await client.get<{ rt_cd?: string }>("/uapi/x", "TTTC0000R", {});

    expect(apiCalls).toBe(2);
    expect(result.body.rt_cd).toBe("0");
  });
});
