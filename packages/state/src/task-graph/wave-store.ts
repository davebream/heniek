import type {
  RunId,
  TaskCapacityLease,
  TaskCapacityScope,
  TaskDispatchRecord,
  TaskLifecyclePhase,
  TaskLifecycleProjection,
  TaskPlanningState,
  TaskPropagationReason,
  TaskWaveAuditEvent,
  TaskWavePlan,
} from "@heniek/contracts";
import {
  internalClock,
  internalHandle,
  internalIds,
  type StateDatabase,
} from "../database/open.js";
import { StateStoreError } from "../errors.js";
import type { JsonValue } from "../json.js";
import { stringifyCanonical } from "../json.js";

interface JsonRow {
  readonly json: string;
}

export interface TaskCapacityLimits {
  readonly maxConcurrentWorkers: number;
  readonly accountLimits: Readonly<Record<string, number>>;
}

export interface TaskWaveDispatchInput {
  readonly plan: TaskWavePlan;
  readonly dispatches: readonly TaskDispatchRecord[];
  readonly limits: TaskCapacityLimits;
}

export class TaskCapacityConflictError extends StateStoreError {
  constructor(
    readonly scope: TaskCapacityScope,
    readonly resourceId: string,
  ) {
    super(`task capacity unavailable for ${scope}:${resourceId}`);
    this.name = "TaskCapacityConflictError";
  }
}

export interface TaskWaveStateStore {
  initialize(runId: RunId, graphRevision: number, taskIds: readonly string[]): void;
  projections(runId: RunId): readonly TaskLifecycleProjection[];
  planningStates(runId: RunId, taskIds?: readonly string[]): readonly TaskPlanningState[];
  dispatchWave(input: TaskWaveDispatchInput): readonly TaskDispatchRecord[];
  markActive(runId: RunId, taskId: string): TaskLifecycleProjection;
  markRetrying(runId: RunId, taskId: string): TaskLifecycleProjection;
  requestCancellation(runId: RunId, taskId: string): TaskLifecycleProjection;
  cancelPending(runId: RunId, taskId: string): TaskLifecycleProjection;
  markRecoveryRequired(runId: RunId, taskId: string): TaskLifecycleProjection;
  settle(
    runId: RunId,
    taskId: string,
    phase: "succeeded" | "failed" | "cancelled",
  ): TaskLifecycleProjection;
  block(runId: RunId, taskId: string, reason: TaskPropagationReason): TaskLifecycleProjection;
  leases(runId: RunId): readonly TaskCapacityLease[];
  dispatches(runId: RunId): readonly TaskDispatchRecord[];
  plans(runId: RunId): readonly TaskWavePlan[];
  auditEvents(runId: RunId): readonly TaskWaveAuditEvent[];
}

function transaction<T>(db: StateDatabase, operation: () => T): T {
  const handle = internalHandle(db);
  if (handle.isTransaction) throw new StateStoreError("task wave operations cannot be nested");
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

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

function lifecycleFrom(row: Record<string, unknown>): TaskLifecycleProjection {
  return {
    schemaVersion: 1,
    runId: String(row.run_id),
    taskId: String(row.task_id),
    graphRevision: Number(row.graph_revision),
    phase: String(row.phase) as TaskLifecyclePhase,
    childRunId: row.child_run_id === null ? null : String(row.child_run_id),
    attemptOrdinal: Number(row.attempt_ordinal),
    retryCount: Number(row.retry_count),
    blockReason:
      row.block_reason_json === null
        ? null
        : parse<TaskPropagationReason>(String(row.block_reason_json)),
    completionContract: String(row.completion_contract) as TaskPlanningState["completionContract"],
    integration: String(row.integration) as TaskPlanningState["integration"],
    combinedVerification: String(
      row.combined_verification,
    ) as TaskPlanningState["combinedVerification"],
    revision: Number(row.revision),
    updatedAt: String(row.updated_at),
  } as TaskLifecycleProjection;
}

function planningOutcome(phase: TaskLifecyclePhase): TaskPlanningState["outcome"] {
  if (phase === "not_started") return "not_started";
  if (phase === "succeeded" || phase === "failed" || phase === "cancelled" || phase === "blocked")
    return phase;
  return "active";
}

export function createTaskWaveStateStore(db: StateDatabase): TaskWaveStateStore {
  const handle = internalHandle(db);

  const readOne = (runId: RunId, taskId: string): TaskLifecycleProjection => {
    const row = handle
      .prepare("SELECT * FROM task_lifecycle_projection WHERE run_id = ? AND task_id = ?")
      .get(runId, taskId) as Record<string, unknown> | undefined;
    if (row === undefined) throw new StateStoreError(`unknown task lifecycle ${runId}/${taskId}`);
    return lifecycleFrom(row);
  };

  const audit = (
    runId: RunId,
    taskId: string | null,
    kind: TaskWaveAuditEvent["kind"],
    detail: Readonly<Record<string, unknown>>,
    recordedAt: string,
  ): void => {
    const event = {
      schemaVersion: 1,
      eventId: internalIds(db).next("task-wave-event"),
      runId,
      taskId,
      kind,
      detail,
      recordedAt,
    } as TaskWaveAuditEvent;
    handle
      .prepare(`INSERT INTO task_wave_audit_event
        (event_id, run_id, task_id, kind, event_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        event.eventId,
        runId,
        taskId,
        kind,
        stringifyCanonical(event as unknown as JsonValue),
        recordedAt,
      );
  };

  const updatePhase = (
    runId: RunId,
    taskId: string,
    from: readonly TaskLifecyclePhase[],
    phase: TaskLifecyclePhase,
    extraSql = "",
  ): TaskLifecycleProjection => {
    const now = internalClock(db).nowIso();
    const placeholders = from.map(() => "?").join(",");
    const result = handle
      .prepare(`UPDATE task_lifecycle_projection SET phase = ?, revision = revision + 1,
        updated_at = ?${extraSql} WHERE run_id = ? AND task_id = ? AND phase IN (${placeholders})`)
      .run(phase, now, runId, taskId, ...from);
    if (result.changes !== 1) {
      const current = readOne(runId, taskId);
      if (current.phase === phase) return current;
      throw new StateStoreError(`invalid task transition ${current.phase} -> ${phase}`);
    }
    return readOne(runId, taskId);
  };

  const release = (runId: RunId, taskId: string, now: string): number => {
    const result = handle
      .prepare(`UPDATE task_capacity_lease SET state = 'released', released_at = ?,
        fencing_revision = fencing_revision + 1
        WHERE run_id = ? AND task_id = ? AND state = 'active'`)
      .run(now, runId, taskId);
    if (result.changes > 0)
      audit(runId, taskId, "capacity_released", { count: result.changes }, now);
    return Number(result.changes);
  };

  return {
    initialize(runId, graphRevision, taskIds) {
      transaction(db, () => {
        const now = internalClock(db).nowIso();
        for (const taskId of [...taskIds].sort()) {
          const existing = handle
            .prepare(
              "SELECT phase, graph_revision FROM task_lifecycle_projection WHERE run_id = ? AND task_id = ?",
            )
            .get(runId, taskId) as { phase: string; graph_revision: number } | undefined;
          if (existing === undefined) {
            handle
              .prepare(`INSERT INTO task_lifecycle_projection
                (run_id, task_id, graph_revision, phase, child_run_id, attempt_ordinal,
                 retry_count, block_reason_json, completion_contract, integration,
                 combined_verification, revision, updated_at)
                VALUES (?, ?, ?, 'not_started', NULL, 0, 0, NULL, 'pending', 'pending',
                  'pending', 1, ?)`)
              .run(runId, taskId, graphRevision, now);
          } else if (
            existing.phase === "not_started" &&
            existing.graph_revision !== graphRevision
          ) {
            handle
              .prepare(`UPDATE task_lifecycle_projection SET graph_revision = ?, revision = revision + 1,
                updated_at = ? WHERE run_id = ? AND task_id = ?`)
              .run(graphRevision, now, runId, taskId);
          }
        }
      });
    },

    projections(runId) {
      return (
        handle
          .prepare("SELECT * FROM task_lifecycle_projection WHERE run_id = ? ORDER BY task_id")
          .all(runId) as Record<string, unknown>[]
      ).map(lifecycleFrom);
    },

    planningStates(runId, taskIds) {
      const selected = taskIds === undefined ? undefined : new Set(taskIds);
      return this.projections(runId)
        .filter((task) => selected === undefined || selected.has(task.taskId))
        .map((task) => ({
          taskId: task.taskId,
          outcome: planningOutcome(task.phase),
          completionContract: task.completionContract,
          integration: task.integration,
          combinedVerification: task.combinedVerification,
        })) as readonly TaskPlanningState[];
    },

    dispatchWave(input) {
      return transaction(db, () => {
        const now = input.plan.plannedAt;
        const existingPlan = handle
          .prepare(`SELECT plan_json AS json FROM task_wave_plan
            WHERE run_id = ? AND graph_revision = ? AND wave_ordinal = ?`)
          .get(
            input.dispatches[0]?.runId ?? "",
            input.plan.graphRevision,
            input.plan.waveOrdinal,
          ) as JsonRow | undefined;
        const planJson = stringifyCanonical(input.plan as unknown as JsonValue);
        if (existingPlan !== undefined && existingPlan.json !== planJson)
          throw new StateStoreError("task wave replay does not match the persisted plan");
        const runId = input.dispatches[0]?.runId;
        if (runId === undefined) return [];
        if (existingPlan === undefined) {
          handle
            .prepare(`INSERT INTO task_wave_plan
              (run_id, graph_revision, wave_ordinal, plan_json, planned_at) VALUES (?, ?, ?, ?, ?)`)
            .run(runId, input.plan.graphRevision, input.plan.waveOrdinal, planJson, now);
          audit(runId, null, "wave_planned", { selectedTaskIds: input.plan.selectedTaskIds }, now);
        }

        const accepted: TaskDispatchRecord[] = [];
        for (const dispatch of [...input.dispatches].sort((a, b) =>
          a.taskId.localeCompare(b.taskId),
        )) {
          const replay = handle
            .prepare(`SELECT dispatch_json AS json FROM task_dispatch_record
              WHERE run_id = ? AND task_id = ? AND graph_revision = ?`)
            .get(dispatch.runId, dispatch.taskId, dispatch.graphRevision) as JsonRow | undefined;
          if (replay !== undefined) {
            accepted.push(parse<TaskDispatchRecord>(replay.json));
            continue;
          }
          const task = readOne(dispatch.runId, dispatch.taskId);
          if (task.phase !== "not_started")
            throw new StateStoreError(
              `task ${dispatch.taskId} is not dispatchable from ${task.phase}`,
            );

          const counted = (scope: "global" | "account", resourceId: string, limit: number) => {
            const row = handle
              .prepare(`SELECT count(*) AS count FROM task_capacity_lease
                WHERE scope = ? AND resource_id = ? AND state = 'active'`)
              .get(scope, resourceId) as { count: number };
            if (Number(row.count) >= limit) throw new TaskCapacityConflictError(scope, resourceId);
          };
          counted("global", "global", input.limits.maxConcurrentWorkers);
          if (dispatch.accountId !== null) {
            const limit = input.limits.accountLimits[dispatch.accountId];
            if (limit === undefined)
              throw new TaskCapacityConflictError("account", dispatch.accountId);
            counted("account", dispatch.accountId, limit);
          }

          const resources: ReadonlyArray<readonly [TaskCapacityScope, string]> = [
            ["global", "global"],
            ...(dispatch.accountId === null ? [] : ([["account", dispatch.accountId]] as const)),
            ["workspace", dispatch.workspaceId],
            ...dispatch.repositoryIds.map((repositoryId) => ["repository", repositoryId] as const),
          ];
          for (const [scope, resourceId] of resources) {
            const leaseId = internalIds(db).next("task-capacity");
            const priorFence = handle
              .prepare(`SELECT MAX(fencing_revision) AS revision FROM task_capacity_lease
                WHERE scope = ? AND resource_id = ?`)
              .get(scope, resourceId) as { revision: number | null };
            const fencingRevision = Number(priorFence.revision ?? 0) + 1;
            try {
              handle
                .prepare(`INSERT INTO task_capacity_lease
                  (lease_id, run_id, task_id, scope, resource_id, fencing_revision,
                   state, acquired_at, released_at)
                  VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL)`)
                .run(
                  leaseId,
                  dispatch.runId,
                  dispatch.taskId,
                  scope,
                  resourceId,
                  fencingRevision,
                  now,
                );
            } catch (error) {
              if (scope === "workspace" || scope === "repository")
                throw new TaskCapacityConflictError(scope, resourceId);
              throw error;
            }
          }
          handle
            .prepare(`UPDATE task_lifecycle_projection SET phase = 'dispatching', child_run_id = ?,
              attempt_ordinal = 1, revision = revision + 1, updated_at = ?
              WHERE run_id = ? AND task_id = ? AND phase = 'not_started'`)
            .run(dispatch.childRunId, now, dispatch.runId, dispatch.taskId);
          handle
            .prepare(`INSERT INTO task_dispatch_record
              (dispatch_id, run_id, task_id, graph_revision, wave_ordinal, child_run_id,
               dispatch_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
              dispatch.dispatchId,
              dispatch.runId,
              dispatch.taskId,
              dispatch.graphRevision,
              dispatch.waveOrdinal,
              dispatch.childRunId,
              stringifyCanonical(dispatch as unknown as JsonValue),
              dispatch.recordedAt,
            );
          audit(dispatch.runId, dispatch.taskId, "capacity_acquired", { resources }, now);
          audit(
            dispatch.runId,
            dispatch.taskId,
            "task_dispatched",
            { childRunId: dispatch.childRunId },
            now,
          );
          accepted.push(dispatch);
        }
        return accepted;
      });
    },

    markActive(runId, taskId) {
      return transaction(db, () =>
        updatePhase(runId, taskId, ["dispatching", "retrying"], "active"),
      );
    },

    markRetrying(runId, taskId) {
      return transaction(db, () => {
        const result = updatePhase(
          runId,
          taskId,
          ["active", "retrying"],
          "retrying",
          ", retry_count = retry_count + 1, attempt_ordinal = attempt_ordinal + 1",
        );
        audit(runId, taskId, "task_retrying", { retryCount: result.retryCount }, result.updatedAt);
        return result;
      });
    },

    requestCancellation(runId, taskId) {
      return transaction(db, () => {
        const result = updatePhase(
          runId,
          taskId,
          ["dispatching", "active", "retrying", "cancelling"],
          "cancelling",
        );
        audit(runId, taskId, "cancellation_requested", {}, result.updatedAt);
        return result;
      });
    },

    cancelPending(runId, taskId) {
      return transaction(db, () => {
        const now = internalClock(db).nowIso();
        const result = updatePhase(runId, taskId, ["not_started"], "cancelled");
        audit(runId, taskId, "task_settled", { phase: "cancelled" }, now);
        return result;
      });
    },

    markRecoveryRequired(runId, taskId) {
      return transaction(db, () => {
        const result = updatePhase(
          runId,
          taskId,
          ["dispatching", "active", "retrying", "cancelling", "recovery_required"],
          "recovery_required",
        );
        audit(runId, taskId, "recovery_required", {}, result.updatedAt);
        return result;
      });
    },

    settle(runId, taskId, phase) {
      return transaction(db, () => {
        const now = internalClock(db).nowIso();
        const result = updatePhase(
          runId,
          taskId,
          ["dispatching", "active", "retrying", "cancelling", "recovery_required"],
          phase,
        );
        release(runId, taskId, now);
        audit(runId, taskId, "task_settled", { phase }, now);
        return result;
      });
    },

    block(runId, taskId, reason) {
      return transaction(db, () => {
        const now = internalClock(db).nowIso();
        const reasonJson = stringifyCanonical(reason as unknown as JsonValue);
        const changed = handle
          .prepare(`UPDATE task_lifecycle_projection SET phase = 'blocked', block_reason_json = ?,
            revision = revision + 1, updated_at = ?
            WHERE run_id = ? AND task_id = ? AND phase = 'not_started'`)
          .run(reasonJson, now, runId, taskId);
        const result = readOne(runId, taskId);
        if (changed.changes === 1) audit(runId, taskId, "task_blocked", { reason }, now);
        if (result.phase !== "blocked")
          throw new StateStoreError(`cannot block task ${taskId} from ${result.phase}`);
        return result;
      });
    },

    leases(runId) {
      return (
        handle
          .prepare(`SELECT lease_id, run_id, task_id, scope, resource_id, fencing_revision,
          state, acquired_at, released_at FROM task_capacity_lease
          WHERE run_id = ? ORDER BY acquired_at, lease_id`)
          .all(runId) as Record<string, unknown>[]
      ).map((row) => ({
        schemaVersion: 1,
        leaseId: String(row.lease_id),
        runId: String(row.run_id),
        taskId: String(row.task_id),
        scope: String(row.scope),
        resourceId: String(row.resource_id),
        fencingRevision: Number(row.fencing_revision),
        state: String(row.state),
        acquiredAt: String(row.acquired_at),
        releasedAt: row.released_at === null ? null : String(row.released_at),
      })) as unknown as readonly TaskCapacityLease[];
    },

    dispatches(runId) {
      return (
        handle
          .prepare(
            "SELECT dispatch_json AS json FROM task_dispatch_record WHERE run_id = ? ORDER BY recorded_at, dispatch_id",
          )
          .all(runId) as unknown as JsonRow[]
      ).map((row) => parse<TaskDispatchRecord>(row.json));
    },

    plans(runId) {
      return (
        handle
          .prepare(
            "SELECT plan_json AS json FROM task_wave_plan WHERE run_id = ? ORDER BY graph_revision, wave_ordinal",
          )
          .all(runId) as unknown as JsonRow[]
      ).map((row) => parse<TaskWavePlan>(row.json));
    },

    auditEvents(runId) {
      return (
        handle
          .prepare(
            "SELECT event_json AS json FROM task_wave_audit_event WHERE run_id = ? ORDER BY recorded_at, event_id",
          )
          .all(runId) as unknown as JsonRow[]
      ).map((row) => parse<TaskWaveAuditEvent>(row.json));
    },
  };
}
