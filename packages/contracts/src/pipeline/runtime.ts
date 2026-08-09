import { Type } from "@sinclair/typebox";
import { ProfileId } from "../execution-backend/ids.js";
import { versioned } from "../kernel/index.js";
import { RunId } from "../run/ids.js";
import {
  PipelineAttemptId,
  PipelineId,
  PipelineRecoveryDecisionId,
  PipelineSchedulerDecisionId,
  PipelineSchedulerIntentId,
  PipelineStageId,
} from "./ids.js";
import {
  PipelineFailureSignatureV1,
  PipelineFailureV1,
  PipelineRecoveryDecisionV1,
  PipelineRetryDirectiveV1,
} from "./recovery.js";
import { PipelineGraphV1 } from "./schemas.js";
import { PipelineStageState } from "./state.js";
import {
  PipelineExecutionMode,
  PipelineSchedulerDecisionAction,
  PipelineSchedulerDecisionActionV2,
  PipelineSchedulerIntentKind,
  PipelineSchedulerIntentKindV2,
  PipelineSessionPolicy,
  PipelineStageType,
  PipelineTerminalOutcome,
  PipelineTransitionReason,
  PipelineTransitionReasonV2,
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

const Sha256Hex = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[0-9a-f]{64}$",
});

const RecoveryDispatchIntentPayload = Type.Object(
  {
    kind: Type.Literal("recovery_dispatch"),
    stageId: PipelineStageId,
    stageType: PipelineStageType,
    attemptId: PipelineAttemptId,
    generation: Type.Integer({ minimum: 1 }),
    attemptOrdinal: Type.Integer({ minimum: 1 }),
    directive: Type.Ref(PipelineRetryDirectiveV1),
    recoveryDecisionId: PipelineRecoveryDecisionId,
  },
  { additionalProperties: false },
);

/**
 * V2 observation envelope. V1 stays frozen; recovery kinds and failure
 * fingerprints are additive optional fields.
 */
export const PipelineSchedulerObservationV2 = versioned("PipelineSchedulerObservation", 2, {
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
    Type.Literal("recovery_proposed"),
    Type.Literal("recovery_approved"),
    Type.Literal("recovery_rejected"),
  ]),
  stageId: Type.Optional(PipelineStageId),
  attemptId: Type.Optional(PipelineAttemptId),
  /** When `attempt_failed`, whether another repair attempt is allowed by policy. */
  retryable: Type.Optional(Type.Boolean()),
  /** Evaluator edge key (`from\\0to`) and whether the branch was selected. */
  edgeKey: Type.Optional(Type.String({ minLength: 1 })),
  selected: Type.Optional(Type.Boolean()),
  recordedAt: Type.String({ format: "date-time" }),
  failure: Type.Optional(Type.Ref(PipelineFailureV1)),
  signature: Type.Optional(Type.Ref(PipelineFailureSignatureV1)),
  recoveryDecisionId: Type.Optional(PipelineRecoveryDecisionId),
  proposalId: Type.Optional(Type.String({ minLength: 1 })),
  /** For `recovery_approved` / `recovery_rejected`. */
  approved: Type.Optional(Type.Boolean()),
});

/** V2 outbox intent including recovery-driven dispatch. */
export const PipelineSchedulerIntentV2 = versioned("PipelineSchedulerIntent", 2, {
  intentId: PipelineSchedulerIntentId,
  runId: RunId,
  graphRevision: Type.Integer({ minimum: 1 }),
  kind: PipelineSchedulerIntentKindV2,
  payload: Type.Union([
    DispatchIntentPayload,
    CancelIntentPayload,
    EvaluatorIntentPayload,
    RecoveryDispatchIntentPayload,
  ]),
  createdAt: Type.String({ format: "date-time" }),
});

/**
 * Scheduler stage attempt with optional recovery binding. Distinct from
 * `StageRunnerAttempt` — this is the scheduler's attempt ledger row.
 */
export const PipelineStageAttemptV2 = versioned("PipelineStageAttempt", 2, {
  attemptId: PipelineAttemptId,
  runId: RunId,
  pipelineId: PipelineId,
  stageId: PipelineStageId,
  graphRevision: Type.Integer({ minimum: 1 }),
  generation: Type.Integer({ minimum: 1 }),
  attemptOrdinal: Type.Integer({ minimum: 1 }),
  stageType: PipelineStageType,
  createdAt: Type.String({ format: "date-time" }),
  sessionPolicy: Type.Optional(PipelineSessionPolicy),
  priorAttemptId: Type.Optional(PipelineAttemptId),
  recoveryDecisionId: Type.Optional(PipelineRecoveryDecisionId),
  delegatedProfileId: Type.Optional(ProfileId),
  retryDirective: Type.Optional(Type.Ref(PipelineRetryDirectiveV1)),
});

/**
 * V2 scheduler decision with widened reason/action vocabulary and optional
 * recovery linkage.
 */
export const PipelineSchedulerDecisionV2 = versioned("PipelineSchedulerDecision", 2, {
  decisionId: PipelineSchedulerDecisionId,
  runId: RunId,
  stageId: Type.Optional(PipelineStageId),
  graphRevision: Type.Integer({ minimum: 1 }),
  generation: Type.Integer({ minimum: 1 }),
  attemptOrdinal: Type.Integer({ minimum: 0 }),
  action: PipelineSchedulerDecisionActionV2,
  reason: PipelineTransitionReasonV2,
  fromState: Type.Optional(PipelineStageState.schema),
  toState: Type.Optional(PipelineStageState.schema),
  attemptId: Type.Optional(PipelineAttemptId),
  intentId: Type.Optional(PipelineSchedulerIntentId),
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  recordedAt: Type.String({ format: "date-time" }),
  recoveryDecisionId: Type.Optional(PipelineRecoveryDecisionId),
  signatureDigest: Type.Optional(Sha256Hex),
});

const PipelineStageRecoveryState = Type.Object(
  {
    stageId: PipelineStageId,
    generation: Type.Integer({ minimum: 1 }),
    repairsUsed: Type.Integer({ minimum: 0 }),
    lastSignatureDigest: Type.Optional(Sha256Hex),
    identicalSignatureCount: Type.Integer({ minimum: 0 }),
    pendingProposalId: Type.Optional(Type.String({ minLength: 1 })),
    pendingProposalJson: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

const PipelineEffectiveLimits = Type.Object(
  {
    maxRepairAttempts: Type.Optional(Type.Integer({ minimum: 0 })),
    maxConcurrentWorkers: Type.Optional(Type.Integer({ minimum: 1 })),
    maxPipelineDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
    maxGraphRevisions: Type.Optional(Type.Integer({ minimum: 1 })),
    stageDurationMsByStageId: Type.Optional(
      Type.Record(Type.String({ minLength: 1 }), Type.Integer({ minimum: 1 })),
    ),
  },
  { additionalProperties: false },
);

/** V2 scheduler input with recovery counters, effective limits, and mode. */
export const PipelineSchedulerInputV2 = versioned("PipelineSchedulerInput", 2, {
  runId: RunId,
  pipelineId: PipelineId,
  graphRevision: Type.Integer({ minimum: 1 }),
  scheduleRevision: Type.Integer({ minimum: 1 }),
  graph: Type.Ref(PipelineGraphV1),
  now: Type.String({ format: "date-time" }),
  deadlineAt: Type.Optional(Type.String({ format: "date-time" })),
  stages: Type.Array(Type.Ref(PipelineStageSnapshotV1)),
  observations: Type.Array(Type.Ref(PipelineSchedulerObservationV2)),
  canonicalState: Type.Unknown(),
  pendingEvaluatorEdgeKeys: Type.Array(Type.String({ minLength: 1 })),
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
  recoveryState: Type.Optional(Type.Array(PipelineStageRecoveryState)),
  effectiveLimits: Type.Optional(PipelineEffectiveLimits),
  executionMode: Type.Optional(PipelineExecutionMode),
});

/** V2 plan carrying recovery decisions and V2 attempt/intent/decision rows. */
export const PipelineSchedulerPlanV2 = versioned("PipelineSchedulerPlan", 2, {
  runId: RunId,
  graphRevision: Type.Integer({ minimum: 1 }),
  expectedScheduleRevision: Type.Integer({ minimum: 1 }),
  nextScheduleRevision: Type.Integer({ minimum: 1 }),
  recordedAt: Type.String({ format: "date-time" }),
  transitions: Type.Array(Type.Ref(PipelineStageTransitionV1)),
  decisions: Type.Array(Type.Ref(PipelineSchedulerDecisionV2)),
  intents: Type.Array(Type.Ref(PipelineSchedulerIntentV2)),
  attempts: Type.Array(Type.Ref(PipelineStageAttemptV2)),
  stagePatches: Type.Array(Type.Ref(PipelineStageSnapshotV1)),
  consumedObservationIds: Type.Array(Type.String({ minLength: 1 })),
  terminal: Type.Optional(Type.Ref(PipelineScheduleTerminalV1)),
  recoveryDecisions: Type.Array(Type.Ref(PipelineRecoveryDecisionV1)),
});
