import { rm } from "node:fs/promises";
import type {
  RunId,
  TaskDagV2,
  TaskGraphChange,
  TaskGraphRevisionProposal,
  TaskGraphRevisionRecord,
  TaskPlanningState,
  TaskRequirementMapping,
} from "@heniek/contracts";
import { openStateDatabase, runMigrations } from "@heniek/state";
import { afterEach, describe, expect, it } from "vitest";
import { internalHandle, type StateDatabase } from "../../state/src/database/open.js";
import { makeTempDbPath } from "../../state/test/helpers/temp-db.js";
import { createTaskGraphRevisionService } from "../src/runtime/task-graph-revision-service.js";

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

function task(taskId: string, repositoryId: string, dependencies: readonly string[] = []) {
  return {
    pipelineId: "careful",
    profileId: "builder",
    accountId: null,
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

function dag(revision: number, nodes: readonly ReturnType<typeof task>[]): TaskDagV2 {
  return {
    schemaVersion: 2,
    graphId: "graph-1",
    graphRevision: revision,
    nodes,
    createdAt: revision === 1 ? NOW : "2026-08-12T12:01:00.000Z",
  } as unknown as TaskDagV2;
}

function mapping(beforeTaskIds: readonly string[], afterTaskIds: readonly string[]) {
  return {
    sourceWorkItemId: "source-1",
    requirementId: "R-1",
    beforeTaskIds,
    afterTaskIds,
    rationale: "Coverage is preserved.",
  } as TaskRequirementMapping;
}

function pending(taskId: string): TaskPlanningState {
  return {
    taskId,
    outcome: "not_started",
    completionContract: "pending",
    integration: "pending",
    combinedVerification: "pending",
  } as TaskPlanningState;
}

async function fixture() {
  const temporary = await makeTempDbPath();
  directory = temporary.directory;
  let tick = 0;
  const clock = {
    nowIso: () => `2026-08-12T12:0${tick++}:00.000Z`,
  };
  const ids = {
    next: (prefix: string) => `${prefix}-${tick}`,
  };
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
  return createTaskGraphRevisionService({ stateDatabase: database, clock, ids });
}

describe("Q041 task graph revision service", () => {
  it("accepts proposals only through deterministic validation and preserves state on rejection", async () => {
    const service = await fixture();
    const initial = service.initialize({
      runId: RUN_ID,
      dag: dag(1, [task("a", "repo-a")]),
      requirementMappings: [mapping([], ["a"])],
      rationale: "Initial analysis.",
      evidenceArtifactIds: [
        "artifact-initial",
      ] as unknown as TaskGraphRevisionRecord["evidenceArtifactIds"],
    });
    const change = {
      kind: "add",
      beforeTaskIds: [],
      afterTaskIds: ["b"],
      rationale: "Missing task.",
      evidenceArtifactIds: ["artifact-change"],
    } as unknown as TaskGraphChange;
    const proposal = {
      schemaVersion: 1,
      runId: RUN_ID,
      graphId: initial.graphId,
      expectedGraphRevision: 1,
      expectedRevisionSha256: initial.revisionSha256,
      proposedDag: dag(2, [task("a", "repo-a"), task("b", "repo-b", ["a"])]),
      changes: [change],
      requirementMappings: [mapping(["a"], ["a", "b"])],
      rationale: "Analysis found missing work.",
      evidenceArtifactIds: ["artifact-proposal"],
      proposedAt: "2026-08-12T12:01:00.000Z",
    } as TaskGraphRevisionProposal;

    expect(
      service.submit({ proposal, taskStates: [pending("a")], maxGraphRevisions: 5 }).decision
        .outcome,
    ).toBe("accepted");
    expect(service.active(RUN_ID)?.graphRevision).toBe(2);

    const rejected = service.submit({
      proposal,
      taskStates: [pending("a"), pending("b")],
      maxGraphRevisions: 5,
    });
    expect(rejected.decision.outcome).toBe("rejected");
    expect(rejected.decision.diagnostics.map((entry) => entry.code)).toContain(
      "task-graph-revision.stale",
    );
    expect(service.active(RUN_ID)?.graphRevision).toBe(2);
  });
});
