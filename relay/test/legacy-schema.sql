-- Test fixture: relay/schema.sql as it was before code deletion (2026-10-19) — codes WITHOUT person_salt — plus two
-- codes made back then. relay/test/lib.mjs migratedDatabase applies this, then today's schema.sql twice, so the relay
-- tests run on a database shaped like the deployed one after its update (the Worker adds person_salt itself).
-- Never applied to a real database.

CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  allowed_models TEXT NOT NULL,
  daily_limit_usd REAL NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS usage (
  code TEXT NOT NULL,
  day TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (code, day, model)
);

CREATE INDEX IF NOT EXISTS usage_by_day ON usage (day);

CREATE UNIQUE INDEX IF NOT EXISTS codes_by_key ON codes (replace(code, '-', ''));

CREATE TABLE IF NOT EXISTS auth_failures (
  ip TEXT NOT NULL,
  kind TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  last_guess TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (ip, kind)
);
CREATE INDEX IF NOT EXISTS auth_failures_by_window ON auth_failures (window_start);

CREATE TABLE IF NOT EXISTS shared_trees (
  lib TEXT NOT NULL,
  tree TEXT NOT NULL,
  base TEXT NOT NULL,
  person TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (lib, tree, base, person)
);

-- Codes from before person salts (lib.mjs LEGACY_CODES): their personId stays SHA-256 / HMAC of the code alone.
INSERT INTO codes (code, name, active, allowed_models, daily_limit_usd, created_at)
VALUES ('PR-01DC-0DE5', '예전 코드', 1, '["claude-haiku-5-5"]', 0.5, 1760000000000),
       ('OLD-WARD-7B', '예전 그룹', 1, '["claude-haiku-5-5"]', 0.5, 1760000000000);
