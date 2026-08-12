-- The terminal schema, written by hand as a fresh set of CREATE statements —
-- deliberately NOT generated from MIGRATIONS (design D3, plan Task 2.6).
-- This is the independent witness that makes the two-digest fingerprint
-- earn its keep: it must open with PRAGMA application_id and close with
-- PRAGMA user_version (finding CRIT-04), and it deliberately differs from
-- the migration DDL in both formatting and statement ordering (round-1
-- minor revision) rather than merely echoing the migration text verbatim.
--
-- Terminal version in this phase: 23. Migration 23 adds durable whole-task
-- lifecycle, wave dispatch, capacity, and audit tables. ALTER-appended columns are
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
    instruction_snapshot_json TEXT CHECK (instruction_snapshot_json IS NULL OR json_valid(instruction_snapshot_json)),
    capability_landing_json TEXT CHECK (capability_landing_json IS NULL OR json_valid(capability_landing_json))
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
    capability_request_json   TEXT CHECK (capability_request_json IS NULL OR json_valid(capability_request_json)),
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
    capability_delta_json  TEXT CHECK (capability_delta_json IS NULL OR json_valid(capability_delta_json)),
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

CREATE TABLE parent_session
(
    session_id             TEXT NOT NULL PRIMARY KEY,
    codebase_id            TEXT NOT NULL REFERENCES codebase(codebase_id),
    state                  TEXT NOT NULL,
    revision               INTEGER NOT NULL,
    boot_witness           TEXT,
    process_witness_json   TEXT CHECK (process_witness_json IS NULL OR json_valid(process_witness_json)),
    attached_at            TEXT NOT NULL,
    renewed_at             TEXT NOT NULL,
    expires_at             TEXT NOT NULL,
    released_at            TEXT,
    superseded_by          TEXT REFERENCES parent_session(session_id),
    updated_at             TEXT NOT NULL,
    CHECK (state IN ('attached','stalled','detached','expired','superseded')),
    CHECK (revision >= 1),
    CHECK (superseded_by IS NULL OR superseded_by <> session_id),
    CHECK ((state IN ('detached','expired','superseded')) = (released_at IS NOT NULL))
) STRICT;

CREATE INDEX parent_session_live
ON parent_session (codebase_id, state, expires_at);

CREATE TRIGGER parent_session_first_revision BEFORE INSERT ON parent_session
WHEN NEW.revision <> 1
BEGIN
    SELECT RAISE(ABORT, 'first parent session revision must be 1');
END;

CREATE TRIGGER parent_session_revision_advances BEFORE UPDATE ON parent_session
WHEN NEW.revision < OLD.revision
BEGIN
    SELECT RAISE(ABORT, 'a parent session revision must never move backwards');
END;

CREATE TABLE native_stage
(
    run_id                 TEXT NOT NULL PRIMARY KEY REFERENCES run_projection(run_id),
    stage_id               TEXT NOT NULL UNIQUE,
    codebase_id            TEXT NOT NULL REFERENCES codebase(codebase_id),
    repository_id          TEXT NOT NULL REFERENCES repository(repository_id),
    profile_id             TEXT NOT NULL,
    profile_json           TEXT NOT NULL CHECK (json_valid(profile_json)),
    permissions_json       TEXT NOT NULL CHECK (json_valid(permissions_json)),
    limits_json            TEXT NOT NULL CHECK (json_valid(limits_json)),
    prompt                 TEXT NOT NULL,
    artifact_path          TEXT NOT NULL,
    instructions_path      TEXT NOT NULL,
    artifact_contract      TEXT NOT NULL,
    model                  TEXT NOT NULL,
    effort                 TEXT NOT NULL,
    focus                  TEXT,
    questions              TEXT NOT NULL,
    base_sha               TEXT NOT NULL,
    hard_deadline_at       TEXT,
    state                  TEXT NOT NULL,
    current_attempt_id     TEXT,
    attempt_count          INTEGER NOT NULL,
    revision               INTEGER NOT NULL,
    waiting_since          TEXT,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    CHECK (state IN ('waiting_for_parent','dispatched','waiting_on_user','recovery_required','settled')),
    CHECK (questions IN ('parent-mediated','direct')),
    CHECK (revision >= 1),
    CHECK (attempt_count >= 0),
    CHECK ((state = 'waiting_for_parent') = (waiting_since IS NOT NULL))
) STRICT;

CREATE INDEX native_stage_dispatchable
ON native_stage (codebase_id, state, created_at, run_id);

CREATE TRIGGER native_stage_first_revision BEFORE INSERT ON native_stage
WHEN NEW.revision <> 1
BEGIN
    SELECT RAISE(ABORT, 'first native stage revision must be 1');
END;

CREATE TRIGGER native_stage_revision_advances BEFORE UPDATE ON native_stage
WHEN NEW.revision <> OLD.revision + 1
BEGIN
    SELECT RAISE(ABORT, 'native stage update must advance revision by 1');
END;

CREATE TRIGGER native_stage_identity_immutable BEFORE UPDATE ON native_stage
WHEN NEW.stage_id <> OLD.stage_id OR NEW.codebase_id <> OLD.codebase_id
OR NEW.repository_id <> OLD.repository_id OR NEW.artifact_path <> OLD.artifact_path
OR NEW.base_sha <> OLD.base_sha
BEGIN
    SELECT RAISE(ABORT, 'native stage identity is immutable');
END;

CREATE TABLE native_stage_attempt
(
    attempt_id             TEXT NOT NULL PRIMARY KEY,
    run_id                 TEXT NOT NULL REFERENCES native_stage(run_id),
    stage_id               TEXT NOT NULL,
    attempt_ordinal        INTEGER NOT NULL,
    workspace_id           TEXT REFERENCES workspace(workspace_id),
    readonly_baseline_json TEXT CHECK (readonly_baseline_json IS NULL OR json_valid(readonly_baseline_json)),
    status                 TEXT NOT NULL,
    result_json            TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    failure_json           TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
    started_at             TEXT,
    finished_at            TEXT,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    UNIQUE (run_id, attempt_ordinal),
    UNIQUE (attempt_id, run_id),
    CHECK (attempt_ordinal >= 1),
    CHECK (status IN ('running','waiting_on_user','recovery_required','succeeded','failed','cancelled')),
    CHECK ((status IN ('succeeded','failed','cancelled')) = (finished_at IS NOT NULL))
) STRICT;

CREATE TABLE native_dispatch
(
    dispatch_id            TEXT NOT NULL PRIMARY KEY,
    run_id                 TEXT NOT NULL,
    stage_id               TEXT NOT NULL,
    attempt_id             TEXT NOT NULL,
    session_id             TEXT NOT NULL REFERENCES parent_session(session_id),
    state                  TEXT NOT NULL,
    revision               INTEGER NOT NULL,
    terminal_reason        TEXT,
    outcome                TEXT,
    submission_id          TEXT,
    submission_digest      TEXT,
    result_json            TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    issued_at              TEXT NOT NULL,
    expires_at             TEXT NOT NULL,
    settled_at             TEXT,
    updated_at             TEXT NOT NULL,
    UNIQUE (dispatch_id, submission_id),
    FOREIGN KEY (attempt_id, run_id) REFERENCES native_stage_attempt(attempt_id, run_id),
    CHECK (state IN ('dispatched','waiting_on_user','submitted','revoked','abandoned')),
    CHECK (revision >= 1),
    CHECK (outcome IS NULL OR outcome IN ('succeeded','failed','cancelled')),
    CHECK ((state = 'submitted') = (outcome IS NOT NULL)),
    CHECK ((state = 'submitted') = (submission_id IS NOT NULL)),
    CHECK ((state = 'submitted') = (submission_digest IS NOT NULL)),
    CHECK ((state IN ('submitted','revoked','abandoned')) = (settled_at IS NOT NULL)),
    CHECK ((state IN ('revoked','abandoned')) = (terminal_reason IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX native_dispatch_open_per_attempt
ON native_dispatch (attempt_id) WHERE state IN ('dispatched','waiting_on_user');

CREATE INDEX native_dispatch_by_session
ON native_dispatch (session_id, state, dispatch_id);

CREATE TRIGGER native_dispatch_binding_immutable BEFORE UPDATE ON native_dispatch
WHEN NEW.run_id <> OLD.run_id OR NEW.stage_id <> OLD.stage_id
OR NEW.attempt_id <> OLD.attempt_id OR NEW.issued_at <> OLD.issued_at
BEGIN
    SELECT RAISE(ABORT, 'a dispatch binding is immutable');
END;

CREATE TRIGGER native_dispatch_revision_advances BEFORE UPDATE ON native_dispatch
WHEN NEW.revision < OLD.revision
BEGIN
    SELECT RAISE(ABORT, 'a dispatch revision must never move backwards');
END;

CREATE TRIGGER native_dispatch_settlement_final BEFORE UPDATE ON native_dispatch
WHEN OLD.state IN ('submitted','revoked','abandoned') AND NEW.state <> OLD.state
BEGIN
    SELECT RAISE(ABORT, 'a settled dispatch is terminal');
END;

CREATE TABLE native_stage_question
(
    run_id                 TEXT NOT NULL REFERENCES native_stage(run_id),
    interaction_id         TEXT NOT NULL,
    stage_id               TEXT NOT NULL,
    attempt_id             TEXT NOT NULL REFERENCES native_stage_attempt(attempt_id),
    dispatch_id            TEXT NOT NULL REFERENCES native_dispatch(dispatch_id),
    source_payload_json    TEXT NOT NULL CHECK (json_valid(source_payload_json)),
    canonical_payload_json TEXT NOT NULL CHECK (json_valid(canonical_payload_json)),
    requested_at           TEXT NOT NULL,
    timeout_at             TEXT,
    created_event_id       TEXT REFERENCES state_event(event_id),
    PRIMARY KEY (run_id, interaction_id)
) STRICT;

CREATE TRIGGER native_stage_question_immutable_update BEFORE UPDATE ON native_stage_question
BEGIN
    SELECT RAISE(ABORT, 'native stage questions are immutable');
END;

CREATE TRIGGER native_stage_question_immutable_delete BEFORE DELETE ON native_stage_question
BEGIN
    SELECT RAISE(ABORT, 'native stage questions are immutable');
END;

CREATE TABLE native_question_projection
(
    run_id                 TEXT NOT NULL,
    interaction_id         TEXT NOT NULL,
    state                  TEXT NOT NULL,
    revision               INTEGER NOT NULL,
    delivery_state         TEXT NOT NULL,
    cancellation_reason    TEXT,
    answer_json            TEXT CHECK (answer_json IS NULL OR json_valid(answer_json)),
    answered_by_key_id     TEXT,
    answered_at            TEXT,
    resolved_at            TEXT,
    last_event_sequence    INTEGER NOT NULL REFERENCES state_event(sequence),
    updated_at             TEXT NOT NULL,
    PRIMARY KEY (run_id, interaction_id),
    FOREIGN KEY (run_id, interaction_id) REFERENCES native_stage_question(run_id, interaction_id),
    CHECK (state IN ('pending','answered','cancelled')),
    CHECK (delivery_state IN ('not_applicable','pending','delivered')),
    CHECK (revision >= 1),
    CHECK ((state = 'answered') = (answer_json IS NOT NULL)),
    CHECK ((state = 'answered') = (answered_by_key_id IS NOT NULL)),
    CHECK ((state IN ('answered','cancelled')) = (resolved_at IS NOT NULL)),
    CHECK (cancellation_reason IS NULL OR cancellation_reason IN
      ('withdrawn','timed_out','run_terminal','migration_unresolved'))
) STRICT;

CREATE INDEX native_question_inbox
ON native_question_projection (state, updated_at, run_id, interaction_id);

CREATE INDEX native_question_undelivered
ON native_question_projection (delivery_state, run_id, interaction_id);

CREATE TRIGGER native_question_first_revision BEFORE INSERT ON native_question_projection
WHEN NEW.revision <> 1
BEGIN
    SELECT RAISE(ABORT, 'first native question revision must be 1');
END;

CREATE TRIGGER native_question_causal_update BEFORE UPDATE ON native_question_projection
WHEN NEW.last_event_sequence <= OLD.last_event_sequence OR NEW.revision <> OLD.revision + 1
BEGIN
    SELECT RAISE(ABORT, 'native question projection must advance revision by 1');
END;

-- Migration 12 — durable pipeline graph scheduling (Q025).

CREATE TABLE pipeline_graph_revision (
    run_id TEXT NOT NULL,
    graph_revision INTEGER NOT NULL,
    pipeline_id TEXT NOT NULL,
    graph_json TEXT NOT NULL CHECK (json_valid(graph_json)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, graph_revision),
    CHECK (graph_revision >= 1)
) STRICT;

CREATE TRIGGER pipeline_graph_revision_immutable_update
BEFORE UPDATE ON pipeline_graph_revision
BEGIN
    SELECT RAISE(ABORT, 'pipeline graph revisions are immutable');
END;

CREATE TRIGGER pipeline_graph_revision_immutable_delete
BEFORE DELETE ON pipeline_graph_revision
BEGIN
    SELECT RAISE(ABORT, 'pipeline graph revisions are immutable');
END;

CREATE TABLE pipeline_schedule (
    run_id TEXT NOT NULL PRIMARY KEY,
    pipeline_id TEXT NOT NULL,
    graph_revision INTEGER NOT NULL,
    schedule_revision INTEGER NOT NULL,
    deadline_at TEXT,
    terminal_outcome TEXT,
    terminal_reason TEXT,
    terminal_stage_id TEXT,
    updated_at TEXT NOT NULL,
    CHECK (graph_revision >= 1),
    CHECK (schedule_revision >= 1),
    CHECK (terminal_outcome IS NULL OR terminal_outcome IN
      ('succeeded','failed','cancelled','blocked')),
    FOREIGN KEY (run_id, graph_revision)
      REFERENCES pipeline_graph_revision (run_id, graph_revision)
) STRICT;

CREATE TRIGGER pipeline_schedule_first_revision BEFORE INSERT ON pipeline_schedule
WHEN NEW.schedule_revision <> 1
BEGIN
    SELECT RAISE(ABORT, 'first pipeline schedule revision must be 1');
END;

CREATE TRIGGER pipeline_schedule_revision_advances BEFORE UPDATE ON pipeline_schedule
WHEN NEW.schedule_revision < OLD.schedule_revision
BEGIN
    SELECT RAISE(ABORT, 'a pipeline schedule revision must never move backwards');
END;

CREATE TABLE pipeline_stage_attempt (
    attempt_id TEXT NOT NULL PRIMARY KEY,
    run_id TEXT NOT NULL,
    pipeline_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    graph_revision INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    attempt_ordinal INTEGER NOT NULL,
    stage_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, graph_revision, stage_id, generation, attempt_ordinal),
    CHECK (graph_revision >= 1),
    CHECK (generation >= 1),
    CHECK (attempt_ordinal >= 1),
    CHECK (stage_type IN ('agent','command','approval','integration','verify','publish')),
    FOREIGN KEY (run_id, graph_revision)
      REFERENCES pipeline_graph_revision (run_id, graph_revision)
) STRICT;

CREATE TRIGGER pipeline_stage_attempt_immutable_update
BEFORE UPDATE ON pipeline_stage_attempt
BEGIN
    SELECT RAISE(ABORT, 'pipeline stage attempts are immutable');
END;

CREATE TRIGGER pipeline_stage_attempt_immutable_delete
BEFORE DELETE ON pipeline_stage_attempt
BEGIN
    SELECT RAISE(ABORT, 'pipeline stage attempts are immutable');
END;

CREATE TABLE pipeline_stage_projection (
    run_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    graph_revision INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    state TEXT NOT NULL,
    attempt_ordinal INTEGER NOT NULL,
    current_attempt_id TEXT REFERENCES pipeline_stage_attempt (attempt_id),
    last_transition_reason TEXT,
    block_reason TEXT,
    selected INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, stage_id),
    CHECK (graph_revision >= 1),
    CHECK (generation >= 1),
    CHECK (attempt_ordinal >= 0),
    CHECK (selected IN (0, 1)),
    CHECK (state IN (
      'pending','ready','queued','running','waiting','retrying',
      'succeeded','failed','cancelled','blocked'
    )),
    FOREIGN KEY (run_id, graph_revision)
      REFERENCES pipeline_graph_revision (run_id, graph_revision)
) STRICT;

CREATE TABLE pipeline_scheduler_decision (
    decision_id TEXT NOT NULL PRIMARY KEY,
    run_id TEXT NOT NULL,
    stage_id TEXT,
    graph_revision INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    attempt_ordinal INTEGER NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT,
    attempt_id TEXT,
    intent_id TEXT,
    detail TEXT,
    recorded_at TEXT NOT NULL,
    CHECK (graph_revision >= 1),
    CHECK (generation >= 1),
    CHECK (attempt_ordinal >= 0),
    FOREIGN KEY (run_id, graph_revision)
      REFERENCES pipeline_graph_revision (run_id, graph_revision)
) STRICT;

CREATE INDEX pipeline_scheduler_decision_run
ON pipeline_scheduler_decision (run_id, recorded_at, decision_id);

CREATE TRIGGER pipeline_scheduler_decision_immutable_update
BEFORE UPDATE ON pipeline_scheduler_decision
BEGIN
    SELECT RAISE(ABORT, 'pipeline scheduler decisions are immutable');
END;

CREATE TRIGGER pipeline_scheduler_decision_immutable_delete
BEFORE DELETE ON pipeline_scheduler_decision
BEGIN
    SELECT RAISE(ABORT, 'pipeline scheduler decisions are immutable');
END;

CREATE TABLE pipeline_scheduler_intent (
    intent_id TEXT NOT NULL PRIMARY KEY,
    run_id TEXT NOT NULL,
    graph_revision INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    CHECK (kind IN ('dispatch','cancel','evaluator')),
    CHECK (state IN ('pending','delivered')),
    CHECK (graph_revision >= 1),
    CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
    FOREIGN KEY (run_id, graph_revision)
      REFERENCES pipeline_graph_revision (run_id, graph_revision)
) STRICT;

CREATE INDEX pipeline_scheduler_intent_pending
ON pipeline_scheduler_intent (state, run_id, created_at, intent_id);

CREATE TABLE pipeline_scheduler_observation (
    observation_id TEXT NOT NULL PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    recorded_at TEXT NOT NULL,
    consumed_at TEXT,
    CHECK (kind IN (
      'attempt_started','attempt_waiting','attempt_succeeded','attempt_failed',
      'cancellation_settled','evaluator_decided','cancel_requested','manual_rerun',
      'recovery_proposed','recovery_approved','recovery_rejected'
    ))
) STRICT;

CREATE INDEX pipeline_scheduler_observation_pending
ON pipeline_scheduler_observation (run_id, consumed_at, recorded_at, observation_id);

CREATE TABLE pipeline_evaluator_decision (
    run_id TEXT NOT NULL,
    edge_key TEXT NOT NULL,
    selected INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (run_id, edge_key),
    CHECK (selected IN (0, 1))
) STRICT;

CREATE TRIGGER pipeline_evaluator_decision_immutable_update
BEFORE UPDATE ON pipeline_evaluator_decision
BEGIN
    SELECT RAISE(ABORT, 'pipeline evaluator decisions are immutable');
END;

CREATE TABLE pipeline_runner_attempt (
    attempt_id TEXT NOT NULL PRIMARY KEY
      REFERENCES pipeline_stage_attempt (attempt_id),
    run_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    stage_type TEXT NOT NULL,
    intent_id TEXT NOT NULL UNIQUE
      REFERENCES pipeline_scheduler_intent (intent_id),
    graph_revision INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    attempt_ordinal INTEGER NOT NULL,
    phase TEXT NOT NULL,
    workspace_id TEXT REFERENCES workspace (workspace_id),
    lease_id TEXT,
    checkout_path TEXT,
    process_group_id INTEGER,
    backend_execution_id TEXT,
    operation_id TEXT,
    deadline_at TEXT,
    runtime_directory TEXT,
    prepared_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    outputs_json TEXT NOT NULL CHECK (json_valid(outputs_json)),
    evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
    cleanup_json TEXT CHECK (cleanup_json IS NULL OR json_valid(cleanup_json)),
    validation_json TEXT CHECK (validation_json IS NULL OR json_valid(validation_json)),
    recovery TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (stage_type IN (
      'agent','command','approval','integration','verify','publish'
    )),
    CHECK (graph_revision >= 1),
    CHECK (generation >= 1),
    CHECK (attempt_ordinal >= 1),
    CHECK (revision >= 1),
    CHECK (process_group_id IS NULL OR process_group_id >= 1),
    CHECK (phase IN (
      'prepare','start','observe','cancel','collect','validate','finalize',
      'succeeded','failed','cancelled','recovery_required'
    )),
    CHECK (recovery IN (
      'none','observe_backend','reap_process','reconcile_artifacts',
      'reconcile_git','reconcile_forge','await_approval','manual'
    )),
    CHECK ((phase IN ('succeeded','failed','cancelled','recovery_required')) =
      (finished_at IS NOT NULL))
) STRICT;

CREATE INDEX pipeline_runner_attempt_run
ON pipeline_runner_attempt (run_id, stage_id, attempt_id);

CREATE INDEX pipeline_runner_attempt_open
ON pipeline_runner_attempt (phase, updated_at, attempt_id)
WHERE phase NOT IN ('succeeded','failed','cancelled');

CREATE TRIGGER pipeline_runner_attempt_first_revision
BEFORE INSERT ON pipeline_runner_attempt
WHEN NEW.revision <> 1
BEGIN
    SELECT RAISE(ABORT, 'first pipeline runner attempt revision must be 1');
END;

CREATE TRIGGER pipeline_runner_attempt_revision_advances
BEFORE UPDATE ON pipeline_runner_attempt
WHEN NEW.revision <> OLD.revision + 1
BEGIN
    SELECT RAISE(ABORT, 'pipeline runner attempt update must advance revision by 1');
END;

CREATE TRIGGER pipeline_runner_attempt_identity_immutable
BEFORE UPDATE ON pipeline_runner_attempt
WHEN NEW.run_id <> OLD.run_id OR NEW.stage_id <> OLD.stage_id
  OR NEW.stage_type <> OLD.stage_type OR NEW.intent_id <> OLD.intent_id
  OR NEW.graph_revision <> OLD.graph_revision
  OR NEW.generation <> OLD.generation
  OR NEW.attempt_ordinal <> OLD.attempt_ordinal
  OR NEW.created_at <> OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'pipeline runner attempt identity is immutable');
END;

CREATE TABLE pipeline_runner_phase_transition (
    transition_id TEXT NOT NULL PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES pipeline_runner_attempt (attempt_id),
    from_phase TEXT,
    to_phase TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    detail TEXT,
    CHECK (from_phase IS NULL OR from_phase IN (
      'prepare','start','observe','cancel','collect','validate','finalize',
      'succeeded','failed','cancelled','recovery_required'
    )),
    CHECK (to_phase IN (
      'prepare','start','observe','cancel','collect','validate','finalize',
      'succeeded','failed','cancelled','recovery_required'
    ))
) STRICT;

CREATE INDEX pipeline_runner_phase_transition_attempt
ON pipeline_runner_phase_transition (attempt_id, recorded_at, transition_id);

CREATE TRIGGER pipeline_runner_phase_transition_immutable_update
BEFORE UPDATE ON pipeline_runner_phase_transition
BEGIN
    SELECT RAISE(ABORT, 'pipeline runner phase transitions are immutable');
END;

CREATE TRIGGER pipeline_runner_phase_transition_immutable_delete
BEFORE DELETE ON pipeline_runner_phase_transition
BEGIN
    SELECT RAISE(ABORT, 'pipeline runner phase transitions are immutable');
END;

CREATE TABLE pipeline_runner_operation_request (
    operation_id TEXT NOT NULL PRIMARY KEY,
    attempt_id TEXT NOT NULL UNIQUE
      REFERENCES pipeline_runner_attempt (attempt_id),
    stage_type TEXT NOT NULL,
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    created_at TEXT NOT NULL,
    CHECK (stage_type IN ('approval','integration','verify','publish'))
) STRICT;

CREATE TRIGGER pipeline_runner_operation_request_immutable_update
BEFORE UPDATE ON pipeline_runner_operation_request
BEGIN
    SELECT RAISE(ABORT, 'pipeline runner operation requests are immutable');
END;

CREATE TRIGGER pipeline_runner_operation_request_immutable_delete
BEFORE DELETE ON pipeline_runner_operation_request
BEGIN
    SELECT RAISE(ABORT, 'pipeline runner operation requests are immutable');
END;

CREATE TABLE pipeline_runner_operation_state (
    operation_id TEXT NOT NULL PRIMARY KEY
      REFERENCES pipeline_runner_operation_request (operation_id),
    attempt_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (phase IN (
      'pending','waiting','executing','completed','failed',
      'cancelled','reconciliation_required'
    )),
    CHECK (revision >= 1)
) STRICT;

CREATE TRIGGER pipeline_runner_operation_state_first_revision
BEFORE INSERT ON pipeline_runner_operation_state
WHEN NEW.revision <> 1
BEGIN
    SELECT RAISE(ABORT, 'first pipeline runner operation state revision must be 1');
END;

CREATE TRIGGER pipeline_runner_operation_state_revision_advances
BEFORE UPDATE ON pipeline_runner_operation_state
WHEN NEW.revision <> OLD.revision + 1
BEGIN
    SELECT RAISE(ABORT, 'pipeline runner operation state update must advance revision by 1');
END;

CREATE TABLE pipeline_runner_approval_answer (
    answer_id TEXT NOT NULL PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE
      REFERENCES pipeline_runner_operation_request (operation_id),
    attempt_id TEXT NOT NULL,
    interaction_id TEXT NOT NULL,
    expected_revision INTEGER NOT NULL,
    decision TEXT NOT NULL,
    selected_label TEXT NOT NULL,
    answered_by_key_id TEXT NOT NULL,
    answered_at TEXT NOT NULL,
    decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
    CHECK (decision IN ('approve','reject')),
    CHECK (expected_revision >= 1)
) STRICT;

CREATE TRIGGER pipeline_runner_approval_answer_immutable_update
BEFORE UPDATE ON pipeline_runner_approval_answer
BEGIN
    SELECT RAISE(ABORT, 'pipeline runner approval answers are immutable');
END;

CREATE TRIGGER pipeline_runner_approval_answer_immutable_delete
BEFORE DELETE ON pipeline_runner_approval_answer
BEGIN
    SELECT RAISE(ABORT, 'pipeline runner approval answers are immutable');
END;

CREATE TABLE pipeline_runner_external_observation (
    observation_id TEXT NOT NULL PRIMARY KEY,
    attempt_id TEXT NOT NULL
      REFERENCES pipeline_runner_attempt (attempt_id),
    operation_id TEXT,
    kind TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
) STRICT;

CREATE INDEX pipeline_runner_external_observation_attempt
ON pipeline_runner_external_observation (attempt_id, recorded_at, observation_id);

CREATE TRIGGER pipeline_runner_external_observation_immutable_update
BEFORE UPDATE ON pipeline_runner_external_observation
BEGIN
    SELECT RAISE(ABORT, 'pipeline runner external observations are immutable');
END;

CREATE TRIGGER pipeline_runner_external_observation_immutable_delete
BEFORE DELETE ON pipeline_runner_external_observation
BEGIN
    SELECT RAISE(ABORT, 'pipeline runner external observations are immutable');
END;

CREATE TABLE pipeline_runner_reconciliation_trace (
    trace_id TEXT NOT NULL PRIMARY KEY,
    attempt_id TEXT NOT NULL
      REFERENCES pipeline_runner_attempt (attempt_id),
    operation_id TEXT,
    stage_type TEXT NOT NULL,
    classification TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    detail TEXT,
    payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
    CHECK (stage_type IN ('integration','publish'))
) STRICT;

CREATE INDEX pipeline_runner_reconciliation_trace_attempt
ON pipeline_runner_reconciliation_trace (attempt_id, recorded_at, trace_id);

CREATE TRIGGER pipeline_runner_reconciliation_trace_immutable_update
BEFORE UPDATE ON pipeline_runner_reconciliation_trace
BEGIN
    SELECT RAISE(ABORT, 'pipeline runner reconciliation traces are immutable');
END;

CREATE TRIGGER pipeline_runner_reconciliation_trace_immutable_delete
BEFORE DELETE ON pipeline_runner_reconciliation_trace
BEGIN
    SELECT RAISE(ABORT, 'pipeline runner reconciliation traces are immutable');
END;

CREATE INDEX pipeline_runner_approval_inbox
ON pipeline_runner_operation_state (phase, updated_at, operation_id)
WHERE phase = 'waiting';

CREATE TABLE pipeline_recovery_decision (
    decision_id TEXT NOT NULL PRIMARY KEY,
    run_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    graph_revision INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    attempt_ordinal INTEGER NOT NULL,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL,
    decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
    recorded_at TEXT NOT NULL,
    CHECK (graph_revision >= 1),
    CHECK (generation >= 1),
    CHECK (attempt_ordinal >= 0),
    CHECK (action IN (
      'propose','approve','reject','dispatch','block','fail','exhaust'
    )),
    CHECK (outcome IN (
      'pause','fail','repair','repair_fresh','delegate','exhausted',
      'unchanged_exhausted','rejected','blocked'
    ))
) STRICT;

CREATE INDEX pipeline_recovery_decision_run
ON pipeline_recovery_decision (run_id, recorded_at, decision_id);

CREATE TRIGGER pipeline_recovery_decision_immutable_update
BEFORE UPDATE ON pipeline_recovery_decision
BEGIN
    SELECT RAISE(ABORT, 'pipeline recovery decisions are immutable');
END;

CREATE TRIGGER pipeline_recovery_decision_immutable_delete
BEFORE DELETE ON pipeline_recovery_decision
BEGIN
    SELECT RAISE(ABORT, 'pipeline recovery decisions are immutable');
END;

CREATE TABLE pipeline_stage_recovery_state (
    run_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    repairs_used INTEGER NOT NULL,
    last_signature_digest TEXT,
    identical_signature_count INTEGER NOT NULL,
    pending_proposal_id TEXT,
    pending_proposal_json TEXT
      CHECK (pending_proposal_json IS NULL OR json_valid(pending_proposal_json)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, stage_id, generation),
    CHECK (generation >= 1),
    CHECK (repairs_used >= 0),
    CHECK (identical_signature_count >= 0),
    CHECK (last_signature_digest IS NULL OR (
      length(last_signature_digest) = 64
      AND last_signature_digest NOT GLOB '*[^0-9a-f]*'
    ))
) STRICT;

CREATE TABLE pipeline_canonical_run_state (
    run_id TEXT NOT NULL PRIMARY KEY,
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (revision >= 1)
) STRICT;

CREATE TRIGGER pipeline_canonical_run_state_first_revision
BEFORE INSERT ON pipeline_canonical_run_state
WHEN NEW.revision <> 1
BEGIN
    SELECT RAISE(ABORT, 'first pipeline canonical run state revision must be 1');
END;

CREATE TRIGGER pipeline_canonical_run_state_revision_advances
BEFORE UPDATE ON pipeline_canonical_run_state
WHEN NEW.revision <> OLD.revision + 1
BEGIN
    SELECT RAISE(ABORT, 'pipeline canonical run state update must advance revision by 1');
END;

CREATE TABLE pipeline_retry_directive (
    attempt_id TEXT NOT NULL PRIMARY KEY
      REFERENCES pipeline_stage_attempt (attempt_id),
    recovery_decision_id TEXT NOT NULL
      REFERENCES pipeline_recovery_decision (decision_id),
    directive_json TEXT NOT NULL CHECK (json_valid(directive_json)),
    created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER pipeline_retry_directive_immutable_update
BEFORE UPDATE ON pipeline_retry_directive
BEGIN
    SELECT RAISE(ABORT, 'pipeline retry directives are immutable');
END;

CREATE TRIGGER pipeline_retry_directive_immutable_delete
BEFORE DELETE ON pipeline_retry_directive
BEGIN
    SELECT RAISE(ABORT, 'pipeline retry directives are immutable');
END;

CREATE TABLE pipeline_execution_segment (
    segment_id TEXT NOT NULL PRIMARY KEY,
    run_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    profile_fingerprint TEXT,
    workspace_id TEXT,
    lease_id TEXT,
    backend_execution_id TEXT,
    stage_ids_json TEXT NOT NULL CHECK (json_valid(stage_ids_json)),
    status TEXT NOT NULL,
    soft_threshold REAL NOT NULL,
    hard_threshold REAL NOT NULL,
    telemetry_cursor TEXT,
    capsule_id TEXT,
    segment_json TEXT NOT NULL CHECK (json_valid(segment_json)),
    started_at TEXT NOT NULL,
    closed_at TEXT,
    CHECK (status IN ('open','checkpointed','closed','blocked')),
    CHECK (soft_threshold >= 0 AND soft_threshold <= 1),
    CHECK (hard_threshold >= 0 AND hard_threshold <= 1)
) STRICT;

CREATE INDEX pipeline_execution_segment_run
ON pipeline_execution_segment (run_id, started_at, segment_id);

CREATE TRIGGER pipeline_execution_segment_immutable_delete
BEFORE DELETE ON pipeline_execution_segment
BEGIN
    SELECT RAISE(ABORT, 'pipeline execution segments are immutable');
END;

CREATE TABLE pipeline_fusion_decision (
    decision_id TEXT NOT NULL PRIMARY KEY,
    run_id TEXT NOT NULL,
    from_stage_id TEXT NOT NULL,
    to_stage_id TEXT NOT NULL,
    from_attempt_id TEXT,
    to_attempt_id TEXT,
    outcome TEXT NOT NULL,
    split_reason TEXT,
    segment_id TEXT,
    decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
    recorded_at TEXT NOT NULL,
    CHECK (outcome IN ('fuse','split'))
) STRICT;

CREATE INDEX pipeline_fusion_decision_run
ON pipeline_fusion_decision (run_id, recorded_at, decision_id);

CREATE TRIGGER pipeline_fusion_decision_immutable_update
BEFORE UPDATE ON pipeline_fusion_decision
BEGIN
    SELECT RAISE(ABORT, 'pipeline fusion decisions are immutable');
END;

CREATE TRIGGER pipeline_fusion_decision_immutable_delete
BEFORE DELETE ON pipeline_fusion_decision
BEGIN
    SELECT RAISE(ABORT, 'pipeline fusion decisions are immutable');
END;

CREATE TABLE pipeline_continuation_capsule (
    capsule_id TEXT NOT NULL PRIMARY KEY,
    run_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    segment_ordinal INTEGER NOT NULL,
    digest TEXT NOT NULL,
    narrative_digest TEXT,
    capsule_json TEXT NOT NULL CHECK (json_valid(capsule_json)),
    narrative_text TEXT,
    created_at TEXT NOT NULL,
    CHECK (segment_ordinal >= 0),
    CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
    CHECK (narrative_digest IS NULL OR (
      length(narrative_digest) = 64
      AND narrative_digest NOT GLOB '*[^0-9a-f]*'
    ))
) STRICT;

CREATE INDEX pipeline_continuation_capsule_run
ON pipeline_continuation_capsule (run_id, created_at, capsule_id);

CREATE TRIGGER pipeline_continuation_capsule_immutable_update
BEFORE UPDATE ON pipeline_continuation_capsule
BEGIN
    SELECT RAISE(ABORT, 'pipeline continuation capsules are immutable');
END;

CREATE TRIGGER pipeline_continuation_capsule_immutable_delete
BEFORE DELETE ON pipeline_continuation_capsule
BEGIN
    SELECT RAISE(ABORT, 'pipeline continuation capsules are immutable');
END;

CREATE TABLE pipeline_pressure_observation (
    observation_id TEXT NOT NULL PRIMARY KEY,
    run_id TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    attempt_id TEXT,
    ratio REAL,
    confidence TEXT NOT NULL,
    state TEXT NOT NULL,
    soft_threshold REAL NOT NULL,
    hard_threshold REAL NOT NULL,
    telemetry_cursor TEXT,
    action TEXT NOT NULL,
    observation_json TEXT NOT NULL CHECK (json_valid(observation_json)),
    recorded_at TEXT NOT NULL,
    CHECK (confidence IN ('exact','estimated','unavailable')),
    CHECK (state IN ('measured','exhausted','unavailable')),
    CHECK (action IN ('continue','soft_boundary','hard_checkpoint','forbid_fusion')),
    CHECK (soft_threshold >= 0 AND soft_threshold <= 1),
    CHECK (hard_threshold >= 0 AND hard_threshold <= 1),
    CHECK (ratio IS NULL OR (ratio >= 0 AND ratio <= 1))
) STRICT;

CREATE INDEX pipeline_pressure_observation_segment
ON pipeline_pressure_observation (segment_id, recorded_at, observation_id);

CREATE TRIGGER pipeline_pressure_observation_immutable_update
BEFORE UPDATE ON pipeline_pressure_observation
BEGIN
    SELECT RAISE(ABORT, 'pipeline pressure observations are immutable');
END;

CREATE TRIGGER pipeline_pressure_observation_immutable_delete
BEFORE DELETE ON pipeline_pressure_observation
BEGIN
    SELECT RAISE(ABORT, 'pipeline pressure observations are immutable');
END;

CREATE TABLE pipeline_incoming_verification (
    verification_id TEXT NOT NULL PRIMARY KEY,
    capsule_id TEXT NOT NULL
      REFERENCES pipeline_continuation_capsule (capsule_id),
    run_id TEXT NOT NULL,
    segment_id TEXT,
    verdict TEXT NOT NULL,
    blockers_json TEXT NOT NULL CHECK (json_valid(blockers_json)),
    verification_json TEXT NOT NULL CHECK (json_valid(verification_json)),
    recorded_at TEXT NOT NULL,
    CHECK (verdict IN ('pass','block'))
) STRICT;

CREATE INDEX pipeline_incoming_verification_capsule
ON pipeline_incoming_verification (capsule_id, recorded_at, verification_id);

CREATE TRIGGER pipeline_incoming_verification_immutable_update
BEFORE UPDATE ON pipeline_incoming_verification
BEGIN
    SELECT RAISE(ABORT, 'pipeline incoming verifications are immutable');
END;

CREATE TRIGGER pipeline_incoming_verification_immutable_delete
BEFORE DELETE ON pipeline_incoming_verification
BEGIN
    SELECT RAISE(ABORT, 'pipeline incoming verifications are immutable');
END;

CREATE TABLE pipeline_segment_metrics (
    run_id TEXT NOT NULL PRIMARY KEY,
    session_count INTEGER NOT NULL,
    cold_start_count INTEGER NOT NULL,
    fused_stage_count INTEGER NOT NULL,
    smart_continuation_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (session_count >= 0),
    CHECK (cold_start_count >= 0),
    CHECK (fused_stage_count >= 0),
    CHECK (smart_continuation_count >= 0)
) STRICT;

CREATE TABLE pipeline_finding_report (
    sequence INTEGER PRIMARY KEY,
    report_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    report_kind TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    report_json TEXT NOT NULL CHECK (json_valid(report_json)),
    recorded_at TEXT NOT NULL,
    CHECK (report_kind IN ('review','repair','final_verification')),
    CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE INDEX pipeline_finding_report_run
ON pipeline_finding_report (run_id, sequence);

CREATE TRIGGER pipeline_finding_report_immutable_update
BEFORE UPDATE ON pipeline_finding_report
BEGIN
    SELECT RAISE(ABORT, 'pipeline finding reports are immutable');
END;

CREATE TRIGGER pipeline_finding_report_immutable_delete
BEFORE DELETE ON pipeline_finding_report
BEGIN
    SELECT RAISE(ABORT, 'pipeline finding reports are immutable');
END;

CREATE TABLE pipeline_finding_projection (
    run_id TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    origin_report_id TEXT NOT NULL,
    origin_stage_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    disposition TEXT NOT NULL,
    claim_verification_state TEXT NOT NULL,
    repair_state TEXT NOT NULL,
    resolution_state TEXT NOT NULL,
    latest_report_id TEXT NOT NULL,
    latest_report_artifact_id TEXT NOT NULL,
    latest_report_content_hash TEXT NOT NULL,
    evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, finding_id),
    CHECK (severity IN ('critical','major','minor')),
    CHECK (disposition IN ('accepted','rejected')),
    CHECK (claim_verification_state IN ('verified','retracted')),
    CHECK (repair_state IN ('pending','applied','skipped','failed','not_required')),
    CHECK (resolution_state IN ('pending','fixed','unresolved','not_applicable')),
    CHECK (revision >= 1)
) STRICT;

CREATE INDEX pipeline_finding_projection_query
ON pipeline_finding_projection (
    run_id, severity, disposition, resolution_state, finding_id
);

CREATE TABLE pipeline_run_snapshot (
    run_id TEXT NOT NULL PRIMARY KEY,
    pipeline_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_identity TEXT NOT NULL,
    source_digest TEXT NOT NULL,
    source_path TEXT,
    base_graph_json TEXT NOT NULL CHECK (json_valid(base_graph_json)),
    effective_graph_json TEXT NOT NULL CHECK (json_valid(effective_graph_json)),
    base_graph_digest TEXT NOT NULL,
    effective_graph_digest TEXT NOT NULL,
    resolved_profiles_json TEXT NOT NULL CHECK (json_valid(resolved_profiles_json)),
    requested_overrides_json TEXT NOT NULL CHECK (json_valid(requested_overrides_json)),
    applied_overrides_json TEXT NOT NULL CHECK (json_valid(applied_overrides_json)),
    effective_limits_json TEXT NOT NULL CHECK (json_valid(effective_limits_json)),
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
    recorded_at TEXT NOT NULL,
    CHECK (source_kind IN ('bundled','global','codebase-override','one-off')),
    CHECK (length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(base_graph_digest) = 64 AND base_graph_digest NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(effective_graph_digest) = 64 AND effective_graph_digest NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE TRIGGER pipeline_run_snapshot_immutable_update
BEFORE UPDATE ON pipeline_run_snapshot
BEGIN
    SELECT RAISE(ABORT, 'pipeline run snapshots are immutable');
END;

CREATE TRIGGER pipeline_run_snapshot_immutable_delete
BEFORE DELETE ON pipeline_run_snapshot
BEGIN
    SELECT RAISE(ABORT, 'pipeline run snapshots are immutable');
END;

CREATE TABLE pipeline_attachment_ledger (
    attachment_id TEXT NOT NULL PRIMARY KEY,
    request_digest TEXT NOT NULL,
    source_run_id TEXT NOT NULL,
    source_stage_id TEXT NOT NULL,
    target_run_id TEXT NOT NULL,
    target_stage_id TEXT NOT NULL,
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    validation_evidence_json TEXT NOT NULL CHECK (json_valid(validation_evidence_json)),
    artifact_ids_json TEXT NOT NULL CHECK (json_valid(artifact_ids_json)),
    lifecycle_json TEXT NOT NULL CHECK (json_valid(lifecycle_json)),
    graph_revision_before INTEGER NOT NULL,
    graph_revision_after INTEGER NOT NULL,
    schedule_revision_after INTEGER NOT NULL,
    run_revision_after INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
    CHECK (graph_revision_before >= 1),
    CHECK (graph_revision_after = graph_revision_before + 1),
    CHECK (schedule_revision_after >= 1),
    CHECK (run_revision_after >= 1)
) STRICT;

CREATE UNIQUE INDEX pipeline_attachment_source_target
ON pipeline_attachment_ledger (
    source_run_id, source_stage_id, target_run_id, target_stage_id
);

CREATE INDEX pipeline_attachment_target_run
ON pipeline_attachment_ledger (target_run_id, recorded_at, attachment_id);

CREATE TRIGGER pipeline_attachment_ledger_immutable_update
BEFORE UPDATE ON pipeline_attachment_ledger
BEGIN
    SELECT RAISE(ABORT, 'pipeline attachment ledger is immutable');
END;

CREATE TRIGGER pipeline_attachment_ledger_immutable_delete
BEFORE DELETE ON pipeline_attachment_ledger
BEGIN
    SELECT RAISE(ABORT, 'pipeline attachment ledger is immutable');
END;

CREATE TABLE workspace_variant_projection (
    variant_id TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspace(workspace_id),
    lifecycle_status TEXT NOT NULL,
    revision INTEGER NOT NULL,
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    updated_at TEXT NOT NULL,
    CHECK (revision >= 1),
    CHECK (lifecycle_status IN
      ('provisioning','ready','prepared','integrated','conflict','partial-progress','recovery-required'))
) STRICT;

CREATE INDEX workspace_variant_workspace
ON workspace_variant_projection(workspace_id, updated_at, variant_id);

CREATE TRIGGER workspace_variant_first_revision
BEFORE INSERT ON workspace_variant_projection WHEN NEW.revision <> 1
BEGIN SELECT RAISE(ABORT, 'first workspace variant revision must be 1'); END;

CREATE TRIGGER workspace_variant_causal_update
BEFORE UPDATE ON workspace_variant_projection WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'workspace variant projection must advance revision by 1'); END;

CREATE TRIGGER workspace_variant_immutable_delete
BEFORE DELETE ON workspace_variant_projection
BEGIN SELECT RAISE(ABORT, 'workspace variant projections cannot be deleted'); END;

CREATE TABLE workspace_variant_integration_trace (
    variant_id TEXT NOT NULL REFERENCES workspace_variant_projection(variant_id),
    sequence INTEGER NOT NULL,
    trace_json TEXT NOT NULL CHECK (json_valid(trace_json)),
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (variant_id, sequence)
) STRICT;

CREATE TRIGGER workspace_variant_trace_immutable_update
BEFORE UPDATE ON workspace_variant_integration_trace
BEGIN SELECT RAISE(ABORT, 'workspace variant traces are immutable'); END;

CREATE TRIGGER workspace_variant_trace_immutable_delete
BEFORE DELETE ON workspace_variant_integration_trace
BEGIN SELECT RAISE(ABORT, 'workspace variant traces are immutable'); END;

CREATE TABLE task_source_snapshot (
    snapshot_id TEXT NOT NULL PRIMARY KEY,
    source_work_item_id TEXT NOT NULL,
    source_uri TEXT NOT NULL,
    observed_version TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    raw_artifact_id TEXT NOT NULL,
    raw_relative_path TEXT NOT NULL,
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
    observed_at TEXT NOT NULL,
    UNIQUE (source_uri, observed_version),
    CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
    CHECK (raw_relative_path = 'blobs/sha256/' || content_sha256)
) STRICT;

CREATE INDEX task_source_snapshot_work_item
ON task_source_snapshot(source_work_item_id, observed_at, snapshot_id);

CREATE TRIGGER task_source_snapshot_immutable_update BEFORE UPDATE ON task_source_snapshot
BEGIN SELECT RAISE(ABORT, 'task source snapshots are immutable'); END;

CREATE TRIGGER task_source_snapshot_immutable_delete BEFORE DELETE ON task_source_snapshot
BEGIN SELECT RAISE(ABORT, 'task source snapshots are immutable'); END;

CREATE TABLE task_source_artifact (
    snapshot_id TEXT NOT NULL REFERENCES task_source_snapshot(snapshot_id),
    artifact_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, artifact_id),
    CHECK (role IN ('source','attachment')),
    CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (relative_path = 'blobs/sha256/' || content_hash)
) STRICT;

CREATE TRIGGER task_source_artifact_immutable_update BEFORE UPDATE ON task_source_artifact
BEGIN SELECT RAISE(ABORT, 'task source artifacts are immutable'); END;

CREATE TRIGGER task_source_artifact_immutable_delete BEFORE DELETE ON task_source_artifact
BEGIN SELECT RAISE(ABORT, 'task source artifacts are immutable'); END;

CREATE TABLE task_revision (
    revision_id TEXT NOT NULL PRIMARY KEY,
    source_work_item_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    revision_sha256 TEXT NOT NULL,
    predecessor_id TEXT REFERENCES task_revision(revision_id),
    snapshot_id TEXT NOT NULL REFERENCES task_source_snapshot(snapshot_id),
    revision_json TEXT NOT NULL CHECK (json_valid(revision_json)),
    created_at TEXT NOT NULL,
    UNIQUE (source_work_item_id, ordinal),
    CHECK (ordinal >= 1),
    CHECK (length(revision_sha256) = 64 AND revision_sha256 NOT GLOB '*[^0-9a-f]*'),
    CHECK ((ordinal = 1) = (predecessor_id IS NULL))
) STRICT;

CREATE TRIGGER task_revision_immutable_update BEFORE UPDATE ON task_revision
BEGIN SELECT RAISE(ABORT, 'task revisions are immutable'); END;

CREATE TRIGGER task_revision_immutable_delete BEFORE DELETE ON task_revision
BEGIN SELECT RAISE(ABORT, 'task revisions are immutable'); END;

CREATE TRIGGER task_revision_exact_predecessor BEFORE INSERT ON task_revision
WHEN NEW.ordinal > 1 AND NOT EXISTS (
    SELECT 1 FROM task_revision predecessor
    WHERE predecessor.revision_id = NEW.predecessor_id
      AND predecessor.source_work_item_id = NEW.source_work_item_id
      AND predecessor.ordinal = NEW.ordinal - 1
)
BEGIN SELECT RAISE(ABORT, 'task revision must continue the exact predecessor chain'); END;

CREATE TABLE task_revision_projection (
    source_work_item_id TEXT NOT NULL PRIMARY KEY,
    active_revision_id TEXT NOT NULL REFERENCES task_revision(revision_id),
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (revision >= 1)
) STRICT;

CREATE TRIGGER task_revision_projection_first BEFORE INSERT ON task_revision_projection
WHEN NEW.revision <> 1
BEGIN SELECT RAISE(ABORT, 'first task revision projection must be 1'); END;

CREATE TRIGGER task_revision_projection_causal BEFORE UPDATE ON task_revision_projection
WHEN NEW.revision <> OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'task revision projection must advance revision by 1'); END;

CREATE TRIGGER task_revision_projection_immutable_delete BEFORE DELETE ON task_revision_projection
BEGIN SELECT RAISE(ABORT, 'task revision projections cannot be deleted'); END;

CREATE TABLE task_tracker_edge (
    root_source_work_item_id TEXT NOT NULL,
    parent_source_work_item_id TEXT NOT NULL,
    child_source_work_item_id TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (root_source_work_item_id, parent_source_work_item_id, child_source_work_item_id),
    CHECK (parent_source_work_item_id <> child_source_work_item_id)
) STRICT;

CREATE TRIGGER task_tracker_edge_immutable_update BEFORE UPDATE ON task_tracker_edge
BEGIN SELECT RAISE(ABORT, 'task tracker edges are immutable'); END;

CREATE TRIGGER task_tracker_edge_immutable_delete BEFORE DELETE ON task_tracker_edge
BEGIN SELECT RAISE(ABORT, 'task tracker edges are immutable'); END;

CREATE TABLE task_execution_mapping (
    root_source_work_item_id TEXT NOT NULL,
    source_work_item_id TEXT NOT NULL,
    execution_task_id TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (root_source_work_item_id, source_work_item_id, execution_task_id)
) STRICT;

CREATE TRIGGER task_execution_mapping_immutable_update BEFORE UPDATE ON task_execution_mapping
BEGIN SELECT RAISE(ABORT, 'task execution mappings are immutable'); END;

CREATE TRIGGER task_execution_mapping_immutable_delete BEFORE DELETE ON task_execution_mapping
BEGIN SELECT RAISE(ABORT, 'task execution mappings are immutable'); END;

CREATE TABLE task_graph_revision_decision (
    decision_id TEXT NOT NULL PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES run_projection(run_id),
    graph_id TEXT NOT NULL,
    expected_graph_revision INTEGER NOT NULL,
    proposal_sha256 TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('accepted','rejected')),
    decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
    recorded_at TEXT NOT NULL,
    CHECK (expected_graph_revision >= 1),
    CHECK (length(proposal_sha256) = 64 AND proposal_sha256 NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE INDEX task_graph_revision_decision_run
ON task_graph_revision_decision(run_id, recorded_at, decision_id);

CREATE TRIGGER task_graph_revision_decision_immutable_update BEFORE UPDATE ON task_graph_revision_decision
BEGIN SELECT RAISE(ABORT, 'task graph revision decisions are immutable'); END;

CREATE TRIGGER task_graph_revision_decision_immutable_delete BEFORE DELETE ON task_graph_revision_decision
BEGIN SELECT RAISE(ABORT, 'task graph revision decisions are immutable'); END;

CREATE TABLE task_graph_revision (
    run_id TEXT NOT NULL REFERENCES run_projection(run_id),
    graph_id TEXT NOT NULL,
    graph_revision INTEGER NOT NULL,
    revision_sha256 TEXT NOT NULL,
    predecessor_revision_sha256 TEXT,
    decision_id TEXT REFERENCES task_graph_revision_decision(decision_id),
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    committed_at TEXT NOT NULL,
    PRIMARY KEY (run_id, graph_revision),
    UNIQUE (run_id, revision_sha256),
    CHECK (graph_revision >= 1),
    CHECK (length(revision_sha256) = 64 AND revision_sha256 NOT GLOB '*[^0-9a-f]*'),
    CHECK (predecessor_revision_sha256 IS NULL OR
      (length(predecessor_revision_sha256) = 64 AND predecessor_revision_sha256 NOT GLOB '*[^0-9a-f]*')),
    CHECK ((graph_revision = 1) = (predecessor_revision_sha256 IS NULL)),
    CHECK ((graph_revision = 1) = (decision_id IS NULL))
) STRICT;

CREATE TRIGGER task_graph_revision_exact_predecessor BEFORE INSERT ON task_graph_revision
WHEN NEW.graph_revision > 1 AND NOT EXISTS (
    SELECT 1 FROM task_graph_revision predecessor
    WHERE predecessor.run_id = NEW.run_id
      AND predecessor.graph_id = NEW.graph_id
      AND predecessor.graph_revision = NEW.graph_revision - 1
      AND predecessor.revision_sha256 = NEW.predecessor_revision_sha256
)
BEGIN SELECT RAISE(ABORT, 'task graph revision must continue the exact predecessor'); END;

CREATE TRIGGER task_graph_revision_immutable_update BEFORE UPDATE ON task_graph_revision
BEGIN SELECT RAISE(ABORT, 'task graph revisions are immutable'); END;

CREATE TRIGGER task_graph_revision_immutable_delete BEFORE DELETE ON task_graph_revision
BEGIN SELECT RAISE(ABORT, 'task graph revisions are immutable'); END;

CREATE TABLE task_graph_revision_projection (
    run_id TEXT NOT NULL PRIMARY KEY REFERENCES run_projection(run_id),
    graph_id TEXT NOT NULL,
    active_graph_revision INTEGER NOT NULL,
    active_revision_sha256 TEXT NOT NULL,
    projection_revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id, active_graph_revision)
      REFERENCES task_graph_revision(run_id, graph_revision),
    CHECK (active_graph_revision >= 1),
    CHECK (projection_revision >= 1),
    CHECK (length(active_revision_sha256) = 64 AND active_revision_sha256 NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE TRIGGER task_graph_revision_projection_first BEFORE INSERT ON task_graph_revision_projection
WHEN NEW.active_graph_revision <> 1 OR NEW.projection_revision <> 1
BEGIN SELECT RAISE(ABORT, 'first task graph projection must point to revision 1'); END;

CREATE TRIGGER task_graph_revision_projection_causal BEFORE UPDATE ON task_graph_revision_projection
WHEN NEW.active_graph_revision <> OLD.active_graph_revision + 1
  OR NEW.projection_revision <> OLD.projection_revision + 1
  OR NEW.graph_id <> OLD.graph_id
BEGIN SELECT RAISE(ABORT, 'task graph projection must advance causally'); END;

CREATE TRIGGER task_graph_revision_projection_immutable_delete BEFORE DELETE ON task_graph_revision_projection
BEGIN SELECT RAISE(ABORT, 'task graph revision projections cannot be deleted'); END;

CREATE TABLE task_lifecycle_projection (
    run_id TEXT NOT NULL REFERENCES run_projection(run_id),
    task_id TEXT NOT NULL,
    graph_revision INTEGER NOT NULL,
    phase TEXT NOT NULL,
    child_run_id TEXT,
    attempt_ordinal INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    block_reason_json TEXT CHECK (block_reason_json IS NULL OR json_valid(block_reason_json)),
    completion_contract TEXT NOT NULL DEFAULT 'pending',
    integration TEXT NOT NULL DEFAULT 'pending',
    combined_verification TEXT NOT NULL DEFAULT 'pending',
    revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, task_id),
    UNIQUE (child_run_id),
    CHECK (graph_revision >= 1), CHECK (attempt_ordinal >= 0), CHECK (retry_count >= 0),
    CHECK (revision >= 1),
    CHECK (phase IN ('not_started','dispatching','active','retrying','cancelling',
      'recovery_required','succeeded','failed','cancelled','blocked')),
    CHECK (completion_contract IN ('pending','passed','failed')),
    CHECK (integration IN ('pending','passed','reconciliation_required')),
    CHECK (combined_verification IN ('pending','passed','failed')),
    CHECK (phase NOT IN ('dispatching','active','retrying','cancelling','recovery_required',
      'succeeded','failed') OR child_run_id IS NOT NULL),
    CHECK (phase NOT IN ('not_started','blocked') OR child_run_id IS NULL),
    CHECK ((phase = 'blocked') = (block_reason_json IS NOT NULL))
) STRICT;
CREATE INDEX task_lifecycle_active ON task_lifecycle_projection(run_id, phase, task_id);
CREATE TRIGGER task_lifecycle_first_revision BEFORE INSERT ON task_lifecycle_projection
WHEN NEW.revision <> 1 BEGIN SELECT RAISE(ABORT, 'first task lifecycle revision must be 1'); END;
CREATE TRIGGER task_lifecycle_causal_update BEFORE UPDATE ON task_lifecycle_projection
WHEN NEW.revision <> OLD.revision + 1 OR NEW.run_id <> OLD.run_id
  OR NEW.task_id <> OLD.task_id OR NEW.graph_revision < OLD.graph_revision
BEGIN SELECT RAISE(ABORT, 'task lifecycle projection must advance causally'); END;
CREATE TRIGGER task_lifecycle_terminal BEFORE UPDATE ON task_lifecycle_projection
WHEN OLD.phase IN ('succeeded','failed','cancelled','blocked') AND NEW.phase <> OLD.phase
BEGIN SELECT RAISE(ABORT, 'terminal task lifecycle cannot transition'); END;

CREATE TABLE task_wave_plan (
    run_id TEXT NOT NULL REFERENCES run_projection(run_id), graph_revision INTEGER NOT NULL,
    wave_ordinal INTEGER NOT NULL, plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
    planned_at TEXT NOT NULL, PRIMARY KEY (run_id, graph_revision, wave_ordinal),
    CHECK (graph_revision >= 1), CHECK (wave_ordinal >= 1)
) STRICT;
CREATE TRIGGER task_wave_plan_immutable_update BEFORE UPDATE ON task_wave_plan
BEGIN SELECT RAISE(ABORT, 'task wave plans are immutable'); END;
CREATE TRIGGER task_wave_plan_immutable_delete BEFORE DELETE ON task_wave_plan
BEGIN SELECT RAISE(ABORT, 'task wave plans are immutable'); END;

CREATE TABLE task_dispatch_record (
    dispatch_id TEXT NOT NULL PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run_projection(run_id),
    task_id TEXT NOT NULL, graph_revision INTEGER NOT NULL, wave_ordinal INTEGER NOT NULL,
    child_run_id TEXT NOT NULL UNIQUE, dispatch_json TEXT NOT NULL CHECK (json_valid(dispatch_json)),
    recorded_at TEXT NOT NULL, UNIQUE (run_id, task_id, graph_revision),
    FOREIGN KEY (run_id, task_id) REFERENCES task_lifecycle_projection(run_id, task_id)
) STRICT;
CREATE TRIGGER task_dispatch_immutable_update BEFORE UPDATE ON task_dispatch_record
BEGIN SELECT RAISE(ABORT, 'task dispatch records are immutable'); END;
CREATE TRIGGER task_dispatch_immutable_delete BEFORE DELETE ON task_dispatch_record
BEGIN SELECT RAISE(ABORT, 'task dispatch records are immutable'); END;

CREATE TABLE task_capacity_lease (
    lease_id TEXT NOT NULL PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
    scope TEXT NOT NULL, resource_id TEXT NOT NULL, fencing_revision INTEGER NOT NULL,
    state TEXT NOT NULL, acquired_at TEXT NOT NULL, released_at TEXT,
    UNIQUE (run_id, task_id, scope, resource_id),
    FOREIGN KEY (run_id, task_id) REFERENCES task_lifecycle_projection(run_id, task_id),
    CHECK (scope IN ('global','account','workspace','repository')),
    CHECK (fencing_revision >= 1), CHECK (state IN ('active','released')),
    CHECK ((state = 'released') = (released_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX task_capacity_exclusive_active ON task_capacity_lease(scope, resource_id)
WHERE state = 'active' AND scope IN ('workspace','repository');
CREATE INDEX task_capacity_counted_active ON task_capacity_lease(scope, resource_id, state);
CREATE TRIGGER task_capacity_identity_immutable BEFORE UPDATE ON task_capacity_lease
WHEN NEW.lease_id <> OLD.lease_id OR NEW.run_id <> OLD.run_id OR NEW.task_id <> OLD.task_id
  OR NEW.scope <> OLD.scope OR NEW.resource_id <> OLD.resource_id OR NEW.acquired_at <> OLD.acquired_at
BEGIN SELECT RAISE(ABORT, 'task capacity lease identity is immutable'); END;
CREATE TRIGGER task_capacity_release_final BEFORE UPDATE ON task_capacity_lease
WHEN OLD.state = 'released' AND NEW.state <> OLD.state
BEGIN SELECT RAISE(ABORT, 'released task capacity cannot reactivate'); END;

CREATE TABLE task_wave_audit_event (
    event_id TEXT NOT NULL PRIMARY KEY, run_id TEXT NOT NULL REFERENCES run_projection(run_id),
    task_id TEXT, kind TEXT NOT NULL, event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    recorded_at TEXT NOT NULL,
    CHECK (kind IN ('wave_planned','capacity_acquired','task_dispatched','task_retrying',
      'cancellation_requested','task_settled','task_blocked','capacity_released','recovery_required'))
) STRICT;
CREATE INDEX task_wave_audit_run ON task_wave_audit_event(run_id, recorded_at, event_id);
CREATE TRIGGER task_wave_audit_immutable_update BEFORE UPDATE ON task_wave_audit_event
BEGIN SELECT RAISE(ABORT, 'task wave audit events are immutable'); END;
CREATE TRIGGER task_wave_audit_immutable_delete BEFORE DELETE ON task_wave_audit_event
BEGIN SELECT RAISE(ABORT, 'task wave audit events are immutable'); END;

CREATE TABLE epic_repository_branch (
    run_id TEXT NOT NULL REFERENCES run_projection(run_id), repository_id TEXT NOT NULL,
    branch_ref TEXT NOT NULL, remote TEXT NOT NULL, remote_base_ref TEXT NOT NULL,
    remote_base_sha TEXT NOT NULL, expected_local_sha TEXT NOT NULL, observed_remote_sha TEXT,
    lifecycle TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, repository_id), CHECK (lifecycle IN ('ready','reconciliation_required')),
    CHECK (revision >= 1)
) STRICT;
CREATE TRIGGER epic_repository_branch_causal_update BEFORE UPDATE ON epic_repository_branch
WHEN NEW.revision <> OLD.revision + 1 OR NEW.run_id <> OLD.run_id
  OR NEW.repository_id <> OLD.repository_id OR NEW.branch_ref <> OLD.branch_ref
  OR NEW.remote <> OLD.remote OR NEW.remote_base_ref <> OLD.remote_base_ref
  OR NEW.remote_base_sha <> OLD.remote_base_sha OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'epic repository branch must advance causally'); END;
CREATE TRIGGER epic_repository_branch_reconciliation_final BEFORE UPDATE ON epic_repository_branch
WHEN OLD.lifecycle = 'reconciliation_required' AND NEW.lifecycle <> OLD.lifecycle
BEGIN SELECT RAISE(ABORT, 'reconciled epic repository branch requires an explicit replacement'); END;

CREATE TABLE task_integration_ledger (
    integration_id TEXT NOT NULL PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
    graph_revision INTEGER NOT NULL, wave_ordinal INTEGER NOT NULL, integration_ordinal INTEGER NOT NULL,
    variant_id TEXT NOT NULL, lifecycle TEXT NOT NULL,
    entry_json TEXT NOT NULL CHECK (json_valid(entry_json)), revision INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (run_id, graph_revision, task_id),
    UNIQUE (run_id, integration_ordinal),
    FOREIGN KEY (run_id, task_id) REFERENCES task_lifecycle_projection(run_id, task_id),
    CHECK (graph_revision >= 1 AND wave_ordinal >= 1 AND integration_ordinal >= 1),
    CHECK (revision >= 1),
    CHECK (lifecycle IN ('queued','prepared','verified','integrated','failed','reconciliation_required'))
) STRICT;
CREATE INDEX task_integration_next ON task_integration_ledger(run_id, integration_ordinal, lifecycle);
CREATE TRIGGER task_integration_ledger_causal_update BEFORE UPDATE ON task_integration_ledger
WHEN NEW.revision <> OLD.revision + 1 OR NEW.integration_id <> OLD.integration_id
  OR NEW.run_id <> OLD.run_id OR NEW.task_id <> OLD.task_id
  OR NEW.graph_revision <> OLD.graph_revision OR NEW.wave_ordinal <> OLD.wave_ordinal
  OR NEW.integration_ordinal <> OLD.integration_ordinal OR NEW.variant_id <> OLD.variant_id
  OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'task integration ledger must advance causally'); END;
CREATE TRIGGER task_integration_terminal BEFORE UPDATE ON task_integration_ledger
WHEN OLD.lifecycle IN ('integrated','failed','reconciliation_required')
BEGIN SELECT RAISE(ABORT, 'terminal task integration cannot transition'); END;

CREATE TABLE task_integration_trace (
    trace_id TEXT NOT NULL PRIMARY KEY, integration_id TEXT NOT NULL REFERENCES task_integration_ledger(integration_id),
    run_id TEXT NOT NULL, task_id TEXT NOT NULL, sequence INTEGER NOT NULL, phase TEXT NOT NULL,
    trace_json TEXT NOT NULL CHECK (json_valid(trace_json)), recorded_at TEXT NOT NULL,
    UNIQUE (integration_id, sequence),
    FOREIGN KEY (run_id, task_id) REFERENCES task_lifecycle_projection(run_id, task_id),
    CHECK (sequence >= 1)
) STRICT;
CREATE INDEX task_integration_trace_run ON task_integration_trace(run_id, integration_id, sequence);
CREATE TRIGGER task_integration_trace_immutable_update BEFORE UPDATE ON task_integration_trace
BEGIN SELECT RAISE(ABORT, 'task integration traces are immutable'); END;
CREATE TRIGGER task_integration_trace_immutable_delete BEFORE DELETE ON task_integration_trace
BEGIN SELECT RAISE(ABORT, 'task integration traces are immutable'); END;

PRAGMA user_version = 24;
