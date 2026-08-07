/**
 * Restart-reconciliation classification (design C12, plan Task 4).
 *
 * The table is asserted entry by entry, and then the two properties the table
 * exists to enforce are asserted independently of it — so a future edit that
 * quietly makes an unresolvable run resumable fails on the property test even
 * if someone updated the row to match.
 */

import { ExecutionStatus } from "@heniek/contracts";
import { describe, expect, it } from "vitest";
import {
  classifyRunRecovery,
  type RunProbeOutcome,
  type RunRecoveryDecision,
} from "../src/recovery/classify.js";

function probed(status: ExecutionStatus): RunRecoveryDecision {
  return classifyRunRecovery({ kind: "status", status });
}

describe("classifyRunRecovery — the design C12 table", () => {
  it.each([
    ["failed", "failed", "failed"],
    ["cancelled", "cancelled", "cancelled"],
    ["succeeded", "resumable", "succeeded"],
    ["queued", "resumable", "queued"],
    ["running", "resumable", "running"],
    ["waiting_on_user", "resumable", "waiting_on_user"],
    ["recovery_required", "unknown", "recovery_required"],
  ] as const)("%s → %s / %s", (status, classification, runStatus) => {
    expect(probed(status)).toEqual({ classification, runStatus, probeOutcome: "status" });
  });

  it("a failed probe is unknown / recovery_required", () => {
    expect(classifyRunRecovery({ kind: "error" })).toEqual({
      classification: "unknown",
      runStatus: "recovery_required",
      probeOutcome: "error",
    });
  });
});

describe("classifyRunRecovery — totality", () => {
  it("classifies every ExecutionStatus the contract defines", () => {
    // Guards the table against a status being added to the contract and
    // silently going unhandled. The `switch` has no `default`, so this pairs
    // with a typecheck failure rather than replacing it.
    for (const status of ExecutionStatus.values) {
      const decision = probed(status);
      expect(decision.classification).toBeDefined();
      expect(decision.runStatus).toBeDefined();
    }
  });

  it("is a pure function of its input", () => {
    const outcome: RunProbeOutcome = { kind: "status", status: "running" };

    expect(classifyRunRecovery(outcome)).toEqual(classifyRunRecovery(outcome));
  });
});

describe("classifyRunRecovery — the properties the table encodes", () => {
  it("never resumes a run whose status could not be resolved", () => {
    // The double-execution hazard: if an unresolvable run classified as
    // resumable, a restarted daemon could start work that is still running
    // elsewhere.
    const unresolvable: RunProbeOutcome[] = [
      { kind: "error" },
      { kind: "status", status: "recovery_required" },
    ];

    for (const outcome of unresolvable) {
      const decision = classifyRunRecovery(outcome);
      expect(decision.classification).toBe("unknown");
      expect(decision.runStatus).toBe("recovery_required");
    }
  });

  it("only classifies as resumable when the backend gave a definitive answer", () => {
    const resumable = ExecutionStatus.values.filter(
      (status) => probed(status).classification === "resumable",
    );

    expect(resumable).toEqual(["queued", "running", "waiting_on_user", "succeeded"]);
  });

  it("preserves a live run's own status rather than overwriting it", () => {
    // The backend is authoritative about work it is still carrying; projecting
    // anything else here would discard live progress.
    for (const status of ["queued", "running", "waiting_on_user"] as const) {
      expect(probed(status).runStatus).toBe(status);
    }
  });

  it("maps every terminal backend status onto the same terminal run status", () => {
    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      expect(probed(status).runStatus).toBe(status);
    }
  });

  it("records how the answer was obtained, so the pass stays auditable", () => {
    expect(probed("running").probeOutcome).toBe("status");
    expect(classifyRunRecovery({ kind: "error" }).probeOutcome).toBe("error");
  });
});
