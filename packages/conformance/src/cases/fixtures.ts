import type {
  ArtifactId,
  CreatePullRequestInputV1,
  ExecutionRequestV1,
  ProfileId,
  RepositoryId,
  StageId,
  WorkspaceId,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import type { ConformanceContext } from "../kernel/context.js";

/** Builds a contract-valid `ExecutionRequestV1` fixture for a case. */
export function executionRequest(
  ctx: ConformanceContext,
  overrides?: Partial<Static<typeof ExecutionRequestV1>>,
): Static<typeof ExecutionRequestV1> {
  return {
    schemaVersion: 1,
    stageId: ctx.ids.next("stage") as StageId,
    profileId: ctx.ids.next("profile") as ProfileId,
    workspaceId: ctx.ids.next("workspace") as WorkspaceId,
    workingDirectory: "/work/conformance",
    inputArtifactRefs: [],
    outputContract: "conformance-stage-output-v1",
    limits: {},
    ...overrides,
  };
}

/** A source-kind literal `TaskContextV1` accepts, mirrored from the schema union. */
export type TaskSourceKindLiteral =
  | "parent_conversation"
  | "manual_text"
  | "github_issue"
  | "github_pull_request"
  | "local_file"
  | "existing_branch_or_pr";

/** The `unknown` input shape the bundled fake `TaskSource` accepts when resolving normally. */
export interface TaskSourceFixtureInput {
  readonly ref: string;
  readonly sourceKind: TaskSourceKindLiteral;
}

export function taskSourceInput(
  overrides?: Partial<TaskSourceFixtureInput>,
): TaskSourceFixtureInput {
  return {
    ref: overrides?.ref ?? "conformance/task-1",
    sourceKind: overrides?.sourceKind ?? "github_issue",
  };
}

/** Builds a contract-valid `CreatePullRequestInputV1` fixture for a case. */
export function createPullRequestInput(
  overrides?: Partial<Static<typeof CreatePullRequestInputV1>>,
): Static<typeof CreatePullRequestInputV1> {
  return {
    schemaVersion: 1,
    repositoryId: "conformance-repository-1" as RepositoryId,
    sourceBranch: "conformance-feature",
    targetBranch: "main",
    title: "Conformance pull request",
    body: "Opened by the conformance harness.",
    draft: false,
    ...overrides,
  };
}

/** A conformance-only artifact ref, cast to the branded id type. */
export function artifactRef(ctx: ConformanceContext): ArtifactId {
  return ctx.ids.next("conformance-artifact") as ArtifactId;
}
