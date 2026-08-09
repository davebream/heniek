import type { Static } from "@sinclair/typebox";
import { defineIdNamespace } from "../kernel/index.js";

/**
 * One pipeline definition — a named template (`careful-epic`) or the
 * generated id of a validated one-off graph (§14.1). Authored by a human in
 * a YAML file, so it is a name rather than a minted opaque id, but it stays
 * an opaque `string` on the wire like every other id namespace; the
 * *shape* constraint (`ConfigurationName`) belongs to the document schema,
 * which is where a violation can be reported at a source position.
 */
export const PipelineId = defineIdNamespace("PipelineId");
export type PipelineId = Static<typeof PipelineId>;

/**
 * One stage inside a pipeline definition — §14.3's `id: critique`.
 *
 * Deliberately *not* `execution-backend`'s `StageId`, despite the obvious
 * pull. That id names a stage the runtime is executing inside one run; this
 * one names a vertex in a declarative graph that has never run and may be
 * instantiated by many runs. Sharing one brand would make
 * `stageId: "critique"` and `stageId: <minted run-scoped id>` assignable to
 * each other, which is exactly the confusion the branding exists to prevent.
 */
export const PipelineStageId = defineIdNamespace("PipelineStageId");
export type PipelineStageId = Static<typeof PipelineStageId>;

/**
 * One immutable stage attempt identity. Derived deterministically from
 * `(runId, graphRevision, stageId, generation, attemptOrdinal)` so a
 * duplicate tick or a restart reload cannot mint a second attempt for the
 * same logical try.
 */
export const PipelineAttemptId = defineIdNamespace("PipelineAttemptId");
export type PipelineAttemptId = Static<typeof PipelineAttemptId>;

/**
 * One append-only scheduler decision. Derived from the same coordinates as
 * the attempt plus the decision action, so uniqueness constraints turn
 * duplicate ticks into no-ops.
 */
export const PipelineSchedulerDecisionId = defineIdNamespace("PipelineSchedulerDecisionId");
export type PipelineSchedulerDecisionId = Static<typeof PipelineSchedulerDecisionId>;

/**
 * One uniquely keyed outbox intent (dispatch, cancellation, or evaluator).
 * Q026 and later consumers drain these; Q025 only persists them.
 */
export const PipelineSchedulerIntentId = defineIdNamespace("PipelineSchedulerIntentId");
export type PipelineSchedulerIntentId = Static<typeof PipelineSchedulerIntentId>;
