import { describe, expect, it } from "vitest";
import {
  addDays,
  fromCompactDate,
  isValidDateString,
  kstDate,
  toCompactDate,
} from "../src/lib/dates";

describe("kstDate", () => {
  it("keeps the same date just before KST midnight", () => {
    expect(kstDate(new Date("2026-01-01T14:59:59Z"))).toBe("2026-01-01");
  });

  it("rolls over at 15:00 UTC (KST midnight)", () => {
    expect(kstDate(new Date("2026-01-01T15:00:00Z"))).toBe("2026-01-02");
  });
});

describe("date conversion", () => {
  it("converts between dashed and compact dates", () => {
    expect(toCompactDate("2026-09-20")).toBe("20260920");
    expect(fromCompactDate("20260920")).toBe("2026-09-20");
  });

  it("adds days across month boundaries", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("validates date strings", () => {
    expect(isValidDateString("2026-09-20")).toBe(true);
    expect(isValidDateString("2026-02-30")).toBe(false);
    expect(isValidDateString("20-09-2026")).toBe(false);
  });
});
