import { createRequire } from "node:module";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  SCHEMA_REGISTRY,
  TaskDagV1,
  TaskDagValidationResultV1,
  TaskWavePlanningSnapshotV1,
  TaskWavePlanV1,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
for (const [id, schema] of SCHEMA_REGISTRY) ajv.addSchema(schema, id);

const NOW = "2026-08-12T12:00:00.000Z";
const HASH = "a".repeat(64);

function taskDag() {
  return {
    schemaVersion: 1,
    graphId: "graph-1",
    graphRevision: 1,
    nodes: [
      {
        profileId: "builder",
        accountId: "account-1",
        task: {
          schemaVersion: 1,
          taskId: "task-1",
          revision: 1,
          revisionSha256: HASH,
          predecessorRevisionSha256: null,
          analysisPacketId: "analysis-1",
          analysisPacketSha256: HASH,
          objective: "Build the task graph.",
          rationale: "Q040 requires deterministic whole-task waves.",
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

describe("Q040 task-graph contracts", () => {
  it("registers the versioned DAG, snapshot, validation, and wave-plan family", () => {
    expect([
      TaskDagV1.$id,
      TaskWavePlanningSnapshotV1.$id,
      TaskDagValidationResultV1.$id,
      TaskWavePlanV1.$id,
    ]).toEqual([
      "heniek://contract/TaskDag/v1",
      "heniek://contract/TaskWavePlanningSnapshot/v1",
      "heniek://contract/TaskDagValidationResult/v1",
      "heniek://contract/TaskWavePlan/v1",
    ]);
    for (const schema of [
      TaskDagV1,
      TaskWavePlanningSnapshotV1,
      TaskDagValidationResultV1,
      TaskWavePlanV1,
    ]) {
      expect(ajv.getSchema(schema.$id ?? "")).toBeTypeOf("function");
    }
  });

  it("accepts a provider-neutral DAG and rejects unknown fields", () => {
    const validate = ajv.getSchema(TaskDagV1.$id ?? "");
    expect(validate?.(taskDag()), JSON.stringify(validate?.errors)).toBe(true);
    expect(validate?.({ ...taskDag(), providerPayload: {} })).toBe(false);
  });

  it("accepts a complete immutable planning snapshot", () => {
    const snapshot = {
      schemaVersion: 1,
      dag: taskDag(),
      waveOrdinal: 1,
      unresolvedGraphRevision: false,
      tasks: [
        {
          taskId: "task-1",
          outcome: "not_started",
          completionContract: "pending",
          integration: "pending",
          combinedVerification: "pending",
        },
      ],
      profiles: [{ profileId: "builder", available: true }],
      accounts: [{ accountId: "account-1", activeRuns: 0, maxConcurrentRuns: 2 }],
      writerLeases: [{ repositoryId: "repo-1", available: true, holderTaskId: null }],
      activeWorkers: 0,
      maxConcurrentWorkers: 2,
      recordedAt: NOW,
    };
    const validate = ajv.getSchema(TaskWavePlanningSnapshotV1.$id ?? "");
    expect(validate?.(snapshot), JSON.stringify(validate?.errors)).toBe(true);
  });
});
