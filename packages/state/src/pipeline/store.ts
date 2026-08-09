/**
 * Durable pipeline graph scheduler store (Q025, ADR 0023).
 *
 * Applies pure `tickScheduler` plans transactionally: decision and intent
 * rows first, then projection patches, under an expected-revision check.
 * Duplicate ticks collide on deterministic primary keys and become no-ops;
 * concurrent ticks that lose the compare-and-swap reload and retry.
 */

import type { PipelineGraphV1 } from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { internalClock, internalHandle, type StateDatabase } from "../database/open.js";
import { toNullableText, toSafeInteger, toText } from "../database/pragma.js";
import { StateStoreError } from "../errors.js";
import { type JsonValue, parseJsonValue, stringifyCanonical } from "../json.js";
import {
  type InsertRetryDirectiveInput,
  listStageRecoveryStates,
  readCanonicalRunState,
  type UpsertStageRecoveryStateInput,
  writeRecoveryDecision,
  writeRetryDirective,
  writeStageRecoveryState,
} from "./recovery-store.js";

export type PipelineGraph = Static<typeof PipelineGraphV1>;

export interface PipelineScheduleSnapshot {
  readonly runId: string;
  readonly pipelineId: string;
  readonly graphRevision: number;
  readonly scheduleRevision: number;
  readonly deadlineAt: string | null;
  readonly terminalOutcome: string | null;
  readonly terminalReason: string | null;
  readonly terminalStageId: string | null;
  readonly updatedAt: string;
}

export interface PipelineStageProjectionSnapshot {
  readonly runId: string;
  readonly stageId: string;
  readonly graphRevision: number;
  readonly generation: number;
  readonly state: string;
  readonly attemptOrdinal: number;
  readonly currentAttemptId: string | null;
  readonly lastTransitionReason: string | null;
  readonly blockReason: string | null;
  readonly selected: boolean;
  readonly updatedAt: string;
}

export interface PipelineSchedulerDecisionRow {
  readonly decisionId: string;
  readonly runId: string;
  readonly stageId: string | null;
  readonly graphRevision: number;
  readonly generation: number;
  readonly attemptOrdinal: number;
  readonly action: string;
  readonly reason: string;
  readonly fromState: string | null;
  readonly toState: string | null;
  readonly attemptId: string | null;
  readonly intentId: string | null;
  readonly detail: string | null;
  readonly recordedAt: string;
}

export interface PipelineSchedulerIntentRow {
  readonly intentId: string;
  readonly runId: string;
  readonly graphRevision: number;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly state: "pending" | "delivered";
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

export interface PipelineSchedulerObservationRow {
  readonly observationId: string;
  readonly runId: string;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly recordedAt: string;
  readonly consumedAt: string | null;
}

export interface CreatePipelineScheduleInput {
  readonly runId: string;
  readonly pipelineId: string;
  readonly graph: PipelineGraph;
  readonly deadlineAt?: string;
  readonly now?: string;
}

export interface PipelineSchedulerPlanLike {
  readonly runId: string;
  readonly graphRevision: number;
  readonly expectedScheduleRevision: number;
  readonly nextScheduleRevision: number;
  readonly recordedAt: string;
  readonly transitions: readonly unknown[];
  readonly decisions: readonly {
    readonly decisionId: string;
    readonly runId: string;
    readonly stageId?: string;
    readonly graphRevision: number;
    readonly generation: number;
    readonly attemptOrdinal: number;
    readonly action: string;
    readonly reason: string;
    readonly fromState?: string;
    readonly toState?: string;
    readonly attemptId?: string;
    readonly intentId?: string;
    readonly detail?: string;
    readonly recordedAt: string;
  }[];
  readonly intents: readonly {
    readonly intentId: string;
    readonly runId: string;
    readonly graphRevision: number;
    readonly kind: string;
    readonly payload: unknown;
    readonly createdAt: string;
  }[];
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly runId: string;
    readonly pipelineId: string;
    readonly stageId: string;
    readonly graphRevision: number;
    readonly generation: number;
    readonly attemptOrdinal: number;
    readonly stageType: string;
    readonly createdAt: string;
    readonly recoveryDecisionId?: string;
    readonly retryDirective?: unknown;
  }[];
  readonly stagePatches: readonly {
    readonly runId: string;
    readonly stageId: string;
    readonly graphRevision: number;
    readonly generation: number;
    readonly state: string;
    readonly attemptOrdinal: number;
    readonly currentAttemptId?: string;
    readonly lastTransitionReason?: string;
    readonly blockReason?: string;
    readonly selected: boolean;
    readonly updatedAt: string;
  }[];
  readonly consumedObservationIds: readonly string[];
  readonly terminal?: {
    readonly outcome: string;
    readonly reason: string;
    readonly blockedStageId?: string;
  };
  /** Optional V2 recovery ledger — ignored by V1 callers. */
  readonly recoveryDecisions?: ReadonlyArray<{
    readonly decisionId: string;
    readonly runId: string;
    readonly stageId: string;
    readonly graphRevision: number;
    readonly generation: number;
    readonly attemptOrdinal: number;
    readonly action: string;
    readonly outcome: string;
    readonly recordedAt: string;
    readonly decision?: JsonValue;
  }>;
  /** Alias for recoveryStatePatches used by tickSchedulerV2 plans. */
  readonly recoveryState?: readonly {
    readonly stageId: string;
    readonly generation: number;
    readonly repairsUsed: number;
    readonly lastSignatureDigest?: string;
    readonly identicalSignatureCount: number;
    readonly pendingProposalId?: string;
    readonly pendingProposalJson?: unknown;
  }[];
  readonly recoveryStatePatches?: readonly UpsertStageRecoveryStateInput[];
  readonly retryDirectives?: readonly InsertRetryDirectiveInput[];
}

export type ApplyPipelineSchedulerPlanResult =
  | { readonly status: "applied"; readonly scheduleRevision: number }
  | { readonly status: "duplicate"; readonly scheduleRevision: number }
  | { readonly status: "conflict"; readonly scheduleRevision: number };

export class PipelineSchedulerConflictError extends StateStoreError {
  readonly scheduleRevision: number;
  constructor(scheduleRevision: number) {
    super(`pipeline schedule revision conflict: expected different head, have ${scheduleRevision}`);
    this.name = "PipelineSchedulerConflictError";
    this.scheduleRevision = scheduleRevision;
  }
}

function transaction<T>(db: StateDatabase, operation: () => T): T {
  const handle = internalHandle(db);
  if (handle.isTransaction) {
    throw new StateStoreError(
      "pipeline scheduler operations cannot run inside another transaction",
    );
  }
  handle.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    handle.exec("COMMIT");
    return result;
  } catch (error) {
    if (handle.isTransaction) handle.exec("ROLLBACK");
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = String((error as { code?: string }).code ?? "");
  return code.startsWith("SQLITE_CONSTRAINT");
}

export function createPipelineSchedule(
  db: StateDatabase,
  input: CreatePipelineScheduleInput,
): PipelineScheduleSnapshot {
  const now = input.now ?? internalClock(db).nowIso();
  return transaction(db, () => {
    const handle = internalHandle(db);
    const existing = handle
      .prepare("SELECT run_id FROM pipeline_schedule WHERE run_id = ?")
      .get(input.runId);
    if (existing !== undefined) {
      throw new StateStoreError(`pipeline schedule already exists for run ${input.runId}`);
    }

    handle
      .prepare(
        `INSERT INTO pipeline_graph_revision
          (run_id, graph_revision, pipeline_id, graph_json, created_at)
         VALUES (?, 1, ?, ?, ?)`,
      )
      .run(input.runId, input.pipelineId, stringifyCanonical(input.graph as JsonValue), now);

    handle
      .prepare(
        `INSERT INTO pipeline_schedule
          (run_id, pipeline_id, graph_revision, schedule_revision, deadline_at,
           terminal_outcome, terminal_reason, terminal_stage_id, updated_at)
         VALUES (?, ?, 1, 1, ?, NULL, NULL, NULL, ?)`,
      )
      .run(input.runId, input.pipelineId, input.deadlineAt ?? null, now);

    const insertStage = handle.prepare(
      `INSERT INTO pipeline_stage_projection
        (run_id, stage_id, graph_revision, generation, state, attempt_ordinal,
         current_attempt_id, last_transition_reason, block_reason, selected, updated_at)
       VALUES (?, ?, 1, 1, 'pending', 0, NULL, NULL, NULL, 1, ?)`,
    );
    for (const stage of [...input.graph.stages].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      insertStage.run(input.runId, stage.id, now);
    }

    const created = readPipelineSchedule(db, input.runId);
    if (created === undefined) {
      throw new StateStoreError(`failed to read pipeline schedule ${input.runId} after create`);
    }
    return created;
  });
}

export function readPipelineSchedule(
  db: StateDatabase,
  runId: string,
): PipelineScheduleSnapshot | undefined {
  const row = internalHandle(db)
    .prepare(
      `SELECT run_id, pipeline_id, graph_revision, schedule_revision, deadline_at,
              terminal_outcome, terminal_reason, terminal_stage_id, updated_at
         FROM pipeline_schedule WHERE run_id = ?`,
    )
    .get(runId);
  if (row === undefined) {
    return undefined;
  }
  return {
    runId: toText(row.run_id, "row.run_id"),
    pipelineId: toText(row.pipeline_id, "row.pipeline_id"),
    graphRevision: toSafeInteger(row.graph_revision, "row.graph_revision"),
    scheduleRevision: toSafeInteger(row.schedule_revision, "row.schedule_revision"),
    deadlineAt: toNullableText(row.deadline_at, "row.deadline_at"),
    terminalOutcome: toNullableText(row.terminal_outcome, "row.terminal_outcome"),
    terminalReason: toNullableText(row.terminal_reason, "row.terminal_reason"),
    terminalStageId: toNullableText(row.terminal_stage_id, "row.terminal_stage_id"),
    updatedAt: toText(row.updated_at, "row.updated_at"),
  };
}

export function readPipelineGraph(
  db: StateDatabase,
  runId: string,
  graphRevision: number,
): PipelineGraph {
  const row = internalHandle(db)
    .prepare(
      `SELECT graph_json FROM pipeline_graph_revision
        WHERE run_id = ? AND graph_revision = ?`,
    )
    .get(runId, graphRevision);
  if (row === undefined) {
    throw new StateStoreError(`pipeline graph revision ${graphRevision} not found for ${runId}`);
  }
  return parseJsonValue(toText(row.graph_json, "graph_json"), "graph_json") as PipelineGraph;
}

export function readPipelineStageProjections(
  db: StateDatabase,
  runId: string,
): readonly PipelineStageProjectionSnapshot[] {
  const rows = internalHandle(db)
    .prepare(
      `SELECT run_id, stage_id, graph_revision, generation, state, attempt_ordinal,
              current_attempt_id, last_transition_reason, block_reason, selected, updated_at
         FROM pipeline_stage_projection
        WHERE run_id = ?
        ORDER BY stage_id`,
    )
    .all(runId);
  return rows.map((row) => ({
    runId: toText(row.run_id, "row.run_id"),
    stageId: toText(row.stage_id, "row.stage_id"),
    graphRevision: toSafeInteger(row.graph_revision, "row.graph_revision"),
    generation: toSafeInteger(row.generation, "row.generation"),
    state: toText(row.state, "row.state"),
    attemptOrdinal: toSafeInteger(row.attempt_ordinal, "row.attempt_ordinal"),
    currentAttemptId: toNullableText(row.current_attempt_id, "row.current_attempt_id"),
    lastTransitionReason: toNullableText(row.last_transition_reason, "row.last_transition_reason"),
    blockReason: toNullableText(row.block_reason, "row.block_reason"),
    selected: toSafeInteger(row.selected, "row.selected") === 1,
    updatedAt: toText(row.updated_at, "row.updated_at"),
  }));
}

export function readPipelineSchedulerDecisions(
  db: StateDatabase,
  runId: string,
): readonly PipelineSchedulerDecisionRow[] {
  const rows = internalHandle(db)
    .prepare(
      `SELECT decision_id, run_id, stage_id, graph_revision, generation, attempt_ordinal,
              action, reason, from_state, to_state, attempt_id, intent_id, detail, recorded_at
         FROM pipeline_scheduler_decision
        WHERE run_id = ?
        ORDER BY decision_id`,
    )
    .all(runId);
  return rows.map((row) => ({
    decisionId: toText(row.decision_id, "row.decision_id"),
    runId: toText(row.run_id, "row.run_id"),
    stageId: toNullableText(row.stage_id, "row.stage_id"),
    graphRevision: toSafeInteger(row.graph_revision, "row.graph_revision"),
    generation: toSafeInteger(row.generation, "row.generation"),
    attemptOrdinal: toSafeInteger(row.attempt_ordinal, "row.attempt_ordinal"),
    action: toText(row.action, "row.action"),
    reason: toText(row.reason, "row.reason"),
    fromState: toNullableText(row.from_state, "row.from_state"),
    toState: toNullableText(row.to_state, "row.to_state"),
    attemptId: toNullableText(row.attempt_id, "row.attempt_id"),
    intentId: toNullableText(row.intent_id, "row.intent_id"),
    detail: toNullableText(row.detail, "row.detail"),
    recordedAt: toText(row.recorded_at, "row.recorded_at"),
  }));
}

export function readPipelineSchedulerIntents(
  db: StateDatabase,
  runId: string,
): readonly PipelineSchedulerIntentRow[] {
  const rows = internalHandle(db)
    .prepare(
      `SELECT intent_id, run_id, graph_revision, kind, payload_json, state, created_at, delivered_at
         FROM pipeline_scheduler_intent
        WHERE run_id = ?
        ORDER BY intent_id`,
    )
    .all(runId);
  return rows.map((row) => ({
    intentId: toText(row.intent_id, "row.intent_id"),
    runId: toText(row.run_id, "row.run_id"),
    graphRevision: toSafeInteger(row.graph_revision, "row.graph_revision"),
    kind: toText(row.kind, "row.kind"),
    payload: parseJsonValue(toText(row.payload_json, "payload_json"), "payload_json"),
    state: toText(row.state, "row.state") as "pending" | "delivered",
    createdAt: toText(row.created_at, "row.created_at"),
    deliveredAt: toNullableText(row.delivered_at, "row.delivered_at"),
  }));
}

export function readPendingPipelineObservations(
  db: StateDatabase,
  runId: string,
): readonly PipelineSchedulerObservationRow[] {
  const rows = internalHandle(db)
    .prepare(
      `SELECT observation_id, run_id, kind, payload_json, recorded_at, consumed_at
         FROM pipeline_scheduler_observation
        WHERE run_id = ? AND consumed_at IS NULL
        ORDER BY recorded_at, observation_id`,
    )
    .all(runId);
  return rows.map((row) => ({
    observationId: toText(row.observation_id, "row.observation_id"),
    runId: toText(row.run_id, "row.run_id"),
    kind: toText(row.kind, "row.kind"),
    payload: parseJsonValue(toText(row.payload_json, "payload_json"), "payload_json"),
    recordedAt: toText(row.recorded_at, "row.recorded_at"),
    consumedAt: toNullableText(row.consumed_at, "row.consumed_at"),
  }));
}

/** Map stored observation rows into the pure-scheduler observation shape. */
export function toSchedulerObservations(
  rows: readonly PipelineSchedulerObservationRow[],
): readonly {
  readonly schemaVersion: 1 | 2;
  readonly observationId: string;
  readonly kind:
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
  readonly stageId?: string;
  readonly attemptId?: string;
  readonly retryable?: boolean;
  readonly edgeKey?: string;
  readonly selected?: boolean;
  readonly recordedAt: string;
  readonly failure?: unknown;
  readonly signature?: unknown;
  readonly proposalId?: string;
  readonly approved?: boolean;
  readonly priorBackendExecutionId?: string;
  readonly resumeAvailable?: boolean;
  readonly classification?: string;
  readonly phase?: string;
  readonly code?: string;
  readonly backendClassification?: string;
  readonly validationFailures?: readonly string[];
}[] {
  return rows.map((row) => {
    const payload =
      typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {};
    const hasRecoveryFields =
      payload.failure !== undefined ||
      payload.signature !== undefined ||
      row.kind === "recovery_approved" ||
      row.kind === "recovery_rejected" ||
      row.kind === "recovery_proposed";
    return {
      schemaVersion: (hasRecoveryFields ? 2 : 1) as 1 | 2,
      observationId: row.observationId,
      kind: row.kind as
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
        | "recovery_rejected",
      recordedAt: row.recordedAt,
      ...(typeof payload.stageId === "string" ? { stageId: payload.stageId } : {}),
      ...(typeof payload.attemptId === "string" ? { attemptId: payload.attemptId } : {}),
      ...(typeof payload.retryable === "boolean" ? { retryable: payload.retryable } : {}),
      ...(typeof payload.edgeKey === "string" ? { edgeKey: payload.edgeKey } : {}),
      ...(typeof payload.selected === "boolean" ? { selected: payload.selected } : {}),
      ...(payload.failure !== undefined ? { failure: payload.failure } : {}),
      ...(payload.signature !== undefined ? { signature: payload.signature } : {}),
      ...(typeof payload.proposalId === "string" ? { proposalId: payload.proposalId } : {}),
      ...(typeof payload.approved === "boolean" ? { approved: payload.approved } : {}),
      ...(typeof payload.priorBackendExecutionId === "string"
        ? { priorBackendExecutionId: payload.priorBackendExecutionId }
        : {}),
      ...(typeof payload.resumeAvailable === "boolean"
        ? { resumeAvailable: payload.resumeAvailable }
        : {}),
      ...(typeof payload.classification === "string"
        ? { classification: payload.classification }
        : {}),
      ...(typeof payload.phase === "string" ? { phase: payload.phase } : {}),
      ...(typeof payload.code === "string" ? { code: payload.code } : {}),
      ...(typeof payload.backendClassification === "string"
        ? { backendClassification: payload.backendClassification }
        : {}),
      ...(Array.isArray(payload.validationFailures)
        ? {
            validationFailures: payload.validationFailures.filter(
              (entry): entry is string => typeof entry === "string",
            ),
          }
        : {}),
    };
  });
}

export function readPipelineEvaluatorDecisions(
  db: StateDatabase,
  runId: string,
): readonly {
  readonly edgeKey: string;
  readonly selected: boolean;
  readonly recordedAt: string;
}[] {
  const rows = internalHandle(db)
    .prepare(
      `SELECT edge_key, selected, recorded_at
         FROM pipeline_evaluator_decision
        WHERE run_id = ?
        ORDER BY edge_key`,
    )
    .all(runId);
  return rows.map((row) => ({
    edgeKey: toText(row.edge_key, "row.edge_key"),
    selected: toSafeInteger(row.selected, "row.selected") === 1,
    recordedAt: toText(row.recorded_at, "row.recorded_at"),
  }));
}

export function readPendingEvaluatorEdgeKeys(db: StateDatabase, runId: string): readonly string[] {
  const rows = internalHandle(db)
    .prepare(
      `SELECT payload_json FROM pipeline_scheduler_intent
        WHERE run_id = ? AND kind = 'evaluator' AND state = 'pending'
        ORDER BY intent_id`,
    )
    .all(runId);
  return rows
    .map((row) => {
      const payload = parseJsonValue(toText(row.payload_json, "payload_json"), "payload_json") as {
        edgeKey?: string;
      };
      return String(payload.edgeKey ?? "");
    })
    .filter((key) => key.length > 0);
}

export function recordPipelineObservation(
  db: StateDatabase,
  input: {
    readonly observationId: string;
    readonly runId: string;
    readonly kind: string;
    readonly payload: JsonValue;
    readonly recordedAt?: string;
  },
): void {
  const recordedAt = input.recordedAt ?? internalClock(db).nowIso();
  transaction(db, () => {
    try {
      internalHandle(db)
        .prepare(
          `INSERT INTO pipeline_scheduler_observation
            (observation_id, run_id, kind, payload_json, recorded_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          input.observationId,
          input.runId,
          input.kind,
          stringifyCanonical(input.payload),
          recordedAt,
        );
    } catch (error) {
      if (isUniqueViolation(error)) {
        return;
      }
      throw error;
    }
  });
}

/**
 * Apply a scheduler plan. Returns `duplicate` when every decision/intent id
 * already existed (idempotent replay). Returns `conflict` when the expected
 * schedule revision does not match — callers reload and retick.
 */
export function applyPipelineSchedulerPlan(
  db: StateDatabase,
  plan: PipelineSchedulerPlanLike,
): ApplyPipelineSchedulerPlanResult {
  return transaction(db, () => {
    const handle = internalHandle(db);
    const schedule = readPipelineSchedule(db, plan.runId);
    if (schedule === undefined) {
      throw new StateStoreError(`pipeline schedule ${plan.runId} does not exist`);
    }
    if (schedule.scheduleRevision !== plan.expectedScheduleRevision) {
      return { status: "conflict", scheduleRevision: schedule.scheduleRevision };
    }

    let insertedDecision = false;
    const insertDecision = handle.prepare(
      `INSERT INTO pipeline_scheduler_decision
        (decision_id, run_id, stage_id, graph_revision, generation, attempt_ordinal,
         action, reason, from_state, to_state, attempt_id, intent_id, detail, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const decision of plan.decisions) {
      try {
        insertDecision.run(
          decision.decisionId,
          decision.runId,
          decision.stageId ?? null,
          decision.graphRevision,
          decision.generation,
          decision.attemptOrdinal,
          decision.action,
          decision.reason,
          decision.fromState ?? null,
          decision.toState ?? null,
          decision.attemptId ?? null,
          decision.intentId ?? null,
          decision.detail ?? null,
          decision.recordedAt,
        );
        insertedDecision = true;
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
    }

    let insertedIntent = false;
    const insertIntent = handle.prepare(
      `INSERT INTO pipeline_scheduler_intent
        (intent_id, run_id, graph_revision, kind, payload_json, state, created_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
    );
    for (const intent of plan.intents) {
      try {
        insertIntent.run(
          intent.intentId,
          intent.runId,
          intent.graphRevision,
          intent.kind,
          stringifyCanonical(intent.payload as never),
          intent.createdAt,
        );
        insertedIntent = true;
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
    }

    const insertAttempt = handle.prepare(
      `INSERT INTO pipeline_stage_attempt
        (attempt_id, run_id, pipeline_id, stage_id, graph_revision, generation,
         attempt_ordinal, stage_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const attempt of plan.attempts) {
      try {
        insertAttempt.run(
          attempt.attemptId,
          attempt.runId,
          attempt.pipelineId,
          attempt.stageId,
          attempt.graphRevision,
          attempt.generation,
          attempt.attemptOrdinal,
          attempt.stageType,
          attempt.createdAt,
        );
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
    }

    for (const decision of plan.recoveryDecisions ?? []) {
      const decisionJson =
        "decision" in decision && decision.decision !== undefined
          ? decision.decision
          : (decision as unknown as JsonValue);
      writeRecoveryDecision(handle, {
        decisionId: decision.decisionId,
        runId: decision.runId,
        stageId: decision.stageId,
        graphRevision: decision.graphRevision,
        generation: decision.generation,
        attemptOrdinal: decision.attemptOrdinal,
        action: decision.action,
        outcome: decision.outcome,
        decision: decisionJson,
        recordedAt: decision.recordedAt,
      });
    }

    const recoveryPatches: UpsertStageRecoveryStateInput[] = [...(plan.recoveryStatePatches ?? [])];
    for (const entry of plan.recoveryState ?? []) {
      recoveryPatches.push({
        runId: plan.runId,
        stageId: entry.stageId,
        generation: entry.generation,
        repairsUsed: entry.repairsUsed,
        lastSignatureDigest: entry.lastSignatureDigest ?? null,
        identicalSignatureCount: entry.identicalSignatureCount,
        pendingProposalId: entry.pendingProposalId ?? null,
        pendingProposal:
          entry.pendingProposalJson === undefined ? null : (entry.pendingProposalJson as JsonValue),
        updatedAt: plan.recordedAt,
      });
    }
    for (const patch of recoveryPatches) {
      writeStageRecoveryState(handle, patch);
    }

    const retryDirectives: InsertRetryDirectiveInput[] = [...(plan.retryDirectives ?? [])];
    for (const attempt of plan.attempts) {
      if (
        attempt.retryDirective !== undefined &&
        attempt.recoveryDecisionId !== undefined &&
        !retryDirectives.some((entry) => entry.attemptId === attempt.attemptId)
      ) {
        retryDirectives.push({
          attemptId: attempt.attemptId,
          recoveryDecisionId: attempt.recoveryDecisionId,
          directive: attempt.retryDirective as JsonValue,
          createdAt: attempt.createdAt,
        });
      }
    }
    for (const directive of retryDirectives) {
      writeRetryDirective(handle, directive);
    }

    const updateStage = handle.prepare(
      `UPDATE pipeline_stage_projection
          SET graph_revision = ?, generation = ?, state = ?, attempt_ordinal = ?,
              current_attempt_id = ?, last_transition_reason = ?, block_reason = ?,
              selected = ?, updated_at = ?
        WHERE run_id = ? AND stage_id = ?`,
    );
    for (const patch of plan.stagePatches) {
      updateStage.run(
        patch.graphRevision,
        patch.generation,
        patch.state,
        patch.attemptOrdinal,
        patch.currentAttemptId ?? null,
        patch.lastTransitionReason ?? null,
        patch.blockReason ?? null,
        patch.selected ? 1 : 0,
        patch.updatedAt,
        patch.runId,
        patch.stageId,
      );
    }

    if (plan.consumedObservationIds.length > 0) {
      const mark = handle.prepare(
        `UPDATE pipeline_scheduler_observation
            SET consumed_at = ?
          WHERE observation_id = ? AND consumed_at IS NULL`,
      );
      for (const observationId of plan.consumedObservationIds) {
        mark.run(plan.recordedAt, observationId);
      }
    }

    // Persist evaluator decisions recorded via observations in this plan's
    // decision stream (select_edge / reject_edge with edge key detail).
    const insertEvaluator = handle.prepare(
      `INSERT OR IGNORE INTO pipeline_evaluator_decision
        (run_id, edge_key, selected, recorded_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const decision of plan.decisions) {
      if (
        (decision.action === "select_edge" || decision.action === "reject_edge") &&
        decision.detail !== undefined
      ) {
        insertEvaluator.run(
          plan.runId,
          decision.detail,
          decision.action === "select_edge" ? 1 : 0,
          decision.recordedAt,
        );
      }
    }

    handle
      .prepare(
        `UPDATE pipeline_schedule
            SET schedule_revision = ?, terminal_outcome = ?, terminal_reason = ?,
                terminal_stage_id = ?, updated_at = ?
          WHERE run_id = ? AND schedule_revision = ?`,
      )
      .run(
        plan.nextScheduleRevision,
        plan.terminal?.outcome ?? schedule.terminalOutcome,
        plan.terminal?.reason ?? schedule.terminalReason,
        plan.terminal?.blockedStageId ?? schedule.terminalStageId,
        plan.recordedAt,
        plan.runId,
        plan.expectedScheduleRevision,
      );

    const updated = readPipelineSchedule(db, plan.runId);
    if (updated === undefined || updated.scheduleRevision !== plan.nextScheduleRevision) {
      return { status: "conflict", scheduleRevision: schedule.scheduleRevision };
    }

    if (!insertedDecision && !insertedIntent && plan.decisions.length > 0) {
      return { status: "duplicate", scheduleRevision: updated.scheduleRevision };
    }
    return { status: "applied", scheduleRevision: updated.scheduleRevision };
  });
}

export function loadPipelineSchedulerInputParts(
  db: StateDatabase,
  runId: string,
): {
  readonly schedule: PipelineScheduleSnapshot;
  readonly graph: PipelineGraph;
  readonly stages: readonly PipelineStageProjectionSnapshot[];
  readonly observations: readonly PipelineSchedulerObservationRow[];
  readonly evaluatorDecisions: readonly {
    readonly edgeKey: string;
    readonly selected: boolean;
    readonly recordedAt: string;
  }[];
  readonly pendingEvaluatorEdgeKeys: readonly string[];
  readonly recoveryState: ReturnType<typeof listStageRecoveryStates>;
  readonly canonicalState: JsonValue;
} {
  const schedule = readPipelineSchedule(db, runId);
  if (schedule === undefined) {
    throw new StateStoreError(`pipeline schedule ${runId} does not exist`);
  }
  const canonical = readCanonicalRunState(db, runId);
  return {
    schedule,
    graph: readPipelineGraph(db, runId, schedule.graphRevision),
    stages: readPipelineStageProjections(db, runId),
    observations: readPendingPipelineObservations(db, runId),
    evaluatorDecisions: readPipelineEvaluatorDecisions(db, runId),
    pendingEvaluatorEdgeKeys: readPendingEvaluatorEdgeKeys(db, runId),
    recoveryState: listStageRecoveryStates(db, runId),
    canonicalState: canonical?.state ?? {},
  };
}
