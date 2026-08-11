import { type Static, Type } from "@sinclair/typebox";
import { ExecutionTaskId } from "../execution-backend/ids.js";
import { versioned } from "../kernel/index.js";
import { VerifyCheckV1 } from "../pipeline/operations.js";
import { AnalysisPacketId, RepositoryId } from "./ids.js";

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const IsoDateTime = Type.String({ format: "date-time" });
const SafeRelativePath = Type.String({
  minLength: 1,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\u0000).+$",
});

const ExcludedRepository = Type.Object(
  {
    repositoryId: RepositoryId,
    rationale: Type.String({ minLength: 1, maxLength: 8192 }),
  },
  { additionalProperties: false },
);

const TaskArtifactRequirement = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 128 }),
    contract: Type.String({ minLength: 1, maxLength: 1024 }),
    repositoryId: Type.Union([RepositoryId, Type.Null()]),
    path: Type.Union([SafeRelativePath, Type.Null()]),
    required: Type.Boolean(),
  },
  { additionalProperties: false },
);

const TaskVerificationCheck = Type.Object(
  {
    repositoryId: RepositoryId,
    check: Type.Ref(VerifyCheckV1),
  },
  { additionalProperties: false },
);

/**
 * Q037's immutable execution-task revision. This is deliberately narrower than
 * Q039's future TaskSource snapshots and Q041's task-graph revisions.
 */
export const ExecutionTaskRevisionV1 = versioned("ExecutionTaskRevision", 1, {
  taskId: ExecutionTaskId,
  revision: Type.Integer({ minimum: 1 }),
  revisionSha256: Sha256,
  predecessorRevisionSha256: Type.Union([Sha256, Type.Null()]),
  analysisPacketId: AnalysisPacketId,
  analysisPacketSha256: Sha256,
  objective: Type.String({ minLength: 1, maxLength: 65536 }),
  rationale: Type.String({ minLength: 1, maxLength: 65536 }),
  primaryRepositoryId: RepositoryId,
  readSet: Type.Array(RepositoryId, { minItems: 1, uniqueItems: true }),
  writeSet: Type.Array(RepositoryId, { uniqueItems: true }),
  excludedRepositories: Type.Array(ExcludedRepository),
  dependencies: Type.Array(ExecutionTaskId, { uniqueItems: true }),
  artifacts: Type.Array(TaskArtifactRequirement),
  verification: Type.Array(TaskVerificationCheck),
  createdAt: IsoDateTime,
});

export type ExecutionTaskRevision = Static<typeof ExecutionTaskRevisionV1>;
