# asset-tracker

Cloudflare Worker that syncs brokerage account data into D1 on a daily schedule.
KIS (한국투자증권) and Kiwoom (키움증권) are supported providers; the core is
provider/broker agnostic so more brokers and countries can be added without
touching the sync engine.

## 현재 상태 (2026-09-20)

계좌별 KIS 자격증명 지원으로 전환하고 원격 배포까지 완료. KIS는 **계좌마다 별도의
appkey/appsecret**이 필요하므로, 이를 `KIS_CREDENTIALS` secret(계좌 external id → 키 JSON)으로
관리한다.

### 완료된 것

- 계좌별 자격증명: `KIS_CREDENTIALS` JSON secret, 계좌별 `KisClient`/토큰 캐시 분리
  (`kis:token:<env>:<credId>`), 계좌 미지정 시세는 첫 계좌 키 재사용.
- 로컬 도구 `scripts/kis-accounts.ts`: `.kis-credentials.json` 기반 계좌별 검증/시드 SQL 생성
  (`--sql`은 시크릿 없이 stdout, 진행 로그는 stderr). `--no-trades`로 계좌별 체결 조회 비활성화.
  `pnpm kis:secret:put`으로 secret 업로드.
- `meta.trades = false`인 계좌는 체결 조회를 건너뛴다(provider-agnostic). 퇴직연금 계좌
  (`11111111-29`)에 적용되어 실행 status가 `success`로 유지됨.
- 구 단일 app key(appkey/appsecret) 방식은 코드·로컬 데이터·원격 secret에서 완전히 제거됨.
- 3개 계좌 원격 D1 등록, `KIS_CREDENTIALS`/`ADMIN_TOKEN` secret 업로드, Worker 배포 및
  원격 `POST /sync` 검증 완료.
- `pnpm test` 34 passed, `pnpm typecheck` 통과.

### 키움증권 추가 (2026-09-20)

- `src/providers/kiwoom/` 추가, `registry`에 등록. 잔고 `kt00018` + 예수금 `kt00001`,
  체결 `kt00015`(위탁종합거래내역, 날짜 범위 1회), 일봉 `ka10081`(`upd_stkpc_tp=0`, 비수정).
  금현물 계좌는 잔고 `kt50020`·체결 `kt50032`·일봉 `ka50081`, `market="KRX-GOLD"`.
- IP 화이트리스트 대응: squid forward proxy는 Worker에서 사용 불가(workerd #6903) →
  VPS `kiwoom.proxy.example.com`에 Caddy 리버스 프록시(`deploy/caddy/kiwoom.caddy`),
  Worker는 `KIWOOM_BASE_URL` + `X-Kiwoom-Relay` 시크릿으로 호출.
- 계좌 발견(`ka00001`)로 6개 전부 등록(주식 5 + 금현물 1, `meta.product="gold"`).
  원격 `POST /sync?provider=kiwoom` 성공(보유 1, 일봉 5, 60일 체결 6). 체결 조회는
  일자별 `kt00007` 대신 범위 조회 `kt00015`/`kt50032`로 전환해 Worker 서브리퀘스트
  한도(50)를 회피.
- `pnpm test` 64 passed, `pnpm typecheck` 통과.

### 토스증권 추가 (2026-09-25)

- `src/providers/toss/` 추가, `registry`에 등록. **사용자당 단일 OAuth2 client**
  (`TOSS_CREDENTIALS={clientId,clientSecret}`) + `X-Tossinvest-Account: <accountSeq>`
  헤더. 한 계좌가 KR+US를 함께 보유하므로 **두 행**으로 등록:
  `<accountNo>`(KRX) / `<accountNo>-us`(US, `meta.product="us"`).
- 매핑: 보유 `GET /api/v1/holdings`(시장별 필터, `Price{krw,usd}` 합산), 예수금은
  `GET /api/v1/buying-power`(`cashBuyingPower`)로 **근사**(순자산 = 주식+현금 파생,
  없는 통화 합계는 0), 체결은 `GET /api/v1/orders?status=CLOSED`(커서 페이징,
  `execution` 사용), 일봉은 `GET /api/v1/candles?interval=1d&adjusted=false`.
- IP 허용 필요 → 키움과 동일하게 Caddy 리버스 프록시
  (`deploy/caddy/toss.caddy`, `TOSS_BASE_URL`, `X-Toss-Relay`/`TOSS_RELAY_SECRET`).
- 주의: Open API로 접수 가능한 호가유형만 `orders`에 노출(시간외 등 누락), 토큰은
  클라이언트당 1개(`token-revoked`), KR 시세는 통합(KRX+NXT)일 수 있음.
- 계좌 등록: `pnpm toss:accounts -- --sql > seeds/accounts.sql`.
- `pnpm test` 130 passed, `pnpm typecheck` 통과.

### 시세 중복 제거 + KRX 정규장 정렬 (2026-09-20)

- **종목별 단일 시세 출처**: 여러 증권사가 같은 종목을 보유해도 시세는 한 번만
  조회한다. `src/sync/quoteSources.ts`가 종목별 후보 provider를
  `quoteProviderPriority()`(registry 순서: `kis` → `kiwoom`)로 정렬하고, 첫 후보로
  묶어 조회한다. 실패하면 해당 종목만 다음 후보로 폴백한다.
- **KRX 정규장 고정**: KIS `FID_COND_MRKT_DIV_CODE=J`(KRX), Kiwoom plain 6자리
  코드(=`_NX`/`_AL` 접미사 제거)만 사용. KRX/NXT 프리·애프터마켓은 제외하며 KRX
  15:30 종가가 공식 종가다. 시세는 비수정주가(KIS `FID_ORG_ADJ_PRC=1`, Kiwoom
  `upd_stkpc_tp=0`).
- **NXT 체결 포함**: KIS 체결 `EXCG_ID_DVSN_CD=ALL`, Kiwoom 체결 `dmst_stex_tp=%`.
- **실 API 확인(2026-09-20)**: Kiwoom `kt00018`은 `dmst_stex_tp=KRX`/`NXT`에서 보유
  집합·수량이 동일(예: `005930:10`) — 거래소 구분은 평가 시세 선택일 뿐이라 KRX
  유지로 누락 없음. KIS 일봉은 `J`와 `NX`의 OHLC·거래량이 다르고(예: 005930
  2026-09-18 O 261,000 vs 259,500, V 17.49M vs 6.58M) 종가도 갈릴 때가 있어(000660
  2026-09-17 1,745,000 vs 1,766,000) KRX 고정이 실제로 의미가 있다.
- `pnpm test` 75 passed, `pnpm typecheck` 통과.

### 키움 미국주식 추가 (2026-09-20)

- 별도 계좌행으로 등록: `external_id="<acctNo>-us"`, `country="US"`, `currency="USD"`,
  `meta.product="us"` (금현물과 동일한 패턴). 토큰=계좌라 자격증명은 그대로 해석된다.
- 엔드포인트: 잔고 `ust21070`(원장잔고), 체결 `ust21100`(미국주식 거래내역, 날짜 범위 1회),
  일봉 `usa06012`(`upd_stkpc_tp=0`, `exrt_appl_tp=0`), 거래소 조회 `usa10098`.
  경로는 `/api/us/acnt`·`/api/us/chart`·`/api/us/stkinfo`이고 목록 키는 `result_list`다.
- 잔고·체결에 거래소 정보가 없어(`stex_nm="미국"`) 시세 조회 시 `usa10098`로
  `stex_tp`(ND/NY/NA)를 해석한다(인메모리 캐시). `market="US"` 단일 시장.
- **정규장 종가 고정**: KST 07:00 실행은 미국 정규장(마감 익일 KST 05:00/06:00) 이후지만
  시간외 구간이라, 보유평가를 `usa06012` 정규장 종가(캔들 `dt == date`)로 재계산한다.
- 라이브 확인(2026-09-20): `ust21100`은 `krw_repl_skip_yn="N"`이 실제로 필수(`1511`),
  `usa06012`의 `strt_dt`는 **기준일(포함)**이라 `from`이 아니라 `date`를 보내야 한다(아니면
  구간이 조용히 비어버림). 거래소를 잘못 주면 `1903`(QLD는 `ND`가 아니라 `NY`).
- **소수점(소수점매매) 보유는 미지원(2026-09-20, 키움 확인)**: `ust21070`/`ust21170`의
  `poss_qty`는 정수 주식만 준다(예: QLD 22, SPYM 23). 소수점 수량은 체결 `ust21100`의
  `deal_qty`에만 소수점으로 내려오고, 소수점 *가치*는 집계(`ust21120`/`ust21121`/`ust21131`/
  `ust21132`)에 포함돼 `ust21070` 합계보다 크다(관측 4063.72 vs 4247.50 USD). 키움 REST가
  소수점 잔고를 지원하면 `mapUsHolding`/`ust21070` 파싱만 확장하면 된다(`quantity`는 REAL).
- **스케줄 분리**: KRX/금현물은 KST 20:30(UTC Mon–Fri 11:30), 미국은 KST 07:00
  (UTC Mon–Fri 22:00, `0 22 * * 2-6`)에 별도 실행. US 실행은 ET 세션 날짜(`etDate`)를 쓴다.
- US 티커는 `stripSymbol`을 태우지 않는다(7자 `A/J/Q` 티커 손상 방지).
- `pnpm test` 88 passed, `pnpm typecheck` 통과.

### 환율 원천: 한국수출입은행 매매기준율

- **별개 태스크**: `src/sync/fx.ts`(`syncFxRates`)가 환율 조회·보관을 담당한다.
  보유종목과 무관하게 **자체 크론(KST 월–금 12:00 = UTC `0 3 * * 2-6`)** 으로 돌고
  `POST /sync/fx`로 수동 실행할 수 있다. 환율 실패는 보유 스냅샷에 영향을 주지 않는다.
- **출처**: 한국수출입은행 Open API(`src/fx/koreaexim.ts`)의 **매매기준율**
  (`deal_bas_r`, `data=AP01`, `oapi.koreaexim.go.kr`). 키움 `ust31301`(환전 적용환율
  =가환율)은 시장 기준환율이 아니라 평가용으로 부적합해 **제거**했다.
- **시점**: 고시는 영업일 **오전 11시 전후**라 KST 12:00에 수집한다. 영업일 11시
  이전·주말·공휴일은 데이터가 없어 **직전 영업일로 최대 7일 역추적**한다.
- **기준일**: `fx_rates.date`는 관측일이 아니라 **실제 고시(영업)일**이다. US 보유는
  ET 세션 날짜로 스냅샷되므로 KST 고시일과 하루 어긋날 수 있다.
- **저장**: `fx_rates` (`base_currency`, `quote_currency`, `date`, `rate`, `provider`,
  `source`, `raw_json`; `UNIQUE (base, quote, date)`), `provider="koreaexim"`,
  `source="koreaexim-deal-bas-r"`. 현재 USD→KRW만 매핑한다.
- **source-agnostic**: 시장 FX 소스는 `BrokerProvider`가 아니라 `FxSource`(계좌 없음)
  이며 `src/fx/registry.ts`에 등록한다. 브로커/`koreaexim` 필드명은 `src/fx/` 밖으로
  새지 않는다. 인증키는 `KOREAEXIM_API_KEY`(wrangler secret)다.
- `pnpm test` 111 passed, `pnpm typecheck` 통과.

### 계좌 검증/동기화 결과 (2026-09-20, 로컬·원격)

| 계좌 | 잔고 조회 | 체결내역 조회 |
| --- | --- | --- |
| `22222222-01` | 정상 (예수금 N원, 보유 0) | 정상 (0건) |
| `33333333-22` | 정상 (예수금 N원, 보유 0) | 정상 (0건) |
| `11111111-29` | 정상 (보유 1, 평가 N원) | `APBK1744`로 건너뜀 (`meta.trades=false`) |

- 계좌별 키로 전환한 뒤 이전 `INVALID_CHECK_ACNO` / `APTR0058` 문제가 모두 해소됨.
- `11111111-29`는 퇴직연금계좌라 `inquire-daily-ccld`가 원천 미지원(`APBK1744`).
  `meta.trades=false`로 체결 조회를 건너뛰어 실행 status가 `success`로 유지된다.
- `22222222-01`은 예수금 N원·보유 0으로 사실상 비어 있음 → 실제 관리 대상인지 확인 필요.

### 남은 선택 사항

- 관리 대상이 아니면 `22222222-01`을 `active = 0`으로 내리거나 시드에서 제거.

메모:
- 자격증명은 `KIS_CREDENTIALS`(계좌별 JSON) 하나만 사용한다.
- 체결 조회를 지원하지 않는 계좌는 `meta.trades = false`로 표시해 건너뛴다(아래 참고).
- 원격 KV는 비어 있으므로 첫 배포 직후 첫 sync에서 토큰 발급이 필요하다. KIS 토큰은
  appkey당 1분에 1회만 발급되니, 직전에 로컬 `kis:accounts`를 돌렸다면 1분 뒤 재시도.
- `pnpm kis:accounts`는 계좌별 appkey(마스킹)를 표시하며, `--sql`은 시크릿 없이 accounts 행만 생성.
- `DEBUG_KIS=1`(워커는 `--var DEBUG_KIS:1`)로 KIS 요청 로깅(시크릿 미노출).
- 로컬 토큰은 `.kis-token-cache.json`(gitignore)에 자격증명별로 캐시되어 재발급 알림/1분 제한을 피함.

## What it does

Once a day (and on demand) it:

1. Loads active accounts from D1.
2. For each account, stores a **daily snapshot**: cash/deposit summary plus every
   holding (symbol, quantity, average price, valuation, P/L).
3. Fetches **quantity-changing trades only** (buys/sells) over a rolling 7-day
   window. Deposits, dividends, and other cash events are ignored.
4. Fetches **daily OHLC** quotes for every held instrument — **once per
   instrument**, even if several brokers hold it, pinned to the **KRX regular
   session** (unadjusted prices).
5. Runs a **separate FX task** on its own cron that records the USD/KRW market
   reference rate (Korea Eximbank 매매기준율) in `fx_rates`. It is independent of
   holdings and can be run on its own via `POST /sync/fx`; a failure never affects
   the snapshot.

Re-running for the same day overwrites that day's snapshot (`INSERT ... ON
CONFLICT DO UPDATE`); holdings for the day are replaced wholesale so sold
positions disappear.

## Architecture

```
src/
  index.ts                 Worker entry: scheduled (cron) + fetch (manual/API)
  env.ts                   Bindings & secrets
  domain/types.ts          Normalized model + BrokerProvider interface
  providers/registry.ts     provider id -> instance (cached per isolate)
  providers/kis/            KIS implementation
    credentials.ts          KIS_CREDENTIALS parsing + per-account lookup
    auth.ts                 Token issue + per-credential KV cache (24h, 1/min)
    client.ts               Headers, rt_cd checks, retry, pagination
    tr-ids.ts               Env-aware TR_IDs and base URLs
    endpoints/domestic.ts   Raw KIS fields -> normalized domain types
  providers/kiwoom/         Kiwoom implementation (same shape as KIS)
    credentials.ts          KIWOOM_CREDENTIALS parsing + per-account lookup
    auth.ts                 Token issue + per-credential KV cache (expires_dt)
    client.ts               api-id header, return_code checks, pagination
    tr-ids.ts               API ids, paths, base URLs
    endpoints/domestic.ts   Raw Kiwoom fields -> normalized domain types
  providers/toss/           Toss Securities implementation (OAuth2 + accountSeq)
    credentials.ts          TOSS_CREDENTIALS (single client) parsing
    auth.ts                 OAuth2 token issue + per-client KV cache
    client.ts               Bearer + X-Tossinvest-Account, error envelope, retry
    endpoints/              holdings / orders / candles -> normalized types
  db/repo.ts               D1 upserts / queries
  fx/                       Market FX sources (not brokers)
    koreaexim.ts            Korea Eximbank 매매기준율 (FxSource)
    registry.ts             source id -> instance
  sync/                     Provider-agnostic engine
    balances.ts trades.ts quotes.ts orchestrator.ts quoteSources.ts
    fx.ts                    Standalone FX task: fetch/record the reference rate
```

The sync engine only talks to the `BrokerProvider` interface, so a new broker is
a new folder under `src/providers/<id>/` plus one line in the registry.

## Data model (D1)

| Table | Grain | Notes |
|---|---|---|
| `accounts` | provider + env + external_id | runtime account registry |
| `instruments` | market + symbol | stable instrument anchor |
| `account_snapshots` | account + date | cash/deposit + valuation totals |
| `holdings` | account + date + market + symbol | daily positions |
| `price_daily` | market + symbol + date | OHLCV |
| `trades` | account + date + external_id + side | buy/sell fills |
| `fx_rates` | base + quote + date | market reference FX (USD/KRW), source-agnostic |
| `sync_runs` | run | execution history / status |

## Cloudflare resources

`wrangler.jsonc` is **gitignored** (it holds your account-specific ids and proxy
host); commit-safe defaults live in `wrangler.example.jsonc`:

```bash
cp wrangler.example.jsonc wrangler.jsonc   # then fill in the ids/URLs
```

It wires:

- Worker: `asset-tracker`
- D1: `asset-tracker-db` (binding `DB`) — `<d1-database-id>`
- KV: `asset-tracker-kv` (binding `CACHE`) — `<kv-namespace-id>`
- Cron: `30 11 * * 2-6` (UTC Mon-Fri 11:30 = KST Mon-Fri 20:30) for KRX/gold,
  `0 22 * * 2-6` (UTC Mon-Fri 22:00 = KST Tue-Sat 07:00) for US, and
  `0 3 * * 2-6` (UTC Mon-Fri 03:00 = KST Mon-Fri 12:00) for FX. Cloudflare uses
  Quartz weekdays: 1=Sunday … 7=Saturday, so Mon-Fri is `2-6`.

## Setup

```bash
pnpm install

# Bindings config (gitignored; holds D1/KV ids and the Kiwoom proxy host)
cp wrangler.example.jsonc wrangler.jsonc   # then fill in the ids/URLs

# Secrets (see below)
cp .dev.vars.example .dev.vars   # then fill in values

# Apply schema
pnpm db:migrate:local
pnpm db:migrate:remote

# Per-account credentials (see "Credentials")
# Create .kis-credentials.json, then register accounts (see "Accounts")
pnpm kis:accounts -- --accounts 12345678-01 --sql > seeds/accounts.sql
pnpm db:seed:remote
pnpm kis:secret:put

pnpm run deploy
```

## Credentials (per account) + secrets

KIS issues a **separate app key per account**, so credentials are stored as one
JSON object keyed by account external id (`CANO-PRDT`):

```json
{
  "22222222-01": { "appkey": "...", "appsecret": "..." },
  "33333333-22": { "appkey": "...", "appsecret": "..." }
}
```

Keys are matched by `externalId` (`22222222-01`), then by the 8-digit `CANO`
(`22222222`). The file is the source of truth for local tooling and the secret
upload:

```bash
# .kis-credentials.json (gitignored)
pnpm kis:secret:put          # wrangler secret put KIS_CREDENTIALS < .kis-credentials.json
```

`wrangler secret put` writes to the **deployed** Worker only; local runs read
`.dev.vars`. For local dev add the same JSON as a single-line
`KIS_CREDENTIALS='{...}'` entry in `.dev.vars`.

| | Local | Production |
|---|---|---|
| `KIS_CREDENTIALS` | `.dev.vars` (or `.kis-credentials.json` for `kis:accounts`) | `pnpm kis:secret:put` |
| `ADMIN_TOKEN` | `.dev.vars` | `pnpm exec wrangler secret put ADMIN_TOKEN` |

`.dev.vars` and `.kis-credentials.json` are gitignored. `KIS_ENV` (`prod`/`vts`)
is a plain var in `wrangler.jsonc` and can also be set in `.dev.vars` locally.

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars: KIS_CREDENTIALS, KIS_ENV, ADMIN_TOKEN
pnpm db:migrate:local
pnpm dev
# then, against the local worker:
curl -X POST http://localhost:8787/sync -H "x-admin-token: $ADMIN_TOKEN"
```

## Accounts

KIS has **no "list my accounts" API** — the official samples read the account
number from a config file. You get the account number (`CANO`, 8 digits) and
product code (`ACNT_PRDT_CD`, usually `01`) from the KIS Developers portal's
신청현황 screen.

`pnpm kis:accounts` verifies candidates against the live API using each
account's own credentials (from `.kis-credentials.json`) and can emit seed SQL:

```bash
# Verify known accounts (uses their own keys)
pnpm kis:accounts -- --accounts 22222222-01,33333333-22 --trades

# Don't know the product code? Probe the common ones (01, 22, 29, 03, 08)
pnpm kis:accounts -- --cano 12345678

# Use a non-default credentials file
pnpm kis:accounts -- --accounts 12345678-01 --credentials-file .kis-credentials.other.json

# Emit seeds/accounts.sql from the accounts that verified (no secrets in SQL)
pnpm kis:accounts -- --accounts 12345678-01,87654321-01 --sql > seeds/accounts.sql

# Mark accounts whose broker does not support trade history (sets meta.trades=false)
pnpm kis:accounts -- --accounts 12345678-01,87654321-01 \
  --no-trades 87654321-01 --sql > seeds/accounts.sql

# Paper environment
pnpm kis:accounts -- --cano 12345678 --env vts
```

Apply the generated file with `pnpm db:seed:remote`, then upload credentials
with `pnpm kis:secret:put`. Register the example by hand with
`cp seeds/accounts.example.sql seeds/accounts.sql`.

### Disabling trade sync per account

Some accounts cannot call the trade endpoint at all (e.g. KIS retirement-pension
accounts return `APBK1744`). Set `"trades": false` in the account's `meta` so the
sync engine skips it and the run stays `success`:

```json
{ "cano": "11111111", "prdtCd": "29", "trades": false }
```

`pnpm kis:accounts --no-trades <account>` writes this into the generated seed.
Trades are otherwise best-effort: an unexpected failure is recorded as
`:trades` in the run report without failing the balance snapshot.


## Manual trigger / API

All admin routes require the `x-admin-token` header (the `ADMIN_TOKEN` secret).

```bash
# Health (no auth)
curl https://asset-tracker.<subdomain>.workers.dev/

# Run a sync for today
curl -X POST https://asset-tracker.<subdomain>.workers.dev/sync \
  -H "x-admin-token: $ADMIN_TOKEN"

# Backfill / re-sync a specific day, wider trade window
curl -X POST "https://asset-tracker.<subdomain>.workers.dev/sync?date=2026-09-18&lookbackDays=30" \
  -H "x-admin-token: $ADMIN_TOKEN"

# Inspect
curl -H "x-admin-token: $ADMIN_TOKEN" .../accounts
curl -H "x-admin-token: $ADMIN_TOKEN" .../runs

# FX task on its own (KST date by default)
curl -X POST https://asset-tracker.<subdomain>.workers.dev/sync/fx \
  -H "x-admin-token: $ADMIN_TOKEN"

# Explicit date / pair / source
curl -X POST "https://asset-tracker.<subdomain>.workers.dev/sync/fx?date=2026-09-21&source=koreaexim" \
  -H "x-admin-token: $ADMIN_TOKEN"
```

`POST /sync` accepts a JSON body too: `{ "date": "...", "lookbackDays": 7, "provider": "kis" }`.
Restrict by product with `products` (comma-separated), e.g. `?products=us` for US accounts only.
`POST /sync/fx` accepts `{ "date": "...", "source": "koreaexim", "base": "USD", "quote": "KRW" }`.

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | local Worker |
| `pnpm test` | vitest |
| `pnpm typecheck` | tsc |
| `pnpm run deploy` | deploy (`pnpm deploy` is pnpm's built-in) |
| `pnpm db:migrate:local` / `:remote` | apply migrations |
| `pnpm kis:accounts -- ...` | verify KIS accounts / emit seed SQL |
| `pnpm kis:secret:put` | upload `.kis-credentials.json` as `KIS_CREDENTIALS` |
| `pnpm kiwoom:accounts -- ...` | discover/verify Kiwoom accounts / emit seed SQL |
| `pnpm kiwoom:secret:put` | upload `.kiwoom-credentials.json` as `KIWOOM_CREDENTIALS` |
| `pnpm toss:accounts -- ...` | discover/verify Toss accounts / emit seed SQL |
| `pnpm toss:secret:put` | upload `.toss-credentials.json` as `TOSS_CREDENTIALS` |
| `pnpm db:seed:local` / `:remote` | seed accounts |

## KIS notes

- Real domain `https://openapi.koreainvestment.com:9443`; paper (`vts`) is
  supported by setting `KIS_ENV=vts` but the current accounts are real-only.
- Each account has its own app key, so tokens are cached per credential in KV
  (`kis:token:<env>:<credentialId>`, where `credentialId` is a short SHA-256 of
  the app key) and refreshed an hour before expiry. Tokens are valid 24h and may
  only be issued once per minute.
- Rate limit is per app key (~20 TPS real). Calls are serialized at 300 ms and
  `EGW00201` is retried with backoff.
- Endpoints used: `inquire-balance` (`TTTC8434R`), `inquire-daily-ccld`
  (`TTTC0081R`), `inquire-daily-itemchartprice` (`FHKST03010100`).
- Prices use unadjusted daily candles (`FID_ORG_ADJ_PRC=1`) with
  `FID_COND_MRKT_DIV_CODE=J` (KRX only; `NX`=NXT, `UN`=통합), so the close is the
  KRX regular-session 15:30 close. Trade history sends `EXCG_ID_DVSN_CD=ALL` to
  include NXT fills (`KRX`/`NXT`/`SOR`/`ALL`).
- Trade history is best-effort: `inquire-daily-ccld` can fail for a single
  account while its balance works. Examples: `APTR0058` ("처리계좌의 ID와
  사용자정보가 상이") when an account is queried with a mismatched/stale app key
  (fixed by using that account's own `KIS_CREDENTIALS` entry), and `APBK1744`
  ("퇴직연금계좌는 해당 서비스가 불가합니다") for retirement-pension accounts,
  which do not support the endpoint at all. Mark those accounts with
  `meta.trades = false` (`pnpm kis:accounts --no-trades`) so the endpoint is
  skipped; otherwise they still get their snapshot and only the `:trades` step is
  reported as failed. Check with `pnpm kis:accounts -- --accounts <id> --trades`.
- `DEBUG_KIS=1` (or `--var DEBUG_KIS:1` in `wrangler dev`) logs outgoing KIS
  requests without secrets.

## Kiwoom notes

Kiwoom requires **IP whitelisting**, so Worker requests cannot go straight to
`api.kiwoom.com`. Cloudflare Workers also cannot tunnel through a forward proxy
reliably: `cloudflare:sockets` `startTls()` after `CONNECT` fails on the
production edge (workerd #6903 — SNI is not sent), and `node:tls` inherits the
same limitation. The supported setup is therefore a **Caddy reverse proxy** on
the IP-whitelisted VPS (`deploy/caddy/kiwoom.caddy`):

```
Worker --HTTPS--> Caddy (whitelisted IP) --HTTPS--> api.kiwoom.com
```

- `KIWOOM_BASE_URL` points at the Caddy vhost
  (`https://kiwoom.proxy.example.com`); `KIWOOM_RELAY_SECRET` is sent as the
  `X-Kiwoom-Relay` header and checked by Caddy. Neither is needed for KIS.
- Toss uses the same pattern: `TOSS_BASE_URL`
  (`https://toss.proxy.example.com`) with `TOSS_RELAY_SECRET` as the
  `X-Toss-Relay` header (`deploy/caddy/toss.caddy`). Toss also requires the VPS
  IP in its WTS > Open API > 허용 IP 관리 allowlist.
- The VPS `/etc/caddy/Caddyfile` should `import /etc/caddy/conf.d/*.caddy`, and
  each broker gets its own file there (copy from `deploy/caddy/`). Caddy obtains
  and renews the public certificate automatically (DNS-only A record).
- Each `.kiwoom-credentials.json` entry is one app key bound to one account, so
  `pnpm kiwoom:accounts` calls `ka00001` (계좌번호조회) to discover the account
  number and emits seed SQL with `provider='kiwoom'`, `external_id=<acctNo>`,
  `meta={acctNo, credKey}`.
- Endpoints: balance `kt00018`, deposit `kt00001`, fills `kt00015` (위탁종합거래내역,
  one date-range call per account), daily candles `ka10081` (`upd_stkpc_tp=0`,
  unadjusted).
- US (미국주식) endpoints: balance `ust21070` (`/api/us/acnt`), fills `ust21100`,
  candles `usa06012` (`/api/us/chart`), exchange `usa10098` (`/api/us/stkinfo`).
  Registered as a separate account row with `meta.product="us"`; holdings are
  valued at the regular-session close. See "키움 미국주식 추가" above.
- FX is fetched by the standalone task `src/sync/fx.ts` from **Korea Eximbank**
  (`src/fx/koreaexim.ts`, `data=AP01`, `deal_bas_r` 매매기준율) and recorded in
  `fx_rates` as USD→KRW. `date` is the actual quote (business) day; the source
  searches back up to 7 days for the latest published day.
- Exchange codes: daily candles use the plain 6-digit code (KRX); NXT/unified
  candles require `_NX`/`_AL`, which `stripSymbol` removes so quotes stay KRX
  regular-session. Fills already cover all exchanges (`dmst_stex_tp=%`), while
  balance keeps `dmst_stex_tp=KRX` — it selects the valuation price of a single
  exchange-agnostic position, not which positions are returned.
- Gold-spot (금현물) accounts are detected by `pnpm kiwoom:accounts` (kt00018
  returns `400114`; kt50020 succeeds) and stored with `meta.product="gold"`.
  They use balance `kt50020`, fills `kt50032` (date range) and candles `ka50081`,
  and are recorded under `market="KRX-GOLD"`.
- This same command probes `ust21070` and, on success, emits an extra US row
  (`<acctNo>-us`, `meta.product="us"`). Pass `--no-us` to skip that probe.
- Kiwoom returns HTTP 200 with `return_code != 0` on logical errors; an empty
  trade range comes back as `501724` (관련자료가없습니다) and is treated as no
  trades. Tokens are cached per app key in KV (`kiwoom:token:<env>:<credId>`) and
  refreshed before `expires_dt` (KST); `8005`/`8103` triggers one re-issue.

```bash
pnpm kiwoom:accounts -- --sql > seeds/accounts.sql
pnpm db:seed:remote
pnpm kiwoom:secret:put
pnpm exec wrangler secret put KIWOOM_RELAY_SECRET
pnpm run deploy
```

## Adding a provider / country

1. Add `src/providers/<id>/` implementing `BrokerProvider`.
2. Register it in `src/providers/registry.ts` (its position there sets quote
   priority; implement `supportsMarket` so quotes route to a capable provider).
3. Seed `accounts` rows with the new `provider`.
4. Optionally add market/country/currency handling — all stored in the schema.
