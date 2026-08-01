-- The terminal schema, written by hand as a fresh set of CREATE statements —
-- deliberately NOT generated from MIGRATIONS (design D3, plan Task 2.6).
-- This is the independent witness that makes the two-digest fingerprint
-- earn its keep: it must open with PRAGMA application_id and close with
-- PRAGMA user_version (finding CRIT-04), and it deliberately differs from
-- the migration DDL in both formatting and statement ordering (round-1
-- minor revision) rather than merely echoing the migration text verbatim.
--
-- Terminal version in this phase: 1 (Task 3.1 rewrites this file wholesale
-- and bumps the closing PRAGMA to 3 once migrations 2 and 3 land).

PRAGMA application_id = 1213090609;

CREATE TABLE state_event
(
    sequence            INTEGER PRIMARY KEY,
    event_id            TEXT NOT NULL UNIQUE,
    run_id              TEXT,
    correlation_id      TEXT NOT NULL,
    causation_event_id  TEXT REFERENCES state_event(event_id),
    type                TEXT NOT NULL,
    recorded_at         TEXT NOT NULL,
    payload             TEXT NOT NULL CHECK (json_valid(payload))
) STRICT;

CREATE TRIGGER state_event_immutable_delete
BEFORE DELETE ON state_event
BEGIN
    SELECT RAISE(ABORT, 'state_event is append-only');
END;

CREATE INDEX state_event_correlation_id ON state_event (correlation_id);

CREATE TRIGGER state_event_immutable_update
BEFORE UPDATE ON state_event
BEGIN
    SELECT RAISE(ABORT, 'state_event is append-only');
END;

CREATE INDEX state_event_run_id_sequence ON state_event (run_id, sequence);

PRAGMA user_version = 1;
