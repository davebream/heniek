/**
 * The rules a JSON Schema cannot express.
 *
 * Everything here is a statement about the graph *as a whole* — an edge
 * naming a stage that exists, a read satisfied by an upstream write, a stage
 * limit no looser than the pipeline limit — so none of it can be checked one
 * value at a time, which is exactly the boundary between
 * `PipelineDefinition/v1` and this module.
 *
 * Every rule reports through the shared reporter, so every diagnostic it
 * raises carries the file, the pointer, the position, the code, and a
 * correction without any rule having to remember to attach them.
 */

import { joinPointer } from "@heniek/config";
import { PIPELINE_DIAGNOSTIC_CODES } from "../diagnostics.js";
import type { PipelineGraph, PipelineStage } from "../document.js";
import type { DiagnosticReporter } from "../reporter.js";
import { canonicalText, compareCodepoints } from "./canonical.js";
import type { NormalizedPipeline } from "./normalize.js";

export interface ValidatePipelineOptions {
  /**
   * Profile ids the caller knows exist. Omitted means "do not check": a
   * pipeline file is validated on its own here, and profiles live in
   * different files resolved through §8.2's layers against a capability
   * catalogue this package deliberately does not depend on. Supplying the
   * list turns an unknown profile into an error; omitting it leaves profile
   * references to whoever *runs* the pipeline, where the answer is knowable.
   */
  readonly knownProfileIds?: readonly string[];
}

/** The three namespaces §14.3's `reads`/`writes` references may address. */
const STATE_NAMESPACES = new Set(["task", "artifacts", "decisions"]);

/**
 * Namespaces a stage may *write*. `task` is the source work item as the
 * runtime supplies it, not an output surface — a stage that claims to write
 * it is describing something the run cannot honour.
 */
const WRITABLE_NAMESPACES = new Set(["artifacts", "decisions"]);

/** Stage types that resolve a worker profile, and therefore require one (§14.2, §15.1). */
const PROFILE_STAGE_TYPES = new Set(["agent", "verify"]);

/** Stage types that never resolve a profile — declaring one would be silently ignored at run time. */
const PROFILE_FREE_STAGE_TYPES = new Set(["command", "approval"]);

export function validatePipelineGraph(
  normalized: NormalizedPipeline,
  reporter: DiagnosticReporter,
  options: ValidatePipelineOptions = {},
): void {
  const { graph, stagePointers, edgePointers } = normalized;

  const stagesById = new Map<string, PipelineStage>();
  for (const stage of graph.stages) {
    stagesById.set(stage.id, stage);
  }

  validateStageIds(normalized, reporter);
  validateStageShapes(graph, stagePointers, reporter, options);
  validateContext(graph, reporter);
  validateLimits(graph, stagePointers, reporter);

  const endpointsResolve = validateEdgeEndpoints(graph, edgePointers, stagesById, reporter);
  validateDuplicateEdges(graph, edgePointers, reporter);
  validateConditionProfiles(graph, edgePointers, reporter, options);

  // Reachability and cycle detection are meaningless while an edge names a
  // stage that does not exist: every such edge would be reported again as a
  // phantom cycle or a phantom unreachable stage, burying the one diagnostic
  // that actually explains the failure.
  if (!endpointsResolve) {
    return;
  }

  validateAcyclic(graph, stagePointers, reporter);
  validateStageReachability(graph, stagePointers, reporter);
  validateStateFlow(graph, stagePointers, computeAncestors(graph), reporter);
}

/** Duplicate ids make every later rule ambiguous, so this one runs first and alone. */
function validateStageIds(normalized: NormalizedPipeline, reporter: DiagnosticReporter): void {
  // Counted over the graph's (sorted) stage list rather than the document's,
  // so the diagnostics come out ordered by id; the pointer still comes from
  // the document, so the reported position is the author's.
  const counts = new Map<string, number>();
  for (const stage of normalized.graph.stages) {
    counts.set(stage.id, (counts.get(stage.id) ?? 0) + 1);
  }
  for (const [id, count] of counts) {
    if (count > 1) {
      reporter.error(
        PIPELINE_DIAGNOSTIC_CODES.duplicateStageId,
        `Stage id "${id}" is declared ${count} times.`,
        normalized.stagePointers.get(id) ?? "/stages",
        "Give each stage a unique id; a later stage referring to this one cannot say which it means.",
      );
    }
  }
}

function validateStageShapes(
  graph: PipelineGraph,
  stagePointers: ReadonlyMap<string, string>,
  reporter: DiagnosticReporter,
  options: ValidatePipelineOptions,
): void {
  const known =
    options.knownProfileIds === undefined ? undefined : new Set(options.knownProfileIds);

  for (const stage of graph.stages) {
    const pointer = stagePointers.get(stage.id) ?? "/stages";

    if (PROFILE_STAGE_TYPES.has(stage.type) && stage.profile === undefined) {
      reporter.error(
        PIPELINE_DIAGNOSTIC_CODES.profileRequired,
        `${article(stage.type)} "${stage.type}" stage runs a worker, so it must name a profile.`,
        joinPointer(pointer, "profile"),
        "Add `profile: <name>`, for example `profile: sol-critic`.",
      );
    }
    if (PROFILE_FREE_STAGE_TYPES.has(stage.type) && stage.profile !== undefined) {
      reporter.error(
        PIPELINE_DIAGNOSTIC_CODES.profileNotAllowed,
        `${article(stage.type)} "${stage.type}" stage does not run a worker, so a profile would never be used.`,
        joinPointer(pointer, "profile"),
        "Remove `profile`, or change the stage type to `agent` if it should run a worker.",
      );
    }

    if (stage.type === "command" && stage.command === undefined) {
      reporter.error(
        PIPELINE_DIAGNOSTIC_CODES.commandRequired,
        'A "command" stage must declare what to run.',
        joinPointer(pointer, "command"),
        "Add `command: { argv: [...] }`, for example `argv: [pnpm, test]`.",
      );
    }
    if (stage.type !== "command" && stage.command !== undefined) {
      reporter.error(
        PIPELINE_DIAGNOSTIC_CODES.commandNotAllowed,
        `${article(stage.type)} "${stage.type}" stage does not run a command.`,
        joinPointer(pointer, "command"),
        "Remove `command`, or change the stage type to `command`.",
      );
    }

    validateStageProfiles(stage, pointer, known, reporter);
    validateValidationFailurePolicy(stage, pointer, reporter);
  }
}

/** Every profile a stage names — its worker, its verdict requirements, its repair delegate. */
function validateStageProfiles(
  stage: PipelineStage,
  pointer: string,
  known: ReadonlySet<string> | undefined,
  reporter: DiagnosticReporter,
): void {
  const references: { readonly profile: string; readonly pointer: string }[] = [];
  if (stage.profile !== undefined) {
    references.push({ profile: stage.profile, pointer: joinPointer(pointer, "profile") });
  }
  if (stage.onValidationFailure?.delegateTo !== undefined) {
    references.push({
      profile: stage.onValidationFailure.delegateTo,
      pointer: joinPointer(joinPointer(pointer, "on_validation_failure"), "delegate_to"),
    });
  }
  stage.completion?.require.forEach((requirement, index) => {
    if (requirement.kind === "verdict") {
      references.push({
        profile: requirement.profile,
        pointer: joinPointer(joinPointer(joinPointer(pointer, "completion"), "require"), index),
      });
    }
  });

  if (known === undefined) {
    return;
  }
  for (const reference of references) {
    if (!known.has(reference.profile)) {
      reporter.error(
        PIPELINE_DIAGNOSTIC_CODES.profileNotDeclared,
        `Profile "${reference.profile}" is not declared in the resolved configuration.`,
        reference.pointer,
        `Declare "${reference.profile}" under \`profiles:\`, or name one that already exists.`,
      );
    }
  }
}

function validateValidationFailurePolicy(
  stage: PipelineStage,
  pointer: string,
  reporter: DiagnosticReporter,
): void {
  const policy = stage.onValidationFailure;
  if (policy === undefined) {
    return;
  }
  const policyPointer = joinPointer(pointer, "on_validation_failure");
  if (policy.strategy === "delegate" && policy.delegateTo === undefined) {
    reporter.error(
      PIPELINE_DIAGNOSTIC_CODES.delegateTargetRequired,
      'A "delegate" repair strategy must name the profile the repair is delegated to.',
      joinPointer(policyPointer, "delegate_to"),
      "Add `delegate_to: <profile>`, or choose `repair` to retry with this stage's own profile.",
    );
  }
  if (policy.strategy !== "delegate" && policy.delegateTo !== undefined) {
    reporter.error(
      PIPELINE_DIAGNOSTIC_CODES.delegateTargetNotAllowed,
      `${article(policy.strategy)} "${policy.strategy}" repair strategy never delegates, so \`delegate_to\` would be ignored.`,
      joinPointer(policyPointer, "delegate_to"),
      "Remove `delegate_to`, or set `strategy: delegate`.",
    );
  }
}

/** §15.3's thresholds are a soft point followed by a hard one; inverted, neither can fire as described. */
function validateContext(graph: PipelineGraph, reporter: DiagnosticReporter): void {
  const soft = graph.context.handoffSoftThreshold;
  const hard = graph.context.handoffHardThreshold;
  if (soft !== undefined && hard !== undefined && soft > hard) {
    reporter.error(
      PIPELINE_DIAGNOSTIC_CODES.contextThresholdsInverted,
      `The soft handoff threshold (${soft}) is above the hard threshold (${hard}).`,
      "/context/handoff_soft_threshold",
      "The soft threshold warns first, so it must be the lower of the two — for example `0.65` and `0.80`.",
    );
  }
}

/**
 * §24's "profile/stage limits may be stricter". A stage limit *looser* than
 * the pipeline limit is not merely ineffective — it reads like a licence the
 * run will not grant, which is the kind of quiet disagreement between a
 * document and its behaviour this parser exists to prevent.
 */
function validateLimits(
  graph: PipelineGraph,
  stagePointers: ReadonlyMap<string, string>,
  reporter: DiagnosticReporter,
): void {
  const pipelineRepairs = graph.limits.maxRepairAttempts;
  const pipelineDuration = graph.limits.maxPipelineDurationMs;

  for (const stage of graph.stages) {
    const pointer = stagePointers.get(stage.id) ?? "/stages";
    const stageRepairs = stage.limits?.maxRepairAttempts;
    if (
      pipelineRepairs !== undefined &&
      stageRepairs !== undefined &&
      stageRepairs > pipelineRepairs
    ) {
      reporter.error(
        PIPELINE_DIAGNOSTIC_CODES.limitNotStricter,
        `Stage "${stage.id}" allows ${stageRepairs} repair attempts, more than the pipeline limit of ${pipelineRepairs}.`,
        joinPointer(joinPointer(pointer, "limits"), "max_repair_attempts"),
        `Lower it to ${pipelineRepairs} or below — the strictest applicable limit is the one that applies.`,
      );
    }

    const stageDuration = stage.limits?.maxDurationMs;
    if (
      pipelineDuration !== undefined &&
      stageDuration !== undefined &&
      stageDuration > pipelineDuration
    ) {
      reporter.error(
        PIPELINE_DIAGNOSTIC_CODES.limitNotStricter,
        `Stage "${stage.id}" may run for ${stageDuration}ms, longer than the whole pipeline's ${pipelineDuration}ms.`,
        joinPointer(joinPointer(pointer, "limits"), "max_duration"),
        "Shorten the stage limit so it fits inside `limits.max_pipeline_duration`.",
      );
    }

    const attempts = stage.onValidationFailure?.maxAttempts;
    const effectiveRepairs = stageRepairs ?? pipelineRepairs;
    if (attempts !== undefined && effectiveRepairs !== undefined && attempts > effectiveRepairs) {
      reporter.error(
        PIPELINE_DIAGNOSTIC_CODES.repairAttemptsExceedLimit,
        `Stage "${stage.id}" declares ${attempts} repair attempts, more than the ${effectiveRepairs} its limits allow.`,
        joinPointer(joinPointer(pointer, "on_validation_failure"), "max_attempts"),
        `Lower \`max_attempts\` to ${effectiveRepairs} or below, or raise the repair limit.`,
      );
    }
  }
}

/** Returns `false` when any endpoint is unresolvable, so the caller can skip graph-shaped rules. */
function validateEdgeEndpoints(
  graph: PipelineGraph,
  edgePointers: readonly string[],
  stagesById: ReadonlyMap<string, PipelineStage>,
  reporter: DiagnosticReporter,
): boolean {
  let resolved = true;
  graph.edges.forEach((edge, index) => {
    const pointer = edgePointers[index] ?? "/edges";
    for (const [side, id] of [
      ["from", edge.from],
      ["to", edge.to],
    ] as const) {
      if (!stagesById.has(id)) {
        resolved = false;
        reporter.error(
          PIPELINE_DIAGNOSTIC_CODES.unknownStageReference,
          `No stage with id "${id}" is declared.`,
          pointer,
          `Declare a stage with id "${id}", or point this ${side === "from" ? "dependency" : "transition"} at an existing stage.`,
        );
      }
    }
    if (edge.from === edge.to) {
      resolved = false;
      reporter.error(
        PIPELINE_DIAGNOSTIC_CODES.selfEdge,
        `Stage "${edge.from}" depends on itself.`,
        pointer,
        "Remove the self-reference; a stage cannot wait for its own completion.",
      );
    }
  });
  return resolved;
}

/**
 * Two edges with the same endpoints but different conditions. Identical
 * duplicates were already collapsed by the normalizer — the same relation
 * written twice is still one relation — so anything reaching here is a
 * genuine disagreement about when the transition fires.
 */
function validateDuplicateEdges(
  graph: PipelineGraph,
  edgePointers: readonly string[],
  reporter: DiagnosticReporter,
): void {
  const byEndpoints = new Map<string, number[]>();
  graph.edges.forEach((edge, index) => {
    const key = `${edge.from} ${edge.to}`;
    const bucket = byEndpoints.get(key);
    if (bucket === undefined) {
      byEndpoints.set(key, [index]);
    } else {
      bucket.push(index);
    }
  });

  for (const [key, indices] of byEndpoints) {
    if (indices.length < 2) {
      continue;
    }
    const [from, to] = key.split(" ");
    for (const index of indices.slice(1)) {
      reporter.error(
        PIPELINE_DIAGNOSTIC_CODES.duplicateEdge,
        `"${from}" leads to "${to}" more than once, under different conditions.`,
        edgePointers[index] ?? "/edges",
        "Combine them into one edge — use `||` inside a single expression if either condition should allow the transition.",
      );
    }
  }
}

function validateConditionProfiles(
  graph: PipelineGraph,
  edgePointers: readonly string[],
  reporter: DiagnosticReporter,
  options: ValidatePipelineOptions,
): void {
  if (options.knownProfileIds === undefined) {
    return;
  }
  const known = new Set(options.knownProfileIds);
  graph.edges.forEach((edge, index) => {
    if (edge.condition?.kind !== "evaluator") {
      return;
    }
    if (!known.has(edge.condition.profile)) {
      reporter.error(
        PIPELINE_DIAGNOSTIC_CODES.profileNotDeclared,
        `Evaluator profile "${edge.condition.profile}" is not declared in the resolved configuration.`,
        joinPointer(joinPointer(edgePointers[index] ?? "/edges", "when"), "evaluator"),
        `Declare "${edge.condition.profile}" under \`profiles:\`, or name one that already exists.`,
      );
    }
  });
}

function validateAcyclic(
  graph: PipelineGraph,
  stagePointers: ReadonlyMap<string, string>,
  reporter: DiagnosticReporter,
): void {
  const cycle = findCycle(graph);
  if (cycle === undefined) {
    return;
  }
  const entry = cycle[0] ?? "";
  reporter.error(
    PIPELINE_DIAGNOSTIC_CODES.cycle,
    `These stages depend on each other in a cycle: ${cycle.join(" → ")}.`,
    stagePointers.get(entry) ?? "/stages",
    "Break the cycle by removing one dependency; a pipeline is a DAG, so no stage may wait for a stage that waits for it.",
  );
}

/**
 * Iterative depth-first search with an explicit stack. Recursion would be
 * shorter and would also make a pathological graph a stack overflow rather
 * than a diagnostic, in a function whose whole job is to report pathological
 * graphs.
 *
 * Both the outer iteration and the successor lists are visited in sorted
 * order, so the *same* graph always reports the *same* cycle — a diagnostic
 * that names a different one of several cycles per run is not a stable
 * artefact.
 */
function findCycle(graph: PipelineGraph): readonly string[] | undefined {
  const successors = buildSuccessors(graph);
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];

  const roots = graph.stages.map((stage) => stage.id);
  for (const root of roots) {
    if (state.get(root) === "done") {
      continue;
    }
    const stack: { readonly id: string; index: number }[] = [{ id: root, index: 0 }];
    state.set(root, "visiting");
    path.push(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      /* c8 ignore next 3 -- the loop condition guarantees a top frame */
      if (frame === undefined) {
        break;
      }
      const children = successors.get(frame.id) ?? [];
      if (frame.index >= children.length) {
        state.set(frame.id, "done");
        stack.pop();
        path.pop();
        continue;
      }
      const child = children[frame.index] ?? "";
      frame.index += 1;
      const childState = state.get(child);
      if (childState === "visiting") {
        const start = path.indexOf(child);
        return [...path.slice(start), child];
      }
      if (childState === "done") {
        continue;
      }
      state.set(child, "visiting");
      path.push(child);
      stack.push({ id: child, index: 0 });
    }
  }
  return undefined;
}

function buildSuccessors(graph: PipelineGraph): ReadonlyMap<string, readonly string[]> {
  const successors = new Map<string, string[]>();
  for (const stage of graph.stages) {
    successors.set(stage.id, []);
  }
  for (const edge of graph.edges) {
    successors.get(edge.from)?.push(edge.to);
  }
  for (const children of successors.values()) {
    children.sort(compareCodepoints);
  }
  return successors;
}

/**
 * A stage with no path from any entry stage can never run. Reported per
 * stage rather than once for the set, because the fix — an edge, or a
 * deletion — is per stage.
 */
function validateStageReachability(
  graph: PipelineGraph,
  stagePointers: ReadonlyMap<string, string>,
  reporter: DiagnosticReporter,
): void {
  const incoming = new Set(graph.edges.map((edge) => edge.to));
  const entries = graph.stages.filter((stage) => !incoming.has(stage.id));

  if (entries.length === 0) {
    reporter.error(
      PIPELINE_DIAGNOSTIC_CODES.noEntryStage,
      "Every stage depends on another stage, so the pipeline has nowhere to start.",
      "/stages",
      "Leave at least one stage with no `needs` and no incoming edge.",
    );
    return;
  }

  const reached = new Set<string>();
  const successors = buildSuccessors(graph);
  const queue: string[] = entries.map((stage) => stage.id);
  for (const id of queue) {
    reached.add(id);
  }
  while (queue.length > 0) {
    const current = queue.shift() ?? "";
    for (const child of successors.get(current) ?? []) {
      if (!reached.has(child)) {
        reached.add(child);
        queue.push(child);
      }
    }
  }

  for (const stage of graph.stages) {
    if (!reached.has(stage.id)) {
      reporter.error(
        PIPELINE_DIAGNOSTIC_CODES.unreachableStage,
        `Stage "${stage.id}" cannot be reached from any starting stage.`,
        stagePointers.get(stage.id) ?? "/stages",
        `Connect "${stage.id}" to the graph with \`needs\` or an edge, or remove it.`,
      );
    }
  }
}

/**
 * Ancestors of every stage, computed once for the `reads`/`writes` rules.
 * The visited set makes the walk terminate on a cyclic graph too — a cycle is
 * reported separately, but the remaining rules still run so the author sees
 * every problem in one pass rather than one per fix.
 */
function computeAncestors(graph: PipelineGraph): ReadonlyMap<string, ReadonlySet<string>> {
  const predecessors = new Map<string, string[]>();
  for (const stage of graph.stages) {
    predecessors.set(stage.id, []);
  }
  for (const edge of graph.edges) {
    predecessors.get(edge.to)?.push(edge.from);
  }

  const ancestors = new Map<string, ReadonlySet<string>>();
  for (const stage of graph.stages) {
    const collected = new Set<string>();
    const queue = [...(predecessors.get(stage.id) ?? [])];
    while (queue.length > 0) {
      const current = queue.shift() ?? "";
      if (collected.has(current)) {
        continue;
      }
      collected.add(current);
      queue.push(...(predecessors.get(current) ?? []));
    }
    ancestors.set(stage.id, collected);
  }
  return ancestors;
}

/**
 * §14.3's declared dependencies, checked against the graph that will actually
 * run them: a namespace that exists, a write into a namespace a stage may
 * write, a read some ancestor produces, and no two concurrent stages claiming
 * the same output.
 */
function validateStateFlow(
  graph: PipelineGraph,
  stagePointers: ReadonlyMap<string, string>,
  ancestors: ReadonlyMap<string, ReadonlySet<string>>,
  reporter: DiagnosticReporter,
): void {
  const producers = new Map<string, string[]>();

  for (const stage of graph.stages) {
    const pointer = stagePointers.get(stage.id) ?? "/stages";

    stage.reads.forEach((reference, index) => {
      const namespace = namespaceOf(reference);
      if (!STATE_NAMESPACES.has(namespace)) {
        reporter.error(
          PIPELINE_DIAGNOSTIC_CODES.unknownStateNamespace,
          `"${reference}" starts with "${namespace}", which is not part of the canonical run state.`,
          joinPointer(joinPointer(pointer, "reads"), index),
          "Read from `task.`, `artifacts.`, or `decisions.`.",
        );
      }
    });

    stage.writes.forEach((reference, index) => {
      const namespace = namespaceOf(reference);
      if (!STATE_NAMESPACES.has(namespace)) {
        reporter.error(
          PIPELINE_DIAGNOSTIC_CODES.unknownStateNamespace,
          `"${reference}" starts with "${namespace}", which is not part of the canonical run state.`,
          joinPointer(joinPointer(pointer, "writes"), index),
          "Write to `artifacts.` or `decisions.`.",
        );
        return;
      }
      if (!WRITABLE_NAMESPACES.has(namespace)) {
        reporter.error(
          PIPELINE_DIAGNOSTIC_CODES.writeNotAllowed,
          `"${reference}" is supplied by the run, so a stage cannot write it.`,
          joinPointer(joinPointer(pointer, "writes"), index),
          "Write to `artifacts.` or `decisions.` instead.",
        );
        return;
      }
      const bucket = producers.get(reference);
      if (bucket === undefined) {
        producers.set(reference, [stage.id]);
      } else {
        bucket.push(stage.id);
      }
    });
  }

  validateReadsAreProduced(graph, stagePointers, ancestors, producers, reporter);
  validateWriteConflicts(graph, stagePointers, ancestors, producers, reporter);
}

/**
 * A read is satisfied when some ancestor writes it, or writes a prefix of it:
 * §14.3 reads `artifacts.design.selected` from a stage that writes
 * `artifacts.design`, because the alias is a view of the artifact, not a
 * separate output. `task.*` is always available — the run supplies it.
 */
function validateReadsAreProduced(
  graph: PipelineGraph,
  stagePointers: ReadonlyMap<string, string>,
  ancestors: ReadonlyMap<string, ReadonlySet<string>>,
  producers: ReadonlyMap<string, readonly string[]>,
  reporter: DiagnosticReporter,
): void {
  for (const stage of graph.stages) {
    const pointer = stagePointers.get(stage.id) ?? "/stages";
    const upstream = ancestors.get(stage.id) ?? new Set<string>();

    stage.reads.forEach((reference, index) => {
      // A reference in an unknown namespace was already reported as such;
      // adding "and nothing writes it" on top says the same mistake twice and
      // buries the one diagnostic that names the actual problem.
      if (!STATE_NAMESPACES.has(namespaceOf(reference)) || namespaceOf(reference) === "task") {
        return;
      }
      const producedBy = prefixesOf(reference).flatMap((prefix) => producers.get(prefix) ?? []);
      if (producedBy.length === 0) {
        reporter.error(
          PIPELINE_DIAGNOSTIC_CODES.readNotProduced,
          `Nothing in this pipeline writes "${reference}".`,
          joinPointer(joinPointer(pointer, "reads"), index),
          `Add a stage that writes "${reference}", or remove the read.`,
        );
        return;
      }
      if (!producedBy.some((producer) => upstream.has(producer))) {
        reporter.error(
          PIPELINE_DIAGNOSTIC_CODES.readNotProduced,
          `"${reference}" is written by ${formatList(producedBy)}, which "${stage.id}" does not depend on.`,
          joinPointer(joinPointer(pointer, "reads"), index),
          `Add a dependency so "${stage.id}" runs after ${formatList(producedBy)}.`,
        );
      }
    });
  }
}

/**
 * Two stages writing the same target are fine when one runs after the other —
 * §16.2's active artifact alias is mutable, so a later stage may supersede an
 * earlier one's output. Two stages that may run *concurrently* writing the
 * same target is a race whose winner depends on scheduling, which is exactly
 * what a deterministic control plane must not have.
 */
function validateWriteConflicts(
  graph: PipelineGraph,
  stagePointers: ReadonlyMap<string, string>,
  ancestors: ReadonlyMap<string, ReadonlySet<string>>,
  producers: ReadonlyMap<string, readonly string[]>,
  reporter: DiagnosticReporter,
): void {
  for (const [reference, writers] of [...producers].sort(([left], [right]) =>
    compareCodepoints(left, right),
  )) {
    if (writers.length < 2) {
      continue;
    }
    const sorted = [...writers].sort(compareCodepoints);
    for (let outer = 0; outer < sorted.length; outer += 1) {
      for (let inner = outer + 1; inner < sorted.length; inner += 1) {
        const first = sorted[outer] ?? "";
        const second = sorted[inner] ?? "";
        const ordered =
          (ancestors.get(second)?.has(first) ?? false) ||
          (ancestors.get(first)?.has(second) ?? false);
        if (ordered) {
          continue;
        }
        const stage = graph.stages.find((candidate) => candidate.id === second);
        const index = stage?.writes.indexOf(reference) ?? -1;
        const pointer = stagePointers.get(second) ?? "/stages";
        reporter.error(
          PIPELINE_DIAGNOSTIC_CODES.conflictingWrites,
          `"${first}" and "${second}" both write "${reference}" and may run at the same time.`,
          index >= 0 ? joinPointer(joinPointer(pointer, "writes"), index) : pointer,
          `Order the two stages so one runs after the other, or have them write different targets.`,
        );
      }
    }
  }
}

/**
 * "A" or "An" for a stage type or strategy name. Diagnostics are read by
 * people, and `A "agent" stage` is the kind of small wrongness that makes a
 * tool feel unmaintained.
 */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "An" : "A";
}

function namespaceOf(reference: string): string {
  const dot = reference.indexOf(".");
  return dot < 0 ? reference : reference.slice(0, dot);
}

/** `artifacts.design.selected` → `["artifacts.design.selected", "artifacts.design"]`. */
function prefixesOf(reference: string): readonly string[] {
  const segments = reference.split(".");
  const prefixes: string[] = [];
  for (let length = segments.length; length >= 2; length -= 1) {
    prefixes.push(segments.slice(0, length).join("."));
  }
  return prefixes;
}

function formatList(values: readonly string[]): string {
  const sorted = [...new Set(values)].sort(compareCodepoints).map((value) => `"${value}"`);
  if (sorted.length === 1) {
    return sorted[0] ?? "";
  }
  const last = sorted[sorted.length - 1] ?? "";
  return `${sorted.slice(0, -1).join(", ")} and ${last}`;
}

/** Re-exported for the snapshot tests, which compare canonical text of the whole graph. */
export { canonicalText };
