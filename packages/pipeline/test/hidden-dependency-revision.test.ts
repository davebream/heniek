import type {
  HiddenDependencyFinding,
  RunId,
  TaskDagV2,
  TaskGraphRevisionProposal,
  TaskGraphRevisionRecord,
  TaskPlanningState,
  TaskRequirementMapping,
} from "@heniek/contracts";
import { describe, expect, it } from "vitest";
import {
  createInitialTaskGraphRevision,
  validateTaskGraphRevision,
} from "../src/task-graph/revise.js";

const NOW = "2026-08-12T12:00:00.000Z";
const LATER = "2026-08-12T12:01:00.000Z";
const HASH = "a".repeat(64);

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
  } as unknown as TaskDagV2["nodes"][number];
}

function dag(revision: number, nodes: TaskDagV2["nodes"]): TaskDagV2 {
  return {
    schemaVersion: 2,
    graphId: "graph-1",
    graphRevision: revision,
    nodes,
    createdAt: revision === 1 ? NOW : LATER,
  } as TaskDagV2;
}

function planning(taskId: string, outcome: TaskPlanningState["outcome"]): TaskPlanningState {
  return {
    taskId,
    outcome,
    completionContract: "pending",
    integration: "pending",
    combinedVerification: "pending",
  } as TaskPlanningState;
}

function fixture() {
  const current = createInitialTaskGraphRevision({
    runId: "run-1" as RunId,
    dag: dag(1, [node("T4", "repo-c")]),
    requirementMappings: [
      {
        sourceWorkItemId: "source-1",
        requirementId: "R-1",
        beforeTaskIds: [],
        afterTaskIds: ["T4"],
        rationale: "Initial coverage.",
      },
    ] as unknown as readonly TaskRequirementMapping[],
    rationale: "Initial graph.",
    evidenceArtifactIds: [
      "artifact-initial",
    ] as unknown as TaskGraphRevisionRecord["evidenceArtifactIds"],
    committedAt: NOW,
  });
  const finding = {
    schemaVersion: 1,
    findingId: "finding-1",
    runId: current.runId,
    graphId: current.graphId,
    graphRevision: current.graphRevision,
    revisionSha256: current.revisionSha256,
    reporterTaskId: "T4",
    prerequisiteTaskIds: ["T2"],
    affectedTaskIds: ["T4"],
    rationale: "T4 requires T2 output.",
    evidenceArtifactIds: ["artifact-finding"],
    discoveredAt: LATER,
  } as unknown as HiddenDependencyFinding;
  const proposal = {
    schemaVersion: 2,
    runId: current.runId,
    graphId: current.graphId,
    expectedGraphRevision: current.graphRevision,
    expectedRevisionSha256: current.revisionSha256,
    proposedDag: dag(2, [node("T4-replacement", "repo-c")]),
    changes: [
      {
        kind: "supersede",
        beforeTaskIds: ["T4"],
        afterTaskIds: ["T4-replacement"],
        rationale: "Restart after the hidden prerequisite.",
        evidenceArtifactIds: ["artifact-finding"],
      },
    ],
    requirementMappings: [
      {
        sourceWorkItemId: "source-1",
        requirementId: "R-1",
        beforeTaskIds: ["T4"],
        afterTaskIds: ["T4-replacement"],
        rationale: "Coverage moves to the safe replacement.",
      },
    ],
    rationale: "Replan around the hidden prerequisite.",
    evidenceArtifactIds: ["artifact-finding"],
    proposedAt: LATER,
    trigger: {
      kind: "hidden_dependency",
      findingId: finding.findingId,
      interruptedTaskIds: ["T4"],
    },
  } as unknown as Extract<TaskGraphRevisionProposal, { schemaVersion: 2 }>;
  return { current, finding, proposal };
}

describe("Q045 hidden-dependency graph revision", () => {
  it("accepts only an evidence-authorized supersession of a cancelled task", () => {
    const { current, finding, proposal } = fixture();
    const outcome = validateTaskGraphRevision(
      {
        current,
        taskStates: [planning("T4", "cancelled")],
        maxGraphRevisions: 5,
        decisionId: "decision-1",
        decidedAt: LATER,
        hiddenDependencyFinding: finding,
      },
      proposal,
    );
    expect(outcome.decision.outcome, JSON.stringify(outcome.decision.diagnostics)).toBe("accepted");
    expect(outcome.record).toMatchObject({
      schemaVersion: 2,
      graphRevision: 2,
      trigger: { findingId: "finding-1" },
    });
  });

  it("keeps V1 started-task immutability and rejects missing finding authorization", () => {
    const { current, finding, proposal } = fixture();
    const withoutFinding = validateTaskGraphRevision(
      {
        current,
        taskStates: [planning("T4", "cancelled")],
        maxGraphRevisions: 5,
        decisionId: "decision-1",
        decidedAt: LATER,
      },
      proposal,
    );
    expect(withoutFinding.decision.diagnostics.map((entry) => entry.code)).toContain(
      "task-graph-revision.hidden-dependency-evidence-mismatch",
    );

    const v1 = {
      ...proposal,
      schemaVersion: 1,
      trigger: undefined,
    } as unknown as TaskGraphRevisionProposal;
    const legacy = validateTaskGraphRevision(
      {
        current,
        taskStates: [planning("T4", "cancelled")],
        maxGraphRevisions: 5,
        decisionId: "decision-2",
        decidedAt: LATER,
      },
      v1,
    );
    expect(legacy.decision.diagnostics.map((entry) => entry.code)).toContain(
      "task-graph-revision.started-task",
    );

    const unrelatedSupersede = validateTaskGraphRevision(
      {
        current,
        taskStates: [planning("T4", "cancelled")],
        maxGraphRevisions: 5,
        decisionId: "decision-3",
        decidedAt: LATER,
        hiddenDependencyFinding: finding,
      },
      {
        ...proposal,
        changes: [
          ...proposal.changes,
          {
            kind: "supersede",
            beforeTaskIds: ["T2"],
            afterTaskIds: ["T2-replacement"],
            rationale: "Unrelated replacement must not inherit authorization.",
            evidenceArtifactIds: ["artifact-finding"],
          },
        ],
      } as typeof proposal,
    );
    expect(unrelatedSupersede.decision.diagnostics.map((entry) => entry.code)).toContain(
      "task-graph-revision.hidden-dependency-supersede-unauthorized",
    );
  });
});
