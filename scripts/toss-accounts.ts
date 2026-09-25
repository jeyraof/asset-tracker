/**
 * Discovers and verifies Toss Securities accounts against the live API and
 * (optionally) prints SQL to register them. Toss uses a single user-level
 * OAuth2 client and exposes every account via `GET /api/v1/accounts`; each
 * account gets two rows (KRX + US) since one Toss account holds both markets.
 *
 * Requests go through the Caddy reverse proxy (TOSS_BASE_URL) so they egress
 * from the IP-allowlisted host.
 *
 * Usage:
 *   npm run toss:accounts -- --sql > seeds/accounts.sql
 *   npm run toss:accounts -- --accounts 1 --trades
 *   npm run toss:accounts -- --credentials-file .toss-credentials.json
 *
 * Credentials are read from the credentials file first, then TOSS_CREDENTIALS
 * (environment or .dev.vars).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { addDays, kstDate } from "../src/lib/dates";
import { setLoggerSilent } from "../src/lib/logger";
import { RateLimiter } from "../src/lib/rateLimit";
import { TossClient } from "../src/providers/toss/client";
import { parseTossCredentials, type TossCredentials } from "../src/providers/toss/credentials";
import { isTossApiError } from "../src/providers/toss/errors";
import { createTossProvider } from "../src/providers/toss";
import { TOSS_BASE_URL, TOSS_PATHS } from "../src/providers/toss/tr-ids";
import type { TossAccount, TossHoldingsOverview } from "../src/providers/toss/types";
import type { AccountConfig, BalanceResult } from "../src/domain/types";
import type { Env } from "../src/env";

const DEFAULT_ENV = "prod";
const TOKEN_CACHE_PATH = ".toss-token-cache.json";
const DEFAULT_CREDENTIALS_FILE = ".toss-credentials.json";

function readCredentialsFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  return raw === "" ? undefined : raw;
}

function maskSecret(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function loadDevVars(path = ".dev.vars"): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** File-backed KV shim so repeated local runs reuse the Toss access token. */
function createFileKv(path = TOKEN_CACHE_PATH): KVNamespace {
  const load = (): Record<string, string> => {
    try {
      return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const save = (data: Record<string, string>) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
  };

  return {
    async get(key: string, type?: string) {
      const value = load()[key];
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      const data = load();
      data[key] = value;
      save(data);
    },
    async delete(key: string) {
      const data = load();
      delete data[key];
      save(data);
    },
  } as unknown as KVNamespace;
}

function argValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === `--${name}` && args[i + 1]) out.push(args[i + 1] as string);
    else if (arg?.startsWith(`--${name}=`)) out.push(arg.slice(name.length + 3));
  }
  return out;
}

function hasFlag(args: string[], name: string): boolean {
  return args.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}

function splitCandidates(raw: string[]): string[] {
  return raw
    .flatMap((value) => value.split(/[\s,]+/))
    .map((value) => value.trim())
    .filter(Boolean);
}

function sqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function toAccount(
  accountSeq: number,
  accountNo: string | null,
  env: string,
  product: "stock" | "us",
): AccountConfig {
  const meta: Record<string, unknown> = { accountSeq };
  if (accountNo) meta["accountNo"] = accountNo;
  if (product === "us") meta["product"] = "us";

  // Identify accounts by the real account number; fall back to the accountSeq.
  const base = accountNo ?? String(accountSeq);
  const externalId = product === "us" ? `${base}-us` : base;
  return {
    id: 0,
    provider: "toss",
    env,
    externalId,
    country: product === "us" ? "US" : "KR",
    currency: product === "us" ? "USD" : "KRW",
    name: product === "us" ? `Toss ${accountSeq} US` : `Toss ${accountSeq}`,
    active: true,
    accountNo,
    meta,
  };
}

function seedSql(accounts: AccountConfig[]): string {
  const lines = [
    "-- Generated by `npm run toss:accounts -- --sql`.",
    "-- Apply with: npm run db:seed:remote",
    "",
  ];
  for (const account of accounts) {
    const meta = sqlString(JSON.stringify(account.meta));
    lines.push(
      `INSERT INTO accounts (provider, env, external_id, country, currency, name, account_no, active, meta_json)`,
      `VALUES ('${account.provider}', '${account.env}', '${sqlString(account.externalId)}', '${sqlString(account.country)}', '${sqlString(account.currency)}', '${sqlString(account.name ?? account.externalId)}', '${sqlString(account.accountNo ?? "")}', 1, '${meta}')`,
      `ON CONFLICT (provider, env, external_id) DO UPDATE SET`,
      `  name = excluded.name, account_no = excluded.account_no, active = excluded.active, country = excluded.country, currency = excluded.currency, meta_json = excluded.meta_json, updated_at = datetime('now');`,
      "",
    );
  }
  return lines.join("\n");
}

function errorDetail(error: unknown): string {
  if (isTossApiError(error)) return `${error.code ?? "?"} ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (hasFlag(args, "help") || args.includes("-h")) {
    console.log(
      [
        "Usage: npm run toss:accounts -- [options]",
        "",
        "  --accounts <list>          accountSeq values to check (default: all)",
        "  --env <prod>               Toss environment (default: prod)",
        "  --credentials-file <path>  Credentials JSON (default: .toss-credentials.json)",
        "  --base-url <url>           Reverse-proxy base URL (default: TOSS_BASE_URL)",
        "  --relay-secret <value>     X-Toss-Relay header value for the reverse proxy",
        "  --sql                      Print seed SQL instead of a report",
        "  --raw                      Print raw holdings JSON",
        "  --trades                   Also test the order history endpoint",
        "",
        "Credentials are read from the credentials file, then TOSS_CREDENTIALS",
        "(environment or .dev.vars). TOSS_BASE_URL must point at the reverse proxy.",
      ].join("\n"),
    );
    return;
  }

  const wantSql = hasFlag(args, "sql");
  setLoggerSilent(wantSql);

  const devVars = loadDevVars();
  const readEnv = (key: string) => process.env[key] ?? devVars[key];
  const environment = argValues(args, "env")[0] ?? DEFAULT_ENV;

  const credentialsFile =
    argValues(args, "credentials-file")[0] ??
    (existsSync(DEFAULT_CREDENTIALS_FILE) ? DEFAULT_CREDENTIALS_FILE : undefined);
  const credentialsJson = credentialsFile
    ? readCredentialsFile(credentialsFile)
    : readEnv("TOSS_CREDENTIALS");

  if (!credentialsJson) {
    console.error(
      `Missing Toss credentials.\n` +
        `Create ${DEFAULT_CREDENTIALS_FILE} with {"clientId","clientSecret"}, or set ` +
        `TOSS_CREDENTIALS in .dev.vars.`,
    );
    process.exitCode = 1;
    return;
  }

  const baseUrl = argValues(args, "base-url")[0] ?? readEnv("TOSS_BASE_URL") ?? TOSS_BASE_URL;
  const relaySecret = argValues(args, "relay-secret")[0] ?? readEnv("TOSS_RELAY_SECRET");

  if (credentialsFile) console.error(`Using credentials file: ${credentialsFile}`);
  console.error(`Base URL: ${baseUrl}${relaySecret ? " (relay secret set)" : ""}`);

  const credentials = parseTossCredentials(credentialsJson) as TossCredentials;
  console.error(`Client: ${maskSecret(credentials.clientId)}`);

  const cache = createFileKv();
  const client = new TossClient({
    baseUrl,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    env: environment,
    cache,
    rateLimiter: new RateLimiter(0),
    relaySecret,
  });

  const env = {
    CACHE: cache,
    TOSS_CREDENTIALS: credentialsJson,
    TOSS_BASE_URL: baseUrl,
    TOSS_RELAY_SECRET: relaySecret,
    DEBUG_TOSS: process.env["DEBUG_TOSS"],
  } as unknown as Env;
  const provider = createTossProvider(env);
  const date = kstDate();

  const explicit = new Set(splitCandidates(argValues(args, "accounts")));
  const wantRaw = hasFlag(args, "raw");
  const wantTrades = hasFlag(args, "trades");

  let accounts: TossAccount[];
  try {
    accounts = await client.request<TossAccount[]>("GET", TOSS_PATHS.accounts);
  } catch (error) {
    console.error(`FAIL /accounts (${errorDetail(error)})`);
    process.exitCode = 1;
    return;
  }

  const selected = accounts.filter(
    (account) => explicit.size === 0 || (account.accountSeq !== undefined && explicit.has(String(account.accountSeq))),
  );
  if (selected.length === 0) {
    console.error("No matching accounts. Pass --accounts or check Open API access.");
    process.exitCode = 1;
    return;
  }

  const verified: AccountConfig[] = [];

  for (const account of selected) {
    const accountSeq = account.accountSeq;
    if (accountSeq === undefined) continue;
    const accountNo = account.accountNo ?? null;
    process.stderr.write(
      `Checking accountSeq ${accountSeq} (${account.accountType ?? "?"}, no ${accountNo ? maskSecret(accountNo) : "-"}) ... `,
    );

    try {
      const overview = await client.request<TossHoldingsOverview>("GET", TOSS_PATHS.holdings, {
        accountSeq,
      });
      const itemCount = overview.items?.length ?? 0;
      console.error(
        `OK  (holdings: ${itemCount}, krw eval: ${overview.marketValue?.amount?.krw ?? "-"}, usd eval: ${overview.marketValue?.amount?.usd ?? "-"})`,
      );

      if (wantRaw) {
        console.log(JSON.stringify({ accountSeq, overview }, null, 2));
      }

      for (const product of ["stock", "us"] as const) {
        const row = toAccount(accountSeq, accountNo, environment, product);
        let balance: BalanceResult;
        try {
          balance = await provider.getBalance(row, date);
        } catch (error) {
          console.error(`      ${product} balance FAIL (${errorDetail(error)})`);
          continue;
        }
        verified.push(row);
        console.error(
          `      ${product}: holdings ${balance.holdings.length}, deposit ${balance.summary.depositTotal ?? "-"}`,
        );

        if (wantTrades) {
          try {
            const trades = await provider.getTrades(row, addDays(date, -6), date);
            console.error(`      ${product}: trades ${trades.length}`);
          } catch (error) {
            console.error(`      ${product}: trades FAIL (${errorDetail(error)})`);
          }
        }
      }
    } catch (error) {
      console.error(`FAIL (${errorDetail(error)})`);
    }
  }

  console.error(`\nVerified ${verified.length} row(s) from ${selected.length} account(s).`);

  if (wantSql) {
    if (verified.length > 0) console.log(`\n${seedSql(verified)}`);
    return;
  }

  if (verified.length === 0) process.exitCode = 1;
}

await main();
