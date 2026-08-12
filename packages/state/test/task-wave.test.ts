import { rm } from "node:fs/promises";
import type { RunId, TaskDispatchRecord, TaskWavePlan } from "@heniek/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { runMigrations } from "../src/migrations/migrate.js";
import {
  createTaskWaveStateStore,
  TaskCapacityConflictError,
} from "../src/task-graph/wave-store.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const NOW = "2026-08-12T12:00:00.000Z";
const RUN_ID = "run-1" as RunId;
let directory = "";
let db: StateDatabase | undefined;

afterEach(async () => {
  db?.close();
  db = undefined;
  if (directory !== "") await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const temporary = await makeTempDbPath();
  directory = temporary.directory;
  const clock = createFakeClock();
  const ids = createDeterministicIds(1);
  db = openStateDatabase({ path: temporary.path, clock, ids });
  runMigrations(db);
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
  return { temporary, clock, ids, store: createTaskWaveStateStore(db) };
}

function plan(taskIds: readonly string[]): TaskWavePlan {
  return {
    schemaVersion: 1,
    graphId: "graph-1",
    graphRevision: 1,
    waveOrdinal: 1,
    validation: {
      schemaVersion: 1,
      graphId: "graph-1",
      graphRevision: 1,
      valid: true,
      topologicalOrder: taskIds,
      diagnostics: [],
    },
    selectedTaskIds: taskIds,
    decisions: taskIds.map((taskId) => ({
      taskId,
      classification: "selected",
      blockingReasons: [],
    })),
    plannedAt: NOW,
  } as unknown as TaskWavePlan;
}

function dispatch(taskId: string, repositoryId: string): TaskDispatchRecord {
  return {
    schemaVersion: 1,
    dispatchId: `dispatch-${taskId}`,
    runId: RUN_ID,
    taskId,
    graphRevision: 1,
    waveOrdinal: 1,
    childRunId: `child-${taskId}`,
    pipelineId: "careful",
    profileId: "builder",
    accountId: "account-1",
    workspaceId: `workspace-${taskId}`,
    repositoryIds: [repositoryId],
    recordedAt: NOW,
  } as TaskDispatchRecord;
}

describe("Q042 task-wave state", () => {
  it("atomically claims all scopes, replays dispatch, and releases only on settlement", async () => {
    const { store, temporary, clock, ids } = await fixture();
    store.initialize(RUN_ID, 1, ["a", "b"]);
    const input = {
      plan: plan(["a"]),
      dispatches: [dispatch("a", "repo-a")],
      limits: { maxConcurrentWorkers: 2, accountLimits: { "account-1": 2 } },
    };
    expect(store.dispatchWave(input)).toHaveLength(1);
    expect(store.dispatchWave(input)).toHaveLength(1);
    expect(store.dispatches(RUN_ID)).toHaveLength(1);
    expect(store.leases(RUN_ID).filter((lease) => lease.state === "active")).toHaveLength(4);

    store.markActive(RUN_ID, "a");
    store.markRetrying(RUN_ID, "a");
    expect(store.projections(RUN_ID)[0]?.retryCount).toBe(1);
    expect(store.leases(RUN_ID).every((lease) => lease.state === "active")).toBe(true);

    db?.close();
    db = openStateDatabase({ path: temporary.path, clock, ids });
    runMigrations(db);
    const restarted = createTaskWaveStateStore(db);
    expect(restarted.dispatches(RUN_ID)).toHaveLength(1);
    restarted.settle(RUN_ID, "a", "succeeded");
    expect(restarted.leases(RUN_ID).every((lease) => lease.state === "released")).toBe(true);

    restarted.dispatchWave({
      plan: { ...plan(["b"]), waveOrdinal: 2 },
      dispatches: [{ ...dispatch("b", "repo-a"), waveOrdinal: 2 }],
      limits: { maxConcurrentWorkers: 2, accountLimits: { "account-1": 2 } },
    });
    const repositoryFences = restarted
      .leases(RUN_ID)
      .filter((lease) => lease.scope === "repository" && lease.resourceId === "repo-a")
      .map((lease) => lease.fencingRevision);
    expect(repositoryFences).toHaveLength(2);
    expect(repositoryFences[1]).toBeGreaterThan(repositoryFences[0] ?? 0);
  });

  it("rolls back every claim when one repository is unavailable", async () => {
    const { store } = await fixture();
    store.initialize(RUN_ID, 1, ["a", "b", "c"]);
    store.dispatchWave({
      plan: plan(["a"]),
      dispatches: [dispatch("a", "shared")],
      limits: { maxConcurrentWorkers: 2, accountLimits: { "account-1": 2 } },
    });
    expect(() =>
      store.dispatchWave({
        plan: { ...plan(["b", "c"]), waveOrdinal: 2 },
        dispatches: [
          { ...dispatch("b", "repo-b"), waveOrdinal: 2 },
          { ...dispatch("c", "shared"), waveOrdinal: 2 },
        ],
        limits: { maxConcurrentWorkers: 3, accountLimits: { "account-1": 3 } },
      }),
    ).toThrow(TaskCapacityConflictError);
    expect(store.dispatches(RUN_ID).map((entry) => entry.taskId)).toEqual(["a"]);
    expect(store.projections(RUN_ID).find((task) => task.taskId === "b")?.phase).toBe(
      "not_started",
    );
    expect(store.leases(RUN_ID).some((lease) => lease.taskId === "b")).toBe(false);
  });

  it("retains recovery-required capacity and cancels pending tasks without a child run", async () => {
    const { store } = await fixture();
    store.initialize(RUN_ID, 1, ["a", "b"]);
    store.dispatchWave({
      plan: plan(["a"]),
      dispatches: [dispatch("a", "repo-a")],
      limits: { maxConcurrentWorkers: 1, accountLimits: { "account-1": 1 } },
    });
    store.markRecoveryRequired(RUN_ID, "a");
    expect(store.leases(RUN_ID).every((lease) => lease.state === "active")).toBe(true);
    expect(store.cancelPending(RUN_ID, "b").childRunId).toBeNull();
  });
});
