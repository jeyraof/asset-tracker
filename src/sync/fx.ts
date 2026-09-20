import type { Env } from "../env";
import type { BrokerProvider } from "../domain/types";
import { getProvider, listKnownProviders } from "../providers/registry";
import * as repo from "../db/repo";
import { kstDate } from "../lib/dates";
import { errorCode, errorText } from "../lib/errors";
import { logger } from "../lib/logger";

export interface FxSyncOptions {
  /** Rate date (YYYY-MM-DD, KST). Defaults to today in KST. */
  date?: string;
  /** Restrict to a single provider id, e.g. "kiwoom". */
  provider?: string;
  /** Base currency. Defaults to "USD". */
  base?: string;
  /** Quote currency. Defaults to "KRW". */
  quote?: string;
  /** Run origin: "cron" | "http". */
  source?: string;
}

export interface FxRateResult {
  provider: string;
  base: string;
  quote: string;
  rate: number | null;
}

export interface FxSyncError {
  scope: string;
  message: string;
  code?: string;
}

export interface FxSyncReport {
  date: string;
  base: string;
  quote: string;
  rates: FxRateResult[];
  errors: FxSyncError[];
  durationMs: number;
}

/**
 * Fetches and stores spot FX rates. This is a standalone task: it needs no
 * holdings, runs independently via `POST /sync/fx`, and is also invoked
 * alongside the US cron. Providers without `getFxRate` are skipped.
 */
export async function syncFxRates(env: Env, options: FxSyncOptions = {}): Promise<FxSyncReport> {
  const startedAt = Date.now();
  const date = options.date ?? kstDate();
  const base = options.base ?? "USD";
  const quote = options.quote ?? "KRW";

  const report: FxSyncReport = { date, base, quote, rates: [], errors: [], durationMs: 0 };
  const candidateIds = options.provider ? [options.provider] : listKnownProviders();

  for (const id of candidateIds) {
    let provider: BrokerProvider;
    try {
      provider = getProvider(id, { env });
    } catch (error) {
      // A provider missing credentials is only an error when explicitly asked for.
      if (options.provider) {
        report.errors.push({ scope: `provider:${id}`, message: errorText(error), code: errorCode(error) });
      }
      continue;
    }

    if (typeof provider.getFxRate !== "function") continue;

    try {
      const rate = await provider.getFxRate(base, quote, date);
      if (!rate) {
        logger.info("fx rate unavailable", { provider: id, base, quote, date });
        report.rates.push({ provider: id, base, quote, rate: null });
        continue;
      }

      await repo.upsertFxRates(env.DB, [rate]);
      report.rates.push({ provider: id, base: rate.base, quote: rate.quote, rate: rate.rate });
      logger.info("fx rate synced", {
        provider: id,
        base: rate.base,
        quote: rate.quote,
        rate: rate.rate,
        date,
      });
    } catch (error) {
      const message = errorText(error);
      report.errors.push({ scope: `fx:${id}`, message, code: errorCode(error) });
      logger.error("fx rate sync failed", { provider: id, base, quote, date, message, code: errorCode(error) });
    }
  }

  report.durationMs = Date.now() - startedAt;
  return report;
}
