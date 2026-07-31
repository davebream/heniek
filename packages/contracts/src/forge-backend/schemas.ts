import { Type } from "@sinclair/typebox";
import { versioned } from "../kernel/index.js";
import { RepositoryId } from "../run/ids.js";
import { PullRequestId } from "./ids.js";
import { CheckState, PullRequestState } from "./state.js";

/**
 * §21.6, provider-neutral. `v1 implements GitHubForgeBackend` per spec, but
 * no GitHub-shaped field (node id, mergeable_state, check-run id, ...) may
 * appear here — only the shape every forge can express.
 */
export const CreatePullRequestInputV1 = versioned("CreatePullRequestInput", 1, {
  repositoryId: RepositoryId,
  sourceBranch: Type.String({ minLength: 1 }),
  targetBranch: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  body: Type.String(),
  draft: Type.Boolean(),
});

export const PullRequestV1 = versioned("PullRequest", 1, {
  pullRequestId: PullRequestId,
  repositoryId: RepositoryId,
  number: Type.Integer({ minimum: 1 }),
  url: Type.String({ format: "uri" }),
  state: PullRequestState.schema,
  draft: Type.Boolean(),
  headSha: Type.String({ minLength: 1 }),
});

export const CheckStatusV1 = versioned("CheckStatus", 1, {
  name: Type.String({ minLength: 1 }),
  state: CheckState.schema,
  required: Type.Boolean(),
  detailsUrl: Type.Optional(Type.String({ format: "uri" })),
});

export const CheckFailureV1 = versioned("CheckFailure", 1, {
  name: Type.String({ minLength: 1 }),
  summary: Type.String({ minLength: 1 }),
  logExcerpt: Type.Optional(Type.String()),
});
