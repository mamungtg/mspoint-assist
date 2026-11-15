-- MSPoint Assist initial schema

CREATE TABLE IF NOT EXISTS bots (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  site_url      TEXT NOT NULL,
  owner_email   TEXT NOT NULL,
  key_hash      TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'free',
  status        TEXT NOT NULL DEFAULT 'indexing',   -- indexing | ready | error
  status_detail TEXT,
  pages_indexed INTEGER NOT NULL DEFAULT 0,
  chunks        INTEGER NOT NULL DEFAULT 0,
  greeting      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id     TEXT NOT NULL,
  name       TEXT,
  email      TEXT NOT NULL,
  phone      TEXT,
  message    TEXT,
  page_url   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_bot ON leads (bot_id, created_at);

CREATE TABLE IF NOT EXISTS usage (
  bot_id   TEXT NOT NULL,
  day      TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_id, day)
);
