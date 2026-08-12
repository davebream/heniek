import type { Static } from "@sinclair/typebox";
import { defineIdNamespace } from "../kernel/index.js";

export const TaskGraphId = defineIdNamespace("TaskGraphId");
export type TaskGraphId = Static<typeof TaskGraphId>;
