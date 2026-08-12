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
import { createInitialTaskGraphRevision, validateTaskGraphRevision } from "@heniek/pipeline";
import { afterEach, describe, expect, it } from "vitest";
import { internalHandle, openStateDatabase, type StateDatabase } from "../src/database/open.js";
import { runMigrations } from "../src/migrations/migrate.js";
import { createTaskGraphRevisionStateStore } from "../src/task-graph/store.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const NOW = "2026-08-12T12:00:00.000Z";
const LATER = "2026-08-12T12:01:00.000Z";
const HASH = "a".repeat(64);
const RUN_ID = "run-1" as RunId;

let directory = "";
let db: StateDatabase | undefined;

afterEach(async () => {
  db?.close();
  db = undefined;
  if (directory !== "") await rm(directory, { recursive: true, force: true });
});

function node(taskId: string, repositoryId: string, dependencies: readonly string[] = []) {
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

function dag(revision: number, nodes: readonly ReturnType<typeof node>[]): TaskDagV2 {
  return {
    schemaVersion: 2,
    graphId: "graph-1",
    graphRevision: revision,
    nodes,
    createdAt: revision === 1 ? NOW : LATER,
  } as unknown as TaskDagV2;
}

function state(taskId: string): TaskPlanningState {
  return {
    taskId,
    outcome: "not_started",
    completionContract: "pending",
    integration: "pending",
    combinedVerification: "pending",
  } as TaskPlanningState;
}

function requirement(beforeTaskIds: readonly string[], afterTaskIds: readonly string[]) {
  return {
    sourceWorkItemId: "source-1",
    requirementId: "R-1",
    beforeTaskIds,
    afterTaskIds,
    rationale: "Coverage is preserved.",
  } as TaskRequirementMapping;
}

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
  const store = createTaskGraphRevisionStateStore(db, validateTaskGraphRevision);
  const initial = createInitialTaskGraphRevision({
    runId: RUN_ID,
    dag: dag(1, [node("a", "repo-a")]),
    requirementMappings: [requirement([], ["a"])],
    rationale: "Initial analysis.",
    evidenceArtifactIds: [
      "artifact-initial",
    ] as unknown as TaskGraphRevisionRecord["evidenceArtifactIds"],
    committedAt: NOW,
  });
  store.initialize(initial);
  return { path: temporary.path, store, initial, clock, ids };
}

function proposal(
  initial: Awaited<ReturnType<typeof fixture>>["initial"],
): TaskGraphRevisionProposal {
  const change = {
    kind: "add",
    beforeTaskIds: [],
    afterTaskIds: ["b"],
    rationale: "Add the missing task.",
    evidenceArtifactIds: ["artifact-change"],
  } as unknown as TaskGraphChange;
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    graphId: initial.graphId,
    expectedGraphRevision: 1,
    expectedRevisionSha256: initial.revisionSha256,
    proposedDag: dag(2, [node("a", "repo-a"), node("b", "repo-b", ["a"])]),
    changes: [change],
    requirementMappings: [requirement(["a"], ["a", "b"])],
    rationale: "Analysis found missing work.",
    evidenceArtifactIds: ["artifact-proposal"],
    proposedAt: LATER,
  } as TaskGraphRevisionProposal;
}

describe("Q041 task graph revision state", () => {
  it("atomically commits accepted revisions and persists history across restart", async () => {
    const { store, initial, path, clock, ids } = await fixture();
    const accepted = store.propose({
      proposal: proposal(initial),
      taskStates: [state("a")],
      maxGraphRevisions: 5,
      decisionId: "decision-1",
      decidedAt: LATER,
    });
    expect(accepted.decision.outcome).toBe("accepted");
    expect(store.active(RUN_ID)?.graphRevision).toBe(2);
    expect(store.revisions(RUN_ID)).toHaveLength(2);
    expect(store.decisions(RUN_ID)).toHaveLength(1);

    expect(() =>
      internalHandle(db as StateDatabase)
        .prepare("UPDATE task_graph_revision SET graph_id = 'mutated'")
        .run(),
    ).toThrow(/immutable/);

    db?.close();
    db = openStateDatabase({ path, clock, ids });
    runMigrations(db);
    const reopened = createTaskGraphRevisionStateStore(db, validateTaskGraphRevision);
    expect(reopened.active(RUN_ID)?.revisionSha256).toBe(accepted.record?.revisionSha256);
    expect(reopened.revisions(RUN_ID)).toHaveLength(2);
  });

  it("records stale rejection without partially mutating the canonical graph", async () => {
    const { store, initial } = await fixture();
    const candidate = proposal(initial);
    store.propose({
      proposal: candidate,
      taskStates: [state("a")],
      maxGraphRevisions: 5,
      decisionId: "decision-1",
      decidedAt: LATER,
    });
    const rejected = store.propose({
      proposal: candidate,
      taskStates: [state("a"), state("b")],
      maxGraphRevisions: 5,
      decisionId: "decision-2",
      decidedAt: "2026-08-12T12:02:00.000Z",
    });
    expect(rejected.decision.outcome).toBe("rejected");
    expect(rejected.decision.diagnostics.map((entry) => entry.code)).toContain(
      "task-graph-revision.stale",
    );
    expect(store.active(RUN_ID)?.graphRevision).toBe(2);
    expect(store.revisions(RUN_ID)).toHaveLength(2);
    expect(store.decisions(RUN_ID)).toHaveLength(2);
    expect(store.decisions(RUN_ID)[1]?.proposal).toEqual(candidate);
  });

  it("rolls back every write when validator execution fails", async () => {
    const { initial } = await fixture();
    const throwing = createTaskGraphRevisionStateStore(db as StateDatabase, () => {
      throw new Error("injected validator failure");
    });
    expect(() =>
      throwing.propose({
        proposal: proposal(initial),
        taskStates: [state("a")],
        maxGraphRevisions: 5,
        decisionId: "decision-failure",
        decidedAt: LATER,
      }),
    ).toThrow(/injected validator failure/);
    expect(throwing.active(RUN_ID)?.graphRevision).toBe(1);
    expect(throwing.decisions(RUN_ID)).toEqual([]);
  });
});
