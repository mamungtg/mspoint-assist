-- One-time sign-in links sent by mail (owner key recovery).
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,           -- sha256 of the token in the link
  email      TEXT NOT NULL,
  bot_id     TEXT NOT NULL,
  expires_at TEXT NOT NULL,              -- ISO time, 30 minutes after creation
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_tokens_email ON login_tokens (email, created_at);
