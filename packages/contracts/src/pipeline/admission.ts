/**
 * Pipeline admission, invocation overrides, run snapshots, and ad-hoc
 * attachment contracts (Q032).
 *
 * Named and one-off graphs share one admission door. Overrides are closed,
 * allowlisted, and source-traced. Attachment imports a completed source stage
 * into a live target run as a synthetic succeeded stage through an immutable
 * graph revision — never by mutating a template or silently linking an
 * unvalidated artifact.
 */

import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { ArtifactId } from "../artifact/ids.js";
import { versioned } from "../kernel/index.js";
import { CodebaseId, RunId } from "../run/ids.js";
import { PipelineId, PipelineStageId } from "./ids.js";
import { PipelineGraphV1 } from "./schemas.js";
import { PipelineExecutionMode } from "./vocabulary.js";

const Digest = Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" });
const NonEmpty = Type.String({ minLength: 1, maxLength: 1024 });
const IsoDateTime = Type.String({ format: "date-time" });
const FieldName = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
});

/** Where a named pipeline definition was resolved from. */
export const PipelineDefinitionSourceKind = Type.Union([
  Type.Literal("bundled"),
  Type.Literal("global"),
  Type.Literal("codebase-override"),
  Type.Literal("one-off"),
]);
export type PipelineDefinitionSourceKind = Static<typeof PipelineDefinitionSourceKind>;

/**
 * Closed set of invocation override fields admitted at the pipeline layer.
 * Profile-shaped fields intersect stage + profile `overridable` allowlists;
 * `mode` requires the target stage allowlist; hard limits use configuration
 * policy (strictest-wins) and never invent new limit keys here.
 */
export const PipelineInvocationOverrideField = Type.Union([
  Type.Literal("mode"),
  Type.Literal("engine"),
  Type.Literal("account"),
  Type.Literal("billing"),
  Type.Literal("model"),
  Type.Literal("effort"),
  Type.Literal("executor"),
  Type.Literal("focus"),
  Type.Literal("max_duration"),
  Type.Literal("workspace_strategy"),
  Type.Literal("max_pipeline_duration"),
  Type.Literal("max_concurrent_workers"),
  Type.Literal("max_repair_attempts"),
  Type.Literal("max_graph_revisions"),
]);
export type PipelineInvocationOverrideField = Static<typeof PipelineInvocationOverrideField>;

export const PipelineOverrideTarget = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("pipeline"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("stage"),
      stageId: PipelineStageId,
    },
    { additionalProperties: false },
  ),
]);
export type PipelineOverrideTarget = Static<typeof PipelineOverrideTarget>;

/** One caller-requested override before admission resolves it. */
export const PipelineInvocationOverrideRequestV1 = versioned(
  "PipelineInvocationOverrideRequest",
  1,
  {
    target: PipelineOverrideTarget,
    field: FieldName,
    value: Type.Unknown(),
  },
);
export type PipelineInvocationOverrideRequestV1 = Static<
  typeof PipelineInvocationOverrideRequestV1
>;

/** One applied override with redacted provenance for the run snapshot. */
export const PipelineAppliedOverrideV1 = versioned("PipelineAppliedOverride", 1, {
  target: PipelineOverrideTarget,
  field: PipelineInvocationOverrideField,
  /** Redacted JSON value — credentials never persist here. */
  value: Type.Unknown(),
  source: Type.Union([
    Type.Literal("invocation"),
    Type.Literal("stage-allowlist"),
    Type.Literal("profile-allowlist"),
    Type.Literal("configuration-policy"),
  ]),
  redacted: Type.Boolean(),
});
export type PipelineAppliedOverrideV1 = Static<typeof PipelineAppliedOverrideV1>;

export const PipelineDefinitionSourceV1 = versioned("PipelineDefinitionSource", 1, {
  kind: PipelineDefinitionSourceKind,
  identity: NonEmpty,
  digest: Digest,
  path: Type.Optional(NonEmpty),
});
export type PipelineDefinitionSourceV1 = Static<typeof PipelineDefinitionSourceV1>;

export const PipelineValidateRequestV1 = versioned("PipelineValidateRequest", 1, {
  source: Type.Union([
    Type.Object(
      {
        kind: Type.Literal("named"),
        pipelineId: PipelineId,
        codebaseId: Type.Optional(CodebaseId),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("one-off"),
        /** YAML or JSON PipelineDefinition/v1 text — never a pre-validated graph claim. */
        definitionText: Type.String({ minLength: 1, maxLength: 1_048_576 }),
        format: Type.Union([Type.Literal("yaml"), Type.Literal("json")]),
      },
      { additionalProperties: false },
    ),
  ]),
  overrides: Type.Optional(Type.Array(Type.Ref(PipelineInvocationOverrideRequestV1))),
  knownProfileIds: Type.Optional(Type.Array(NonEmpty, { uniqueItems: true })),
});
export type PipelineValidateRequestV1 = Static<typeof PipelineValidateRequestV1>;

const AdmissionDiagnostic = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    severity: Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info")]),
    message: Type.String(),
    pointer: Type.Optional(Type.String()),
    suggestion: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const PipelineValidateResultV1 = versioned("PipelineValidateResult", 1, {
  accepted: Type.Boolean(),
  pipelineId: Type.Optional(PipelineId),
  source: Type.Optional(Type.Ref(PipelineDefinitionSourceV1)),
  baseGraph: Type.Optional(Type.Ref(PipelineGraphV1)),
  effectiveGraph: Type.Optional(Type.Ref(PipelineGraphV1)),
  baseGraphDigest: Type.Optional(Digest),
  effectiveGraphDigest: Type.Optional(Digest),
  appliedOverrides: Type.Array(Type.Ref(PipelineAppliedOverrideV1)),
  diagnostics: Type.Array(AdmissionDiagnostic),
});
export type PipelineValidateResultV1 = Static<typeof PipelineValidateResultV1>;

export const PipelineRunRequestV1 = versioned("PipelineRunRequest", 1, {
  runId: RunId,
  codebaseId: CodebaseId,
  source: Type.Union([
    Type.Object(
      {
        kind: Type.Literal("named"),
        pipelineId: PipelineId,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal("one-off"),
        definitionText: Type.String({ minLength: 1, maxLength: 1_048_576 }),
        format: Type.Union([Type.Literal("yaml"), Type.Literal("json")]),
      },
      { additionalProperties: false },
    ),
  ]),
  overrides: Type.Optional(Type.Array(Type.Ref(PipelineInvocationOverrideRequestV1))),
  knownProfileIds: Type.Optional(Type.Array(NonEmpty, { uniqueItems: true })),
  deadlineAt: Type.Optional(IsoDateTime),
});
export type PipelineRunRequestV1 = Static<typeof PipelineRunRequestV1>;

/** Immutable per-run admission record (§8.2 freeze + §16.1). */
export const PipelineRunSnapshotV1 = versioned("PipelineRunSnapshot", 1, {
  runId: RunId,
  pipelineId: PipelineId,
  source: Type.Ref(PipelineDefinitionSourceV1),
  baseGraph: Type.Ref(PipelineGraphV1),
  effectiveGraph: Type.Ref(PipelineGraphV1),
  baseGraphDigest: Digest,
  effectiveGraphDigest: Digest,
  resolvedProfiles: Type.Array(
    Type.Object(
      {
        stageId: PipelineStageId,
        profileId: NonEmpty,
        digest: Digest,
      },
      { additionalProperties: false },
    ),
  ),
  requestedOverrides: Type.Array(Type.Ref(PipelineInvocationOverrideRequestV1)),
  appliedOverrides: Type.Array(Type.Ref(PipelineAppliedOverrideV1)),
  effectiveLimits: Type.Record(Type.String(), Type.Unknown()),
  recordedAt: IsoDateTime,
});
export type PipelineRunSnapshotV1 = Static<typeof PipelineRunSnapshotV1>;

export const PipelineRunResultV1 = versioned("PipelineRunResult", 1, {
  accepted: Type.Boolean(),
  runId: Type.Optional(RunId),
  pipelineId: Type.Optional(PipelineId),
  graphRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  scheduleRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  snapshot: Type.Optional(Type.Ref(PipelineRunSnapshotV1)),
  diagnostics: Type.Array(AdmissionDiagnostic),
});
export type PipelineRunResultV1 = Static<typeof PipelineRunResultV1>;

/**
 * New stage definition imported into the target graph. Authored as a stage
 * document fragment; admission re-validates the augmented graph.
 */
export const PipelineAttachedStageDefinitionV1 = versioned("PipelineAttachedStageDefinition", 1, {
  id: PipelineStageId,
  type: Type.Union([
    Type.Literal("agent"),
    Type.Literal("command"),
    Type.Literal("approval"),
    Type.Literal("integration"),
    Type.Literal("verify"),
    Type.Literal("publish"),
  ]),
  profile: Type.Optional(NonEmpty),
  mode: Type.Optional(PipelineExecutionMode),
  optional: Type.Optional(Type.Boolean()),
  reads: Type.Optional(Type.Array(NonEmpty)),
  writes: Type.Optional(Type.Array(NonEmpty)),
  overridable: Type.Optional(Type.Array(FieldName)),
  completion: Type.Optional(
    Type.Object(
      {
        require: Type.Array(Type.Unknown(), { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
  ),
});
export type PipelineAttachedStageDefinitionV1 = Static<typeof PipelineAttachedStageDefinitionV1>;

export const PipelineAttachRequestV1 = versioned("PipelineAttachRequest", 1, {
  attachmentId: NonEmpty,
  sourceRunId: RunId,
  sourceStageId: PipelineStageId,
  targetRunId: RunId,
  stage: Type.Ref(PipelineAttachedStageDefinitionV1),
  dependantStageIds: Type.Array(PipelineStageId, { uniqueItems: true }),
  expectedRunRevision: Type.Integer({ minimum: 1 }),
  expectedGraphRevision: Type.Integer({ minimum: 1 }),
  expectedScheduleRevision: Type.Integer({ minimum: 1 }),
});
export type PipelineAttachRequestV1 = Static<typeof PipelineAttachRequestV1>;

export const PipelineAttachmentLifecyclePhase = Type.Union([
  Type.Literal("validated"),
  Type.Literal("committed"),
  Type.Literal("rejected"),
  Type.Literal("idempotent-replay"),
]);
export type PipelineAttachmentLifecyclePhase = Static<typeof PipelineAttachmentLifecyclePhase>;

export const PipelineAttachmentLifecycleV1 = versioned("PipelineAttachmentLifecycle", 1, {
  attachmentId: NonEmpty,
  phase: PipelineAttachmentLifecyclePhase,
  sourceRunId: RunId,
  sourceStageId: PipelineStageId,
  targetRunId: RunId,
  targetStageId: PipelineStageId,
  requestDigest: Digest,
  graphRevisionBefore: Type.Optional(Type.Integer({ minimum: 1 })),
  graphRevisionAfter: Type.Optional(Type.Integer({ minimum: 1 })),
  scheduleRevisionAfter: Type.Optional(Type.Integer({ minimum: 1 })),
  runRevisionAfter: Type.Optional(Type.Integer({ minimum: 1 })),
  artifactIds: Type.Array(ArtifactId),
  recordedAt: IsoDateTime,
  detail: Type.Optional(NonEmpty),
});
export type PipelineAttachmentLifecycleV1 = Static<typeof PipelineAttachmentLifecycleV1>;

export const PipelineAttachResultV1 = versioned("PipelineAttachResult", 1, {
  accepted: Type.Boolean(),
  idempotentReplay: Type.Boolean(),
  lifecycle: Type.Optional(Type.Ref(PipelineAttachmentLifecycleV1)),
  rejectionCode: Type.Optional(NonEmpty),
  diagnostics: Type.Array(AdmissionDiagnostic),
});
export type PipelineAttachResultV1 = Static<typeof PipelineAttachResultV1>;
