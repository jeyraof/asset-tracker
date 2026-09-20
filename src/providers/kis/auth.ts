import { logger } from "../../lib/logger";
import { KisApiError, KIS_MSG } from "./errors";
import type { KisTokenResponse } from "./types";
import type { KisEnvironment } from "./tr-ids";

const TOKEN_PATH = "/oauth2/tokenP";
const DEFAULT_EXPIRES_IN_SECONDS = 86_400;
/** Refresh this long before the token actually expires. */
const EXPIRY_SAFETY_MS = 60 * 60 * 1000;
const MIN_TTL_SECONDS = 60;

export interface TokenCacheEntry {
  accessToken: string;
  /** Epoch millis. */
  expiresAt: number;
}

/**
 * Stable, non-secret identifier for an app key. KIS tokens are bound to the
 * app key that issued them, so the KV cache must be keyed per credential —
 * otherwise one account's token would be reused for another.
 */
export async function credentialId(appkey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(appkey));
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function tokenCacheKey(env: KisEnvironment, id: string): string {
  return `kis:token:${env}:${id}`;
}

export interface TokenOptions {
  baseUrl: string;
  appkey: string;
  appsecret: string;
  env: KisEnvironment;
  cache: KVNamespace;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function getAccessToken(options: TokenOptions): Promise<string> {
  const now = options.now?.() ?? Date.now();
  const key = tokenCacheKey(options.env, await credentialId(options.appkey));
  const cached = await options.cache.get<TokenCacheEntry>(key, "json");

  if (cached && cached.expiresAt - now > 0) return cached.accessToken;

  try {
    return await issueToken(options, now, key);
  } catch (error) {
    if (cached && error instanceof KisApiError && error.msgCd === KIS_MSG.TOKEN_RATE_LIMIT) {
      logger.warn("kis token issuance rate limited; reusing cached token", {
        env: options.env,
        expiresAt: cached.expiresAt,
      });
      return cached.accessToken;
    }
    throw error;
  }
}

export async function invalidateAccessToken(
  cache: KVNamespace,
  env: KisEnvironment,
  appkey: string,
): Promise<void> {
  await cache.delete(tokenCacheKey(env, await credentialId(appkey)));
}

async function issueToken(options: TokenOptions, now: number, key: string): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(new URL(TOKEN_PATH, options.baseUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: options.appkey,
      appsecret: options.appsecret,
    }),
  });

  const text = await response.text();
  let body: KisTokenResponse;
  try {
    body = JSON.parse(text) as KisTokenResponse;
  } catch {
    throw new KisApiError("Failed to parse KIS token response", {
      path: TOKEN_PATH,
      status: response.status,
      body: text,
    });
  }

  const accessToken = body.access_token;
  if (!response.ok || !accessToken) {
    throw new KisApiError(body.msg1 ?? body.error_description ?? "KIS token issuance failed", {
      msgCd: body.msg_cd ?? body.error_code ?? null,
      path: TOKEN_PATH,
      status: response.status,
      body,
    });
  }

  const expiresInMs = (body.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000;
  const expiresAt = now + expiresInMs - EXPIRY_SAFETY_MS;
  const ttl = Math.max(MIN_TTL_SECONDS, Math.floor((expiresAt - now) / 1000));

  await options.cache.put(
    key,
    JSON.stringify({ accessToken, expiresAt } satisfies TokenCacheEntry),
    { expirationTtl: ttl },
  );

  logger.info("kis access token issued", { env: options.env, expiresAt });
  return accessToken;
}
