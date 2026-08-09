/**
 * Migration 13 (Q026, ADR 0024) — durable pipeline stage-runner tables.
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

const NOW = "2026-08-09T18:00:00.000Z";

const RUNNER_TABLES = ["pipeline_runner_attempt", "pipeline_runner_phase_transition"] as const;

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

describe("migration 13 — pipeline runner", () => {
  it("creates the pipeline runner tables on a fresh database", () => {
    runMigrations(db);
    expect(readUserVersion(internalHandle(db))).toBe(currentSchemaVersion());
    expect(currentSchemaVersion()).toBeGreaterThanOrEqual(13);
    const names = new Set(
      internalHandle(db)
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map((row) => String(row.name)),
    );
    for (const table of RUNNER_TABLES) {
      expect(names.has(table)).toBe(true);
    }
  });

  it("upgrades from migration 12 to 13 without touching existing rows", () => {
    runMigrationList(db, MIGRATIONS, 12);
    expect(readUserVersion(internalHandle(db))).toBe(12);
    expect(runMigrationList(db, MIGRATIONS, 13)).toMatchObject({ fromVersion: 12, toVersion: 13 });
    expect(readUserVersion(internalHandle(db))).toBe(13);
    for (const table of RUNNER_TABLES) {
      const count = Number(
        internalHandle(db).prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count,
      );
      expect(count).toBe(0);
    }
  });

  it("rejects mutating an immutable phase transition", () => {
    runMigrations(db);
    const handle = internalHandle(db);
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
         VALUES ('pa:1', 'run-1', 'p', 'build', 1, 1, 1, 'command', ?)`,
      )
      .run(NOW);
    handle
      .prepare(
        `INSERT INTO pipeline_runner_attempt (
           attempt_id, run_id, stage_id, stage_type, intent_id, graph_revision,
           generation, attempt_ordinal, phase, outputs_json, evidence_json,
           recovery, revision, updated_at, created_at
         ) VALUES (
           'pa:1', 'run-1', 'build', 'command', 'intent-1', 1, 1, 1, 'prepare',
           '[]', '[]', 'none', 1, ?, ?
         )`,
      )
      .run(NOW, NOW);
    handle
      .prepare(
        `INSERT INTO pipeline_runner_phase_transition
           (transition_id, attempt_id, from_phase, to_phase, recorded_at, detail)
         VALUES ('t1', 'pa:1', NULL, 'prepare', ?, NULL)`,
      )
      .run(NOW);
    expect(() =>
      handle
        .prepare(
          `UPDATE pipeline_runner_phase_transition SET to_phase = 'start' WHERE transition_id = 't1'`,
        )
        .run(),
    ).toThrow(/immutable/i);
  });
});
