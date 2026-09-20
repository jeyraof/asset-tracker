import { describe, expect, it } from "vitest";
import { chunk, num, str } from "../src/lib/parse";

describe("num", () => {
  it("parses KIS numeric strings with commas", () => {
    expect(num("1,234,567")).toBe(1234567);
    expect(num("0.5")).toBe(0.5);
  });

  it("returns null for empty or invalid values", () => {
    expect(num("")).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num("-")).toBeNull();
  });
});

describe("str", () => {
  it("trims and nullifies blanks", () => {
    expect(str("  005930 ")).toBe("005930");
    expect(str("   ")).toBeNull();
    expect(str(null)).toBeNull();
  });
});

describe("chunk", () => {
  it("splits arrays into fixed-size groups", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});
