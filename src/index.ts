import type { Env } from "./env";
import { etDate, isValidDateString, kstDate } from "./lib/dates";
import { logger } from "./lib/logger";
import { runSync } from "./sync/orchestrator";
import { listActiveAccounts, listRecentRuns } from "./db/repo";
import { listKnownProviders } from "./providers/registry";

const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 90;

/**
 * US accounts run separately after the US regular session closes: UTC Mon-Fri
 * 22:00 = KST Tue-Sat 07:00. The KRX run stays at UTC Sun-Thu 16:00 (KST 01:00).
 */
const US_CRON = "0 22 * * 2-6";
const KRX_PRODUCTS = ["stock", "gold"] as const;
const US_PRODUCTS = ["us"] as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isAuthorized(request: Request, env: Env): boolean {
  return Boolean(env.ADMIN_TOKEN) && request.headers.get("x-admin-token") === env.ADMIN_TOKEN;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickProducts(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const products = value
    .split(",")
    .map((product) => product.trim())
    .filter(Boolean);
  return products.length > 0 ? products : undefined;
}

async function handleSync(request: Request, url: URL, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown> = {};
  if (request.method === "POST") {
    try {
      const parsed = await request.json();
      if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    } catch {
      body = {};
    }
  }

  const date = pickString(body["date"]) ?? pickString(url.searchParams.get("date")) ?? kstDate();
  if (!isValidDateString(date)) return json({ error: `invalid date: ${date}` }, 400);

  const lookbackInput =
    pickNumber(body["lookbackDays"]) ?? Number(url.searchParams.get("lookbackDays") ?? NaN);
  const lookbackDays = Number.isFinite(lookbackInput)
    ? Math.min(MAX_LOOKBACK_DAYS, Math.max(1, Math.trunc(lookbackInput)))
    : DEFAULT_LOOKBACK_DAYS;

  const provider = pickString(body["provider"]) ?? pickString(url.searchParams.get("provider"));
  const products =
    pickProducts(body["products"]) ?? pickProducts(url.searchParams.get("products"));

  const report = await runSync(env, { date, lookbackDays, provider, products, source: "http" });
  return json(report, report.status === "failed" ? 502 : 200);
}

export default {
  async scheduled(controller, env, ctx) {
    const scheduledAt = new Date(controller.scheduledTime);
    const isUs = controller.cron === US_CRON;
    // US accounts snapshot on the just-closed US session date (ET), not KST.
    const date = isUs ? etDate(scheduledAt) : kstDate(scheduledAt);
    const products = isUs ? [...US_PRODUCTS] : [...KRX_PRODUCTS];

    ctx.waitUntil(
      runSync(env, { date, products, source: "cron" }).catch((error: unknown) => {
        logger.error("scheduled sync failed", {
          date,
          products,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({
        service: "asset-tracker",
        ok: true,
        time: new Date().toISOString(),
        todayKst: kstDate(),
        providers: listKnownProviders(),
      });
    }

    if (request.method === "POST" && url.pathname === "/sync") {
      return handleSync(request, url, env);
    }

    if (request.method === "GET" && url.pathname === "/accounts") {
      if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
      const accounts = await listActiveAccounts(env.DB, pickString(url.searchParams.get("provider")));
      return json({ accounts });
    }

    if (request.method === "GET" && url.pathname === "/runs") {
      if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
      const runs = await listRecentRuns(env.DB, 20);
      return json({ runs });
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
