import type {
  ArtifactId,
  ExecutionBackend,
  ExecutionResultV1,
  ExecutionStatus as ExecutionStatusValue,
  InteractionId,
  PendingInteractionV1,
} from "@heniek/contracts";
import { ExecutionRequestV1, ExecutionStatus } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import type { ExecutionArrangement, PendingInteractionKind } from "../contract/arrangement.js";
import { ConformanceFaultError, isConformanceFaultError } from "../contract/fault.js";
import {
  EXECUTION_BACKEND_TRACE_ACTIONS,
  type ExecutionBackendHarness,
  TRACE_ACTORS,
} from "../contract/harness.js";
import { assertValid } from "../contract/validation.js";
import type { ConformanceContext } from "../kernel/context.js";
import { createFaultProgramme, type FaultProgramme } from "./fault-programme.js";

type ExecutionResult = Static<typeof ExecutionResultV1>;
type PendingInteraction = Static<typeof PendingInteractionV1>;

/** Retryable per design §2/§4.1: the fault classification a caller can immediately retry after. */
function isRetryable(fault: string): boolean {
  return fault === "disconnect" || fault === "rate_limit";
}

interface ExecutionRunRecord {
  readonly id: string;
  status: ExecutionStatusValue;
  askedOnce: boolean;
  readonly interactionKind: PendingInteractionKind | undefined;
  pendingInteractions: PendingInteraction[];
  readonly terminalTarget: "succeeded" | "failed";
  readonly malformed: boolean;
  readonly faultProgramme: FaultProgramme;
  inputArtifactRefs: ArtifactId[];
}

export interface FakeExecutionBackend {
  readonly backend: ExecutionBackend;
  /**
   * Arranges behaviour. `"next"` programs the next run to be `start()`ed
   * (this is the only form the harness-level `ConformanceSubject.arrange`
   * uses). Passing an existing run id instead enqueues an additional fault
   * onto that run in place — only `injects-fault` arrangements are valid
   * once a run already exists (used by `src/replay.ts` to build a single
   * run's fault sequence, e.g. disconnect → rate_limit → crash).
   */
  arrange(target: string | "next", arrangement: ExecutionArrangement): void;
}

function buildPendingInteraction(
  ctx: ConformanceContext,
  kind: PendingInteractionKind,
): PendingInteraction {
  const id = ctx.ids.next("conformance-interaction") as InteractionId;
  if (kind === "free_text") {
    return { schemaVersion: 1, id, kind, prompt: "Conformance harness question." };
  }
  return {
    schemaVersion: 1,
    id,
    kind,
    prompt: "Conformance harness question.",
    options: ["conformance-option-a", "conformance-option-b"],
  };
}

function advance(run: ExecutionRunRecord, ctx: ConformanceContext): void {
  switch (run.status) {
    case "queued":
      run.status = "running";
      return;
    case "running":
      if (run.interactionKind !== undefined && !run.askedOnce) {
        run.status = "waiting_on_user";
        run.pendingInteractions = [buildPendingInteraction(ctx, run.interactionKind)];
        return;
      }
      run.status = run.terminalTarget;
      return;
    default:
      // waiting_on_user, recovery_required, and every terminal status are
      // frozen: only answer()/resume()/cancel() move them forward.
      return;
  }
}

export function createFakeExecutionBackend(context: ConformanceContext): FakeExecutionBackend {
  const runs = new Map<string, ExecutionRunRecord>();
  let pendingArrangement: ExecutionArrangement | undefined;

  function requireRun(runId: string, action: string): ExecutionRunRecord {
    const run = runs.get(runId);
    if (run === undefined) {
      context.trace.record({
        atMs: context.clock.nowMs(),
        actor: TRACE_ACTORS.executionBackend,
        action,
        outcome: "fault",
        detail: { runId, fault: "stale_ref" },
      });
      throw new ConformanceFaultError("stale_ref", false, `unknown run id: ${runId}`);
    }
    return run;
  }

  const backend: ExecutionBackend = {
    async start(request: Static<typeof ExecutionRequestV1>): Promise<string> {
      assertValid(ExecutionRequestV1, request, "ExecutionRequestV1");
      const arrangement = pendingArrangement;
      pendingArrangement = undefined;

      const id = context.ids.next("backend-run");
      const run: ExecutionRunRecord = {
        id,
        status: "queued",
        askedOnce: false,
        interactionKind:
          arrangement?.kind === "asks-question" ? arrangement.interactionKind : undefined,
        pendingInteractions: [],
        terminalTarget:
          arrangement?.kind === "completes" && arrangement.status === "failed"
            ? "failed"
            : "succeeded",
        malformed: arrangement?.kind === "emits-malformed-result",
        faultProgramme: createFaultProgramme(
          arrangement?.kind === "injects-fault"
            ? [{ fault: arrangement.fault, occurrences: arrangement.occurrences }]
            : [],
        ),
        inputArtifactRefs: [],
      };
      runs.set(id, run);

      context.trace.record({
        atMs: context.clock.nowMs(),
        actor: TRACE_ACTORS.executionBackend,
        action: EXECUTION_BACKEND_TRACE_ACTIONS.start,
        outcome: "ok",
        detail: { runId: id },
      });
      return id;
    },

    async status(runId: string): Promise<ExecutionStatusValue> {
      const run = requireRun(runId, "status");
      const fault = run.faultProgramme.consume();
      if (fault === "crash") {
        // An injected crash can only move a still-in-flight run to
        // recovery_required (§18.2/§29 crash-during-run). Once a run has
        // already reached a terminal state, a "crash" is a no-op from the
        // caller's point of view — it must NOT un-terminalise the run —
        // and is classified as a conflict instead, mirroring every other
        // "operation happened after terminal" case in this fake.
        if (ExecutionStatus.isTerminal(run.status)) {
          context.trace.record({
            atMs: context.clock.nowMs(),
            actor: TRACE_ACTORS.executionBackend,
            action: EXECUTION_BACKEND_TRACE_ACTIONS.status,
            outcome: "fault",
            detail: { runId, fault: "conflict" },
          });
          throw new ConformanceFaultError(
            "conflict",
            false,
            "an injected crash cannot un-terminalise an already-terminal run",
          );
        }
        run.status = "recovery_required";
        context.trace.record({
          atMs: context.clock.nowMs(),
          actor: TRACE_ACTORS.executionBackend,
          action: EXECUTION_BACKEND_TRACE_ACTIONS.status,
          outcome: "ok",
          detail: { runId, status: run.status, fault: "crash" },
        });
        return run.status;
      }
      if (fault !== undefined) {
        context.trace.record({
          atMs: context.clock.nowMs(),
          actor: TRACE_ACTORS.executionBackend,
          action: EXECUTION_BACKEND_TRACE_ACTIONS.status,
          outcome: "fault",
          detail: { runId, fault },
        });
        throw new ConformanceFaultError(fault, isRetryable(fault));
      }
      advance(run, context);
      context.trace.record({
        atMs: context.clock.nowMs(),
        actor: TRACE_ACTORS.executionBackend,
        action: EXECUTION_BACKEND_TRACE_ACTIONS.status,
        outcome: "ok",
        detail: { runId, status: run.status },
      });
      return run.status;
    },

    async interactions(runId: string): Promise<PendingInteraction[]> {
      const run = requireRun(runId, "interactions");
      context.trace.record({
        atMs: context.clock.nowMs(),
        actor: TRACE_ACTORS.executionBackend,
        action: EXECUTION_BACKEND_TRACE_ACTIONS.interactions,
        outcome: "ok",
        detail: {
          runId,
          count: run.status === "waiting_on_user" ? run.pendingInteractions.length : 0,
        },
      });
      return run.status === "waiting_on_user" ? [...run.pendingInteractions] : [];
    },

    async answer(runId: string, interactionId: InteractionId, _answer: unknown): Promise<void> {
      const run = requireRun(runId, "answer");
      const fault = run.faultProgramme.consume();
      if (fault !== undefined) {
        context.trace.record({
          atMs: context.clock.nowMs(),
          actor: TRACE_ACTORS.executionBackend,
          action: EXECUTION_BACKEND_TRACE_ACTIONS.answer,
          outcome: "fault",
          detail: { runId, fault },
        });
        throw new ConformanceFaultError(fault, isRetryable(fault));
      }
      if (ExecutionStatus.isTerminal(run.status)) {
        context.trace.record({
          atMs: context.clock.nowMs(),
          actor: TRACE_ACTORS.executionBackend,
          action: EXECUTION_BACKEND_TRACE_ACTIONS.answer,
          outcome: "fault",
          detail: { runId, fault: "conflict" },
        });
        throw new ConformanceFaultError("conflict", false, "answer requested after terminal");
      }
      const pending = run.pendingInteractions.find((entry) => entry.id === interactionId);
      if (run.status !== "waiting_on_user" || pending === undefined) {
        context.trace.record({
          atMs: context.clock.nowMs(),
          actor: TRACE_ACTORS.executionBackend,
          action: EXECUTION_BACKEND_TRACE_ACTIONS.answer,
          outcome: "fault",
          detail: { runId, fault: "stale_ref" },
        });
        throw new ConformanceFaultError("stale_ref", false, "unknown interaction id");
      }
      run.pendingInteractions = [];
      run.askedOnce = true;
      run.status = "running";
      context.trace.record({
        atMs: context.clock.nowMs(),
        actor: TRACE_ACTORS.executionBackend,
        action: EXECUTION_BACKEND_TRACE_ACTIONS.answer,
        outcome: "ok",
        detail: { runId, interactionId },
      });
    },

    async resume(runId: string, inputArtifactRefs: ArtifactId[]): Promise<void> {
      const run = requireRun(runId, "resume");
      const fault = run.faultProgramme.consume();
      if (fault !== undefined) {
        context.trace.record({
          atMs: context.clock.nowMs(),
          actor: TRACE_ACTORS.executionBackend,
          action: EXECUTION_BACKEND_TRACE_ACTIONS.resume,
          outcome: "fault",
          detail: { runId, fault },
        });
        throw new ConformanceFaultError(fault, isRetryable(fault));
      }
      run.inputArtifactRefs = [...run.inputArtifactRefs, ...inputArtifactRefs];
      if (run.status === "recovery_required") {
        run.status = "running";
      }
      context.trace.record({
        atMs: context.clock.nowMs(),
        actor: TRACE_ACTORS.executionBackend,
        action: EXECUTION_BACKEND_TRACE_ACTIONS.resume,
        outcome: "ok",
        detail: { runId, inputArtifactRefs: run.inputArtifactRefs },
      });
    },

    async result(runId: string): Promise<ExecutionResult> {
      const run = requireRun(runId, "result");
      const fault = run.faultProgramme.consume();
      if (fault !== undefined) {
        context.trace.record({
          atMs: context.clock.nowMs(),
          actor: TRACE_ACTORS.executionBackend,
          action: EXECUTION_BACKEND_TRACE_ACTIONS.result,
          outcome: "fault",
          detail: { runId, fault },
        });
        throw new ConformanceFaultError(fault, isRetryable(fault));
      }
      if (!ExecutionStatus.isTerminal(run.status)) {
        context.trace.record({
          atMs: context.clock.nowMs(),
          actor: TRACE_ACTORS.executionBackend,
          action: EXECUTION_BACKEND_TRACE_ACTIONS.result,
          outcome: "fault",
          detail: { runId, fault: "conflict" },
        });
        throw new ConformanceFaultError("conflict", false, "result requested before terminal");
      }
      if (run.malformed) {
        context.trace.record({
          atMs: context.clock.nowMs(),
          actor: TRACE_ACTORS.executionBackend,
          action: EXECUTION_BACKEND_TRACE_ACTIONS.result,
          outcome: "fault",
          detail: { runId, fault: "malformed_response" },
        });
        throw new ConformanceFaultError("malformed_response", false, "result payload is malformed");
      }
      const status =
        run.status === "cancelled" || run.status === "failed" ? run.status : "succeeded";
      const payload: ExecutionResult = {
        schemaVersion: 1,
        status,
        summary: `Conformance run ${run.id} ${status}.`,
        changedRepositories: [],
        artifacts: { report: context.ids.next("conformance-artifact") as ArtifactId },
      };
      context.trace.record({
        atMs: context.clock.nowMs(),
        actor: TRACE_ACTORS.executionBackend,
        action: EXECUTION_BACKEND_TRACE_ACTIONS.result,
        outcome: "ok",
        detail: { runId, status },
      });
      return payload;
    },

    async cancel(runId: string): Promise<void> {
      const run = requireRun(runId, "cancel");
      if (run.status !== "cancelled") {
        run.status = "cancelled";
        run.pendingInteractions = [];
      }
      context.trace.record({
        atMs: context.clock.nowMs(),
        actor: TRACE_ACTORS.executionBackend,
        action: EXECUTION_BACKEND_TRACE_ACTIONS.cancel,
        outcome: "ok",
        detail: { runId },
      });
    },
  };

  return {
    backend,
    arrange(target: string | "next", arrangement: ExecutionArrangement): void {
      if (target === "next") {
        pendingArrangement = arrangement;
        return;
      }
      if (arrangement.kind !== "injects-fault") {
        throw new Error(
          `Only "injects-fault" arrangements can target an existing run id (got: ${arrangement.kind})`,
        );
      }
      const run = runs.get(target);
      if (run === undefined) {
        throw new Error(`Cannot arrange a fault on unknown run id: ${target}`);
      }
      run.faultProgramme.enqueue({
        fault: arrangement.fault,
        occurrences: arrangement.occurrences,
      });
    },
  };
}

/**
 * Every capability the execution-backend case catalogue actually requires
 * (design §5's "full capability set" scoped to this family — `fault-conflict`
 * is never a `requires` entry for an execution-backend case, so it is
 * deliberately excluded here: declaring it would trip the anti-drift check
 * "no subject declares a capability no case requires").
 */
export const FAKE_EXECUTION_BACKEND_CAPABILITIES = [
  "lifecycle",
  "interaction",
  "resume",
  "cancellation",
  "malformed-response",
  "fault-disconnect",
  "fault-rate-limit",
  "fault-stale-ref",
  "fault-crash-recovery",
] as const;

export function createFakeExecutionBackendHarness(): ExecutionBackendHarness {
  return {
    name: "fake-execution-backend",
    capabilities: FAKE_EXECUTION_BACKEND_CAPABILITIES,
    classifyFault: (error: unknown) => (isConformanceFaultError(error) ? error.kind : "unknown"),
    async createSubject(context: ConformanceContext) {
      const fake = createFakeExecutionBackend(context);
      return {
        subject: fake.backend,
        async arrange(arrangement: ExecutionArrangement): Promise<void> {
          fake.arrange("next", arrangement);
        },
        async dispose(): Promise<void> {
          // Nothing to release: fully in-memory.
        },
      };
    },
  };
}
