import { type Static, Type } from "@sinclair/typebox";
import { versioned } from "../kernel/index.js";
import { RepositoryId, WorkspaceId, WorkspaceVariantId } from "../run/index.js";

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const IsoDateTime = Type.String({ format: "date-time" });

const VerificationCheckEvidence = Type.Object(
  {
    checkId: Type.String({ minLength: 1, maxLength: 128 }),
    scope: Type.Union([Type.Literal("repository"), Type.Literal("whole-codebase")]),
    repositoryId: Type.Union([RepositoryId, Type.Null()]),
    argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    cwd: Type.String({ minLength: 1 }),
    expectedExitCode: Type.Integer({ minimum: 0, maximum: 255 }),
    actualExitCode: Type.Union([Type.Integer(), Type.Null()]),
    required: Type.Boolean(),
    outcome: Type.Union([
      Type.Literal("passed"),
      Type.Literal("failed"),
      Type.Literal("timed-out"),
      Type.Literal("execution-error"),
    ]),
    logPath: Type.String({ minLength: 1 }),
    logSha256: Sha256,
    startedAt: IsoDateTime,
    finishedAt: IsoDateTime,
  },
  { additionalProperties: false },
);

/** Immutable fan-in evidence for repository-local and whole-Codebase checks. */
export const CombinedVerificationReportV1 = versioned("CombinedVerificationReport", 1, {
  reportId: Type.String({ minLength: 1, maxLength: 128 }),
  workspaceId: WorkspaceId,
  variantId: WorkspaceVariantId,
  classification: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
  checks: Type.Array(VerificationCheckEvidence, { minItems: 1 }),
  failedRepositoryIds: Type.Array(RepositoryId, { uniqueItems: true }),
  wholeCodebaseFailed: Type.Boolean(),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
});

export const WorkspaceRecoveryPhase = Type.Union([
  Type.Literal("provisioning"),
  Type.Literal("setup"),
  Type.Literal("leases"),
  Type.Literal("processes"),
  Type.Literal("artifacts"),
  Type.Literal("integration-refs"),
]);

const RecoveryDecision = Type.Object(
  {
    sequence: Type.Integer({ minimum: 1, maximum: 6 }),
    phase: WorkspaceRecoveryPhase,
    observedState: Type.Union([
      Type.Literal("complete"),
      Type.Literal("not-started"),
      Type.Literal("in-progress"),
      Type.Literal("missing"),
      Type.Literal("ambiguous"),
    ]),
    ownership: Type.Union([
      Type.Literal("heniek"),
      Type.Literal("external"),
      Type.Literal("unknown"),
    ]),
    action: Type.Union([
      Type.Literal("confirmed"),
      Type.Literal("resume"),
      Type.Literal("retry"),
      Type.Literal("preserve"),
      Type.Literal("operator-action"),
    ]),
    detail: Type.String({ minLength: 1, maxLength: 4096 }),
  },
  { additionalProperties: false },
);

/** Ordered restart decision trace across every composite-operation boundary. */
export const WorkspaceRecoveryDecisionTraceV1 = versioned("WorkspaceRecoveryDecisionTrace", 1, {
  workspaceId: WorkspaceId,
  variantId: WorkspaceVariantId,
  classification: Type.Union([Type.Literal("reconciled"), Type.Literal("recovery-required")]),
  decisions: Type.Array(RecoveryDecision, { minItems: 6, maxItems: 6 }),
  recordedAt: IsoDateTime,
});

/** Evidence-first cleanup result; `removed` is possible only after archival. */
export const WorkspaceCleanupResultV1 = versioned("WorkspaceCleanupResult", 1, {
  workspaceId: WorkspaceId,
  variantId: WorkspaceVariantId,
  classification: Type.Union([
    Type.Literal("removed"),
    Type.Literal("preserved"),
    Type.Literal("recovery-required"),
  ]),
  checkoutPath: Type.String({ minLength: 1 }),
  evidenceArchived: Type.Boolean(),
  archivePath: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  archiveSha256: Type.Union([Sha256, Type.Null()]),
  checkoutRemoved: Type.Boolean(),
  reasons: Type.Array(Type.String({ minLength: 1, maxLength: 4096 })),
  recordedAt: IsoDateTime,
});

export type CombinedVerificationReport = Static<typeof CombinedVerificationReportV1>;
export type WorkspaceRecoveryDecisionTrace = Static<typeof WorkspaceRecoveryDecisionTraceV1>;
export type WorkspaceCleanupResult = Static<typeof WorkspaceCleanupResultV1>;
export type WorkspaceRecoveryPhase = Static<typeof WorkspaceRecoveryPhase>;
