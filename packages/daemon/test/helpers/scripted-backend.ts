/**
 * A scripted `ExecutionBackend` for reconciliation tests (design C17).
 *
 * Every answer is scripted, so a reconciliation run is reproducible
 * byte-for-byte across machines: no wall clock, no randomness, no timers, no
 * process spawning, no filesystem, no network.
 *
 * **The four mutating methods throw on invocation, and that is the point.**
 * It is not defensive coding — it *is* the IR-16 assertion. Design C12 says
 * the reconciliation pass never calls `start`, and that `resume`, `retry` and
 * `cancel` remain explicit operator decisions surfaced through
 * `daemon.recovery`. A backend whose mutators throw turns "the pass must not
 * duplicate a write attempt" from a claim into something a test cannot help
 * but check: any pass that reached for one fails loudly instead of silently
 * restarting work that may still be running elsewhere.
 *
 * `interactions` and `result` throw too, with a different message. The
 * reconciler does not call them either, but they are reads — their throwing
 * says "no script covers this", not "a forbidden write was attempted", and
 * conflating the two would blunt the assertion above.
 *
 * A **local helper on purpose**, not an import of
 * `packages/conformance/src/fakes/execution-backend.ts`: a workspace
 * dependency from `@heniek/daemon` onto `@heniek/conformance` would invert
 * the intended dependency direction, and duplication here is the recorded
 * no-cross-package-coupling trade-off (see
 * `packages/state/test/no-ambient-sources.test.ts`).
 */

import type { ExecutionBackend, ExecutionStatus } from "@heniek/contracts";

/** One answer, consumed by one `status()` call. */
export type ScriptedAnswer =
  | { readonly kind: "status"; readonly status: ExecutionStatus }
  /** The backend call rejects — the reconciler must classify this `unknown`. */
  | { readonly kind: "throws"; readonly message?: string }
  /**
   * The backend does not know this run. `ExecutionBackend.status()` has no
   * unknown-run channel and contracts define no typed not-found error, so a
   * conforming backend can only signal it by rejecting — which is exactly
   * what this does. It is a distinct authoring marker, not a distinct wire
   * outcome.
   */
  | { readonly kind: "unknown-run" };

/** Answers for one run, consumed in order — one per `status()` call. */
export type ScriptedRunProgram = readonly ScriptedAnswer[];

export interface BackendCall {
  readonly method: keyof ExecutionBackend;
  readonly runId: string;
}

export interface ScriptedBackend extends ExecutionBackend {
  /** Every call made, in order, so a test can prove `status()` ran exactly once per non-terminal run. */
  readonly calls: readonly BackendCall[];
  /** Calls to `status` for `runId`, the count reconciliation idempotence is asserted on. */
  statusCallsFor(runId: string): number;
}

/** Thrown when a test's script does not cover a call the code under test made. */
export class UnscriptedCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnscriptedCallError";
  }
}

/** Thrown by the four mutators — reaching one is an IR-16 violation, not a missing script. */
export class ForbiddenBackendWriteError extends Error {
  constructor(method: string) {
    super(
      `reconciliation called ExecutionBackend.${method}(), which it must never do (design C12, IR-16)`,
    );
    this.name = "ForbiddenBackendWriteError";
  }
}

export function createScriptedBackend(
  script: Record<string, ScriptedRunProgram>,
): ScriptedBackend {
  const calls: BackendCall[] = [];
  // Consumed positions per run, so a second `status()` on the same run gets
  // the *next* scripted answer rather than repeating the first.
  const consumed = new Map<string, number>();

  function record(method: keyof ExecutionBackend, runId: string): void {
    calls.push({ method, runId });
  }

  function forbid(method: keyof ExecutionBackend): never {
    // Recorded before throwing: a test that catches the throw can still prove
    // which method the pass reached for.
    record(method, "");
    throw new ForbiddenBackendWriteError(method);
  }

  return {
    calls,

    statusCallsFor(runId: string): number {
      return calls.filter((call) => call.method === "status" && call.runId === runId).length;
    },

    async status(runId: string): Promise<ExecutionStatus> {
      record("status", runId);

      const program = script[runId];
      if (program === undefined) {
        throw new UnscriptedCallError(`no script for run ${runId}`);
      }

      const index = consumed.get(runId) ?? 0;
      const answer = program[index];
      if (answer === undefined) {
        throw new UnscriptedCallError(
          `script for run ${runId} supplied ${program.length} answer(s); status() was called ${index + 1} time(s)`,
        );
      }
      consumed.set(runId, index + 1);

      if (answer.kind === "status") {
        return answer.status;
      }
      if (answer.kind === "unknown-run") {
        throw new UnscriptedCallError(`backend does not know run ${runId}`);
      }
      throw new Error(answer.message ?? `backend failed probing run ${runId}`);
    },

    // ---- the four the reconciliation pass must never call --------------
    start: () => forbid("start"),
    answer: () => forbid("answer"),
    resume: () => forbid("resume"),
    cancel: () => forbid("cancel"),

    // ---- reads the reconciler also does not use ------------------------
    interactions: (runId: string) => {
      record("interactions", runId);
      return Promise.reject(new UnscriptedCallError(`interactions() is not scripted (${runId})`));
    },
    result: (runId: string) => {
      record("result", runId);
      return Promise.reject(new UnscriptedCallError(`result() is not scripted (${runId})`));
    },
  };
}
