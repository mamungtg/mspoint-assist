-- Owner-defined instructions per assistant, and richer leads.
ALTER TABLE bots ADD COLUMN instructions TEXT;

ALTER TABLE leads ADD COLUMN company TEXT;
ALTER TABLE leads ADD COLUMN priority TEXT;     -- high | medium | low
ALTER TABLE leads ADD COLUMN summary TEXT;      -- one-line AI summary of the request
ALTER TABLE leads ADD COLUMN transcript TEXT;   -- last messages of the chat (JSON)
