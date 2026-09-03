import type { Static } from "@sinclair/typebox";
import { defineIdNamespace } from "../kernel/index.js";

export const PullRequestId = defineIdNamespace("PullRequestId");
export type PullRequestId = Static<typeof PullRequestId>;

export const ForgeIssueId = defineIdNamespace("ForgeIssueId");
export type ForgeIssueId = Static<typeof ForgeIssueId>;

export const ForgeRefId = defineIdNamespace("ForgeRefId");
export type ForgeRefId = Static<typeof ForgeRefId>;

export const ForgeObservedVersion = defineIdNamespace("ForgeObservedVersion");
export type ForgeObservedVersion = Static<typeof ForgeObservedVersion>;
