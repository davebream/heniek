import type {
  ExecutionStatus,
  InteractionAnswerSetV1,
  InteractionAnswerSubmissionV2,
  InteractionAnswerV2,
  InteractionV2,
  PendingInteractionV2,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
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
import { appendEvent } from "../journal/append.js";
import { asCausationEventId, asCorrelationId } from "../journal/brand.js";
import type { CorrelationId, StateEvent } from "../journal/event.js";
import { type JsonValue, stringifyCanonical } from "../json.js";

type Interaction = Static<typeof InteractionV2>;
type AnswerSubmission = Static<typeof InteractionAnswerSubmissionV2>;
type Answer = Static<typeof InteractionAnswerV2>;
type BackendInteraction = Static<typeof PendingInteractionV2>;
type BackendAnswer = Static<typeof InteractionAnswerSetV1>;

type CancellationReason = NonNullable<Interaction["cancellationReason"]>;

const TERMINAL_RUN_STATUSES = new Set<ExecutionStatus>(["succeeded", "failed", "cancelled"]);

export interface InteractionInboxItem {
  readonly runId: string;
  readonly stageId: string;
  readonly runRevision: number;
  readonly interaction: Interaction;
}

export interface AcceptedInteractionAnswer {
  readonly runId: string;
  readonly runRevision: number;
  readonly status: ExecutionStatus;
  readonly interactionRevision: number;
  readonly operationId: string;
  readonly answer: Answer;
}

export interface RequestedRunResume {
  readonly runId: string;
  readonly runRevision: number;
  readonly status: "recovery_required";
  readonly operationId: string;
}

export interface PendingExecutionOperation {
  readonly operationId: string;
  readonly runId: string;
  readonly interactionId: string | null;
  readonly kind: "answer" | "resume";
  readonly payload: BackendAnswer | { readonly inputArtifactRefs: readonly string[] };
  readonly backendExecutionId: string;
  readonly attemptCount: number;
}

interface InteractionRow {
  readonly runId: string;
  readonly interactionId: string;
  readonly stageId: string;
  readonly sourcePayloadJson: string;
  readonly canonicalPayloadJson: string | null;
  readonly state: Interaction["status"];
  readonly revision: number;
  readonly deliveryState: Interaction["deliveryState"];
  readonly cancellationReason: CancellationReason | null;
  readonly resolvedAt: string | null;
  readonly requestedAt: string;
  readonly timeoutAt: string | null;
  readonly createdEventId: string;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new StateDatabaseCorruptionError(`${label} is malformed`, { cause: error });
  }
}

export function canonicalizeBackendInteraction(
  interaction: BackendInteraction,
  purpose: "question" | "approval" = "question",
): Interaction {
  const seenQuestions = new Set<string>();
  const questions: Interaction["questions"] = interaction.questions.map((question) => {
    if (seenQuestions.has(question.id)) {
      throw new StateStoreError(`interaction has duplicate question id: ${question.id}`);
    }
    seenQuestions.add(question.id);
    const seenLabels = new Set<string>();
    for (const option of question.options) {
      if (seenLabels.has(option.label)) {
        throw new StateStoreError(
          `interaction question has duplicate option label: ${option.label}`,
        );
      }
      seenLabels.add(option.label);
    }
    if (question.options.length === 0) {
      if (question.multiSelect) {
        throw new StateStoreError(`free-text question cannot enable multi-select: ${question.id}`);
      }
      return {
        questionId: question.id,
        kind: "free_text" as const,
        prompt: question.prompt,
        ...(question.header === undefined ? {} : { header: question.header }),
      };
    }
    return {
      questionId: question.id,
      kind: question.multiSelect ? ("multiple_choice" as const) : ("single_choice" as const),
      prompt: question.prompt,
      ...(question.header === undefined ? {} : { header: question.header }),
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      })),
    };
  });
  return {
    schemaVersion: 2,
    interactionId: interaction.id,
    purpose,
    status: "pending",
    revision: 1,
    questions,
    requestedAt: interaction.requestedAt,
    ...(interaction.timeoutAt === undefined ? {} : { timeoutAt: interaction.timeoutAt }),
    deliveryState: "not_applicable",
  };
}

function interactionRow(raw: Record<string, unknown>): InteractionRow {
  const state = toText(raw.state, "pending_interaction_projection.state");
  if (state !== "pending" && state !== "answered" && state !== "cancelled") {
    throw new StateDatabaseCorruptionError("interaction projection has an unknown state");
  }
  const deliveryState = toText(raw.delivery_state, "pending_interaction_projection.delivery_state");
  if (
    deliveryState !== "not_applicable" &&
    deliveryState !== "pending" &&
    deliveryState !== "delivered"
  ) {
    throw new StateDatabaseCorruptionError("interaction projection has an unknown delivery state");
  }
  const cancellationReason = toNullableText(
    raw.cancellation_reason,
    "pending_interaction_projection.cancellation_reason",
  );
  if (
    cancellationReason !== null &&
    cancellationReason !== "withdrawn" &&
    cancellationReason !== "timed_out" &&
    cancellationReason !== "run_terminal" &&
    cancellationReason !== "migration_unresolved"
  ) {
    throw new StateDatabaseCorruptionError(
      "interaction projection has an unknown cancellation reason",
    );
  }
  return {
    runId: toText(raw.run_id, "interaction_record.run_id"),
    interactionId: toText(raw.interaction_id, "interaction_record.interaction_id"),
    stageId: toText(raw.stage_id, "interaction_record.stage_id"),
    sourcePayloadJson: toText(raw.source_payload_json, "interaction_record.source_payload_json"),
    canonicalPayloadJson: toNullableText(
      raw.canonical_payload_json,
      "interaction_record.canonical_payload_json",
    ),
    state,
    revision: toSafeInteger(raw.revision, "pending_interaction_projection.revision"),
    deliveryState,
    cancellationReason,
    resolvedAt: toNullableText(raw.resolved_at, "pending_interaction_projection.resolved_at"),
    requestedAt: toText(raw.requested_at, "interaction_record.requested_at"),
    timeoutAt: toNullableText(raw.timeout_at, "interaction_record.timeout_at"),
    createdEventId: toText(raw.created_event_id, "interaction_record.created_event_id"),
  };
}

const INTERACTION_SELECT = `
  SELECT r.run_id, r.interaction_id, r.stage_id, r.source_payload_json,
         r.canonical_payload_json, r.requested_at, r.timeout_at, r.created_event_id,
         p.state, p.revision, p.delivery_state, p.cancellation_reason, p.resolved_at
    FROM interaction_record r
    JOIN pending_interaction_projection p
      ON p.run_id = r.run_id AND p.interaction_id = r.interaction_id`;

function readInteractionRow(
  db: StateDatabase,
  runId: string,
  interactionId: string,
): InteractionRow | undefined {
  const raw = internalHandle(db)
    .prepare(`${INTERACTION_SELECT} WHERE r.run_id = ? AND r.interaction_id = ?`)
    .get(runId, interactionId);
  return raw === undefined ? undefined : interactionRow(raw);
}

function initialInteraction(row: InteractionRow): Interaction {
  if (row.canonicalPayloadJson !== null) {
    return parseJson(row.canonicalPayloadJson, "canonical interaction JSON") as Interaction;
  }
  const legacy = parseJson(row.sourcePayloadJson, "legacy interaction JSON") as BackendInteraction;
  return canonicalizeBackendInteraction(legacy);
}

function interactionSnapshot(row: InteractionRow): Interaction {
  const initial = initialInteraction(row);
  return {
    ...initial,
    status: row.state,
    revision: row.revision,
    deliveryState: row.deliveryState,
    ...(row.resolvedAt === null ? {} : { resolvedAt: row.resolvedAt }),
    ...(row.cancellationReason === null ? {} : { cancellationReason: row.cancellationReason }),
  };
}

function correlationForCreation(db: StateDatabase, createdEventId: string): CorrelationId {
  const raw = internalHandle(db)
    .prepare("SELECT correlation_id FROM state_event WHERE event_id = ?")
    .get(createdEventId);
  if (raw === undefined) {
    throw new StateDatabaseCorruptionError("interaction creation event is missing");
  }
  return asCorrelationId(toText(raw.correlation_id, "state_event.correlation_id"));
}

function appendInteractionEvent(
  db: StateDatabase,
  input: {
    readonly runId: string;
    readonly type: string;
    readonly payload: JsonValue;
    readonly correlationId?: CorrelationId;
    readonly causationEventId?: string;
    readonly recordedAt: string;
  },
): StateEvent {
  return appendEvent(db, {
    runId: input.runId,
    type: input.type,
    payload: input.payload,
    correlationId: input.correlationId ?? asCorrelationId(internalIds(db).next("cor")),
    causationEventId:
      input.causationEventId === undefined ? null : asCausationEventId(input.causationEventId),
    recordedAt: input.recordedAt,
  });
}

function advanceRunRevision(
  db: StateDatabase,
  event: StateEvent,
  expectedRevision?: number,
): number {
  const where = expectedRevision === undefined ? "run_id = ?" : "run_id = ? AND revision = ?";
  const values =
    expectedRevision === undefined
      ? [event.sequence, event.recordedAt, event.runId]
      : [event.sequence, event.recordedAt, event.runId, expectedRevision];
  const report = internalHandle(db)
    .prepare(
      `UPDATE run_projection
          SET revision = revision + 1, last_event_sequence = ?, updated_at = ?
        WHERE ${where}`,
    )
    .run(...values);
  if (toSafeInteger(report.changes, "run projection changes") !== 1) {
    throw new CausalityViolationError(
      expectedRevision === undefined
        ? `interaction event references missing run: ${event.runId ?? "unknown"}`
        : `run revision is stale: expected ${expectedRevision}`,
    );
  }
  const row = internalHandle(db)
    .prepare("SELECT revision FROM run_projection WHERE run_id = ?")
    .get(event.runId);
  if (row === undefined) throw new StateDatabaseCorruptionError("run projection disappeared");
  return toSafeInteger(row.revision, "run_projection.revision");
}

function cancelInteraction(
  db: StateDatabase,
  row: InteractionRow,
  reason: CancellationReason,
  now: string,
): void {
  if (row.state !== "pending") return;
  const event = appendInteractionEvent(db, {
    runId: row.runId,
    type: "interaction.cancelled",
    payload: { interactionId: row.interactionId, reason },
    correlationId: correlationForCreation(db, row.createdEventId),
    causationEventId: row.createdEventId,
    recordedAt: now,
  });
  advanceRunRevision(db, event);
  const report = internalHandle(db)
    .prepare(
      `UPDATE pending_interaction_projection
          SET state = 'cancelled', revision = revision + 1,
              delivery_state = 'not_applicable', cancellation_reason = ?, resolved_at = ?,
              last_event_sequence = ?, updated_at = ?
        WHERE run_id = ? AND interaction_id = ? AND state = 'pending' AND revision = ?`,
    )
    .run(reason, now, event.sequence, now, row.runId, row.interactionId, row.revision);
  if (toSafeInteger(report.changes, "interaction cancellation changes") !== 1) {
    throw new CausalityViolationError(
      `interaction changed during cancellation: ${row.interactionId}`,
    );
  }
}

function stageState(
  db: StateDatabase,
  runId: string,
): {
  readonly stageId: string;
  readonly status: ExecutionStatus;
  readonly runRevision: number;
  readonly backendExecutionId: string | null;
} {
  const raw = internalHandle(db)
    .prepare(
      `SELECT s.stage_id, s.status, s.backend_execution_id, r.revision
         FROM stage_execution s JOIN run_projection r ON r.run_id = s.run_id
        WHERE s.run_id = ?`,
    )
    .get(runId);
  if (raw === undefined) throw new StateStoreError(`stage execution does not exist: ${runId}`);
  const status = toText(raw.status, "stage_execution.status") as ExecutionStatus;
  return {
    stageId: toText(raw.stage_id, "stage_execution.stage_id"),
    status,
    runRevision: toSafeInteger(raw.revision, "run_projection.revision"),
    backendExecutionId: toNullableText(
      raw.backend_execution_id,
      "stage_execution.backend_execution_id",
    ),
  };
}

export function synchronizePendingInteractions(
  db: StateDatabase,
  runId: string,
  interactions: readonly BackendInteraction[],
  purpose: "question" | "approval" = "question",
  observedStatus?: ExecutionStatus,
): void {
  const prepared = interactions.map((source) => ({
    source,
    sourceJson: stringifyCanonical(source as unknown as JsonValue),
    canonical: canonicalizeBackendInteraction(source, purpose),
  }));
  const activeIds = new Set<string>(prepared.map((entry) => entry.source.id));
  if (activeIds.size !== prepared.length) {
    throw new StateStoreError("backend returned duplicate interaction ids");
  }
  const handle = internalHandle(db);
  const now = internalClock(db).nowIso();
  handle.exec("BEGIN IMMEDIATE");
  try {
    const stage = stageState(db, runId);
    const effectiveStatus = observedStatus ?? stage.status;
    for (const entry of prepared) {
      const existing = readInteractionRow(db, runId, entry.source.id);
      if (existing !== undefined) {
        const existingCanonical = stringifyCanonical(
          parseJson(existing.sourcePayloadJson, "interaction source payload") as JsonValue,
        );
        if (existingCanonical !== entry.sourceJson) {
          throw new StateStoreError(`interaction question is immutable: ${entry.source.id}`);
        }
        continue;
      }
      const event = appendInteractionEvent(db, {
        runId,
        type: "interaction.created",
        payload: {
          interactionId: entry.source.id,
          stageId: stage.stageId,
          purpose,
          interaction: entry.canonical as unknown as JsonValue,
        },
        recordedAt: entry.canonical.requestedAt,
      });
      advanceRunRevision(db, event);
      handle
        .prepare(
          `INSERT INTO interaction_record
            (run_id, interaction_id, stage_id, purpose, source_payload_json,
             canonical_payload_json, legacy_state, requested_at, timeout_at, created_event_id)
           VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          runId,
          entry.source.id,
          stage.stageId,
          purpose,
          entry.sourceJson,
          stringifyCanonical(entry.canonical as unknown as JsonValue),
          entry.canonical.requestedAt,
          entry.canonical.timeoutAt ?? null,
          event.eventId,
        );
      handle
        .prepare(
          `INSERT INTO pending_interaction_projection
            (run_id, interaction_id, state, revision, delivery_state, cancellation_reason,
             resolved_at, answer_id, last_event_sequence, updated_at)
           VALUES (?, ?, 'pending', 1, 'not_applicable', NULL, NULL, NULL, ?, ?)`,
        )
        .run(runId, entry.source.id, event.sequence, event.recordedAt);
    }

    const pending = handle
      .prepare(`${INTERACTION_SELECT} WHERE r.run_id = ? AND p.state = 'pending'`)
      .all(runId)
      .map(interactionRow);
    for (const row of pending) {
      const timedOut = row.timeoutAt !== null && row.timeoutAt <= now;
      if (TERMINAL_RUN_STATUSES.has(effectiveStatus)) {
        cancelInteraction(db, row, "run_terminal", now);
      } else if (timedOut) {
        cancelInteraction(db, row, "timed_out", now);
      } else if (!activeIds.has(row.interactionId)) {
        cancelInteraction(db, row, "withdrawn", now);
      }
    }
    handle.exec("COMMIT");
  } catch (error) {
    if (handle.isTransaction) handle.exec("ROLLBACK");
    throw error;
  }
}

export function readRunInteractions(db: StateDatabase, runId: string): readonly Interaction[] {
  return internalHandle(db)
    .prepare(`${INTERACTION_SELECT} WHERE r.run_id = ? ORDER BY r.requested_at, r.interaction_id`)
    .all(runId)
    .map(interactionRow)
    .map(interactionSnapshot);
}

export function listInteractionInbox(db: StateDatabase): readonly InteractionInboxItem[] {
  return internalHandle(db)
    .prepare(
      `${INTERACTION_SELECT.replace("p.state,", "run.revision AS run_revision, p.state,")}
       JOIN run_projection run ON run.run_id = r.run_id
       WHERE p.state = 'pending'
       ORDER BY r.requested_at, r.run_id, r.interaction_id`,
    )
    .all()
    .map((raw) => {
      const row = interactionRow(raw);
      return {
        runId: row.runId,
        stageId: row.stageId,
        runRevision: toSafeInteger(raw.run_revision, "run_projection.revision"),
        interaction: interactionSnapshot(row),
      };
    });
}

/**
 * Exported for `native-bridge/store.ts`: native questions validate answers
 * against the exact same `InteractionV2`/`InteractionAnswerSubmissionV2`
 * shapes, so this is reused rather than re-implemented — one place decides
 * what a well-formed answer looks like, for both interaction kinds.
 */
export function validateAnswer(
  interaction: Interaction,
  submission: AnswerSubmission,
): BackendAnswer {
  const byQuestion = new Map(submission.answers.map((answer) => [answer.questionId, answer]));
  if (
    byQuestion.size !== submission.answers.length ||
    byQuestion.size !== interaction.questions.length
  ) {
    throw new StateStoreError("answer must cover every interaction question exactly once");
  }
  const answers: BackendAnswer["answers"] = interaction.questions.map((question) => {
    const answer = byQuestion.get(question.questionId);
    if (answer === undefined || answer.kind !== question.kind) {
      throw new StateStoreError(`answer shape does not match question: ${question.questionId}`);
    }
    if (question.kind === "free_text") {
      if (answer.kind !== "free_text" || answer.freeText.trim().length === 0) {
        throw new StateStoreError(`free-text answer is empty: ${question.questionId}`);
      }
      return { questionId: question.questionId, selectedLabels: [], freeText: answer.freeText };
    }
    if (answer.kind === "free_text") {
      throw new StateStoreError(`choice answer is malformed: ${question.questionId}`);
    }
    if (new Set(answer.selectedLabels).size !== answer.selectedLabels.length) {
      throw new StateStoreError(`answer selected a duplicate option: ${question.questionId}`);
    }
    const allowed = new Set(question.options.map((option) => option.label));
    if (answer.selectedLabels.some((label) => !allowed.has(label))) {
      throw new StateStoreError(`answer selected an unknown option: ${question.questionId}`);
    }
    if (question.kind === "single_choice" && answer.selectedLabels.length !== 1) {
      throw new StateStoreError(
        `single-choice answer must select exactly one option: ${question.questionId}`,
      );
    }
    if (question.kind === "multiple_choice" && answer.selectedLabels.length === 0) {
      throw new StateStoreError(
        `multiple-choice answer must select an option: ${question.questionId}`,
      );
    }
    return { questionId: question.questionId, selectedLabels: [...answer.selectedLabels] };
  });
  return { schemaVersion: 1, interactionId: interaction.interactionId, answers };
}

export function acceptInteractionAnswer(
  db: StateDatabase,
  runId: string,
  submission: AnswerSubmission,
  answeredByKeyId: string,
): AcceptedInteractionAnswer {
  if (answeredByKeyId.length === 0) throw new StateStoreError("authenticated key id is required");
  const handle = internalHandle(db);
  handle.exec("BEGIN IMMEDIATE");
  try {
    const stage = stageState(db, runId);
    if (TERMINAL_RUN_STATUSES.has(stage.status)) {
      throw new StateStoreError("terminal runs cannot accept interaction answers");
    }
    const row = readInteractionRow(db, runId, submission.interactionId);
    if (row === undefined) {
      throw new StateStoreError(`interaction does not belong to run: ${submission.interactionId}`);
    }
    if (row.state !== "pending") {
      throw new StateStoreError(`interaction is not pending: ${submission.interactionId}`);
    }
    if (row.revision !== submission.expectedInteractionRevision) {
      throw new CausalityViolationError(
        `interaction revision is stale: expected ${submission.expectedInteractionRevision}`,
      );
    }
    const interaction = interactionSnapshot(row);
    const backendAnswer = validateAnswer(interaction, submission);
    const now = internalClock(db).nowIso();
    const answerId = internalIds(db).next("answer");
    const operationId = internalIds(db).next("operation");
    const interactionRevision = row.revision + 1;
    const answer: Answer = {
      schemaVersion: 2,
      answerId,
      operationId,
      interactionId: submission.interactionId,
      interactionRevision,
      answers: submission.answers,
      answeredAt: now,
      answeredByKeyId,
    };
    const event = appendInteractionEvent(db, {
      runId,
      type: "interaction.answer_accepted",
      payload: {
        interactionId: submission.interactionId,
        answer: answer as unknown as JsonValue,
        operationId,
      },
      correlationId: correlationForCreation(db, row.createdEventId),
      causationEventId: row.createdEventId,
      recordedAt: now,
    });
    const runRevision = advanceRunRevision(db, event);
    handle
      .prepare(
        `INSERT INTO interaction_answer_record
          (answer_id, run_id, interaction_id, operation_id, source_answer_json,
           canonical_answer_json, answered_by_key_id, answered_at, accepted_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        answerId,
        runId,
        submission.interactionId,
        operationId,
        stringifyCanonical(backendAnswer as unknown as JsonValue),
        stringifyCanonical(answer as unknown as JsonValue),
        answeredByKeyId,
        now,
        event.eventId,
      );
    handle
      .prepare(
        `INSERT INTO execution_operation_outbox
          (operation_id, run_id, interaction_id, kind, payload_json, state,
           attempt_count, last_error, created_at, delivered_at, last_event_sequence)
         VALUES (?, ?, ?, 'answer', ?, 'pending', 0, NULL, ?, NULL, ?)`,
      )
      .run(
        operationId,
        runId,
        submission.interactionId,
        stringifyCanonical(backendAnswer as unknown as JsonValue),
        now,
        event.sequence,
      );
    const changed = handle
      .prepare(
        `UPDATE pending_interaction_projection
            SET state = 'answered', revision = revision + 1, delivery_state = 'pending',
                cancellation_reason = NULL, resolved_at = ?, answer_id = ?,
                last_event_sequence = ?, updated_at = ?
          WHERE run_id = ? AND interaction_id = ? AND state = 'pending' AND revision = ?`,
      )
      .run(now, answerId, event.sequence, now, runId, submission.interactionId, row.revision);
    if (toSafeInteger(changed.changes, "interaction answer changes") !== 1) {
      throw new CausalityViolationError(
        `interaction changed during answer: ${submission.interactionId}`,
      );
    }
    handle.exec("COMMIT");
    return {
      runId,
      runRevision,
      status: stage.status,
      interactionRevision,
      operationId,
      answer,
    };
  } catch (error) {
    if (handle.isTransaction) handle.exec("ROLLBACK");
    throw error;
  }
}

export function requestRunResume(
  db: StateDatabase,
  runId: string,
  expectedRunRevision: number,
  inputArtifactRefs: readonly string[],
): RequestedRunResume {
  const handle = internalHandle(db);
  handle.exec("BEGIN IMMEDIATE");
  try {
    const stage = stageState(db, runId);
    if (stage.status !== "recovery_required") {
      throw new StateStoreError("explicit resume requires recovery_required status");
    }
    if (stage.runRevision !== expectedRunRevision) {
      throw new CausalityViolationError(`run revision is stale: expected ${expectedRunRevision}`);
    }
    if (stage.backendExecutionId === null)
      throw new StateStoreError("backend handle is unavailable");
    const operationId = internalIds(db).next("operation");
    const now = internalClock(db).nowIso();
    const payload = { inputArtifactRefs: [...inputArtifactRefs] };
    const event = appendInteractionEvent(db, {
      runId,
      type: "run.resume_requested",
      payload: { operationId, ...payload },
      recordedAt: now,
    });
    const runRevision = advanceRunRevision(db, event, expectedRunRevision);
    handle
      .prepare(
        `INSERT INTO execution_operation_outbox
          (operation_id, run_id, interaction_id, kind, payload_json, state,
           attempt_count, last_error, created_at, delivered_at, last_event_sequence)
         VALUES (?, ?, NULL, 'resume', ?, 'pending', 0, NULL, ?, NULL, ?)`,
      )
      .run(
        operationId,
        runId,
        stringifyCanonical(payload as unknown as JsonValue),
        now,
        event.sequence,
      );
    handle.exec("COMMIT");
    return {
      runId,
      runRevision,
      status: "recovery_required",
      operationId,
    };
  } catch (error) {
    if (handle.isTransaction) handle.exec("ROLLBACK");
    throw error;
  }
}

export function readPendingExecutionOperations(
  db: StateDatabase,
): readonly PendingExecutionOperation[] {
  return internalHandle(db)
    .prepare(
      `SELECT o.operation_id, o.run_id, o.interaction_id, o.kind, o.payload_json,
              o.attempt_count, s.backend_execution_id
         FROM execution_operation_outbox o
         JOIN stage_execution s ON s.run_id = o.run_id
        WHERE o.state = 'pending' AND s.backend_execution_id IS NOT NULL
        ORDER BY o.created_at, o.operation_id`,
    )
    .all()
    .map((raw) => {
      const kind = toText(raw.kind, "execution_operation_outbox.kind");
      if (kind !== "answer" && kind !== "resume") {
        throw new StateDatabaseCorruptionError("execution operation has an unknown kind");
      }
      return {
        operationId: toText(raw.operation_id, "execution_operation_outbox.operation_id"),
        runId: toText(raw.run_id, "execution_operation_outbox.run_id"),
        interactionId: toNullableText(
          raw.interaction_id,
          "execution_operation_outbox.interaction_id",
        ),
        kind,
        payload: parseJson(
          toText(raw.payload_json, "execution_operation_outbox.payload_json"),
          "execution operation payload",
        ) as PendingExecutionOperation["payload"],
        backendExecutionId: toText(
          raw.backend_execution_id,
          "stage_execution.backend_execution_id",
        ),
        attemptCount: toSafeInteger(raw.attempt_count, "execution_operation_outbox.attempt_count"),
      };
    });
}

export function recordExecutionOperationFailure(
  db: StateDatabase,
  operationId: string,
  message: string,
): void {
  const bounded = message.slice(0, 1_024);
  const report = internalHandle(db)
    .prepare(
      `UPDATE execution_operation_outbox
          SET attempt_count = attempt_count + 1, last_error = ?
        WHERE operation_id = ? AND state = 'pending'`,
    )
    .run(bounded, operationId);
  if (toSafeInteger(report.changes, "operation failure changes") !== 1) {
    throw new StateStoreError(`pending operation does not exist: ${operationId}`);
  }
}

export function markExecutionOperationDelivered(db: StateDatabase, operationId: string): number {
  const handle = internalHandle(db);
  handle.exec("BEGIN IMMEDIATE");
  try {
    const raw = handle
      .prepare(
        `SELECT operation_id, run_id, interaction_id, kind, state, created_at
           FROM execution_operation_outbox WHERE operation_id = ?`,
      )
      .get(operationId);
    if (raw === undefined) throw new StateStoreError(`operation does not exist: ${operationId}`);
    if (toText(raw.state, "execution_operation_outbox.state") === "delivered") {
      const current = stageState(db, toText(raw.run_id, "execution_operation_outbox.run_id"));
      handle.exec("COMMIT");
      return current.runRevision;
    }
    const runId = toText(raw.run_id, "execution_operation_outbox.run_id");
    const kind = toText(raw.kind, "execution_operation_outbox.kind");
    const now = internalClock(db).nowIso();
    const event = appendInteractionEvent(db, {
      runId,
      type: kind === "answer" ? "interaction.answer_delivered" : "run.resume_delivered",
      payload: {
        operationId,
        ...(raw.interaction_id === null
          ? {}
          : {
              interactionId: toText(
                raw.interaction_id,
                "execution_operation_outbox.interaction_id",
              ),
            }),
      },
      recordedAt: now,
    });
    const runRevision = advanceRunRevision(db, event);
    const changed = handle
      .prepare(
        `UPDATE execution_operation_outbox
            SET state = 'delivered', attempt_count = attempt_count + 1, last_error = NULL,
                delivered_at = ?, last_event_sequence = ?
          WHERE operation_id = ? AND state = 'pending'`,
      )
      .run(now, event.sequence, operationId);
    if (toSafeInteger(changed.changes, "operation delivery changes") !== 1) {
      throw new CausalityViolationError(`operation changed during delivery: ${operationId}`);
    }
    if (kind === "answer") {
      const interactionId = toText(raw.interaction_id, "execution_operation_outbox.interaction_id");
      const projected = handle
        .prepare(
          `UPDATE pending_interaction_projection
              SET revision = revision + 1, delivery_state = 'delivered',
                  last_event_sequence = ?, updated_at = ?
            WHERE run_id = ? AND interaction_id = ? AND state = 'answered'
              AND delivery_state = 'pending'`,
        )
        .run(event.sequence, now, runId, interactionId);
      if (toSafeInteger(projected.changes, "answer delivery projection changes") !== 1) {
        throw new CausalityViolationError(
          `answer projection changed during delivery: ${interactionId}`,
        );
      }
    }
    handle.exec("COMMIT");
    return runRevision;
  } catch (error) {
    if (handle.isTransaction) handle.exec("ROLLBACK");
    throw error;
  }
}

export function readLegacyPendingInteractions(
  db: StateDatabase,
  runId: string,
): readonly BackendInteraction[] {
  return internalHandle(db)
    .prepare(
      `SELECT r.source_payload_json
         FROM interaction_record r
         JOIN pending_interaction_projection p
           ON p.run_id = r.run_id AND p.interaction_id = r.interaction_id
        WHERE r.run_id = ? AND p.state = 'pending'
        ORDER BY r.requested_at, r.interaction_id`,
    )
    .all(runId)
    .map((raw) =>
      parseJson(
        toText(raw.source_payload_json, "interaction_record.source_payload_json"),
        "interaction source payload",
      ),
    ) as readonly BackendInteraction[];
}

export function legacyAnswerSubmission(
  db: StateDatabase,
  runId: string,
  answer: BackendAnswer,
): AnswerSubmission {
  const row = readInteractionRow(db, runId, answer.interactionId);
  if (row === undefined || row.state !== "pending") {
    throw new StateStoreError(`pending interaction does not exist: ${answer.interactionId}`);
  }
  const interaction = interactionSnapshot(row);
  const byQuestion = new Map(answer.answers.map((entry) => [entry.questionId, entry]));
  const answers: AnswerSubmission["answers"] = interaction.questions.map((question) => {
    const entry = byQuestion.get(question.questionId);
    if (entry === undefined) {
      throw new StateStoreError(`answer does not cover question: ${question.questionId}`);
    }
    if (question.kind === "free_text") {
      return {
        questionId: question.questionId,
        kind: "free_text" as const,
        freeText: entry.freeText ?? "",
      };
    }
    return {
      questionId: question.questionId,
      kind: question.kind,
      selectedLabels: [...entry.selectedLabels],
    };
  });
  return {
    schemaVersion: 2,
    interactionId: answer.interactionId,
    expectedInteractionRevision: row.revision,
    answers,
  };
}
