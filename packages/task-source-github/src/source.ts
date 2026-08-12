import { createHash } from "node:crypto";
import { closeSync } from "node:fs";
import type {
  SourceWorkItemId,
  TaskContext,
  TaskGraphRevisionRecord,
  TaskSource,
  TaskSourceSnapshot,
  TaskSourceSnapshotId,
  TaskSourceSynchronizationAudit,
  TaskSourceSynchronizationId,
  TaskSourceUpdateProposal,
  TaskSourceUpdateProposalId,
} from "@heniek/contracts";
import {
  type ArtifactStore,
  type Clock,
  createTaskIngestionSource,
  type IdGenerator,
  publishArtifact,
  type TaskSourceAttachmentInput,
  type TaskSourceStateStore,
} from "@heniek/state";
import {
  classifyGitHubResponse,
  GitHubApiError,
  type GitHubTransport,
  type GitHubTransportResponse,
  parseJson,
} from "./client.js";

const MAX_PAGES = 100;
const MAX_ATTACHMENTS = 64;
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const MARKDOWN_ATTACHMENT =
  /https:\/\/(?:github\.com\/user-attachments\/assets\/[A-Za-z0-9-]+|user-images\.githubusercontent\.com\/[^\s)>"']+)/gu;

interface IssueDto {
  readonly nodeId: string;
  readonly uri: string;
  readonly apiUri: string;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly labels: readonly string[];
  readonly updatedAt: string;
}

interface CommentDto {
  readonly nodeId: string;
  readonly uri: string;
  readonly body: string;
  readonly author: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface Component {
  readonly id: string;
  readonly uri: string;
  readonly version: string;
  readonly digest: string;
}

interface DownloadedAttachment extends TaskSourceAttachmentInput {
  readonly content: Uint8Array;
}

interface Observation {
  readonly issue: IssueDto;
  readonly comments: readonly CommentDto[];
  readonly allComments: readonly CommentDto[];
  readonly parent: IssueDto | null;
  readonly children: readonly IssueDto[];
  readonly attachments: readonly DownloadedAttachment[];
  readonly components: readonly Component[];
  readonly rawContent: string;
  readonly observedVersion: string;
  readonly sourceWorkItemId: SourceWorkItemId;
  readonly sourceUri: string;
}

export interface GitHubIssueInput {
  readonly owner: string;
  readonly repository: string;
  readonly issueNumber: number;
}

export interface SynchronizeApprovedUpdateInput extends GitHubIssueInput {
  readonly sourceWorkItemId: SourceWorkItemId;
  readonly expectedObservedVersion: string;
  readonly idempotencyKey: string;
  readonly actor: string;
  readonly revision: TaskGraphRevisionRecord;
}

export interface GitHubTaskSource {
  readonly source: TaskSource;
  synchronizeApprovedUpdate(
    input: SynchronizeApprovedUpdateInput,
  ): Promise<TaskSourceSynchronizationAudit>;
}

export class GitHubTaskSourceInputError extends Error {
  override readonly name: string = "GitHubTaskSourceInputError";
}

export class GitHubAttachmentError extends GitHubTaskSourceInputError {
  override readonly name = "GitHubAttachmentError";

  constructor(
    readonly kind: "unsafe_host" | "too_many" | "too_large" | "missing_redirect" | "redirect_limit",
    readonly uri: string,
    message: string,
  ) {
    super(message);
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new GitHubApiError({
      status: 200,
      kind: "malformed_response",
      message: `GitHub ${context} was not an object`,
    });
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string")
    throw new GitHubApiError({
      status: 200,
      kind: "malformed_response",
      message: `GitHub response omitted ${field}`,
    });
  return value;
}

function issueDto(value: unknown): IssueDto {
  const item = record(value, "issue");
  const labels = Array.isArray(item.labels)
    ? item.labels.map((label) =>
        typeof label === "string" ? label : text(record(label, "label").name, "label.name"),
      )
    : [];
  const state = text(item.state, "issue.state");
  if (state !== "open" && state !== "closed")
    throw new GitHubApiError({
      status: 200,
      kind: "malformed_response",
      message: "GitHub issue state was not open or closed",
    });
  return {
    nodeId: text(item.node_id, "issue.node_id"),
    uri: text(item.html_url, "issue.html_url"),
    apiUri: text(item.url, "issue.url"),
    title: text(item.title, "issue.title"),
    body: item.body === null ? "" : text(item.body, "issue.body"),
    state,
    labels: [...new Set(labels)].sort(),
    updatedAt: text(item.updated_at, "issue.updated_at"),
  };
}

function commentDto(value: unknown): CommentDto {
  const item = record(value, "comment");
  const user = record(item.user, "comment.user");
  return {
    nodeId: text(item.node_id, "comment.node_id"),
    uri: text(item.html_url, "comment.html_url"),
    body: item.body === null ? "" : text(item.body, "comment.body"),
    author: text(user.login, "comment.user.login"),
    createdAt: text(item.created_at, "comment.created_at"),
    updatedAt: text(item.updated_at, "comment.updated_at"),
  };
}

function inputFrom(value: unknown): GitHubIssueInput {
  const candidate = value as Partial<GitHubIssueInput> | null;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof candidate.owner !== "string" ||
    !/^[A-Za-z0-9_.-]+$/.test(candidate.owner) ||
    typeof candidate.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+$/.test(candidate.repository) ||
    !Number.isSafeInteger(candidate.issueNumber) ||
    (candidate.issueNumber ?? 0) < 1
  ) {
    throw new GitHubTaskSourceInputError(
      "expected a valid GitHub owner, repository, and issueNumber",
    );
  }
  return candidate as GitHubIssueInput;
}

function nextLink(value: string | undefined): string | null {
  if (value === undefined) return null;
  for (const part of value.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(part);
    if (match?.[2] === "next") return match[1] ?? null;
  }
  return null;
}

function responseVersion(response: GitHubTransportResponse, fallback: string): string {
  return response.headers.etag ?? response.headers["last-modified"] ?? fallback;
}

function assertPaginationUrl(url: string, apiOrigin: string): void {
  const parsed = new URL(url);
  if (parsed.origin !== apiOrigin || !parsed.pathname.startsWith("/repos/"))
    throw new GitHubApiError({
      status: 200,
      kind: "malformed_response",
      message: "GitHub pagination returned an unexpected URL",
    });
}

async function jsonRequest(
  transport: GitHubTransport,
  url: string,
  operation: string,
  allowNotFound = false,
): Promise<{ readonly value: unknown; readonly response: GitHubTransportResponse }> {
  const response = await transport.request({ method: "GET", url });
  if (allowNotFound && response.status === 404) return { value: null, response };
  classifyGitHubResponse(response, operation);
  return { value: parseJson(response.body, operation), response };
}

async function paginated(
  transport: GitHubTransport,
  initialUrl: string,
  operation: string,
  apiOrigin: string,
): Promise<{ readonly values: readonly unknown[]; readonly components: readonly Component[] }> {
  const values: unknown[] = [];
  const components: Component[] = [];
  let url: string | null = initialUrl;
  for (let page = 1; url !== null; page += 1) {
    if (page > MAX_PAGES)
      throw new GitHubApiError({
        status: 200,
        kind: "malformed_response",
        message: `GitHub ${operation} exceeded ${MAX_PAGES} pages`,
      });
    assertPaginationUrl(url, apiOrigin);
    const { value, response } = await jsonRequest(transport, url, operation);
    if (!Array.isArray(value))
      throw new GitHubApiError({
        status: 200,
        kind: "malformed_response",
        message: `GitHub ${operation} page was not an array`,
      });
    values.push(...value);
    const digest = sha256(canonical(value));
    components.push({
      id: `${operation}:page:${page}`,
      uri: url,
      version: responseVersion(response, digest),
      digest,
    });
    url = nextLink(response.headers.link);
  }
  return { values, components };
}

function attachmentUrls(issue: IssueDto, comments: readonly CommentDto[]): readonly string[] {
  const found = new Set<string>();
  for (const content of [issue.body, ...comments.map((comment) => comment.body)]) {
    for (const match of content.matchAll(MARKDOWN_ATTACHMENT)) {
      if (match[0] !== undefined) found.add(match[0]);
      if (found.size > MAX_ATTACHMENTS)
        throw new GitHubAttachmentError(
          "too_many",
          issue.uri,
          `GitHub issue exceeds ${MAX_ATTACHMENTS} attachments`,
        );
    }
  }
  return [...found].sort();
}

function assertAttachmentUrl(url: string): void {
  const parsed = new URL(url);
  const allowed =
    (parsed.hostname === "github.com" && parsed.pathname.startsWith("/user-attachments/assets/")) ||
    parsed.hostname === "user-images.githubusercontent.com";
  if (parsed.protocol !== "https:" || !allowed)
    throw new GitHubAttachmentError(
      "unsafe_host",
      url,
      "attachment URL is not on an allowlisted GitHub host",
    );
}

async function downloadAttachment(
  transport: GitHubTransport,
  initialUrl: string,
  index: number,
): Promise<DownloadedAttachment> {
  let url = initialUrl;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    assertAttachmentUrl(url);
    const response = await transport.request({
      method: "GET",
      url,
      maxResponseBytes: MAX_ATTACHMENT_BYTES,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (location === undefined)
        throw new GitHubAttachmentError(
          "missing_redirect",
          url,
          "attachment redirect omitted its location",
        );
      url = new URL(location, url).toString();
      continue;
    }
    classifyGitHubResponse(response, "attachment download");
    if (response.body.byteLength > MAX_ATTACHMENT_BYTES)
      throw new GitHubAttachmentError(
        "too_large",
        url,
        `attachment exceeded the ${MAX_ATTACHMENT_BYTES} byte limit`,
      );
    const mediaType = (response.headers["content-type"] ?? "application/octet-stream")
      .split(";", 1)[0]
      ?.trim();
    return {
      uri: initialUrl,
      name: new URL(initialUrl).pathname.split("/").at(-1) || `attachment-${index + 1}`,
      mediaType: mediaType || "application/octet-stream",
      observedVersion: responseVersion(response, sha256(response.body)),
      content: response.body,
    };
  }
  throw new GitHubAttachmentError(
    "redirect_limit",
    initialUrl,
    "attachment exceeded the redirect limit",
  );
}

function sourceId(nodeId: string): SourceWorkItemId {
  return `github:issue:${nodeId}` as SourceWorkItemId;
}

function requirementText(issue: IssueDto): string {
  return issue.body.trim().length === 0 ? issue.title : issue.body;
}

function changedFields(
  base: Extract<TaskSourceSnapshot, { schemaVersion: 2 }>,
  observed: Extract<TaskSourceSnapshot, { schemaVersion: 2 }>,
): TaskSourceUpdateProposal["changedFields"] {
  const fields: TaskSourceUpdateProposal["changedFields"][number][] = [];
  if (base.title !== observed.title) fields.push("title");
  if (base.state !== observed.state) fields.push("state");
  if (canonical(base.labels) !== canonical(observed.labels)) fields.push("labels");
  if (canonical(base.comments) !== canonical(observed.comments)) fields.push("comments");
  if (canonical(base.attachments) !== canonical(observed.attachments)) fields.push("attachments");
  const baseHierarchy = base.components.filter((item) =>
    /^(parent|sub-issues):/.test(item.componentId),
  );
  const observedHierarchy = observed.components.filter((item) =>
    /^(parent|sub-issues):/.test(item.componentId),
  );
  if (canonical(baseHierarchy) !== canonical(observedHierarchy)) fields.push("hierarchy");
  const baseIssue = base.components.find((item) => item.componentId === "issue");
  const observedIssue = observed.components.find((item) => item.componentId === "issue");
  if (baseIssue?.contentSha256 !== observedIssue?.contentSha256) fields.push("body");
  return [...new Set(fields)];
}

function publishPendingObservation(
  deps: {
    readonly artifacts: ArtifactStore;
    readonly clock: Clock;
    readonly ids: IdGenerator;
    readonly state: TaskSourceStateStore;
  },
  observation: Observation,
  active: TaskContext,
): TaskContext {
  const rawBytes = new TextEncoder().encode(observation.rawContent);
  const rawHash = sha256(rawBytes);
  const rawReceipt = publishArtifact(deps.artifacts, {
    bytes: rawBytes,
    expectedContentHash: rawHash,
  });
  closeSync(rawReceipt.fd);
  const attachmentRelativePaths: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const attachments: Extract<TaskSourceSnapshot, { schemaVersion: 2 }>["attachments"] = [];
  for (const attachment of observation.attachments) {
    const digest = sha256(attachment.content);
    const receipt = publishArtifact(deps.artifacts, {
      bytes: attachment.content,
      expectedContentHash: digest,
    });
    closeSync(receipt.fd);
    attachmentRelativePaths[receipt.artifactId] = receipt.relativePath;
    attachments.push({
      uri: attachment.uri,
      name: attachment.name,
      mediaType: attachment.mediaType,
      observedVersion: attachment.observedVersion ?? null,
      contentSha256: digest,
      artifactId: receipt.artifactId,
    });
  }
  const now = deps.clock.nowIso();
  const snapshot: Extract<TaskSourceSnapshot, { schemaVersion: 2 }> = {
    schemaVersion: 2,
    snapshotId: deps.ids.next("source-snapshot") as TaskSourceSnapshotId,
    sourceWorkItemId: observation.sourceWorkItemId,
    sourceKind: "github_issue",
    sourceUri: observation.sourceUri,
    observedVersion: observation.observedVersion,
    contentSha256: rawHash,
    rawContentRef: rawReceipt.artifactId,
    requirements: [
      {
        requirementId: "github-issue-body",
        text: requirementText(observation.issue),
        sourcePointer: "/issue/body",
      },
    ],
    attachments,
    observedAt: now,
    title: observation.issue.title,
    state: observation.issue.state,
    labels: [...observation.issue.labels],
    comments: observation.comments.map((comment) => ({
      sourceCommentId: comment.nodeId,
      uri: comment.uri,
      author: comment.author,
      bodySha256: sha256(comment.body),
      observedVersion: comment.updatedAt,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    })),
    components: observation.components.map((component) => ({
      componentId: component.id,
      uri: component.uri,
      observedVersion: component.version,
      contentSha256: component.digest,
    })),
  };
  const base = deps.state.snapshot(active.activeRevision.sourceSnapshotId);
  if (base?.schemaVersion !== 2)
    throw new GitHubTaskSourceInputError("active GitHub task source is not a V2 snapshot");
  const fields = changedFields(base, snapshot);
  if (fields.length === 0) fields.push("body");
  const proposal: TaskSourceUpdateProposal = {
    schemaVersion: 1,
    proposalId: deps.ids.next("source-update") as TaskSourceUpdateProposalId,
    sourceWorkItemId: observation.sourceWorkItemId,
    baseSnapshotId: active.activeRevision.sourceSnapshotId,
    observedSnapshotId: snapshot.snapshotId,
    baseObservedVersion: base.observedVersion,
    observedVersion: snapshot.observedVersion,
    changedFields: fields,
    status: "pending",
    createdAt: now,
    decidedAt: null,
  };
  return deps.state.recordPendingUpdate({
    snapshot,
    rawRelativePath: rawReceipt.relativePath,
    attachmentRelativePaths,
    proposal,
  });
}

function synchronizationComment(
  input: SynchronizeApprovedUpdateInput,
  currentVersion: string,
  stale: boolean,
): string {
  const changes = input.revision.changes
    .map((change) => `- **${change.kind}**: ${change.rationale}`)
    .join("\n");
  return [
    stale ? "## Heniek synchronization merge proposal" : "## Heniek synchronization update",
    "",
    input.revision.rationale,
    "",
    changes,
    "",
    `Graph revision: ${input.revision.graphRevision}`,
    `Expected source version: \`${input.expectedObservedVersion}\``,
    `Observed source version: \`${currentVersion}\``,
    stale
      ? "The source changed after approval. This append-only proposal preserves the human edit for review."
      : "The source still matches the approved observation.",
  ].join("\n");
}

export function createGitHubTaskSource(deps: {
  readonly readTransport: GitHubTransport;
  readonly writeTransport: GitHubTransport;
  readonly artifacts: ArtifactStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly state: TaskSourceStateStore;
  readonly apiBaseUrl?: string;
}): GitHubTaskSource {
  const apiBaseUrl = (deps.apiBaseUrl ?? "https://api.github.com").replace(/\/$/u, "");
  const apiOrigin = new URL(apiBaseUrl).origin;
  const ingestion = createTaskIngestionSource(deps);
  const locks = new Map<string, Promise<void>>();
  const observationCache = new Map<string, Observation>();

  async function observe(input: GitHubIssueInput): Promise<Observation> {
    const base = `${apiBaseUrl}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/issues/${input.issueNumber}`;
    const cached = observationCache.get(base);
    const cachedIssueVersion = cached?.components.find(
      (component) => component.id === "issue",
    )?.version;
    const issueHttpResponse = await deps.readTransport.request({
      method: "GET",
      url: base,
      ...(cachedIssueVersion !== undefined && /^(?:W\/)?"/.test(cachedIssueVersion)
        ? { headers: { "if-none-match": cachedIssueVersion } }
        : {}),
    });
    const issue =
      issueHttpResponse.status === 304 && cached !== undefined
        ? cached.issue
        : (() => {
            classifyGitHubResponse(issueHttpResponse, "issue snapshot");
            return issueDto(parseJson(issueHttpResponse.body, "issue snapshot"));
          })();
    const commentsPage = await paginated(
      deps.readTransport,
      `${base}/comments?per_page=100`,
      "comments",
      apiOrigin,
    );
    const childrenPage = await paginated(
      deps.readTransport,
      `${base}/sub_issues?per_page=100`,
      "sub-issues",
      apiOrigin,
    );
    const parentResponse = await jsonRequest(
      deps.readTransport,
      `${base}/parent`,
      "parent issue",
      true,
    );
    const allComments = commentsPage.values
      .map(commentDto)
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    const comments = allComments.filter(
      (comment) => !comment.body.includes("<!-- heniek-sync:v1:"),
    );
    const children = childrenPage.values
      .map(issueDto)
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
    const parent = parentResponse.value === null ? null : issueDto(parentResponse.value);
    const attachments: DownloadedAttachment[] = [];
    for (const [index, url] of attachmentUrls(issue, comments).entries())
      attachments.push(await downloadAttachment(deps.readTransport, url, index));
    const rootValue = {
      nodeId: issue.nodeId,
      uri: issue.uri,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels,
      updatedAt: issue.updatedAt,
    };
    const rootDigest = sha256(canonical(rootValue));
    const parentValue =
      parent === null
        ? null
        : { nodeId: parent.nodeId, uri: parent.uri, updatedAt: parent.updatedAt };
    const parentDigest = sha256(canonical(parentValue));
    const components: Component[] = [
      {
        id: "issue",
        uri: issue.apiUri,
        version:
          issueHttpResponse.status === 304 && cachedIssueVersion !== undefined
            ? cachedIssueVersion
            : responseVersion(issueHttpResponse, issue.updatedAt),
        digest: rootDigest,
      },
      ...comments.map((comment) => ({
        id: `comment:${comment.nodeId}`,
        uri: comment.uri,
        version: comment.updatedAt,
        digest: sha256(canonical(comment)),
      })),
      ...attachments.map((attachment) => ({
        id: `attachment:${sha256(attachment.uri)}`,
        uri: attachment.uri,
        version: attachment.observedVersion ?? sha256(attachment.content),
        digest: sha256(attachment.content),
      })),
      ...childrenPage.components,
      {
        id: "parent:issue",
        uri: `${base}/parent`,
        version: responseVersion(parentResponse.response, parent?.updatedAt ?? "none"),
        digest: parentDigest,
      },
    ];
    const rawValue = {
      issue: rootValue,
      comments,
      parent: parentValue,
      children: children.map((child) => ({
        nodeId: child.nodeId,
        uri: child.uri,
        title: child.title,
        state: child.state,
        updatedAt: child.updatedAt,
      })),
      attachments: attachments.map((attachment) => ({
        uri: attachment.uri,
        name: attachment.name,
        mediaType: attachment.mediaType,
        observedVersion: attachment.observedVersion,
        contentSha256: sha256(attachment.content),
      })),
      components,
    };
    const rawContent = canonical(rawValue);
    const observedVersion = `github-composite-v1:${sha256(
      canonical(components.map(({ id, version, digest }) => ({ id, version, digest }))),
    )}`;
    const observation = {
      issue,
      comments,
      allComments,
      parent,
      children,
      attachments,
      components,
      rawContent,
      observedVersion,
      sourceWorkItemId: sourceId(issue.nodeId),
      sourceUri: issue.uri,
    };
    observationCache.set(base, observation);
    return observation;
  }

  const source: TaskSource = {
    async load(value) {
      const input = inputFrom(value);
      const observation = await observe(input);
      const existing = deps.state.findObservation(
        observation.sourceUri,
        observation.observedVersion,
      );
      if (existing !== undefined) {
        const context = deps.state.load(observation.sourceWorkItemId);
        if (context === undefined)
          throw new GitHubTaskSourceInputError("stored GitHub observation has no task context");
        return context;
      }
      const active = deps.state.load(observation.sourceWorkItemId);
      if (active !== undefined) return publishPendingObservation(deps, observation, active);
      return ingestion.load({
        sourceWorkItemId: observation.sourceWorkItemId,
        sourceKind: "github_issue",
        sourceUri: observation.sourceUri,
        observedVersion: observation.observedVersion,
        rawContent: observation.rawContent,
        handoff: {
          schemaVersion: 1,
          objective: observation.issue.title,
          constraints: [
            `Source state: ${observation.issue.state}`,
            `Labels: ${observation.issue.labels.join(", ") || "none"}`,
          ],
          decisions: [],
          openQuestions: [],
          repositoryReferences: [`${input.owner}/${input.repository}`],
          requirements: [
            {
              requirementId: "github-issue-body",
              text: requirementText(observation.issue),
              sourcePointer: "/issue/body",
            },
          ],
        },
        attachments: observation.attachments,
        hierarchy: {
          trackerEdges: [
            ...(observation.parent === null
              ? []
              : [
                  {
                    parentSourceWorkItemId: sourceId(observation.parent.nodeId),
                    childSourceWorkItemId: observation.sourceWorkItemId,
                  },
                ]),
            ...observation.children.map((child) => ({
              parentSourceWorkItemId: observation.sourceWorkItemId,
              childSourceWorkItemId: sourceId(child.nodeId),
            })),
          ],
        },
        author: "github-task-source",
        reason: "Initial GitHub issue observation",
        externalMetadata: {
          title: observation.issue.title,
          state: observation.issue.state,
          labels: observation.issue.labels,
          comments: observation.comments.map((comment) => ({
            sourceCommentId: comment.nodeId,
            uri: comment.uri,
            author: comment.author,
            bodySha256: sha256(comment.body),
            observedVersion: comment.updatedAt,
            createdAt: comment.createdAt,
            updatedAt: comment.updatedAt,
          })),
          components: observation.components.map((component) => ({
            componentId: component.id,
            uri: component.uri,
            observedVersion: component.version,
            contentSha256: component.digest,
          })),
        },
      });
    },
  };

  async function synchronizeUnlocked(
    input: SynchronizeApprovedUpdateInput,
  ): Promise<TaskSourceSynchronizationAudit> {
    inputFrom(input);
    if (input.idempotencyKey.length === 0 || input.actor.length === 0)
      throw new GitHubTaskSourceInputError("synchronization requires idempotencyKey and actor");
    const observation = await observe(input);
    if (observation.sourceWorkItemId !== input.sourceWorkItemId) {
      const now = deps.clock.nowIso();
      const proposalSha256 = sha256(canonical(input.revision));
      const claim = deps.state.claimSynchronization({
        synchronizationId: deps.ids.next("source-sync"),
        sourceWorkItemId: input.sourceWorkItemId,
        sourceUri: observation.sourceUri,
        idempotencyKey: input.idempotencyKey,
        proposalSha256,
        expectedObservedVersion: input.expectedObservedVersion,
        actor: input.actor,
        claimedAt: now,
      });
      if (claim.audit !== undefined) return claim.audit;
      return deps.state.completeSynchronization({
        schemaVersion: 1,
        synchronizationId: claim.claim.synchronizationId as TaskSourceSynchronizationId,
        sourceWorkItemId: input.sourceWorkItemId,
        sourceUri: observation.sourceUri,
        idempotencyKey: input.idempotencyKey,
        proposalSha256,
        expectedObservedVersion: input.expectedObservedVersion,
        currentObservedVersion: observation.observedVersion,
        actor: input.actor,
        outcome: "conflict",
        commentUri: null,
        requestId: null,
        conflict: {
          kind: "incompatible_source",
          message: "GitHub issue identity no longer matches the approved source",
          baseObservedVersion: input.expectedObservedVersion,
          currentObservedVersion: observation.observedVersion,
          mergeable: false,
        },
        createdAt: claim.claim.claimedAt,
        completedAt: deps.clock.nowIso(),
      });
    }
    const mappings = input.revision.requirementMappings.filter(
      (mapping) => mapping.sourceWorkItemId === input.sourceWorkItemId,
    );
    const stale = observation.observedVersion !== input.expectedObservedVersion;
    const draftBody = synchronizationComment(input, observation.observedVersion, stale);
    const proposalSha256 = sha256(draftBody);
    const claim = deps.state.claimSynchronization({
      synchronizationId: deps.ids.next("source-sync"),
      sourceWorkItemId: input.sourceWorkItemId,
      sourceUri: observation.sourceUri,
      idempotencyKey: input.idempotencyKey,
      proposalSha256,
      expectedObservedVersion: input.expectedObservedVersion,
      actor: input.actor,
      claimedAt: deps.clock.nowIso(),
    });
    if (claim.audit !== undefined) return claim.audit;
    if (mappings.length === 0) {
      return deps.state.completeSynchronization({
        schemaVersion: 1,
        synchronizationId: claim.claim.synchronizationId as TaskSourceSynchronizationId,
        sourceWorkItemId: input.sourceWorkItemId,
        sourceUri: observation.sourceUri,
        idempotencyKey: input.idempotencyKey,
        proposalSha256,
        expectedObservedVersion: input.expectedObservedVersion,
        currentObservedVersion: observation.observedVersion,
        actor: input.actor,
        outcome: "conflict",
        commentUri: null,
        requestId: null,
        conflict: {
          kind: "ambiguous_mapping",
          message: "Approved graph revision has no requirement mapping for this source",
          baseObservedVersion: input.expectedObservedVersion,
          currentObservedVersion: observation.observedVersion,
          mergeable: false,
        },
        createdAt: claim.claim.claimedAt,
        completedAt: deps.clock.nowIso(),
      });
    }
    const marker = `<!-- heniek-sync:v1:${sha256(`${input.idempotencyKey}\0${proposalSha256}`)} -->`;
    const body = `${marker}\n${draftBody}`;
    const existing = observation.allComments.find((comment) => comment.body.includes(marker));
    if (existing !== undefined) {
      return deps.state.completeSynchronization({
        schemaVersion: 1,
        synchronizationId: claim.claim.synchronizationId as TaskSourceSynchronizationId,
        sourceWorkItemId: input.sourceWorkItemId,
        sourceUri: observation.sourceUri,
        idempotencyKey: input.idempotencyKey,
        proposalSha256,
        expectedObservedVersion: input.expectedObservedVersion,
        currentObservedVersion: observation.observedVersion,
        actor: input.actor,
        outcome: "adopted",
        commentUri: existing.uri,
        requestId: null,
        conflict: stale
          ? {
              kind: "stale_source",
              message:
                "Human-authored source changes were preserved in an append-only merge proposal",
              baseObservedVersion: input.expectedObservedVersion,
              currentObservedVersion: observation.observedVersion,
              mergeable: true,
            }
          : null,
        createdAt: claim.claim.claimedAt,
        completedAt: deps.clock.nowIso(),
      });
    }
    const commentsUrl = `${apiBaseUrl}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/issues/${input.issueNumber}/comments`;
    const response = await deps.writeTransport.request({
      method: "POST",
      url: commentsUrl,
      body: JSON.stringify({ body }),
    });
    classifyGitHubResponse(response, "synchronization comment");
    const posted = record(parseJson(response.body, "synchronization comment"), "comment");
    return deps.state.completeSynchronization({
      schemaVersion: 1,
      synchronizationId: claim.claim.synchronizationId as TaskSourceSynchronizationId,
      sourceWorkItemId: input.sourceWorkItemId,
      sourceUri: observation.sourceUri,
      idempotencyKey: input.idempotencyKey,
      proposalSha256,
      expectedObservedVersion: input.expectedObservedVersion,
      currentObservedVersion: observation.observedVersion,
      actor: input.actor,
      outcome: "posted",
      commentUri: text(posted.html_url, "comment.html_url"),
      requestId: response.headers["x-github-request-id"] ?? null,
      conflict: stale
        ? {
            kind: "stale_source",
            message:
              "Human-authored source changes were preserved in an append-only merge proposal",
            baseObservedVersion: input.expectedObservedVersion,
            currentObservedVersion: observation.observedVersion,
            mergeable: true,
          }
        : null,
      createdAt: claim.claim.claimedAt,
      completedAt: deps.clock.nowIso(),
    });
  }

  return {
    source,
    async synchronizeApprovedUpdate(input) {
      const prior = locks.get(input.idempotencyKey) ?? Promise.resolve();
      let release = (): void => undefined;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const chained = prior.then(() => current);
      locks.set(input.idempotencyKey, chained);
      await prior;
      try {
        return await synchronizeUnlocked(input);
      } finally {
        release();
        if (locks.get(input.idempotencyKey) === chained) locks.delete(input.idempotencyKey);
      }
    },
  };
}
