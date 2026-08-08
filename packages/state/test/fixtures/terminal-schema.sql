-- The terminal schema, written by hand as a fresh set of CREATE statements —
-- deliberately NOT generated from MIGRATIONS (design D3, plan Task 2.6).
-- This is the independent witness that makes the two-digest fingerprint
-- earn its keep: it must open with PRAGMA application_id and close with
-- PRAGMA user_version (finding CRIT-04), and it deliberately differs from
-- the migration DDL in both formatting and statement ordering (round-1
-- minor revision) rather than merely echoing the migration text verbatim.
--
-- Terminal version in this phase: 7. Migration 7 adds durable external-stage
-- execution, interaction, and artifact-import projections. ALTER-appended columns are
-- positioned **last** in their fresh CREATE declarations (finding C2):
-- `pragma_table_xinfo`
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
--
-- `artifact`'s `CHECK (revision = 1)` (issue #8, Phase 2 fix cycle G1) is
-- the first-revision guard: an artifact row is written once and never
-- revised, so a plain value `CHECK` stands in for the
-- `*_first_revision` trigger the other three projection tables carry.

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
    updated_at           TEXT NOT NULL,
    name                 TEXT,
    root_path            TEXT,
    topology_sha256      TEXT,
    configuration_sha256 TEXT,
    registration_json    TEXT CHECK (registration_json IS NULL OR json_valid(registration_json)),
    instruction_snapshot_json TEXT CHECK (instruction_snapshot_json IS NULL OR json_valid(instruction_snapshot_json))
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
    updated_at            TEXT NOT NULL,
    name                  TEXT,
    repository_path       TEXT,
    git_common_directory  TEXT,
    remotes_json          TEXT CHECK (remotes_json IS NULL OR json_valid(remotes_json)),
    default_remote        TEXT,
    default_branch        TEXT
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
    updated_at            TEXT NOT NULL,
    repository_id         TEXT REFERENCES repository(repository_id),
    lifecycle_status      TEXT,
    checkout_path         TEXT,
    configuration_sha256  TEXT,
    manifest_json         TEXT CHECK (manifest_json IS NULL OR json_valid(manifest_json))
) STRICT;

CREATE UNIQUE INDEX workspace_checkout_path_unique
ON workspace (checkout_path)
WHERE checkout_path IS NOT NULL;

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

CREATE TABLE workspace_lease
(
    checkout_path          TEXT NOT NULL PRIMARY KEY,
    workspace_id           TEXT NOT NULL REFERENCES workspace(workspace_id),
    repository_id          TEXT NOT NULL REFERENCES repository(repository_id),
    lease_id               TEXT NOT NULL,
    owner_id               TEXT NOT NULL,
    boot_witness           TEXT,
    process_witnesses_json TEXT NOT NULL CHECK (json_valid(process_witnesses_json)),
    expected_sha           TEXT NOT NULL,
    fencing_revision       INTEGER NOT NULL,
    lease_state            TEXT NOT NULL,
    acquired_at            TEXT NOT NULL,
    renewed_at             TEXT NOT NULL,
    expires_at             TEXT NOT NULL,
    released_at            TEXT,
    revision               INTEGER NOT NULL,
    last_event_sequence    INTEGER NOT NULL REFERENCES state_event(sequence),
    updated_at             TEXT NOT NULL
) STRICT;

CREATE TRIGGER workspace_lease_causal_update
BEFORE UPDATE ON workspace_lease
WHEN NEW.last_event_sequence <= OLD.last_event_sequence OR NEW.revision <> OLD.revision + 1
BEGIN
    SELECT RAISE(ABORT, 'projection update must advance revision by 1 and cite a newer event');
END;

CREATE TRIGGER workspace_lease_first_revision
BEFORE INSERT ON workspace_lease
WHEN NEW.revision <> 1 OR NEW.fencing_revision <> 1
BEGIN
    SELECT RAISE(ABORT, 'first workspace lease revision and fence must be 1');
END;

CREATE TABLE run_projection
(
    run_id               TEXT NOT NULL PRIMARY KEY,
    status               TEXT NOT NULL,
    revision             INTEGER NOT NULL,
    last_event_sequence  INTEGER NOT NULL REFERENCES state_event(sequence),
    codebase_id          TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    workspace_id         TEXT,
    instruction_snapshot_sha256 TEXT,
    instruction_snapshot_json TEXT CHECK (instruction_snapshot_json IS NULL OR json_valid(instruction_snapshot_json))
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
    run_id                TEXT NOT NULL REFERENCES run_projection(run_id),
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
    CHECK (revision = 1),
    CHECK (byte_length >= 0),
    CHECK (relative_path = 'blobs/sha256/' || content_hash),
    CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*')
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

CREATE TABLE stage_execution
(
    run_id                 TEXT NOT NULL PRIMARY KEY REFERENCES run_projection(run_id),
    stage_id               TEXT NOT NULL UNIQUE,
    codebase_id            TEXT NOT NULL REFERENCES codebase(codebase_id),
    repository_id          TEXT NOT NULL REFERENCES repository(repository_id),
    workspace_id           TEXT NOT NULL REFERENCES workspace(workspace_id),
    backend_kind           TEXT NOT NULL,
    backend_execution_id   TEXT UNIQUE,
    status                 TEXT NOT NULL,
    prompt                 TEXT NOT NULL,
    artifact_path          TEXT NOT NULL,
    limits_json            TEXT NOT NULL CHECK (json_valid(limits_json)),
    summary                TEXT,
    session_id             TEXT,
    error                  TEXT,
    finalized              INTEGER NOT NULL DEFAULT 0,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    CHECK (status IN ('queued','running','waiting_on_user','recovery_required','succeeded','failed','cancelled')),
    CHECK (finalized IN (0,1))
) STRICT;

CREATE INDEX stage_execution_status
ON stage_execution (status, run_id);

CREATE TABLE interaction_record
(
    run_id                 TEXT NOT NULL REFERENCES stage_execution(run_id),
    interaction_id         TEXT NOT NULL,
    stage_id               TEXT NOT NULL,
    purpose                TEXT NOT NULL,
    source_payload_json    TEXT NOT NULL CHECK (json_valid(source_payload_json)),
    canonical_payload_json TEXT CHECK (canonical_payload_json IS NULL OR json_valid(canonical_payload_json)),
    legacy_state           TEXT,
    requested_at           TEXT NOT NULL,
    timeout_at             TEXT,
    created_event_id       TEXT REFERENCES state_event(event_id),
    PRIMARY KEY (run_id, interaction_id),
    CHECK (purpose IN ('question','approval'))
) STRICT;

CREATE TRIGGER interaction_record_immutable_update
BEFORE UPDATE ON interaction_record
BEGIN
    SELECT RAISE(ABORT, 'interaction records are immutable');
END;

CREATE TRIGGER interaction_record_immutable_delete
BEFORE DELETE ON interaction_record
BEGIN
    SELECT RAISE(ABORT, 'interaction records are immutable');
END;

CREATE TABLE interaction_answer_record
(
    answer_id                TEXT NOT NULL PRIMARY KEY,
    run_id                   TEXT NOT NULL,
    interaction_id           TEXT NOT NULL,
    operation_id             TEXT NOT NULL UNIQUE,
    source_answer_json       TEXT NOT NULL CHECK (json_valid(source_answer_json)),
    canonical_answer_json    TEXT CHECK (canonical_answer_json IS NULL OR json_valid(canonical_answer_json)),
    answered_by_key_id       TEXT NOT NULL,
    answered_at              TEXT NOT NULL,
    accepted_event_id        TEXT REFERENCES state_event(event_id),
    UNIQUE (run_id, interaction_id),
    FOREIGN KEY (run_id, interaction_id)
        REFERENCES interaction_record(run_id, interaction_id)
) STRICT;

CREATE TRIGGER interaction_answer_immutable_update
BEFORE UPDATE ON interaction_answer_record
BEGIN
    SELECT RAISE(ABORT, 'interaction answers are immutable');
END;

CREATE TRIGGER interaction_answer_immutable_delete
BEFORE DELETE ON interaction_answer_record
BEGIN
    SELECT RAISE(ABORT, 'interaction answers are immutable');
END;

CREATE TABLE pending_interaction_projection
(
    run_id                 TEXT NOT NULL,
    interaction_id        TEXT NOT NULL,
    state                  TEXT NOT NULL,
    revision               INTEGER NOT NULL,
    delivery_state         TEXT NOT NULL,
    cancellation_reason    TEXT,
    resolved_at            TEXT,
    answer_id              TEXT REFERENCES interaction_answer_record(answer_id),
    last_event_sequence    INTEGER NOT NULL REFERENCES state_event(sequence),
    updated_at             TEXT NOT NULL,
    PRIMARY KEY (run_id, interaction_id),
    FOREIGN KEY (run_id, interaction_id)
        REFERENCES interaction_record(run_id, interaction_id),
    CHECK (state IN ('pending','answered','cancelled')),
    CHECK (delivery_state IN ('not_applicable','pending','delivered')),
    CHECK (revision >= 1),
    CHECK (cancellation_reason IS NULL OR cancellation_reason IN
        ('withdrawn','timed_out','run_terminal','migration_unresolved'))
) STRICT;

CREATE INDEX pending_interaction_inbox
ON pending_interaction_projection (state, updated_at, run_id, interaction_id);

CREATE TRIGGER pending_interaction_causal_update
BEFORE UPDATE ON pending_interaction_projection
WHEN NEW.last_event_sequence <= OLD.last_event_sequence OR NEW.revision <> OLD.revision + 1
BEGIN
    SELECT RAISE(ABORT, 'interaction projection must advance revision by 1');
END;

CREATE TRIGGER pending_interaction_first_revision
BEFORE INSERT ON pending_interaction_projection
WHEN NEW.revision <> 1
BEGIN
    SELECT RAISE(ABORT, 'first interaction projection revision must be 1');
END;

CREATE TABLE execution_operation_outbox
(
    operation_id           TEXT NOT NULL PRIMARY KEY,
    run_id                 TEXT NOT NULL REFERENCES stage_execution(run_id),
    interaction_id         TEXT,
    kind                   TEXT NOT NULL,
    payload_json           TEXT NOT NULL CHECK (json_valid(payload_json)),
    state                  TEXT NOT NULL,
    attempt_count          INTEGER NOT NULL DEFAULT 0,
    last_error             TEXT,
    created_at             TEXT NOT NULL,
    delivered_at           TEXT,
    last_event_sequence    INTEGER NOT NULL REFERENCES state_event(sequence),
    FOREIGN KEY (run_id, interaction_id)
        REFERENCES interaction_record(run_id, interaction_id),
    CHECK (kind IN ('answer','resume')),
    CHECK (state IN ('pending','delivered')),
    CHECK (attempt_count >= 0),
    CHECK ((kind = 'answer' AND interaction_id IS NOT NULL) OR
           (kind = 'resume' AND interaction_id IS NULL))
) STRICT;

CREATE INDEX execution_operation_pending
ON execution_operation_outbox (state, created_at, operation_id);

CREATE TABLE backend_artifact_import
(
    run_id                 TEXT NOT NULL REFERENCES stage_execution(run_id),
    backend_artifact_id    TEXT NOT NULL,
    artifact_id            TEXT REFERENCES artifact(artifact_id),
    content_hash           TEXT,
    byte_length            INTEGER,
    state                  TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    PRIMARY KEY (run_id, backend_artifact_id),
    CHECK (state IN ('pending','completed')),
    CHECK (byte_length IS NULL OR byte_length >= 0)
) STRICT;

CREATE TABLE capability_snapshot
(
    engine             TEXT NOT NULL,
    account_key        TEXT NOT NULL,
    engine_version_key TEXT NOT NULL,
    claudexor_version  TEXT NOT NULL,
    observed_at        TEXT NOT NULL,
    expires_at         TEXT NOT NULL,
    payload_json       TEXT NOT NULL CHECK (json_valid(payload_json)),
    PRIMARY KEY (engine, account_key, engine_version_key, claudexor_version),
    CHECK (engine IN ('claude','codex','cursor'))
) STRICT;

CREATE INDEX capability_snapshot_latest
ON capability_snapshot (engine, account_key, observed_at DESC);

CREATE TABLE execution_schedule
(
    run_id                    TEXT NOT NULL PRIMARY KEY,
    stage_id                  TEXT NOT NULL UNIQUE,
    codebase_id               TEXT NOT NULL,
    repository_id             TEXT NOT NULL,
    prompt                    TEXT NOT NULL,
    artifact_path             TEXT NOT NULL,
    base_sha                  TEXT,
    hard_deadline_at          TEXT,
    state                     TEXT NOT NULL,
    capacity_policy           TEXT NOT NULL,
    requested_priority        INTEGER NOT NULL,
    current_candidate_index   INTEGER,
    current_attempt_id        TEXT,
    revision                  INTEGER NOT NULL,
    chain_json                TEXT NOT NULL CHECK (json_valid(chain_json)),
    requested_secret_ids_json TEXT NOT NULL CHECK (json_valid(requested_secret_ids_json)),
    enqueued_at               TEXT NOT NULL,
    updated_at                TEXT NOT NULL,
    CHECK (state IN ('queued','waiting_on_user','running','terminal')),
    CHECK (capacity_policy IN ('queue','fallback','ask')),
    CHECK (requested_priority BETWEEN 0 AND 9),
    CHECK (revision >= 1)
) STRICT;

CREATE TABLE execution_candidate
(
    run_id                 TEXT NOT NULL REFERENCES execution_schedule(run_id),
    candidate_index        INTEGER NOT NULL,
    profile_id             TEXT NOT NULL,
    account_id             TEXT,
    engine                 TEXT NOT NULL,
    max_concurrent_runs    INTEGER NOT NULL,
    profile_json           TEXT NOT NULL CHECK (json_valid(profile_json)),
    limits_json            TEXT NOT NULL CHECK (json_valid(limits_json)),
    permissions_json       TEXT NOT NULL CHECK (json_valid(permissions_json)),
    state                  TEXT NOT NULL,
    PRIMARY KEY (run_id, candidate_index),
    CHECK (candidate_index >= 0),
    CHECK (max_concurrent_runs >= 1),
    CHECK (state IN ('pending','queued','selected','rejected','failed','succeeded'))
) STRICT;

CREATE INDEX execution_candidate_account
ON execution_candidate (account_id, state, run_id, candidate_index);

CREATE TABLE account_capacity
(
    account_id             TEXT NOT NULL PRIMARY KEY,
    max_concurrent_runs    INTEGER NOT NULL,
    updated_at             TEXT NOT NULL,
    CHECK (max_concurrent_runs >= 1)
) STRICT;

CREATE TABLE account_queue_entry
(
    queue_sequence         INTEGER PRIMARY KEY,
    run_id                 TEXT NOT NULL,
    candidate_index        INTEGER NOT NULL,
    account_id             TEXT NOT NULL,
    requested_priority     INTEGER NOT NULL,
    enqueued_at            TEXT NOT NULL,
    UNIQUE (run_id, candidate_index),
    FOREIGN KEY (run_id, candidate_index)
        REFERENCES execution_candidate(run_id, candidate_index),
    CHECK (requested_priority BETWEEN 0 AND 9)
) STRICT;

CREATE INDEX account_queue_order
ON account_queue_entry (account_id, requested_priority DESC, queue_sequence);

CREATE TABLE execution_attempt
(
    attempt_id             TEXT NOT NULL PRIMARY KEY,
    run_id                 TEXT NOT NULL REFERENCES execution_schedule(run_id),
    stage_id               TEXT NOT NULL,
    candidate_index        INTEGER NOT NULL,
    profile_id             TEXT NOT NULL,
    account_id             TEXT,
    workspace_id           TEXT REFERENCES workspace(workspace_id),
    backend_execution_id   TEXT UNIQUE,
    status                 TEXT NOT NULL,
    limits_json            TEXT NOT NULL CHECK (json_valid(limits_json)),
    permissions_json       TEXT NOT NULL CHECK (json_valid(permissions_json)),
    readonly_baseline_json TEXT CHECK (readonly_baseline_json IS NULL OR json_valid(readonly_baseline_json)),
    result_json            TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    failure_json           TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
    started_at             TEXT,
    finished_at            TEXT,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    UNIQUE (run_id, candidate_index),
    FOREIGN KEY (run_id, candidate_index)
        REFERENCES execution_candidate(run_id, candidate_index),
    CHECK (status IN ('queued','running','waiting_on_user','recovery_required','succeeded','failed','cancelled'))
) STRICT;

CREATE INDEX execution_attempt_run
ON execution_attempt (run_id, candidate_index);

CREATE TABLE account_concurrency_lease
(
    lease_id               TEXT NOT NULL PRIMARY KEY,
    account_id             TEXT NOT NULL,
    run_id                 TEXT NOT NULL,
    candidate_index        INTEGER NOT NULL,
    attempt_id             TEXT NOT NULL REFERENCES execution_attempt(attempt_id),
    owner_id               TEXT NOT NULL,
    acquired_at            TEXT NOT NULL,
    renewed_at             TEXT NOT NULL,
    expires_at             TEXT NOT NULL,
    released_at            TEXT,
    fencing_revision       INTEGER NOT NULL,
    state                  TEXT NOT NULL,
    FOREIGN KEY (run_id, candidate_index)
        REFERENCES execution_candidate(run_id, candidate_index),
    CHECK (fencing_revision >= 1),
    CHECK (state IN ('active','released','expired'))
) STRICT;

CREATE UNIQUE INDEX account_lease_attempt_active
ON account_concurrency_lease (attempt_id) WHERE state = 'active';

CREATE INDEX account_lease_capacity
ON account_concurrency_lease (account_id, state, expires_at);

CREATE TABLE scheduling_decision
(
    decision_sequence      INTEGER PRIMARY KEY,
    decision_id            TEXT NOT NULL UNIQUE,
    run_id                 TEXT NOT NULL REFERENCES execution_schedule(run_id),
    stage_id               TEXT NOT NULL,
    candidate_index        INTEGER,
    profile_id             TEXT,
    account_id             TEXT,
    kind                   TEXT NOT NULL,
    reason_code            TEXT NOT NULL,
    recorded_at            TEXT NOT NULL,
    CHECK (candidate_index IS NULL OR candidate_index >= 0)
) STRICT;

CREATE INDEX scheduling_decision_run
ON scheduling_decision (run_id, decision_sequence);

CREATE TRIGGER scheduling_decision_immutable_update
BEFORE UPDATE ON scheduling_decision
BEGIN
    SELECT RAISE(ABORT, 'scheduling decisions are immutable');
END;

CREATE TRIGGER scheduling_decision_immutable_delete
BEFORE DELETE ON scheduling_decision
BEGIN
    SELECT RAISE(ABORT, 'scheduling decisions are immutable');
END;

CREATE TABLE scheduling_capacity_question
(
    run_id                 TEXT NOT NULL PRIMARY KEY REFERENCES execution_schedule(run_id),
    interaction_id        TEXT NOT NULL UNIQUE,
    question_json         TEXT NOT NULL CHECK (json_valid(question_json)),
    state                  TEXT NOT NULL,
    revision               INTEGER NOT NULL,
    answer_json            TEXT CHECK (answer_json IS NULL OR json_valid(answer_json)),
    created_at             TEXT NOT NULL,
    answered_at           TEXT,
    CHECK (state IN ('pending','answered')),
    CHECK (revision >= 1)
) STRICT;

CREATE TRIGGER scheduling_capacity_question_immutable
BEFORE UPDATE OF interaction_id, question_json, created_at ON scheduling_capacity_question
BEGIN
    SELECT RAISE(ABORT, 'scheduling capacity questions are immutable');
END;

PRAGMA user_version = 10;
