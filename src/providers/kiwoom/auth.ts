import { logger } from "../../lib/logger";
import { KiwoomApiError, normalizeKiwoomReturnCode } from "./errors";
import { KIWOOM_PATHS, type KiwoomEnvironment } from "./tr-ids";
import type { KiwoomTokenResponse } from "./types";

const DEFAULT_EXPIRES_IN_SECONDS = 86_400;
/** Refresh this long before the token actually expires. */
const EXPIRY_SAFETY_MS = 10 * 60 * 1000;
const MIN_TTL_SECONDS = 60;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export interface KiwoomTokenCacheEntry {
  accessToken: string;
  /** Epoch millis. */
  expiresAt: number;
}

/**
 * Stable, non-secret identifier for an app key. Kiwoom tokens are bound to the
 * issuing app key (and the issuing IP), so the KV cache is keyed per credential.
 */
export async function kiwoomCredentialId(appkey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(appkey));
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function kiwoomTokenCacheKey(env: KiwoomEnvironment, id: string): string {
  return `kiwoom:token:${env}:${id}`;
}

export interface KiwoomTokenOptions {
  baseUrl: string;
  appkey: string;
  appsecret: string;
  env: KiwoomEnvironment;
  cache: KVNamespace;
  /** Shared secret header expected by the reverse proxy, if any. */
  relaySecret?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function getKiwoomAccessToken(options: KiwoomTokenOptions): Promise<string> {
  const now = options.now?.() ?? Date.now();
  const key = kiwoomTokenCacheKey(options.env, await kiwoomCredentialId(options.appkey));
  const cached = await options.cache.get<KiwoomTokenCacheEntry>(key, "json");

  if (cached && cached.expiresAt - now > 0) return cached.accessToken;

  return issueKiwoomToken(options, now, key);
}

export async function invalidateKiwoomToken(
  cache: KVNamespace,
  env: KiwoomEnvironment,
  appkey: string,
): Promise<void> {
  await cache.delete(kiwoomTokenCacheKey(env, await kiwoomCredentialId(appkey)));
}

async function issueKiwoomToken(
  options: KiwoomTokenOptions,
  now: number,
  key: string,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(KIWOOM_PATHS.token, options.baseUrl).toString();
  const headers: Record<string, string> = {
    "content-type": "application/json;charset=UTF-8",
  };
  if (options.relaySecret) headers["X-Kiwoom-Relay"] = options.relaySecret;

  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: options.appkey,
      secretkey: options.appsecret,
    }),
  });

  const text = await response.text();
  let body: KiwoomTokenResponse;
  try {
    body = JSON.parse(text) as KiwoomTokenResponse;
  } catch {
    throw new KiwoomApiError("Failed to parse Kiwoom token response", {
      path: KIWOOM_PATHS.token,
      status: response.status,
      body: text,
    });
  }

  const returnCode = normalizeKiwoomReturnCode(body.return_code, body.return_msg);
  const token = body.token;
  if (!response.ok || !token || (returnCode !== null && returnCode !== 0)) {
    throw new KiwoomApiError(body.return_msg ?? "Kiwoom token issuance failed", {
      returnCode,
      path: KIWOOM_PATHS.token,
      status: response.status,
      body,
    });
  }

  const expiresAt = parseKiwoomExpiry(body.expires_dt, now) - EXPIRY_SAFETY_MS;
  const ttl = Math.max(MIN_TTL_SECONDS, Math.floor((expiresAt - now) / 1000));

  await options.cache.put(
    key,
    JSON.stringify({ accessToken: token, expiresAt } satisfies KiwoomTokenCacheEntry),
    { expirationTtl: ttl },
  );

  logger.info("kiwoom access token issued", { env: options.env, expiresAt });
  return token;
}

/** Parses Kiwoom's `YYYYMMDDHHMMSS` (KST) expiry into epoch millis. */
export function parseKiwoomExpiry(expiresDt: string | undefined, now: number): number {
  if (!expiresDt || expiresDt.length !== 14) {
    return now + DEFAULT_EXPIRES_IN_SECONDS * 1000;
  }
  const [y, mo, d, h, mi, s] = [
    expiresDt.slice(0, 4),
    expiresDt.slice(4, 6),
    expiresDt.slice(6, 8),
    expiresDt.slice(8, 10),
    expiresDt.slice(10, 12),
    expiresDt.slice(12, 14),
  ].map(Number);

  const utc = Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, s ?? 0);
  return utc - KST_OFFSET_MS;
}
