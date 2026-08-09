import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";

/**
 * §14.2's first-class stage types. Closed and fixed for v1: "no public
 * third-party stage implementation API exists in v1", so a document naming a
 * type outside this set is an authoring error, not an extension point.
 */
export const PipelineStageType = Type.Union([
  Type.Literal("agent"),
  Type.Literal("command"),
  Type.Literal("approval"),
  Type.Literal("integration"),
  Type.Literal("verify"),
  Type.Literal("publish"),
]);
export type PipelineStageType = Static<typeof PipelineStageType>;

/**
 * §14.5's execution modes. Layered pipeline default → stage override →
 * invocation override; this vocabulary covers the first two, and the third
 * is applied by the configuration layer that owns invocation overrides.
 */
export const PipelineExecutionMode = Type.Union([Type.Literal("autonomous"), Type.Literal("hitl")]);
export type PipelineExecutionMode = Static<typeof PipelineExecutionMode>;

/**
 * §15.2's explicit segment boundary declarations. There is deliberately no
 * third `auto` member: "no explicit fresh-session boundary exists" is
 * expressed by *omitting* `session`, not by naming a value, so the absence
 * of the field and the presence of a value never disagree.
 */
export const PipelineSessionPolicy = Type.Union([Type.Literal("fresh"), Type.Literal("resume")]);
export type PipelineSessionPolicy = Static<typeof PipelineSessionPolicy>;

/** §19.6's bounded validation-failure strategies. */
export const PipelineValidationFailureStrategy = Type.Union([
  Type.Literal("pause"),
  Type.Literal("fail"),
  Type.Literal("repair"),
  Type.Literal("repair_fresh"),
  Type.Literal("delegate"),
]);
export type PipelineValidationFailureStrategy = Static<typeof PipelineValidationFailureStrategy>;

/**
 * The comparison and boolean operators the condition grammar admits (§14.4).
 * Spelled as words rather than symbols (`gt`, not `>`) because the graph is
 * JSON that other tools read: a symbolic operator invites "just eval it",
 * and §8.1's "no executable values" is the whole point of compiling the
 * expression to a data structure in the first place.
 */
export const PipelineComparisonOperator = Type.Union([
  Type.Literal("eq"),
  Type.Literal("ne"),
  Type.Literal("lt"),
  Type.Literal("lte"),
  Type.Literal("gt"),
  Type.Literal("gte"),
]);
export type PipelineComparisonOperator = Static<typeof PipelineComparisonOperator>;

export const PipelineLogicalOperator = Type.Union([Type.Literal("and"), Type.Literal("or")]);
export type PipelineLogicalOperator = Static<typeof PipelineLogicalOperator>;

/**
 * §19.5's repository-state checks, as the three states a stage completion
 * can require of a repository without inspecting its contents. Closed, for
 * the same reason `PipelineStageType` is: a check the runtime cannot perform
 * is an authoring error the parser should name, not a string to pass through.
 */
export const PipelineRepositoryStateCheck = Type.Union([
  Type.Literal("clean"),
  Type.Literal("no_untracked_files"),
  Type.Literal("no_staged_changes"),
]);
export type PipelineRepositoryStateCheck = Static<typeof PipelineRepositoryStateCheck>;

/**
 * Why a stage projection moved. Closed so a persisted decision never carries
 * a free-form string the replay log cannot classify.
 */
export const PipelineTransitionReason = Type.Union([
  Type.Literal("dependencies_satisfied"),
  Type.Literal("root_eligible"),
  Type.Literal("dispatch_intent"),
  Type.Literal("attempt_started"),
  Type.Literal("attempt_waiting"),
  Type.Literal("attempt_succeeded"),
  Type.Literal("attempt_failed"),
  Type.Literal("retry_scheduled"),
  Type.Literal("retry_exhausted"),
  Type.Literal("condition_not_selected"),
  Type.Literal("condition_blocked"),
  Type.Literal("dependency_unsatisfied"),
  Type.Literal("cancel_requested"),
  Type.Literal("cancellation_settled"),
  Type.Literal("deadline_exceeded"),
  Type.Literal("manual_rerun"),
  Type.Literal("pipeline_cancelled"),
]);
export type PipelineTransitionReason = Static<typeof PipelineTransitionReason>;

/**
 * Outbox intent kinds. Runners are not invoked in Q025; these rows are the
 * durable hand-off Q026 (and evaluator dispatch) will drain.
 */
export const PipelineSchedulerIntentKind = Type.Union([
  Type.Literal("dispatch"),
  Type.Literal("cancel"),
  Type.Literal("evaluator"),
]);
export type PipelineSchedulerIntentKind = Static<typeof PipelineSchedulerIntentKind>;

/**
 * Terminal outcomes of one pipeline graph run. `blocked` is distinct from
 * `failed`: optional-stage failures do not fail an otherwise completed graph,
 * while an unsatisfiable required dependency or incompatible condition state
 * yields typed `blocked`.
 */
export const PipelineTerminalOutcome = Type.Union([
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("blocked"),
]);
export type PipelineTerminalOutcome = Static<typeof PipelineTerminalOutcome>;

/**
 * Scheduler decision actions. One decision row is one action against one
 * stage (or one evaluator edge), sorted by canonical stage id on every tick.
 */
export const PipelineSchedulerDecisionAction = Type.Union([
  Type.Literal("release"),
  Type.Literal("queue"),
  Type.Literal("start"),
  Type.Literal("wait"),
  Type.Literal("succeed"),
  Type.Literal("fail"),
  Type.Literal("retry"),
  Type.Literal("rearm"),
  Type.Literal("cancel"),
  Type.Literal("block"),
  Type.Literal("select_edge"),
  Type.Literal("reject_edge"),
  Type.Literal("request_evaluator"),
  Type.Literal("request_cancel"),
  Type.Literal("rerun"),
  Type.Literal("terminal"),
]);
export type PipelineSchedulerDecisionAction = Static<typeof PipelineSchedulerDecisionAction>;
