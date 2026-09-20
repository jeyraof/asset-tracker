-- Provider-agnostic spot FX rates, recorded per (pair, date).

CREATE TABLE IF NOT EXISTS fx_rates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  base_currency  TEXT    NOT NULL,
  quote_currency TEXT    NOT NULL,
  date           TEXT    NOT NULL,
  rate           REAL    NOT NULL,
  provider       TEXT,
  source         TEXT,
  raw_json       TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (base_currency, quote_currency, date)
);

CREATE INDEX IF NOT EXISTS idx_fx_rates_date
  ON fx_rates (date);
