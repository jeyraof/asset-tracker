/**
 * Discovers and verifies Kiwoom accounts against the live API and (optionally)
 * prints SQL to register them. Each `.kiwoom-credentials.json` entry is one app
 * key bound to one account, so `ka00001` (계좌번호조회) reveals the account number.
 *
 * Requests go through the Caddy reverse proxy (KIWOOM_BASE_URL) so they egress
 * from the IP-whitelisted host.
 *
 * Usage:
 *   npm run kiwoom:accounts -- --sql > seeds/accounts.sql
 *   npm run kiwoom:accounts -- --accounts 12345678 --trades
 *   npm run kiwoom:accounts -- --credentials-file .kiwoom-credentials.json
 *
 * Credentials are read from the credentials file first, then KIWOOM_CREDENTIALS
 * (environment or .dev.vars).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { addDays, kstDate } from "../src/lib/dates";
import { setLoggerSilent } from "../src/lib/logger";
import { RateLimiter } from "../src/lib/rateLimit";
import { KiwoomClient } from "../src/providers/kiwoom/client";
import { parseKiwoomCredentials, type KiwoomCredentials } from "../src/providers/kiwoom/credentials";
import { isKiwoomApiError } from "../src/providers/kiwoom/errors";
import { createKiwoomProvider } from "../src/providers/kiwoom";
import {
  KIWOOM_API_IDS,
  KIWOOM_BASE_URLS,
  KIWOOM_PATHS,
  normalizeKiwoomEnv,
} from "../src/providers/kiwoom/tr-ids";
import type { KiwoomAccountListResponse } from "../src/providers/kiwoom/types";
import type { AccountConfig, BalanceResult } from "../src/domain/types";
import type { Env } from "../src/env";

const DEFAULT_ENV = "prod";
const TOKEN_CACHE_PATH = ".kiwoom-token-cache.json";
const DEFAULT_CREDENTIALS_FILE = ".kiwoom-credentials.json";

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

/** File-backed KV shim so repeated local runs reuse the Kiwoom access token. */
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
  acctNo: string,
  credKey: string,
  env: string,
  tradesDisabled: boolean,
  product: "stock" | "gold" | "us",
): AccountConfig {
  const meta: Record<string, unknown> = { acctNo, credKey };
  let externalId = acctNo;
  let country = "KR";
  let currency = "KRW";
  if (product === "gold") meta["product"] = "gold";
  if (product === "us") {
    meta["product"] = "us";
    externalId = `${acctNo}-us`;
    country = "US";
    currency = "USD";
  }
  if (tradesDisabled) meta["trades"] = false;
  return {
    id: 0,
    provider: "kiwoom",
    env,
    externalId,
    country,
    currency,
    name: product === "us" ? `Kiwoom ${acctNo} US` : `Kiwoom ${acctNo}`,
    active: true,
    accountNo: acctNo,
    meta,
  };
}

function seedSql(accounts: AccountConfig[]): string {
  const lines = [
    "-- Generated by `npm run kiwoom:accounts -- --sql`.",
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (hasFlag(args, "help") || args.includes("-h")) {
    console.log(
      [
        "Usage: npm run kiwoom:accounts -- [options]",
        "",
        "  --accounts <list>          Credentials-file keys to check (default: all)",
        "  --env <prod|mock>          Kiwoom environment (default: prod)",
        "  --credentials-file <path>  Per-account credentials JSON (default: .kiwoom-credentials.json)",
        "  --base-url <url>           Reverse-proxy base URL (default: KIWOOM_BASE_URL or the env default)",
        "  --relay-secret <value>     X-Kiwoom-Relay header value for the reverse proxy",
        "  --no-trades <list>         Accounts to mark meta.trades=false (skip trade sync)",
        "  --no-us                    Skip the US (미국주식) product probe",
        "  --sql                      Print seed SQL instead of a report",
        "  --raw                      Print raw balance summary JSON",
        "  --trades                   Also test the order-fills endpoint",
        "",
        "Credentials are read from the credentials file, then KIWOOM_CREDENTIALS",
        "(environment or .dev.vars). KIWOOM_BASE_URL must point at the reverse proxy.",
      ].join("\n"),
    );
    return;
  }

  const wantSql = hasFlag(args, "sql");
  setLoggerSilent(wantSql);

  const devVars = loadDevVars();
  const readEnv = (key: string) => process.env[key] ?? devVars[key];
  const kiwoomEnv = argValues(args, "env")[0] ?? readEnv("KIWOOM_ENV") ?? DEFAULT_ENV;
  const environment = normalizeKiwoomEnv(kiwoomEnv);

  const credentialsFile =
    argValues(args, "credentials-file")[0] ??
    (existsSync(DEFAULT_CREDENTIALS_FILE) ? DEFAULT_CREDENTIALS_FILE : undefined);
  const credentialsJson = credentialsFile
    ? readCredentialsFile(credentialsFile)
    : readEnv("KIWOOM_CREDENTIALS");

  if (!credentialsJson) {
    console.error(
      `Missing Kiwoom credentials.\n` +
        `Create ${DEFAULT_CREDENTIALS_FILE} with per-account appkey/appsecret, or set ` +
        `KIWOOM_CREDENTIALS in .dev.vars.`,
    );
    process.exitCode = 1;
    return;
  }

  const baseUrl =
    argValues(args, "base-url")[0] ?? readEnv("KIWOOM_BASE_URL") ?? KIWOOM_BASE_URLS[environment];
  const relaySecret = argValues(args, "relay-secret")[0] ?? readEnv("KIWOOM_RELAY_SECRET");

  if (credentialsFile) console.error(`Using credentials file: ${credentialsFile}`);
  console.error(`Base URL: ${baseUrl}${relaySecret ? " (relay secret set)" : ""}`);

  const credentialMap = parseKiwoomCredentials(credentialsJson);
  const env = {
    CACHE: createFileKv(),
    KIWOOM_CREDENTIALS: credentialsJson,
    KIWOOM_ENV: environment,
    KIWOOM_BASE_URL: baseUrl,
    KIWOOM_RELAY_SECRET: relaySecret,
    DEBUG_KIWOOM: process.env["DEBUG_KIWOOM"],
  } as unknown as Env;

  const provider = createKiwoomProvider(env);
  const date = kstDate();

  const explicit = new Set(
    splitCandidates(argValues(args, "accounts")).map((value) => value.replace(/\D/g, "")),
  );
  const noTrades = new Set(
    splitCandidates(argValues(args, "no-trades")).map((value) => value.replace(/\D/g, "")),
  );
  const noUs = hasFlag(args, "no-us");

  const entries: [string, KiwoomCredentials][] = [...credentialMap.entries()].filter(
    ([key]) => explicit.size === 0 || explicit.has(key),
  );
  if (entries.length === 0) {
    console.error("No matching credentials. Pass --accounts or check the credentials file.");
    process.exitCode = 1;
    return;
  }

  const wantRaw = hasFlag(args, "raw");
  const wantTrades = hasFlag(args, "trades");
  const verified: AccountConfig[] = [];

  for (const [credKey, credentials] of entries) {
    process.stderr.write(`Checking ${credKey} (key ${maskSecret(credentials.appkey)}) ... `);
    try {
      const discovery = new KiwoomClient({
        baseUrl,
        appkey: credentials.appkey,
        appsecret: credentials.appsecret,
        env: environment,
        cache: env.CACHE,
        rateLimiter: new RateLimiter(0),
        relaySecret,
      });
      const list = await discovery.request<KiwoomAccountListResponse>(
        KIWOOM_API_IDS.accountList,
        KIWOOM_PATHS.account,
        {},
      );
      const acctNo = (list.body.acctNo ?? credKey).replace(/\D/g, "") || credKey;
      const tradesDisabled = noTrades.has(credKey) || noTrades.has(acctNo);

      // Product detection: domestic stock (kt00018), US (ust21070), gold (kt50020).
      const products: ("stock" | "us" | "gold")[] = [];
      try {
        await discovery.request(KIWOOM_API_IDS.balance, KIWOOM_PATHS.account, {
          qry_tp: "1",
          dmst_stex_tp: "KRX",
        });
        products.push("stock");
      } catch {
        // not a domestic-stock account
      }
      if (!noUs) {
        try {
          await discovery.request(KIWOOM_API_IDS.usBalance, KIWOOM_PATHS.usAccount, {});
          products.push("us");
        } catch {
          // US trading not enabled for this account
        }
      }
      if (products.length === 0) {
        await discovery.request(KIWOOM_API_IDS.goldBalance, KIWOOM_PATHS.account, {});
        products.push("gold");
      }

      for (const product of products) {
        const account = toAccount(acctNo, credKey, environment, tradesDisabled, product);

        let balance: BalanceResult;
        try {
          balance = await provider.getBalance(account, date);
        } catch (error) {
          const detail = isKiwoomApiError(error)
            ? `${error.returnCode ?? "?"} ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error);
          console.error(`FAIL ${product} (${detail})`);
          continue;
        }

        verified.push(account);
        const summary = balance.summary;
        console.error(
          `OK  (acct ${acctNo}, ${product}, holdings: ${balance.holdings.length}, deposit: ${summary.depositTotal ?? "-"}, total: ${summary.totalEvalAmount ?? "-"})`,
        );

        if (wantRaw) {
          console.log(
            JSON.stringify(
              { externalId: account.externalId, summary: summary.raw, holdings: balance.holdings.map((h) => h.raw) },
              null,
              2,
            ),
          );
        }

        if (wantTrades && !tradesDisabled) {
          try {
            const trades = await provider.getTrades(account, addDays(date, -6), date);
            console.error(`      trades: ${trades.length}`);
          } catch (error) {
            const detail = isKiwoomApiError(error)
              ? `${error.returnCode ?? "?"} ${error.message.trim()}`
              : error instanceof Error
                ? error.message
                : String(error);
            console.error(`      trades FAIL (${detail})`);
          }
        }
      }
    } catch (error) {
      const detail = isKiwoomApiError(error)
        ? `${error.returnCode ?? "?"} ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
      console.error(`FAIL (${detail})`);
    }
  }

  console.error(`\nVerified ${verified.length} account(s) from ${entries.length} credential(s).`);

  if (wantSql) {
    if (verified.length > 0) console.log(`\n${seedSql(verified)}`);
    return;
  }

  if (verified.length === 0) process.exitCode = 1;
}

await main();
