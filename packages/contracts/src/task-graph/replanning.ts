import { type Static, Type } from "@sinclair/typebox";
import { ArtifactId } from "../artifact/index.js";
import { ExecutionTaskId } from "../execution-backend/index.js";
import { versioned } from "../kernel/index.js";
import { RunId } from "../run/index.js";
import { TaskGraphId, TaskGraphRevisionDecisionId } from "./ids.js";
import { TaskGraphRevisionProposalV2 } from "./revision.js";

const IsoDateTime = Type.String({ format: "date-time" });
const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const NonEmpty = Type.String({ minLength: 1, maxLength: 65536 });

export const HiddenDependencyFindingV1 = versioned("HiddenDependencyFinding", 1, {
  findingId: Type.String({ minLength: 1, maxLength: 256 }),
  runId: RunId,
  graphId: TaskGraphId,
  graphRevision: Type.Integer({ minimum: 1 }),
  revisionSha256: Sha256,
  reporterTaskId: ExecutionTaskId,
  prerequisiteTaskIds: Type.Array(ExecutionTaskId, {
    minItems: 1,
    uniqueItems: true,
    maxItems: 4096,
  }),
  affectedTaskIds: Type.Array(ExecutionTaskId, {
    minItems: 1,
    uniqueItems: true,
    maxItems: 4096,
  }),
  rationale: NonEmpty,
  evidenceArtifactIds: Type.Array(ArtifactId, { minItems: 1, uniqueItems: true }),
  discoveredAt: IsoDateTime,
});

export const HiddenDependencyReplanLifecycle = Type.Union([
  Type.Literal("quiescing"),
  Type.Literal("revising"),
  Type.Literal("resumed"),
  Type.Literal("blocked"),
]);

export const HiddenDependencyReplanBlocker = Type.Union([
  Type.Literal("cancellation_unconfirmed"),
  Type.Literal("prerequisite_unsatisfied"),
  Type.Literal("integration_reconciliation_required"),
  Type.Literal("revision_rejected"),
  Type.Literal("missing_evidence"),
]);

export const HiddenDependencyReplanV1 = versioned("HiddenDependencyReplan", 1, {
  replanId: Type.String({ minLength: 1, maxLength: 256 }),
  finding: Type.Ref(HiddenDependencyFindingV1),
  proposal: Type.Ref(TaskGraphRevisionProposalV2),
  lifecycle: HiddenDependencyReplanLifecycle,
  interruptedTaskIds: Type.Array(ExecutionTaskId, {
    minItems: 1,
    uniqueItems: true,
    maxItems: 4096,
  }),
  replacementTaskIds: Type.Array(ExecutionTaskId, { uniqueItems: true, maxItems: 4096 }),
  decisionId: Type.Union([TaskGraphRevisionDecisionId, Type.Null()]),
  resultingGraphRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  blocker: Type.Union([HiddenDependencyReplanBlocker, Type.Null()]),
  revision: Type.Integer({ minimum: 1 }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export type HiddenDependencyFinding = Static<typeof HiddenDependencyFindingV1>;
export type HiddenDependencyReplanLifecycle = Static<typeof HiddenDependencyReplanLifecycle>;
export type HiddenDependencyReplanBlocker = Static<typeof HiddenDependencyReplanBlocker>;
export type HiddenDependencyReplan = Static<typeof HiddenDependencyReplanV1>;
