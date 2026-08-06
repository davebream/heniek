import type { Static } from "@sinclair/typebox";
import { defineIdNamespace } from "../kernel/index.js";

export const InteractionId = defineIdNamespace("InteractionId");
export type InteractionId = Static<typeof InteractionId>;

export const InteractionQuestionId = defineIdNamespace("InteractionQuestionId");
export type InteractionQuestionId = Static<typeof InteractionQuestionId>;
