import type { Env } from "../env";
import type { FxSource } from "../domain/types";
import { KOREAEXIM_SOURCE_ID, KoreaEximFxSource } from "./koreaexim";

export type FxSourceFactory = (env: Env) => FxSource;

/**
 * FX sources in preference order. Unlike broker providers, these are market
 * data sources with no accounts; the standalone FX task iterates them.
 */
const factories: Record<string, FxSourceFactory> = {
  [KOREAEXIM_SOURCE_ID]: (env) => new KoreaEximFxSource({ apiKey: requireApiKey(env) }),
};

export function listKnownFxSources(): string[] {
  return Object.keys(factories);
}

export function getFxSource(id: string, env: Env): FxSource {
  const factory = factories[id];
  if (!factory) {
    throw new Error(`Unknown FX source "${id}". Known sources: ${listKnownFxSources().join(", ")}`);
  }
  return factory(env);
}

function requireApiKey(env: Env): string {
  const key = env.KOREAEXIM_API_KEY?.trim();
  if (!key) throw new Error("KOREAEXIM_API_KEY is not set");
  return key;
}
