ALTER TABLE oauth_attempts ADD COLUMN report_target_kind TEXT
  CHECK (report_target_kind IS NULL OR report_target_kind IN ('timeline', 'link'));

ALTER TABLE oauth_attempts ADD COLUMN report_target_value TEXT
  CHECK (report_target_value IS NULL OR length(report_target_value) BETWEEN 1 AND 100);
