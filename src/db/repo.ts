import type {
  AccountConfig,
  BalanceSummary,
  DailyQuote,
  FxRate,
  HoldingSnapshot,
  ProviderAccount,
  TradeFill,
} from "../domain/types";
import { chunk } from "../lib/parse";

const BATCH_SIZE = 50;

interface AccountRow {
  id: number;
  provider: string;
  env: string;
  external_id: string;
  country: string;
  currency: string;
  name: string | null;
  alias: string | null;
  account_no: string | null;
  active: number;
  meta_json: string | null;
}

function mapAccountRow(row: AccountRow): AccountConfig {
  let meta: Record<string, unknown> = {};
  if (row.meta_json) {
    try {
      const parsed: unknown = JSON.parse(row.meta_json);
      if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
    } catch {
      meta = {};
    }
  }

  return {
    id: row.id,
    provider: row.provider,
    env: row.env,
    externalId: row.external_id,
    country: row.country,
    currency: row.currency,
    name: row.name,
    alias: row.alias,
    accountNo: row.account_no,
    active: row.active === 1,
    meta,
  };
}

export async function upsertAccount(db: D1Database, account: ProviderAccount): Promise<number> {
  await db
    .prepare(
      `INSERT INTO accounts (provider, env, external_id, country, currency, name, active, meta_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))
       ON CONFLICT (provider, env, external_id) DO UPDATE SET
         country = excluded.country,
         currency = excluded.currency,
         name = excluded.name,
         meta_json = excluded.meta_json,
         updated_at = datetime('now')`,
    )
    .bind(
      account.provider,
      account.env,
      account.externalId,
      account.country,
      account.currency,
      account.name,
      JSON.stringify(account.meta),
    )
    .run();

  const row = await db
    .prepare("SELECT id FROM accounts WHERE provider = ? AND env = ? AND external_id = ?")
    .bind(account.provider, account.env, account.externalId)
    .first<{ id: number }>();

  if (!row) throw new Error("failed to resolve account id after upsert");
  return row.id;
}

export async function listActiveAccounts(
  db: D1Database,
  provider?: string,
): Promise<AccountConfig[]> {
  const base = `SELECT id, provider, env, external_id, country, currency, name, alias, account_no, active, meta_json
                FROM accounts WHERE active = 1`;
  const statement = provider
    ? db.prepare(`${base} AND provider = ? ORDER BY id`).bind(provider)
    : db.prepare(`${base} ORDER BY id`);

  const { results } = await statement.all<AccountRow>();
  return (results ?? []).map(mapAccountRow);
}

export async function upsertAccountSnapshot(
  db: D1Database,
  accountId: number,
  date: string,
  summary: BalanceSummary,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO account_snapshots (
         account_id, snapshot_date, currency, deposit_total, next_day_settlement,
         total_eval_amount, securities_eval_amount, purchase_amount_total,
         eval_pfls_amount, net_asset_amount, raw_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (account_id, snapshot_date) DO UPDATE SET
         currency = excluded.currency,
         deposit_total = excluded.deposit_total,
         next_day_settlement = excluded.next_day_settlement,
         total_eval_amount = excluded.total_eval_amount,
         securities_eval_amount = excluded.securities_eval_amount,
         purchase_amount_total = excluded.purchase_amount_total,
         eval_pfls_amount = excluded.eval_pfls_amount,
         net_asset_amount = excluded.net_asset_amount,
         raw_json = excluded.raw_json,
         updated_at = datetime('now')`,
    )
    .bind(
      accountId,
      date,
      summary.currency,
      summary.depositTotal,
      summary.nextDaySettlement,
      summary.totalEvalAmount,
      summary.securitiesEvalAmount,
      summary.purchaseAmountTotal,
      summary.evalPflsAmount,
      summary.netAssetAmount,
      JSON.stringify(summary.raw),
    )
    .run();
}

/**
 * Replaces the holdings snapshot for (account, date) so that positions that
 * were sold since the previous run are removed, then inserts the fresh set.
 */
export async function replaceHoldings(
  db: D1Database,
  accountId: number,
  date: string,
  holdings: readonly HoldingSnapshot[],
): Promise<void> {
  const deleteStatement = db
    .prepare("DELETE FROM holdings WHERE account_id = ? AND snapshot_date = ?")
    .bind(accountId, date);

  const insertStatements = holdings.map((holding) =>
    db
      .prepare(
        `INSERT INTO holdings (
           account_id, snapshot_date, market, symbol, product_name, currency,
           quantity, avg_price, purchase_amount, current_price, eval_amount,
           eval_pfls_amount, eval_pfls_rate, raw_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .bind(
        accountId,
        date,
        holding.market,
        holding.symbol,
        holding.productName,
        holding.currency,
        holding.quantity,
        holding.avgPrice,
        holding.purchaseAmount,
        holding.currentPrice,
        holding.evalAmount,
        holding.evalPflsAmount,
        holding.evalPflsRate,
        JSON.stringify(holding.raw),
      ),
  );

  await db.batch([deleteStatement, ...insertStatements]);
}

export interface InstrumentInput {
  market: string;
  symbol: string;
  country: string;
  currency: string;
  name: string | null;
  provider: string;
}

export async function upsertInstruments(
  db: D1Database,
  instruments: readonly InstrumentInput[],
): Promise<void> {
  if (instruments.length === 0) return;

  for (const group of chunk(instruments, BATCH_SIZE)) {
    await db.batch(
      group.map((instrument) =>
        db
          .prepare(
            `INSERT INTO instruments (market, symbol, country, currency, name, provider, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT (market, symbol) DO UPDATE SET
               country = excluded.country,
               currency = excluded.currency,
               name = COALESCE(excluded.name, instruments.name),
               provider = excluded.provider,
               updated_at = datetime('now')`,
          )
          .bind(
            instrument.market,
            instrument.symbol,
            instrument.country,
            instrument.currency,
            instrument.name,
            instrument.provider,
          ),
      ),
    );
  }
}

export async function upsertQuotes(
  db: D1Database,
  quotes: readonly DailyQuote[],
): Promise<void> {
  if (quotes.length === 0) return;

  for (const group of chunk(quotes, BATCH_SIZE)) {
    await db.batch(
      group.map((quote) =>
        db
          .prepare(
            `INSERT INTO price_daily (
               market, symbol, date, open, high, low, close, volume,
               currency, provider, source, raw_json, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT (market, symbol, date) DO UPDATE SET
               open = excluded.open,
               high = excluded.high,
               low = excluded.low,
               close = excluded.close,
               volume = excluded.volume,
               currency = excluded.currency,
               provider = excluded.provider,
               source = excluded.source,
               raw_json = excluded.raw_json,
               updated_at = datetime('now')`,
          )
          .bind(
            quote.market,
            quote.symbol,
            quote.date,
            quote.open,
            quote.high,
            quote.low,
            quote.close,
            quote.volume,
            quote.currency,
            quote.provider,
            quote.source,
            JSON.stringify(quote.raw),
          ),
      ),
    );
  }
}

export async function upsertFxRates(
  db: D1Database,
  rates: readonly FxRate[],
): Promise<void> {
  if (rates.length === 0) return;

  for (const group of chunk(rates, BATCH_SIZE)) {
    await db.batch(
      group.map((rate) =>
        db
          .prepare(
            `INSERT INTO fx_rates (
               base_currency, quote_currency, date, rate,
               provider, source, raw_json, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT (base_currency, quote_currency, date) DO UPDATE SET
               rate = excluded.rate,
               provider = excluded.provider,
               source = excluded.source,
               raw_json = excluded.raw_json,
               updated_at = datetime('now')`,
          )
          .bind(
            rate.base,
            rate.quote,
            rate.date,
            rate.rate,
            rate.provider,
            rate.source,
            JSON.stringify(rate.raw),
          ),
      ),
    );
  }
}

export async function upsertTrades(
  db: D1Database,
  accountId: number,
  trades: readonly TradeFill[],
): Promise<void> {
  if (trades.length === 0) return;

  for (const group of chunk(trades, BATCH_SIZE)) {
    await db.batch(
      group.map((trade) =>
        db
          .prepare(
            `INSERT INTO trades (
               account_id, trade_date, external_id, market, symbol, product_name,
               side, quantity, avg_price, amount, currency, order_time, raw_json, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT (account_id, trade_date, external_id, side) DO UPDATE SET
               market = excluded.market,
               symbol = excluded.symbol,
               product_name = excluded.product_name,
               quantity = excluded.quantity,
               avg_price = excluded.avg_price,
               amount = excluded.amount,
               currency = excluded.currency,
               order_time = excluded.order_time,
               raw_json = excluded.raw_json,
               updated_at = datetime('now')`,
          )
          .bind(
            accountId,
            trade.date,
            trade.externalId,
            trade.market,
            trade.symbol,
            trade.productName,
            trade.side,
            trade.quantity,
            trade.avgPrice,
            trade.amount,
            trade.currency,
            trade.orderTime,
            JSON.stringify(trade.raw),
          ),
      ),
    );
  }
}

export interface StartSyncRunInput {
  runId: string;
  provider: string | null;
  source: string;
}

export async function startSyncRun(db: D1Database, input: StartSyncRunInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_runs (run_id, provider, source, status)
       VALUES (?, ?, ?, 'running')`,
    )
    .bind(input.runId, input.provider, input.source)
    .run();
}

export async function finishSyncRun(
  db: D1Database,
  runId: string,
  status: string,
  details: unknown,
  errors: SyncErrorRecord[] = [],
): Promise<void> {
  const statements = [
    db
      .prepare(
        `UPDATE sync_runs
           SET status = ?, finished_at = datetime('now'), details_json = ?
         WHERE run_id = ?`,
      )
      .bind(status, JSON.stringify(details), runId),
  ];

  for (const error of errors) {
    statements.push(
      db
        .prepare(
          `INSERT INTO sync_errors
             (run_id, provider, external_id, market, symbol, scope, status, code, attempts, path, message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          runId,
          error.provider,
          error.externalId,
          error.market,
          error.symbol,
          error.scope,
          error.status,
          error.code,
          error.attempts,
          error.path,
          error.message,
        ),
    );
  }

  await db.batch(statements);
}

export interface SyncErrorRecord {
  runId: string;
  scope: string;
  message: string;
  provider?: string | null;
  externalId?: string | null;
  market?: string | null;
  symbol?: string | null;
  status?: number | null;
  code?: string | null;
  attempts?: number | null;
  path?: string | null;
}

export async function listRecentRuns(db: D1Database, limit = 20): Promise<unknown[]> {
  const { results } = await db
    .prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?")
    .bind(limit)
    .all();
  return results ?? [];
}

export interface SyncRunRow {
  run_id: string;
  provider: string | null;
  source: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  details_json: string | null;
}

export async function getLatestSyncRun(db: D1Database): Promise<SyncRunRow | null> {
  const row = await db
    .prepare(
      `SELECT run_id, provider, source, status, started_at, finished_at, details_json
         FROM sync_runs ORDER BY id DESC LIMIT 1`,
    )
    .first<SyncRunRow>();
  return row ?? null;
}

export async function getSyncRun(db: D1Database, runId: string): Promise<SyncRunRow | null> {
  const row = await db
    .prepare(
      `SELECT run_id, provider, source, status, started_at, finished_at, details_json
         FROM sync_runs WHERE run_id = ?`,
    )
    .bind(runId)
    .first<SyncRunRow>();
  return row ?? null;
}

export async function listSyncErrors(db: D1Database, runId: string): Promise<unknown[]> {
  const { results } = await db
    .prepare(
      `SELECT provider, external_id, market, symbol, scope, status, code, attempts, path, message, created_at
         FROM sync_errors WHERE run_id = ? ORDER BY id ASC`,
    )
    .bind(runId)
    .all();
  return results ?? [];
}
