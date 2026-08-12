import { rm } from "node:fs/promises";
import type {
  RunId,
  TaskDagV2,
  TaskDispatchRecord,
  TaskIntegrationLedgerEntry,
  TaskWavePlan,
} from "@heniek/contracts";
import { createTaskWaveStateStore, openStateDatabase, runMigrations } from "@heniek/state";
import { afterEach, describe, expect, it } from "vitest";
import { internalHandle, type StateDatabase } from "../../state/src/database/open.js";
import { makeTempDbPath } from "../../state/test/helpers/temp-db.js";
import {
  createTaskIntegrationService,
  type TaskIntegrationDriver,
  type TaskIntegrationWork,
} from "../src/runtime/task-integration-service.js";

const NOW = "2026-08-12T12:00:00.000Z";
const BASE = "0".repeat(40);
const RUN_ID = "run-1" as RunId;
let directory = "";
let database: StateDatabase | undefined;

afterEach(async () => {
  database?.close();
  database = undefined;
  if (directory !== "") await rm(directory, { recursive: true, force: true });
});

function task(taskId: string, repositoryId: string) {
  return {
    pipelineId: "careful",
    profileId: "builder",
    accountId: null,
    task: {
      schemaVersion: 1,
      taskId,
      revision: 1,
      revisionSha256: "1".repeat(64),
      predecessorRevisionSha256: null,
      analysisPacketId: "analysis-1",
      analysisPacketSha256: "2".repeat(64),
      objective: taskId,
      rationale: "required",
      primaryRepositoryId: repositoryId,
      readSet: [repositoryId],
      writeSet: [repositoryId],
      excludedRepositories: [],
      dependencies: [],
      artifacts: [],
      verification: [],
      createdAt: NOW,
    },
  };
}

const DAG = {
  schemaVersion: 2,
  graphId: "graph-1",
  graphRevision: 1,
  nodes: [task("a", "repo-a"), task("b", "repo-b")],
  createdAt: NOW,
} as unknown as TaskDagV2;

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
    accountId: null,
    workspaceId: `workspace-${taskId}`,
    repositoryIds: [repositoryId],
    recordedAt: NOW,
  } as TaskDispatchRecord;
}

function plan(): TaskWavePlan {
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
      topologicalOrder: ["a", "b"],
      diagnostics: [],
    },
    selectedTaskIds: ["a", "b"],
    decisions: [],
    plannedAt: NOW,
  } as unknown as TaskWavePlan;
}

class FakeIntegrationDriver implements TaskIntegrationDriver {
  readonly calls: string[] = [];
  readonly heads = new Map([
    ["repo-a", BASE],
    ["repo-b", BASE],
  ]);
  failVerificationFor: string | null = null;
  remoteSha: string | null = null;
  prepareFailure: "conflict" | "stale_target" | null = null;
  inventoryClassification: "ready" | "no_changes" | "replanning_required" = "ready";
  multiRepositoryFor: string | null = null;
  publicationFailure: "partial_progress" | null = null;
  throwOnVerifyOnce = false;
  throwOnPublishOnce = false;

  async observeBranches() {
    return ["repo-a", "repo-b"].map((repositoryId) => ({
      runId: RUN_ID,
      repositoryId,
      branchRef: `refs/heads/epic/${repositoryId}`,
      remote: "origin",
      remoteBaseRef: "refs/remotes/origin/main",
      remoteBaseSha: BASE,
      observedLocalSha: this.heads.get(repositoryId) as string,
      observedRemoteSha: this.remoteSha,
    }));
  }

  async resolve(dispatchRecord: TaskDispatchRecord): Promise<TaskIntegrationWork> {
    return { variantId: `task-variant:${dispatchRecord.runId}:1:${dispatchRecord.taskId}` };
  }

  async inventory(work: TaskIntegrationWork) {
    this.calls.push(`inventory:${work.variantId.at(-1)}`);
    return { classification: this.inventoryClassification, detail: "declared write inventory" };
  }

  async prepare(work: TaskIntegrationWork) {
    const taskId = work.variantId.at(-1) as string;
    const repositoryIds =
      this.multiRepositoryFor === taskId ? ["repo-a", "repo-b"] : [`repo-${taskId}`];
    this.calls.push(`prepare:${taskId}`);
    if (this.prepareFailure !== null) {
      return {
        classification: this.prepareFailure,
        repositories: repositoryIds.map((repositoryId) =>
          this.repository(repositoryId, null, this.prepareFailure as string),
        ),
      };
    }
    return {
      classification: "prepared" as const,
      repositories: repositoryIds.map((repositoryId) =>
        this.repository(repositoryId, null, "prepared"),
      ),
    };
  }

  async verify(work: TaskIntegrationWork) {
    const taskId = work.variantId.at(-1) as string;
    this.calls.push(`verify:${taskId}`);
    if (this.throwOnVerifyOnce) {
      this.throwOnVerifyOnce = false;
      throw new Error("verification process interrupted");
    }
    return {
      classification:
        this.failVerificationFor === taskId ? ("failed" as const) : ("passed" as const),
      reportId: `report-${taskId}`,
    };
  }

  async publish(work: TaskIntegrationWork) {
    const taskId = work.variantId.at(-1) as string;
    const repositoryIds =
      this.multiRepositoryFor === taskId ? ["repo-a", "repo-b"] : [`repo-${taskId}`];
    this.calls.push(`publish:${taskId}`);
    if (this.throwOnPublishOnce) {
      this.throwOnPublishOnce = false;
      throw new Error("publication process interrupted");
    }
    if (this.publicationFailure === "partial_progress") {
      const first = repositoryIds[0] as string;
      const result = "d".repeat(40);
      const installed = this.repository(first, result, "integrated");
      this.heads.set(first, result);
      return {
        classification: "partial_progress" as const,
        repositories: [
          installed,
          ...repositoryIds
            .slice(1)
            .map((repositoryId) => this.repository(repositoryId, null, "stale_target")),
        ],
      };
    }
    const repositories = repositoryIds.map((repositoryId, index) => {
      const result = String(index + (taskId === "a" ? 4 : 6)).repeat(40);
      const repository = this.repository(repositoryId, result, "integrated");
      this.heads.set(repositoryId, result);
      return repository;
    });
    return {
      classification: "integrated" as const,
      repositories,
    };
  }

  private repository(repositoryId: string, resultSha: string | null, classification: string) {
    return {
      repositoryId,
      sourceSha: "c".repeat(40),
      expectedTargetSha: this.heads.get(repositoryId) as string,
      candidateSha: repositoryId.endsWith("a") ? "1".repeat(40) : "2".repeat(40),
      resultSha,
      classification,
    } as TaskIntegrationLedgerEntry["repositories"][number];
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
  const waves = createTaskWaveStateStore(database);
  waves.initialize(RUN_ID, 1, ["a", "b"]);
  waves.dispatchWave({
    plan: plan(),
    dispatches: [dispatch("a", "repo-a"), dispatch("b", "repo-b")],
    limits: { maxConcurrentWorkers: 2, accountLimits: {} },
  });
  waves.markActive(RUN_ID, "a");
  waves.markActive(RUN_ID, "b");
  const driver = new FakeIntegrationDriver();
  const create = () =>
    createTaskIntegrationService({ db: database as StateDatabase, driver, clock });
  return { waves, driver, create };
}

describe("Q043 serialized task integration", () => {
  it("waits for the earlier ordinal, then integrates deterministically and adopts duplicate ticks", async () => {
    const { waves, driver, create } = await fixture();
    waves.settle(RUN_ID, "b", "succeeded");
    const service = create();
    await service.tick({
      runId: RUN_ID,
      dag: DAG,
      tasks: waves.projections(RUN_ID),
      dispatches: waves.dispatches(RUN_ID),
    });
    expect(driver.calls).toEqual([]);

    waves.settle(RUN_ID, "a", "succeeded");
    const completed = await service.tick({
      runId: RUN_ID,
      dag: DAG,
      tasks: waves.projections(RUN_ID),
      dispatches: waves.dispatches(RUN_ID),
    });
    expect(driver.calls).toEqual([
      "inventory:a",
      "prepare:a",
      "verify:a",
      "publish:a",
      "inventory:b",
      "prepare:b",
      "verify:b",
      "publish:b",
    ]);
    expect(completed.entries.map((entry) => [entry.taskId, entry.lifecycle])).toEqual([
      ["a", "integrated"],
      ["b", "integrated"],
    ]);
    expect(waves.projections(RUN_ID).every((taskState) => taskState.integration === "passed")).toBe(
      true,
    );

    await create().tick({
      runId: RUN_ID,
      dag: DAG,
      tasks: waves.projections(RUN_ID),
      dispatches: waves.dispatches(RUN_ID),
    });
    expect(driver.calls).toHaveLength(8);
  });

  it("produces the same ledger and publication order when tasks complete in canonical order", async () => {
    const { waves, driver, create } = await fixture();
    waves.settle(RUN_ID, "a", "succeeded");
    waves.settle(RUN_ID, "b", "succeeded");
    const result = await create().tick({
      runId: RUN_ID,
      dag: DAG,
      tasks: waves.projections(RUN_ID),
      dispatches: waves.dispatches(RUN_ID),
    });
    expect(result.entries.map((entry) => [entry.integrationOrdinal, entry.taskId])).toEqual([
      [1, "a"],
      [2, "b"],
    ]);
    expect(driver.calls.filter((call) => call.startsWith("publish:"))).toEqual([
      "publish:a",
      "publish:b",
    ]);
  });

  it("stops the queue when combined verification fails and records failed gates", async () => {
    const { waves, driver, create } = await fixture();
    waves.settle(RUN_ID, "a", "succeeded");
    waves.settle(RUN_ID, "b", "succeeded");
    driver.failVerificationFor = "a";
    const result = await create().tick({
      runId: RUN_ID,
      dag: DAG,
      tasks: waves.projections(RUN_ID),
      dispatches: waves.dispatches(RUN_ID),
    });
    expect(result.entries.map((entry) => entry.lifecycle)).toEqual(["failed", "queued"]);
    expect(driver.calls).toEqual(["inventory:a", "prepare:a", "verify:a"]);
    expect(waves.projections(RUN_ID).find((taskState) => taskState.taskId === "a")).toMatchObject({
      completionContract: "passed",
      integration: "pending",
      combinedVerification: "failed",
    });
  });

  it("resumes from durable prepared and verified phases without repeating earlier side effects", async () => {
    const { waves, driver, create } = await fixture();
    waves.settle(RUN_ID, "a", "succeeded");
    driver.throwOnVerifyOnce = true;
    await expect(
      create().tick({
        runId: RUN_ID,
        dag: DAG,
        tasks: waves.projections(RUN_ID),
        dispatches: waves.dispatches(RUN_ID),
      }),
    ).rejects.toThrow("verification process interrupted");
    expect(create().status(RUN_ID).entries[0]?.lifecycle).toBe("prepared");

    driver.throwOnPublishOnce = true;
    await expect(
      create().tick({
        runId: RUN_ID,
        dag: DAG,
        tasks: waves.projections(RUN_ID),
        dispatches: waves.dispatches(RUN_ID),
      }),
    ).rejects.toThrow("publication process interrupted");
    expect(create().status(RUN_ID).entries[0]?.lifecycle).toBe("verified");

    await create().tick({
      runId: RUN_ID,
      dag: DAG,
      tasks: waves.projections(RUN_ID),
      dispatches: waves.dispatches(RUN_ID),
    });
    expect(driver.calls).toEqual([
      "inventory:a",
      "prepare:a",
      "verify:a",
      "verify:a",
      "publish:a",
      "publish:a",
    ]);
    expect(create().status(RUN_ID).entries[0]?.lifecycle).toBe("integrated");
  });

  it("stops before integration when a remote branch or prepared target is unexpected", async () => {
    const remote = await fixture();
    remote.waves.settle(RUN_ID, "a", "succeeded");
    remote.driver.remoteSha = "d".repeat(40);
    const remoteResult = await remote.create().tick({
      runId: RUN_ID,
      dag: DAG,
      tasks: remote.waves.projections(RUN_ID),
      dispatches: remote.waves.dispatches(RUN_ID),
    });
    expect(
      remoteResult.branches.every((branch) => branch.lifecycle === "reconciliation_required"),
    ).toBe(true);
    expect(remote.driver.calls).toEqual([]);
  });

  it.each(["conflict", "stale_target"] as const)(
    "enters reconciliation on %s and leaves later ordinals untouched",
    async (prepareFailure) => {
      const { waves, driver, create } = await fixture();
      waves.settle(RUN_ID, "a", "succeeded");
      waves.settle(RUN_ID, "b", "succeeded");
      driver.prepareFailure = prepareFailure;
      const result = await create().tick({
        runId: RUN_ID,
        dag: DAG,
        tasks: waves.projections(RUN_ID),
        dispatches: waves.dispatches(RUN_ID),
      });
      expect(result.entries.map((entry) => entry.lifecycle)).toEqual([
        "reconciliation_required",
        "queued",
      ]);
      expect(driver.calls).toEqual(["inventory:a", "prepare:a"]);
      expect(waves.projections(RUN_ID).find((taskState) => taskState.taskId === "a")).toMatchObject(
        {
          completionContract: "passed",
          integration: "reconciliation_required",
          combinedVerification: "pending",
        },
      );
    },
  );

  it("verifies and records a no-change task without preparing or publishing candidates", async () => {
    const { waves, driver, create } = await fixture();
    waves.settle(RUN_ID, "a", "succeeded");
    driver.inventoryClassification = "no_changes";
    const result = await create().tick({
      runId: RUN_ID,
      dag: DAG,
      tasks: waves.projections(RUN_ID),
      dispatches: waves.dispatches(RUN_ID),
    });
    expect(driver.calls).toEqual(["inventory:a", "verify:a"]);
    expect(result.entries[0]).toMatchObject({
      lifecycle: "integrated",
      repositories: [],
      verificationReportId: "report-a",
      verification: "passed",
    });
    expect(result.traces.at(-1)).toMatchObject({
      phase: "completed",
      classification: "no_changes",
    });
  });

  it("publishes a multi-repository candidate in canonical repository order", async () => {
    const { waves, driver, create } = await fixture();
    waves.settle(RUN_ID, "a", "succeeded");
    driver.multiRepositoryFor = "a";
    const result = await create().tick({
      runId: RUN_ID,
      dag: DAG,
      tasks: waves.projections(RUN_ID),
      dispatches: waves.dispatches(RUN_ID),
    });
    expect(result.entries[0]).toMatchObject({ lifecycle: "integrated", verification: "passed" });
    expect(result.entries[0]?.repositories.map((repository) => repository.repositoryId)).toEqual([
      "repo-a",
      "repo-b",
    ]);
    expect(result.branches.map((branch) => branch.expectedLocalSha)).toEqual([
      "4".repeat(40),
      "5".repeat(40),
    ]);
  });

  it("preserves installed repository progress and stops after partial multi-repository publication", async () => {
    const { waves, driver, create } = await fixture();
    waves.settle(RUN_ID, "a", "succeeded");
    waves.settle(RUN_ID, "b", "succeeded");
    driver.multiRepositoryFor = "a";
    driver.publicationFailure = "partial_progress";
    const result = await create().tick({
      runId: RUN_ID,
      dag: DAG,
      tasks: waves.projections(RUN_ID),
      dispatches: waves.dispatches(RUN_ID),
    });
    expect(result.entries.map((entry) => entry.lifecycle)).toEqual([
      "reconciliation_required",
      "queued",
    ]);
    expect(result.entries[0]?.repositories).toMatchObject([
      { repositoryId: "repo-a", classification: "integrated", resultSha: "d".repeat(40) },
      { repositoryId: "repo-b", classification: "stale_target", resultSha: null },
    ]);
    expect(result.branches.map((branch) => branch.expectedLocalSha)).toEqual([
      "d".repeat(40),
      BASE,
    ]);
    expect(driver.calls).toEqual(["inventory:a", "prepare:a", "verify:a", "publish:a"]);
  });

  it("detects local epic-ref movement on replay before invoking integration work", async () => {
    const { waves, driver, create } = await fixture();
    const service = create();
    await service.tick({
      runId: RUN_ID,
      dag: DAG,
      tasks: waves.projections(RUN_ID),
      dispatches: waves.dispatches(RUN_ID),
    });
    driver.heads.set("repo-a", "f".repeat(40));
    waves.settle(RUN_ID, "a", "succeeded");
    const result = await service.tick({
      runId: RUN_ID,
      dag: DAG,
      tasks: waves.projections(RUN_ID),
      dispatches: waves.dispatches(RUN_ID),
    });
    expect(result.branches.find((branch) => branch.repositoryId === "repo-a")).toMatchObject({
      lifecycle: "reconciliation_required",
      expectedLocalSha: BASE,
    });
    expect(driver.calls).toEqual([]);
  });

  it("rejects undeclared writes before candidate preparation and leaves later ordinals queued", async () => {
    const { waves, driver, create } = await fixture();
    waves.settle(RUN_ID, "a", "succeeded");
    waves.settle(RUN_ID, "b", "succeeded");
    driver.inventoryClassification = "replanning_required";
    const result = await create().tick({
      runId: RUN_ID,
      dag: DAG,
      tasks: waves.projections(RUN_ID),
      dispatches: waves.dispatches(RUN_ID),
    });
    expect(result.entries.map((entry) => entry.lifecycle)).toEqual([
      "reconciliation_required",
      "queued",
    ]);
    expect(driver.calls).toEqual(["inventory:a"]);
  });
});
