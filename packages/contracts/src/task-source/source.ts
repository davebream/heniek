import type { Static } from "@sinclair/typebox";
import type {
  ParentHandoffV1,
  TaskContextV1,
  TaskContextV2,
  TaskHierarchyV1,
  TaskRevisionDocumentV1,
  TaskRevisionV1,
  TaskSourceSnapshotV1,
  TaskSourceSnapshotV2,
  TaskSourceSynchronizationAuditV1,
  TaskSourceUpdateProposalV1,
} from "./schemas.js";

/** §13.1, verbatim. */
export interface TaskSource {
  load(input: unknown): Promise<Static<typeof TaskContextV1> | Static<typeof TaskContextV2>>;
}

export type ParentHandoff = Static<typeof ParentHandoffV1>;
export type TaskSourceSnapshot =
  | Static<typeof TaskSourceSnapshotV1>
  | Static<typeof TaskSourceSnapshotV2>;
export type TaskRevisionDocument = Static<typeof TaskRevisionDocumentV1>;
export type TaskRevision = Static<typeof TaskRevisionV1>;
export type TaskHierarchy = Static<typeof TaskHierarchyV1>;
export type TaskContext = Static<typeof TaskContextV1> | Static<typeof TaskContextV2>;
export type TaskSourceUpdateProposal = Static<typeof TaskSourceUpdateProposalV1>;
export type TaskSourceSynchronizationAudit = Static<typeof TaskSourceSynchronizationAuditV1>;
