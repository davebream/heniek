import { createRequire } from "node:module";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  ExecutionTaskRevisionV1,
  SCHEMA_REGISTRY,
  TaskWorkspaceBindingV1,
  WholeCodebaseAnalysisPacketV1,
  WorkspaceDiffInventoryV1,
} from "../src/index.js";

const require = createRequire(import.meta.url);
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
for (const schema of SCHEMA_REGISTRY.values()) ajv.addSchema(schema);

function validate(schema: { readonly $id?: string }, value: unknown): boolean {
  const validator = schema.$id === undefined ? undefined : ajv.getSchema(schema.$id);
  if (validator === undefined) throw new Error("schema was not registered");
  return validator(value) as boolean;
}

const now = "2026-08-12T10:00:00.000Z";
const sha = "a".repeat(40);
const digest = "b".repeat(64);

describe("Q037 public contracts", () => {
  it("registers additive whole-Codebase, task, binding, and diff schemas", () => {
    expect(WholeCodebaseAnalysisPacketV1.$id).toBe(
      "heniek://contract/WholeCodebaseAnalysisPacket/v1",
    );
    expect(ExecutionTaskRevisionV1.$id).toBe("heniek://contract/ExecutionTaskRevision/v1");
    expect(TaskWorkspaceBindingV1.$id).toBe("heniek://contract/TaskWorkspaceBinding/v1");
    expect(WorkspaceDiffInventoryV1.$id).toBe("heniek://contract/WorkspaceDiffInventory/v1");
  });

  it("validates a packet whose source repository is not the task primary", () => {
    expect(
      validate(WholeCodebaseAnalysisPacketV1, {
        schemaVersion: 1,
        packetId: "analysis-1",
        codebaseId: "cb-1",
        workspaceId: "ws-1",
        sourceRepositoryId: "repo-api",
        registrationSha256: digest,
        configurationSha256: "c".repeat(64),
        effectiveInstructions: {
          schemaVersion: 1,
          provider: "codex",
          generatedAt: now,
          readiness: "ready",
          reportSha256: "d".repeat(64),
          effectiveContentSha256: "e".repeat(64),
          sources: [],
          unresolvedConflicts: [],
        },
        repositories: [
          {
            repositoryId: "repo-api",
            name: "api",
            checkoutPath: "/workspace/api",
            base: { kind: "managed-pin", sha },
            index: {
              maxEntries: 10_000,
              maxBytes: 1_048_576,
              observedEntries: 1,
              observedBytes: 100,
              emittedEntries: 1,
              emittedBytes: 100,
              truncated: false,
              entries: [
                { path: "README.md", mode: "100644", type: "blob", objectId: sha, byteLength: 7 },
              ],
            },
          },
        ],
        createdAt: now,
      }),
    ).toBe(true);
  });

  it("rejects malformed task revisions and accepts exact workspace evidence", () => {
    const task = {
      schemaVersion: 1,
      taskId: "task-1",
      revision: 1,
      revisionSha256: digest,
      predecessorRevisionSha256: null,
      analysisPacketId: "analysis-1",
      analysisPacketSha256: "c".repeat(64),
      objective: "Implement identity across repositories.",
      rationale: "The issue repository only exposes the boundary.",
      primaryRepositoryId: "repo-identity",
      readSet: ["repo-api", "repo-identity"],
      writeSet: ["repo-identity"],
      excludedRepositories: [],
      dependencies: [],
      artifacts: [],
      verification: [],
      createdAt: now,
    };
    expect(validate(ExecutionTaskRevisionV1, task)).toBe(true);
    expect(validate(ExecutionTaskRevisionV1, { ...task, revision: 0 })).toBe(false);
    expect(
      validate(TaskWorkspaceBindingV1, {
        schemaVersion: 1,
        workspaceId: "ws-1",
        variantId: "variant-1",
        taskId: "task-1",
        taskRevision: 1,
        taskRevisionSha256: digest,
        repositories: [
          {
            repositoryId: "repo-identity",
            access: "write",
            expectedHeadSha: sha,
            leaseId: "lease-1",
            fencingRevision: 1,
          },
        ],
        boundAt: now,
      }),
    ).toBe(true);
    expect(
      validate(WorkspaceDiffInventoryV1, {
        schemaVersion: 1,
        workspaceId: "ws-1",
        variantId: "variant-1",
        taskId: "task-1",
        taskRevision: 1,
        taskRevisionSha256: digest,
        classification: "replanning-required",
        repositories: [
          {
            repositoryId: "repo-api",
            access: "read-only",
            baseSha: sha,
            headSha: sha,
            changedPaths: [{ path: "src/api.ts", states: ["unstaged"] }],
            observedChangedPaths: 1,
            emittedBytes: 48,
            truncated: false,
            undeclaredWrite: true,
          },
        ],
        undeclaredWriteRepositories: ["repo-api"],
        recordedAt: now,
      }),
    ).toBe(true);
  });
});
