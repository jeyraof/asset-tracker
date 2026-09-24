-- Structured per-run sync errors, so failures are queryable across runs
-- (by provider/symbol/status) instead of being buried in details_json.

CREATE TABLE IF NOT EXISTS sync_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT    NOT NULL,
  provider    TEXT,
  external_id TEXT,
  market      TEXT,
  symbol      TEXT,
  scope       TEXT    NOT NULL,
  status      INTEGER,
  code        TEXT,
  attempts    INTEGER,
  path        TEXT,
  message     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_errors_created
  ON sync_errors (created_at);
CREATE INDEX IF NOT EXISTS idx_sync_errors_symbol
  ON sync_errors (provider, symbol);
CREATE INDEX IF NOT EXISTS idx_sync_errors_run
  ON sync_errors (run_id);
