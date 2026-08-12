import { type Static, Type } from "@sinclair/typebox";
import { AccountId } from "../configuration/index.js";
import { ExecutionTaskId, ProfileId } from "../execution-backend/index.js";
import { versioned } from "../kernel/index.js";
import { ExecutionTaskRevisionV1, RepositoryId } from "../run/index.js";
import { TaskGraphId } from "./ids.js";

const IsoDateTime = Type.String({ format: "date-time" });

const TaskDagNode = Type.Object(
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
  nodes: Type.Array(TaskDagNode, { minItems: 1, maxItems: 4096 }),
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

const TaskPlanningState = Type.Object(
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

const TaskDagDiagnostic = Type.Object(
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

export type TaskDag = Static<typeof TaskDagV1>;
export type TaskPlanningOutcome = Static<typeof TaskPlanningOutcome>;
export type TaskWavePlanningSnapshot = Static<typeof TaskWavePlanningSnapshotV1>;
export type TaskDagValidationResult = Static<typeof TaskDagValidationResultV1>;
export type TaskWaveBlockingCode = Static<typeof TaskWaveBlockingCode>;
export type TaskWavePlan = Static<typeof TaskWavePlanV1>;
