import { Type } from "@sinclair/typebox";
import { ArtifactId } from "../artifact/index.js";
import { versioned } from "../kernel/index.js";
import { SourceWorkItemId } from "./ids.js";

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
  sourceWorkItemId: SourceWorkItemId,
  sourceKind: Type.Union([
    Type.Literal("parent_conversation"),
    Type.Literal("manual_text"),
    Type.Literal("github_issue"),
    Type.Literal("github_pull_request"),
    Type.Literal("local_file"),
    Type.Literal("existing_branch_or_pr"),
  ]),
  objective: Type.String({ minLength: 1 }),
  constraints: Type.Array(Type.String({ minLength: 1 })),
  decisions: Type.Array(Type.String({ minLength: 1 })),
  openQuestions: Type.Array(Type.String({ minLength: 1 })),
  repositoryReferences: Type.Array(Type.String({ minLength: 1 })),
  rawContentRef: ArtifactId,
  revision: Type.Integer({ minimum: 1 }),
});
