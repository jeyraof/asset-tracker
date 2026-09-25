-- Unified run history: distinguish broker syncs from the FX task.
-- `provider` holds a broker id when task='sync' and an FX source id when task='fx'.

ALTER TABLE sync_runs ADD COLUMN task TEXT NOT NULL DEFAULT 'sync';
