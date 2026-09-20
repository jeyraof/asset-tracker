import { describe, expect, it } from "vitest";
import { credentialId, getAccessToken, tokenCacheKey } from "../src/providers/kis/auth";
import { createFakeKv, createFetchMock, jsonResponse } from "./helpers";

const NOW = Date.parse("2026-09-20T06:30:00Z");

function tokenOptions(kv: KVNamespace, fetchImpl: typeof fetch, appkey = "APPKEY", now = NOW) {
  return {
    baseUrl: "https://openapi.koreainvestment.com:9443",
    appkey,
    appsecret: "APPSECRET",
    env: "prod" as const,
    cache: kv,
    fetchImpl,
    now: () => now,
  };
}

describe("getAccessToken", () => {
  it("issues and caches a token, then reuses the cache", async () => {
    const fake = createFakeKv();
    const mock = createFetchMock(() =>
      jsonResponse({ access_token: "TOKEN-1", token_type: "Bearer", expires_in: 86400 }),
    );

    const first = await getAccessToken(tokenOptions(fake.kv, mock.fetchImpl));
    const second = await getAccessToken(tokenOptions(fake.kv, mock.fetchImpl));

    expect(first).toBe("TOKEN-1");
    expect(second).toBe("TOKEN-1");
    expect(mock.calls).toHaveLength(1);
    expect(fake.store.has(tokenCacheKey("prod", await credentialId("APPKEY")))).toBe(true);
  });

  it("keeps tokens isolated per app key", async () => {
    const fake = createFakeKv();
    const mock = createFetchMock((_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { appkey?: string };
      return jsonResponse({
        access_token: `TOKEN-${body.appkey}`,
        token_type: "Bearer",
        expires_in: 86400,
      });
    });

    const a = await getAccessToken(tokenOptions(fake.kv, mock.fetchImpl, "APPKEY-A"));
    const b = await getAccessToken(tokenOptions(fake.kv, mock.fetchImpl, "APPKEY-B"));
    const aAgain = await getAccessToken(tokenOptions(fake.kv, mock.fetchImpl, "APPKEY-A"));

    expect(a).toBe("TOKEN-APPKEY-A");
    expect(b).toBe("TOKEN-APPKEY-B");
    expect(aAgain).toBe("TOKEN-APPKEY-A");
    expect(mock.calls).toHaveLength(2);
    expect(fake.store.size).toBe(2);

    const keyA = tokenCacheKey("prod", await credentialId("APPKEY-A"));
    const keyB = tokenCacheKey("prod", await credentialId("APPKEY-B"));
    expect(keyA).not.toBe(keyB);
  });

  it("reuses the cached token when issuance is rate limited (EGW00133)", async () => {
    const key = tokenCacheKey("prod", await credentialId("APPKEY"));
    const expiredEntry = JSON.stringify({ accessToken: "STALE", expiresAt: NOW - 1 });
    const fake = createFakeKv({ [key]: expiredEntry });
    const mock = createFetchMock(() =>
      jsonResponse({ msg_cd: "EGW00133", msg1: "접근토큰발급 잠시후 다시 시도하세요", rt_cd: "1" }, {}, 429),
    );

    const token = await getAccessToken(tokenOptions(fake.kv, mock.fetchImpl));
    expect(token).toBe("STALE");
  });
});
