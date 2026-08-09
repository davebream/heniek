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

/**
 * §14.5's execution modes. Layered pipeline default → stage override →
 * invocation override; this vocabulary covers the first two, and the third
 * is applied by the configuration layer that owns invocation overrides.
 */
export const PipelineExecutionMode = Type.Union([Type.Literal("autonomous"), Type.Literal("hitl")]);

/**
 * §15.2's explicit segment boundary declarations. There is deliberately no
 * third `auto` member: "no explicit fresh-session boundary exists" is
 * expressed by *omitting* `session`, not by naming a value, so the absence
 * of the field and the presence of a value never disagree.
 */
export const PipelineSessionPolicy = Type.Union([Type.Literal("fresh"), Type.Literal("resume")]);

/** §19.6's bounded validation-failure strategies. */
export const PipelineValidationFailureStrategy = Type.Union([
  Type.Literal("pause"),
  Type.Literal("fail"),
  Type.Literal("repair"),
  Type.Literal("repair_fresh"),
  Type.Literal("delegate"),
]);

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

export const PipelineLogicalOperator = Type.Union([Type.Literal("and"), Type.Literal("or")]);

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
