import { describe, expect, it } from "vitest";
import { TossClient } from "../src/providers/toss/client";
import { RateLimiter } from "../src/lib/rateLimit";
import { createFakeKv, createFetchMock, jsonResponse } from "./helpers";

const TOKEN = { access_token: "TOKEN", token_type: "bearer", expires_in: 3600 };

function createClient(handler: Parameters<typeof createFetchMock>[0]) {
  const fake = createFakeKv();
  const mock = createFetchMock(handler);
  const client = new TossClient({
    baseUrl: "https://toss.test",
    clientId: "CID",
    clientSecret: "SEC",
    env: "prod",
    cache: fake.kv,
    rateLimiter: new RateLimiter(0),
    relaySecret: "relay",
    fetchImpl: mock.fetchImpl,
  });
  return { client, mock };
}

describe("TossClient", () => {
  it("sends bearer/account/relay headers and unwraps { result }", async () => {
    const { client, mock } = createClient((url) => {
      if (url.includes("/oauth2/token")) return jsonResponse(TOKEN);
      return jsonResponse({ result: { ok: true } });
    });

    const result = await client.request<{ ok: boolean }>("GET", "/api/v1/accounts", {
      accountSeq: 7,
    });

    expect(result).toEqual({ ok: true });
    const call = mock.calls.find((entry) => entry.url.includes("/api/v1/accounts"));
    expect(call?.init?.headers).toMatchObject({
      authorization: "Bearer TOKEN",
      "X-Tossinvest-Account": "7",
      "X-Toss-Relay": "relay",
    });
  });

  it("maps an error envelope to a TossApiError", async () => {
    const { client } = createClient((url) =>
      url.includes("/oauth2/token")
        ? jsonResponse(TOKEN)
        : jsonResponse({ error: { code: "account-not-found", message: "no acct" } }, {}, 404),
    );

    await expect(client.request("GET", "/api/v1/holdings", { accountSeq: 1 })).rejects.toMatchObject(
      { name: "TossApiError", code: "account-not-found", status: 404 },
    );
  });

  it("retries a 429 and then succeeds", async () => {
    let dataCalls = 0;
    const { client } = createClient((url) => {
      if (url.includes("/oauth2/token")) return jsonResponse(TOKEN);
      dataCalls += 1;
      if (dataCalls === 1) {
        return jsonResponse(
          { error: { code: "rate-limit-exceeded", message: "slow" } },
          { "retry-after": "0" },
          429,
        );
      }
      return jsonResponse({ result: { ok: true } });
    });

    const result = await client.request("GET", "/api/v1/accounts");

    expect(dataCalls).toBe(2);
    expect(result).toEqual({ ok: true });
  });

  it("re-issues the token once on a token error", async () => {
    let dataCalls = 0;
    let tokenCalls = 0;
    const { client } = createClient((url) => {
      if (url.includes("/oauth2/token")) {
        tokenCalls += 1;
        return jsonResponse({ ...TOKEN, access_token: `T${tokenCalls}` });
      }
      dataCalls += 1;
      if (dataCalls === 1) {
        return jsonResponse({ error: { code: "token-revoked", message: "stale" } }, {}, 401);
      }
      return jsonResponse({ result: { ok: true } });
    });

    const result = await client.request("GET", "/api/v1/accounts");

    expect(result).toEqual({ ok: true });
    expect(tokenCalls).toBe(2);
  });
});
