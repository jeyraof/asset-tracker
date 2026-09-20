export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;

  /**
   * Per-account KIS credentials as a JSON object keyed by account external id
   * (e.g. `{"12345678-01":{"appkey":"...","appsecret":"..."}}`). Wrangler secret.
   */
  KIS_CREDENTIALS?: string;

  /** KIS target environment: "prod" (real) | "vts" (paper). Defaults to "prod". */
  KIS_ENV?: string;
  /** Override for the KIS REST base URL. */
  KIS_BASE_URL?: string;

  /** Shared secret required by the manual `POST /sync` trigger. */
  ADMIN_TOKEN?: string;

  /** Set to "1" to log outgoing KIS requests (never logs secrets). */
  DEBUG_KIS?: string;

  /**
   * Per-account Kiwoom credentials as a JSON object keyed by account id
   * (e.g. `{"12345678":{"appkey":"...","appsecret":"..."}}`). Wrangler secret.
   */
  KIWOOM_CREDENTIALS?: string;

  /** Kiwoom target environment: "prod" (real) | "mock" (paper). Defaults to "prod". */
  KIWOOM_ENV?: string;
  /**
   * Base URL the Worker calls. Point this at the Caddy reverse proxy vhost so
   * requests egress from the IP-whitelisted host (e.g. "https://kiwoom-api.example.com").
   */
  KIWOOM_BASE_URL?: string;
  /** Shared secret sent as `X-Kiwoom-Relay` to the reverse proxy. Wrangler secret. */
  KIWOOM_RELAY_SECRET?: string;

  /** Set to "1" to log outgoing Kiwoom requests (never logs secrets). */
  DEBUG_KIWOOM?: string;
}
