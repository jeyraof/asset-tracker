import type { AccountConfig } from "../../domain/types";
import { str } from "../../lib/parse";

/** A single account's Kiwoom app credentials. */
export interface KiwoomCredentials {
  appkey: string;
  appsecret: string;
  /** Where the credentials came from, for logs/errors (never contains secrets). */
  source: string;
}

/** Normalized keys are digit-only, so account-number variants resolve together. */
export type KiwoomCredentialMap = Map<string, KiwoomCredentials>;

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Parses the `KIWOOM_CREDENTIALS` JSON secret. Accepts either `appsecret` or
 * `secretkey` as the secret field. Entries missing either value are skipped.
 */
export function parseKiwoomCredentials(raw: string | undefined | null): KiwoomCredentialMap {
  const map: KiwoomCredentialMap = new Map();
  if (!raw || raw.trim() === "") return map;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("KIWOOM_CREDENTIALS must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("KIWOOM_CREDENTIALS must be a JSON object keyed by account id");
  }

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const appkey = str(entry["appkey"]);
    const appsecret = str(entry["appsecret"]) ?? str(entry["secretkey"]);
    if (!appkey || !appsecret) continue;

    map.set(digits(key), { appkey, appsecret, source: key });
  }

  return map;
}

/**
 * Resolves an account's credentials by `externalId`, then by `meta.acctNo`
 * (the 10-digit account number returned by ka00001), then by `meta.credKey`
 * (the key used in the credentials file).
 */
export function resolveKiwoomCredentials(
  map: KiwoomCredentialMap,
  account: Pick<AccountConfig, "externalId" | "meta">,
): KiwoomCredentials | undefined {
  const candidates = [
    digits(account.externalId ?? ""),
    digits(str(account.meta?.["acctNo"]) ?? ""),
    digits(str(account.meta?.["credKey"]) ?? ""),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const found = map.get(candidate);
    if (found) return found;
  }

  return undefined;
}

export function firstKiwoomCredentials(
  map: KiwoomCredentialMap,
): KiwoomCredentials | undefined {
  for (const value of map.values()) return value;
  return undefined;
}
