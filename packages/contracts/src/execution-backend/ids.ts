import type { Static } from "@sinclair/typebox";
import { defineIdNamespace } from "../kernel/index.js";

export const ExecutionTaskId = defineIdNamespace("ExecutionTaskId");
export type ExecutionTaskId = Static<typeof ExecutionTaskId>;

export const StageId = defineIdNamespace("StageId");
export type StageId = Static<typeof StageId>;

export const StageAttemptId = defineIdNamespace("StageAttemptId");
export type StageAttemptId = Static<typeof StageAttemptId>;

/** Provider-neutral opaque identifiers owned by an execution-backend adapter. */
export const BackendExecutionId = defineIdNamespace("BackendExecutionId");
export type BackendExecutionId = Static<typeof BackendExecutionId>;

export const BackendArtifactId = defineIdNamespace("BackendArtifactId");
export type BackendArtifactId = Static<typeof BackendArtifactId>;

/**
 * Opaque forward reference only — §9.4's `Profile` (worker + role
 * composition) has no contract schema yet; that's a later queue issue.
 * `ExecutionRequestV1` needs *some* reference to "which profile", so it
 * carries `profileId` rather than embedding an un-sourced `ResolvedProfile`
 * shape ahead of that issue.
 */
export const ProfileId = defineIdNamespace("ProfileId");
export type ProfileId = Static<typeof ProfileId>;
