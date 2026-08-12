import type { Migration } from "./migration.js";

/** Immutable task-source observations and revisions with mutable active-revision projection (Q039). */
export const MIGRATION_0021_TASK_SOURCE: Migration = {
  version: 21,
  name: "task-source",
  statements: [
    `CREATE TABLE task_source_snapshot (
      snapshot_id          TEXT NOT NULL PRIMARY KEY,
      source_work_item_id  TEXT NOT NULL,
      source_uri           TEXT NOT NULL,
      observed_version     TEXT NOT NULL,
      content_sha256       TEXT NOT NULL,
      raw_artifact_id      TEXT NOT NULL,
      raw_relative_path    TEXT NOT NULL,
      snapshot_json        TEXT NOT NULL CHECK (json_valid(snapshot_json)),
      observed_at          TEXT NOT NULL,
      UNIQUE (source_uri, observed_version),
      CHECK (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
      CHECK (raw_relative_path = 'blobs/sha256/' || content_sha256)
    ) STRICT`,
    `CREATE INDEX task_source_snapshot_work_item
      ON task_source_snapshot(source_work_item_id, observed_at, snapshot_id)`,
    `CREATE TRIGGER task_source_snapshot_immutable_update BEFORE UPDATE ON task_source_snapshot
      BEGIN SELECT RAISE(ABORT, 'task source snapshots are immutable'); END`,
    `CREATE TRIGGER task_source_snapshot_immutable_delete BEFORE DELETE ON task_source_snapshot
      BEGIN SELECT RAISE(ABORT, 'task source snapshots are immutable'); END`,
    `CREATE TABLE task_source_artifact (
      snapshot_id     TEXT NOT NULL REFERENCES task_source_snapshot(snapshot_id),
      artifact_id     TEXT NOT NULL,
      role            TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      relative_path   TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, artifact_id),
      CHECK (role IN ('source','attachment')),
      CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
      CHECK (relative_path = 'blobs/sha256/' || content_hash)
    ) STRICT`,
    `CREATE TRIGGER task_source_artifact_immutable_update BEFORE UPDATE ON task_source_artifact
      BEGIN SELECT RAISE(ABORT, 'task source artifacts are immutable'); END`,
    `CREATE TRIGGER task_source_artifact_immutable_delete BEFORE DELETE ON task_source_artifact
      BEGIN SELECT RAISE(ABORT, 'task source artifacts are immutable'); END`,
    `CREATE TABLE task_revision (
      revision_id          TEXT NOT NULL PRIMARY KEY,
      source_work_item_id  TEXT NOT NULL,
      ordinal              INTEGER NOT NULL,
      revision_sha256      TEXT NOT NULL,
      predecessor_id       TEXT REFERENCES task_revision(revision_id),
      snapshot_id          TEXT NOT NULL REFERENCES task_source_snapshot(snapshot_id),
      revision_json        TEXT NOT NULL CHECK (json_valid(revision_json)),
      created_at           TEXT NOT NULL,
      UNIQUE (source_work_item_id, ordinal),
      CHECK (ordinal >= 1),
      CHECK (length(revision_sha256) = 64 AND revision_sha256 NOT GLOB '*[^0-9a-f]*'),
      CHECK ((ordinal = 1) = (predecessor_id IS NULL))
    ) STRICT`,
    `CREATE TRIGGER task_revision_immutable_update BEFORE UPDATE ON task_revision
      BEGIN SELECT RAISE(ABORT, 'task revisions are immutable'); END`,
    `CREATE TRIGGER task_revision_immutable_delete BEFORE DELETE ON task_revision
      BEGIN SELECT RAISE(ABORT, 'task revisions are immutable'); END`,
    `CREATE TRIGGER task_revision_exact_predecessor BEFORE INSERT ON task_revision
      WHEN NEW.ordinal > 1 AND NOT EXISTS (
        SELECT 1 FROM task_revision predecessor
        WHERE predecessor.revision_id = NEW.predecessor_id
          AND predecessor.source_work_item_id = NEW.source_work_item_id
          AND predecessor.ordinal = NEW.ordinal - 1
      )
      BEGIN SELECT RAISE(ABORT, 'task revision must continue the exact predecessor chain'); END`,
    `CREATE TABLE task_revision_projection (
      source_work_item_id  TEXT NOT NULL PRIMARY KEY,
      active_revision_id   TEXT NOT NULL REFERENCES task_revision(revision_id),
      revision             INTEGER NOT NULL,
      updated_at           TEXT NOT NULL,
      CHECK (revision >= 1)
    ) STRICT`,
    `CREATE TRIGGER task_revision_projection_first BEFORE INSERT ON task_revision_projection
      WHEN NEW.revision <> 1
      BEGIN SELECT RAISE(ABORT, 'first task revision projection must be 1'); END`,
    `CREATE TRIGGER task_revision_projection_causal BEFORE UPDATE ON task_revision_projection
      WHEN NEW.revision <> OLD.revision + 1
      BEGIN SELECT RAISE(ABORT, 'task revision projection must advance revision by 1'); END`,
    `CREATE TRIGGER task_revision_projection_immutable_delete BEFORE DELETE ON task_revision_projection
      BEGIN SELECT RAISE(ABORT, 'task revision projections cannot be deleted'); END`,
    `CREATE TABLE task_tracker_edge (
      root_source_work_item_id   TEXT NOT NULL,
      parent_source_work_item_id TEXT NOT NULL,
      child_source_work_item_id  TEXT NOT NULL,
      recorded_at                TEXT NOT NULL,
      PRIMARY KEY (root_source_work_item_id, parent_source_work_item_id, child_source_work_item_id),
      CHECK (parent_source_work_item_id <> child_source_work_item_id)
    ) STRICT`,
    `CREATE TRIGGER task_tracker_edge_immutable_update BEFORE UPDATE ON task_tracker_edge
      BEGIN SELECT RAISE(ABORT, 'task tracker edges are immutable'); END`,
    `CREATE TRIGGER task_tracker_edge_immutable_delete BEFORE DELETE ON task_tracker_edge
      BEGIN SELECT RAISE(ABORT, 'task tracker edges are immutable'); END`,
    `CREATE TABLE task_execution_mapping (
      root_source_work_item_id TEXT NOT NULL,
      source_work_item_id      TEXT NOT NULL,
      execution_task_id        TEXT NOT NULL,
      recorded_at              TEXT NOT NULL,
      PRIMARY KEY (root_source_work_item_id, source_work_item_id, execution_task_id)
    ) STRICT`,
    `CREATE TRIGGER task_execution_mapping_immutable_update BEFORE UPDATE ON task_execution_mapping
      BEGIN SELECT RAISE(ABORT, 'task execution mappings are immutable'); END`,
    `CREATE TRIGGER task_execution_mapping_immutable_delete BEFORE DELETE ON task_execution_mapping
      BEGIN SELECT RAISE(ABORT, 'task execution mappings are immutable'); END`,
  ],
};
Object.freeze(MIGRATION_0021_TASK_SOURCE.statements);
Object.freeze(MIGRATION_0021_TASK_SOURCE);
