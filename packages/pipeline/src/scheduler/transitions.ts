/**
 * Permitted stage-state transitions for the fixed pipeline state machine.
 *
 * Terminal states are immutable except through an explicit manual rerun,
 * which is modelled as a transition back to `pending` with reason
 * `manual_rerun` (and a generation bump applied alongside it).
 */

import type { PipelineStageState, PipelineTransitionReason } from "@heniek/contracts";
import { PipelineStageState as StageStates } from "@heniek/contracts";

export type TransitionKey = `${PipelineStageState}->${PipelineStageState}`;

export interface PermittedTransition {
  readonly from: PipelineStageState;
  readonly to: PipelineStageState;
  readonly reasons: readonly PipelineTransitionReason[];
}

/**
 * Complete adjacency list. Machine-readable diagram data is derived from
 * this table for ADR evidence — do not invent transitions elsewhere.
 */
export const PERMITTED_TRANSITIONS: readonly PermittedTransition[] = Object.freeze([
  {
    from: "pending",
    to: "ready",
    reasons: ["dependencies_satisfied", "root_eligible"],
  },
  {
    from: "pending",
    to: "cancelled",
    reasons: [
      "condition_not_selected",
      "cancel_requested",
      "pipeline_cancelled",
      "deadline_exceeded",
    ],
  },
  {
    from: "pending",
    to: "blocked",
    reasons: ["condition_blocked", "dependency_unsatisfied"],
  },
  {
    from: "ready",
    to: "queued",
    reasons: ["dispatch_intent"],
  },
  {
    from: "ready",
    to: "cancelled",
    reasons: [
      "cancel_requested",
      "pipeline_cancelled",
      "deadline_exceeded",
      "condition_not_selected",
    ],
  },
  {
    from: "ready",
    to: "blocked",
    reasons: ["condition_blocked", "dependency_unsatisfied", "deadline_exceeded"],
  },
  {
    from: "queued",
    to: "running",
    reasons: ["attempt_started"],
  },
  {
    from: "queued",
    to: "cancelled",
    reasons: ["cancellation_settled"],
  },
  {
    from: "running",
    to: "waiting",
    reasons: ["attempt_waiting"],
  },
  {
    from: "running",
    to: "succeeded",
    reasons: ["attempt_succeeded"],
  },
  {
    from: "running",
    to: "failed",
    reasons: ["attempt_failed", "retry_exhausted"],
  },
  {
    from: "running",
    to: "retrying",
    reasons: ["retry_scheduled"],
  },
  {
    from: "running",
    to: "cancelled",
    reasons: ["cancellation_settled"],
  },
  {
    from: "waiting",
    to: "running",
    reasons: ["attempt_started"],
  },
  {
    from: "waiting",
    to: "succeeded",
    reasons: ["attempt_succeeded"],
  },
  {
    from: "waiting",
    to: "failed",
    reasons: ["attempt_failed", "retry_exhausted"],
  },
  {
    from: "waiting",
    to: "retrying",
    reasons: ["retry_scheduled"],
  },
  {
    from: "waiting",
    to: "cancelled",
    reasons: ["cancellation_settled"],
  },
  {
    from: "retrying",
    to: "ready",
    reasons: ["retry_scheduled"],
  },
  {
    from: "retrying",
    to: "failed",
    reasons: ["retry_exhausted"],
  },
  {
    from: "retrying",
    to: "cancelled",
    reasons: ["cancel_requested", "pipeline_cancelled", "deadline_exceeded"],
  },
  // Explicit manual rerun: terminal → pending with a generation bump.
  {
    from: "succeeded",
    to: "pending",
    reasons: ["manual_rerun"],
  },
  {
    from: "failed",
    to: "pending",
    reasons: ["manual_rerun"],
  },
  {
    from: "cancelled",
    to: "pending",
    reasons: ["manual_rerun"],
  },
  {
    from: "blocked",
    to: "pending",
    reasons: ["manual_rerun"],
  },
]);

const REASON_INDEX: ReadonlyMap<TransitionKey, ReadonlySet<PipelineTransitionReason>> = (() => {
  const map = new Map<TransitionKey, Set<PipelineTransitionReason>>();
  for (const entry of PERMITTED_TRANSITIONS) {
    const key: TransitionKey = `${entry.from}->${entry.to}`;
    const reasons = map.get(key) ?? new Set<PipelineTransitionReason>();
    for (const reason of entry.reasons) {
      reasons.add(reason);
    }
    map.set(key, reasons);
  }
  return map;
})();

/** Adjacency list suitable for diagram generation: from → sorted tos. */
export function transitionAdjacency(): Readonly<
  Record<PipelineStageState, readonly PipelineStageState[]>
> {
  const map = new Map<PipelineStageState, Set<PipelineStageState>>();
  for (const state of StageStates.values) {
    map.set(state, new Set());
  }
  for (const entry of PERMITTED_TRANSITIONS) {
    map.get(entry.from)!.add(entry.to);
  }
  const result = {} as Record<PipelineStageState, readonly PipelineStageState[]>;
  for (const state of StageStates.values) {
    result[state] = [...map.get(state)!].sort();
  }
  return result;
}

export function isPermittedTransition(
  from: PipelineStageState,
  to: PipelineStageState,
  reason: PipelineTransitionReason,
): boolean {
  const reasons = REASON_INDEX.get(`${from}->${to}`);
  return reasons !== undefined && reasons.has(reason);
}

export function assertPermittedTransition(
  from: PipelineStageState,
  to: PipelineStageState,
  reason: PipelineTransitionReason,
): void {
  if (!isPermittedTransition(from, to, reason)) {
    throw new Error(`undeclared transition ${from} → ${to} (${reason})`);
  }
}

export function isTerminalStageState(state: PipelineStageState): boolean {
  return StageStates.isTerminal(state);
}
