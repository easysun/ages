CREATE TRIGGER report_events_no_update BEFORE UPDATE ON report_events
BEGIN SELECT RAISE(ABORT, 'immutable_report_event'); END;
CREATE TRIGGER report_events_no_delete BEFORE DELETE ON report_events
BEGIN SELECT RAISE(ABORT, 'immutable_report_event'); END;
