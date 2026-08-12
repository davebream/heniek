import type { Migration } from "./migration.js";

export const MIGRATION_0022_TASK_GRAPH_REVISION: Migration = {
  version: 22,
  name: "task-graph-revision",
  statements: [
    `CREATE TABLE task_graph_revision_decision (
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
    ) STRICT`,
    `CREATE INDEX task_graph_revision_decision_run
      ON task_graph_revision_decision(run_id, recorded_at, decision_id)`,
    `CREATE TRIGGER task_graph_revision_decision_immutable_update BEFORE UPDATE ON task_graph_revision_decision
      BEGIN SELECT RAISE(ABORT, 'task graph revision decisions are immutable'); END`,
    `CREATE TRIGGER task_graph_revision_decision_immutable_delete BEFORE DELETE ON task_graph_revision_decision
      BEGIN SELECT RAISE(ABORT, 'task graph revision decisions are immutable'); END`,
    `CREATE TABLE task_graph_revision (
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
    ) STRICT`,
    `CREATE TRIGGER task_graph_revision_exact_predecessor BEFORE INSERT ON task_graph_revision
      WHEN NEW.graph_revision > 1 AND NOT EXISTS (
        SELECT 1 FROM task_graph_revision predecessor
        WHERE predecessor.run_id = NEW.run_id
          AND predecessor.graph_id = NEW.graph_id
          AND predecessor.graph_revision = NEW.graph_revision - 1
          AND predecessor.revision_sha256 = NEW.predecessor_revision_sha256
      )
      BEGIN SELECT RAISE(ABORT, 'task graph revision must continue the exact predecessor'); END`,
    `CREATE TRIGGER task_graph_revision_immutable_update BEFORE UPDATE ON task_graph_revision
      BEGIN SELECT RAISE(ABORT, 'task graph revisions are immutable'); END`,
    `CREATE TRIGGER task_graph_revision_immutable_delete BEFORE DELETE ON task_graph_revision
      BEGIN SELECT RAISE(ABORT, 'task graph revisions are immutable'); END`,
    `CREATE TABLE task_graph_revision_projection (
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
    ) STRICT`,
    `CREATE TRIGGER task_graph_revision_projection_first BEFORE INSERT ON task_graph_revision_projection
      WHEN NEW.active_graph_revision <> 1 OR NEW.projection_revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first task graph projection must point to revision 1'); END`,
    `CREATE TRIGGER task_graph_revision_projection_causal BEFORE UPDATE ON task_graph_revision_projection
      WHEN NEW.active_graph_revision <> OLD.active_graph_revision + 1
        OR NEW.projection_revision <> OLD.projection_revision + 1
        OR NEW.graph_id <> OLD.graph_id
      BEGIN SELECT RAISE(ABORT, 'task graph projection must advance causally'); END`,
    `CREATE TRIGGER task_graph_revision_projection_immutable_delete BEFORE DELETE ON task_graph_revision_projection
      BEGIN SELECT RAISE(ABORT, 'task graph revision projections cannot be deleted'); END`,
  ],
};
