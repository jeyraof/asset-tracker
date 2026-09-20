import type { AccountConfig, BalanceResult, BrokerProvider } from "../domain/types";
import * as repo from "../db/repo";

export async function syncBalance(
  db: D1Database,
  provider: BrokerProvider,
  account: AccountConfig,
  date: string,
): Promise<BalanceResult> {
  const result = await provider.getBalance(account, date);

  await repo.upsertAccountSnapshot(db, account.id, result.date, result.summary);
  await repo.replaceHoldings(db, account.id, result.date, result.holdings);
  await repo.upsertInstruments(
    db,
    result.holdings.map((holding) => ({
      market: holding.market,
      symbol: holding.symbol,
      country: account.country,
      currency: holding.currency,
      name: holding.productName,
      provider: account.provider,
    })),
  );

  return result;
}
