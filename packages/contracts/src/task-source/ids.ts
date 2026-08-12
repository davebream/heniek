import type { Static } from "@sinclair/typebox";
import { defineIdNamespace } from "../kernel/index.js";

export const SourceWorkItemId = defineIdNamespace("SourceWorkItemId");
export type SourceWorkItemId = Static<typeof SourceWorkItemId>;

export const TaskSourceSnapshotId = defineIdNamespace("TaskSourceSnapshotId");
export type TaskSourceSnapshotId = Static<typeof TaskSourceSnapshotId>;

export const TaskRevisionId = defineIdNamespace("TaskRevisionId");
export type TaskRevisionId = Static<typeof TaskRevisionId>;

export const TaskSourceUpdateProposalId = defineIdNamespace("TaskSourceUpdateProposalId");
export type TaskSourceUpdateProposalId = Static<typeof TaskSourceUpdateProposalId>;

export const TaskSourceSynchronizationId = defineIdNamespace("TaskSourceSynchronizationId");
export type TaskSourceSynchronizationId = Static<typeof TaskSourceSynchronizationId>;
