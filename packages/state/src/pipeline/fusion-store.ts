/**
 * Durable segment / fusion / capsule / verification store (Q029).
 *
 * Append-only fusion decisions, capsules, pressure observations, and
 * verifications. Segments allow status updates; metrics are a mutable
 * per-run projection derived from those records.
 */

import type { DatabaseSync } from "node:sqlite";
import { internalClock, internalHandle, type StateDatabase } from "../database/open.js";
import { toNullableText, toSafeInteger, toText } from "../database/pragma.js";
import { StateStoreError } from "../errors.js";
import { type JsonValue, parseJsonValue, stringifyCanonical } from "../json.js";

export interface PipelineExecutionSegmentRow {
  readonly segmentId: string;
  readonly runId: string;
  readonly profileId: string;
  readonly profileFingerprint: string | null;
  readonly workspaceId: string | null;
  readonly leaseId: string | null;
  readonly backendExecutionId: string | null;
  readonly stageIds: JsonValue;
  readonly status: string;
  readonly softThreshold: number;
  readonly hardThreshold: number;
  readonly telemetryCursor: string | null;
  readonly capsuleId: string | null;
  readonly segment: JsonValue;
  readonly startedAt: string;
  readonly closedAt: string | null;
}

export interface PipelineFusionDecisionRow {
  readonly decisionId: string;
  readonly runId: string;
  readonly fromStageId: string;
  readonly toStageId: string;
  readonly fromAttemptId: string | null;
  readonly toAttemptId: string | null;
  readonly outcome: string;
  readonly splitReason: string | null;
  readonly segmentId: string | null;
  readonly decision: JsonValue;
  readonly recordedAt: string;
}

export interface PipelineContinuationCapsuleRow {
  readonly capsuleId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly attemptId: string;
  readonly segmentId: string;
  readonly segmentOrdinal: number;
  readonly digest: string;
  readonly narrativeDigest: string | null;
  readonly capsule: JsonValue;
  readonly narrativeText: string | null;
  readonly createdAt: string;
}

export interface PipelinePressureObservationRow {
  readonly observationId: string;
  readonly runId: string;
  readonly segmentId: string;
  readonly attemptId: string | null;
  readonly ratio: number | null;
  readonly confidence: string;
  readonly state: string;
  readonly softThreshold: number;
  readonly hardThreshold: number;
  readonly telemetryCursor: string | null;
  readonly action: string;
  readonly observation: JsonValue;
  readonly recordedAt: string;
}

export interface PipelineIncomingVerificationRow {
  readonly verificationId: string;
  readonly capsuleId: string;
  readonly runId: string;
  readonly segmentId: string | null;
  readonly verdict: string;
  readonly blockers: JsonValue;
  readonly verification: JsonValue;
  readonly recordedAt: string;
}

export interface PipelineSegmentMetricsRow {
  readonly runId: string;
  readonly sessionCount: number;
  readonly coldStartCount: number;
  readonly fusedStageCount: number;
  readonly smartContinuationCount: number;
  readonly updatedAt: string;
}

export interface InsertExecutionSegmentInput {
  readonly segmentId: string;
  readonly runId: string;
  readonly profileId: string;
  readonly profileFingerprint?: string | null;
  readonly workspaceId?: string | null;
  readonly leaseId?: string | null;
  readonly backendExecutionId?: string | null;
  readonly stageIds: JsonValue;
  readonly status: string;
  readonly softThreshold: number;
  readonly hardThreshold: number;
  readonly telemetryCursor?: string | null;
  readonly capsuleId?: string | null;
  readonly segment: JsonValue;
  readonly startedAt: string;
  readonly closedAt?: string | null;
}

export interface UpdateExecutionSegmentInput {
  readonly segmentId: string;
  readonly status?: string;
  readonly backendExecutionId?: string | null;
  readonly workspaceId?: string | null;
  readonly leaseId?: string | null;
  readonly stageIds?: JsonValue;
  readonly telemetryCursor?: string | null;
  readonly capsuleId?: string | null;
  readonly segment?: JsonValue;
  readonly closedAt?: string | null;
}

export interface InsertFusionDecisionInput {
  readonly decisionId: string;
  readonly runId: string;
  readonly fromStageId: string;
  readonly toStageId: string;
  readonly fromAttemptId?: string | null;
  readonly toAttemptId?: string | null;
  readonly outcome: string;
  readonly splitReason?: string | null;
  readonly segmentId?: string | null;
  readonly decision: JsonValue;
  readonly recordedAt: string;
}

export interface InsertContinuationCapsuleInput {
  readonly capsuleId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly attemptId: string;
  readonly segmentId: string;
  readonly segmentOrdinal: number;
  readonly digest: string;
  readonly narrativeDigest?: string | null;
  readonly capsule: JsonValue;
  readonly narrativeText?: string | null;
  readonly createdAt: string;
}

export interface InsertPressureObservationInput {
  readonly observationId: string;
  readonly runId: string;
  readonly segmentId: string;
  readonly attemptId?: string | null;
  readonly ratio?: number | null;
  readonly confidence: string;
  readonly state: string;
  readonly softThreshold: number;
  readonly hardThreshold: number;
  readonly telemetryCursor?: string | null;
  readonly action: string;
  readonly observation: JsonValue;
  readonly recordedAt: string;
}

export interface InsertIncomingVerificationInput {
  readonly verificationId: string;
  readonly capsuleId: string;
  readonly runId: string;
  readonly segmentId?: string | null;
  readonly verdict: string;
  readonly blockers: JsonValue;
  readonly verification: JsonValue;
  readonly recordedAt: string;
}

export interface UpsertSegmentMetricsInput {
  readonly runId: string;
  readonly sessionCount?: number;
  readonly coldStartCount?: number;
  readonly fusedStageCount?: number;
  readonly smartContinuationCount?: number;
  readonly updatedAt: string;
}

function transaction<T>(db: StateDatabase, operation: () => T): T {
  const handle = internalHandle(db);
  if (handle.isTransaction) {
    throw new StateStoreError("pipeline fusion operations cannot run inside another transaction");
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
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as { code?: string; errstr?: string; message?: string };
  const code = String(record.code ?? "");
  if (code.startsWith("SQLITE_CONSTRAINT")) {
    return true;
  }
  const detail = `${record.errstr ?? ""} ${record.message ?? ""}`.toLowerCase();
  return detail.includes("unique constraint") || detail.includes("constraint failed");
}

function toReal(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StateStoreError(`${label} must be a finite number`);
  }
  return value;
}

function mapSegment(row: Record<string, unknown>): PipelineExecutionSegmentRow {
  return {
    segmentId: toText(row.segment_id, "row.segment_id"),
    runId: toText(row.run_id, "row.run_id"),
    profileId: toText(row.profile_id, "row.profile_id"),
    profileFingerprint: toNullableText(row.profile_fingerprint, "row.profile_fingerprint"),
    workspaceId: toNullableText(row.workspace_id, "row.workspace_id"),
    leaseId: toNullableText(row.lease_id, "row.lease_id"),
    backendExecutionId: toNullableText(row.backend_execution_id, "row.backend_execution_id"),
    stageIds: parseJsonValue(toText(row.stage_ids_json, "stage_ids_json"), "stage_ids_json"),
    status: toText(row.status, "row.status"),
    softThreshold: toReal(row.soft_threshold, "row.soft_threshold"),
    hardThreshold: toReal(row.hard_threshold, "row.hard_threshold"),
    telemetryCursor: toNullableText(row.telemetry_cursor, "row.telemetry_cursor"),
    capsuleId: toNullableText(row.capsule_id, "row.capsule_id"),
    segment: parseJsonValue(toText(row.segment_json, "segment_json"), "segment_json"),
    startedAt: toText(row.started_at, "row.started_at"),
    closedAt: toNullableText(row.closed_at, "row.closed_at"),
  };
}

function mapFusionDecision(row: Record<string, unknown>): PipelineFusionDecisionRow {
  return {
    decisionId: toText(row.decision_id, "row.decision_id"),
    runId: toText(row.run_id, "row.run_id"),
    fromStageId: toText(row.from_stage_id, "row.from_stage_id"),
    toStageId: toText(row.to_stage_id, "row.to_stage_id"),
    fromAttemptId: toNullableText(row.from_attempt_id, "row.from_attempt_id"),
    toAttemptId: toNullableText(row.to_attempt_id, "row.to_attempt_id"),
    outcome: toText(row.outcome, "row.outcome"),
    splitReason: toNullableText(row.split_reason, "row.split_reason"),
    segmentId: toNullableText(row.segment_id, "row.segment_id"),
    decision: parseJsonValue(toText(row.decision_json, "decision_json"), "decision_json"),
    recordedAt: toText(row.recorded_at, "row.recorded_at"),
  };
}

function mapCapsule(row: Record<string, unknown>): PipelineContinuationCapsuleRow {
  return {
    capsuleId: toText(row.capsule_id, "row.capsule_id"),
    runId: toText(row.run_id, "row.run_id"),
    stageId: toText(row.stage_id, "row.stage_id"),
    attemptId: toText(row.attempt_id, "row.attempt_id"),
    segmentId: toText(row.segment_id, "row.segment_id"),
    segmentOrdinal: toSafeInteger(row.segment_ordinal, "row.segment_ordinal"),
    digest: toText(row.digest, "row.digest"),
    narrativeDigest: toNullableText(row.narrative_digest, "row.narrative_digest"),
    capsule: parseJsonValue(toText(row.capsule_json, "capsule_json"), "capsule_json"),
    narrativeText: toNullableText(row.narrative_text, "row.narrative_text"),
    createdAt: toText(row.created_at, "row.created_at"),
  };
}

function mapPressure(row: Record<string, unknown>): PipelinePressureObservationRow {
  const ratioRaw = row.ratio;
  return {
    observationId: toText(row.observation_id, "row.observation_id"),
    runId: toText(row.run_id, "row.run_id"),
    segmentId: toText(row.segment_id, "row.segment_id"),
    attemptId: toNullableText(row.attempt_id, "row.attempt_id"),
    ratio: ratioRaw === null || ratioRaw === undefined ? null : toReal(ratioRaw, "row.ratio"),
    confidence: toText(row.confidence, "row.confidence"),
    state: toText(row.state, "row.state"),
    softThreshold: toReal(row.soft_threshold, "row.soft_threshold"),
    hardThreshold: toReal(row.hard_threshold, "row.hard_threshold"),
    telemetryCursor: toNullableText(row.telemetry_cursor, "row.telemetry_cursor"),
    action: toText(row.action, "row.action"),
    observation: parseJsonValue(
      toText(row.observation_json, "observation_json"),
      "observation_json",
    ),
    recordedAt: toText(row.recorded_at, "row.recorded_at"),
  };
}

function mapVerification(row: Record<string, unknown>): PipelineIncomingVerificationRow {
  return {
    verificationId: toText(row.verification_id, "row.verification_id"),
    capsuleId: toText(row.capsule_id, "row.capsule_id"),
    runId: toText(row.run_id, "row.run_id"),
    segmentId: toNullableText(row.segment_id, "row.segment_id"),
    verdict: toText(row.verdict, "row.verdict"),
    blockers: parseJsonValue(toText(row.blockers_json, "blockers_json"), "blockers_json"),
    verification: parseJsonValue(
      toText(row.verification_json, "verification_json"),
      "verification_json",
    ),
    recordedAt: toText(row.recorded_at, "row.recorded_at"),
  };
}

function mapMetrics(row: Record<string, unknown>): PipelineSegmentMetricsRow {
  return {
    runId: toText(row.run_id, "row.run_id"),
    sessionCount: toSafeInteger(row.session_count, "row.session_count"),
    coldStartCount: toSafeInteger(row.cold_start_count, "row.cold_start_count"),
    fusedStageCount: toSafeInteger(row.fused_stage_count, "row.fused_stage_count"),
    smartContinuationCount: toSafeInteger(
      row.smart_continuation_count,
      "row.smart_continuation_count",
    ),
    updatedAt: toText(row.updated_at, "row.updated_at"),
  };
}

export function writeExecutionSegment(
  handle: DatabaseSync,
  input: InsertExecutionSegmentInput,
): boolean {
  try {
    handle
      .prepare(
        `INSERT INTO pipeline_execution_segment
          (segment_id, run_id, profile_id, profile_fingerprint, workspace_id, lease_id,
           backend_execution_id, stage_ids_json, status, soft_threshold, hard_threshold,
           telemetry_cursor, capsule_id, segment_json, started_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.segmentId,
        input.runId,
        input.profileId,
        input.profileFingerprint ?? null,
        input.workspaceId ?? null,
        input.leaseId ?? null,
        input.backendExecutionId ?? null,
        stringifyCanonical(input.stageIds),
        input.status,
        input.softThreshold,
        input.hardThreshold,
        input.telemetryCursor ?? null,
        input.capsuleId ?? null,
        stringifyCanonical(input.segment),
        input.startedAt,
        input.closedAt ?? null,
      );
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

export function updateExecutionSegment(
  handle: DatabaseSync,
  input: UpdateExecutionSegmentInput,
): void {
  const existing = handle
    .prepare("SELECT * FROM pipeline_execution_segment WHERE segment_id = ?")
    .get(input.segmentId) as Record<string, unknown> | undefined;
  if (existing === undefined) {
    throw new StateStoreError(`unknown pipeline execution segment ${input.segmentId}`);
  }
  handle
    .prepare(
      `UPDATE pipeline_execution_segment SET
         status = ?,
         backend_execution_id = ?,
         workspace_id = ?,
         lease_id = ?,
         stage_ids_json = ?,
         telemetry_cursor = ?,
         capsule_id = ?,
         segment_json = ?,
         closed_at = ?
       WHERE segment_id = ?`,
    )
    .run(
      input.status ?? toText(existing.status, "status"),
      input.backendExecutionId !== undefined
        ? (input.backendExecutionId as string | null)
        : ((existing.backend_execution_id as string | null | undefined) ?? null),
      input.workspaceId !== undefined
        ? (input.workspaceId as string | null)
        : ((existing.workspace_id as string | null | undefined) ?? null),
      input.leaseId !== undefined
        ? (input.leaseId as string | null)
        : ((existing.lease_id as string | null | undefined) ?? null),
      input.stageIds !== undefined
        ? stringifyCanonical(input.stageIds)
        : toText(existing.stage_ids_json, "stage_ids_json"),
      input.telemetryCursor !== undefined
        ? (input.telemetryCursor as string | null)
        : ((existing.telemetry_cursor as string | null | undefined) ?? null),
      input.capsuleId !== undefined
        ? (input.capsuleId as string | null)
        : ((existing.capsule_id as string | null | undefined) ?? null),
      input.segment !== undefined
        ? stringifyCanonical(input.segment)
        : toText(existing.segment_json, "segment_json"),
      input.closedAt !== undefined
        ? (input.closedAt as string | null)
        : ((existing.closed_at as string | null | undefined) ?? null),
      input.segmentId,
    );
}

export function writeFusionDecision(
  handle: DatabaseSync,
  input: InsertFusionDecisionInput,
): boolean {
  try {
    handle
      .prepare(
        `INSERT INTO pipeline_fusion_decision
          (decision_id, run_id, from_stage_id, to_stage_id, from_attempt_id, to_attempt_id,
           outcome, split_reason, segment_id, decision_json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.decisionId,
        input.runId,
        input.fromStageId,
        input.toStageId,
        input.fromAttemptId ?? null,
        input.toAttemptId ?? null,
        input.outcome,
        input.splitReason ?? null,
        input.segmentId ?? null,
        stringifyCanonical(input.decision),
        input.recordedAt,
      );
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

export function writeContinuationCapsule(
  handle: DatabaseSync,
  input: InsertContinuationCapsuleInput,
): boolean {
  try {
    handle
      .prepare(
        `INSERT INTO pipeline_continuation_capsule
          (capsule_id, run_id, stage_id, attempt_id, segment_id, segment_ordinal,
           digest, narrative_digest, capsule_json, narrative_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.capsuleId,
        input.runId,
        input.stageId,
        input.attemptId,
        input.segmentId,
        input.segmentOrdinal,
        input.digest,
        input.narrativeDigest ?? null,
        stringifyCanonical(input.capsule),
        input.narrativeText ?? null,
        input.createdAt,
      );
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

export function writePressureObservation(
  handle: DatabaseSync,
  input: InsertPressureObservationInput,
): boolean {
  try {
    handle
      .prepare(
        `INSERT INTO pipeline_pressure_observation
          (observation_id, run_id, segment_id, attempt_id, ratio, confidence, state,
           soft_threshold, hard_threshold, telemetry_cursor, action, observation_json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.observationId,
        input.runId,
        input.segmentId,
        input.attemptId ?? null,
        input.ratio ?? null,
        input.confidence,
        input.state,
        input.softThreshold,
        input.hardThreshold,
        input.telemetryCursor ?? null,
        input.action,
        stringifyCanonical(input.observation),
        input.recordedAt,
      );
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

export function writeIncomingVerification(
  handle: DatabaseSync,
  input: InsertIncomingVerificationInput,
): boolean {
  try {
    handle
      .prepare(
        `INSERT INTO pipeline_incoming_verification
          (verification_id, capsule_id, run_id, segment_id, verdict,
           blockers_json, verification_json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.verificationId,
        input.capsuleId,
        input.runId,
        input.segmentId ?? null,
        input.verdict,
        stringifyCanonical(input.blockers),
        stringifyCanonical(input.verification),
        input.recordedAt,
      );
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

export function upsertSegmentMetrics(handle: DatabaseSync, input: UpsertSegmentMetricsInput): void {
  const existing = handle
    .prepare("SELECT * FROM pipeline_segment_metrics WHERE run_id = ?")
    .get(input.runId) as Record<string, unknown> | undefined;
  if (existing === undefined) {
    handle
      .prepare(
        `INSERT INTO pipeline_segment_metrics
          (run_id, session_count, cold_start_count, fused_stage_count,
           smart_continuation_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.sessionCount ?? 0,
        input.coldStartCount ?? 0,
        input.fusedStageCount ?? 0,
        input.smartContinuationCount ?? 0,
        input.updatedAt,
      );
    return;
  }
  handle
    .prepare(
      `UPDATE pipeline_segment_metrics SET
         session_count = ?,
         cold_start_count = ?,
         fused_stage_count = ?,
         smart_continuation_count = ?,
         updated_at = ?
       WHERE run_id = ?`,
    )
    .run(
      input.sessionCount ?? toSafeInteger(existing.session_count, "session_count"),
      input.coldStartCount ?? toSafeInteger(existing.cold_start_count, "cold_start_count"),
      input.fusedStageCount ?? toSafeInteger(existing.fused_stage_count, "fused_stage_count"),
      input.smartContinuationCount ??
        toSafeInteger(existing.smart_continuation_count, "smart_continuation_count"),
      input.updatedAt,
      input.runId,
    );
}

export function insertExecutionSegment(
  db: StateDatabase,
  input: InsertExecutionSegmentInput,
): boolean {
  return transaction(db, () => writeExecutionSegment(internalHandle(db), input));
}

export function insertFusionDecision(db: StateDatabase, input: InsertFusionDecisionInput): boolean {
  return transaction(db, () => writeFusionDecision(internalHandle(db), input));
}

export function insertContinuationCapsule(
  db: StateDatabase,
  input: InsertContinuationCapsuleInput,
): boolean {
  return transaction(db, () => writeContinuationCapsule(internalHandle(db), input));
}

export function insertPressureObservation(
  db: StateDatabase,
  input: InsertPressureObservationInput,
): boolean {
  return transaction(db, () => writePressureObservation(internalHandle(db), input));
}

export function insertIncomingVerification(
  db: StateDatabase,
  input: InsertIncomingVerificationInput,
): boolean {
  return transaction(db, () => writeIncomingVerification(internalHandle(db), input));
}

export function patchExecutionSegment(db: StateDatabase, input: UpdateExecutionSegmentInput): void {
  transaction(db, () => updateExecutionSegment(internalHandle(db), input));
}

export function readExecutionSegment(
  db: StateDatabase,
  segmentId: string,
): PipelineExecutionSegmentRow | undefined {
  const row = internalHandle(db)
    .prepare("SELECT * FROM pipeline_execution_segment WHERE segment_id = ?")
    .get(segmentId) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : mapSegment(row);
}

export function listExecutionSegments(
  db: StateDatabase,
  runId: string,
): readonly PipelineExecutionSegmentRow[] {
  const rows = internalHandle(db)
    .prepare(
      `SELECT * FROM pipeline_execution_segment
       WHERE run_id = ?
       ORDER BY started_at ASC, segment_id ASC`,
    )
    .all(runId) as Record<string, unknown>[];
  return rows.map(mapSegment);
}

export function readOpenExecutionSegment(
  db: StateDatabase,
  runId: string,
): PipelineExecutionSegmentRow | undefined {
  const row = internalHandle(db)
    .prepare(
      `SELECT * FROM pipeline_execution_segment
       WHERE run_id = ? AND status = 'open'
       ORDER BY started_at DESC, segment_id DESC
       LIMIT 1`,
    )
    .get(runId) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : mapSegment(row);
}

export function listFusionDecisions(
  db: StateDatabase,
  runId: string,
): readonly PipelineFusionDecisionRow[] {
  const rows = internalHandle(db)
    .prepare(
      `SELECT * FROM pipeline_fusion_decision
       WHERE run_id = ?
       ORDER BY recorded_at ASC, decision_id ASC`,
    )
    .all(runId) as Record<string, unknown>[];
  return rows.map(mapFusionDecision);
}

export function readContinuationCapsule(
  db: StateDatabase,
  capsuleId: string,
): PipelineContinuationCapsuleRow | undefined {
  const row = internalHandle(db)
    .prepare("SELECT * FROM pipeline_continuation_capsule WHERE capsule_id = ?")
    .get(capsuleId) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : mapCapsule(row);
}

export function listContinuationCapsules(
  db: StateDatabase,
  runId: string,
): readonly PipelineContinuationCapsuleRow[] {
  const rows = internalHandle(db)
    .prepare(
      `SELECT * FROM pipeline_continuation_capsule
       WHERE run_id = ?
       ORDER BY created_at ASC, capsule_id ASC`,
    )
    .all(runId) as Record<string, unknown>[];
  return rows.map(mapCapsule);
}

export function listPressureObservations(
  db: StateDatabase,
  segmentId: string,
): readonly PipelinePressureObservationRow[] {
  const rows = internalHandle(db)
    .prepare(
      `SELECT * FROM pipeline_pressure_observation
       WHERE segment_id = ?
       ORDER BY recorded_at ASC, observation_id ASC`,
    )
    .all(segmentId) as Record<string, unknown>[];
  return rows.map(mapPressure);
}

export function listIncomingVerifications(
  db: StateDatabase,
  capsuleId: string,
): readonly PipelineIncomingVerificationRow[] {
  const rows = internalHandle(db)
    .prepare(
      `SELECT * FROM pipeline_incoming_verification
       WHERE capsule_id = ?
       ORDER BY recorded_at ASC, verification_id ASC`,
    )
    .all(capsuleId) as Record<string, unknown>[];
  return rows.map(mapVerification);
}

export function readSegmentMetrics(
  db: StateDatabase,
  runId: string,
): PipelineSegmentMetricsRow | undefined {
  const row = internalHandle(db)
    .prepare("SELECT * FROM pipeline_segment_metrics WHERE run_id = ?")
    .get(runId) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : mapMetrics(row);
}

/** Record a cold-start session open (new segment). */
export function recordColdStartSession(db: StateDatabase, runId: string, now?: string): void {
  transaction(db, () => {
    const handle = internalHandle(db);
    const updatedAt = now ?? internalClock(db).nowIso();
    const existing = handle
      .prepare("SELECT * FROM pipeline_segment_metrics WHERE run_id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    if (existing === undefined) {
      upsertSegmentMetrics(handle, {
        runId,
        sessionCount: 1,
        coldStartCount: 1,
        fusedStageCount: 0,
        smartContinuationCount: 0,
        updatedAt,
      });
      return;
    }
    upsertSegmentMetrics(handle, {
      runId,
      sessionCount: toSafeInteger(existing.session_count, "session_count") + 1,
      coldStartCount: toSafeInteger(existing.cold_start_count, "cold_start_count") + 1,
      fusedStageCount: toSafeInteger(existing.fused_stage_count, "fused_stage_count"),
      smartContinuationCount: toSafeInteger(
        existing.smart_continuation_count,
        "smart_continuation_count",
      ),
      updatedAt,
    });
  });
}

/** Record a fused successor stage joining an open segment. */
export function recordFusedStage(db: StateDatabase, runId: string, now?: string): void {
  transaction(db, () => {
    const handle = internalHandle(db);
    const updatedAt = now ?? internalClock(db).nowIso();
    const existing = handle
      .prepare("SELECT * FROM pipeline_segment_metrics WHERE run_id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    if (existing === undefined) {
      upsertSegmentMetrics(handle, {
        runId,
        sessionCount: 1,
        coldStartCount: 0,
        fusedStageCount: 1,
        smartContinuationCount: 0,
        updatedAt,
      });
      return;
    }
    upsertSegmentMetrics(handle, {
      runId,
      sessionCount: toSafeInteger(existing.session_count, "session_count"),
      coldStartCount: toSafeInteger(existing.cold_start_count, "cold_start_count"),
      fusedStageCount: toSafeInteger(existing.fused_stage_count, "fused_stage_count") + 1,
      smartContinuationCount: toSafeInteger(
        existing.smart_continuation_count,
        "smart_continuation_count",
      ),
      updatedAt,
    });
  });
}

/** Record a pressure-driven smart continuation handoff. */
export function recordSmartContinuation(db: StateDatabase, runId: string, now?: string): void {
  transaction(db, () => {
    const handle = internalHandle(db);
    const updatedAt = now ?? internalClock(db).nowIso();
    const existing = handle
      .prepare("SELECT * FROM pipeline_segment_metrics WHERE run_id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    if (existing === undefined) {
      upsertSegmentMetrics(handle, {
        runId,
        sessionCount: 1,
        coldStartCount: 1,
        fusedStageCount: 0,
        smartContinuationCount: 1,
        updatedAt,
      });
      return;
    }
    upsertSegmentMetrics(handle, {
      runId,
      sessionCount: toSafeInteger(existing.session_count, "session_count") + 1,
      coldStartCount: toSafeInteger(existing.cold_start_count, "cold_start_count") + 1,
      fusedStageCount: toSafeInteger(existing.fused_stage_count, "fused_stage_count"),
      smartContinuationCount:
        toSafeInteger(existing.smart_continuation_count, "smart_continuation_count") + 1,
      updatedAt,
    });
  });
}
