import type { Migration } from "./migration.js";

export const MIGRATION_0023_TASK_WAVE_SCHEDULER: Migration = {
  version: 23,
  name: "task-wave-scheduler",
  statements: [
    `CREATE TABLE task_lifecycle_projection (
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
      CHECK (graph_revision >= 1),
      CHECK (attempt_ordinal >= 0),
      CHECK (retry_count >= 0),
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
    ) STRICT`,
    `CREATE INDEX task_lifecycle_active
      ON task_lifecycle_projection(run_id, phase, task_id)`,
    `CREATE TRIGGER task_lifecycle_first_revision BEFORE INSERT ON task_lifecycle_projection
      WHEN NEW.revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first task lifecycle revision must be 1'); END`,
    `CREATE TRIGGER task_lifecycle_causal_update BEFORE UPDATE ON task_lifecycle_projection
      WHEN NEW.revision <> OLD.revision + 1 OR NEW.run_id <> OLD.run_id
        OR NEW.task_id <> OLD.task_id OR NEW.graph_revision < OLD.graph_revision
      BEGIN SELECT RAISE(ABORT, 'task lifecycle projection must advance causally'); END`,
    `CREATE TRIGGER task_lifecycle_terminal BEFORE UPDATE ON task_lifecycle_projection
      WHEN OLD.phase IN ('succeeded','failed','cancelled','blocked') AND NEW.phase <> OLD.phase
      BEGIN SELECT RAISE(ABORT, 'terminal task lifecycle cannot transition'); END`,
    `CREATE TABLE task_wave_plan (
      run_id TEXT NOT NULL REFERENCES run_projection(run_id),
      graph_revision INTEGER NOT NULL,
      wave_ordinal INTEGER NOT NULL,
      plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
      planned_at TEXT NOT NULL,
      PRIMARY KEY (run_id, graph_revision, wave_ordinal),
      CHECK (graph_revision >= 1),
      CHECK (wave_ordinal >= 1)
    ) STRICT`,
    `CREATE TRIGGER task_wave_plan_immutable_update BEFORE UPDATE ON task_wave_plan
      BEGIN SELECT RAISE(ABORT, 'task wave plans are immutable'); END`,
    `CREATE TRIGGER task_wave_plan_immutable_delete BEFORE DELETE ON task_wave_plan
      BEGIN SELECT RAISE(ABORT, 'task wave plans are immutable'); END`,
    `CREATE TABLE task_dispatch_record (
      dispatch_id TEXT NOT NULL PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES run_projection(run_id),
      task_id TEXT NOT NULL,
      graph_revision INTEGER NOT NULL,
      wave_ordinal INTEGER NOT NULL,
      child_run_id TEXT NOT NULL UNIQUE,
      dispatch_json TEXT NOT NULL CHECK (json_valid(dispatch_json)),
      recorded_at TEXT NOT NULL,
      UNIQUE (run_id, task_id, graph_revision),
      FOREIGN KEY (run_id, task_id) REFERENCES task_lifecycle_projection(run_id, task_id)
    ) STRICT`,
    `CREATE TRIGGER task_dispatch_immutable_update BEFORE UPDATE ON task_dispatch_record
      BEGIN SELECT RAISE(ABORT, 'task dispatch records are immutable'); END`,
    `CREATE TRIGGER task_dispatch_immutable_delete BEFORE DELETE ON task_dispatch_record
      BEGIN SELECT RAISE(ABORT, 'task dispatch records are immutable'); END`,
    `CREATE TABLE task_capacity_lease (
      lease_id TEXT NOT NULL PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      fencing_revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      released_at TEXT,
      UNIQUE (run_id, task_id, scope, resource_id),
      FOREIGN KEY (run_id, task_id) REFERENCES task_lifecycle_projection(run_id, task_id),
      CHECK (scope IN ('global','account','workspace','repository')),
      CHECK (fencing_revision >= 1),
      CHECK (state IN ('active','released')),
      CHECK ((state = 'released') = (released_at IS NOT NULL))
    ) STRICT`,
    `CREATE UNIQUE INDEX task_capacity_exclusive_active
      ON task_capacity_lease(scope, resource_id)
      WHERE state = 'active' AND scope IN ('workspace','repository')`,
    `CREATE INDEX task_capacity_counted_active
      ON task_capacity_lease(scope, resource_id, state)`,
    `CREATE TRIGGER task_capacity_identity_immutable BEFORE UPDATE ON task_capacity_lease
      WHEN NEW.lease_id <> OLD.lease_id OR NEW.run_id <> OLD.run_id
        OR NEW.task_id <> OLD.task_id OR NEW.scope <> OLD.scope
        OR NEW.resource_id <> OLD.resource_id OR NEW.acquired_at <> OLD.acquired_at
      BEGIN SELECT RAISE(ABORT, 'task capacity lease identity is immutable'); END`,
    `CREATE TRIGGER task_capacity_release_final BEFORE UPDATE ON task_capacity_lease
      WHEN OLD.state = 'released' AND NEW.state <> OLD.state
      BEGIN SELECT RAISE(ABORT, 'released task capacity cannot reactivate'); END`,
    `CREATE TABLE task_wave_audit_event (
      event_id TEXT NOT NULL PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES run_projection(run_id),
      task_id TEXT,
      kind TEXT NOT NULL,
      event_json TEXT NOT NULL CHECK (json_valid(event_json)),
      recorded_at TEXT NOT NULL,
      CHECK (kind IN ('wave_planned','capacity_acquired','task_dispatched','task_retrying',
        'cancellation_requested','task_settled','task_blocked','capacity_released',
        'recovery_required'))
    ) STRICT`,
    `CREATE INDEX task_wave_audit_run
      ON task_wave_audit_event(run_id, recorded_at, event_id)`,
    `CREATE TRIGGER task_wave_audit_immutable_update BEFORE UPDATE ON task_wave_audit_event
      BEGIN SELECT RAISE(ABORT, 'task wave audit events are immutable'); END`,
    `CREATE TRIGGER task_wave_audit_immutable_delete BEFORE DELETE ON task_wave_audit_event
      BEGIN SELECT RAISE(ABORT, 'task wave audit events are immutable'); END`,
  ],
};
