/**
 * Pure deterministic pipeline scheduler.
 *
 * One tick consumes a `PipelineSchedulerInput/v1`-shaped snapshot and
 * produces a `PipelineSchedulerPlan/v1`-shaped plan. Decisions are sorted by
 * canonical stage id; attempt and intent ids are derived, never minted.
 * Nothing here reads a clock, the filesystem, or the network — `now` arrives
 * as an explicit input.
 */

import type {
  PipelineSchedulerDecisionAction,
  PipelineStageState,
  PipelineTransitionReason,
} from "@heniek/contracts";
import type { PipelineEdge, PipelineGraph, PipelineStage } from "../document.js";
import { evaluateExpressionCondition, type JsonValue } from "../expression/evaluate.js";
import { deriveAttemptId, deriveDecisionId, deriveIntentId, edgeKey } from "./ids.js";
import { assertPermittedTransition, isTerminalStageState } from "./transitions.js";

/**
 * Pure-scheduler shapes. Id fields are plain strings: brands belong on the
 * published contracts for wire validation; this function derives text ids and
 * must stay free of brand-assignment noise at every construction site.
 */
export interface StageSnapshot {
  schemaVersion: 1;
  runId: string;
  stageId: string;
  graphRevision: number;
  generation: number;
  state: PipelineStageState;
  attemptOrdinal: number;
  currentAttemptId?: string;
  lastTransitionReason?: PipelineTransitionReason;
  blockReason?: string;
  selected: boolean;
  updatedAt: string;
}

export interface SchedulerObservation {
  schemaVersion: 1;
  observationId: string;
  kind:
    | "attempt_started"
    | "attempt_waiting"
    | "attempt_succeeded"
    | "attempt_failed"
    | "cancellation_settled"
    | "evaluator_decided"
    | "cancel_requested"
    | "manual_rerun";
  stageId?: string;
  attemptId?: string;
  retryable?: boolean;
  edgeKey?: string;
  selected?: boolean;
  recordedAt: string;
}

export interface SchedulerDecision {
  schemaVersion: 1;
  decisionId: string;
  runId: string;
  stageId?: string;
  graphRevision: number;
  generation: number;
  attemptOrdinal: number;
  action: PipelineSchedulerDecisionAction;
  reason: PipelineTransitionReason;
  fromState?: PipelineStageState;
  toState?: PipelineStageState;
  attemptId?: string;
  intentId?: string;
  detail?: string;
  recordedAt: string;
}

export interface SchedulerIntent {
  schemaVersion: 1;
  intentId: string;
  runId: string;
  graphRevision: number;
  kind: "dispatch" | "cancel" | "evaluator";
  payload: unknown;
  createdAt: string;
}

export interface StageAttempt {
  schemaVersion: 1;
  attemptId: string;
  runId: string;
  pipelineId: string;
  stageId: string;
  graphRevision: number;
  generation: number;
  attemptOrdinal: number;
  stageType: string;
  createdAt: string;
}

export interface StageTransition {
  schemaVersion: 1;
  stageId: string;
  from: PipelineStageState;
  to: PipelineStageState;
  reason: PipelineTransitionReason;
  attemptId?: string;
  generation: number;
  blockReason?: string;
}

export interface ScheduleTerminal {
  schemaVersion: 1;
  outcome: "succeeded" | "failed" | "cancelled" | "blocked";
  reason: string;
  blockedStageId?: string;
}

export interface SchedulerInput {
  schemaVersion: 1;
  runId: string;
  pipelineId: string;
  graphRevision: number;
  scheduleRevision: number;
  graph: PipelineGraph;
  now: string;
  deadlineAt?: string;
  stages: StageSnapshot[];
  observations: SchedulerObservation[];
  canonicalState: unknown;
  pendingEvaluatorEdgeKeys: string[];
  evaluatorDecisions: { edgeKey: string; selected: boolean; recordedAt: string }[];
}

export interface SchedulerPlan {
  schemaVersion: 1;
  runId: string;
  graphRevision: number;
  expectedScheduleRevision: number;
  nextScheduleRevision: number;
  recordedAt: string;
  transitions: StageTransition[];
  decisions: SchedulerDecision[];
  intents: SchedulerIntent[];
  attempts: StageAttempt[];
  stagePatches: StageSnapshot[];
  consumedObservationIds: string[];
  terminal?: ScheduleTerminal;
}

interface MutableStage {
  runId: string;
  stageId: string;
  graphRevision: number;
  generation: number;
  state: PipelineStageState;
  attemptOrdinal: number;
  currentAttemptId?: string | undefined;
  lastTransitionReason?: PipelineTransitionReason | undefined;
  blockReason?: string | undefined;
  selected: boolean;
  updatedAt: string;
  schemaVersion: 1;
}

interface TickContext {
  readonly input: SchedulerInput;
  readonly graph: PipelineGraph;
  readonly stagesById: ReadonlyMap<string, PipelineStage>;
  readonly incoming: ReadonlyMap<string, readonly PipelineEdge[]>;
  readonly outgoing: ReadonlyMap<string, readonly PipelineEdge[]>;
  readonly descendants: ReadonlyMap<string, readonly string[]>;
  readonly working: Map<string, MutableStage>;
  readonly evaluatorDecisions: Map<string, boolean>;
  readonly pendingEvaluators: Set<string>;
  readonly transitions: StageTransition[];
  readonly decisions: SchedulerDecision[];
  readonly intents: SchedulerIntent[];
  readonly attempts: StageAttempt[];
  readonly consumedObservationIds: string[];
  cancelRequested: boolean;
  deadlineExceeded: boolean;
}

function freezeSnapshot(stage: MutableStage): StageSnapshot {
  const snapshot: StageSnapshot = {
    schemaVersion: 1,
    runId: stage.runId,
    stageId: stage.stageId,
    graphRevision: stage.graphRevision,
    generation: stage.generation,
    state: stage.state,
    attemptOrdinal: stage.attemptOrdinal,
    selected: stage.selected,
    updatedAt: stage.updatedAt,
  };
  if (stage.currentAttemptId !== undefined) {
    (snapshot as { currentAttemptId?: string }).currentAttemptId = stage.currentAttemptId;
  }
  if (stage.lastTransitionReason !== undefined) {
    (snapshot as { lastTransitionReason?: PipelineTransitionReason }).lastTransitionReason =
      stage.lastTransitionReason;
  }
  if (stage.blockReason !== undefined) {
    (snapshot as { blockReason?: string }).blockReason = stage.blockReason;
  }
  return snapshot;
}

function cloneStage(snapshot: StageSnapshot): MutableStage {
  return {
    schemaVersion: 1,
    runId: snapshot.runId,
    stageId: snapshot.stageId,
    graphRevision: snapshot.graphRevision,
    generation: snapshot.generation,
    state: snapshot.state,
    attemptOrdinal: snapshot.attemptOrdinal,
    currentAttemptId: snapshot.currentAttemptId,
    lastTransitionReason: snapshot.lastTransitionReason,
    blockReason: snapshot.blockReason,
    selected: snapshot.selected,
    updatedAt: snapshot.updatedAt,
  };
}

function buildEdgeMaps(graph: PipelineGraph): {
  readonly incoming: ReadonlyMap<string, readonly PipelineEdge[]>;
  readonly outgoing: ReadonlyMap<string, readonly PipelineEdge[]>;
} {
  const incoming = new Map<string, PipelineEdge[]>();
  const outgoing = new Map<string, PipelineEdge[]>();
  for (const stage of graph.stages) {
    incoming.set(stage.id, []);
    outgoing.set(stage.id, []);
  }
  for (const edge of graph.edges) {
    incoming.get(edge.to)!.push(edge);
    outgoing.get(edge.from)!.push(edge);
  }
  return { incoming, outgoing };
}

function buildDescendants(graph: PipelineGraph): ReadonlyMap<string, readonly string[]> {
  const successors = new Map<string, string[]>();
  for (const stage of graph.stages) {
    successors.set(stage.id, []);
  }
  for (const edge of graph.edges) {
    successors.get(edge.from)!.push(edge.to);
  }
  const result = new Map<string, string[]>();
  for (const stage of graph.stages) {
    const seen = new Set<string>();
    const stack = [...successors.get(stage.id)!];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) {
        continue;
      }
      seen.add(next);
      for (const child of successors.get(next) ?? []) {
        stack.push(child);
      }
    }
    result.set(stage.id, [...seen].sort());
  }
  return result;
}

function recordDecision(
  ctx: TickContext,
  input: {
    readonly stageId: string;
    readonly action: PipelineSchedulerDecisionAction;
    readonly reason: PipelineTransitionReason;
    readonly fromState?: PipelineStageState;
    readonly toState?: PipelineStageState;
    readonly attemptId?: string;
    readonly intentId?: string;
    readonly detail?: string;
    readonly generation: number;
    readonly attemptOrdinal: number;
  },
): void {
  const decisionId = deriveDecisionId({
    runId: ctx.input.runId,
    graphRevision: ctx.input.graphRevision,
    stageId: input.stageId,
    generation: input.generation,
    attemptOrdinal: input.attemptOrdinal,
    action: input.action,
  });
  if (ctx.decisions.some((decision) => decision.decisionId === decisionId)) {
    return;
  }
  const decision: SchedulerDecision = {
    schemaVersion: 1,
    decisionId,
    runId: ctx.input.runId,
    stageId: input.stageId,
    graphRevision: ctx.input.graphRevision,
    generation: input.generation,
    attemptOrdinal: input.attemptOrdinal,
    action: input.action,
    reason: input.reason,
    recordedAt: ctx.input.now,
  };
  if (input.fromState !== undefined) {
    (decision as { fromState?: PipelineStageState }).fromState = input.fromState;
  }
  if (input.toState !== undefined) {
    (decision as { toState?: PipelineStageState }).toState = input.toState;
  }
  if (input.attemptId !== undefined) {
    (decision as { attemptId?: string }).attemptId = input.attemptId;
  }
  if (input.intentId !== undefined) {
    (decision as { intentId?: string }).intentId = input.intentId;
  }
  if (input.detail !== undefined) {
    (decision as { detail?: string }).detail = input.detail;
  }
  ctx.decisions.push(decision);
}

function applyTransition(
  ctx: TickContext,
  stage: MutableStage,
  to: PipelineStageState,
  reason: PipelineTransitionReason,
  options: {
    readonly action: PipelineSchedulerDecisionAction;
    readonly attemptId?: string | undefined;
    readonly intentId?: string | undefined;
    readonly detail?: string | undefined;
    readonly blockReason?: string | undefined;
    readonly clearAttempt?: boolean;
    readonly selected?: boolean;
  },
): void {
  assertPermittedTransition(stage.state, to, reason);
  const from = stage.state;
  stage.state = to;
  stage.lastTransitionReason = reason;
  stage.updatedAt = ctx.input.now;
  if (options.blockReason !== undefined) {
    stage.blockReason = options.blockReason;
  } else if (to !== "blocked") {
    stage.blockReason = undefined;
  }
  if (options.selected !== undefined) {
    stage.selected = options.selected;
  }
  if (options.attemptId !== undefined) {
    stage.currentAttemptId = options.attemptId;
  }
  if (options.clearAttempt) {
    stage.currentAttemptId = undefined;
  }
  ctx.transitions.push({
    schemaVersion: 1,
    stageId: stage.stageId,
    from,
    to,
    reason,
    generation: stage.generation,
    ...(options.attemptId !== undefined ? { attemptId: options.attemptId } : {}),
    ...(options.blockReason !== undefined ? { blockReason: options.blockReason } : {}),
  });
  recordDecision(ctx, {
    stageId: stage.stageId,
    action: options.action,
    reason,
    fromState: from,
    toState: to,
    ...(options.attemptId !== undefined
      ? { attemptId: options.attemptId }
      : stage.currentAttemptId !== undefined
        ? { attemptId: stage.currentAttemptId }
        : {}),
    ...(options.intentId !== undefined ? { intentId: options.intentId } : {}),
    ...(options.detail !== undefined
      ? { detail: options.detail }
      : options.blockReason !== undefined
        ? { detail: options.blockReason }
        : {}),
    generation: stage.generation,
    attemptOrdinal: stage.attemptOrdinal,
  });
}

function maxRepairAttemptsFor(stage: PipelineStage, graph: PipelineGraph): number {
  const stageLimit = stage.limits?.maxRepairAttempts;
  const pipelineLimit = graph.limits.maxRepairAttempts;
  if (stageLimit !== undefined && pipelineLimit !== undefined) {
    return Math.min(stageLimit, pipelineLimit);
  }
  if (stageLimit !== undefined) {
    return stageLimit;
  }
  if (pipelineLimit !== undefined) {
    return pipelineLimit;
  }
  // Unresolved limit: one try, zero repairs. Defaults belong to configuration
  // layering; inventing a backoff or a silent default here would invent policy.
  return 0;
}

function producedWrites(ctx: TickContext, excludingStageId: string): ReadonlySet<string> {
  const writes = new Set<string>();
  for (const stage of ctx.graph.stages) {
    if (stage.id === excludingStageId) {
      continue;
    }
    const projection = ctx.working.get(stage.id);
    if (projection?.state === "succeeded") {
      for (const write of stage.writes) {
        writes.add(write);
      }
    }
  }
  return writes;
}

type EdgeResolution =
  | { readonly status: "pending" }
  | { readonly status: "selected" }
  | { readonly status: "rejected" }
  | { readonly status: "blocked"; readonly reason: string }
  | { readonly status: "waived" };

function resolveIncomingEdge(ctx: TickContext, edge: PipelineEdge): EdgeResolution {
  const predecessor = ctx.working.get(edge.from)!;
  const predecessorStage = ctx.stagesById.get(edge.from)!;

  if (!predecessor.selected && predecessor.state === "cancelled") {
    return { status: "rejected" };
  }

  if (predecessor.state === "blocked") {
    return { status: "blocked", reason: predecessor.blockReason ?? "predecessor_blocked" };
  }

  if (predecessor.state === "failed") {
    if (predecessorStage.optional) {
      return { status: "waived" };
    }
    return { status: "blocked", reason: `required predecessor ${edge.from} failed` };
  }

  if (predecessor.state === "cancelled") {
    if (predecessor.lastTransitionReason === "condition_not_selected") {
      return { status: "rejected" };
    }
    return { status: "blocked", reason: `predecessor ${edge.from} cancelled` };
  }

  if (predecessor.state !== "succeeded") {
    return { status: "pending" };
  }

  if (edge.condition === undefined) {
    return { status: "selected" };
  }

  if (edge.condition.kind === "expression") {
    const evaluation = evaluateExpressionCondition(
      edge.condition,
      ctx.input.canonicalState as JsonValue,
    );
    if (!evaluation.ok) {
      return {
        status: "blocked",
        reason: `${evaluation.code}:${evaluation.message}`,
      };
    }
    return evaluation.value ? { status: "selected" } : { status: "rejected" };
  }

  const key = edgeKey(edge.from, edge.to);
  if (ctx.evaluatorDecisions.has(key)) {
    return ctx.evaluatorDecisions.get(key) ? { status: "selected" } : { status: "rejected" };
  }
  if (ctx.pendingEvaluators.has(key)) {
    return { status: "pending" };
  }
  // Request evaluator once the predecessor has succeeded.
  const intentId = deriveIntentId({
    runId: ctx.input.runId,
    graphRevision: ctx.input.graphRevision,
    kind: "evaluator",
    key,
  });
  if (!ctx.intents.some((intent) => intent.intentId === intentId)) {
    ctx.intents.push({
      schemaVersion: 1,
      intentId,
      runId: ctx.input.runId,
      graphRevision: ctx.input.graphRevision,
      kind: "evaluator",
      payload: {
        kind: "evaluator",
        fromStageId: edge.from,
        toStageId: edge.to,
        profile: edge.condition.profile,
        question: edge.condition.question,
        edgeKey: key,
      },
      createdAt: ctx.input.now,
    });
    ctx.pendingEvaluators.add(key);
    recordDecision(ctx, {
      stageId: edge.to,
      action: "request_evaluator",
      reason: "dependencies_satisfied",
      intentId,
      detail: key,
      generation: ctx.working.get(edge.to)!.generation,
      attemptOrdinal: ctx.working.get(edge.to)!.attemptOrdinal,
    });
  }
  return { status: "pending" };
}

function unsatisfiedReads(ctx: TickContext, stage: PipelineStage): string | undefined {
  const available = producedWrites(ctx, stage.id);
  for (const read of stage.reads) {
    // Roots and early stages may read ambient canonical state (task.*, etc.).
    // Only require graph-produced writes when some succeeded stage declares them.
    const producedSomewhere = ctx.graph.stages.some(
      (candidate) => candidate.id !== stage.id && candidate.writes.includes(read),
    );
    if (producedSomewhere && !available.has(read)) {
      return read;
    }
  }
  return undefined;
}

function maybeReleaseStage(ctx: TickContext, stageId: string): void {
  const stage = ctx.working.get(stageId)!;
  if (!stage.selected || stage.state !== "pending") {
    return;
  }
  if (ctx.cancelRequested || ctx.deadlineExceeded) {
    return;
  }

  const edges = ctx.incoming.get(stageId) ?? [];
  if (edges.length === 0) {
    applyTransition(ctx, stage, "ready", "root_eligible", { action: "release" });
    return;
  }

  const resolutions = edges.map((edge) => ({ edge, resolution: resolveIncomingEdge(ctx, edge) }));
  if (resolutions.some((entry) => entry.resolution.status === "pending")) {
    return;
  }

  const blocked = resolutions.find((entry) => entry.resolution.status === "blocked");
  if (blocked && blocked.resolution.status === "blocked") {
    applyTransition(ctx, stage, "blocked", "dependency_unsatisfied", {
      action: "block",
      blockReason: blocked.resolution.reason,
    });
    return;
  }

  const selected = resolutions.filter((entry) => entry.resolution.status === "selected");
  if (selected.length === 0) {
    applyTransition(ctx, stage, "cancelled", "condition_not_selected", {
      action: "cancel",
      selected: false,
      clearAttempt: true,
    });
    return;
  }

  const missingRead = unsatisfiedReads(ctx, ctx.stagesById.get(stageId)!);
  if (missingRead !== undefined) {
    applyTransition(ctx, stage, "blocked", "dependency_unsatisfied", {
      action: "block",
      blockReason: `unsatisfied read ${missingRead}`,
    });
    return;
  }

  applyTransition(ctx, stage, "ready", "dependencies_satisfied", { action: "release" });
}

function cancelInactiveStage(
  ctx: TickContext,
  stage: MutableStage,
  reason: PipelineTransitionReason,
): void {
  if (stage.state === "pending" || stage.state === "ready" || stage.state === "retrying") {
    applyTransition(ctx, stage, "cancelled", reason, {
      action: "cancel",
      clearAttempt: true,
    });
  }
}

function requestCancelForActive(ctx: TickContext, stage: MutableStage): void {
  if (stage.state !== "queued" && stage.state !== "running" && stage.state !== "waiting") {
    return;
  }
  if (stage.currentAttemptId === undefined) {
    return;
  }
  const intentId = deriveIntentId({
    runId: ctx.input.runId,
    graphRevision: ctx.input.graphRevision,
    kind: "cancel",
    key: `${stage.stageId}:${stage.generation}:${stage.attemptOrdinal}`,
  });
  if (ctx.intents.some((intent) => intent.intentId === intentId)) {
    return;
  }
  ctx.intents.push({
    schemaVersion: 1,
    intentId,
    runId: ctx.input.runId,
    graphRevision: ctx.input.graphRevision,
    kind: "cancel",
    payload: {
      kind: "cancel",
      stageId: stage.stageId,
      attemptId: stage.currentAttemptId,
      generation: stage.generation,
      attemptOrdinal: stage.attemptOrdinal,
    },
    createdAt: ctx.input.now,
  });
  recordDecision(ctx, {
    stageId: stage.stageId,
    action: "request_cancel",
    reason: "cancel_requested",
    attemptId: stage.currentAttemptId,
    intentId,
    generation: stage.generation,
    attemptOrdinal: stage.attemptOrdinal,
  });
}

function processManualRerun(ctx: TickContext, stageId: string): void {
  const root = ctx.working.get(stageId);
  if (root === undefined) {
    return;
  }
  const targets = [stageId, ...(ctx.descendants.get(stageId) ?? [])].sort();
  for (const targetId of targets) {
    const stage = ctx.working.get(targetId)!;
    if (!isTerminalStageState(stage.state) && stage.state !== "pending") {
      // Active work must settle before a rerun can reset the generation.
      continue;
    }
    const from = stage.state;
    stage.generation += 1;
    stage.attemptOrdinal = 0;
    stage.currentAttemptId = undefined;
    stage.blockReason = undefined;
    stage.selected = true;
    stage.lastTransitionReason = "manual_rerun";
    stage.updatedAt = ctx.input.now;
    if (from !== "pending") {
      assertPermittedTransition(from, "pending", "manual_rerun");
      stage.state = "pending";
      ctx.transitions.push({
        schemaVersion: 1,
        stageId: stage.stageId,
        from,
        to: "pending",
        reason: "manual_rerun",
        generation: stage.generation,
      });
    } else {
      stage.state = "pending";
    }
    recordDecision(ctx, {
      stageId: stage.stageId,
      action: "rerun",
      reason: "manual_rerun",
      fromState: from,
      toState: "pending",
      generation: stage.generation,
      attemptOrdinal: 0,
    });
  }
}

function processObservation(ctx: TickContext, observation: SchedulerObservation): void {
  ctx.consumedObservationIds.push(observation.observationId);

  switch (observation.kind) {
    case "cancel_requested": {
      ctx.cancelRequested = true;
      return;
    }
    case "manual_rerun": {
      if (observation.stageId !== undefined) {
        processManualRerun(ctx, observation.stageId);
      }
      return;
    }
    case "evaluator_decided": {
      if (observation.edgeKey !== undefined && observation.selected !== undefined) {
        ctx.evaluatorDecisions.set(observation.edgeKey, observation.selected);
        ctx.pendingEvaluators.delete(observation.edgeKey);
        const action = observation.selected ? "select_edge" : "reject_edge";
        const stageId = observation.edgeKey.split("->")[1] ?? observation.stageId ?? "unknown";
        const stage = ctx.working.get(stageId);
        recordDecision(ctx, {
          stageId,
          action,
          reason: observation.selected ? "dependencies_satisfied" : "condition_not_selected",
          detail: observation.edgeKey,
          generation: stage?.generation ?? 1,
          attemptOrdinal: stage?.attemptOrdinal ?? 0,
        });
      }
      return;
    }
    default:
      break;
  }

  if (observation.stageId === undefined) {
    return;
  }
  const stage = ctx.working.get(observation.stageId);
  if (stage === undefined) {
    return;
  }

  switch (observation.kind) {
    case "attempt_started": {
      if (stage.state === "queued" || stage.state === "waiting") {
        applyTransition(ctx, stage, "running", "attempt_started", {
          action: "start",
          attemptId: observation.attemptId ?? stage.currentAttemptId,
        });
      }
      return;
    }
    case "attempt_waiting": {
      if (stage.state === "running") {
        applyTransition(ctx, stage, "waiting", "attempt_waiting", {
          action: "wait",
          attemptId: observation.attemptId ?? stage.currentAttemptId,
        });
      }
      return;
    }
    case "attempt_succeeded": {
      if (stage.state === "running" || stage.state === "waiting") {
        applyTransition(ctx, stage, "succeeded", "attempt_succeeded", {
          action: "succeed",
          attemptId: observation.attemptId ?? stage.currentAttemptId,
        });
      }
      return;
    }
    case "attempt_failed": {
      if (stage.state !== "running" && stage.state !== "waiting") {
        return;
      }
      const definition = ctx.stagesById.get(stage.stageId)!;
      const maxRepairs = maxRepairAttemptsFor(definition, ctx.graph);
      const repairsUsed = Math.max(0, stage.attemptOrdinal - 1);
      const canRetry = observation.retryable === true && repairsUsed < maxRepairs;
      if (canRetry) {
        applyTransition(ctx, stage, "retrying", "retry_scheduled", {
          action: "retry",
          attemptId: observation.attemptId ?? stage.currentAttemptId,
        });
      } else {
        applyTransition(
          ctx,
          stage,
          "failed",
          repairsUsed >= maxRepairs && observation.retryable === true
            ? "retry_exhausted"
            : "attempt_failed",
          {
            action: "fail",
            attemptId: observation.attemptId ?? stage.currentAttemptId,
          },
        );
      }
      return;
    }
    case "cancellation_settled": {
      if (stage.state === "queued" || stage.state === "running" || stage.state === "waiting") {
        applyTransition(ctx, stage, "cancelled", "cancellation_settled", {
          action: "cancel",
          ...(observation.attemptId !== undefined || stage.currentAttemptId !== undefined
            ? { attemptId: observation.attemptId ?? stage.currentAttemptId }
            : {}),
          clearAttempt: false,
        });
      }
      return;
    }
  }
}

function rearmRetries(ctx: TickContext, retryingAtTickStart: ReadonlySet<string>): void {
  for (const stageId of [...retryingAtTickStart].sort()) {
    const stage = ctx.working.get(stageId)!;
    // Only rearm stages that entered this tick already in `retrying`. A
    // failure observed on this tick stops at `retrying` so running →
    // retrying → ready never collapses onto one tick.
    if (stage.state !== "retrying") {
      continue;
    }
    if (ctx.cancelRequested || ctx.deadlineExceeded) {
      continue;
    }
    applyTransition(ctx, stage, "ready", "retry_scheduled", {
      action: "rearm",
      clearAttempt: true,
    });
  }
}

function queueReadyStages(ctx: TickContext): void {
  const maxConcurrent = ctx.graph.limits.maxConcurrentWorkers;
  let inFlight = 0;
  for (const stage of ctx.working.values()) {
    if (stage.state === "queued" || stage.state === "running" || stage.state === "waiting") {
      inFlight += 1;
    }
  }

  for (const stageId of [...ctx.working.keys()].sort()) {
    const stage = ctx.working.get(stageId)!;
    if (stage.state !== "ready" || !stage.selected) {
      continue;
    }
    if (ctx.cancelRequested || ctx.deadlineExceeded) {
      continue;
    }
    if (maxConcurrent !== undefined && inFlight >= maxConcurrent) {
      break;
    }

    const definition = ctx.stagesById.get(stageId)!;
    stage.attemptOrdinal += 1;
    const attemptId = deriveAttemptId({
      runId: ctx.input.runId,
      graphRevision: ctx.input.graphRevision,
      stageId: stage.stageId,
      generation: stage.generation,
      attemptOrdinal: stage.attemptOrdinal,
    });
    const intentId = deriveIntentId({
      runId: ctx.input.runId,
      graphRevision: ctx.input.graphRevision,
      kind: "dispatch",
      key: `${stage.stageId}:${stage.generation}:${stage.attemptOrdinal}`,
    });

    ctx.attempts.push({
      schemaVersion: 1,
      attemptId,
      runId: ctx.input.runId,
      pipelineId: ctx.input.pipelineId,
      stageId: stage.stageId,
      graphRevision: ctx.input.graphRevision,
      generation: stage.generation,
      attemptOrdinal: stage.attemptOrdinal,
      stageType: definition.type,
      createdAt: ctx.input.now,
    });
    ctx.intents.push({
      schemaVersion: 1,
      intentId,
      runId: ctx.input.runId,
      graphRevision: ctx.input.graphRevision,
      kind: "dispatch",
      payload: {
        kind: "dispatch",
        stageId: stage.stageId,
        stageType: definition.type,
        attemptId,
        generation: stage.generation,
        attemptOrdinal: stage.attemptOrdinal,
      },
      createdAt: ctx.input.now,
    });
    applyTransition(ctx, stage, "queued", "dispatch_intent", {
      action: "queue",
      attemptId,
      intentId,
    });
    inFlight += 1;
  }
}

function computeTerminal(ctx: TickContext): ScheduleTerminal | undefined {
  const stages = [...ctx.working.values()];
  if (stages.some((stage) => !isTerminalStageState(stage.state))) {
    return undefined;
  }

  if (stages.some((stage) => stage.state === "blocked")) {
    const blocked = stages.find((stage) => stage.state === "blocked")!;
    return {
      schemaVersion: 1,
      outcome: "blocked",
      reason: blocked.blockReason ?? "stage_blocked",
      blockedStageId: blocked.stageId,
    };
  }

  if (ctx.cancelRequested || stages.every((stage) => stage.state === "cancelled")) {
    return {
      schemaVersion: 1,
      outcome: "cancelled",
      reason: ctx.deadlineExceeded ? "deadline_exceeded" : "cancel_requested",
    };
  }

  const requiredFailed = stages.some((stage) => {
    if (stage.state !== "failed") {
      return false;
    }
    return !ctx.stagesById.get(stage.stageId)!.optional;
  });
  if (requiredFailed) {
    return {
      schemaVersion: 1,
      outcome: "failed",
      reason: "required_stage_failed",
    };
  }

  const anySucceeded = stages.some((stage) => stage.state === "succeeded");
  if (
    anySucceeded ||
    stages.every((stage) => stage.state === "cancelled" || stage.state === "failed")
  ) {
    // Optional failures with all selected work cancelled/failed but no required
    // failure: if anything succeeded, the graph succeeded; if everything was
    // unselected, treat as cancelled; otherwise succeeded (optional-only fail).
    if (!anySucceeded && stages.every((stage) => stage.state === "cancelled")) {
      return {
        schemaVersion: 1,
        outcome: "cancelled",
        reason: "all_stages_cancelled",
      };
    }
    return {
      schemaVersion: 1,
      outcome: "succeeded",
      reason: "graph_complete",
    };
  }

  return {
    schemaVersion: 1,
    outcome: "succeeded",
    reason: "graph_complete",
  };
}

function sortDecisions(decisions: SchedulerDecision[]): SchedulerDecision[] {
  return [...decisions].sort((left, right) => {
    const leftStage = left.stageId ?? "";
    const rightStage = right.stageId ?? "";
    if (leftStage !== rightStage) {
      return leftStage < rightStage ? -1 : 1;
    }
    if (left.decisionId !== right.decisionId) {
      return left.decisionId < right.decisionId ? -1 : 1;
    }
    return 0;
  });
}

/**
 * Compute one deterministic scheduler plan from canonical input.
 *
 * Duplicate calls with the same input produce byte-identical plans (same
 * decision, attempt, and intent ids). The store turns those collisions into
 * no-ops via uniqueness constraints.
 */
export function tickScheduler(input: SchedulerInput): SchedulerPlan {
  const graph = input.graph as PipelineGraph;
  const { incoming, outgoing } = buildEdgeMaps(graph);
  const stagesById = new Map(graph.stages.map((stage) => [stage.id, stage]));
  const working = new Map<string, MutableStage>();
  for (const snapshot of input.stages) {
    working.set(snapshot.stageId, cloneStage(snapshot));
  }
  // Ensure every graph stage has a projection.
  for (const stage of graph.stages) {
    if (!working.has(stage.id)) {
      working.set(stage.id, {
        schemaVersion: 1,
        runId: input.runId,
        stageId: stage.id,
        graphRevision: input.graphRevision,
        generation: 1,
        state: "pending",
        attemptOrdinal: 0,
        selected: true,
        updatedAt: input.now,
      });
    }
  }

  const retryingAtTickStart = new Set(
    [...working.values()]
      .filter((stage) => stage.state === "retrying")
      .map((stage) => stage.stageId),
  );

  const ctx: TickContext = {
    input,
    graph,
    stagesById,
    incoming,
    outgoing,
    descendants: buildDescendants(graph),
    working,
    evaluatorDecisions: new Map(
      input.evaluatorDecisions.map((entry) => [entry.edgeKey, entry.selected]),
    ),
    pendingEvaluators: new Set(input.pendingEvaluatorEdgeKeys),
    transitions: [],
    decisions: [],
    intents: [],
    attempts: [],
    consumedObservationIds: [],
    cancelRequested: false,
    deadlineExceeded: input.deadlineAt !== undefined && input.now >= input.deadlineAt,
  };

  const observations = [...input.observations].sort((left, right) => {
    if (left.recordedAt !== right.recordedAt) {
      return left.recordedAt < right.recordedAt ? -1 : 1;
    }
    return left.observationId < right.observationId
      ? -1
      : left.observationId > right.observationId
        ? 1
        : 0;
  });
  for (const observation of observations) {
    processObservation(ctx, observation);
  }

  const cancelReason: PipelineTransitionReason = ctx.deadlineExceeded
    ? "deadline_exceeded"
    : "pipeline_cancelled";
  if (ctx.cancelRequested || ctx.deadlineExceeded) {
    for (const stageId of [...ctx.working.keys()].sort()) {
      const stage = ctx.working.get(stageId)!;
      cancelInactiveStage(ctx, stage, cancelReason);
      requestCancelForActive(ctx, stage);
    }
  }

  rearmRetries(ctx, retryingAtTickStart);

  // Release passes: fan-out/fan-in may unlock stages in waves within one tick.
  let progressed = true;
  while (progressed) {
    const before = ctx.transitions.length + ctx.intents.length;
    for (const stageId of [...ctx.working.keys()].sort()) {
      maybeReleaseStage(ctx, stageId);
    }
    progressed = ctx.transitions.length + ctx.intents.length > before;
  }

  queueReadyStages(ctx);

  // If cancel landed after releases in the same tick, fold inactive cancels.
  if (ctx.cancelRequested || ctx.deadlineExceeded) {
    for (const stageId of [...ctx.working.keys()].sort()) {
      const stage = ctx.working.get(stageId)!;
      cancelInactiveStage(ctx, stage, cancelReason);
      requestCancelForActive(ctx, stage);
    }
  }

  const terminal = computeTerminal(ctx);
  if (terminal !== undefined) {
    recordDecision(ctx, {
      stageId: terminal.blockedStageId ?? graph.stages[0]!.id,
      action: "terminal",
      reason:
        terminal.outcome === "blocked"
          ? "dependency_unsatisfied"
          : terminal.outcome === "cancelled"
            ? "pipeline_cancelled"
            : terminal.outcome === "failed"
              ? "attempt_failed"
              : "attempt_succeeded",
      detail: terminal.reason,
      generation: 1,
      attemptOrdinal: 0,
    });
  }

  const stagePatches = [...ctx.working.values()]
    .map(freezeSnapshot)
    .sort((left, right) => (left.stageId < right.stageId ? -1 : 1));

  const plan: SchedulerPlan = {
    schemaVersion: 1,
    runId: input.runId,
    graphRevision: input.graphRevision,
    expectedScheduleRevision: input.scheduleRevision,
    nextScheduleRevision: input.scheduleRevision + 1,
    recordedAt: input.now,
    transitions: ctx.transitions,
    decisions: sortDecisions(ctx.decisions),
    intents: [...ctx.intents].sort((left, right) => (left.intentId < right.intentId ? -1 : 1)),
    attempts: [...ctx.attempts].sort((left, right) => (left.attemptId < right.attemptId ? -1 : 1)),
    stagePatches,
    consumedObservationIds: [...ctx.consumedObservationIds].sort(),
  };
  if (terminal !== undefined) {
    (plan as { terminal?: ScheduleTerminal }).terminal = terminal;
  }
  return plan;
}

/** Initial pending projections for every stage in a graph. */
export function initialStageSnapshots(input: {
  readonly runId: string;
  readonly graphRevision: number;
  readonly graph: PipelineGraph;
  readonly now: string;
}): StageSnapshot[] {
  return input.graph.stages
    .map((stage) => ({
      schemaVersion: 1 as const,
      runId: input.runId,
      stageId: stage.id,
      graphRevision: input.graphRevision,
      generation: 1,
      state: "pending" as const,
      attemptOrdinal: 0,
      selected: true,
      updatedAt: input.now,
    }))
    .sort((left, right) => (left.stageId < right.stageId ? -1 : 1)) as StageSnapshot[];
}
