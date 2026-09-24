-- User-set display name for an account. When set, it overrides the default
-- `name` (broker/tooling value) in presentation; empty means fall back.

ALTER TABLE accounts ADD COLUMN alias TEXT;
