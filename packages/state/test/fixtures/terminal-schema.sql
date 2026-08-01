-- The terminal schema, written by hand as a fresh set of CREATE statements —
-- deliberately NOT generated from MIGRATIONS (design D3, plan Task 2.6).
-- This is the independent witness that makes the two-digest fingerprint
-- earn its keep: it must open with PRAGMA application_id and close with
-- PRAGMA user_version (finding CRIT-04), and it deliberately differs from
-- the migration DDL in both formatting and statement ordering (round-1
-- minor revision) rather than merely echoing the migration text verbatim.
--
-- Terminal version in this phase: 4 (plan Task 2.4/B6 — migration 4 adds
-- the immutable `artifact` table and the mutable `stage_artifact_alias`
-- alias, design D11/D11a). `workspace_id` is inline in `run_projection`'s
-- column list here and positioned **last** (finding C2): `pragma_table_xinfo`
-- orders by `cid`, and an `ALTER`-appended column always receives the
-- highest `cid`, so placing it anywhere else in this fixture would make the
-- structural digest disagree with the migrated lineages for a reason
-- unrelated to what this fixture exists to test. Its literal DDL text
-- nonetheless differs from the migrated database's stored `run_projection`
-- SQL — an `ALTER`-rewritten column's stored text is not the same as fresh
-- `CREATE` text for the identical logical schema.
--
-- That difference survives normalisation, and is MEANT to: the structural
-- digest must see through it, the declared digest must not (plan Task 3.1).
-- Do NOT "fix" the divergence by transcribing SQLite's ALTER output
-- (`updated_at TEXT NOT NULL , workspace_id TEXT) STRICT`) into this file —
-- that would make the witness circular, since it would no longer be an
-- independently hand-written CREATE for the one table the ALTER touched.
-- See test/fingerprint.test.ts's structural-matches / declared-differs /
-- literal-DDL-diverges trio.
--
-- `artifact` and `stage_artifact_alias` below (B6) are independently
-- authored from `MIGRATION_0004_ARTIFACT` in
-- `src/migrations/list.ts` — deliberately different CHECK-clause ordering,
-- trigger ordering, and whitespace, matching this file's existing posture
-- for versions 1-3. Do not transcribe the migration text.

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

CREATE TABLE codebase
(
    codebase_id          TEXT NOT NULL PRIMARY KEY,
    revision             INTEGER NOT NULL,
    last_event_sequence  INTEGER NOT NULL REFERENCES state_event(sequence),
    updated_at           TEXT NOT NULL
) STRICT;

CREATE TRIGGER codebase_first_revision
BEFORE INSERT ON codebase
WHEN NEW.revision <> 1
BEGIN
    SELECT RAISE(ABORT, 'first projection revision must be 1');
END;

CREATE TRIGGER codebase_causal_update
BEFORE UPDATE ON codebase
WHEN NEW.last_event_sequence <= OLD.last_event_sequence OR NEW.revision <> OLD.revision + 1
BEGIN
    SELECT RAISE(ABORT, 'projection update must advance revision by 1 and cite a newer event');
END;

CREATE TABLE repository
(
    repository_id        TEXT NOT NULL PRIMARY KEY,
    codebase_id           TEXT NOT NULL REFERENCES codebase(codebase_id),
    revision              INTEGER NOT NULL,
    last_event_sequence   INTEGER NOT NULL REFERENCES state_event(sequence),
    updated_at            TEXT NOT NULL
) STRICT;

CREATE TRIGGER repository_first_revision
BEFORE INSERT ON repository
WHEN NEW.revision <> 1
BEGIN
    SELECT RAISE(ABORT, 'first projection revision must be 1');
END;

CREATE TRIGGER repository_causal_update
BEFORE UPDATE ON repository
WHEN NEW.last_event_sequence <= OLD.last_event_sequence OR NEW.revision <> OLD.revision + 1
BEGIN
    SELECT RAISE(ABORT, 'projection update must advance revision by 1 and cite a newer event');
END;

CREATE TABLE workspace
(
    workspace_id          TEXT NOT NULL PRIMARY KEY,
    codebase_id           TEXT NOT NULL REFERENCES codebase(codebase_id),
    revision              INTEGER NOT NULL,
    last_event_sequence   INTEGER NOT NULL REFERENCES state_event(sequence),
    updated_at            TEXT NOT NULL
) STRICT;

CREATE TRIGGER workspace_first_revision
BEFORE INSERT ON workspace
WHEN NEW.revision <> 1
BEGIN
    SELECT RAISE(ABORT, 'first projection revision must be 1');
END;

CREATE TRIGGER workspace_causal_update
BEFORE UPDATE ON workspace
WHEN NEW.last_event_sequence <= OLD.last_event_sequence OR NEW.revision <> OLD.revision + 1
BEGIN
    SELECT RAISE(ABORT, 'projection update must advance revision by 1 and cite a newer event');
END;

CREATE TABLE run_projection
(
    run_id               TEXT NOT NULL PRIMARY KEY,
    status               TEXT NOT NULL,
    revision             INTEGER NOT NULL,
    last_event_sequence  INTEGER NOT NULL REFERENCES state_event(sequence),
    codebase_id          TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    workspace_id         TEXT
) STRICT;

CREATE TRIGGER run_projection_first_revision
BEFORE INSERT ON run_projection
WHEN NEW.revision <> 1
BEGIN
    SELECT RAISE(ABORT, 'first projection revision must be 1');
END;

CREATE TRIGGER run_projection_causal_update
BEFORE UPDATE ON run_projection
WHEN NEW.last_event_sequence <= OLD.last_event_sequence OR NEW.revision <> OLD.revision + 1
BEGIN
    SELECT RAISE(ABORT, 'projection update must advance revision by 1 and cite a newer event');
END;

CREATE TABLE artifact
(
    artifact_id           TEXT NOT NULL PRIMARY KEY,
    run_id                TEXT NOT NULL,
    stage_id              TEXT NOT NULL,
    name                  TEXT NOT NULL,
    content_hash          TEXT NOT NULL,
    byte_length           INTEGER NOT NULL,
    media_type            TEXT NOT NULL,
    content_schema_id     TEXT NOT NULL,
    producer              TEXT NOT NULL,
    source_lineage        TEXT NOT NULL CHECK (json_valid(source_lineage)),
    relative_path         TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    revision              INTEGER NOT NULL,
    last_event_sequence   INTEGER NOT NULL REFERENCES state_event(sequence),
    CHECK (byte_length >= 0),
    CHECK (relative_path NOT LIKE 'incoming/%'),
    CHECK (relative_path = 'blobs/sha256/' || content_hash),
    CHECK (length(content_hash) = 64 AND content_hash = lower(content_hash))
) STRICT;

CREATE TRIGGER artifact_immutable_delete
BEFORE DELETE ON artifact
BEGIN
    SELECT RAISE(ABORT, 'artifact is append-only');
END;

CREATE INDEX artifact_run_id_stage_id ON artifact (run_id, stage_id);

CREATE TRIGGER artifact_immutable_update
BEFORE UPDATE ON artifact
BEGIN
    SELECT RAISE(ABORT, 'artifact is append-only');
END;

CREATE TABLE stage_artifact_alias
(
    run_id                TEXT NOT NULL,
    stage_id              TEXT NOT NULL,
    name                  TEXT NOT NULL,
    artifact_id           TEXT NOT NULL REFERENCES artifact(artifact_id),
    revision              INTEGER NOT NULL,
    last_event_sequence   INTEGER NOT NULL REFERENCES state_event(sequence),
    updated_at            TEXT NOT NULL,
    PRIMARY KEY (run_id, stage_id, name)
) STRICT;

CREATE TRIGGER stage_artifact_alias_causal_update
BEFORE UPDATE ON stage_artifact_alias
WHEN NEW.last_event_sequence <= OLD.last_event_sequence OR NEW.revision <> OLD.revision + 1
BEGIN
    SELECT RAISE(ABORT, 'projection update must advance revision by 1 and cite a newer event');
END;

CREATE TRIGGER stage_artifact_alias_first_revision
BEFORE INSERT ON stage_artifact_alias
WHEN NEW.revision <> 1
BEGIN
    SELECT RAISE(ABORT, 'first projection revision must be 1');
END;

PRAGMA user_version = 4;
