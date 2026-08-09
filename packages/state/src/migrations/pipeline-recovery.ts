/**
 * Migration 15 — durable recovery decisions and canonical run state (Q028).
 *
 * Append-only recovery decisions and retry directives, mutable per-stage
 * recovery counters, and a revisioned canonical-run-state projection.
 * Widens migration 12's observation `kind` CHECK for recovery HITL kinds
 * (SQLite cannot ALTER CHECK — rebuild + data copy). Intent kinds stay
 * `dispatch|cancel|evaluator`; recovery retries reuse `dispatch` with a
 * directive on the attempt (tickSchedulerV2). Intent table is not rebuilt
 * because `pipeline_runner_attempt.intent_id` references it.
 */

import type { Migration } from "./migration.js";

export const MIGRATION_0015_PIPELINE_RECOVERY: Migration = {
  version: 15,
  name: "pipeline-recovery",
  statements: [
    `CREATE TABLE pipeline_scheduler_observation_new (
      observation_id   TEXT    NOT NULL PRIMARY KEY,
      run_id           TEXT    NOT NULL,
      kind             TEXT    NOT NULL,
      payload_json     TEXT    NOT NULL CHECK (json_valid(payload_json)),
      recorded_at      TEXT    NOT NULL,
      consumed_at      TEXT,
      CHECK (kind IN (
        'attempt_started','attempt_waiting','attempt_succeeded','attempt_failed',
        'cancellation_settled','evaluator_decided','cancel_requested','manual_rerun',
        'recovery_proposed','recovery_approved','recovery_rejected'
      ))
    ) STRICT`,
    `INSERT INTO pipeline_scheduler_observation_new
       (observation_id, run_id, kind, payload_json, recorded_at, consumed_at)
     SELECT observation_id, run_id, kind, payload_json, recorded_at, consumed_at
       FROM pipeline_scheduler_observation`,
    "DROP TABLE pipeline_scheduler_observation",
    "ALTER TABLE pipeline_scheduler_observation_new RENAME TO pipeline_scheduler_observation",
    `CREATE INDEX pipeline_scheduler_observation_pending
      ON pipeline_scheduler_observation(run_id, consumed_at, recorded_at, observation_id)`,

    `CREATE TABLE pipeline_recovery_decision (
      decision_id        TEXT    NOT NULL PRIMARY KEY,
      run_id             TEXT    NOT NULL,
      stage_id           TEXT    NOT NULL,
      graph_revision     INTEGER NOT NULL,
      generation         INTEGER NOT NULL,
      attempt_ordinal    INTEGER NOT NULL,
      action             TEXT    NOT NULL,
      outcome            TEXT    NOT NULL,
      decision_json      TEXT    NOT NULL CHECK (json_valid(decision_json)),
      recorded_at        TEXT    NOT NULL,
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
    ) STRICT`,
    `CREATE INDEX pipeline_recovery_decision_run
      ON pipeline_recovery_decision(run_id, recorded_at, decision_id)`,
    `CREATE TRIGGER pipeline_recovery_decision_immutable_update
      BEFORE UPDATE ON pipeline_recovery_decision
      BEGIN SELECT RAISE(ABORT, 'pipeline recovery decisions are immutable'); END`,
    `CREATE TRIGGER pipeline_recovery_decision_immutable_delete
      BEFORE DELETE ON pipeline_recovery_decision
      BEGIN SELECT RAISE(ABORT, 'pipeline recovery decisions are immutable'); END`,

    `CREATE TABLE pipeline_stage_recovery_state (
      run_id                       TEXT    NOT NULL,
      stage_id                     TEXT    NOT NULL,
      generation                   INTEGER NOT NULL,
      repairs_used                 INTEGER NOT NULL,
      last_signature_digest        TEXT,
      identical_signature_count    INTEGER NOT NULL,
      pending_proposal_id          TEXT,
      pending_proposal_json        TEXT
        CHECK (pending_proposal_json IS NULL OR json_valid(pending_proposal_json)),
      updated_at                   TEXT    NOT NULL,
      PRIMARY KEY (run_id, stage_id, generation),
      CHECK (generation >= 1),
      CHECK (repairs_used >= 0),
      CHECK (identical_signature_count >= 0),
      CHECK (last_signature_digest IS NULL OR (
        length(last_signature_digest) = 64
        AND last_signature_digest NOT GLOB '*[^0-9a-f]*'
      ))
    ) STRICT`,

    `CREATE TABLE pipeline_canonical_run_state (
      run_id       TEXT    NOT NULL PRIMARY KEY,
      state_json   TEXT    NOT NULL CHECK (json_valid(state_json)),
      revision     INTEGER NOT NULL,
      updated_at   TEXT    NOT NULL,
      CHECK (revision >= 1)
    ) STRICT`,
    `CREATE TRIGGER pipeline_canonical_run_state_first_revision
      BEFORE INSERT ON pipeline_canonical_run_state
      WHEN NEW.revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first pipeline canonical run state revision must be 1'); END`,
    `CREATE TRIGGER pipeline_canonical_run_state_revision_advances
      BEFORE UPDATE ON pipeline_canonical_run_state
      WHEN NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'pipeline canonical run state update must advance revision by 1'); END`,

    `CREATE TABLE pipeline_retry_directive (
      attempt_id              TEXT    NOT NULL PRIMARY KEY
        REFERENCES pipeline_stage_attempt(attempt_id),
      recovery_decision_id    TEXT    NOT NULL
        REFERENCES pipeline_recovery_decision(decision_id),
      directive_json          TEXT    NOT NULL CHECK (json_valid(directive_json)),
      created_at              TEXT    NOT NULL
    ) STRICT`,
    `CREATE TRIGGER pipeline_retry_directive_immutable_update
      BEFORE UPDATE ON pipeline_retry_directive
      BEGIN SELECT RAISE(ABORT, 'pipeline retry directives are immutable'); END`,
    `CREATE TRIGGER pipeline_retry_directive_immutable_delete
      BEFORE DELETE ON pipeline_retry_directive
      BEGIN SELECT RAISE(ABORT, 'pipeline retry directives are immutable'); END`,
  ],
};
Object.freeze(MIGRATION_0015_PIPELINE_RECOVERY.statements);
Object.freeze(MIGRATION_0015_PIPELINE_RECOVERY);
