# Seeds are applied with:
#   npm run db:seed:remote
#
# Registers a KIS account. `external_id` is "CANO-PRDT_CD"; `account_no` is the
# real account number (PII).
# provider = 'kis', env = 'prod' | 'vts'.
#
# Replace the placeholder values below, then run the seed command.

INSERT INTO accounts (provider, env, external_id, country, currency, name, account_no, active, meta_json)
VALUES (
  'kis',
  'prod',
  '<8-digit-CANO>-01',
  'KR',
  'KRW',
  'KIS main',
  '<8-digit-CANO>-01',
  1,
  '{"cano":"<8-digit-CANO>","prdtCd":"01"}'
)
ON CONFLICT (provider, env, external_id) DO UPDATE SET
  name = excluded.name,
  account_no = excluded.account_no,
  active = excluded.active,
  meta_json = excluded.meta_json,
  updated_at = datetime('now');

# Registers a Kiwoom account. `external_id` is the account number returned by
# ka00001; `credKey` is the key used in .kiwoom-credentials.json.
INSERT INTO accounts (provider, env, external_id, country, currency, name, account_no, active, meta_json)
VALUES (
  'kiwoom',
  'prod',
  '<10-digit-acctNo>',
  'KR',
  'KRW',
  'Kiwoom main',
  '<10-digit-acctNo>',
  1,
  '{"acctNo":"<10-digit-acctNo>","credKey":"<credentials-file-key>"}'
)
ON CONFLICT (provider, env, external_id) DO UPDATE SET
  name = excluded.name,
  account_no = excluded.account_no,
  active = excluded.active,
  meta_json = excluded.meta_json,
  updated_at = datetime('now');
