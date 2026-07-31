import type { Static } from "@sinclair/typebox";
import { defineIdNamespace } from "../kernel/index.js";

export const PullRequestId = defineIdNamespace("PullRequestId");
export type PullRequestId = Static<typeof PullRequestId>;
