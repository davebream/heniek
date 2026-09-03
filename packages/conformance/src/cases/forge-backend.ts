import assert from "node:assert/strict";
import type { ForgeBackendV3, PullRequestId, RepositoryId } from "@heniek/contracts";
import {
  CheckStatusV1,
  ForgeIssueMutationV1,
  ForgeIssueV1,
  ForgeRefMutationV1,
  ForgeRefV1,
  PullRequestMutationV1,
  PullRequestStatusV1,
  PullRequestV1,
  PullRequestV2,
} from "@heniek/contracts";
import type { ForgeArrangement } from "../contract/arrangement.js";
import type { ConformanceCase } from "../contract/case.js";
import { assertValid } from "../contract/validation.js";
import { createPullRequestInput } from "./fixtures.js";

type ForgeCase = ConformanceCase<ForgeBackendV3, ForgeArrangement>;

const REPOSITORY_ID = "repository-1" as RepositoryId;

function createIssueInput() {
  return {
    schemaVersion: 1 as const,
    repositoryId: REPOSITORY_ID,
    title: "Q047 conformance issue",
    body: "Exercise idempotent issue creation.",
    labels: ["conformance"],
    idempotencyKey: "forge-conformance-issue",
  };
}

async function prepareBranches(subject: ForgeBackendV3): Promise<void> {
  await subject.createOrAdoptBranch({
    schemaVersion: 1,
    repositoryId: REPOSITORY_ID,
    branchName: "main",
    targetSha: "base-sha",
  });
  await subject.createOrAdoptBranch({
    schemaVersion: 1,
    repositoryId: REPOSITORY_ID,
    branchName: "q047-forge",
    targetSha: "head-sha",
  });
}

function createPullRequestInputV2() {
  return {
    schemaVersion: 2 as const,
    repositoryId: REPOSITORY_ID,
    sourceBranch: "q047-forge",
    targetBranch: "main",
    title: "Q047 — forge primitives",
    body: "Closes #63",
    expectedHeadSha: "head-sha",
    idempotencyKey: "forge-conformance-pull-request",
  };
}

export const FORGE_BACKEND_CASES: readonly ForgeCase[] = [
  {
    id: "forge/create-pull-request-returns-contract-valid-pull-request",
    title: "createPullRequest() returns a contract-valid PullRequestV1",
    requires: ["lifecycle"],
    covers: ["AC1:lifecycle", "§21.6"],
    async run({ subject, arrange }) {
      await arrange({ kind: "clean" });
      const pr = await subject.createPullRequest(createPullRequestInput({ draft: false }));
      assertValid(PullRequestV1, pr, "PullRequestV1");
      assert.equal(pr.draft, false);
      assert.equal(pr.state, "open");
    },
  },
  {
    id: "forge/create-pull-request-honours-draft-true",
    title: "createPullRequest() honours draft: true",
    requires: ["lifecycle"],
    covers: ["AC1:lifecycle", "§21.5"],
    async run({ subject, arrange }) {
      await arrange({ kind: "clean" });
      const pr = await subject.createPullRequest(createPullRequestInput({ draft: true }));
      assertValid(PullRequestV1, pr, "PullRequestV1");
      assert.equal(pr.draft, true);
    },
  },
  {
    id: "forge/mark-ready-clears-draft",
    title: "markReady() clears draft",
    requires: ["lifecycle", "fault-conflict"],
    covers: ["AC1:lifecycle", "AC2:conflict", "§21.5"],
    async run({ subject, arrange, expectFault }) {
      await arrange({ kind: "clean" });
      const pr = await subject.createPullRequest(createPullRequestInput({ draft: true }));
      // Before markReady(), the draft-PR default (§21.5) makes enableAutoMerge a conflict.
      await expectFault(() => subject.enableAutoMerge(pr.pullRequestId), "conflict");
      await subject.markReady(pr.pullRequestId);
      // After markReady(), draft is cleared and enableAutoMerge no longer conflicts.
      await subject.enableAutoMerge(pr.pullRequestId);
    },
  },
  {
    id: "forge/mark-ready-is-idempotent",
    title: "markReady() is idempotent",
    requires: ["lifecycle"],
    covers: ["AC1:lifecycle"],
    async run({ subject, arrange }) {
      await arrange({ kind: "clean" });
      const pr = await subject.createPullRequest(createPullRequestInput({ draft: true }));
      await subject.markReady(pr.pullRequestId);
      // Idempotent means the *second* call must not throw AND must not
      // undo the effect of the first: draft stays cleared, observed
      // indirectly (ForgeBackend has no PR getter) via enableAutoMerge no
      // longer conflicting — a bare "does not throw" assertion (the
      // original version of this case) would also pass for a backend that
      // silently re-drafted the PR on the second call.
      await subject.markReady(pr.pullRequestId);
      await subject.enableAutoMerge(pr.pullRequestId);
    },
  },
  {
    id: "forge/mark-ready-rejects-unknown-pull-request-id",
    title: "markReady() classifies an unknown pull request id as stale_ref",
    requires: ["fault-stale-ref"],
    covers: ["AC2:stale-ref", "stale refs"],
    async run({ subject, expectFault }) {
      await expectFault(
        () => subject.markReady("conformance-unknown-pull-request" as PullRequestId),
        "stale_ref",
      );
    },
  },
  {
    id: "forge/get-checks-returns-contract-valid-check-statuses",
    title: "getChecks() returns contract-valid CheckStatusV1 entries",
    requires: ["lifecycle"],
    covers: ["AC1:lifecycle", "§21.6"],
    async run({ subject, arrange }) {
      await arrange({ kind: "checks", states: ["succeeded", "failed", "in_progress"] });
      const pr = await subject.createPullRequest(createPullRequestInput());
      const checks = await subject.getChecks(pr.pullRequestId);
      assert.equal(checks.length, 3);
      for (const check of checks) {
        assertValid(CheckStatusV1, check, "CheckStatusV1");
      }
    },
  },
  {
    id: "forge/get-failed-check-logs-returns-only-failed-checks",
    title: "getFailedCheckLogs() returns entries only for failed checks",
    requires: ["lifecycle"],
    covers: ["AC1:lifecycle", "§21.6"],
    async run({ subject, arrange }) {
      await arrange({ kind: "checks", states: ["succeeded", "failed", "failed"] });
      const pr = await subject.createPullRequest(createPullRequestInput());
      const failures = await subject.getFailedCheckLogs(pr.pullRequestId);
      assert.equal(failures.length, 2);
    },
  },
  {
    id: "forge/enable-auto-merge-on-draft-pr-is-a-conflict",
    title: "enableAutoMerge() on a draft PR is a conflict",
    requires: ["fault-conflict"],
    covers: ["AC2:conflict", "§21.5"],
    async run({ subject, arrange, expectFault }) {
      await arrange({ kind: "clean" });
      const pr = await subject.createPullRequest(createPullRequestInput({ draft: true }));
      await expectFault(() => subject.enableAutoMerge(pr.pullRequestId), "conflict");
    },
  },
  {
    id: "forge/enable-auto-merge-with-stale-head-is-a-conflict",
    title: "enableAutoMerge() with a stale head sha is a conflict",
    requires: ["fault-conflict"],
    covers: ["AC2:conflict", "§29"],
    async run({ subject, arrange, expectFault }) {
      await arrange({ kind: "stale-head" });
      const pr = await subject.createPullRequest(createPullRequestInput({ draft: false }));
      await expectFault(() => subject.enableAutoMerge(pr.pullRequestId), "conflict");
    },
  },
  {
    id: "forge/disconnect-is-classified-and-retryable",
    title: "a disconnect fault is classified and retryable",
    requires: ["fault-disconnect"],
    covers: ["AC2:disconnect", "disconnects"],
    async run({ subject, arrange, expectFault }) {
      await arrange({ kind: "injects-fault", fault: "disconnect", occurrences: 1 });
      const pr = await subject.createPullRequest(createPullRequestInput());
      await expectFault(() => subject.getChecks(pr.pullRequestId), "disconnect");
      const checks = await subject.getChecks(pr.pullRequestId);
      // `Array.isArray` alone is guaranteed by the return type and can
      // never fail — assert the actual expected value instead: no "checks"
      // arrangement was made for this PR, so the retried call must return
      // an empty list, not merely "an array".
      assert.deepEqual(checks, []);
    },
  },
  {
    id: "forge/rate-limit-is-classified",
    title: "a rate_limit fault is classified",
    requires: ["fault-rate-limit"],
    covers: ["AC2:rate-limit", "rate limits"],
    async run({ subject, arrange, expectFault }) {
      await arrange({ kind: "injects-fault", fault: "rate_limit", occurrences: 1 });
      const pr = await subject.createPullRequest(createPullRequestInput());
      await expectFault(() => subject.getChecks(pr.pullRequestId), "rate_limit");
    },
  },
  {
    id: "forge/issue-create-adopt-and-versioned-update",
    title: "issue primitives create, adopt, and return post-update versions",
    requires: ["lifecycle"],
    covers: ["AC1:lifecycle", "Q047:issue-idempotency", "Q047:observed-version"],
    async run({ subject }) {
      const created = await subject.createOrAdoptIssue(createIssueInput());
      assertValid(ForgeIssueMutationV1, created, "ForgeIssueMutationV1", [ForgeIssueV1]);
      assert.equal(created.disposition, "created");
      const adopted = await subject.createOrAdoptIssue(createIssueInput());
      assert.equal(adopted.disposition, "adopted");
      assert.equal(adopted.issue.issueId, created.issue.issueId);
      const updated = await subject.updateIssue({
        schemaVersion: 1,
        repositoryId: REPOSITORY_ID,
        number: created.issue.number,
        expectedObservedVersion: created.issue.observedVersion,
        patch: { title: "Q047 conformance issue updated" },
      });
      assert.equal(updated.disposition, "updated");
      assert.notEqual(updated.issue.observedVersion, created.issue.observedVersion);
      assert.equal(updated.issue.title, "Q047 conformance issue updated");
    },
  },
  {
    id: "forge/issue-update-rejects-stale-version",
    title: "issue update rejects an unexpected observed version",
    requires: ["lifecycle", "fault-conflict"],
    covers: ["AC2:conflict", "Q047:observed-version"],
    async run({ subject, expectFault }) {
      const created = await subject.createOrAdoptIssue(createIssueInput());
      await expectFault(
        () =>
          subject.updateIssue({
            schemaVersion: 1,
            repositoryId: REPOSITORY_ID,
            number: created.issue.number,
            expectedObservedVersion: "sha256:stale" as typeof created.issue.observedVersion,
            patch: { title: "A conflicting title" },
          }),
        "conflict",
      );
    },
  },
  {
    id: "forge/branch-create-adopt-and-exact-update",
    title: "branch primitives adopt exact refs and update with an expected SHA",
    requires: ["lifecycle"],
    covers: ["AC1:lifecycle", "Q047:branch-cas"],
    async run({ subject }) {
      const input = {
        schemaVersion: 1 as const,
        repositoryId: REPOSITORY_ID,
        branchName: "q047-branch",
        targetSha: "first-sha",
      };
      const created = await subject.createOrAdoptBranch(input);
      assertValid(ForgeRefMutationV1, created, "ForgeRefMutationV1", [ForgeRefV1]);
      assert.equal(created.disposition, "created");
      const adopted = await subject.createOrAdoptBranch(input);
      assert.equal(adopted.disposition, "adopted");
      const updated = await subject.updateBranch({
        schemaVersion: 1,
        repositoryId: REPOSITORY_ID,
        branchName: input.branchName,
        expectedHeadSha: "first-sha",
        targetHeadSha: "second-sha",
      });
      assert.equal(updated.disposition, "updated");
      assert.equal(updated.ref.headSha, "second-sha");
    },
  },
  {
    id: "forge/branch-update-rejects-unexpected-ref",
    title: "branch update rejects an unexpected ref without overwriting it",
    requires: ["lifecycle", "fault-stale-ref"],
    covers: ["AC2:stale-ref", "Q047:no-force"],
    async run({ subject, expectFault }) {
      await subject.createOrAdoptBranch({
        schemaVersion: 1,
        repositoryId: REPOSITORY_ID,
        branchName: "q047-stale-branch",
        targetSha: "observed-sha",
      });
      await expectFault(
        () =>
          subject.updateBranch({
            schemaVersion: 1,
            repositoryId: REPOSITORY_ID,
            branchName: "q047-stale-branch",
            expectedHeadSha: "unexpected-sha",
            targetHeadSha: "replacement-sha",
          }),
        "stale_ref",
      );
      const observed = await subject.getRef({
        schemaVersion: 1,
        repositoryId: REPOSITORY_ID,
        qualifiedRef: "refs/heads/q047-stale-branch",
      });
      assert.equal(observed?.headSha, "observed-sha");
    },
  },
  {
    id: "forge/pull-request-defaults-to-draft-and-adopts",
    title: "pull-request creation defaults to draft and adopts the linkage marker",
    requires: ["lifecycle"],
    covers: ["AC1:lifecycle", "§21.5", "Q047:pull-request-idempotency"],
    async run({ subject }) {
      await prepareBranches(subject);
      const created = await subject.createOrAdoptPullRequest(createPullRequestInputV2());
      assertValid(PullRequestMutationV1, created, "PullRequestMutationV1", [PullRequestV2]);
      assert.equal(created.disposition, "created");
      assert.equal(created.pullRequest.draft, true);
      assert.equal(created.pullRequest.headSha, "head-sha");
      const adopted = await subject.createOrAdoptPullRequest(createPullRequestInputV2());
      assert.equal(adopted.disposition, "adopted");
      assert.equal(adopted.pullRequest.pullRequestId, created.pullRequest.pullRequestId);
    },
  },
  {
    id: "forge/pull-request-update-fences-head-and-version",
    title: "pull-request updates fence metadata and head revisions",
    requires: ["lifecycle", "fault-stale-ref"],
    covers: ["AC2:stale-ref", "Q047:observed-version", "Q047:expected-head"],
    async run({ subject, expectFault }) {
      await prepareBranches(subject);
      const created = await subject.createOrAdoptPullRequest(createPullRequestInputV2());
      await expectFault(
        () =>
          subject.updatePullRequest({
            schemaVersion: 1,
            pullRequestId: created.pullRequest.pullRequestId,
            expectedObservedVersion: created.pullRequest.observedVersion,
            expectedHeadSha: "stale-head",
            draft: false,
          }),
        "stale_ref",
      );
      const ready = await subject.updatePullRequest({
        schemaVersion: 1,
        pullRequestId: created.pullRequest.pullRequestId,
        expectedObservedVersion: created.pullRequest.observedVersion,
        expectedHeadSha: created.pullRequest.headSha,
        draft: false,
      });
      assert.equal(ready.pullRequest.draft, false);
      const autoMerge = await subject.updatePullRequest({
        schemaVersion: 1,
        pullRequestId: ready.pullRequest.pullRequestId,
        expectedObservedVersion: ready.pullRequest.observedVersion,
        expectedHeadSha: ready.pullRequest.headSha,
        autoMergeEnabled: true,
      });
      assert.equal(autoMerge.pullRequest.autoMergeEnabled, true);
    },
  },
  {
    id: "forge/status-observation-summarizes-required-checks",
    title: "status observation reports mergeability and required-check counts",
    requires: ["lifecycle"],
    covers: ["AC1:lifecycle", "Q047:checks-summary", "Q047:mergeability"],
    async run({ subject, arrange }) {
      await prepareBranches(subject);
      await arrange({ kind: "checks", states: ["succeeded", "failed", "in_progress"] });
      const created = await subject.createOrAdoptPullRequest({
        ...createPullRequestInputV2(),
        draft: false,
      });
      const status = await subject.observePullRequestStatus(created.pullRequest.pullRequestId);
      assertValid(PullRequestStatusV1, status, "PullRequestStatusV1", [CheckStatusV1]);
      assert.equal(status.mergeability, "mergeable");
      assert.equal(status.totalCount, 3);
      assert.equal(status.requiredCount, 3);
      assert.equal(status.succeededCount, 1);
      assert.equal(status.failedCount, 1);
      assert.equal(status.pendingCount, 1);
      assert.notEqual(status.observedVersion, created.pullRequest.observedVersion);
    },
  },
];
