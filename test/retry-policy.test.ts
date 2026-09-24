import { describe, expect, it } from "vitest";
import { isTransientHttp, parseRetryAfter } from "../src/lib/retryPolicy";
import { withRetry } from "../src/lib/rateLimit";

class StatusError extends Error {
  constructor(readonly status: number, message = "error") {
    super(message);
    this.name = "StatusError";
  }
}

describe("retryPolicy", () => {
  it("classifies 429/5xx and network failures as transient", () => {
    expect(isTransientHttp(new StatusError(429))).toBe(true);
    expect(isTransientHttp(new StatusError(500))).toBe(true);
    expect(isTransientHttp(new StatusError(503))).toBe(true);
    expect(isTransientHttp(new StatusError(400))).toBe(false);
    expect(isTransientHttp(new StatusError(404))).toBe(false);
    expect(isTransientHttp(new TypeError("fetch failed"))).toBe(true);

    const aborted = new Error("aborted");
    aborted.name = "AbortError";
    expect(isTransientHttp(aborted)).toBe(true);

    expect(isTransientHttp(new Error("logical error"))).toBe(false);
  });

  it("parses Retry-After delta-seconds and HTTP dates", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("not-a-date")).toBeUndefined();

    const ms = parseRetryAfter(new Date(Date.now() + 5_000).toUTCString());
    expect(ms).toBeDefined();
    expect(ms ?? 0).toBeGreaterThan(0);
    expect(ms ?? 0).toBeLessThanOrEqual(60_000);
  });
});

describe("withRetry", () => {
  it("retries transient errors and reports each attempt", async () => {
    let calls = 0;
    const retried: number[] = [];

    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new StatusError(503);
        return "ok";
      },
      {
        retries: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        shouldRetry: isTransientHttp,
        onRetry: (attempt) => retried.push(attempt),
      },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(retried).toEqual([1, 2]);
  });

  it("does not retry a non-transient error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new StatusError(400);
        },
        { retries: 3, baseDelayMs: 0, maxDelayMs: 0, shouldRetry: isTransientHttp },
      ),
    ).rejects.toBeInstanceOf(StatusError);
    expect(calls).toBe(1);
  });

  it("honors a delayFor override", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new StatusError(429);
        return "ok";
      },
      {
        retries: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        shouldRetry: isTransientHttp,
        delayFor: (_error, _attempt, fallback) => {
          delays.push(fallback + 1);
          return 0;
        },
      },
    );
    expect(delays).toEqual([1]);
  });
});
