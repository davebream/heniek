import { Type } from "@sinclair/typebox";
import { versioned } from "../kernel/index.js";
import { InteractionId, InteractionQuestionId } from "./ids.js";
import { InteractionStatus } from "./state.js";

/**
 * Duplicated locally rather than imported from `execution-backend` (whose
 * `PendingInteractionV1` uses the same three kinds): `execution-backend`
 * already depends on this family for `InteractionId`, so importing back
 * would create a cycle. Three literals is cheap enough to keep in sync by
 * hand rather than introducing a shared-but-ownerless location for it.
 */
const InteractionKind = Type.Union([
  Type.Literal("free_text"),
  Type.Literal("single_choice"),
  Type.Literal("multiple_choice"),
]);

export const InteractionV1 = versioned("Interaction", 1, {
  interactionId: InteractionId,
  status: InteractionStatus.schema,
  kind: InteractionKind,
  prompt: Type.String({ minLength: 1 }),
  options: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  createdAt: Type.String({ format: "date-time" }),
  resolvedAt: Type.Optional(Type.String({ format: "date-time" })),
});

export const InteractionAnswerV1 = versioned("InteractionAnswer", 1, {
  interactionId: InteractionId,
  answer: Type.Unknown(),
  answeredAt: Type.String({ format: "date-time" }),
});

const InteractionOptionV2 = Type.Object(
  {
    label: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const InteractionQuestionV2 = Type.Union([
  Type.Object(
    {
      questionId: InteractionQuestionId,
      kind: Type.Literal("free_text"),
      prompt: Type.String({ minLength: 1 }),
      header: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      questionId: InteractionQuestionId,
      kind: Type.Literal("single_choice"),
      prompt: Type.String({ minLength: 1 }),
      header: Type.Optional(Type.String({ minLength: 1 })),
      options: Type.Array(InteractionOptionV2, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      questionId: InteractionQuestionId,
      kind: Type.Literal("multiple_choice"),
      prompt: Type.String({ minLength: 1 }),
      header: Type.Optional(Type.String({ minLength: 1 })),
      options: Type.Array(InteractionOptionV2, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
]);

const InteractionAnswerValueV2 = Type.Union([
  Type.Object(
    {
      questionId: InteractionQuestionId,
      kind: Type.Literal("free_text"),
      freeText: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      questionId: InteractionQuestionId,
      kind: Type.Literal("single_choice"),
      selectedLabels: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 1,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      questionId: InteractionQuestionId,
      kind: Type.Literal("multiple_choice"),
      selectedLabels: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        uniqueItems: true,
      }),
    },
    { additionalProperties: false },
  ),
]);

/** Q020's canonical, revision-safe interaction snapshot. */
export const InteractionV2 = versioned("Interaction", 2, {
  interactionId: InteractionId,
  purpose: Type.Union([Type.Literal("question"), Type.Literal("approval")]),
  status: InteractionStatus.schema,
  revision: Type.Integer({ minimum: 1 }),
  questions: Type.Array(InteractionQuestionV2, { minItems: 1 }),
  requestedAt: Type.String({ format: "date-time" }),
  timeoutAt: Type.Optional(Type.String({ format: "date-time" })),
  resolvedAt: Type.Optional(Type.String({ format: "date-time" })),
  cancellationReason: Type.Optional(
    Type.Union([
      Type.Literal("withdrawn"),
      Type.Literal("timed_out"),
      Type.Literal("run_terminal"),
      Type.Literal("migration_unresolved"),
    ]),
  ),
  deliveryState: Type.Union([
    Type.Literal("not_applicable"),
    Type.Literal("pending"),
    Type.Literal("delivered"),
  ]),
});

/** Authenticated caller input; provenance is added by the daemon. */
export const InteractionAnswerSubmissionV2 = versioned("InteractionAnswerSubmission", 2, {
  interactionId: InteractionId,
  expectedInteractionRevision: Type.Integer({ minimum: 1 }),
  answers: Type.Array(InteractionAnswerValueV2, { minItems: 1 }),
});

/** Immutable accepted answer, including local credential provenance. */
export const InteractionAnswerV2 = versioned("InteractionAnswer", 2, {
  answerId: Type.String({ minLength: 1 }),
  operationId: Type.String({ minLength: 1 }),
  interactionId: InteractionId,
  interactionRevision: Type.Integer({ minimum: 1 }),
  answers: Type.Array(InteractionAnswerValueV2, { minItems: 1 }),
  answeredAt: Type.String({ format: "date-time" }),
  answeredByKeyId: Type.String({ minLength: 1 }),
});
