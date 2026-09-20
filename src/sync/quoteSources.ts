import type { BrokerProvider, InstrumentRef } from "../domain/types";

/** An instrument and the ids of the providers that reported holding it. */
export interface QuoteSourceEntry {
  ref: InstrumentRef;
  providers: ReadonlySet<string>;
}

/** An instrument with its ordered quote providers (first = source, rest = fallback). */
export interface QuoteAssignment {
  ref: InstrumentRef;
  candidates: string[];
}

type QuoteCapability = Pick<BrokerProvider, "supportsMarket">;

/**
 * Assigns each instrument one ordered list of quote providers: the providers
 * that hold it, are available, and support its market, ordered by `priority`.
 * The first candidate is the quote source; the rest are fallbacks, so the same
 * instrument is never fetched from more than one provider unless one fails.
 */
export function resolveQuoteCandidates(
  entries: Iterable<QuoteSourceEntry>,
  available: ReadonlyMap<string, QuoteCapability>,
  priority: readonly string[],
): QuoteAssignment[] {
  const assignments: QuoteAssignment[] = [];

  for (const entry of entries) {
    const candidates = priority.filter((id) => {
      const provider = available.get(id);
      return (
        provider !== undefined &&
        entry.providers.has(id) &&
        provider.supportsMarket(entry.ref.market)
      );
    });

    if (candidates.length > 0) assignments.push({ ref: entry.ref, candidates });
  }

  return assignments;
}
