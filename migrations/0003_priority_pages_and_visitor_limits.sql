-- Owner-chosen pages that are always indexed first (JSON array of URLs).
ALTER TABLE bots ADD COLUMN priority_urls TEXT;

-- Per-visitor message counter (hashed IP, hourly buckets) to stop one visitor
-- from using up an assistant's daily quota. Rows older than 2 days are pruned.
CREATE TABLE IF NOT EXISTS visitor_usage (
  bot_id   TEXT NOT NULL,
  visitor  TEXT NOT NULL,   -- sha256(ip + bot_id), never the raw IP
  hour     TEXT NOT NULL,   -- e.g. 2026-11-19T08
  messages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_id, visitor, hour)
);
CREATE INDEX IF NOT EXISTS idx_visitor_usage_hour ON visitor_usage (hour);
