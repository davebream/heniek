import { type Static, Type } from "@sinclair/typebox";
import { ExecutionTaskId } from "../execution-backend/index.js";
import { versioned } from "../kernel/index.js";
import { RepositoryId, RunId, WorkspaceVariantId } from "../run/index.js";

const IsoDateTime = Type.String({ format: "date-time" });
const GitObjectId = Type.String({ pattern: "^[0-9a-f]{40}(?:[0-9a-f]{24})?$" });

export const EpicRepositoryBranchV1 = versioned("EpicRepositoryBranch", 1, {
  runId: RunId,
  repositoryId: RepositoryId,
  branchRef: Type.String({ minLength: 1, maxLength: 256 }),
  remote: Type.String({ minLength: 1, maxLength: 256 }),
  remoteBaseRef: Type.String({ minLength: 1, maxLength: 256 }),
  remoteBaseSha: GitObjectId,
  expectedLocalSha: GitObjectId,
  observedRemoteSha: Type.Union([GitObjectId, Type.Null()]),
  lifecycle: Type.Union([Type.Literal("ready"), Type.Literal("reconciliation_required")]),
  revision: Type.Integer({ minimum: 1 }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const TaskIntegrationRepository = Type.Object(
  {
    repositoryId: RepositoryId,
    sourceSha: GitObjectId,
    expectedTargetSha: GitObjectId,
    candidateSha: Type.Union([GitObjectId, Type.Null()]),
    resultSha: Type.Union([GitObjectId, Type.Null()]),
    classification: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  },
  { additionalProperties: false },
);

export const TaskIntegrationLedgerEntryV1 = versioned("TaskIntegrationLedgerEntry", 1, {
  integrationId: Type.String({ minLength: 1, maxLength: 512 }),
  runId: RunId,
  taskId: ExecutionTaskId,
  graphRevision: Type.Integer({ minimum: 1 }),
  waveOrdinal: Type.Integer({ minimum: 1 }),
  integrationOrdinal: Type.Integer({ minimum: 1 }),
  variantId: WorkspaceVariantId,
  lifecycle: Type.Union([
    Type.Literal("queued"),
    Type.Literal("prepared"),
    Type.Literal("verified"),
    Type.Literal("integrated"),
    Type.Literal("failed"),
    Type.Literal("reconciliation_required"),
  ]),
  repositories: Type.Array(TaskIntegrationRepository, { uniqueItems: true, maxItems: 4096 }),
  verificationReportId: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  verification: Type.Union([
    Type.Literal("pending"),
    Type.Literal("passed"),
    Type.Literal("failed"),
  ]),
  revision: Type.Integer({ minimum: 1 }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const TaskIntegrationTraceV1 = versioned("TaskIntegrationTrace", 1, {
  traceId: Type.String({ minLength: 1, maxLength: 512 }),
  integrationId: Type.String({ minLength: 1, maxLength: 512 }),
  runId: RunId,
  taskId: ExecutionTaskId,
  sequence: Type.Integer({ minimum: 1 }),
  repositoryId: Type.Union([RepositoryId, Type.Null()]),
  phase: Type.Union([
    Type.Literal("intent_recorded"),
    Type.Literal("source_observed"),
    Type.Literal("target_observed"),
    Type.Literal("merge_prepared"),
    Type.Literal("verification_started"),
    Type.Literal("verification_finished"),
    Type.Literal("ref_update_attempted"),
    Type.Literal("ref_update_observed"),
    Type.Literal("adopted"),
    Type.Literal("completed"),
    Type.Literal("reconciliation_required"),
  ]),
  expectedSha: Type.Union([GitObjectId, Type.Null()]),
  observedSha: Type.Union([GitObjectId, Type.Null()]),
  candidateSha: Type.Union([GitObjectId, Type.Null()]),
  verificationReportId: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  classification: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  recordedAt: IsoDateTime,
});

export type EpicRepositoryBranch = Static<typeof EpicRepositoryBranchV1>;
export type TaskIntegrationLedgerEntry = Static<typeof TaskIntegrationLedgerEntryV1>;
export type TaskIntegrationTrace = Static<typeof TaskIntegrationTraceV1>;
