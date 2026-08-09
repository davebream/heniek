/**
 * Migration 13 — durable pipeline stage runners (Q026, ADR 0024).
 *
 * Extends migration 12's scheduler outbox with per-attempt runner state:
 * lifecycle phase, workspace/lease identity, process or backend handles,
 * collected outputs, evidence, terminal failures, and recovery classification.
 * Intent delivery marking stays on `pipeline_scheduler_intent`; this table is
 * the runner's own durable attempt ledger.
 */

import type { Migration } from "./migration.js";

export const MIGRATION_0013_PIPELINE_RUNNER: Migration = {
  version: 13,
  name: "pipeline-runner",
  statements: [
    `CREATE TABLE pipeline_runner_attempt (
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
      CHECK (stage_type IN ('agent','command')),
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
        'none','observe_backend','reap_process','reconcile_artifacts','manual'
      )),
      CHECK ((phase IN ('succeeded','failed','cancelled','recovery_required')) =
        (finished_at IS NOT NULL))
    ) STRICT`,
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

    `CREATE TABLE pipeline_runner_phase_transition (
      transition_id   TEXT    NOT NULL PRIMARY KEY,
      attempt_id      TEXT    NOT NULL REFERENCES pipeline_runner_attempt(attempt_id),
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
    `CREATE INDEX pipeline_runner_phase_transition_attempt
      ON pipeline_runner_phase_transition(attempt_id, recorded_at, transition_id)`,
    `CREATE TRIGGER pipeline_runner_phase_transition_immutable_update
      BEFORE UPDATE ON pipeline_runner_phase_transition
      BEGIN SELECT RAISE(ABORT, 'pipeline runner phase transitions are immutable'); END`,
    `CREATE TRIGGER pipeline_runner_phase_transition_immutable_delete
      BEFORE DELETE ON pipeline_runner_phase_transition
      BEGIN SELECT RAISE(ABORT, 'pipeline runner phase transitions are immutable'); END`,
  ],
};
Object.freeze(MIGRATION_0013_PIPELINE_RUNNER.statements);
Object.freeze(MIGRATION_0013_PIPELINE_RUNNER);
