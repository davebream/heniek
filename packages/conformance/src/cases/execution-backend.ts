import assert from "node:assert/strict";
import type {
  ExecutionBackend,
  ExecutionStatus as ExecutionStatusValue,
  InteractionId,
} from "@heniek/contracts";
import { ExecutionResultV1, ExecutionStatus, PendingInteractionV1 } from "@heniek/contracts";
import type { ExecutionArrangement } from "../contract/arrangement.js";
import type { ConformanceCase } from "../contract/case.js";
import { EXECUTION_BACKEND_TRACE_ACTIONS, TRACE_ACTORS } from "../contract/harness.js";
import { assertValid } from "../contract/validation.js";
import { artifactRef, executionRequest } from "./fixtures.js";

type ExecutionCase = ConformanceCase<ExecutionBackend, ExecutionArrangement>;

const MAX_POLLS = 32;

/**
 * Polls `status()` until `predicate` is satisfied or `MAX_POLLS` is
 * reached. No timers, no waiting — obligation 3 on `ConformanceHarness`
 * (progress must be poll-driven). Throws when the predicate is never
 * satisfied within the poll budget: silently returning the last-seen status
 * would let a case that forgets to also assert on the returned value pass
 * vacuously even though the subject never reached the state under test.
 */
async function pollUntil(
  subject: ExecutionBackend,
  runId: string,
  predicate: (status: ExecutionStatusValue) => boolean,
): Promise<ExecutionStatusValue> {
  let status = await subject.status(runId);
  for (let polls = 1; polls < MAX_POLLS && !predicate(status); polls += 1) {
    status = await subject.status(runId);
  }
  if (!predicate(status)) {
    throw new Error(
      `pollUntil exhausted ${MAX_POLLS} polls for run "${runId}" without satisfying the ` +
        `predicate (last observed status: "${status}")`,
    );
  }
  return status;
}

async function pollUntilTerminal(
  subject: ExecutionBackend,
  runId: string,
): Promise<ExecutionStatusValue> {
  return pollUntil(subject, runId, (status) => ExecutionStatus.isTerminal(status));
}

export const EXECUTION_BACKEND_CASES: readonly ExecutionCase[] = [
  {
    id: "execution/start-returns-opaque-run-id",
    title: "start() returns a non-empty opaque run id",
    requires: ["lifecycle"],
    covers: ["AC1:start", "§22"],
    async run({ context, subject }) {
      const runId = await subject.start(executionRequest(context));
      assert.equal(typeof runId, "string");
      assert.ok(runId.length > 0, "run id must be non-empty");
    },
  },
  {
    id: "execution/start-rejects-contract-invalid-request",
    title: "start() rejects a contract-invalid request",
    requires: ["lifecycle"],
    covers: ["AC1:start", "§22"],
    async run({ context, subject, expectRejection }) {
      const request = executionRequest(context) as Record<string, unknown>;
      const { outputContract: _omitted, ...invalid } = request;
      await expectRejection(() =>
        subject.start(invalid as unknown as Parameters<ExecutionBackend["start"]>[0]),
      );
    },
  },
  {
    id: "execution/start-yields-distinct-run-ids",
    title: "start() yields a distinct run id per call",
    requires: ["lifecycle"],
    covers: ["AC1:start", "§22"],
    async run({ context, subject }) {
      const first = await subject.start(executionRequest(context));
      const second = await subject.start(executionRequest(context));
      assert.notEqual(first, second);
    },
  },
  {
    id: "execution/status-is-non-terminal-immediately-after-start",
    title: "status() is non-terminal immediately after start()",
    requires: ["lifecycle"],
    covers: ["AC1:status", "§22"],
    async run({ context, subject }) {
      const runId = await subject.start(executionRequest(context));
      const status = await subject.status(runId);
      assert.equal(ExecutionStatus.isTerminal(status), false);
    },
  },
  {
    id: "execution/status-reaches-declared-terminal-state",
    title: "status() reaches the declared terminal state",
    requires: ["lifecycle"],
    covers: ["AC1:status", "§22"],
    async run({ context, subject, arrange }) {
      await arrange({ kind: "completes", status: "succeeded" });
      const runId = await subject.start(executionRequest(context));
      const final = await pollUntilTerminal(subject, runId);
      assert.ok(ExecutionStatus.values.includes(final), `unexpected status value: ${final}`);
      assert.equal(ExecutionStatus.isTerminal(final), true);
    },
  },
  {
    id: "execution/status-is-stable-once-terminal",
    title: "status() stays terminal once terminal is reached",
    requires: ["lifecycle"],
    covers: ["AC1:status", "§22"],
    async run({ context, subject, arrange }) {
      await arrange({ kind: "completes", status: "succeeded" });
      const runId = await subject.start(executionRequest(context));
      const final = await pollUntilTerminal(subject, runId);
      assert.equal(ExecutionStatus.isTerminal(final), true);
      const again = await subject.status(runId);
      const yetAgain = await subject.status(runId);
      assert.equal(again, final);
      assert.equal(yetAgain, final);
    },
  },
  {
    id: "execution/status-rejects-unknown-run-id",
    title: "status() classifies an unknown run id as stale_ref",
    requires: ["fault-stale-ref"],
    covers: ["AC2:stale-ref", "stale refs"],
    async run({ subject, expectFault }) {
      await expectFault(() => subject.status("conformance-unknown-run-id"), "stale_ref");
    },
  },
  {
    id: "execution/interactions-are-empty-when-not-waiting",
    title: "interactions() is empty when the run is not waiting on the user",
    requires: ["lifecycle"],
    covers: ["AC1:interaction", "§22"],
    async run({ context, subject }) {
      const runId = await subject.start(executionRequest(context));
      const pending = await subject.interactions(runId);
      assert.deepEqual(pending, []);
    },
  },
  {
    id: "execution/interaction-is-surfaced-as-contract-valid-pending-interaction",
    title: "a surfaced interaction is a contract-valid PendingInteractionV1",
    requires: ["interaction"],
    covers: ["AC1:interaction", "§23.5"],
    async run({ context, subject, arrange }) {
      await arrange({ kind: "asks-question", interactionKind: "single_choice" });
      const runId = await subject.start(executionRequest(context));
      await pollUntil(subject, runId, (status) => status === "waiting_on_user");
      const pending = await subject.interactions(runId);
      assert.equal(pending.length, 1);
      const [interaction] = pending;
      assertValid(PendingInteractionV1, interaction, "PendingInteractionV1");
      assert.equal(interaction?.kind, "single_choice");
    },
  },
  {
    id: "execution/interaction-moves-status-to-waiting-on-user",
    title: "an arranged interaction moves status() to waiting_on_user",
    requires: ["interaction"],
    covers: ["AC1:interaction"],
    async run({ context, subject, arrange }) {
      await arrange({ kind: "asks-question", interactionKind: "free_text" });
      const runId = await subject.start(executionRequest(context));
      const status = await pollUntil(subject, runId, (value) => value === "waiting_on_user");
      assert.equal(status, "waiting_on_user");
    },
  },
  {
    id: "execution/answer-resolves-the-pending-interaction",
    title: "answer() resolves the pending interaction and the run continues",
    requires: ["interaction"],
    covers: ["AC1:answer", "§23.5"],
    async run({ context, subject, arrange }) {
      await arrange({ kind: "asks-question", interactionKind: "free_text" });
      const runId = await subject.start(executionRequest(context));
      await pollUntil(subject, runId, (status) => status === "waiting_on_user");
      const [pending] = await subject.interactions(runId);
      assert.ok(pending, "expected a pending interaction");
      await subject.answer(runId, pending.id, "conformance answer");
      const final = await pollUntilTerminal(subject, runId);
      assert.equal(ExecutionStatus.isTerminal(final), true);
    },
  },
  {
    id: "execution/answer-rejects-unknown-interaction-id",
    title: "answer() classifies an unknown interaction id as stale_ref",
    requires: ["interaction"],
    covers: ["AC1:answer"],
    async run({ context, subject, arrange, expectFault }) {
      await arrange({ kind: "asks-question", interactionKind: "single_choice" });
      const runId = await subject.start(executionRequest(context));
      const status = await pollUntil(subject, runId, (value) => value === "waiting_on_user");
      // Without this assertion the case could pass vacuously: any status
      // other than "waiting_on_user" with no matching pending interaction
      // also classifies as stale_ref (see `fakes/execution-backend.ts`'s
      // `answer()`), so the case must independently prove the run actually
      // entered waiting_on_user before it exercises the unknown-id path.
      assert.equal(status, "waiting_on_user");
      await expectFault(
        () => subject.answer(runId, "conformance-unknown-interaction" as InteractionId, "x"),
        "stale_ref",
      );
    },
  },
  {
    id: "execution/answer-is-rejected-after-terminal",
    title: "answer() classifies a call after terminal as conflict",
    requires: ["interaction"],
    covers: ["AC1:answer"],
    async run({ context, subject, arrange, expectFault }) {
      await arrange({ kind: "completes", status: "succeeded" });
      const runId = await subject.start(executionRequest(context));
      await pollUntilTerminal(subject, runId);
      await expectFault(
        () => subject.answer(runId, "conformance-any-interaction" as InteractionId, "x"),
        "conflict",
      );
    },
  },
  {
    id: "execution/resume-continues-and-records-input-artifacts",
    title: "resume() records the supplied input artifact refs",
    requires: ["resume"],
    covers: ["AC1:resume", "§23.5"],
    async run({ context, subject }) {
      const runId = await subject.start(executionRequest(context));
      const ref = artifactRef(context);
      await subject.resume(runId, [ref]);
      // Portable across every ExecutionBackend implementation: `actor` and
      // `action` are the shared, family-level trace labels documented on
      // `ConformanceHarness` (obligation 7), not this bundled fake's own
      // implementation name — see harness.ts.
      const recorded = context.trace.events.filter(
        (event) =>
          event.actor === TRACE_ACTORS.executionBackend &&
          event.action === EXECUTION_BACKEND_TRACE_ACTIONS.resume,
      );
      const last = recorded.at(-1);
      assert.ok(last, "expected a recorded resume trace event");
      assert.deepEqual(last.detail, { runId, inputArtifactRefs: [ref] });
    },
  },
  {
    id: "execution/resume-rejects-unknown-run-id",
    title: "resume() classifies an unknown run id as stale_ref",
    requires: ["resume", "fault-stale-ref"],
    covers: ["AC2:stale-ref", "stale refs"],
    async run({ subject, expectFault }) {
      await expectFault(() => subject.resume("conformance-unknown-run-id", []), "stale_ref");
    },
  },
  {
    id: "execution/result-is-rejected-before-terminal",
    title: "result() rejects before the run reaches a terminal state",
    requires: ["lifecycle"],
    covers: ["AC1:result", "§22"],
    async run({ context, subject, expectRejection }) {
      const runId = await subject.start(executionRequest(context));
      await expectRejection(() => subject.result(runId));
    },
  },
  {
    id: "execution/result-matches-execution-result-contract",
    title: "result() matches the ExecutionResultV1 contract",
    requires: ["lifecycle"],
    covers: ["AC1:result", "§23.5"],
    async run({ context, subject, arrange }) {
      await arrange({ kind: "completes", status: "succeeded" });
      const runId = await subject.start(executionRequest(context));
      await pollUntilTerminal(subject, runId);
      const result = await subject.result(runId);
      assertValid(ExecutionResultV1, result, "ExecutionResultV1");
      assert.ok(["succeeded", "failed", "cancelled"].includes(result.status));
      for (const value of Object.values(result.artifacts)) {
        assert.equal(typeof value, "string");
        assert.ok((value as string).length > 0);
      }
    },
  },
  {
    id: "execution/cancel-transitions-to-cancelled-and-result-agrees",
    title: "cancel() transitions the run to cancelled and result() agrees",
    requires: ["cancellation"],
    covers: ["AC1:cancellation", "§29"],
    async run({ context, subject }) {
      const runId = await subject.start(executionRequest(context));
      await subject.cancel(runId);
      const status = await subject.status(runId);
      assert.equal(status, "cancelled");
      const result = await subject.result(runId);
      assertValid(ExecutionResultV1, result, "ExecutionResultV1");
      assert.equal(result.status, "cancelled");
    },
  },
  {
    id: "execution/cancel-is-idempotent",
    title: "cancel() is idempotent",
    requires: ["cancellation"],
    covers: ["AC1:cancellation"],
    async run({ context, subject }) {
      const runId = await subject.start(executionRequest(context));
      await subject.cancel(runId);
      await subject.cancel(runId);
      const status = await subject.status(runId);
      assert.equal(status, "cancelled");
    },
  },
  {
    id: "execution/malformed-result-is-rejected-not-returned",
    title: "a malformed result is rejected, not returned",
    requires: ["malformed-response"],
    covers: ["AC1:malformed", "§23.5"],
    async run({ context, subject, arrange, expectFault }) {
      await arrange({ kind: "emits-malformed-result" });
      const runId = await subject.start(executionRequest(context));
      await pollUntilTerminal(subject, runId);
      await expectFault(() => subject.result(runId), "malformed_response");
    },
  },
  {
    id: "execution/disconnect-is-classified-and-retryable",
    title: "a disconnect fault is classified and retryable",
    requires: ["fault-disconnect"],
    covers: ["AC2:disconnect", "disconnects"],
    async run({ context, subject, arrange, expectFault }) {
      await arrange({ kind: "injects-fault", fault: "disconnect", occurrences: 1 });
      const runId = await subject.start(executionRequest(context));
      await expectFault(() => subject.status(runId), "disconnect");
      const status = await subject.status(runId);
      assert.ok(ExecutionStatus.values.includes(status));
    },
  },
  {
    id: "execution/rate-limit-is-classified-and-retryable",
    title: "a rate_limit fault is classified and retryable",
    requires: ["fault-rate-limit"],
    covers: ["AC2:rate-limit", "rate limits"],
    async run({ context, subject, arrange, expectFault }) {
      await arrange({ kind: "injects-fault", fault: "rate_limit", occurrences: 1 });
      const runId = await subject.start(executionRequest(context));
      await expectFault(() => subject.status(runId), "rate_limit");
      const status = await subject.status(runId);
      assert.ok(ExecutionStatus.values.includes(status));
    },
  },
  {
    id: "execution/crash-requires-explicit-recovery-then-resumes",
    title: "a crash requires explicit recovery, then resume() continues the run",
    requires: ["fault-crash-recovery", "resume"],
    covers: ["AC2:crash-recovery", "§18.2"],
    async run({ context, subject, arrange, expectRejection }) {
      await arrange({ kind: "injects-fault", fault: "crash", occurrences: 1 });
      const runId = await subject.start(executionRequest(context));
      const status = await subject.status(runId);
      assert.equal(status, "recovery_required");
      await expectRejection(() => subject.result(runId));
      await subject.resume(runId, []);
      const final = await pollUntilTerminal(subject, runId);
      assert.equal(ExecutionStatus.isTerminal(final), true);
      const result = await subject.result(runId);
      assertValid(ExecutionResultV1, result, "ExecutionResultV1");
    },
  },
];
