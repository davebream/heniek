import { Type } from "@sinclair/typebox";
import { ArtifactId } from "../artifact/index.js";
import { ResolvedProfileSchema, ResolvedProfileSchemaV2 } from "../configuration/index.js";
import { InteractionId, InteractionQuestionId } from "../interaction/index.js";
import { SCHEMA_REGISTRY, versioned } from "../kernel/index.js";
import { RepositoryId, RunId, WorkspaceId } from "../run/index.js";
import { BackendArtifactId, BackendExecutionId, ProfileId, StageId } from "./ids.js";
import { ExecutionStatus } from "./state.js";

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

/** Q014's additive request contract: V2's provider-neutral inputs plus a fully sourced profile. */
export const ExecutionRequestV3 = versioned("ExecutionRequest", 3, {
  runId: Type.String({ minLength: 1 }),
  stageId: StageId,
  workspaceId: WorkspaceId,
  workingDirectory: Type.String({ minLength: 1 }),
  prompt: Type.String({ minLength: 1 }),
  artifactPath: Type.String({ minLength: 1 }),
  inputArtifactRefs: Type.Array(ArtifactId),
  limits: ExecutionLimits,
  profile: ResolvedProfileSchema,
});

const ExecutionPermissionFields = {
  workspace: Type.Union([Type.Literal("read-only"), Type.Literal("read-write")]),
  identifiers: Type.Array(
    Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
    }),
    { uniqueItems: true },
  ),
} as const;

/** Names-only permission envelope. Secret values never cross this contract. */
export const ExecutionPermissionEnvelopeV1 = versioned(
  "ExecutionPermissionEnvelope",
  1,
  ExecutionPermissionFields,
);

export const ExecutionFailureClass = Type.Union([
  Type.Literal("account_unavailable"),
  Type.Literal("profile_unavailable"),
  Type.Literal("model_unavailable"),
  Type.Literal("engine_unavailable"),
  Type.Literal("provider_throttled"),
  Type.Literal("context_capacity_exhausted"),
  Type.Literal("authentication_failed"),
  Type.Literal("permission_denied"),
  Type.Literal("invalid_request"),
  Type.Literal("workspace_failed"),
  Type.Literal("artifact_failed"),
  Type.Literal("hard_limit_exceeded"),
  Type.Literal("cancelled"),
  Type.Literal("ambiguous"),
  Type.Literal("unknown"),
]);

const ExecutionFailureFields = {
  classification: ExecutionFailureClass,
  phase: Type.Union([
    Type.Literal("admission"),
    Type.Literal("start"),
    Type.Literal("running"),
    Type.Literal("completion"),
  ]),
  code: Type.String({ minLength: 1, maxLength: 128 }),
  message: Type.String({ minLength: 1, maxLength: 512 }),
  fallbackEligible: Type.Boolean(),
} as const;

export const ExecutionFailureV1 = versioned("ExecutionFailure", 1, ExecutionFailureFields);

/** Q021 adds resolved permissions without changing V1-V3 request bytes. */
export const ExecutionRequestV4 = versioned("ExecutionRequest", 4, {
  runId: Type.String({ minLength: 1 }),
  stageId: StageId,
  workspaceId: WorkspaceId,
  workingDirectory: Type.String({ minLength: 1 }),
  prompt: Type.String({ minLength: 1 }),
  artifactPath: Type.String({ minLength: 1 }),
  inputArtifactRefs: Type.Array(ArtifactId),
  limits: ExecutionLimits,
  profile: ResolvedProfileSchemaV2,
  permissions: Type.Ref(ExecutionPermissionEnvelopeV1),
});

export const BackendExecutionHandleV1 = versioned("BackendExecutionHandle", 1, {
  executionId: BackendExecutionId,
});

/**
 * A deliberately small, replayable lifecycle feed for profile-aware
 * execution. It reports only facts which can be translated without exposing
 * a harness event or transcript payload. Broader usage/context telemetry is
 * intentionally deferred to Q019.
 */
const EXECUTION_EVENT_SCHEMA_ID = "heniek://contract/ExecutionEvent/v1";
const EXECUTION_EVENT_V2_SCHEMA_ID = "heniek://contract/ExecutionEvent/v2";
const EXECUTION_EVENT_V3_SCHEMA_ID = "heniek://contract/ExecutionEvent/v3";

export const ExecutionEventV1 = Type.Union(
  [
    Type.Object(
      {
        schemaVersion: Type.Literal(1),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("status"),
        status: ExecutionStatus.schema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(1),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("rate_limited"),
        retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(1),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("context_pressure"),
        pressure: Type.Literal("capacity_exhausted"),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: EXECUTION_EVENT_SCHEMA_ID },
);

if (SCHEMA_REGISTRY.has(EXECUTION_EVENT_SCHEMA_ID)) {
  throw new Error(`Duplicate contract schema id: ${EXECUTION_EVENT_SCHEMA_ID}`);
}
SCHEMA_REGISTRY.set(EXECUTION_EVENT_SCHEMA_ID, ExecutionEventV1);

/**
 * Q017's structured execution feed. V1 remains available unchanged for
 * existing profile consumers; V2 adds only provider-neutral facts carried by
 * Claudexor's typed harness events. It intentionally does not expose tool
 * arguments, tool output, prompt text, or provider event payloads.
 */
const ExecutionToolKindV1 = Type.Union([
  Type.Literal("web"),
  Type.Literal("file"),
  Type.Literal("command"),
  Type.Literal("mcp"),
  Type.Literal("search"),
  Type.Literal("other"),
]);

const ExecutionToolEventV1 = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    kind: ExecutionToolKindV1,
    useId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const ExecutionEventV2 = Type.Union(
  [
    Type.Object(
      {
        schemaVersion: Type.Literal(2),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("status"),
        status: ExecutionStatus.schema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(2),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("rate_limited"),
        retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(2),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("context_pressure"),
        pressure: Type.Literal("capacity_exhausted"),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(2),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("tool_call"),
        tool: ExecutionToolEventV1,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(2),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("tool_result"),
        tool: Type.Object(
          {
            name: Type.String({ minLength: 1 }),
            kind: ExecutionToolKindV1,
            useId: Type.Optional(Type.String({ minLength: 1 })),
            outcome: Type.Union([
              Type.Literal("succeeded"),
              Type.Literal("failed"),
              Type.Literal("cancelled"),
              Type.Literal("denied"),
            ]),
            exitCode: Type.Optional(Type.Integer()),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(2),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("file_change"),
        path: Type.String({
          minLength: 1,
          pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\u0000).+$",
        }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(2),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("usage"),
        usage: Type.Object(
          {
            inputUnits: Type.Optional(Type.Integer({ minimum: 0 })),
            outputUnits: Type.Optional(Type.Integer({ minimum: 0 })),
            cachedInputUnits: Type.Optional(Type.Integer({ minimum: 0 })),
            costUsd: Type.Optional(Type.Number({ minimum: 0 })),
            estimated: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(2),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("error"),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: EXECUTION_EVENT_V2_SCHEMA_ID },
);

if (SCHEMA_REGISTRY.has(EXECUTION_EVENT_V2_SCHEMA_ID)) {
  throw new Error(`Duplicate contract schema id: ${EXECUTION_EVENT_V2_SCHEMA_ID}`);
}
SCHEMA_REGISTRY.set(EXECUTION_EVENT_V2_SCHEMA_ID, ExecutionEventV2);

const TelemetryUnavailableReasonV1 = Type.Union([
  Type.Literal("not_reported"),
  Type.Literal("unsupported"),
  Type.Literal("invalid"),
  Type.Literal("contradictory"),
  Type.Literal("overflow"),
  Type.Literal("counter_reset"),
]);

const TelemetryConfidenceV1 = Type.Union([Type.Literal("exact"), Type.Literal("estimated")]);

function telemetryNumber(options: { readonly integer?: boolean; readonly maximum?: number } = {}) {
  const value = options.integer
    ? Type.Integer({ minimum: 0, maximum: options.maximum ?? Number.MAX_SAFE_INTEGER })
    : Type.Number({
        minimum: 0,
        ...(options.maximum === undefined ? {} : { maximum: options.maximum }),
      });
  return Type.Union([
    Type.Object(
      {
        availability: Type.Literal("available"),
        value,
        confidence: TelemetryConfidenceV1,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        availability: Type.Literal("unavailable"),
        reason: TelemetryUnavailableReasonV1,
      },
      { additionalProperties: false },
    ),
  ]);
}

const TelemetryIdentifierV1 = Type.Union([
  Type.Object(
    {
      availability: Type.Literal("available"),
      value: Type.String({ minLength: 1, maxLength: 512 }),
      confidence: TelemetryConfidenceV1,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      availability: Type.Literal("unavailable"),
      reason: TelemetryUnavailableReasonV1,
    },
    { additionalProperties: false },
  ),
]);

const TelemetryPressureV1 = Type.Union([
  Type.Object(
    {
      state: Type.Literal("measured"),
      utilization: Type.Object(
        {
          availability: Type.Literal("available"),
          value: Type.Number({ minimum: 0, maximum: 1 }),
          confidence: TelemetryConfidenceV1,
        },
        { additionalProperties: false },
      ),
      basis: Type.Union([Type.Literal("reported_ratio"), Type.Literal("usage_ratio")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal("exhausted"),
      confidence: Type.Literal("exact"),
      basis: Type.Literal("capacity_signal"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      state: Type.Literal("unavailable"),
      reason: TelemetryUnavailableReasonV1,
    },
    { additionalProperties: false },
  ),
]);

const executionTelemetryProperties = {
  engine: Type.Union([Type.Literal("claude"), Type.Literal("codex"), Type.Literal("cursor")]),
  executionMode: Type.Union([Type.Literal("external"), Type.Literal("native")]),
  evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
    minItems: 1,
    maxItems: 32,
    uniqueItems: true,
  }),
  session: Type.Object(
    { providerSessionId: TelemetryIdentifierV1 },
    { additionalProperties: false },
  ),
  usage: Type.Object(
    {
      inputUnits: telemetryNumber({ integer: true }),
      outputUnits: telemetryNumber({ integer: true }),
      cachedInputUnits: telemetryNumber({ integer: true }),
      cacheReadUnits: telemetryNumber({ integer: true }),
      cacheWriteUnits: telemetryNumber({ integer: true }),
      totalUnits: telemetryNumber({ integer: true }),
      costUsd: telemetryNumber(),
    },
    { additionalProperties: false },
  ),
  timing: Type.Object(
    {
      wallDurationMs: telemetryNumber({ integer: true }),
      apiDurationMs: telemetryNumber({ integer: true }),
    },
    { additionalProperties: false },
  ),
  context: Type.Object(
    {
      usedUnits: telemetryNumber({ integer: true }),
      windowUnits: telemetryNumber({ integer: true }),
      utilization: telemetryNumber({ maximum: 1 }),
      pressure: TelemetryPressureV1,
    },
    { additionalProperties: false },
  ),
};

/** Q019's provider-neutral, evidence-linked telemetry snapshot. */
export const ExecutionTelemetryV1 = versioned(
  "ExecutionTelemetry",
  1,
  executionTelemetryProperties,
);

/** Q019 carries live telemetry without changing the replayable V2 event contract. */
export const ExecutionEventV3 = Type.Union(
  [
    Type.Object(
      {
        schemaVersion: Type.Literal(3),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("status"),
        status: ExecutionStatus.schema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(3),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("rate_limited"),
        retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(3),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("telemetry"),
        telemetry: Type.Ref(ExecutionTelemetryV1),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(3),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("tool_call"),
        tool: ExecutionToolEventV1,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(3),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("tool_result"),
        tool: Type.Object(
          {
            name: Type.String({ minLength: 1 }),
            kind: ExecutionToolKindV1,
            useId: Type.Optional(Type.String({ minLength: 1 })),
            outcome: Type.Union([
              Type.Literal("succeeded"),
              Type.Literal("failed"),
              Type.Literal("cancelled"),
              Type.Literal("denied"),
            ]),
            exitCode: Type.Optional(Type.Integer()),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(3),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("file_change"),
        path: Type.String({
          minLength: 1,
          pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\u0000).+$",
        }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        schemaVersion: Type.Literal(3),
        cursor: Type.String({ minLength: 1 }),
        kind: Type.Literal("error"),
      },
      { additionalProperties: false },
    ),
  ],
  { $id: EXECUTION_EVENT_V3_SCHEMA_ID },
);

if (SCHEMA_REGISTRY.has(EXECUTION_EVENT_V3_SCHEMA_ID)) {
  throw new Error(`Duplicate contract schema id: ${EXECUTION_EVENT_V3_SCHEMA_ID}`);
}
SCHEMA_REGISTRY.set(EXECUTION_EVENT_V3_SCHEMA_ID, ExecutionEventV3);

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

/** Durable recovery operation delivered to a backend exactly once logically. */
export const ExecutionResumeRequestV1 = versioned("ExecutionResumeRequest", 1, {
  executionId: BackendExecutionId,
  operationId: Type.String({ minLength: 1 }),
  inputArtifactRefs: Type.Array(ArtifactId),
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

/** Q017's result contract adds normalized usage and a diff summary without provider DTOs. */
export const ExecutionResultV3 = versioned("ExecutionResult", 3, {
  status: Type.Union([
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  summary: Type.String({ minLength: 1 }),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
  artifacts: Type.Array(BackendArtifactV1),
  usage: Type.Optional(
    Type.Object(
      {
        inputUnits: Type.Optional(Type.Integer({ minimum: 0 })),
        outputUnits: Type.Optional(Type.Integer({ minimum: 0 })),
        cachedInputUnits: Type.Optional(Type.Integer({ minimum: 0 })),
        costUsd: Type.Optional(Type.Number({ minimum: 0 })),
        estimated: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
  ),
  diff: Type.Optional(
    Type.Object(
      {
        files: Type.Integer({ minimum: 0 }),
        additions: Type.Integer({ minimum: 0 }),
        deletions: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  ),
});

/** Q019's additive result contract replaces ambiguous usage with explicit telemetry. */
export const ExecutionResultV4 = versioned("ExecutionResult", 4, {
  status: Type.Union([
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  summary: Type.String({ minLength: 1 }),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
  artifacts: Type.Array(BackendArtifactV1),
  telemetry: Type.Ref(ExecutionTelemetryV1),
  diff: Type.Optional(
    Type.Object(
      {
        files: Type.Integer({ minimum: 0 }),
        additions: Type.Integer({ minimum: 0 }),
        deletions: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  ),
});

/** Q021's failure-classified terminal result. */
export const ExecutionResultV5 = versioned("ExecutionResult", 5, {
  status: Type.Union([
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  summary: Type.String({ minLength: 1 }),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
  artifacts: Type.Array(BackendArtifactV1),
  telemetry: Type.Ref(ExecutionTelemetryV1),
  diff: Type.Optional(
    Type.Object(
      {
        files: Type.Integer({ minimum: 0 }),
        additions: Type.Integer({ minimum: 0 }),
        deletions: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  ),
  failure: Type.Optional(Type.Ref(ExecutionFailureV1)),
});

export const ExecutionAttemptV1 = versioned("ExecutionAttempt", 1, {
  attemptId: Type.String({ minLength: 1 }),
  runId: RunId,
  stageId: StageId,
  candidateIndex: Type.Integer({ minimum: 0 }),
  profileId: ProfileId,
  accountId: Type.Optional(Type.String({ minLength: 1 })),
  workspaceId: Type.Optional(WorkspaceId),
  status: ExecutionStatus.schema,
  backendExecutionId: Type.Optional(BackendExecutionId),
  limits: ExecutionLimits,
  permissions: Type.Ref(ExecutionPermissionEnvelopeV1),
  failure: Type.Optional(Type.Ref(ExecutionFailureV1)),
  startedAt: Type.Optional(Type.String({ format: "date-time" })),
  finishedAt: Type.Optional(Type.String({ format: "date-time" })),
});

export const SchedulingDecisionV1 = versioned("SchedulingDecision", 1, {
  decisionId: Type.String({ minLength: 1 }),
  runId: RunId,
  stageId: StageId,
  candidateIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  profileId: Type.Optional(ProfileId),
  accountId: Type.Optional(Type.String({ minLength: 1 })),
  kind: Type.Union([
    Type.Literal("enqueued"),
    Type.Literal("capacity_rejected"),
    Type.Literal("compatibility_rejected"),
    Type.Literal("candidate_selected"),
    Type.Literal("lease_acquired"),
    Type.Literal("lease_renewed"),
    Type.Literal("lease_released"),
    Type.Literal("lease_expired"),
    Type.Literal("capacity_question_created"),
    Type.Literal("capacity_answered"),
    Type.Literal("attempt_started"),
    Type.Literal("attempt_failed"),
    Type.Literal("fallback_selected"),
    Type.Literal("fallback_exhausted"),
  ]),
  reasonCode: Type.String({ minLength: 1, maxLength: 128 }),
  recordedAt: Type.String({ format: "date-time" }),
});

/** The one-stage structured result Heniek validates before completion. */
export const ExternalStageResultV1 = versioned("ExternalStageResult", 1, {
  summary: Type.String({ minLength: 1 }),
  artifactPath: Type.String({
    minLength: 1,
    pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\u0000).+$",
  }),
});
