/**
 * Provider-neutral review, repair, and verification contracts (Q031).
 *
 * Reports are immutable evidence. FindingSnapshot/v1 is the rebuildable
 * current-state view maintained by @heniek/state.
 */

import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { ArtifactId } from "../artifact/ids.js";
import { versioned } from "../kernel/index.js";
import { RunId } from "../run/ids.js";
import { PipelineStageId } from "./ids.js";

const NonEmptyText = Type.String({ minLength: 1, maxLength: 16_384 });
const FindingId = Type.String({
  minLength: 3,
  maxLength: 64,
  pattern: "^[A-Z][A-Z0-9_-]*$",
});
const ReportId = Type.String({ minLength: 1, maxLength: 128 });
const Digest = Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" });
const RelativePath = Type.String({
  minLength: 1,
  maxLength: 1024,
  pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\u0000).+$",
});

export const FindingSeverity = Type.Union([
  Type.Literal("critical"),
  Type.Literal("major"),
  Type.Literal("minor"),
]);

export const FindingEvidence = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("source"),
      path: RelativePath,
      startLine: Type.Integer({ minimum: 1 }),
      endLine: Type.Optional(Type.Integer({ minimum: 1 })),
      contentHash: Type.Optional(Digest),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("command"),
      checkId: Type.String({ minLength: 1, maxLength: 128 }),
      exitCode: Type.Integer({ minimum: 0, maximum: 255 }),
      artifactId: Type.Optional(ArtifactId),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("artifact"),
      artifactId: ArtifactId,
      contentHash: Digest,
    },
    { additionalProperties: false },
  ),
]);

const FindingDisposition = Type.Union([
  Type.Object({ status: Type.Literal("accepted") }, { additionalProperties: false }),
  Type.Object(
    { status: Type.Literal("rejected"), reason: NonEmptyText },
    { additionalProperties: false },
  ),
]);

const ClaimVerification = Type.Union([
  Type.Object(
    {
      state: Type.Literal("verified"),
      evidence: Type.Array(FindingEvidence, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal("retracted"),
      evidence: Type.Array(FindingEvidence, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
]);

export const ReviewFindingV1 = versioned("ReviewFinding", 1, {
  findingId: FindingId,
  severity: FindingSeverity,
  title: Type.String({ minLength: 1, maxLength: 256 }),
  detail: NonEmptyText,
  evidence: Type.Array(FindingEvidence, { minItems: 1 }),
  disposition: FindingDisposition,
  claimVerification: ClaimVerification,
});

const ReportHeader = {
  reportId: ReportId,
  runId: RunId,
  stageId: PipelineStageId,
  sourceArtifactIds: Type.Array(ArtifactId, { uniqueItems: true }),
  markdown: NonEmptyText,
  createdAt: Type.String({ format: "date-time" }),
};

export const ReviewReportV1 = versioned("ReviewReport", 1, {
  ...ReportHeader,
  reviewKind: Type.Union([
    Type.Literal("design-critique"),
    Type.Literal("plan-validation"),
    Type.Literal("code-review"),
  ]),
  contextPolicy: Type.Literal("fresh"),
  verdict: Type.Union([
    Type.Literal("ready"),
    Type.Literal("needs-repair"),
    Type.Literal("blocked"),
  ]),
  findings: Type.Array(Type.Ref(ReviewFindingV1)),
});

export const RepairEntryV1 = Type.Object(
  {
    findingId: FindingId,
    outcome: Type.Union([Type.Literal("applied"), Type.Literal("skipped"), Type.Literal("failed")]),
    reason: Type.Optional(NonEmptyText),
    evidence: Type.Array(FindingEvidence, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const RepairReportV1 = versioned("RepairReport", 1, {
  ...ReportHeader,
  sourceReportId: ReportId,
  entries: Type.Array(RepairEntryV1),
});

export const FindingVerificationResultV1 = Type.Object(
  {
    findingId: FindingId,
    result: Type.Union([
      Type.Literal("fixed"),
      Type.Literal("unresolved"),
      Type.Literal("not_applicable"),
    ]),
    evidence: Type.Array(FindingEvidence, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const FinalVerificationReportV1 = versioned("FinalVerificationReport", 1, {
  ...ReportHeader,
  sourceReviewReportIds: Type.Array(ReportId, { minItems: 1, uniqueItems: true }),
  sourceRepairReportIds: Type.Array(ReportId, { uniqueItems: true }),
  deterministicCheckArtifactIds: Type.Array(ArtifactId, { minItems: 1, uniqueItems: true }),
  verdict: Type.Union([Type.Literal("ready"), Type.Literal("blocked")]),
  findings: Type.Array(FindingVerificationResultV1),
});

export const FindingSnapshotV1 = versioned("FindingSnapshot", 1, {
  runId: RunId,
  findingId: FindingId,
  originReportId: ReportId,
  originStageId: PipelineStageId,
  severity: FindingSeverity,
  disposition: Type.Union([Type.Literal("accepted"), Type.Literal("rejected")]),
  claimVerificationState: Type.Union([Type.Literal("verified"), Type.Literal("retracted")]),
  repairState: Type.Union([
    Type.Literal("pending"),
    Type.Literal("applied"),
    Type.Literal("skipped"),
    Type.Literal("failed"),
    Type.Literal("not_required"),
  ]),
  resolutionState: Type.Union([
    Type.Literal("pending"),
    Type.Literal("fixed"),
    Type.Literal("unresolved"),
    Type.Literal("not_applicable"),
  ]),
  latestReportId: ReportId,
  latestReportArtifactId: ArtifactId,
  latestReportContentHash: Digest,
  evidence: Type.Array(FindingEvidence, { minItems: 1 }),
  revision: Type.Integer({ minimum: 1 }),
  updatedAt: Type.String({ format: "date-time" }),
});

export type FindingEvidence = Static<typeof FindingEvidence>;
export type FindingSeverity = Static<typeof FindingSeverity>;
export type ReviewFindingV1 = Static<typeof ReviewFindingV1>;
export type ReviewReportV1 = Static<typeof ReviewReportV1>;
export type RepairReportV1 = Static<typeof RepairReportV1>;
export type FinalVerificationReportV1 = Static<typeof FinalVerificationReportV1>;
export type FindingSnapshotV1 = Static<typeof FindingSnapshotV1>;

export type StructuredReviewReport = ReviewReportV1 | RepairReportV1 | FinalVerificationReportV1;

export const REVIEW_REPORT_SCHEMA_NAMES = {
  "review-report-v1": ReviewReportV1,
  "repair-report-v1": RepairReportV1,
  "final-verification-report-v1": FinalVerificationReportV1,
} as const;

export type ReviewReportSchemaName = keyof typeof REVIEW_REPORT_SCHEMA_NAMES;
