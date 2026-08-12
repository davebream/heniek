import type { Static } from "@sinclair/typebox";
import { defineIdNamespace } from "../kernel/index.js";

export const TaskGraphId = defineIdNamespace("TaskGraphId");
export type TaskGraphId = Static<typeof TaskGraphId>;

export const TaskGraphRevisionDecisionId = defineIdNamespace("TaskGraphRevisionDecisionId");
export type TaskGraphRevisionDecisionId = Static<typeof TaskGraphRevisionDecisionId>;
