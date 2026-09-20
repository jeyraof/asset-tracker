import type { AccountConfig } from "../../domain/types";
import { str } from "../../lib/parse";

/** A single account's KIS app credentials. */
export interface KisCredentials {
  appkey: string;
  appsecret: string;
  /** Where the credentials came from, for logs/errors (never contains secrets). */
  source: string;
}

/** Normalized keys are digit-only, so `"12345678-01"`, `"1234567801"` and
 * `"12345678"` can all resolve to the same account. */
export type KisCredentialMap = Map<string, KisCredentials>;

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Parses the `KIS_CREDENTIALS` JSON secret. Entries that are missing an
 * `appkey` or `appsecret` are skipped rather than failing the whole map.
 */
export function parseKisCredentials(raw: string | undefined | null): KisCredentialMap {
  const map: KisCredentialMap = new Map();
  if (!raw || raw.trim() === "") return map;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("KIS_CREDENTIALS must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("KIS_CREDENTIALS must be a JSON object keyed by account id");
  }

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const appkey = str(entry["appkey"]);
    const appsecret = str(entry["appsecret"]);
    if (!appkey || !appsecret) continue;

    map.set(digits(key), { appkey, appsecret, source: key });
  }

  return map;
}

/**
 * Resolves an account's credentials, first by `externalId` (10 digits), then by
 * the 8-digit `CANO` from `meta`. Returns `undefined` when the account has no
 * `KIS_CREDENTIALS` entry.
 */
export function resolveKisCredentials(
  map: KisCredentialMap,
  account: Pick<AccountConfig, "externalId" | "meta">,
): KisCredentials | undefined {
  const externalId = digits(account.externalId ?? "");
  if (externalId) {
    const found = map.get(externalId);
    if (found) return found;
  }

  const cano = str(account.meta?.["cano"]);
  if (cano) {
    const found = map.get(digits(cano));
    if (found) return found;
  }

  return undefined;
}

export function firstCredentials(map: KisCredentialMap): KisCredentials | undefined {
  for (const value of map.values()) return value;
  return undefined;
}
