import { rm } from "node:fs/promises";
import type { RunId, TaskDagV2, TaskDispatchRecord } from "@heniek/contracts";
import { openStateDatabase, runMigrations } from "@heniek/state";
import { afterEach, describe, expect, it } from "vitest";
import { internalHandle, type StateDatabase } from "../../state/src/database/open.js";
import { makeTempDbPath } from "../../state/test/helpers/temp-db.js";
import {
  createTaskWaveSchedulerService,
  type TaskPipelineDriver,
  type TaskPipelineStatus,
} from "../src/runtime/task-wave-scheduler-service.js";

const NOW = "2026-08-12T12:00:00.000Z";
const HASH = "a".repeat(64);
const RUN_ID = "run-1" as RunId;
let directory = "";
let database: StateDatabase | undefined;

afterEach(async () => {
  database?.close();
  database = undefined;
  if (directory !== "") await rm(directory, { recursive: true, force: true });
});

function node(taskId: string, repositoryId: string, dependencies: readonly string[] = []) {
  return {
    pipelineId: "careful",
    profileId: "builder",
    accountId: "account-1",
    task: {
      schemaVersion: 1,
      taskId,
      revision: 1,
      revisionSha256: HASH,
      predecessorRevisionSha256: null,
      analysisPacketId: "analysis-1",
      analysisPacketSha256: HASH,
      objective: `Implement ${taskId}.`,
      rationale: "Required.",
      primaryRepositoryId: repositoryId,
      readSet: [repositoryId],
      writeSet: [repositoryId],
      excludedRepositories: [],
      dependencies,
      artifacts: [],
      verification: [],
      createdAt: NOW,
    },
  };
}

function dag(): TaskDagV2 {
  return {
    schemaVersion: 2,
    graphId: "graph-1",
    graphRevision: 1,
    nodes: [
      node("a", "repo-a"),
      node("b", "repo-b"),
      node("c", "repo-c", ["a"]),
      node("d", "repo-d", ["c"]),
    ],
    createdAt: NOW,
  } as unknown as TaskDagV2;
}

class FakeDriver implements TaskPipelineDriver {
  readonly starts: string[] = [];
  readonly receivedDispatches: TaskDispatchRecord[] = [];
  readonly cancellations: string[] = [];
  readonly statuses = new Map<string, TaskPipelineStatus>();
  activeStarts = 0;
  maxParallelStarts = 0;

  async start(dispatch: TaskDispatchRecord): Promise<void> {
    if (this.statuses.has(dispatch.childRunId)) return;
    this.starts.push(dispatch.taskId);
    this.receivedDispatches.push(dispatch);
    this.activeStarts += 1;
    this.maxParallelStarts = Math.max(this.maxParallelStarts, this.activeStarts);
    this.statuses.set(dispatch.childRunId, { state: "running" });
    await Promise.resolve();
    this.activeStarts -= 1;
  }

  async tick(childRunId: string): Promise<TaskPipelineStatus> {
    return this.status(childRunId);
  }

  async status(childRunId: string): Promise<TaskPipelineStatus> {
    return this.statuses.get(childRunId) ?? { state: "missing" };
  }

  async cancel(childRunId: string): Promise<void> {
    this.cancellations.push(childRunId);
    this.statuses.set(childRunId, { state: "cancelling" });
  }
}

async function fixture() {
  const temporary = await makeTempDbPath();
  directory = temporary.directory;
  let sequence = 0;
  const clock = { nowIso: () => `2026-08-12T12:00:${String(sequence++).padStart(2, "0")}.000Z` };
  const ids = { next: (prefix: string) => `${prefix}-${sequence++}` };
  database = openStateDatabase({ path: temporary.path, clock, ids });
  runMigrations(database);
  const handle = internalHandle(database);
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
  const driver = new FakeDriver();
  const create = () =>
    createTaskWaveSchedulerService({ db: database as StateDatabase, driver, clock, ids });
  return { driver, create };
}

const tickInput = {
  runId: RUN_ID,
  dag: dag(),
  maxConcurrentWorkers: 2,
  profiles: [{ profileId: "builder", available: true }],
  accounts: [{ accountId: "account-1", activeRuns: 0, maxConcurrentRuns: 2 }],
} as const;

describe("Q042 task-wave scheduler service", () => {
  it("runs complete independent task pipelines in parallel and adopts them after restart", async () => {
    const { driver, create } = await fixture();
    const first = await create().tick(tickInput);
    expect(driver.starts.sort()).toEqual(["a", "b"]);
    expect(driver.maxParallelStarts).toBe(2);
    expect(driver.receivedDispatches[0]).toMatchObject({
      accountId: "account-1",
      workspaceId: "task-workspace:run-1:1:a",
      repositoryIds: ["repo-a"],
    });
    expect(
      first.tasks.filter((task) => task.phase === "active").map((task) => task.taskId),
    ).toEqual(["a", "b"]);

    const restarted = create();
    await restarted.tick(tickInput);
    expect(driver.starts.sort()).toEqual(["a", "b"]);
    expect(restarted.status(RUN_ID).dispatches).toHaveLength(2);
  });

  it("propagates failure transitively while leaving an independent sibling active", async () => {
    const { driver, create } = await fixture();
    const service = create();
    await service.tick(tickInput);
    const a = service.status(RUN_ID).dispatches.find((entry) => entry.taskId === "a");
    if (a === undefined) throw new Error("missing task a dispatch");
    driver.statuses.set(a.childRunId, { state: "failed" });
    const result = await service.tick(tickInput);
    expect(result.tasks.find((task) => task.taskId === "a")?.phase).toBe("failed");
    expect(result.tasks.find((task) => task.taskId === "b")?.phase).toBe("active");
    const blocked = result.tasks.find((task) => task.taskId === "c");
    expect(blocked?.phase).toBe("blocked");
    expect(blocked?.blockReason?.rootTaskId).toBe("a");
    expect(blocked?.blockReason?.path).toEqual(["a", "c"]);
    const transitivelyBlocked = result.tasks.find((task) => task.taskId === "d");
    expect(transitivelyBlocked?.phase).toBe("blocked");
    expect(transitivelyBlocked?.blockReason).toMatchObject({
      immediateTaskId: "c",
      rootTaskId: "a",
      path: ["a", "c", "d"],
    });
    expect(
      result.leases
        .filter((lease) => lease.taskId === "a")
        .every((lease) => lease.state === "released"),
    ).toBe(true);
    expect(
      result.leases
        .filter((lease) => lease.taskId === "b")
        .every((lease) => lease.state === "active"),
    ).toBe(true);
  });

  it("holds capacity through retry and cancellation until terminal acknowledgement", async () => {
    const { driver, create } = await fixture();
    const service = create();
    await service.tick(tickInput);
    const a = service.status(RUN_ID).dispatches.find((entry) => entry.taskId === "a");
    if (a === undefined) throw new Error("missing task a dispatch");
    driver.statuses.set(a.childRunId, { state: "retrying", attemptOrdinal: 2 });
    await service.reconcile(RUN_ID, dag());
    expect(service.status(RUN_ID).tasks.find((task) => task.taskId === "a")?.phase).toBe(
      "retrying",
    );
    expect(service.status(RUN_ID).tasks.find((task) => task.taskId === "c")?.phase).toBe(
      "not_started",
    );
    expect(
      service
        .status(RUN_ID)
        .leases.filter((lease) => lease.taskId === "a")
        .every((lease) => lease.state === "active"),
    ).toBe(true);

    await service.cancel(RUN_ID, "a");
    expect(driver.cancellations).toEqual([a.childRunId]);
    expect(
      service
        .status(RUN_ID)
        .leases.filter((lease) => lease.taskId === "a")
        .every((lease) => lease.state === "active"),
    ).toBe(true);
    driver.statuses.set(a.childRunId, { state: "cancelled" });
    await service.reconcile(RUN_ID, dag());
    expect(service.status(RUN_ID).tasks.find((task) => task.taskId === "a")?.phase).toBe(
      "cancelled",
    );
    expect(
      service.status(RUN_ID).tasks.find((task) => task.taskId === "c")?.blockReason,
    ).toMatchObject({ code: "predecessor_cancelled", rootTaskId: "a" });
    expect(
      service
        .status(RUN_ID)
        .leases.filter((lease) => lease.taskId === "a")
        .every((lease) => lease.state === "released"),
    ).toBe(true);
  });

  it("keeps dependants pending after child success until Q043 gates pass", async () => {
    const { driver, create } = await fixture();
    const service = create();
    await service.tick(tickInput);
    const a = service.status(RUN_ID).dispatches.find((entry) => entry.taskId === "a");
    if (a === undefined) throw new Error("missing task a dispatch");
    driver.statuses.set(a.childRunId, { state: "succeeded" });

    const result = await service.tick(tickInput);
    expect(result.tasks.find((task) => task.taskId === "a")).toMatchObject({
      phase: "succeeded",
      completionContract: "pending",
      integration: "pending",
      combinedVerification: "pending",
    });
    expect(result.tasks.find((task) => task.taskId === "c")?.phase).toBe("not_started");
    expect(driver.starts.sort()).toEqual(["a", "b"]);
  });
});
