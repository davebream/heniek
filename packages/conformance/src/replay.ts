import { executionRequest } from "./cases/fixtures.js";
import { createFakeExecutionBackend } from "./fakes/execution-backend.js";
import { createConformanceContext } from "./kernel/context.js";
import { DEFAULT_SEED, type Seed } from "./kernel/seed.js";
import type { TraceEvent } from "./kernel/trace.js";

/** Every step in the scripted scenario is expected to either resolve or throw; both are fine. */
async function attempt(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    // Expected: the fault or rejection is already captured in the trace
    // recorder by the fake backend itself before it throws.
  }
}

export interface FailureReplay {
  readonly seed: number;
  readonly events: readonly TraceEvent[];
}

/**
 * Drives the fake execution backend through a fixed, deterministic failure
 * scenario — disconnect → rate_limit → crash-while-running →
 * recovery_required → explicit resume → malformed result — and returns the
 * recorded trace (RE2). Pure and deterministic: the same seed always
 * reproduces byte-identical output (RT1), which is what
 * `generated/failure-replay.json` pins.
 *
 * The crash is deliberately injected while the run is still `running` — not
 * after it has already reached `succeeded` — so this artifact genuinely
 * models the §18.2/§29 crash-during-run → `recovery_required` → explicit
 * `resume()` path. (A prior revision injected the crash after the run had
 * already reached `succeeded`, so the recorded transition was
 * `succeeded → recovery_required`: the fake violating its own terminal-state
 * invariant, not the crash-recovery scenario the design specifies. See
 * `fakes/execution-backend.ts`'s terminal guard on the `crash` fault branch
 * and `execution/crash-fault-cannot-un-terminalise-a-terminal-run` in
 * `test/regressions.test.ts`.)
 */
export async function recordFailureReplay(seedValue: Seed = DEFAULT_SEED): Promise<FailureReplay> {
  const context = createConformanceContext(seedValue);
  const fake = createFakeExecutionBackend(context);

  fake.arrange("next", { kind: "emits-malformed-result" });
  const runId = await fake.backend.start(executionRequest(context));

  fake.arrange(runId, { kind: "injects-fault", fault: "disconnect", occurrences: 1 });
  await attempt(() => fake.backend.status(runId)); // disconnect, classified + retryable
  await attempt(() => fake.backend.status(runId)); // retried: queued -> running

  fake.arrange(runId, { kind: "injects-fault", fault: "crash", occurrences: 1 });
  await attempt(() => fake.backend.status(runId)); // crash while running -> recovery_required

  await attempt(() => fake.backend.result(runId)); // rejected: non-terminal (recovery pending)
  await attempt(() => fake.backend.resume(runId, [])); // explicit recovery: recovery_required -> running

  fake.arrange(runId, { kind: "injects-fault", fault: "rate_limit", occurrences: 1 });
  await attempt(() => fake.backend.status(runId)); // rate_limit, classified + retryable
  await attempt(() => fake.backend.status(runId)); // retried: running -> succeeded

  await attempt(() => fake.backend.result(runId)); // rejected: malformed_response

  return context.trace.toJson();
}
