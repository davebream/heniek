import type { ConformanceContext } from "../kernel/context.js";
import type { ConformanceCapability } from "./capability.js";
import type { FaultKind } from "./fault.js";
import type { ConformanceHarness } from "./harness.js";

/**
 * The per-case surface a `ConformanceCase.run` implementation is given. The
 * helper methods (`arrange`, `expectFault`, `expectRejection`) are
 * implemented in `src/runner/case-context.ts`, not here — this file only
 * declares the shape (Phase 3.5 of the plan).
 */
export interface ConformanceCaseContext<TSubject, TArrangement> {
  readonly context: ConformanceContext;
  readonly harness: ConformanceHarness<TSubject, TArrangement>;
  readonly subject: TSubject;
  arrange(arrangement: TArrangement): Promise<void>;
  /** Asserts the thrown error classifies to `kind` via the harness. */
  expectFault(operation: () => Promise<unknown>, kind: FaultKind): Promise<void>;
  /** Asserts the operation rejects, regardless of error shape. */
  expectRejection(operation: () => Promise<unknown>): Promise<void>;
}

/** One entry of a case catalogue (design §4). */
export interface ConformanceCase<TSubject, TArrangement> {
  /** Stable, kebab-case id, e.g. `"execution/cancel-is-idempotent"`. */
  readonly id: string;
  readonly title: string;
  readonly requires: readonly ConformanceCapability[];
  /** Spec/AC anchors this case covers, e.g. `["AC1", "§22"]`. */
  readonly covers: readonly string[];
  run(ctx: ConformanceCaseContext<TSubject, TArrangement>): Promise<void>;
}
