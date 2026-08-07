import { Type } from "@sinclair/typebox";
import { ArtifactId } from "../artifact/index.js";
import { InteractionId, InteractionQuestionId } from "../interaction/index.js";
import { versioned } from "../kernel/index.js";
import { RepositoryId, WorkspaceId } from "../run/index.js";
import { BackendArtifactId, BackendExecutionId, ProfileId, StageId } from "./ids.js";

/**
 * §22, verbatim shape with IDs branded. `profile: ResolvedProfile` becomes
 * `profileId: ProfileId` — see the note on `ProfileId` in `./ids.ts`.
 * `inputArtifactRefs: string[]` becomes `ArtifactId[]`, since every
 * artifact reference in this package is an opaque `ArtifactId`.
 */
export const ExecutionRequestV1 = versioned("ExecutionRequest", 1, {
  stageId: StageId,
  profileId: ProfileId,
  workspaceId: WorkspaceId,
  workingDirectory: Type.String({ minLength: 1 }),
  inputArtifactRefs: Type.Array(ArtifactId),
  outputContract: Type.String({ minLength: 1 }),
  limits: Type.Object(
    {
      maxDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
      maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
});

/** §22, verbatim shape with IDs branded. */
export const PendingInteractionV1 = versioned("PendingInteraction", 1, {
  id: InteractionId,
  kind: Type.Union([
    Type.Literal("free_text"),
    Type.Literal("single_choice"),
    Type.Literal("multiple_choice"),
  ]),
  prompt: Type.String({ minLength: 1 }),
  options: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

/**
 * §22, verbatim shape with IDs branded. `status` is intentionally its own
 * three-literal union, not `ExecutionStatus.schema` — a *result* can only
 * ever land on one of `ExecutionStatus`'s three terminal values, and spec
 * text repeats exactly those three literals rather than reusing the
 * broader union.
 */
/**
 * Key pattern shared by every open map on this contract. `artifacts`/`usage`
 * are open by necessity (arbitrary stage-defined keys), which would
 * otherwise be the one place a provider-shaped key (`claudeSessionId`,
 * `codexRunId`, ...) could smuggle provider detail through a public
 * contract despite `additionalProperties: false` on the fixed-shape fields.
 * Closing the key namespace, not just the fixed properties, is what makes
 * OR-8 actually hold for these two fields.
 */
const OPEN_MAP_KEY = Type.String({
  pattern: "^(?!(claude|codex|cursor|github|anthropic|openai))[a-zA-Z0-9_.-]+$",
  minLength: 1,
});

export const ExecutionResultV1 = versioned("ExecutionResult", 1, {
  status: Type.Union([
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  summary: Type.String({ minLength: 1 }),
  providerSessionId: Type.Optional(Type.String({ minLength: 1 })),
  changedRepositories: Type.Array(RepositoryId),
  // `additionalProperties: false` is required, not decorative: TypeBox's
  // `Record` emits only `patternProperties` by default, and JSON Schema
  // treats `additionalProperties` as `true` when absent — so a key that
  // does *not* match `OPEN_MAP_KEY` (e.g. a provider-shaped key) would be
  // silently accepted with no value constraint at all without this.
  artifacts: Type.Record(OPEN_MAP_KEY, ArtifactId, { additionalProperties: false }),
  usage: Type.Optional(Type.Record(OPEN_MAP_KEY, Type.Number(), { additionalProperties: false })),
});

const ExecutionLimits = Type.Object(
  {
    maxDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
    maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

/**
 * Q012's provider-neutral start contract. The prompt and declared artifact
 * path are stage inputs; no provider routing DTO crosses this boundary.
 */
export const ExecutionRequestV2 = versioned("ExecutionRequest", 2, {
  runId: Type.String({ minLength: 1 }),
  stageId: StageId,
  workspaceId: WorkspaceId,
  workingDirectory: Type.String({ minLength: 1 }),
  prompt: Type.String({ minLength: 1 }),
  artifactPath: Type.String({ minLength: 1 }),
  inputArtifactRefs: Type.Array(ArtifactId),
  limits: ExecutionLimits,
});

export const BackendExecutionHandleV1 = versioned("BackendExecutionHandle", 1, {
  executionId: BackendExecutionId,
});

const InteractionOptionV1 = Type.Object(
  {
    label: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const PendingInteractionV2 = versioned("PendingInteraction", 2, {
  id: InteractionId,
  questions: Type.Array(
    Type.Object(
      {
        id: InteractionQuestionId,
        prompt: Type.String({ minLength: 1 }),
        header: Type.Optional(Type.String({ minLength: 1 })),
        options: Type.Array(InteractionOptionV1),
        multiSelect: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    { minItems: 1 },
  ),
  requestedAt: Type.String({ format: "date-time" }),
  timeoutAt: Type.Optional(Type.String({ format: "date-time" })),
});

export const InteractionAnswerSetV1 = versioned("InteractionAnswerSet", 1, {
  interactionId: InteractionId,
  answers: Type.Array(
    Type.Object(
      {
        questionId: InteractionQuestionId,
        selectedLabels: Type.Array(Type.String({ minLength: 1 })),
        freeText: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    { minItems: 1 },
  ),
});

export const BackendArtifactV1 = versioned("BackendArtifact", 1, {
  id: BackendArtifactId,
  path: Type.String({ minLength: 1 }),
  byteLength: Type.Integer({ minimum: 0 }),
  mediaType: Type.String({ minLength: 1 }),
  sha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
});

export const ExecutionResultV2 = versioned("ExecutionResult", 2, {
  status: Type.Union([
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  summary: Type.String({ minLength: 1 }),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
  artifacts: Type.Array(BackendArtifactV1),
  usage: Type.Optional(Type.Record(OPEN_MAP_KEY, Type.Number(), { additionalProperties: false })),
});

/** The one-stage structured result Heniek validates before completion. */
export const ExternalStageResultV1 = versioned("ExternalStageResult", 1, {
  summary: Type.String({ minLength: 1 }),
  artifactPath: Type.String({
    minLength: 1,
    pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\u0000).+$",
  }),
});
