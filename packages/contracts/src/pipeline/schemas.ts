import { Type } from "@sinclair/typebox";
import { ProfileId } from "../execution-backend/ids.js";
import { versioned } from "../kernel/index.js";
import { PipelineId, PipelineStageId } from "./ids.js";
import {
  PipelineComparisonOperator,
  PipelineExecutionMode,
  PipelineLogicalOperator,
  PipelineRepositoryStateCheck,
  PipelineSessionPolicy,
  PipelineStageType,
  PipelineValidationFailureStrategy,
} from "./vocabulary.js";

/**
 * Same two patterns `configuration/schemas.ts` declares privately, duplicated
 * here rather than exported from there. Exporting would publish two one-line
 * regular expressions as a shared surface that neither family owns, and the
 * `native-bridge` family already made the same trade for `SAFE_RELATIVE_PATH`.
 * `DURATION` matches `@heniek/config`'s `hardLimitMagnitude`, which is what
 * actually converts these strings to milliseconds.
 */
const CONFIGURATION_NAME = "^[a-zA-Z0-9][a-zA-Z0-9._-]*$";
const DURATION = "^[1-9][0-9]*(?:ms|s|m|h|d)$";

const Duration = Type.String({ pattern: DURATION });
const ConfigurationName = Type.String({ minLength: 1, pattern: CONFIGURATION_NAME });

/**
 * A `reads`/`writes` entry (§14.3): a dotted reference into the canonical run
 * state, `task.current`, `artifacts.design.selected`, `decisions.architecture`.
 * The pattern pins the *shape*; which namespaces exist, and whether a read is
 * actually produced upstream, are semantic checks the parser makes against the
 * whole graph, where the diagnostic can name the producing stage.
 */
const StateReference = Type.String({
  minLength: 1,
  pattern: "^[a-z][a-z0-9_]*(?:\\.[a-zA-Z0-9][a-zA-Z0-9._-]*)+$",
});

// ---------------------------------------------------------------------------
// Conditions (§14.4)
// ---------------------------------------------------------------------------

/**
 * A condition as authored. The union — rather than one object with two
 * optional fields — is what makes "exactly one of `expression` and
 * `evaluator`" a schema-level guarantee instead of a hand-written check that
 * could be forgotten. `question` is required alongside `evaluator` because
 * §14.4's subjective route is an *explicit* evaluator stage: an evaluator
 * with no question is a stage with nothing to decide.
 */
const ConditionDocument = Type.Union([
  Type.Object({ expression: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object(
    { evaluator: ProfileId, question: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  ),
]);

/**
 * One node of a compiled condition expression, in an **index-addressed flat
 * array** rather than a nested tree.
 *
 * A nested tree needs `Type.Recursive`, which mints its own `$id` nested
 * inside whatever schema embeds it — the duplicate-`$id` hazard
 * `configuration/schemas.ts` documents at length for `Diagnostic`. The flat
 * form has no recursion to declare, serialises to bytes that depend only on
 * the expression's structure, and costs a consumer one index lookup per
 * child.
 *
 * `left`/`right`/`operand` are indices into the same array. The parser only
 * ever emits children *before* their parent, so `root` is the last node and
 * a consumer may evaluate the array front-to-back without recursion at all.
 */
const ExpressionNode = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("path"),
      /** Dotted segments, already split: `verify.blockingFindings.length`. */
      path: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("literal"),
      value: Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("not"), operand: Type.Integer({ minimum: 0 }) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("compare"),
      operator: PipelineComparisonOperator,
      left: Type.Integer({ minimum: 0 }),
      right: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("logical"),
      operator: PipelineLogicalOperator,
      left: Type.Integer({ minimum: 0 }),
      right: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
]);

/** A condition after compilation: a deterministic expression, or an evaluator handover. */
const PipelineCondition = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("expression"),
      nodes: Type.Array(ExpressionNode, { minItems: 1 }),
      root: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("evaluator"),
      profile: ProfileId,
      question: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

// ---------------------------------------------------------------------------
// Stage completion (§19.5)
// ---------------------------------------------------------------------------

const CommandRequirement = Type.Object(
  {
    argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    exit_code: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
  },
  { additionalProperties: false },
);

/**
 * §19.5's seven completion requirements, as a closed set. Closed because a
 * requirement the runtime cannot evaluate is worse than no requirement at
 * all: it would read like a guarantee and enforce nothing, which is precisely
 * the "a worker's done claim is evidence, not authority" failure §19.5 exists
 * to prevent.
 *
 * `valid_result_envelope` and `non_empty_diff` take no argument and are bare
 * strings; the rest are single-key objects, matching §14.3's `- artifact:
 * critique-report`.
 */
const CompletionRequirementDocument = Type.Union([
  Type.Literal("valid_result_envelope"),
  Type.Literal("non_empty_diff"),
  Type.Object({ artifact: ConfigurationName }, { additionalProperties: false }),
  Type.Object({ schema_check: ConfigurationName }, { additionalProperties: false }),
  Type.Object(
    { sections: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) },
    { additionalProperties: false },
  ),
  Type.Object({ command: CommandRequirement }, { additionalProperties: false }),
  Type.Object({ repository_state: PipelineRepositoryStateCheck }, { additionalProperties: false }),
  Type.Object({ verdict: ProfileId }, { additionalProperties: false }),
]);

/**
 * The same seven requirements after normalization: every form becomes a
 * `{ kind, ... }` object, so a consumer switches on one discriminator instead
 * of distinguishing "is it a string or an object, and if an object, which key
 * does it have".
 */
const CompletionRequirement = Type.Union([
  Type.Object({ kind: Type.Literal("result_envelope") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("non_empty_diff") }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal("artifact"), name: ConfigurationName },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("schema_check"), name: ConfigurationName },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("sections"),
      names: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("command"),
      argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      exitCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("repository_state"), state: PipelineRepositoryStateCheck },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("verdict"), profile: ProfileId },
    { additionalProperties: false },
  ),
]);

// ---------------------------------------------------------------------------
// Limits (§24)
// ---------------------------------------------------------------------------

/**
 * §24's four pipeline-scoped limits. All optional and **no defaults are
 * applied here**: built-in defaults live in `@heniek/config`'s
 * `HENIEK_BUILT_IN_DEFAULTS` and are merged through §8.2's layer order, where
 * "the strictest applicable hard limit wins" can actually be evaluated
 * against every layer. A pipeline document declares only what it declares;
 * inventing a default at parse time would silently promote a template's
 * silence into a value that outranks a global default.
 */
const PipelineLimitsDocument = Type.Object(
  {
    max_pipeline_duration: Type.Optional(Duration),
    max_concurrent_workers: Type.Optional(Type.Integer({ minimum: 1 })),
    max_repair_attempts: Type.Optional(Type.Integer({ minimum: 0 })),
    max_graph_revisions: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const PipelineLimits = Type.Object(
  {
    maxPipelineDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
    maxConcurrentWorkers: Type.Optional(Type.Integer({ minimum: 1 })),
    maxRepairAttempts: Type.Optional(Type.Integer({ minimum: 0 })),
    maxGraphRevisions: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

/** §24's "profile/stage limits may be stricter", scoped to what a single stage can cap. */
const StageLimitsDocument = Type.Object(
  {
    max_duration: Type.Optional(Duration),
    max_repair_attempts: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const StageLimits = Type.Object(
  {
    maxDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
    maxRepairAttempts: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

/** §15.3's context-handoff thresholds, as fractions of the usable context window. */
const PipelineContextDocument = Type.Object(
  {
    handoff_soft_threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    handoff_hard_threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);

const PipelineContext = Type.Object(
  {
    handoffSoftThreshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    handoffHardThreshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

const SessionDocument = Type.Object(
  { policy: PipelineSessionPolicy },
  { additionalProperties: false },
);

const ValidationFailureDocument = Type.Object(
  {
    strategy: PipelineValidationFailureStrategy,
    session: Type.Optional(PipelineSessionPolicy),
    max_attempts: Type.Optional(Type.Integer({ minimum: 1 })),
    /** The profile repair is handed to when `strategy` is `delegate` (§19.6). */
    delegate_to: Type.Optional(ProfileId),
  },
  { additionalProperties: false },
);

const ValidationFailure = Type.Object(
  {
    strategy: PipelineValidationFailureStrategy,
    session: Type.Optional(PipelineSessionPolicy),
    maxAttempts: Type.Optional(Type.Integer({ minimum: 1 })),
    delegateTo: Type.Optional(ProfileId),
  },
  { additionalProperties: false },
);

/**
 * A `command` stage's declaration (§14.2). Present here so a graph is
 * complete enough to schedule; the execution semantics — argv without shell
 * interpolation, descendant kill on timeout — belong to the runner.
 *
 * `env` carries values, so it is exactly the field a credential could be
 * pasted into. No guard is declared here: `@heniek/config`'s restricted-YAML
 * layer already refuses credential-shaped entries on every mapping pair
 * before this schema ever sees the document, and a second, weaker guard here
 * would only invite disagreement between the two.
 */
const CommandDocument = Type.Object(
  {
    argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    cwd: Type.Optional(Type.String({ minLength: 1 })),
    env: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
  },
  { additionalProperties: false },
);

/**
 * §14.4's `when`/`then` pair, spelled exactly as the specification writes it.
 *
 * `then` is a YAML key in a hand-authored file, never a JavaScript property
 * anyone awaits, so the thenable hazard the lint rule guards against cannot
 * arise here — and renaming the key to satisfy a JavaScript concern would
 * make every pipeline in the specification fail to parse.
 */
const TransitionDocument = Type.Object(
  // biome-ignore lint/suspicious/noThenProperty: `then` is §14.4's YAML key, not a thenable.
  { when: ConditionDocument, then: PipelineStageId },
  { additionalProperties: false },
);

/**
 * One authored stage (§14.3). Three of its fields — `needs`, `transitions`,
 * and the document-level `edges` — are three spellings of the same thing, and
 * all three normalize into one canonical edge list. That redundancy is
 * deliberate: §14.3 and §15.2 write plain sequences, §14.4 writes
 * `when`/`then`, and a generated one-off graph (§14.1) is easiest to emit as
 * explicit edges.
 */
const StageDocument = Type.Object(
  {
    id: PipelineStageId,
    type: PipelineStageType,
    profile: Type.Optional(ProfileId),
    optional: Type.Optional(Type.Boolean()),
    mode: Type.Optional(PipelineExecutionMode),
    needs: Type.Optional(Type.Array(PipelineStageId)),
    reads: Type.Optional(Type.Array(StateReference)),
    writes: Type.Optional(Type.Array(StateReference)),
    overridable: Type.Optional(Type.Array(ConfigurationName)),
    session: Type.Optional(SessionDocument),
    limits: Type.Optional(StageLimitsDocument),
    command: Type.Optional(CommandDocument),
    completion: Type.Optional(
      Type.Object(
        { require: Type.Array(CompletionRequirementDocument, { minItems: 1 }) },
        { additionalProperties: false },
      ),
    ),
    on_validation_failure: Type.Optional(ValidationFailureDocument),
    transitions: Type.Optional(Type.Array(TransitionDocument)),
  },
  { additionalProperties: false },
);

/**
 * One stage after normalization. `mode` and `optional` are always present —
 * resolved from the stage override, then the pipeline default — so a consumer
 * never re-derives them and two documents that differ only in which level
 * declared the mode produce identical bytes. `reads`, `writes`, and
 * `overridable` are always present and always sorted, empty array included,
 * for the same reason.
 */
const PipelineStage = Type.Object(
  {
    id: PipelineStageId,
    type: PipelineStageType,
    mode: PipelineExecutionMode,
    optional: Type.Boolean(),
    profile: Type.Optional(ProfileId),
    session: Type.Optional(SessionDocument),
    limits: Type.Optional(StageLimits),
    command: Type.Optional(CommandDocument),
    completion: Type.Optional(
      Type.Object(
        { require: Type.Array(CompletionRequirement, { minItems: 1 }) },
        { additionalProperties: false },
      ),
    ),
    onValidationFailure: Type.Optional(ValidationFailure),
    reads: Type.Array(StateReference),
    writes: Type.Array(StateReference),
    overridable: Type.Array(ConfigurationName),
  },
  { additionalProperties: false },
);

const EdgeDocument = Type.Object(
  { from: PipelineStageId, to: PipelineStageId, when: Type.Optional(ConditionDocument) },
  { additionalProperties: false },
);

const PipelineEdge = Type.Object(
  { from: PipelineStageId, to: PipelineStageId, condition: Type.Optional(PipelineCondition) },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// The three registered contracts
// ---------------------------------------------------------------------------

/**
 * The authored YAML document (§8.3's human-readable source of truth).
 *
 * `versioned()` supplies both halves of "require an explicit schema version
 * and a closed shape": the required `schemaVersion: 1` literal, and
 * `additionalProperties: false`, which turns a misspelled key into a located
 * diagnostic rather than a silently ignored line.
 *
 * This is the schema handed to `@heniek/config`'s
 * `loadRestrictedYamlDocument`, so validating a pipeline file and validating
 * the published contract are the same operation, not two that can drift.
 */
export const PipelineDefinitionV1 = versioned("PipelineDefinition", 1, {
  id: PipelineId,
  name: Type.Optional(Type.String({ minLength: 1 })),
  description: Type.Optional(Type.String({ minLength: 1 })),
  mode: Type.Optional(PipelineExecutionMode),
  limits: Type.Optional(PipelineLimitsDocument),
  context: Type.Optional(PipelineContextDocument),
  stages: Type.Array(StageDocument, { minItems: 1 }),
  edges: Type.Optional(Type.Array(EdgeDocument)),
});

/**
 * The normalized graph: the provider-neutral contract every later pipeline
 * stage of the product consumes.
 *
 * It carries **no source positions**. That is the load-bearing decision
 * behind "equivalent YAML normalizes to byte-identical graph JSON" — a line
 * number is a property of the file, not of the pipeline, and embedding one
 * would make two identical pipelines differ because a comment moved.
 * Positions live only in diagnostics, which are about the file by definition.
 */
export const PipelineGraphV1 = versioned("PipelineGraph", 1, {
  pipelineId: PipelineId,
  name: Type.Optional(Type.String({ minLength: 1 })),
  description: Type.Optional(Type.String({ minLength: 1 })),
  mode: PipelineExecutionMode,
  limits: PipelineLimits,
  context: PipelineContext,
  /** Sorted by `id`. */
  stages: Type.Array(PipelineStage, { minItems: 1 }),
  /** Sorted by `from`, then `to`, then the canonical rendering of `condition`. */
  edges: Type.Array(PipelineEdge),
});

/**
 * A diagnostic raised while reading a pipeline document.
 *
 * Structurally `@heniek/config`'s `Diagnostic` plus `suggestion`, and inlined
 * here for the same reason `configuration/schemas.ts` inlines its own copy:
 * registering it would give it an `$id` that then appears nested inside
 * another schema, an Ajv duplicate-`$id` hazard the moment two parents reach
 * one validator. Extending the configuration family's copy in place was the
 * alternative and was rejected — that object is embedded in
 * `ApplicationHome/v1`, `ResolvedConfiguration/v1`, and both `ResolvedProfile`
 * versions, so adding a field there changes four published digests to serve
 * one new consumer.
 *
 * `suggestion` is what makes a diagnostic actionable rather than merely
 * correct: "unknown stage type `agents`" names the rule, "did you mean
 * `agent`?" names the fix.
 */
const PipelineDiagnostic = Type.Object(
  {
    /** Open `string`, not an enum — codes grow additively; see the configuration family's copy. */
    code: Type.String({ minLength: 1 }),
    severity: Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info")]),
    message: Type.String(),
    sourcePath: Type.Optional(Type.String()),
    line: Type.Optional(Type.Integer({ minimum: 1 })),
    column: Type.Optional(Type.Integer({ minimum: 1 })),
    pointer: Type.Optional(Type.String()),
    suggestion: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

/**
 * The result of reading one pipeline document: the graph when it parsed, and
 * the diagnostics either way.
 *
 * `graph` is absent exactly when an error-severity diagnostic was raised, so
 * a consumer never has to decide whether a partially-built graph is safe to
 * use — there is no such thing here.
 */
export const PipelineValidationResultV1 = versioned("PipelineValidationResult", 1, {
  sourcePath: Type.Optional(Type.String({ minLength: 1 })),
  graph: Type.Optional(Type.Ref(PipelineGraphV1)),
  diagnostics: Type.Array(PipelineDiagnostic),
});
