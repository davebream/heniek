/**
 * Migration 14 — durable fixed-stage operation ledger (Q027, ADR 0025).
 *
 * Broadens migration 13's attempt `stage_type` / `recovery` CHECKs for all six
 * fixed stage types, adds optional `operation_id`, and introduces immutable
 * operation requests, revisioned operation state, approval answers, and
 * append-only external-observation / reconciliation traces. Q026 attempt rows
 * are preserved via table rebuild + data copy (SQLite cannot ALTER CHECK).
 */

import type { Migration } from "./migration.js";

export const MIGRATION_0014_PIPELINE_RUNNER_OPERATIONS: Migration = {
  version: 14,
  name: "pipeline-runner-operations",
  statements: [
    // Rebuild attempt + phase_transition so stage_type/recovery CHECKs widen
    // and operation_id appears. Child table must move with the parent because
    // foreign_keys stay ON inside the migration transaction.
    `CREATE TABLE pipeline_runner_attempt_new (
      attempt_id             TEXT    NOT NULL PRIMARY KEY
        REFERENCES pipeline_stage_attempt(attempt_id),
      run_id                 TEXT    NOT NULL,
      stage_id               TEXT    NOT NULL,
      stage_type             TEXT    NOT NULL,
      intent_id              TEXT    NOT NULL UNIQUE
        REFERENCES pipeline_scheduler_intent(intent_id),
      graph_revision         INTEGER NOT NULL,
      generation             INTEGER NOT NULL,
      attempt_ordinal        INTEGER NOT NULL,
      phase                  TEXT    NOT NULL,
      workspace_id           TEXT             REFERENCES workspace(workspace_id),
      lease_id               TEXT,
      checkout_path          TEXT,
      process_group_id       INTEGER,
      backend_execution_id   TEXT,
      operation_id           TEXT,
      deadline_at            TEXT,
      runtime_directory      TEXT,
      prepared_at            TEXT,
      started_at             TEXT,
      finished_at            TEXT,
      outputs_json           TEXT    NOT NULL CHECK (json_valid(outputs_json)),
      evidence_json          TEXT    NOT NULL CHECK (json_valid(evidence_json)),
      result_json            TEXT             CHECK (result_json IS NULL OR json_valid(result_json)),
      failure_json           TEXT             CHECK (failure_json IS NULL OR json_valid(failure_json)),
      cleanup_json           TEXT             CHECK (cleanup_json IS NULL OR json_valid(cleanup_json)),
      validation_json        TEXT             CHECK (validation_json IS NULL OR json_valid(validation_json)),
      recovery               TEXT    NOT NULL,
      revision               INTEGER NOT NULL,
      updated_at             TEXT    NOT NULL,
      created_at             TEXT    NOT NULL,
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
    ) STRICT`,
    `INSERT INTO pipeline_runner_attempt_new (
       attempt_id, run_id, stage_id, stage_type, intent_id, graph_revision,
       generation, attempt_ordinal, phase, workspace_id, lease_id, checkout_path,
       process_group_id, backend_execution_id, operation_id, deadline_at,
       runtime_directory, prepared_at, started_at, finished_at, outputs_json,
       evidence_json, result_json, failure_json, cleanup_json, validation_json,
       recovery, revision, updated_at, created_at
     )
     SELECT
       attempt_id, run_id, stage_id, stage_type, intent_id, graph_revision,
       generation, attempt_ordinal, phase, workspace_id, lease_id, checkout_path,
       process_group_id, backend_execution_id, NULL, deadline_at,
       runtime_directory, prepared_at, started_at, finished_at, outputs_json,
       evidence_json, result_json, failure_json, cleanup_json, validation_json,
       recovery, revision, updated_at, created_at
     FROM pipeline_runner_attempt`,
    `CREATE TABLE pipeline_runner_phase_transition_new (
      transition_id   TEXT    NOT NULL PRIMARY KEY,
      attempt_id      TEXT    NOT NULL REFERENCES pipeline_runner_attempt_new(attempt_id),
      from_phase      TEXT,
      to_phase        TEXT    NOT NULL,
      recorded_at     TEXT    NOT NULL,
      detail          TEXT,
      CHECK (from_phase IS NULL OR from_phase IN (
        'prepare','start','observe','cancel','collect','validate','finalize',
        'succeeded','failed','cancelled','recovery_required'
      )),
      CHECK (to_phase IN (
        'prepare','start','observe','cancel','collect','validate','finalize',
        'succeeded','failed','cancelled','recovery_required'
      ))
    ) STRICT`,
    `INSERT INTO pipeline_runner_phase_transition_new
       (transition_id, attempt_id, from_phase, to_phase, recorded_at, detail)
     SELECT transition_id, attempt_id, from_phase, to_phase, recorded_at, detail
       FROM pipeline_runner_phase_transition`,
    "DROP TABLE pipeline_runner_phase_transition",
    "DROP TABLE pipeline_runner_attempt",
    "ALTER TABLE pipeline_runner_attempt_new RENAME TO pipeline_runner_attempt",
    "ALTER TABLE pipeline_runner_phase_transition_new RENAME TO pipeline_runner_phase_transition",
    `CREATE INDEX pipeline_runner_attempt_run
      ON pipeline_runner_attempt(run_id, stage_id, attempt_id)`,
    `CREATE INDEX pipeline_runner_attempt_open
      ON pipeline_runner_attempt(phase, updated_at, attempt_id)
      WHERE phase NOT IN ('succeeded','failed','cancelled')`,
    `CREATE TRIGGER pipeline_runner_attempt_first_revision
      BEFORE INSERT ON pipeline_runner_attempt
      WHEN NEW.revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first pipeline runner attempt revision must be 1'); END`,
    `CREATE TRIGGER pipeline_runner_attempt_revision_advances
      BEFORE UPDATE ON pipeline_runner_attempt
      WHEN NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'pipeline runner attempt update must advance revision by 1'); END`,
    `CREATE TRIGGER pipeline_runner_attempt_identity_immutable
      BEFORE UPDATE ON pipeline_runner_attempt
      WHEN NEW.run_id <> OLD.run_id OR NEW.stage_id <> OLD.stage_id
        OR NEW.stage_type <> OLD.stage_type OR NEW.intent_id <> OLD.intent_id
        OR NEW.graph_revision <> OLD.graph_revision
        OR NEW.generation <> OLD.generation
        OR NEW.attempt_ordinal <> OLD.attempt_ordinal
        OR NEW.created_at <> OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'pipeline runner attempt identity is immutable'); END`,
    `CREATE INDEX pipeline_runner_phase_transition_attempt
      ON pipeline_runner_phase_transition(attempt_id, recorded_at, transition_id)`,
    `CREATE TRIGGER pipeline_runner_phase_transition_immutable_update
      BEFORE UPDATE ON pipeline_runner_phase_transition
      BEGIN SELECT RAISE(ABORT, 'pipeline runner phase transitions are immutable'); END`,
    `CREATE TRIGGER pipeline_runner_phase_transition_immutable_delete
      BEFORE DELETE ON pipeline_runner_phase_transition
      BEGIN SELECT RAISE(ABORT, 'pipeline runner phase transitions are immutable'); END`,

    `CREATE TABLE pipeline_runner_operation_request (
      operation_id   TEXT    NOT NULL PRIMARY KEY,
      attempt_id     TEXT    NOT NULL UNIQUE
        REFERENCES pipeline_runner_attempt(attempt_id),
      stage_type     TEXT    NOT NULL,
      request_json   TEXT    NOT NULL CHECK (json_valid(request_json)),
      created_at     TEXT    NOT NULL,
      CHECK (stage_type IN ('approval','integration','verify','publish'))
    ) STRICT`,
    `CREATE TRIGGER pipeline_runner_operation_request_immutable_update
      BEFORE UPDATE ON pipeline_runner_operation_request
      BEGIN SELECT RAISE(ABORT, 'pipeline runner operation requests are immutable'); END`,
    `CREATE TRIGGER pipeline_runner_operation_request_immutable_delete
      BEFORE DELETE ON pipeline_runner_operation_request
      BEGIN SELECT RAISE(ABORT, 'pipeline runner operation requests are immutable'); END`,

    `CREATE TABLE pipeline_runner_operation_state (
      operation_id   TEXT    NOT NULL PRIMARY KEY
        REFERENCES pipeline_runner_operation_request(operation_id),
      attempt_id     TEXT    NOT NULL,
      phase          TEXT    NOT NULL,
      result_json    TEXT             CHECK (result_json IS NULL OR json_valid(result_json)),
      failure_json   TEXT             CHECK (failure_json IS NULL OR json_valid(failure_json)),
      revision       INTEGER NOT NULL,
      updated_at     TEXT    NOT NULL,
      CHECK (phase IN (
        'pending','waiting','executing','completed','failed',
        'cancelled','reconciliation_required'
      )),
      CHECK (revision >= 1)
    ) STRICT`,
    `CREATE TRIGGER pipeline_runner_operation_state_first_revision
      BEFORE INSERT ON pipeline_runner_operation_state
      WHEN NEW.revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first pipeline runner operation state revision must be 1'); END`,
    `CREATE TRIGGER pipeline_runner_operation_state_revision_advances
      BEFORE UPDATE ON pipeline_runner_operation_state
      WHEN NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'pipeline runner operation state update must advance revision by 1'); END`,

    `CREATE TABLE pipeline_runner_approval_answer (
      answer_id              TEXT    NOT NULL PRIMARY KEY,
      operation_id           TEXT    NOT NULL UNIQUE
        REFERENCES pipeline_runner_operation_request(operation_id),
      attempt_id             TEXT    NOT NULL,
      interaction_id         TEXT    NOT NULL,
      expected_revision      INTEGER NOT NULL,
      decision               TEXT    NOT NULL,
      selected_label         TEXT    NOT NULL,
      answered_by_key_id     TEXT    NOT NULL,
      answered_at            TEXT    NOT NULL,
      decision_json          TEXT    NOT NULL CHECK (json_valid(decision_json)),
      CHECK (decision IN ('approve','reject')),
      CHECK (expected_revision >= 1)
    ) STRICT`,
    `CREATE TRIGGER pipeline_runner_approval_answer_immutable_update
      BEFORE UPDATE ON pipeline_runner_approval_answer
      BEGIN SELECT RAISE(ABORT, 'pipeline runner approval answers are immutable'); END`,
    `CREATE TRIGGER pipeline_runner_approval_answer_immutable_delete
      BEFORE DELETE ON pipeline_runner_approval_answer
      BEGIN SELECT RAISE(ABORT, 'pipeline runner approval answers are immutable'); END`,

    `CREATE TABLE pipeline_runner_external_observation (
      observation_id   TEXT    NOT NULL PRIMARY KEY,
      attempt_id       TEXT    NOT NULL
        REFERENCES pipeline_runner_attempt(attempt_id),
      operation_id     TEXT,
      kind             TEXT    NOT NULL,
      recorded_at      TEXT    NOT NULL,
      payload_json     TEXT    NOT NULL CHECK (json_valid(payload_json))
    ) STRICT`,
    `CREATE INDEX pipeline_runner_external_observation_attempt
      ON pipeline_runner_external_observation(attempt_id, recorded_at, observation_id)`,
    `CREATE TRIGGER pipeline_runner_external_observation_immutable_update
      BEFORE UPDATE ON pipeline_runner_external_observation
      BEGIN SELECT RAISE(ABORT, 'pipeline runner external observations are immutable'); END`,
    `CREATE TRIGGER pipeline_runner_external_observation_immutable_delete
      BEFORE DELETE ON pipeline_runner_external_observation
      BEGIN SELECT RAISE(ABORT, 'pipeline runner external observations are immutable'); END`,

    `CREATE TABLE pipeline_runner_reconciliation_trace (
      trace_id         TEXT    NOT NULL PRIMARY KEY,
      attempt_id       TEXT    NOT NULL
        REFERENCES pipeline_runner_attempt(attempt_id),
      operation_id     TEXT,
      stage_type       TEXT    NOT NULL,
      classification   TEXT    NOT NULL,
      recorded_at      TEXT    NOT NULL,
      detail           TEXT,
      payload_json     TEXT             CHECK (payload_json IS NULL OR json_valid(payload_json)),
      CHECK (stage_type IN ('integration','publish'))
    ) STRICT`,
    `CREATE INDEX pipeline_runner_reconciliation_trace_attempt
      ON pipeline_runner_reconciliation_trace(attempt_id, recorded_at, trace_id)`,
    `CREATE TRIGGER pipeline_runner_reconciliation_trace_immutable_update
      BEFORE UPDATE ON pipeline_runner_reconciliation_trace
      BEGIN SELECT RAISE(ABORT, 'pipeline runner reconciliation traces are immutable'); END`,
    `CREATE TRIGGER pipeline_runner_reconciliation_trace_immutable_delete
      BEFORE DELETE ON pipeline_runner_reconciliation_trace
      BEGIN SELECT RAISE(ABORT, 'pipeline runner reconciliation traces are immutable'); END`,

    // Pending approval operations awaiting an answer (inbox drain).
    `CREATE INDEX pipeline_runner_approval_inbox
      ON pipeline_runner_operation_state(phase, updated_at, operation_id)
      WHERE phase = 'waiting'`,
  ],
};
Object.freeze(MIGRATION_0014_PIPELINE_RUNNER_OPERATIONS.statements);
Object.freeze(MIGRATION_0014_PIPELINE_RUNNER_OPERATIONS);
