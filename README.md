# asset-tracker

Cloudflare Worker가 증권 계좌 데이터를 D1에 매일 동기화한다. 지원 provider는
**KIS(한국투자증권)**, **키움증권**, **토스증권**이며, 코어는 **provider-agnostic**이라
sync 엔진을 건드리지 않고 broker/국가를 추가할 수 있다.

변경 이력은 [`CHANGELOG.md`](./CHANGELOG.md) 참고.

## 동작

매일(그리고 수동 실행 시):

1. D1에서 활성 계좌를 로드한다.
2. 계좌별 **일일 스냅샷**을 저장한다: 현금/예수금 요약 + 모든 보유 종목(수량, 평균단가,
   평가금액, 손익).
3. 최근 7일 롤링 윈도우의 **수량 변동 체결(매수/매도)만** 수집한다. 입출금·배당 등 현금
   이벤트는 무시한다.
4. 보유 종목별 **일봉 OHLC**를 **종목당 한 번만**(여러 broker가 같은 종목을 보유해도)
   가져오며, **KRX 정규장**(비수정가)에 고정한다.
5. **별도 FX 태스크**가 자체 크론으로 USD/KRW 시장 기준환율(수출입은행 매매기준율)을
   `fx_rates`에 기록한다. 보유와 무관하며 `POST /sync/fx`로 단독 실행할 수 있고, 실패해도
   스냅샷에 영향을 주지 않는다.

같은 날짜로 재실행하면 그날 스냅샷을 덮어쓴다(`INSERT ... ON CONFLICT DO UPDATE`).
보유는 통째로 교체되어 매도된 포지션이 사라진다.

## Providers

### KIS (한국투자증권)

- **자격증명**: 계좌마다 별도의 appkey/appsecret가 필요하다. `KIS_CREDENTIALS` JSON
  secret(계좌 external id → 키)으로 관리하며, `externalId`(예: `12345678-01`)로 매칭하고
  없으면 8자리 `CANO`로 매칭한다.
- **토큰**: 계좌별 KV 캐시(`kis:token:<env>:<credId>`, `credId`는 appkey SHA-256 앞자리),
  만료 1시간 전 갱신. appkey당 1분에 1회만 발급 가능.
- **엔드포인트**: 잔고 `inquire-balance`(`TTTC8434R`), 체결 `inquire-daily-ccld`
  (`TTTC0081R`), 일봉 `inquire-daily-itemchartprice` (`FHKST03010100`).
- **시세 정책**: 비수정 일봉(`FID_ORG_ADJ_PRC=1`), `FID_COND_MRKT_DIV_CODE=J`(KRX만;
  `NX`=NXT, `UN`=통합) → KRX 15:30 종가. 체결은 `EXCG_ID_DVSN_CD=ALL`로 NXT 포함.
- **체결은 best-effort**: 계좌 단위로 실패해도 스냅샷은 유지된다. `APTR0058`(계좌-키
  불일치), `APBK1744`(퇴직연금 미지원) 등은 해당 계좌를 `meta.trades=false`로 표시해
  엔드포인트를 건너뛴다.
- rate limit ~20 TPS(appkey), 호출은 300ms로 직렬화하고 `EGW00201`은 백오프 재시도.
- 실전 도메인 `https://openapi.koreainvestment.com:9443`, 모의(`vts`)는 `KIS_ENV=vts`.
- `DEBUG_KIS=1`로 요청 로깅(시크릿 미노출).

### 키움증권

- **자격증명**: 계좌별 appkey/appsecret, `KIWOOM_CREDENTIALS` JSON. 해석 순서는
  `externalId` → `meta.acctNo` → `meta.credKey`. 토큰 KV 캐시
  (`kiwoom:token:<env>:<credId>`), `expires_dt` 전 갱신, `8005`/`8103` 시 1회 재발급.
- **IP 허용 + Caddy**: `KIWOOM_BASE_URL`(Caddy vhost) + `X-Kiwoom-Relay`
  (`KIWOOM_RELAY_SECRET`). 자세한 내용은 아래 "IP 허용과 리버스 프록시" 참고.
- **엔드포인트**: 잔고 `kt00018` + 예수금 `kt00001`, 체결 `kt00015`(위탁종합거래내역,
  계좌당 날짜 범위 1회), 일봉 `ka10081`(`upd_stkpc_tp=0`).
- **금현물(금 spot)**: 잔고 `kt50020`, 체결 `kt50032`, 일봉 `ka50081`,
  `market="KRX-GOLD"`, `meta.product="gold"`.
- **미국주식**: 별도 계좌행(`<acctNo>-us`, `country=US`, `currency=USD`,
  `meta.product="us"`). 엔드포인트 `ust21070`(원장잔고), `ust21100`(거래내역),
  `usa06012`(일봉), `usa10098`(거래소 ND/NY/NA). 경로 `/api/us/*`, 목록 키 `result_list`.
  - KST 07:00 실행은 미국 정규장 이후지만 시간외 구간이라, 보유평가를 `usa06012` 정규장
    종가(캔들 `dt == date`)로 재계산한다.
  - `ust21100`은 `krw_repl_skip_yn="N"`이 실제로 필수(`1511`), `usa06012`의 `strt_dt`는
    **기준일(포함)**이라 `from`이 아니라 `date`를 보낸다(아니면 구간이 조용히 빈다).
  - 소수점(소수점매매) 보유는 REST 미지원(`poss_qty`는 정수). 소수점 수량은 체결
    `ust21100`의 `deal_qty`에만 내려오고, 소수점 가치는 집계 응답에 포함된다.
- **KRX/NXT**: 잔고 `dmst_stex_tp=KRX`(평가 시세 선택용, 보유 집합은 거래소 무관), 체결
  `dmst_stex_tp=%`(전체), 일봉은 plain 6자리(KRX; `_NX`/`_AL` 제거).
- 논리 오류는 HTTP 200 + `return_code != 0`. 빈 체결 구간은 `501724`
  (관련자료가없습니다)로 간주해 무시.

### 토스증권

- **자격증명**: 사용자당 **단일 OAuth2 client**(`TOSS_CREDENTIALS={clientId,clientSecret}`).
  계좌 관련 호출은 `X-Tossinvest-Account: <accountSeq>`(meta.accountSeq) 헤더가 필요하다.
  토큰은 KV 캐시(`toss:token:<env>:<credId>`), **클라이언트당 1개**만 유효해 재발급하면
  이전 토큰이 무효(`token-revoked`) → 토큰 오류 시 1회 재발급.
- **계좌 = 2행**: 한 계좌가 KR+US를 함께 보유하므로 `<accountNo>`(KRX) /
  `<accountNo>-us`(US, `meta.product="us"`)로 등록한다.
- **엔드포인트**: 보유 `GET /api/v1/holdings`, 예수금(근사) `GET /api/v1/buying-power`,
  체결 `GET /api/v1/orders?status=CLOSED`(커서 페이징, `execution`), 일봉
  `GET /api/v1/candles?interval=1d&adjusted=false`. **주문 내역에는 종목명이 없어**
  체결의 종목명은 `GET /api/v1/stocks`로 보강한다(best-effort). 경로 접두사는 `/api/v1`.
- **순자산 파생**: Toss에는 총자산 필드가 없어 `순자산 = 주식 평가금액 + 현금
  (buying-power 근사)`로 계산한다. Toss가 생략한 통화 합계(해당 시장 보유 없음)는 0으로
  저장한다.
- **IP 허용 + Caddy**: `TOSS_BASE_URL` + `X-Toss-Relay`(`TOSS_RELAY_SECRET`). WTS >
  Open API > 허용 IP 관리에 VPS IP를 등록해야 한다.
- 응답은 성공 시 `{ result }`, 실패 시 `{ error: { code, message, requestId } }`.
  금액·수량은 JSON **문자열**로 온다. `profitLoss.rate`는 소수 비율(0.1077 = 10.77%)이라
  퍼센트로 변환해 저장한다.
- 주의: Open API로 접수 가능한 호가유형만 `orders`에 노출(장전/장후 시간외 등 누락) →
  체결 이력이 불완전할 수 있다(best-effort). rate limit은 client × 그룹(`ACCOUNT` 1 TPS,
  `ASSET` 5, `MARKET_DATA_CHART` 20)이고 `429` + `Retry-After`. KR 시세는 통합
  (KRX+NXT)일 수 있어 KRX 종가 정책과 일치하는지 확인이 필요하다.

### FX (한국수출입은행)

- **별개 태스크**: `src/sync/fx.ts`(`syncFxRates`)가 조회·보관을 담당한다. 자체 크론
  **KST 월–금 12:00**(UTC `0 3 * * 2-6`)으로 돌고 `POST /sync/fx`로 수동 실행할 수 있다.
  보유와 무관하며, 실패해도 스냅샷에 영향을 주지 않는다.
- **출처**: 한국수출입은행 Open API(`src/fx/koreaexim.ts`)의 **매매기준율**
  (`deal_bas_r`, `data=AP01`, `oapi.koreaexim.go.kr`). 고시는 영업일 오전 11시
  전후라 KST 12:00에 수집하며, 영업일 11시 이전·주말·공휴일은 데이터가 없어 **직전
  영업일로 최대 7일 역추적**한다.
- **저장**: `fx_rates`(`UNIQUE (base, quote, date)`), `provider="koreaexim"`,
  `source="koreaexim-deal-bas-r"`. `date`는 관측일이 아니라 **실제 고시(영업)일**이다.
  현재 USD→KRW만 매핑한다.
- **source-agnostic**: 시장 FX 소스는 `BrokerProvider`가 아니라 `FxSource`(계좌 없음)이며
  `src/fx/registry.ts`에 등록한다. 브로커/`koreaexim` 필드명은 `src/fx/` 밖으로 새지
  않는다. 인증키는 `KOREAEXIM_API_KEY`(wrangler secret).

### IP 허용과 리버스 프록시 (키움·토스)

키움·토스는 **호출 IP 허용목록**이 필요하다. Cloudflare Worker의 egress IP는 허용목록에
등록할 수 없고, forward proxy 터널도 프로덕션 엣지에서 동작하지 않는다
(`cloudflare:sockets` `startTls()`는 `CONNECT` 후 SNI를 누락 — workerd #6903, `node:tls`도
동일). 그래서 **고정 IP VPS의 Caddy 리버스 프록시**로 우회한다:

```
Worker --HTTPS--> Caddy (허용 IP) --HTTPS--> api.kiwoom.com / openapi.tossinvest.com
```

- `deploy/caddy/kiwoom.caddy`, `deploy/caddy/toss.caddy`가 각 provider vhost다.
  VPS `/etc/caddy/Caddyfile`은 `import /etc/caddy/conf.d/*.caddy`를 포함하고, 각 broker
  파일을 복사한다. Caddy가 공인 인증서를 자동 발급·갱신한다(DNS-only A 레코드).
- Worker는 `KIWOOM_BASE_URL`/`TOSS_BASE_URL`로 Caddy를 호출하고, `X-Kiwoom-Relay`/
  `X-Toss-Relay`(각 relay secret)를 Caddy가 검사한다. KIS에는 필요 없다.

## 아키텍처

```
src/
  index.ts                 Worker entry: scheduled (cron) + fetch (manual/API)
  env.ts                   Bindings & secrets
  domain/types.ts          Normalized model + BrokerProvider / FxSource interfaces
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
    endpoints/              domestic / gold / us -> normalized types
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

sync 엔진은 `BrokerProvider` 인터페이스만 알기 때문에, 새 broker는
`src/providers/<id>/` 폴더 + registry 한 줄이면 된다.

## 데이터 모델 (D1)

| 테이블 | 그레인 | 비고 |
|---|---|---|
| `accounts` | provider + env + external_id | 런타임 계좌 레지스트리 |
| `instruments` | market + symbol | 안정적인 종목 기준 |
| `account_snapshots` | account + date | 현금/예수금 + 평가 합계 |
| `holdings` | account + date + market + symbol | 일별 포지션 |
| `price_daily` | market + symbol + date | OHLCV |
| `trades` | account + date + external_id + side | 매수/매도 체결 |
| `fx_rates` | base + quote + date | 시장 기준환율(USD/KRW), source-agnostic |
| `sync_runs` | run | 실행 이력 / 상태 |
| `sync_errors` | run + scope | 런별 구조화 오류(status/attempts/symbol 등) |

## Cloudflare 리소스

- Worker: `asset-tracker`
- D1: `asset-tracker-db` (binding `DB`) — `<d1-database-id>`
- KV: `asset-tracker-kv` (binding `CACHE`) — `<kv-namespace-id>`
- Cron:
  - `30 11 * * 2-6` (UTC Mon-Fri 11:30 = KST Mon-Fri 20:30) — KRX/금
  - `0 22 * * 2-6` (UTC Mon-Fri 22:00 = KST Tue-Sat 07:00) — US
  - `0 3 * * 2-6` (UTC Mon-Fri 03:00 = KST Mon-Fri 12:00) — FX
  - Cloudflare는 Quartz 요일(1=일 … 7=토)이라 Mon–Fri는 `2-6`.

`wrangler.jsonc`는 **gitignored**(계정별 id·프록시 호스트 보관)이고, 커밋 가능한 기본값은
`wrangler.example.jsonc`에 있다.

## 설정 (Setup)

```bash
pnpm install

# 바인딩 설정 (gitignored; D1/KV id와 프록시 호스트 포함)
cp wrangler.example.jsonc wrangler.jsonc   # 값 채우기

# 시크릿
cp .dev.vars.example .dev.vars             # 값 채우기

# 스키마 적용
pnpm db:migrate:local
pnpm db:migrate:remote

# provider별 자격증명 준비 후 계좌 등록 (아래 "계좌 등록" 참고)
pnpm kis:accounts -- --accounts 12345678-01 --sql > seeds/accounts.sql
pnpm db:seed:remote
pnpm kis:secret:put

pnpm run deploy
```

## 보안/시크릿

이 저장소는 **공개**다. 민감정보는 커밋하지 않는다. 자세한 규칙은
[`SECURITY.md`](./SECURITY.md)와 `AGENTS.md`의 "Secrets & PII" 참고.

시크릿은 **wrangler secret**으로만 저장하고, 로컬에서는 gitignored 파일
(`.dev.vars`, `*.credentials.json`, 토큰 캐시)을 쓴다. `wrangler secret put`은 **배포된
Worker**에만 적용되고, 로컬(`wrangler dev`)은 `.dev.vars`를 읽는다.

| 시크릿 | 로컬 | 프로덕션 |
|---|---|---|
| `KIS_CREDENTIALS` | `.kis-credentials.json` / `.dev.vars` | `pnpm kis:secret:put` |
| `KIWOOM_CREDENTIALS` | `.kiwoom-credentials.json` / `.dev.vars` | `pnpm kiwoom:secret:put` |
| `KIWOOM_RELAY_SECRET` | `.dev.vars` | `pnpm exec wrangler secret put KIWOOM_RELAY_SECRET` |
| `TOSS_CREDENTIALS` | `.toss-credentials.json` / `.dev.vars` | `pnpm toss:secret:put` |
| `TOSS_RELAY_SECRET` | `.dev.vars` | `pnpm exec wrangler secret put TOSS_RELAY_SECRET` |
| `KOREAEXIM_API_KEY` | `.dev.vars` | `pnpm exec wrangler secret put KOREAEXIM_API_KEY` |
| `ADMIN_TOKEN` | `.dev.vars` | `pnpm exec wrangler secret put ADMIN_TOKEN` |

자격증명 형식:

- **KIS** — 계좌별 키, `externalId`/`CANO`로 매칭:
  ```json
  { "12345678-01": { "appkey": "...", "appsecret": "..." } }
  ```
- **키움** — 계좌별 키, `externalId` → `meta.acctNo` → `meta.credKey`로 매칭:
  ```json
  { "12345678": { "appkey": "...", "appsecret": "..." } }
  ```
- **토스** — 사용자당 단일 client:
  ```json
  { "clientId": "...", "clientSecret": "..." }
  ```

## 계좌 등록 (Accounts)

계좌는 D1 `accounts` 행으로 등록하고, 시드는 `pnpm db:seed:remote`로 적용한다. `alias`는
사용자 지정 표시명이며(`resolveAccountName`: alias → name → externalId), 툴/시드는
`alias`를 쓰지 않으므로 수동 지정값이 재등록에도 유지된다.

- **KIS**: "계좌 목록" API가 없다. KIS Developers 포털 신청현황에서 `CANO`(8자리)와
  `ACNT_PRDT_CD`(보통 `01`)를 확인한다. `pnpm kis:accounts`가 계좌별 자체 키로 검증하고
  시드 SQL을 생성한다:
  ```bash
  pnpm kis:accounts -- --accounts 12345678-01,87654321-01 --trades
  pnpm kis:accounts -- --cano 12345678                 # 상품코드(01,22,29,03,08) 탐색
  pnpm kis:accounts -- --accounts 12345678-01 --sql > seeds/accounts.sql
  ```
- **키움**: `.kiwoom-credentials.json`의 각 키가 한 계좌에 묶여 있어 `ka00001`
  (계좌번호조회)로 계좌번호를 찾는다. `kt00018` 실패(`400114`) 시 금현물을 탐지하고,
  `ust21070` 성공 시 US 행을 추가한다(`--no-us`로 생략):
  ```bash
  pnpm kiwoom:accounts -- --sql > seeds/accounts.sql
  ```
- **토스**: 단일 client로 `GET /api/v1/accounts`에서 `accountSeq`/`accountNo`를 얻어
  KRX/US 2행을 만든다:
  ```bash
  pnpm toss:accounts -- --sql > seeds/accounts.sql
  ```

### 계좌별 체결 동기화 끄기

체결 엔드포인트를 지원하지 않는 계좌(예: KIS 퇴직연금 `APBK1744`)는 `meta`에
`"trades": false`를 넣어 건너뛴다. 그러면 런은 `success`로 유지된다:

```json
{ "cano": "11111111", "prdtCd": "29", "trades": false }
```

`pnpm kis:accounts --no-trades <account>`가 생성 시드에 이를 써 준다. 그 외 체결 수집은
best-effort이며, 예기치 않은 실패는 런 리포트에 `:trades`로 기록되고 스냅샷은 실패하지
않는다.

## 수동 실행 / API

관리 라우트는 `x-admin-token` 헤더(`ADMIN_TOKEN`)가 필요하다.

```bash
# Health (인증 불필요): 마지막 런 요약, 실패 시 503
curl https://asset-tracker.<subdomain>.workers.dev/health

# 오늘 동기화
curl -X POST https://asset-tracker.<subdomain>.workers.dev/sync \
  -H "x-admin-token: $ADMIN_TOKEN"

# 특정 날짜 재동기화, 체결 윈도우 확대
curl -X POST "https://asset-tracker.<subdomain>.workers.dev/sync?date=2026-09-18&lookbackDays=30" \
  -H "x-admin-token: $ADMIN_TOKEN"

# 조회
curl -H "x-admin-token: $ADMIN_TOKEN" .../accounts
curl -H "x-admin-token: $ADMIN_TOKEN" .../runs
curl -H "x-admin-token: $ADMIN_TOKEN" .../runs/<runId>

# FX 단독 실행 (기본: 오늘 KST)
curl -X POST https://asset-tracker.<subdomain>.workers.dev/sync/fx \
  -H "x-admin-token: $ADMIN_TOKEN"

# 특정 날짜/소스
curl -X POST "https://asset-tracker.<subdomain>.workers.dev/sync/fx?date=2026-09-21&source=koreaexim" \
  -H "x-admin-token: $ADMIN_TOKEN"
```

- `POST /sync`는 JSON 바디도 받는다: `{ "date": "...", "lookbackDays": 7, "provider": "kis" }`.
  `products`(콤마 구분)로 product 제한, 예: `?products=us`.
- `POST /sync/fx`는 `{ "date": "...", "source": "koreaexim", "base": "USD", "quote": "KRW" }`를 받는다.

## 명령어

| 명령 | 용도 |
|---|---|
| `pnpm dev` | 로컬 Worker |
| `pnpm test` | vitest |
| `pnpm typecheck` | tsc |
| `pnpm run deploy` | 배포 (`pnpm deploy`는 pnpm 내장 명령과 충돌) |
| `pnpm db:migrate:local` / `:remote` | 마이그레이션 적용 |
| `pnpm kis:accounts -- ...` | KIS 계좌 검증 / 시드 SQL 생성 |
| `pnpm kis:secret:put` | `.kis-credentials.json`을 `KIS_CREDENTIALS`로 업로드 |
| `pnpm kiwoom:accounts -- ...` | 키움 계좌 발견/검증 / 시드 SQL 생성 |
| `pnpm kiwoom:secret:put` | `.kiwoom-credentials.json`을 `KIWOOM_CREDENTIALS`로 업로드 |
| `pnpm toss:accounts -- ...` | 토스 계좌 발견/검증 / 시드 SQL 생성 |
| `pnpm toss:secret:put` | `.toss-credentials.json`을 `TOSS_CREDENTIALS`로 업로드 |
| `pnpm db:seed:local` / `:remote` | 계좌 시드 적용 |

## provider / 국가 추가하기

1. `src/providers/<id>/`에 `BrokerProvider` 구현을 추가한다.
2. `src/providers/registry.ts`에 등록한다(위치가 quote priority를 결정하므로
   `supportsMarket`을 구현해 시세가 처리 가능한 provider로 라우팅되게 한다).
3. 새 `provider`로 `accounts` 행을 시드한다.
4. market/country/currency는 스키마에 이미 있으므로 별도 마이그레이션이 필요 없다.
