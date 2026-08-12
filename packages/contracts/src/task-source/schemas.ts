import { Type } from "@sinclair/typebox";
import { ArtifactId } from "../artifact/index.js";
import { ExecutionTaskId } from "../execution-backend/index.js";
import { versioned } from "../kernel/index.js";
import {
  SourceWorkItemId,
  TaskRevisionId,
  TaskSourceSnapshotId,
  TaskSourceSynchronizationId,
  TaskSourceUpdateProposalId,
} from "./ids.js";

const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const IsoDateTime = Type.String({ format: "date-time" });
const NonEmpty = Type.String({ minLength: 1, maxLength: 65536 });
// JSON Patch values are structurally unconstrained JSON; the ingestion boundary
// rejects non-JSON values before persistence and the operation count is bounded.
const JsonValue = Type.Any();

export const TaskSourceKind = Type.Union([
  Type.Literal("parent_conversation"),
  Type.Literal("manual_text"),
  Type.Literal("github_issue"),
  Type.Literal("github_pull_request"),
  Type.Literal("local_file"),
  Type.Literal("existing_branch_or_pr"),
]);

export const TaskRequirement = Type.Object(
  {
    requirementId: Type.String({ minLength: 1, maxLength: 256 }),
    text: NonEmpty,
    sourcePointer: Type.String({ minLength: 1, maxLength: 4096 }),
  },
  { additionalProperties: false },
);

export const TaskDecision = Type.Object(
  {
    statement: NonEmpty,
    author: Type.String({ minLength: 1, maxLength: 1024 }),
    rationale: NonEmpty,
  },
  { additionalProperties: false },
);

export const ParentHandoffV1 = versioned("ParentHandoff", 1, {
  objective: NonEmpty,
  constraints: Type.Array(NonEmpty, { maxItems: 1024 }),
  decisions: Type.Array(TaskDecision, { maxItems: 1024 }),
  openQuestions: Type.Array(NonEmpty, { maxItems: 1024 }),
  repositoryReferences: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
    maxItems: 1024,
  }),
  requirements: Type.Array(TaskRequirement, { minItems: 1, maxItems: 4096 }),
});

export const TaskSourceAttachment = Type.Object(
  {
    uri: Type.String({ minLength: 1, maxLength: 8192 }),
    name: Type.String({ minLength: 1, maxLength: 1024 }),
    mediaType: Type.String({ minLength: 1, maxLength: 256 }),
    observedVersion: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
    contentSha256: Sha256,
    artifactId: ArtifactId,
  },
  { additionalProperties: false },
);

export const TaskSourceSnapshotV1 = versioned("TaskSourceSnapshot", 1, {
  snapshotId: TaskSourceSnapshotId,
  sourceWorkItemId: SourceWorkItemId,
  sourceKind: TaskSourceKind,
  sourceUri: Type.String({ minLength: 1, maxLength: 8192 }),
  observedVersion: Type.String({ minLength: 1, maxLength: 4096 }),
  contentSha256: Sha256,
  rawContentRef: ArtifactId,
  requirements: Type.Array(TaskRequirement, { minItems: 1, maxItems: 4096 }),
  attachments: Type.Array(TaskSourceAttachment, { maxItems: 1024 }),
  observedAt: IsoDateTime,
});

export const TaskSourceState = Type.Union([Type.Literal("open"), Type.Literal("closed")]);

export const TaskSourceComment = Type.Object(
  {
    sourceCommentId: Type.String({ minLength: 1, maxLength: 1024 }),
    uri: Type.String({ minLength: 1, maxLength: 8192 }),
    author: Type.String({ minLength: 1, maxLength: 1024 }),
    bodySha256: Sha256,
    observedVersion: Type.String({ minLength: 1, maxLength: 4096 }),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  { additionalProperties: false },
);

export const TaskSourceComponentObservation = Type.Object(
  {
    componentId: Type.String({ minLength: 1, maxLength: 1024 }),
    uri: Type.String({ minLength: 1, maxLength: 8192 }),
    observedVersion: Type.String({ minLength: 1, maxLength: 4096 }),
    contentSha256: Sha256,
  },
  { additionalProperties: false },
);

/** Q046: normalized external issue observation without provider DTO leakage. */
export const TaskSourceSnapshotV2 = versioned("TaskSourceSnapshot", 2, {
  snapshotId: TaskSourceSnapshotId,
  sourceWorkItemId: SourceWorkItemId,
  sourceKind: TaskSourceKind,
  sourceUri: Type.String({ minLength: 1, maxLength: 8192 }),
  observedVersion: Type.String({ minLength: 1, maxLength: 4096 }),
  contentSha256: Sha256,
  rawContentRef: ArtifactId,
  requirements: Type.Array(TaskRequirement, { minItems: 1, maxItems: 4096 }),
  attachments: Type.Array(TaskSourceAttachment, { maxItems: 1024 }),
  observedAt: IsoDateTime,
  title: NonEmpty,
  state: TaskSourceState,
  labels: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), {
    uniqueItems: true,
    maxItems: 1024,
  }),
  comments: Type.Array(TaskSourceComment, { maxItems: 4096 }),
  components: Type.Array(TaskSourceComponentObservation, { minItems: 1, maxItems: 8192 }),
});

export const TaskSourceChangedField = Type.Union([
  Type.Literal("title"),
  Type.Literal("body"),
  Type.Literal("state"),
  Type.Literal("labels"),
  Type.Literal("comments"),
  Type.Literal("hierarchy"),
  Type.Literal("attachments"),
]);

export const TaskSourceUpdateProposalV1 = versioned("TaskSourceUpdateProposal", 1, {
  proposalId: TaskSourceUpdateProposalId,
  sourceWorkItemId: SourceWorkItemId,
  baseSnapshotId: TaskSourceSnapshotId,
  observedSnapshotId: TaskSourceSnapshotId,
  baseObservedVersion: Type.String({ minLength: 1, maxLength: 4096 }),
  observedVersion: Type.String({ minLength: 1, maxLength: 4096 }),
  changedFields: Type.Array(TaskSourceChangedField, { minItems: 1, uniqueItems: true }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("accepted"), Type.Literal("rejected")]),
  createdAt: IsoDateTime,
  decidedAt: Type.Union([IsoDateTime, Type.Null()]),
});

export const TaskSourceSynchronizationConflict = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("stale_source"),
      Type.Literal("ambiguous_mapping"),
      Type.Literal("incompatible_source"),
    ]),
    message: NonEmpty,
    baseObservedVersion: Type.String({ minLength: 1, maxLength: 4096 }),
    currentObservedVersion: Type.String({ minLength: 1, maxLength: 4096 }),
    mergeable: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const TaskSourceSynchronizationAuditV1 = versioned("TaskSourceSynchronizationAudit", 1, {
  synchronizationId: TaskSourceSynchronizationId,
  sourceWorkItemId: SourceWorkItemId,
  sourceUri: Type.String({ minLength: 1, maxLength: 8192 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 1024 }),
  proposalSha256: Sha256,
  expectedObservedVersion: Type.String({ minLength: 1, maxLength: 4096 }),
  currentObservedVersion: Type.String({ minLength: 1, maxLength: 4096 }),
  actor: Type.String({ minLength: 1, maxLength: 1024 }),
  outcome: Type.Union([Type.Literal("posted"), Type.Literal("adopted"), Type.Literal("conflict")]),
  commentUri: Type.Union([Type.String({ minLength: 1, maxLength: 8192 }), Type.Null()]),
  requestId: Type.Union([Type.String({ minLength: 1, maxLength: 1024 }), Type.Null()]),
  conflict: Type.Union([TaskSourceSynchronizationConflict, Type.Null()]),
  createdAt: IsoDateTime,
  completedAt: IsoDateTime,
});

export const TaskRevisionDocumentV1 = versioned("TaskRevisionDocument", 1, {
  objective: NonEmpty,
  constraints: Type.Array(NonEmpty, { maxItems: 1024 }),
  decisions: Type.Array(TaskDecision, { maxItems: 1024 }),
  openQuestions: Type.Array(NonEmpty, { maxItems: 1024 }),
  repositoryReferences: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
    maxItems: 1024,
  }),
  requirements: Type.Array(TaskRequirement, { minItems: 1, maxItems: 4096 }),
});

const JsonPointer = Type.String({ pattern: "^(?:/(?:[^~/]|~[01])*)*$", maxLength: 8192 });
export const JsonPatchOperation = Type.Union([
  Type.Object(
    { op: Type.Literal("add"), path: JsonPointer, value: JsonValue },
    { additionalProperties: false },
  ),
  Type.Object({ op: Type.Literal("remove"), path: JsonPointer }, { additionalProperties: false }),
  Type.Object(
    { op: Type.Literal("replace"), path: JsonPointer, value: JsonValue },
    { additionalProperties: false },
  ),
  Type.Object(
    { op: Type.Literal("move"), from: JsonPointer, path: JsonPointer },
    { additionalProperties: false },
  ),
  Type.Object(
    { op: Type.Literal("copy"), from: JsonPointer, path: JsonPointer },
    { additionalProperties: false },
  ),
  Type.Object(
    { op: Type.Literal("test"), path: JsonPointer, value: JsonValue },
    { additionalProperties: false },
  ),
]);

export const TaskRevisionV1 = versioned("TaskRevision", 1, {
  revisionId: TaskRevisionId,
  sourceWorkItemId: SourceWorkItemId,
  ordinal: Type.Integer({ minimum: 1 }),
  revisionSha256: Sha256,
  predecessorRevisionId: Type.Union([TaskRevisionId, Type.Null()]),
  predecessorRevisionSha256: Type.Union([Sha256, Type.Null()]),
  sourceSnapshotId: TaskSourceSnapshotId,
  author: Type.String({ minLength: 1, maxLength: 1024 }),
  reason: NonEmpty,
  patch: Type.Array(JsonPatchOperation, { maxItems: 256 }),
  document: Type.Ref(TaskRevisionDocumentV1),
  supersessionState: Type.Union([Type.Literal("active"), Type.Literal("superseded")]),
  supersededByRevisionId: Type.Union([TaskRevisionId, Type.Null()]),
  createdAt: IsoDateTime,
});

const TrackerEdge = Type.Object(
  { parentSourceWorkItemId: SourceWorkItemId, childSourceWorkItemId: SourceWorkItemId },
  { additionalProperties: false },
);
const ExecutionMapping = Type.Object(
  {
    sourceWorkItemId: SourceWorkItemId,
    executionTaskIds: Type.Array(ExecutionTaskId, { uniqueItems: true, maxItems: 4096 }),
  },
  { additionalProperties: false },
);

export const TaskHierarchyV1 = versioned("TaskHierarchy", 1, {
  rootSourceWorkItemId: SourceWorkItemId,
  trackerEdges: Type.Array(TrackerEdge, { maxItems: 4096 }),
  executionMappings: Type.Array(ExecutionMapping, { maxItems: 4096 }),
  recordedAt: IsoDateTime,
});

/**
 * §13.1 does not define `TaskContext`'s shape, only `load(input): Promise<TaskContext>`.
 * This is synthesized from the surrounding section: the v1 source-kind
 * enumeration (§13.1), the parent-handoff artifact fields (§13.2), and the
 * immutable-initial-source / revision model (§13.3). `repositoryReferences`
 * stays a raw string array rather than branded `RepositoryId[]` because at
 * load time these are unresolved mentions (e.g. `"org/repo"` parsed out of
 * an issue body) — canonical `RepositoryId`s don't exist until Codebase
 * registration (§11) binds them.
 */
export const TaskContextV1 = versioned("TaskContext", 1, {
  snapshot: Type.Ref(TaskSourceSnapshotV1),
  activeRevision: Type.Ref(TaskRevisionV1),
  hierarchy: Type.Ref(TaskHierarchyV1),
});

export const TaskContextV2 = versioned("TaskContext", 2, {
  snapshot: Type.Ref(TaskSourceSnapshotV2),
  activeRevision: Type.Ref(TaskRevisionV1),
  hierarchy: Type.Ref(TaskHierarchyV1),
  pendingUpdates: Type.Array(Type.Ref(TaskSourceUpdateProposalV1), { maxItems: 4096 }),
});
