import { describe, expect, it } from "vitest";
import {
  parseKiwoomCredentials,
  resolveKiwoomCredentials,
} from "../src/providers/kiwoom/credentials";

describe("parseKiwoomCredentials", () => {
  it("accepts appsecret and secretkey, normalizing keys to digits", () => {
    const map = parseKiwoomCredentials(
      JSON.stringify({
        "12345678": { appkey: "KEY-A", appsecret: "SECRET-A" },
        "87654321": { appkey: "KEY-B", secretkey: "SECRET-B" },
        "00000000": { appkey: "NO-SECRET" },
      }),
    );

    expect(map.size).toBe(2);
    expect(map.get("12345678")).toMatchObject({ appkey: "KEY-A", appsecret: "SECRET-A" });
    expect(map.get("87654321")).toMatchObject({ appkey: "KEY-B", appsecret: "SECRET-B" });
  });

  it("returns an empty map for blank input", () => {
    expect(parseKiwoomCredentials(undefined).size).toBe(0);
    expect(parseKiwoomCredentials("").size).toBe(0);
  });

  it("rejects non-object JSON", () => {
    expect(() => parseKiwoomCredentials("[]")).toThrow(/JSON object/);
  });
});

describe("resolveKiwoomCredentials", () => {
  const map = parseKiwoomCredentials(
    JSON.stringify({ "12345678": { appkey: "KEY-A", appsecret: "SECRET-A" } }),
  );

  it("resolves by externalId", () => {
    expect(resolveKiwoomCredentials(map, { externalId: "12345678", meta: {} })?.appkey).toBe("KEY-A");
  });

  it("resolves by meta.acctNo when the external id differs", () => {
    expect(
      resolveKiwoomCredentials(map, { externalId: "9999999999", meta: { acctNo: "12345678" } })?.appkey,
    ).toBe("KEY-A");
  });

  it("resolves by meta.credKey", () => {
    expect(
      resolveKiwoomCredentials(map, { externalId: "9999999999", meta: { credKey: "12345678" } })?.appkey,
    ).toBe("KEY-A");
  });

  it("returns undefined when nothing matches", () => {
    expect(resolveKiwoomCredentials(map, { externalId: "11111111", meta: {} })).toBeUndefined();
  });
});
