import type {
  EpicRepositoryBranch,
  RunId,
  TaskIntegrationLedgerEntry,
  TaskIntegrationReconciliation,
  TaskIntegrationReconciliationObservation,
  TaskIntegrationTrace,
  TaskPlanningState,
} from "@heniek/contracts";
import { internalClock, internalHandle, type StateDatabase } from "../database/open.js";
import { StateStoreError } from "../errors.js";
import { stringifyCanonical } from "../json.js";

export interface InitializeEpicBranchInput {
  readonly runId: RunId;
  readonly repositoryId: string;
  readonly branchRef: string;
  readonly remote: string;
  readonly remoteBaseRef: string;
  readonly remoteBaseSha: string;
  readonly observedLocalSha: string;
  readonly observedRemoteSha: string | null;
}

export interface QueueTaskIntegrationInput {
  readonly integrationId: string;
  readonly runId: RunId;
  readonly taskId: string;
  readonly graphRevision: number;
  readonly waveOrdinal: number;
  readonly integrationOrdinal: number;
  readonly variantId: string;
}

export interface TaskIntegrationTransitionInput {
  readonly integrationId: string;
  readonly expectedLifecycle: TaskIntegrationLedgerEntry["lifecycle"];
  readonly lifecycle: TaskIntegrationLedgerEntry["lifecycle"];
  readonly repositories?: TaskIntegrationLedgerEntry["repositories"];
  readonly verificationReportId?: string | null;
  readonly verification?: TaskIntegrationLedgerEntry["verification"];
  readonly gates?: {
    readonly completionContract: TaskPlanningState["completionContract"];
    readonly integration: TaskPlanningState["integration"];
    readonly combinedVerification: TaskPlanningState["combinedVerification"];
  };
}

export interface StartTaskIntegrationReconciliationInput {
  readonly entry: TaskIntegrationLedgerEntry;
  readonly trigger: TaskIntegrationReconciliation["trigger"];
}

export interface AdvanceTaskIntegrationReconciliationInput {
  readonly reconciliationId: string;
  readonly expectedLifecycle: TaskIntegrationReconciliation["lifecycle"];
  readonly lifecycle: TaskIntegrationReconciliation["lifecycle"];
  readonly pass?: number;
  readonly repositories?: TaskIntegrationReconciliation["repositories"];
  readonly resolution?: TaskIntegrationReconciliation["resolution"];
  readonly blocker?: TaskIntegrationReconciliation["blocker"];
}

export interface TaskIntegrationStateStore {
  initializeBranch(input: InitializeEpicBranchInput): EpicRepositoryBranch;
  branches(runId: RunId): readonly EpicRepositoryBranch[];
  enqueue(input: QueueTaskIntegrationInput): TaskIntegrationLedgerEntry;
  entries(runId: RunId): readonly TaskIntegrationLedgerEntry[];
  transition(input: TaskIntegrationTransitionInput): TaskIntegrationLedgerEntry;
  startReconciliation(
    input: StartTaskIntegrationReconciliationInput,
  ): TaskIntegrationReconciliation;
  advanceReconciliation(
    input: AdvanceTaskIntegrationReconciliationInput,
  ): TaskIntegrationReconciliation;
  resolveReconciliation(
    reconciliationId: string,
    repositories: TaskIntegrationLedgerEntry["repositories"],
    resolution: Exclude<TaskIntegrationReconciliation["resolution"], "blocked" | null>,
  ): TaskIntegrationReconciliation;
  reconciliations(runId: RunId): readonly TaskIntegrationReconciliation[];
  appendReconciliationObservation(
    observation: TaskIntegrationReconciliationObservation,
  ): TaskIntegrationReconciliationObservation;
  reconciliationObservations(runId: RunId): readonly TaskIntegrationReconciliationObservation[];
  appendTrace(trace: TaskIntegrationTrace): TaskIntegrationTrace;
  traces(integrationId: string): readonly TaskIntegrationTrace[];
}

function transaction<T>(db: StateDatabase, operation: () => T): T {
  const handle = internalHandle(db);
  if (handle.isTransaction)
    throw new StateStoreError("task integration operations cannot be nested");
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

function branchFrom(row: Record<string, unknown>): EpicRepositoryBranch {
  return {
    schemaVersion: 1,
    runId: String(row.run_id),
    repositoryId: String(row.repository_id),
    branchRef: String(row.branch_ref),
    remote: String(row.remote),
    remoteBaseRef: String(row.remote_base_ref),
    remoteBaseSha: String(row.remote_base_sha),
    expectedLocalSha: String(row.expected_local_sha),
    observedRemoteSha: row.observed_remote_sha === null ? null : String(row.observed_remote_sha),
    lifecycle: String(row.lifecycle) as EpicRepositoryBranch["lifecycle"],
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  } as EpicRepositoryBranch;
}

function parseEntry(value: unknown): TaskIntegrationLedgerEntry {
  return JSON.parse(String(value)) as TaskIntegrationLedgerEntry;
}

function parseReconciliation(value: unknown): TaskIntegrationReconciliation {
  return JSON.parse(String(value)) as TaskIntegrationReconciliation;
}

function parseReconciliationObservation(value: unknown): TaskIntegrationReconciliationObservation {
  return JSON.parse(String(value)) as TaskIntegrationReconciliationObservation;
}

export function createTaskIntegrationStateStore(db: StateDatabase): TaskIntegrationStateStore {
  const handle = internalHandle(db);
  const clock = internalClock(db);

  const readBranch = (runId: RunId, repositoryId: string): EpicRepositoryBranch | undefined => {
    const row = handle
      .prepare("SELECT * FROM epic_repository_branch WHERE run_id = ? AND repository_id = ?")
      .get(runId, repositoryId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : branchFrom(row);
  };

  const readEntry = (integrationId: string): TaskIntegrationLedgerEntry | undefined => {
    const row = handle
      .prepare("SELECT entry_json FROM task_integration_ledger WHERE integration_id = ?")
      .get(integrationId) as { entry_json: string } | undefined;
    return row === undefined ? undefined : parseEntry(row.entry_json);
  };

  const readReconciliation = (
    reconciliationId: string,
  ): TaskIntegrationReconciliation | undefined => {
    const row = handle
      .prepare(
        "SELECT reconciliation_json FROM task_integration_reconciliation WHERE reconciliation_id = ?",
      )
      .get(reconciliationId) as { reconciliation_json: string } | undefined;
    return row === undefined ? undefined : parseReconciliation(row.reconciliation_json);
  };

  return {
    initializeBranch(input) {
      return transaction(db, () => {
        const existing = readBranch(input.runId, input.repositoryId);
        if (existing === undefined) {
          const now = clock.nowIso();
          const remoteMatches =
            input.observedRemoteSha === null || input.observedRemoteSha === input.observedLocalSha;
          const branch = {
            schemaVersion: 1,
            runId: input.runId,
            repositoryId: input.repositoryId,
            branchRef: input.branchRef,
            remote: input.remote,
            remoteBaseRef: input.remoteBaseRef,
            remoteBaseSha: input.remoteBaseSha,
            expectedLocalSha: input.observedLocalSha,
            observedRemoteSha: input.observedRemoteSha,
            lifecycle:
              input.observedLocalSha === input.remoteBaseSha && remoteMatches
                ? "ready"
                : "reconciliation_required",
            revision: 1,
            createdAt: now,
            updatedAt: now,
          } as EpicRepositoryBranch;
          handle
            .prepare(
              `INSERT INTO epic_repository_branch
                (run_id, repository_id, branch_ref, remote, remote_base_ref, remote_base_sha,
                 expected_local_sha, observed_remote_sha, lifecycle, revision, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              branch.runId,
              branch.repositoryId,
              branch.branchRef,
              branch.remote,
              branch.remoteBaseRef,
              branch.remoteBaseSha,
              branch.expectedLocalSha,
              branch.observedRemoteSha,
              branch.lifecycle,
              now,
              now,
            );
          return branch;
        }

        const identityMatches =
          existing.branchRef === input.branchRef &&
          existing.remote === input.remote &&
          existing.remoteBaseRef === input.remoteBaseRef &&
          existing.remoteBaseSha === input.remoteBaseSha;
        const refsMatch =
          existing.expectedLocalSha === input.observedLocalSha &&
          (input.observedRemoteSha === null ||
            input.observedRemoteSha === existing.expectedLocalSha);
        if (identityMatches && refsMatch) return existing;
        if (existing.lifecycle === "reconciliation_required") return existing;
        const now = clock.nowIso();
        handle
          .prepare(
            `UPDATE epic_repository_branch
             SET observed_remote_sha = ?, lifecycle = 'reconciliation_required',
                 revision = revision + 1, updated_at = ?
             WHERE run_id = ? AND repository_id = ?`,
          )
          .run(input.observedRemoteSha, now, input.runId, input.repositoryId);
        return readBranch(input.runId, input.repositoryId) as EpicRepositoryBranch;
      });
    },

    branches(runId) {
      return (
        handle
          .prepare("SELECT * FROM epic_repository_branch WHERE run_id = ? ORDER BY repository_id")
          .all(runId) as Record<string, unknown>[]
      ).map(branchFrom);
    },

    enqueue(input) {
      return transaction(db, () => {
        const existing = readEntry(input.integrationId);
        if (existing !== undefined) {
          if (
            existing.runId !== input.runId ||
            existing.taskId !== input.taskId ||
            existing.graphRevision !== input.graphRevision ||
            existing.waveOrdinal !== input.waveOrdinal ||
            existing.integrationOrdinal !== input.integrationOrdinal ||
            existing.variantId !== input.variantId
          ) {
            throw new StateStoreError(`task integration identity conflict: ${input.integrationId}`);
          }
          return existing;
        }
        const now = clock.nowIso();
        const entry = {
          schemaVersion: 1,
          ...input,
          lifecycle: "queued",
          repositories: [],
          verificationReportId: null,
          verification: "pending",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        } as unknown as TaskIntegrationLedgerEntry;
        handle
          .prepare(
            `INSERT INTO task_integration_ledger
              (integration_id, run_id, task_id, graph_revision, wave_ordinal,
               integration_ordinal, variant_id, lifecycle, entry_json, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            entry.integrationId,
            entry.runId,
            entry.taskId,
            entry.graphRevision,
            entry.waveOrdinal,
            entry.integrationOrdinal,
            entry.variantId,
            entry.lifecycle,
            stringifyCanonical(entry),
            now,
            now,
          );
        return entry;
      });
    },

    entries(runId) {
      return (
        handle
          .prepare(
            "SELECT entry_json FROM task_integration_ledger WHERE run_id = ? ORDER BY integration_ordinal",
          )
          .all(runId) as { entry_json: string }[]
      ).map((row) => parseEntry(row.entry_json));
    },

    transition(input) {
      return transaction(db, () => {
        const existing = readEntry(input.integrationId);
        if (existing === undefined)
          throw new StateStoreError(`unknown task integration: ${input.integrationId}`);
        if (existing.lifecycle !== input.expectedLifecycle) {
          if (existing.lifecycle === input.lifecycle) return existing;
          throw new StateStoreError(
            `task integration ${input.integrationId} expected ${input.expectedLifecycle}, observed ${existing.lifecycle}`,
          );
        }
        const now = clock.nowIso();
        const next = {
          ...existing,
          lifecycle: input.lifecycle,
          repositories: input.repositories ?? existing.repositories,
          verificationReportId:
            input.verificationReportId === undefined
              ? existing.verificationReportId
              : input.verificationReportId,
          verification: input.verification ?? existing.verification,
          revision: existing.revision + 1,
          updatedAt: now,
        } as TaskIntegrationLedgerEntry;
        handle
          .prepare(
            `UPDATE task_integration_ledger
             SET lifecycle = ?, entry_json = ?, revision = ?, updated_at = ?
             WHERE integration_id = ? AND revision = ?`,
          )
          .run(
            next.lifecycle,
            stringifyCanonical(next),
            next.revision,
            now,
            next.integrationId,
            existing.revision,
          );
        if (next.lifecycle === "integrated" || next.lifecycle === "reconciliation_required") {
          for (const repository of next.repositories) {
            if (
              repository.resultSha === null ||
              repository.resultSha !== repository.candidateSha ||
              (repository.classification !== "integrated" &&
                repository.classification !== "already-applied" &&
                repository.classification !== "already_applied")
            )
              continue;
            const changed = handle
              .prepare(
                `UPDATE epic_repository_branch
                 SET expected_local_sha = ?, revision = revision + 1, updated_at = ?
                 WHERE run_id = ? AND repository_id = ? AND expected_local_sha = ?
                   AND lifecycle = 'ready'`,
              )
              .run(
                repository.resultSha,
                now,
                existing.runId,
                repository.repositoryId,
                repository.expectedTargetSha,
              );
            if (changed.changes !== 1)
              throw new StateStoreError(
                `epic branch expected SHA changed for ${repository.repositoryId}`,
              );
          }
        }
        if (input.gates !== undefined) {
          const changed = handle
            .prepare(
              `UPDATE task_lifecycle_projection
               SET completion_contract = ?, integration = ?, combined_verification = ?,
                   revision = revision + 1, updated_at = ?
               WHERE run_id = ? AND task_id = ? AND phase = 'succeeded'`,
            )
            .run(
              input.gates.completionContract,
              input.gates.integration,
              input.gates.combinedVerification,
              now,
              existing.runId,
              existing.taskId,
            );
          if (changed.changes !== 1)
            throw new StateStoreError(
              `task integration gates require succeeded task ${existing.taskId}`,
            );
        }
        return next;
      });
    },

    startReconciliation(input) {
      return transaction(db, () => {
        const reconciliationId = `${input.entry.integrationId}:reconciliation`;
        const existing = readReconciliation(reconciliationId);
        if (existing !== undefined) return existing;
        const now = clock.nowIso();
        const reconciliation: TaskIntegrationReconciliation = {
          schemaVersion: 1,
          reconciliationId,
          integrationId: input.entry.integrationId,
          runId: input.entry.runId,
          taskId: input.entry.taskId,
          trigger: input.trigger,
          lifecycle: "observing",
          resolution: null,
          blocker: null,
          pass: 0,
          repositories: [],
          verificationReportId: input.entry.verificationReportId,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        handle
          .prepare(
            `INSERT INTO task_integration_reconciliation
              (reconciliation_id, integration_id, run_id, task_id, lifecycle,
               reconciliation_json, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            reconciliation.reconciliationId,
            reconciliation.integrationId,
            reconciliation.runId,
            reconciliation.taskId,
            reconciliation.lifecycle,
            stringifyCanonical(reconciliation),
            now,
            now,
          );
        return reconciliation;
      });
    },

    advanceReconciliation(input) {
      return transaction(db, () => {
        const existing = readReconciliation(input.reconciliationId);
        if (existing === undefined)
          throw new StateStoreError(
            `unknown task integration reconciliation: ${input.reconciliationId}`,
          );
        if (existing.lifecycle !== input.expectedLifecycle) {
          if (existing.lifecycle === input.lifecycle) return existing;
          throw new StateStoreError(
            `task integration reconciliation ${input.reconciliationId} expected ${input.expectedLifecycle}, observed ${existing.lifecycle}`,
          );
        }
        const now = clock.nowIso();
        const next: TaskIntegrationReconciliation = {
          ...existing,
          lifecycle: input.lifecycle,
          pass: input.pass ?? existing.pass,
          repositories: input.repositories ?? existing.repositories,
          resolution: input.resolution === undefined ? existing.resolution : input.resolution,
          blocker: input.blocker === undefined ? existing.blocker : input.blocker,
          revision: existing.revision + 1,
          updatedAt: now,
        };
        handle
          .prepare(
            `UPDATE task_integration_reconciliation
             SET lifecycle = ?, reconciliation_json = ?, revision = ?, updated_at = ?
             WHERE reconciliation_id = ? AND revision = ?`,
          )
          .run(
            next.lifecycle,
            stringifyCanonical(next),
            next.revision,
            now,
            next.reconciliationId,
            existing.revision,
          );
        return next;
      });
    },

    resolveReconciliation(reconciliationId, repositories, resolution) {
      return transaction(db, () => {
        const existing = readReconciliation(reconciliationId);
        if (existing === undefined)
          throw new StateStoreError(`unknown task integration reconciliation: ${reconciliationId}`);
        if (existing.lifecycle === "integrated") return existing;
        if (existing.lifecycle === "blocked")
          throw new StateStoreError(
            `blocked task integration reconciliation cannot resolve: ${reconciliationId}`,
          );
        const entry = readEntry(existing.integrationId);
        if (entry === undefined)
          throw new StateStoreError(`unknown task integration: ${existing.integrationId}`);
        const now = clock.nowIso();
        for (const repository of repositories) {
          if (repository.candidateSha === null || repository.resultSha !== repository.candidateSha)
            throw new StateStoreError(
              `reconciliation result does not prove candidate for ${repository.repositoryId}`,
            );
          const changed = handle
            .prepare(
              `UPDATE epic_repository_branch
               SET expected_local_sha = ?, lifecycle = 'ready', revision = revision + 1, updated_at = ?
               WHERE run_id = ? AND repository_id = ?
                 AND expected_local_sha IN (?, ?)`,
            )
            .run(
              repository.candidateSha,
              now,
              entry.runId,
              repository.repositoryId,
              repository.expectedTargetSha,
              repository.candidateSha,
            );
          if (changed.changes !== 1)
            throw new StateStoreError(
              `epic branch reconciliation evidence changed for ${repository.repositoryId}`,
            );
        }
        const nextEntry: TaskIntegrationLedgerEntry = {
          ...entry,
          lifecycle: "integrated",
          repositories,
          revision: entry.revision + 1,
          updatedAt: now,
        };
        handle
          .prepare(
            `UPDATE task_integration_ledger
             SET lifecycle = 'integrated', entry_json = ?, revision = ?, updated_at = ?
             WHERE integration_id = ? AND revision = ?`,
          )
          .run(
            stringifyCanonical(nextEntry),
            nextEntry.revision,
            now,
            nextEntry.integrationId,
            entry.revision,
          );
        const gates = handle
          .prepare(
            `UPDATE task_lifecycle_projection
             SET completion_contract = 'passed', integration = 'passed', combined_verification = 'passed',
                 revision = revision + 1, updated_at = ?
             WHERE run_id = ? AND task_id = ? AND phase = 'succeeded'`,
          )
          .run(now, entry.runId, entry.taskId);
        if (gates.changes !== 1)
          throw new StateStoreError(
            `task integration gates require succeeded task ${entry.taskId}`,
          );
        const next: TaskIntegrationReconciliation = {
          ...existing,
          lifecycle: "integrated",
          repositories: existing.repositories,
          resolution,
          blocker: null,
          revision: existing.revision + 1,
          updatedAt: now,
        };
        handle
          .prepare(
            `UPDATE task_integration_reconciliation
             SET lifecycle = 'integrated', reconciliation_json = ?, revision = ?, updated_at = ?
             WHERE reconciliation_id = ? AND revision = ?`,
          )
          .run(
            stringifyCanonical(next),
            next.revision,
            now,
            next.reconciliationId,
            existing.revision,
          );
        return next;
      });
    },

    reconciliations(runId) {
      return (
        handle
          .prepare(
            `SELECT reconciliation_json FROM task_integration_reconciliation
             WHERE run_id = ? ORDER BY created_at, reconciliation_id`,
          )
          .all(runId) as { reconciliation_json: string }[]
      ).map((row) => parseReconciliation(row.reconciliation_json));
    },

    appendReconciliationObservation(observation) {
      return transaction(db, () => {
        handle
          .prepare(
            `INSERT INTO task_integration_reconciliation_observation
              (observation_id, reconciliation_id, integration_id, run_id, task_id,
               pass, sequence, repository_id, observation_json, observed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            observation.observationId,
            observation.reconciliationId,
            observation.integrationId,
            observation.runId,
            observation.taskId,
            observation.pass,
            observation.sequence,
            observation.repositoryId,
            stringifyCanonical(observation),
            observation.observedAt,
          );
        return observation;
      });
    },

    reconciliationObservations(runId) {
      return (
        handle
          .prepare(
            `SELECT observation_json FROM task_integration_reconciliation_observation
             WHERE run_id = ? ORDER BY observed_at, observation_id`,
          )
          .all(runId) as { observation_json: string }[]
      ).map((row) => parseReconciliationObservation(row.observation_json));
    },

    appendTrace(trace) {
      return transaction(db, () => {
        const existing = handle
          .prepare("SELECT trace_json FROM task_integration_trace WHERE trace_id = ?")
          .get(trace.traceId) as { trace_json: string } | undefined;
        if (existing !== undefined) {
          const adopted = JSON.parse(existing.trace_json) as TaskIntegrationTrace;
          if (stringifyCanonical(adopted) !== stringifyCanonical(trace))
            throw new StateStoreError(`task integration trace conflict: ${trace.traceId}`);
          return adopted;
        }
        handle
          .prepare(
            `INSERT INTO task_integration_trace
              (trace_id, integration_id, run_id, task_id, sequence, phase, trace_json, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            trace.traceId,
            trace.integrationId,
            trace.runId,
            trace.taskId,
            trace.sequence,
            trace.phase,
            stringifyCanonical(trace),
            trace.recordedAt,
          );
        return trace;
      });
    },

    traces(integrationId) {
      return (
        handle
          .prepare(
            "SELECT trace_json FROM task_integration_trace WHERE integration_id = ? ORDER BY sequence",
          )
          .all(integrationId) as { trace_json: string }[]
      ).map((row) => JSON.parse(row.trace_json) as TaskIntegrationTrace);
    },
  };
}
