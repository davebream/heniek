import { type Static, Type } from "@sinclair/typebox";
import { AccountId } from "../configuration/index.js";
import { ExecutionTaskId, ProfileId } from "../execution-backend/index.js";
import { versioned } from "../kernel/index.js";
import { PipelineId } from "../pipeline/index.js";
import { ExecutionTaskRevisionV1, RepositoryId, RunId } from "../run/index.js";
import { TaskGraphId } from "./ids.js";

const IsoDateTime = Type.String({ format: "date-time" });

export const TaskDagNodeV1 = Type.Object(
  {
    task: Type.Ref(ExecutionTaskRevisionV1),
    profileId: ProfileId,
    accountId: Type.Union([AccountId, Type.Null()]),
  },
  { additionalProperties: false },
);

/** Immutable whole-task scheduling graph. Internal pipeline stages never appear here. */
export const TaskDagV1 = versioned("TaskDag", 1, {
  graphId: TaskGraphId,
  graphRevision: Type.Integer({ minimum: 1 }),
  nodes: Type.Array(TaskDagNodeV1, { minItems: 1, maxItems: 4096 }),
  createdAt: IsoDateTime,
});

export const TaskDagNodeV2 = Type.Object(
  {
    task: Type.Ref(ExecutionTaskRevisionV1),
    pipelineId: PipelineId,
    profileId: ProfileId,
    accountId: Type.Union([AccountId, Type.Null()]),
  },
  { additionalProperties: false },
);

/** Q041 graph shape: each whole task names the mini-pipeline it will execute. */
export const TaskDagV2 = versioned("TaskDag", 2, {
  graphId: TaskGraphId,
  graphRevision: Type.Integer({ minimum: 1 }),
  nodes: Type.Array(TaskDagNodeV2, { minItems: 1, maxItems: 4096 }),
  createdAt: IsoDateTime,
});

export const TaskPlanningOutcome = Type.Union([
  Type.Literal("not_started"),
  Type.Literal("active"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("blocked"),
]);

const CompletionGate = Type.Union([
  Type.Literal("pending"),
  Type.Literal("passed"),
  Type.Literal("failed"),
]);
const IntegrationGate = Type.Union([
  Type.Literal("pending"),
  Type.Literal("passed"),
  Type.Literal("reconciliation_required"),
]);

export const TaskPlanningState = Type.Object(
  {
    taskId: ExecutionTaskId,
    outcome: TaskPlanningOutcome,
    completionContract: CompletionGate,
    integration: IntegrationGate,
    combinedVerification: CompletionGate,
  },
  { additionalProperties: false },
);

const ProfileCapacitySnapshot = Type.Object(
  { profileId: ProfileId, available: Type.Boolean() },
  { additionalProperties: false },
);

const AccountCapacitySnapshot = Type.Object(
  {
    accountId: AccountId,
    activeRuns: Type.Integer({ minimum: 0 }),
    maxConcurrentRuns: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const WriterLeaseSnapshot = Type.Object(
  {
    repositoryId: RepositoryId,
    available: Type.Boolean(),
    holderTaskId: Type.Union([ExecutionTaskId, Type.Null()]),
  },
  { additionalProperties: false },
);

/** Complete, versioned input to one pure wave-planning decision. */
export const TaskWavePlanningSnapshotV1 = versioned("TaskWavePlanningSnapshot", 1, {
  dag: Type.Ref(TaskDagV1),
  waveOrdinal: Type.Integer({ minimum: 1 }),
  unresolvedGraphRevision: Type.Boolean(),
  tasks: Type.Array(TaskPlanningState, { minItems: 1, maxItems: 4096 }),
  profiles: Type.Array(ProfileCapacitySnapshot, { maxItems: 4096 }),
  accounts: Type.Array(AccountCapacitySnapshot, { maxItems: 4096 }),
  writerLeases: Type.Array(WriterLeaseSnapshot, { maxItems: 4096 }),
  activeWorkers: Type.Integer({ minimum: 0 }),
  maxConcurrentWorkers: Type.Integer({ minimum: 1 }),
  recordedAt: IsoDateTime,
});

/** Q042 snapshot shape: the executable V2 DAG carries each task's pipeline binding. */
export const TaskWavePlanningSnapshotV2 = versioned("TaskWavePlanningSnapshot", 2, {
  dag: Type.Ref(TaskDagV2),
  waveOrdinal: Type.Integer({ minimum: 1 }),
  unresolvedGraphRevision: Type.Boolean(),
  tasks: Type.Array(TaskPlanningState, { minItems: 1, maxItems: 4096 }),
  profiles: Type.Array(ProfileCapacitySnapshot, { maxItems: 4096 }),
  accounts: Type.Array(AccountCapacitySnapshot, { maxItems: 4096 }),
  writerLeases: Type.Array(WriterLeaseSnapshot, { maxItems: 4096 }),
  activeWorkers: Type.Integer({ minimum: 0 }),
  maxConcurrentWorkers: Type.Integer({ minimum: 1 }),
  recordedAt: IsoDateTime,
});

export const TaskLifecyclePhase = Type.Union([
  Type.Literal("not_started"),
  Type.Literal("dispatching"),
  Type.Literal("active"),
  Type.Literal("retrying"),
  Type.Literal("cancelling"),
  Type.Literal("recovery_required"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("blocked"),
]);

export const TaskPropagationReasonV1 = versioned("TaskPropagationReason", 1, {
  code: Type.Union([
    Type.Literal("predecessor_failed"),
    Type.Literal("predecessor_cancelled"),
    Type.Literal("predecessor_blocked"),
  ]),
  immediateTaskId: ExecutionTaskId,
  rootTaskId: ExecutionTaskId,
  path: Type.Array(ExecutionTaskId, { minItems: 2, uniqueItems: true, maxItems: 4096 }),
});

export const TaskLifecycleProjectionV1 = versioned("TaskLifecycleProjection", 1, {
  runId: RunId,
  taskId: ExecutionTaskId,
  graphRevision: Type.Integer({ minimum: 1 }),
  phase: TaskLifecyclePhase,
  childRunId: Type.Union([RunId, Type.Null()]),
  attemptOrdinal: Type.Integer({ minimum: 0 }),
  retryCount: Type.Integer({ minimum: 0 }),
  blockReason: Type.Union([Type.Ref(TaskPropagationReasonV1), Type.Null()]),
  completionContract: CompletionGate,
  integration: IntegrationGate,
  combinedVerification: CompletionGate,
  revision: Type.Integer({ minimum: 1 }),
  updatedAt: IsoDateTime,
});

export const TaskCapacityScope = Type.Union([
  Type.Literal("global"),
  Type.Literal("account"),
  Type.Literal("workspace"),
  Type.Literal("repository"),
]);

export const TaskCapacityLeaseV1 = versioned("TaskCapacityLease", 1, {
  leaseId: Type.String({ minLength: 1, maxLength: 256 }),
  runId: RunId,
  taskId: ExecutionTaskId,
  scope: TaskCapacityScope,
  resourceId: Type.String({ minLength: 1, maxLength: 1024 }),
  fencingRevision: Type.Integer({ minimum: 1 }),
  state: Type.Union([Type.Literal("active"), Type.Literal("released")]),
  acquiredAt: IsoDateTime,
  releasedAt: Type.Union([IsoDateTime, Type.Null()]),
});

export const TaskDispatchRecordV1 = versioned("TaskDispatchRecord", 1, {
  dispatchId: Type.String({ minLength: 1, maxLength: 256 }),
  runId: RunId,
  taskId: ExecutionTaskId,
  graphRevision: Type.Integer({ minimum: 1 }),
  waveOrdinal: Type.Integer({ minimum: 1 }),
  childRunId: RunId,
  pipelineId: PipelineId,
  profileId: ProfileId,
  accountId: Type.Union([AccountId, Type.Null()]),
  workspaceId: Type.String({ minLength: 1, maxLength: 1024 }),
  repositoryIds: Type.Array(RepositoryId, { uniqueItems: true, maxItems: 4096 }),
  recordedAt: IsoDateTime,
});

export const TaskWaveAuditEventV1 = versioned("TaskWaveAuditEvent", 1, {
  eventId: Type.String({ minLength: 1, maxLength: 256 }),
  runId: RunId,
  taskId: Type.Union([ExecutionTaskId, Type.Null()]),
  kind: Type.Union([
    Type.Literal("wave_planned"),
    Type.Literal("capacity_acquired"),
    Type.Literal("task_dispatched"),
    Type.Literal("task_retrying"),
    Type.Literal("cancellation_requested"),
    Type.Literal("task_settled"),
    Type.Literal("task_blocked"),
    Type.Literal("capacity_released"),
    Type.Literal("recovery_required"),
  ]),
  detail: Type.Record(Type.String(), Type.Unknown()),
  recordedAt: IsoDateTime,
});

export const TaskDagDiagnostic = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 128 }),
    message: Type.String({ minLength: 1, maxLength: 8192 }),
    taskIds: Type.Array(ExecutionTaskId, { maxItems: 4096 }),
  },
  { additionalProperties: false },
);

export const TaskDagValidationResultV1 = versioned("TaskDagValidationResult", 1, {
  graphId: TaskGraphId,
  graphRevision: Type.Integer({ minimum: 1 }),
  valid: Type.Boolean(),
  topologicalOrder: Type.Array(ExecutionTaskId, { uniqueItems: true, maxItems: 4096 }),
  diagnostics: Type.Array(TaskDagDiagnostic, { maxItems: 4096 }),
});

export const TaskWaveBlockingCode = Type.Union([
  Type.Literal("graph_invalid"),
  Type.Literal("task_not_pending"),
  Type.Literal("graph_revision_pending"),
  Type.Literal("predecessor_pending"),
  Type.Literal("predecessor_failed"),
  Type.Literal("predecessor_cancelled"),
  Type.Literal("predecessor_blocked"),
  Type.Literal("completion_contract_pending"),
  Type.Literal("completion_contract_failed"),
  Type.Literal("integration_pending"),
  Type.Literal("integration_reconciliation_required"),
  Type.Literal("combined_verification_pending"),
  Type.Literal("combined_verification_failed"),
  Type.Literal("writer_lease_unavailable"),
  Type.Literal("profile_unavailable"),
  Type.Literal("account_capacity_unknown"),
  Type.Literal("account_capacity_exhausted"),
  Type.Literal("run_concurrency_exhausted"),
]);

const TaskWaveBlockingReason = Type.Object(
  {
    code: TaskWaveBlockingCode,
    sourceTaskId: Type.Union([ExecutionTaskId, Type.Null()]),
    repositoryId: Type.Union([RepositoryId, Type.Null()]),
    profileId: Type.Union([ProfileId, Type.Null()]),
    accountId: Type.Union([AccountId, Type.Null()]),
  },
  { additionalProperties: false },
);

const TaskEligibilityDecision = Type.Object(
  {
    taskId: ExecutionTaskId,
    classification: Type.Union([
      Type.Literal("selected"),
      Type.Literal("deferred"),
      Type.Literal("settled"),
      Type.Literal("invalid"),
    ]),
    blockingReasons: Type.Array(TaskWaveBlockingReason, { maxItems: 4096 }),
  },
  { additionalProperties: false },
);

/** Deterministic next-wave selection plus the complete task-by-task eligibility trace. */
export const TaskWavePlanV1 = versioned("TaskWavePlan", 1, {
  graphId: TaskGraphId,
  graphRevision: Type.Integer({ minimum: 1 }),
  waveOrdinal: Type.Integer({ minimum: 1 }),
  validation: Type.Ref(TaskDagValidationResultV1),
  selectedTaskIds: Type.Array(ExecutionTaskId, { uniqueItems: true, maxItems: 4096 }),
  decisions: Type.Array(TaskEligibilityDecision, { maxItems: 4096 }),
  plannedAt: IsoDateTime,
});

export type TaskDagV1 = Static<typeof TaskDagV1>;
export type TaskDagV2 = Static<typeof TaskDagV2>;
/** Backward-compatible name retained for Q040 consumers. */
export type TaskDag = TaskDagV1;
export type TaskDagVersioned = TaskDagV1 | TaskDagV2;
export type TaskPlanningOutcome = Static<typeof TaskPlanningOutcome>;
export type TaskPlanningState = Static<typeof TaskPlanningState>;
export type TaskWavePlanningSnapshot = Omit<Static<typeof TaskWavePlanningSnapshotV1>, "dag"> & {
  readonly dag: TaskDagVersioned;
};
export type TaskDagDiagnostic = Static<typeof TaskDagDiagnostic>;
export type TaskDagValidationResult = Static<typeof TaskDagValidationResultV1>;
export type TaskWaveBlockingCode = Static<typeof TaskWaveBlockingCode>;
export type TaskWavePlan = Static<typeof TaskWavePlanV1>;
export type TaskWavePlanningSnapshotV2 = Static<typeof TaskWavePlanningSnapshotV2>;
export type TaskLifecyclePhase = Static<typeof TaskLifecyclePhase>;
export type TaskPropagationReason = Static<typeof TaskPropagationReasonV1>;
export type TaskLifecycleProjection = Static<typeof TaskLifecycleProjectionV1>;
export type TaskCapacityScope = Static<typeof TaskCapacityScope>;
export type TaskCapacityLease = Static<typeof TaskCapacityLeaseV1>;
export type TaskDispatchRecord = Static<typeof TaskDispatchRecordV1>;
export type TaskWaveAuditEvent = Static<typeof TaskWaveAuditEventV1>;
