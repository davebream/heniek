/**
 * Provider-neutral fixed-stage operation contracts (Q027, ADR 0025).
 *
 * These request/result envelopes are independent of GitHub DTOs. Runners
 * persist the immutable request before any Git or Forge side effect and
 * reconcile against the typed result after restart.
 */

import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { PullRequestId } from "../forge-backend/ids.js";
import { versioned } from "../kernel/index.js";
import { RepositoryId, RunId } from "../run/ids.js";
import { PipelineAttemptId, PipelineSchedulerIntentId, PipelineStageId } from "./ids.js";

/** Full Git object id (sha-1). */
const GitObjectId = Type.String({
  minLength: 40,
  maxLength: 40,
  pattern: "^[0-9a-f]{40}$",
});

const IsoTimestamp = Type.String({ format: "date-time" });

/**
 * Coordinates that let an approval answer resume the exact waiting attempt.
 * Stored with the request so a restart can reattach without ambient lookup.
 */
export const ApprovalContinuationV1 = versioned("ApprovalContinuation", 1, {
  runId: RunId,
  stageId: PipelineStageId,
  attemptId: PipelineAttemptId,
  intentId: PipelineSchedulerIntentId,
  interactionId: Type.String({ minLength: 1, maxLength: 128 }),
});

/** Immutable approval gate request — never auto-answered in HITL. */
export const ApprovalRequestV1 = versioned("ApprovalRequest", 1, {
  prompt: Type.String({ minLength: 1, maxLength: 4096 }),
  header: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  options: Type.Array(
    Type.Object(
      {
        label: Type.String({ minLength: 1, maxLength: 128 }),
        description: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
      },
      { additionalProperties: false },
    ),
    { minItems: 2, maxItems: 8 },
  ),
  continuation: Type.Ref(ApprovalContinuationV1),
  requestedAt: IsoTimestamp,
  timeoutAt: Type.Optional(IsoTimestamp),
});

/** Compare-and-set approval answer with authenticated actor provenance. */
export const ApprovalDecisionV1 = versioned("ApprovalDecision", 1, {
  interactionId: Type.String({ minLength: 1, maxLength: 128 }),
  expectedInteractionRevision: Type.Integer({ minimum: 1 }),
  decision: Type.Union([Type.Literal("approve"), Type.Literal("reject")]),
  answeredByKeyId: Type.String({ minLength: 1, maxLength: 256 }),
  answeredAt: IsoTimestamp,
  selectedLabel: Type.String({ minLength: 1, maxLength: 128 }),
});

export const IntegrationConflictClass = Type.Union([
  Type.Literal("none"),
  Type.Literal("stale_source"),
  Type.Literal("stale_target"),
  Type.Literal("merge_conflict"),
  Type.Literal("already_applied"),
  Type.Literal("irreconcilable_external"),
]);
export type IntegrationConflictClass = Static<typeof IntegrationConflictClass>;

/** Expected-SHA integration into one repository ref. */
export const IntegrationRequestV1 = versioned("IntegrationRequest", 1, {
  repositoryId: RepositoryId,
  sourceRef: Type.String({ minLength: 1, maxLength: 256 }),
  targetRef: Type.String({ minLength: 1, maxLength: 256 }),
  expectedSourceSha: GitObjectId,
  expectedTargetSha: GitObjectId,
  message: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
});

export const IntegrationResultV1 = versioned("IntegrationResult", 1, {
  repositoryId: RepositoryId,
  sourceRef: Type.String({ minLength: 1, maxLength: 256 }),
  targetRef: Type.String({ minLength: 1, maxLength: 256 }),
  expectedSourceSha: GitObjectId,
  expectedTargetSha: GitObjectId,
  candidateSha: Type.Optional(GitObjectId),
  resultSha: Type.Optional(GitObjectId),
  classification: IntegrationConflictClass,
  targetMoved: Type.Boolean(),
  finishedAt: IsoTimestamp,
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
});

/** One ordered argv check — never shell-interpolated. */
export const VerifyCheckV1 = versioned("VerifyCheck", 1, {
  checkId: Type.String({ minLength: 1, maxLength: 128 }),
  argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  cwd: Type.Optional(
    Type.String({
      minLength: 1,
      pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\u0000).+$",
    }),
  ),
  env: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
  expectedExitCode: Type.Integer({ minimum: 0, maximum: 255 }),
  required: Type.Boolean(),
});

export const VerifyRequestV1 = versioned("VerifyRequest", 1, {
  checks: Type.Array(Type.Ref(VerifyCheckV1), { minItems: 1 }),
});

export const VerifyCheckEvidenceV1 = versioned("VerifyCheckEvidence", 1, {
  checkId: Type.String({ minLength: 1, maxLength: 128 }),
  argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  exitCode: Type.Integer({ minimum: 0, maximum: 255 }),
  expectedExitCode: Type.Integer({ minimum: 0, maximum: 255 }),
  satisfied: Type.Boolean(),
  required: Type.Boolean(),
  startedAt: IsoTimestamp,
  finishedAt: IsoTimestamp,
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
});

export const VerifyVerdict = Type.Union([
  Type.Literal("passed"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("malformed"),
]);
export type VerifyVerdict = Static<typeof VerifyVerdict>;

export const VerifyResultV1 = versioned("VerifyResult", 1, {
  verdict: VerifyVerdict,
  checks: Type.Array(Type.Ref(VerifyCheckEvidenceV1)),
  finishedAt: IsoTimestamp,
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
});

export const PublishPullRequestSpecV1 = versioned("PublishPullRequestSpec", 1, {
  repositoryId: RepositoryId,
  sourceBranch: Type.String({ minLength: 1, maxLength: 256 }),
  targetBranch: Type.String({ minLength: 1, maxLength: 256 }),
  title: Type.String({ minLength: 1, maxLength: 512 }),
  body: Type.String({ maxLength: 65536 }),
  expectedHeadSha: GitObjectId,
  draft: Type.Boolean(),
  markReady: Type.Boolean(),
  enableAutoMerge: Type.Boolean(),
});

/** Stable publication key — identical keys must reconcile to one resource. */
export const PublishRequestV1 = versioned("PublishRequest", 1, {
  publicationKey: Type.String({ minLength: 1, maxLength: 256 }),
  pullRequest: Type.Ref(PublishPullRequestSpecV1),
});

export const PublishOutcomeClass = Type.Union([
  Type.Literal("created"),
  Type.Literal("adopted"),
  Type.Literal("mismatched_head"),
  Type.Literal("ambiguous"),
  Type.Literal("forge_failed"),
  Type.Literal("cancelled"),
]);
export type PublishOutcomeClass = Static<typeof PublishOutcomeClass>;

export const PublishResultV1 = versioned("PublishResult", 1, {
  publicationKey: Type.String({ minLength: 1, maxLength: 256 }),
  outcome: PublishOutcomeClass,
  pullRequestId: Type.Optional(PullRequestId),
  number: Type.Optional(Type.Integer({ minimum: 1 })),
  url: Type.Optional(Type.String({ format: "uri" })),
  headSha: Type.Optional(Type.String({ minLength: 1 })),
  draft: Type.Optional(Type.Boolean()),
  autoMergeEnabled: Type.Optional(Type.Boolean()),
  finishedAt: IsoTimestamp,
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
});

/** Append-only observation of an external Git/Forge fact. */
export const RunnerExternalObservationV1 = versioned("RunnerExternalObservation", 1, {
  observationId: Type.String({ minLength: 1, maxLength: 128 }),
  attemptId: PipelineAttemptId,
  kind: Type.Union([
    Type.Literal("git_ref_read"),
    Type.Literal("git_merge_prepared"),
    Type.Literal("git_ref_updated"),
    Type.Literal("forge_pr_listed"),
    Type.Literal("forge_pr_created"),
    Type.Literal("forge_pr_adopted"),
    Type.Literal("forge_pr_ready"),
    Type.Literal("forge_auto_merge"),
    Type.Literal("forge_fault"),
  ]),
  recordedAt: IsoTimestamp,
  payload: Type.Unknown(),
});

/** Append-only reconciliation classification for integration/publish. */
export const RunnerReconciliationTraceV1 = versioned("RunnerReconciliationTrace", 1, {
  traceId: Type.String({ minLength: 1, maxLength: 128 }),
  attemptId: PipelineAttemptId,
  stageType: Type.Union([Type.Literal("integration"), Type.Literal("publish")]),
  classification: Type.String({ minLength: 1, maxLength: 128 }),
  recordedAt: IsoTimestamp,
  detail: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  payload: Type.Optional(Type.Unknown()),
});

export type ApprovalContinuationV1 = Static<typeof ApprovalContinuationV1>;
export type ApprovalRequestV1 = Static<typeof ApprovalRequestV1>;
export type ApprovalDecisionV1 = Static<typeof ApprovalDecisionV1>;
export type IntegrationRequestV1 = Static<typeof IntegrationRequestV1>;
export type IntegrationResultV1 = Static<typeof IntegrationResultV1>;
export type VerifyCheckV1 = Static<typeof VerifyCheckV1>;
export type VerifyRequestV1 = Static<typeof VerifyRequestV1>;
export type VerifyCheckEvidenceV1 = Static<typeof VerifyCheckEvidenceV1>;
export type VerifyResultV1 = Static<typeof VerifyResultV1>;
export type PublishPullRequestSpecV1 = Static<typeof PublishPullRequestSpecV1>;
export type PublishRequestV1 = Static<typeof PublishRequestV1>;
export type PublishResultV1 = Static<typeof PublishResultV1>;
export type RunnerExternalObservationV1 = Static<typeof RunnerExternalObservationV1>;
export type RunnerReconciliationTraceV1 = Static<typeof RunnerReconciliationTraceV1>;
