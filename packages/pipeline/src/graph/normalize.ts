/**
 * Document → graph.
 *
 * This is the half of the parser that makes "equivalent YAML normalizes to
 * byte-identical graph JSON" true. Three things get collapsed here, and every
 * one of them is a place where two authors writing the same pipeline would
 * otherwise produce different bytes:
 *
 * 1. **Edge spelling.** `needs`, `transitions`, and top-level `edges` are
 *    three surfaces for one relation — §14.3 and §15.2 write plain sequences,
 *    §14.4 writes `when`/`then`, and a generated one-off graph (§14.1) is
 *    easiest to emit as explicit edges. All three become one sorted edge list.
 * 2. **Inherited values.** `mode` and `optional` are resolved to a concrete
 *    value on every stage, so a pipeline that sets the mode once at the top
 *    and one that repeats it on every stage are the same graph.
 * 3. **Order.** Stages, edges, reads, writes, overridable fields, and
 *    completion requirements are all sorted; the key order inside objects
 *    does not matter, because `canonicalJsonStringify` sorts keys at every
 *    level when the graph is rendered.
 *
 * Durations become milliseconds here too, via the same `hardLimitMagnitude`
 * the configuration layer uses to decide which of two hard limits is
 * stricter — one parser for `4h`, not two that can disagree.
 */

import { hardLimitMagnitude, joinPointer } from "@heniek/config";
import { PIPELINE_DIAGNOSTIC_CODES } from "../diagnostics.js";
import type {
  CompletionRequirement,
  CompletionRequirementDocument,
  ConditionDocument,
  PipelineCondition,
  PipelineDocument,
  PipelineEdge,
  PipelineGraph,
  PipelineStage,
  PipelineStageId,
  StageDocument,
} from "../document.js";
import { parseConditionExpression, renderExpressionExcerpt } from "../expression/parse.js";
import type { DiagnosticReporter } from "../reporter.js";
import { canonicalText, compareCodepoints } from "./canonical.js";

/**
 * An edge with the pointer it was authored at, so a later semantic
 * diagnostic (unknown endpoint, cycle, contradictory duplicate) can be
 * reported at the line the author actually wrote rather than at the graph as
 * a whole.
 */
export interface LocatedEdge {
  readonly edge: PipelineEdge;
  readonly pointer: string;
}

export interface NormalizedPipeline {
  readonly graph: PipelineGraph;
  /** Parallel to `graph.edges`, same order. */
  readonly edgePointers: readonly string[];
  /** Pointer of each stage, keyed by stage id; ids are unique by the time this is built. */
  readonly stagePointers: ReadonlyMap<string, string>;
}

export function normalizePipelineDocument(
  document: PipelineDocument,
  reporter: DiagnosticReporter,
): NormalizedPipeline {
  const pipelineMode = document.mode ?? "autonomous";

  const stagePointers = new Map<string, string>();
  const stages: PipelineStage[] = [];
  document.stages.forEach((stage, index) => {
    const pointer = joinPointer("/stages", index);
    // First writer wins: a duplicate id is reported by the validator, and
    // keeping the first pointer makes the *second* occurrence the one the
    // duplicate diagnostic points at, which is where the fix belongs.
    if (!stagePointers.has(stage.id)) {
      stagePointers.set(stage.id, pointer);
    }
    stages.push(normalizeStage(stage, pipelineMode));
  });
  stages.sort((left, right) => compareCodepoints(left.id, right.id));

  const located = collectEdges(document, reporter);
  located.sort(compareLocatedEdges);
  const deduped = dedupeEdges(located);

  const graph: PipelineGraph = {
    schemaVersion: 1,
    pipelineId: document.id,
    ...(document.name !== undefined ? { name: document.name } : {}),
    ...(document.description !== undefined ? { description: document.description } : {}),
    mode: pipelineMode,
    limits: {
      ...optionalDuration("maxPipelineDurationMs", document.limits?.max_pipeline_duration),
      ...optionalNumber("maxConcurrentWorkers", document.limits?.max_concurrent_workers),
      ...optionalNumber("maxRepairAttempts", document.limits?.max_repair_attempts),
      ...optionalNumber("maxGraphRevisions", document.limits?.max_graph_revisions),
    },
    context: {
      ...optionalNumber("handoffSoftThreshold", document.context?.handoff_soft_threshold),
      ...optionalNumber("handoffHardThreshold", document.context?.handoff_hard_threshold),
    },
    stages,
    edges: deduped.map((entry) => entry.edge),
  };

  return {
    graph,
    edgePointers: deduped.map((entry) => entry.pointer),
    stagePointers,
  };
}

/**
 * Takes no reporter: normalizing a stage cannot fail. Every value it reads has
 * already been accepted by `PipelineDefinition/v1`, and every rule that could
 * reject one is a statement about the whole graph, which belongs to
 * `validate.ts`. Conditions are the single exception, and they are compiled in
 * `collectEdges` rather than here.
 */
function normalizeStage(stage: StageDocument, pipelineMode: PipelineGraph["mode"]): PipelineStage {
  const completion = stage.completion;
  return {
    id: stage.id,
    type: stage.type,
    mode: stage.mode ?? pipelineMode,
    optional: stage.optional ?? false,
    ...(stage.profile !== undefined ? { profile: stage.profile } : {}),
    ...(stage.session !== undefined ? { session: { policy: stage.session.policy } } : {}),
    ...normalizeStageLimits(stage),
    ...(stage.command !== undefined ? { command: stage.command } : {}),
    ...(completion !== undefined
      ? {
          completion: {
            require: sortUnique(
              completion.require.map(normalizeCompletionRequirement),
              canonicalText,
            ),
          },
        }
      : {}),
    ...normalizeValidationFailure(stage),
    reads: sortUnique(stage.reads ?? [], (value) => value),
    writes: sortUnique(stage.writes ?? [], (value) => value),
    overridable: sortUnique(stage.overridable ?? [], (value) => value),
  } satisfies PipelineStage & Record<string, unknown>;
}

function normalizeStageLimits(stage: StageDocument): Pick<PipelineStage, "limits"> | object {
  const limits = stage.limits;
  if (limits === undefined) {
    return {};
  }
  const normalized = {
    ...optionalDuration("maxDurationMs", limits.max_duration),
    ...optionalNumber("maxRepairAttempts", limits.max_repair_attempts),
  };
  return { limits: normalized };
}

function normalizeValidationFailure(
  stage: StageDocument,
): Pick<PipelineStage, "onValidationFailure"> | object {
  const policy = stage.on_validation_failure;
  if (policy === undefined) {
    return {};
  }
  return {
    onValidationFailure: {
      strategy: policy.strategy,
      ...(policy.session !== undefined ? { session: policy.session } : {}),
      ...optionalNumber("maxAttempts", policy.max_attempts),
      ...(policy.delegate_to !== undefined ? { delegateTo: policy.delegate_to } : {}),
    },
  };
}

/**
 * §19.5's requirements all become `{ kind, ... }`. The authored forms are a
 * mix of bare strings and single-key mappings, which is comfortable to write
 * and awkward to consume; one discriminated shape is the reverse, and the
 * graph is the consumed artefact.
 */
function normalizeCompletionRequirement(
  requirement: CompletionRequirementDocument,
): CompletionRequirement {
  if (requirement === "valid_result_envelope") {
    return { kind: "result_envelope" };
  }
  if (requirement === "non_empty_diff") {
    return { kind: "non_empty_diff" };
  }
  if ("artifact" in requirement) {
    return { kind: "artifact", name: requirement.artifact };
  }
  if ("schema_check" in requirement) {
    return { kind: "schema_check", name: requirement.schema_check };
  }
  if ("sections" in requirement) {
    return { kind: "sections", names: [...requirement.sections] };
  }
  if ("command" in requirement) {
    return {
      kind: "command",
      argv: [...requirement.command.argv],
      ...optionalNumber("exitCode", requirement.command.exit_code),
    };
  }
  if ("repository_state" in requirement) {
    return { kind: "repository_state", state: requirement.repository_state };
  }
  return { kind: "verdict", profile: requirement.verdict };
}

/** Gathers `needs`, `transitions`, and `edges` into one list of located edges. */
function collectEdges(document: PipelineDocument, reporter: DiagnosticReporter): LocatedEdge[] {
  const located: LocatedEdge[] = [];

  document.stages.forEach((stage, stageIndex) => {
    const stagePointer = joinPointer("/stages", stageIndex);

    (stage.needs ?? []).forEach((dependency, needIndex) => {
      located.push({
        edge: { from: dependency, to: stage.id },
        pointer: joinPointer(joinPointer(stagePointer, "needs"), needIndex),
      });
    });

    (stage.transitions ?? []).forEach((transition, transitionIndex) => {
      const pointer = joinPointer(joinPointer(stagePointer, "transitions"), transitionIndex);
      located.push({
        edge: buildEdge(stage.id, transition.then, transition.when, pointer, reporter),
        pointer,
      });
    });
  });

  (document.edges ?? []).forEach((edge, edgeIndex) => {
    const pointer = joinPointer("/edges", edgeIndex);
    located.push({ edge: buildEdge(edge.from, edge.to, edge.when, pointer, reporter), pointer });
  });

  return located;
}

function buildEdge(
  from: PipelineStageId,
  to: PipelineStageId,
  when: ConditionDocument | undefined,
  pointer: string,
  reporter: DiagnosticReporter,
): PipelineEdge {
  if (when === undefined) {
    return { from, to };
  }
  const condition = normalizeCondition(when, pointer, reporter);
  return condition === undefined ? { from, to } : { from, to, condition };
}

/**
 * Compiles one condition. An expression that fails to parse yields
 * `undefined` and a diagnostic: the edge stays in the graph without a
 * condition so the remaining rules (unknown endpoint, cycle, unreachable
 * stage) still run and the author sees every problem in one pass. The graph
 * itself is discarded by the caller, since an error was raised — a
 * partially-compiled condition is never handed to a consumer.
 */
function normalizeCondition(
  when: ConditionDocument,
  pointer: string,
  reporter: DiagnosticReporter,
): PipelineCondition | undefined {
  if ("evaluator" in when) {
    return { kind: "evaluator", profile: when.evaluator, question: when.question };
  }

  const parsed = parseConditionExpression(when.expression);
  if (!parsed.ok) {
    reporter.error(
      PIPELINE_DIAGNOSTIC_CODES.expressionInvalid,
      `${parsed.error.message} (at character ${parsed.error.offset + 1} of the condition)`,
      joinPointer(joinPointer(pointer, "when"), "expression"),
      `Fix the condition at the marked character:\n${renderExpressionExcerpt(when.expression, parsed.error.offset)}`,
    );
    return undefined;
  }
  return { kind: "expression", nodes: [...parsed.nodes], root: parsed.root };
}

function compareLocatedEdges(left: LocatedEdge, right: LocatedEdge): number {
  const fromDelta = compareCodepoints(left.edge.from, right.edge.from);
  if (fromDelta !== 0) {
    return fromDelta;
  }
  const toDelta = compareCodepoints(left.edge.to, right.edge.to);
  if (toDelta !== 0) {
    return toDelta;
  }
  return compareCodepoints(conditionKey(left.edge), conditionKey(right.edge));
}

function conditionKey(edge: PipelineEdge): string {
  return edge.condition === undefined ? "" : canonicalText(edge.condition);
}

/**
 * Drops edges that are the same relation written twice — the same endpoints
 * *and* the same condition. That is set semantics, and it is what lets a
 * document declare `needs: [design]` and an explicit `design → critique` edge
 * without the two spellings producing a different graph than either alone.
 *
 * Two edges sharing endpoints but differing in condition are a genuine
 * contradiction and are left in place for `validate.ts` to report; silently
 * keeping both would leave a scheduler to guess.
 */
function dedupeEdges(edges: readonly LocatedEdge[]): LocatedEdge[] {
  const seen = new Set<string>();
  const kept: LocatedEdge[] = [];
  for (const entry of edges) {
    const key = `${entry.edge.from} ${entry.edge.to} ${conditionKey(entry.edge)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(entry);
  }
  return kept;
}

function sortUnique<T>(values: readonly T[], key: (value: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const value of values) {
    const identity = key(value);
    if (!byKey.has(identity)) {
      byKey.set(identity, value);
    }
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => compareCodepoints(left, right))
    .map(([, value]) => value);
}

function optionalNumber<K extends string>(
  key: K,
  value: number | undefined,
): Record<K, number> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

/**
 * `4h` → `14400000`. `hardLimitMagnitude` returns `undefined` only for a
 * string the duration pattern would have rejected, which the schema layer has
 * already refused, so the `undefined` branch is unreachable in practice and
 * omits the key rather than inventing a value if it ever is not.
 */
function optionalDuration<K extends string>(
  key: K,
  value: string | undefined,
): Record<K, number> | Record<string, never> {
  if (value === undefined) {
    return {};
  }
  const milliseconds = hardLimitMagnitude(value);
  /* c8 ignore next 3 -- unreachable: the document schema pins the duration pattern */
  if (milliseconds === undefined) {
    return {};
  }
  return { [key]: milliseconds } as Record<K, number>;
}
