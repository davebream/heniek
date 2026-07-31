import type { Static } from "@sinclair/typebox";
import type { PullRequestId } from "./ids.js";
import type {
  CheckFailureV1,
  CheckStatusV1,
  CreatePullRequestInputV1,
  PullRequestV1,
} from "./schemas.js";

/** §21.6, verbatim signatures with IDs branded. v1 implements `GitHubForgeBackend`. */
export interface ForgeBackend {
  createPullRequest(input: Static<typeof CreatePullRequestInputV1>): Promise<Static<typeof PullRequestV1>>;
  markReady(id: PullRequestId): Promise<void>;
  getChecks(id: PullRequestId): Promise<Static<typeof CheckStatusV1>[]>;
  getFailedCheckLogs(id: PullRequestId): Promise<Static<typeof CheckFailureV1>[]>;
  enableAutoMerge(id: PullRequestId): Promise<void>;
}
