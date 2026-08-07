import assert from "node:assert/strict";
import { ExecutionStatus } from "@heniek/contracts";
import { describe, expect, it } from "vitest";
import { executionRequest } from "../src/cases/fixtures.js";
import { type ConformanceFaultError, isConformanceFaultError } from "../src/contract/fault.js";
import { createFakeExecutionBackend } from "../src/fakes/execution-backend.js";
import { createConformanceContext } from "../src/kernel/context.js";
import { DEFAULT_SEED } from "../src/kernel/seed.js";
import { createSubprocessExecutionBackend } from "../src/smoke/subprocess-execution-backend.js";

// RT3: one test per real defect discovered while implementing this package.
// Each test is named `regression: <what broke>` and pins the fix behaviourally
// (by driving the actual subject and observing its actual behaviour), not by
// grepping source text — a source-text grep only proves a particular string
// is or isn't present, which is brittle to any harmless refactor and proves
// nothing about whether the defect is actually fixed.

describe("regressions", () => {
  it("regression: an injected crash did not check for an already-terminal run, so it could un-terminalise a finished run", async () => {
    // MAJOR-2 / critic blocking item 1. `src/fakes/execution-backend.ts`'s
    // `status()` handled the `crash` fault before any terminal guard, so a
    // crash fault injected onto a run that had already reached a terminal
    // state (e.g. "succeeded") transitioned it to "recovery_required" —
    // the fake violating its own `execution/status-is-stable-once-terminal`
    // invariant, and not modelling the §18.2/§29 crash-*during-a-run*
    // scenario the design specifies (a crash can only interrupt a run still
    // in flight). This exercises the fake's own escape-valve arrangement API
    // (`arrange(existingRunId, …)`, the same mechanism `src/replay.ts` uses)
    // because the neutral, harness-level `ConformanceSubject.arrange()` can
    // only configure the *next* run to be started (obligation 1 on
    // `ConformanceHarness`) — it cannot inject a fault onto a run that has
    // already completed, so this invariant cannot be expressed as a
    // provider-neutral catalogue case; it is a property of this fake's own
    // fault-injection escape valve, mirroring `src/replay.ts`'s own use of it.
    const context = createConformanceContext(DEFAULT_SEED);
    const fake = createFakeExecutionBackend(context);

    fake.arrange("next", { kind: "completes", status: "succeeded" });
    const runId = await fake.backend.start(executionRequest(context));

    let status = await fake.backend.status(runId); // queued -> running
    while (!ExecutionStatus.isTerminal(status)) {
      status = await fake.backend.status(runId);
    }
    assert.equal(status, "succeeded");

    fake.arrange(runId, { kind: "injects-fault", fault: "crash", occurrences: 1 });

    await assert.rejects(
      () => fake.backend.status(runId),
      (error: unknown) => {
        assert.ok(isConformanceFaultError(error));
        assert.equal((error as ConformanceFaultError).kind, "conflict");
        return true;
      },
    );

    // The run must still report its original terminal status — a crash
    // fault must never un-terminalise it.
    const after = await fake.backend.status(runId);
    assert.equal(after, "succeeded");
  });

  it("regression: subprocess smoke adapter's start() pre-consumed the ready handshake, breaking status() non-terminal-after-start", async () => {
    // `createSubprocessExecutionBackend`'s `start()` originally awaited the
    // child's "ready" message before returning, to "synchronize" with the
    // real process. The bundled child writes "ready" and its result
    // back-to-back with no real delay, so by the time the first `status()`
    // poll ran, it consumed the *next* queued message (the result) and
    // landed on a terminal status immediately — failing
    // "execution/status-is-non-terminal-immediately-after-start" against
    // the opt-in smoke harness. Fixed by leaving `start()` non-consuming
    // (status stays "queued" until the first poll), mirroring the fakes'
    // contract where `start()` never itself advances the run's phase.
    //
    // Exercised behaviourally (spawns the real, bundled child process — the
    // same programme the opt-in smoke suite uses, and always deterministic
    // given the child's near-instantaneous write of both messages) rather
    // than by grepping source text, which only proves a particular string
    // is present or absent and can be defeated by any harmless refactor.
    const context = createConformanceContext(DEFAULT_SEED);
    const adapter = createSubprocessExecutionBackend(context);
    try {
      const runId = await adapter.backend.start(executionRequest(context));
      const status = await adapter.backend.status(runId);
      expect(ExecutionStatus.isTerminal(status)).toBe(false);
    } finally {
      await adapter.dispose();
    }
  });
});
