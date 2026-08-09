/**
 * Recovery / bounded-repair contracts (Q028).
 *
 * Classifies stage failures into policy categories, fingerprints unchanged
 * failure signatures, and records auditable propose/approve/dispatch decisions
 * without mutating frozen V1 scheduler or runner envelopes.
 */

import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { ProfileId } from "../execution-backend/ids.js";
import { versioned } from "../kernel/index.js";
import { RunId } from "../run/ids.js";
import { PipelineAttemptId, PipelineRecoveryDecisionId, PipelineStageId } from "./ids.js";
import { StageRunnerFailureClassV2 } from "./runner.js";
import { PipelineFailureCategory, PipelineRetryMode, PipelineSessionPolicy } from "./vocabulary.js";

const Sha256Hex = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[0-9a-f]{64}$",
});

/**
 * Policy-facing failure after runner classification and upper-bound mapping.
 * `retryable` is the post-policy flag; `runnerRetryable` preserves the runner's
 * original signal.
 */
export const PipelineFailureV1 = versioned("PipelineFailure", 1, {
  category: PipelineFailureCategory,
  classification: StageRunnerFailureClassV2,
  phase: Type.String({ minLength: 1, maxLength: 64 }),
  code: Type.String({ minLength: 1, maxLength: 128 }),
  retryable: Type.Boolean(),
  runnerRetryable: Type.Boolean(),
  backendClassification: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  validationFailures: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

/**
 * Canonical fingerprint of a failure for unchanged-signature exhaustion.
 * `digest` is sha256 of the canonical signature payload (not of this object).
 */
export const PipelineFailureSignatureV1 = versioned("PipelineFailureSignature", 1, {
  digest: Sha256Hex,
  category: PipelineFailureCategory,
  classification: Type.String({ minLength: 1, maxLength: 128 }),
  phase: Type.String({ minLength: 1, maxLength: 64 }),
  code: Type.String({ minLength: 1, maxLength: 128 }),
  backendClassification: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  validationFailures: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

/** How the next attempt should bind session, prior identity, and delegation. */
export const PipelineRetryDirectiveV1 = versioned("PipelineRetryDirective", 1, {
  mode: PipelineRetryMode,
  sessionPolicy: PipelineSessionPolicy,
  priorAttemptId: Type.Optional(PipelineAttemptId),
  priorBackendExecutionId: Type.Optional(Type.String({ minLength: 1 })),
  delegateTo: Type.Optional(ProfileId),
  recoveryContextDigest: Type.Optional(Sha256Hex),
});

const PipelineRecoveryDecisionAction = Type.Union([
  Type.Literal("propose"),
  Type.Literal("approve"),
  Type.Literal("reject"),
  Type.Literal("dispatch"),
  Type.Literal("block"),
  Type.Literal("fail"),
  Type.Literal("exhaust"),
]);

const PipelineRecoveryDecisionOutcome = Type.Union([
  Type.Literal("pause"),
  Type.Literal("fail"),
  Type.Literal("repair"),
  Type.Literal("repair_fresh"),
  Type.Literal("delegate"),
  Type.Literal("exhausted"),
  Type.Literal("unchanged_exhausted"),
  Type.Literal("rejected"),
  Type.Literal("blocked"),
]);

/**
 * Append-only recovery decision. Links HITL propose/approve/reject flows to
 * repair dispatch via `proposalId` and carries budget counters for audit.
 */
export const PipelineRecoveryDecisionV1 = versioned("PipelineRecoveryDecision", 1, {
  decisionId: PipelineRecoveryDecisionId,
  runId: RunId,
  stageId: PipelineStageId,
  graphRevision: Type.Integer({ minimum: 1 }),
  generation: Type.Integer({ minimum: 1 }),
  attemptOrdinal: Type.Integer({ minimum: 0 }),
  action: PipelineRecoveryDecisionAction,
  outcome: PipelineRecoveryDecisionOutcome,
  failure: Type.Optional(Type.Ref(PipelineFailureV1)),
  signature: Type.Optional(Type.Ref(PipelineFailureSignatureV1)),
  directive: Type.Optional(Type.Ref(PipelineRetryDirectiveV1)),
  proposalId: Type.Optional(Type.String({ minLength: 1 })),
  repairsUsed: Type.Integer({ minimum: 0 }),
  repairBudget: Type.Integer({ minimum: 0 }),
  identicalSignatureCount: Type.Integer({ minimum: 0 }),
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  recordedAt: Type.String({ format: "date-time" }),
});

export type PipelineFailureV1 = Static<typeof PipelineFailureV1>;
export type PipelineFailureSignatureV1 = Static<typeof PipelineFailureSignatureV1>;
export type PipelineRetryDirectiveV1 = Static<typeof PipelineRetryDirectiveV1>;
export type PipelineRecoveryDecisionV1 = Static<typeof PipelineRecoveryDecisionV1>;
