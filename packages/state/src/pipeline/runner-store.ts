/**
 * Durable pipeline stage-runner store (Q026/Q027, ADR 0024/0025).
 *
 * Claims scheduler intents idempotently, persists attempt phase transitions
 * before external side effects, and atomically finalizes validated output by
 * binding artifacts, appending a scheduler observation, and settling the
 * intent in one transaction. Q027 adds the fixed-stage operation ledger.
 */

import type {
  ApprovalRequestV1,
  InteractionV2,
  StageRunnerAttemptV2,
  StageRunnerCleanupReportV1,
  StageRunnerEvidenceV1,
  StageRunnerFailureV2,
  StageRunnerOutputBindingV1,
  StageRunnerResultV2,
  StageRunnerValidationReportV1,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { internalClock, internalHandle, type StateDatabase } from "../database/open.js";
import { toNullableText, toSafeInteger, toText } from "../database/pragma.js";
import { StateStoreError } from "../errors.js";
import { type JsonValue, parseJsonValue, stringifyCanonical } from "../json.js";
import type { PipelineSchedulerIntentRow } from "./store.js";

export type StageRunnerAttempt = Static<typeof StageRunnerAttemptV2>;
export type StageRunnerResult = Static<typeof StageRunnerResultV2>;
export type StageRunnerFailure = Static<typeof StageRunnerFailureV2>;
export type StageRunnerEvidence = Static<typeof StageRunnerEvidenceV1>;
export type StageRunnerOutputBinding = Static<typeof StageRunnerOutputBindingV1>;
export type StageRunnerCleanupReport = Static<typeof StageRunnerCleanupReportV1>;
export type StageRunnerValidationReport = Static<typeof StageRunnerValidationReportV1>;

export type RunnerStageType = StageRunnerAttempt["stageType"];
export type RunnerOperationStageType = "approval" | "integration" | "verify" | "publish";
export type RunnerOperationPhase =
  | "pending"
  | "waiting"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled"
  | "reconciliation_required";

const SUPPORTED_STAGE_TYPES = new Set<RunnerStageType>([
  "agent",
  "command",
  "approval",
  "integration",
  "verify",
  "publish",
]);

const OPEN_PHASES = new Set([
  "prepare",
  "start",
  "observe",
  "cancel",
  "collect",
  "validate",
  "finalize",
  "recovery_required",
]);

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

function parseArray<T>(raw: string, label: string): readonly T[] {
  const value = parseJsonValue(raw, label);
  if (!Array.isArray(value)) {
    throw new StateStoreError(`${label} must be a JSON array`);
  }
  return value as readonly T[];
}

function parseOptionalObject<T>(raw: string | null, label: string): T | undefined {
  if (raw === null) return undefined;
  const value = parseJsonValue(raw, label);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StateStoreError(`${label} must be a JSON object`);
  }
  return value as T;
}

function mapAttemptRow(row: Record<string, unknown>): StageRunnerAttempt {
  const outputs = parseArray<StageRunnerOutputBinding>(
    toText(row.outputs_json, "outputs_json"),
    "outputs_json",
  );
  const evidence = parseArray<StageRunnerEvidence>(
    toText(row.evidence_json, "evidence_json"),
    "evidence_json",
  );
  const result = parseOptionalObject<StageRunnerResult>(
    toNullableText(row.result_json, "result_json"),
    "result_json",
  );
  const failure = parseOptionalObject<StageRunnerFailure>(
    toNullableText(row.failure_json, "failure_json"),
    "failure_json",
  );
  const workspaceId = toNullableText(row.workspace_id, "workspace_id");
  const leaseId = toNullableText(row.lease_id, "lease_id");
  const checkoutPath = toNullableText(row.checkout_path, "checkout_path");
  const processGroupIdRaw = row.process_group_id;
  const processGroupId =
    processGroupIdRaw === null || processGroupIdRaw === undefined
      ? undefined
      : toSafeInteger(processGroupIdRaw, "process_group_id");
  const backendExecutionId = toNullableText(row.backend_execution_id, "backend_execution_id");
  const operationId = toNullableText(row.operation_id, "operation_id");
  const deadlineAt = toNullableText(row.deadline_at, "deadline_at");
  const runtimeDirectory = toNullableText(row.runtime_directory, "runtime_directory");
  const preparedAt = toNullableText(row.prepared_at, "prepared_at");
  const startedAt = toNullableText(row.started_at, "started_at");
  const finishedAt = toNullableText(row.finished_at, "finished_at");

  const mapped = {
    schemaVersion: 2 as const,
    attemptId: toText(row.attempt_id, "attempt_id"),
    runId: toText(row.run_id, "run_id"),
    stageId: toText(row.stage_id, "stage_id"),
    stageType: toText(row.stage_type, "stage_type") as RunnerStageType,
    intentId: toText(row.intent_id, "intent_id"),
    graphRevision: toSafeInteger(row.graph_revision, "graph_revision"),
    generation: toSafeInteger(row.generation, "generation"),
    attemptOrdinal: toSafeInteger(row.attempt_ordinal, "attempt_ordinal"),
    phase: toText(row.phase, "phase") as StageRunnerAttempt["phase"],
    ...(workspaceId === null ? {} : { workspaceId }),
    ...(leaseId === null ? {} : { leaseId }),
    ...(checkoutPath === null ? {} : { checkoutPath }),
    ...(processGroupId === undefined ? {} : { processGroupId }),
    ...(backendExecutionId === null ? {} : { backendExecutionId }),
    ...(operationId === null ? {} : { operationId }),
    ...(deadlineAt === null ? {} : { deadlineAt }),
    ...(runtimeDirectory === null ? {} : { runtimeDirectory }),
    ...(preparedAt === null ? {} : { preparedAt }),
    ...(startedAt === null ? {} : { startedAt }),
    ...(finishedAt === null ? {} : { finishedAt }),
    outputs: [...outputs],
    evidence: [...evidence],
    ...(result === undefined ? {} : { result }),
    ...(failure === undefined ? {} : { failure }),
    recovery: toText(row.recovery, "recovery") as StageRunnerAttempt["recovery"],
    revision: toSafeInteger(row.revision, "revision"),
    updatedAt: toText(row.updated_at, "updated_at"),
    createdAt: toText(row.created_at, "created_at"),
  };
  return mapped as StageRunnerAttempt;
}

export function readPendingPipelineSchedulerIntents(
  db: StateDatabase,
  options: { readonly runId?: string; readonly kinds?: readonly string[] } = {},
): readonly PipelineSchedulerIntentRow[] {
  const kinds = options.kinds ?? ["dispatch", "cancel"];
  const placeholders = kinds.map(() => "?").join(", ");
  const params: string[] = [...kinds];
  let sql = `SELECT intent_id, run_id, graph_revision, kind, payload_json, state, created_at, delivered_at
               FROM pipeline_scheduler_intent
              WHERE state = 'pending' AND kind IN (${placeholders})`;
  if (options.runId !== undefined) {
    sql += " AND run_id = ?";
    params.push(options.runId);
  }
  sql += " ORDER BY created_at, intent_id";
  const rows = internalHandle(db)
    .prepare(sql)
    .all(...params);
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

export function markPipelineSchedulerIntentDelivered(
  db: StateDatabase,
  intentId: string,
  deliveredAt?: string,
): void {
  const at = deliveredAt ?? internalClock(db).nowIso();
  const result = internalHandle(db)
    .prepare(
      `UPDATE pipeline_scheduler_intent
          SET state = 'delivered', delivered_at = ?
        WHERE intent_id = ? AND state = 'pending'`,
    )
    .run(at, intentId);
  if (result.changes !== 1) {
    const existing = internalHandle(db)
      .prepare(`SELECT state FROM pipeline_scheduler_intent WHERE intent_id = ?`)
      .get(intentId);
    if (existing === undefined) {
      throw new StateStoreError(`unknown pipeline scheduler intent: ${intentId}`);
    }
    if (toText(existing.state, "state") === "delivered") return;
    throw new StateStoreError(`pipeline scheduler intent ${intentId} could not be delivered`);
  }
}

export interface ClaimRunnerDispatchInput {
  readonly attemptId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly stageType: RunnerStageType | string;
  readonly intentId: string;
  readonly graphRevision: number;
  readonly generation: number;
  readonly attemptOrdinal: number;
  readonly deadlineAt?: string;
  readonly runtimeDirectory?: string;
  readonly now?: string;
}

export type ClaimRunnerDispatchResult =
  | { readonly status: "claimed"; readonly attempt: StageRunnerAttempt }
  | { readonly status: "duplicate"; readonly attempt: StageRunnerAttempt }
  | { readonly status: "unsupported"; readonly stageType: string };

/**
 * Idempotently claim a dispatch intent by inserting the runner attempt row.
 * Persist before any workspace or process side effect.
 */
export function claimRunnerDispatch(
  db: StateDatabase,
  input: ClaimRunnerDispatchInput,
): ClaimRunnerDispatchResult {
  if (!SUPPORTED_STAGE_TYPES.has(input.stageType as RunnerStageType)) {
    return { status: "unsupported", stageType: input.stageType };
  }
  const existing = readRunnerAttempt(db, input.attemptId);
  if (existing !== undefined) {
    return { status: "duplicate", attempt: existing };
  }
  const byIntent = readRunnerAttemptByIntent(db, input.intentId);
  if (byIntent !== undefined) {
    return { status: "duplicate", attempt: byIntent };
  }

  const now = input.now ?? internalClock(db).nowIso();
  const handle = internalHandle(db);
  handle.exec("BEGIN IMMEDIATE");
  try {
    handle
      .prepare(
        `INSERT INTO pipeline_runner_attempt (
           attempt_id, run_id, stage_id, stage_type, intent_id, graph_revision,
           generation, attempt_ordinal, phase, workspace_id, lease_id, checkout_path,
           process_group_id, backend_execution_id, operation_id, deadline_at,
           runtime_directory, prepared_at, started_at, finished_at, outputs_json,
           evidence_json, result_json, failure_json, cleanup_json, validation_json,
           recovery, revision, updated_at, created_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, 'prepare', NULL, NULL, NULL,
           NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, '[]', '[]',
           NULL, NULL, NULL, NULL, 'none',
           1, ?, ?
         )`,
      )
      .run(
        input.attemptId,
        input.runId,
        input.stageId,
        input.stageType,
        input.intentId,
        input.graphRevision,
        input.generation,
        input.attemptOrdinal,
        input.deadlineAt ?? null,
        input.runtimeDirectory ?? null,
        now,
        now,
      );
    handle
      .prepare(
        `INSERT INTO pipeline_runner_phase_transition
           (transition_id, attempt_id, from_phase, to_phase, recorded_at, detail)
         VALUES (?, ?, NULL, 'prepare', ?, ?)`,
      )
      .run(`prt:${input.attemptId}:1`, input.attemptId, now, "claim_dispatch");
    handle.exec("COMMIT");
  } catch (error) {
    handle.exec("ROLLBACK");
    const duplicate =
      readRunnerAttempt(db, input.attemptId) ?? readRunnerAttemptByIntent(db, input.intentId);
    if (duplicate !== undefined) return { status: "duplicate", attempt: duplicate };
    throw error;
  }
  const attempt = readRunnerAttempt(db, input.attemptId);
  if (attempt === undefined)
    throw new StateStoreError("claimed runner attempt missing after insert");
  return { status: "claimed", attempt };
}

export function readRunnerAttempt(
  db: StateDatabase,
  attemptId: string,
): StageRunnerAttempt | undefined {
  const row = internalHandle(db)
    .prepare(`SELECT * FROM pipeline_runner_attempt WHERE attempt_id = ?`)
    .get(attemptId);
  if (row === undefined) return undefined;
  return mapAttemptRow(row as Record<string, unknown>);
}

export function readRunnerAttemptByIntent(
  db: StateDatabase,
  intentId: string,
): StageRunnerAttempt | undefined {
  const row = internalHandle(db)
    .prepare(`SELECT * FROM pipeline_runner_attempt WHERE intent_id = ?`)
    .get(intentId);
  if (row === undefined) return undefined;
  return mapAttemptRow(row as Record<string, unknown>);
}

export function readOpenRunnerAttempts(db: StateDatabase): readonly StageRunnerAttempt[] {
  const rows = internalHandle(db)
    .prepare(
      `SELECT * FROM pipeline_runner_attempt
        WHERE phase NOT IN ('succeeded','failed','cancelled')
        ORDER BY updated_at, attempt_id`,
    )
    .all();
  return rows.map((row) => mapAttemptRow(row as Record<string, unknown>));
}

export function exportRunnerAttempt(
  db: StateDatabase,
  attemptId: string,
): {
  readonly attempt: StageRunnerAttempt;
  readonly transitions: readonly {
    readonly transitionId: string;
    readonly fromPhase: string | null;
    readonly toPhase: string;
    readonly recordedAt: string;
    readonly detail: string | null;
  }[];
  readonly cleanup: StageRunnerCleanupReport | undefined;
  readonly validation: StageRunnerValidationReport | undefined;
} {
  const attempt = readRunnerAttempt(db, attemptId);
  if (attempt === undefined) throw new StateStoreError(`unknown runner attempt: ${attemptId}`);
  const transitions = internalHandle(db)
    .prepare(
      `SELECT transition_id, from_phase, to_phase, recorded_at, detail
         FROM pipeline_runner_phase_transition
        WHERE attempt_id = ?
        ORDER BY recorded_at, transition_id`,
    )
    .all(attemptId)
    .map((row) => ({
      transitionId: toText(row.transition_id, "transition_id"),
      fromPhase: toNullableText(row.from_phase, "from_phase"),
      toPhase: toText(row.to_phase, "to_phase"),
      recordedAt: toText(row.recorded_at, "recorded_at"),
      detail: toNullableText(row.detail, "detail"),
    }));
  const raw = internalHandle(db)
    .prepare(
      `SELECT cleanup_json, validation_json FROM pipeline_runner_attempt WHERE attempt_id = ?`,
    )
    .get(attemptId) as { cleanup_json: unknown; validation_json: unknown } | undefined;
  return {
    attempt,
    transitions,
    cleanup: parseOptionalObject<StageRunnerCleanupReport>(
      toNullableText(raw?.cleanup_json, "cleanup_json"),
      "cleanup_json",
    ),
    validation: parseOptionalObject<StageRunnerValidationReport>(
      toNullableText(raw?.validation_json, "validation_json"),
      "validation_json",
    ),
  };
}

export interface UpdateRunnerAttemptInput {
  readonly attemptId: string;
  readonly expectedRevision: number;
  readonly phase?: StageRunnerAttempt["phase"];
  readonly workspaceId?: string | null;
  readonly leaseId?: string | null;
  readonly checkoutPath?: string | null;
  readonly processGroupId?: number | null;
  readonly backendExecutionId?: string | null;
  readonly deadlineAt?: string | null;
  readonly runtimeDirectory?: string | null;
  readonly preparedAt?: string | null;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly outputs?: readonly StageRunnerOutputBinding[];
  readonly evidence?: readonly StageRunnerEvidence[];
  readonly result?: StageRunnerResult | null;
  readonly failure?: StageRunnerFailure | null;
  readonly cleanup?: StageRunnerCleanupReport | null;
  readonly validation?: StageRunnerValidationReport | null;
  readonly recovery?: StageRunnerAttempt["recovery"];
  readonly operationId?: string | null;
  readonly transitionDetail?: string;
  readonly now?: string;
}

export function updateRunnerAttempt(
  db: StateDatabase,
  input: UpdateRunnerAttemptInput,
): StageRunnerAttempt {
  const current = readRunnerAttempt(db, input.attemptId);
  if (current === undefined)
    throw new StateStoreError(`unknown runner attempt: ${input.attemptId}`);
  if (current.revision !== input.expectedRevision) {
    throw new StateStoreError(
      `runner attempt revision conflict: expected ${input.expectedRevision}, have ${current.revision}`,
    );
  }
  const now = input.now ?? internalClock(db).nowIso();
  const nextPhase = input.phase ?? current.phase;
  const finishedAt =
    input.finishedAt !== undefined
      ? input.finishedAt
      : OPEN_PHASES.has(nextPhase)
        ? null
        : (current.finishedAt ?? now);
  const handle = internalHandle(db);
  handle.exec("BEGIN IMMEDIATE");
  try {
    const existingExtras = handle
      .prepare(
        `SELECT cleanup_json, validation_json FROM pipeline_runner_attempt WHERE attempt_id = ?`,
      )
      .get(input.attemptId) as
      | { cleanup_json: string | null; validation_json: string | null }
      | undefined;
    const cleanupJson =
      input.cleanup === undefined
        ? (existingExtras?.cleanup_json ?? null)
        : input.cleanup === null
          ? null
          : stringifyCanonical(asJson(input.cleanup));
    const validationJson =
      input.validation === undefined
        ? (existingExtras?.validation_json ?? null)
        : input.validation === null
          ? null
          : stringifyCanonical(asJson(input.validation));
    const result = handle
      .prepare(
        `UPDATE pipeline_runner_attempt SET
           phase = ?,
           workspace_id = ?,
           lease_id = ?,
           checkout_path = ?,
           process_group_id = ?,
           backend_execution_id = ?,
           operation_id = ?,
           deadline_at = ?,
           runtime_directory = ?,
           prepared_at = ?,
           started_at = ?,
           finished_at = ?,
           outputs_json = ?,
           evidence_json = ?,
           result_json = ?,
           failure_json = ?,
           cleanup_json = ?,
           validation_json = ?,
           recovery = ?,
           revision = ?,
           updated_at = ?
         WHERE attempt_id = ? AND revision = ?`,
      )
      .run(
        nextPhase,
        input.workspaceId !== undefined ? input.workspaceId : (current.workspaceId ?? null),
        input.leaseId !== undefined ? input.leaseId : (current.leaseId ?? null),
        input.checkoutPath !== undefined ? input.checkoutPath : (current.checkoutPath ?? null),
        input.processGroupId !== undefined
          ? input.processGroupId
          : (current.processGroupId ?? null),
        input.backendExecutionId !== undefined
          ? input.backendExecutionId
          : (current.backendExecutionId ?? null),
        input.operationId !== undefined ? input.operationId : (current.operationId ?? null),
        input.deadlineAt !== undefined ? input.deadlineAt : (current.deadlineAt ?? null),
        input.runtimeDirectory !== undefined
          ? input.runtimeDirectory
          : (current.runtimeDirectory ?? null),
        input.preparedAt !== undefined ? input.preparedAt : (current.preparedAt ?? null),
        input.startedAt !== undefined ? input.startedAt : (current.startedAt ?? null),
        finishedAt,
        stringifyCanonical(asJson(input.outputs ?? current.outputs)),
        stringifyCanonical(asJson(input.evidence ?? current.evidence)),
        input.result === null || (input.result === undefined && current.result === undefined)
          ? null
          : stringifyCanonical(asJson(input.result ?? current.result)),
        input.failure === null || (input.failure === undefined && current.failure === undefined)
          ? null
          : stringifyCanonical(asJson(input.failure ?? current.failure)),
        cleanupJson,
        validationJson,
        input.recovery ?? current.recovery,
        current.revision + 1,
        now,
        input.attemptId,
        input.expectedRevision,
      );
    if (result.changes !== 1) {
      throw new StateStoreError(`runner attempt update failed for ${input.attemptId}`);
    }
    if (input.phase !== undefined && input.phase !== current.phase) {
      handle
        .prepare(
          `INSERT INTO pipeline_runner_phase_transition
             (transition_id, attempt_id, from_phase, to_phase, recorded_at, detail)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `prt:${input.attemptId}:${current.revision + 1}`,
          input.attemptId,
          current.phase,
          input.phase,
          now,
          input.transitionDetail ?? null,
        );
    }
    handle.exec("COMMIT");
  } catch (error) {
    handle.exec("ROLLBACK");
    throw error;
  }
  const updated = readRunnerAttempt(db, input.attemptId);
  if (updated === undefined) throw new StateStoreError("runner attempt missing after update");
  return updated;
}

export interface FinalizeRunnerAttemptInput {
  readonly attemptId: string;
  readonly expectedRevision: number;
  readonly observationId: string;
  readonly observationKind: "attempt_succeeded" | "attempt_failed" | "cancellation_settled";
  readonly retryable?: boolean;
  /** Classified PipelineFailure/v1 JSON for attempt_failed observations. */
  readonly classifiedFailure?: JsonValue;
  /** PipelineFailureSignature/v1 JSON paired with classifiedFailure. */
  readonly failureSignature?: JsonValue;
  readonly priorBackendExecutionId?: string;
  readonly resumeAvailable?: boolean;
  readonly result?: StageRunnerResult;
  readonly failure?: StageRunnerFailure;
  readonly outputs: readonly StageRunnerOutputBinding[];
  readonly evidence: readonly StageRunnerEvidence[];
  readonly validation: StageRunnerValidationReport;
  readonly cleanup?: StageRunnerCleanupReport;
  readonly phase: "succeeded" | "failed" | "cancelled" | "recovery_required";
  readonly recovery?: StageRunnerAttempt["recovery"];
  readonly now?: string;
}

/**
 * Atomically bind outputs, persist evidence/validation, append the scheduler
 * observation, and settle the dispatch/cancel intent.
 */
export function finalizeRunnerAttempt(
  db: StateDatabase,
  input: FinalizeRunnerAttemptInput,
): StageRunnerAttempt {
  const current = readRunnerAttempt(db, input.attemptId);
  if (current === undefined)
    throw new StateStoreError(`unknown runner attempt: ${input.attemptId}`);
  if (current.revision !== input.expectedRevision) {
    throw new StateStoreError(
      `runner attempt revision conflict: expected ${input.expectedRevision}, have ${current.revision}`,
    );
  }
  const now = input.now ?? internalClock(db).nowIso();
  const handle = internalHandle(db);
  handle.exec("BEGIN IMMEDIATE");
  try {
    const update = handle
      .prepare(
        `UPDATE pipeline_runner_attempt SET
           phase = ?,
           finished_at = ?,
           outputs_json = ?,
           evidence_json = ?,
           result_json = ?,
           failure_json = ?,
           cleanup_json = ?,
           validation_json = ?,
           recovery = ?,
           revision = ?,
           updated_at = ?
         WHERE attempt_id = ? AND revision = ?`,
      )
      .run(
        input.phase,
        now,
        stringifyCanonical(asJson(input.outputs)),
        stringifyCanonical(asJson(input.evidence)),
        input.result === undefined ? null : stringifyCanonical(asJson(input.result)),
        input.failure === undefined ? null : stringifyCanonical(asJson(input.failure)),
        input.cleanup === undefined ? null : stringifyCanonical(asJson(input.cleanup)),
        stringifyCanonical(asJson(input.validation)),
        input.recovery ?? "none",
        current.revision + 1,
        now,
        input.attemptId,
        input.expectedRevision,
      );
    if (update.changes !== 1) {
      throw new StateStoreError(`finalize failed for runner attempt ${input.attemptId}`);
    }
    handle
      .prepare(
        `INSERT INTO pipeline_runner_phase_transition
           (transition_id, attempt_id, from_phase, to_phase, recorded_at, detail)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `prt:${input.attemptId}:${current.revision + 1}`,
        input.attemptId,
        current.phase,
        input.phase,
        now,
        "finalize",
      );

    const observationPayload = {
      stageId: current.stageId,
      attemptId: current.attemptId,
      ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
      ...(input.classifiedFailure === undefined ? {} : { failure: input.classifiedFailure }),
      ...(input.failureSignature === undefined ? {} : { signature: input.failureSignature }),
      ...(input.priorBackendExecutionId === undefined
        ? {}
        : { priorBackendExecutionId: input.priorBackendExecutionId }),
      ...(input.resumeAvailable === undefined ? {} : { resumeAvailable: input.resumeAvailable }),
    };
    handle
      .prepare(
        `INSERT INTO pipeline_scheduler_observation
           (observation_id, run_id, kind, payload_json, recorded_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        input.observationId,
        current.runId,
        input.observationKind,
        stringifyCanonical(asJson(observationPayload)),
        now,
      );

    handle
      .prepare(
        `UPDATE pipeline_scheduler_intent
            SET state = 'delivered', delivered_at = ?
          WHERE intent_id = ? AND state = 'pending'`,
      )
      .run(now, current.intentId);

    handle.exec("COMMIT");
  } catch (error) {
    handle.exec("ROLLBACK");
    throw error;
  }
  const finalized = readRunnerAttempt(db, input.attemptId);
  if (finalized === undefined) throw new StateStoreError("runner attempt missing after finalize");
  return finalized;
}

export interface RunnerCleanupHealthReport {
  readonly openAttempts: number;
  readonly recoveryRequired: number;
  readonly uncleanProcessGroups: number;
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly phase: string;
    readonly recovery: string;
    readonly processGroupId: number | null;
    readonly cleaned: boolean | null;
  }[];
}

export function reportRunnerCleanupHealth(db: StateDatabase): RunnerCleanupHealthReport {
  const open = readOpenRunnerAttempts(db);
  const attempts = open.map((attempt) => {
    const exported = exportRunnerAttempt(db, attempt.attemptId);
    return {
      attemptId: attempt.attemptId,
      phase: attempt.phase,
      recovery: attempt.recovery,
      processGroupId: attempt.processGroupId ?? null,
      cleaned: exported.cleanup?.cleaned ?? null,
    };
  });
  return {
    openAttempts: attempts.length,
    recoveryRequired: attempts.filter((row) => row.phase === "recovery_required").length,
    uncleanProcessGroups: attempts.filter(
      (row) => row.processGroupId !== null && row.cleaned === false,
    ).length,
    attempts,
  };
}

export interface RunnerOperationRequestRow {
  readonly operationId: string;
  readonly attemptId: string;
  readonly stageType: RunnerOperationStageType;
  readonly request: JsonValue;
  readonly createdAt: string;
}

export interface RunnerOperationStateRow {
  readonly operationId: string;
  readonly attemptId: string;
  readonly phase: RunnerOperationPhase;
  readonly result: JsonValue | undefined;
  readonly failure: JsonValue | undefined;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface RunnerApprovalAnswerRow {
  readonly answerId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly interactionId: string;
  readonly expectedRevision: number;
  readonly decision: "approve" | "reject";
  readonly selectedLabel: string;
  readonly answeredByKeyId: string;
  readonly answeredAt: string;
  readonly decisionJson: JsonValue;
}

export interface RunnerExternalObservationRow {
  readonly observationId: string;
  readonly attemptId: string;
  readonly operationId: string | null;
  readonly kind: string;
  readonly recordedAt: string;
  readonly payload: JsonValue;
}

export interface RunnerReconciliationTraceRow {
  readonly traceId: string;
  readonly attemptId: string;
  readonly operationId: string | null;
  readonly stageType: "integration" | "publish";
  readonly classification: string;
  readonly recordedAt: string;
  readonly detail: string | null;
  readonly payload: JsonValue | undefined;
}

export interface PipelineApprovalInboxItem {
  readonly runId: string;
  readonly stageId: string;
  readonly attemptId: string;
  readonly operationId: string;
  readonly interactionRevision: number;
  readonly interaction: Static<typeof InteractionV2>;
}

export interface PersistRunnerOperationRequestInput {
  readonly operationId: string;
  readonly attemptId: string;
  readonly stageType: RunnerOperationStageType;
  readonly request: JsonValue;
  readonly initialPhase?: RunnerOperationPhase;
  readonly now?: string;
}

export interface UpdateRunnerOperationStateInput {
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly phase?: RunnerOperationPhase;
  readonly result?: JsonValue | null;
  readonly failure?: JsonValue | null;
  readonly now?: string;
}

export interface RecordRunnerApprovalAnswerInput {
  readonly answerId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly interactionId: string;
  readonly expectedRevision: number;
  readonly decision: "approve" | "reject";
  readonly selectedLabel: string;
  readonly answeredByKeyId: string;
  readonly decisionJson: JsonValue;
  readonly answeredAt?: string;
}

export interface AppendRunnerExternalObservationInput {
  readonly observationId: string;
  readonly attemptId: string;
  readonly operationId?: string;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly recordedAt?: string;
}

export interface AppendRunnerReconciliationTraceInput {
  readonly traceId: string;
  readonly attemptId: string;
  readonly operationId?: string;
  readonly stageType: "integration" | "publish";
  readonly classification: string;
  readonly detail?: string;
  readonly payload?: JsonValue;
  readonly recordedAt?: string;
}

function mapOperationRequestRow(row: Record<string, unknown>): RunnerOperationRequestRow {
  return {
    operationId: toText(row.operation_id, "operation_id"),
    attemptId: toText(row.attempt_id, "attempt_id"),
    stageType: toText(row.stage_type, "stage_type") as RunnerOperationStageType,
    request: parseJsonValue(toText(row.request_json, "request_json"), "request_json"),
    createdAt: toText(row.created_at, "created_at"),
  };
}

function mapOperationStateRow(row: Record<string, unknown>): RunnerOperationStateRow {
  return {
    operationId: toText(row.operation_id, "operation_id"),
    attemptId: toText(row.attempt_id, "attempt_id"),
    phase: toText(row.phase, "phase") as RunnerOperationPhase,
    result: parseOptionalObject<JsonValue>(
      toNullableText(row.result_json, "result_json"),
      "result_json",
    ),
    failure: parseOptionalObject<JsonValue>(
      toNullableText(row.failure_json, "failure_json"),
      "failure_json",
    ),
    revision: toSafeInteger(row.revision, "revision"),
    updatedAt: toText(row.updated_at, "updated_at"),
  };
}

/**
 * Persist an immutable operation request and its initial revisioned state
 * before any Git/Forge/approval side effect. Links the attempt via operation_id.
 */
export function persistRunnerOperationRequest(
  db: StateDatabase,
  input: PersistRunnerOperationRequestInput,
): {
  readonly request: RunnerOperationRequestRow;
  readonly state: RunnerOperationStateRow;
  readonly attempt: StageRunnerAttempt;
} {
  const attempt = readRunnerAttempt(db, input.attemptId);
  if (attempt === undefined) {
    throw new StateStoreError(`unknown runner attempt: ${input.attemptId}`);
  }
  const existing = readRunnerOperationRequest(db, input.operationId);
  if (existing !== undefined) {
    const state = readRunnerOperationState(db, input.operationId);
    if (state === undefined) {
      throw new StateStoreError(`operation state missing for ${input.operationId}`);
    }
    return { request: existing, state, attempt };
  }
  const byAttempt = readRunnerOperationRequestByAttempt(db, input.attemptId);
  if (byAttempt !== undefined) {
    if (byAttempt.operationId !== input.operationId) {
      throw new StateStoreError(
        `runner attempt ${input.attemptId} already has operation ${byAttempt.operationId}`,
      );
    }
    const state = readRunnerOperationState(db, input.operationId);
    if (state === undefined) {
      throw new StateStoreError(`operation state missing for ${input.operationId}`);
    }
    return { request: byAttempt, state, attempt };
  }

  const now = input.now ?? internalClock(db).nowIso();
  const initialPhase = input.initialPhase ?? "pending";
  const handle = internalHandle(db);
  handle.exec("BEGIN IMMEDIATE");
  try {
    handle
      .prepare(
        `INSERT INTO pipeline_runner_operation_request
           (operation_id, attempt_id, stage_type, request_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.operationId,
        input.attemptId,
        input.stageType,
        stringifyCanonical(input.request),
        now,
      );
    handle
      .prepare(
        `INSERT INTO pipeline_runner_operation_state
           (operation_id, attempt_id, phase, result_json, failure_json, revision, updated_at)
         VALUES (?, ?, ?, NULL, NULL, 1, ?)`,
      )
      .run(input.operationId, input.attemptId, initialPhase, now);
    const linked = handle
      .prepare(
        `UPDATE pipeline_runner_attempt
            SET operation_id = ?, revision = revision + 1, updated_at = ?
          WHERE attempt_id = ? AND revision = ?`,
      )
      .run(input.operationId, now, input.attemptId, attempt.revision);
    if (linked.changes !== 1) {
      throw new StateStoreError(`failed to link operation ${input.operationId} to attempt`);
    }
    handle.exec("COMMIT");
  } catch (error) {
    handle.exec("ROLLBACK");
    const duplicate = readRunnerOperationRequest(db, input.operationId);
    if (duplicate !== undefined) {
      const state = readRunnerOperationState(db, input.operationId);
      if (state === undefined) {
        throw new StateStoreError(`operation state missing for ${input.operationId}`);
      }
      const linkedAttempt = readRunnerAttempt(db, input.attemptId);
      if (linkedAttempt === undefined) {
        throw new StateStoreError(`unknown runner attempt: ${input.attemptId}`);
      }
      return { request: duplicate, state, attempt: linkedAttempt };
    }
    throw error;
  }
  const request = readRunnerOperationRequest(db, input.operationId);
  const state = readRunnerOperationState(db, input.operationId);
  const linkedAttempt = readRunnerAttempt(db, input.attemptId);
  if (request === undefined || state === undefined || linkedAttempt === undefined) {
    throw new StateStoreError("operation request missing after persist");
  }
  return { request, state, attempt: linkedAttempt };
}

export function updateRunnerOperationState(
  db: StateDatabase,
  input: UpdateRunnerOperationStateInput,
): RunnerOperationStateRow {
  const current = readRunnerOperationState(db, input.operationId);
  if (current === undefined) {
    throw new StateStoreError(`unknown runner operation: ${input.operationId}`);
  }
  if (current.revision !== input.expectedRevision) {
    throw new StateStoreError(
      `runner operation revision conflict: expected ${input.expectedRevision}, have ${current.revision}`,
    );
  }
  const now = input.now ?? internalClock(db).nowIso();
  const resultJson =
    input.result === undefined
      ? current.result === undefined
        ? null
        : stringifyCanonical(current.result)
      : input.result === null
        ? null
        : stringifyCanonical(input.result);
  const failureJson =
    input.failure === undefined
      ? current.failure === undefined
        ? null
        : stringifyCanonical(current.failure)
      : input.failure === null
        ? null
        : stringifyCanonical(input.failure);
  const result = internalHandle(db)
    .prepare(
      `UPDATE pipeline_runner_operation_state
          SET phase = ?, result_json = ?, failure_json = ?, revision = ?, updated_at = ?
        WHERE operation_id = ? AND revision = ?`,
    )
    .run(
      input.phase ?? current.phase,
      resultJson,
      failureJson,
      current.revision + 1,
      now,
      input.operationId,
      input.expectedRevision,
    );
  if (result.changes !== 1) {
    throw new StateStoreError(`runner operation update failed for ${input.operationId}`);
  }
  const updated = readRunnerOperationState(db, input.operationId);
  if (updated === undefined) throw new StateStoreError("operation state missing after update");
  return updated;
}

export type RecordRunnerApprovalAnswerResult =
  | { readonly status: "recorded"; readonly answer: RunnerApprovalAnswerRow }
  | { readonly status: "duplicate"; readonly answer: RunnerApprovalAnswerRow }
  | { readonly status: "stale_revision"; readonly currentRevision: number };

export function recordRunnerApprovalAnswer(
  db: StateDatabase,
  input: RecordRunnerApprovalAnswerInput,
): RecordRunnerApprovalAnswerResult {
  const existing = readRunnerApprovalAnswer(db, input.operationId);
  if (existing !== undefined) {
    return { status: "duplicate", answer: existing };
  }
  const state = readRunnerOperationState(db, input.operationId);
  if (state === undefined) {
    throw new StateStoreError(`unknown runner operation: ${input.operationId}`);
  }
  if (state.revision !== input.expectedRevision) {
    return { status: "stale_revision", currentRevision: state.revision };
  }
  const answeredAt = input.answeredAt ?? internalClock(db).nowIso();
  const handle = internalHandle(db);
  handle.exec("BEGIN IMMEDIATE");
  try {
    const insert = handle
      .prepare(
        `INSERT INTO pipeline_runner_approval_answer (
           answer_id, operation_id, attempt_id, interaction_id, expected_revision,
           decision, selected_label, answered_by_key_id, answered_at, decision_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.answerId,
        input.operationId,
        input.attemptId,
        input.interactionId,
        input.expectedRevision,
        input.decision,
        input.selectedLabel,
        input.answeredByKeyId,
        answeredAt,
        stringifyCanonical(input.decisionJson),
      );
    if (insert.changes !== 1) {
      throw new StateStoreError(`failed to record approval answer ${input.answerId}`);
    }
    const advanced = handle
      .prepare(
        `UPDATE pipeline_runner_operation_state
            SET revision = ?, updated_at = ?
          WHERE operation_id = ? AND revision = ?`,
      )
      .run(state.revision + 1, answeredAt, input.operationId, input.expectedRevision);
    if (advanced.changes !== 1) {
      throw new StateStoreError(`approval answer CAS failed for ${input.operationId}`);
    }
    handle.exec("COMMIT");
  } catch (error) {
    handle.exec("ROLLBACK");
    const duplicate = readRunnerApprovalAnswer(db, input.operationId);
    if (duplicate !== undefined) return { status: "duplicate", answer: duplicate };
    const current = readRunnerOperationState(db, input.operationId);
    if (current !== undefined && current.revision !== input.expectedRevision) {
      return { status: "stale_revision", currentRevision: current.revision };
    }
    throw error;
  }
  const answer = readRunnerApprovalAnswer(db, input.operationId);
  if (answer === undefined) throw new StateStoreError("approval answer missing after record");
  return { status: "recorded", answer };
}

export function appendRunnerExternalObservation(
  db: StateDatabase,
  input: AppendRunnerExternalObservationInput,
): RunnerExternalObservationRow {
  const recordedAt = input.recordedAt ?? internalClock(db).nowIso();
  try {
    internalHandle(db)
      .prepare(
        `INSERT INTO pipeline_runner_external_observation
           (observation_id, attempt_id, operation_id, kind, recorded_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.observationId,
        input.attemptId,
        input.operationId ?? null,
        input.kind,
        recordedAt,
        stringifyCanonical(input.payload),
      );
  } catch (error) {
    const existing = readRunnerExternalObservation(db, input.observationId);
    if (existing !== undefined) return existing;
    throw error;
  }
  const row = readRunnerExternalObservation(db, input.observationId);
  if (row === undefined) throw new StateStoreError("external observation missing after append");
  return row;
}

export function appendRunnerReconciliationTrace(
  db: StateDatabase,
  input: AppendRunnerReconciliationTraceInput,
): RunnerReconciliationTraceRow {
  const recordedAt = input.recordedAt ?? internalClock(db).nowIso();
  try {
    internalHandle(db)
      .prepare(
        `INSERT INTO pipeline_runner_reconciliation_trace
           (trace_id, attempt_id, operation_id, stage_type, classification,
            recorded_at, detail, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.traceId,
        input.attemptId,
        input.operationId ?? null,
        input.stageType,
        input.classification,
        recordedAt,
        input.detail ?? null,
        input.payload === undefined ? null : stringifyCanonical(input.payload),
      );
  } catch (error) {
    const existing = readRunnerReconciliationTrace(db, input.traceId);
    if (existing !== undefined) return existing;
    throw error;
  }
  const row = readRunnerReconciliationTrace(db, input.traceId);
  if (row === undefined) throw new StateStoreError("reconciliation trace missing after append");
  return row;
}

export function readRunnerOperationRequest(
  db: StateDatabase,
  operationId: string,
): RunnerOperationRequestRow | undefined {
  const row = internalHandle(db)
    .prepare(`SELECT * FROM pipeline_runner_operation_request WHERE operation_id = ?`)
    .get(operationId);
  if (row === undefined) return undefined;
  return mapOperationRequestRow(row as Record<string, unknown>);
}

export function readRunnerOperationRequestByAttempt(
  db: StateDatabase,
  attemptId: string,
): RunnerOperationRequestRow | undefined {
  const row = internalHandle(db)
    .prepare(`SELECT * FROM pipeline_runner_operation_request WHERE attempt_id = ?`)
    .get(attemptId);
  if (row === undefined) return undefined;
  return mapOperationRequestRow(row as Record<string, unknown>);
}

export function readRunnerOperationState(
  db: StateDatabase,
  operationId: string,
): RunnerOperationStateRow | undefined {
  const row = internalHandle(db)
    .prepare(`SELECT * FROM pipeline_runner_operation_state WHERE operation_id = ?`)
    .get(operationId);
  if (row === undefined) return undefined;
  return mapOperationStateRow(row as Record<string, unknown>);
}

export function readRunnerApprovalAnswer(
  db: StateDatabase,
  operationId: string,
): RunnerApprovalAnswerRow | undefined {
  const row = internalHandle(db)
    .prepare(`SELECT * FROM pipeline_runner_approval_answer WHERE operation_id = ?`)
    .get(operationId);
  if (row === undefined) return undefined;
  return {
    answerId: toText(row.answer_id, "answer_id"),
    operationId: toText(row.operation_id, "operation_id"),
    attemptId: toText(row.attempt_id, "attempt_id"),
    interactionId: toText(row.interaction_id, "interaction_id"),
    expectedRevision: toSafeInteger(row.expected_revision, "expected_revision"),
    decision: toText(row.decision, "decision") as "approve" | "reject",
    selectedLabel: toText(row.selected_label, "selected_label"),
    answeredByKeyId: toText(row.answered_by_key_id, "answered_by_key_id"),
    answeredAt: toText(row.answered_at, "answered_at"),
    decisionJson: parseJsonValue(toText(row.decision_json, "decision_json"), "decision_json"),
  };
}

export function readRunnerExternalObservation(
  db: StateDatabase,
  observationId: string,
): RunnerExternalObservationRow | undefined {
  const row = internalHandle(db)
    .prepare(`SELECT * FROM pipeline_runner_external_observation WHERE observation_id = ?`)
    .get(observationId);
  if (row === undefined) return undefined;
  return {
    observationId: toText(row.observation_id, "observation_id"),
    attemptId: toText(row.attempt_id, "attempt_id"),
    operationId: toNullableText(row.operation_id, "operation_id"),
    kind: toText(row.kind, "kind"),
    recordedAt: toText(row.recorded_at, "recorded_at"),
    payload: parseJsonValue(toText(row.payload_json, "payload_json"), "payload_json"),
  };
}

export function readRunnerReconciliationTrace(
  db: StateDatabase,
  traceId: string,
): RunnerReconciliationTraceRow | undefined {
  const row = internalHandle(db)
    .prepare(`SELECT * FROM pipeline_runner_reconciliation_trace WHERE trace_id = ?`)
    .get(traceId);
  if (row === undefined) return undefined;
  return {
    traceId: toText(row.trace_id, "trace_id"),
    attemptId: toText(row.attempt_id, "attempt_id"),
    operationId: toNullableText(row.operation_id, "operation_id"),
    stageType: toText(row.stage_type, "stage_type") as "integration" | "publish",
    classification: toText(row.classification, "classification"),
    recordedAt: toText(row.recorded_at, "recorded_at"),
    detail: toNullableText(row.detail, "detail"),
    payload: parseOptionalObject<JsonValue>(
      toNullableText(row.payload_json, "payload_json"),
      "payload_json",
    ),
  };
}

export function listRunnerExternalObservations(
  db: StateDatabase,
  attemptId: string,
): readonly RunnerExternalObservationRow[] {
  return internalHandle(db)
    .prepare(
      `SELECT * FROM pipeline_runner_external_observation
        WHERE attempt_id = ?
        ORDER BY recorded_at, observation_id`,
    )
    .all(attemptId)
    .map((row) => ({
      observationId: toText(row.observation_id, "observation_id"),
      attemptId: toText(row.attempt_id, "attempt_id"),
      operationId: toNullableText(row.operation_id, "operation_id"),
      kind: toText(row.kind, "kind"),
      recordedAt: toText(row.recorded_at, "recorded_at"),
      payload: parseJsonValue(toText(row.payload_json, "payload_json"), "payload_json"),
    }));
}

export function listRunnerReconciliationTraces(
  db: StateDatabase,
  attemptId: string,
): readonly RunnerReconciliationTraceRow[] {
  return internalHandle(db)
    .prepare(
      `SELECT * FROM pipeline_runner_reconciliation_trace
        WHERE attempt_id = ?
        ORDER BY recorded_at, trace_id`,
    )
    .all(attemptId)
    .map((row) => ({
      traceId: toText(row.trace_id, "trace_id"),
      attemptId: toText(row.attempt_id, "attempt_id"),
      operationId: toNullableText(row.operation_id, "operation_id"),
      stageType: toText(row.stage_type, "stage_type") as "integration" | "publish",
      classification: toText(row.classification, "classification"),
      recordedAt: toText(row.recorded_at, "recorded_at"),
      detail: toNullableText(row.detail, "detail"),
      payload: parseOptionalObject<JsonValue>(
        toNullableText(row.payload_json, "payload_json"),
        "payload_json",
      ),
    }));
}

/**
 * Reconstruct the durable operation bundle for a restarting runner.
 */
export function reconstructRunnerOperation(
  db: StateDatabase,
  attemptId: string,
):
  | {
      readonly attempt: StageRunnerAttempt;
      readonly request: RunnerOperationRequestRow;
      readonly state: RunnerOperationStateRow;
      readonly answer: RunnerApprovalAnswerRow | undefined;
      readonly observations: readonly RunnerExternalObservationRow[];
      readonly traces: readonly RunnerReconciliationTraceRow[];
    }
  | undefined {
  const attempt = readRunnerAttempt(db, attemptId);
  if (attempt === undefined) return undefined;
  const request = readRunnerOperationRequestByAttempt(db, attemptId);
  if (request === undefined) return undefined;
  const state = readRunnerOperationState(db, request.operationId);
  if (state === undefined) {
    throw new StateStoreError(`operation state missing for ${request.operationId}`);
  }
  return {
    attempt,
    request,
    state,
    answer: readRunnerApprovalAnswer(db, request.operationId),
    observations: listRunnerExternalObservations(db, attemptId),
    traces: listRunnerReconciliationTraces(db, attemptId),
  };
}

function approvalRequestFromJson(value: JsonValue): Static<typeof ApprovalRequestV1> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StateStoreError("approval operation request_json must be an object");
  }
  return value as Static<typeof ApprovalRequestV1>;
}

/**
 * Pending approval operations waiting for an answer, shaped as InteractionV2
 * inbox items so the daemon can reuse the existing inbox surface.
 */
export function listPipelineApprovalInbox(db: StateDatabase): readonly PipelineApprovalInboxItem[] {
  const rows = internalHandle(db)
    .prepare(
      `SELECT r.operation_id, r.attempt_id, r.request_json, r.created_at,
              s.revision AS interaction_revision, s.updated_at,
              a.run_id, a.stage_id
         FROM pipeline_runner_operation_request r
         JOIN pipeline_runner_operation_state s ON s.operation_id = r.operation_id
         JOIN pipeline_runner_attempt a ON a.attempt_id = r.attempt_id
         LEFT JOIN pipeline_runner_approval_answer ans ON ans.operation_id = r.operation_id
        WHERE r.stage_type = 'approval'
          AND s.phase = 'waiting'
          AND ans.answer_id IS NULL
        ORDER BY r.created_at, r.operation_id`,
    )
    .all();
  return rows.map((row) => {
    const request = approvalRequestFromJson(
      parseJsonValue(toText(row.request_json, "request_json"), "request_json"),
    );
    const interactionId = request.continuation.interactionId;
    const interaction = {
      schemaVersion: 2 as const,
      interactionId,
      purpose: "approval" as const,
      status: "pending" as const,
      revision: toSafeInteger(row.interaction_revision, "interaction_revision"),
      questions: [
        {
          questionId: `${interactionId}:decision`,
          kind: "single_choice" as const,
          prompt: request.prompt,
          ...(request.header === undefined ? {} : { header: request.header }),
          options: request.options.map((option) => ({
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
        },
      ],
      requestedAt: request.requestedAt,
      ...(request.timeoutAt === undefined ? {} : { timeoutAt: request.timeoutAt }),
      deliveryState: "pending" as const,
    } as Static<typeof InteractionV2>;
    return {
      runId: toText(row.run_id, "run_id"),
      stageId: toText(row.stage_id, "stage_id"),
      attemptId: toText(row.attempt_id, "attempt_id"),
      operationId: toText(row.operation_id, "operation_id"),
      interactionRevision: toSafeInteger(row.interaction_revision, "interaction_revision"),
      interaction,
    };
  });
}
