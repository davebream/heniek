import type { Static } from "@sinclair/typebox";
import { defineIdNamespace } from "../kernel/index.js";

export const SourceWorkItemId = defineIdNamespace("SourceWorkItemId");
export type SourceWorkItemId = Static<typeof SourceWorkItemId>;
