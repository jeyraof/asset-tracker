import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

interface TaskHealthRow {
  task: string;
  latest_status: string;
  latest_success_at: string | null;
}

/** Formats an epoch (ms) as a SQLite `datetime('now')` value. */
function sqliteUtc(base: number): string {
  return new Date(base).toISOString().slice(0, 19).replace("T", " ");
}

function createEnv(options: { latest: Record<string, unknown> | null; health: TaskHealthRow[] }): Env {
  const db = {
    prepare: () => ({
      first: async () => options.latest,
      all: async () => ({ results: options.health }),
    }),
  } as unknown as D1Database;
  return { DB: db } as unknown as Env;
}

async function health(env: Env) {
  const response = await worker.fetch(new Request("https://example.test/health"), env);
  const body = (await response.json()) as { ok: boolean; lastSuccessfulAt: string | null };
  return { status: response.status, body };
}

function run(status: string) {
  return {
    run_id: "run-1",
    provider: null,
    source: "cron",
    task: "sync",
    status,
    started_at: "2026-09-25 11:30:00",
    finished_at: "2026-09-25 11:30:10",
    details_json: JSON.stringify({ errors: [], failedSymbols: [] }),
  };
}

describe("/health", () => {
  it("is healthy before any run", async () => {
    const result = await health(createEnv({ latest: null, health: [] }));
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("tolerates a non-success run when a recent success exists", async () => {
    const env = createEnv({
      latest: run("partial"),
      health: [
        {
          task: "sync",
          latest_status: "partial",
          latest_success_at: sqliteUtc(Date.now() - 60 * 60 * 1000),
        },
      ],
    });
    const result = await health(env);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.lastSuccessfulAt).not.toBeNull();
  });

  it("is unhealthy when a task failed with no success", async () => {
    const env = createEnv({
      latest: run("failed"),
      health: [{ task: "sync", latest_status: "failed", latest_success_at: null }],
    });
    const result = await health(env);
    expect(result.status).toBe(503);
    expect(result.body.ok).toBe(false);
  });

  it("is unhealthy when the last success is older than the window", async () => {
    const env = createEnv({
      latest: run("failed"),
      health: [
        {
          task: "sync",
          latest_status: "failed",
          latest_success_at: sqliteUtc(Date.now() - 48 * 60 * 60 * 1000),
        },
      ],
    });
    const result = await health(env);
    expect(result.status).toBe(503);
  });

  it("requires every task to be healthy", async () => {
    const env = createEnv({
      latest: run("success"),
      health: [
        {
          task: "sync",
          latest_status: "success",
          latest_success_at: sqliteUtc(Date.now() - 60 * 60 * 1000),
        },
        { task: "fx", latest_status: "failed", latest_success_at: null },
      ],
    });
    const result = await health(env);
    expect(result.status).toBe(503);
  });
});
