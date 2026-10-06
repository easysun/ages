-- Worst case is 403 fixed JSON characters plus six ASCII characters for each
-- of 2,100 allowed UTF-16 string units when JSON.stringify escapes lone surrogates.
CREATE TABLE tracking_tickets_new (
    token_hash TEXT PRIMARY KEY NOT NULL,
    link_id TEXT NOT NULL REFERENCES distribution_links(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('url', 'timeline', 'asset')),
    event_json TEXT NOT NULL CHECK (
        length(event_json) <= 13003 AND
        json_valid(event_json) AND json_type(event_json) = 'object'
    ),
    providers_json TEXT NOT NULL CHECK (
        length(providers_json) <= 2048 AND
        json_valid(providers_json) AND json_type(providers_json) = 'object'
    ),
    expires_at TEXT NOT NULL,
    consumed_at TEXT
);

INSERT INTO tracking_tickets_new (
    token_hash, link_id, target_kind, event_json, providers_json, expires_at, consumed_at
)
SELECT
    token_hash, link_id, target_kind, event_json, providers_json, expires_at, consumed_at
FROM tracking_tickets;

DROP TABLE tracking_tickets;
ALTER TABLE tracking_tickets_new RENAME TO tracking_tickets;

CREATE INDEX idx_tracking_tickets_expiry
ON tracking_tickets(expires_at, token_hash);
