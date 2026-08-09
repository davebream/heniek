/**
 * Durable recovery decision / stage recovery / canonical run state store (Q028).
 *
 * Append-only decisions and retry directives; mutable recovery counters and
 * revisioned canonical-run-state projection. Write helpers that take a raw
 * handle are safe inside an outer `BEGIN IMMEDIATE` (e.g. apply plan).
 */

import type { DatabaseSync } from "node:sqlite";
import { internalClock, internalHandle, type StateDatabase } from "../database/open.js";
import { toNullableText, toSafeInteger, toText } from "../database/pragma.js";
import { StateStoreError } from "../errors.js";
import { type JsonValue, parseJsonValue, stringifyCanonical } from "../json.js";

export interface PipelineRecoveryDecisionRow {
  readonly decisionId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly graphRevision: number;
  readonly generation: number;
  readonly attemptOrdinal: number;
  readonly action: string;
  readonly outcome: string;
  readonly decision: JsonValue;
  readonly recordedAt: string;
}

export interface PipelineStageRecoveryStateRow {
  readonly runId: string;
  readonly stageId: string;
  readonly generation: number;
  readonly repairsUsed: number;
  readonly lastSignatureDigest: string | null;
  readonly identicalSignatureCount: number;
  readonly pendingProposalId: string | null;
  readonly pendingProposal: JsonValue | null;
  readonly updatedAt: string;
}

export interface PipelineCanonicalRunStateRow {
  readonly runId: string;
  readonly state: JsonValue;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface PipelineRetryDirectiveRow {
  readonly attemptId: string;
  readonly recoveryDecisionId: string;
  readonly directive: JsonValue;
  readonly createdAt: string;
}

export interface InsertRecoveryDecisionInput {
  readonly decisionId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly graphRevision: number;
  readonly generation: number;
  readonly attemptOrdinal: number;
  readonly action: string;
  readonly outcome: string;
  readonly decision: JsonValue;
  readonly recordedAt: string;
}

export interface UpsertStageRecoveryStateInput {
  readonly runId: string;
  readonly stageId: string;
  readonly generation: number;
  readonly repairsUsed: number;
  readonly lastSignatureDigest?: string | null;
  readonly identicalSignatureCount: number;
  readonly pendingProposalId?: string | null;
  readonly pendingProposal?: JsonValue | null;
  readonly updatedAt: string;
}

export interface UpsertCanonicalRunStateInput {
  readonly runId: string;
  readonly state: JsonValue;
  readonly expectedRevision?: number;
  readonly now?: string;
}

export interface InsertRetryDirectiveInput {
  readonly attemptId: string;
  readonly recoveryDecisionId: string;
  readonly directive: JsonValue;
  readonly createdAt: string;
}

function transaction<T>(db: StateDatabase, operation: () => T): T {
  const handle = internalHandle(db);
  if (handle.isTransaction) {
    throw new StateStoreError("pipeline recovery operations cannot run inside another transaction");
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

function mapRecoveryDecision(row: Record<string, unknown>): PipelineRecoveryDecisionRow {
  return {
    decisionId: toText(row.decision_id, "row.decision_id"),
    runId: toText(row.run_id, "row.run_id"),
    stageId: toText(row.stage_id, "row.stage_id"),
    graphRevision: toSafeInteger(row.graph_revision, "row.graph_revision"),
    generation: toSafeInteger(row.generation, "row.generation"),
    attemptOrdinal: toSafeInteger(row.attempt_ordinal, "row.attempt_ordinal"),
    action: toText(row.action, "row.action"),
    outcome: toText(row.outcome, "row.outcome"),
    decision: parseJsonValue(toText(row.decision_json, "decision_json"), "decision_json"),
    recordedAt: toText(row.recorded_at, "row.recorded_at"),
  };
}

function mapStageRecoveryState(row: Record<string, unknown>): PipelineStageRecoveryStateRow {
  const pendingProposalJson = toNullableText(
    row.pending_proposal_json,
    "row.pending_proposal_json",
  );
  return {
    runId: toText(row.run_id, "row.run_id"),
    stageId: toText(row.stage_id, "row.stage_id"),
    generation: toSafeInteger(row.generation, "row.generation"),
    repairsUsed: toSafeInteger(row.repairs_used, "row.repairs_used"),
    lastSignatureDigest: toNullableText(row.last_signature_digest, "row.last_signature_digest"),
    identicalSignatureCount: toSafeInteger(
      row.identical_signature_count,
      "row.identical_signature_count",
    ),
    pendingProposalId: toNullableText(row.pending_proposal_id, "row.pending_proposal_id"),
    pendingProposal:
      pendingProposalJson === null
        ? null
        : parseJsonValue(pendingProposalJson, "pending_proposal_json"),
    updatedAt: toText(row.updated_at, "row.updated_at"),
  };
}

/** Insert (or ignore duplicate) a recovery decision row. Returns true if inserted. */
export function writeRecoveryDecision(
  handle: DatabaseSync,
  input: InsertRecoveryDecisionInput,
): boolean {
  try {
    handle
      .prepare(
        `INSERT INTO pipeline_recovery_decision
          (decision_id, run_id, stage_id, graph_revision, generation, attempt_ordinal,
           action, outcome, decision_json, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.decisionId,
        input.runId,
        input.stageId,
        input.graphRevision,
        input.generation,
        input.attemptOrdinal,
        input.action,
        input.outcome,
        stringifyCanonical(input.decision),
        input.recordedAt,
      );
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return false;
    }
    throw error;
  }
}

export function insertRecoveryDecision(
  db: StateDatabase,
  decision: InsertRecoveryDecisionInput,
): void {
  transaction(db, () => {
    writeRecoveryDecision(internalHandle(db), decision);
  });
}

export function listRecoveryDecisions(
  db: StateDatabase,
  runId: string,
): readonly PipelineRecoveryDecisionRow[] {
  const rows = internalHandle(db)
    .prepare(
      `SELECT decision_id, run_id, stage_id, graph_revision, generation, attempt_ordinal,
              action, outcome, decision_json, recorded_at
         FROM pipeline_recovery_decision
        WHERE run_id = ?
        ORDER BY recorded_at, decision_id`,
    )
    .all(runId);
  return rows.map((row) => mapRecoveryDecision(row as Record<string, unknown>));
}

/** Upsert mutable recovery counters for (run_id, stage_id, generation). */
export function writeStageRecoveryState(
  handle: DatabaseSync,
  input: UpsertStageRecoveryStateInput,
): void {
  const pendingProposalJson =
    input.pendingProposal === undefined || input.pendingProposal === null
      ? null
      : stringifyCanonical(input.pendingProposal);
  handle
    .prepare(
      `INSERT INTO pipeline_stage_recovery_state
        (run_id, stage_id, generation, repairs_used, last_signature_digest,
         identical_signature_count, pending_proposal_id, pending_proposal_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (run_id, stage_id, generation) DO UPDATE SET
         repairs_used = excluded.repairs_used,
         last_signature_digest = excluded.last_signature_digest,
         identical_signature_count = excluded.identical_signature_count,
         pending_proposal_id = excluded.pending_proposal_id,
         pending_proposal_json = excluded.pending_proposal_json,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.runId,
      input.stageId,
      input.generation,
      input.repairsUsed,
      input.lastSignatureDigest ?? null,
      input.identicalSignatureCount,
      input.pendingProposalId ?? null,
      pendingProposalJson,
      input.updatedAt,
    );
}

export function upsertStageRecoveryState(
  db: StateDatabase,
  state: UpsertStageRecoveryStateInput,
): void {
  transaction(db, () => {
    writeStageRecoveryState(internalHandle(db), state);
  });
}

export function readStageRecoveryState(
  db: StateDatabase,
  runId: string,
  stageId: string,
  generation: number,
): PipelineStageRecoveryStateRow | undefined {
  const row = internalHandle(db)
    .prepare(
      `SELECT run_id, stage_id, generation, repairs_used, last_signature_digest,
              identical_signature_count, pending_proposal_id, pending_proposal_json, updated_at
         FROM pipeline_stage_recovery_state
        WHERE run_id = ? AND stage_id = ? AND generation = ?`,
    )
    .get(runId, stageId, generation);
  if (row === undefined) {
    return undefined;
  }
  return mapStageRecoveryState(row as Record<string, unknown>);
}

export function listStageRecoveryStates(
  db: StateDatabase,
  runId: string,
): readonly PipelineStageRecoveryStateRow[] {
  const rows = internalHandle(db)
    .prepare(
      `SELECT run_id, stage_id, generation, repairs_used, last_signature_digest,
              identical_signature_count, pending_proposal_id, pending_proposal_json, updated_at
         FROM pipeline_stage_recovery_state
        WHERE run_id = ?
        ORDER BY stage_id, generation`,
    )
    .all(runId);
  return rows.map((row) => mapStageRecoveryState(row as Record<string, unknown>));
}

/**
 * Upsert canonical run state. On insert, revision is 1. On update, revision
 * advances by 1; when `expectedRevision` is set, the update is compare-and-swap.
 * Returns the new revision, or `undefined` on CAS conflict.
 */
export function writeCanonicalRunState(
  handle: DatabaseSync,
  input: UpsertCanonicalRunStateInput & { readonly now: string },
): number | undefined {
  const existing = handle
    .prepare(`SELECT revision FROM pipeline_canonical_run_state WHERE run_id = ?`)
    .get(input.runId);
  if (existing === undefined) {
    if (input.expectedRevision !== undefined && input.expectedRevision !== 0) {
      return undefined;
    }
    handle
      .prepare(
        `INSERT INTO pipeline_canonical_run_state (run_id, state_json, revision, updated_at)
         VALUES (?, ?, 1, ?)`,
      )
      .run(input.runId, stringifyCanonical(input.state), input.now);
    return 1;
  }
  const currentRevision = toSafeInteger(existing.revision, "pipeline_canonical_run_state.revision");
  if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
    return undefined;
  }
  const nextRevision = currentRevision + 1;
  handle
    .prepare(
      `UPDATE pipeline_canonical_run_state
          SET state_json = ?, revision = ?, updated_at = ?
        WHERE run_id = ? AND revision = ?`,
    )
    .run(stringifyCanonical(input.state), nextRevision, input.now, input.runId, currentRevision);
  const updated = handle
    .prepare(`SELECT revision FROM pipeline_canonical_run_state WHERE run_id = ?`)
    .get(input.runId);
  if (
    updated === undefined ||
    toSafeInteger(updated.revision, "pipeline_canonical_run_state.revision") !== nextRevision
  ) {
    return undefined;
  }
  return nextRevision;
}

export function upsertCanonicalRunState(
  db: StateDatabase,
  input: UpsertCanonicalRunStateInput,
): { readonly status: "applied" | "conflict"; readonly revision: number } {
  const now = input.now ?? internalClock(db).nowIso();
  return transaction(db, () => {
    const revision = writeCanonicalRunState(internalHandle(db), { ...input, now });
    if (revision === undefined) {
      const current = readCanonicalRunState(db, input.runId);
      return {
        status: "conflict" as const,
        revision: current?.revision ?? 0,
      };
    }
    return { status: "applied" as const, revision };
  });
}

export function readCanonicalRunState(
  db: StateDatabase,
  runId: string,
): PipelineCanonicalRunStateRow | undefined {
  const row = internalHandle(db)
    .prepare(
      `SELECT run_id, state_json, revision, updated_at
         FROM pipeline_canonical_run_state WHERE run_id = ?`,
    )
    .get(runId);
  if (row === undefined) {
    return undefined;
  }
  return {
    runId: toText(row.run_id, "row.run_id"),
    state: parseJsonValue(toText(row.state_json, "state_json"), "state_json"),
    revision: toSafeInteger(row.revision, "row.revision"),
    updatedAt: toText(row.updated_at, "row.updated_at"),
  };
}

/** Insert (or ignore duplicate) a retry directive. Returns true if inserted. */
export function writeRetryDirective(
  handle: DatabaseSync,
  input: InsertRetryDirectiveInput,
): boolean {
  try {
    handle
      .prepare(
        `INSERT INTO pipeline_retry_directive
          (attempt_id, recovery_decision_id, directive_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.attemptId,
        input.recoveryDecisionId,
        stringifyCanonical(input.directive),
        input.createdAt,
      );
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return false;
    }
    throw error;
  }
}

export function insertRetryDirective(db: StateDatabase, input: InsertRetryDirectiveInput): void {
  transaction(db, () => {
    writeRetryDirective(internalHandle(db), input);
  });
}

export function readRetryDirective(
  db: StateDatabase,
  attemptId: string,
): PipelineRetryDirectiveRow | undefined {
  const row = internalHandle(db)
    .prepare(
      `SELECT attempt_id, recovery_decision_id, directive_json, created_at
         FROM pipeline_retry_directive WHERE attempt_id = ?`,
    )
    .get(attemptId);
  if (row === undefined) {
    return undefined;
  }
  return {
    attemptId: toText(row.attempt_id, "row.attempt_id"),
    recoveryDecisionId: toText(row.recovery_decision_id, "row.recovery_decision_id"),
    directive: parseJsonValue(toText(row.directive_json, "directive_json"), "directive_json"),
    createdAt: toText(row.created_at, "row.created_at"),
  };
}

/**
 * Insert a recovery_approved or recovery_rejected observation so the next
 * scheduler tick can clear a pending proposal and dispatch (or fail).
 */
export function recordRecoveryApproval(
  db: StateDatabase,
  input: {
    readonly runId: string;
    readonly stageId: string;
    readonly proposalId: string;
    readonly approved: boolean;
    readonly now?: string;
    readonly observationId?: string;
  },
): { readonly observationId: string; readonly kind: "recovery_approved" | "recovery_rejected" } {
  const now = input.now ?? internalClock(db).nowIso();
  const kind = input.approved ? ("recovery_approved" as const) : ("recovery_rejected" as const);
  const observationId = input.observationId ?? `obs:recovery:${input.proposalId}:${kind}`;
  const pending = listStageRecoveryStates(db, input.runId).find(
    (row) => row.stageId === input.stageId && row.pendingProposalId === input.proposalId,
  );
  if (pending === undefined) {
    throw new StateStoreError(
      `no pending recovery proposal ${input.proposalId} for stage ${input.stageId}`,
    );
  }
  transaction(db, () => {
    const handle = internalHandle(db);
    try {
      handle
        .prepare(
          `INSERT INTO pipeline_scheduler_observation
             (observation_id, run_id, kind, payload_json, recorded_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          observationId,
          input.runId,
          kind,
          stringifyCanonical({
            stageId: input.stageId,
            proposalId: input.proposalId,
            approved: input.approved,
          }),
          now,
        );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  });
  return { observationId, kind };
}
