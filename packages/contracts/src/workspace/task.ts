import { type Static, Type } from "@sinclair/typebox";
import { ExecutionTaskId } from "../execution-backend/ids.js";
import { versioned } from "../kernel/index.js";
import { RepositoryId, WorkspaceId, WorkspaceVariantId } from "../run/ids.js";

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const GitObjectId = Type.String({ pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" });
const IsoDateTime = Type.String({ format: "date-time" });
const SafeRelativePath = Type.String({
  minLength: 1,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\u0000).+$",
});

const TaskWorkspaceRepositoryBinding = Type.Object(
  {
    repositoryId: RepositoryId,
    access: Type.Union([Type.Literal("write"), Type.Literal("read-only")]),
    expectedHeadSha: GitObjectId,
    leaseId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    fencingRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const TaskWorkspaceBindingV1 = versioned("TaskWorkspaceBinding", 1, {
  workspaceId: WorkspaceId,
  variantId: WorkspaceVariantId,
  taskId: ExecutionTaskId,
  taskRevision: Type.Integer({ minimum: 1 }),
  taskRevisionSha256: Sha256,
  repositories: Type.Array(TaskWorkspaceRepositoryBinding, { minItems: 1 }),
  boundAt: IsoDateTime,
});

const WorkspaceChangedPath = Type.Object(
  {
    path: SafeRelativePath,
    states: Type.Array(
      Type.Union([
        Type.Literal("committed"),
        Type.Literal("staged"),
        Type.Literal("unstaged"),
        Type.Literal("untracked"),
      ]),
      { minItems: 1, uniqueItems: true },
    ),
  },
  { additionalProperties: false },
);

const WorkspaceRepositoryDiff = Type.Object(
  {
    repositoryId: RepositoryId,
    access: Type.Union([Type.Literal("write"), Type.Literal("read-only")]),
    baseSha: GitObjectId,
    headSha: GitObjectId,
    changedPaths: Type.Array(WorkspaceChangedPath, { maxItems: 10000 }),
    observedChangedPaths: Type.Integer({ minimum: 0 }),
    emittedBytes: Type.Integer({ minimum: 0, maximum: 1048576 }),
    truncated: Type.Boolean(),
    undeclaredWrite: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const WorkspaceDiffInventoryV1 = versioned("WorkspaceDiffInventory", 1, {
  workspaceId: WorkspaceId,
  variantId: WorkspaceVariantId,
  taskId: ExecutionTaskId,
  taskRevision: Type.Integer({ minimum: 1 }),
  taskRevisionSha256: Sha256,
  classification: Type.Union([
    Type.Literal("clean"),
    Type.Literal("declared-changes"),
    Type.Literal("replanning-required"),
  ]),
  repositories: Type.Array(WorkspaceRepositoryDiff, { minItems: 1 }),
  undeclaredWriteRepositories: Type.Array(RepositoryId, { uniqueItems: true }),
  recordedAt: IsoDateTime,
});

export type TaskWorkspaceBinding = Static<typeof TaskWorkspaceBindingV1>;
export type WorkspaceDiffInventory = Static<typeof WorkspaceDiffInventoryV1>;
