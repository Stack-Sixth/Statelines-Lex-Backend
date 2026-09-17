-- Run on the RECEIVING platform's database, not through its browser.
CREATE SCHEMA IF NOT EXISTS lex_receiver;
CREATE TABLE IF NOT EXISTS lex_receiver.inbox (
 source text NOT NULL,
 event_id uuid NOT NULL,
 envelope jsonb NOT NULL,
 state text NOT NULL DEFAULT 'accepted' CHECK(state IN ('accepted','processed','failed')),
 received_at timestamptz NOT NULL DEFAULT now(),
 processed_at timestamptz,
 PRIMARY KEY(source,event_id)
);
REVOKE ALL ON SCHEMA lex_receiver FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA lex_receiver FROM PUBLIC;
ALTER TABLE lex_receiver.inbox ENABLE ROW LEVEL SECURITY;
