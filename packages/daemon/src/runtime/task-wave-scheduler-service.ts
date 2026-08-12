import type {
  RunId,
  TaskDagV2,
  TaskDispatchRecord,
  TaskLifecycleProjection,
  TaskPropagationReason,
  TaskWavePlanningSnapshot,
} from "@heniek/contracts";
import { planTaskWave } from "@heniek/pipeline";
import {
  createTaskWaveStateStore,
  type StateDatabase,
  type TaskWaveStateStore,
} from "@heniek/state";
import type { PipelineRunnerService } from "./pipeline-runner-service.js";

export type TaskPipelineStatus =
  | { readonly state: "missing" }
  | { readonly state: "queued" | "running" | "waiting_on_user" }
  | { readonly state: "retrying"; readonly attemptOrdinal: number }
  | { readonly state: "cancelling" }
  | { readonly state: "recovery_required" }
  | { readonly state: "succeeded" | "failed" | "cancelled" };

export interface TaskPipelineDriver {
  start(dispatch: TaskDispatchRecord): Promise<void>;
  tick(childRunId: string): Promise<TaskPipelineStatus>;
  status(childRunId: string): Promise<TaskPipelineStatus>;
  cancel(childRunId: string): Promise<void>;
}

/** Adapter used by the daemon composition root after task-specific pipeline admission. */
export function createPipelineRunnerTaskDriver(input: {
  readonly runner: PipelineRunnerService;
  readonly launch: (dispatch: TaskDispatchRecord) => Promise<void>;
}): TaskPipelineDriver {
  return {
    start: input.launch,
    async tick(childRunId) {
      await input.runner.tick(childRunId);
      return input.runner.status(childRunId);
    },
    async status(childRunId) {
      return input.runner.status(childRunId);
    },
    async cancel(childRunId) {
      await input.runner.cancel(childRunId);
    },
  };
}

export interface TaskWaveSchedulerTickInput {
  readonly runId: RunId;
  readonly dag: TaskDagV2;
  readonly maxConcurrentWorkers: number;
  readonly profiles: readonly { readonly profileId: string; readonly available: boolean }[];
  readonly accounts: readonly {
    readonly accountId: string;
    readonly activeRuns: number;
    readonly maxConcurrentRuns: number;
  }[];
  readonly unresolvedGraphRevision?: boolean;
  readonly externalActiveWorkers?: number;
  readonly unavailableRepositoryIds?: readonly string[];
}

export interface TaskWaveSchedulerStatus {
  readonly tasks: readonly TaskLifecycleProjection[];
  readonly dispatches: ReturnType<TaskWaveStateStore["dispatches"]>;
  readonly leases: ReturnType<TaskWaveStateStore["leases"]>;
  readonly auditEvents: ReturnType<TaskWaveStateStore["auditEvents"]>;
}

export interface TaskWaveSchedulerService {
  initialize(runId: RunId, dag: TaskDagV2): void;
  tick(input: TaskWaveSchedulerTickInput): Promise<TaskWaveSchedulerStatus>;
  reconcile(runId: RunId, dag: TaskDagV2): Promise<TaskWaveSchedulerStatus>;
  cancel(runId: RunId, taskId: string): Promise<TaskLifecycleProjection>;
  status(runId: RunId): TaskWaveSchedulerStatus;
}

export interface TaskWaveSchedulerServiceOptions {
  readonly db: StateDatabase;
  readonly driver: TaskPipelineDriver;
  readonly clock: { nowIso(): string };
  readonly ids: { next(prefix: string): string };
}

function canonical(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function appendPath(path: readonly string[], taskId: string): readonly string[] {
  return path.includes(taskId) ? path : [...path, taskId];
}

export function createTaskWaveSchedulerService(
  options: TaskWaveSchedulerServiceOptions,
): TaskWaveSchedulerService {
  const store = createTaskWaveStateStore(options.db);

  const status = (runId: RunId): TaskWaveSchedulerStatus => ({
    tasks: store.projections(runId),
    dispatches: store.dispatches(runId),
    leases: store.leases(runId),
    auditEvents: store.auditEvents(runId),
  });

  const dispatchFor = (runId: RunId, taskId: string) =>
    store.dispatches(runId).find((dispatch) => dispatch.taskId === taskId);

  const applyDriverStatus = (
    runId: RunId,
    task: TaskLifecycleProjection,
    observation: TaskPipelineStatus,
  ): TaskLifecycleProjection => {
    if (observation.state === "missing") {
      if (task.phase === "dispatching") return task;
      return task.phase === "recovery_required"
        ? task
        : store.markRecoveryRequired(runId, task.taskId);
    }
    if (
      observation.state === "queued" ||
      observation.state === "running" ||
      observation.state === "waiting_on_user"
    ) {
      return task.phase === "dispatching" || task.phase === "retrying"
        ? store.markActive(runId, task.taskId)
        : task;
    }
    if (observation.state === "retrying") {
      return task.phase === "retrying" ? task : store.markRetrying(runId, task.taskId);
    }
    if (observation.state === "cancelling") {
      return task.phase === "cancelling" ? task : store.requestCancellation(runId, task.taskId);
    }
    if (observation.state === "recovery_required") {
      return task.phase === "recovery_required"
        ? task
        : store.markRecoveryRequired(runId, task.taskId);
    }
    return store.settle(runId, task.taskId, observation.state);
  };

  const reconcileTasks = async (runId: RunId): Promise<void> => {
    const active = store
      .projections(runId)
      .filter((task) =>
        ["dispatching", "active", "retrying", "cancelling", "recovery_required"].includes(
          task.phase,
        ),
      );
    await Promise.all(
      active.map(async (task) => {
        if (task.childRunId === null) return;
        let observation = await options.driver.status(task.childRunId);
        if (observation.state === "missing" && task.phase === "dispatching") {
          const dispatch = dispatchFor(runId, task.taskId);
          if (dispatch === undefined) {
            store.markRecoveryRequired(runId, task.taskId);
            return;
          }
          await options.driver.start(dispatch);
          observation = await options.driver.status(task.childRunId);
        }
        applyDriverStatus(runId, task, observation);
      }),
    );
  };

  const propagationReason = (
    taskId: string,
    nodes: ReadonlyMap<string, TaskDagV2["nodes"][number]>,
    states: ReadonlyMap<string, TaskLifecycleProjection>,
    visiting = new Set<string>(),
  ): TaskPropagationReason | undefined => {
    if (visiting.has(taskId)) return undefined;
    const nextVisiting = new Set(visiting).add(taskId);
    const reasons: TaskPropagationReason[] = [];
    for (const predecessorId of canonical(nodes.get(taskId)?.task.dependencies ?? [])) {
      const predecessor = states.get(predecessorId);
      if (predecessor?.phase === "failed" || predecessor?.phase === "cancelled") {
        reasons.push({
          schemaVersion: 1,
          code: predecessor.phase === "failed" ? "predecessor_failed" : "predecessor_cancelled",
          immediateTaskId: predecessorId,
          rootTaskId: predecessorId,
          path: [predecessorId, taskId],
        } as TaskPropagationReason);
      } else if (predecessor?.phase === "blocked" && predecessor.blockReason !== null) {
        reasons.push({
          ...predecessor.blockReason,
          code: "predecessor_blocked",
          immediateTaskId: predecessorId,
          path: appendPath(predecessor.blockReason.path, taskId),
        } as TaskPropagationReason);
      } else if (predecessor?.phase === "not_started") {
        const inherited = propagationReason(predecessorId, nodes, states, nextVisiting);
        if (inherited !== undefined) {
          reasons.push({
            ...inherited,
            code: "predecessor_blocked",
            immediateTaskId: predecessorId,
            path: appendPath(inherited.path, taskId),
          } as TaskPropagationReason);
        }
      }
    }
    return reasons.sort((left, right) => {
      const root = left.rootTaskId.localeCompare(right.rootTaskId);
      return root === 0 ? left.immediateTaskId.localeCompare(right.immediateTaskId) : root;
    })[0];
  };

  const propagate = (runId: RunId, dag: TaskDagV2): void => {
    const nodes = new Map(dag.nodes.map((node) => [node.task.taskId, node]));
    let changed = true;
    while (changed) {
      changed = false;
      const states = new Map(store.projections(runId).map((task) => [task.taskId, task]));
      for (const task of [...states.values()].sort((a, b) => a.taskId.localeCompare(b.taskId))) {
        if (task.phase !== "not_started") continue;
        const reason = propagationReason(task.taskId, nodes, states);
        if (reason !== undefined) {
          store.block(runId, task.taskId, reason);
          changed = true;
        }
      }
    }
  };

  const makeDispatch = (
    input: TaskWaveSchedulerTickInput,
    taskId: string,
    waveOrdinal: number,
  ): TaskDispatchRecord => {
    const node = input.dag.nodes.find((candidate) => candidate.task.taskId === taskId);
    if (node === undefined) throw new Error(`wave selected unknown task ${taskId}`);
    const suffix = `${input.runId}:${input.dag.graphRevision}:${taskId}`;
    return {
      schemaVersion: 1,
      dispatchId: `task-dispatch:${suffix}`,
      runId: input.runId,
      taskId,
      graphRevision: input.dag.graphRevision,
      waveOrdinal,
      childRunId: `task-run:${suffix}`,
      pipelineId: node.pipelineId,
      profileId: node.profileId,
      accountId: node.accountId,
      workspaceId: `task-workspace:${suffix}`,
      repositoryIds: canonical(node.task.writeSet),
      recordedAt: options.clock.nowIso(),
    } as TaskDispatchRecord;
  };

  return {
    initialize(runId, dag) {
      store.initialize(
        runId,
        dag.graphRevision,
        dag.nodes.map((node) => node.task.taskId),
      );
    },

    async tick(input) {
      this.initialize(input.runId, input.dag);
      await reconcileTasks(input.runId);
      propagate(input.runId, input.dag);

      const leases = store.leases(input.runId).filter((lease) => lease.state === "active");
      const taskAccountCounts = new Map<string, number>();
      for (const lease of leases.filter((candidate) => candidate.scope === "account")) {
        taskAccountCounts.set(lease.resourceId, (taskAccountCounts.get(lease.resourceId) ?? 0) + 1);
      }
      const unavailable = new Set(input.unavailableRepositoryIds ?? []);
      const repositories = canonical(input.dag.nodes.flatMap((node) => node.task.writeSet));
      const repositoryLeases = new Map(
        leases
          .filter((lease) => lease.scope === "repository")
          .map((lease) => [lease.resourceId, lease.taskId]),
      );
      const waveOrdinal = (store.plans(input.runId).at(-1)?.waveOrdinal ?? 0) + 1;
      const planningSnapshot = {
        schemaVersion: 2,
        dag: input.dag,
        waveOrdinal,
        unresolvedGraphRevision: input.unresolvedGraphRevision ?? false,
        tasks: store.planningStates(input.runId),
        profiles: input.profiles,
        accounts: input.accounts.map((account) => ({
          ...account,
          activeRuns: account.activeRuns + (taskAccountCounts.get(account.accountId) ?? 0),
        })),
        writerLeases: repositories.map((repositoryId) => ({
          repositoryId,
          available: !unavailable.has(repositoryId) && !repositoryLeases.has(repositoryId),
          holderTaskId: repositoryLeases.get(repositoryId) ?? null,
        })),
        activeWorkers:
          (input.externalActiveWorkers ?? 0) +
          leases.filter((lease) => lease.scope === "global").length,
        maxConcurrentWorkers: input.maxConcurrentWorkers,
        recordedAt: options.clock.nowIso(),
      } as unknown as TaskWavePlanningSnapshot;
      const plan = planTaskWave(planningSnapshot);

      if (plan.selectedTaskIds.length > 0) {
        const dispatches = plan.selectedTaskIds.map((taskId) =>
          makeDispatch(input, taskId, waveOrdinal),
        );
        const accepted = store.dispatchWave({
          plan,
          dispatches,
          limits: {
            maxConcurrentWorkers: input.maxConcurrentWorkers,
            accountLimits: Object.fromEntries(
              input.accounts.map((account) => [account.accountId, account.maxConcurrentRuns]),
            ),
          },
        });
        await Promise.all(
          accepted.map(async (dispatch) => {
            await options.driver.start(dispatch);
            const task = store
              .projections(input.runId)
              .find((candidate) => candidate.taskId === dispatch.taskId);
            if (task !== undefined) {
              applyDriverStatus(
                input.runId,
                task,
                await options.driver.status(dispatch.childRunId),
              );
            }
          }),
        );
      }

      const runnable = store
        .projections(input.runId)
        .filter(
          (task) =>
            task.childRunId !== null && ["active", "retrying", "cancelling"].includes(task.phase),
        );
      await Promise.all(
        runnable.map(async (task) => {
          if (task.childRunId === null) return;
          applyDriverStatus(input.runId, task, await options.driver.tick(task.childRunId));
        }),
      );
      propagate(input.runId, input.dag);
      return status(input.runId);
    },

    async reconcile(runId, dag) {
      this.initialize(runId, dag);
      await reconcileTasks(runId);
      propagate(runId, dag);
      return status(runId);
    },

    async cancel(runId, taskId) {
      const task = store.projections(runId).find((candidate) => candidate.taskId === taskId);
      if (task === undefined) throw new Error(`unknown task ${taskId}`);
      if (task.phase === "not_started") return store.cancelPending(runId, taskId);
      if (task.phase === "dispatching" || task.phase === "active" || task.phase === "retrying") {
        const cancelling = store.requestCancellation(runId, taskId);
        if (cancelling.childRunId !== null) await options.driver.cancel(cancelling.childRunId);
        return cancelling;
      }
      return task;
    },

    status,
  };
}
