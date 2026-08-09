/**
 * Migration 14 (Q027, ADR 0025) — durable fixed-stage operation ledger.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalHandle } from "../src/database/open.js";
import { readUserVersion } from "../src/database/pragma.js";
import { openStateDatabase, runMigrations, type StateDatabase } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations/list.js";
import { currentSchemaVersion, runMigrationList } from "../src/migrations/migrate.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const NOW = "2026-08-09T22:00:00.000Z";

const OPERATION_TABLES = [
  "pipeline_runner_operation_request",
  "pipeline_runner_operation_state",
  "pipeline_runner_approval_answer",
  "pipeline_runner_external_observation",
  "pipeline_runner_reconciliation_trace",
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

function seedRunnerAttempt(handle: ReturnType<typeof internalHandle>, attemptId = "pa:1"): void {
  handle
    .prepare(
      `INSERT INTO pipeline_graph_revision
         (run_id, graph_revision, pipeline_id, graph_json, created_at)
       VALUES ('run-1', 1, 'p', '{}', ?)`,
    )
    .run(NOW);
  handle
    .prepare(
      `INSERT INTO pipeline_scheduler_intent
         (intent_id, run_id, graph_revision, kind, payload_json, state, created_at, delivered_at)
       VALUES ('intent-1', 'run-1', 1, 'dispatch', '{}', 'pending', ?, NULL)`,
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
  handle
    .prepare(
      `INSERT INTO pipeline_runner_attempt (
         attempt_id, run_id, stage_id, stage_type, intent_id, graph_revision,
         generation, attempt_ordinal, phase, outputs_json, evidence_json,
         recovery, revision, updated_at, created_at
       ) VALUES (
         ?, 'run-1', 'build', 'command', 'intent-1', 1, 1, 1, 'prepare',
         '[]', '[]', 'none', 1, ?, ?
       )`,
    )
    .run(attemptId, NOW, NOW);
  handle
    .prepare(
      `INSERT INTO pipeline_runner_phase_transition
         (transition_id, attempt_id, from_phase, to_phase, recorded_at, detail)
       VALUES ('t1', ?, NULL, 'prepare', ?, 'claim')`,
    )
    .run(attemptId, NOW);
}

describe("migration 14 — pipeline runner operations", () => {
  it("creates the operation ledger tables on a fresh database", () => {
    runMigrations(db);
    expect(readUserVersion(internalHandle(db))).toBe(14);
    expect(currentSchemaVersion()).toBe(14);
    const names = new Set(
      internalHandle(db)
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map((row) => String(row.name)),
    );
    for (const table of OPERATION_TABLES) {
      expect(names.has(table)).toBe(true);
    }
    const columns = internalHandle(db)
      .prepare(`SELECT name FROM pragma_table_xinfo('pipeline_runner_attempt')`)
      .all()
      .map((row) => String(row.name));
    expect(columns).toContain("operation_id");
  });

  it("preserves Q026 attempts when upgrading from migration 13", () => {
    runMigrationList(db, MIGRATIONS, 13);
    expect(readUserVersion(internalHandle(db))).toBe(13);
    seedRunnerAttempt(internalHandle(db));
    expect(runMigrations(db)).toMatchObject({ fromVersion: 13, toVersion: 14 });
    expect(readUserVersion(internalHandle(db))).toBe(14);

    const attempt = internalHandle(db)
      .prepare(
        `SELECT attempt_id, stage_type, recovery, operation_id, revision FROM pipeline_runner_attempt`,
      )
      .get();
    expect(attempt).toMatchObject({
      attempt_id: "pa:1",
      stage_type: "command",
      recovery: "none",
      operation_id: null,
      revision: 1,
    });
    const transitions = Number(
      internalHandle(db)
        .prepare(`SELECT count(*) AS count FROM pipeline_runner_phase_transition`)
        .get()?.count,
    );
    expect(transitions).toBe(1);
  });

  it("accepts all six stage types and widened recovery values", () => {
    runMigrations(db);
    const handle = internalHandle(db);
    handle
      .prepare(
        `INSERT INTO pipeline_graph_revision
           (run_id, graph_revision, pipeline_id, graph_json, created_at)
         VALUES ('run-1', 1, 'p', '{}', ?)`,
      )
      .run(NOW);
    const stageTypes = [
      "agent",
      "command",
      "approval",
      "integration",
      "verify",
      "publish",
    ] as const;
    for (const [index, stageType] of stageTypes.entries()) {
      const attemptId = `pa:${stageType}`;
      const intentId = `intent:${stageType}`;
      handle
        .prepare(
          `INSERT INTO pipeline_scheduler_intent
             (intent_id, run_id, graph_revision, kind, payload_json, state, created_at, delivered_at)
           VALUES (?, 'run-1', 1, 'dispatch', '{}', 'pending', ?, NULL)`,
        )
        .run(intentId, NOW);
      handle
        .prepare(
          `INSERT INTO pipeline_stage_attempt
             (attempt_id, run_id, pipeline_id, stage_id, graph_revision, generation,
              attempt_ordinal, stage_type, created_at)
           VALUES (?, 'run-1', 'p', ?, 1, 1, ?, ?, ?)`,
        )
        .run(attemptId, stageType, index + 1, stageType, NOW);
      handle
        .prepare(
          `INSERT INTO pipeline_runner_attempt (
             attempt_id, run_id, stage_id, stage_type, intent_id, graph_revision,
             generation, attempt_ordinal, phase, outputs_json, evidence_json,
             recovery, revision, updated_at, created_at
           ) VALUES (
             ?, 'run-1', ?, ?, ?, 1, 1, ?, 'prepare',
             '[]', '[]', 'await_approval', 1, ?, ?
           )`,
        )
        .run(attemptId, stageType, stageType, intentId, index + 1, NOW, NOW);
    }
    expect(
      Number(handle.prepare(`SELECT count(*) AS count FROM pipeline_runner_attempt`).get()?.count),
    ).toBe(6);
  });

  it("rejects mutating immutable operation request and approval answer rows", () => {
    runMigrations(db);
    const handle = internalHandle(db);
    seedRunnerAttempt(handle);
    handle
      .prepare(
        `INSERT INTO pipeline_runner_operation_request
           (operation_id, attempt_id, stage_type, request_json, created_at)
         VALUES ('op:1', 'pa:1', 'approval', '{}', ?)`,
      )
      .run(NOW);
    handle
      .prepare(
        `INSERT INTO pipeline_runner_operation_state
           (operation_id, attempt_id, phase, revision, updated_at)
         VALUES ('op:1', 'pa:1', 'waiting', 1, ?)`,
      )
      .run(NOW);
    handle
      .prepare(
        `INSERT INTO pipeline_runner_approval_answer (
           answer_id, operation_id, attempt_id, interaction_id, expected_revision,
           decision, selected_label, answered_by_key_id, answered_at, decision_json
         ) VALUES (
           'ans:1', 'op:1', 'pa:1', 'ix:1', 1, 'approve', 'yes', 'key:1', ?, '{}'
         )`,
      )
      .run(NOW);

    expect(() =>
      handle
        .prepare(
          `UPDATE pipeline_runner_operation_request SET stage_type = 'verify' WHERE operation_id = 'op:1'`,
        )
        .run(),
    ).toThrow(/immutable/i);
    expect(() =>
      handle
        .prepare(
          `UPDATE pipeline_runner_approval_answer SET decision = 'reject' WHERE answer_id = 'ans:1'`,
        )
        .run(),
    ).toThrow(/immutable/i);
  });
});
