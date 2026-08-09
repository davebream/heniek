/**
 * Segment fusion, smart continuation, and incoming verification (Q029).
 *
 * Provider-neutral contracts for execution segments, fuse/split decisions,
 * continuation capsules, and pre-start verification. Capsules never carry
 * transcripts or credentials — only bounded references and exact coordinates.
 */

import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { ArtifactId } from "../artifact/index.js";
import { ProfileId } from "../execution-backend/ids.js";
import { versioned } from "../kernel/index.js";
import { RepositoryId, RunId, WorkspaceId } from "../run/ids.js";
import {
  PipelineAttemptId,
  PipelineContinuationCapsuleId,
  PipelineFusionDecisionId,
  PipelineIncomingVerificationId,
  PipelineSegmentId,
  PipelineStageId,
} from "./ids.js";

const Sha256Hex = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[0-9a-f]{64}$",
});

/** Bound for capsule narrative Markdown (32 KiB). */
export const CONTINUATION_NARRATIVE_MAX_BYTES = 32 * 1024;
/** Bound for individual description / next-action strings (1 KiB). */
export const CONTINUATION_DESCRIPTION_MAX_BYTES = 1024;
/** Bound for reference collections on a capsule. */
export const CONTINUATION_REFERENCE_COLLECTION_MAX = 64;
/** Bound for plan-item collections on a capsule. */
export const CONTINUATION_PLAN_ITEMS_MAX = 256;

const BoundedDescription = Type.String({
  minLength: 1,
  maxLength: CONTINUATION_DESCRIPTION_MAX_BYTES,
});

const ArtifactReference = Type.Object(
  {
    artifactId: ArtifactId,
    contentHash: Sha256Hex,
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);

const ContextFileReference = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 512 }),
    contentHash: Type.Optional(Sha256Hex),
  },
  { additionalProperties: false },
);

const RepositoryHeadWitness = Type.Object(
  {
    repositoryId: RepositoryId,
    head: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { additionalProperties: false },
);

export const PipelineFusionSplitReason = Type.Union([
  Type.Literal("explicit_fresh"),
  Type.Literal("profile_mismatch"),
  Type.Literal("fingerprint_mismatch"),
  Type.Literal("permissions_mismatch"),
  Type.Literal("workspace_mismatch"),
  Type.Literal("lease_mismatch"),
  Type.Literal("backend_no_continuation"),
  Type.Literal("fresh_review_required"),
  Type.Literal("retry_requires_fresh"),
  Type.Literal("delegated_recovery"),
  Type.Literal("branching_ambiguity"),
  Type.Literal("pressure_unavailable"),
  Type.Literal("pressure_contradictory"),
  Type.Literal("pressure_soft_threshold"),
  Type.Literal("pressure_hard_threshold"),
  Type.Literal("capacity_exhausted"),
  Type.Literal("non_agent_stage"),
  Type.Literal("not_adjacent"),
]);
export type PipelineFusionSplitReason = Static<typeof PipelineFusionSplitReason>;

export const PipelineFusionOutcome = Type.Union([Type.Literal("fuse"), Type.Literal("split")]);
export type PipelineFusionOutcome = Static<typeof PipelineFusionOutcome>;

export const PipelineSegmentStatus = Type.Union([
  Type.Literal("open"),
  Type.Literal("checkpointed"),
  Type.Literal("closed"),
  Type.Literal("blocked"),
]);
export type PipelineSegmentStatus = Static<typeof PipelineSegmentStatus>;

export const PipelinePressureConfidence = Type.Union([
  Type.Literal("exact"),
  Type.Literal("estimated"),
  Type.Literal("unavailable"),
]);
export type PipelinePressureConfidence = Static<typeof PipelinePressureConfidence>;

export const PipelinePressureObservationV1 = Type.Object(
  {
    ratio: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    confidence: PipelinePressureConfidence,
    state: Type.Union([
      Type.Literal("measured"),
      Type.Literal("exhausted"),
      Type.Literal("unavailable"),
    ]),
    softThreshold: Type.Number({ minimum: 0, maximum: 1 }),
    hardThreshold: Type.Number({ minimum: 0, maximum: 1 }),
    telemetryCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);
export type PipelinePressureObservationV1 = Static<typeof PipelinePressureObservationV1>;

/**
 * One live provider session owned by the runtime. Stages listed in
 * `stageIds` completed (or are completing) inside this segment; the segment
 * owns workspace and backend execution identity.
 */
export const PipelineExecutionSegmentV1 = versioned("PipelineExecutionSegment", 1, {
  segmentId: PipelineSegmentId,
  runId: RunId,
  profileId: ProfileId,
  profileFingerprint: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  workspaceId: Type.Optional(WorkspaceId),
  leaseId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  backendExecutionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  stageIds: Type.Array(PipelineStageId, { maxItems: CONTINUATION_REFERENCE_COLLECTION_MAX }),
  status: PipelineSegmentStatus,
  softThreshold: Type.Number({ minimum: 0, maximum: 1 }),
  hardThreshold: Type.Number({ minimum: 0, maximum: 1 }),
  telemetryCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  capsuleId: Type.Optional(PipelineContinuationCapsuleId),
  startedAt: Type.String({ format: "date-time" }),
  closedAt: Type.Optional(Type.String({ format: "date-time" })),
});

/**
 * Auditable fuse-or-split record between a predecessor and a successor stage
 * (or between successive segments of one unfinished stage).
 */
export const PipelineFusionDecisionV1 = versioned("PipelineFusionDecision", 1, {
  decisionId: PipelineFusionDecisionId,
  runId: RunId,
  fromStageId: PipelineStageId,
  toStageId: PipelineStageId,
  fromAttemptId: Type.Optional(PipelineAttemptId),
  toAttemptId: Type.Optional(PipelineAttemptId),
  outcome: PipelineFusionOutcome,
  splitReason: Type.Optional(PipelineFusionSplitReason),
  segmentId: Type.Optional(PipelineSegmentId),
  pressure: Type.Optional(PipelinePressureObservationV1),
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  recordedAt: Type.String({ format: "date-time" }),
});

/**
 * Machine continuation capsule (§15.4). `digest` is sha256 of the canonical
 * payload excluding `digest` itself. Narrative Markdown is stored beside the
 * capsule (filesystem) and referenced by `narrativeDigest` only.
 */
export const PipelineContinuationCapsuleV1 = versioned("PipelineContinuationCapsule", 1, {
  capsuleId: PipelineContinuationCapsuleId,
  runId: RunId,
  stageId: PipelineStageId,
  attemptId: PipelineAttemptId,
  segmentId: PipelineSegmentId,
  segmentOrdinal: Type.Integer({ minimum: 0 }),
  completedPlanItems: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
    maxItems: CONTINUATION_PLAN_ITEMS_MAX,
  }),
  activePlanItem: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  remainingPlanItems: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      maxItems: CONTINUATION_PLAN_ITEMS_MAX,
    }),
  ),
  nextAction: BoundedDescription,
  repositoryHeads: Type.Array(RepositoryHeadWitness, {
    maxItems: CONTINUATION_REFERENCE_COLLECTION_MAX,
  }),
  dirtyFiles: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    maxItems: CONTINUATION_REFERENCE_COLLECTION_MAX,
  }),
  artifactRefs: Type.Array(ArtifactReference, {
    maxItems: CONTINUATION_REFERENCE_COLLECTION_MAX,
  }),
  contextFileRefs: Type.Array(ContextFileReference, {
    maxItems: CONTINUATION_REFERENCE_COLLECTION_MAX,
  }),
  decisionIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
    maxItems: CONTINUATION_REFERENCE_COLLECTION_MAX,
  }),
  unresolvedQuestionIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
    maxItems: CONTINUATION_REFERENCE_COLLECTION_MAX,
  }),
  riskRefs: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
    maxItems: CONTINUATION_REFERENCE_COLLECTION_MAX,
  }),
  telemetryCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  outgoingSessionId: Type.String({ minLength: 1, maxLength: 256 }),
  narrativeDigest: Type.Optional(Sha256Hex),
  omittedNarrativeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  omittedDescriptionCount: Type.Optional(Type.Integer({ minimum: 0 })),
  digest: Sha256Hex,
  createdAt: Type.String({ format: "date-time" }),
});

export const PipelineIncomingVerificationBlocker = Type.Union([
  Type.Literal("schema_invalid"),
  Type.Literal("digest_mismatch"),
  Type.Literal("missing_artifact"),
  Type.Literal("artifact_hash_mismatch"),
  Type.Literal("missing_context_file"),
  Type.Literal("context_file_hash_mismatch"),
  Type.Literal("stale_head"),
  Type.Literal("dirty_set_mismatch"),
  Type.Literal("contradictory_completion"),
  Type.Literal("cheap_check_failed"),
  Type.Literal("tampered_capsule"),
]);
export type PipelineIncomingVerificationBlocker = Static<
  typeof PipelineIncomingVerificationBlocker
>;

/**
 * Verdict recorded before any capsule-backed fresh segment starts. Failures
 * never trigger automatic repository mutation.
 */
export const PipelineIncomingVerificationV1 = versioned("PipelineIncomingVerification", 1, {
  verificationId: PipelineIncomingVerificationId,
  capsuleId: PipelineContinuationCapsuleId,
  runId: RunId,
  segmentId: Type.Optional(PipelineSegmentId),
  verdict: Type.Union([Type.Literal("pass"), Type.Literal("block")]),
  blockers: Type.Array(PipelineIncomingVerificationBlocker, {
    maxItems: CONTINUATION_REFERENCE_COLLECTION_MAX,
  }),
  observedHeads: Type.Array(RepositoryHeadWitness, {
    maxItems: CONTINUATION_REFERENCE_COLLECTION_MAX,
  }),
  observedDirtyFiles: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    maxItems: CONTINUATION_REFERENCE_COLLECTION_MAX,
  }),
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  recordedAt: Type.String({ format: "date-time" }),
});

export type PipelineExecutionSegmentV1 = Static<typeof PipelineExecutionSegmentV1>;
export type PipelineFusionDecisionV1 = Static<typeof PipelineFusionDecisionV1>;
export type PipelineContinuationCapsuleV1 = Static<typeof PipelineContinuationCapsuleV1>;
export type PipelineIncomingVerificationV1 = Static<typeof PipelineIncomingVerificationV1>;
