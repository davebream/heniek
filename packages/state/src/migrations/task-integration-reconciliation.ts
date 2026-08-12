import type { Migration } from "./migration.js";

export const MIGRATION_0025_TASK_INTEGRATION_RECONCILIATION: Migration = {
  version: 25,
  name: "task-integration-reconciliation",
  statements: [
    `DROP TRIGGER task_integration_terminal`,
    `CREATE TRIGGER task_integration_terminal
      BEFORE UPDATE ON task_integration_ledger
      WHEN OLD.lifecycle IN ('integrated','failed')
      BEGIN SELECT RAISE(ABORT, 'terminal task integration cannot transition'); END`,
    `DROP TRIGGER epic_repository_branch_reconciliation_final`,
    `CREATE TABLE task_integration_reconciliation (
      reconciliation_id TEXT NOT NULL PRIMARY KEY,
      integration_id TEXT NOT NULL UNIQUE REFERENCES task_integration_ledger(integration_id),
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      reconciliation_json TEXT NOT NULL CHECK (json_valid(reconciliation_json)),
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id, task_id) REFERENCES task_lifecycle_projection(run_id, task_id),
      CHECK (lifecycle IN ('observing','forwarding','integrated','blocked')),
      CHECK (revision >= 1)
    ) STRICT`,
    `CREATE INDEX task_integration_reconciliation_run
      ON task_integration_reconciliation(run_id, integration_id)`,
    `CREATE TRIGGER task_integration_reconciliation_causal_update
      BEFORE UPDATE ON task_integration_reconciliation
      WHEN NEW.revision <> OLD.revision + 1
        OR NEW.reconciliation_id <> OLD.reconciliation_id
        OR NEW.integration_id <> OLD.integration_id OR NEW.run_id <> OLD.run_id
        OR NEW.task_id <> OLD.task_id OR NEW.created_at <> OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'task integration reconciliation must advance causally'); END`,
    `CREATE TRIGGER task_integration_reconciliation_terminal
      BEFORE UPDATE ON task_integration_reconciliation
      WHEN OLD.lifecycle IN ('integrated','blocked')
      BEGIN SELECT RAISE(ABORT, 'terminal task integration reconciliation cannot transition'); END`,
    `CREATE TABLE task_integration_reconciliation_observation (
      observation_id TEXT NOT NULL PRIMARY KEY,
      reconciliation_id TEXT NOT NULL REFERENCES task_integration_reconciliation(reconciliation_id),
      integration_id TEXT NOT NULL REFERENCES task_integration_ledger(integration_id),
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      pass INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      repository_id TEXT NOT NULL,
      observation_json TEXT NOT NULL CHECK (json_valid(observation_json)),
      observed_at TEXT NOT NULL,
      UNIQUE (reconciliation_id, sequence),
      UNIQUE (reconciliation_id, pass, repository_id),
      FOREIGN KEY (run_id, task_id) REFERENCES task_lifecycle_projection(run_id, task_id),
      CHECK (pass >= 1 AND sequence >= 1)
    ) STRICT`,
    `CREATE INDEX task_integration_reconciliation_observation_run
      ON task_integration_reconciliation_observation(run_id, integration_id, sequence)`,
    `CREATE TRIGGER task_integration_reconciliation_observation_immutable_update
      BEFORE UPDATE ON task_integration_reconciliation_observation
      BEGIN SELECT RAISE(ABORT, 'task integration reconciliation observations are immutable'); END`,
    `CREATE TRIGGER task_integration_reconciliation_observation_immutable_delete
      BEFORE DELETE ON task_integration_reconciliation_observation
      BEGIN SELECT RAISE(ABORT, 'task integration reconciliation observations are immutable'); END`,
  ],
};
