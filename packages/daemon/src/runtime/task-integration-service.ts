import type {
  EpicRepositoryBranch,
  RunId,
  TaskDagV2,
  TaskDispatchRecord,
  TaskIntegrationLedgerEntry,
  TaskIntegrationTrace,
  TaskLifecycleProjection,
} from "@heniek/contracts";
import {
  createTaskIntegrationStateStore,
  type InitializeEpicBranchInput,
  type StateDatabase,
} from "@heniek/state";

export interface EpicBranchObservation extends InitializeEpicBranchInput {}

export interface TaskIntegrationWork {
  readonly variantId: string;
}

export interface TaskIntegrationInventoryResult {
  readonly classification: "ready" | "no_changes" | "replanning_required" | "recovery_required";
  readonly detail: string;
}

export interface TaskIntegrationPrepareResult {
  readonly classification:
    | "prepared"
    | "conflict"
    | "stale_source"
    | "stale_target"
    | "recovery_required";
  readonly repositories: TaskIntegrationLedgerEntry["repositories"];
}

export interface TaskIntegrationVerificationResult {
  readonly classification: "passed" | "failed";
  readonly reportId: string;
}

export interface TaskIntegrationPublishResult {
  readonly classification:
    | "integrated"
    | "already_applied"
    | "conflict"
    | "stale_target"
    | "partial_progress"
    | "recovery_required";
  readonly repositories: TaskIntegrationLedgerEntry["repositories"];
}

/** Provider-neutral adapter over Q036/Q037/Q038 workspace operations. */
export interface TaskIntegrationDriver {
  observeBranches(runId: RunId): Promise<readonly EpicBranchObservation[]>;
  resolve(dispatch: TaskDispatchRecord): Promise<TaskIntegrationWork | null>;
  inventory(work: TaskIntegrationWork): Promise<TaskIntegrationInventoryResult>;
  prepare(work: TaskIntegrationWork): Promise<TaskIntegrationPrepareResult>;
  verify(
    work: TaskIntegrationWork,
    repositories: TaskIntegrationLedgerEntry["repositories"],
  ): Promise<TaskIntegrationVerificationResult>;
  publish(work: TaskIntegrationWork): Promise<TaskIntegrationPublishResult>;
}

export interface TaskIntegrationTickInput {
  readonly runId: RunId;
  readonly dag: TaskDagV2;
  readonly tasks: readonly TaskLifecycleProjection[];
  readonly dispatches: readonly TaskDispatchRecord[];
}

export interface TaskIntegrationStatus {
  readonly branches: readonly EpicRepositoryBranch[];
  readonly entries: readonly TaskIntegrationLedgerEntry[];
  readonly traces: readonly TaskIntegrationTrace[];
}

export interface TaskIntegrationService {
  tick(input: TaskIntegrationTickInput): Promise<TaskIntegrationStatus>;
  status(runId: RunId): TaskIntegrationStatus;
}

export interface TaskIntegrationServiceOptions {
  readonly db: StateDatabase;
  readonly driver: TaskIntegrationDriver;
  readonly clock: { nowIso(): string };
}

function terminal(lifecycle: TaskIntegrationLedgerEntry["lifecycle"]): boolean {
  return (
    lifecycle === "integrated" || lifecycle === "failed" || lifecycle === "reconciliation_required"
  );
}

export function createTaskIntegrationService(
  options: TaskIntegrationServiceOptions,
): TaskIntegrationService {
  const store = createTaskIntegrationStateStore(options.db);

  const status = (runId: RunId): TaskIntegrationStatus => {
    const entries = store.entries(runId);
    return {
      branches: store.branches(runId),
      entries,
      traces: entries.flatMap((entry) => store.traces(entry.integrationId)),
    };
  };

  const trace = (
    entry: TaskIntegrationLedgerEntry,
    value: Omit<
      TaskIntegrationTrace,
      "schemaVersion" | "traceId" | "integrationId" | "runId" | "taskId" | "sequence" | "recordedAt"
    >,
  ): TaskIntegrationTrace => {
    const existing = store
      .traces(entry.integrationId)
      .find(
        (candidate) =>
          candidate.phase === value.phase &&
          candidate.repositoryId === value.repositoryId &&
          candidate.expectedSha === value.expectedSha &&
          candidate.observedSha === value.observedSha &&
          candidate.candidateSha === value.candidateSha &&
          candidate.verificationReportId === value.verificationReportId &&
          candidate.classification === value.classification,
      );
    if (existing !== undefined) return existing;
    const sequence = store.traces(entry.integrationId).length + 1;
    return store.appendTrace({
      schemaVersion: 1,
      traceId: `${entry.integrationId}:trace:${sequence}`,
      integrationId: entry.integrationId,
      runId: entry.runId,
      taskId: entry.taskId,
      sequence,
      ...value,
      recordedAt: options.clock.nowIso(),
    } as TaskIntegrationTrace);
  };

  const recordRepositories = (
    entry: TaskIntegrationLedgerEntry,
    phase: "target_observed" | "merge_prepared" | "ref_update_observed",
    repositories: TaskIntegrationLedgerEntry["repositories"],
  ): void => {
    for (const repository of [...repositories].sort((a, b) =>
      a.repositoryId.localeCompare(b.repositoryId),
    )) {
      trace(entry, {
        repositoryId: repository.repositoryId,
        phase,
        expectedSha: repository.expectedTargetSha,
        observedSha: repository.resultSha ?? repository.expectedTargetSha,
        candidateSha: repository.candidateSha,
        verificationReportId: entry.verificationReportId,
        classification: repository.classification,
      });
    }
  };

  const reconcile = (
    entry: TaskIntegrationLedgerEntry,
    expectedLifecycle: TaskIntegrationLedgerEntry["lifecycle"],
    classification: string,
    repositories = entry.repositories,
  ): TaskIntegrationLedgerEntry => {
    trace(entry, {
      repositoryId: null,
      phase: "reconciliation_required",
      expectedSha: null,
      observedSha: null,
      candidateSha: null,
      verificationReportId: entry.verificationReportId,
      classification,
    });
    return store.transition({
      integrationId: entry.integrationId,
      expectedLifecycle,
      lifecycle: "reconciliation_required",
      repositories,
      gates: {
        completionContract: "passed",
        integration: "reconciliation_required",
        combinedVerification: entry.verification,
      },
    });
  };

  const process = async (
    entry: TaskIntegrationLedgerEntry,
    dispatch: TaskDispatchRecord,
  ): Promise<TaskIntegrationLedgerEntry> => {
    const work = await options.driver.resolve(dispatch);
    if (work === null || work.variantId !== entry.variantId)
      return reconcile(entry, entry.lifecycle, "missing_task_binding");

    if (entry.lifecycle === "queued") {
      trace(entry, {
        repositoryId: null,
        phase: "source_observed",
        expectedSha: null,
        observedSha: null,
        candidateSha: null,
        verificationReportId: null,
        classification: "inventory_started",
      });
      const inventory = await options.driver.inventory(work);
      if (
        inventory.classification === "replanning_required" ||
        inventory.classification === "recovery_required"
      )
        return reconcile(entry, "queued", inventory.classification);

      const prepared: TaskIntegrationPrepareResult =
        inventory.classification === "no_changes"
          ? { classification: "prepared", repositories: [] }
          : await options.driver.prepare(work);
      if (prepared.classification !== "prepared")
        return reconcile(entry, "queued", prepared.classification, prepared.repositories);
      recordRepositories(entry, "merge_prepared", prepared.repositories);
      entry = store.transition({
        integrationId: entry.integrationId,
        expectedLifecycle: "queued",
        lifecycle: "prepared",
        repositories: prepared.repositories,
        gates: {
          completionContract: "passed",
          integration: "pending",
          combinedVerification: "pending",
        },
      });
    }

    if (entry.lifecycle === "prepared") {
      trace(entry, {
        repositoryId: null,
        phase: "verification_started",
        expectedSha: null,
        observedSha: null,
        candidateSha: null,
        verificationReportId: null,
        classification: "started",
      });
      const verification = await options.driver.verify(work, entry.repositories);
      trace(entry, {
        repositoryId: null,
        phase: "verification_finished",
        expectedSha: null,
        observedSha: null,
        candidateSha: null,
        verificationReportId: verification.reportId,
        classification: verification.classification,
      });
      if (verification.classification === "failed") {
        return store.transition({
          integrationId: entry.integrationId,
          expectedLifecycle: "prepared",
          lifecycle: "failed",
          verificationReportId: verification.reportId,
          verification: "failed",
          gates: {
            completionContract: "passed",
            integration: "pending",
            combinedVerification: "failed",
          },
        });
      }
      entry = store.transition({
        integrationId: entry.integrationId,
        expectedLifecycle: "prepared",
        lifecycle: "verified",
        verificationReportId: verification.reportId,
        verification: "passed",
      });
    }

    if (entry.lifecycle === "verified") {
      if (entry.repositories.length === 0) {
        trace(entry, {
          repositoryId: null,
          phase: "completed",
          expectedSha: null,
          observedSha: null,
          candidateSha: null,
          verificationReportId: entry.verificationReportId,
          classification: "no_changes",
        });
        return store.transition({
          integrationId: entry.integrationId,
          expectedLifecycle: "verified",
          lifecycle: "integrated",
          gates: {
            completionContract: "passed",
            integration: "passed",
            combinedVerification: "passed",
          },
        });
      }
      trace(entry, {
        repositoryId: null,
        phase: "ref_update_attempted",
        expectedSha: null,
        observedSha: null,
        candidateSha: null,
        verificationReportId: entry.verificationReportId,
        classification: "started",
      });
      const publication = await options.driver.publish(work);
      recordRepositories(entry, "ref_update_observed", publication.repositories);
      if (
        publication.classification !== "integrated" &&
        publication.classification !== "already_applied"
      )
        return reconcile(entry, "verified", publication.classification, publication.repositories);
      trace(entry, {
        repositoryId: null,
        phase: publication.classification === "already_applied" ? "adopted" : "completed",
        expectedSha: null,
        observedSha: null,
        candidateSha: null,
        verificationReportId: entry.verificationReportId,
        classification: publication.classification,
      });
      return store.transition({
        integrationId: entry.integrationId,
        expectedLifecycle: "verified",
        lifecycle: "integrated",
        repositories: publication.repositories,
        gates: {
          completionContract: "passed",
          integration: "passed",
          combinedVerification: "passed",
        },
      });
    }
    return entry;
  };

  return {
    async tick(input) {
      const branches = await options.driver.observeBranches(input.runId);
      const observed = branches.map((branch) => store.initializeBranch(branch));
      if (observed.some((branch) => branch.lifecycle === "reconciliation_required"))
        return status(input.runId);

      const order = new Map(
        [...input.dag.nodes]
          .sort((a, b) => a.task.taskId.localeCompare(b.task.taskId))
          .map((node, index) => [node.task.taskId, index]),
      );
      const dispatches = [...input.dispatches].sort((left, right) => {
        const wave = left.waveOrdinal - right.waveOrdinal;
        return wave !== 0
          ? wave
          : (order.get(left.taskId) ?? Number.MAX_SAFE_INTEGER) -
              (order.get(right.taskId) ?? Number.MAX_SAFE_INTEGER);
      });
      for (const [index, dispatch] of dispatches.entries()) {
        store.enqueue({
          integrationId: `task-integration:${dispatch.runId}:${dispatch.graphRevision}:${dispatch.taskId}`,
          runId: dispatch.runId,
          taskId: dispatch.taskId,
          graphRevision: dispatch.graphRevision,
          waveOrdinal: dispatch.waveOrdinal,
          integrationOrdinal: index + 1,
          variantId: `task-variant:${dispatch.runId}:${dispatch.graphRevision}:${dispatch.taskId}`,
        });
      }

      for (const entry of store.entries(input.runId)) {
        if (terminal(entry.lifecycle)) continue;
        const task = input.tasks.find((candidate) => candidate.taskId === entry.taskId);
        if (
          task === undefined ||
          task.phase === "not_started" ||
          task.phase === "dispatching" ||
          task.phase === "active" ||
          task.phase === "retrying" ||
          task.phase === "cancelling" ||
          task.phase === "recovery_required"
        )
          break;
        if (task.phase === "failed" || task.phase === "cancelled" || task.phase === "blocked") {
          store.transition({
            integrationId: entry.integrationId,
            expectedLifecycle: entry.lifecycle,
            lifecycle: "failed",
          });
          continue;
        }
        const dispatch = dispatches.find((candidate) => candidate.taskId === entry.taskId);
        if (dispatch === undefined) break;
        const result = await process(entry, dispatch);
        if (result.lifecycle !== "integrated") break;
      }
      return status(input.runId);
    },

    status,
  };
}
