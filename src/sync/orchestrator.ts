import type { Env } from "../env";
import type { AccountConfig, BrokerProvider, InstrumentRef } from "../domain/types";
import { getProvider, quoteProviderPriority } from "../providers/registry";
import * as repo from "../db/repo";
import { kstDate } from "../lib/dates";
import { errorCode, errorText } from "../lib/errors";
import { logger } from "../lib/logger";
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
}

export interface SyncReport {
  runId: string;
  date: string;
  lookbackDays: number;
  status: "success" | "partial" | "failed";
  accounts: AccountSyncResult[];
  quotes: ProviderQuoteResult[];
  errors: SyncError[];
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

  await repo.startSyncRun(env.DB, { runId, provider: options.provider ?? null, source });

  const report: SyncReport = {
    runId,
    date,
    lookbackDays,
    status: "success",
    accounts: [],
    quotes: [],
    errors: [],
    durationMs: 0,
  };

  let accounts: AccountConfig[];
  try {
    accounts = await repo.listActiveAccounts(env.DB, options.provider);
  } catch (error) {
    report.errors.push({ scope: "accounts", message: errorText(error), code: errorCode(error) });
    report.status = "failed";
    report.durationMs = Date.now() - startedAt;
    await repo.finishSyncRun(env.DB, runId, report.status, report);
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
      const message = errorText(error);
      providerCache.set(id, null);
      report.errors.push({ scope: `provider:${id}`, message, code: errorCode(error) });
      logger.error("provider unavailable", { runId, provider: id, message, code: errorCode(error) });
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
          const message = errorText(error);
          report.errors.push({ scope: `${scope}:trades`, message, code: errorCode(error) });
          logger.error("trade sync failed", { runId, scope, message, code: errorCode(error) });
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
      const message = errorText(error);
      report.errors.push({ scope, message, code: errorCode(error) });
      logger.error("account sync failed", { runId, scope, message, code: errorCode(error) });
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

  report.status =
    report.errors.length === 0
      ? "success"
      : report.accounts.length + report.quotes.length > 0
        ? "partial"
        : "failed";
  report.durationMs = Date.now() - startedAt;

  await repo.finishSyncRun(env.DB, runId, report.status, report);
  logger.info("sync finished", {
    runId,
    date,
    status: report.status,
    accounts: report.accounts.length,
    errors: report.errors.length,
    durationMs: report.durationMs,
  });

  return report;
}

/**
 * Fetches quotes once per instrument, batching by chosen provider, and retries
 * the instruments of a failed provider against its next candidate so a broker
 * outage never drops an instrument another broker could price.
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

  for (let attempt = 0; attempt < maxAttempts && pending.size > 0; attempt++) {
    const next = new Map<string, InstrumentRef[]>();

    for (const [providerId, refs] of pending) {
      const provider = available.get(providerId);
      if (!provider) continue;

      try {
        const quotes = await syncQuotes(db, provider, refs, date);
        const aggregate = synced.get(providerId) ?? { instruments: 0, quotes: 0 };
        aggregate.instruments += refs.length;
        aggregate.quotes += quotes.length;
        synced.set(providerId, aggregate);
        logger.info("quotes synced", {
          runId,
          provider: providerId,
          instruments: refs.length,
          quotes: quotes.length,
        });
      } catch (error) {
        const message = errorText(error);
        let requeued = 0;

        for (const ref of refs) {
          const key = `${ref.market}:${ref.symbol}`;
          const assignment = assignmentByKey.get(key);
          const nextIndex = (remaining.get(key) ?? 0) + 1;
          const fallback = assignment?.candidates[nextIndex];

          if (assignment && fallback) {
            remaining.set(key, nextIndex);
            const fallbackRefs = next.get(fallback) ?? [];
            fallbackRefs.push(ref);
            next.set(fallback, fallbackRefs);
            requeued += 1;
          } else {
            report.errors.push({ scope: `quotes:${providerId}`, message, code: errorCode(error) });
            logger.error("quote sync failed", {
              runId,
              provider: providerId,
              symbol: ref.symbol,
              message,
              code: errorCode(error),
            });
          }
        }

        if (requeued > 0) {
          logger.warn("quote fallback", { runId, provider: providerId, requeued, message });
        }
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
