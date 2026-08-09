/**
 * Pure deterministic pipeline scheduler.
 *
 * One tick consumes a `PipelineSchedulerInput/v1`-shaped snapshot and
 * produces a `PipelineSchedulerPlan/v1`-shaped plan. Decisions are sorted by
 * canonical stage id; attempt and intent ids are derived, never minted.
 * Nothing here reads a clock, the filesystem, or the network — `now` arrives
 * as an explicit input.
 *
 * Optional recovery fields (Q028) layer onto the same tick without breaking
 * V1 callers: when `observation.failure` (or classifiable fields) is present,
 * `decideRecovery` drives retry/propose/fail; otherwise the legacy
 * `retryable && repairsUsed < maxRepairs` path remains.
 */

import type {
  PipelineSchedulerDecisionAction,
  PipelineSchedulerDecisionActionV2,
  PipelineStageState,
  PipelineTransitionReason,
  PipelineTransitionReasonV2,
} from "@heniek/contracts";
import type { PipelineEdge, PipelineGraph, PipelineStage } from "../document.js";
import { evaluateExpressionCondition, type JsonValue } from "../expression/evaluate.js";
import {
  classifyFailure,
  decideRecovery,
  type PipelineFailurePlain,
  type PipelineRecoveryDecisionPlain,
  type PipelineRetryDirectivePlain,
  resolveEffectiveConcurrency,
  resolveRepairBudget,
  type StageRecoveryCounters,
} from "../recovery/index.js";
import {
  deriveAttemptId,
  deriveDecisionId,
  deriveIntentId,
  deriveRecoveryDecisionId,
  edgeKey,
} from "./ids.js";
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
  schemaVersion: 1 | 2;
  observationId: string;
  kind:
    | "attempt_started"
    | "attempt_waiting"
    | "attempt_succeeded"
    | "attempt_failed"
    | "cancellation_settled"
    | "evaluator_decided"
    | "cancel_requested"
    | "manual_rerun"
    | "recovery_proposed"
    | "recovery_approved"
    | "recovery_rejected";
  stageId?: string;
  attemptId?: string;
  retryable?: boolean;
  edgeKey?: string;
  selected?: boolean;
  recordedAt: string;
  failure?: PipelineFailurePlain;
  signature?: {
    schemaVersion: 1;
    digest: string;
    category: string;
    classification: string;
    phase: string;
    code: string;
    backendClassification?: string;
    validationFailures?: readonly string[];
  };
  recoveryDecisionId?: string;
  proposalId?: string;
  approved?: boolean;
  /** Runner classification fields used when `failure` is absent. */
  classification?: string;
  phase?: string;
  code?: string;
  backendClassification?: string;
  validationFailures?: readonly string[];
  resumeAvailable?: boolean;
  priorBackendExecutionId?: string;
}

export type SchedulerDecisionAction =
  | PipelineSchedulerDecisionAction
  | PipelineSchedulerDecisionActionV2;
export type SchedulerTransitionReason = PipelineTransitionReason | PipelineTransitionReasonV2;

export interface SchedulerDecision {
  schemaVersion: 1 | 2;
  decisionId: string;
  runId: string;
  stageId?: string;
  graphRevision: number;
  generation: number;
  attemptOrdinal: number;
  action: SchedulerDecisionAction;
  reason: SchedulerTransitionReason;
  fromState?: PipelineStageState;
  toState?: PipelineStageState;
  attemptId?: string;
  intentId?: string;
  detail?: string;
  recordedAt: string;
  recoveryDecisionId?: string;
  signatureDigest?: string;
}

export interface SchedulerIntent {
  schemaVersion: 1 | 2;
  intentId: string;
  runId: string;
  graphRevision: number;
  kind: "dispatch" | "cancel" | "evaluator" | "recovery_dispatch";
  payload: unknown;
  createdAt: string;
}

export interface StageAttempt {
  schemaVersion: 1 | 2;
  attemptId: string;
  runId: string;
  pipelineId: string;
  stageId: string;
  graphRevision: number;
  generation: number;
  attemptOrdinal: number;
  stageType: string;
  createdAt: string;
  sessionPolicy?: "fresh" | "resume";
  priorAttemptId?: string;
  recoveryDecisionId?: string;
  delegatedProfileId?: string;
  retryDirective?: PipelineRetryDirectivePlain;
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

export interface StageRecoveryStatePlain {
  stageId: string;
  generation: number;
  repairsUsed: number;
  lastSignatureDigest?: string;
  identicalSignatureCount: number;
  pendingProposalId?: string;
  pendingProposalJson?: unknown;
  pendingDirective?: PipelineRetryDirectivePlain;
}

export interface EffectiveLimitsPlain {
  maxRepairAttempts?: number;
  maxConcurrentWorkers?: number;
  maxPipelineDurationMs?: number;
  maxGraphRevisions?: number;
  stageDurationMsByStageId?: Record<string, number>;
}

export interface SchedulerInput {
  schemaVersion: 1 | 2;
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
  recoveryState?: StageRecoveryStatePlain[];
  effectiveLimits?: EffectiveLimitsPlain;
  executionMode?: "autonomous" | "hitl";
}

export interface SchedulerPlan {
  schemaVersion: 1 | 2;
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
  recoveryDecisions?: PipelineRecoveryDecisionPlain[];
  recoveryState?: StageRecoveryStatePlain[];
}

/** V2 plain input mirroring PipelineSchedulerInput/v2 without brands. */
export type SchedulerInputV2Plain = SchedulerInput & { schemaVersion: 2 };

/** V2 plain plan mirroring PipelineSchedulerPlan/v2 without brands. */
export type SchedulerPlanV2Plain = SchedulerPlan & {
  schemaVersion: 2;
  recoveryDecisions: PipelineRecoveryDecisionPlain[];
};

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
  readonly recoveryByKey: Map<string, StageRecoveryCounters & { generation: number }>;
  readonly transitions: StageTransition[];
  readonly decisions: SchedulerDecision[];
  readonly intents: SchedulerIntent[];
  readonly attempts: StageAttempt[];
  readonly recoveryDecisions: PipelineRecoveryDecisionPlain[];
  readonly consumedObservationIds: string[];
  readonly v2: boolean;
  cancelRequested: boolean;
  deadlineExceeded: boolean;
}

function recoveryKey(stageId: string, generation: number): string {
  return `${stageId}:${generation}`;
}

function getRecoveryCounters(
  ctx: TickContext,
  stage: MutableStage,
): StageRecoveryCounters & { generation: number } {
  const key = recoveryKey(stage.stageId, stage.generation);
  const existing = ctx.recoveryByKey.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created: StageRecoveryCounters & { generation: number } = {
    generation: stage.generation,
    repairsUsed: 0,
    identicalSignatureCount: 0,
  };
  ctx.recoveryByKey.set(key, created);
  return created;
}

function setRecoveryCounters(
  ctx: TickContext,
  stage: MutableStage,
  counters: StageRecoveryCounters,
): void {
  ctx.recoveryByKey.set(recoveryKey(stage.stageId, stage.generation), {
    ...counters,
    generation: stage.generation,
  });
}

function freezeRecoveryState(ctx: TickContext): StageRecoveryStatePlain[] {
  return [...ctx.recoveryByKey.entries()]
    .map(([key, counters]) => {
      const stageId = key.slice(0, key.lastIndexOf(":"));
      const state: StageRecoveryStatePlain = {
        stageId,
        generation: counters.generation,
        repairsUsed: counters.repairsUsed,
        identicalSignatureCount: counters.identicalSignatureCount,
      };
      if (counters.lastSignatureDigest !== undefined) {
        state.lastSignatureDigest = counters.lastSignatureDigest;
      }
      if (counters.pendingProposalId !== undefined) {
        state.pendingProposalId = counters.pendingProposalId;
      }
      if (counters.pendingDirective !== undefined) {
        state.pendingDirective = counters.pendingDirective;
        state.pendingProposalJson = counters.pendingDirective;
      }
      return state;
    })
    .sort((left, right) =>
      left.stageId !== right.stageId
        ? left.stageId < right.stageId
          ? -1
          : 1
        : left.generation - right.generation,
    );
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
    readonly action: SchedulerDecisionAction;
    readonly reason: SchedulerTransitionReason;
    readonly fromState?: PipelineStageState;
    readonly toState?: PipelineStageState;
    readonly attemptId?: string;
    readonly intentId?: string;
    readonly detail?: string;
    readonly generation: number;
    readonly attemptOrdinal: number;
    readonly recoveryDecisionId?: string;
    readonly signatureDigest?: string;
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
    schemaVersion: ctx.v2 ? 2 : 1,
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
  if (input.recoveryDecisionId !== undefined) {
    (decision as { recoveryDecisionId?: string }).recoveryDecisionId = input.recoveryDecisionId;
  }
  if (input.signatureDigest !== undefined) {
    (decision as { signatureDigest?: string }).signatureDigest = input.signatureDigest;
  }
  ctx.decisions.push(decision);
}

function applyTransition(
  ctx: TickContext,
  stage: MutableStage,
  to: PipelineStageState,
  reason: PipelineTransitionReason,
  options: {
    readonly action: SchedulerDecisionAction;
    readonly attemptId?: string | undefined;
    readonly intentId?: string | undefined;
    readonly detail?: string | undefined;
    readonly blockReason?: string | undefined;
    readonly clearAttempt?: boolean;
    readonly selected?: boolean;
    readonly decisionReason?: SchedulerTransitionReason;
    readonly recoveryDecisionId?: string;
    readonly signatureDigest?: string;
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
    reason: options.decisionReason ?? reason,
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
    ...(options.recoveryDecisionId !== undefined
      ? { recoveryDecisionId: options.recoveryDecisionId }
      : {}),
    ...(options.signatureDigest !== undefined ? { signatureDigest: options.signatureDigest } : {}),
    generation: stage.generation,
    attemptOrdinal: stage.attemptOrdinal,
  });
}

function maxRepairAttemptsFor(
  stage: PipelineStage,
  graph: PipelineGraph,
  effectiveLimits?: EffectiveLimitsPlain,
): number {
  return resolveRepairBudget({
    ...(effectiveLimits?.maxRepairAttempts !== undefined
      ? { effectiveMaxRepairAttempts: effectiveLimits.maxRepairAttempts }
      : {}),
    ...(stage.limits?.maxRepairAttempts !== undefined
      ? { stageMaxRepairAttempts: stage.limits.maxRepairAttempts }
      : {}),
    ...(graph.limits.maxRepairAttempts !== undefined
      ? { pipelineMaxRepairAttempts: graph.limits.maxRepairAttempts }
      : {}),
    ...(stage.onValidationFailure?.maxAttempts !== undefined
      ? { validationMaxAttempts: stage.onValidationFailure.maxAttempts }
      : {}),
  });
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
  const intentId = deriveIntentId({
    runId: ctx.input.runId,
    graphRevision: ctx.input.graphRevision,
    kind: "evaluator",
    key,
  });
  if (!ctx.intents.some((intent) => intent.intentId === intentId)) {
    ctx.intents.push({
      schemaVersion: ctx.v2 ? 2 : 1,
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
    schemaVersion: ctx.v2 ? 2 : 1,
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
    setRecoveryCounters(ctx, stage, {
      repairsUsed: 0,
      identicalSignatureCount: 0,
    });
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

function resolveFailureFromObservation(
  observation: SchedulerObservation,
): PipelineFailurePlain | undefined {
  if (observation.failure !== undefined) {
    return observation.failure;
  }
  if (
    observation.classification === undefined ||
    observation.phase === undefined ||
    observation.code === undefined
  ) {
    return undefined;
  }
  return classifyFailure({
    classification: observation.classification,
    phase: observation.phase,
    code: observation.code,
    retryable: observation.retryable === true,
    ...(observation.backendClassification !== undefined
      ? { backendClassification: observation.backendClassification }
      : {}),
    ...(observation.validationFailures !== undefined
      ? { validationFailures: observation.validationFailures }
      : {}),
  });
}

function applyRecoveryDecision(
  ctx: TickContext,
  stage: MutableStage,
  observation: SchedulerObservation,
  result: ReturnType<typeof decideRecovery>,
): void {
  ctx.recoveryDecisions.push(result.recoveryDecision);
  setRecoveryCounters(ctx, stage, result.nextCounters);
  const attemptId = observation.attemptId ?? stage.currentAttemptId;
  const signatureDigest = result.recoveryDecision.signature?.digest;
  const signatureFields = signatureDigest !== undefined ? { signatureDigest } : {};

  switch (result.kind) {
    case "fail": {
      const transitionReason: PipelineTransitionReason =
        result.reason === "repair_exhausted" || result.reason === "unchanged_failure_exhausted"
          ? "retry_exhausted"
          : "attempt_failed";
      const decisionReason: SchedulerTransitionReason =
        result.reason === "repair_exhausted"
          ? "repair_exhausted"
          : result.reason === "unchanged_failure_exhausted"
            ? "unchanged_failure_exhausted"
            : result.reason === "recovery_rejected"
              ? "recovery_rejected"
              : "attempt_failed";
      applyTransition(ctx, stage, "failed", transitionReason, {
        action: "fail",
        attemptId,
        decisionReason,
        recoveryDecisionId: result.recoveryDecision.decisionId,
        ...signatureFields,
      });
      return;
    }
    case "block": {
      applyTransition(ctx, stage, "blocked", "condition_blocked", {
        action: "block",
        attemptId,
        blockReason: result.blockReason,
        decisionReason: "condition_blocked",
        recoveryDecisionId: result.recoveryDecision.decisionId,
        ...signatureFields,
      });
      return;
    }
    case "propose": {
      applyTransition(ctx, stage, "waiting", "attempt_waiting", {
        action: "propose_recovery",
        attemptId,
        decisionReason: "recovery_proposed",
        recoveryDecisionId: result.recoveryDecision.decisionId,
        ...signatureFields,
      });
      return;
    }
    case "retry": {
      applyTransition(ctx, stage, "retrying", "retry_scheduled", {
        action: result.reason === "recovery_approved" ? "approve_recovery" : "retry",
        attemptId,
        decisionReason:
          result.reason === "recovery_approved" ? "recovery_approved" : "retry_scheduled",
        recoveryDecisionId: result.recoveryDecision.decisionId,
        ...signatureFields,
      });
      return;
    }
  }
}

function processAttemptFailed(
  ctx: TickContext,
  stage: MutableStage,
  observation: SchedulerObservation,
): void {
  if (stage.state !== "running" && stage.state !== "waiting") {
    return;
  }
  const definition = ctx.stagesById.get(stage.stageId)!;
  const failure = resolveFailureFromObservation(observation);
  if (failure !== undefined) {
    const counters = getRecoveryCounters(ctx, stage);
    const repairBudget = maxRepairAttemptsFor(definition, ctx.graph, ctx.input.effectiveLimits);
    const priorAttemptId = observation.attemptId ?? stage.currentAttemptId;
    const result = decideRecovery({
      runId: ctx.input.runId,
      stageId: stage.stageId,
      graphRevision: ctx.input.graphRevision,
      generation: stage.generation,
      attemptOrdinal: stage.attemptOrdinal,
      now: ctx.input.now,
      failure,
      stageType: definition.type,
      ...(definition.session?.policy !== undefined
        ? { sessionPolicy: definition.session.policy }
        : {}),
      ...(definition.onValidationFailure !== undefined
        ? {
            onValidationFailure: {
              strategy: definition.onValidationFailure.strategy,
              ...(definition.onValidationFailure.session !== undefined
                ? { session: definition.onValidationFailure.session }
                : {}),
              ...(definition.onValidationFailure.maxAttempts !== undefined
                ? { maxAttempts: definition.onValidationFailure.maxAttempts }
                : {}),
              ...(definition.onValidationFailure.delegateTo !== undefined
                ? { delegateTo: definition.onValidationFailure.delegateTo }
                : {}),
            },
          }
        : {}),
      executionMode: ctx.input.executionMode ?? definition.mode ?? ctx.graph.mode,
      counters,
      repairBudget,
      ...(priorAttemptId !== undefined ? { priorAttemptId } : {}),
      ...(observation.priorBackendExecutionId !== undefined
        ? { priorBackendExecutionId: observation.priorBackendExecutionId }
        : {}),
      resumeAvailable: observation.resumeAvailable === true,
    });
    applyRecoveryDecision(ctx, stage, observation, result);
    return;
  }

  const maxRepairs = maxRepairAttemptsFor(definition, ctx.graph, ctx.input.effectiveLimits);
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
}

function processRecoveryApproved(
  ctx: TickContext,
  stage: MutableStage,
  observation: SchedulerObservation,
): void {
  if (stage.state !== "waiting") {
    return;
  }
  const counters = getRecoveryCounters(ctx, stage);
  if (
    observation.proposalId === undefined ||
    counters.pendingProposalId === undefined ||
    observation.proposalId !== counters.pendingProposalId
  ) {
    return;
  }
  const directive = counters.pendingDirective;
  if (directive === undefined) {
    return;
  }
  const nextCounters: StageRecoveryCounters = {
    repairsUsed: counters.repairsUsed + 1,
    identicalSignatureCount: counters.identicalSignatureCount,
    ...(counters.lastSignatureDigest !== undefined
      ? { lastSignatureDigest: counters.lastSignatureDigest }
      : {}),
    pendingDirective: directive,
  };
  const recoveryDecision: PipelineRecoveryDecisionPlain = {
    schemaVersion: 1,
    decisionId: deriveRecoveryDecisionId({
      runId: ctx.input.runId,
      graphRevision: ctx.input.graphRevision,
      stageId: stage.stageId,
      generation: stage.generation,
      attemptOrdinal: stage.attemptOrdinal,
      action: "approve",
    }),
    runId: ctx.input.runId,
    stageId: stage.stageId,
    graphRevision: ctx.input.graphRevision,
    generation: stage.generation,
    attemptOrdinal: stage.attemptOrdinal,
    action: "approve",
    outcome:
      directive.mode === "delegate"
        ? "delegate"
        : directive.mode === "resume"
          ? "repair"
          : "repair_fresh",
    directive,
    proposalId: observation.proposalId,
    repairsUsed: nextCounters.repairsUsed,
    repairBudget: maxRepairAttemptsFor(
      ctx.stagesById.get(stage.stageId)!,
      ctx.graph,
      ctx.input.effectiveLimits,
    ),
    identicalSignatureCount: nextCounters.identicalSignatureCount,
    recordedAt: ctx.input.now,
  };
  ctx.recoveryDecisions.push(recoveryDecision);
  setRecoveryCounters(ctx, stage, nextCounters);
  applyTransition(ctx, stage, "retrying", "retry_scheduled", {
    action: "approve_recovery",
    attemptId: observation.attemptId ?? stage.currentAttemptId,
    decisionReason: "recovery_approved",
    recoveryDecisionId: recoveryDecision.decisionId,
  });
}

function processRecoveryRejected(
  ctx: TickContext,
  stage: MutableStage,
  observation: SchedulerObservation,
): void {
  if (stage.state !== "waiting") {
    return;
  }
  const counters = getRecoveryCounters(ctx, stage);
  if (
    observation.proposalId !== undefined &&
    counters.pendingProposalId !== undefined &&
    observation.proposalId !== counters.pendingProposalId
  ) {
    return;
  }
  const recoveryDecision: PipelineRecoveryDecisionPlain = {
    schemaVersion: 1,
    decisionId: deriveRecoveryDecisionId({
      runId: ctx.input.runId,
      graphRevision: ctx.input.graphRevision,
      stageId: stage.stageId,
      generation: stage.generation,
      attemptOrdinal: stage.attemptOrdinal,
      action: "reject",
    }),
    runId: ctx.input.runId,
    stageId: stage.stageId,
    graphRevision: ctx.input.graphRevision,
    generation: stage.generation,
    attemptOrdinal: stage.attemptOrdinal,
    action: "reject",
    outcome: "rejected",
    ...(observation.proposalId !== undefined ? { proposalId: observation.proposalId } : {}),
    repairsUsed: counters.repairsUsed,
    repairBudget: maxRepairAttemptsFor(
      ctx.stagesById.get(stage.stageId)!,
      ctx.graph,
      ctx.input.effectiveLimits,
    ),
    identicalSignatureCount: counters.identicalSignatureCount,
    recordedAt: ctx.input.now,
  };
  ctx.recoveryDecisions.push(recoveryDecision);
  setRecoveryCounters(ctx, stage, {
    repairsUsed: counters.repairsUsed,
    identicalSignatureCount: counters.identicalSignatureCount,
    ...(counters.lastSignatureDigest !== undefined
      ? { lastSignatureDigest: counters.lastSignatureDigest }
      : {}),
  });
  applyTransition(ctx, stage, "failed", "attempt_failed", {
    action: "reject_recovery",
    attemptId: observation.attemptId ?? stage.currentAttemptId,
    decisionReason: "recovery_rejected",
    recoveryDecisionId: recoveryDecision.decisionId,
  });
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
      processAttemptFailed(ctx, stage, observation);
      return;
    }
    case "recovery_approved": {
      processRecoveryApproved(ctx, stage, observation);
      return;
    }
    case "recovery_rejected": {
      processRecoveryRejected(ctx, stage, observation);
      return;
    }
    case "recovery_proposed": {
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
  const maxConcurrent = resolveEffectiveConcurrency({
    ...(ctx.input.effectiveLimits?.maxConcurrentWorkers !== undefined
      ? { effectiveMaxConcurrentWorkers: ctx.input.effectiveLimits.maxConcurrentWorkers }
      : {}),
    ...(ctx.graph.limits.maxConcurrentWorkers !== undefined
      ? { pipelineMaxConcurrentWorkers: ctx.graph.limits.maxConcurrentWorkers }
      : {}),
  });
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

    const counters = getRecoveryCounters(ctx, stage);
    const directive = counters.pendingDirective;
    const attempt: StageAttempt = {
      schemaVersion: ctx.v2 || directive !== undefined ? 2 : 1,
      attemptId,
      runId: ctx.input.runId,
      pipelineId: ctx.input.pipelineId,
      stageId: stage.stageId,
      graphRevision: ctx.input.graphRevision,
      generation: stage.generation,
      attemptOrdinal: stage.attemptOrdinal,
      stageType: definition.type,
      createdAt: ctx.input.now,
    };
    if (directive !== undefined) {
      attempt.retryDirective = directive;
      attempt.sessionPolicy = directive.sessionPolicy;
      if (directive.priorAttemptId !== undefined) {
        attempt.priorAttemptId = directive.priorAttemptId;
      }
      if (directive.delegateTo !== undefined) {
        attempt.delegatedProfileId = directive.delegateTo;
      }
      const lastRecovery = [...ctx.recoveryDecisions]
        .reverse()
        .find((decision) => decision.stageId === stage.stageId);
      if (lastRecovery !== undefined) {
        attempt.recoveryDecisionId = lastRecovery.decisionId;
      }
      setRecoveryCounters(ctx, stage, {
        repairsUsed: counters.repairsUsed,
        identicalSignatureCount: counters.identicalSignatureCount,
        ...(counters.lastSignatureDigest !== undefined
          ? { lastSignatureDigest: counters.lastSignatureDigest }
          : {}),
      });
    }

    ctx.attempts.push(attempt);
    ctx.intents.push({
      schemaVersion: ctx.v2 ? 2 : 1,
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
        ...(directive !== undefined ? { retryDirective: directive } : {}),
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

function createTickContext(input: SchedulerInput, v2: boolean): TickContext {
  const graph = input.graph as PipelineGraph;
  const { incoming, outgoing } = buildEdgeMaps(graph);
  const stagesById = new Map(graph.stages.map((stage) => [stage.id, stage]));
  const working = new Map<string, MutableStage>();
  for (const snapshot of input.stages) {
    working.set(snapshot.stageId, cloneStage(snapshot));
  }
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

  const recoveryByKey = new Map<string, StageRecoveryCounters & { generation: number }>();
  for (const entry of input.recoveryState ?? []) {
    recoveryByKey.set(recoveryKey(entry.stageId, entry.generation), {
      generation: entry.generation,
      repairsUsed: entry.repairsUsed,
      identicalSignatureCount: entry.identicalSignatureCount,
      ...(entry.lastSignatureDigest !== undefined
        ? { lastSignatureDigest: entry.lastSignatureDigest }
        : {}),
      ...(entry.pendingProposalId !== undefined
        ? { pendingProposalId: entry.pendingProposalId }
        : {}),
      ...(entry.pendingDirective !== undefined
        ? { pendingDirective: entry.pendingDirective }
        : entry.pendingProposalJson !== undefined &&
            typeof entry.pendingProposalJson === "object" &&
            entry.pendingProposalJson !== null &&
            "mode" in (entry.pendingProposalJson as object)
          ? { pendingDirective: entry.pendingProposalJson as PipelineRetryDirectivePlain }
          : {}),
    });
  }

  return {
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
    recoveryByKey,
    transitions: [],
    decisions: [],
    intents: [],
    attempts: [],
    recoveryDecisions: [],
    consumedObservationIds: [],
    v2,
    cancelRequested: false,
    deadlineExceeded: input.deadlineAt !== undefined && input.now >= input.deadlineAt,
  };
}

function runTick(ctx: TickContext): SchedulerPlan {
  const retryingAtTickStart = new Set(
    [...ctx.working.values()]
      .filter((stage) => stage.state === "retrying")
      .map((stage) => stage.stageId),
  );

  const observations = [...ctx.input.observations].sort((left, right) => {
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

  let progressed = true;
  while (progressed) {
    const before = ctx.transitions.length + ctx.intents.length;
    for (const stageId of [...ctx.working.keys()].sort()) {
      maybeReleaseStage(ctx, stageId);
    }
    progressed = ctx.transitions.length + ctx.intents.length > before;
  }

  queueReadyStages(ctx);

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
      stageId: terminal.blockedStageId ?? ctx.graph.stages[0]!.id,
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
    schemaVersion: ctx.v2 ? 2 : 1,
    runId: ctx.input.runId,
    graphRevision: ctx.input.graphRevision,
    expectedScheduleRevision: ctx.input.scheduleRevision,
    nextScheduleRevision: ctx.input.scheduleRevision + 1,
    recordedAt: ctx.input.now,
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
  if (ctx.v2 || ctx.recoveryDecisions.length > 0) {
    plan.recoveryDecisions = [...ctx.recoveryDecisions].sort((left, right) =>
      left.decisionId < right.decisionId ? -1 : left.decisionId > right.decisionId ? 1 : 0,
    );
    plan.recoveryState = freezeRecoveryState(ctx);
  }
  return plan;
}

/**
 * Compute one deterministic scheduler plan from canonical input.
 *
 * Duplicate calls with the same input produce byte-identical plans (same
 * decision, attempt, and intent ids). The store turns those collisions into
 * no-ops via uniqueness constraints.
 */
export function tickScheduler(input: SchedulerInput): SchedulerPlan {
  const v2 =
    input.schemaVersion === 2 ||
    input.recoveryState !== undefined ||
    input.effectiveLimits !== undefined ||
    input.executionMode !== undefined ||
    input.observations.some(
      (observation) =>
        observation.failure !== undefined ||
        observation.kind === "recovery_approved" ||
        observation.kind === "recovery_rejected" ||
        observation.kind === "recovery_proposed",
    );
  return runTick(createTickContext(input, v2));
}

/** V2 entry point with recovery decisions always present on the plan. */
export function tickSchedulerV2(input: SchedulerInputV2Plain): SchedulerPlanV2Plain {
  const plan = runTick(createTickContext({ ...input, schemaVersion: 2 }, true));
  return {
    ...plan,
    schemaVersion: 2,
    recoveryDecisions: plan.recoveryDecisions ?? [],
  };
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
