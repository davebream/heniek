/**
 * Durable pipeline stage-runner store (Q026, ADR 0024).
 *
 * Claims scheduler intents idempotently, persists attempt phase transitions
 * before external side effects, and atomically finalizes validated output by
 * binding artifacts, appending a scheduler observation, and settling the
 * intent in one transaction.
 */

import type {
  StageRunnerAttemptV1,
  StageRunnerCleanupReportV1,
  StageRunnerEvidenceV1,
  StageRunnerFailureV1,
  StageRunnerOutputBindingV1,
  StageRunnerResultV1,
  StageRunnerValidationReportV1,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { internalClock, internalHandle, type StateDatabase } from "../database/open.js";
import { toNullableText, toSafeInteger, toText } from "../database/pragma.js";
import { StateStoreError } from "../errors.js";
import { type JsonValue, parseJsonValue, stringifyCanonical } from "../json.js";
import type { PipelineSchedulerIntentRow } from "./store.js";

export type StageRunnerAttempt = Static<typeof StageRunnerAttemptV1>;
export type StageRunnerResult = Static<typeof StageRunnerResultV1>;
export type StageRunnerFailure = Static<typeof StageRunnerFailureV1>;
export type StageRunnerEvidence = Static<typeof StageRunnerEvidenceV1>;
export type StageRunnerOutputBinding = Static<typeof StageRunnerOutputBindingV1>;
export type StageRunnerCleanupReport = Static<typeof StageRunnerCleanupReportV1>;
export type StageRunnerValidationReport = Static<typeof StageRunnerValidationReportV1>;

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
  const deadlineAt = toNullableText(row.deadline_at, "deadline_at");
  const runtimeDirectory = toNullableText(row.runtime_directory, "runtime_directory");
  const preparedAt = toNullableText(row.prepared_at, "prepared_at");
  const startedAt = toNullableText(row.started_at, "started_at");
  const finishedAt = toNullableText(row.finished_at, "finished_at");

  const mapped = {
    schemaVersion: 1 as const,
    attemptId: toText(row.attempt_id, "attempt_id"),
    runId: toText(row.run_id, "run_id"),
    stageId: toText(row.stage_id, "stage_id"),
    stageType: toText(row.stage_type, "stage_type") as "agent" | "command",
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
  readonly stageType: "agent" | "command";
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
  if (input.stageType !== "agent" && input.stageType !== "command") {
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
           process_group_id, backend_execution_id, deadline_at, runtime_directory,
           prepared_at, started_at, finished_at, outputs_json, evidence_json,
           result_json, failure_json, cleanup_json, validation_json, recovery,
           revision, updated_at, created_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, 'prepare', NULL, NULL, NULL,
           NULL, NULL, ?, ?, NULL, NULL, NULL, '[]', '[]',
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
