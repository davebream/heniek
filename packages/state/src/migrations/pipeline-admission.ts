/** Migration 18 — immutable run snapshots and idempotent attachment ledger (Q032). */

import type { Migration } from "./migration.js";

export const MIGRATION_0018_PIPELINE_ADMISSION: Migration = {
  version: 18,
  name: "pipeline-admission",
  statements: [
    `CREATE TABLE pipeline_run_snapshot (
      run_id                    TEXT NOT NULL PRIMARY KEY,
      pipeline_id               TEXT NOT NULL,
      source_kind               TEXT NOT NULL,
      source_identity           TEXT NOT NULL,
      source_digest             TEXT NOT NULL,
      source_path               TEXT,
      base_graph_json           TEXT NOT NULL CHECK (json_valid(base_graph_json)),
      effective_graph_json      TEXT NOT NULL CHECK (json_valid(effective_graph_json)),
      base_graph_digest         TEXT NOT NULL,
      effective_graph_digest    TEXT NOT NULL,
      resolved_profiles_json    TEXT NOT NULL CHECK (json_valid(resolved_profiles_json)),
      requested_overrides_json  TEXT NOT NULL CHECK (json_valid(requested_overrides_json)),
      applied_overrides_json    TEXT NOT NULL CHECK (json_valid(applied_overrides_json)),
      effective_limits_json     TEXT NOT NULL CHECK (json_valid(effective_limits_json)),
      snapshot_json             TEXT NOT NULL CHECK (json_valid(snapshot_json)),
      recorded_at               TEXT NOT NULL,
      CHECK (source_kind IN ('bundled','global','codebase-override','one-off')),
      CHECK (length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
      CHECK (length(base_graph_digest) = 64 AND base_graph_digest NOT GLOB '*[^0-9a-f]*'),
      CHECK (length(effective_graph_digest) = 64 AND effective_graph_digest NOT GLOB '*[^0-9a-f]*')
    ) STRICT`,
    `CREATE TRIGGER pipeline_run_snapshot_immutable_update
      BEFORE UPDATE ON pipeline_run_snapshot
      BEGIN SELECT RAISE(ABORT, 'pipeline run snapshots are immutable'); END`,
    `CREATE TRIGGER pipeline_run_snapshot_immutable_delete
      BEFORE DELETE ON pipeline_run_snapshot
      BEGIN SELECT RAISE(ABORT, 'pipeline run snapshots are immutable'); END`,
    `CREATE TABLE pipeline_attachment_ledger (
      attachment_id             TEXT NOT NULL PRIMARY KEY,
      request_digest            TEXT NOT NULL,
      source_run_id             TEXT NOT NULL,
      source_stage_id           TEXT NOT NULL,
      target_run_id             TEXT NOT NULL,
      target_stage_id           TEXT NOT NULL,
      request_json              TEXT NOT NULL CHECK (json_valid(request_json)),
      validation_evidence_json  TEXT NOT NULL CHECK (json_valid(validation_evidence_json)),
      artifact_ids_json         TEXT NOT NULL CHECK (json_valid(artifact_ids_json)),
      lifecycle_json            TEXT NOT NULL CHECK (json_valid(lifecycle_json)),
      graph_revision_before     INTEGER NOT NULL,
      graph_revision_after      INTEGER NOT NULL,
      schedule_revision_after   INTEGER NOT NULL,
      run_revision_after        INTEGER NOT NULL,
      recorded_at               TEXT NOT NULL,
      CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      CHECK (graph_revision_before >= 1),
      CHECK (graph_revision_after = graph_revision_before + 1),
      CHECK (schedule_revision_after >= 1),
      CHECK (run_revision_after >= 1)
    ) STRICT`,
    `CREATE UNIQUE INDEX pipeline_attachment_source_target
      ON pipeline_attachment_ledger(source_run_id, source_stage_id, target_run_id, target_stage_id)`,
    `CREATE INDEX pipeline_attachment_target_run
      ON pipeline_attachment_ledger(target_run_id, recorded_at, attachment_id)`,
    `CREATE TRIGGER pipeline_attachment_ledger_immutable_update
      BEFORE UPDATE ON pipeline_attachment_ledger
      BEGIN SELECT RAISE(ABORT, 'pipeline attachment ledger is immutable'); END`,
    `CREATE TRIGGER pipeline_attachment_ledger_immutable_delete
      BEFORE DELETE ON pipeline_attachment_ledger
      BEGIN SELECT RAISE(ABORT, 'pipeline attachment ledger is immutable'); END`,
  ],
};

Object.freeze(MIGRATION_0018_PIPELINE_ADMISSION.statements);
Object.freeze(MIGRATION_0018_PIPELINE_ADMISSION);
