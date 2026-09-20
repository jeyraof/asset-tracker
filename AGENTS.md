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
- Kiwoom trades use date-range calls (stock `kt00015`, gold `kt50032`) — one
  request per account, which keeps the Worker under the 50-subrequest limit. Do
  not go back to per-day `kt00007`/`kt50031` loops. The side is `io_tp_nm`
  (stock) / `rmrk_nm` (gold). `ka10081`/`ka50081` use `upd_stkpc_tp=0`.
- Gold-spot accounts (`meta.product="gold"`) use `kt50020`/`kt50032`/`ka50081`
  and `market="KRX-GOLD"`; `kiwoom:accounts` detects them when `kt00018` fails
  with `400114`.
- KRX·NXT are separate exchanges now. Holdings/trades must include NXT (KIS
  `inquire-daily-ccld` uses `EXCG_ID_DVSN_CD=ALL`; Kiwoom `kt00015`
  `dmst_stex_tp=%`), while **quotes must stay KRX-only**. Kiwoom `kt00018`'s
  `dmst_stex_tp` selects the valuation price of a single exchange-agnostic
  position — verified live (2026-09-20) that `KRX` and `NXT` return the same
  holdings/quantities — so keep it `KRX` to value holdings at the KRX close.
