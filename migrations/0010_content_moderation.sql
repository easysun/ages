ALTER TABLE assets ADD COLUMN moderation_blocked INTEGER NOT NULL DEFAULT 0 CHECK (moderation_blocked IN (0, 1));
ALTER TABLE timelines ADD COLUMN moderation_blocked INTEGER NOT NULL DEFAULT 0 CHECK (moderation_blocked IN (0, 1));
ALTER TABLE distribution_links ADD COLUMN moderation_blocked INTEGER NOT NULL DEFAULT 0 CHECK (moderation_blocked IN (0, 1));

CREATE TABLE content_reports (
    id TEXT PRIMARY KEY NOT NULL,
    reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('timeline', 'link')),
    target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 100),
    category TEXT NOT NULL CHECK (category IN ('spam', 'abuse', 'copyright', 'illegal', 'other')),
    detail TEXT NOT NULL CHECK (length(detail) <= 1000),
    created_at TEXT NOT NULL,
    UNIQUE (reporter_id, target_kind, target_id)
);
CREATE INDEX idx_content_reports_reporter_created ON content_reports(reporter_id, created_at);
CREATE INDEX idx_content_reports_created ON content_reports(created_at DESC, id DESC);

CREATE TABLE moderation_audit (
    id TEXT PRIMARY KEY NOT NULL,
    moderator_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('asset', 'timeline', 'link')),
    target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 100),
    previous_blocked INTEGER NOT NULL CHECK (previous_blocked IN (0, 1)),
    blocked INTEGER NOT NULL CHECK (blocked IN (0, 1)),
    reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
    created_at TEXT NOT NULL,
    CHECK (previous_blocked != blocked)
);
CREATE INDEX idx_moderation_audit_target ON moderation_audit(target_kind, target_id, created_at, id);
CREATE TRIGGER moderation_audit_no_update BEFORE UPDATE ON moderation_audit
BEGIN SELECT RAISE(ABORT, 'immutable_moderation_audit'); END;
CREATE TRIGGER moderation_audit_no_delete BEFORE DELETE ON moderation_audit
BEGIN SELECT RAISE(ABORT, 'immutable_moderation_audit'); END;
