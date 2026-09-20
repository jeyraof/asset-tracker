import type { AccountConfig, BrokerProvider, TradeFill } from "../domain/types";
import * as repo from "../db/repo";
import { addDays } from "../lib/dates";

/** Fetches fills within the recent window and upserts them (idempotent by order id). */
export async function syncTrades(
  db: D1Database,
  provider: BrokerProvider,
  account: AccountConfig,
  date: string,
  lookbackDays: number,
): Promise<TradeFill[]> {
  const from = addDays(date, -(lookbackDays - 1));
  const trades = await provider.getTrades(account, from, date);
  await repo.upsertTrades(db, account.id, trades);
  return trades;
}
