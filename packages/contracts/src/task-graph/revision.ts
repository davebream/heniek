import { type Static, Type } from "@sinclair/typebox";
import { ArtifactId } from "../artifact/index.js";
import { ExecutionTaskId } from "../execution-backend/index.js";
import { versioned } from "../kernel/index.js";
import { RunId } from "../run/index.js";
import { SourceWorkItemId } from "../task-source/index.js";
import { TaskGraphId, TaskGraphRevisionDecisionId } from "./ids.js";
import { TaskDagDiagnostic, TaskDagV2, TaskPlanningState } from "./schemas.js";

const IsoDateTime = Type.String({ format: "date-time" });
const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const NonEmpty = Type.String({ minLength: 1, maxLength: 65536 });

export const TaskGraphChangeKind = Type.Union([
  Type.Literal("add"),
  Type.Literal("split"),
  Type.Literal("merge"),
  Type.Literal("reorder"),
  Type.Literal("supersede"),
]);

export const TaskGraphChange = Type.Object(
  {
    kind: TaskGraphChangeKind,
    beforeTaskIds: Type.Array(ExecutionTaskId, { uniqueItems: true, maxItems: 4096 }),
    afterTaskIds: Type.Array(ExecutionTaskId, { uniqueItems: true, maxItems: 4096 }),
    rationale: NonEmpty,
    evidenceArtifactIds: Type.Array(ArtifactId, { minItems: 1, uniqueItems: true }),
  },
  { additionalProperties: false },
);

export const TaskRequirementMapping = Type.Object(
  {
    sourceWorkItemId: SourceWorkItemId,
    requirementId: Type.String({ minLength: 1, maxLength: 256 }),
    beforeTaskIds: Type.Array(ExecutionTaskId, { uniqueItems: true, maxItems: 4096 }),
    afterTaskIds: Type.Array(ExecutionTaskId, {
      minItems: 1,
      uniqueItems: true,
      maxItems: 4096,
    }),
    rationale: NonEmpty,
  },
  { additionalProperties: false },
);

export const TaskStructuralWave = Type.Object(
  {
    ordinal: Type.Integer({ minimum: 1 }),
    taskIds: Type.Array(ExecutionTaskId, { minItems: 1, uniqueItems: true, maxItems: 4096 }),
  },
  { additionalProperties: false },
);

export const TaskGraphRevisionProposalV1 = versioned("TaskGraphRevisionProposal", 1, {
  runId: RunId,
  graphId: TaskGraphId,
  expectedGraphRevision: Type.Integer({ minimum: 1 }),
  expectedRevisionSha256: Sha256,
  proposedDag: Type.Ref(TaskDagV2),
  changes: Type.Array(TaskGraphChange, { minItems: 1, maxItems: 4096 }),
  requirementMappings: Type.Array(TaskRequirementMapping, { minItems: 1, maxItems: 4096 }),
  rationale: NonEmpty,
  evidenceArtifactIds: Type.Array(ArtifactId, { minItems: 1, uniqueItems: true }),
  proposedAt: IsoDateTime,
});

export const HiddenDependencyRevisionTrigger = Type.Object(
  {
    kind: Type.Literal("hidden_dependency"),
    findingId: Type.String({ minLength: 1, maxLength: 256 }),
    interruptedTaskIds: Type.Array(ExecutionTaskId, {
      minItems: 1,
      uniqueItems: true,
      maxItems: 4096,
    }),
  },
  { additionalProperties: false },
);

/** Q045 proposal shape: explicitly authorizes evidence-linked replacement of interrupted tasks. */
export const TaskGraphRevisionProposalV2 = versioned("TaskGraphRevisionProposal", 2, {
  runId: RunId,
  graphId: TaskGraphId,
  expectedGraphRevision: Type.Integer({ minimum: 1 }),
  expectedRevisionSha256: Sha256,
  proposedDag: Type.Ref(TaskDagV2),
  changes: Type.Array(TaskGraphChange, { minItems: 1, maxItems: 4096 }),
  requirementMappings: Type.Array(TaskRequirementMapping, { minItems: 1, maxItems: 4096 }),
  rationale: NonEmpty,
  evidenceArtifactIds: Type.Array(ArtifactId, { minItems: 1, uniqueItems: true }),
  proposedAt: IsoDateTime,
  trigger: HiddenDependencyRevisionTrigger,
});

export const TaskGraphRevisionDecisionV1 = versioned("TaskGraphRevisionDecision", 1, {
  decisionId: TaskGraphRevisionDecisionId,
  runId: RunId,
  graphId: TaskGraphId,
  proposal: Type.Ref(TaskGraphRevisionProposalV1),
  proposalSha256: Sha256,
  expectedGraphRevision: Type.Integer({ minimum: 1 }),
  outcome: Type.Union([Type.Literal("accepted"), Type.Literal("rejected")]),
  proposedRevisionSha256: Type.Union([Sha256, Type.Null()]),
  diagnostics: Type.Array(TaskDagDiagnostic, { maxItems: 4096 }),
  beforeWaves: Type.Array(TaskStructuralWave, { maxItems: 4096 }),
  afterWaves: Type.Array(TaskStructuralWave, { maxItems: 4096 }),
  affectedTaskIds: Type.Array(ExecutionTaskId, { uniqueItems: true, maxItems: 4096 }),
  affectedWaveOrdinals: Type.Array(Type.Integer({ minimum: 1 }), {
    uniqueItems: true,
    maxItems: 4096,
  }),
  taskStates: Type.Array(TaskPlanningState, { maxItems: 4096 }),
  maxGraphRevisions: Type.Integer({ minimum: 1 }),
  decidedAt: IsoDateTime,
});

export const TaskGraphRevisionDecisionV2 = versioned("TaskGraphRevisionDecision", 2, {
  decisionId: TaskGraphRevisionDecisionId,
  runId: RunId,
  graphId: TaskGraphId,
  proposal: Type.Ref(TaskGraphRevisionProposalV2),
  proposalSha256: Sha256,
  expectedGraphRevision: Type.Integer({ minimum: 1 }),
  outcome: Type.Union([Type.Literal("accepted"), Type.Literal("rejected")]),
  proposedRevisionSha256: Type.Union([Sha256, Type.Null()]),
  diagnostics: Type.Array(TaskDagDiagnostic, { maxItems: 4096 }),
  beforeWaves: Type.Array(TaskStructuralWave, { maxItems: 4096 }),
  afterWaves: Type.Array(TaskStructuralWave, { maxItems: 4096 }),
  affectedTaskIds: Type.Array(ExecutionTaskId, { uniqueItems: true, maxItems: 4096 }),
  affectedWaveOrdinals: Type.Array(Type.Integer({ minimum: 1 }), {
    uniqueItems: true,
    maxItems: 4096,
  }),
  taskStates: Type.Array(TaskPlanningState, { maxItems: 4096 }),
  maxGraphRevisions: Type.Integer({ minimum: 1 }),
  decidedAt: IsoDateTime,
  trigger: HiddenDependencyRevisionTrigger,
});

export const TaskGraphRevisionRecordV1 = versioned("TaskGraphRevisionRecord", 1, {
  runId: RunId,
  graphId: TaskGraphId,
  graphRevision: Type.Integer({ minimum: 1 }),
  revisionSha256: Sha256,
  predecessorRevisionSha256: Type.Union([Sha256, Type.Null()]),
  dag: Type.Ref(TaskDagV2),
  changes: Type.Array(TaskGraphChange, { maxItems: 4096 }),
  requirementMappings: Type.Array(TaskRequirementMapping, { minItems: 1, maxItems: 4096 }),
  rationale: NonEmpty,
  evidenceArtifactIds: Type.Array(ArtifactId, { minItems: 1, uniqueItems: true }),
  decisionId: Type.Union([TaskGraphRevisionDecisionId, Type.Null()]),
  committedAt: IsoDateTime,
});

export const TaskGraphRevisionRecordV2 = versioned("TaskGraphRevisionRecord", 2, {
  runId: RunId,
  graphId: TaskGraphId,
  graphRevision: Type.Integer({ minimum: 1 }),
  revisionSha256: Sha256,
  predecessorRevisionSha256: Type.Union([Sha256, Type.Null()]),
  dag: Type.Ref(TaskDagV2),
  changes: Type.Array(TaskGraphChange, { maxItems: 4096 }),
  requirementMappings: Type.Array(TaskRequirementMapping, { minItems: 1, maxItems: 4096 }),
  rationale: NonEmpty,
  evidenceArtifactIds: Type.Array(ArtifactId, { minItems: 1, uniqueItems: true }),
  decisionId: Type.Union([TaskGraphRevisionDecisionId, Type.Null()]),
  committedAt: IsoDateTime,
  trigger: HiddenDependencyRevisionTrigger,
});

export type TaskGraphChange = Static<typeof TaskGraphChange>;
export type TaskRequirementMapping = Static<typeof TaskRequirementMapping>;
export type TaskStructuralWave = Static<typeof TaskStructuralWave>;
export type HiddenDependencyRevisionTrigger = Static<typeof HiddenDependencyRevisionTrigger>;
export type TaskGraphRevisionProposal =
  | Static<typeof TaskGraphRevisionProposalV1>
  | Static<typeof TaskGraphRevisionProposalV2>;
export type TaskGraphRevisionDecision =
  | Static<typeof TaskGraphRevisionDecisionV1>
  | Static<typeof TaskGraphRevisionDecisionV2>;
export type TaskGraphRevisionRecord =
  | Static<typeof TaskGraphRevisionRecordV1>
  | Static<typeof TaskGraphRevisionRecordV2>;
