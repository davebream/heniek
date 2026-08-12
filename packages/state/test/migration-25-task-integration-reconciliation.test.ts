import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalHandle } from "../src/database/open.js";
import { readUserVersion } from "../src/database/pragma.js";
import { openStateDatabase, type StateDatabase } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations/list.js";
import { runMigrationList } from "../src/migrations/migrate.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const NOW = "2026-08-12T12:00:00.000Z";

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

function seedReconciliationRequiredIntegration(): void {
  const handle = internalHandle(db);
  const codebaseEvent = handle
    .prepare(`INSERT INTO state_event
      (event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload)
      VALUES ('event-codebase', NULL, 'correlation-1', NULL, 'codebase.registered', ?, '{}')`)
    .run(NOW);
  handle
    .prepare(`INSERT INTO codebase (codebase_id, revision, last_event_sequence, updated_at)
      VALUES ('codebase-1', 1, ?, ?)`)
    .run(Number(codebaseEvent.lastInsertRowid), NOW);
  const runEvent = handle
    .prepare(`INSERT INTO state_event
      (event_id, run_id, correlation_id, causation_event_id, type, recorded_at, payload)
      VALUES ('event-run', 'run-1', 'correlation-1', NULL, 'run.created', ?, '{}')`)
    .run(NOW);
  handle
    .prepare(`INSERT INTO run_projection
      (run_id, status, revision, last_event_sequence, codebase_id, updated_at)
      VALUES ('run-1', 'queued', 1, ?, 'codebase-1', ?)`)
    .run(Number(runEvent.lastInsertRowid), NOW);
  handle
    .prepare(`INSERT INTO task_lifecycle_projection
      (run_id, task_id, graph_revision, phase, child_run_id, completion_contract,
       integration, combined_verification, revision, updated_at)
      VALUES ('run-1', 'a', 1, 'succeeded', 'child-a', 'passed',
              'reconciliation_required', 'passed', 1, ?)`)
    .run(NOW);
  handle
    .prepare(`INSERT INTO task_integration_ledger
      (integration_id, run_id, task_id, graph_revision, wave_ordinal,
       integration_ordinal, variant_id, lifecycle, entry_json, revision, created_at, updated_at)
      VALUES ('integration-a', 'run-1', 'a', 1, 1, 1, 'variant-a',
              'reconciliation_required', '{}', 1, ?, ?)`)
    .run(NOW, NOW);
}

describe("migration 25 — task integration reconciliation", () => {
  it("upgrades a Q043 blocked integration without losing it and permits explicit resolution", () => {
    runMigrationList(db, MIGRATIONS, 24);
    seedReconciliationRequiredIntegration();
    expect(runMigrationList(db, MIGRATIONS)).toMatchObject({ fromVersion: 24, toVersion: 25 });
    expect(readUserVersion(internalHandle(db))).toBe(25);
    expect(
      internalHandle(db)
        .prepare(
          "SELECT lifecycle, revision FROM task_integration_ledger WHERE integration_id = 'integration-a'",
        )
        .get(),
    ).toMatchObject({ lifecycle: "reconciliation_required", revision: 1 });
    expect(() =>
      internalHandle(db)
        .prepare(`UPDATE task_integration_ledger
          SET lifecycle = 'integrated', entry_json = '{}', revision = 2, updated_at = ?
          WHERE integration_id = 'integration-a'`)
        .run(NOW),
    ).not.toThrow();
  });

  it("enforces causal projections and immutable observations", () => {
    runMigrationList(db, MIGRATIONS, 24);
    seedReconciliationRequiredIntegration();
    runMigrationList(db, MIGRATIONS);
    const handle = internalHandle(db);
    handle
      .prepare(`INSERT INTO task_integration_reconciliation
        (reconciliation_id, integration_id, run_id, task_id, lifecycle,
         reconciliation_json, revision, created_at, updated_at)
        VALUES ('reconciliation-a', 'integration-a', 'run-1', 'a', 'blocked', '{}', 1, ?, ?)`)
      .run(NOW, NOW);
    handle
      .prepare(`INSERT INTO task_integration_reconciliation_observation
        (observation_id, reconciliation_id, integration_id, run_id, task_id,
         pass, sequence, repository_id, observation_json, observed_at)
        VALUES ('observation-1', 'reconciliation-a', 'integration-a', 'run-1', 'a',
                1, 1, 'repo-a', '{}', ?)`)
      .run(NOW);
    expect(() =>
      handle.exec(
        "UPDATE task_integration_reconciliation_observation SET observation_json = '{\"changed\":true}'",
      ),
    ).toThrow("task integration reconciliation observations are immutable");
    expect(() => handle.exec("DELETE FROM task_integration_reconciliation_observation")).toThrow(
      "task integration reconciliation observations are immutable",
    );
    expect(() =>
      handle.exec(
        "UPDATE task_integration_reconciliation SET lifecycle = 'integrated', revision = 2",
      ),
    ).toThrow("terminal task integration reconciliation cannot transition");
  });
});
