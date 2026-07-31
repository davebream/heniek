import assert from "node:assert/strict";
import type { ForgeBackend, PullRequestId } from "@heniek/contracts";
import { CheckStatusV1, PullRequestV1 } from "@heniek/contracts";
import type { ForgeArrangement } from "../contract/arrangement.js";
import type { ConformanceCase } from "../contract/case.js";
import { assertValid } from "../contract/validation.js";
import { createPullRequestInput } from "./fixtures.js";

type ForgeCase = ConformanceCase<ForgeBackend, ForgeArrangement>;

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
];
