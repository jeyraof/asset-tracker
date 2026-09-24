import { num } from "../../../lib/parse";
import type { DailyQuote } from "../../../domain/types";
import { TOSS_PROVIDER_ID } from "./holdings";
import type { TossCandle } from "../types";

/** Maps one Toss candle to a normalized daily quote (null if undated). */
export function mapTossCandle(
  raw: TossCandle,
  symbol: string,
  market: string,
  currency: string,
): DailyQuote | null {
  const date = typeof raw.timestamp === "string" ? raw.timestamp.slice(0, 10) : null;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  return {
    market,
    symbol,
    date,
    open: num(raw.openPrice),
    high: num(raw.highPrice),
    low: num(raw.lowPrice),
    close: num(raw.closePrice),
    volume: num(raw.volume),
    currency: typeof raw.currency === "string" ? raw.currency : currency,
    provider: TOSS_PROVIDER_ID,
    source: "toss-daily-candle",
    raw,
  };
}
