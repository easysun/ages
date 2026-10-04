-- Preserve the original report rows as a read-only archive and keep unknown legacy versions NULL.
CREATE TABLE report_events (
    id TEXT PRIMARY KEY NOT NULL,
    reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('timeline', 'link')),
    target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 100),
    category TEXT NOT NULL CHECK (category IN ('spam', 'abuse', 'copyright', 'illegal', 'other')),
    detail TEXT NOT NULL CHECK (length(detail) <= 1000),
    created_at TEXT NOT NULL,
    observed_timeline_version INTEGER CHECK (observed_timeline_version IS NULL OR observed_timeline_version >= 1)
);
INSERT INTO report_events(id,reporter_id,target_kind,target_id,category,detail,created_at)
SELECT id,reporter_id,target_kind,target_id,category,detail,created_at FROM content_reports;
CREATE INDEX idx_report_events_reporter_created ON report_events(reporter_id, created_at);
CREATE INDEX idx_report_events_subject ON report_events(reporter_id, target_kind, target_id, created_at);
CREATE INDEX idx_report_events_created ON report_events(created_at DESC, id DESC);

CREATE TRIGGER legacy_reports_no_insert BEFORE INSERT ON content_reports
BEGIN SELECT RAISE(ABORT, 'legacy_reports_read_only'); END;
CREATE TRIGGER legacy_reports_no_update BEFORE UPDATE ON content_reports
BEGIN SELECT RAISE(ABORT, 'legacy_reports_read_only'); END;
CREATE TRIGGER legacy_reports_no_delete BEFORE DELETE ON content_reports
BEGIN SELECT RAISE(ABORT, 'legacy_reports_read_only'); END;
