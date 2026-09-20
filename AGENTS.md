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
  `quoteProviderPriority()` in the registry (`kis` before `kiwoom`). The
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
- DB access goes through `src/db/repo.ts`. Keep SQL there, not in sync/providers.
- New tables/columns require a new file in `migrations/`; never edit an applied
  migration. The schema carries `provider`/`market`/`country`/`currency` so new
  brokers and countries need no schema change.
- Re-running a sync must be idempotent: use `ON CONFLICT DO UPDATE`. Holdings for
  a day are replaced (delete + insert in one `db.batch`) to drop sold positions.
- Accounts opt out of trade sync with `meta.trades = false` (checked by
  `tradesEnabled` in `src/sync/orchestrator.ts`), so provider-agnostic code never
  hardcodes a broker's unsupported-endpoint error.
- Scheduled runs are split by account product (`productOf` / `SyncOptions.products`):
  the KRX run (`stock`+`gold`) fires at KST 20:30, and the US run (`us`) fires at
  KST 07:00 after the US regular close. `src/index.ts` picks the date/`products`
  from `controller.cron`; the US run uses the **ET** session date (`etDate`), not KST.
- FX is a **separate task** (`src/sync/fx.ts`, `syncFxRates`) keyed to the **KST**
  date, stored in `fx_rates`. It is runnable on its own via `POST /sync/fx` and is
  also invoked alongside the US cron as an independent `ctx.waitUntil` (its
  failure never affects the holdings snapshot). A provider opts in by implementing
  the optional `BrokerProvider.getFxRate`; providers without it (KIS) are skipped.
  Keep FX provider-agnostic: no TR_IDs or broker field names outside `providers/`.
  Note: `fx_rates.date` is the KST date the rate was observed (not a date from the
  response, which carries none), while US snapshots are keyed to the ET session
  date; the US cron runs KST morning, so the two are a day apart — worth keeping in
  mind when valuing US holdings with FX (`created_at` holds the exact UTC instant).

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
- US FX uses `ust31301` (환율 조회, `POST /api/us/exchange`) from the FX task. The
  body requires `exch_tp` (`1` = KRW→USD, `2` = USD→KRW; we send `2`) and the
  response is a flat envelope: `aplc_exrt` (적용환율, preferred), `sell_aplc_exrt`,
  `buy_aplc_exrt`. The response carries no date, so the task's KST date is stored;
  only USD→KRW is mapped. Verified against Kiwoom's official example repo
  (2026-09-21); the live `1511` error without `exch_tp` confirmed it.
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
