import { Type } from "@sinclair/typebox";
import { CapabilityDeltaV1 } from "../capability/schemas.js";
import { ProfileQuestionMode } from "../configuration/index.js";
import {
  ExecutionFailureV1,
  ExecutionPermissionEnvelopeV1,
  ExecutionStatus,
  ExternalStageResultV1,
  InteractionAnswerSetV1,
  PendingInteractionV2,
  StageAttemptId,
  StageId,
} from "../execution-backend/index.js";
import { InteractionId, InteractionV2 } from "../interaction/index.js";
import { versioned } from "../kernel/index.js";
import { CodebaseId, RunId, WorkspaceId } from "../run/ids.js";
import { RunStatus } from "../run/state.js";
import { NativeDispatchId, NativeSubmissionId, ParentSessionId } from "./ids.js";
import { NativeStageState } from "./state.js";

/**
 * Same shape as `configuration`'s unexported `SafeRelativePath` and
 * `ExternalStageResultV1.artifactPath`: relative, no `..` segment, no NUL.
 * Duplicated rather than exported from one of those, because making it
 * shared would either create a cycle or invent an ownerless location for a
 * one-line pattern — the same trade the `interaction` family already
 * documents for `InteractionKind`.
 */
const SAFE_RELATIVE_PATH = "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\u0000).+$";

const NativeStageLimits = Type.Object(
  {
    maxDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
    maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

/**
 * Why refusals are data rather than thrown errors: the daemon's dispatcher
 * collapses every handler throw into a bare JSON-RPC `-32603` carrying no
 * `data`, so a thrown refusal is indistinguishable from a daemon bug. A
 * plugin that cannot tell "you are stale, re-attach" from "the daemon
 * crashed" cannot recover. `StageRunMutationResultV1.accepted` is the
 * existing precedent; every method in this family follows it, and handlers
 * throw only for malformed params and genuine internal faults.
 *
 * `unknown_dispatch` deliberately covers three cases at once — no such
 * dispatch, a dispatch belonging to another session, and a dispatch whose
 * attempt is no longer current. Distinguishing them would let any holder of
 * the daemon credential enumerate other sessions' dispatches, the same
 * existence oracle the auth path already refuses to be by folding every
 * failure into one uniform `-32001`.
 */
export const NativeBridgeRejectionCode = Type.Union([
  Type.Literal("session_not_attached"),
  Type.Literal("session_expired"),
  Type.Literal("stale_session_revision"),
  Type.Literal("unknown_dispatch"),
  Type.Literal("stale_dispatch_revision"),
  Type.Literal("dispatch_revoked"),
  Type.Literal("dispatch_already_settled"),
  Type.Literal("idempotency_key_reuse"),
  Type.Literal("run_terminal"),
  Type.Literal("artifact_missing"),
  Type.Literal("result_contract_violation"),
  Type.Literal("workspace_mutated"),
]);

export const ParentSessionAttachRequestV1 = versioned("ParentSessionAttachRequest", 1, {
  currentDirectory: Type.String({ minLength: 1 }),
  previousSessionId: Type.Optional(ParentSessionId),
  previousSessionRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  resumeDispatchIds: Type.Array(NativeDispatchId, { uniqueItems: true }),
});

/**
 * The attach result doubles as the capability echo a plugin needs *before*
 * its first poll: how long its lease lasts, how many dispatches one poll can
 * return, and how long to wait between polls. Discovering those at submit
 * time instead would mean finding out by being rejected.
 */
export const ParentSessionAttachmentV1 = versioned("ParentSessionAttachment", 1, {
  sessionId: ParentSessionId,
  sessionRevision: Type.Integer({ minimum: 1 }),
  codebaseId: CodebaseId,
  attachedAt: Type.String({ format: "date-time" }),
  expiresAt: Type.String({ format: "date-time" }),
  leaseTtlMs: Type.Integer({ minimum: 1 }),
  maxDispatches: Type.Integer({ minimum: 1 }),
  pollAfterMs: Type.Integer({ minimum: 0 }),
  resumedDispatchIds: Type.Array(NativeDispatchId, { uniqueItems: true }),
  supersededSessionId: Type.Optional(ParentSessionId),
});

/**
 * `outcome` is the parent's assertion about work it alone can observe. The
 * daemon treats it as a hint, never as authority: a parent that did start
 * work and reports otherwise — a bug, or a fresh process with no memory of
 * the first run — would otherwise cause the side effects of a started
 * attempt to be replayed. Any daemon-checkable evidence of work routes the
 * dispatch to recovery instead of back to the redispatch queue.
 */
export const ParentSessionDetachRequestV1 = versioned("ParentSessionDetachRequest", 1, {
  sessionId: ParentSessionId,
  sessionRevision: Type.Integer({ minimum: 1 }),
  dispatches: Type.Array(
    Type.Object(
      {
        dispatchId: NativeDispatchId,
        outcome: Type.Union([Type.Literal("not_started"), Type.Literal("abandoned")]),
      },
      { additionalProperties: false },
    ),
    { uniqueItems: true },
  ),
});

export const ParentSessionDetachResultV1 = versioned("ParentSessionDetachResult", 1, {
  accepted: Type.Boolean(),
  rejectionCode: Type.Optional(NativeBridgeRejectionCode),
  released: Type.Array(
    Type.Object(
      {
        dispatchId: NativeDispatchId,
        disposition: Type.Union([
          Type.Literal("redispatchable"),
          Type.Literal("recovery_required"),
        ]),
      },
      { additionalProperties: false },
    ),
  ),
});

export const NativeStagePollRequestV1 = versioned("NativeStagePollRequest", 1, {
  sessionId: ParentSessionId,
  sessionRevision: Type.Integer({ minimum: 1 }),
  maxDispatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
});

/**
 * Everything a parent needs to run one native subagent turn. Note what is
 * absent: no artifact bytes and no transcript. The subagent writes
 * `artifactPath` inside `workingDirectory`, and the daemon reads, digests
 * and publishes that file itself at submit time — forced by the 64 KiB
 * line cap, and stronger than the external path, which trusts the bytes a
 * backend reports.
 */
export const NativeStageDispatchV1 = versioned("NativeStageDispatch", 1, {
  dispatchId: NativeDispatchId,
  dispatchRevision: Type.Integer({ minimum: 1 }),
  runId: RunId,
  stageId: StageId,
  attemptId: StageAttemptId,
  attemptOrdinal: Type.Integer({ minimum: 1 }),
  workspaceId: WorkspaceId,
  workingDirectory: Type.String({ minLength: 1 }),
  instructionsPath: Type.String({ minLength: 1, pattern: SAFE_RELATIVE_PATH }),
  prompt: Type.String({ minLength: 1 }),
  artifactPath: Type.String({ minLength: 1, pattern: SAFE_RELATIVE_PATH }),
  artifactContract: Type.String({ minLength: 1 }),
  model: Type.String({ minLength: 1 }),
  effort: Type.String({ minLength: 1 }),
  focus: Type.Optional(Type.String({ minLength: 1 })),
  questions: ProfileQuestionMode,
  permissions: Type.Ref(ExecutionPermissionEnvelopeV1),
  limits: NativeStageLimits,
  issuedAt: Type.String({ format: "date-time" }),
  expiresAt: Type.String({ format: "date-time" }),
  deadlineAt: Type.Optional(Type.String({ format: "date-time" })),
});

/** Adds an optional capability degradation for the parent session to surface. */
export const NativeStageDispatchV2 = versioned("NativeStageDispatch", 2, {
  dispatchId: NativeDispatchId,
  dispatchRevision: Type.Integer({ minimum: 1 }),
  runId: RunId,
  stageId: StageId,
  attemptId: StageAttemptId,
  attemptOrdinal: Type.Integer({ minimum: 1 }),
  workspaceId: WorkspaceId,
  workingDirectory: Type.String({ minLength: 1 }),
  instructionsPath: Type.String({ minLength: 1, pattern: SAFE_RELATIVE_PATH }),
  prompt: Type.String({ minLength: 1 }),
  artifactPath: Type.String({ minLength: 1, pattern: SAFE_RELATIVE_PATH }),
  artifactContract: Type.String({ minLength: 1 }),
  model: Type.String({ minLength: 1 }),
  effort: Type.String({ minLength: 1 }),
  focus: Type.Optional(Type.String({ minLength: 1 })),
  questions: ProfileQuestionMode,
  permissions: Type.Ref(ExecutionPermissionEnvelopeV1),
  limits: NativeStageLimits,
  issuedAt: Type.String({ format: "date-time" }),
  expiresAt: Type.String({ format: "date-time" }),
  deadlineAt: Type.Optional(Type.String({ format: "date-time" })),
  capabilityDelta: Type.Optional(Type.Ref(CapabilityDeltaV1)),
});

/**
 * One poll is the whole read side: it renews the lease, claims dispatches,
 * delivers answers to questions raised since the last poll, and reports
 * revocations. Splitting those into four methods would cost four socket
 * connections and four `hello`+`negotiate` handshakes per cycle — the
 * client opens one connection per call — and, worse, would resolve each
 * against a different daemon state snapshot.
 *
 * Every array is bounded. `resumes` in particular carries answer payloads,
 * which is the one part of this result that could otherwise approach the
 * 64 KiB line cap.
 */
export const NativeStagePollResultV1 = versioned("NativeStagePollResult", 1, {
  accepted: Type.Boolean(),
  rejectionCode: Type.Optional(NativeBridgeRejectionCode),
  sessionRevision: Type.Integer({ minimum: 1 }),
  expiresAt: Type.String({ format: "date-time" }),
  pollAfterMs: Type.Integer({ minimum: 0 }),
  dispatches: Type.Array(Type.Ref(NativeStageDispatchV1), { maxItems: 16 }),
  resumes: Type.Array(
    Type.Object(
      {
        dispatchId: NativeDispatchId,
        dispatchRevision: Type.Integer({ minimum: 1 }),
        interactionId: InteractionId,
        interactionRevision: Type.Integer({ minimum: 1 }),
        answer: Type.Ref(InteractionAnswerSetV1),
      },
      { additionalProperties: false },
    ),
    { maxItems: 16 },
  ),
  revocations: Type.Array(
    Type.Object(
      {
        dispatchId: NativeDispatchId,
        dispatchRevision: Type.Integer({ minimum: 1 }),
        reason: Type.Union([
          Type.Literal("run_cancelled"),
          Type.Literal("lease_expired"),
          Type.Literal("superseded"),
          Type.Literal("recovery_required"),
        ]),
      },
      { additionalProperties: false },
    ),
    { maxItems: 64 },
  ),
});

/** Poll result carrying `NativeStageDispatch/v2` (optional capability delta). */
export const NativeStagePollResultV2 = versioned("NativeStagePollResult", 2, {
  accepted: Type.Boolean(),
  rejectionCode: Type.Optional(NativeBridgeRejectionCode),
  sessionRevision: Type.Integer({ minimum: 1 }),
  expiresAt: Type.String({ format: "date-time" }),
  pollAfterMs: Type.Integer({ minimum: 0 }),
  dispatches: Type.Array(Type.Ref(NativeStageDispatchV2), { maxItems: 16 }),
  resumes: Type.Array(
    Type.Object(
      {
        dispatchId: NativeDispatchId,
        dispatchRevision: Type.Integer({ minimum: 1 }),
        interactionId: InteractionId,
        interactionRevision: Type.Integer({ minimum: 1 }),
        answer: Type.Ref(InteractionAnswerSetV1),
      },
      { additionalProperties: false },
    ),
    { maxItems: 16 },
  ),
  revocations: Type.Array(
    Type.Object(
      {
        dispatchId: NativeDispatchId,
        dispatchRevision: Type.Integer({ minimum: 1 }),
        reason: Type.Union([
          Type.Literal("run_cancelled"),
          Type.Literal("lease_expired"),
          Type.Literal("superseded"),
          Type.Literal("recovery_required"),
        ]),
      },
      { additionalProperties: false },
    ),
    { maxItems: 64 },
  ),
});

/**
 * A native subagent's structured `needs_input` crosses as the *same*
 * `PendingInteraction/v2` an external backend raises through
 * `ExecutionBackend.interactions()`, and the daemon canonicalises it with
 * the same function. No native-only question contract is minted, so a
 * native question reaches the inbox and is answered through `run.answer`
 * exactly like any other — one code path, both `ProfileQuestionMode` values.
 */
export const NativeStageQuestionRequestV1 = versioned("NativeStageQuestionRequest", 1, {
  sessionId: ParentSessionId,
  sessionRevision: Type.Integer({ minimum: 1 }),
  dispatchId: NativeDispatchId,
  expectedDispatchRevision: Type.Integer({ minimum: 1 }),
  runId: RunId,
  stageId: StageId,
  attemptId: StageAttemptId,
  interaction: Type.Ref(PendingInteractionV2),
});

export const NativeStageQuestionResultV1 = versioned("NativeStageQuestionResult", 1, {
  accepted: Type.Boolean(),
  rejectionCode: Type.Optional(NativeBridgeRejectionCode),
  interactionId: Type.Optional(InteractionId),
  interactionRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  dispatchRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  status: Type.Optional(RunStatus.schema),
});

/**
 * The seven-field binding is checked as one compare-and-swap inside a single
 * transaction: session, session revision, dispatch, dispatch revision, run,
 * stage, and attempt. That tuple — not the unguessability of any id — is what
 * makes "rebinding cannot submit a result to the wrong run/stage/attempt"
 * true. Ids are random as defence in depth only.
 */
export const NativeStageSubmitRequestV1 = versioned("NativeStageSubmitRequest", 1, {
  sessionId: ParentSessionId,
  sessionRevision: Type.Integer({ minimum: 1 }),
  dispatchId: NativeDispatchId,
  expectedDispatchRevision: Type.Integer({ minimum: 1 }),
  runId: RunId,
  stageId: StageId,
  attemptId: StageAttemptId,
  submissionId: NativeSubmissionId,
  outcome: Type.Union([
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  result: Type.Optional(Type.Ref(ExternalStageResultV1)),
  failure: Type.Optional(Type.Ref(ExecutionFailureV1)),
});

export const NativeStageSubmitResultV1 = versioned("NativeStageSubmitResult", 1, {
  accepted: Type.Boolean(),
  rejectionCode: Type.Optional(NativeBridgeRejectionCode),
  idempotentReplay: Type.Boolean(),
  runId: RunId,
  stageId: StageId,
  attemptId: StageAttemptId,
  status: RunStatus.schema,
  stageRevision: Type.Integer({ minimum: 1 }),
});

/**
 * Attempt status reuses `ExecutionStatus` rather than minting a native-only
 * vocabulary, so an operator comparing a native attempt with an external one
 * is reading the same words. `waiting_for_parent_session` is deliberately
 * *not* available here: it is a property of the stage waiting for somebody
 * to connect, never of an attempt, which by construction only exists once a
 * parent has taken the work.
 */
export const NativeStageAttemptV1 = versioned("NativeStageAttempt", 1, {
  attemptId: StageAttemptId,
  runId: RunId,
  stageId: StageId,
  attemptOrdinal: Type.Integer({ minimum: 1 }),
  workspaceId: Type.Optional(WorkspaceId),
  status: ExecutionStatus.schema,
  dispatchId: Type.Optional(NativeDispatchId),
  failure: Type.Optional(Type.Ref(ExecutionFailureV1)),
  startedAt: Type.Optional(Type.String({ format: "date-time" })),
  finishedAt: Type.Optional(Type.String({ format: "date-time" })),
});

export const NativeStageStatusResultV1 = versioned("NativeStageStatusResult", 1, {
  runId: RunId,
  stageId: StageId,
  status: RunStatus.schema,
  runRevision: Type.Integer({ minimum: 1 }),
  stageState: NativeStageState.schema,
  stageRevision: Type.Integer({ minimum: 1 }),
  attemptCount: Type.Integer({ minimum: 0 }),
  currentAttemptId: Type.Optional(StageAttemptId),
  waitingSince: Type.Optional(Type.String({ format: "date-time" })),
  attempts: Type.Array(Type.Ref(NativeStageAttemptV1)),
  interactions: Type.Array(Type.Ref(InteractionV2)),
  result: Type.Optional(Type.Ref(ExternalStageResultV1)),
});
