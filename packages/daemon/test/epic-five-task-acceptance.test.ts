import { rm } from "node:fs/promises";
import type {
  RunId,
  TaskDagV2,
  TaskDispatchRecord,
  TaskGraphRevisionRecord,
  TaskIntegrationLedgerEntry,
  TaskRequirementMapping,
} from "@heniek/contracts";
import { openStateDatabase, runMigrations } from "@heniek/state";
import { afterEach, describe, expect, it } from "vitest";
import { internalHandle, type StateDatabase } from "../../state/src/database/open.js";
import { makeTempDbPath } from "../../state/test/helpers/temp-db.js";
import { createTaskGraphRevisionService } from "../src/runtime/task-graph-revision-service.js";
import {
  createTaskIntegrationService,
  type TaskIntegrationDriver,
  type TaskIntegrationWork,
} from "../src/runtime/task-integration-service.js";
import {
  createTaskWaveSchedulerService,
  type TaskPipelineDriver,
  type TaskPipelineStatus,
} from "../src/runtime/task-wave-scheduler-service.js";

const NOW = "2026-08-12T12:00:00.000Z";
const HASH = "a".repeat(64);
const BASE = "b".repeat(40);
const RUN_ID = "run-1" as RunId;
let directory = "";
let database: StateDatabase | undefined;

afterEach(async () => {
  database?.close();
  database = undefined;
  if (directory !== "") await rm(directory, { recursive: true, force: true });
});

function node(
  taskId: string,
  writeSet: readonly string[],
  profileId: string,
  accountId: string,
  dependencies: readonly string[] = [],
) {
  return {
    pipelineId: taskId === "T1" ? "careful" : "fast",
    profileId,
    accountId,
    task: {
      schemaVersion: 1,
      taskId,
      revision: 1,
      revisionSha256: HASH,
      predecessorRevisionSha256: null,
      analysisPacketId: "analysis-1",
      analysisPacketSha256: HASH,
      objective: `Implement ${taskId}.`,
      rationale: "Canonical Q045 acceptance task.",
      primaryRepositoryId: writeSet[0] ?? "repo-a",
      readSet: ["repo-a", "repo-b", "repo-c"],
      writeSet,
      excludedRepositories: [],
      dependencies,
      artifacts: [],
      verification: [],
      createdAt: NOW,
    },
  } as unknown as TaskDagV2["nodes"][number];
}

const DAG = {
  schemaVersion: 2,
  graphId: "graph-1",
  graphRevision: 1,
  nodes: [
    node("T1", ["repo-a", "repo-b", "repo-c"], "claude", "claude-subscription"),
    node("T2", ["repo-a"], "codex", "openai-subscription", ["T1"]),
    node("T3", ["repo-b"], "cursor", "cursor-subscription", ["T1"]),
    node("T4", ["repo-c"], "claude", "claude-subscription", ["T1"]),
    node("T5", [], "codex", "openai-subscription", ["T1"]),
  ],
  createdAt: NOW,
} as TaskDagV2;

class ScriptedTaskDriver implements TaskPipelineDriver {
  readonly starts: TaskDispatchRecord[] = [];
  readonly statuses = new Map<string, TaskPipelineStatus>();

  async start(dispatch: TaskDispatchRecord): Promise<void> {
    if (this.statuses.has(dispatch.childRunId)) return;
    this.starts.push(dispatch);
    this.statuses.set(dispatch.childRunId, { state: "running" });
  }

  async tick(childRunId: string): Promise<TaskPipelineStatus> {
    return this.status(childRunId);
  }

  async status(childRunId: string): Promise<TaskPipelineStatus> {
    return this.statuses.get(childRunId) ?? { state: "missing" };
  }

  async cancel(childRunId: string): Promise<void> {
    this.statuses.set(childRunId, { state: "cancelling" });
  }

  set(taskId: string, status: TaskPipelineStatus) {
    const dispatch = this.starts.find((candidate) => candidate.taskId === taskId);
    if (dispatch === undefined) throw new Error(`missing ${taskId} dispatch`);
    this.statuses.set(dispatch.childRunId, status);
  }
}

class AcceptanceIntegrationDriver implements TaskIntegrationDriver {
  readonly heads = new Map([
    ["repo-a", BASE],
    ["repo-b", BASE],
    ["repo-c", BASE],
  ]);
  readonly dispatches = new Map<string, TaskDispatchRecord>();
  readonly timeline: string[] = [];

  async observeBranches() {
    return [...this.heads].map(([repositoryId, observedLocalSha]) => ({
      runId: RUN_ID,
      repositoryId,
      branchRef: `refs/heads/epic/${repositoryId}`,
      remote: "origin",
      remoteBaseRef: "refs/remotes/origin/main",
      remoteBaseSha: BASE,
      observedLocalSha,
      observedRemoteSha: null,
    }));
  }

  async resolve(dispatch: TaskDispatchRecord): Promise<TaskIntegrationWork> {
    this.dispatches.set(dispatch.taskId, dispatch);
    return {
      variantId: `task-variant:${dispatch.runId}:${dispatch.graphRevision}:${dispatch.taskId}`,
    };
  }

  async inventory(work: TaskIntegrationWork) {
    const taskId = work.variantId.split(":").at(-1) as string;
    this.timeline.push(`inventory:${taskId}`);
    return {
      classification:
        (this.dispatches.get(taskId)?.repositoryIds.length ?? 0) === 0
          ? ("no_changes" as const)
          : ("ready" as const),
      detail: "deterministic acceptance inventory",
    };
  }

  async prepare(work: TaskIntegrationWork) {
    const taskId = work.variantId.split(":").at(-1) as string;
    this.timeline.push(`prepare:${taskId}`);
    const repositories = (this.dispatches.get(taskId)?.repositoryIds ?? []).map((repositoryId) => ({
      repositoryId,
      sourceSha: "c".repeat(40),
      expectedTargetSha: this.heads.get(repositoryId) as string,
      candidateSha: `${taskId.at(-1) ?? "0"}`.repeat(40),
      resultSha: null,
      classification: "prepared",
    })) as TaskIntegrationLedgerEntry["repositories"];
    return { classification: "prepared" as const, repositories };
  }

  async verify(work: TaskIntegrationWork) {
    const taskId = work.variantId.split(":").at(-1) as string;
    this.timeline.push(`verify:${taskId}`);
    return { classification: "passed" as const, reportId: `combined-verification:${taskId}` };
  }

  async publish(
    work: TaskIntegrationWork,
    repositories: TaskIntegrationLedgerEntry["repositories"],
  ) {
    const taskId = work.variantId.split(":").at(-1) as string;
    this.timeline.push(`publish:${taskId}`);
    const integrated = repositories.map((repository) => {
      this.heads.set(repository.repositoryId, repository.candidateSha as string);
      return { ...repository, resultSha: repository.candidateSha, classification: "integrated" };
    });
    return { classification: "integrated" as const, repositories: integrated };
  }

  async observe(
    _work: TaskIntegrationWork,
    repositories: TaskIntegrationLedgerEntry["repositories"],
  ) {
    return repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
      observedSha: this.heads.get(repository.repositoryId) ?? null,
      classification: "observed" as const,
      detail: null,
    }));
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

  const revisions = createTaskGraphRevisionService({ stateDatabase: database, clock, ids });
  revisions.initialize({
    runId: RUN_ID,
    dag: DAG,
    requirementMappings: [
      {
        sourceWorkItemId: "source-1",
        requirementId: "R-1",
        beforeTaskIds: [],
        afterTaskIds: ["T1", "T2", "T3", "T4", "T5"],
        rationale: "Canonical five-task coverage.",
      },
    ] as unknown as readonly TaskRequirementMapping[],
    rationale: "Canonical Q045 graph.",
    evidenceArtifactIds: [
      "artifact-initial",
    ] as unknown as TaskGraphRevisionRecord["evidenceArtifactIds"],
  });
  const taskDriver = new ScriptedTaskDriver();
  const integrationDriver = new AcceptanceIntegrationDriver();
  const integration = createTaskIntegrationService({
    db: database,
    clock,
    driver: integrationDriver,
  });
  const scheduler = createTaskWaveSchedulerService({
    db: database,
    clock,
    ids,
    driver: taskDriver,
    integration,
  });
  return { integration, integrationDriver, scheduler, taskDriver };
}

const tickInput = {
  runId: RUN_ID,
  dag: DAG,
  maxConcurrentWorkers: 4,
  profiles: [
    { profileId: "claude", available: true },
    { profileId: "codex", available: true },
    { profileId: "cursor", available: true },
  ],
  accounts: [
    { accountId: "claude-subscription", activeRuns: 0, maxConcurrentRuns: 2 },
    { accountId: "openai-subscription", activeRuns: 0, maxConcurrentRuns: 2 },
    { accountId: "cursor-subscription", activeRuns: 0, maxConcurrentRuns: 1 },
  ],
} as const;

describe("Q045 deterministic five-task, three-repository acceptance", () => {
  it("integrates T1 before a four-task parallel wave and preserves retry and question sessions", async () => {
    const { integration, integrationDriver, scheduler, taskDriver } = await fixture();
    await scheduler.tick(tickInput);
    expect(taskDriver.starts.map((dispatch) => dispatch.taskId)).toEqual(["T1"]);

    taskDriver.set("T1", { state: "succeeded" });
    await scheduler.tick(tickInput);
    const parallel = taskDriver.starts.filter((dispatch) => dispatch.taskId !== "T1");
    expect(parallel.map((dispatch) => dispatch.taskId).sort()).toEqual(["T2", "T3", "T4", "T5"]);
    expect(new Set(parallel.map((dispatch) => dispatch.waveOrdinal))).toEqual(new Set([2]));
    expect(integration.status(RUN_ID).entries.find((entry) => entry.taskId === "T1")).toMatchObject(
      {
        lifecycle: "integrated",
        verification: "passed",
      },
    );

    const t2Child = parallel.find((dispatch) => dispatch.taskId === "T2")?.childRunId;
    const t3Child = parallel.find((dispatch) => dispatch.taskId === "T3")?.childRunId;
    taskDriver.set("T2", { state: "retrying", attemptOrdinal: 2 });
    taskDriver.set("T3", { state: "waiting_on_user" });
    taskDriver.set("T4", { state: "succeeded" });
    taskDriver.set("T5", { state: "succeeded" });
    await scheduler.tick(tickInput);
    expect(scheduler.status(RUN_ID).tasks.find((task) => task.taskId === "T2")?.phase).toBe(
      "retrying",
    );
    expect(scheduler.status(RUN_ID).tasks.find((task) => task.taskId === "T3")?.childRunId).toBe(
      t3Child,
    );

    taskDriver.set("T2", { state: "succeeded" });
    taskDriver.set("T3", { state: "running" });
    await scheduler.tick(tickInput);
    expect(scheduler.status(RUN_ID).tasks.find((task) => task.taskId === "T2")?.childRunId).toBe(
      t2Child,
    );
    taskDriver.set("T3", { state: "succeeded" });
    const completed = await scheduler.tick(tickInput);

    expect(completed.tasks.every((task) => task.phase === "succeeded")).toBe(true);
    expect(
      completed.tasks.every(
        (task) =>
          task.completionContract === "passed" &&
          task.integration === "passed" &&
          task.combinedVerification === "passed",
      ),
    ).toBe(true);
    expect(integration.status(RUN_ID).entries.map((entry) => entry.taskId)).toEqual([
      "T1",
      "T2",
      "T3",
      "T4",
      "T5",
    ]);
    expect(integrationDriver.timeline.filter((entry) => entry.startsWith("verify:"))).toEqual([
      "verify:T1",
      "verify:T2",
      "verify:T3",
      "verify:T4",
      "verify:T5",
    ]);
  });
});
