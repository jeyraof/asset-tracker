-- D+2 (settlement-inclusive) deposit, distinct from the D+0 deposit_total.
--
-- Brokers publish a D+0/D+1/D+2 deposit triplet (KIS dnca_tot_amt /
-- nxdy_excc_amt / prvs_rcdl_excc_amt; Kiwoom entr / d1_entra / d2_entra). Equity
-- trades settle T+2, so a buy's cash effect reaches deposit_total (D+0) only on
-- the settlement day, while settlement_deposit (D+2) reflects it immediately.
-- Consumers that want "cash" consistent with the same-day holdings should read
-- settlement_deposit, falling back to deposit_total when it is NULL (gold/US/Toss).
ALTER TABLE account_snapshots ADD COLUMN settlement_deposit REAL;

-- Backfill existing rows from the stored raw summary.
UPDATE account_snapshots
SET settlement_deposit = CAST((
  SELECT CASE a.provider
    WHEN 'kis'    THEN json_extract(account_snapshots.raw_json, '$.prvs_rcdl_excc_amt')
    WHEN 'kiwoom' THEN json_extract(account_snapshots.raw_json, '$.deposit.d2_entra')
  END
  FROM accounts a WHERE a.id = account_snapshots.account_id
) AS REAL)
WHERE account_id IN (SELECT id FROM accounts WHERE provider IN ('kis', 'kiwoom'));
