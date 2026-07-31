import type { ConformanceCase, ConformanceCaseContext } from "../contract/case.js";
import type { FaultKind } from "../contract/fault.js";
import type { ConformanceHarness } from "../contract/harness.js";
import { createConformanceContext } from "../kernel/context.js";
import type { Seed } from "../kernel/seed.js";
import type { TraceEvent } from "../kernel/trace.js";

/**
 * Creates a fresh context and subject, runs one catalogue case against it,
 * and disposes the subject in a `finally` — no state leaks between cases,
 * which is a precondition for seed-replay determinism (RT1). Framework-free:
 * no vitest import, so the matrix generator can import this module without
 * pulling in a test framework. Returns the case's recorded trace events so
 * callers (e.g. `determinism.test.ts`) can compare traces across repeated
 * runs at the same seed without duplicating this wiring.
 */
export async function runConformanceCase<TSubject, TArrangement>(
  harness: ConformanceHarness<TSubject, TArrangement>,
  testCase: ConformanceCase<TSubject, TArrangement>,
  seedValue: Seed,
): Promise<readonly TraceEvent[]> {
  const context = createConformanceContext(seedValue);
  const subject = await harness.createSubject(context);

  try {
    const caseContext: ConformanceCaseContext<TSubject, TArrangement> = {
      context,
      harness,
      subject: subject.subject,

      arrange: (arrangement: TArrangement) => subject.arrange(arrangement),

      async expectFault(operation: () => Promise<unknown>, kind: FaultKind): Promise<void> {
        let caught: { readonly error: unknown } | undefined;
        try {
          await operation();
        } catch (error) {
          caught = { error };
        }
        if (caught === undefined) {
          throw new Error(
            `Expected harness "${harness.name}" to reject with fault "${kind}", but the operation resolved.`,
          );
        }
        const classified = harness.classifyFault(caught.error);
        if (classified !== kind) {
          throw new Error(
            `Expected harness "${harness.name}" to classify the fault as "${kind}", but observed "${classified}".`,
          );
        }
      },

      async expectRejection(operation: () => Promise<unknown>): Promise<void> {
        let rejected = false;
        try {
          await operation();
        } catch {
          rejected = true;
        }
        if (!rejected) {
          throw new Error(
            `Expected harness "${harness.name}" operation to reject, but it resolved.`,
          );
        }
      },
    };

    await testCase.run(caseContext);
    return context.trace.events;
  } finally {
    await subject.dispose();
  }
}
