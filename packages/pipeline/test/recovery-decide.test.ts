/**
 * Recovery decision strategies, budgets, HITL, and fail-closed paths.
 */

import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/recovery/classify.js";
import { type DecideRecoveryInput, decideRecovery } from "../src/recovery/decide.js";

function baseInput(
  overrides: Partial<DecideRecoveryInput> & {
    failure: DecideRecoveryInput["failure"];
  },
): DecideRecoveryInput {
  return {
    runId: "run-1",
    stageId: "design",
    graphRevision: 1,
    generation: 1,
    attemptOrdinal: 1,
    now: "2026-08-09T12:00:00.000Z",
    stageType: "agent",
    executionMode: "autonomous",
    counters: { repairsUsed: 0, identicalSignatureCount: 0 },
    repairBudget: 3,
    resumeAvailable: true,
    ...overrides,
  };
}

describe("decideRecovery", () => {
  it("schedules repair_fresh for validation failures", () => {
    const failure = classifyFailure({
      classification: "validation_failed",
      phase: "validate",
      code: "schema",
      retryable: true,
    });
    const result = decideRecovery(
      baseInput({
        failure,
        onValidationFailure: { strategy: "repair_fresh" },
      }),
    );
    expect(result.kind).toBe("retry");
    if (result.kind !== "retry") {
      return;
    }
    expect(result.directive.mode).toBe("fresh");
    expect(result.directive.sessionPolicy).toBe("fresh");
    expect(result.recoveryDecision.outcome).toBe("repair_fresh");
    expect(result.nextCounters.repairsUsed).toBe(1);
  });

  it("proposes instead of dispatching in HITL mode", () => {
    const failure = classifyFailure({
      classification: "timeout",
      phase: "running",
      code: "timeout",
      retryable: true,
    });
    const result = decideRecovery(
      baseInput({
        failure,
        executionMode: "hitl",
        sessionPolicy: "fresh",
      }),
    );
    expect(result.kind).toBe("propose");
    if (result.kind !== "propose") {
      return;
    }
    expect(result.recoveryDecision.action).toBe("propose");
    expect(result.nextCounters.pendingProposalId).toMatch(/^prp:/);
    expect(result.nextCounters.repairsUsed).toBe(0);
  });

  it("fails closed on security failures", () => {
    const failure = classifyFailure({
      classification: "backend_failed",
      phase: "start",
      code: "auth",
      retryable: true,
      backendClassification: "authentication_failed",
    });
    const result = decideRecovery(baseInput({ failure, repairBudget: 3 }));
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") {
      return;
    }
    expect(result.reason).toBe("attempt_failed");
  });

  it("exhausts when repairsUsed reaches the budget", () => {
    const failure = classifyFailure({
      classification: "timeout",
      phase: "running",
      code: "timeout",
      retryable: true,
    });
    const result = decideRecovery(
      baseInput({
        failure,
        repairBudget: 2,
        counters: { repairsUsed: 2, identicalSignatureCount: 0 },
      }),
    );
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") {
      return;
    }
    expect(result.reason).toBe("repair_exhausted");
  });

  it("exhausts unchanged identical signatures at the budget", () => {
    const failure = classifyFailure({
      classification: "timeout",
      phase: "running",
      code: "timeout",
      retryable: true,
    });
    const first = decideRecovery(baseInput({ failure, repairBudget: 2 }));
    expect(first.kind).toBe("retry");
    if (first.kind !== "retry") {
      return;
    }
    const second = decideRecovery(
      baseInput({
        failure,
        repairBudget: 2,
        counters: first.nextCounters,
      }),
    );
    expect(second.kind).toBe("fail");
    if (second.kind !== "fail") {
      return;
    }
    expect(second.reason).toBe("unchanged_failure_exhausted");
  });

  it("blocks when resume is required but unavailable", () => {
    const failure = classifyFailure({
      classification: "validation_failed",
      phase: "validate",
      code: "schema",
      retryable: true,
    });
    const result = decideRecovery(
      baseInput({
        failure,
        onValidationFailure: { strategy: "repair" },
        resumeAvailable: false,
        priorAttemptId: "pa:run-1:1:design:1:1",
      }),
    );
    expect(result.kind).toBe("block");
    if (result.kind !== "block") {
      return;
    }
    expect(result.reason).toBe("resume_unavailable");
    expect(result.blockReason).toBe("resume_unavailable");
  });

  it("fails safely when validation policy is missing", () => {
    const failure = classifyFailure({
      classification: "validation_failed",
      phase: "validate",
      code: "schema",
      retryable: true,
    });
    const result = decideRecovery(baseInput({ failure }));
    expect(result.kind).toBe("fail");
    if (result.kind !== "fail") {
      return;
    }
    expect(result.reason).toBe("attempt_failed");
  });

  it("pauses validation failures when strategy is pause", () => {
    const failure = classifyFailure({
      classification: "validation_failed",
      phase: "validate",
      code: "schema",
      retryable: true,
    });
    const result = decideRecovery(
      baseInput({
        failure,
        onValidationFailure: { strategy: "pause" },
      }),
    );
    expect(result.kind).toBe("block");
    if (result.kind !== "block") {
      return;
    }
    expect(result.recoveryDecision.outcome).toBe("pause");
  });

  it("requires delegateTo for delegate strategy", () => {
    const failure = classifyFailure({
      classification: "validation_failed",
      phase: "validate",
      code: "schema",
      retryable: true,
    });
    const result = decideRecovery(
      baseInput({
        failure,
        onValidationFailure: { strategy: "delegate" },
      }),
    );
    expect(result.kind).toBe("fail");
  });
});
