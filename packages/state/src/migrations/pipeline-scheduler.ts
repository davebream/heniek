/**
 * Migration 12 — durable pipeline graph scheduling (Q025, ADR 0023).
 *
 * Separate from the account/capacity scheduler (migration 10) and the native
 * bridge (migration 11): those admit one backend attempt, this one orchestrates
 * a whole `PipelineGraph/v1`. Nothing existing is widened; runners are not
 * invoked here — only immutable revisions, attempts, decisions, mutable stage
 * projections, and uniquely keyed outbox intents are stored so Q026 can drain
 * them later.
 */

import type { Migration } from "./migration.js";

export const MIGRATION_0012_PIPELINE_SCHEDULER: Migration = {
  version: 12,
  name: "pipeline-scheduler",
  statements: [
    `CREATE TABLE pipeline_graph_revision (
      run_id          TEXT    NOT NULL,
      graph_revision  INTEGER NOT NULL,
      pipeline_id     TEXT    NOT NULL,
      graph_json      TEXT    NOT NULL CHECK (json_valid(graph_json)),
      created_at      TEXT    NOT NULL,
      PRIMARY KEY (run_id, graph_revision),
      CHECK (graph_revision >= 1)
    ) STRICT`,
    `CREATE TRIGGER pipeline_graph_revision_immutable_update
      BEFORE UPDATE ON pipeline_graph_revision
      BEGIN SELECT RAISE(ABORT, 'pipeline graph revisions are immutable'); END`,
    `CREATE TRIGGER pipeline_graph_revision_immutable_delete
      BEFORE DELETE ON pipeline_graph_revision
      BEGIN SELECT RAISE(ABORT, 'pipeline graph revisions are immutable'); END`,

    `CREATE TABLE pipeline_schedule (
      run_id              TEXT    NOT NULL PRIMARY KEY,
      pipeline_id         TEXT    NOT NULL,
      graph_revision      INTEGER NOT NULL,
      schedule_revision   INTEGER NOT NULL,
      deadline_at         TEXT,
      terminal_outcome    TEXT,
      terminal_reason     TEXT,
      terminal_stage_id   TEXT,
      updated_at          TEXT    NOT NULL,
      CHECK (graph_revision >= 1),
      CHECK (schedule_revision >= 1),
      CHECK (terminal_outcome IS NULL OR terminal_outcome IN
        ('succeeded','failed','cancelled','blocked')),
      FOREIGN KEY (run_id, graph_revision)
        REFERENCES pipeline_graph_revision(run_id, graph_revision)
    ) STRICT`,
    `CREATE TRIGGER pipeline_schedule_first_revision BEFORE INSERT ON pipeline_schedule
      WHEN NEW.schedule_revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first pipeline schedule revision must be 1'); END`,
    `CREATE TRIGGER pipeline_schedule_revision_advances BEFORE UPDATE ON pipeline_schedule
      WHEN NEW.schedule_revision < OLD.schedule_revision
      BEGIN SELECT RAISE(ABORT, 'a pipeline schedule revision must never move backwards'); END`,

    `CREATE TABLE pipeline_stage_attempt (
      attempt_id       TEXT    NOT NULL PRIMARY KEY,
      run_id           TEXT    NOT NULL,
      pipeline_id      TEXT    NOT NULL,
      stage_id         TEXT    NOT NULL,
      graph_revision   INTEGER NOT NULL,
      generation       INTEGER NOT NULL,
      attempt_ordinal  INTEGER NOT NULL,
      stage_type       TEXT    NOT NULL,
      created_at       TEXT    NOT NULL,
      UNIQUE (run_id, graph_revision, stage_id, generation, attempt_ordinal),
      CHECK (graph_revision >= 1),
      CHECK (generation >= 1),
      CHECK (attempt_ordinal >= 1),
      CHECK (stage_type IN ('agent','command','approval','integration','verify','publish')),
      FOREIGN KEY (run_id, graph_revision)
        REFERENCES pipeline_graph_revision(run_id, graph_revision)
    ) STRICT`,
    `CREATE TRIGGER pipeline_stage_attempt_immutable_update
      BEFORE UPDATE ON pipeline_stage_attempt
      BEGIN SELECT RAISE(ABORT, 'pipeline stage attempts are immutable'); END`,
    `CREATE TRIGGER pipeline_stage_attempt_immutable_delete
      BEFORE DELETE ON pipeline_stage_attempt
      BEGIN SELECT RAISE(ABORT, 'pipeline stage attempts are immutable'); END`,

    `CREATE TABLE pipeline_stage_projection (
      run_id                   TEXT    NOT NULL,
      stage_id                 TEXT    NOT NULL,
      graph_revision           INTEGER NOT NULL,
      generation               INTEGER NOT NULL,
      state                    TEXT    NOT NULL,
      attempt_ordinal          INTEGER NOT NULL,
      current_attempt_id       TEXT             REFERENCES pipeline_stage_attempt(attempt_id),
      last_transition_reason   TEXT,
      block_reason             TEXT,
      selected                 INTEGER NOT NULL,
      updated_at               TEXT    NOT NULL,
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
        REFERENCES pipeline_graph_revision(run_id, graph_revision)
    ) STRICT`,

    `CREATE TABLE pipeline_scheduler_decision (
      decision_id      TEXT    NOT NULL PRIMARY KEY,
      run_id           TEXT    NOT NULL,
      stage_id         TEXT,
      graph_revision   INTEGER NOT NULL,
      generation       INTEGER NOT NULL,
      attempt_ordinal  INTEGER NOT NULL,
      action           TEXT    NOT NULL,
      reason           TEXT    NOT NULL,
      from_state       TEXT,
      to_state         TEXT,
      attempt_id       TEXT,
      intent_id        TEXT,
      detail           TEXT,
      recorded_at      TEXT    NOT NULL,
      CHECK (graph_revision >= 1),
      CHECK (generation >= 1),
      CHECK (attempt_ordinal >= 0),
      FOREIGN KEY (run_id, graph_revision)
        REFERENCES pipeline_graph_revision(run_id, graph_revision)
    ) STRICT`,
    `CREATE INDEX pipeline_scheduler_decision_run
      ON pipeline_scheduler_decision(run_id, recorded_at, decision_id)`,
    `CREATE TRIGGER pipeline_scheduler_decision_immutable_update
      BEFORE UPDATE ON pipeline_scheduler_decision
      BEGIN SELECT RAISE(ABORT, 'pipeline scheduler decisions are immutable'); END`,
    `CREATE TRIGGER pipeline_scheduler_decision_immutable_delete
      BEFORE DELETE ON pipeline_scheduler_decision
      BEGIN SELECT RAISE(ABORT, 'pipeline scheduler decisions are immutable'); END`,

    `CREATE TABLE pipeline_scheduler_intent (
      intent_id        TEXT    NOT NULL PRIMARY KEY,
      run_id           TEXT    NOT NULL,
      graph_revision   INTEGER NOT NULL,
      kind             TEXT    NOT NULL,
      payload_json     TEXT    NOT NULL CHECK (json_valid(payload_json)),
      state            TEXT    NOT NULL,
      created_at       TEXT    NOT NULL,
      delivered_at     TEXT,
      CHECK (kind IN ('dispatch','cancel','evaluator')),
      CHECK (state IN ('pending','delivered')),
      CHECK (graph_revision >= 1),
      CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
      FOREIGN KEY (run_id, graph_revision)
        REFERENCES pipeline_graph_revision(run_id, graph_revision)
    ) STRICT`,
    `CREATE INDEX pipeline_scheduler_intent_pending
      ON pipeline_scheduler_intent(state, run_id, created_at, intent_id)`,

    `CREATE TABLE pipeline_scheduler_observation (
      observation_id   TEXT    NOT NULL PRIMARY KEY,
      run_id           TEXT    NOT NULL,
      kind             TEXT    NOT NULL,
      payload_json     TEXT    NOT NULL CHECK (json_valid(payload_json)),
      recorded_at      TEXT    NOT NULL,
      consumed_at      TEXT,
      CHECK (kind IN (
        'attempt_started','attempt_waiting','attempt_succeeded','attempt_failed',
        'cancellation_settled','evaluator_decided','cancel_requested','manual_rerun'
      ))
    ) STRICT`,
    `CREATE INDEX pipeline_scheduler_observation_pending
      ON pipeline_scheduler_observation(run_id, consumed_at, recorded_at, observation_id)`,

    `CREATE TABLE pipeline_evaluator_decision (
      run_id           TEXT    NOT NULL,
      edge_key         TEXT    NOT NULL,
      selected         INTEGER NOT NULL,
      recorded_at      TEXT    NOT NULL,
      PRIMARY KEY (run_id, edge_key),
      CHECK (selected IN (0, 1))
    ) STRICT`,
    `CREATE TRIGGER pipeline_evaluator_decision_immutable_update
      BEFORE UPDATE ON pipeline_evaluator_decision
      BEGIN SELECT RAISE(ABORT, 'pipeline evaluator decisions are immutable'); END`,
  ],
};
Object.freeze(MIGRATION_0012_PIPELINE_SCHEDULER.statements);
Object.freeze(MIGRATION_0012_PIPELINE_SCHEDULER);
