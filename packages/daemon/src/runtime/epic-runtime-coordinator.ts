import type {
  HiddenDependencyFinding,
  HiddenDependencyReplan,
  RunId,
  TaskGraphRevisionProposal,
  TaskPlanningState,
} from "@heniek/contracts";
import { createHiddenDependencyReplanStateStore, type StateDatabase } from "@heniek/state";
import type { TaskGraphRevisionService } from "./task-graph-revision-service.js";
import type { TaskIntegrationService, TaskIntegrationStatus } from "./task-integration-service.js";
import type {
  TaskWaveSchedulerService,
  TaskWaveSchedulerStatus,
  TaskWaveSchedulerTickInput,
} from "./task-wave-scheduler-service.js";

type HiddenDependencyProposal = Extract<TaskGraphRevisionProposal, { schemaVersion: 2 }>;

export interface ReportHiddenDependencyInput {
  readonly finding: HiddenDependencyFinding;
  readonly proposal: HiddenDependencyProposal;
}

export interface EpicRuntimeTickInput
  extends Omit<TaskWaveSchedulerTickInput, "dag" | "unresolvedGraphRevision"> {
  readonly maxGraphRevisions: number;
}

export interface EpicRuntimeStatus {
  readonly graph: ReturnType<TaskGraphRevisionService["active"]>;
  readonly scheduler: TaskWaveSchedulerStatus;
  readonly integration: TaskIntegrationStatus | null;
  readonly findings: readonly HiddenDependencyFinding[];
  readonly replans: readonly HiddenDependencyReplan[];
}

export interface EpicRuntimeCoordinator {
  reportHiddenDependency(input: ReportHiddenDependencyInput): Promise<HiddenDependencyReplan>;
  tick(input: EpicRuntimeTickInput): Promise<EpicRuntimeStatus>;
  status(runId: RunId): EpicRuntimeStatus;
}

export interface EpicRuntimeCoordinatorOptions {
  readonly db: StateDatabase;
  readonly scheduler: TaskWaveSchedulerService;
  readonly revisions: TaskGraphRevisionService;
  readonly integration?: TaskIntegrationService;
}

function planningStates(
  status: TaskWaveSchedulerStatus,
  activeTaskIds: readonly string[],
): readonly TaskPlanningState[] {
  const active = new Set(activeTaskIds);
  return status.tasks
    .filter((task) => active.has(task.taskId))
    .map((task) => ({
      taskId: task.taskId,
      outcome:
        task.phase === "not_started"
          ? "not_started"
          : task.phase === "succeeded" ||
              task.phase === "failed" ||
              task.phase === "cancelled" ||
              task.phase === "blocked"
            ? task.phase
            : "active",
      completionContract: task.completionContract,
      integration: task.integration,
      combinedVerification: task.combinedVerification,
    })) as readonly TaskPlanningState[];
}

/** Coordinates Q041 revision, Q042 scheduling, and Q043/Q044 integration for one epic run. */
export function createEpicRuntimeCoordinator(
  options: EpicRuntimeCoordinatorOptions,
): EpicRuntimeCoordinator {
  const store = createHiddenDependencyReplanStateStore(options.db);

  const status = (runId: RunId): EpicRuntimeStatus => ({
    graph: options.revisions.active(runId),
    scheduler: options.scheduler.status(runId),
    integration: options.integration?.status(runId) ?? null,
    findings: store.findings(runId),
    replans: store.replans(runId),
  });

  const block = (
    replan: HiddenDependencyReplan,
    blocker: NonNullable<HiddenDependencyReplan["blocker"]>,
  ) =>
    store.advance({
      replanId: replan.replanId,
      expectedLifecycle: replan.lifecycle,
      lifecycle: "blocked",
      blocker,
    });

  return {
    async reportHiddenDependency(input) {
      const active = options.revisions.active(input.finding.runId);
      if (active === undefined)
        throw new Error(`task graph is not initialized for ${input.finding.runId}`);
      if (
        active.graphId !== input.finding.graphId ||
        active.graphRevision !== input.finding.graphRevision ||
        active.revisionSha256 !== input.finding.revisionSha256
      )
        throw new Error("hidden dependency finding does not cite the active graph");
      if (!input.finding.affectedTaskIds.includes(input.finding.reporterTaskId))
        throw new Error("hidden dependency reporter must be included in affected tasks");
      if (
        input.proposal.trigger.interruptedTaskIds.length !== input.finding.affectedTaskIds.length ||
        input.proposal.trigger.interruptedTaskIds.some(
          (taskId) => !input.finding.affectedTaskIds.includes(taskId),
        )
      )
        throw new Error("hidden dependency interrupted tasks must match affected tasks");
      const activeTaskIds = new Set(active.dag.nodes.map((node) => node.task.taskId));
      if (input.finding.prerequisiteTaskIds.some((taskId) => !activeTaskIds.has(taskId)))
        throw new Error("hidden dependency prerequisite is not in the active graph");
      const existing = store
        .replans(input.finding.runId)
        .find((candidate) => candidate.finding.findingId === input.finding.findingId);
      if (existing === undefined) {
        const tasks = options.scheduler.status(input.finding.runId).tasks;
        for (const taskId of input.proposal.trigger.interruptedTaskIds) {
          const task = tasks.find((candidate) => candidate.taskId === taskId);
          if (
            task === undefined ||
            !["dispatching", "active", "retrying", "cancelling"].includes(task.phase)
          )
            throw new Error(`hidden dependency interrupted task ${taskId} is not active`);
          const supersede = input.proposal.changes.find(
            (change) =>
              change.kind === "supersede" &&
              change.beforeTaskIds.length === 1 &&
              change.beforeTaskIds[0] === taskId &&
              change.afterTaskIds.length === 1,
          );
          if (supersede === undefined)
            throw new Error(`hidden dependency interrupted task ${taskId} has no replacement`);
        }
      }
      const replacementTaskIds = input.proposal.changes
        .filter((change) => change.kind === "supersede")
        .flatMap((change) => change.afterTaskIds);
      const replan = store.record({
        replanId: `hidden-dependency-replan:${input.finding.runId}:${input.finding.findingId}`,
        finding: input.finding,
        proposal: input.proposal,
        replacementTaskIds,
      });
      for (const taskId of replan.interruptedTaskIds) {
        await options.scheduler.cancel(input.finding.runId, taskId);
      }
      return replan;
    },

    async tick(input) {
      let graph = options.revisions.active(input.runId);
      if (graph === undefined) throw new Error(`task graph is not initialized for ${input.runId}`);
      let replan = store.active(input.runId);
      let scheduler = await options.scheduler.tick({
        ...input,
        dag: graph.dag,
        unresolvedGraphRevision: replan !== undefined,
      });

      if (replan?.lifecycle === "quiescing") {
        const interrupted = replan.interruptedTaskIds.map((taskId) =>
          scheduler.tasks.find((task) => task.taskId === taskId),
        );
        if (
          interrupted.some(
            (task) =>
              task === undefined || task.phase === "recovery_required" || task.phase === "failed",
          )
        ) {
          block(replan, "cancellation_unconfirmed");
          return status(input.runId);
        }
        const integration = options.integration?.status(input.runId);
        if (
          integration?.entries.some((entry) => entry.lifecycle === "reconciliation_required") ||
          integration?.reconciliations.some(
            (candidate) =>
              candidate.lifecycle === "blocked" || candidate.lifecycle === "forwarding",
          )
        ) {
          block(replan, "integration_reconciliation_required");
          return status(input.runId);
        }
        const prerequisiteStates = replan.finding.prerequisiteTaskIds.map((taskId) =>
          scheduler.tasks.find((task) => task.taskId === taskId),
        );
        if (
          prerequisiteStates.some(
            (task) =>
              task === undefined ||
              task.phase === "failed" ||
              task.phase === "cancelled" ||
              task.phase === "blocked" ||
              task.phase === "recovery_required",
          )
        ) {
          block(replan, "prerequisite_unsatisfied");
          return status(input.runId);
        }
        const awaitingIntegratedPredecessor = prerequisiteStates.some(
          (task) =>
            task !== undefined &&
            (task.phase !== "succeeded" ||
              task.completionContract !== "passed" ||
              task.integration !== "passed" ||
              task.combinedVerification !== "passed"),
        );
        if (
          interrupted.every((task) => task?.phase === "cancelled") &&
          !awaitingIntegratedPredecessor
        ) {
          replan = store.advance({
            replanId: replan.replanId,
            expectedLifecycle: "quiescing",
            lifecycle: "revising",
          });
        }
      }

      if (replan?.lifecycle === "revising") {
        graph = options.revisions.active(input.runId);
        if (graph === undefined)
          throw new Error(`task graph is not initialized for ${input.runId}`);
        if (
          graph.graphRevision === replan.proposal.proposedDag.graphRevision &&
          graph.schemaVersion === 2 &&
          graph.trigger.findingId === replan.finding.findingId
        ) {
          store.advance({
            replanId: replan.replanId,
            expectedLifecycle: "revising",
            lifecycle: "resumed",
            decisionId: graph.decisionId,
            resultingGraphRevision: graph.graphRevision,
          });
          scheduler = await options.scheduler.tick({
            ...input,
            dag: graph.dag,
            unresolvedGraphRevision: false,
          });
        } else {
          const decision = options.revisions.submit({
            proposal: replan.proposal,
            taskStates: planningStates(
              scheduler,
              graph.dag.nodes.map((node) => node.task.taskId),
            ),
            maxGraphRevisions: input.maxGraphRevisions,
            hiddenDependencyFinding: replan.finding,
          });
          if (decision.record === null) {
            const missingEvidence = decision.decision.diagnostics.some((diagnostic) =>
              diagnostic.code.startsWith("task-graph-revision.hidden-dependency-evidence"),
            );
            block(replan, missingEvidence ? "missing_evidence" : "revision_rejected");
            return status(input.runId);
          }
          store.advance({
            replanId: replan.replanId,
            expectedLifecycle: "revising",
            lifecycle: "resumed",
            decisionId: decision.decision.decisionId,
            resultingGraphRevision: decision.record.graphRevision,
          });
          graph = decision.record;
          scheduler = await options.scheduler.tick({
            ...input,
            dag: graph.dag,
            unresolvedGraphRevision: false,
          });
        }
      }
      return {
        graph: options.revisions.active(input.runId),
        scheduler,
        integration: options.integration?.status(input.runId) ?? null,
        findings: store.findings(input.runId),
        replans: store.replans(input.runId),
      };
    },

    status,
  };
}
