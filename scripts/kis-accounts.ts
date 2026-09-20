/**
 * Verifies KIS accounts against the live API and (optionally) prints SQL to
 * register them. KIS has no "list my accounts" endpoint, so this tool works
 * from candidate account numbers you know (from the KIS Developers portal).
 *
 * Usage:
 *   npm run kis:accounts -- --accounts 12345678-01
 *   npm run kis:accounts -- --accounts 12345678-01,87654321-01
 *   npm run kis:accounts -- --cano 12345678            # probes product codes
 *   npm run kis:accounts -- --accounts 12345678-01 --sql > seeds/accounts.sql
 *
 * Credentials are read from .dev.vars first, then process.env.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { addDays, kstDate } from "../src/lib/dates";
import { setLoggerSilent } from "../src/lib/logger";
import { isKisApiError } from "../src/providers/kis/errors";
import { createKisProvider } from "../src/providers/kis";
import { parseKisCredentials, resolveKisCredentials } from "../src/providers/kis/credentials";
import type { AccountConfig } from "../src/domain/types";
import type { Env } from "../src/env";

const PRODUCT_CODES = ["01", "22", "29", "03", "08"];
const DEFAULT_ENV = "prod";
const TOKEN_CACHE_PATH = ".kis-token-cache.json";
const DEFAULT_CREDENTIALS_FILE = ".kis-credentials.json";

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

/**
 * File-backed KV shim so repeated local runs reuse the KIS access token
 * (issuing a token notifies the account holder and is limited to 1/min).
 */
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

/** Accepts "12345678-01", "1234567801", or "12345678" (uses the fallback). */
function normalizeAccount(input: string, fallbackPrdt: string): { cano: string; prdtCd: string } | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return { cano: digits.slice(0, 8), prdtCd: digits.slice(8, 10) };
  if (digits.length === 8) return { cano: digits, prdtCd: fallbackPrdt };
  return null;
}

function toAccount(cano: string, prdtCd: string, env: string, tradesDisabled: boolean): AccountConfig {
  const externalId = `${cano}-${prdtCd}`;
  return {
    id: 0,
    provider: "kis",
    env,
    externalId,
    country: "KR",
    currency: "KRW",
    name: `KIS ${externalId}`,
    active: true,
    meta: tradesDisabled ? { cano, prdtCd, trades: false } : { cano, prdtCd },
  };
}

function sqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function seedSql(accounts: AccountConfig[]): string {
  const lines = [
    "-- Generated by `npm run kis:accounts -- --sql`.",
    "-- Apply with: npm run db:seed:remote",
    "",
  ];
  for (const account of accounts) {
    const meta = sqlString(JSON.stringify(account.meta));
    lines.push(
      `INSERT INTO accounts (provider, env, external_id, country, currency, name, active, meta_json)`,
      `VALUES ('${account.provider}', '${account.env}', '${account.externalId}', 'KR', 'KRW', '${sqlString(account.name ?? account.externalId)}', 1, '${meta}')`,
      `ON CONFLICT (provider, env, external_id) DO UPDATE SET`,
      `  name = excluded.name, active = excluded.active, meta_json = excluded.meta_json, updated_at = datetime('now');`,
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
        "Usage: npm run kis:accounts -- [options]",
        "",
        "  --accounts <list>          Comma/space separated accounts (12345678-01 or 1234567801)",
        "  --cano <8 digits>          Probe product codes (01,22,29,03,08) for this account",
        "  --env <prod|vts>           KIS environment (default: prod)",
        "  --credentials-file <path>  Per-account credentials JSON (default: .kis-credentials.json)",
        "  --no-trades <list>         Accounts to mark meta.trades=false (skip trade sync)",
        "  --sql                      Print seed SQL instead of a report",
        "  --raw                      Print the raw balance summary JSON",
        "  --trades                   Also test the trade-history endpoint",
        "",
        "Credentials are read from the credentials file, then KIS_CREDENTIALS",
        "(environment or .dev.vars).",
        "Without --accounts/--cano, KIS_ACCOUNTS from the environment is used.",
      ].join("\n"),
    );
    return;
  }

  // In --sql mode stdout is reserved for the SQL, so logs and status go away
  // (logger) or to stderr (below).
  const wantSql = hasFlag(args, "sql");
  setLoggerSilent(wantSql);

  const devVars = loadDevVars();
  const readEnv = (key: string) => process.env[key] ?? devVars[key];
  const kisiEnv = argValues(args, "env")[0] ?? readEnv("KIS_ENV") ?? DEFAULT_ENV;

  const credentialsFile =
    argValues(args, "credentials-file")[0] ??
    (existsSync(DEFAULT_CREDENTIALS_FILE) ? DEFAULT_CREDENTIALS_FILE : undefined);
  const credentialsJson = credentialsFile
    ? readCredentialsFile(credentialsFile)
    : readEnv("KIS_CREDENTIALS");

  if (!credentialsJson) {
    console.error(
      `Missing KIS credentials.\n` +
        `Create ${DEFAULT_CREDENTIALS_FILE} with per-account appkey/appsecret, or set ` +
        `KIS_CREDENTIALS in .dev.vars.`,
    );
    process.exitCode = 1;
    return;
  }

  if (credentialsFile) {
    console.error(`Using credentials file: ${credentialsFile}`);
  }

  const credentialMap = parseKisCredentials(credentialsJson);

  const env = {
    CACHE: createFileKv(),
    KIS_CREDENTIALS: credentialsJson,
    KIS_ENV: kisiEnv,
    DEBUG_KIS: process.env["DEBUG_KIS"],
  } as unknown as Env;

  const provider = createKisProvider(env);
  const date = kstDate();

  const explicit = splitCandidates(argValues(args, "accounts"));
  const canoProbes = splitCandidates(argValues(args, "cano"));
  const fromEnv = splitCandidates(
    explicit.length === 0 && canoProbes.length === 0 ? [readEnv("KIS_ACCOUNTS") ?? ""] : [],
  );

  const candidates: { cano: string; prdtCd: string }[] = [];
  for (const value of [...explicit, ...fromEnv]) {
    const parsed = normalizeAccount(value, "01");
    if (parsed) candidates.push(parsed);
    else console.warn(`Skipping "${value}" (expected 8 or 10 digits).`);
  }
  for (const cano of canoProbes) {
    const parsed = normalizeAccount(cano, "01");
    if (!parsed) {
      console.warn(`Skipping --cano "${cano}" (expected 8 digits).`);
      continue;
    }
    for (const prdtCd of PRODUCT_CODES) candidates.push({ cano: parsed.cano, prdtCd });
  }

  if (candidates.length === 0) {
    console.error("No candidate accounts. Pass --accounts or --cano (see --help).");
    process.exitCode = 1;
    return;
  }

  const noTrades = new Set(
    splitCandidates(argValues(args, "no-trades")).map((value) => value.replace(/\D/g, "")),
  );
  if (noTrades.size > 0) {
    const matched = new Set<string>();
    for (const { cano, prdtCd } of candidates) {
      matched.add(cano);
      matched.add(`${cano}${prdtCd}`);
    }
    for (const value of noTrades) {
      if (!matched.has(value)) console.warn(`--no-trades "${value}" matched no candidate account.`);
    }
  }

  const verified: AccountConfig[] = [];
  const wantRaw = hasFlag(args, "raw");
  const wantTrades = hasFlag(args, "trades");
  for (const { cano, prdtCd } of candidates) {
    const tradesDisabled = noTrades.has(cano) || noTrades.has(`${cano}${prdtCd}`);
    const account = toAccount(cano, prdtCd, kisiEnv, tradesDisabled);
    const credentials = resolveKisCredentials(credentialMap, account);
    const label = credentials ? `key ${maskSecret(credentials.appkey)}` : "no credentials";
    process.stderr.write(`Checking ${account.externalId} (${label}) ... `);
    try {
      const balance = await provider.getBalance(account, date);
      verified.push(account);
      const summary = balance.summary;
      console.error(
        `OK  (holdings: ${balance.holdings.length}, deposit: ${summary.depositTotal ?? "-"}, total: ${summary.totalEvalAmount ?? "-"})`,
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
      if (wantTrades) {
        try {
          const trades = await provider.getTrades(account, addDays(date, -6), date);
          console.error(`      trades: ${trades.length}`);
        } catch (error) {
          const detail = isKisApiError(error)
            ? `${error.msgCd ?? "?"} ${error.message.trim()}`
            : error instanceof Error
              ? error.message
              : String(error);
          console.error(`      trades FAIL (${detail})`);
        }
      }
    } catch (error) {
      const detail = isKisApiError(error)
        ? `${error.msgCd ?? "?"} ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
      console.error(`FAIL (${detail})`);
    }
  }

  console.error(`\nVerified ${verified.length}/${candidates.length} account(s).`);

  if (wantSql) {
    if (verified.length > 0) console.log(`\n${seedSql(verified)}`);
    if (verified.length > 0) {
      console.error(
        `\nNext: upload credentials with \`wrangler secret put KIS_CREDENTIALS < ${credentialsFile ?? DEFAULT_CREDENTIALS_FILE}\`.`,
      );
    }
    return;
  }

  if (verified.length === 0) process.exitCode = 1;
}

await main();
