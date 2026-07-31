import { Type } from "@sinclair/typebox";
import { ArtifactId } from "../artifact/index.js";
import { InteractionId } from "../interaction/index.js";
import { versioned } from "../kernel/index.js";
import { RepositoryId, WorkspaceId } from "../run/index.js";
import { ProfileId, StageId } from "./ids.js";

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
