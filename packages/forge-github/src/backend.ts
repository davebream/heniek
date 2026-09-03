import type {
  CheckFailureV1,
  CheckStatusV1,
  CreateOrAdoptBranchInputV1,
  CreateOrAdoptIssueInputV1,
  CreatePullRequestInputV1,
  CreatePullRequestInputV2,
  ForgeBackendV3,
  ForgeIssueMutationV1,
  ForgeIssueV1,
  ForgeRefMutationV1,
  ForgeRefV1,
  GetIssueInputV1,
  GetRefInputV1,
  PullRequestId,
  PullRequestMutationV1,
  PullRequestStatusV1,
  PullRequestV1,
  PullRequestV2,
  RepositoryId,
  UpdateBranchInputV1,
  UpdateIssueInputV1,
  UpdatePullRequestInputV1,
} from "@heniek/contracts";
import {
  classifyGitHubResponse,
  type GitHubTransport,
  type GitHubTransportResponse,
  parseJson,
} from "@heniek/github-client";
import type { Static } from "@sinclair/typebox";
import { digest, observedVersion } from "./canonical.js";
import { forgeError, GitHubForgeError } from "./error.js";

const ZERO_OID = "0000000000000000000000000000000000000000";
const MAX_PAGES = 100;
const PAGE_SIZE = 100;
const MARKER = /(?:\n\n)?<!-- heniek-forge:(issue|pull-request):([a-f0-9]{64}) -->\s*$/u;

type Issue = Static<typeof ForgeIssueV1>;
type IssueMutation = Static<typeof ForgeIssueMutationV1>;
type Ref = Static<typeof ForgeRefV1>;
type RefMutation = Static<typeof ForgeRefMutationV1>;
type PullRequest = Static<typeof PullRequestV2>;
type PullRequestMutation = Static<typeof PullRequestMutationV1>;
type PullRequestStatus = Static<typeof PullRequestStatusV1>;
type Check = Static<typeof CheckStatusV1>;
type CheckFailure = Static<typeof CheckFailureV1>;

export interface GitHubRepositoryLocator {
  readonly owner: string;
  readonly repository: string;
}

export interface GitHubForgeBackendOptions {
  readonly readTransport: GitHubTransport;
  readonly writeTransport: GitHubTransport;
  readonly resolveRepository: (
    repositoryId: RepositoryId,
  ) => GitHubRepositoryLocator | Promise<GitHubRepositoryLocator>;
  readonly apiOrigin?: string;
  readonly webOrigin?: string;
}

interface PullRequestObservation {
  readonly resource: PullRequest;
  readonly title: string;
  readonly body: string;
}

interface StatusObservation {
  readonly status: PullRequestStatus;
  readonly failures: readonly CheckFailure[];
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubForgeError("malformed_response", `GitHub ${context} was not an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new GitHubForgeError("malformed_response", `GitHub response omitted ${field}`);
  }
  return value;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new GitHubForgeError("malformed_response", `GitHub response omitted ${field}`);
  }
  return value as number;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new GitHubForgeError("malformed_response", `GitHub response omitted ${field}`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return string(value, field);
}

function locatorPath(locator: GitHubRepositoryLocator): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(locator.owner) || !/^[A-Za-z0-9_.-]+$/.test(locator.repository)) {
    throw new GitHubForgeError("conflict", "repository locator contains unsafe characters");
  }
  return `${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.repository)}`;
}

function markerBody(kind: "issue" | "pull-request", body: string, linkageDigest: string): string {
  return `${body.replace(MARKER, "").trimEnd()}\n\n<!-- heniek-forge:${kind}:${linkageDigest} -->`;
}

function bodyAndLinkage(body: string): { readonly body: string; readonly linkageDigest?: string } {
  const match = MARKER.exec(body);
  const clean = body.replace(MARKER, "").trimEnd();
  return match?.[2] === undefined ? { body: clean } : { body: clean, linkageDigest: match[2] };
}

function linkageDigest(kind: "issue" | "pull-request", key: string): string {
  return digest({ kind, key });
}

function labels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new GitHubForgeError("malformed_response", "GitHub issue labels were not an array");
  }
  return [
    ...new Set(
      value.map((entry) =>
        typeof entry === "string"
          ? entry
          : string(object(entry, "issue label").name, "issue label.name"),
      ),
    ),
  ].sort();
}

function nextLink(value: string | undefined): string | null {
  if (value === undefined) return null;
  for (const part of value.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/u.exec(part);
    if (match?.[2] === "next") return match[1] ?? null;
  }
  return null;
}

function assertPaginationUrl(url: string, apiOrigin: string, repositoryPath: string): void {
  const parsed = new URL(url);
  if (parsed.origin !== apiOrigin || !parsed.pathname.startsWith(`/repos/${repositoryPath}/`)) {
    throw new GitHubForgeError(
      "malformed_response",
      "GitHub pagination returned an unexpected URL",
    );
  }
}

async function rest(
  transport: GitHubTransport,
  request: Parameters<GitHubTransport["request"]>[0],
  operation: string,
): Promise<{ readonly value: unknown; readonly response: GitHubTransportResponse }> {
  try {
    const response = await transport.request(request);
    classifyGitHubResponse(response, operation);
    return {
      value: response.body.byteLength === 0 ? null : parseJson(response.body, operation),
      response,
    };
  } catch (error) {
    throw forgeError(error, operation);
  }
}

function graphQlError(value: unknown, operation: string): GitHubForgeError {
  const errors = Array.isArray(value) ? value : [];
  const first = errors[0];
  const extensions =
    first === undefined
      ? {}
      : object(object(first, "GraphQL error").extensions ?? {}, "error extensions");
  const code = extensions.type ?? extensions.code;
  if (code === "FORBIDDEN") return new GitHubForgeError("permission", `GitHub ${operation} denied`);
  if (code === "NOT_FOUND")
    return new GitHubForgeError("not_found", `GitHub ${operation} not found`);
  if (operation === "update refs") {
    return new GitHubForgeError("stale_ref", "GitHub rejected the expected ref SHA");
  }
  if (code === "UNPROCESSABLE" || code === "CONFLICT") {
    return new GitHubForgeError("conflict", `GitHub ${operation} conflicted`);
  }
  return new GitHubForgeError("malformed_response", `GitHub ${operation} returned errors`);
}

async function graphQl(
  transport: GitHubTransport,
  apiOrigin: string,
  operationName: string,
  query: string,
  variables: Readonly<Record<string, unknown>>,
  faultOperation = operationName,
): Promise<Record<string, unknown>> {
  const { value } = await rest(
    transport,
    {
      method: "POST",
      url: `${apiOrigin}/graphql`,
      body: JSON.stringify({ operationName, query, variables }),
    },
    faultOperation,
  );
  const envelope = object(value, `${operationName} response`);
  if (envelope.errors !== undefined) throw graphQlError(envelope.errors, faultOperation);
  return object(envelope.data, `${operationName} data`);
}

async function paginatedRest(
  transport: GitHubTransport,
  initialUrl: string,
  operation: string,
  apiOrigin: string,
  repositoryPath: string,
): Promise<readonly unknown[]> {
  const values: unknown[] = [];
  let url: string | null = initialUrl;
  for (let page = 1; url !== null; page += 1) {
    if (page > MAX_PAGES) {
      throw new GitHubForgeError(
        "malformed_response",
        `GitHub ${operation} exceeded ${MAX_PAGES} pages`,
      );
    }
    assertPaginationUrl(url, apiOrigin, repositoryPath);
    const result = await rest(transport, { method: "GET", url }, operation);
    if (!Array.isArray(result.value)) {
      throw new GitHubForgeError("malformed_response", `GitHub ${operation} was not an array`);
    }
    values.push(...result.value);
    url = nextLink(result.response.headers.link);
  }
  return values;
}

function issueFromRest(repositoryId: RepositoryId, value: unknown): Issue {
  const item = object(value, "issue");
  const rawBody = item.body === null ? "" : string(item.body, "issue.body");
  const normalizedBody = bodyAndLinkage(rawBody);
  const state = string(item.state, "issue.state");
  if (state !== "open" && state !== "closed") {
    throw new GitHubForgeError("malformed_response", "GitHub issue state was invalid");
  }
  const normalized = {
    issueId: string(item.node_id, "issue.node_id"),
    repositoryId,
    number: integer(item.number, "issue.number"),
    url: string(item.html_url, "issue.html_url"),
    title: string(item.title, "issue.title"),
    body: normalizedBody.body,
    state,
    labels: labels(item.labels),
    ...(normalizedBody.linkageDigest === undefined
      ? {}
      : { linkageDigest: normalizedBody.linkageDigest }),
  };
  return {
    schemaVersion: 1,
    ...normalized,
    observedVersion: observedVersion(normalized),
  } as Issue;
}

function pullRequestId(repositoryId: RepositoryId, nodeId: string): PullRequestId {
  const repository = Buffer.from(repositoryId).toString("base64url");
  const node = Buffer.from(nodeId).toString("base64url");
  return `github-pr:${repository}:${node}` as PullRequestId;
}

function parsePullRequestId(id: PullRequestId): {
  readonly repositoryId: RepositoryId;
  readonly nodeId: string;
} {
  const match = /^github-pr:([^:]+):([^:]+)$/u.exec(id);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new GitHubForgeError("stale_ref", "pull request id is not a GitHub forge reference");
  }
  try {
    return {
      repositoryId: Buffer.from(match[1], "base64url").toString("utf8") as RepositoryId,
      nodeId: Buffer.from(match[2], "base64url").toString("utf8"),
    };
  } catch {
    throw new GitHubForgeError("stale_ref", "pull request id is malformed");
  }
}

function pullRequestState(value: unknown): PullRequest["state"] {
  const state = string(value, "pull request state").toLowerCase();
  if (state === "open" || state === "closed" || state === "merged") return state;
  throw new GitHubForgeError("malformed_response", "GitHub pull request state was invalid");
}

function pullRequestFromRest(repositoryId: RepositoryId, value: unknown): PullRequestObservation {
  const item = object(value, "pull request");
  const head = object(item.head, "pull request head");
  const base = object(item.base, "pull request base");
  const bodyValue = item.body === null ? "" : string(item.body, "pull request.body");
  const normalizedBody = bodyAndLinkage(bodyValue);
  const normalized = {
    pullRequestId: pullRequestId(repositoryId, string(item.node_id, "pull request.node_id")),
    repositoryId,
    number: integer(item.number, "pull request.number"),
    url: string(item.html_url, "pull request.html_url"),
    state: item.merged_at === null ? pullRequestState(item.state) : ("merged" as const),
    draft: boolean(item.draft, "pull request.draft"),
    sourceBranch: string(head.ref, "pull request.head.ref"),
    targetBranch: string(base.ref, "pull request.base.ref"),
    baseSha: string(base.sha, "pull request.base.sha"),
    headSha: string(head.sha, "pull request.head.sha"),
    autoMergeEnabled: item.auto_merge !== null && item.auto_merge !== undefined,
    ...(normalizedBody.linkageDigest === undefined
      ? {}
      : { linkageDigest: normalizedBody.linkageDigest }),
  };
  return {
    title: string(item.title, "pull request.title"),
    body: normalizedBody.body,
    resource: {
      schemaVersion: 2,
      ...normalized,
      observedVersion: observedVersion(normalized),
    } as PullRequest,
  };
}

function pullRequestFromGraphQl(
  repositoryId: RepositoryId,
  value: unknown,
): PullRequestObservation {
  const item = object(value, "pull request");
  const bodyValue = string(item.body, "pull request.body");
  const normalizedBody = bodyAndLinkage(bodyValue);
  const normalized = {
    pullRequestId: pullRequestId(repositoryId, string(item.id, "pull request.id")),
    repositoryId,
    number: integer(item.number, "pull request.number"),
    url: string(item.url, "pull request.url"),
    state: pullRequestState(item.state),
    draft: boolean(item.isDraft, "pull request.isDraft"),
    sourceBranch: string(item.headRefName, "pull request.headRefName"),
    targetBranch: string(item.baseRefName, "pull request.baseRefName"),
    baseSha: string(item.baseRefOid, "pull request.baseRefOid"),
    headSha: string(item.headRefOid, "pull request.headRefOid"),
    autoMergeEnabled: item.autoMergeRequest !== null,
    ...(normalizedBody.linkageDigest === undefined
      ? {}
      : { linkageDigest: normalizedBody.linkageDigest }),
  };
  return {
    title: string(item.title, "pull request.title"),
    body: normalizedBody.body,
    resource: {
      schemaVersion: 2,
      ...normalized,
      observedVersion: observedVersion(normalized),
    } as PullRequest,
  };
}

function pullRequestV1(value: PullRequest): Static<typeof PullRequestV1> {
  return {
    schemaVersion: 1,
    pullRequestId: value.pullRequestId,
    repositoryId: value.repositoryId,
    number: value.number,
    url: value.url,
    state: value.state,
    draft: value.draft,
    headSha: value.headSha,
  };
}

function equalLabels(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function issueMatches(
  issue: Issue,
  input: Static<typeof CreateOrAdoptIssueInputV1>,
  expectedLinkage: string,
): boolean {
  return (
    issue.linkageDigest === expectedLinkage &&
    issue.title === input.title &&
    issue.body === input.body.trimEnd() &&
    equalLabels(issue.labels, input.labels ?? [])
  );
}

function pullRequestMatches(
  observation: PullRequestObservation,
  input: Static<typeof CreatePullRequestInputV2>,
  expectedLinkage: string,
): boolean {
  const pullRequest = observation.resource;
  return (
    pullRequest.linkageDigest === expectedLinkage &&
    pullRequest.sourceBranch === input.sourceBranch &&
    pullRequest.targetBranch === input.targetBranch &&
    pullRequest.headSha === input.expectedHeadSha &&
    pullRequest.draft === (input.draft ?? true) &&
    observation.title === input.title &&
    observation.body === input.body.trimEnd()
  );
}

function prNode(data: Record<string, unknown>): Record<string, unknown> {
  if (data.node === null) throw new GitHubForgeError("stale_ref", "pull request no longer exists");
  const node = object(data.node, "pull request node");
  if (node.__typename !== "PullRequest") {
    throw new GitHubForgeError("stale_ref", "forge reference does not identify a pull request");
  }
  return node;
}

export function createGitHubForgeBackend(options: GitHubForgeBackendOptions): ForgeBackendV3 {
  const apiOrigin = (options.apiOrigin ?? "https://api.github.com").replace(/\/$/u, "");
  const webOrigin = (options.webOrigin ?? "https://github.com").replace(/\/$/u, "");

  async function locate(repositoryId: RepositoryId): Promise<GitHubRepositoryLocator> {
    const locator = await options.resolveRepository(repositoryId);
    locatorPath(locator);
    return locator;
  }

  async function getIssue(input: Static<typeof GetIssueInputV1>): Promise<Issue> {
    const locator = await locate(input.repositoryId);
    const path = locatorPath(locator);
    const { value } = await rest(
      options.readTransport,
      { method: "GET", url: `${apiOrigin}/repos/${path}/issues/${input.number}` },
      "read issue",
    );
    const item = object(value, "issue");
    if (item.pull_request !== undefined) {
      throw new GitHubForgeError("stale_ref", "forge issue reference identifies a pull request");
    }
    return issueFromRest(input.repositoryId, item);
  }

  async function findIssuesByLinkage(
    repositoryId: RepositoryId,
    expectedLinkage: string,
  ): Promise<readonly Issue[]> {
    const locator = await locate(repositoryId);
    const path = locatorPath(locator);
    const values = await paginatedRest(
      options.readTransport,
      `${apiOrigin}/repos/${path}/issues?state=all&per_page=${PAGE_SIZE}`,
      "list issues",
      apiOrigin,
      path,
    );
    return values
      .filter((value) => object(value, "issue list item").pull_request === undefined)
      .map((value) => issueFromRest(repositoryId, value))
      .filter((issue) => issue.linkageDigest === expectedLinkage);
  }

  async function adoptIssue(
    input: Static<typeof CreateOrAdoptIssueInputV1>,
    expectedLinkage: string,
  ): Promise<Issue | null> {
    const matches = await findIssuesByLinkage(input.repositoryId, expectedLinkage);
    if (matches.length > 1) {
      throw new GitHubForgeError(
        "conflict",
        "multiple GitHub issues carry the same linkage marker",
      );
    }
    const match = matches[0];
    if (match === undefined) return null;
    if (!issueMatches(match, input, expectedLinkage)) {
      throw new GitHubForgeError(
        "conflict",
        "linked GitHub issue does not match requested content",
      );
    }
    return match;
  }

  async function createOrAdoptIssue(
    input: Static<typeof CreateOrAdoptIssueInputV1>,
  ): Promise<IssueMutation> {
    const expectedLinkage = linkageDigest("issue", input.idempotencyKey);
    const existing = await adoptIssue(input, expectedLinkage);
    if (existing !== null) {
      return { schemaVersion: 1, disposition: "adopted", issue: existing };
    }
    const locator = await locate(input.repositoryId);
    const path = locatorPath(locator);
    try {
      const { value } = await rest(
        options.writeTransport,
        {
          method: "POST",
          url: `${apiOrigin}/repos/${path}/issues`,
          body: JSON.stringify({
            title: input.title,
            body: markerBody("issue", input.body, expectedLinkage),
            labels: input.labels ?? [],
          }),
        },
        "create issue",
      );
      const created = issueFromRest(input.repositoryId, value);
      const issue = await getIssue({
        schemaVersion: 1,
        repositoryId: input.repositoryId,
        number: created.number,
      });
      return { schemaVersion: 1, disposition: "created", issue };
    } catch (error) {
      const classified = forgeError(error, "create issue");
      if (classified.kind !== "transport") throw classified;
      const recovered = await adoptIssue(input, expectedLinkage);
      if (recovered !== null) {
        return { schemaVersion: 1, disposition: "adopted", issue: recovered };
      }
      throw classified;
    }
  }

  async function updateIssue(input: Static<typeof UpdateIssueInputV1>): Promise<IssueMutation> {
    const current = await getIssue({
      schemaVersion: 1,
      repositoryId: input.repositoryId,
      number: input.number,
    });
    const desiredMatches =
      (input.patch.title === undefined || current.title === input.patch.title) &&
      (input.patch.body === undefined || current.body === input.patch.body.trimEnd()) &&
      (input.patch.state === undefined || current.state === input.patch.state) &&
      (input.patch.labels === undefined || equalLabels(current.labels, input.patch.labels));
    if (desiredMatches) {
      return { schemaVersion: 1, disposition: "unchanged", issue: current };
    }
    if (current.observedVersion !== input.expectedObservedVersion) {
      throw new GitHubForgeError("conflict", "issue observed version changed");
    }
    const locator = await locate(input.repositoryId);
    const path = locatorPath(locator);
    const patch = {
      ...input.patch,
      ...(input.patch.body === undefined
        ? {}
        : {
            body:
              current.linkageDigest === undefined
                ? input.patch.body
                : markerBody("issue", input.patch.body, current.linkageDigest),
          }),
    };
    await rest(
      options.writeTransport,
      {
        method: "PATCH",
        url: `${apiOrigin}/repos/${path}/issues/${input.number}`,
        body: JSON.stringify(patch),
      },
      "update issue",
    );
    const updated = await getIssue({
      schemaVersion: 1,
      repositoryId: input.repositoryId,
      number: input.number,
    });
    const verified =
      (input.patch.title === undefined || updated.title === input.patch.title) &&
      (input.patch.body === undefined || updated.body === input.patch.body.trimEnd()) &&
      (input.patch.state === undefined || updated.state === input.patch.state) &&
      (input.patch.labels === undefined || equalLabels(updated.labels, input.patch.labels));
    if (!verified) {
      throw new GitHubForgeError("conflict", "issue changed concurrently during update");
    }
    return { schemaVersion: 1, disposition: "updated", issue: updated };
  }

  async function repositoryNodeId(locator: GitHubRepositoryLocator): Promise<string> {
    const data = await graphQl(
      options.readTransport,
      apiOrigin,
      "ResolveRepository",
      `query ResolveRepository($owner: String!, $repository: String!) {
        repository(owner: $owner, name: $repository) { id }
      }`,
      { owner: locator.owner, repository: locator.repository },
      "resolve repository",
    );
    if (data.repository === null) {
      throw new GitHubForgeError("not_found", "GitHub repository was not found");
    }
    return string(object(data.repository, "repository").id, "repository.id");
  }

  async function getRef(input: Static<typeof GetRefInputV1>): Promise<Ref | null> {
    const locator = await locate(input.repositoryId);
    const data = await graphQl(
      options.readTransport,
      apiOrigin,
      "ReadRef",
      `query ReadRef($owner: String!, $repository: String!, $qualifiedRef: String!) {
        repository(owner: $owner, name: $repository) {
          ref(qualifiedName: $qualifiedRef) { id name prefix target { oid } }
        }
      }`,
      { owner: locator.owner, repository: locator.repository, qualifiedRef: input.qualifiedRef },
      "read ref",
    );
    if (data.repository === null) {
      throw new GitHubForgeError("not_found", "GitHub repository was not found");
    }
    const value = object(data.repository, "repository").ref;
    if (value === null) return null;
    const item = object(value, "ref");
    const headSha = string(object(item.target, "ref target").oid, "ref.target.oid");
    const qualifiedRef = `${string(item.prefix, "ref.prefix")}${string(item.name, "ref.name")}`;
    const normalized = {
      forgeRefId: string(item.id, "ref.id"),
      repositoryId: input.repositoryId,
      qualifiedRef,
      url: `${webOrigin}/${locatorPath(locator)}/tree/${encodeURIComponent(string(item.name, "ref.name"))}`,
      headSha,
    };
    return {
      schemaVersion: 1,
      ...normalized,
      observedVersion: observedVersion(normalized),
    } as Ref;
  }

  function qualifiedBranch(branchName: string): string {
    if (branchName.startsWith("refs/") || branchName.trim().length === 0) {
      throw new GitHubForgeError("conflict", "branch name must be unqualified");
    }
    return `refs/heads/${branchName}`;
  }

  async function mutateRef(
    repositoryId: RepositoryId,
    branchName: string,
    beforeOid: string,
    afterOid: string,
  ): Promise<void> {
    const locator = await locate(repositoryId);
    const repositoryIdOnGitHub = await repositoryNodeId(locator);
    await graphQl(
      options.writeTransport,
      apiOrigin,
      "UpdateRefs",
      `mutation UpdateRefs($input: UpdateRefsInput!) {
        updateRefs(input: $input) { clientMutationId }
      }`,
      {
        input: {
          repositoryId: repositoryIdOnGitHub,
          refUpdates: [{ name: qualifiedBranch(branchName), beforeOid, afterOid, force: false }],
        },
      },
      "update refs",
    );
  }

  async function createOrAdoptBranch(
    input: Static<typeof CreateOrAdoptBranchInputV1>,
  ): Promise<RefMutation> {
    const readInput = {
      schemaVersion: 1 as const,
      repositoryId: input.repositoryId,
      qualifiedRef: qualifiedBranch(input.branchName),
    };
    const current = await getRef(readInput);
    if (current !== null) {
      if (current.headSha !== input.targetSha) {
        throw new GitHubForgeError("stale_ref", "branch already exists at an unexpected SHA");
      }
      return { schemaVersion: 1, disposition: "adopted", ref: current };
    }
    try {
      await mutateRef(input.repositoryId, input.branchName, ZERO_OID, input.targetSha);
    } catch (error) {
      const classified = forgeError(error, "create branch");
      if (classified.kind !== "transport") throw classified;
      const recovered = await getRef(readInput);
      if (recovered?.headSha === input.targetSha) {
        return { schemaVersion: 1, disposition: "adopted", ref: recovered };
      }
      throw classified;
    }
    const created = await getRef(readInput);
    if (created === null || created.headSha !== input.targetSha) {
      throw new GitHubForgeError("stale_ref", "created branch was not observed at the target SHA");
    }
    return { schemaVersion: 1, disposition: "created", ref: created };
  }

  async function updateBranch(input: Static<typeof UpdateBranchInputV1>): Promise<RefMutation> {
    const readInput = {
      schemaVersion: 1 as const,
      repositoryId: input.repositoryId,
      qualifiedRef: qualifiedBranch(input.branchName),
    };
    const current = await getRef(readInput);
    if (current === null) throw new GitHubForgeError("stale_ref", "branch no longer exists");
    if (current.headSha === input.targetHeadSha) {
      return { schemaVersion: 1, disposition: "unchanged", ref: current };
    }
    if (current.headSha !== input.expectedHeadSha) {
      throw new GitHubForgeError("stale_ref", "branch head changed from its expected SHA");
    }
    try {
      await mutateRef(
        input.repositoryId,
        input.branchName,
        input.expectedHeadSha,
        input.targetHeadSha,
      );
    } catch (error) {
      const classified = forgeError(error, "update branch");
      if (classified.kind !== "transport") throw classified;
      const recovered = await getRef(readInput);
      if (recovered?.headSha === input.targetHeadSha) {
        return { schemaVersion: 1, disposition: "updated", ref: recovered };
      }
      throw classified;
    }
    const updated = await getRef(readInput);
    if (updated === null || updated.headSha !== input.targetHeadSha) {
      throw new GitHubForgeError("stale_ref", "updated branch was not observed at the target SHA");
    }
    return { schemaVersion: 1, disposition: "updated", ref: updated };
  }

  async function readPullRequest(id: PullRequestId): Promise<PullRequestObservation> {
    const parsed = parsePullRequestId(id);
    const data = await graphQl(
      options.readTransport,
      apiOrigin,
      "ReadPullRequest",
      `query ReadPullRequest($id: ID!) {
        node(id: $id) {
          __typename
          ... on PullRequest {
            id number url state isDraft title body headRefName baseRefName headRefOid baseRefOid
            autoMergeRequest { enabledAt }
          }
        }
      }`,
      { id: parsed.nodeId },
      "read pull request",
    );
    return pullRequestFromGraphQl(parsed.repositoryId, prNode(data));
  }

  async function getPullRequest(id: PullRequestId): Promise<PullRequest> {
    return (await readPullRequest(id)).resource;
  }

  async function listPullRequests(
    repositoryId: RepositoryId,
    sourceBranch: string,
    targetBranch: string,
  ): Promise<readonly PullRequestObservation[]> {
    const locator = await locate(repositoryId);
    const path = locatorPath(locator);
    const query = new URLSearchParams({
      state: "all",
      head: `${locator.owner}:${sourceBranch}`,
      base: targetBranch,
      per_page: String(PAGE_SIZE),
    });
    const values = await paginatedRest(
      options.readTransport,
      `${apiOrigin}/repos/${path}/pulls?${query.toString()}`,
      "list pull requests",
      apiOrigin,
      path,
    );
    return values.map((value) => pullRequestFromRest(repositoryId, value));
  }

  async function adoptPullRequest(
    input: Static<typeof CreatePullRequestInputV2>,
    expectedLinkage: string,
  ): Promise<PullRequest | null> {
    const candidates = (
      await listPullRequests(input.repositoryId, input.sourceBranch, input.targetBranch)
    ).filter((item) => item.resource.linkageDigest === expectedLinkage);
    if (candidates.length > 1) {
      throw new GitHubForgeError(
        "conflict",
        "multiple GitHub pull requests carry the same linkage marker",
      );
    }
    const candidate = candidates[0];
    if (candidate === undefined) return null;
    if (!pullRequestMatches(candidate, input, expectedLinkage)) {
      throw new GitHubForgeError(
        "conflict",
        "linked GitHub pull request does not match requested content",
      );
    }
    return candidate.resource;
  }

  async function createOrAdoptPullRequest(
    input: Static<typeof CreatePullRequestInputV2>,
  ): Promise<PullRequestMutation> {
    const source = await getRef({
      schemaVersion: 1,
      repositoryId: input.repositoryId,
      qualifiedRef: qualifiedBranch(input.sourceBranch),
    });
    if (source === null || source.headSha !== input.expectedHeadSha) {
      throw new GitHubForgeError("stale_ref", "pull request head changed from its expected SHA");
    }
    const expectedLinkage = linkageDigest("pull-request", input.idempotencyKey);
    const existing = await adoptPullRequest(input, expectedLinkage);
    if (existing !== null) {
      return { schemaVersion: 1, disposition: "adopted", pullRequest: existing };
    }
    const locator = await locate(input.repositoryId);
    const path = locatorPath(locator);
    try {
      const { value } = await rest(
        options.writeTransport,
        {
          method: "POST",
          url: `${apiOrigin}/repos/${path}/pulls`,
          body: JSON.stringify({
            head: input.sourceBranch,
            base: input.targetBranch,
            title: input.title,
            body: markerBody("pull-request", input.body, expectedLinkage),
            draft: input.draft ?? true,
          }),
        },
        "create pull request",
      );
      const created = pullRequestFromRest(input.repositoryId, value).resource;
      const pullRequest = await getPullRequest(created.pullRequestId);
      return { schemaVersion: 1, disposition: "created", pullRequest };
    } catch (error) {
      const classified = forgeError(error, "create pull request");
      if (classified.kind !== "transport") throw classified;
      const recovered = await adoptPullRequest(input, expectedLinkage);
      if (recovered !== null) {
        return { schemaVersion: 1, disposition: "adopted", pullRequest: recovered };
      }
      throw classified;
    }
  }

  async function mutatePullRequest(
    operationName: string,
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await graphQl(
      options.writeTransport,
      apiOrigin,
      operationName,
      query,
      variables,
      "update pull request",
    );
  }

  async function updatePullRequest(
    input: Static<typeof UpdatePullRequestInputV1>,
  ): Promise<PullRequestMutation> {
    if (input.draft === undefined && input.autoMergeEnabled === undefined) {
      throw new GitHubForgeError("conflict", "pull request update is empty");
    }
    let current = await getPullRequest(input.pullRequestId);
    if (current.state !== "open") {
      throw new GitHubForgeError("conflict", "pull request is not open");
    }
    if (current.headSha !== input.expectedHeadSha) {
      throw new GitHubForgeError("stale_ref", "pull request head changed from its expected SHA");
    }
    const draftMatches = input.draft === undefined || current.draft === input.draft;
    const autoMergeMatches =
      input.autoMergeEnabled === undefined || current.autoMergeEnabled === input.autoMergeEnabled;
    if (draftMatches && autoMergeMatches) {
      return { schemaVersion: 1, disposition: "unchanged", pullRequest: current };
    }
    const partialRecovery =
      (input.draft !== undefined && draftMatches) ||
      (input.autoMergeEnabled !== undefined && autoMergeMatches);
    if (current.observedVersion !== input.expectedObservedVersion && !partialRecovery) {
      throw new GitHubForgeError("conflict", "pull request observed version changed");
    }
    const parsed = parsePullRequestId(input.pullRequestId);
    if (input.draft !== undefined && current.draft !== input.draft) {
      if (input.draft) {
        await mutatePullRequest(
          "ConvertPullRequestToDraft",
          `mutation ConvertPullRequestToDraft($id: ID!) {
            convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId }
          }`,
          { id: parsed.nodeId },
        );
      } else {
        await mutatePullRequest(
          "MarkPullRequestReadyForReview",
          `mutation MarkPullRequestReadyForReview($id: ID!) {
            markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId }
          }`,
          { id: parsed.nodeId },
        );
      }
      current = await getPullRequest(input.pullRequestId);
    }
    if (
      input.autoMergeEnabled !== undefined &&
      current.autoMergeEnabled !== input.autoMergeEnabled
    ) {
      if (input.autoMergeEnabled) {
        if (current.draft) {
          throw new GitHubForgeError("conflict", "cannot enable auto-merge on a draft PR");
        }
        await mutatePullRequest(
          "EnablePullRequestAutoMerge",
          `mutation EnablePullRequestAutoMerge($id: ID!, $head: GitObjectID!) {
            enablePullRequestAutoMerge(input: {
              pullRequestId: $id, expectedHeadOid: $head, mergeMethod: SQUASH
            }) { clientMutationId }
          }`,
          { id: parsed.nodeId, head: input.expectedHeadSha },
        );
      } else {
        await mutatePullRequest(
          "DisablePullRequestAutoMerge",
          `mutation DisablePullRequestAutoMerge($id: ID!) {
            disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId }
          }`,
          { id: parsed.nodeId },
        );
      }
    }
    const updated = await getPullRequest(input.pullRequestId);
    if (
      (input.draft !== undefined && updated.draft !== input.draft) ||
      (input.autoMergeEnabled !== undefined && updated.autoMergeEnabled !== input.autoMergeEnabled)
    ) {
      throw new GitHubForgeError("conflict", "pull request state was not observed after update");
    }
    return { schemaVersion: 1, disposition: "updated", pullRequest: updated };
  }

  function checkState(value: Record<string, unknown>): Check["state"] {
    if (value.__typename === "StatusContext") {
      const state = string(value.state, "status context.state");
      if (state === "SUCCESS") return "succeeded";
      if (state === "FAILURE" || state === "ERROR") return "failed";
      return "in_progress";
    }
    const status = string(value.status, "check run.status");
    if (status === "QUEUED" || status === "WAITING" || status === "PENDING") return "queued";
    if (status !== "COMPLETED") return "in_progress";
    const conclusion = nullableString(value.conclusion, "check run.conclusion");
    if (conclusion === "SUCCESS") return "succeeded";
    if (conclusion === "SKIPPED" || conclusion === "NEUTRAL") return "skipped";
    return "failed";
  }

  function normalizedCheck(value: unknown): {
    readonly check: Check;
    readonly failure?: CheckFailure;
  } {
    const item = object(value, "check");
    const isContext = item.__typename === "StatusContext";
    const name = string(isContext ? item.context : item.name, "check.name");
    const state = checkState(item);
    const details = isContext ? item.targetUrl : item.detailsUrl;
    const check: Check = {
      schemaVersion: 1,
      name,
      state,
      required: boolean(item.isRequired, "check.isRequired"),
      ...(details === null ? {} : { detailsUrl: string(details, "check.detailsUrl") }),
    };
    if (state !== "failed") return { check };
    const output = isContext || item.output === null ? null : object(item.output, "check output");
    const summary =
      output === null || typeof output.summary !== "string" || output.summary.trim().length === 0
        ? `${name} failed.`
        : output.summary.slice(0, 8_192);
    const excerpt =
      output === null || typeof output.text !== "string" || output.text.length === 0
        ? undefined
        : output.text.slice(0, 8_192);
    return {
      check,
      failure: {
        schemaVersion: 1,
        name,
        summary,
        ...(excerpt === undefined ? {} : { logExcerpt: excerpt }),
      },
    };
  }

  async function statusObservation(id: PullRequestId): Promise<StatusObservation> {
    const parsed = parsePullRequestId(id);
    const checks: Check[] = [];
    const failures: CheckFailure[] = [];
    let cursor: string | null = null;
    let mergeability: PullRequestStatus["mergeability"] = "unknown";
    let mergeState: PullRequestStatus["mergeState"] = "unknown";
    for (let page = 1; ; page += 1) {
      if (page > MAX_PAGES) {
        throw new GitHubForgeError(
          "malformed_response",
          `GitHub pull request checks exceeded ${MAX_PAGES} pages`,
        );
      }
      const data = await graphQl(
        options.readTransport,
        apiOrigin,
        "ObservePullRequestStatus",
        `query ObservePullRequestStatus($id: ID!, $cursor: String) {
          node(id: $id) {
            __typename
            ... on PullRequest {
              mergeable mergeStateStatus
              statusCheckRollup {
                contexts(first: 100, after: $cursor) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name status conclusion detailsUrl isRequired(pullRequestId: $id)
                      output { summary text }
                    }
                    ... on StatusContext {
                      context state targetUrl isRequired(pullRequestId: $id)
                    }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }
        }`,
        { id: parsed.nodeId, cursor },
        "observe pull request status",
      );
      const node = prNode(data);
      const rawMergeability = string(node.mergeable, "pull request.mergeable").toLowerCase();
      if (
        rawMergeability !== "unknown" &&
        rawMergeability !== "mergeable" &&
        rawMergeability !== "conflicting"
      ) {
        throw new GitHubForgeError("malformed_response", "GitHub mergeability was invalid");
      }
      mergeability = rawMergeability;
      const rawMergeState = string(node.mergeStateStatus, "pull request.mergeStateStatus")
        .toLowerCase()
        .replace("has_hooks", "has_hooks") as PullRequestStatus["mergeState"];
      if (
        ![
          "unknown",
          "behind",
          "blocked",
          "clean",
          "dirty",
          "draft",
          "has_hooks",
          "unstable",
        ].includes(rawMergeState)
      ) {
        throw new GitHubForgeError("malformed_response", "GitHub merge state was invalid");
      }
      mergeState = rawMergeState;
      if (node.statusCheckRollup === null) break;
      const contexts = object(
        object(node.statusCheckRollup, "status check rollup").contexts,
        "status check contexts",
      );
      if (!Array.isArray(contexts.nodes)) {
        throw new GitHubForgeError("malformed_response", "GitHub status checks were not an array");
      }
      for (const value of contexts.nodes) {
        const normalized = normalizedCheck(value);
        checks.push(normalized.check);
        if (normalized.failure !== undefined) failures.push(normalized.failure);
      }
      const pageInfo = object(contexts.pageInfo, "status check page info");
      if (!boolean(pageInfo.hasNextPage, "pageInfo.hasNextPage")) break;
      cursor = nullableString(pageInfo.endCursor, "pageInfo.endCursor");
      if (cursor === null) {
        throw new GitHubForgeError("malformed_response", "GitHub pagination omitted its cursor");
      }
    }
    const normalized = { pullRequestId: id, mergeability, mergeState, checks };
    const status: PullRequestStatus = {
      schemaVersion: 1,
      ...normalized,
      totalCount: checks.length,
      requiredCount: checks.filter((check) => check.required).length,
      succeededCount: checks.filter((check) => check.state === "succeeded").length,
      failedCount: checks.filter((check) => check.state === "failed").length,
      pendingCount: checks.filter(
        (check) => check.state === "queued" || check.state === "in_progress",
      ).length,
      observedVersion: observedVersion(normalized),
    };
    return { status, failures };
  }

  const backend: ForgeBackendV3 = {
    createOrAdoptIssue,
    getIssue,
    updateIssue,
    getRef,
    createOrAdoptBranch,
    updateBranch,
    createOrAdoptPullRequest,
    getPullRequest,
    updatePullRequest,
    async observePullRequestStatus(id) {
      return (await statusObservation(id)).status;
    },
    async createPullRequest(input: Static<typeof CreatePullRequestInputV1>) {
      const source = await getRef({
        schemaVersion: 1,
        repositoryId: input.repositoryId,
        qualifiedRef: qualifiedBranch(input.sourceBranch),
      });
      if (source === null) throw new GitHubForgeError("stale_ref", "source branch does not exist");
      const { schemaVersion: _schemaVersion, ...legacyInput } = input;
      const result = await createOrAdoptPullRequest({
        schemaVersion: 2,
        ...legacyInput,
        expectedHeadSha: source.headSha,
        idempotencyKey: digest({
          repositoryId: input.repositoryId,
          sourceBranch: input.sourceBranch,
          targetBranch: input.targetBranch,
        }),
      });
      return pullRequestV1(result.pullRequest);
    },
    async findPullRequests(repositoryId, sourceBranch, targetBranch) {
      return (await listPullRequests(repositoryId, sourceBranch, targetBranch)).map((item) =>
        pullRequestV1(item.resource),
      );
    },
    async markReady(id) {
      const current = await getPullRequest(id);
      await updatePullRequest({
        schemaVersion: 1,
        pullRequestId: id,
        expectedObservedVersion: current.observedVersion,
        expectedHeadSha: current.headSha,
        draft: false,
      });
    },
    async getChecks(id) {
      return (await statusObservation(id)).status.checks;
    },
    async getFailedCheckLogs(id) {
      return [...(await statusObservation(id)).failures];
    },
    async enableAutoMerge(id) {
      const current = await getPullRequest(id);
      await updatePullRequest({
        schemaVersion: 1,
        pullRequestId: id,
        expectedObservedVersion: current.observedVersion,
        expectedHeadSha: current.headSha,
        autoMergeEnabled: true,
      });
    },
  };

  return backend;
}
