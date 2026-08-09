/**
 * Provider-neutral stage-runner contracts (Q026, ADR 0024).
 *
 * The scheduler (Q025) emits dispatch/cancel intents; runners drain them
 * through prepare → start → observe → cancel → collect → validate → finalize
 * and return observations only after outputs and evidence pass validation.
 * Exit code or backend status alone never authorizes success (§19.5).
 */

import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { ArtifactId } from "../artifact/ids.js";
import { ExecutionFailureV1 } from "../execution-backend/schemas.js";
import { defineStates, versioned } from "../kernel/index.js";
import { RunId, WorkspaceId } from "../run/ids.js";
import { PipelineAttemptId, PipelineSchedulerIntentId, PipelineStageId } from "./ids.js";
import type { PipelineStageType } from "./vocabulary.js";

/**
 * Lifecycle phases both runners share. Terminal phases are outcomes; the
 * runner may still need cleanup or recovery bookkeeping after them.
 */
export const StageRunnerPhase = defineStates({
  nonTerminal: [
    "prepare",
    "start",
    "observe",
    "cancel",
    "collect",
    "validate",
    "finalize",
  ] as const,
  terminal: ["succeeded", "failed", "cancelled", "recovery_required"] as const,
});
export type StageRunnerPhase = (typeof StageRunnerPhase)["values"][number];

/**
 * Why an attempt stopped short of validated success. Separate from
 * `ExecutionFailure/v1` so command runners can classify without a backend,
 * while still embedding a backend failure when one exists.
 */
export const StageRunnerFailureClass = Type.Union([
  Type.Literal("prepare_failed"),
  Type.Literal("start_failed"),
  Type.Literal("timeout"),
  Type.Literal("cancelled"),
  Type.Literal("process_failed"),
  Type.Literal("backend_failed"),
  Type.Literal("collection_failed"),
  Type.Literal("validation_failed"),
  Type.Literal("finalize_failed"),
  Type.Literal("workspace_failed"),
  Type.Literal("profile_failed"),
  Type.Literal("recovery_required"),
  Type.Literal("unknown"),
]);
export type StageRunnerFailureClass = Static<typeof StageRunnerFailureClass>;

export const StageRunnerRecoveryClass = Type.Union([
  Type.Literal("none"),
  Type.Literal("observe_backend"),
  Type.Literal("reap_process"),
  Type.Literal("reconcile_artifacts"),
  Type.Literal("manual"),
]);
export type StageRunnerRecoveryClass = Static<typeof StageRunnerRecoveryClass>;

/** One collected output binding — either a canonical JSON value or an artifact. */
export const StageRunnerOutputBindingV1 = versioned("StageRunnerOutputBinding", 1, {
  reference: Type.String({ minLength: 1, maxLength: 256 }),
  kind: Type.Union([Type.Literal("value"), Type.Literal("artifact")]),
  value: Type.Optional(Type.Unknown()),
  artifactId: Type.Optional(ArtifactId),
  contentHash: Type.Optional(
    Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" }),
  ),
  relativePath: Type.Optional(
    Type.String({
      minLength: 1,
      pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\u0000).+$",
    }),
  ),
});

/**
 * Evidence collected for §19.5 completion requirements. Verdict evidence is
 * consumed when already recorded; Q026 does not invoke verify-stage behavior.
 */
export const StageRunnerEvidenceV1 = versioned("StageRunnerEvidence", 1, {
  kind: Type.Union([
    Type.Literal("result_envelope"),
    Type.Literal("non_empty_diff"),
    Type.Literal("artifact"),
    Type.Literal("schema_check"),
    Type.Literal("sections"),
    Type.Literal("command"),
    Type.Literal("repository_state"),
    Type.Literal("verdict"),
    Type.Literal("process_cleanup"),
    Type.Literal("exit_code"),
  ]),
  requirement: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  satisfied: Type.Boolean(),
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  recordedAt: Type.String({ format: "date-time" }),
  payload: Type.Optional(Type.Unknown()),
});

export const StageRunnerFailureV1 = versioned("StageRunnerFailure", 1, {
  classification: StageRunnerFailureClass,
  phase: StageRunnerPhase.schema,
  code: Type.String({ minLength: 1, maxLength: 128 }),
  /** Redacted operator-facing message; never credentials or full env. */
  message: Type.String({ minLength: 1, maxLength: 512 }),
  retryable: Type.Boolean(),
  recovery: StageRunnerRecoveryClass,
  backendFailure: Type.Optional(Type.Ref(ExecutionFailureV1)),
});

/** Terminal result envelope after validate (success or typed failure). */
export const StageRunnerResultV1 = versioned("StageRunnerResult", 1, {
  attemptId: PipelineAttemptId,
  outcome: Type.Union([
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
    Type.Literal("recovery_required"),
  ]),
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  artifactPath: Type.Optional(
    Type.String({
      minLength: 1,
      pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\u0000).+$",
    }),
  ),
  exitCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
  outputs: Type.Array(Type.Ref(StageRunnerOutputBindingV1)),
  evidence: Type.Array(Type.Ref(StageRunnerEvidenceV1)),
  failure: Type.Optional(Type.Ref(StageRunnerFailureV1)),
  finishedAt: Type.String({ format: "date-time" }),
});

/**
 * Durable attempt snapshot. Mutable fields move through phases; identity
 * coordinates stay fixed and match `PipelineStageAttempt/v1`.
 */
export const StageRunnerAttemptV1 = versioned("StageRunnerAttempt", 1, {
  attemptId: PipelineAttemptId,
  runId: RunId,
  stageId: PipelineStageId,
  stageType: Type.Union([Type.Literal("agent"), Type.Literal("command")]),
  intentId: PipelineSchedulerIntentId,
  graphRevision: Type.Integer({ minimum: 1 }),
  generation: Type.Integer({ minimum: 1 }),
  attemptOrdinal: Type.Integer({ minimum: 1 }),
  phase: StageRunnerPhase.schema,
  workspaceId: Type.Optional(WorkspaceId),
  leaseId: Type.Optional(Type.String({ minLength: 1 })),
  checkoutPath: Type.Optional(Type.String({ minLength: 1 })),
  processGroupId: Type.Optional(Type.Integer({ minimum: 1 })),
  backendExecutionId: Type.Optional(Type.String({ minLength: 1 })),
  deadlineAt: Type.Optional(Type.String({ format: "date-time" })),
  runtimeDirectory: Type.Optional(Type.String({ minLength: 1 })),
  preparedAt: Type.Optional(Type.String({ format: "date-time" })),
  startedAt: Type.Optional(Type.String({ format: "date-time" })),
  finishedAt: Type.Optional(Type.String({ format: "date-time" })),
  outputs: Type.Array(Type.Ref(StageRunnerOutputBindingV1)),
  evidence: Type.Array(Type.Ref(StageRunnerEvidenceV1)),
  result: Type.Optional(Type.Ref(StageRunnerResultV1)),
  failure: Type.Optional(Type.Ref(StageRunnerFailureV1)),
  recovery: StageRunnerRecoveryClass,
  revision: Type.Integer({ minimum: 1 }),
  updatedAt: Type.String({ format: "date-time" }),
  createdAt: Type.String({ format: "date-time" }),
});

/** Cleanup health after timeout/cancel or daemon restart. */
export const StageRunnerCleanupReportV1 = versioned("StageRunnerCleanupReport", 1, {
  attemptId: PipelineAttemptId,
  processGroupId: Type.Optional(Type.Integer({ minimum: 1 })),
  signalSequence: Type.Array(
    Type.Union([Type.Literal("SIGTERM"), Type.Literal("SIGKILL"), Type.Literal("backend_cancel")]),
  ),
  descendantsRemaining: Type.Integer({ minimum: 0 }),
  gracePeriodMs: Type.Integer({ minimum: 0 }),
  cleaned: Type.Boolean(),
  recordedAt: Type.String({ format: "date-time" }),
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});

/** Evidence-validation report required by Q026 acceptance. */
export const StageRunnerValidationReportV1 = versioned("StageRunnerValidationReport", 1, {
  attemptId: PipelineAttemptId,
  valid: Type.Boolean(),
  missingWrites: Type.Array(Type.String({ minLength: 1 })),
  missingEvidence: Type.Array(Type.String({ minLength: 1 })),
  envelopeValid: Type.Boolean(),
  exitCodeAlone: Type.Boolean(),
  recordedAt: Type.String({ format: "date-time" }),
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
});

export type StageRunnerOutputBindingV1 = Static<typeof StageRunnerOutputBindingV1>;
export type StageRunnerEvidenceV1 = Static<typeof StageRunnerEvidenceV1>;
export type StageRunnerFailureV1 = Static<typeof StageRunnerFailureV1>;
export type StageRunnerResultV1 = Static<typeof StageRunnerResultV1>;
export type StageRunnerAttemptV1 = Static<typeof StageRunnerAttemptV1>;
export type StageRunnerCleanupReportV1 = Static<typeof StageRunnerCleanupReportV1>;
export type StageRunnerValidationReportV1 = Static<typeof StageRunnerValidationReportV1>;

/** Narrow stage-type union Q026 actually runs. */
export type StageRunnerStageType = Extract<PipelineStageType, "agent" | "command">;
