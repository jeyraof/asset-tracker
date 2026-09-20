import { describe, expect, it } from "vitest";
import {
  firstCredentials,
  parseKisCredentials,
  resolveKisCredentials,
} from "../src/providers/kis/credentials";

const ACCOUNT = { externalId: "12345678-01", meta: { cano: "12345678", prdtCd: "01" } };

describe("parseKisCredentials", () => {
  it("parses entries keyed by external id, cano, or compact digits", () => {
    const map = parseKisCredentials(
      JSON.stringify({
        "12345678-01": { appkey: "K1", appsecret: "S1" },
        "8765432101": { appkey: "K2", appsecret: "S2" },
      }),
    );

    expect(map.get("1234567801")?.appkey).toBe("K1");
    expect(map.get("8765432101")?.appkey).toBe("K2");
  });

  it("skips entries missing a key or secret", () => {
    const map = parseKisCredentials(
      JSON.stringify({
        "11111111-01": { appkey: "K", appsecret: "S" },
        "22222222-01": { appkey: "", appsecret: "S" },
        "33333333-01": { appkey: "K" },
      }),
    );

    expect(map.size).toBe(1);
  });

  it("returns an empty map for undefined or blank input", () => {
    expect(parseKisCredentials(undefined).size).toBe(0);
    expect(parseKisCredentials("  ").size).toBe(0);
  });

  it("rejects invalid JSON and non-object roots", () => {
    expect(() => parseKisCredentials("not json")).toThrow(/valid JSON/);
    expect(() => parseKisCredentials("[1,2,3]")).toThrow(/JSON object/);
  });
});

describe("resolveKisCredentials", () => {
  const map = parseKisCredentials(
    JSON.stringify({ "12345678-01": { appkey: "K1", appsecret: "S1" } }),
  );

  it("resolves by external id", () => {
    expect(resolveKisCredentials(map, ACCOUNT)?.appkey).toBe("K1");
  });

  it("falls back to the cano when keyed without a product code", () => {
    const canoOnly = parseKisCredentials(
      JSON.stringify({ "12345678": { appkey: "K2", appsecret: "S2" } }),
    );
    expect(resolveKisCredentials(canoOnly, ACCOUNT)?.appkey).toBe("K2");
  });

  it("returns undefined when unmapped and exposes the first credential", () => {
    const unknown = { externalId: "99999999-01", meta: {} };

    expect(resolveKisCredentials(map, unknown)).toBeUndefined();
    expect(firstCredentials(map)?.appkey).toBe("K1");
  });
});
