import type { BrokerProvider, DailyQuote, InstrumentRef } from "../domain/types";
import * as repo from "../db/repo";

/** Fetches and upserts daily OHLC for the given instruments as of `date`. */
export async function syncQuotes(
  db: D1Database,
  provider: BrokerProvider,
  instruments: readonly InstrumentRef[],
  date: string,
): Promise<DailyQuote[]> {
  if (instruments.length === 0) return [];
  const quotes = await provider.getDailyQuotes([...instruments], date);
  await repo.upsertQuotes(db, quotes);
  return quotes;
}
