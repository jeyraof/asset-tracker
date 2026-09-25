import type { Env } from "../env";
import type { FxSource } from "../domain/types";
import { getFxSource, listKnownFxSources } from "../fx/registry";
import * as repo from "../db/repo";
import { kstDate } from "../lib/dates";
import { describeError } from "../lib/errors";
import { logger } from "../lib/logger";

export interface FxSyncOptions {
  /** Search-from date (YYYY-MM-DD, KST). Defaults to today in KST. */
  date?: string;
  /** Run origin: "cron" | "http". Defaults to "cron". */
  source?: string;
  /** Restrict to a single FX source id, e.g. "koreaexim". */
  fxSource?: string;
  /** Base currency. Defaults to "USD". */
  base?: string;
  /** Quote currency. Defaults to "KRW". */
  quote?: string;
  /** Explicit run id (defaults to a fresh UUID). */
  runId?: string;
}

export interface FxRateResult {
  source: string;
  base: string;
  quote: string;
  rate: number | null;
  /** Actual quote (business) date the rate applies to; null when unavailable. */
  date: string | null;
}

export interface FxSyncError {
  scope: string;
  message: string;
  code?: string;
  status?: number;
  attempts?: number;
  path?: string;
}

export interface FxSyncReport {
  runId: string;
  /** The date the search started from (YYYY-MM-DD, KST). */
  date: string;
  base: string;
  quote: string;
  status: "success" | "partial" | "failed";
  rates: FxRateResult[];
  errors: FxSyncError[];
  durationMs: number;
}

/**
 * Fetches and stores the reference FX rate. This is a standalone task (recorded
 * in `sync_runs` with `task='fx'`): it needs no holdings, runs on its own cron
 * (and via `POST /sync/fx`), and iterates the market `FxSource`s in `src/fx/`.
 */
export async function syncFxRates(env: Env, options: FxSyncOptions = {}): Promise<FxSyncReport> {
  const startedAt = Date.now();
  const date = options.date ?? kstDate();
  const source = options.source ?? "cron";
  const runId = options.runId ?? crypto.randomUUID();
  const base = options.base ?? "USD";
  const quote = options.quote ?? "KRW";

  const candidateIds = options.fxSource ? [options.fxSource] : listKnownFxSources();
  const provider = options.fxSource ?? listKnownFxSources()[0] ?? null;

  await repo.startSyncRun(env.DB, { runId, provider, source, task: "fx" });

  const report: FxSyncReport = {
    runId,
    date,
    base,
    quote,
    status: "success",
    rates: [],
    errors: [],
    durationMs: 0,
  };

  for (const id of candidateIds) {
    let fxSource: FxSource;
    try {
      fxSource = getFxSource(id, env);
    } catch (error) {
      const details = describeError(error);
      report.errors.push({ scope: `source:${id}`, ...details });
      logger.error("fx source unavailable", { source: id, message: details.message });
      continue;
    }

    try {
      const rate = await fxSource.getFxRate(base, quote, date);
      if (!rate) {
        logger.info("fx rate unavailable", { source: id, base, quote, date });
        report.rates.push({ source: id, base, quote, rate: null, date: null });
        continue;
      }

      await repo.upsertFxRates(env.DB, [rate]);
      report.rates.push({ source: id, base: rate.base, quote: rate.quote, rate: rate.rate, date: rate.date });
      logger.info("fx rate synced", {
        source: id,
        base: rate.base,
        quote: rate.quote,
        rate: rate.rate,
        date: rate.date,
      });
    } catch (error) {
      const details = describeError(error);
      report.errors.push({ scope: `fx:${id}`, ...details });
      logger.error("fx rate sync failed", {
        source: id,
        base,
        quote,
        date,
        message: details.message,
        code: details.code,
        status: details.status,
        attempts: details.attempts,
      });
    }
  }

  report.durationMs = Date.now() - startedAt;
  report.status =
    report.errors.length === 0
      ? "success"
      : report.rates.some((rate) => rate.rate !== null)
        ? "partial"
        : "failed";

  await repo.finishSyncRun(
    env.DB,
    runId,
    report.status,
    report,
    report.errors.map((error) => ({
      runId,
      scope: error.scope,
      message: error.message,
      provider: error.scope.includes(":") ? error.scope.slice(error.scope.indexOf(":") + 1) : null,
      status: error.status ?? null,
      code: error.code ?? null,
      attempts: error.attempts ?? null,
      path: error.path ?? null,
    })),
  );
  logger.info("fx sync finished", {
    runId,
    date,
    status: report.status,
    rates: report.rates.length,
    errors: report.errors.length,
    durationMs: report.durationMs,
  });

  return report;
}
