import { createRequire } from "node:module";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  HiddenDependencyFindingV1,
  HiddenDependencyReplanV1,
  SCHEMA_REGISTRY,
  TaskDagV1,
  TaskDagV2,
  TaskGraphRevisionDecisionV1,
  TaskGraphRevisionDecisionV2,
  TaskGraphRevisionProposalV1,
  TaskGraphRevisionProposalV2,
  TaskGraphRevisionRecordV1,
  TaskGraphRevisionRecordV2,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
for (const [id, schema] of SCHEMA_REGISTRY) ajv.addSchema(schema, id);

const NOW = "2026-08-12T12:00:00.000Z";
const HASH = "a".repeat(64);

function taskDagV2() {
  return {
    schemaVersion: 2,
    graphId: "graph-1",
    graphRevision: 2,
    nodes: [
      {
        pipelineId: "careful",
        profileId: "builder",
        accountId: null,
        task: {
          schemaVersion: 1,
          taskId: "task-1",
          revision: 1,
          revisionSha256: HASH,
          predecessorRevisionSha256: null,
          analysisPacketId: "analysis-1",
          analysisPacketSha256: HASH,
          objective: "Build Q041.",
          rationale: "Required by Q041.",
          primaryRepositoryId: "repo-1",
          readSet: ["repo-1"],
          writeSet: ["repo-1"],
          excludedRepositories: [],
          dependencies: [],
          artifacts: [],
          verification: [],
          createdAt: NOW,
        },
      },
    ],
    createdAt: NOW,
  };
}

describe("Q041 task-graph revision contracts", () => {
  it("keeps V1 registered and deliberately registers V2 and the revision family", () => {
    expect([
      TaskDagV1.$id,
      TaskDagV2.$id,
      TaskGraphRevisionProposalV1.$id,
      TaskGraphRevisionDecisionV1.$id,
      TaskGraphRevisionRecordV1.$id,
      TaskGraphRevisionProposalV2.$id,
      TaskGraphRevisionDecisionV2.$id,
      TaskGraphRevisionRecordV2.$id,
      HiddenDependencyFindingV1.$id,
      HiddenDependencyReplanV1.$id,
    ]).toEqual([
      "heniek://contract/TaskDag/v1",
      "heniek://contract/TaskDag/v2",
      "heniek://contract/TaskGraphRevisionProposal/v1",
      "heniek://contract/TaskGraphRevisionDecision/v1",
      "heniek://contract/TaskGraphRevisionRecord/v1",
      "heniek://contract/TaskGraphRevisionProposal/v2",
      "heniek://contract/TaskGraphRevisionDecision/v2",
      "heniek://contract/TaskGraphRevisionRecord/v2",
      "heniek://contract/HiddenDependencyFinding/v1",
      "heniek://contract/HiddenDependencyReplan/v1",
    ]);
  });

  it("requires a provider-neutral pipeline binding and rejects unknown fields", () => {
    const validate = ajv.getSchema(TaskDagV2.$id ?? "");
    expect(validate?.(taskDagV2()), JSON.stringify(validate?.errors)).toBe(true);
    const { pipelineId: _pipelineId, ...withoutPipeline } = taskDagV2().nodes[0] ?? {};
    expect(validate?.({ ...taskDagV2(), nodes: [withoutPipeline] })).toBe(false);
    expect(validate?.({ ...taskDagV2(), providerPayload: {} })).toBe(false);
  });

  it("validates provider-neutral hidden-dependency evidence and replanning state", () => {
    const finding = {
      schemaVersion: 1,
      findingId: "finding-1",
      runId: "run-1",
      graphId: "graph-1",
      graphRevision: 1,
      revisionSha256: HASH,
      reporterTaskId: "task-1",
      prerequisiteTaskIds: ["task-0"],
      affectedTaskIds: ["task-1"],
      rationale: "The task needs a predecessor contract.",
      evidenceArtifactIds: ["artifact-finding"],
      discoveredAt: NOW,
    };
    const proposal = {
      schemaVersion: 2,
      runId: "run-1",
      graphId: "graph-1",
      expectedGraphRevision: 1,
      expectedRevisionSha256: HASH,
      proposedDag: taskDagV2(),
      changes: [
        {
          kind: "supersede",
          beforeTaskIds: ["task-old"],
          afterTaskIds: ["task-1"],
          rationale: "Replace interrupted work.",
          evidenceArtifactIds: ["artifact-finding"],
        },
      ],
      requirementMappings: [
        {
          sourceWorkItemId: "source-1",
          requirementId: "R-1",
          beforeTaskIds: ["task-old"],
          afterTaskIds: ["task-1"],
          rationale: "Coverage is preserved.",
        },
      ],
      rationale: "Replan safely.",
      evidenceArtifactIds: ["artifact-finding"],
      proposedAt: NOW,
      trigger: {
        kind: "hidden_dependency",
        findingId: "finding-1",
        interruptedTaskIds: ["task-old"],
      },
    };
    const replan = {
      schemaVersion: 1,
      replanId: "replan-1",
      finding,
      proposal,
      lifecycle: "quiescing",
      interruptedTaskIds: ["task-old"],
      replacementTaskIds: ["task-1"],
      decisionId: null,
      resultingGraphRevision: null,
      blocker: null,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const validateFinding = ajv.getSchema(HiddenDependencyFindingV1.$id ?? "");
    const validateReplan = ajv.getSchema(HiddenDependencyReplanV1.$id ?? "");
    expect(validateFinding?.(finding), JSON.stringify(validateFinding?.errors)).toBe(true);
    expect(validateReplan?.(replan), JSON.stringify(validateReplan?.errors)).toBe(true);
    expect(validateFinding?.({ ...finding, providerPayload: {} })).toBe(false);
  });
});
