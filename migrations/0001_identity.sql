CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT,
    avatar_url TEXT,
    plan TEXT NOT NULL DEFAULT 'free'
        CHECK (plan IN ('free', 'creator', 'pro', 'admin')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY NOT NULL
        CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE usage_quotas (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    storage_limit_bytes INTEGER NOT NULL CHECK (storage_limit_bytes >= 0),
    storage_used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (storage_used_bytes >= 0),
    max_asset_bytes INTEGER NOT NULL CHECK (max_asset_bytes > 0),
    timeline_limit INTEGER NOT NULL CHECK (timeline_limit >= 0),
    link_limit INTEGER NOT NULL CHECK (link_limit >= 0),
    updated_at TEXT NOT NULL
);
