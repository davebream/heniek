import type {
  EpicRepositoryBranch,
  RunId,
  TaskDagV2,
  TaskDispatchRecord,
  TaskIntegrationLedgerEntry,
  TaskIntegrationReconciliation,
  TaskIntegrationReconciliationObservation,
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

export interface TaskIntegrationRepositoryObservation {
  readonly repositoryId: string;
  readonly observedSha: string | null;
  readonly classification: "observed" | "missing_ref" | "observation_failed" | "identity_mismatch";
  readonly detail: string | null;
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
  observe(
    work: TaskIntegrationWork,
    repositories: TaskIntegrationLedgerEntry["repositories"],
  ): Promise<readonly TaskIntegrationRepositoryObservation[]>;
  publish(
    work: TaskIntegrationWork,
    repositories: TaskIntegrationLedgerEntry["repositories"],
  ): Promise<TaskIntegrationPublishResult>;
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
  readonly reconciliations: readonly TaskIntegrationReconciliation[];
  readonly reconciliationObservations: readonly TaskIntegrationReconciliationObservation[];
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
      reconciliations: store.reconciliations(runId),
      reconciliationObservations: store.reconciliationObservations(runId),
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
    trigger: TaskIntegrationReconciliation["trigger"] = "recovery_required",
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
    const reconciled = store.transition({
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
    store.startReconciliation({ entry: reconciled, trigger });
    return reconciled;
  };

  const reconcileEntry = async (
    entry: TaskIntegrationLedgerEntry,
    dispatch: TaskDispatchRecord,
    allowForward = true,
  ): Promise<TaskIntegrationLedgerEntry> => {
    const work = await options.driver.resolve(dispatch);
    let reconciliation = store.startReconciliation({
      entry,
      trigger: entry.repositories.some((repository) => repository.resultSha !== null)
        ? "partial_publish"
        : "recovery_required",
    });
    const previousActions = reconciliation.repositories.map((repository) => repository.action);
    if (reconciliation.lifecycle === "integrated" || reconciliation.lifecycle === "blocked")
      return entry;

    if (work === null || work.variantId !== entry.variantId || entry.repositories.length === 0) {
      store.advanceReconciliation({
        reconciliationId: reconciliation.reconciliationId,
        expectedLifecycle: reconciliation.lifecycle,
        lifecycle: "blocked",
        repositories: [],
        resolution: "blocked",
        blocker: "missing_evidence",
      });
      return entry;
    }

    const pass = reconciliation.pass + 1;
    reconciliation = store.advanceReconciliation({
      reconciliationId: reconciliation.reconciliationId,
      expectedLifecycle: reconciliation.lifecycle,
      lifecycle: "observing",
      pass,
    });
    let observed: readonly TaskIntegrationRepositoryObservation[];
    try {
      observed = await options.driver.observe(work, entry.repositories);
    } catch (error) {
      const detail = (
        error instanceof Error ? error.message : "repository observation failed"
      ).slice(0, 1024);
      observed = entry.repositories.map((repository) => ({
        repositoryId: repository.repositoryId,
        observedSha: null,
        classification: "observation_failed" as const,
        detail,
      }));
    }

    const byRepository = new Map(
      observed.map((observation) => [observation.repositoryId, observation]),
    );
    const existingCount = store
      .reconciliationObservations(entry.runId)
      .filter(
        (observation) => observation.reconciliationId === reconciliation.reconciliationId,
      ).length;
    const repositories: TaskIntegrationReconciliation["repositories"] = [];
    for (const [index, repository] of [...entry.repositories]
      .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId))
      .entries()) {
      const observation = byRepository.get(repository.repositoryId);
      let classification: TaskIntegrationReconciliation["repositories"][number]["classification"];
      let action: TaskIntegrationReconciliation["repositories"][number]["action"];
      let detail = observation?.detail ?? null;
      if (repository.candidateSha === null) {
        classification = "missing_candidate";
        action = "block";
        detail = detail ?? "prepared candidate SHA is missing";
      } else if (observation === undefined || observation.classification === "missing_ref") {
        classification = "missing_ref";
        action = "block";
        detail = detail ?? "repository ref observation is missing";
      } else if (observation.classification === "observation_failed") {
        classification = "observation_failed";
        action = "block";
      } else if (observation.classification === "identity_mismatch") {
        classification = "identity_mismatch";
        action = "block";
      } else if (observation.observedSha === repository.candidateSha) {
        classification = "applied";
        action = "adopt";
      } else if (observation.observedSha === repository.expectedTargetSha) {
        classification = "pending";
        action = "publish";
      } else {
        classification = "external_mutation";
        action = "block";
        detail =
          detail ?? "observed SHA matches neither the expected target nor prepared candidate";
      }
      const projected = {
        repositoryId: repository.repositoryId,
        expectedSha: repository.expectedTargetSha,
        candidateSha: repository.candidateSha,
        observedSha: observation?.observedSha ?? null,
        classification,
        action,
        detail,
      };
      repositories.push(projected);
      const sequence = existingCount + index + 1;
      store.appendReconciliationObservation({
        schemaVersion: 1,
        observationId: `${reconciliation.reconciliationId}:observation:${sequence}`,
        reconciliationId: reconciliation.reconciliationId,
        integrationId: entry.integrationId,
        runId: entry.runId,
        taskId: entry.taskId,
        pass,
        sequence,
        repositoryId: repository.repositoryId,
        expectedSha: repository.expectedTargetSha,
        candidateSha: repository.candidateSha,
        observedSha: observation?.observedSha ?? null,
        classification,
        detail,
        observedAt: options.clock.nowIso(),
      });
    }

    const blocked = repositories.find((repository) => repository.action === "block");
    if (blocked !== undefined) {
      const blocker: Exclude<TaskIntegrationReconciliation["blocker"], null> =
        blocked.classification === "external_mutation"
          ? "external_mutation"
          : blocked.classification === "observation_failed" ||
              blocked.classification === "missing_ref"
            ? "observation_failed"
            : blocked.classification === "identity_mismatch"
              ? "identity_mismatch"
              : "missing_evidence";
      store.advanceReconciliation({
        reconciliationId: reconciliation.reconciliationId,
        expectedLifecycle: "observing",
        lifecycle: "blocked",
        repositories,
        resolution: "blocked",
        blocker,
      });
      return entry;
    }

    const pending = repositories.filter((repository) => repository.action === "publish");
    if (pending.length > 0) {
      if (!allowForward) {
        store.advanceReconciliation({
          reconciliationId: reconciliation.reconciliationId,
          expectedLifecycle: "observing",
          lifecycle: "blocked",
          repositories,
          resolution: "blocked",
          blocker: "ambiguous_state",
        });
        return entry;
      }
      store.advanceReconciliation({
        reconciliationId: reconciliation.reconciliationId,
        expectedLifecycle: "observing",
        lifecycle: "forwarding",
        repositories,
      });
      const selected = entry.repositories.filter((repository) =>
        pending.some((candidate) => candidate.repositoryId === repository.repositoryId),
      );
      try {
        await options.driver.publish(work, selected);
      } catch {
        return entry;
      }
      return reconcileEntry(entry, dispatch, false);
    }

    const hadForward = previousActions.includes("publish");
    const hadAdoption = previousActions.includes("adopt");
    const resolution = hadForward
      ? hadAdoption
        ? "mixed_forward_and_adopt"
        : "forward_published"
      : "adopted_published";
    const resolvedRepositories = entry.repositories.map((repository) => ({
      ...repository,
      resultSha: repository.candidateSha,
      classification:
        repository.resultSha === repository.candidateSha ? "integrated" : "already_applied",
    }));
    store.resolveReconciliation(reconciliation.reconciliationId, resolvedRepositories, resolution);
    return store
      .entries(entry.runId)
      .find(
        (candidate) => candidate.integrationId === entry.integrationId,
      ) as TaskIntegrationLedgerEntry;
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
      let publication: TaskIntegrationPublishResult;
      try {
        publication = await options.driver.publish(work, entry.repositories);
      } catch {
        return reconcile(
          entry,
          "verified",
          "interrupted_publish",
          entry.repositories,
          "interrupted_publish",
        );
      }
      recordRepositories(entry, "ref_update_observed", publication.repositories);
      if (
        publication.classification !== "integrated" &&
        publication.classification !== "already_applied"
      )
        return reconcile(
          entry,
          "verified",
          publication.classification,
          publication.repositories,
          publication.classification === "partial_progress"
            ? "partial_publish"
            : "recovery_required",
        );
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

      if (observed.some((branch) => branch.lifecycle === "reconciliation_required")) {
        const entries = store.entries(input.runId);
        const hasActiveReconciliation = entries.some(
          (entry) => entry.lifecycle === "reconciliation_required",
        );
        const first = entries.find(
          (entry) =>
            !terminal(entry.lifecycle) &&
            input.tasks.find((task) => task.taskId === entry.taskId)?.phase === "succeeded",
        );
        if (!hasActiveReconciliation && first !== undefined)
          reconcile(first, first.lifecycle, "branch_drift", first.repositories, "branch_drift");
      }

      for (const entry of store.entries(input.runId)) {
        if (entry.lifecycle === "reconciliation_required") {
          const dispatch = dispatches.find((candidate) => candidate.taskId === entry.taskId);
          if (dispatch !== undefined) await reconcileEntry(entry, dispatch);
          break;
        }
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
