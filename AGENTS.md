# AGENTS.md

Guidance for working in `asset-tracker`.

## Commands

- `pnpm test` — vitest (must pass before finishing).
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm db:migrate:local` / `pnpm db:migrate:remote` — apply D1 migrations.
- `pnpm run deploy` — deploy the Worker (`pnpm deploy` collides with pnpm's
  built-in deploy command).

Always run `pnpm test` and `pnpm typecheck` after changes.

## Architecture rules

- `src/domain/types.ts` and `src/sync/` must stay **provider-agnostic**. No KIS
  fields, TR_IDs, or response shapes leak into them.
- Broker-specific code lives under `src/providers/<id>/`. Map raw responses to
  the normalized types in `endpoints/*.ts`; never return raw KIS objects from a
  provider method except in the `raw` escape hatch.
- To add a broker: create `src/providers/<id>/index.ts` implementing
  `BrokerProvider`, then register it in `src/providers/registry.ts`. Kiwoom
  (`src/providers/kiwoom/`) mirrors the KIS layout.
- Quotes are fetched **once per instrument**: `src/sync/quoteSources.ts`
  (`resolveQuoteCandidates`) assigns each `market:symbol` one ordered list of
  providers — holders that are available and support the market, ordered by
  `quoteProviderPriority()` in the registry (`kis` → `kiwoom` → `toss`). The
  orchestrator batches by the first candidate and retries a failed provider's
  instruments against the next candidate. Never go back to a per-provider
  instrument map: the same symbol held at two brokers would be fetched twice.
- Quotes are pinned to the **KRX regular session** (09:00–15:30 KST). KIS sends
  `FID_COND_MRKT_DIV_CODE=J` (KRX; `NX`=NXT, `UN`=통합) and Kiwoom sends the
  plain 6-digit code (KRX; `_NX`=NXT, `_AL`=통합); `stripSymbol` drops those
  suffixes. KRX/NXT pre/after-market prices are ignored; the KRX 15:30 close is
  the official close. Prices stay unadjusted (KIS `FID_ORG_ADJ_PRC=1`, Kiwoom
  `upd_stkpc_tp=0`), so both providers agree and match real fills.
- Kiwoom requests must egress from the IP-whitelisted host: the client calls
  `KIWOOM_BASE_URL` (a Caddy reverse proxy, see `deploy/caddy/kiwoom.caddy`) and
  sends `KIWOOM_RELAY_SECRET` as `X-Kiwoom-Relay`. Do **not** try to tunnel
  through a forward proxy from the Worker: `cloudflare:sockets` `startTls()`
  after `CONNECT` and `node:tls` both fail on the production edge (workerd
  #6903 — SNI is dropped).
- Toss (`src/providers/toss/`) differs from KIS/Kiwoom: a **single user-level
  OAuth2 client** (`TOSS_CREDENTIALS`) serves all accounts, addressed with the
  `X-Tossinvest-Account: <accountSeq>` header (stored in `meta.accountSeq`). One
  Toss account holds both KR and US, so it is registered as **two rows** —
  `<accountNo>` (KRX) and `<accountNo>-us` (US, `meta.product="us"`) — matching
  the per-product cron split. It also requires an IP allowlist, so it egresses
  via `TOSS_BASE_URL` (a Caddy proxy, `deploy/caddy/toss.caddy`) sending
  `TOSS_RELAY_SECRET` as `X-Toss-Relay`.
- DB access goes through `src/db/repo.ts`. Keep SQL there, not in sync/providers.
- New tables/columns require a new file in `migrations/`; never edit an applied
  migration. The schema carries `provider`/`market`/`country`/`currency` so new
  brokers and countries need no schema change.
- `accounts.alias` is a user-set display name; `resolveAccountName` (in
  `src/lib/accounts.ts`) falls back to `name`, then `externalId`. Tooling/seeds
  never write `alias`, so manual values survive re-registration.
- `accounts.account_no` is the broker's **real account number** (PII): KIS
  `CANO-PRDT`, Kiwoom/Toss 10-digit account number. Tooling/seeds write it; the
  column is populated by deriving from `external_id`/`meta` (migration `0006`).
  Never commit or log it, and keep real values out of fixtures/docs.
- Re-running a sync must be idempotent: use `ON CONFLICT DO UPDATE`. Holdings for
  a day are replaced (delete + insert in one `db.batch`) to drop sold positions.
- Accounts opt out of trade sync with `meta.trades = false` (checked by
  `tradesEnabled` in `src/sync/orchestrator.ts`), so provider-agnostic code never
  hardcodes a broker's unsupported-endpoint error.
- Scheduled runs are split by account product (`productOf` / `SyncOptions.products`):
  the KRX run (`stock`+`gold`) fires at KST 20:30, and the US run (`us`) fires at
  KST 07:00 after the US regular close. `src/index.ts` picks the date/`products`
  from `controller.cron`; the US run uses the **ET** session date (`etDate`), not KST.
- FX is a **separate task** (`src/sync/fx.ts`, `syncFxRates`) stored in `fx_rates`.
  It runs on its own cron at **KST Mon-Fri 12:00** (UTC `0 3 * * 2-6`, after Korea
  Eximbank publishes ~11:00) and via `POST /sync/fx`; its failure never affects a
  holdings snapshot. The source is **Korea Eximbank's 매매기준율** (`deal_bas_r`) in
  `src/fx/koreaexim.ts`, implementing the market-data `FxSource` — **not** a
  `BrokerProvider` (no accounts). Keep FX source-agnostic: no broker/`koreaexim`
  field names outside `src/fx/`. `fx_rates.date` is the **actual quote (business)
  day**; the source searches back up to 7 days for the latest published day
  (weekends/holidays have none). US snapshots are keyed to the ET session date,
  which is a day apart from the KST quote day — keep that in mind when valuing US
  holdings with FX (`created_at` holds the exact UTC instant).

## Conventions

- TypeScript strict; no `any` unless unavoidable. No comments unless they add
  non-obvious context.
- All dates crossing the provider boundary are `YYYY-MM-DD`; KIS compact dates
  are converted with `src/lib/dates.ts`. KST is `UTC+9`.
- Keep the KIS call rate conservative (300 ms serialized). Add jittered backoff
  for `EGW00201`; invalidate the KV token cache and retry once on token errors.
- KIS credentials are **per account**: `KIS_CREDENTIALS` is a JSON secret keyed
  by account `externalId` (falling back to the 8-digit `CANO`). Resolve via
  `src/providers/kis/credentials.ts`; keep secrets out of `AccountConfig`, the
  D1 `accounts` table, and the `/accounts` API response.
- Secrets (`KIS_CREDENTIALS`, `ADMIN_TOKEN`) are wrangler secrets, never
  committed. `seeds/accounts.sql`, `.dev.vars`, and `.kis-credentials.json` are
  gitignored. There is no global/legacy KIS app key.
- Kiwoom credentials are per account too: `KIWOOM_CREDENTIALS` is a JSON secret
  keyed by the credentials-file key, resolved by `externalId`, then
  `meta.acctNo`, then `meta.credKey` (`src/providers/kiwoom/credentials.ts`).
  Kiwoom tokens are cached per app key (`kiwoom:token:<env>:<credId>`).
- Tests use fakes for `fetch` and `KVNamespace` (see `test/helpers.ts`); do not
  make real network calls in tests.

## Secrets & PII (public repo)

This repository is **public**. Nothing sensitive may appear in code, docs, tests,
fixtures, or commit messages/history. See `SECURITY.md` for the full policy.

- **Never commit** real account numbers or broker external ids (KIS `CANO-PRDT`,
  Kiwoom account numbers), credentials/tokens/API keys, real hostnames or VPS
  domains, D1/KV ids, or personal data (emails, names, phone numbers).
- **Secrets** live only as wrangler secrets (`KIS_CREDENTIALS`,
  `KIWOOM_CREDENTIALS`, `KIWOOM_RELAY_SECRET`, `TOSS_CREDENTIALS`,
  `TOSS_RELAY_SECRET`, `KOREAEXIM_API_KEY`, `ADMIN_TOKEN`); locally in gitignored
  files (`.dev.vars`, `*.credentials.json`, token caches). `wrangler.jsonc` and
  generated `seeds/*.sql` stay gitignored.
- **Test fixtures**: obviously fake values only (`11111111-01`, `KEY-A`,
  `TESTKEY`). Never copy values from prod D1 rows, API responses, or `raw_json`.
- **Docs/examples**: placeholders only (`<subdomain>`, `example.com`,
  `<8-digit-CANO>`, `<d1-database-id>`, `<RELAY_SECRET>`).
- **Logging**: never log a full URL carrying a key in the query string (e.g.
  Korea Eximbank `authkey`); log the host/path or a masked value.
- **Before every commit**: review `git diff --cached` for the patterns above.
- **If something leaks**: rotate it, purge it from history
  (`git filter-repo`/`filter-branch`) and force-push; treat any pushed value as
  compromised.

## Gotchas

- KIS returns HTTP 200 with `rt_cd != "0"` on logical errors — always check.
- Balance pagination uses the response header `tr_cont` (`M`/`F` = more) and
  lowercase response context fields (`ctx_area_fk100`), while requests send
  uppercase params (`CTX_AREA_FK100`).
- Account numbers are strings with leading zeros (`ACNT_PRDT_CD = "01"`).
- Trade history keeps only buys/sells with `tot_ccld_qty > 0`.
- KIS tokens are bound to the issuing app key, so the token cache key must
  include a per-credential id (`kis:token:<env>:<credentialId>`, a short
  SHA-256 of the app key). Never share a token across accounts.
- Never reuse one account's app key for another: KIS ties an app key to an
  account, and `inquire-daily-ccld` returns `APTR0058` ("ID와 사용자정보가
  상이") on a mismatch even though `inquire-balance` may work.
- Trading endpoints (`inquire-daily-ccld`) can also fail with `APBK1744` for
  retirement-pension (퇴직연금) accounts, which do not support the service at
  all. Set `meta.trades = false` (via `pnpm kis:accounts --no-trades`) for these
  accounts so the endpoint is skipped. Trades are otherwise best-effort and must
  never fail the balance snapshot; a failure is recorded as `:trades` in the run
  report. `pnpm kis:accounts -- --trades` checks this per account.
- Never call `fetch` as an object method in the Worker runtime (e.g.
  `this.fetchImpl(...)`) — it throws "Illegal invocation". Call via a local
  reference.
- Kiwoom returns HTTP 200 with `return_code != 0` on logical errors — always
  check. Numbers are zero-padded signed strings and symbols carry an `A`/`J`/`Q`
  prefix (`A005930`, `A0199C0` — strip only the prefix, keep letters in the code).
  An empty trade range is `501724` (관련자료가없습니다), treated as no trades.
- Kiwoom trades use date-range calls (stock `kt00015`, gold `kt50032`, US
  `ust21100`) — one request per account, which keeps the Worker under the
  50-subrequest limit. Do not go back to per-day `kt00007`/`kt50031` loops. The
  side is `io_tp_nm` (stock) / `rmrk_nm` (gold, US). `ka10081`/`ka50081`/
  `usa06012` use `upd_stkpc_tp=0`.
- Gold-spot accounts (`meta.product="gold"`) use `kt50020`/`kt50032`/`ka50081`
  and `market="KRX-GOLD"`; `kiwoom:accounts` detects them when `kt00018` fails
  with `400114`.
- Kiwoom US (`meta.product="us"`) uses `/api/us/*` (`ust21070` balance,
  `ust21100` trades, `usa10098` exchange, `usa06012` daily chart) with a
  `result_list` envelope. Accounts are extra rows (`external_id="<acctNo>-us"`,
  `country="US"`, `currency="USD"`, `market="US"`). Neither the balance nor the
  trades carry an exchange, so quotes resolve `stex_tp` (`ND`/`NY`/`NA`) via
  `usa10098` first (a `ND` guess fails with `1903` for NYSE/AMEX names). The US
  run fires at KST 07:00, which is still after-hours, so holdings are re-valued
  at the regular-session close (candle `dt == date`) instead of the broker's
  `now_pric`. Never run US tickers through `stripSymbol`: 7-char tickers
  starting with `A`/`J`/`Q` would be truncated.
- Verified live (2026-09-20): `ust21100` requires `krw_repl_skip_yn` (send `"N"`;
  the spec marks it optional but the API returns `1511` without it), and
  `usa06012`'s `strt_dt` is an **inclusive base date** (candles come back
  descending from it) — send `strt_dt=date`, not the window start, or the
  lookback window silently comes back empty.
- FX comes from **Korea Eximbank's 매매기준율** (`src/fx/koreaexim.ts`,
  `data=AP01`, `deal_bas_r`), not a broker. It is published ~11:00 KST on business
  days, so the FX cron runs KST 12:00 (UTC `0 3 * * 2-6`) and the source searches
  back up to 7 days when a date has no data. The authkey goes in the query string
  (`KOREAEXIM_API_KEY`); never log the full URL. `result` codes: 2=data, 3=auth,
  4=daily quota. Only USD→KRW is mapped. FX runs are recorded in `sync_runs` with
  `task='fx'`, `provider='koreaexim'` (errors in `sync_errors`) so the run history
  is unified across brokers and FX.
- `sync_runs.task` distinguishes run kinds: `'sync'` (broker) or `'fx'`. The
  `provider` column holds a broker id when `task='sync'` and an FX source id when
  `task='fx'`. `runSync` finishes the run in a `finally` (status `failed` on an
  unexpected error, `finished_at` always set); `syncFxRates` records its own run.
- Kiwoom REST does **not** expose US fractional (소수점) holdings yet. `ust21070`/  `ust21170` return whole shares only (`poss_qty` is an integer); fractional
  quantities appear only in trades (`ust21100` `deal_qty`, kind `소수점매매`).
  The fractional *value* is folded into the aggregate endpoints (`ust21120`/
  `ust21121`/`ust21131`/`ust21132`), so `ust21070`'s `tot_evlt_amt` can be lower
  than the aggregate (observed 2026-09-20: 4063.72 vs 4247.50 USD). Do not try to
  "fix" `poss_qty`. When Kiwoom ships a fractional balance TR/field, extend
  `mapUsHolding`/the `ust21070` request — `quantity` is `REAL`, so no migration.
- KRX·NXT are separate exchanges now. Holdings/trades must include NXT (KIS
  `inquire-daily-ccld` uses `EXCG_ID_DVSN_CD=ALL`; Kiwoom `kt00015`
  `dmst_stex_tp=%`), while **quotes must stay KRX-only**. Kiwoom `kt00018`'s
  `dmst_stex_tp` selects the valuation price of a single exchange-agnostic
  position — verified live (2026-09-20) that `KRX` and `NXT` return the same
  holdings/quantities — so keep it `KRX` to value holdings at the KRX close.
- Toss returns a JSON `{ result }` envelope on success and `{ error: { code,
  message, requestId } }` on failure (HTTP status is also set); check both.
  Amounts are JSON numbers; `profitLoss.rate` is a **decimal ratio**
  (0.1077 = 10.77%) so `mapTossBalance` multiplies by 100.
- Toss has **no cash field in holdings**: `depositTotal` is approximated from
  `GET /api/v1/buying-power` (`cashBuyingPower`, one extra call per account).
  `nextDaySettlement` stays `null`. `netAssetAmount` is **derived** as securities
  + cash (`marketValue.amount + deposit`); a per-currency total that Toss omits
  (no holdings in that market) is stored as `0`.
- Toss fills come from `GET /api/v1/orders?status=CLOSED` (order history, cursor
  paging, one account per call). Only order types orderable via Open API are
  returned (장전/장후 시간외 등은 누락), so trade history can be incomplete; it is
  best-effort like other trades. The order history carries **no product name**, so
  `getTrades` enriches it from `GET /api/v1/stocks` (batched, best-effort).
- Toss tokens are **one per client** — issuing a new one revokes the previous
  (`token-revoked`). Keep the token in KV and re-issue once on a token error;
  avoid concurrent issuance. Rate limits are per client × group (e.g. `ACCOUNT`
  1 TPS, `ASSET` 5, `MARKET_DATA_CHART` 20) with `429` + `Retry-After`.
- Toss KR market data may be **unified (KRX+NXT)**; the candles endpoint is
  called with `adjusted=false`. Verify it matches the KRX regular-session close
  policy on the first live run.
