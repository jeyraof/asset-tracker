-- Add the account's real account number (PII). Backfilled by deriving from the
-- existing columns/meta, so no real value is written into this public migration.

ALTER TABLE accounts ADD COLUMN account_no TEXT;

UPDATE accounts SET account_no = external_id
 WHERE provider = 'kis' AND account_no IS NULL;

UPDATE accounts SET account_no = json_extract(meta_json, '$.acctNo')
 WHERE provider = 'kiwoom' AND account_no IS NULL;

UPDATE accounts SET account_no = json_extract(meta_json, '$.accountNo')
 WHERE provider = 'toss' AND account_no IS NULL;
