import { Type } from "@sinclair/typebox";
import { versioned } from "../kernel/index.js";
import { InteractionId } from "./ids.js";
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
