/**
 * Restart-reconciliation classification (design C12, plan Task 4).
 *
 * A **total, pure** function from one backend probe outcome to the pair
 * `(RunRecoveryClass, RunStatus)` the reconciler commits. No I/O, no clock,
 * no randomness — every branch is a plain unit test, and the same inputs
 * classify identically on every machine and every restart.
 *
 * Two properties this function exists to guarantee:
 *
 * - **No stored PID or process handle is ever consulted** (OR-8/IR-14). The
 *   only evidence admitted is what the backend answered *now*. A pid
 *   recorded before a crash says nothing after one — the number may have
 *   been recycled onto an unrelated process.
 * - **A run is never silently resumed on missing evidence.** Anything the
 *   backend could not answer becomes `unknown` / `recovery_required`, which
 *   is §18.2 verbatim. Guessing `resumable` here would let a crashed daemon
 *   restart work that may still be running elsewhere.
 *
 * `probeOutcome` is `"status" | "error"` with no `"absent"` member, matching
 * `RunRecoveryClassification/v1`: `ExecutionBackend.status()` has no
 * unknown-run channel and contracts define no typed not-found error, so a
 * conforming backend can only ever produce those two. A backend that cannot
 * resolve a run is an `"error"`, not a third outcome.
 */

import type { ExecutionStatus, RunRecoveryClass, RunStatus } from "@heniek/contracts";

/**
 * What probing one run yielded. `"error"` covers every way the answer failed
 * to arrive — the call threw, or the backend does not know this run — because
 * both are, to the reconciler, the same fact: no usable evidence.
 */
export type RunProbeOutcome =
  | { readonly kind: "status"; readonly status: ExecutionStatus }
  | { readonly kind: "error" };

export interface RunRecoveryDecision {
  readonly classification: RunRecoveryClass;
  /** The status to project onto the run. */
  readonly runStatus: RunStatus;
  /** Recorded on `RunRecoveryClassification/v1` so the pass is auditable after the fact. */
  readonly probeOutcome: "status" | "error";
}

/**
 * The design C12 table, exhaustively. The `switch` has no `default`: adding a
 * member to `ExecutionStatus` must fail the typecheck here rather than fall
 * through to some default classification, because an unenumerated status
 * silently treated as resumable is precisely the double-execution bug this
 * whole pass exists to prevent.
 */
export function classifyRunRecovery(outcome: RunProbeOutcome): RunRecoveryDecision {
  if (outcome.kind === "error") {
    return { classification: "unknown", runStatus: "recovery_required", probeOutcome: "error" };
  }

  switch (outcome.status) {
    case "failed":
      return { classification: "failed", runStatus: "failed", probeOutcome: "status" };

    case "cancelled":
      return { classification: "cancelled", runStatus: "cancelled", probeOutcome: "status" };

    // `succeeded` classifies as `resumable` rather than as its own class: the
    // run is resumable in the sense that the daemon can pick it up and finish
    // settling it, and it is immediately settled because the terminal status
    // is already known. It is deliberately not `unknown` — the backend gave a
    // definitive answer.
    case "succeeded":
      return { classification: "resumable", runStatus: "succeeded", probeOutcome: "status" };

    // The probed status is projected unchanged: the backend is authoritative
    // about work it is still carrying, and overwriting it here would discard
    // live progress.
    case "queued":
    case "running":
    case "waiting_on_user":
      return { classification: "resumable", runStatus: outcome.status, probeOutcome: "status" };

    // The backend answered, but its answer is itself "I do not know" — which
    // carries exactly as much resumption authority as no answer at all.
    case "recovery_required":
      return {
        classification: "unknown",
        runStatus: "recovery_required",
        probeOutcome: "status",
      };
  }
}
