import { defineStates } from "../kernel/index.js";

/**
 * Fixed graph-stage lifecycle for the deterministic pipeline scheduler (Q025).
 *
 * Distinct from `RunStatus` (what callers see for a run) and
 * `ExecutionStatus` (what one backend attempt is doing). A pipeline stage
 * projection lives at the graph layer: it becomes `ready` when selected
 * predecessors succeed, `queued` when a dispatch intent is persisted, and
 * only settles to a terminal value after an attempt outcome, an unselected
 * branch, an unsatisfiable dependency, or an explicit cancellation.
 *
 * `blocked` is terminal and carries a typed reason — it is not the same as
 * an unselected conditional branch, which settles as `cancelled` with
 * `condition_not_selected`.
 */
export const PipelineStageState = defineStates({
  nonTerminal: ["pending", "ready", "queued", "running", "waiting", "retrying"],
  terminal: ["succeeded", "failed", "cancelled", "blocked"],
});
export type PipelineStageState = (typeof PipelineStageState)["values"][number];
