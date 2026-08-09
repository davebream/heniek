import { Type } from "@sinclair/typebox";
import { ProfileId } from "../execution-backend/ids.js";
import { versioned } from "../kernel/index.js";
import { RunId } from "../run/ids.js";
import {
  PipelineAttemptId,
  PipelineId,
  PipelineSchedulerDecisionId,
  PipelineSchedulerIntentId,
  PipelineStageId,
} from "./ids.js";
import { PipelineGraphV1 } from "./schemas.js";
import { PipelineStageState } from "./state.js";
import {
  PipelineSchedulerDecisionAction,
  PipelineSchedulerIntentKind,
  PipelineStageType,
  PipelineTerminalOutcome,
  PipelineTransitionReason,
} from "./vocabulary.js";

/**
 * Immutable identity of one stage attempt. The opaque `attemptId` is derived
 * from these coordinates so uniqueness constraints and deterministic IDs
 * agree without a separate minting step.
 */
export const PipelineStageAttemptV1 = versioned("PipelineStageAttempt", 1, {
  attemptId: PipelineAttemptId,
  runId: RunId,
  pipelineId: PipelineId,
  stageId: PipelineStageId,
  graphRevision: Type.Integer({ minimum: 1 }),
  generation: Type.Integer({ minimum: 1 }),
  attemptOrdinal: Type.Integer({ minimum: 1 }),
  stageType: PipelineStageType,
  createdAt: Type.String({ format: "date-time" }),
});

/**
 * Mutable per-stage projection the scheduler reads and the store updates.
 * Attempts and decisions stay immutable; only this row moves.
 */
export const PipelineStageSnapshotV1 = versioned("PipelineStageSnapshot", 1, {
  runId: RunId,
  stageId: PipelineStageId,
  graphRevision: Type.Integer({ minimum: 1 }),
  generation: Type.Integer({ minimum: 1 }),
  state: PipelineStageState.schema,
  attemptOrdinal: Type.Integer({ minimum: 0 }),
  currentAttemptId: Type.Optional(PipelineAttemptId),
  lastTransitionReason: Type.Optional(PipelineTransitionReason),
  blockReason: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  selected: Type.Boolean(),
  updatedAt: Type.String({ format: "date-time" }),
});

/** One permitted state transition produced by a scheduler tick. */
export const PipelineStageTransitionV1 = versioned("PipelineStageTransition", 1, {
  stageId: PipelineStageId,
  from: PipelineStageState.schema,
  to: PipelineStageState.schema,
  reason: PipelineTransitionReason,
  attemptId: Type.Optional(PipelineAttemptId),
  generation: Type.Integer({ minimum: 1 }),
  blockReason: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});

/**
 * Append-only scheduler decision. `decisionId` is derived from run, graph
 * revision, stage generation, attempt ordinal, and action.
 */
export const PipelineSchedulerDecisionV1 = versioned("PipelineSchedulerDecision", 1, {
  decisionId: PipelineSchedulerDecisionId,
  runId: RunId,
  stageId: Type.Optional(PipelineStageId),
  graphRevision: Type.Integer({ minimum: 1 }),
  generation: Type.Integer({ minimum: 1 }),
  attemptOrdinal: Type.Integer({ minimum: 0 }),
  action: PipelineSchedulerDecisionAction,
  reason: PipelineTransitionReason,
  fromState: Type.Optional(PipelineStageState.schema),
  toState: Type.Optional(PipelineStageState.schema),
  attemptId: Type.Optional(PipelineAttemptId),
  intentId: Type.Optional(PipelineSchedulerIntentId),
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  recordedAt: Type.String({ format: "date-time" }),
});

const DispatchIntentPayload = Type.Object(
  {
    kind: Type.Literal("dispatch"),
    stageId: PipelineStageId,
    stageType: PipelineStageType,
    attemptId: PipelineAttemptId,
    generation: Type.Integer({ minimum: 1 }),
    attemptOrdinal: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const CancelIntentPayload = Type.Object(
  {
    kind: Type.Literal("cancel"),
    stageId: PipelineStageId,
    attemptId: PipelineAttemptId,
    generation: Type.Integer({ minimum: 1 }),
    attemptOrdinal: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const EvaluatorIntentPayload = Type.Object(
  {
    kind: Type.Literal("evaluator"),
    fromStageId: PipelineStageId,
    toStageId: PipelineStageId,
    profile: ProfileId,
    question: Type.String({ minLength: 1 }),
    edgeKey: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/**
 * Durable outbox intent. Uniquely keyed so restart replay cannot enqueue a
 * second dispatch for an existing attempt.
 */
export const PipelineSchedulerIntentV1 = versioned("PipelineSchedulerIntent", 1, {
  intentId: PipelineSchedulerIntentId,
  runId: RunId,
  graphRevision: Type.Integer({ minimum: 1 }),
  kind: PipelineSchedulerIntentKind,
  payload: Type.Union([DispatchIntentPayload, CancelIntentPayload, EvaluatorIntentPayload]),
  createdAt: Type.String({ format: "date-time" }),
});

/** Typed terminal outcome of one pipeline graph schedule. */
export const PipelineScheduleTerminalV1 = versioned("PipelineScheduleTerminal", 1, {
  outcome: PipelineTerminalOutcome,
  reason: Type.String({ minLength: 1, maxLength: 256 }),
  blockedStageId: Type.Optional(PipelineStageId),
});

/**
 * Observations the store feeds the pure scheduler: runner progress,
 * cancellation settlement, evaluator answers, cancel requests, and manual
 * reruns. The scheduler never invents these — it only consumes recorded
 * facts and explicit time.
 */
export const PipelineSchedulerObservationV1 = versioned("PipelineSchedulerObservation", 1, {
  observationId: Type.String({ minLength: 1 }),
  kind: Type.Union([
    Type.Literal("attempt_started"),
    Type.Literal("attempt_waiting"),
    Type.Literal("attempt_succeeded"),
    Type.Literal("attempt_failed"),
    Type.Literal("cancellation_settled"),
    Type.Literal("evaluator_decided"),
    Type.Literal("cancel_requested"),
    Type.Literal("manual_rerun"),
  ]),
  stageId: Type.Optional(PipelineStageId),
  attemptId: Type.Optional(PipelineAttemptId),
  /** When `attempt_failed`, whether another repair attempt is allowed by policy. */
  retryable: Type.Optional(Type.Boolean()),
  /** Evaluator edge key (`from\\0to`) and whether the branch was selected. */
  edgeKey: Type.Optional(Type.String({ minLength: 1 })),
  selected: Type.Optional(Type.Boolean()),
  recordedAt: Type.String({ format: "date-time" }),
});

/**
 * Pure-scheduler input. Everything here is either immutable history,
 * a mutable projection snapshot, an explicit clock reading, or a recorded
 * observation — no ambient sources.
 */
export const PipelineSchedulerInputV1 = versioned("PipelineSchedulerInput", 1, {
  runId: RunId,
  pipelineId: PipelineId,
  graphRevision: Type.Integer({ minimum: 1 }),
  scheduleRevision: Type.Integer({ minimum: 1 }),
  graph: Type.Ref(PipelineGraphV1),
  now: Type.String({ format: "date-time" }),
  /** ISO deadline; when set and `now` is past it, open stages cancel. */
  deadlineAt: Type.Optional(Type.String({ format: "date-time" })),
  stages: Type.Array(Type.Ref(PipelineStageSnapshotV1)),
  observations: Type.Array(Type.Ref(PipelineSchedulerObservationV1)),
  /**
   * Canonical JSON state expressions read. Missing or incompatible paths
   * produce typed `blocked`, never a throw into executable code.
   */
  canonicalState: Type.Unknown(),
  /**
   * Edge keys (`from\\0to`) whose evaluator has already been requested and
   * is awaiting a recorded decision. Prevents duplicate evaluator intents.
   */
  pendingEvaluatorEdgeKeys: Type.Array(Type.String({ minLength: 1 })),
  /**
   * Recorded evaluator decisions keyed by edge key. Only these decide
   * evaluator conditions on later ticks.
   */
  evaluatorDecisions: Type.Array(
    Type.Object(
      {
        edgeKey: Type.String({ minLength: 1 }),
        selected: Type.Boolean(),
        recordedAt: Type.String({ format: "date-time" }),
      },
      { additionalProperties: false },
    ),
  ),
});

/**
 * Deterministic plan one tick emits. Applied transactionally against
 * `expectedScheduleRevision`; duplicate IDs make a second apply a no-op.
 */
export const PipelineSchedulerPlanV1 = versioned("PipelineSchedulerPlan", 1, {
  runId: RunId,
  graphRevision: Type.Integer({ minimum: 1 }),
  expectedScheduleRevision: Type.Integer({ minimum: 1 }),
  nextScheduleRevision: Type.Integer({ minimum: 1 }),
  recordedAt: Type.String({ format: "date-time" }),
  transitions: Type.Array(Type.Ref(PipelineStageTransitionV1)),
  decisions: Type.Array(Type.Ref(PipelineSchedulerDecisionV1)),
  intents: Type.Array(Type.Ref(PipelineSchedulerIntentV1)),
  attempts: Type.Array(Type.Ref(PipelineStageAttemptV1)),
  stagePatches: Type.Array(Type.Ref(PipelineStageSnapshotV1)),
  consumedObservationIds: Type.Array(Type.String({ minLength: 1 })),
  terminal: Type.Optional(Type.Ref(PipelineScheduleTerminalV1)),
});
