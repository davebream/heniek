/**
 * Migration 15 (Q028) — durable recovery decisions and canonical run state.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalHandle } from "../src/database/open.js";
import { readUserVersion } from "../src/database/pragma.js";
import { openStateDatabase, runMigrations, type StateDatabase } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations/list.js";
import { currentSchemaVersion, runMigrationList } from "../src/migrations/migrate.js";
import {
  insertRecoveryDecision,
  insertRetryDirective,
  listRecoveryDecisions,
  listStageRecoveryStates,
  readCanonicalRunState,
  readRetryDirective,
  readStageRecoveryState,
  upsertCanonicalRunState,
  upsertStageRecoveryState,
} from "../src/pipeline/recovery-store.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const NOW = "2026-08-09T23:00:00.000Z";
const DIGEST = "a".repeat(64);

const RECOVERY_TABLES = [
  "pipeline_recovery_decision",
  "pipeline_stage_recovery_state",
  "pipeline_canonical_run_state",
  "pipeline_retry_directive",
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

function seedStageAttempt(handle: ReturnType<typeof internalHandle>, attemptId = "pa:1"): void {
  handle
    .prepare(
      `INSERT INTO pipeline_graph_revision
         (run_id, graph_revision, pipeline_id, graph_json, created_at)
       VALUES ('run-1', 1, 'p', '{}', ?)`,
    )
    .run(NOW);
  handle
    .prepare(
      `INSERT INTO pipeline_stage_attempt
         (attempt_id, run_id, pipeline_id, stage_id, graph_revision, generation,
          attempt_ordinal, stage_type, created_at)
       VALUES (?, 'run-1', 'p', 'build', 1, 1, 1, 'command', ?)`,
    )
    .run(attemptId, NOW);
}

describe("migration 15 — pipeline recovery", () => {
  it("creates recovery tables on a fresh database", () => {
    runMigrations(db);
    expect(readUserVersion(internalHandle(db))).toBe(15);
    expect(currentSchemaVersion()).toBe(15);
    const names = new Set(
      internalHandle(db)
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map((row) => String(row.name)),
    );
    for (const table of RECOVERY_TABLES) {
      expect(names.has(table)).toBe(true);
    }
    const triggers = new Set(
      internalHandle(db)
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'")
        .all()
        .map((row) => String(row.name)),
    );
    expect(triggers.has("pipeline_recovery_decision_immutable_update")).toBe(true);
    expect(triggers.has("pipeline_recovery_decision_immutable_delete")).toBe(true);
    expect(triggers.has("pipeline_retry_directive_immutable_update")).toBe(true);
    expect(triggers.has("pipeline_canonical_run_state_first_revision")).toBe(true);
    expect(triggers.has("pipeline_canonical_run_state_revision_advances")).toBe(true);
  });

  it("preserves observations when upgrading from migration 14 and widens kinds", () => {
    runMigrationList(db, MIGRATIONS, 14);
    expect(readUserVersion(internalHandle(db))).toBe(14);
    const handle = internalHandle(db);
    handle
      .prepare(
        `INSERT INTO pipeline_scheduler_observation
           (observation_id, run_id, kind, payload_json, recorded_at, consumed_at)
         VALUES ('obs:1', 'run-1', 'attempt_failed', '{}', ?, NULL)`,
      )
      .run(NOW);
    expect(runMigrations(db)).toMatchObject({ fromVersion: 14, toVersion: 15 });
    expect(readUserVersion(handle)).toBe(15);

    const preserved = handle
      .prepare(`SELECT observation_id, kind FROM pipeline_scheduler_observation`)
      .get();
    expect(preserved).toMatchObject({ observation_id: "obs:1", kind: "attempt_failed" });

    handle
      .prepare(
        `INSERT INTO pipeline_scheduler_observation
           (observation_id, run_id, kind, payload_json, recorded_at, consumed_at)
         VALUES ('obs:2', 'run-1', 'recovery_proposed', '{}', ?, NULL)`,
      )
      .run(NOW);
    expect(
      Number(
        handle.prepare(`SELECT count(*) AS count FROM pipeline_scheduler_observation`).get()?.count,
      ),
    ).toBe(2);
  });

  it("enforces append-only recovery decisions and round-trips store APIs", () => {
    runMigrations(db);
    const handle = internalHandle(db);
    seedStageAttempt(handle);

    const decision = {
      decisionId: "prd:1",
      runId: "run-1",
      stageId: "build",
      graphRevision: 1,
      generation: 1,
      attemptOrdinal: 1,
      action: "dispatch",
      outcome: "repair",
      decision: {
        schemaVersion: 1,
        decisionId: "prd:1",
        action: "dispatch",
        outcome: "repair",
      },
      recordedAt: NOW,
    };
    insertRecoveryDecision(db, decision);
    expect(listRecoveryDecisions(db, "run-1")).toHaveLength(1);
    expect(() =>
      handle
        .prepare(
          `UPDATE pipeline_recovery_decision SET outcome = 'fail' WHERE decision_id = 'prd:1'`,
        )
        .run(),
    ).toThrow(/immutable/i);
    expect(() =>
      handle.prepare(`DELETE FROM pipeline_recovery_decision WHERE decision_id = 'prd:1'`).run(),
    ).toThrow(/immutable/i);

    upsertStageRecoveryState(db, {
      runId: "run-1",
      stageId: "build",
      generation: 1,
      repairsUsed: 1,
      lastSignatureDigest: DIGEST,
      identicalSignatureCount: 1,
      pendingProposalId: null,
      pendingProposal: null,
      updatedAt: NOW,
    });
    upsertStageRecoveryState(db, {
      runId: "run-1",
      stageId: "build",
      generation: 1,
      repairsUsed: 2,
      lastSignatureDigest: DIGEST,
      identicalSignatureCount: 2,
      updatedAt: NOW,
    });
    expect(readStageRecoveryState(db, "run-1", "build", 1)).toMatchObject({
      repairsUsed: 2,
      identicalSignatureCount: 2,
      lastSignatureDigest: DIGEST,
    });
    expect(listStageRecoveryStates(db, "run-1")).toHaveLength(1);

    expect(upsertCanonicalRunState(db, { runId: "run-1", state: { a: 1 }, now: NOW })).toEqual({
      status: "applied",
      revision: 1,
    });
    expect(upsertCanonicalRunState(db, { runId: "run-1", state: { a: 2 }, now: NOW })).toEqual({
      status: "applied",
      revision: 2,
    });
    expect(
      upsertCanonicalRunState(db, {
        runId: "run-1",
        state: { a: 3 },
        expectedRevision: 1,
        now: NOW,
      }),
    ).toEqual({ status: "conflict", revision: 2 });
    expect(readCanonicalRunState(db, "run-1")).toMatchObject({
      revision: 2,
      state: { a: 2 },
    });

    insertRetryDirective(db, {
      attemptId: "pa:1",
      recoveryDecisionId: "prd:1",
      directive: { schemaVersion: 1, mode: "fresh", sessionPolicy: "fresh" },
      createdAt: NOW,
    });
    expect(readRetryDirective(db, "pa:1")).toMatchObject({
      attemptId: "pa:1",
      recoveryDecisionId: "prd:1",
    });
    expect(() =>
      handle
        .prepare(
          `UPDATE pipeline_retry_directive SET recovery_decision_id = 'prd:x' WHERE attempt_id = 'pa:1'`,
        )
        .run(),
    ).toThrow(/immutable/i);
  });
});
