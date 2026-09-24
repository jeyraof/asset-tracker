import type { Env } from "../env";
import type { BrokerProvider } from "../domain/types";
import { createKisProvider } from "./kis";
import { createKiwoomProvider } from "./kiwoom";
import { createTossProvider } from "./toss";

export interface ProviderContext {
  env: Env;
}

export type ProviderFactory = (ctx: ProviderContext) => BrokerProvider;

const factories: Record<string, ProviderFactory> = {
  kis: (ctx) => createKisProvider(ctx.env),
  kiwoom: (ctx) => createKiwoomProvider(ctx.env),
  toss: (ctx) => createTossProvider(ctx.env),
};

/**
 * Preference order for choosing a single quote source per instrument. An
 * instrument held at several brokers is fetched from the first provider here
 * that supports its market, so the same symbol is never fetched more than once.
 */
export function quoteProviderPriority(): string[] {
  return Object.keys(factories);
}

/**
 * Provider instances are cached per id so that in-isolate state such as the
 * rate limiter is shared across accounts and calls within a single invocation.
 */
const instances = new Map<string, BrokerProvider>();

export function isKnownProvider(id: string): boolean {
  return id in factories;
}

export function listKnownProviders(): string[] {
  return Object.keys(factories);
}

export function getProvider(id: string, ctx: ProviderContext): BrokerProvider {
  const cached = instances.get(id);
  if (cached) return cached;

  const factory = factories[id];
  if (!factory) {
    throw new Error(
      `Unknown provider "${id}". Known providers: ${listKnownProviders().join(", ")}`,
    );
  }
  const provider = factory(ctx);
  instances.set(id, provider);
  return provider;
}

/** Test/utility hook to drop cached instances. */
export function resetProviderCache(): void {
  instances.clear();
}
