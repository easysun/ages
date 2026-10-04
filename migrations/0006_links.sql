CREATE TABLE links (
    id TEXT PRIMARY KEY NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 3 AND 64 AND slug NOT GLOB '*[^a-z0-9-]*'),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('url', 'timeline')),
    target_url TEXT,
    timeline_id TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((target_kind = 'url' AND target_url IS NOT NULL AND timeline_id IS NULL) OR
        (target_kind = 'timeline' AND timeline_id IS NOT NULL AND target_url IS NULL)),
    FOREIGN KEY (timeline_id, owner_id) REFERENCES timelines(id, owner_id) ON DELETE RESTRICT
);
CREATE INDEX idx_links_owner_created ON links(owner_id, created_at DESC, id DESC);
CREATE INDEX idx_links_timeline ON links(timeline_id);

CREATE TRIGGER links_quota BEFORE INSERT ON links
WHEN NOT EXISTS (SELECT 1 FROM usage_quotas q WHERE q.user_id = NEW.owner_id
    AND (SELECT count(*) FROM links WHERE owner_id = NEW.owner_id) < q.link_limit)
BEGIN SELECT RAISE(ABORT, 'link_quota_exceeded'); END;

CREATE TRIGGER links_immutable_identity BEFORE UPDATE ON links
WHEN OLD.id != NEW.id OR OLD.owner_id != NEW.owner_id OR OLD.slug != NEW.slug
    OR OLD.target_kind != NEW.target_kind OR OLD.target_url IS NOT NEW.target_url
    OR OLD.timeline_id IS NOT NEW.timeline_id
BEGIN SELECT RAISE(ABORT, 'immutable_link_identity'); END;

CREATE TRIGGER links_visible_timeline BEFORE INSERT ON links
WHEN NEW.target_kind = 'timeline' AND NOT EXISTS (SELECT 1 FROM timelines
    WHERE id = NEW.timeline_id AND owner_id = NEW.owner_id AND visibility IN ('unlisted', 'public'))
BEGIN SELECT RAISE(ABORT, 'invalid_link_timeline'); END;
