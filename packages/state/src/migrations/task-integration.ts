import type { Migration } from "./migration.js";

export const MIGRATION_0024_TASK_INTEGRATION: Migration = {
  version: 24,
  name: "task-integration",
  statements: [
    `CREATE TABLE epic_repository_branch (
      run_id TEXT NOT NULL REFERENCES run_projection(run_id),
      repository_id TEXT NOT NULL,
      branch_ref TEXT NOT NULL,
      remote TEXT NOT NULL,
      remote_base_ref TEXT NOT NULL,
      remote_base_sha TEXT NOT NULL,
      expected_local_sha TEXT NOT NULL,
      observed_remote_sha TEXT,
      lifecycle TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, repository_id),
      CHECK (lifecycle IN ('ready','reconciliation_required')),
      CHECK (revision >= 1)
    ) STRICT`,
    `CREATE TRIGGER epic_repository_branch_causal_update
      BEFORE UPDATE ON epic_repository_branch
      WHEN NEW.revision <> OLD.revision + 1 OR NEW.run_id <> OLD.run_id
        OR NEW.repository_id <> OLD.repository_id OR NEW.branch_ref <> OLD.branch_ref
        OR NEW.remote <> OLD.remote OR NEW.remote_base_ref <> OLD.remote_base_ref
        OR NEW.remote_base_sha <> OLD.remote_base_sha OR NEW.created_at <> OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'epic repository branch must advance causally'); END`,
    `CREATE TRIGGER epic_repository_branch_reconciliation_final
      BEFORE UPDATE ON epic_repository_branch
      WHEN OLD.lifecycle = 'reconciliation_required' AND NEW.lifecycle <> OLD.lifecycle
      BEGIN SELECT RAISE(ABORT, 'reconciled epic repository branch requires an explicit replacement'); END`,
    `CREATE TABLE task_integration_ledger (
      integration_id TEXT NOT NULL PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      graph_revision INTEGER NOT NULL,
      wave_ordinal INTEGER NOT NULL,
      integration_ordinal INTEGER NOT NULL,
      variant_id TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      entry_json TEXT NOT NULL CHECK (json_valid(entry_json)),
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (run_id, graph_revision, task_id),
      UNIQUE (run_id, integration_ordinal),
      FOREIGN KEY (run_id, task_id) REFERENCES task_lifecycle_projection(run_id, task_id),
      CHECK (graph_revision >= 1 AND wave_ordinal >= 1 AND integration_ordinal >= 1),
      CHECK (revision >= 1),
      CHECK (lifecycle IN ('queued','prepared','verified','integrated','failed','reconciliation_required'))
    ) STRICT`,
    `CREATE INDEX task_integration_next
      ON task_integration_ledger(run_id, integration_ordinal, lifecycle)`,
    `CREATE TRIGGER task_integration_ledger_causal_update
      BEFORE UPDATE ON task_integration_ledger
      WHEN NEW.revision <> OLD.revision + 1 OR NEW.integration_id <> OLD.integration_id
        OR NEW.run_id <> OLD.run_id OR NEW.task_id <> OLD.task_id
        OR NEW.graph_revision <> OLD.graph_revision OR NEW.wave_ordinal <> OLD.wave_ordinal
        OR NEW.integration_ordinal <> OLD.integration_ordinal OR NEW.variant_id <> OLD.variant_id
        OR NEW.created_at <> OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'task integration ledger must advance causally'); END`,
    `CREATE TRIGGER task_integration_terminal
      BEFORE UPDATE ON task_integration_ledger
      WHEN OLD.lifecycle IN ('integrated','failed','reconciliation_required')
      BEGIN SELECT RAISE(ABORT, 'terminal task integration cannot transition'); END`,
    `CREATE TABLE task_integration_trace (
      trace_id TEXT NOT NULL PRIMARY KEY,
      integration_id TEXT NOT NULL REFERENCES task_integration_ledger(integration_id),
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      phase TEXT NOT NULL,
      trace_json TEXT NOT NULL CHECK (json_valid(trace_json)),
      recorded_at TEXT NOT NULL,
      UNIQUE (integration_id, sequence),
      FOREIGN KEY (run_id, task_id) REFERENCES task_lifecycle_projection(run_id, task_id),
      CHECK (sequence >= 1)
    ) STRICT`,
    `CREATE INDEX task_integration_trace_run
      ON task_integration_trace(run_id, integration_id, sequence)`,
    `CREATE TRIGGER task_integration_trace_immutable_update BEFORE UPDATE ON task_integration_trace
      BEGIN SELECT RAISE(ABORT, 'task integration traces are immutable'); END`,
    `CREATE TRIGGER task_integration_trace_immutable_delete BEFORE DELETE ON task_integration_trace
      BEGIN SELECT RAISE(ABORT, 'task integration traces are immutable'); END`,
  ],
};
