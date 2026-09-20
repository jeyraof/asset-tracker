import { describe, expect, it } from "vitest";
import {
  getKiwoomAccessToken,
  invalidateKiwoomToken,
  kiwoomCredentialId,
  kiwoomTokenCacheKey,
  parseKiwoomExpiry,
} from "../src/providers/kiwoom/auth";
import { createFakeKv, createFetchMock, jsonResponse } from "./helpers";

const NOW = Date.parse("2026-09-20T06:30:00Z");

function tokenOptions(
  kv: KVNamespace,
  fetchImpl: typeof fetch,
  appkey = "APPKEY",
  relaySecret?: string,
) {
  return {
    baseUrl: "https://kiwoom-api.example.test",
    appkey,
    appsecret: "APPSECRET",
    env: "prod" as const,
    cache: kv,
    relaySecret,
    fetchImpl,
    now: () => NOW,
  };
}

describe("parseKiwoomExpiry", () => {
  it("parses KST YYYYMMDDHHMMSS into epoch millis", () => {
    expect(parseKiwoomExpiry("20260920153000", 0)).toBe(Date.parse("2026-09-20T06:30:00Z"));
  });

  it("falls back to 24h when the value is malformed", () => {
    expect(parseKiwoomExpiry(undefined, NOW)).toBe(NOW + 86_400_000);
  });
});

describe("getKiwoomAccessToken", () => {
  it("issues and caches a token, then reuses the cache", async () => {
    const fake = createFakeKv();
    const mock = createFetchMock(() =>
      jsonResponse({ token: "TOKEN-1", token_type: "bearer", expires_dt: "20260921153000", return_code: 0 }),
    );

    const first = await getKiwoomAccessToken(tokenOptions(fake.kv, mock.fetchImpl));
    const second = await getKiwoomAccessToken(tokenOptions(fake.kv, mock.fetchImpl));

    expect(first).toBe("TOKEN-1");
    expect(second).toBe("TOKEN-1");
    expect(mock.calls).toHaveLength(1);
    expect(fake.store.has(kiwoomTokenCacheKey("prod", await kiwoomCredentialId("APPKEY")))).toBe(true);
  });

  it("sends the secretkey field and the relay header", async () => {
    const fake = createFakeKv();
    const mock = createFetchMock(() =>
      jsonResponse({ token: "TOKEN-1", expires_dt: "20260921153000", return_code: 0 }),
    );

    await getKiwoomAccessToken(tokenOptions(fake.kv, mock.fetchImpl, "APPKEY", "relay-secret"));

    const body = JSON.parse(String(mock.calls[0]?.init?.body)) as Record<string, string>;
    expect(body).toMatchObject({
      grant_type: "client_credentials",
      appkey: "APPKEY",
      secretkey: "APPSECRET",
    });
    expect(mock.calls[0]?.init?.headers).toMatchObject({ "X-Kiwoom-Relay": "relay-secret" });
  });

  it("keeps tokens isolated per app key", async () => {
    const fake = createFakeKv();
    const mock = createFetchMock((_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { appkey?: string };
      return jsonResponse({ token: `TOKEN-${body.appkey}`, expires_dt: "20260921153000", return_code: 0 });
    });

    const a = await getKiwoomAccessToken(tokenOptions(fake.kv, mock.fetchImpl, "APPKEY-A"));
    const b = await getKiwoomAccessToken(tokenOptions(fake.kv, mock.fetchImpl, "APPKEY-B"));
    const aAgain = await getKiwoomAccessToken(tokenOptions(fake.kv, mock.fetchImpl, "APPKEY-A"));

    expect(a).toBe("TOKEN-APPKEY-A");
    expect(b).toBe("TOKEN-APPKEY-B");
    expect(aAgain).toBe("TOKEN-APPKEY-A");
    expect(mock.calls).toHaveLength(2);
  });

  it("invalidates a cached token", async () => {
    const fake = createFakeKv();
    const mock = createFetchMock(() =>
      jsonResponse({ token: "TOKEN-1", expires_dt: "20260921153000", return_code: 0 }),
    );

    await getKiwoomAccessToken(tokenOptions(fake.kv, mock.fetchImpl));
    await invalidateKiwoomToken(fake.kv, "prod", "APPKEY");
    await getKiwoomAccessToken(tokenOptions(fake.kv, mock.fetchImpl));

    expect(mock.calls).toHaveLength(2);
  });
});
