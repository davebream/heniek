import { Type } from "@sinclair/typebox";
import { versioned } from "../kernel/index.js";
import { RepositoryId } from "../run/ids.js";
import { ForgeIssueId, ForgeObservedVersion, ForgeRefId, PullRequestId } from "./ids.js";
import {
  CheckState,
  ForgeIssueState,
  ForgeMutationDisposition,
  PullRequestMergeability,
  PullRequestMergeState,
  PullRequestState,
} from "./state.js";

const Sha = Type.String({ minLength: 1 });
const LinkageDigest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const BranchName = Type.String({ minLength: 1, pattern: "^(?!refs/).+" });
const QualifiedRef = Type.String({ minLength: 6, pattern: "^refs/[^/]+/.+" });

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

export const ForgeIssueV1 = versioned("ForgeIssue", 1, {
  issueId: ForgeIssueId,
  repositoryId: RepositoryId,
  number: Type.Integer({ minimum: 1 }),
  url: Type.String({ format: "uri" }),
  title: Type.String({ minLength: 1 }),
  body: Type.String(),
  state: ForgeIssueState.schema,
  labels: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  linkageDigest: Type.Optional(LinkageDigest),
  observedVersion: ForgeObservedVersion,
});

export const CreateOrAdoptIssueInputV1 = versioned("CreateOrAdoptIssueInput", 1, {
  repositoryId: RepositoryId,
  title: Type.String({ minLength: 1 }),
  body: Type.String(),
  labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
  idempotencyKey: Type.String({ minLength: 1 }),
});

export const GetIssueInputV1 = versioned("GetIssueInput", 1, {
  repositoryId: RepositoryId,
  number: Type.Integer({ minimum: 1 }),
});

export const UpdateIssueInputV1 = versioned("UpdateIssueInput", 1, {
  repositoryId: RepositoryId,
  number: Type.Integer({ minimum: 1 }),
  expectedObservedVersion: ForgeObservedVersion,
  patch: Type.Object(
    {
      title: Type.Optional(Type.String({ minLength: 1 })),
      body: Type.Optional(Type.String()),
      state: Type.Optional(ForgeIssueState.schema),
      labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true })),
    },
    { additionalProperties: false, minProperties: 1 },
  ),
});

export const ForgeIssueMutationV1 = versioned("ForgeIssueMutation", 1, {
  disposition: ForgeMutationDisposition.schema,
  issue: Type.Ref(ForgeIssueV1),
});

export const ForgeRefV1 = versioned("ForgeRef", 1, {
  forgeRefId: ForgeRefId,
  repositoryId: RepositoryId,
  qualifiedRef: QualifiedRef,
  url: Type.String({ format: "uri" }),
  headSha: Sha,
  observedVersion: ForgeObservedVersion,
});

export const GetRefInputV1 = versioned("GetRefInput", 1, {
  repositoryId: RepositoryId,
  qualifiedRef: QualifiedRef,
});

export const CreateOrAdoptBranchInputV1 = versioned("CreateOrAdoptBranchInput", 1, {
  repositoryId: RepositoryId,
  branchName: BranchName,
  targetSha: Sha,
});

export const UpdateBranchInputV1 = versioned("UpdateBranchInput", 1, {
  repositoryId: RepositoryId,
  branchName: BranchName,
  expectedHeadSha: Sha,
  targetHeadSha: Sha,
});

export const ForgeRefMutationV1 = versioned("ForgeRefMutation", 1, {
  disposition: ForgeMutationDisposition.schema,
  ref: Type.Ref(ForgeRefV1),
});

export const CreatePullRequestInputV2 = versioned("CreatePullRequestInput", 2, {
  repositoryId: RepositoryId,
  sourceBranch: BranchName,
  targetBranch: BranchName,
  title: Type.String({ minLength: 1 }),
  body: Type.String(),
  draft: Type.Optional(Type.Boolean()),
  expectedHeadSha: Sha,
  idempotencyKey: Type.String({ minLength: 1 }),
});

export const PullRequestV2 = versioned("PullRequest", 2, {
  pullRequestId: PullRequestId,
  repositoryId: RepositoryId,
  number: Type.Integer({ minimum: 1 }),
  url: Type.String({ format: "uri" }),
  state: PullRequestState.schema,
  draft: Type.Boolean(),
  sourceBranch: BranchName,
  targetBranch: BranchName,
  baseSha: Sha,
  headSha: Sha,
  autoMergeEnabled: Type.Boolean(),
  linkageDigest: Type.Optional(LinkageDigest),
  observedVersion: ForgeObservedVersion,
});

export const UpdatePullRequestInputV1 = versioned("UpdatePullRequestInput", 1, {
  pullRequestId: PullRequestId,
  expectedObservedVersion: ForgeObservedVersion,
  expectedHeadSha: Sha,
  draft: Type.Optional(Type.Boolean()),
  autoMergeEnabled: Type.Optional(Type.Boolean()),
});

export const PullRequestMutationV1 = versioned("PullRequestMutation", 1, {
  disposition: ForgeMutationDisposition.schema,
  pullRequest: Type.Ref(PullRequestV2),
});

export const PullRequestStatusV1 = versioned("PullRequestStatus", 1, {
  pullRequestId: PullRequestId,
  mergeability: PullRequestMergeability.schema,
  mergeState: PullRequestMergeState.schema,
  checks: Type.Array(Type.Ref(CheckStatusV1)),
  totalCount: Type.Integer({ minimum: 0 }),
  requiredCount: Type.Integer({ minimum: 0 }),
  succeededCount: Type.Integer({ minimum: 0 }),
  failedCount: Type.Integer({ minimum: 0 }),
  pendingCount: Type.Integer({ minimum: 0 }),
  observedVersion: ForgeObservedVersion,
});
