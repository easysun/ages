CREATE TABLE asset_tags (
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 64 AND length(trim(tag)) > 0),
    PRIMARY KEY (asset_id, tag)
);

CREATE INDEX idx_asset_tags_owner_tag ON asset_tags(owner_id, tag, asset_id);

CREATE TRIGGER asset_tags_owner_insert BEFORE INSERT ON asset_tags
WHEN NOT EXISTS (SELECT 1 FROM assets WHERE id = NEW.asset_id AND owner_id = NEW.owner_id)
BEGIN
    SELECT RAISE(ABORT, 'asset_tag_owner_mismatch');
END;

CREATE TRIGGER asset_tags_owner_update BEFORE UPDATE ON asset_tags
WHEN NOT EXISTS (SELECT 1 FROM assets WHERE id = NEW.asset_id AND owner_id = NEW.owner_id)
BEGIN
    SELECT RAISE(ABORT, 'asset_tag_owner_mismatch');
END;

CREATE TRIGGER asset_tags_limit_insert AFTER INSERT ON asset_tags
WHEN (SELECT COUNT(*) FROM asset_tags WHERE asset_id = NEW.asset_id) > 20
BEGIN
    SELECT RAISE(ABORT, 'asset_tag_limit');
END;

CREATE TRIGGER asset_tags_limit_update AFTER UPDATE OF asset_id ON asset_tags
WHEN (SELECT COUNT(*) FROM asset_tags WHERE asset_id = NEW.asset_id) > 20
BEGIN
    SELECT RAISE(ABORT, 'asset_tag_limit');
END;
