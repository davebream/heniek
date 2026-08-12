import { createRequire } from "node:module";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  SCHEMA_REGISTRY,
  TaskDagV1,
  TaskDagV2,
  TaskGraphRevisionDecisionV1,
  TaskGraphRevisionProposalV1,
  TaskGraphRevisionRecordV1,
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
    ]).toEqual([
      "heniek://contract/TaskDag/v1",
      "heniek://contract/TaskDag/v2",
      "heniek://contract/TaskGraphRevisionProposal/v1",
      "heniek://contract/TaskGraphRevisionDecision/v1",
      "heniek://contract/TaskGraphRevisionRecord/v1",
    ]);
  });

  it("requires a provider-neutral pipeline binding and rejects unknown fields", () => {
    const validate = ajv.getSchema(TaskDagV2.$id ?? "");
    expect(validate?.(taskDagV2()), JSON.stringify(validate?.errors)).toBe(true);
    const { pipelineId: _pipelineId, ...withoutPipeline } = taskDagV2().nodes[0] ?? {};
    expect(validate?.({ ...taskDagV2(), nodes: [withoutPipeline] })).toBe(false);
    expect(validate?.({ ...taskDagV2(), providerPayload: {} })).toBe(false);
  });
});
