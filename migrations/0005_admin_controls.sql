-- Admin controls per assistant.
ALTER TABLE bots ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;  -- 1 = widget and chat disabled
ALTER TABLE bots ADD COLUMN daily_limit INTEGER;                   -- overrides FREE_DAILY_MESSAGES
ALTER TABLE bots ADD COLUMN max_pages INTEGER;                     -- overrides MAX_CRAWL_PAGES
ALTER TABLE bots ADD COLUMN admin_note TEXT;                       -- private note, admin only
