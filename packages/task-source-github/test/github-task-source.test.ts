import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskSourceArrangement, TaskSourceHarness } from "@heniek/conformance";
import { describeTaskSourceConformance } from "@heniek/conformance/vitest";
import type { SourceWorkItemId, TaskGraphRevisionRecord } from "@heniek/contracts";
import { SensitiveValue } from "@heniek/secrets";
import {
  createArtifactStore,
  createTaskSourceStateStore,
  openStateDatabase,
  runMigrations,
} from "@heniek/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyGitHubResponse,
  createGitHubTaskSource,
  createGitHubTransport,
  GitHubApiError,
  type GitHubTransport,
  type GitHubTransportRequest,
  type GitHubTransportResponse,
} from "../src/index.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;

interface FakeOptions {
  readonly rateLimited?: boolean;
  readonly unsafeAttachmentRedirect?: boolean;
  readonly oversizedAttachment?: boolean;
  readonly failAfterPostOnce?: boolean;
  readonly issueBody?: string;
  readonly issue304AfterFirst?: boolean;
}

function response(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): GitHubTransportResponse {
  return { status, body: body instanceof Uint8Array ? body : encode(body), headers };
}

function fakeGitHub(options: FakeOptions = {}) {
  const posted: string[] = [];
  let commentRevision = 1;
  let failAfterPost = options.failAfterPostOnce ?? false;
  let issueRequests = 0;
  const transport: GitHubTransport = {
    async request(request: GitHubTransportRequest) {
      if (request.method === "POST") {
        const body = JSON.parse(request.body ?? "{}") as { body?: string };
        posted.push(body.body ?? "");
        commentRevision += 1;
        if (failAfterPost) {
          failAfterPost = false;
          throw new Error("simulated disconnect after GitHub accepted the comment");
        }
        return response(
          201,
          {
            html_url: `https://github.com/acme/widget/issues/61#issuecomment-${posted.length + 2}`,
          },
          { "x-github-request-id": "request-redacted" },
        );
      }
      if (request.url.includes("user-attachments/assets/")) {
        if (options.unsafeAttachmentRedirect)
          return response(302, "", { location: "https://attacker.example/credential-target" });
        if (options.oversizedAttachment)
          return response(200, new Uint8Array(16 * 1024 * 1024 + 1), {
            "content-type": "application/octet-stream",
          });
        return response(200, encode("attachment bytes"), {
          "content-type": "text/plain",
          etag: '"attachment-v1"',
        });
      }
      if (request.url.endsWith("/issues/61")) {
        issueRequests += 1;
        if (
          options.issue304AfterFirst &&
          issueRequests > 1 &&
          request.headers?.["if-none-match"] === '"issue-v1"'
        )
          return response(304, "", { etag: '"issue-v1"' });
        if (options.rateLimited)
          return response(403, { message: "rate limited" }, { "x-ratelimit-remaining": "0" });
        const issue = structuredClone(fixture("issue.json")) as Record<string, unknown>;
        if (options.issueBody !== undefined) issue.body = options.issueBody;
        return response(200, issue, { etag: '"issue-v1"' });
      }
      if (request.url.includes("/comments?per_page=100") && !request.url.includes("page=2")) {
        return response(200, fixture("comments-page-1.json"), {
          etag: `"comments-${commentRevision}-page-1"`,
          link: '<https://api.github.com/repos/acme/widget/issues/61/comments?per_page=100&page=2>; rel="next"',
        });
      }
      if (request.url.includes("/comments?") && request.url.includes("page=2")) {
        const comments = structuredClone(fixture("comments-page-2.json")) as unknown[];
        posted.forEach((body, index) => {
          comments.push({
            node_id: `IC_kwDOHeniek${index + 1}`,
            html_url: `https://github.com/acme/widget/issues/61#issuecomment-${index + 3}`,
            body,
            user: { login: "heniek" },
            created_at: "2026-08-12T11:00:00Z",
            updated_at: "2026-08-12T11:00:00Z",
          });
        });
        return response(200, comments, { etag: `"comments-${commentRevision}-page-2"` });
      }
      if (request.url.includes("/sub_issues"))
        return response(200, fixture("sub-issues.json"), { etag: '"children-v1"' });
      if (request.url.endsWith("/parent"))
        return response(200, fixture("parent.json"), { etag: '"parent-v1"' });
      throw new Error(`unhandled fake GitHub request: ${request.method} ${request.url}`);
    },
  };
  return { transport, posted };
}

let directory: string | undefined;
let close: (() => void) | undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  close?.();
  close = undefined;
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function subject(github = fakeGitHub()) {
  directory = mkdtempSync(join(tmpdir(), "heniek-github-task-source-"));
  let sequence = 0;
  const ids = { next: (prefix: string) => `${prefix}-${++sequence}` };
  const clock = { nowIso: () => `2026-08-12T12:00:${String(sequence).padStart(2, "0")}Z` };
  const db = openStateDatabase({ path: join(directory, "state.sqlite"), clock, ids });
  close = () => db.close();
  runMigrations(db);
  const artifacts = createArtifactStore({ root: join(directory, "artifacts"), clock, ids });
  const state = createTaskSourceStateStore(db);
  return {
    github,
    clock,
    ids,
    state,
    adapter: createGitHubTaskSource({
      readTransport: github.transport,
      writeTransport: github.transport,
      artifacts,
      clock,
      ids,
      state,
    }),
  };
}

const input = { owner: "acme", repository: "widget", issueNumber: 61 } as const;

function revision(sourceWorkItemId: SourceWorkItemId): TaskGraphRevisionRecord {
  return {
    graphRevision: 2,
    rationale: "Split delivery into independently verifiable tasks.",
    changes: [
      {
        kind: "split",
        rationale: "Separate API and worker delivery.",
      },
    ],
    requirementMappings: [{ sourceWorkItemId }],
  } as TaskGraphRevisionRecord;
}

describe("GitHub TaskSource", () => {
  it("normalizes paginated comments, labels, state, and cross-repository hierarchy", async () => {
    const { adapter } = subject();
    const first = await adapter.source.load(input);
    expect(first.schemaVersion).toBe(2);
    if (first.schemaVersion !== 2) throw new Error("expected TaskContextV2");
    expect(first.snapshot.title).toBe("Synchronize the delivery graph");
    expect(first.snapshot.labels).toEqual(["enhancement", "m6"]);
    expect(first.snapshot.comments).toHaveLength(2);
    expect(first.hierarchy.trackerEdges).toHaveLength(2);
    expect(first.pendingUpdates).toEqual([]);
    expect(await adapter.source.load(input)).toEqual(first);
  });

  it("records later observations as pending without advancing accepted requirements", async () => {
    const github = fakeGitHub();
    const fixture = subject(github);
    const first = await fixture.adapter.source.load(input);
    const comments = github.posted;
    comments.push("A human-authored follow-up comment.");
    const second = await fixture.adapter.source.load(input);
    expect(second.schemaVersion).toBe(2);
    if (second.schemaVersion !== 2) throw new Error("expected TaskContextV2");
    expect(second.activeRevision.ordinal).toBe(first.activeRevision.ordinal);
    expect(second.pendingUpdates).toHaveLength(1);
    expect(second.pendingUpdates[0]?.changedFields).toContain("comments");
  });

  it("reuses the cached issue representation after a conditional 304", async () => {
    const { adapter } = subject(fakeGitHub({ issue304AfterFirst: true }));
    const first = await adapter.source.load(input);
    const second = await adapter.source.load(input);
    expect(second).toEqual(first);
  });

  it("classifies rate limits without retaining response bodies or credentials", async () => {
    const { adapter } = subject(fakeGitHub({ rateLimited: true }));
    await expect(adapter.source.load(input)).rejects.toMatchObject({
      kind: "rate_limit",
      status: 403,
    });
  });

  it("confines authorization to configured API origins and redacts failures", async () => {
    const tokenText = `github_pat_${"a".repeat(24)}`;
    const seen: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init);
        return new Response(JSON.stringify({ message: tokenText }), {
          status: 403,
          headers: { "x-github-request-id": "request-1" },
        });
      }),
    );
    const transport = createGitHubTransport({ token: SensitiveValue.from(tokenText) });
    const apiResponse = await transport.request({
      method: "GET",
      url: "https://api.github.com/repos/acme/widget/issues/61",
    });
    expect(new Headers(seen[0]?.headers).get("authorization")).toBe(`Bearer ${tokenText}`);
    expect(() => classifyGitHubResponse(apiResponse, "issue snapshot")).toThrow(
      "GitHub issue snapshot failed with HTTP 403",
    );
    try {
      classifyGitHubResponse(apiResponse, "issue snapshot");
    } catch (error) {
      expect(String(error)).not.toContain(tokenText);
      expect(JSON.stringify(error)).not.toContain(tokenText);
    }

    await transport.request({
      method: "GET",
      url: "https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
    });
    expect(new Headers(seen[1]?.headers).get("authorization")).toBeNull();
  });

  it("rejects attachment redirects outside the GitHub allowlist", async () => {
    const github = fakeGitHub({
      issueBody:
        "Attachment: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
      unsafeAttachmentRedirect: true,
    });
    const { adapter } = subject(github);
    await expect(adapter.source.load(input)).rejects.toThrow("allowlisted GitHub host");
  });

  it("publishes allowlisted attachments and includes their bytes in component observations", async () => {
    const github = fakeGitHub({
      issueBody:
        "Attachment: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
    });
    const { adapter } = subject(github);
    const context = await adapter.source.load(input);
    expect(context.snapshot.attachments).toHaveLength(1);
    if (context.schemaVersion !== 2) throw new Error("expected TaskContextV2");
    expect(
      context.snapshot.components.some((component) =>
        component.componentId.startsWith("attachment:"),
      ),
    ).toBe(true);
  });

  it("enforces attachment size bounds even when an injected transport ignores its hint", async () => {
    const github = fakeGitHub({
      issueBody:
        "Attachment: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000001",
      oversizedAttachment: true,
    });
    const { adapter } = subject(github);
    await expect(adapter.source.load(input)).rejects.toMatchObject({
      name: "GitHubAttachmentError",
      kind: "too_large",
    });
  });

  it("posts once for duplicate and concurrent synchronization deliveries", async () => {
    const fixture = subject();
    const context = await fixture.adapter.source.load(input);
    const request = {
      ...input,
      sourceWorkItemId: context.snapshot.sourceWorkItemId,
      expectedObservedVersion: context.snapshot.observedVersion,
      idempotencyKey: "graph-2-source-61",
      actor: "epic-runtime",
      revision: revision(context.snapshot.sourceWorkItemId),
    };
    const [first, second] = await Promise.all([
      fixture.adapter.synchronizeApprovedUpdate(request),
      fixture.adapter.synchronizeApprovedUpdate(request),
    ]);
    expect(first.outcome).toBe("posted");
    expect(second).toEqual(first);
    expect(fixture.github.posted).toHaveLength(1);
    expect(fixture.github.posted[0]).toContain("<!-- heniek-sync:v1:");
  });

  it("adopts the posted marker after a disconnect and preserves a stale source as a merge proposal", async () => {
    const fixture = subject(fakeGitHub({ failAfterPostOnce: true }));
    const context = await fixture.adapter.source.load(input);
    const request = {
      ...input,
      sourceWorkItemId: context.snapshot.sourceWorkItemId,
      expectedObservedVersion: "github-composite-v1:stale",
      idempotencyKey: "recover-after-post",
      actor: "epic-runtime",
      revision: revision(context.snapshot.sourceWorkItemId),
    };
    await expect(fixture.adapter.synchronizeApprovedUpdate(request)).rejects.toThrow(
      "simulated disconnect",
    );
    const recovered = await fixture.adapter.synchronizeApprovedUpdate(request);
    expect(recovered.outcome).toBe("adopted");
    expect(recovered.conflict).toMatchObject({ kind: "stale_source", mergeable: true });
    expect(fixture.github.posted).toHaveLength(1);
  });

  it("retains synchronization audit across a database restart", async () => {
    const fixture = subject();
    const context = await fixture.adapter.source.load(input);
    const audit = await fixture.adapter.synchronizeApprovedUpdate({
      ...input,
      sourceWorkItemId: context.snapshot.sourceWorkItemId,
      expectedObservedVersion: context.snapshot.observedVersion,
      idempotencyKey: "restart-audit",
      actor: "epic-runtime",
      revision: revision(context.snapshot.sourceWorkItemId),
    });
    close?.();
    close = undefined;
    if (directory === undefined) throw new Error("test database directory is missing");
    const reopened = openStateDatabase({
      path: join(directory, "state.sqlite"),
      clock: fixture.clock,
      ids: fixture.ids,
    });
    close = () => reopened.close();
    expect(createTaskSourceStateStore(reopened).synchronization("restart-audit")).toEqual(audit);
  });
});

let conformanceMode: TaskSourceArrangement = { kind: "resolves" };

describeTaskSourceConformance({
  name: "github-task-source",
  capabilities: ["lifecycle", "fault-rate-limit", "fault-conflict"],
  mapInput() {
    if (conformanceMode.kind === "malformed-input") return null;
    if (conformanceMode.kind === "unknown-source-kind") return { ...input, issueNumber: 0 };
    return input;
  },
  classifyFault(error) {
    if (error instanceof GitHubApiError && error.kind === "rate_limit") return "rate_limit";
    if (typeof error === "object" && error !== null && "kind" in error && error.kind === "conflict")
      return "conflict";
    return "unknown";
  },
  async createSubject() {
    const github = fakeGitHub();
    const root = mkdtempSync(join(tmpdir(), "heniek-github-conformance-"));
    let sequence = 0;
    const ids = { next: (prefix: string) => `${prefix}-${++sequence}` };
    const clock = { nowIso: () => `2026-08-12T13:00:${String(sequence).padStart(2, "0")}Z` };
    const db = openStateDatabase({ path: join(root, "state.sqlite"), clock, ids });
    runMigrations(db);
    const artifacts = createArtifactStore({ root: join(root, "artifacts"), clock, ids });
    const state = createTaskSourceStateStore(db);
    const faultingRead: GitHubTransport = {
      async request(request) {
        if (
          conformanceMode.kind === "injects-fault" &&
          conformanceMode.fault === "rate_limit" &&
          request.url.endsWith("/issues/61")
        ) {
          return response(403, { message: "rate limited" }, { "x-ratelimit-remaining": "0" });
        }
        return github.transport.request(request);
      },
    };
    const adapter = createGitHubTaskSource({
      readTransport: faultingRead,
      writeTransport: github.transport,
      artifacts,
      clock,
      ids,
      state,
    });
    return {
      subject: {
        async load(nativeInput: unknown) {
          if (conformanceMode.kind === "injects-fault" && conformanceMode.fault === "conflict")
            throw Object.assign(new Error("stale source"), { kind: "conflict" as const });
          return adapter.source.load(nativeInput);
        },
      },
      async arrange(arrangement: TaskSourceArrangement) {
        conformanceMode = arrangement;
        if (arrangement.kind === "revised") github.posted.push("Human-authored revision");
      },
      async dispose() {
        db.close();
        rmSync(root, { recursive: true, force: true });
        conformanceMode = { kind: "resolves" };
      },
    };
  },
} satisfies TaskSourceHarness);
