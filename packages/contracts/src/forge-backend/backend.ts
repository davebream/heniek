import type { Static } from "@sinclair/typebox";
import type { RepositoryId } from "../run/ids.js";
import type { PullRequestId } from "./ids.js";
import type {
  CheckFailureV1,
  CheckStatusV1,
  CreatePullRequestInputV1,
  PullRequestV1,
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
