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
  /** Restrict to a single FX source id, e.g. "koreaexim". */
  source?: string;
  /** Base currency. Defaults to "USD". */
  base?: string;
  /** Quote currency. Defaults to "KRW". */
  quote?: string;
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
  /** The date the search started from (YYYY-MM-DD, KST). */
  date: string;
  base: string;
  quote: string;
  rates: FxRateResult[];
  errors: FxSyncError[];
  durationMs: number;
}

/**
 * Fetches and stores the reference FX rate. This is a standalone task: it needs
 * no holdings, runs on its own cron (and via `POST /sync/fx`), and iterates the
 * market `FxSource`s in `src/fx/`. Sources that cannot be constructed (e.g. a
 * missing API key) are only an error when explicitly requested.
 */
export async function syncFxRates(env: Env, options: FxSyncOptions = {}): Promise<FxSyncReport> {
  const startedAt = Date.now();
  const date = options.date ?? kstDate();
  const base = options.base ?? "USD";
  const quote = options.quote ?? "KRW";

  const report: FxSyncReport = { date, base, quote, rates: [], errors: [], durationMs: 0 };
  const candidateIds = options.source ? [options.source] : listKnownFxSources();

  for (const id of candidateIds) {
    let source: FxSource;
    try {
      source = getFxSource(id, env);
    } catch (error) {
      const details = describeError(error);
      report.errors.push({ scope: `source:${id}`, ...details });
      logger.error("fx source unavailable", { source: id, message: details.message });
      continue;
    }

    try {
      const rate = await source.getFxRate(base, quote, date);
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
  return report;
}
