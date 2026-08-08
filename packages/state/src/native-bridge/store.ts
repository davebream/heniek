/**
 * The native Claude bridge store (Q023, ADR 0021).
 *
 * Mirrors two existing modules rather than inventing a third style:
 * `interaction/store.ts` for the "append one event, update one projection
 * row, all inside a hand-rolled `BEGIN IMMEDIATE`" pattern (this file uses
 * the same low-level `appendEvent`, never `commitStateChange`, so that a
 * `run.status_changed` transition can be atomic with the native table writes
 * that caused it — `commitStateChange` refuses to run inside a transaction
 * the caller already opened, which is exactly the nesting `interaction/store.ts`
 * avoids the same way); `scheduling/store.ts` for the lease/fencing/reap-on-read
 * shape (`expireOrphanLeases`, `renewAccountLease`).
 *
 * One exception to "everything happens in one transaction": a `succeeded`
 * submission cannot mark its run terminal here, because that transition
 * belongs to `completeStage` (`@heniek/state`'s own `artifact/complete-stage.ts`),
 * which internally opens *its own* top-level transaction via
 * `commitStateChangeInternal` — nesting it inside this file's transaction
 * would throw the same "cannot start a transaction within a transaction"
 * error `scheduling/store.ts` guards against. `settleNativeDispatch` marks
 * the dispatch `submitted` and stops there for a `succeeded` outcome; the
 * caller (the native bridge service, `@heniek/daemon`, which alone may import
 * `finalizeStageArtifact`) publishes the artifact and completes the run in a
 * second, separate call, then reports back here via
 * `completeNativeAttemptArtifactOutcome` or `downgradeNativeAttemptToFailed`.
 * This mirrors the *already-shipped* non-atomicity in `scheduling-service.ts`'s
 * `finishTerminal`, which marks `execution_attempt.status` only after — not
 * atomically with — `completeStage` runs; it is not a new gap this file
 * introduces.
 *
 * The fencing tuple every mutating call CASes is
 * `{sessionId, sessionRevision, dispatchId, expectedDispatchRevision, runId,
 * stageId, attemptId}` (question/submit calls) or the leading pair alone
 * (session-only calls: poll, detach). Every mutation to `native_dispatch`
 * bumps its revision by exactly one, not only on rebind — a stricter, simpler
 * invariant than "only rebind bumps revision" that closes more races and
 * needs no special-casing to reason about.
 */

import type {
  ExecutionFailureV1,
  InteractionAnswerSubmissionV2,
  InteractionV2,
  PendingInteractionV2,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { commitStateChange } from "../command/commit.js";
import {
  internalClock,
  internalHandle,
  internalIds,
  type StateDatabase,
} from "../database/open.js";
import { toNullableText, toSafeInteger, toText } from "../database/pragma.js";
import {
  CausalityViolationError,
  StateDatabaseCorruptionError,
  StateStoreError,
} from "../errors.js";
import { canonicalizeBackendInteraction, validateAnswer } from "../interaction/store.js";
import { appendEvent } from "../journal/append.js";
import { asCorrelationId } from "../journal/brand.js";
import type { StateEvent } from "../journal/event.js";
import { type JsonValue, stringifyCanonical } from "../json.js";

type Interaction = Static<typeof InteractionV2>;
type AnswerSubmission = Static<typeof InteractionAnswerSubmissionV2>;
type BackendInteraction = Static<typeof PendingInteractionV2>;
type Failure = Static<typeof ExecutionFailureV1>;

export type NativeBridgeRejectionCode =
  | "session_not_attached"
  | "session_expired"
  | "stale_session_revision"
  | "unknown_dispatch"
  | "stale_dispatch_revision"
  | "dispatch_revoked"
  | "dispatch_already_settled"
  | "idempotency_key_reuse"
  | "run_terminal"
  | "artifact_missing"
  | "result_contract_violation"
  | "workspace_mutated";

/**
 * A witness a caller *claims* for the process behind a parent session.
 * Nothing today populates one on the wire (no plugin exists yet — Q050
 * builds it), so every real classifier currently receives `null` and, per
 * `WitnessClassifier`'s own contract, must answer `"unknown"` — which is the
 * fail-closed default §18.2 asks for, not a placeholder to be embarrassed
 * about.
 */
export interface ProcessWitness {
  readonly kind: "process" | "process-group";
  readonly value: number;
}

/**
 * Supplied by the caller (the daemon-side native bridge service), never
 * computed here — this package has no process/OS primitives (design C10;
 * `no-ambient-sources.test.ts`), and liveness is exactly the kind of ambient
 * fact that must be injected. `"alive"` MUST NOT expire the session's open
 * dispatches (CR6); `"dead"` and `"unknown"` both route to
 * `recovery_required`, differing only in the recorded reason.
 */
export type WitnessClassifier = (
  bootWitness: string | null,
  witness: ProcessWitness | null,
) => "alive" | "dead" | "unknown";

const SESSION_LEASE_TTL_MS = 90_000;
const DISPATCH_TTL_MS = 90_000;

function assertIso(value: string, what: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new StateStoreError(`${what} is not a valid ISO timestamp`);
  return parsed;
}

function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(assertIso(value, "clock value") + milliseconds).toISOString();
}

function transaction<T>(db: StateDatabase, operation: () => T): T {
  const handle = internalHandle(db);
  if (handle.isTransaction) {
    throw new StateStoreError("native bridge operations cannot run inside another transaction");
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

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new StateDatabaseCorruptionError(`${label} is malformed`, { cause: error });
  }
}

function appendNativeEvent(
  db: StateDatabase,
  input: {
    readonly runId: string;
    readonly type: string;
    readonly payload: JsonValue;
    readonly recordedAt: string;
  },
): StateEvent {
  return appendEvent(db, {
    runId: input.runId,
    type: input.type,
    payload: input.payload,
    correlationId: asCorrelationId(internalIds(db).next("cor")),
    causationEventId: null,
    recordedAt: input.recordedAt,
  });
}

/** Mirrors `interaction/store.ts`'s `advanceRunRevision`, and additionally sets `status`. */
function advanceRunStatus(
  db: StateDatabase,
  event: StateEvent,
  status: string,
  expectedRevision?: number,
): number {
  const where = expectedRevision === undefined ? "run_id = ?" : "run_id = ? AND revision = ?";
  const values =
    expectedRevision === undefined
      ? [status, event.sequence, event.recordedAt, event.runId]
      : [status, event.sequence, event.recordedAt, event.runId, expectedRevision];
  const report = internalHandle(db)
    .prepare(
      `UPDATE run_projection
          SET status = ?, revision = revision + 1, last_event_sequence = ?, updated_at = ?
        WHERE ${where}`,
    )
    .run(...values);
  if (toSafeInteger(report.changes, "run projection changes") !== 1) {
    throw new CausalityViolationError(
      expectedRevision === undefined
        ? `native bridge event references missing run: ${event.runId}`
        : `run revision is stale: expected ${expectedRevision}`,
    );
  }
  const row = internalHandle(db)
    .prepare("SELECT revision FROM run_projection WHERE run_id = ?")
    .get(event.runId);
  if (row === undefined) throw new StateDatabaseCorruptionError("run projection disappeared");
  return toSafeInteger(row.revision, "run_projection.revision");
}

/** Mirrors `interaction/store.ts`'s own `advanceRunRevision` exactly: bumps revision, leaves `status` untouched. */
function advanceRunRevisionOnly(db: StateDatabase, event: StateEvent): number {
  const report = internalHandle(db)
    .prepare(
      `UPDATE run_projection SET revision = revision + 1, last_event_sequence = ?, updated_at = ?
        WHERE run_id = ?`,
    )
    .run(event.sequence, event.recordedAt, event.runId);
  if (toSafeInteger(report.changes, "run projection changes") !== 1) {
    throw new CausalityViolationError(`native bridge event references missing run: ${event.runId}`);
  }
  const row = internalHandle(db)
    .prepare("SELECT revision FROM run_projection WHERE run_id = ?")
    .get(event.runId);
  if (row === undefined) throw new StateDatabaseCorruptionError("run projection disappeared");
  return toSafeInteger(row.revision, "run_projection.revision");
}

/**
 * Cancels one pending native question, mirroring `interaction/store.ts`'s
 * `cancelInteraction` exactly: one `native_question.cancelled` event per
 * question, bumping run revision only (never `status` — that is a separate,
 * single `run.status_changed` event the caller emits once for the whole
 * stage-level transition that triggered this, not once per question).
 */
function cancelNativeQuestion(
  db: StateDatabase,
  handle: ReturnType<typeof internalHandle>,
  runId: string,
  interactionId: string,
  reason: "withdrawn" | "timed_out" | "run_terminal" | "migration_unresolved",
  now: string,
): void {
  const row = handle
    .prepare(
      `SELECT state, revision FROM native_question_projection WHERE run_id = ? AND interaction_id = ?`,
    )
    .get(runId, interactionId);
  if (row === undefined || toText(row.state, "native_question_projection.state") !== "pending")
    return;
  const event = appendNativeEvent(db, {
    runId,
    type: "native_question.cancelled",
    payload: { interactionId, reason },
    recordedAt: now,
  });
  advanceRunRevisionOnly(db, event);
  const changed = handle
    .prepare(
      `UPDATE native_question_projection
          SET state = 'cancelled', revision = revision + 1, delivery_state = 'not_applicable',
              cancellation_reason = ?, resolved_at = ?, last_event_sequence = ?, updated_at = ?
        WHERE run_id = ? AND interaction_id = ? AND state = 'pending' AND revision = ?`,
    )
    .run(
      reason,
      now,
      event.sequence,
      now,
      runId,
      interactionId,
      toSafeInteger(row.revision, "native_question_projection.revision"),
    );
  if (toSafeInteger(changed.changes, "native question cancellation changes") !== 1) {
    throw new CausalityViolationError(
      `native question changed during cancellation: ${interactionId}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Reap-on-read (CR5, CR6)
// ---------------------------------------------------------------------------

interface OpenDispatchRow {
  readonly dispatchId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly attemptId: string;
}

function abandonDispatchAndRecover(
  db: StateDatabase,
  handle: ReturnType<typeof internalHandle>,
  dispatch: OpenDispatchRow,
  terminalReason: string,
  reasonCode: string,
  now: string,
): void {
  const changed = handle
    .prepare(
      `UPDATE native_dispatch
          SET state = 'abandoned', terminal_reason = ?, settled_at = ?,
              revision = revision + 1, updated_at = ?
        WHERE dispatch_id = ? AND state IN ('dispatched','waiting_on_user')`,
    )
    .run(terminalReason, now, now, dispatch.dispatchId);
  if (toSafeInteger(changed.changes, "dispatch abandon changes") !== 1) return;
  handle
    .prepare(
      `UPDATE native_stage_attempt
          SET status = 'recovery_required', updated_at = ?
        WHERE attempt_id = ? AND status IN ('running','waiting_on_user')`,
    )
    .run(now, dispatch.attemptId);
  const pendingQuestion = handle
    .prepare(`SELECT interaction_id FROM native_stage_question WHERE dispatch_id = ?`)
    .get(dispatch.dispatchId);
  if (pendingQuestion !== undefined) {
    cancelNativeQuestion(
      db,
      handle,
      dispatch.runId,
      toText(pendingQuestion.interaction_id, "native_stage_question.interaction_id"),
      "withdrawn",
      now,
    );
  }
  const event = appendNativeEvent(db, {
    runId: dispatch.runId,
    type: "run.status_changed",
    payload: { runId: dispatch.runId, status: "recovery_required", reasonCode },
    recordedAt: now,
  });
  const stageChanged = handle
    .prepare(
      `UPDATE native_stage
          SET state = 'recovery_required', revision = revision + 1, updated_at = ?
        WHERE run_id = ? AND state IN ('dispatched','waiting_on_user')`,
    )
    .run(now, dispatch.runId);
  if (toSafeInteger(stageChanged.changes, "stage recovery changes") === 1) {
    advanceRunStatus(db, event, "recovery_required");
  }
}

/**
 * The single reap-on-read sweep, run inline at the top of every mutating
 * bridge transaction (CR5) — never on a separate timer that could race the
 * call it is meant to protect. Two independent conditions are swept:
 *
 * 1. A session past its lease `expires_at` — classified via `witnessOf`.
 *    `"alive"` marks it `stalled` and touches nothing else (CR6's core: a
 *    parent mid-tool-call must not have its work expired out from under it).
 *    `"dead"`/`"unknown"` expire the session and abandon every dispatch it
 *    still holds open, recording *which* verdict caused it.
 * 2. Any open dispatch whose session is no longer `attached`/`stalled` —
 *    catches a dispatch a rebind did not list in `resumeDispatchIds`,
 *    orphaned by a session that is now `superseded`/`detached`/`expired`
 *    without this sweep ever having touched that particular session row.
 *
 * Scoped to one `codebaseId`: every mutating call already knows its own
 * codebase, and a bridge session never spans two.
 */
function reapExpirations(
  db: StateDatabase,
  codebaseId: string | undefined,
  now: string,
  witnessOf: WitnessClassifier,
): void {
  const handle = internalHandle(db);
  const expiredSessions = handle
    .prepare(
      `SELECT session_id, state, boot_witness, process_witness_json
         FROM parent_session
        WHERE (? IS NULL OR codebase_id = ?) AND state IN ('attached','stalled') AND expires_at <= ?`,
    )
    .all(codebaseId ?? null, codebaseId ?? null, now);
  for (const row of expiredSessions) {
    const sessionId = toText(row.session_id, "parent_session.session_id");
    const sessionState = toText(row.state, "parent_session.state");
    const bootWitness = toNullableText(row.boot_witness, "parent_session.boot_witness");
    const witnessJson = toNullableText(
      row.process_witness_json,
      "parent_session.process_witness_json",
    );
    const witness =
      witnessJson === null ? null : (parseJson(witnessJson, "process witness") as ProcessWitness);
    const verdict = witnessOf(bootWitness, witness);
    if (verdict === "alive") {
      // No revision bump here, deliberately — session revision is a
      // fencing token for REBIND (CR7), never for liveness classification.
      // Nothing dispatch-fencing-relevant depends on it moving when a third
      // party discovers this session is merely late, not gone: CR1's actual
      // guarantee is entirely dispatch-level (an abandoned dispatch is
      // terminal and one-shot, full stop) and does not touch this branch at
      // all. Bumping here would invalidate the session's own in-flight
      // fencing tuple through no fault of its own — including, worst of
      // all, its own next self-poll discovering itself in this very sweep.
      if (sessionState === "attached") {
        handle
          .prepare(
            `UPDATE parent_session SET state = 'stalled', updated_at = ?
              WHERE session_id = ? AND state = 'attached'`,
          )
          .run(now, sessionId);
      }
      continue;
    }
    handle
      .prepare(
        `UPDATE parent_session
            SET state = 'expired', released_at = ?, revision = revision + 1, updated_at = ?
          WHERE session_id = ? AND state IN ('attached','stalled')`,
      )
      .run(now, now, sessionId);
    const openDispatches = handle
      .prepare(
        `SELECT dispatch_id, run_id, stage_id, attempt_id
           FROM native_dispatch
          WHERE session_id = ? AND state IN ('dispatched','waiting_on_user')`,
      )
      .all(sessionId)
      .map((raw) => ({
        dispatchId: toText(raw.dispatch_id, "native_dispatch.dispatch_id"),
        runId: toText(raw.run_id, "native_dispatch.run_id"),
        stageId: toText(raw.stage_id, "native_dispatch.stage_id"),
        attemptId: toText(raw.attempt_id, "native_dispatch.attempt_id"),
      }));
    for (const dispatch of openDispatches) {
      abandonDispatchAndRecover(
        db,
        handle,
        dispatch,
        verdict === "dead" ? "session_expired_dead" : "session_expired_unknown",
        verdict === "dead" ? "session_liveness_dead" : "session_liveness_unknown",
        now,
      );
    }
  }

  const orphaned = handle
    .prepare(
      `SELECT d.dispatch_id, d.run_id, d.stage_id, d.attempt_id
         FROM native_dispatch d
         JOIN parent_session s ON s.session_id = d.session_id
        WHERE (? IS NULL OR s.codebase_id = ?) AND d.state IN ('dispatched','waiting_on_user')
          AND s.state NOT IN ('attached','stalled')`,
    )
    .all(codebaseId ?? null, codebaseId ?? null)
    .map((raw) => ({
      dispatchId: toText(raw.dispatch_id, "native_dispatch.dispatch_id"),
      runId: toText(raw.run_id, "native_dispatch.run_id"),
      stageId: toText(raw.stage_id, "native_dispatch.stage_id"),
      attemptId: toText(raw.attempt_id, "native_dispatch.attempt_id"),
    }));
  for (const dispatch of orphaned) {
    abandonDispatchAndRecover(
      db,
      handle,
      dispatch,
      "session_superseded",
      "session_superseded",
      now,
    );
  }
}

/**
 * The background timer's only sanctioned entry point (CR5: "a background
 * timer may nudge, but must call the same store function — never a second
 * implementation"). Every mutating call above already reaps inline for its
 * own codebase; this exists only so a codebase whose plugin never
 * reconnects is not left with a stale, unreaped session forever. Same
 * function, `codebaseId` omitted — not a parallel sweep implementation.
 */
export function reapAllExpiredParentSessions(
  db: StateDatabase,
  witnessOf: WitnessClassifier,
): void {
  transaction(db, () => {
    reapExpirations(db, undefined, internalClock(db).nowIso(), witnessOf);
  });
}

// ---------------------------------------------------------------------------
// Native stage creation
// ---------------------------------------------------------------------------

export interface CreateNativeStageInput {
  readonly runId: string;
  readonly stageId: string;
  readonly codebaseId: string;
  readonly repositoryId: string;
  readonly profileId: string;
  readonly profile: JsonValue;
  readonly permissions: JsonValue;
  readonly limits: JsonValue;
  readonly prompt: string;
  readonly artifactPath: string;
  readonly instructionsPath: string;
  readonly artifactContract: string;
  readonly model: string;
  readonly effort: string;
  readonly focus?: string;
  readonly questions: "parent-mediated" | "direct";
  readonly baseSha: string;
  readonly hardDeadlineAt?: string;
}

export interface NativeStageSnapshot {
  readonly runId: string;
  readonly stageId: string;
  readonly codebaseId: string;
  readonly state: string;
  readonly currentAttemptId: string | null;
  readonly attemptCount: number;
  readonly revision: number;
  readonly waitingSince: string | null;
  readonly runRevision: number;
}

function readNativeStageRow(db: StateDatabase, runId: string): Record<string, unknown> | undefined {
  return internalHandle(db)
    .prepare(
      `SELECT n.run_id, n.stage_id, n.codebase_id, n.repository_id, n.profile_id,
              n.state, n.current_attempt_id, n.attempt_count, n.revision, n.waiting_since,
              n.artifact_path, n.instructions_path, n.artifact_contract, n.model, n.effort,
              n.focus, n.questions, n.permissions_json, n.limits_json, n.prompt,
              r.revision AS run_revision
         FROM native_stage n JOIN run_projection r ON r.run_id = n.run_id
        WHERE n.run_id = ?`,
    )
    .get(runId);
}

function toNativeStageSnapshot(raw: Record<string, unknown>): NativeStageSnapshot {
  return {
    runId: toText(raw.run_id, "native_stage.run_id"),
    stageId: toText(raw.stage_id, "native_stage.stage_id"),
    codebaseId: toText(raw.codebase_id, "native_stage.codebase_id"),
    state: toText(raw.state, "native_stage.state"),
    currentAttemptId: toNullableText(raw.current_attempt_id, "native_stage.current_attempt_id"),
    attemptCount: toSafeInteger(raw.attempt_count, "native_stage.attempt_count"),
    revision: toSafeInteger(raw.revision, "native_stage.revision"),
    waitingSince: toNullableText(raw.waiting_since, "native_stage.waiting_since"),
    runRevision: toSafeInteger(raw.run_revision, "run_projection.revision"),
  };
}

export function readNativeStage(db: StateDatabase, runId: string): NativeStageSnapshot | undefined {
  const raw = readNativeStageRow(db, runId);
  return raw === undefined ? undefined : toNativeStageSnapshot(raw);
}

/**
 * Creates the run (its own top-level `commitStateChange` call — the only
 * path in this package permitted to touch `run_projection`'s identity
 * columns) and then, in a second, separate transaction, both inserts the
 * `native_stage` row and moves the run straight to
 * `waiting_for_parent_session` — never through `queued` first. `queued` is
 * meaningful for the scheduled path (waiting on account capacity); a native
 * stage has no such resource, so the honest initial state is "nobody is
 * connected yet," which is `waiting_for_parent_session` from the first
 * instant the stage exists.
 *
 * Deliberately mirrors `SchedulingExecutionService.start`'s own two-step,
 * non-atomic shape (`commitStateChange('run.created')` followed by a
 * separate `createExecutionSchedule` call) rather than trying to fuse them —
 * the same accepted precedent, not a new gap.
 */
export function createNativeStage(
  db: StateDatabase,
  input: CreateNativeStageInput,
): NativeStageSnapshot {
  commitStateChange(db, {
    runId: input.runId,
    type: "run.created",
    payload: { runId: input.runId, codebaseId: input.codebaseId },
  });
  return transaction(db, () => {
    const handle = internalHandle(db);
    const now = internalClock(db).nowIso();
    const event = appendNativeEvent(db, {
      runId: input.runId,
      type: "run.status_changed",
      payload: { runId: input.runId, status: "waiting_for_parent_session" },
      recordedAt: now,
    });
    const runRevision = advanceRunStatus(db, event, "waiting_for_parent_session");
    handle
      .prepare(
        `INSERT INTO native_stage
          (run_id, stage_id, codebase_id, repository_id, profile_id, profile_json,
           permissions_json, limits_json, prompt, artifact_path, instructions_path,
           artifact_contract, model, effort, focus, questions, base_sha, hard_deadline_at,
           state, current_attempt_id, attempt_count, revision, waiting_since, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 'waiting_for_parent', NULL, 0, 1, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.stageId,
        input.codebaseId,
        input.repositoryId,
        input.profileId,
        stringifyCanonical(input.profile),
        stringifyCanonical(input.permissions),
        stringifyCanonical(input.limits),
        input.prompt,
        input.artifactPath,
        input.instructionsPath,
        input.artifactContract,
        input.model,
        input.effort,
        input.focus ?? null,
        input.questions,
        input.baseSha,
        input.hardDeadlineAt ?? null,
        now,
        now,
        now,
      );
    const snapshot = readNativeStageRow(db, input.runId);
    if (snapshot === undefined) throw new StateDatabaseCorruptionError("native stage disappeared");
    return { ...toNativeStageSnapshot(snapshot), runRevision };
  });
}

// ---------------------------------------------------------------------------
// Parent session attach / detach
// ---------------------------------------------------------------------------

export interface AttachParentSessionInput {
  readonly codebaseId: string;
  readonly previousSessionId?: string;
  readonly previousSessionRevision?: number;
  readonly resumeDispatchIds?: readonly string[];
  readonly leaseTtlMs?: number;
  readonly witnessOf: WitnessClassifier;
}

export type AttachParentSessionOutcome =
  | {
      readonly accepted: true;
      readonly sessionId: string;
      readonly sessionRevision: number;
      readonly attachedAt: string;
      readonly expiresAt: string;
      readonly leaseTtlMs: number;
      readonly resumedDispatchIds: readonly string[];
      readonly supersededSessionId: string | null;
    }
  | { readonly accepted: false; readonly rejectionCode: NativeBridgeRejectionCode };

export function attachParentSession(
  db: StateDatabase,
  input: AttachParentSessionInput,
): AttachParentSessionOutcome {
  const ttl = input.leaseTtlMs ?? SESSION_LEASE_TTL_MS;
  return transaction(db, () => {
    const handle = internalHandle(db);
    const now = internalClock(db).nowIso();
    reapExpirations(db, input.codebaseId, now, input.witnessOf);

    let supersededSessionId: string | null = null;
    const resumed: string[] = [];
    const resumeIds = new Set(input.resumeDispatchIds ?? []);

    if (input.previousSessionId !== undefined) {
      const previous = handle
        .prepare(
          `SELECT session_id, revision, state FROM parent_session
            WHERE session_id = ? AND codebase_id = ?`,
        )
        .get(input.previousSessionId, input.codebaseId);
      const previousRevision = toSafeInteger(previous?.revision, "parent_session.revision");
      const previousState =
        previous === undefined ? undefined : toText(previous.state, "parent_session.state");
      const revisionMatches =
        previous !== undefined && previousRevision === input.previousSessionRevision;
      const stateIsLive = previousState === "attached" || previousState === "stalled";
      if (previous === undefined || !revisionMatches || !stateIsLive) {
        return { accepted: false, rejectionCode: "stale_session_revision" };
      }
      handle
        .prepare(
          `UPDATE parent_session SET state = 'superseded', released_at = ?,
              revision = revision + 1, updated_at = ? WHERE session_id = ?`,
        )
        .run(now, now, input.previousSessionId);
      supersededSessionId = input.previousSessionId;

      if (resumeIds.size > 0) {
        const openDispatches = handle
          .prepare(
            `SELECT dispatch_id FROM native_dispatch
              WHERE session_id = ? AND state IN ('dispatched','waiting_on_user')`,
          )
          .all(input.previousSessionId)
          .map((raw) => toText(raw.dispatch_id, "native_dispatch.dispatch_id"));
        for (const dispatchId of openDispatches) {
          if (!resumeIds.has(dispatchId)) continue;
          resumed.push(dispatchId);
        }
      }
    }

    const sessionId = internalIds(db).next("session");
    const expiresAt = addMilliseconds(now, ttl);
    handle
      .prepare(
        `INSERT INTO parent_session
          (session_id, codebase_id, state, revision, boot_witness, process_witness_json,
           attached_at, renewed_at, expires_at, released_at, superseded_by, updated_at)
         VALUES (?, ?, 'attached', 1, NULL, NULL, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(sessionId, input.codebaseId, now, now, expiresAt, now);

    if (supersededSessionId !== null) {
      handle
        .prepare("UPDATE parent_session SET superseded_by = ? WHERE session_id = ?")
        .run(sessionId, supersededSessionId);
    }

    for (const dispatchId of resumed) {
      handle
        .prepare(
          `UPDATE native_dispatch SET session_id = ?, revision = revision + 1, updated_at = ?
            WHERE dispatch_id = ? AND state IN ('dispatched','waiting_on_user')`,
        )
        .run(sessionId, now, dispatchId);
    }

    return {
      accepted: true,
      sessionId,
      sessionRevision: 1,
      attachedAt: now,
      expiresAt,
      leaseTtlMs: ttl,
      resumedDispatchIds: resumed,
      supersededSessionId,
    };
  });
}

export interface DetachDispatchOutcome {
  readonly dispatchId: string;
  readonly disposition: "redispatchable" | "recovery_required";
}

export interface DetachParentSessionInput {
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly dispatches: readonly {
    readonly dispatchId: string;
    readonly outcome: "not_started" | "abandoned";
  }[];
  readonly witnessOf: WitnessClassifier;
}

export type DetachParentSessionOutcome =
  | { readonly accepted: true; readonly released: readonly DetachDispatchOutcome[] }
  | { readonly accepted: false; readonly rejectionCode: NativeBridgeRejectionCode };

/**
 * CR8: "never started" is a hint, not authority. The only corroboration a
 * pure store function can perform is DB-checkable — has a question ever been
 * raised on this dispatch, i.e. has the native subagent observably done
 * anything? A dispatch that reached `waiting_on_user` proves work happened
 * and is routed to `recovery_required` regardless of what the client
 * claims. A fuller corroboration (was anything staged in the worktree) needs
 * filesystem access this package does not have; the native bridge service is
 * free to layer that check before calling this.
 */
export function detachParentSession(
  db: StateDatabase,
  input: DetachParentSessionInput,
): DetachParentSessionOutcome {
  return transaction(db, () => {
    const handle = internalHandle(db);
    const session = handle
      .prepare(`SELECT codebase_id, revision, state FROM parent_session WHERE session_id = ?`)
      .get(input.sessionId);
    if (session === undefined) return { accepted: false, rejectionCode: "session_not_attached" };
    const codebaseId = toText(session.codebase_id, "parent_session.codebase_id");
    const now = internalClock(db).nowIso();
    reapExpirations(db, codebaseId, now, input.witnessOf);

    const current = handle
      .prepare(`SELECT revision, state FROM parent_session WHERE session_id = ?`)
      .get(input.sessionId);
    if (current === undefined) return { accepted: false, rejectionCode: "session_not_attached" };
    const currentState = toText(current.state, "parent_session.state");
    const currentRevision = toSafeInteger(current.revision, "parent_session.revision");
    if (currentState !== "attached" && currentState !== "stalled") {
      return { accepted: false, rejectionCode: "session_expired" };
    }
    if (currentRevision !== input.sessionRevision) {
      return { accepted: false, rejectionCode: "stale_session_revision" };
    }

    const released: DetachDispatchOutcome[] = [];
    for (const entry of input.dispatches) {
      const dispatch = handle
        .prepare(
          `SELECT run_id, stage_id, attempt_id, state FROM native_dispatch
            WHERE dispatch_id = ? AND session_id = ?`,
        )
        .get(entry.dispatchId, input.sessionId);
      if (dispatch === undefined) continue;
      const dispatchState = toText(dispatch.state, "native_dispatch.state");
      if (dispatchState !== "dispatched" && dispatchState !== "waiting_on_user") continue;
      const runId = toText(dispatch.run_id, "native_dispatch.run_id");
      const stageId = toText(dispatch.stage_id, "native_dispatch.stage_id");
      const attemptId = toText(dispatch.attempt_id, "native_dispatch.attempt_id");

      const workEvidence = handle
        .prepare(`SELECT 1 AS present FROM native_stage_question WHERE dispatch_id = ? LIMIT 1`)
        .get(entry.dispatchId);
      const corroborated = entry.outcome === "not_started" && workEvidence === undefined;

      if (corroborated) {
        handle
          .prepare(
            `UPDATE native_dispatch SET state = 'abandoned', terminal_reason = 'parent_detached',
                settled_at = ?, revision = revision + 1, updated_at = ? WHERE dispatch_id = ?`,
          )
          .run(now, now, entry.dispatchId);
        handle
          .prepare(
            `UPDATE native_stage_attempt SET status = 'cancelled', finished_at = ?, updated_at = ?
              WHERE attempt_id = ?`,
          )
          .run(now, now, attemptId);
        const event = appendNativeEvent(db, {
          runId,
          type: "run.status_changed",
          payload: { runId, status: "waiting_for_parent_session" },
          recordedAt: now,
        });
        handle
          .prepare(
            `UPDATE native_stage SET state = 'waiting_for_parent', current_attempt_id = NULL,
                revision = revision + 1, waiting_since = ?, updated_at = ? WHERE run_id = ?`,
          )
          .run(now, now, runId);
        advanceRunStatus(db, event, "waiting_for_parent_session");
        released.push({ dispatchId: entry.dispatchId, disposition: "redispatchable" });
      } else {
        abandonDispatchAndRecover(
          db,
          handle,
          { dispatchId: entry.dispatchId, runId, stageId, attemptId },
          "parent_detach_uncorroborated",
          "parent_detach_uncorroborated",
          now,
        );
        released.push({ dispatchId: entry.dispatchId, disposition: "recovery_required" });
      }
    }

    handle
      .prepare(
        `UPDATE parent_session SET state = 'detached', released_at = ?,
            revision = revision + 1, updated_at = ? WHERE session_id = ?`,
      )
      .run(now, now, input.sessionId);

    return { accepted: true, released };
  });
}

// ---------------------------------------------------------------------------
// Poll: renew + claim + resumes + revocations, all one snapshot (D6)
// ---------------------------------------------------------------------------

export interface ClaimedNativeStage {
  readonly dispatchId: string;
  readonly dispatchRevision: number;
  readonly runId: string;
  readonly stageId: string;
  readonly attemptId: string;
  readonly attemptOrdinal: number;
  readonly profileId: string;
  readonly prompt: string;
  readonly artifactPath: string;
  readonly instructionsPath: string;
  readonly artifactContract: string;
  readonly model: string;
  readonly effort: string;
  readonly focus: string | null;
  readonly questions: "parent-mediated" | "direct";
  readonly permissionsJson: string;
  readonly limitsJson: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly hardDeadlineAt: string | null;
}

export interface PollResumeEntry {
  readonly dispatchId: string;
  readonly dispatchRevision: number;
  readonly interactionId: string;
  readonly interactionRevision: number;
  readonly answerJson: string;
}

export interface PollRevocationEntry {
  readonly dispatchId: string;
  readonly dispatchRevision: number;
  readonly terminalReason: string;
}

export interface PollNativeBridgeInput {
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly codebaseId: string;
  readonly maxDispatches: number;
  readonly leaseTtlMs?: number;
  readonly dispatchTtlMs?: number;
  readonly witnessOf: WitnessClassifier;
}

export type PollNativeBridgeOutcome =
  | {
      readonly accepted: true;
      readonly sessionRevision: number;
      readonly expiresAt: string;
      readonly claimed: readonly ClaimedNativeStage[];
      readonly resumes: readonly PollResumeEntry[];
      readonly revocations: readonly PollRevocationEntry[];
    }
  | { readonly accepted: false; readonly rejectionCode: NativeBridgeRejectionCode };

/**
 * The entire read side (D6), one transaction: renews the session lease,
 * claims up to `maxDispatches` newly-dispatchable stages, collects answers
 * delivered since the session's previous poll, and collects revocations
 * settled since then too. "Since the previous poll" is derived from the
 * session's own `renewed_at` — captured before it is overwritten by this
 * call — rather than a dedicated acknowledgement column, so no schema beyond
 * migration 11 is needed for it.
 *
 * Claimed stages do not yet have a `workingDirectory` — workspace
 * provisioning is filesystem/git work the native bridge service performs
 * afterward, exactly as `SchedulingExecutionService.provisionAndStart` does
 * for the scheduled path; a provisioning failure is reported back through
 * `recordNativeAttemptWorkspaceFailure`.
 */
export function pollNativeBridge(
  db: StateDatabase,
  input: PollNativeBridgeInput,
): PollNativeBridgeOutcome {
  const leaseTtl = input.leaseTtlMs ?? SESSION_LEASE_TTL_MS;
  const dispatchTtl = input.dispatchTtlMs ?? DISPATCH_TTL_MS;
  return transaction(db, () => {
    const handle = internalHandle(db);
    const now = internalClock(db).nowIso();
    reapExpirations(db, input.codebaseId, now, input.witnessOf);

    const session = handle
      .prepare(
        `SELECT revision, state, renewed_at FROM parent_session
          WHERE session_id = ? AND codebase_id = ?`,
      )
      .get(input.sessionId, input.codebaseId);
    if (session === undefined) return { accepted: false, rejectionCode: "session_not_attached" };
    const sessionState = toText(session.state, "parent_session.state");
    const sessionRevision = toSafeInteger(session.revision, "parent_session.revision");
    if (sessionState !== "attached" && sessionState !== "stalled") {
      return { accepted: false, rejectionCode: "session_expired" };
    }
    if (sessionRevision !== input.sessionRevision) {
      return { accepted: false, rejectionCode: "stale_session_revision" };
    }
    const sinceRenewedAt = toText(session.renewed_at, "parent_session.renewed_at");

    const expiresAt = addMilliseconds(now, leaseTtl);
    const nextSessionRevision = sessionRevision + 1;
    handle
      .prepare(
        `UPDATE parent_session
            SET state = 'attached', renewed_at = ?, expires_at = ?, revision = ?, updated_at = ?
          WHERE session_id = ?`,
      )
      .run(now, expiresAt, nextSessionRevision, now, input.sessionId);

    const claimable = handle
      .prepare(
        `SELECT run_id, stage_id, profile_id, prompt, artifact_path, instructions_path,
                artifact_contract, model, effort, focus, questions, permissions_json,
                limits_json, hard_deadline_at, attempt_count
           FROM native_stage
          WHERE codebase_id = ? AND state = 'waiting_for_parent'
          ORDER BY created_at, run_id
          LIMIT ?`,
      )
      .all(input.codebaseId, Math.max(0, input.maxDispatches));

    const claimed: ClaimedNativeStage[] = [];
    for (const row of claimable) {
      const runId = toText(row.run_id, "native_stage.run_id");
      const stageId = toText(row.stage_id, "native_stage.stage_id");
      const attemptOrdinal = toSafeInteger(row.attempt_count, "native_stage.attempt_count") + 1;
      const attemptId = internalIds(db).next("nattempt");
      const dispatchId = internalIds(db).next("ndispatch");
      const dispatchExpiresAt = addMilliseconds(now, dispatchTtl);

      const claim = handle
        .prepare(
          `UPDATE native_stage
              SET state = 'dispatched', current_attempt_id = ?, attempt_count = ?,
                  revision = revision + 1, waiting_since = NULL, updated_at = ?
            WHERE run_id = ? AND state = 'waiting_for_parent'`,
        )
        .run(attemptId, attemptOrdinal, now, runId);
      if (toSafeInteger(claim.changes, "native stage claim changes") !== 1) continue;

      handle
        .prepare(
          `INSERT INTO native_stage_attempt
            (attempt_id, run_id, stage_id, attempt_ordinal, workspace_id, readonly_baseline_json,
             status, result_json, failure_json, started_at, finished_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, NULL, 'running', NULL, NULL, ?, NULL, ?, ?)`,
        )
        .run(attemptId, runId, stageId, attemptOrdinal, now, now, now);
      handle
        .prepare(
          `INSERT INTO native_dispatch
            (dispatch_id, run_id, stage_id, attempt_id, session_id, state, revision,
             terminal_reason, outcome, submission_id, submission_digest, result_json,
             issued_at, expires_at, settled_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'dispatched', 1, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, ?)`,
        )
        .run(dispatchId, runId, stageId, attemptId, input.sessionId, now, dispatchExpiresAt, now);

      const event = appendNativeEvent(db, {
        runId,
        type: "run.status_changed",
        payload: { runId, status: "running" },
        recordedAt: now,
      });
      advanceRunStatus(db, event, "running");

      claimed.push({
        dispatchId,
        dispatchRevision: 1,
        runId,
        stageId,
        attemptId,
        attemptOrdinal,
        profileId: toText(row.profile_id, "native_stage.profile_id"),
        prompt: toText(row.prompt, "native_stage.prompt"),
        artifactPath: toText(row.artifact_path, "native_stage.artifact_path"),
        instructionsPath: toText(row.instructions_path, "native_stage.instructions_path"),
        artifactContract: toText(row.artifact_contract, "native_stage.artifact_contract"),
        model: toText(row.model, "native_stage.model"),
        effort: toText(row.effort, "native_stage.effort"),
        focus: toNullableText(row.focus, "native_stage.focus"),
        questions: toText(row.questions, "native_stage.questions") as "parent-mediated" | "direct",
        permissionsJson: toText(row.permissions_json, "native_stage.permissions_json"),
        limitsJson: toText(row.limits_json, "native_stage.limits_json"),
        issuedAt: now,
        expiresAt: dispatchExpiresAt,
        hardDeadlineAt: toNullableText(row.hard_deadline_at, "native_stage.hard_deadline_at"),
      });
    }

    const dueResumes = handle
      .prepare(
        `SELECT q.run_id, q.dispatch_id, d.revision AS dispatch_revision, q.interaction_id,
                p.revision AS interaction_revision, p.answer_json
           FROM native_question_projection p
           JOIN native_stage_question q
             ON q.run_id = p.run_id AND q.interaction_id = p.interaction_id
           JOIN native_dispatch d ON d.dispatch_id = q.dispatch_id
          WHERE d.session_id = ? AND p.state = 'answered' AND p.delivery_state = 'pending'`,
      )
      .all(input.sessionId);
    const resumes: PollResumeEntry[] = [];
    for (const row of dueResumes) {
      const runId = toText(row.run_id, "native_stage_question.run_id");
      const interactionId = toText(row.interaction_id, "native_question_projection.interaction_id");
      // See native-bridge/replay.ts's header: the projection's own causal
      // -update trigger requires a real journal event behind every update.
      const delivered = appendNativeEvent(db, {
        runId,
        type: "native_question.delivered",
        payload: { interactionId },
        recordedAt: now,
      });
      advanceRunRevisionOnly(db, delivered);
      handle
        .prepare(
          `UPDATE native_question_projection
              SET delivery_state = 'delivered', revision = revision + 1,
                  last_event_sequence = ?, updated_at = ?
            WHERE run_id = ? AND interaction_id = ? AND delivery_state = 'pending'`,
        )
        .run(delivered.sequence, now, runId, interactionId);
      resumes.push({
        dispatchId: toText(row.dispatch_id, "native_stage_question.dispatch_id"),
        dispatchRevision: toSafeInteger(row.dispatch_revision, "native_dispatch.revision"),
        interactionId,
        interactionRevision: toSafeInteger(
          row.interaction_revision,
          "native_question_projection.revision",
        ),
        answerJson: toText(row.answer_json, "native_question_projection.answer_json"),
      });
    }

    const revoked = handle
      .prepare(
        `SELECT dispatch_id, revision, terminal_reason FROM native_dispatch
          WHERE session_id = ? AND state IN ('revoked','abandoned') AND settled_at > ?`,
      )
      .all(input.sessionId, sinceRenewedAt);
    const revocations: PollRevocationEntry[] = revoked.map((row) => ({
      dispatchId: toText(row.dispatch_id, "native_dispatch.dispatch_id"),
      dispatchRevision: toSafeInteger(row.revision, "native_dispatch.revision"),
      terminalReason: toText(row.terminal_reason, "native_dispatch.terminal_reason"),
    }));

    return {
      accepted: true,
      sessionRevision: nextSessionRevision,
      expiresAt,
      claimed,
      resumes,
      revocations,
    };
  });
}

export function assignNativeAttemptWorkspace(
  db: StateDatabase,
  input: { readonly attemptId: string; readonly workspaceId: string },
): void {
  const now = internalClock(db).nowIso();
  const report = internalHandle(db)
    .prepare(
      `UPDATE native_stage_attempt SET workspace_id = ?, updated_at = ?
        WHERE attempt_id = ? AND workspace_id IS NULL`,
    )
    .run(input.workspaceId, now, input.attemptId);
  if (toSafeInteger(report.changes, "attempt workspace changes") !== 1) {
    throw new StateStoreError(
      `attempt already has a workspace or does not exist: ${input.attemptId}`,
    );
  }
}

export function recordNativeAttemptReadonlyBaseline(
  db: StateDatabase,
  input: { readonly attemptId: string; readonly baseline: JsonValue },
): void {
  internalHandle(db)
    .prepare(
      `UPDATE native_stage_attempt SET readonly_baseline_json = ?, updated_at = ?
        WHERE attempt_id = ?`,
    )
    .run(stringifyCanonical(input.baseline), internalClock(db).nowIso(), input.attemptId);
}

/**
 * Workspace provisioning failed after a claim. Redispatchable, not a
 * terminal run failure — a git/filesystem hiccup should be retried, not
 * treated as if the stage itself were broken. Mirrors
 * `SchedulingExecutionService.provisionAndStart`'s own failure handling,
 * except native has no fallback candidate to fall through to, so "retry"
 * means "return to `waiting_for_parent`" rather than "try the next profile".
 */
export function recordNativeAttemptWorkspaceFailure(
  db: StateDatabase,
  input: {
    readonly attemptId: string;
    readonly runId: string;
    readonly stageId: string;
    readonly dispatchId: string;
    readonly reasonCode: string;
  },
): void {
  transaction(db, () => {
    const handle = internalHandle(db);
    const now = internalClock(db).nowIso();
    handle
      .prepare(
        `UPDATE native_stage_attempt SET status = 'failed', finished_at = ?,
            failure_json = ?, updated_at = ? WHERE attempt_id = ?`,
      )
      .run(
        now,
        stringifyCanonical({
          schemaVersion: 1,
          classification: "workspace_failed",
          phase: "start",
          code: input.reasonCode,
          message: "Managed workspace provisioning failed for a native dispatch.",
          fallbackEligible: false,
        } satisfies Failure as unknown as JsonValue),
        now,
        input.attemptId,
      );
    handle
      .prepare(
        `UPDATE native_dispatch SET state = 'abandoned', terminal_reason = 'workspace_failed',
            settled_at = ?, revision = revision + 1, updated_at = ? WHERE dispatch_id = ?`,
      )
      .run(now, now, input.dispatchId);
    const event = appendNativeEvent(db, {
      runId: input.runId,
      type: "run.status_changed",
      payload: { runId: input.runId, status: "waiting_for_parent_session" },
      recordedAt: now,
    });
    handle
      .prepare(
        `UPDATE native_stage SET state = 'waiting_for_parent', current_attempt_id = NULL,
            revision = revision + 1, waiting_since = ?, updated_at = ? WHERE run_id = ?`,
      )
      .run(now, now, input.runId);
    advanceRunStatus(db, event, "waiting_for_parent_session");
  });
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export type RaiseNativeQuestionOutcome =
  | {
      readonly accepted: true;
      readonly interactionId: string;
      readonly interactionRevision: number;
      readonly dispatchRevision: number;
      readonly status: "waiting_on_user";
    }
  | { readonly accepted: false; readonly rejectionCode: NativeBridgeRejectionCode };

export interface RaiseNativeQuestionInput {
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly dispatchId: string;
  readonly expectedDispatchRevision: number;
  readonly runId: string;
  readonly stageId: string;
  readonly attemptId: string;
  readonly interaction: BackendInteraction;
  readonly witnessOf: WitnessClassifier;
}

/**
 * Resolves the codebase to reap-sweep from the *session*, never from the
 * caller-supplied `runId`/`stageId`/`attemptId` — those are exactly the
 * fields a fencing mismatch test deliberately sends wrong, and a lookup
 * keyed on them would throw before the fence check ever gets a chance to
 * produce its typed rejection. A session that does not exist yields no
 * codebase to sweep; `validateDispatchFence` reports that precisely.
 */
function codebaseForSession(
  handle: ReturnType<typeof internalHandle>,
  sessionId: string,
): string | undefined {
  const row = handle
    .prepare(`SELECT codebase_id FROM parent_session WHERE session_id = ?`)
    .get(sessionId);
  return row === undefined ? undefined : toText(row.codebase_id, "parent_session.codebase_id");
}

function validateDispatchFence(
  handle: ReturnType<typeof internalHandle>,
  input: {
    readonly sessionId: string;
    readonly sessionRevision: number;
    readonly dispatchId: string;
    readonly expectedDispatchRevision: number;
    readonly runId: string;
    readonly stageId: string;
    readonly attemptId: string;
  },
  /**
   * `settleNativeDispatch` alone needs to reach an already-`submitted`
   * dispatch: that is exactly the idempotent-replay/conflict case D4 asks
   * for, and it is judged by `submissionId`/digest, not by
   * `expectedDispatchRevision` — a resubmit legitimately carries the
   * *pre*-settlement revision, which would otherwise always read as stale.
   * Every other caller keeps the blunt "already settled" rejection.
   */
  allowSettled = false,
):
  | { readonly ok: true; readonly dispatchState: string }
  | { readonly ok: false; readonly rejectionCode: NativeBridgeRejectionCode } {
  const session = handle
    .prepare(`SELECT revision, state FROM parent_session WHERE session_id = ?`)
    .get(input.sessionId);
  if (session === undefined) return { ok: false, rejectionCode: "session_not_attached" };
  const sessionState = toText(session.state, "parent_session.state");
  if (sessionState !== "attached" && sessionState !== "stalled") {
    return { ok: false, rejectionCode: "session_expired" };
  }
  if (toSafeInteger(session.revision, "parent_session.revision") !== input.sessionRevision) {
    return { ok: false, rejectionCode: "stale_session_revision" };
  }
  const dispatch = handle
    .prepare(
      `SELECT run_id, stage_id, attempt_id, session_id, revision, state FROM native_dispatch
        WHERE dispatch_id = ?`,
    )
    .get(input.dispatchId);
  if (dispatch === undefined) return { ok: false, rejectionCode: "unknown_dispatch" };
  if (
    toText(dispatch.session_id, "native_dispatch.session_id") !== input.sessionId ||
    toText(dispatch.run_id, "native_dispatch.run_id") !== input.runId ||
    toText(dispatch.stage_id, "native_dispatch.stage_id") !== input.stageId ||
    toText(dispatch.attempt_id, "native_dispatch.attempt_id") !== input.attemptId
  ) {
    // Existence and ownership collapse into one code (D5): a distinguishable
    // "wrong session" vs "no such dispatch" would let any credential holder
    // enumerate another session's dispatches.
    return { ok: false, rejectionCode: "unknown_dispatch" };
  }
  const dispatchState = toText(dispatch.state, "native_dispatch.state");
  if (dispatchState === "revoked" || dispatchState === "abandoned") {
    return { ok: false, rejectionCode: "dispatch_revoked" };
  }
  if (dispatchState === "submitted") {
    if (!allowSettled) return { ok: false, rejectionCode: "dispatch_already_settled" };
    return { ok: true, dispatchState };
  }
  if (
    toSafeInteger(dispatch.revision, "native_dispatch.revision") !== input.expectedDispatchRevision
  ) {
    return { ok: false, rejectionCode: "stale_dispatch_revision" };
  }
  return { ok: true, dispatchState };
}

export function raiseNativeQuestion(
  db: StateDatabase,
  input: RaiseNativeQuestionInput,
): RaiseNativeQuestionOutcome {
  return transaction(db, () => {
    const handle = internalHandle(db);
    const now = internalClock(db).nowIso();
    const codebaseId = codebaseForSession(handle, input.sessionId);
    if (codebaseId !== undefined) reapExpirations(db, codebaseId, now, input.witnessOf);
    const fence = validateDispatchFence(handle, input);
    if (!fence.ok) return { accepted: false, rejectionCode: fence.rejectionCode };

    const dispatchState = toText(
      handle
        .prepare(`SELECT state FROM native_dispatch WHERE dispatch_id = ?`)
        .get(input.dispatchId)?.state,
      "native_dispatch.state",
    );
    if (dispatchState !== "dispatched") {
      return { accepted: false, rejectionCode: "unknown_dispatch" };
    }

    const existing = handle
      .prepare(
        `SELECT interaction_id FROM native_stage_question WHERE run_id = ? AND interaction_id = ?`,
      )
      .get(input.runId, input.interaction.id);
    if (existing !== undefined) {
      throw new StateStoreError(`native question is immutable: ${input.interaction.id}`);
    }

    const canonical = canonicalizeBackendInteraction(input.interaction, "question");
    // The event must exist before either table is written: both carry a
    // `last_event_sequence`/`created_event_id` column with a real foreign
    // key into `state_event`, and `state_event.sequence` does not exist
    // until `appendNativeEvent` commits its own insert.
    const event = appendNativeEvent(db, {
      runId: input.runId,
      type: "native_question.raised",
      payload: {
        interactionId: input.interaction.id,
        stageId: input.stageId,
        dispatchId: input.dispatchId,
        attemptId: input.attemptId,
        interaction: canonical as unknown as JsonValue,
      },
      recordedAt: now,
    });
    handle
      .prepare(
        `INSERT INTO native_stage_question
          (run_id, interaction_id, stage_id, attempt_id, dispatch_id, source_payload_json,
           canonical_payload_json, requested_at, timeout_at, created_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.interaction.id,
        input.stageId,
        input.attemptId,
        input.dispatchId,
        stringifyCanonical(input.interaction as unknown as JsonValue),
        stringifyCanonical(canonical as unknown as JsonValue),
        canonical.requestedAt,
        canonical.timeoutAt ?? null,
        event.eventId,
      );
    handle
      .prepare(
        `INSERT INTO native_question_projection
          (run_id, interaction_id, state, revision, delivery_state, cancellation_reason,
           answer_json, answered_by_key_id, answered_at, resolved_at, last_event_sequence, updated_at)
         VALUES (?, ?, 'pending', 1, 'not_applicable', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(input.runId, input.interaction.id, event.sequence, now);

    const dispatchUpdate = handle
      .prepare(
        `UPDATE native_dispatch SET state = 'waiting_on_user', revision = revision + 1, updated_at = ?
          WHERE dispatch_id = ? AND revision = ?`,
      )
      .run(now, input.dispatchId, input.expectedDispatchRevision);
    if (toSafeInteger(dispatchUpdate.changes, "dispatch question changes") !== 1) {
      throw new CausalityViolationError(
        `dispatch changed during question raise: ${input.dispatchId}`,
      );
    }
    handle
      .prepare(
        `UPDATE native_stage SET state = 'waiting_on_user', revision = revision + 1, updated_at = ?
          WHERE run_id = ?`,
      )
      .run(now, input.runId);
    advanceRunStatus(db, event, "waiting_on_user");

    return {
      accepted: true,
      interactionId: input.interaction.id,
      interactionRevision: 1,
      dispatchRevision: input.expectedDispatchRevision + 1,
      status: "waiting_on_user",
    };
  });
}

export interface AnswerNativeQuestionInput {
  readonly runId: string;
  readonly submission: AnswerSubmission;
  readonly answeredByKeyId: string;
}

export interface AnswerNativeQuestionOutcome {
  readonly runRevision: number;
  readonly status: string;
  readonly interactionRevision: number;
}

/**
 * The one path both `ProfileQuestionMode` values reach: in `parent-mediated`
 * mode the parent — itself an authenticated local client — calls this after
 * asking the user; in `direct` mode a TUI/CLI calls it instead. Neither
 * carries a session/dispatch fencing tuple, matching `acceptInteractionAnswer`'s
 * own shape: answering is authenticated by the caller's local credential and
 * CASed by interaction revision, not by which bridge session is attached.
 */
export function answerNativeQuestion(
  db: StateDatabase,
  input: AnswerNativeQuestionInput,
): AnswerNativeQuestionOutcome {
  if (input.answeredByKeyId.length === 0) {
    throw new StateStoreError("authenticated key id is required");
  }
  return transaction(db, () => {
    const handle = internalHandle(db);
    const stage = handle
      .prepare(`SELECT state FROM native_stage WHERE run_id = ?`)
      .get(input.runId);
    if (stage === undefined)
      throw new StateStoreError(`native stage does not exist: ${input.runId}`);

    const row = handle
      .prepare(
        `SELECT q.canonical_payload_json, q.dispatch_id, p.state, p.revision
           FROM native_stage_question q
           JOIN native_question_projection p
             ON p.run_id = q.run_id AND p.interaction_id = q.interaction_id
          WHERE q.run_id = ? AND q.interaction_id = ?`,
      )
      .get(input.runId, input.submission.interactionId);
    if (row === undefined) {
      throw new StateStoreError(
        `interaction does not belong to run: ${input.submission.interactionId}`,
      );
    }
    const questionState = toText(row.state, "native_question_projection.state");
    if (questionState !== "pending") {
      throw new StateStoreError(`interaction is not pending: ${input.submission.interactionId}`);
    }
    const revision = toSafeInteger(row.revision, "native_question_projection.revision");
    if (revision !== input.submission.expectedInteractionRevision) {
      throw new CausalityViolationError(
        `interaction revision is stale: expected ${input.submission.expectedInteractionRevision}`,
      );
    }
    const canonical = parseJson(
      toText(row.canonical_payload_json, "native_stage_question.canonical_payload_json"),
      "native question canonical payload",
    ) as Interaction;
    const answer = validateAnswer(canonical, input.submission);
    const now = internalClock(db).nowIso();

    const event = appendNativeEvent(db, {
      runId: input.runId,
      type: "native_question.answered",
      payload: {
        interactionId: input.submission.interactionId,
        answer: answer as unknown as JsonValue,
        answeredByKeyId: input.answeredByKeyId,
      },
      recordedAt: now,
    });
    const changed = handle
      .prepare(
        `UPDATE native_question_projection
            SET state = 'answered', revision = revision + 1, delivery_state = 'pending',
                answer_json = ?, answered_by_key_id = ?, answered_at = ?, resolved_at = ?,
                last_event_sequence = ?, updated_at = ?
          WHERE run_id = ? AND interaction_id = ? AND state = 'pending' AND revision = ?`,
      )
      .run(
        stringifyCanonical(answer as unknown as JsonValue),
        input.answeredByKeyId,
        now,
        now,
        event.sequence,
        now,
        input.runId,
        input.submission.interactionId,
        revision,
      );
    if (toSafeInteger(changed.changes, "native question answer changes") !== 1) {
      throw new CausalityViolationError(
        `interaction changed during answer: ${input.submission.interactionId}`,
      );
    }

    const dispatchId = toText(row.dispatch_id, "native_stage_question.dispatch_id");
    handle
      .prepare(
        `UPDATE native_dispatch SET state = 'dispatched', revision = revision + 1, updated_at = ?
          WHERE dispatch_id = ? AND state = 'waiting_on_user'`,
      )
      .run(now, dispatchId);
    handle
      .prepare(
        `UPDATE native_stage SET state = 'dispatched', revision = revision + 1, updated_at = ?
          WHERE run_id = ? AND state = 'waiting_on_user'`,
      )
      .run(now, input.runId);
    const runRevision = advanceRunStatus(db, event, "running");

    return { runRevision, status: "running", interactionRevision: revision + 1 };
  });
}

// ---------------------------------------------------------------------------
// Submit (CR3, CR4, D4)
// ---------------------------------------------------------------------------

export interface SettleNativeDispatchInput {
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly dispatchId: string;
  readonly expectedDispatchRevision: number;
  readonly runId: string;
  readonly stageId: string;
  readonly attemptId: string;
  readonly submissionId: string;
  readonly submissionDigest: string;
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly declaredSummary?: string;
  readonly declaredArtifactPath?: string;
  readonly failure?: Failure;
  readonly witnessOf: WitnessClassifier;
}

export type SettleNativeDispatchOutcome =
  | {
      readonly accepted: true;
      readonly idempotentReplay: boolean;
      readonly requiresArtifactCompletion: boolean;
      readonly dispatchRevision: number;
      readonly status: string;
    }
  | { readonly accepted: false; readonly rejectionCode: NativeBridgeRejectionCode };

/**
 * The submission's one-shot settlement (CR3). No `await` belongs anywhere
 * near a call to this function — the caller must read the artifact bytes
 * (if any) *before* calling it, so that the fencing CAS below is the very
 * first thing that happens after that read, with nothing able to interleave
 * in between. That ordering, not this function's transaction alone, is what
 * closes the rebind-in-an-await-gap race the design review found.
 *
 * `succeeded` stops at "dispatch marked submitted" and returns
 * `requiresArtifactCompletion: true` — actually publishing the artifact and
 * completing the run needs `finalizeStageArtifact`, which only
 * `@heniek/daemon` may import (see this file's own header). `failed`/
 * `cancelled` need no artifact and complete fully here, atomically.
 */
export function settleNativeDispatch(
  db: StateDatabase,
  input: SettleNativeDispatchInput,
): SettleNativeDispatchOutcome {
  return transaction(db, () => {
    const handle = internalHandle(db);
    const now = internalClock(db).nowIso();
    const codebaseId = codebaseForSession(handle, input.sessionId);
    if (codebaseId !== undefined) reapExpirations(db, codebaseId, now, input.witnessOf);
    const fence = validateDispatchFence(handle, input, true);
    if (!fence.ok) return { accepted: false, rejectionCode: fence.rejectionCode };

    const dispatchRow = handle
      .prepare(
        `SELECT state, revision, outcome, submission_id, submission_digest FROM native_dispatch
          WHERE dispatch_id = ?`,
      )
      .get(input.dispatchId);
    if (dispatchRow === undefined) return { accepted: false, rejectionCode: "unknown_dispatch" };
    const dispatchState = toText(dispatchRow.state, "native_dispatch.state");

    if (dispatchState === "submitted") {
      // revoked/abandoned are already excluded by the fence above, which
      // shares this exact vocabulary — reaching here with anything but
      // 'submitted' would mean the two have silently diverged.
      const priorSubmissionId = toNullableText(
        dispatchRow.submission_id,
        "native_dispatch.submission_id",
      );
      const priorDigest = toNullableText(
        dispatchRow.submission_digest,
        "native_dispatch.submission_digest",
      );
      if (priorSubmissionId !== input.submissionId) {
        return { accepted: false, rejectionCode: "dispatch_already_settled" };
      }
      if (priorDigest !== input.submissionDigest) {
        return { accepted: false, rejectionCode: "idempotency_key_reuse" };
      }
      return {
        accepted: true,
        idempotentReplay: true,
        requiresArtifactCompletion: false,
        dispatchRevision: toSafeInteger(dispatchRow.revision, "native_dispatch.revision"),
        status: toText(dispatchRow.outcome, "native_dispatch.outcome"),
      };
    }
    if (dispatchState === "revoked" || dispatchState === "abandoned") {
      return { accepted: false, rejectionCode: "dispatch_revoked" };
    }

    const resultJson =
      input.outcome === "succeeded"
        ? stringifyCanonical({
            summary: input.declaredSummary ?? "",
            artifactPath: input.declaredArtifactPath ?? "",
          })
        : stringifyCanonical({
            failure: (input.failure ?? null) as unknown as JsonValue,
          });

    const settleUpdate = handle
      .prepare(
        `UPDATE native_dispatch
            SET state = 'submitted', outcome = ?, submission_id = ?, submission_digest = ?,
                result_json = ?, settled_at = ?, revision = revision + 1, updated_at = ?
          WHERE dispatch_id = ? AND revision = ? AND state IN ('dispatched','waiting_on_user')`,
      )
      .run(
        input.outcome,
        input.submissionId,
        input.submissionDigest,
        resultJson,
        now,
        now,
        input.dispatchId,
        input.expectedDispatchRevision,
      );
    if (toSafeInteger(settleUpdate.changes, "dispatch settle changes") !== 1) {
      throw new CausalityViolationError(`dispatch changed during settlement: ${input.dispatchId}`);
    }
    const newRevision = input.expectedDispatchRevision + 1;

    if (input.outcome === "succeeded") {
      return {
        accepted: true,
        idempotentReplay: false,
        requiresArtifactCompletion: true,
        dispatchRevision: newRevision,
        status: "succeeded",
      };
    }

    handle
      .prepare(
        `UPDATE native_stage_attempt
            SET status = ?, finished_at = ?, failure_json = ?, updated_at = ?
          WHERE attempt_id = ?`,
      )
      .run(
        input.outcome,
        now,
        input.failure === undefined
          ? null
          : stringifyCanonical(input.failure as unknown as JsonValue),
        now,
        input.attemptId,
      );
    handle
      .prepare(
        `UPDATE native_stage SET state = 'settled', current_attempt_id = NULL,
            revision = revision + 1, updated_at = ? WHERE run_id = ?`,
      )
      .run(now, input.runId);
    const event = appendNativeEvent(db, {
      runId: input.runId,
      type: "run.status_changed",
      payload: { runId: input.runId, status: input.outcome },
      recordedAt: now,
    });
    advanceRunStatus(db, event, input.outcome);

    return {
      accepted: true,
      idempotentReplay: false,
      requiresArtifactCompletion: false,
      dispatchRevision: newRevision,
      status: input.outcome,
    };
  });
}

/**
 * Called after `finalizeStageArtifact` (the native bridge service's own,
 * separate transaction) has already moved `run_projection.status` to
 * `succeeded` via `completeStage`. This call only marks the attempt and
 * stage terminal to match — it does not touch the run.
 */
export function completeNativeAttemptArtifactOutcome(
  db: StateDatabase,
  input: { readonly attemptId: string; readonly runId: string },
): void {
  transaction(db, () => {
    const handle = internalHandle(db);
    const now = internalClock(db).nowIso();
    handle
      .prepare(
        `UPDATE native_stage_attempt SET status = 'succeeded', finished_at = ?, updated_at = ?
          WHERE attempt_id = ?`,
      )
      .run(now, now, input.attemptId);
    handle
      .prepare(
        `UPDATE native_stage SET state = 'settled', current_attempt_id = NULL,
            revision = revision + 1, updated_at = ? WHERE run_id = ?`,
      )
      .run(now, input.runId);
  });
}

/**
 * Called when the client declared `succeeded` but `finalizeStageArtifact`
 * threw — the artifact never validated, so `completeStage` never ran and
 * `run_projection.status` was never touched. This is the only place that
 * still has to append `run.status_changed` for a nominally-succeeded
 * dispatch, mirroring `scheduling-service.ts`'s own catch-and-downgrade
 * shape for the identical failure mode.
 */
export function downgradeNativeAttemptToFailed(
  db: StateDatabase,
  input: {
    readonly attemptId: string;
    readonly runId: string;
    readonly reasonCode: string;
    readonly message: string;
  },
): void {
  transaction(db, () => {
    const handle = internalHandle(db);
    const now = internalClock(db).nowIso();
    const failure: Failure = {
      schemaVersion: 1,
      classification: "artifact_failed",
      phase: "completion",
      code: input.reasonCode,
      message: input.message,
      fallbackEligible: false,
    };
    handle
      .prepare(
        `UPDATE native_stage_attempt SET status = 'failed', finished_at = ?,
            failure_json = ?, updated_at = ? WHERE attempt_id = ?`,
      )
      .run(now, stringifyCanonical(failure as unknown as JsonValue), now, input.attemptId);
    handle
      .prepare(
        `UPDATE native_stage SET state = 'settled', current_attempt_id = NULL,
            revision = revision + 1, updated_at = ? WHERE run_id = ?`,
      )
      .run(now, input.runId);
    const event = appendNativeEvent(db, {
      runId: input.runId,
      type: "run.status_changed",
      payload: { runId: input.runId, status: "failed" },
      recordedAt: now,
    });
    advanceRunStatus(db, event, "failed");
  });
}

// ---------------------------------------------------------------------------
// Resume (recovery_required -> redispatchable)
// ---------------------------------------------------------------------------

export interface ResumeNativeStageOutcome {
  readonly runId: string;
  readonly runRevision: number;
  readonly status: "waiting_for_parent_session";
}

/**
 * The explicit, operator-driven exit from `recovery_required` (§18.2's fail
 * -closed contract: never silent, never automatic). Unlike
 * `requestRunResume` (the external path), there is no backend to hand a
 * durable resume operation to — a native stage's "resume" is entirely
 * daemon-local: flip `native_stage` back to `waiting_for_parent`, and the
 * next `nativeStage.poll.v1` claims it exactly like a fresh dispatch,
 * creating a **new** attempt ordinal. That is deliberately the whole
 * mechanism — §9.5's "a new attempt rather than guaranteed hidden-context
 * continuation" is not a special case here, it is the only path there is.
 *
 * Throws rather than returning a typed rejection, matching
 * `requestRunResume`'s own convention exactly — both are called from the
 * *same*, already-shared `run.resume.v2` handler, so they must fail the
 * same way for that handler to treat them uniformly.
 */
export function resumeNativeStage(
  db: StateDatabase,
  input: { readonly runId: string; readonly expectedRunRevision: number },
): ResumeNativeStageOutcome {
  return transaction(db, () => {
    const handle = internalHandle(db);
    const stage = handle
      .prepare(`SELECT state FROM native_stage WHERE run_id = ?`)
      .get(input.runId);
    if (stage === undefined)
      throw new StateStoreError(`native stage does not exist: ${input.runId}`);
    if (toText(stage.state, "native_stage.state") !== "recovery_required") {
      throw new StateStoreError("explicit resume requires recovery_required status");
    }
    const now = internalClock(db).nowIso();
    const event = appendNativeEvent(db, {
      runId: input.runId,
      type: "run.status_changed",
      payload: { runId: input.runId, status: "waiting_for_parent_session" },
      recordedAt: now,
    });
    handle
      .prepare(
        `UPDATE native_stage SET state = 'waiting_for_parent', current_attempt_id = NULL,
            revision = revision + 1, waiting_since = ?, updated_at = ?
          WHERE run_id = ? AND state = 'recovery_required'`,
      )
      .run(now, now, input.runId);
    const runRevision = advanceRunStatus(
      db,
      event,
      "waiting_for_parent_session",
      input.expectedRunRevision,
    );
    return { runId: input.runId, runRevision, status: "waiting_for_parent_session" };
  });
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export function cancelNativeStage(
  db: StateDatabase,
  runId: string,
): { readonly status: string } | undefined {
  return transaction(db, () => {
    const handle = internalHandle(db);
    const stage = handle
      .prepare(`SELECT state, current_attempt_id FROM native_stage WHERE run_id = ?`)
      .get(runId);
    if (stage === undefined) return undefined;
    const state = toText(stage.state, "native_stage.state");
    if (state === "settled") {
      // Already terminal — report what it actually settled as (succeeded/
      // failed/cancelled), never assume "cancelled" just because that is
      // what this function was asked to do.
      const projection = handle
        .prepare(`SELECT status FROM run_projection WHERE run_id = ?`)
        .get(runId);
      return {
        status:
          projection === undefined
            ? "cancelled"
            : toText(projection.status, "run_projection.status"),
      };
    }
    const now = internalClock(db).nowIso();
    const attemptId = toNullableText(stage.current_attempt_id, "native_stage.current_attempt_id");

    handle
      .prepare(
        `UPDATE native_dispatch SET state = 'revoked', terminal_reason = 'run_cancelled',
            settled_at = ?, revision = revision + 1, updated_at = ?
          WHERE run_id = ? AND state IN ('dispatched','waiting_on_user')`,
      )
      .run(now, now, runId);
    const pendingQuestions = handle
      .prepare(
        `SELECT interaction_id FROM native_question_projection WHERE run_id = ? AND state = 'pending'`,
      )
      .all(runId)
      .map((raw) => toText(raw.interaction_id, "native_question_projection.interaction_id"));
    for (const interactionId of pendingQuestions) {
      cancelNativeQuestion(db, handle, runId, interactionId, "run_terminal", now);
    }
    if (attemptId !== null) {
      handle
        .prepare(
          `UPDATE native_stage_attempt SET status = 'cancelled', finished_at = ?, updated_at = ?
            WHERE attempt_id = ? AND status IN ('running','waiting_on_user')`,
        )
        .run(now, now, attemptId);
    }
    handle
      .prepare(
        `UPDATE native_stage SET state = 'settled', current_attempt_id = NULL,
            revision = revision + 1, updated_at = ? WHERE run_id = ?`,
      )
      .run(now, runId);
    const event = appendNativeEvent(db, {
      runId,
      type: "run.status_changed",
      payload: { runId, status: "cancelled" },
      recordedAt: now,
    });
    advanceRunStatus(db, event, "cancelled");
    return { status: "cancelled" };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface NativeStageAttemptSnapshot {
  readonly attemptId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly attemptOrdinal: number;
  readonly workspaceId: string | null;
  readonly status: string;
  readonly failureJson: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export function readNativeStageAttempts(
  db: StateDatabase,
  runId: string,
): readonly NativeStageAttemptSnapshot[] {
  return internalHandle(db)
    .prepare(
      `SELECT attempt_id, run_id, stage_id, attempt_ordinal, workspace_id, status,
              failure_json, started_at, finished_at
         FROM native_stage_attempt WHERE run_id = ? ORDER BY attempt_ordinal`,
    )
    .all(runId)
    .map((raw) => ({
      attemptId: toText(raw.attempt_id, "native_stage_attempt.attempt_id"),
      runId: toText(raw.run_id, "native_stage_attempt.run_id"),
      stageId: toText(raw.stage_id, "native_stage_attempt.stage_id"),
      attemptOrdinal: toSafeInteger(raw.attempt_ordinal, "native_stage_attempt.attempt_ordinal"),
      workspaceId: toNullableText(raw.workspace_id, "native_stage_attempt.workspace_id"),
      status: toText(raw.status, "native_stage_attempt.status"),
      failureJson: toNullableText(raw.failure_json, "native_stage_attempt.failure_json"),
      startedAt: toNullableText(raw.started_at, "native_stage_attempt.started_at"),
      finishedAt: toNullableText(raw.finished_at, "native_stage_attempt.finished_at"),
    }));
}

export interface NativeStageQuestionSnapshot {
  readonly interactionId: string;
  readonly canonical: Interaction;
}

export function readPendingNativeQuestions(
  db: StateDatabase,
  runId: string,
): readonly NativeStageQuestionSnapshot[] {
  return internalHandle(db)
    .prepare(
      `SELECT q.interaction_id, q.canonical_payload_json, p.state, p.revision,
              p.delivery_state, p.resolved_at, p.cancellation_reason
         FROM native_stage_question q
         JOIN native_question_projection p
           ON p.run_id = q.run_id AND p.interaction_id = q.interaction_id
        WHERE q.run_id = ? AND p.state = 'pending'
        ORDER BY q.requested_at, q.interaction_id`,
    )
    .all(runId)
    .map((raw) => {
      const canonical = parseJson(
        toText(raw.canonical_payload_json, "native_stage_question.canonical_payload_json"),
        "native question canonical payload",
      ) as Interaction;
      return {
        interactionId: toText(raw.interaction_id, "native_stage_question.interaction_id"),
        canonical: {
          ...canonical,
          status: toText(raw.state, "native_question_projection.state") as Interaction["status"],
          revision: toSafeInteger(raw.revision, "native_question_projection.revision"),
          deliveryState: toText(
            raw.delivery_state,
            "native_question_projection.delivery_state",
          ) as Interaction["deliveryState"],
        },
      };
    });
}

export function listNativeQuestionInbox(db: StateDatabase): readonly {
  readonly runId: string;
  readonly runRevision: number;
  readonly interaction: Interaction;
}[] {
  return internalHandle(db)
    .prepare(
      `SELECT q.run_id, q.interaction_id, q.canonical_payload_json, p.state, p.revision,
              p.delivery_state, r.revision AS run_revision
         FROM native_stage_question q
         JOIN native_question_projection p
           ON p.run_id = q.run_id AND p.interaction_id = q.interaction_id
         JOIN run_projection r ON r.run_id = q.run_id
        WHERE p.state = 'pending'
        ORDER BY q.requested_at, q.run_id, q.interaction_id`,
    )
    .all()
    .map((raw) => {
      const canonical = parseJson(
        toText(raw.canonical_payload_json, "native_stage_question.canonical_payload_json"),
        "native question canonical payload",
      ) as Interaction;
      return {
        runId: toText(raw.run_id, "native_stage_question.run_id"),
        runRevision: toSafeInteger(raw.run_revision, "run_projection.revision"),
        interaction: {
          ...canonical,
          status: toText(raw.state, "native_question_projection.state") as Interaction["status"],
          revision: toSafeInteger(raw.revision, "native_question_projection.revision"),
          deliveryState: toText(
            raw.delivery_state,
            "native_question_projection.delivery_state",
          ) as Interaction["deliveryState"],
        },
      };
    });
}
