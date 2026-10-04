CREATE TABLE rate_limits (
    scope_hash TEXT NOT NULL
        CHECK (length(scope_hash) = 64 AND scope_hash NOT GLOB '*[^0-9a-f]*'),
    bucket INTEGER NOT NULL CHECK (bucket >= 0),
    count INTEGER NOT NULL CHECK (count > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > bucket),
    PRIMARY KEY (scope_hash, bucket)
);
CREATE INDEX idx_rate_limits_expiry ON rate_limits(expires_at);

ALTER TABLE assets ADD COLUMN purge_claim TEXT
    CHECK (purge_claim IS NULL OR (
        length(purge_claim) = 32 AND purge_claim NOT GLOB '*[^0-9a-f]*'
    ));
CREATE INDEX idx_assets_trash_expiry ON assets(status, deleted_at, updated_at, id);

CREATE TRIGGER assets_purge_claim_guard BEFORE UPDATE ON assets
WHEN (NEW.purge_claim IS NOT NULL AND (
    NEW.status NOT IN ('deleted', 'purged') OR NEW.purge_claim IS NOT NEW.trash_generation
)) OR (OLD.purge_claim IS NOT NULL AND (
    NEW.purge_claim IS NOT OLD.purge_claim OR NEW.status NOT IN ('deleted', 'purged')
))
BEGIN SELECT RAISE(ABORT, 'asset_purge_claimed'); END;
