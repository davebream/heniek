import { rm } from "node:fs/promises";
import type {
  HiddenDependencyFinding,
  RunId,
  TaskDagV2,
  TaskDispatchRecord,
  TaskGraphRevisionProposal,
  TaskGraphRevisionRecord,
  TaskRequirementMapping,
} from "@heniek/contracts";
import { openStateDatabase, runMigrations } from "@heniek/state";
import { afterEach, describe, expect, it } from "vitest";
import { internalHandle, type StateDatabase } from "../../state/src/database/open.js";
import { makeTempDbPath } from "../../state/test/helpers/temp-db.js";
import { createEpicRuntimeCoordinator } from "../src/runtime/epic-runtime-coordinator.js";
import { createTaskGraphRevisionService } from "../src/runtime/task-graph-revision-service.js";
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

function node(taskId: string, repositoryId: string | null, dependencies: readonly string[] = []) {
  const repositories = repositoryId === null ? [] : [repositoryId];
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
      primaryRepositoryId: repositoryId ?? "repo-a",
      readSet: ["repo-a", "repo-b", "repo-c"],
      writeSet: repositories,
      excludedRepositories: [],
      dependencies,
      artifacts: [],
      verification: [],
      createdAt: NOW,
    },
  } as unknown as TaskDagV2["nodes"][number];
}

function dag(revision = 1): TaskDagV2 {
  return {
    schemaVersion: 2,
    graphId: "graph-1",
    graphRevision: revision,
    nodes: [node("T2", "repo-a"), node("T3", "repo-b"), node("T4", "repo-c"), node("T5", null)],
    createdAt: NOW,
  } as TaskDagV2;
}

class FakeDriver implements TaskPipelineDriver {
  readonly starts: string[] = [];
  readonly cancellations: string[] = [];
  readonly statuses = new Map<string, TaskPipelineStatus>();
  readonly dispatches = new Map<string, TaskDispatchRecord>();

  async start(dispatch: TaskDispatchRecord): Promise<void> {
    if (this.statuses.has(dispatch.childRunId)) return;
    this.starts.push(dispatch.taskId);
    this.dispatches.set(dispatch.taskId, dispatch);
    this.statuses.set(dispatch.childRunId, { state: "running" });
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

  settle(taskId: string, state: "succeeded" | "failed" | "cancelled") {
    const dispatch = this.dispatches.get(taskId);
    if (dispatch === undefined) throw new Error(`missing dispatch for ${taskId}`);
    this.statuses.set(dispatch.childRunId, { state });
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
  const mappings = [
    {
      sourceWorkItemId: "source-1",
      requirementId: "R-1",
      beforeTaskIds: [],
      afterTaskIds: ["T2", "T3", "T4", "T5"],
      rationale: "All tasks preserve the source requirement.",
    },
  ] as unknown as readonly TaskRequirementMapping[];
  const initial = revisions.initialize({
    runId: RUN_ID,
    dag: dag(),
    requirementMappings: mappings,
    rationale: "Initial parallel wave.",
    evidenceArtifactIds: [
      "artifact-initial",
    ] as unknown as TaskGraphRevisionRecord["evidenceArtifactIds"],
  });
  const driver = new FakeDriver();
  const scheduler = createTaskWaveSchedulerService({ db: database, driver, clock, ids });
  const coordinator = createEpicRuntimeCoordinator({ db: database, scheduler, revisions });
  return { coordinator, driver, handle, initial, revisions, scheduler };
}

const capacities = {
  runId: RUN_ID,
  maxGraphRevisions: 5,
  maxConcurrentWorkers: 4,
  profiles: [{ profileId: "builder", available: true }],
  accounts: [{ accountId: "account-1", activeRuns: 0, maxConcurrentRuns: 4 }],
} as const;

describe("Q045 epic runtime coordinator", () => {
  it("quiesces one unsafe attempt, preserves a partial-wave failure, and resumes a replacement", async () => {
    const { coordinator, driver, handle, initial } = await fixture();
    await coordinator.tick(capacities);
    expect(driver.starts.sort()).toEqual(["T2", "T3", "T4", "T5"]);

    const finding = {
      schemaVersion: 1,
      findingId: "finding-1",
      runId: RUN_ID,
      graphId: initial.graphId,
      graphRevision: initial.graphRevision,
      revisionSha256: initial.revisionSha256,
      reporterTaskId: "T4",
      prerequisiteTaskIds: ["T2"],
      affectedTaskIds: ["T4"],
      rationale: "T4 requires the integrated T2 contract.",
      evidenceArtifactIds: ["artifact-finding"],
      discoveredAt: NOW,
    } as unknown as HiddenDependencyFinding;
    const proposedDag = {
      ...dag(2),
      nodes: [
        node("T2", "repo-a"),
        node("T3", "repo-b"),
        node("T4-r", "repo-c", ["T2"]),
        node("T5", null),
      ],
    } as TaskDagV2;
    const proposal = {
      schemaVersion: 2,
      runId: RUN_ID,
      graphId: initial.graphId,
      expectedGraphRevision: 1,
      expectedRevisionSha256: initial.revisionSha256,
      proposedDag,
      changes: [
        {
          kind: "supersede",
          beforeTaskIds: ["T4"],
          afterTaskIds: ["T4-r"],
          rationale: "Resume remaining work after T2 integrates.",
          evidenceArtifactIds: ["artifact-finding"],
        },
      ],
      requirementMappings: [
        {
          sourceWorkItemId: "source-1",
          requirementId: "R-1",
          beforeTaskIds: ["T2", "T3", "T4", "T5"],
          afterTaskIds: ["T2", "T3", "T4-r", "T5"],
          rationale: "Replace only the unsafe task.",
        },
      ],
      rationale: "Apply the discovered dependency.",
      evidenceArtifactIds: ["artifact-finding"],
      proposedAt: NOW,
      trigger: { kind: "hidden_dependency", findingId: "finding-1", interruptedTaskIds: ["T4"] },
    } as unknown as Extract<TaskGraphRevisionProposal, { schemaVersion: 2 }>;

    await coordinator.reportHiddenDependency({ finding, proposal });
    driver.settle("T4", "cancelled");
    driver.settle("T2", "succeeded");
    driver.settle("T3", "failed");
    await coordinator.tick(capacities);
    handle
      .prepare(`UPDATE task_lifecycle_projection SET completion_contract = 'passed',
        integration = 'passed', combined_verification = 'passed', revision = revision + 1
        WHERE run_id = ? AND task_id = 'T2'`)
      .run(RUN_ID);

    const resumed = await coordinator.tick(capacities);
    expect(resumed.graph).toMatchObject({ schemaVersion: 2, graphRevision: 2 });
    expect(resumed.replans[0]).toMatchObject({ lifecycle: "resumed", resultingGraphRevision: 2 });
    expect(driver.starts).toContain("T4-r");
    expect(resumed.scheduler.tasks.find((task) => task.taskId === "T4")?.phase).toBe("cancelled");
    expect(resumed.scheduler.tasks.find((task) => task.taskId === "T3")?.phase).toBe("failed");
    expect(resumed.scheduler.tasks.find((task) => task.taskId === "T4-r")?.phase).toBe("active");
    expect(
      resumed.scheduler.leases
        .filter((lease) => lease.taskId === "T4")
        .every((lease) => lease.state === "released"),
    ).toBe(true);
  });

  it("blocks instead of revising when the hidden prerequisite fails", async () => {
    const { coordinator, driver, initial, revisions } = await fixture();
    await coordinator.tick(capacities);
    const finding = {
      schemaVersion: 1,
      findingId: "finding-failed-prerequisite",
      runId: RUN_ID,
      graphId: initial.graphId,
      graphRevision: initial.graphRevision,
      revisionSha256: initial.revisionSha256,
      reporterTaskId: "T4",
      prerequisiteTaskIds: ["T2"],
      affectedTaskIds: ["T4"],
      rationale: "T4 requires successful integrated T2 evidence.",
      evidenceArtifactIds: ["artifact-finding"],
      discoveredAt: NOW,
    } as unknown as HiddenDependencyFinding;
    const proposal = {
      schemaVersion: 2,
      runId: RUN_ID,
      graphId: initial.graphId,
      expectedGraphRevision: 1,
      expectedRevisionSha256: initial.revisionSha256,
      proposedDag: {
        ...dag(2),
        nodes: [
          node("T2", "repo-a"),
          node("T3", "repo-b"),
          node("T4-r", "repo-c", ["T2"]),
          node("T5", null),
        ],
      },
      changes: [
        {
          kind: "supersede",
          beforeTaskIds: ["T4"],
          afterTaskIds: ["T4-r"],
          rationale: "Resume only after T2 integrates.",
          evidenceArtifactIds: ["artifact-finding"],
        },
      ],
      requirementMappings: [
        {
          sourceWorkItemId: "source-1",
          requirementId: "R-1",
          beforeTaskIds: ["T2", "T3", "T4", "T5"],
          afterTaskIds: ["T2", "T3", "T4-r", "T5"],
          rationale: "Replace only the unsafe task.",
        },
      ],
      rationale: "Apply the discovered dependency.",
      evidenceArtifactIds: ["artifact-finding"],
      proposedAt: NOW,
      trigger: {
        kind: "hidden_dependency",
        findingId: finding.findingId,
        interruptedTaskIds: ["T4"],
      },
    } as unknown as Extract<TaskGraphRevisionProposal, { schemaVersion: 2 }>;

    await coordinator.reportHiddenDependency({ finding, proposal });
    driver.settle("T4", "cancelled");
    driver.settle("T2", "failed");
    const blocked = await coordinator.tick(capacities);

    expect(blocked.replans[0]).toMatchObject({
      lifecycle: "blocked",
      blocker: "prerequisite_unsatisfied",
      resultingGraphRevision: null,
    });
    expect(revisions.active(RUN_ID)?.graphRevision).toBe(1);
    expect(driver.starts).not.toContain("T4-r");
  });
});
