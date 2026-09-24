# CHANGELOG

`asset-tracker`의 주요 변경 이력입니다. **최신 우선**. 과거 개발 메모를 그대로
보존합니다(당시 기준의 수치 포함).

## 2026-09-25 — 토스증권 provider

- `src/providers/toss/` 추가, `registry`에 등록(quote priority `kis → kiwoom → toss`).
  **사용자당 단일 OAuth2 client**(`TOSS_CREDENTIALS={clientId,clientSecret}`) +
  `X-Tossinvest-Account: <accountSeq>`(meta.accountSeq). 한 계좌가 KR+US를 함께
  보유하므로 **두 행**으로 등록: `<accountNo>`(KRX) / `<accountNo>-us`(US,
  `meta.product="us"`). 계좌 식별은 **실제 계좌번호(accountNo)** 기준.
- 매핑: 보유 `GET /api/v1/holdings`(시장별 필터, `Price{krw,usd}` 합산), 예수금은
  `GET /api/v1/buying-power`(`cashBuyingPower`)로 **근사**, 순자산 = 주식+현금 파생
  (Toss가 생략한 통화 합계는 0), 체결은 `GET /api/v1/orders?status=CLOSED`(커서 페이징,
  `execution` 사용), 일봉은 `GET /api/v1/candles?interval=1d&adjusted=false`.
- IP 허용 필요 → 키움과 동일하게 Caddy 리버스 프록시
  (`deploy/caddy/toss.caddy`, `TOSS_BASE_URL`, `X-Toss-Relay`/`TOSS_RELAY_SECRET`).
- 주의: Open API로 접수 가능한 호가유형만 `orders`에 노출(시간외 등 누락), 토큰은
  클라이언트당 1개(`token-revoked`), KR 시세는 통합(KRX+NXT)일 수 있음.
- 계좌 등록: `pnpm toss:accounts -- --sql > seeds/accounts.sql`.
- 검증: 원격 `POST /sync?provider=toss` 성공(보유 3, 일봉 9). 과거 체결은
  `?lookbackDays=90` 백필로 반영.
- `pnpm test` 130 → 132 passed, `pnpm typecheck` 통과.

## 2026-09-24 — 관측성 · alias · FX 원천 교체 · 보안 정책

- **재시도·오류 기록·관측성**:
  - KIS 클라이언트가 `response.ok`를 확인하지 않아 5xx(JSON) 응답을 성공 처리하던
    문제 제거. 이제 non-2xx는 `KisApiError`로 처리.
  - 공용 `src/lib/retryPolicy.ts`: HTTP 429/5xx/네트워크(및 브로커 rate-limit 코드)
    재시도, `Retry-After` 존중, 15초 fetch 타임아웃. KIS·키움·토스에 적용.
  - 종목별 시세 실패를 `QuoteFetchResult.failures`로 수집 → 다음 provider로 fallback,
    최종 실패는 `report.errors`에 기록.
  - `sync_errors` 테이블(마이그레이션 `0003`)에 런 단위 구조화 오류 영속화.
  - `/health`가 마지막 런 요약을 반환하고 실패 시 **503**(외부 모니터용),
    `GET /runs/:runId`(admin) 추가, observability traces 활성화.
- **계정 alias**: `accounts.alias`(마이그레이션 `0004`) + `resolveAccountName`
  (alias → name → externalId). `GET /accounts`가 `alias`/`displayName` 반환.
- **FX 원천 교체**: 키움 `ust31301`(환전 적용환율=가환율)을 제거하고
  **한국수출입은행 매매기준율**(`src/fx/koreaexim.ts`, `FxSource`)로 교체.
  자체 크론 KST 12:00, `fx_rates.date`는 실제 고시일, 기존 값 정리(`0005`).
- **보안/PII**: `SECURITY.md` + `AGENTS.md` "Secrets & PII" 섹션 추가, 공개 이력에서
  실제 호스트/계좌번호 제거(`git filter-branch`).
- `pnpm test` 105 → 111 passed, `pnpm typecheck` 통과.

## 2026-09-21 — KRX 크론 이동 · FX 태스크

- KRX/금 스케줄을 **KST 20:30**(UTC Mon–Fri 11:30, `30 11 * * 2-6`)으로 이동하고,
  US를 KST 07:00(UTC Mon–Fri 22:00, `0 22 * * 2-6`)에 분리. `src/index.ts`가
  `controller.cron`으로 date/`products`를 선택하며, US는 **ET 세션 날짜**(`etDate`) 사용.
- FX를 **별도 태스크**(`src/sync/fx.ts`)로 분리(당시엔 키움 `ust31301`, 이후 09-24에
  수출입은행으로 교체). FX vs US 스냅샷 날짜 의미(ET vs KST 하루 차이) 문서화.

## 2026-09-20 — KIS 계좌별 자격증명 · 키움 · 키움 미국주식 · 시세 정렬

### KIS 계좌별 자격증명

- 계좌별 자격증명 전환: `KIS_CREDENTIALS` JSON secret(계좌 external id → 키),
  계좌별 `KisClient`/토큰 캐시 분리(`kis:token:<env>:<credId>`), 계좌 미지정 시세는
  첫 계좌 키 재사용.
- 로컬 도구 `scripts/kis-accounts.ts`: `.kis-credentials.json` 기반 계좌별 검증/시드 SQL
  생성(`--sql`은 시크릿 없이 stdout, 진행 로그는 stderr). `--no-trades`로 체결 조회 비활성화.
  `pnpm kis:secret:put`으로 secret 업로드.
- `meta.trades = false`인 계좌는 체결 조회를 건너뛴다(provider-agnostic). 퇴직연금 계좌에
  적용되어 실행 status가 `success`로 유지됨.
- 구 단일 app key(appkey/appsecret) 방식은 코드·로컬 데이터·원격 secret에서 완전히 제거됨.
- 계좌 원격 D1 등록, `KIS_CREDENTIALS`/`ADMIN_TOKEN` secret 업로드, Worker 배포 및
  원격 `POST /sync` 검증 완료.
- `pnpm test` 34 passed, `pnpm typecheck` 통과.

### 키움증권 추가

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

### 시세 중복 제거 + KRX 정규장 정렬

- **종목별 단일 시세 출처**: 여러 증권사가 같은 종목을 보유해도 시세는 한 번만
  조회한다. `src/sync/quoteSources.ts`가 종목별 후보 provider를
  `quoteProviderPriority()`(registry 순서)로 정렬하고, 첫 후보로 묶어 조회한다.
  실패하면 해당 종목만 다음 후보로 폴백한다.
- **KRX 정규장 고정**: KIS `FID_COND_MRKT_DIV_CODE=J`(KRX), Kiwoom plain 6자리
  코드(=`_NX`/`_AL` 접미사 제거)만 사용. KRX/NXT 프리·애프터마켓은 제외하며 KRX
  15:30 종가가 공식 종가다. 시세는 비수정주가(KIS `FID_ORG_ADJ_PRC=1`, Kiwoom
  `upd_stkpc_tp=0`).
- **NXT 체결 포함**: KIS 체결 `EXCG_ID_DVSN_CD=ALL`, Kiwoom 체결 `dmst_stex_tp=%`.
- **실 API 확인**: Kiwoom `kt00018`은 `dmst_stex_tp=KRX`/`NXT`에서 보유 집합·수량이
  동일(예: `005930:10`) — 거래소 구분은 평가 시세 선택일 뿐이라 KRX 유지로 누락 없음.
  KIS 일봉은 `J`와 `NX`의 OHLC·거래량이 다르고(예: 005930 2026-09-18 O 261,000 vs
  259,500, V 17.49M vs 6.58M) 종가도 갈릴 때가 있어(000660 2026-09-17 1,745,000 vs
  1,766,000) KRX 고정이 실제로 의미가 있다.
- `pnpm test` 75 passed, `pnpm typecheck` 통과.

### 키움 미국주식 추가

- 별도 계좌행으로 등록: `external_id="<acctNo>-us"`, `country="US"`, `currency="USD"`,
  `meta.product="us"` (금현물과 동일한 패턴). 토큰=계좌라 자격증명은 그대로 해석된다.
- 엔드포인트: 잔고 `ust21070`(원장잔고), 체결 `ust21100`(미국주식 거래내역, 날짜 범위 1회),
  일봉 `usa06012`(`upd_stkpc_tp=0`, `exrt_appl_tp=0`), 거래소 조회 `usa10098`.
  경로는 `/api/us/acnt`·`/api/us/chart`·`/api/us/stkinfo`이고 목록 키는 `result_list`다.
- 잔고·체결에 거래소 정보가 없어(`stex_nm="미국"`) 시세 조회 시 `usa10098`로
  `stex_tp`(ND/NY/NA)를 해석한다(인메모리 캐시). `market="US"` 단일 시장.
- **정규장 종가 고정**: KST 07:00 실행은 미국 정규장(마감 익일 KST 05:00/06:00) 이후지만
  시간외 구간이라, 보유평가를 `usa06012` 정규장 종가(캔들 `dt == date`)로 재계산한다.
- 라이브 확인: `ust21100`은 `krw_repl_skip_yn="N"`이 실제로 필수(`1511`),
  `usa06012`의 `strt_dt`는 **기준일(포함)**이라 `from`이 아니라 `date`를 보내야 한다(아니면
  구간이 조용히 비어버림). 거래소를 잘못 주면 `1903`(QLD는 `ND`가 아니라 `NY`).
- **소수점(소수점매매) 보유는 미지원(키움 확인)**: `ust21070`/`ust21170`의 `poss_qty`는
  정수 주식만 준다(예: QLD 22, SPYM 23). 소수점 수량은 체결 `ust21100`의 `deal_qty`에만
  소수점으로 내려오고, 소수점 *가치*는 집계(`ust21120`/`ust21121`/`ust21131`/`ust21132`)에
  포함돼 `ust21070` 합계보다 크다(관측 4063.72 vs 4247.50 USD). 키움 REST가 소수점 잔고를
  지원하면 `mapUsHolding`/`ust21070` 파싱만 확장하면 된다(`quantity`는 REAL).
- **스케줄 분리**: KRX/금현물은 KST 20:30, 미국은 KST 07:00에 별도 실행. US 실행은 ET
  세션 날짜(`etDate`)를 쓴다.
- US 티커는 `stripSymbol`을 태우지 않는다(7자 `A/J/Q` 티커 손상 방지).
- `pnpm test` 88 passed, `pnpm typecheck` 통과.

### 계좌 검증/동기화 결과 (로컬·원격)

| 계좌 | 잔고 조회 | 체결내역 조회 |
| --- | --- | --- |
| `22222222-01` | 정상 (예수금 N원, 보유 0) | 정상 (0건) |
| `33333333-22` | 정상 (예수금 N원, 보유 0) | 정상 (0건) |
| `11111111-29` | 정상 (보유 1, 평가 N원) | `APBK1744`로 건너뜀 (`meta.trades=false`) |

- 계좌별 키로 전환한 뒤 이전 `INVALID_CHECK_ACNO` / `APTR0058` 문제가 모두 해소됨.
- `11111111-29`는 퇴직연금계좌라 `inquire-daily-ccld`가 원천 미지원(`APBK1744`).
  `meta.trades=false`로 체결 조회를 건너뛰어 실행 status가 `success`로 유지된다.
- `22222222-01`은 예수금 N원·보유 0으로 사실상 비어 있음 → 실제 관리 대상인지 확인 필요.

### 기타 메모

- 관리 대상이 아니면 `22222222-01`을 `active = 0`으로 내리거나 시드에서 제거.
- 자격증명은 `KIS_CREDENTIALS`(계좌별 JSON) 하나만 사용한다.
- 체결 조회를 지원하지 않는 계좌는 `meta.trades = false`로 표시해 건너뛴다.
- 원격 KV는 비어 있으므로 첫 배포 직후 첫 sync에서 토큰 발급이 필요하다. KIS 토큰은
  appkey당 1분에 1회만 발급되니, 직전에 로컬 `kis:accounts`를 돌렸다면 1분 뒤 재시도.
- `pnpm kis:accounts`는 계좌별 appkey(마스킹)를 표시하며, `--sql`은 시크릿 없이 accounts
  행만 생성.
- `DEBUG_KIS=1`(워커는 `--var DEBUG_KIS:1`)로 KIS 요청 로깅(시크릿 미노출).
- 로컬 토큰은 `.kis-token-cache.json`(gitignore)에 자격증명별로 캐시되어 재발급 알림/
  1분 제한을 피함.
