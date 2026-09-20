-- asset-tracker initial schema.
-- Designed to be provider/broker agnostic: KIS is the first provider.

CREATE TABLE IF NOT EXISTS accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider     TEXT    NOT NULL,
  env          TEXT    NOT NULL DEFAULT 'prod',
  external_id  TEXT    NOT NULL,
  country      TEXT    NOT NULL DEFAULT 'KR',
  currency     TEXT    NOT NULL DEFAULT 'KRW',
  name         TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  meta_json    TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, env, external_id)
);

CREATE INDEX IF NOT EXISTS idx_accounts_active
  ON accounts (provider, active);

CREATE TABLE IF NOT EXISTS instruments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  market     TEXT    NOT NULL,
  symbol     TEXT    NOT NULL,
  country    TEXT    NOT NULL DEFAULT 'KR',
  currency   TEXT    NOT NULL DEFAULT 'KRW',
  name       TEXT,
  provider   TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (market, symbol)
);

CREATE TABLE IF NOT EXISTS account_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id            INTEGER NOT NULL REFERENCES accounts (id),
  snapshot_date         TEXT    NOT NULL,
  currency              TEXT    NOT NULL DEFAULT 'KRW',
  deposit_total         REAL,
  next_day_settlement   REAL,
  total_eval_amount     REAL,
  securities_eval_amount REAL,
  purchase_amount_total  REAL,
  eval_pfls_amount      REAL,
  net_asset_amount      REAL,
  raw_json              TEXT,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_account_snapshots_date
  ON account_snapshots (snapshot_date);

CREATE TABLE IF NOT EXISTS holdings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        INTEGER NOT NULL REFERENCES accounts (id),
  snapshot_date     TEXT    NOT NULL,
  market            TEXT    NOT NULL DEFAULT 'KRX',
  symbol            TEXT    NOT NULL,
  product_name      TEXT,
  currency          TEXT    NOT NULL DEFAULT 'KRW',
  quantity          REAL,
  avg_price         REAL,
  purchase_amount   REAL,
  current_price     REAL,
  eval_amount       REAL,
  eval_pfls_amount  REAL,
  eval_pfls_rate    REAL,
  raw_json          TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, snapshot_date, market, symbol)
);

CREATE INDEX IF NOT EXISTS idx_holdings_date
  ON holdings (snapshot_date);
CREATE INDEX IF NOT EXISTS idx_holdings_symbol
  ON holdings (market, symbol);

CREATE TABLE IF NOT EXISTS price_daily (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  market     TEXT    NOT NULL DEFAULT 'KRX',
  symbol     TEXT    NOT NULL,
  date       TEXT    NOT NULL,
  open       REAL,
  high       REAL,
  low        REAL,
  close      REAL,
  volume     REAL,
  currency   TEXT    NOT NULL DEFAULT 'KRW',
  provider   TEXT,
  source     TEXT,
  raw_json   TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (market, symbol, date)
);

CREATE INDEX IF NOT EXISTS idx_price_daily_date
  ON price_daily (date);

CREATE TABLE IF NOT EXISTS trades (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts (id),
  trade_date   TEXT    NOT NULL,
  external_id  TEXT    NOT NULL,
  market       TEXT    NOT NULL DEFAULT 'KRX',
  symbol       TEXT    NOT NULL,
  product_name TEXT,
  side         TEXT    NOT NULL,
  quantity     REAL,
  avg_price    REAL,
  amount       REAL,
  currency     TEXT    NOT NULL DEFAULT 'KRW',
  order_time   TEXT,
  raw_json     TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, trade_date, external_id, side)
);

CREATE INDEX IF NOT EXISTS idx_trades_date
  ON trades (trade_date);
CREATE INDEX IF NOT EXISTS idx_trades_symbol
  ON trades (market, symbol);

CREATE TABLE IF NOT EXISTS sync_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT    NOT NULL UNIQUE,
  provider     TEXT,
  source       TEXT    NOT NULL DEFAULT 'cron',
  status       TEXT    NOT NULL DEFAULT 'running',
  started_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT,
  details_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_started
  ON sync_runs (started_at);
