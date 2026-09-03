import type { ForgeArrangement, ForgeBackendHarness } from "@heniek/conformance";
import type { CheckState, RepositoryId } from "@heniek/contracts";
import type {
  GitHubTransport,
  GitHubTransportRequest,
  GitHubTransportResponse,
} from "@heniek/github-client";
import { createGitHubForgeBackend, isGitHubForgeError } from "../src/index.js";

interface RecordedRef {
  readonly id: string;
  readonly name: string;
  sha: string;
}

interface RecordedIssue {
  readonly node_id: string;
  readonly number: number;
  readonly html_url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
}

interface RecordedCheck {
  readonly name: string;
  readonly state: CheckState;
}

interface RecordedPullRequest {
  readonly node_id: string;
  readonly number: number;
  readonly html_url: string;
  readonly title: string;
  readonly body: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly baseSha: string;
  headSha: string;
  draft: boolean;
  autoMergeEnabled: boolean;
  readonly staleOnAutoMerge: boolean;
  readonly checks: readonly RecordedCheck[];
  fault: "disconnect" | "rate_limit" | null;
}

function json(
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): GitHubTransportResponse {
  return {
    status,
    headers,
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function body(request: GitHubTransportRequest): Record<string, unknown> {
  return JSON.parse(request.body ?? "{}") as Record<string, unknown>;
}

function graphQlData(value: Record<string, unknown>): GitHubTransportResponse {
  return json(200, { data: value });
}

function graphQlError(type: string): GitHubTransportResponse {
  return json(200, { errors: [{ type, extensions: { type } }] });
}

function refKey(name: string): string {
  return name.startsWith("refs/") ? name : `refs/heads/${name}`;
}

export class RecordedGitHubService {
  readonly requests: GitHubTransportRequest[] = [];
  readonly refs = new Map<string, RecordedRef>([
    ["refs/heads/main", { id: "REF_main", name: "main", sha: "base-sha" }],
    ["refs/heads/feature", { id: "REF_feature", name: "feature", sha: "head-sha" }],
    [
      "refs/heads/conformance-feature",
      { id: "REF_conformance_feature", name: "conformance-feature", sha: "head-sha" },
    ],
  ]);
  readonly issues = new Map<number, RecordedIssue>();
  readonly pullRequests = new Map<string, RecordedPullRequest>();
  private nextIssue = 1;
  private nextPullRequest = 1;
  private arrangement: ForgeArrangement = { kind: "clean" };

  readonly transport: GitHubTransport = {
    request: async (request) => this.request(request),
  };

  arrange(arrangement: ForgeArrangement): void {
    this.arrangement = arrangement;
  }

  private issueResponse(issue: RecordedIssue): Record<string, unknown> {
    return { ...issue, labels: issue.labels.map((name) => ({ name })) };
  }

  private pullRequestResponse(pullRequest: RecordedPullRequest): Record<string, unknown> {
    return {
      node_id: pullRequest.node_id,
      number: pullRequest.number,
      html_url: pullRequest.html_url,
      state: "open",
      merged_at: null,
      draft: pullRequest.draft,
      title: pullRequest.title,
      body: pullRequest.body,
      head: { ref: pullRequest.sourceBranch, sha: pullRequest.headSha },
      base: { ref: pullRequest.targetBranch, sha: pullRequest.baseSha },
      auto_merge: pullRequest.autoMergeEnabled ? { enabled_by: { login: "heniek" } } : null,
    };
  }

  private pullRequestGraphQl(pullRequest: RecordedPullRequest): Record<string, unknown> {
    return {
      __typename: "PullRequest",
      id: pullRequest.node_id,
      number: pullRequest.number,
      url: pullRequest.html_url,
      state: "OPEN",
      isDraft: pullRequest.draft,
      title: pullRequest.title,
      body: pullRequest.body,
      headRefName: pullRequest.sourceBranch,
      baseRefName: pullRequest.targetBranch,
      headRefOid: pullRequest.headSha,
      baseRefOid: pullRequest.baseSha,
      autoMergeRequest: pullRequest.autoMergeEnabled ? { enabledAt: "2026-09-03T00:00:00Z" } : null,
    };
  }

  private consumeArrangement(): {
    readonly checks: readonly RecordedCheck[];
    readonly staleOnAutoMerge: boolean;
    readonly fault: RecordedPullRequest["fault"];
  } {
    const arrangement = this.arrangement;
    this.arrangement = { kind: "clean" };
    return {
      checks:
        arrangement.kind === "checks"
          ? arrangement.states.map((state, index) => ({
              name: `recorded-check-${index + 1}`,
              state,
            }))
          : [],
      staleOnAutoMerge: arrangement.kind === "stale-head",
      fault:
        arrangement.kind === "injects-fault" &&
        (arrangement.fault === "disconnect" || arrangement.fault === "rate_limit")
          ? arrangement.fault
          : null,
    };
  }

  private async request(request: GitHubTransportRequest): Promise<GitHubTransportResponse> {
    this.requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/graphql") return this.graphQl(request);

    const issueMatch = /^\/repos\/acme\/repo\/issues(?:\/(\d+))?$/u.exec(url.pathname);
    if (issueMatch !== null) {
      const number = issueMatch[1] === undefined ? null : Number(issueMatch[1]);
      if (request.method === "GET" && number === null) {
        return json(
          200,
          [...this.issues.values()].map((issue) => this.issueResponse(issue)),
        );
      }
      if (request.method === "POST" && number === null) {
        const input = body(request);
        const issueNumber = this.nextIssue++;
        const issue: RecordedIssue = {
          node_id: `ISSUE_${issueNumber}`,
          number: issueNumber,
          html_url: `https://github.test/acme/repo/issues/${issueNumber}`,
          title: String(input.title),
          body: String(input.body),
          state: "open",
          labels: Array.isArray(input.labels) ? input.labels.map(String).sort() : [],
        };
        this.issues.set(issueNumber, issue);
        return json(201, this.issueResponse(issue));
      }
      const issue = number === null ? undefined : this.issues.get(number);
      if (issue === undefined) return json(404, { message: "not found" });
      if (request.method === "GET") return json(200, this.issueResponse(issue));
      if (request.method === "PATCH") {
        const input = body(request);
        if (typeof input.title === "string") issue.title = input.title;
        if (typeof input.body === "string") issue.body = input.body;
        if (input.state === "open" || input.state === "closed") issue.state = input.state;
        if (Array.isArray(input.labels)) issue.labels = input.labels.map(String).sort();
        return json(200, this.issueResponse(issue));
      }
    }

    if (url.pathname === "/repos/acme/repo/pulls") {
      if (request.method === "GET") {
        const head = url.searchParams.get("head")?.split(":").at(-1);
        const base = url.searchParams.get("base");
        return json(
          200,
          [...this.pullRequests.values()]
            .filter(
              (pullRequest) =>
                (head === null || head === undefined || pullRequest.sourceBranch === head) &&
                (base === null || pullRequest.targetBranch === base),
            )
            .map((pullRequest) => this.pullRequestResponse(pullRequest)),
        );
      }
      if (request.method === "POST") {
        const input = body(request);
        const sourceBranch = String(input.head);
        const targetBranch = String(input.base);
        const number = this.nextPullRequest++;
        const arranged = this.consumeArrangement();
        const pullRequest: RecordedPullRequest = {
          node_id: `PR_${number}`,
          number,
          html_url: `https://github.test/acme/repo/pull/${number}`,
          title: String(input.title),
          body: String(input.body),
          sourceBranch,
          targetBranch,
          headSha: this.refs.get(refKey(sourceBranch))?.sha ?? "missing-head",
          baseSha: this.refs.get(refKey(targetBranch))?.sha ?? "missing-base",
          draft: input.draft === true,
          autoMergeEnabled: false,
          ...arranged,
        };
        this.pullRequests.set(pullRequest.node_id, pullRequest);
        return json(201, this.pullRequestResponse(pullRequest));
      }
    }

    return json(404, { message: "recorded route not found" });
  }

  private graphQl(request: GitHubTransportRequest): GitHubTransportResponse {
    const envelope = body(request);
    const operationName = String(envelope.operationName);
    const variables = (envelope.variables ?? {}) as Record<string, unknown>;
    if (operationName === "ResolveRepository") {
      return graphQlData({ repository: { id: "REPOSITORY_acme_repo" } });
    }
    if (operationName === "ReadRef") {
      const ref = this.refs.get(String(variables.qualifiedRef));
      return graphQlData({
        repository: {
          ref:
            ref === undefined
              ? null
              : { id: ref.id, name: ref.name, prefix: "refs/heads/", target: { oid: ref.sha } },
        },
      });
    }
    if (operationName === "UpdateRefs") {
      const input = variables.input as {
        readonly refUpdates: readonly {
          readonly name: string;
          readonly beforeOid: string;
          readonly afterOid: string;
          readonly force: boolean;
        }[];
      };
      const update = input.refUpdates[0];
      if (update === undefined || update.force) return graphQlError("UNPROCESSABLE");
      const current = this.refs.get(update.name);
      const expected = update.beforeOid;
      if (
        (expected === "0000000000000000000000000000000000000000" && current !== undefined) ||
        (expected !== "0000000000000000000000000000000000000000" && current?.sha !== expected)
      ) {
        return graphQlError("UNPROCESSABLE");
      }
      this.refs.set(update.name, {
        id: current?.id ?? `REF_${update.name}`,
        name: update.name.replace("refs/heads/", ""),
        sha: update.afterOid,
      });
      return graphQlData({ updateRefs: { clientMutationId: null } });
    }

    const nodeId = String(variables.id);
    const pullRequest = this.pullRequests.get(nodeId);
    if (operationName === "ReadPullRequest") {
      return graphQlData({
        node: pullRequest === undefined ? null : this.pullRequestGraphQl(pullRequest),
      });
    }
    if (pullRequest === undefined) return graphQlData({ node: null });

    if (operationName === "ObservePullRequestStatus") {
      if (pullRequest.fault === "disconnect") {
        pullRequest.fault = null;
        throw new Error("recorded disconnect after request");
      }
      if (pullRequest.fault === "rate_limit") {
        pullRequest.fault = null;
        return json(403, { message: "rate limited" }, { "x-ratelimit-remaining": "0" });
      }
      return graphQlData({
        node: {
          __typename: "PullRequest",
          mergeable: pullRequest.staleOnAutoMerge ? "CONFLICTING" : "MERGEABLE",
          mergeStateStatus: pullRequest.draft ? "DRAFT" : "CLEAN",
          statusCheckRollup: {
            contexts: {
              nodes: pullRequest.checks.map((check) => ({
                __typename: "CheckRun",
                name: check.name,
                status:
                  check.state === "queued"
                    ? "QUEUED"
                    : check.state === "in_progress"
                      ? "IN_PROGRESS"
                      : "COMPLETED",
                conclusion:
                  check.state === "succeeded"
                    ? "SUCCESS"
                    : check.state === "failed"
                      ? "FAILURE"
                      : check.state === "skipped"
                        ? "SKIPPED"
                        : null,
                detailsUrl: `https://github.test/acme/repo/actions/${check.name}`,
                isRequired: true,
                output:
                  check.state === "failed"
                    ? { summary: `${check.name} failed.`, text: "recorded failure excerpt" }
                    : { summary: "", text: "" },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }
    if (operationName === "MarkPullRequestReadyForReview") {
      pullRequest.draft = false;
      return graphQlData({ markPullRequestReadyForReview: { clientMutationId: null } });
    }
    if (operationName === "ConvertPullRequestToDraft") {
      pullRequest.draft = true;
      return graphQlData({ convertPullRequestToDraft: { clientMutationId: null } });
    }
    if (operationName === "EnablePullRequestAutoMerge") {
      if (pullRequest.draft) return graphQlError("UNPROCESSABLE");
      if (pullRequest.staleOnAutoMerge) pullRequest.headSha = `${pullRequest.headSha}-changed`;
      if (pullRequest.headSha !== variables.head) return graphQlError("UNPROCESSABLE");
      pullRequest.autoMergeEnabled = true;
      return graphQlData({ enablePullRequestAutoMerge: { clientMutationId: null } });
    }
    if (operationName === "DisablePullRequestAutoMerge") {
      pullRequest.autoMergeEnabled = false;
      return graphQlData({ disablePullRequestAutoMerge: { clientMutationId: null } });
    }
    return graphQlError("UNPROCESSABLE");
  }
}

export function createRecordedGitHubForgeHarness(): ForgeBackendHarness {
  return {
    name: "recorded-github-forge-backend",
    capabilities: [
      "lifecycle",
      "fault-conflict",
      "fault-stale-ref",
      "fault-disconnect",
      "fault-rate-limit",
    ],
    classifyFault(error) {
      if (!isGitHubForgeError(error)) return "unknown";
      if (error.kind === "transport") return "disconnect";
      if (error.kind === "rate_limit") return "rate_limit";
      if (error.kind === "stale_ref" || error.kind === "not_found") return "stale_ref";
      if (error.kind === "conflict") return "conflict";
      if (error.kind === "malformed_response") return "malformed_response";
      return "unknown";
    },
    async createSubject() {
      const remote = new RecordedGitHubService();
      const backend = createGitHubForgeBackend({
        readTransport: remote.transport,
        writeTransport: remote.transport,
        apiOrigin: "https://api.github.test",
        webOrigin: "https://github.test",
        resolveRepository: (_repositoryId: RepositoryId) => ({ owner: "acme", repository: "repo" }),
      });
      return {
        subject: backend,
        async arrange(arrangement) {
          remote.arrange(arrangement);
        },
        async dispose() {},
      };
    },
  };
}
