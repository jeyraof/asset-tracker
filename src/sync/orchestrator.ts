import type { Env } from "../env";
import type {
  AccountConfig,
  BrokerProvider,
  InstrumentRef,
  QuoteFetchResult,
} from "../domain/types";
import { getProvider, quoteProviderPriority } from "../providers/registry";
import * as repo from "../db/repo";
import { kstDate } from "../lib/dates";
import { describeError, errorText } from "../lib/errors";
import { logger } from "../lib/logger";
import { takeRetries } from "../lib/retryPolicy";
import { syncBalance } from "./balances";
import { syncTrades } from "./trades";
import { syncQuotes } from "./quotes";
import { resolveQuoteCandidates, type QuoteAssignment } from "./quoteSources";

export interface SyncOptions {
  /** Snapshot date (YYYY-MM-DD, KST). Defaults to today in KST. */
  date?: string;
  /** Trade lookback window in days (inclusive). Defaults to 7. */
  lookbackDays?: number;
  /** Restrict to a single provider id, e.g. "kis". */
  provider?: string;
  /** Restrict to account products (`meta.product`, default "stock"), e.g. ["us"]. */
  products?: readonly string[];
  /** Run origin: "cron" | "http" | "backfill". */
  source?: string;
}

export interface AccountSyncResult {
  accountId: number;
  provider: string;
  externalId: string;
  holdings: number;
  trades: number;
}

export interface ProviderQuoteResult {
  provider: string;
  instruments: number;
  quotes: number;
}

export interface SyncError {
  scope: string;
  message: string;
  code?: string;
  provider?: string;
  externalId?: string;
  market?: string;
  symbol?: string;
  status?: number;
  attempts?: number;
  path?: string;
}

export interface SyncReport {
  runId: string;
  date: string;
  lookbackDays: number;
  status: "success" | "partial" | "failed";
  accounts: AccountSyncResult[];
  quotes: ProviderQuoteResult[];
  errors: SyncError[];
  /** Retry attempts observed during the run (approximate under concurrency). */
  retries: number;
  /** Symbols whose quotes could not be fetched from any candidate provider. */
  failedSymbols: string[];
  durationMs: number;
}

const DEFAULT_LOOKBACK_DAYS = 7;

/**
 * Whether to sync quantity-changing trades for an account. Providers set
 * `meta.trades = false` for accounts that cannot use the trade endpoint
 * (e.g. KIS retirement-pension accounts), so the run stays successful.
 */
export function tradesEnabled(account: AccountConfig): boolean {
  return account.meta?.["trades"] !== false;
}

/**
 * An account's product (`meta.product`), defaulting to "stock". Drives which
 * scheduled run picks up the account (e.g. US accounts run after the US close).
 */
export function productOf(account: Pick<AccountConfig, "meta">): string {
  const value = account.meta?.["product"];
  return typeof value === "string" && value !== "" ? value : "stock";
}

/**
 * Provider-agnostic sync: balance + holdings snapshot, quantity-changing
 * trades, and daily OHLC quotes for every held instrument.
 */
export async function runSync(env: Env, options: SyncOptions = {}): Promise<SyncReport> {
  const startedAt = Date.now();
  const date = options.date ?? kstDate();
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const source = options.source ?? "cron";
  const runId = crypto.randomUUID();

  takeRetries();

  await repo.startSyncRun(env.DB, { runId, provider: options.provider ?? null, source });

  const report: SyncReport = {
    runId,
    date,
    lookbackDays,
    status: "success",
    accounts: [],
    quotes: [],
    errors: [],
    retries: 0,
    failedSymbols: [],
    durationMs: 0,
  };

  try {
    let accounts: AccountConfig[];
    try {
      accounts = await repo.listActiveAccounts(env.DB, options.provider);
    } catch (error) {
      report.errors.push({ scope: "accounts", ...describeError(error) });
      logger.error("failed to load accounts", { runId, error: errorText(error) });
      return report;
    }

    if (options.products) {
      const products = new Set(options.products);
      accounts = accounts.filter((account) => products.has(productOf(account)));
    }

    const providerCache = new Map<string, BrokerProvider | null>();
    function providerFor(id: string): BrokerProvider | null {
      if (providerCache.has(id)) return providerCache.get(id) ?? null;
      try {
        const provider = getProvider(id, { env });
        providerCache.set(id, provider);
        return provider;
      } catch (error) {
        const details = describeError(error);
        providerCache.set(id, null);
        report.errors.push({ scope: `provider:${id}`, provider: id, ...details });
        logger.error("provider unavailable", { runId, provider: id, message: details.message, code: details.code });
        return null;
      }
    }

    const instruments = new Map<string, { ref: InstrumentRef; providers: Set<string> }>();

    for (const account of accounts) {
      const scope = `${account.provider}:${account.externalId}`;
      const provider = providerFor(account.provider);
      if (!provider) continue;

      try {
        const balance = await syncBalance(env.DB, provider, account, date);

        for (const holding of balance.holdings) {
          if (!provider.supportsMarket(holding.market)) continue;
          const key = `${holding.market}:${holding.symbol}`;
          const entry = instruments.get(key) ?? {
            ref: { market: holding.market, symbol: holding.symbol },
            providers: new Set<string>(),
          };
          entry.providers.add(account.provider);
          instruments.set(key, entry);
        }

        // Trade history is best-effort: some accounts reject trading APIs even
        // when balance works (e.g. KIS APTR0058), so don't fail the snapshot.
        // Accounts with `meta.trades = false` skip the endpoint entirely.
        let trades = 0;
        if (!tradesEnabled(account)) {
          logger.info("trade sync skipped", { runId, scope });
        } else {
          try {
            trades = (await syncTrades(env.DB, provider, account, date, lookbackDays)).length;
          } catch (error) {
            const details = describeError(error);
            report.errors.push({
              scope: `${scope}:trades`,
              provider: account.provider,
              externalId: account.externalId,
              ...details,
            });
            logger.error("trade sync failed", { runId, scope, message: details.message, code: details.code, status: details.status, attempts: details.attempts });
          }
        }

        report.accounts.push({
          accountId: account.id,
          provider: account.provider,
          externalId: account.externalId,
          holdings: balance.holdings.length,
          trades,
        });
        logger.info("account synced", { runId, scope, holdings: balance.holdings.length, trades });
      } catch (error) {
        const details = describeError(error);
        report.errors.push({
          scope,
          provider: account.provider,
          externalId: account.externalId,
          ...details,
        });
        logger.error("account sync failed", { runId, scope, message: details.message, code: details.code, status: details.status, attempts: details.attempts });
      }
    }

    const available = new Map<string, BrokerProvider>();
    for (const [id, provider] of providerCache) {
      if (provider) available.set(id, provider);
    }

    const assignments = resolveQuoteCandidates(
      instruments.values(),
      available,
      quoteProviderPriority(),
    );
    await syncQuotesWithFallback(env.DB, assignments, available, report, runId, date);

    return report;
  } finally {
    report.status =
      report.errors.length === 0
        ? "success"
        : report.accounts.length + report.quotes.length > 0
          ? "partial"
          : "failed";
    report.retries = takeRetries();
    report.failedSymbols = [
      ...new Set(report.errors.map((error) => error.symbol).filter((s): s is string => Boolean(s))),
    ];
    report.durationMs = Date.now() - startedAt;

    try {
      await persistReport(env, runId, report);
    } catch (error) {
      logger.error("failed to persist sync run", { runId, error: errorText(error) });
    }
    logger.info("sync finished", {
      runId,
      date,
      status: report.status,
      accounts: report.accounts.length,
      errors: report.errors.length,
      retries: report.retries,
      durationMs: report.durationMs,
    });
  }
}

/** Persists the run status, details, and structured error rows in one batch. */
async function persistReport(env: Env, runId: string, report: SyncReport): Promise<void> {
  await repo.finishSyncRun(
    env.DB,
    runId,
    report.status,
    report,
    report.errors.map((error) => ({
      runId,
      scope: error.scope,
      message: error.message,
      provider: error.provider ?? null,
      externalId: error.externalId ?? null,
      market: error.market ?? null,
      symbol: error.symbol ?? null,
      status: error.status ?? null,
      code: error.code ?? null,
      attempts: error.attempts ?? null,
      path: error.path ?? null,
    })),
  );
}

/**
 * Fetches quotes once per instrument, batching by chosen provider, and retries
 * a failed instrument against its next candidate so a broker outage never drops
 * an instrument another broker could price.
 */
export async function syncQuotesWithFallback(
  db: D1Database,
  assignments: readonly QuoteAssignment[],
  available: ReadonlyMap<string, BrokerProvider>,
  report: SyncReport,
  runId: string,
  date: string,
): Promise<void> {
  const assignmentByKey = new Map<string, QuoteAssignment>();
  const remaining = new Map<string, number>();
  let pending = new Map<string, InstrumentRef[]>();

  for (const assignment of assignments) {
    const primary = assignment.candidates[0];
    if (!primary) continue;
    const key = `${assignment.ref.market}:${assignment.ref.symbol}`;
    assignmentByKey.set(key, assignment);
    remaining.set(key, 0);
    const refs = pending.get(primary) ?? [];
    refs.push(assignment.ref);
    pending.set(primary, refs);
  }

  const synced = new Map<string, { instruments: number; quotes: number }>();
  const maxAttempts = Math.max(1, ...assignments.map((a) => a.candidates.length));

  /** Requeues a failed instrument to its next candidate, else records an error. */
  function requeueOrRecord(
    ref: InstrumentRef,
    providerId: string,
    failure: {
      message: string;
      status?: number;
      code?: string;
      attempts?: number;
      path?: string;
    },
    next: Map<string, InstrumentRef[]>,
  ): void {
    const key = `${ref.market}:${ref.symbol}`;
    const assignment = assignmentByKey.get(key);
    const nextIndex = (remaining.get(key) ?? 0) + 1;
    const fallback = assignment?.candidates[nextIndex];

    if (assignment && fallback) {
      remaining.set(key, nextIndex);
      const fallbackRefs = next.get(fallback) ?? [];
      fallbackRefs.push(ref);
      next.set(fallback, fallbackRefs);
      return;
    }

    report.errors.push({
      scope: `quotes:${providerId}:${ref.symbol}`,
      provider: providerId,
      market: ref.market,
      symbol: ref.symbol,
      ...failure,
    });
    logger.error("quote sync failed", {
      runId,
      provider: providerId,
      symbol: ref.symbol,
      market: ref.market,
      message: failure.message,
      status: failure.status,
      code: failure.code,
      attempts: failure.attempts,
    });
  }

  for (let attempt = 0; attempt < maxAttempts && pending.size > 0; attempt++) {
    const next = new Map<string, InstrumentRef[]>();

    for (const [providerId, refs] of pending) {
      const provider = available.get(providerId);
      if (!provider) continue;

      let result: QuoteFetchResult | undefined;
      let thrown: unknown;
      try {
        result = await syncQuotes(db, provider, refs, date);
      } catch (error) {
        thrown = error;
      }

      if (!result) {
        // A whole-batch failure (e.g. upsert error): requeue every instrument.
        const details = describeError(thrown);
        let requeued = 0;
        for (const ref of refs) {
          const before = report.errors.length;
          requeueOrRecord(ref, providerId, details, next);
          if (report.errors.length === before) requeued += 1;
        }
        if (requeued > 0) {
          logger.warn("quote fallback", { runId, provider: providerId, requeued, message: details.message });
        }
        continue;
      }

      const aggregate = synced.get(providerId) ?? { instruments: 0, quotes: 0 };
      aggregate.instruments += refs.length;
      aggregate.quotes += result.quotes.length;
      synced.set(providerId, aggregate);
      logger.info("quotes synced", {
        runId,
        provider: providerId,
        instruments: refs.length,
        quotes: result.quotes.length,
        failed: result.failures.length,
      });

      let requeued = 0;
      for (const { ref, ...details } of result.failures) {
        const before = report.errors.length;
        requeueOrRecord(ref, providerId, details, next);
        if (report.errors.length === before) requeued += 1;
      }
      if (requeued > 0) {
        logger.warn("quote fallback", { runId, provider: providerId, requeued });
      }
    }

    pending = next;
  }

  const priority = quoteProviderPriority();
  report.quotes.push(
    ...[...synced.entries()]
      .sort((a, b) => priority.indexOf(a[0]) - priority.indexOf(b[0]))
      .map(([provider, value]) => ({ provider, ...value })),
  );
}
