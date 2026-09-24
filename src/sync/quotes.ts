import type { BrokerProvider, InstrumentRef, QuoteFetchResult } from "../domain/types";
import * as repo from "../db/repo";

/** Fetches and upserts daily OHLC for the given instruments as of `date`. */
export async function syncQuotes(
  db: D1Database,
  provider: BrokerProvider,
  instruments: readonly InstrumentRef[],
  date: string,
): Promise<QuoteFetchResult> {
  if (instruments.length === 0) return { quotes: [], failures: [] };
  const result = await provider.getDailyQuotes([...instruments], date);
  await repo.upsertQuotes(db, result.quotes);
  return result;
}
