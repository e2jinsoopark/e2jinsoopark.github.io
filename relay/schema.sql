-- D1 schema for the invite-code relay (docs/RELAY.md §1). Safe to run again: every statement is IF NOT EXISTS.
-- Local:  npx wrangler d1 execute paper-relay --local --file schema.sql
-- Deploy: npx wrangler d1 execute paper-relay --remote --file schema.sql

CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY,               -- "PR-XXXX-XXXX", or a custom code chosen by the owner ("EICU-2026", upper case)
  name TEXT NOT NULL,                  -- who the code was given to
  active INTEGER NOT NULL DEFAULT 1,   -- 0 = disabled
  allowed_models TEXT NOT NULL,        -- JSON array, e.g. ["claude-haiku-5-5"]
  daily_limit_usd REAL NOT NULL,
  created_at INTEGER NOT NULL,         -- epoch ms
  last_used_at INTEGER,                -- epoch ms of the last forwarded request
  person_salt TEXT,                    -- 32 hex (128 random bits) mixed into the personId of 공용 서재; NULL = a code made
                                       -- before code deletion (2026-10-19), which keeps its saltless personId
  library_id TEXT,                     -- 16 hex: the code's own library, codes/<library_id>/ in the team repo
                                       -- (docs/SHARED.md §6); NULL until a code from before code libraries first opens it
  library_max_bytes INTEGER            -- size cap of that library; NULL = CODE_LIBRARY_MAX_BYTES (500 MB by default)
);
-- person_salt, library_id, library_max_bytes and databases made before 2026-10-19: CREATE TABLE IF NOT EXISTS leaves
-- an existing codes table as it is, and SQLite/D1 has no "ADD COLUMN IF NOT EXISTS" (a plain ALTER TABLE here would
-- fail on the second run). So the Worker adds the missing columns itself the first time it needs them after the
-- update (src/db.js ensureCodeColumns: PRAGMA table_info, then ALTER TABLE codes ADD COLUMN … for each, and the unique
-- index codes_by_library on library_id — not created here, because on an old database the column does not exist yet
-- when this file runs). Everything else reads them as optional.

CREATE TABLE IF NOT EXISTS usage (
  code TEXT NOT NULL,                  -- the code; "deleted:<ISO time>:<code>" once that code was deleted (kept as history)
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

-- Codes are looked up by their key: the code without hyphens ("eicu 2026", "EICU2026" and "EICU-2026" all find
-- "EICU-2026"). Unique, so "EICU2026" cannot be created next to "EICU-2026". (Added with custom codes, 2026-10-19:
-- running this file again on an existing database adds it; existing PR-XXXX-XXXX codes never collide.)
CREATE UNIQUE INDEX IF NOT EXISTS codes_by_key ON codes (replace(code, '-', ''));

-- Failed-attempt limiter (src/limiter.js): per client IP (IPv6: its /64) and kind ('code' = invite-code lookups,
-- 'admin' = admin tokens), the failures in a 10-minute window that starts at the first failure. Written only on a
-- failure; rows of finished windows are pruned on every write.
CREATE TABLE IF NOT EXISTS auth_failures (
  ip TEXT NOT NULL,                    -- CF-Connecting-IP ("203.0.113.7", "2001:0db8:0001:0002::/64")
  kind TEXT NOT NULL,                  -- 'code' | 'admin'
  window_start INTEGER NOT NULL,       -- epoch ms of the window's first failure
  failures INTEGER NOT NULL,           -- failures counted in this window
  last_guess TEXT NOT NULL DEFAULT '', -- 16-hex SHA-256 fingerprint of the last failed value (a repeat is not counted)
  PRIMARY KEY (ip, kind)
);
CREATE INDEX IF NOT EXISTS auth_failures_by_window ON auth_failures (window_start);

-- Shared library ("공용 서재", docs/SHARED.md §2): trees created through the GitHub proxy, with the base tree they were
-- built on. POST git/commits accepts a tree only on top of its own base (so a commit cannot revert other people's
-- files), and only for the person who created it. Rows older than an hour are pruned on every insert.
CREATE TABLE IF NOT EXISTS shared_trees (
  lib TEXT NOT NULL,                   -- SHARED_LIBRARIES id, e.g. "team"; "code:<library_id>" for a code library
  tree TEXT NOT NULL,                  -- tree sha GitHub returned
  base TEXT NOT NULL,                  -- its base_tree sha ('' when the branch did not exist yet)
  person TEXT NOT NULL,                -- personId of the invite code that created it
  created_at INTEGER NOT NULL,         -- epoch ms
  PRIMARY KEY (lib, tree, base, person)
);
