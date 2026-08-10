/**
 * Migration 16 (Q029) — durable segments, fusion, capsules, verification.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalHandle } from "../src/database/open.js";
import { readUserVersion } from "../src/database/pragma.js";
import { openStateDatabase, runMigrations, type StateDatabase } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations/list.js";
import { currentSchemaVersion, runMigrationList } from "../src/migrations/migrate.js";
import {
  insertContinuationCapsule,
  insertExecutionSegment,
  insertFusionDecision,
  insertIncomingVerification,
  insertPressureObservation,
  listFusionDecisions,
  patchExecutionSegment,
  readContinuationCapsule,
  readExecutionSegment,
  readSegmentMetrics,
  recordColdStartSession,
  recordFusedStage,
  recordSmartContinuation,
} from "../src/pipeline/fusion-store.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const NOW = "2026-08-09T23:30:00.000Z";
const DIGEST = "a".repeat(64);

const FUSION_TABLES = [
  "pipeline_execution_segment",
  "pipeline_fusion_decision",
  "pipeline_continuation_capsule",
  "pipeline_pressure_observation",
  "pipeline_incoming_verification",
  "pipeline_segment_metrics",
] as const;

let directory: string;
let db: StateDatabase;

beforeEach(async () => {
  const temp = await makeTempDbPath();
  directory = temp.directory;
  db = openStateDatabase({
    path: temp.path,
    clock: createFakeClock(Date.parse(NOW)),
    ids: createDeterministicIds(1),
  });
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe("migration 16 — pipeline fusion", () => {
  it("creates fusion tables on a fresh database", () => {
    runMigrationList(db, MIGRATIONS, 16);
    expect(readUserVersion(internalHandle(db))).toBe(16);
    expect(currentSchemaVersion()).toBe(18);
    const names = new Set(
      internalHandle(db)
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map((row) => String(row.name)),
    );
    for (const table of FUSION_TABLES) {
      expect(names.has(table)).toBe(true);
    }
  });

  it("upgrades from migration 15 without touching prior tables", () => {
    runMigrationList(db, MIGRATIONS, 15);
    expect(readUserVersion(internalHandle(db))).toBe(15);
    const report = runMigrationList(db, MIGRATIONS, 16);
    expect(report.fromVersion).toBe(15);
    expect(report.toVersion).toBe(16);
    expect(report.applied.map((entry) => entry.name)).toEqual(["pipeline-fusion"]);
  });

  it("persists segments, fusion decisions, capsules, and metrics idempotently", () => {
    runMigrations(db);
    const inserted = insertExecutionSegment(db, {
      segmentId: "seg:1",
      runId: "run-1",
      profileId: "opus-planner",
      stageIds: ["understand"],
      status: "open",
      softThreshold: 0.65,
      hardThreshold: 0.8,
      segment: { schemaVersion: 1, segmentId: "seg:1" },
      startedAt: NOW,
      backendExecutionId: "exec-1",
      workspaceId: "ws-1",
    });
    expect(inserted).toBe(true);
    expect(
      insertExecutionSegment(db, {
        segmentId: "seg:1",
        runId: "run-1",
        profileId: "opus-planner",
        stageIds: ["understand"],
        status: "open",
        softThreshold: 0.65,
        hardThreshold: 0.8,
        segment: { schemaVersion: 1, segmentId: "seg:1" },
        startedAt: NOW,
      }),
    ).toBe(false);

    patchExecutionSegment(db, {
      segmentId: "seg:1",
      stageIds: ["understand", "design"],
    });
    expect(readExecutionSegment(db, "seg:1")?.stageIds).toEqual(["understand", "design"]);

    insertFusionDecision(db, {
      decisionId: "fuse:1",
      runId: "run-1",
      fromStageId: "understand",
      toStageId: "design",
      outcome: "fuse",
      segmentId: "seg:1",
      decision: { schemaVersion: 1, outcome: "fuse" },
      recordedAt: NOW,
    });
    expect(listFusionDecisions(db, "run-1")).toHaveLength(1);

    insertContinuationCapsule(db, {
      capsuleId: "cap:1",
      runId: "run-1",
      stageId: "build",
      attemptId: "pa:1",
      segmentId: "seg:1",
      segmentOrdinal: 0,
      digest: DIGEST,
      capsule: { schemaVersion: 1, capsuleId: "cap:1", digest: DIGEST },
      narrativeText: "handoff",
      createdAt: NOW,
    });
    expect(readContinuationCapsule(db, "cap:1")?.narrativeText).toBe("handoff");

    insertPressureObservation(db, {
      observationId: "po:1",
      runId: "run-1",
      segmentId: "seg:1",
      confidence: "exact",
      state: "measured",
      ratio: 0.7,
      softThreshold: 0.65,
      hardThreshold: 0.8,
      action: "soft_boundary",
      observation: { action: "soft_boundary" },
      recordedAt: NOW,
    });

    insertIncomingVerification(db, {
      verificationId: "ver:1",
      capsuleId: "cap:1",
      runId: "run-1",
      verdict: "pass",
      blockers: [],
      verification: { verdict: "pass" },
      recordedAt: NOW,
    });

    recordColdStartSession(db, "run-1", NOW);
    recordFusedStage(db, "run-1", NOW);
    recordSmartContinuation(db, "run-1", NOW);
    const metrics = readSegmentMetrics(db, "run-1");
    expect(metrics?.sessionCount).toBeGreaterThan(0);
    expect(metrics?.fusedStageCount).toBeGreaterThan(0);
    expect(metrics?.smartContinuationCount).toBeGreaterThan(0);
  });

  it("rejects mutation of immutable fusion decisions", () => {
    runMigrations(db);
    insertFusionDecision(db, {
      decisionId: "fuse:2",
      runId: "run-1",
      fromStageId: "a",
      toStageId: "b",
      outcome: "split",
      splitReason: "profile_mismatch",
      decision: { outcome: "split" },
      recordedAt: NOW,
    });
    expect(() =>
      internalHandle(db)
        .prepare("UPDATE pipeline_fusion_decision SET outcome = 'fuse' WHERE decision_id = ?")
        .run("fuse:2"),
    ).toThrow(/immutable/);
  });
});
