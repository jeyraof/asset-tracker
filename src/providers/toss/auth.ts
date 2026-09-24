import { logger } from "../../lib/logger";
import { parseRetryAfter, requestSignal } from "../../lib/retryPolicy";
import { TossApiError } from "./errors";
import { TOSS_PATHS } from "./tr-ids";
import type { TossErrorBody, TossTokenResponse } from "./types";

const DEFAULT_EXPIRES_IN_SECONDS = 3_600;
/** Refresh this long before the token actually expires. */
const EXPIRY_SAFETY_MS = 60 * 1000;
const MIN_TTL_SECONDS = 60;

export interface TossTokenCacheEntry {
  accessToken: string;
  /** Epoch millis. */
  expiresAt: number;
}

/**
 * Stable, non-secret identifier for an OAuth2 client. Toss tokens are bound to
 * the client, so the KV cache is keyed per client id.
 */
export async function tossCredentialId(clientId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientId));
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function tossTokenCacheKey(env: string, id: string): string {
  return `toss:token:${env}:${id}`;
}

export interface TossTokenOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  env: string;
  cache: KVNamespace;
  /** Shared secret sent as `X-Toss-Relay` to the reverse proxy, if any. */
  relaySecret?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function getTossAccessToken(options: TossTokenOptions): Promise<string> {
  const now = options.now?.() ?? Date.now();
  const key = tossTokenCacheKey(options.env, await tossCredentialId(options.clientId));
  const cached = await options.cache.get<TossTokenCacheEntry>(key, "json");

  if (cached && cached.expiresAt - now > 0) return cached.accessToken;

  return issueToken(options, now, key);
}

export async function invalidateTossToken(
  cache: KVNamespace,
  env: string,
  clientId: string,
): Promise<void> {
  await cache.delete(tossTokenCacheKey(env, await tossCredentialId(clientId)));
}

async function issueToken(options: TossTokenOptions, now: number, key: string): Promise<string> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = new URL(TOSS_PATHS.token, options.baseUrl).toString();
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (options.relaySecret) headers["X-Toss-Relay"] = options.relaySecret;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: options.clientId,
    client_secret: options.clientSecret,
  }).toString();

  const response = await doFetch(url, {
    method: "POST",
    headers,
    body,
    signal: requestSignal(),
  });

  const text = await response.text();
  let parsed: TossTokenResponse & TossErrorBody;
  try {
    parsed = JSON.parse(text) as TossTokenResponse & TossErrorBody;
  } catch {
    throw new TossApiError("Failed to parse Toss token response", {
      status: response.status,
      path: TOSS_PATHS.token,
      body: text,
    });
  }

  const accessToken = parsed.access_token;
  if (!response.ok || !accessToken) {
    throw new TossApiError(parsed.error?.message ?? "Toss token issuance failed", {
      code: parsed.error?.code ?? null,
      status: response.status,
      path: TOSS_PATHS.token,
      requestId: parsed.error?.requestId,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      body: parsed,
    });
  }

  const expiresInMs = (parsed.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000;
  const expiresAt = now + expiresInMs - EXPIRY_SAFETY_MS;
  const ttl = Math.max(MIN_TTL_SECONDS, Math.floor((expiresAt - now) / 1000));

  await options.cache.put(
    key,
    JSON.stringify({ accessToken, expiresAt } satisfies TossTokenCacheEntry),
    { expirationTtl: ttl },
  );

  logger.info("toss access token issued", { env: options.env, expiresAt });
  return accessToken;
}
