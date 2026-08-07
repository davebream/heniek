import { Type } from "@sinclair/typebox";
import { InstructionSnapshotSchema } from "../codebase/index.js";
import { versioned } from "../kernel/index.js";
import { SourceWorkItemId } from "../task-source/index.js";
import { CodebaseId, RepositoryId, RunId, WorkspaceId } from "./ids.js";
import { RunStatus } from "./state.js";

/**
 * §16.1 lists a much larger canonical run state (stage states/attempts,
 * resolved profiles, provider sessions, decisions, commits/diffs,
 * verification evidence, publication state, ...). None of those have a
 * contract family yet — they belong to later, dedicated queue issues
 * (profiles, stages/pipeline, delivery, ...) per this issue's own
 * exclusion of unrelated backlog work. `RunV1` v1 covers only what Q001
 * itself is chartered to contract: run identity, its source, and the
 * Codebase/repository/workspace it operates in. It is expected to grow a
 * `RunV2`+ (or additive optional fields, per compatibility policy) as
 * those later issues land — not to be widened speculatively now.
 */
export const RunV1 = versioned("Run", 1, {
  runId: RunId,
  sourceWorkItemId: SourceWorkItemId,
  codebaseId: CodebaseId,
  repositoryIds: Type.Array(RepositoryId),
  workspaceId: WorkspaceId,
  status: RunStatus.schema,
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
});

export const RunV2 = versioned("Run", 2, {
  runId: RunId,
  sourceWorkItemId: SourceWorkItemId,
  codebaseId: CodebaseId,
  repositoryIds: Type.Array(RepositoryId),
  workspaceId: WorkspaceId,
  status: RunStatus.schema,
  instructionSnapshot: InstructionSnapshotSchema,
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
});
