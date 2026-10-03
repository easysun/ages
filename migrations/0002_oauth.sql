CREATE TABLE oauth_identities (
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (issuer, subject),
    UNIQUE (user_id, issuer)
);

CREATE TABLE oauth_attempts (
    state_hash TEXT PRIMARY KEY NOT NULL CHECK (length(state_hash) = 64),
    browser_hash TEXT NOT NULL CHECK (length(browser_hash) = 64),
    verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX idx_oauth_attempts_expires ON oauth_attempts(expires_at);
