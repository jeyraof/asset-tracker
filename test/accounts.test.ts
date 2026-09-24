import { describe, expect, it } from "vitest";
import { resolveAccountName } from "../src/lib/accounts";

describe("resolveAccountName", () => {
  it("prefers a non-empty alias", () => {
    expect(
      resolveAccountName({ alias: "연금저축", name: "KIS 12345678-01", externalId: "12345678-01" }),
    ).toBe("연금저축");
  });

  it("falls back to name when alias is missing or blank", () => {
    expect(
      resolveAccountName({ name: "KIS 12345678-01", externalId: "12345678-01" }),
    ).toBe("KIS 12345678-01");
    expect(
      resolveAccountName({ alias: "   ", name: "KIS 12345678-01", externalId: "12345678-01" }),
    ).toBe("KIS 12345678-01");
  });

  it("falls back to externalId when both are missing or blank", () => {
    expect(resolveAccountName({ externalId: "12345678-01" })).toBe("12345678-01");
    expect(
      resolveAccountName({ alias: null, name: "  ", externalId: "12345678-01" }),
    ).toBe("12345678-01");
  });
});
