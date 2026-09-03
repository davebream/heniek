import type { Static } from "@sinclair/typebox";
import type { RepositoryId } from "../run/ids.js";
import type { PullRequestId } from "./ids.js";
import type {
  CheckFailureV1,
  CheckStatusV1,
  CreateOrAdoptBranchInputV1,
  CreateOrAdoptIssueInputV1,
  CreatePullRequestInputV1,
  CreatePullRequestInputV2,
  ForgeIssueMutationV1,
  ForgeIssueV1,
  ForgeRefMutationV1,
  ForgeRefV1,
  GetIssueInputV1,
  GetRefInputV1,
  PullRequestMutationV1,
  PullRequestStatusV1,
  PullRequestV1,
  PullRequestV2,
  UpdateBranchInputV1,
  UpdateIssueInputV1,
  UpdatePullRequestInputV1,
} from "./schemas.js";

/** §21.6, verbatim signatures with IDs branded. v1 implements `GitHubForgeBackend`. */
export interface ForgeBackend {
  createPullRequest(
    input: Static<typeof CreatePullRequestInputV1>,
  ): Promise<Static<typeof PullRequestV1>>;
  markReady(id: PullRequestId): Promise<void>;
  getChecks(id: PullRequestId): Promise<Static<typeof CheckStatusV1>[]>;
  getFailedCheckLogs(id: PullRequestId): Promise<Static<typeof CheckFailureV1>[]>;
  enableAutoMerge(id: PullRequestId): Promise<void>;
}

/**
 * Q027 publication discovery (ADR 0025). Extends the provider-neutral forge
 * surface so publish can adopt a unique existing PR after an acknowledgement-
 * boundary crash without inventing GitHub-shaped DTOs on the base interface.
 */
export interface ForgeBackendV2 extends ForgeBackend {
  findPullRequests(
    repositoryId: RepositoryId,
    sourceBranch: string,
    targetBranch: string,
  ): Promise<Static<typeof PullRequestV1>[]>;
}

/** Q047 provider-neutral issue, ref, pull-request, and observation primitives. */
export interface ForgeBackendV3 extends ForgeBackendV2 {
  createOrAdoptIssue(
    input: Static<typeof CreateOrAdoptIssueInputV1>,
  ): Promise<Static<typeof ForgeIssueMutationV1>>;
  getIssue(input: Static<typeof GetIssueInputV1>): Promise<Static<typeof ForgeIssueV1>>;
  updateIssue(
    input: Static<typeof UpdateIssueInputV1>,
  ): Promise<Static<typeof ForgeIssueMutationV1>>;
  getRef(input: Static<typeof GetRefInputV1>): Promise<Static<typeof ForgeRefV1> | null>;
  createOrAdoptBranch(
    input: Static<typeof CreateOrAdoptBranchInputV1>,
  ): Promise<Static<typeof ForgeRefMutationV1>>;
  updateBranch(
    input: Static<typeof UpdateBranchInputV1>,
  ): Promise<Static<typeof ForgeRefMutationV1>>;
  createOrAdoptPullRequest(
    input: Static<typeof CreatePullRequestInputV2>,
  ): Promise<Static<typeof PullRequestMutationV1>>;
  getPullRequest(id: PullRequestId): Promise<Static<typeof PullRequestV2>>;
  updatePullRequest(
    input: Static<typeof UpdatePullRequestInputV1>,
  ): Promise<Static<typeof PullRequestMutationV1>>;
  observePullRequestStatus(id: PullRequestId): Promise<Static<typeof PullRequestStatusV1>>;
}
