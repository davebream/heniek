import type { ExecutionBackend, ForgeBackend, TaskSource } from "@heniek/contracts";
import type { ConformanceContext } from "../kernel/context.js";
import type {
  ExecutionArrangement,
  ForgeArrangement,
  TaskSourceArrangement,
} from "./arrangement.js";
import type { ConformanceCapability } from "./capability.js";
import type { FaultKind } from "./fault.js";

/**
 * The one interface a new backend must implement (AC3). The case catalogue
 * depends only on this contract, never on a concrete backend.
 *
 * A conforming implementation of any of the three family-specific harnesses
 * (`ExecutionBackendHarness`, `TaskSourceHarness`, `ForgeBackendHarness`)
 * must additionally satisfy six behavioural obligations that the TypeScript
 * type alone cannot express — the type only proves the *shape* is right,
 * not that the *behaviour* the case catalogue assumes holds. Every case in
 * `src/cases/**` is written against these six obligations; an
 * implementation that satisfies the type but violates one of them will fail
 * one or more cases, sometimes obscurely:
 *
 * 1. **`arrange()` targets the *next* run to be started, not the current
 *    one.** `ConformanceSubject.arrange(arrangement)` configures the
 *    precondition for the run the *following* `start()` call creates —
 *    never a run that already exists. Every case calls `arrange()` (when it
 *    needs to) strictly before `start()`. An implementation that reads
 *    `arrange()` as applying to "whichever run is currently active" will
 *    silently misroute a large fraction of the catalogue.
 *
 * 2. **`start()` must validate its own request and reject a
 *    contract-invalid one.** `execution/start-rejects-contract-invalid-request`
 *    and its siblings pass a structurally invalid request and require a
 *    rejection — `start()` is not permitted to trust its caller.
 *
 * 3. **Progress must be poll-driven, never wall-clock-driven.** The runner
 *    calls `status()` up to a fixed bound of times back-to-back, with no
 *    delay between calls (`pollUntil` in `src/cases/execution-backend.ts`).
 *    A subject whose progress depends on real elapsed time (a timer, a
 *    background tick) will never reach its target state within the poll
 *    budget, and the case fails with an explicit poll-exhaustion error, not
 *    a silent pass.
 *
 * 4. **`status()` advances at most one phase per call.** Each poll may move
 *    the subject exactly one step forward in its own lifecycle (e.g.
 *    `queued` → `running`), never more than one — cases that assert on an
 *    intermediate non-terminal status between `start()` and the terminal
 *    state depend on this.
 *
 * 5. **The per-operation fault taxonomy is fixed, not implementation-chosen.**
 *    An unknown reference (unknown run id, unknown interaction id, unknown
 *    pull request id, …) must classify as `"stale_ref"`; an operation called
 *    after the subject has already reached a terminal state must classify
 *    as `"conflict"`. `classifyFault` below is where an implementation maps
 *    its own error shape onto this vocabulary — the bundled fakes throw
 *    `ConformanceFaultError` directly, but a third-party adapter is free to
 *    throw whatever it naturally throws and classify it in `classifyFault`
 *    instead.
 *
 * 6. **`cancel()` followed by `result()` must synthesize a `cancelled`
 *    `ExecutionResultV1`.** A subject need not have a "real" terminal result
 *    to report after a cancellation; it must still return a contract-valid
 *    `ExecutionResultV1` with `status: "cancelled"`.
 *
 * A seventh, narrower item concerns *trace recording*, not correctness: a
 * subject that chooses to populate `ConformanceContext.trace` (recording is
 * never required by any case — the shared catalogue only asserts on a
 * subject's return values and thrown errors) must record its actor/action
 * labels using the shared constants below (`TRACE_ACTORS`,
 * `EXECUTION_BACKEND_TRACE_ACTIONS`), never an implementation-specific name.
 * The `actor` field identifies the *conformance family* being exercised
 * (e.g. `"execution-backend"`), not the concrete implementation — that
 * distinction is `ConformanceHarness.name` instead. This is what lets a case
 * that inspects the trace assert on it portably, rather than being coupled
 * to one bundled implementation's own naming choice (previously a real
 * defect here: a hard-coded `actor === "execution-backend"` assertion would
 * have silently failed against any subject that recorded a different actor
 * string, such as a subprocess-backed adapter naming itself after its own
 * implementation).
 */
export interface ConformanceHarness<TSubject, TArrangement> {
  readonly name: string;
  readonly capabilities: readonly ConformanceCapability[];
  /** Maps an adapter-native error onto the neutral fault vocabulary. */
  classifyFault(error: unknown): FaultKind | "unknown";
  /** Optionally maps neutral catalogue input into an adapter-native request shape. */
  mapInput?(input: unknown): unknown;
  createSubject(context: ConformanceContext): Promise<ConformanceSubject<TSubject, TArrangement>>;
}

export interface ConformanceSubject<TSubject, TArrangement> {
  readonly subject: TSubject;
  /** Arranges a provider-neutral precondition before the case drives the subject. */
  arrange(arrangement: TArrangement): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Canonical trace `actor` labels, one per conformance family. Every subject
 * that chooses to record trace events for a given family must use that
 * family's shared label — never its own implementation name — so a case
 * that inspects `ConformanceContext.trace` can assert on `event.actor`
 * portably across every implementation of that family (obligation 7 above).
 */
export const TRACE_ACTORS = {
  executionBackend: "execution-backend",
  taskSource: "task-source",
  forgeBackend: "forge-backend",
} as const;

/**
 * Canonical trace `action` labels for the `ExecutionBackend` family — one
 * per contract method a subject may record. Paired with `TRACE_ACTORS`
 * above (obligation 7).
 */
export const EXECUTION_BACKEND_TRACE_ACTIONS = {
  start: "start",
  status: "status",
  interactions: "interactions",
  answer: "answer",
  resume: "resume",
  result: "result",
  cancel: "cancel",
} as const;

export type ExecutionBackendHarness = ConformanceHarness<ExecutionBackend, ExecutionArrangement>;
export type TaskSourceHarness = ConformanceHarness<TaskSource, TaskSourceArrangement>;
export type ForgeBackendHarness = ConformanceHarness<ForgeBackend, ForgeArrangement>;
