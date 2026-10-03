CREATE TABLE assets (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file')),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'ready', 'failed', 'deleted', 'purged')),
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
    r2_key TEXT NOT NULL UNIQUE,
    etag TEXT,
    captured_at TEXT,
    width INTEGER,
    height INTEGER,
    duration_ms INTEGER,
    visibility TEXT NOT NULL DEFAULT 'private'
        CHECK (visibility IN ('private', 'unlisted', 'public')),
    upload_expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE INDEX idx_assets_owner_created ON assets(owner_id, created_at DESC, id DESC);
CREATE INDEX idx_assets_owner_status ON assets(owner_id, status);
CREATE INDEX idx_assets_upload_expiry ON assets(status, upload_expires_at, id);

CREATE TRIGGER assets_immutable_storage BEFORE UPDATE ON assets
WHEN OLD.owner_id != NEW.owner_id OR OLD.r2_key != NEW.r2_key OR OLD.size_bytes != NEW.size_bytes
BEGIN
    SELECT RAISE(ABORT, 'immutable_asset_storage');
END;

CREATE TRIGGER assets_status_transition BEFORE UPDATE OF status ON assets
WHEN OLD.status != NEW.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('ready', 'failed')) OR
    (OLD.status = 'ready' AND NEW.status = 'deleted') OR
    (OLD.status = 'deleted' AND NEW.status IN ('ready', 'purged')) OR
    (OLD.status = 'failed' AND NEW.status = 'purged')
)
BEGIN
    SELECT RAISE(ABORT, 'invalid_asset_transition');
END;

CREATE TRIGGER assets_account_completed AFTER UPDATE OF status ON assets
WHEN OLD.status = 'pending' AND NEW.status = 'ready'
BEGIN
    UPDATE usage_quotas SET storage_used_bytes = storage_used_bytes + NEW.size_bytes,
        updated_at = NEW.updated_at WHERE user_id = NEW.owner_id;
END;

CREATE TRIGGER assets_account_purged AFTER UPDATE OF status ON assets
WHEN OLD.status = 'deleted' AND NEW.status = 'purged'
BEGIN
    UPDATE usage_quotas SET storage_used_bytes = storage_used_bytes - OLD.size_bytes,
        updated_at = NEW.updated_at WHERE user_id = NEW.owner_id;
END;
