import type { SchedulingDecisionKind } from "@heniek/contracts";
import {
  internalClock,
  internalHandle,
  internalIds,
  type StateDatabase,
} from "../database/open.js";
import { readUserVersion, toNullableText, toSafeInteger, toText } from "../database/pragma.js";
import { StateDatabaseCorruptionError, StateStoreError } from "../errors.js";
import { type JsonValue, parseJsonValue, stringifyCanonical } from "../json.js";
import { CAPABILITY_LANDING_SCHEMA_VERSION } from "../migrations/capability-landing.js";

export type CapacityPolicy = "queue" | "fallback" | "ask";
export type WorkspacePermission = "read-only" | "read-write";

export interface SchedulingCandidateInput {
  readonly profileId: string;
  readonly accountId?: string;
  readonly engine: string;
  readonly maxConcurrentRuns: number;
  readonly profile: JsonValue;
  readonly limits: JsonValue;
  readonly permissions: JsonValue;
  readonly compatible?: boolean;
  readonly rejectionReason?: string;
  readonly capabilityDelta?: JsonValue;
}

export interface CreateExecutionScheduleInput {
  readonly runId: string;
  readonly stageId: string;
  readonly codebaseId: string;
  readonly repositoryId: string;
  readonly prompt: string;
  readonly artifactPath: string;
  readonly baseSha: string;
  readonly hardDeadlineAt?: string;
  readonly capacityPolicy: CapacityPolicy;
  readonly requestedPriority?: number;
  readonly requestedIdentifiers?: readonly string[];
  readonly chain: JsonValue;
  readonly candidates: readonly SchedulingCandidateInput[];
  readonly capabilityRequest?: JsonValue;
}

export interface SchedulingClaim {
  readonly runId: string;
  readonly stageId: string;
  readonly codebaseId: string;
  readonly repositoryId: string;
  readonly prompt: string;
  readonly artifactPath: string;
  readonly attemptId: string;
  readonly candidateIndex: number;
  readonly profileId: string;
  readonly accountId: string;
  readonly fencingRevision: number;
  readonly leaseExpiresAt: string;
  readonly baseSha: string;
  readonly hardDeadlineAt?: string;
  readonly profile: JsonValue;
  readonly limits: JsonValue;
  readonly permissions: JsonValue;
  readonly capabilityDelta?: JsonValue;
}

export interface ExecutionScheduleSnapshot {
  readonly runId: string;
  readonly stageId: string;
  readonly codebaseId: string;
  readonly repositoryId: string;
  readonly prompt: string;
  readonly artifactPath: string;
  readonly baseSha: string | null;
  readonly hardDeadlineAt: string | null;
  readonly state: "queued" | "waiting_on_user" | "running" | "terminal";
  readonly capacityPolicy: CapacityPolicy;
  readonly requestedPriority: number;
  readonly currentCandidateIndex: number | null;
  readonly currentAttemptId: string | null;
  readonly revision: number;
  readonly enqueuedAt: string;
  readonly updatedAt: string;
  readonly capabilityRequest: JsonValue | null;
}

export interface ExecutionAttemptSnapshot {
  readonly attemptId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly candidateIndex: number;
  readonly profileId: string;
  readonly accountId: string | null;
  readonly workspaceId: string | null;
  readonly backendExecutionId: string | null;
  readonly status: string;
  readonly limits: JsonValue;
  readonly permissions: JsonValue;
  readonly readonlyBaseline: JsonValue | null;
  readonly result: JsonValue | null;
  readonly failure: JsonValue | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface SchedulingDecisionSnapshot {
  readonly decisionId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly candidateIndex: number | null;
  readonly profileId: string | null;
  readonly accountId: string | null;
  readonly kind: string;
  readonly reasonCode: string;
  readonly recordedAt: string;
}

export interface CapacityQuestionSnapshot {
  readonly runId: string;
  readonly interactionId: string;
  readonly state: "pending" | "answered";
  readonly revision: number;
  readonly interaction: JsonValue;
  readonly answer: JsonValue | null;
}

export interface RecoverableSchedulingAttempt extends ExecutionAttemptSnapshot {
  readonly leaseOwnerId: string;
  readonly leaseFencingRevision: number;
  readonly leaseExpiresAt: string;
}

interface QueueRow {
  readonly queueSequence: number;
  readonly runId: string;
  readonly stageId: string;
  readonly codebaseId: string;
  readonly repositoryId: string;
  readonly prompt: string;
  readonly artifactPath: string;
  readonly candidateIndex: number;
  readonly profileId: string;
  readonly accountId: string;
  readonly requestedPriority: number;
  readonly enqueuedAt: string;
  readonly maxConcurrentRuns: number;
  readonly capacityPolicy: CapacityPolicy;
  readonly baseSha: string;
  readonly hardDeadlineAt: string | null;
  readonly profileJson: string;
  readonly limitsJson: string;
  readonly permissionsJson: string;
  readonly capabilityDeltaJson: string | null;
}

const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

const EXECUTION_SCHEDULE_SELECT_COLUMNS_BEFORE_LANDING =
  "run_id, stage_id, codebase_id, repository_id, prompt, artifact_path," +
  " base_sha, hard_deadline_at, state, capacity_policy," +
  " requested_priority, current_candidate_index, current_attempt_id, revision," +
  " enqueued_at, updated_at";

const EXECUTION_SCHEDULE_SELECT_COLUMNS =
  EXECUTION_SCHEDULE_SELECT_COLUMNS_BEFORE_LANDING + ", capability_request_json";

const CLAIM_QUEUE_SELECT_COLUMNS_BEFORE_LANDING = `q.queue_sequence, q.run_id, q.candidate_index, q.account_id,
                q.requested_priority, q.enqueued_at, c.profile_id,
                COALESCE(ac.max_concurrent_runs, c.max_concurrent_runs) AS max_concurrent_runs,
                c.profile_json, c.limits_json, c.permissions_json, s.stage_id, s.codebase_id,
                s.repository_id, s.prompt, s.artifact_path, s.base_sha, s.hard_deadline_at,
                s.capacity_policy`;

const CLAIM_QUEUE_SELECT_COLUMNS =
  CLAIM_QUEUE_SELECT_COLUMNS_BEFORE_LANDING + ", c.capability_delta_json";

function executionScheduleSelectColumns(schemaVersion: number): string {
  return schemaVersion >= CAPABILITY_LANDING_SCHEMA_VERSION
    ? EXECUTION_SCHEDULE_SELECT_COLUMNS
    : EXECUTION_SCHEDULE_SELECT_COLUMNS_BEFORE_LANDING;
}

function claimQueueSelectColumns(schemaVersion: number): string {
  return schemaVersion >= CAPABILITY_LANDING_SCHEMA_VERSION
    ? CLAIM_QUEUE_SELECT_COLUMNS
    : CLAIM_QUEUE_SELECT_COLUMNS_BEFORE_LANDING;
}

function assertPriority(priority: number): void {
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 9) {
    throw new StateStoreError("requested priority must be an integer from 0 through 9");
  }
}

function assertIso(value: string, what: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new StateStoreError(`${what} must be an ISO-8601 timestamp`);
  return parsed;
}

function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(assertIso(value, "clock value") + milliseconds).toISOString();
}

function transaction<T>(db: StateDatabase, operation: () => T): T {
  const handle = internalHandle(db);
  if (handle.isTransaction) {
    throw new StateStoreError("scheduling operations cannot run inside another transaction");
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

/**
 * `kind` is typed against the published vocabulary rather than left as a
 * bare `string`. It was a `string` until Q023, which is how four kinds this
 * function writes — `attempt_succeeded`, `attempt_cancelled`,
 * `attempt_recovery_required` and `user_choice` — came to be missing from
 * `SchedulingDecision/v1` without anything failing: the column has no CHECK
 * and outgoing results are never validated against their own schema, so the
 * daemon could serve a `decisions` array that violated its published
 * contract. Narrowing the parameter makes the next such omission a
 * compile error instead of a wire-format lie.
 */
function recordDecision(
  db: StateDatabase,
  input: {
    readonly runId: string;
    readonly stageId: string;
    readonly candidateIndex?: number;
    readonly profileId?: string;
    readonly accountId?: string;
    readonly kind: SchedulingDecisionKind;
    readonly reasonCode: string;
    readonly now: string;
  },
): void {
  internalHandle(db)
    .prepare(
      `INSERT INTO scheduling_decision
       (decision_id, run_id, stage_id, candidate_index, profile_id, account_id,
        kind, reason_code, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      internalIds(db).next("decision"),
      input.runId,
      input.stageId,
      input.candidateIndex ?? null,
      input.profileId ?? null,
      input.accountId ?? null,
      input.kind,
      input.reasonCode,
      input.now,
    );
}

function createCapacityQuestion(db: StateDatabase, row: QueueRow, now: string): void {
  const candidates = internalHandle(db)
    .prepare(
      `SELECT candidate_index, profile_id FROM execution_candidate
        WHERE run_id = ? AND candidate_index > 0 AND state <> 'rejected'
        ORDER BY candidate_index`,
    )
    .all(row.runId);
  const interactionId = internalIds(db).next("interaction");
  const questionId = internalIds(db).next("question");
  const interaction = {
    schemaVersion: 2,
    interactionId,
    purpose: "approval",
    status: "pending",
    revision: 1,
    questions: [
      {
        questionId,
        kind: "single_choice",
        prompt: "The primary account is at capacity. Choose how this run should proceed.",
        header: "Account capacity",
        options: [
          { label: "Wait for primary", description: `Wait for profile ${row.profileId}.` },
          ...candidates.map((candidate) => ({
            label: `Use fallback ${toSafeInteger(candidate.candidate_index, "candidate index")}`,
            description: `Run with profile ${toText(candidate.profile_id, "candidate profile")}.`,
          })),
          { label: "Cancel run", description: "Cancel without starting a provider attempt." },
        ],
      },
    ],
    requestedAt: now,
    deliveryState: "not_applicable",
  } as const;
  internalHandle(db)
    .prepare(
      `INSERT OR IGNORE INTO scheduling_capacity_question
       (run_id, interaction_id, question_json, state, revision, answer_json, created_at, answered_at)
       VALUES (?, ?, ?, 'pending', 1, NULL, ?, NULL)`,
    )
    .run(row.runId, interactionId, stringifyCanonical(interaction), now);
}

function enqueueCandidate(
  db: StateDatabase,
  runId: string,
  candidateIndex: number,
  requestedPriority: number,
  now: string,
): boolean {
  const handle = internalHandle(db);
  const candidate = handle
    .prepare(
      `SELECT profile_id, account_id, state FROM execution_candidate
        WHERE run_id = ? AND candidate_index = ?`,
    )
    .get(runId, candidateIndex);
  if (candidate === undefined) return false;
  const accountId = toNullableText(candidate.account_id, "execution_candidate.account_id");
  if (accountId === null || toText(candidate.state, "execution_candidate.state") === "rejected") {
    return false;
  }
  const inserted = handle
    .prepare(
      `INSERT OR IGNORE INTO account_queue_entry
       (run_id, candidate_index, account_id, requested_priority, enqueued_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(runId, candidateIndex, accountId, requestedPriority, now);
  if (toSafeInteger(inserted.changes, "account queue insert changes") === 0) return false;
  handle
    .prepare(
      "UPDATE execution_candidate SET state = 'queued' WHERE run_id = ? AND candidate_index = ?",
    )
    .run(runId, candidateIndex);
  return true;
}

export function createExecutionSchedule(
  db: StateDatabase,
  input: CreateExecutionScheduleInput,
): ExecutionScheduleSnapshot {
  const requestedPriority = input.requestedPriority ?? 0;
  assertPriority(requestedPriority);
  if (input.candidates.length === 0) throw new StateStoreError("a schedule needs a candidate");
  if (
    new Set(input.requestedIdentifiers ?? []).size !== (input.requestedIdentifiers ?? []).length
  ) {
    throw new StateStoreError("requested secret identifiers must be unique");
  }
  if (!/^[0-9a-f]{40}$/i.test(input.baseSha)) {
    throw new StateStoreError("base SHA must be a full 40-character Git object id");
  }
  if (input.hardDeadlineAt !== undefined) assertIso(input.hardDeadlineAt, "hard deadline");

  return transaction(db, () => {
    const now = internalClock(db).nowIso();
    const initialState = "queued";
    const schemaVersion = readUserVersion(internalHandle(db));
    const hasLandingColumns = schemaVersion >= CAPABILITY_LANDING_SCHEMA_VERSION;
    if (hasLandingColumns) {
      internalHandle(db)
        .prepare(
          `INSERT INTO execution_schedule
           (run_id, stage_id, base_sha, hard_deadline_at, state, capacity_policy,
            codebase_id, repository_id, prompt, artifact_path,
            requested_priority, current_candidate_index, current_attempt_id, revision,
            chain_json, requested_secret_ids_json, enqueued_at, updated_at,
            capability_request_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.stageId,
          input.baseSha,
          input.hardDeadlineAt ?? null,
          initialState,
          input.capacityPolicy,
          input.codebaseId,
          input.repositoryId,
          input.prompt,
          input.artifactPath,
          requestedPriority,
          stringifyCanonical(input.chain),
          stringifyCanonical([...(input.requestedIdentifiers ?? [])]),
          now,
          now,
          input.capabilityRequest === undefined
            ? null
            : stringifyCanonical(input.capabilityRequest),
        );
    } else {
      internalHandle(db)
        .prepare(
          `INSERT INTO execution_schedule
           (run_id, stage_id, base_sha, hard_deadline_at, state, capacity_policy,
            codebase_id, repository_id, prompt, artifact_path,
            requested_priority, current_candidate_index, current_attempt_id, revision,
            chain_json, requested_secret_ids_json, enqueued_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          input.stageId,
          input.baseSha,
          input.hardDeadlineAt ?? null,
          initialState,
          input.capacityPolicy,
          input.codebaseId,
          input.repositoryId,
          input.prompt,
          input.artifactPath,
          requestedPriority,
          stringifyCanonical(input.chain),
          stringifyCanonical([...(input.requestedIdentifiers ?? [])]),
          now,
          now,
        );
    }

    for (const [candidateIndex, candidate] of input.candidates.entries()) {
      if (!Number.isSafeInteger(candidate.maxConcurrentRuns) || candidate.maxConcurrentRuns < 1) {
        throw new StateStoreError("max concurrent runs must be a positive integer");
      }
      const compatible = candidate.compatible !== false;
      if (hasLandingColumns) {
        internalHandle(db)
          .prepare(
            `INSERT INTO execution_candidate
             (run_id, candidate_index, profile_id, account_id, engine, max_concurrent_runs,
              profile_json, limits_json, permissions_json, state, capability_delta_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.runId,
            candidateIndex,
            candidate.profileId,
            candidate.accountId ?? null,
            candidate.engine,
            candidate.maxConcurrentRuns,
            stringifyCanonical(candidate.profile),
            stringifyCanonical(candidate.limits),
            stringifyCanonical(candidate.permissions),
            compatible ? "pending" : "rejected",
            candidate.capabilityDelta === undefined
              ? null
              : stringifyCanonical(candidate.capabilityDelta),
          );
      } else {
        internalHandle(db)
          .prepare(
            `INSERT INTO execution_candidate
             (run_id, candidate_index, profile_id, account_id, engine, max_concurrent_runs,
              profile_json, limits_json, permissions_json, state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.runId,
            candidateIndex,
            candidate.profileId,
            candidate.accountId ?? null,
            candidate.engine,
            candidate.maxConcurrentRuns,
            stringifyCanonical(candidate.profile),
            stringifyCanonical(candidate.limits),
            stringifyCanonical(candidate.permissions),
            compatible ? "pending" : "rejected",
          );
      }
      if (candidate.accountId !== undefined) {
        internalHandle(db)
          .prepare(
            `INSERT INTO account_capacity (account_id, max_concurrent_runs, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(account_id) DO UPDATE SET
               max_concurrent_runs = excluded.max_concurrent_runs,
               updated_at = excluded.updated_at`,
          )
          .run(candidate.accountId, candidate.maxConcurrentRuns, now);
      }
      if (!compatible) {
        recordDecision(db, {
          runId: input.runId,
          stageId: input.stageId,
          candidateIndex,
          profileId: candidate.profileId,
          ...(candidate.accountId === undefined ? {} : { accountId: candidate.accountId }),
          kind: "compatibility_rejected",
          reasonCode: candidate.rejectionReason ?? "incompatible",
          now,
        });
      }
    }

    {
      const indexes =
        input.capacityPolicy === "fallback" ? input.candidates.map((_, index) => index) : [0];
      for (const candidateIndex of indexes) {
        if (enqueueCandidate(db, input.runId, candidateIndex, requestedPriority, now)) {
          const candidate = input.candidates[candidateIndex];
          if (candidate !== undefined) {
            recordDecision(db, {
              runId: input.runId,
              stageId: input.stageId,
              candidateIndex,
              profileId: candidate.profileId,
              ...(candidate.accountId === undefined ? {} : { accountId: candidate.accountId }),
              kind: "enqueued",
              reasonCode: candidateIndex === 0 ? "primary" : "configured_fallback",
              now,
            });
          }
        }
      }
    }
    return readExecutionScheduleRequired(db, input.runId);
  });
}

function effectivePriority(row: QueueRow, nowMs: number): number {
  const waitMilliseconds = Math.max(0, nowMs - assertIso(row.enqueuedAt, "enqueue time"));
  return Math.min(9, row.requestedPriority + Math.floor(waitMilliseconds / 60_000));
}

function queueRow(raw: Record<string, unknown>): QueueRow {
  return {
    queueSequence: toSafeInteger(raw.queue_sequence, "account_queue_entry.queue_sequence"),
    runId: toText(raw.run_id, "account_queue_entry.run_id"),
    stageId: toText(raw.stage_id, "execution_schedule.stage_id"),
    codebaseId: toText(raw.codebase_id, "execution_schedule.codebase_id"),
    repositoryId: toText(raw.repository_id, "execution_schedule.repository_id"),
    prompt: toText(raw.prompt, "execution_schedule.prompt"),
    artifactPath: toText(raw.artifact_path, "execution_schedule.artifact_path"),
    candidateIndex: toSafeInteger(raw.candidate_index, "execution_candidate.candidate_index"),
    profileId: toText(raw.profile_id, "execution_candidate.profile_id"),
    accountId: toText(raw.account_id, "account_queue_entry.account_id"),
    requestedPriority: toSafeInteger(
      raw.requested_priority,
      "account_queue_entry.requested_priority",
    ),
    enqueuedAt: toText(raw.enqueued_at, "account_queue_entry.enqueued_at"),
    maxConcurrentRuns: toSafeInteger(
      raw.max_concurrent_runs,
      "execution_candidate.max_concurrent_runs",
    ),
    capacityPolicy: toText(
      raw.capacity_policy,
      "execution_schedule.capacity_policy",
    ) as CapacityPolicy,
    baseSha: toText(raw.base_sha, "execution_schedule.base_sha"),
    hardDeadlineAt: toNullableText(raw.hard_deadline_at, "execution_schedule.hard_deadline_at"),
    profileJson: toText(raw.profile_json, "execution_candidate.profile_json"),
    limitsJson: toText(raw.limits_json, "execution_candidate.limits_json"),
    permissionsJson: toText(raw.permissions_json, "execution_candidate.permissions_json"),
    // Absent when SELECT omitted the column on a pre-migration-19 schema.
    capabilityDeltaJson:
      raw.capability_delta_json === undefined
        ? null
        : toNullableText(raw.capability_delta_json, "execution_candidate.capability_delta_json"),
  };
}

function expireOrphanLeases(db: StateDatabase, now: string): void {
  const handle = internalHandle(db);
  const expired = handle
    .prepare(
      `SELECT l.lease_id, l.run_id, l.candidate_index, c.profile_id, l.account_id, s.stage_id
         FROM account_concurrency_lease l
         JOIN execution_candidate c
           ON c.run_id = l.run_id AND c.candidate_index = l.candidate_index
         JOIN execution_schedule s ON s.run_id = l.run_id
        WHERE l.state = 'active' AND l.expires_at <= ?`,
    )
    .all(now);
  for (const row of expired) {
    handle
      .prepare(
        `UPDATE account_concurrency_lease
            SET state = 'expired', released_at = ?, fencing_revision = fencing_revision + 1
          WHERE lease_id = ? AND state = 'active'`,
      )
      .run(now, toText(row.lease_id, "account_concurrency_lease.lease_id"));
    recordDecision(db, {
      runId: toText(row.run_id, "account_concurrency_lease.run_id"),
      stageId: toText(row.stage_id, "execution_schedule.stage_id"),
      candidateIndex: toSafeInteger(
        row.candidate_index,
        "account_concurrency_lease.candidate_index",
      ),
      profileId: toText(row.profile_id, "execution_candidate.profile_id"),
      accountId: toText(row.account_id, "account_concurrency_lease.account_id"),
      kind: "lease_expired",
      reasonCode: "orphan_lease_expired",
      now,
    });
  }
}

export function claimNextExecutionCandidate(
  db: StateDatabase,
  input: { readonly ownerId: string; readonly leaseTtlMs?: number; readonly accountId?: string },
): SchedulingClaim | undefined {
  const ttl = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 1)
    throw new StateStoreError("lease TTL must be positive");
  return transaction(db, () => {
    const now = internalClock(db).nowIso();
    const nowMs = assertIso(now, "clock value");
    expireOrphanLeases(db, now);
    const claimColumns = claimQueueSelectColumns(readUserVersion(internalHandle(db)));
    const rawRows = internalHandle(db)
      .prepare(
        `SELECT ${claimColumns}
           FROM account_queue_entry q
           JOIN execution_candidate c
             ON c.run_id = q.run_id AND c.candidate_index = q.candidate_index
           JOIN execution_schedule s ON s.run_id = q.run_id
           LEFT JOIN account_capacity ac ON ac.account_id = q.account_id
          WHERE c.state = 'queued' AND s.state = 'queued'
            AND (? IS NULL OR q.account_id = ?)`,
      )
      .all(input.accountId ?? null, input.accountId ?? null)
      .map(queueRow);

    const byAccount = new Map<string, QueueRow[]>();
    for (const row of rawRows) {
      const entries = byAccount.get(row.accountId) ?? [];
      entries.push(row);
      byAccount.set(row.accountId, entries);
    }
    const heads: QueueRow[] = [];
    for (const entries of byAccount.values()) {
      entries.sort((left, right) => {
        const priority = effectivePriority(right, nowMs) - effectivePriority(left, nowMs);
        return priority === 0 ? left.queueSequence - right.queueSequence : priority;
      });
      const head = entries[0];
      if (head !== undefined) heads.push(head);
    }

    const available: QueueRow[] = [];
    for (const head of heads) {
      const capacity = internalHandle(db)
        .prepare(
          `SELECT count(*) AS count FROM account_concurrency_lease
            WHERE account_id = ? AND state = 'active' AND expires_at > ?`,
        )
        .get(head.accountId, now);
      const active = toSafeInteger(capacity?.count, "active account lease count");
      if (active < head.maxConcurrentRuns) {
        available.push(head);
      } else {
        recordDecision(db, {
          runId: head.runId,
          stageId: head.stageId,
          candidateIndex: head.candidateIndex,
          profileId: head.profileId,
          accountId: head.accountId,
          kind: "capacity_rejected",
          reasonCode: "account_at_capacity",
          now,
        });
        if (head.capacityPolicy === "ask") {
          internalHandle(db)
            .prepare(
              `UPDATE execution_schedule SET state = 'waiting_on_user', revision = revision + 1,
                updated_at = ? WHERE run_id = ? AND state = 'queued'`,
            )
            .run(now, head.runId);
          internalHandle(db)
            .prepare("DELETE FROM account_queue_entry WHERE run_id = ?")
            .run(head.runId);
          createCapacityQuestion(db, head, now);
          recordDecision(db, {
            runId: head.runId,
            stageId: head.stageId,
            candidateIndex: head.candidateIndex,
            profileId: head.profileId,
            accountId: head.accountId,
            kind: "capacity_question_created",
            reasonCode: "primary_at_capacity",
            now,
          });
        }
      }
    }
    if (available.length === 0) return undefined;

    const earliestPerRun = new Map<string, QueueRow>();
    for (const row of available) {
      const previous = earliestPerRun.get(row.runId);
      if (previous === undefined || row.candidateIndex < previous.candidateIndex) {
        earliestPerRun.set(row.runId, row);
      }
    }
    const selected = [...earliestPerRun.values()].sort((left, right) => {
      const priority = effectivePriority(right, nowMs) - effectivePriority(left, nowMs);
      return priority === 0 ? left.queueSequence - right.queueSequence : priority;
    })[0];
    if (selected === undefined) return undefined;

    const attemptId = internalIds(db).next("attempt");
    const leaseId = internalIds(db).next("lease");
    const expiresAt = addMilliseconds(now, ttl);
    internalHandle(db)
      .prepare("DELETE FROM account_queue_entry WHERE run_id = ?")
      .run(selected.runId);
    internalHandle(db)
      .prepare(
        `UPDATE execution_candidate SET state = CASE
           WHEN candidate_index = ? THEN 'selected'
           WHEN state = 'queued' THEN 'pending'
           ELSE state END
         WHERE run_id = ?`,
      )
      .run(selected.candidateIndex, selected.runId);
    internalHandle(db)
      .prepare(
        `INSERT INTO execution_attempt
         (attempt_id, run_id, stage_id, candidate_index, profile_id, account_id,
          workspace_id, backend_execution_id, status, limits_json, permissions_json,
          readonly_baseline_json, result_json, failure_json, started_at, finished_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'queued', ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        attemptId,
        selected.runId,
        selected.stageId,
        selected.candidateIndex,
        selected.profileId,
        selected.accountId,
        selected.limitsJson,
        selected.permissionsJson,
        now,
        now,
      );
    internalHandle(db)
      .prepare(
        `INSERT INTO account_concurrency_lease
         (lease_id, account_id, run_id, candidate_index, attempt_id, owner_id,
          acquired_at, renewed_at, expires_at, released_at, fencing_revision, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 'active')`,
      )
      .run(
        leaseId,
        selected.accountId,
        selected.runId,
        selected.candidateIndex,
        attemptId,
        input.ownerId,
        now,
        now,
        expiresAt,
      );
    internalHandle(db)
      .prepare(
        `UPDATE execution_schedule SET state = 'running', current_candidate_index = ?,
          current_attempt_id = ?, revision = revision + 1, updated_at = ? WHERE run_id = ?`,
      )
      .run(selected.candidateIndex, attemptId, now, selected.runId);
    for (const [kind, reasonCode] of [
      ["candidate_selected", selected.candidateIndex === 0 ? "primary" : "fallback_capacity"],
      ["lease_acquired", "capacity_claimed"],
    ] as const) {
      recordDecision(db, {
        runId: selected.runId,
        stageId: selected.stageId,
        candidateIndex: selected.candidateIndex,
        profileId: selected.profileId,
        accountId: selected.accountId,
        kind,
        reasonCode,
        now,
      });
    }
    return {
      runId: selected.runId,
      stageId: selected.stageId,
      codebaseId: selected.codebaseId,
      repositoryId: selected.repositoryId,
      prompt: selected.prompt,
      artifactPath: selected.artifactPath,
      attemptId,
      candidateIndex: selected.candidateIndex,
      profileId: selected.profileId,
      accountId: selected.accountId,
      fencingRevision: 1,
      leaseExpiresAt: expiresAt,
      baseSha: selected.baseSha,
      ...(selected.hardDeadlineAt === null ? {} : { hardDeadlineAt: selected.hardDeadlineAt }),
      profile: parseJsonValue(selected.profileJson, "execution candidate profile"),
      limits: parseJsonValue(selected.limitsJson, "execution candidate limits"),
      permissions: parseJsonValue(selected.permissionsJson, "execution candidate permissions"),
      ...(selected.capabilityDeltaJson === null
        ? {}
        : {
            capabilityDelta: parseJsonValue(
              selected.capabilityDeltaJson,
              "execution candidate capability delta",
            ),
          }),
    };
  });
}

export function assignAttemptWorkspace(
  db: StateDatabase,
  attemptId: string,
  workspaceId: string,
): void {
  const result = internalHandle(db)
    .prepare(
      `UPDATE execution_attempt SET workspace_id = ?, updated_at = ?
        WHERE attempt_id = ? AND status = 'queued' AND workspace_id IS NULL`,
    )
    .run(workspaceId, internalClock(db).nowIso(), attemptId);
  if (toSafeInteger(result.changes, "assign attempt workspace changes") !== 1) {
    throw new StateStoreError("attempt cannot accept a workspace");
  }
}

export function updateAttemptLimits(db: StateDatabase, attemptId: string, limits: JsonValue): void {
  const changed = internalHandle(db)
    .prepare(
      `UPDATE execution_attempt SET limits_json = ?, updated_at = ?
        WHERE attempt_id = ? AND status = 'queued'`,
    )
    .run(stringifyCanonical(limits), internalClock(db).nowIso(), attemptId);
  if (toSafeInteger(changed.changes, "attempt limit update changes") !== 1) {
    throw new StateStoreError("attempt cannot accept updated limits");
  }
}

export function startExecutionAttempt(
  db: StateDatabase,
  attemptId: string,
  backendExecutionId: string,
): void {
  transaction(db, () => {
    const now = internalClock(db).nowIso();
    const row = internalHandle(db)
      .prepare(
        `SELECT a.run_id, a.stage_id, a.candidate_index, a.profile_id, a.account_id
           FROM execution_attempt a
          WHERE a.attempt_id = ? AND a.status = 'queued' AND a.workspace_id IS NOT NULL`,
      )
      .get(attemptId);
    if (row === undefined) throw new StateStoreError("attempt is not ready to start");
    internalHandle(db)
      .prepare(
        `UPDATE execution_attempt SET backend_execution_id = ?, status = 'running',
          started_at = ?, updated_at = ? WHERE attempt_id = ?`,
      )
      .run(backendExecutionId, now, now, attemptId);
    recordDecision(db, {
      runId: toText(row.run_id, "execution_attempt.run_id"),
      stageId: toText(row.stage_id, "execution_attempt.stage_id"),
      candidateIndex: toSafeInteger(row.candidate_index, "execution_attempt.candidate_index"),
      profileId: toText(row.profile_id, "execution_attempt.profile_id"),
      ...(toNullableText(row.account_id, "execution_attempt.account_id") === null
        ? {}
        : { accountId: toText(row.account_id, "execution_attempt.account_id") }),
      kind: "attempt_started",
      reasonCode: "backend_started",
      now,
    });
  });
}

export function recordAttemptReadonlyBaseline(
  db: StateDatabase,
  attemptId: string,
  baseline: JsonValue,
): void {
  const changed = internalHandle(db)
    .prepare(
      `UPDATE execution_attempt SET readonly_baseline_json = ?, updated_at = ?
        WHERE attempt_id = ? AND status = 'queued' AND readonly_baseline_json IS NULL`,
    )
    .run(stringifyCanonical(baseline), internalClock(db).nowIso(), attemptId);
  if (toSafeInteger(changed.changes, "read-only baseline changes") !== 1) {
    throw new StateStoreError("attempt cannot accept a read-only baseline");
  }
}

export function renewAccountLease(
  db: StateDatabase,
  input: {
    readonly attemptId: string;
    readonly ownerId: string;
    readonly fencingRevision: number;
    readonly leaseTtlMs?: number;
  },
): { readonly fencingRevision: number; readonly expiresAt: string } {
  const ttl = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  return transaction(db, () => {
    const now = internalClock(db).nowIso();
    expireOrphanLeases(db, now);
    const expiresAt = addMilliseconds(now, ttl);
    const nextRevision = input.fencingRevision + 1;
    const result = internalHandle(db)
      .prepare(
        `UPDATE account_concurrency_lease SET renewed_at = ?, expires_at = ?,
          fencing_revision = ? WHERE attempt_id = ? AND owner_id = ?
          AND fencing_revision = ? AND state = 'active' AND expires_at > ?`,
      )
      .run(
        now,
        expiresAt,
        nextRevision,
        input.attemptId,
        input.ownerId,
        input.fencingRevision,
        now,
      );
    if (toSafeInteger(result.changes, "lease renewal changes") !== 1) {
      throw new StateStoreError("account lease renewal was fenced or expired");
    }
    const row = internalHandle(db)
      .prepare(
        `SELECT a.run_id, a.stage_id, a.candidate_index, a.profile_id, a.account_id
           FROM execution_attempt a WHERE a.attempt_id = ?`,
      )
      .get(input.attemptId);
    if (row === undefined) throw new StateDatabaseCorruptionError("lease attempt is missing");
    recordDecision(db, {
      runId: toText(row.run_id, "execution_attempt.run_id"),
      stageId: toText(row.stage_id, "execution_attempt.stage_id"),
      candidateIndex: toSafeInteger(row.candidate_index, "execution_attempt.candidate_index"),
      profileId: toText(row.profile_id, "execution_attempt.profile_id"),
      accountId: toText(row.account_id, "execution_attempt.account_id"),
      kind: "lease_renewed",
      reasonCode: "heartbeat",
      now,
    });
    return { fencingRevision: nextRevision, expiresAt };
  });
}

export function restoreAccountLease(
  db: StateDatabase,
  input: {
    readonly attemptId: string;
    readonly ownerId: string;
    readonly leaseTtlMs?: number;
    readonly recoveryReasonCode?: string;
  },
): { readonly fencingRevision: number; readonly expiresAt: string } {
  const ttl = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  return transaction(db, () => {
    const now = internalClock(db).nowIso();
    const expiresAt = addMilliseconds(now, ttl);
    const row = internalHandle(db)
      .prepare(
        `SELECT l.fencing_revision, a.run_id, a.stage_id, a.candidate_index,
                a.profile_id, l.account_id
           FROM account_concurrency_lease l
           JOIN execution_attempt a ON a.attempt_id = l.attempt_id
          WHERE l.attempt_id = ? AND a.status IN ('queued','running','waiting_on_user','recovery_required')`,
      )
      .get(input.attemptId);
    if (row === undefined) throw new StateStoreError("recoverable account lease does not exist");
    const revision =
      toSafeInteger(row.fencing_revision, "account_concurrency_lease.fencing_revision") + 1;
    if (input.recoveryReasonCode !== undefined) {
      internalHandle(db)
        .prepare(
          `UPDATE execution_attempt SET status = 'recovery_required', updated_at = ?
            WHERE attempt_id = ?`,
        )
        .run(now, input.attemptId);
    }
    internalHandle(db)
      .prepare(
        `UPDATE account_concurrency_lease SET owner_id = ?, renewed_at = ?, expires_at = ?,
          released_at = NULL, fencing_revision = ?, state = 'active' WHERE attempt_id = ?`,
      )
      .run(input.ownerId, now, expiresAt, revision, input.attemptId);
    recordDecision(db, {
      runId: toText(row.run_id, "execution_attempt.run_id"),
      stageId: toText(row.stage_id, "execution_attempt.stage_id"),
      candidateIndex: toSafeInteger(row.candidate_index, "execution_attempt.candidate_index"),
      profileId: toText(row.profile_id, "execution_attempt.profile_id"),
      accountId: toText(row.account_id, "account_concurrency_lease.account_id"),
      kind: input.recoveryReasonCode === undefined ? "lease_renewed" : "attempt_recovery_required",
      reasonCode: input.recoveryReasonCode ?? "daemon_restart_reconciled",
      now,
    });
    return { fencingRevision: revision, expiresAt };
  });
}

function releaseLease(db: StateDatabase, attemptId: string, now: string, reasonCode: string): void {
  const row = internalHandle(db)
    .prepare(
      `SELECT a.run_id, a.stage_id, a.candidate_index, a.profile_id, l.account_id
         FROM account_concurrency_lease l
         JOIN execution_attempt a ON a.attempt_id = l.attempt_id
        WHERE l.attempt_id = ? AND l.state = 'active'`,
    )
    .get(attemptId);
  if (row === undefined) return;
  internalHandle(db)
    .prepare(
      `UPDATE account_concurrency_lease SET state = 'released', released_at = ?,
        fencing_revision = fencing_revision + 1 WHERE attempt_id = ? AND state = 'active'`,
    )
    .run(now, attemptId);
  recordDecision(db, {
    runId: toText(row.run_id, "execution_attempt.run_id"),
    stageId: toText(row.stage_id, "execution_attempt.stage_id"),
    candidateIndex: toSafeInteger(row.candidate_index, "execution_attempt.candidate_index"),
    profileId: toText(row.profile_id, "execution_attempt.profile_id"),
    accountId: toText(row.account_id, "account_concurrency_lease.account_id"),
    kind: "lease_released",
    reasonCode,
    now,
  });
}

export function completeExecutionAttempt(
  db: StateDatabase,
  input: {
    readonly attemptId: string;
    readonly status: "succeeded" | "failed" | "cancelled";
    readonly result?: JsonValue;
    readonly failure?: JsonValue;
    readonly fallbackEligible?: boolean;
  },
): { readonly requeued: boolean; readonly exhausted: boolean } {
  return transaction(db, () => {
    const now = internalClock(db).nowIso();
    const row = internalHandle(db)
      .prepare(
        `SELECT a.run_id, a.stage_id, a.candidate_index, a.profile_id, a.account_id,
                s.requested_priority
           FROM execution_attempt a JOIN execution_schedule s ON s.run_id = a.run_id
          WHERE a.attempt_id = ? AND a.status IN ('queued','running','waiting_on_user','recovery_required')`,
      )
      .get(input.attemptId);
    if (row === undefined)
      throw new StateStoreError("attempt is already terminal or does not exist");
    const runId = toText(row.run_id, "execution_attempt.run_id");
    const stageId = toText(row.stage_id, "execution_attempt.stage_id");
    const candidateIndex = toSafeInteger(row.candidate_index, "execution_attempt.candidate_index");
    const profileId = toText(row.profile_id, "execution_attempt.profile_id");
    const accountId = toNullableText(row.account_id, "execution_attempt.account_id");
    internalHandle(db)
      .prepare(
        `UPDATE execution_attempt SET status = ?, result_json = ?, failure_json = ?,
          finished_at = ?, updated_at = ?
          WHERE attempt_id = ?`,
      )
      .run(
        input.status,
        input.result === undefined ? null : stringifyCanonical(input.result),
        input.failure === undefined ? null : stringifyCanonical(input.failure),
        now,
        now,
        input.attemptId,
      );
    internalHandle(db)
      .prepare("UPDATE execution_candidate SET state = ? WHERE run_id = ? AND candidate_index = ?")
      .run(input.status === "succeeded" ? "succeeded" : "failed", runId, candidateIndex);
    releaseLease(db, input.attemptId, now, `attempt_${input.status}`);

    if (input.status === "failed") {
      recordDecision(db, {
        runId,
        stageId,
        candidateIndex,
        profileId,
        ...(accountId === null ? {} : { accountId }),
        kind: "attempt_failed",
        reasonCode: input.fallbackEligible === true ? "fallback_eligible" : "fail_closed",
        now,
      });
    } else {
      recordDecision(db, {
        runId,
        stageId,
        candidateIndex,
        profileId,
        ...(accountId === null ? {} : { accountId }),
        kind: input.status === "succeeded" ? "attempt_succeeded" : "attempt_cancelled",
        reasonCode: `attempt_${input.status}`,
        now,
      });
    }
    if (input.status === "failed" && input.fallbackEligible === true) {
      const remaining = internalHandle(db)
        .prepare(
          `SELECT candidate_index, profile_id, account_id FROM execution_candidate
            WHERE run_id = ? AND candidate_index > ? AND state = 'pending'
            ORDER BY candidate_index`,
        )
        .all(runId, candidateIndex);
      let requeued = false;
      for (const candidate of remaining) {
        const index = toSafeInteger(
          candidate.candidate_index,
          "execution_candidate.candidate_index",
        );
        requeued =
          enqueueCandidate(
            db,
            runId,
            index,
            toSafeInteger(row.requested_priority, "execution_schedule.requested_priority"),
            now,
          ) || requeued;
      }
      if (requeued) {
        internalHandle(db)
          .prepare(
            `UPDATE execution_schedule SET state = 'queued', current_candidate_index = NULL,
              current_attempt_id = NULL, revision = revision + 1, updated_at = ? WHERE run_id = ?`,
          )
          .run(now, runId);
        const next = remaining[0];
        recordDecision(db, {
          runId,
          stageId,
          ...(next === undefined
            ? {}
            : {
                candidateIndex: toSafeInteger(
                  next.candidate_index,
                  "execution_candidate.candidate_index",
                ),
                profileId: toText(next.profile_id, "execution_candidate.profile_id"),
                ...(toNullableText(next.account_id, "execution_candidate.account_id") === null
                  ? {}
                  : { accountId: toText(next.account_id, "execution_candidate.account_id") }),
              }),
          kind: "fallback_selected",
          reasonCode: "eligible_failure",
          now,
        });
        return { requeued: true, exhausted: false };
      }
      recordDecision(db, {
        runId,
        stageId,
        candidateIndex,
        profileId,
        ...(accountId === null ? {} : { accountId }),
        kind: "fallback_exhausted",
        reasonCode: "no_compatible_candidates",
        now,
      });
    }
    internalHandle(db)
      .prepare(
        `UPDATE execution_schedule SET state = 'terminal', revision = revision + 1,
          updated_at = ? WHERE run_id = ?`,
      )
      .run(now, runId);
    return {
      requeued: false,
      exhausted: input.status === "failed" && input.fallbackEligible === true,
    };
  });
}

function cancelQueuedInside(
  db: StateDatabase,
  schedule: ExecutionScheduleSnapshot,
  now: string,
): void {
  const runId = schedule.runId;
  const candidate = internalHandle(db)
    .prepare(
      `SELECT profile_id, account_id, limits_json, permissions_json
           FROM execution_candidate WHERE run_id = ? AND candidate_index = 0`,
    )
    .get(runId);
  if (candidate === undefined) throw new StateDatabaseCorruptionError("primary candidate missing");
  const attemptId = internalIds(db).next("attempt");
  internalHandle(db)
    .prepare(
      `INSERT INTO execution_attempt
         (attempt_id, run_id, stage_id, candidate_index, profile_id, account_id,
          workspace_id, backend_execution_id, status, limits_json, permissions_json,
          readonly_baseline_json, result_json, failure_json, started_at, finished_at,
          created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, NULL, NULL, 'cancelled', ?, ?, NULL, NULL, NULL,
          NULL, ?, ?, ?)`,
    )
    .run(
      attemptId,
      runId,
      schedule.stageId,
      toText(candidate.profile_id, "execution_candidate.profile_id"),
      toNullableText(candidate.account_id, "execution_candidate.account_id"),
      toText(candidate.limits_json, "execution_candidate.limits_json"),
      toText(candidate.permissions_json, "execution_candidate.permissions_json"),
      now,
      now,
      now,
    );
  internalHandle(db).prepare("DELETE FROM account_queue_entry WHERE run_id = ?").run(runId);
  internalHandle(db)
    .prepare(
      "UPDATE execution_candidate SET state = 'failed' WHERE run_id = ? AND candidate_index = 0",
    )
    .run(runId);
  internalHandle(db)
    .prepare(
      `UPDATE execution_schedule SET state = 'terminal', revision = revision + 1,
          current_candidate_index = 0, current_attempt_id = ?, updated_at = ? WHERE run_id = ?`,
    )
    .run(attemptId, now, runId);
  recordDecision(db, {
    runId,
    stageId: schedule.stageId,
    kind: "user_choice",
    reasonCode: "cancel",
    now,
  });
}

export function cancelQueuedExecutionSchedule(db: StateDatabase, runId: string): boolean {
  return transaction(db, () => {
    const schedule = readExecutionScheduleRequired(db, runId);
    if (schedule.state === "terminal") return false;
    if (schedule.state === "running") {
      throw new StateStoreError("running schedules must cancel their backend attempt first");
    }
    cancelQueuedInside(db, schedule, internalClock(db).nowIso());
    return true;
  });
}

export type CapacityAnswer =
  | { readonly action: "wait" }
  | { readonly action: "fallback"; readonly candidateIndex: number }
  | { readonly action: "cancel" };

function applyCapacityAnswerInside(
  db: StateDatabase,
  input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly answer: CapacityAnswer;
  },
): "accepted" | "stale" {
  const schedule = readExecutionScheduleRequired(db, input.runId);
  if (schedule.state !== "waiting_on_user" || schedule.revision !== input.expectedRevision) {
    return "stale";
  }
  const now = internalClock(db).nowIso();
  let reasonCode: string;
  if (input.answer.action === "cancel") {
    cancelQueuedInside(db, schedule, now);
    reasonCode = "cancel";
  } else {
    const candidateIndex = input.answer.action === "wait" ? 0 : input.answer.candidateIndex;
    if (
      input.answer.action === "fallback" &&
      (!Number.isSafeInteger(candidateIndex) || candidateIndex < 1)
    ) {
      throw new StateStoreError("fallback answer must select a configured fallback");
    }
    if (!enqueueCandidate(db, input.runId, candidateIndex, schedule.requestedPriority, now)) {
      throw new StateStoreError("capacity answer selected an unavailable candidate");
    }
    internalHandle(db)
      .prepare(
        `UPDATE execution_schedule SET state = 'queued', revision = revision + 1,
            updated_at = ? WHERE run_id = ?`,
      )
      .run(now, input.runId);
    reasonCode = input.answer.action === "wait" ? "wait_for_primary" : "configured_fallback";
  }
  recordDecision(db, {
    runId: schedule.runId,
    stageId: schedule.stageId,
    ...(input.answer.action === "fallback"
      ? { candidateIndex: input.answer.candidateIndex }
      : input.answer.action === "wait"
        ? { candidateIndex: 0 }
        : {}),
    kind: "capacity_answered",
    reasonCode,
    now,
  });
  return "accepted";
}

export function applyCapacityAnswer(
  db: StateDatabase,
  input: {
    readonly runId: string;
    readonly expectedRevision: number;
    readonly answer: CapacityAnswer;
  },
): "accepted" | "stale" {
  return transaction(db, () => {
    return applyCapacityAnswerInside(db, input);
  });
}

export function readCapacityQuestion(
  db: StateDatabase,
  runId: string,
): CapacityQuestionSnapshot | undefined {
  const row = internalHandle(db)
    .prepare(
      `SELECT run_id, interaction_id, question_json, state, revision, answer_json
         FROM scheduling_capacity_question WHERE run_id = ?`,
    )
    .get(runId);
  if (row === undefined) return undefined;
  const state = toText(row.state, "scheduling_capacity_question.state");
  if (state !== "pending" && state !== "answered") {
    throw new StateDatabaseCorruptionError("capacity question has an unknown state");
  }
  return {
    runId: toText(row.run_id, "scheduling_capacity_question.run_id"),
    interactionId: toText(row.interaction_id, "scheduling_capacity_question.interaction_id"),
    state,
    revision: toSafeInteger(row.revision, "scheduling_capacity_question.revision"),
    interaction: parseJsonValue(
      toText(row.question_json, "scheduling_capacity_question.question_json"),
      "capacity question",
    ),
    answer:
      row.answer_json === null
        ? null
        : parseJsonValue(
            toText(row.answer_json, "scheduling_capacity_question.answer_json"),
            "capacity answer",
          ),
  };
}

export function answerCapacityQuestion(
  db: StateDatabase,
  input: {
    readonly runId: string;
    readonly interactionId: string;
    readonly expectedInteractionRevision: number;
    readonly answers: readonly {
      readonly questionId: string;
      readonly kind: string;
      readonly selectedLabels?: readonly string[];
    }[];
    readonly answeredByKeyId: string;
  },
): {
  readonly interactionId: string;
  readonly interactionRevision: number;
  readonly scheduleRevision: number;
  readonly operationId: string;
} {
  return transaction(db, () => {
    if (input.answeredByKeyId.length === 0) throw new StateStoreError("answering key is required");
    const question = readCapacityQuestion(db, input.runId);
    if (
      question === undefined ||
      question.interactionId !== input.interactionId ||
      question.state !== "pending" ||
      question.revision !== input.expectedInteractionRevision
    ) {
      throw new StateStoreError("capacity answer is stale or does not belong to this run");
    }
    const interaction = question.interaction as {
      questions?: readonly { questionId?: string }[];
    };
    const submitted = input.answers[0];
    const selected = submitted?.selectedLabels;
    if (
      input.answers.length !== 1 ||
      submitted?.kind !== "single_choice" ||
      submitted.questionId !== interaction.questions?.[0]?.questionId ||
      selected?.length !== 1
    ) {
      throw new StateStoreError("capacity approval needs exactly one listed choice");
    }
    const label = selected[0];
    let answer: CapacityAnswer;
    if (label === "Wait for primary") answer = { action: "wait" };
    else if (label === "Cancel run") answer = { action: "cancel" };
    else {
      const match = /^Use fallback ([1-9][0-9]*)$/u.exec(label ?? "");
      if (match?.[1] === undefined) throw new StateStoreError("capacity choice is not recognized");
      answer = { action: "fallback", candidateIndex: Number(match[1]) };
    }
    const schedule = readExecutionScheduleRequired(db, input.runId);
    if (
      applyCapacityAnswerInside(db, {
        runId: input.runId,
        expectedRevision: schedule.revision,
        answer,
      }) !== "accepted"
    ) {
      throw new StateStoreError("capacity schedule changed before the answer was accepted");
    }
    const now = internalClock(db).nowIso();
    const operationId = internalIds(db).next("operation");
    const answerId = internalIds(db).next("answer");
    const answerJson = {
      schemaVersion: 2,
      answerId,
      operationId,
      interactionId: input.interactionId,
      interactionRevision: question.revision + 1,
      answers: input.answers,
      answeredAt: now,
      answeredByKeyId: input.answeredByKeyId,
    };
    const changed = internalHandle(db)
      .prepare(
        `UPDATE scheduling_capacity_question SET state = 'answered', revision = revision + 1,
          answer_json = ?, answered_at = ?
          WHERE run_id = ? AND interaction_id = ? AND state = 'pending' AND revision = ?`,
      )
      .run(
        stringifyCanonical(answerJson),
        now,
        input.runId,
        input.interactionId,
        question.revision,
      );
    if (toSafeInteger(changed.changes, "capacity question answer changes") !== 1) {
      throw new StateStoreError("capacity question changed during answer acceptance");
    }
    return {
      interactionId: input.interactionId,
      interactionRevision: question.revision + 1,
      scheduleRevision: readExecutionScheduleRequired(db, input.runId).revision,
      operationId,
    };
  });
}

export function readExecutionSchedule(
  db: StateDatabase,
  runId: string,
): ExecutionScheduleSnapshot | undefined {
  const handle = internalHandle(db);
  const columns = executionScheduleSelectColumns(readUserVersion(handle));
  const row = handle
    .prepare(`SELECT ${columns} FROM execution_schedule WHERE run_id = ?`)
    .get(runId);
  if (row === undefined) return undefined;
  const state = toText(row.state, "execution_schedule.state");
  const capacityPolicy = toText(row.capacity_policy, "execution_schedule.capacity_policy");
  if (!(["queued", "waiting_on_user", "running", "terminal"] as const).includes(state as never)) {
    throw new StateDatabaseCorruptionError(`unknown execution schedule state: ${state}`);
  }
  if (!(["queue", "fallback", "ask"] as const).includes(capacityPolicy as never)) {
    throw new StateDatabaseCorruptionError(`unknown capacity policy: ${capacityPolicy}`);
  }
  const currentCandidateIndex =
    row.current_candidate_index === null
      ? null
      : toSafeInteger(row.current_candidate_index, "execution_schedule.current_candidate_index");
  return {
    runId: toText(row.run_id, "execution_schedule.run_id"),
    stageId: toText(row.stage_id, "execution_schedule.stage_id"),
    codebaseId: toText(row.codebase_id, "execution_schedule.codebase_id"),
    repositoryId: toText(row.repository_id, "execution_schedule.repository_id"),
    prompt: toText(row.prompt, "execution_schedule.prompt"),
    artifactPath: toText(row.artifact_path, "execution_schedule.artifact_path"),
    baseSha: toNullableText(row.base_sha, "execution_schedule.base_sha"),
    hardDeadlineAt: toNullableText(row.hard_deadline_at, "execution_schedule.hard_deadline_at"),
    state: state as ExecutionScheduleSnapshot["state"],
    capacityPolicy: capacityPolicy as CapacityPolicy,
    requestedPriority: toSafeInteger(
      row.requested_priority,
      "execution_schedule.requested_priority",
    ),
    currentCandidateIndex,
    currentAttemptId: toNullableText(
      row.current_attempt_id,
      "execution_schedule.current_attempt_id",
    ),
    revision: toSafeInteger(row.revision, "execution_schedule.revision"),
    enqueuedAt: toText(row.enqueued_at, "execution_schedule.enqueued_at"),
    updatedAt: toText(row.updated_at, "execution_schedule.updated_at"),
    // Absent when SELECT omitted the column on a pre-migration-19 schema.
    capabilityRequest:
      row.capability_request_json === undefined || row.capability_request_json === null
        ? null
        : parseJsonValue(
            toText(row.capability_request_json, "execution_schedule.capability_request_json"),
            "execution schedule capability request",
          ),
  };
}

function readExecutionScheduleRequired(
  db: StateDatabase,
  runId: string,
): ExecutionScheduleSnapshot {
  const schedule = readExecutionSchedule(db, runId);
  if (schedule === undefined)
    throw new StateStoreError(`execution schedule does not exist: ${runId}`);
  return schedule;
}

export function readExecutionAttempts(
  db: StateDatabase,
  runId: string,
): readonly ExecutionAttemptSnapshot[] {
  return internalHandle(db)
    .prepare(
      `SELECT attempt_id, run_id, stage_id, candidate_index, profile_id, account_id,
              workspace_id, backend_execution_id, status, limits_json, permissions_json,
              readonly_baseline_json, result_json, failure_json, started_at, finished_at
         FROM execution_attempt WHERE run_id = ? ORDER BY candidate_index`,
    )
    .all(runId)
    .map((row) => ({
      attemptId: toText(row.attempt_id, "execution_attempt.attempt_id"),
      runId: toText(row.run_id, "execution_attempt.run_id"),
      stageId: toText(row.stage_id, "execution_attempt.stage_id"),
      candidateIndex: toSafeInteger(row.candidate_index, "execution_attempt.candidate_index"),
      profileId: toText(row.profile_id, "execution_attempt.profile_id"),
      accountId: toNullableText(row.account_id, "execution_attempt.account_id"),
      workspaceId: toNullableText(row.workspace_id, "execution_attempt.workspace_id"),
      backendExecutionId: toNullableText(
        row.backend_execution_id,
        "execution_attempt.backend_execution_id",
      ),
      status: toText(row.status, "execution_attempt.status"),
      limits: parseJsonValue(toText(row.limits_json, "execution_attempt.limits_json"), "limits"),
      permissions: parseJsonValue(
        toText(row.permissions_json, "execution_attempt.permissions_json"),
        "permissions",
      ),
      readonlyBaseline:
        row.readonly_baseline_json === null
          ? null
          : parseJsonValue(
              toText(row.readonly_baseline_json, "execution_attempt.readonly_baseline_json"),
              "read-only baseline",
            ),
      result:
        row.result_json === null
          ? null
          : parseJsonValue(toText(row.result_json, "execution_attempt.result_json"), "result"),
      failure:
        row.failure_json === null
          ? null
          : parseJsonValue(toText(row.failure_json, "execution_attempt.failure_json"), "failure"),
      startedAt: toNullableText(row.started_at, "execution_attempt.started_at"),
      finishedAt: toNullableText(row.finished_at, "execution_attempt.finished_at"),
    }));
}

export function readRecoverableSchedulingAttempts(
  db: StateDatabase,
): readonly RecoverableSchedulingAttempt[] {
  const rows = internalHandle(db)
    .prepare(
      `SELECT a.attempt_id, a.run_id, l.owner_id, l.fencing_revision, l.expires_at
         FROM execution_attempt a
         JOIN account_concurrency_lease l ON l.attempt_id = a.attempt_id
        WHERE a.status IN ('queued','running','waiting_on_user','recovery_required')
          AND l.state IN ('active','expired') ORDER BY a.run_id, a.candidate_index`,
    )
    .all();
  return rows.map((row) => {
    const runId = toText(row.run_id, "execution_attempt.run_id");
    const attemptId = toText(row.attempt_id, "execution_attempt.attempt_id");
    const attempt = readExecutionAttempts(db, runId).find((entry) => entry.attemptId === attemptId);
    if (attempt === undefined) {
      throw new StateDatabaseCorruptionError("recoverable scheduling attempt is missing");
    }
    return {
      ...attempt,
      leaseOwnerId: toText(row.owner_id, "account_concurrency_lease.owner_id"),
      leaseFencingRevision: toSafeInteger(
        row.fencing_revision,
        "account_concurrency_lease.fencing_revision",
      ),
      leaseExpiresAt: toText(row.expires_at, "account_concurrency_lease.expires_at"),
    };
  });
}

export function readSchedulingDecisions(
  db: StateDatabase,
  runId: string,
): readonly SchedulingDecisionSnapshot[] {
  return internalHandle(db)
    .prepare(
      `SELECT decision_id, run_id, stage_id, candidate_index, profile_id, account_id,
              kind, reason_code, recorded_at
         FROM scheduling_decision WHERE run_id = ? ORDER BY decision_sequence`,
    )
    .all(runId)
    .map((row) => ({
      decisionId: toText(row.decision_id, "scheduling_decision.decision_id"),
      runId: toText(row.run_id, "scheduling_decision.run_id"),
      stageId: toText(row.stage_id, "scheduling_decision.stage_id"),
      candidateIndex:
        row.candidate_index === null
          ? null
          : toSafeInteger(row.candidate_index, "scheduling_decision.candidate_index"),
      profileId: toNullableText(row.profile_id, "scheduling_decision.profile_id"),
      accountId: toNullableText(row.account_id, "scheduling_decision.account_id"),
      kind: toText(row.kind, "scheduling_decision.kind"),
      reasonCode: toText(row.reason_code, "scheduling_decision.reason_code"),
      recordedAt: toText(row.recorded_at, "scheduling_decision.recorded_at"),
    }));
}
