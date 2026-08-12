import type { Migration } from "./migration.js";

export const MIGRATION_0026_HIDDEN_DEPENDENCY_REPLANNING: Migration = {
  version: 26,
  name: "hidden-dependency-replanning",
  statements: [
    `CREATE TABLE hidden_dependency_finding (
      finding_id TEXT NOT NULL PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES run_projection(run_id),
      graph_id TEXT NOT NULL,
      graph_revision INTEGER NOT NULL,
      revision_sha256 TEXT NOT NULL,
      reporter_task_id TEXT NOT NULL,
      finding_json TEXT NOT NULL CHECK (json_valid(finding_json)),
      discovered_at TEXT NOT NULL,
      CHECK (graph_revision >= 1),
      CHECK (length(revision_sha256) = 64 AND revision_sha256 NOT GLOB '*[^0-9a-f]*')
    ) STRICT`,
    `CREATE INDEX hidden_dependency_finding_run
      ON hidden_dependency_finding(run_id, discovered_at, finding_id)`,
    `CREATE TRIGGER hidden_dependency_finding_immutable_update
      BEFORE UPDATE ON hidden_dependency_finding
      BEGIN SELECT RAISE(ABORT, 'hidden dependency findings are immutable'); END`,
    `CREATE TRIGGER hidden_dependency_finding_immutable_delete
      BEFORE DELETE ON hidden_dependency_finding
      BEGIN SELECT RAISE(ABORT, 'hidden dependency findings are immutable'); END`,
    `CREATE TABLE hidden_dependency_replan (
      replan_id TEXT NOT NULL PRIMARY KEY,
      finding_id TEXT NOT NULL UNIQUE REFERENCES hidden_dependency_finding(finding_id),
      run_id TEXT NOT NULL REFERENCES run_projection(run_id),
      lifecycle TEXT NOT NULL,
      proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
      replan_json TEXT NOT NULL CHECK (json_valid(replan_json)),
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (lifecycle IN ('quiescing','revising','resumed','blocked')),
      CHECK (revision >= 1)
    ) STRICT`,
    `CREATE INDEX hidden_dependency_replan_run
      ON hidden_dependency_replan(run_id, created_at, replan_id)`,
    `CREATE UNIQUE INDEX hidden_dependency_replan_active
      ON hidden_dependency_replan(run_id)
      WHERE lifecycle IN ('quiescing','revising')`,
    `CREATE TRIGGER hidden_dependency_replan_causal_update
      BEFORE UPDATE ON hidden_dependency_replan
      WHEN NEW.replan_id <> OLD.replan_id OR NEW.finding_id <> OLD.finding_id
        OR NEW.run_id <> OLD.run_id OR NEW.proposal_json <> OLD.proposal_json
        OR NEW.created_at <> OLD.created_at OR NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'hidden dependency replan must advance causally'); END`,
    `CREATE TRIGGER hidden_dependency_replan_lifecycle_order
      BEFORE UPDATE ON hidden_dependency_replan
      WHEN NOT (
        (OLD.lifecycle = 'quiescing' AND NEW.lifecycle IN ('revising','blocked'))
        OR (OLD.lifecycle = 'revising' AND NEW.lifecycle IN ('resumed','blocked'))
      )
      BEGIN SELECT RAISE(ABORT, 'hidden dependency replan lifecycle is out of order'); END`,
    `CREATE TRIGGER hidden_dependency_replan_terminal
      BEFORE UPDATE ON hidden_dependency_replan
      WHEN OLD.lifecycle IN ('resumed','blocked')
      BEGIN SELECT RAISE(ABORT, 'terminal hidden dependency replan is immutable'); END`,
    `CREATE TRIGGER hidden_dependency_replan_immutable_delete
      BEFORE DELETE ON hidden_dependency_replan
      BEGIN SELECT RAISE(ABORT, 'hidden dependency replans cannot be deleted'); END`,
  ],
};
