/** Migration 17 — immutable structured review reports and rebuildable finding projection (Q031). */

import type { Migration } from "./migration.js";

export const MIGRATION_0017_PIPELINE_FINDINGS: Migration = {
  version: 17,
  name: "pipeline-findings",
  statements: [
    `CREATE TABLE pipeline_finding_report (
      sequence        INTEGER PRIMARY KEY,
      report_id       TEXT NOT NULL UNIQUE,
      run_id          TEXT NOT NULL,
      stage_id        TEXT NOT NULL,
      report_kind     TEXT NOT NULL,
      artifact_id     TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      report_json     TEXT NOT NULL CHECK (json_valid(report_json)),
      recorded_at     TEXT NOT NULL,
      CHECK (report_kind IN ('review','repair','final_verification')),
      CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*')
    ) STRICT`,
    `CREATE INDEX pipeline_finding_report_run
      ON pipeline_finding_report(run_id, sequence)`,
    `CREATE TRIGGER pipeline_finding_report_immutable_update
      BEFORE UPDATE ON pipeline_finding_report
      BEGIN SELECT RAISE(ABORT, 'pipeline finding reports are immutable'); END`,
    `CREATE TRIGGER pipeline_finding_report_immutable_delete
      BEFORE DELETE ON pipeline_finding_report
      BEGIN SELECT RAISE(ABORT, 'pipeline finding reports are immutable'); END`,
    `CREATE TABLE pipeline_finding_projection (
      run_id                    TEXT NOT NULL,
      finding_id                TEXT NOT NULL,
      origin_report_id          TEXT NOT NULL,
      origin_stage_id           TEXT NOT NULL,
      severity                  TEXT NOT NULL,
      disposition               TEXT NOT NULL,
      claim_verification_state  TEXT NOT NULL,
      repair_state              TEXT NOT NULL,
      resolution_state          TEXT NOT NULL,
      latest_report_id          TEXT NOT NULL,
      latest_report_artifact_id TEXT NOT NULL,
      latest_report_content_hash TEXT NOT NULL,
      evidence_json             TEXT NOT NULL CHECK (json_valid(evidence_json)),
      snapshot_json             TEXT NOT NULL CHECK (json_valid(snapshot_json)),
      revision                  INTEGER NOT NULL,
      updated_at                TEXT NOT NULL,
      PRIMARY KEY (run_id, finding_id),
      CHECK (severity IN ('critical','major','minor')),
      CHECK (disposition IN ('accepted','rejected')),
      CHECK (claim_verification_state IN ('verified','retracted')),
      CHECK (repair_state IN ('pending','applied','skipped','failed','not_required')),
      CHECK (resolution_state IN ('pending','fixed','unresolved','not_applicable')),
      CHECK (revision >= 1)
    ) STRICT`,
    `CREATE INDEX pipeline_finding_projection_query
      ON pipeline_finding_projection(run_id, severity, disposition, resolution_state, finding_id)`,
  ],
};

Object.freeze(MIGRATION_0017_PIPELINE_FINDINGS.statements);
Object.freeze(MIGRATION_0017_PIPELINE_FINDINGS);
