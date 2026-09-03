import { createHash } from "node:crypto";
import type {
  CheckFailureV1,
  CheckStatusV1,
  ForgeBackendV3,
  ForgeIssueId,
  ForgeIssueV1,
  ForgeObservedVersion,
  ForgeRefId,
  ForgeRefV1,
  PullRequestId,
  PullRequestV1,
  PullRequestV2,
  RepositoryId,
} from "@heniek/contracts";
import {
  CreateOrAdoptBranchInputV1,
  CreateOrAdoptIssueInputV1,
  CreatePullRequestInputV1,
  CreatePullRequestInputV2,
  GetIssueInputV1,
  GetRefInputV1,
  UpdateBranchInputV1,
  UpdateIssueInputV1,
  UpdatePullRequestInputV1,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import type { ForgeArrangement } from "../contract/arrangement.js";
import { ConformanceFaultError, isConformanceFaultError } from "../contract/fault.js";
import type { ForgeBackendHarness } from "../contract/harness.js";
import { assertValid } from "../contract/validation.js";
import type { ConformanceContext } from "../kernel/context.js";
import type { JsonValue } from "../kernel/json.js";
import { createFaultProgramme, type FaultProgramme } from "./fault-programme.js";

type PullRequestV1Value = Static<typeof PullRequestV1>;
type PullRequestV2Value = Static<typeof PullRequestV2>;
type Issue = Static<typeof ForgeIssueV1>;
type Ref = Static<typeof ForgeRefV1>;
type CheckStatus = Static<typeof CheckStatusV1>;
type CheckFailure = Static<typeof CheckFailureV1>;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function version(value: unknown): ForgeObservedVersion {
  return `sha256:${hash(value)}` as ForgeObservedVersion;
}

function isRetryable(fault: string): boolean {
  return fault === "disconnect" || fault === "rate_limit";
}

interface ForgeIssueRecord {
  readonly issueId: ForgeIssueId;
  readonly repositoryId: RepositoryId;
  readonly number: number;
  readonly url: string;
  readonly linkageDigest: string;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
}

interface ForgeRefRecord {
  readonly forgeRefId: ForgeRefId;
  readonly repositoryId: RepositoryId;
  readonly qualifiedRef: string;
  readonly url: string;
  headSha: string;
}

interface ForgePullRequestRecord {
  readonly pullRequestId: PullRequestId;
  readonly repositoryId: RepositoryId;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly linkageDigest?: string;
  readonly baseSha: string;
  draft: boolean;
  readonly headSha: string;
  readonly staleHead: boolean;
  autoMergeEnabled: boolean;
  checks: CheckStatus[];
  readonly faultProgramme: FaultProgramme;
}

export interface FakeForgeBackend {
  readonly backend: ForgeBackendV3;
  /** Arranges the behaviour of the next PR to be created. */
  arrange(arrangement: ForgeArrangement): void;
}

function issueValue(record: ForgeIssueRecord): Issue {
  const normalized = {
    issueId: record.issueId,
    repositoryId: record.repositoryId,
    number: record.number,
    url: record.url,
    title: record.title,
    body: record.body,
    state: record.state,
    labels: [...record.labels].sort(),
    linkageDigest: record.linkageDigest,
  };
  return { schemaVersion: 1, ...normalized, observedVersion: version(normalized) };
}

function refValue(record: ForgeRefRecord): Ref {
  const normalized = {
    forgeRefId: record.forgeRefId,
    repositoryId: record.repositoryId,
    qualifiedRef: record.qualifiedRef,
    url: record.url,
    headSha: record.headSha,
  };
  return { schemaVersion: 1, ...normalized, observedVersion: version(normalized) };
}

function pullRequestValue(record: ForgePullRequestRecord): PullRequestV2Value {
  const normalized = {
    pullRequestId: record.pullRequestId,
    repositoryId: record.repositoryId,
    number: record.number,
    url: record.url,
    state: "open" as const,
    draft: record.draft,
    sourceBranch: record.sourceBranch,
    targetBranch: record.targetBranch,
    baseSha: record.baseSha,
    headSha: record.headSha,
    autoMergeEnabled: record.autoMergeEnabled,
    ...(record.linkageDigest === undefined ? {} : { linkageDigest: record.linkageDigest }),
  };
  return { schemaVersion: 2, ...normalized, observedVersion: version(normalized) };
}

function pullRequestV1(record: ForgePullRequestRecord): PullRequestV1Value {
  return {
    schemaVersion: 1,
    pullRequestId: record.pullRequestId,
    repositoryId: record.repositoryId,
    number: record.number,
    url: record.url,
    state: "open",
    draft: record.draft,
    headSha: record.headSha,
  };
}

export function createFakeForgeBackend(context: ConformanceContext): FakeForgeBackend {
  const issues = new Map<string, ForgeIssueRecord>();
  const refs = new Map<string, ForgeRefRecord>();
  const pullRequests = new Map<string, ForgePullRequestRecord>();
  let pendingArrangement: ForgeArrangement | undefined;
  let nextIssueNumber = 1;
  let nextPullRequestNumber = 1;

  function trace(action: string, detail: JsonValue = {}): void {
    context.trace.record({
      atMs: context.clock.nowMs(),
      actor: "forge-backend",
      action,
      outcome: "ok",
      detail,
    });
  }

  function requirePr(id: PullRequestId, action: string): ForgePullRequestRecord {
    const pr = pullRequests.get(id);
    if (pr === undefined) {
      throw new ConformanceFaultError("stale_ref", false, `unknown pull request id: ${id}`);
    }
    trace(action, { pullRequestId: id });
    return pr;
  }

  function requireIssue(repositoryId: RepositoryId, number: number): ForgeIssueRecord {
    const issue = issues.get(`${repositoryId}:${number}`);
    if (issue === undefined) throw new ConformanceFaultError("stale_ref", false, "unknown issue");
    return issue;
  }

  function branchKey(repositoryId: RepositoryId, branchName: string): string {
    return `${repositoryId}:refs/heads/${branchName}`;
  }

  function createPrRecord(input: {
    readonly repositoryId: RepositoryId;
    readonly sourceBranch: string;
    readonly targetBranch: string;
    readonly title: string;
    readonly body: string;
    readonly draft: boolean;
    readonly headSha: string;
    readonly linkageDigest?: string;
  }): ForgePullRequestRecord {
    const arrangement = pendingArrangement;
    pendingArrangement = undefined;
    const id = context.ids.next("conformance-pull-request") as PullRequestId;
    const number = nextPullRequestNumber++;
    const checks: CheckStatus[] =
      arrangement?.kind === "checks"
        ? arrangement.states.map((state, index) => ({
            schemaVersion: 1,
            name: `conformance-check-${index + 1}`,
            state,
            required: true,
          }))
        : [];
    const target = refs.get(branchKey(input.repositoryId, input.targetBranch));
    const record: ForgePullRequestRecord = {
      pullRequestId: id,
      repositoryId: input.repositoryId,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      title: input.title,
      body: input.body,
      draft: input.draft,
      headSha: input.headSha,
      baseSha: target?.headSha ?? context.ids.next("conformance-base-sha"),
      staleHead: arrangement?.kind === "stale-head",
      autoMergeEnabled: false,
      checks,
      number,
      url: `https://forge.invalid/${input.repositoryId}/pull/${number}`,
      faultProgramme: createFaultProgramme(
        arrangement?.kind === "injects-fault"
          ? [{ fault: arrangement.fault, occurrences: arrangement.occurrences }]
          : [],
      ),
      ...(input.linkageDigest === undefined ? {} : { linkageDigest: input.linkageDigest }),
    };
    pullRequests.set(id, record);
    return record;
  }

  const backend: ForgeBackendV3 = {
    async createOrAdoptIssue(input) {
      assertValid(CreateOrAdoptIssueInputV1, input, "CreateOrAdoptIssueInputV1");
      const linkage = hash({ kind: "issue", key: input.idempotencyKey });
      const matches = [...issues.values()].filter(
        (issue) => issue.repositoryId === input.repositoryId && issue.linkageDigest === linkage,
      );
      if (matches.length > 1) throw new ConformanceFaultError("conflict", false);
      const match = matches[0];
      if (match !== undefined) {
        if (
          match.title !== input.title ||
          match.body !== input.body.trimEnd() ||
          JSON.stringify(match.labels) !== JSON.stringify([...(input.labels ?? [])].sort())
        ) {
          throw new ConformanceFaultError("conflict", false);
        }
        return { schemaVersion: 1, disposition: "adopted", issue: issueValue(match) };
      }
      const number = nextIssueNumber++;
      const record: ForgeIssueRecord = {
        issueId: context.ids.next("conformance-issue") as ForgeIssueId,
        repositoryId: input.repositoryId,
        number,
        url: `https://forge.invalid/${input.repositoryId}/issues/${number}`,
        linkageDigest: linkage,
        title: input.title,
        body: input.body.trimEnd(),
        state: "open",
        labels: [...(input.labels ?? [])].sort(),
      };
      issues.set(`${input.repositoryId}:${number}`, record);
      trace("createOrAdoptIssue", { number });
      return { schemaVersion: 1, disposition: "created", issue: issueValue(record) };
    },

    async getIssue(input) {
      assertValid(GetIssueInputV1, input, "GetIssueInputV1");
      return issueValue(requireIssue(input.repositoryId, input.number));
    },

    async updateIssue(input) {
      assertValid(UpdateIssueInputV1, input, "UpdateIssueInputV1");
      const record = requireIssue(input.repositoryId, input.number);
      const current = issueValue(record);
      const desiredMatches =
        (input.patch.title === undefined || record.title === input.patch.title) &&
        (input.patch.body === undefined || record.body === input.patch.body.trimEnd()) &&
        (input.patch.state === undefined || record.state === input.patch.state) &&
        (input.patch.labels === undefined ||
          JSON.stringify(record.labels) === JSON.stringify([...input.patch.labels].sort()));
      if (desiredMatches) {
        return { schemaVersion: 1, disposition: "unchanged", issue: current };
      }
      if (current.observedVersion !== input.expectedObservedVersion) {
        throw new ConformanceFaultError("conflict", false, "issue version changed");
      }
      if (input.patch.title !== undefined) record.title = input.patch.title;
      if (input.patch.body !== undefined) record.body = input.patch.body.trimEnd();
      if (input.patch.state !== undefined) record.state = input.patch.state;
      if (input.patch.labels !== undefined) record.labels = [...input.patch.labels].sort();
      return { schemaVersion: 1, disposition: "updated", issue: issueValue(record) };
    },

    async getRef(input) {
      assertValid(GetRefInputV1, input, "GetRefInputV1");
      const ref = refs.get(`${input.repositoryId}:${input.qualifiedRef}`);
      return ref === undefined ? null : refValue(ref);
    },

    async createOrAdoptBranch(input) {
      assertValid(CreateOrAdoptBranchInputV1, input, "CreateOrAdoptBranchInputV1");
      const key = branchKey(input.repositoryId, input.branchName);
      const existing = refs.get(key);
      if (existing !== undefined) {
        if (existing.headSha !== input.targetSha)
          throw new ConformanceFaultError("stale_ref", false);
        return { schemaVersion: 1, disposition: "adopted", ref: refValue(existing) };
      }
      const record: ForgeRefRecord = {
        forgeRefId: context.ids.next("conformance-ref") as ForgeRefId,
        repositoryId: input.repositoryId,
        qualifiedRef: `refs/heads/${input.branchName}`,
        url: `https://forge.invalid/${input.repositoryId}/tree/${input.branchName}`,
        headSha: input.targetSha,
      };
      refs.set(key, record);
      return { schemaVersion: 1, disposition: "created", ref: refValue(record) };
    },

    async updateBranch(input) {
      assertValid(UpdateBranchInputV1, input, "UpdateBranchInputV1");
      const record = refs.get(branchKey(input.repositoryId, input.branchName));
      if (record === undefined) throw new ConformanceFaultError("stale_ref", false);
      if (record.headSha === input.targetHeadSha) {
        return { schemaVersion: 1, disposition: "unchanged", ref: refValue(record) };
      }
      if (record.headSha !== input.expectedHeadSha) {
        throw new ConformanceFaultError("stale_ref", false);
      }
      record.headSha = input.targetHeadSha;
      return { schemaVersion: 1, disposition: "updated", ref: refValue(record) };
    },

    async createOrAdoptPullRequest(input) {
      assertValid(CreatePullRequestInputV2, input, "CreatePullRequestInputV2");
      const source = refs.get(branchKey(input.repositoryId, input.sourceBranch));
      if (source?.headSha !== input.expectedHeadSha) {
        throw new ConformanceFaultError("stale_ref", false);
      }
      const linkage = hash({ kind: "pull-request", key: input.idempotencyKey });
      const matches = [...pullRequests.values()].filter(
        (pr) => pr.repositoryId === input.repositoryId && pr.linkageDigest === linkage,
      );
      if (matches.length > 1) throw new ConformanceFaultError("conflict", false);
      const match = matches[0];
      if (match !== undefined) {
        if (
          match.sourceBranch !== input.sourceBranch ||
          match.targetBranch !== input.targetBranch ||
          match.headSha !== input.expectedHeadSha ||
          match.title !== input.title ||
          match.body !== input.body.trimEnd() ||
          match.draft !== (input.draft ?? true)
        ) {
          throw new ConformanceFaultError("conflict", false);
        }
        return {
          schemaVersion: 1,
          disposition: "adopted",
          pullRequest: pullRequestValue(match),
        };
      }
      const record = createPrRecord({
        ...input,
        body: input.body.trimEnd(),
        draft: input.draft ?? true,
        headSha: input.expectedHeadSha,
        linkageDigest: linkage,
      });
      return {
        schemaVersion: 1,
        disposition: "created",
        pullRequest: pullRequestValue(record),
      };
    },

    async getPullRequest(id) {
      return pullRequestValue(requirePr(id, "getPullRequest"));
    },

    async updatePullRequest(input) {
      assertValid(UpdatePullRequestInputV1, input, "UpdatePullRequestInputV1");
      const record = requirePr(input.pullRequestId, "updatePullRequest");
      const current = pullRequestValue(record);
      if (record.headSha !== input.expectedHeadSha) {
        throw new ConformanceFaultError("stale_ref", false);
      }
      const desiredMatches =
        (input.draft === undefined || record.draft === input.draft) &&
        (input.autoMergeEnabled === undefined ||
          record.autoMergeEnabled === input.autoMergeEnabled);
      if (desiredMatches) {
        return { schemaVersion: 1, disposition: "unchanged", pullRequest: current };
      }
      if (current.observedVersion !== input.expectedObservedVersion) {
        throw new ConformanceFaultError("conflict", false);
      }
      if ((input.draft ?? record.draft) && input.autoMergeEnabled === true) {
        throw new ConformanceFaultError("conflict", false, "cannot auto-merge a draft");
      }
      if (input.draft !== undefined) record.draft = input.draft;
      if (input.autoMergeEnabled !== undefined) record.autoMergeEnabled = input.autoMergeEnabled;
      return {
        schemaVersion: 1,
        disposition: "updated",
        pullRequest: pullRequestValue(record),
      };
    },

    async observePullRequestStatus(id) {
      const record = requirePr(id, "observePullRequestStatus");
      const checks = [...record.checks];
      const normalized = {
        pullRequestId: id,
        mergeability: record.staleHead ? ("conflicting" as const) : ("mergeable" as const),
        mergeState: record.draft ? ("draft" as const) : ("clean" as const),
        checks,
      };
      return {
        schemaVersion: 1,
        ...normalized,
        totalCount: checks.length,
        requiredCount: checks.filter((check) => check.required).length,
        succeededCount: checks.filter((check) => check.state === "succeeded").length,
        failedCount: checks.filter((check) => check.state === "failed").length,
        pendingCount: checks.filter(
          (check) => check.state === "queued" || check.state === "in_progress",
        ).length,
        observedVersion: version(normalized),
      };
    },

    async createPullRequest(input) {
      assertValid(CreatePullRequestInputV1, input, "CreatePullRequestInputV1");
      const record = createPrRecord({
        ...input,
        body: input.body.trimEnd(),
        headSha: context.ids.next("conformance-sha"),
      });
      trace("createPullRequest", { pullRequestId: record.pullRequestId });
      return pullRequestV1(record);
    },

    async findPullRequests(repositoryId, sourceBranch, targetBranch) {
      return [...pullRequests.values()]
        .filter(
          (pr) =>
            pr.repositoryId === repositoryId &&
            pr.sourceBranch === sourceBranch &&
            pr.targetBranch === targetBranch,
        )
        .map(pullRequestV1);
    },

    async markReady(id) {
      requirePr(id, "markReady").draft = false;
    },

    async getChecks(id) {
      const pr = requirePr(id, "getChecks");
      const fault = pr.faultProgramme.consume();
      if (fault !== undefined) throw new ConformanceFaultError(fault, isRetryable(fault));
      return [...pr.checks];
    },

    async getFailedCheckLogs(id) {
      return requirePr(id, "getFailedCheckLogs")
        .checks.filter((check) => check.state === "failed")
        .map(
          (check): CheckFailure => ({
            schemaVersion: 1,
            name: check.name,
            summary: `${check.name} failed.`,
            logExcerpt: "conformance harness failure log excerpt",
          }),
        );
    },

    async enableAutoMerge(id) {
      const pr = requirePr(id, "enableAutoMerge");
      const fault = pr.faultProgramme.consume();
      if (fault !== undefined) throw new ConformanceFaultError(fault, isRetryable(fault));
      if (pr.draft) throw new ConformanceFaultError("conflict", false);
      if (pr.staleHead) throw new ConformanceFaultError("conflict", false);
      pr.autoMergeEnabled = true;
    },
  };

  return {
    backend,
    arrange(arrangement): void {
      pendingArrangement = arrangement;
    },
  };
}

export const FAKE_FORGE_BACKEND_CAPABILITIES = [
  "lifecycle",
  "fault-conflict",
  "fault-stale-ref",
  "fault-disconnect",
  "fault-rate-limit",
] as const;

export function createFakeForgeBackendHarness(): ForgeBackendHarness {
  return {
    name: "fake-forge-backend",
    capabilities: FAKE_FORGE_BACKEND_CAPABILITIES,
    classifyFault: (error: unknown) => (isConformanceFaultError(error) ? error.kind : "unknown"),
    async createSubject(context: ConformanceContext) {
      const fake = createFakeForgeBackend(context);
      return {
        subject: fake.backend,
        async arrange(arrangement: ForgeArrangement): Promise<void> {
          fake.arrange(arrangement);
        },
        async dispose(): Promise<void> {},
      };
    },
  };
}
