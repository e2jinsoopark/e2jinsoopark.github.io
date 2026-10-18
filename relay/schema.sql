-- D1 schema for the invite-code relay (docs/RELAY.md §1). Safe to run again: every statement is IF NOT EXISTS.
-- Local:  npx wrangler d1 execute paper-relay --local --file schema.sql
-- Deploy: npx wrangler d1 execute paper-relay --remote --file schema.sql

CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY,               -- "PR-XXXX-XXXX"
  name TEXT NOT NULL,                  -- who the code was given to
  active INTEGER NOT NULL DEFAULT 1,   -- 0 = disabled
  allowed_models TEXT NOT NULL,        -- JSON array, e.g. ["claude-haiku-5-5"]
  daily_limit_usd REAL NOT NULL,
  created_at INTEGER NOT NULL,         -- epoch ms
  last_used_at INTEGER                 -- epoch ms of the last forwarded request
);

CREATE TABLE IF NOT EXISTS usage (
  code TEXT NOT NULL,
  day TEXT NOT NULL,                   -- Asia/Seoul calendar day, "YYYY-MM-DD"
  model TEXT NOT NULL,                 -- model that served (and billed) the tokens
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (code, day, model)
);

-- Today's total across all codes is read on every request; without this it would scan the whole history.
CREATE INDEX IF NOT EXISTS usage_by_day ON usage (day);
