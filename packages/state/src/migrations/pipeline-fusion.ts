/**
 * Migration 16 — durable execution segments, fusion decisions, capsules, and
 * incoming verification (Q029).
 *
 * Append-only segment lifecycle, fusion decisions, continuation capsules,
 * pressure observations, and verification verdicts. Metrics (session,
 * cold-start, fused-stage, smart-continuation) derive from these records.
 */

import type { Migration } from "./migration.js";

export const MIGRATION_0016_PIPELINE_FUSION: Migration = {
  version: 16,
  name: "pipeline-fusion",
  statements: [
    `CREATE TABLE pipeline_execution_segment (
      segment_id             TEXT    NOT NULL PRIMARY KEY,
      run_id                 TEXT    NOT NULL,
      profile_id             TEXT    NOT NULL,
      profile_fingerprint    TEXT,
      workspace_id           TEXT,
      lease_id               TEXT,
      backend_execution_id   TEXT,
      stage_ids_json         TEXT    NOT NULL CHECK (json_valid(stage_ids_json)),
      status                 TEXT    NOT NULL,
      soft_threshold         REAL    NOT NULL,
      hard_threshold         REAL    NOT NULL,
      telemetry_cursor       TEXT,
      capsule_id             TEXT,
      segment_json           TEXT    NOT NULL CHECK (json_valid(segment_json)),
      started_at             TEXT    NOT NULL,
      closed_at              TEXT,
      CHECK (status IN ('open','checkpointed','closed','blocked')),
      CHECK (soft_threshold >= 0 AND soft_threshold <= 1),
      CHECK (hard_threshold >= 0 AND hard_threshold <= 1)
    ) STRICT`,
    `CREATE INDEX pipeline_execution_segment_run
      ON pipeline_execution_segment(run_id, started_at, segment_id)`,
    `CREATE TRIGGER pipeline_execution_segment_immutable_delete
      BEFORE DELETE ON pipeline_execution_segment
      BEGIN SELECT RAISE(ABORT, 'pipeline execution segments are immutable'); END`,

    `CREATE TABLE pipeline_fusion_decision (
      decision_id      TEXT    NOT NULL PRIMARY KEY,
      run_id           TEXT    NOT NULL,
      from_stage_id    TEXT    NOT NULL,
      to_stage_id      TEXT    NOT NULL,
      from_attempt_id  TEXT,
      to_attempt_id    TEXT,
      outcome          TEXT    NOT NULL,
      split_reason     TEXT,
      segment_id       TEXT,
      decision_json    TEXT    NOT NULL CHECK (json_valid(decision_json)),
      recorded_at      TEXT    NOT NULL,
      CHECK (outcome IN ('fuse','split'))
    ) STRICT`,
    `CREATE INDEX pipeline_fusion_decision_run
      ON pipeline_fusion_decision(run_id, recorded_at, decision_id)`,
    `CREATE TRIGGER pipeline_fusion_decision_immutable_update
      BEFORE UPDATE ON pipeline_fusion_decision
      BEGIN SELECT RAISE(ABORT, 'pipeline fusion decisions are immutable'); END`,
    `CREATE TRIGGER pipeline_fusion_decision_immutable_delete
      BEFORE DELETE ON pipeline_fusion_decision
      BEGIN SELECT RAISE(ABORT, 'pipeline fusion decisions are immutable'); END`,

    `CREATE TABLE pipeline_continuation_capsule (
      capsule_id         TEXT    NOT NULL PRIMARY KEY,
      run_id             TEXT    NOT NULL,
      stage_id           TEXT    NOT NULL,
      attempt_id         TEXT    NOT NULL,
      segment_id         TEXT    NOT NULL,
      segment_ordinal    INTEGER NOT NULL,
      digest             TEXT    NOT NULL,
      narrative_digest   TEXT,
      capsule_json       TEXT    NOT NULL CHECK (json_valid(capsule_json)),
      narrative_text     TEXT,
      created_at         TEXT    NOT NULL,
      CHECK (segment_ordinal >= 0),
      CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
      CHECK (narrative_digest IS NULL OR (
        length(narrative_digest) = 64
        AND narrative_digest NOT GLOB '*[^0-9a-f]*'
      ))
    ) STRICT`,
    `CREATE INDEX pipeline_continuation_capsule_run
      ON pipeline_continuation_capsule(run_id, created_at, capsule_id)`,
    `CREATE TRIGGER pipeline_continuation_capsule_immutable_update
      BEFORE UPDATE ON pipeline_continuation_capsule
      BEGIN SELECT RAISE(ABORT, 'pipeline continuation capsules are immutable'); END`,
    `CREATE TRIGGER pipeline_continuation_capsule_immutable_delete
      BEFORE DELETE ON pipeline_continuation_capsule
      BEGIN SELECT RAISE(ABORT, 'pipeline continuation capsules are immutable'); END`,

    `CREATE TABLE pipeline_pressure_observation (
      observation_id     TEXT    NOT NULL PRIMARY KEY,
      run_id             TEXT    NOT NULL,
      segment_id         TEXT    NOT NULL,
      attempt_id         TEXT,
      ratio              REAL,
      confidence         TEXT    NOT NULL,
      state              TEXT    NOT NULL,
      soft_threshold     REAL    NOT NULL,
      hard_threshold     REAL    NOT NULL,
      telemetry_cursor   TEXT,
      action             TEXT    NOT NULL,
      observation_json   TEXT    NOT NULL CHECK (json_valid(observation_json)),
      recorded_at        TEXT    NOT NULL,
      CHECK (confidence IN ('exact','estimated','unavailable')),
      CHECK (state IN ('measured','exhausted','unavailable')),
      CHECK (action IN ('continue','soft_boundary','hard_checkpoint','forbid_fusion')),
      CHECK (soft_threshold >= 0 AND soft_threshold <= 1),
      CHECK (hard_threshold >= 0 AND hard_threshold <= 1),
      CHECK (ratio IS NULL OR (ratio >= 0 AND ratio <= 1))
    ) STRICT`,
    `CREATE INDEX pipeline_pressure_observation_segment
      ON pipeline_pressure_observation(segment_id, recorded_at, observation_id)`,
    `CREATE TRIGGER pipeline_pressure_observation_immutable_update
      BEFORE UPDATE ON pipeline_pressure_observation
      BEGIN SELECT RAISE(ABORT, 'pipeline pressure observations are immutable'); END`,
    `CREATE TRIGGER pipeline_pressure_observation_immutable_delete
      BEFORE DELETE ON pipeline_pressure_observation
      BEGIN SELECT RAISE(ABORT, 'pipeline pressure observations are immutable'); END`,

    `CREATE TABLE pipeline_incoming_verification (
      verification_id    TEXT    NOT NULL PRIMARY KEY,
      capsule_id         TEXT    NOT NULL
        REFERENCES pipeline_continuation_capsule(capsule_id),
      run_id             TEXT    NOT NULL,
      segment_id         TEXT,
      verdict            TEXT    NOT NULL,
      blockers_json      TEXT    NOT NULL CHECK (json_valid(blockers_json)),
      verification_json  TEXT    NOT NULL CHECK (json_valid(verification_json)),
      recorded_at        TEXT    NOT NULL,
      CHECK (verdict IN ('pass','block'))
    ) STRICT`,
    `CREATE INDEX pipeline_incoming_verification_capsule
      ON pipeline_incoming_verification(capsule_id, recorded_at, verification_id)`,
    `CREATE TRIGGER pipeline_incoming_verification_immutable_update
      BEFORE UPDATE ON pipeline_incoming_verification
      BEGIN SELECT RAISE(ABORT, 'pipeline incoming verifications are immutable'); END`,
    `CREATE TRIGGER pipeline_incoming_verification_immutable_delete
      BEFORE DELETE ON pipeline_incoming_verification
      BEGIN SELECT RAISE(ABORT, 'pipeline incoming verifications are immutable'); END`,

    `CREATE TABLE pipeline_segment_metrics (
      run_id                     TEXT    NOT NULL PRIMARY KEY,
      session_count              INTEGER NOT NULL,
      cold_start_count           INTEGER NOT NULL,
      fused_stage_count          INTEGER NOT NULL,
      smart_continuation_count   INTEGER NOT NULL,
      updated_at                 TEXT    NOT NULL,
      CHECK (session_count >= 0),
      CHECK (cold_start_count >= 0),
      CHECK (fused_stage_count >= 0),
      CHECK (smart_continuation_count >= 0)
    ) STRICT`,
  ],
};
Object.freeze(MIGRATION_0016_PIPELINE_FUSION.statements);
Object.freeze(MIGRATION_0016_PIPELINE_FUSION);
