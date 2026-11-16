-- The setup library (docs/SETUP_LIBRARY.md). No IP addresses, user agents, extension versions
-- or browser names are stored anywhere.

CREATE TABLE publishers (
  id          TEXT PRIMARY KEY,           -- SHA-256 of the public key, first 16 bytes, base64url
  public_key  TEXT NOT NULL,              -- raw P-256 key, base64url
  created_at  INTEGER NOT NULL,           -- Unix ms, first seen
  blocked     INTEGER NOT NULL DEFAULT 0  -- 1: can't publish, vote or report
);

CREATE TABLE setups (
  id          TEXT PRIMARY KEY,           -- 10 random base58 characters
  code        TEXT NOT NULL,              -- canonical SF2- code, rebuilt by the server
  code_hash   TEXT NOT NULL UNIQUE,       -- SHA-256 of code: each setup is published once
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  websites    TEXT NOT NULL,              -- space-separated site ids / domains, from the code
  tags        TEXT NOT NULL DEFAULT '',   -- space-separated, from the fixed list
  summary     TEXT NOT NULL,              -- JSON from summarizeShared
  publisher   TEXT NOT NULL REFERENCES publishers(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  upvotes     INTEGER NOT NULL DEFAULT 0,
  reports     INTEGER NOT NULL DEFAULT 0, -- open reports since the last admin review
  status      TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'hidden', 'removed')),
  reviewed    INTEGER NOT NULL DEFAULT 0  -- 1: an admin restored it; reports no longer hide it
);
CREATE INDEX setups_live_top ON setups (status, upvotes DESC, created_at DESC);
CREATE INDEX setups_live_new ON setups (status, created_at DESC);
CREATE INDEX setups_publisher ON setups (publisher);

CREATE TABLE setup_websites (
  setup_id TEXT NOT NULL REFERENCES setups(id) ON DELETE CASCADE,
  website  TEXT NOT NULL,
  PRIMARY KEY (setup_id, website)
);
CREATE INDEX setup_websites_by_website ON setup_websites (website);

CREATE TABLE setup_tags (
  setup_id TEXT NOT NULL REFERENCES setups(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (setup_id, tag)
);
CREATE INDEX setup_tags_by_tag ON setup_tags (tag);

-- Full-text search over titles and descriptions. Kept in step with setups by the Worker.
-- (`wrangler d1 export` skips virtual tables: rebuild it from setups after a restore.)
CREATE VIRTUAL TABLE setups_fts USING fts5(setup_id UNINDEXED, title, description);

CREATE TABLE votes (
  setup_id   TEXT NOT NULL REFERENCES setups(id) ON DELETE CASCADE,
  publisher  TEXT NOT NULL REFERENCES publishers(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (setup_id, publisher)
);

CREATE TABLE reports (
  setup_id   TEXT NOT NULL REFERENCES setups(id) ON DELETE CASCADE,
  publisher  TEXT NOT NULL REFERENCES publishers(id),
  reason     TEXT NOT NULL CHECK (reason IN ('offensive', 'spam', 'misleading', 'other')),
  note       TEXT NOT NULL DEFAULT '',   -- seen only by admins
  created_at INTEGER NOT NULL,
  resolved   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (setup_id, publisher)
);

-- Daily counts for per-key limits ('*' is everyone, for the publishing circuit breaker).
-- Rows older than two days are deleted by the daily cron.
CREATE TABLE activity (
  publisher TEXT NOT NULL,
  day       TEXT NOT NULL,              -- YYYY-MM-DD, UTC
  kind      TEXT NOT NULL CHECK (kind IN ('publish', 'vote', 'report')),
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (publisher, day, kind)
);
