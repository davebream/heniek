/**
 * Migration 12 (Q025, ADR 0023) — durable pipeline graph scheduler tables.
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

const NOW = "2026-08-09T12:00:00.000Z";

const PIPELINE_TABLES = [
  "pipeline_graph_revision",
  "pipeline_schedule",
  "pipeline_stage_attempt",
  "pipeline_stage_projection",
  "pipeline_scheduler_decision",
  "pipeline_scheduler_intent",
  "pipeline_scheduler_observation",
  "pipeline_evaluator_decision",
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

describe("migration 12 — pipeline scheduler", () => {
  it("creates the pipeline scheduler tables on a fresh database", () => {
    runMigrations(db);
    expect(readUserVersion(internalHandle(db))).toBe(currentSchemaVersion());
    expect(currentSchemaVersion()).toBeGreaterThanOrEqual(12);
    const names = new Set(
      internalHandle(db)
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map((row) => String(row.name)),
    );
    for (const table of PIPELINE_TABLES) {
      expect(names.has(table)).toBe(true);
    }
  });

  it("upgrades from migration 11 without touching existing rows", () => {
    runMigrationList(db, MIGRATIONS, 11);
    expect(readUserVersion(internalHandle(db))).toBe(11);
    expect(runMigrationList(db, MIGRATIONS, 12)).toMatchObject({ fromVersion: 11, toVersion: 12 });
    expect(readUserVersion(internalHandle(db))).toBe(12);
    for (const table of PIPELINE_TABLES) {
      const count = Number(
        internalHandle(db).prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count,
      );
      expect(count).toBe(0);
    }
  });

  it("rejects mutating an immutable graph revision", () => {
    runMigrations(db);
    const handle = internalHandle(db);
    handle
      .prepare(
        `INSERT INTO pipeline_graph_revision
          (run_id, graph_revision, pipeline_id, graph_json, created_at)
         VALUES ('run-1', 1, 'p', '{}', ?)`,
      )
      .run(NOW);
    expect(() =>
      handle
        .prepare("UPDATE pipeline_graph_revision SET pipeline_id = 'x' WHERE run_id = 'run-1'")
        .run(),
    ).toThrow(/immutable/);
  });
});
