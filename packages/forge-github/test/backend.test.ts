import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryId } from "@heniek/contracts";
import type {
  GitHubTransport,
  GitHubTransportRequest,
  GitHubTransportResponse,
} from "@heniek/github-client";
import { afterEach, describe, expect, it } from "vitest";
import { createGitHubForgeBackend, GitHubForgeError, isGitHubForgeError } from "../src/index.js";
import { RecordedGitHubService } from "./recorded-service.js";

const REPOSITORY_ID = "repository-1" as RepositoryId;
const temporaryDirectories: string[] = [];

function response(
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): GitHubTransportResponse {
  return { status, headers, body: new TextEncoder().encode(JSON.stringify(value)) };
}

function backend(readTransport: GitHubTransport, writeTransport: GitHubTransport = readTransport) {
  return createGitHubForgeBackend({
    readTransport,
    writeTransport,
    apiOrigin: "https://api.github.test",
    webOrigin: "https://github.test",
    resolveRepository: () => ({ owner: "acme", repository: "repo" }),
  });
}

function issueInput() {
  return {
    schemaVersion: 1 as const,
    repositoryId: REPOSITORY_ID,
    title: "Recoverable issue",
    body: "Created across an acknowledgement boundary.",
    labels: ["q047"],
    idempotencyKey: "recoverable-issue",
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true });
});

describe("GitHub forge adapter safety", () => {
  it("recovers issue and pull-request creation after an accepted write disconnects", async () => {
    const remote = new RecordedGitHubService();
    let disconnectIssue = true;
    let disconnectPullRequest = true;
    const writeTransport: GitHubTransport = {
      async request(request) {
        const result = await remote.transport.request(request);
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path.endsWith("/issues") && disconnectIssue) {
          disconnectIssue = false;
          throw new Error("disconnect after accepted issue");
        }
        if (request.method === "POST" && path.endsWith("/pulls") && disconnectPullRequest) {
          disconnectPullRequest = false;
          throw new Error("disconnect after accepted pull request");
        }
        return result;
      },
    };
    const subject = backend(remote.transport, writeTransport);
    const issue = await subject.createOrAdoptIssue(issueInput());
    expect(issue.disposition).toBe("adopted");
    expect(remote.issues.size).toBe(1);

    const pullRequest = await subject.createOrAdoptPullRequest({
      schemaVersion: 2,
      repositoryId: REPOSITORY_ID,
      sourceBranch: "feature",
      targetBranch: "main",
      title: "Recoverable pull request",
      body: "Closes #63",
      expectedHeadSha: "head-sha",
      idempotencyKey: "recoverable-pull-request",
    });
    expect(pullRequest.disposition).toBe("adopted");
    expect(remote.pullRequests.size).toBe(1);
  });

  it("rejects duplicate linkage markers instead of adopting ambiguously", async () => {
    const remote = new RecordedGitHubService();
    const subject = backend(remote.transport);
    await subject.createOrAdoptIssue(issueInput());
    const existing = [...remote.issues.values()][0];
    expect(existing).toBeDefined();
    await remote.transport.request({
      method: "POST",
      url: "https://api.github.test/repos/acme/repo/issues",
      body: JSON.stringify({
        title: existing?.title,
        body: existing?.body,
        labels: existing?.labels,
      }),
    });
    await expect(subject.createOrAdoptIssue(issueInput())).rejects.toMatchObject({
      kind: "conflict",
    });
  });

  it("classifies least-privilege permission denial without retaining response content", async () => {
    const secret = "never-retain-this-response";
    const denied: GitHubTransport = {
      async request() {
        return response(403, { message: secret }, { "x-github-request-id": "REDACTED" });
      },
    };
    let caught: unknown;
    try {
      await backend(denied).createOrAdoptIssue(issueInput());
    } catch (error) {
      caught = error;
    }
    expect(isGitHubForgeError(caught)).toBe(true);
    expect(caught).toMatchObject({ kind: "permission", requestId: "REDACTED", retryable: false });
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect((caught as Error).message).not.toContain(secret);
  });

  it("rejects pagination that leaves the configured GitHub API origin", async () => {
    let requests = 0;
    const paginationAttack: GitHubTransport = {
      async request() {
        requests += 1;
        return response(200, [], { link: '<https://evil.invalid/steal>; rel="next"' });
      },
    };
    await expect(backend(paginationAttack).createOrAdoptIssue(issueInput())).rejects.toMatchObject({
      kind: "malformed_response",
    });
    expect(requests).toBe(1);
  });
});

interface GitFixture {
  readonly directory: string;
  readonly first: string;
  readonly second: string;
  readonly divergent: string;
}

function gitFixture(): GitFixture {
  const directory = mkdtempSync(join(tmpdir(), "heniek-q047-"));
  temporaryDirectories.push(directory);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Heniek Conformance");
  git("config", "user.email", "heniek@example.invalid");
  writeFileSync(join(directory, "fixture.txt"), "first\n");
  git("add", "fixture.txt");
  git("commit", "-m", "first");
  const first = git("rev-parse", "HEAD");
  writeFileSync(join(directory, "fixture.txt"), "second\n");
  git("commit", "-am", "second");
  const second = git("rev-parse", "HEAD");
  git("checkout", "--detach", first);
  writeFileSync(join(directory, "fixture.txt"), "divergent\n");
  git("commit", "-am", "divergent");
  const divergent = git("rev-parse", "HEAD");
  return { directory, first, second, divergent };
}

class GitBackedRefTransport implements GitHubTransport {
  readonly updates: Record<string, unknown>[] = [];
  private head: string | null = null;

  constructor(private readonly fixture: GitFixture) {}

  async request(request: GitHubTransportRequest): Promise<GitHubTransportResponse> {
    const envelope = JSON.parse(request.body ?? "{}") as {
      readonly operationName?: string;
      readonly variables?: Record<string, unknown>;
    };
    if (envelope.operationName === "ReadRef") {
      return response(200, {
        data: {
          repository: {
            ref:
              this.head === null
                ? null
                : {
                    id: "REF_q047",
                    name: "q047",
                    prefix: "refs/heads/",
                    target: { oid: this.head },
                  },
          },
        },
      });
    }
    if (envelope.operationName === "ResolveRepository") {
      return response(200, { data: { repository: { id: "REPOSITORY_fixture" } } });
    }
    if (envelope.operationName === "UpdateRefs") {
      const input = envelope.variables?.input as {
        readonly refUpdates: readonly Record<string, unknown>[];
      };
      const update = input.refUpdates[0] ?? {};
      this.updates.push(update);
      const before = String(update.beforeOid);
      const after = String(update.afterOid);
      const zero = "0000000000000000000000000000000000000000";
      const expectedMatches = before === zero ? this.head === null : this.head === before;
      let fastForward = true;
      if (this.head !== null) {
        try {
          execFileSync("git", ["merge-base", "--is-ancestor", this.head, after], {
            cwd: this.fixture.directory,
          });
        } catch {
          fastForward = false;
        }
      }
      if (!expectedMatches || !fastForward || update.force !== false) {
        return response(200, {
          errors: [{ extensions: { type: "UNPROCESSABLE" } }],
        });
      }
      this.head = after;
      return response(200, { data: { updateRefs: { clientMutationId: null } } });
    }
    return response(404, { message: "unexpected recorded operation" });
  }
}

describe("GitHub GraphQL ref compare-and-swap", () => {
  it("uses real commit ancestry, exact beforeOid values, and force:false", async () => {
    const fixture = gitFixture();
    const transport = new GitBackedRefTransport(fixture);
    const subject = backend(transport);
    const created = await subject.createOrAdoptBranch({
      schemaVersion: 1,
      repositoryId: REPOSITORY_ID,
      branchName: "q047",
      targetSha: fixture.first,
    });
    expect(created.disposition).toBe("created");
    const updated = await subject.updateBranch({
      schemaVersion: 1,
      repositoryId: REPOSITORY_ID,
      branchName: "q047",
      expectedHeadSha: fixture.first,
      targetHeadSha: fixture.second,
    });
    expect(updated.ref.headSha).toBe(fixture.second);
    await expect(
      subject.updateBranch({
        schemaVersion: 1,
        repositoryId: REPOSITORY_ID,
        branchName: "q047",
        expectedHeadSha: fixture.second,
        targetHeadSha: fixture.divergent,
      }),
    ).rejects.toBeInstanceOf(GitHubForgeError);
    await expect(
      subject.updateBranch({
        schemaVersion: 1,
        repositoryId: REPOSITORY_ID,
        branchName: "q047",
        expectedHeadSha: fixture.second,
        targetHeadSha: fixture.divergent,
      }),
    ).rejects.toMatchObject({ kind: "stale_ref" });
    expect(transport.updates).toEqual([
      expect.objectContaining({ beforeOid: "0".repeat(40), afterOid: fixture.first, force: false }),
      expect.objectContaining({ beforeOid: fixture.first, afterOid: fixture.second, force: false }),
      expect.objectContaining({
        beforeOid: fixture.second,
        afterOid: fixture.divergent,
        force: false,
      }),
      expect.objectContaining({
        beforeOid: fixture.second,
        afterOid: fixture.divergent,
        force: false,
      }),
    ]);
    const observed = await subject.getRef({
      schemaVersion: 1,
      repositoryId: REPOSITORY_ID,
      qualifiedRef: "refs/heads/q047",
    });
    expect(observed?.headSha).toBe(fixture.second);
  });
});
