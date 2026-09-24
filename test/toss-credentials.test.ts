import { describe, expect, it } from "vitest";
import { parseTossCredentials } from "../src/providers/toss/credentials";

describe("parseTossCredentials", () => {
  it("parses a single client id/secret object", () => {
    expect(
      parseTossCredentials(JSON.stringify({ clientId: "CID", clientSecret: "SEC" })),
    ).toEqual({ clientId: "CID", clientSecret: "SEC" });
  });

  it("returns null for empty input", () => {
    expect(parseTossCredentials(undefined)).toBeNull();
    expect(parseTossCredentials("")).toBeNull();
  });

  it("throws on invalid JSON or a missing field", () => {
    expect(() => parseTossCredentials("not json")).toThrow(/valid JSON/);
    expect(() => parseTossCredentials(JSON.stringify({ clientId: "CID" }))).toThrow(
      /clientId and clientSecret/,
    );
  });
});
