import type {
  TaskDag,
  TaskWaveBlockingCode,
  TaskWavePlan,
  TaskWavePlanningSnapshot,
} from "@heniek/contracts";
import { validateTaskDag } from "./validate.js";

type Decision = TaskWavePlan["decisions"][number];
type Reason = Decision["blockingReasons"][number];
type TaskState = TaskWavePlanningSnapshot["tasks"][number];

function compareCodepoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function reason(code: TaskWaveBlockingCode, details: Partial<Omit<Reason, "code">> = {}): Reason {
  return {
    code,
    sourceTaskId: null,
    repositoryId: null,
    profileId: null,
    accountId: null,
    ...details,
  } as Reason;
}

function reasonKey(value: Reason): string {
  return [
    value.code,
    value.sourceTaskId ?? "",
    value.repositoryId ?? "",
    value.profileId ?? "",
    value.accountId ?? "",
  ].join("\0");
}

function canonicalReasons(values: readonly Reason[]): readonly Reason[] {
  const unique = new Map(values.map((value) => [reasonKey(value), value]));
  return [...unique.values()].sort((left, right) =>
    compareCodepoints(reasonKey(left), reasonKey(right)),
  );
}

function terminalReasons(
  taskId: string,
  nodes: ReadonlyMap<string, TaskDag["nodes"][number]>,
  states: ReadonlyMap<string, TaskState>,
  visiting = new Set<string>(),
): readonly Reason[] {
  if (visiting.has(taskId)) return [];
  const nextVisiting = new Set(visiting).add(taskId);
  const values: Reason[] = [];
  for (const predecessorId of nodes.get(taskId)?.task.dependencies ?? []) {
    const predecessor = states.get(predecessorId);
    if (predecessor?.outcome === "failed") {
      values.push(reason("predecessor_failed", { sourceTaskId: predecessorId }));
    } else if (predecessor?.outcome === "cancelled") {
      values.push(reason("predecessor_cancelled", { sourceTaskId: predecessorId }));
    } else if (predecessor?.outcome === "blocked") {
      const inherited = terminalReasons(predecessorId, nodes, states, nextVisiting);
      values.push(
        ...(inherited.length > 0
          ? inherited
          : [reason("predecessor_blocked", { sourceTaskId: predecessorId })]),
      );
    } else if (predecessor?.outcome === "not_started") {
      values.push(...terminalReasons(predecessorId, nodes, states, nextVisiting));
    }
  }
  return canonicalReasons(values);
}

function dependencyReasons(
  node: TaskDag["nodes"][number],
  nodes: ReadonlyMap<string, TaskDag["nodes"][number]>,
  states: ReadonlyMap<string, TaskState>,
): readonly Reason[] {
  const terminal = terminalReasons(node.task.taskId, nodes, states);
  if (terminal.length > 0) return terminal;
  const values: Reason[] = [];
  for (const predecessorId of [...node.task.dependencies].sort(compareCodepoints)) {
    const predecessor = states.get(predecessorId);
    if (predecessor === undefined || predecessor.outcome !== "succeeded") {
      values.push(reason("predecessor_pending", { sourceTaskId: predecessorId }));
      continue;
    }
    if (predecessor.completionContract !== "passed") {
      values.push(
        reason(
          predecessor.completionContract === "failed"
            ? "completion_contract_failed"
            : "completion_contract_pending",
          { sourceTaskId: predecessorId },
        ),
      );
    }
    if (predecessor.integration !== "passed") {
      values.push(
        reason(
          predecessor.integration === "reconciliation_required"
            ? "integration_reconciliation_required"
            : "integration_pending",
          { sourceTaskId: predecessorId },
        ),
      );
    }
    if (predecessor.combinedVerification !== "passed") {
      values.push(
        reason(
          predecessor.combinedVerification === "failed"
            ? "combined_verification_failed"
            : "combined_verification_pending",
          { sourceTaskId: predecessorId },
        ),
      );
    }
  }
  return canonicalReasons(values);
}

/** Select the next whole-task wave from an explicit, immutable planning snapshot. */
export function planTaskWave(snapshot: TaskWavePlanningSnapshot): TaskWavePlan {
  const baseValidation = validateTaskDag(snapshot.dag, snapshot.tasks);
  const resourceDiagnostics: TaskWavePlan["validation"]["diagnostics"] = [];
  const duplicateResourceIds = (
    kind: "profile" | "account" | "writer-lease",
    ids: readonly string[],
  ): void => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) {
        resourceDiagnostics.push({
          code: `task-wave.duplicate-${kind}-observation`,
          message: `Wave snapshot contains more than one ${kind} observation for "${id}".`,
          taskIds: [],
        });
      }
      seen.add(id);
    }
  };
  duplicateResourceIds(
    "profile",
    snapshot.profiles.map((profile) => profile.profileId),
  );
  duplicateResourceIds(
    "account",
    snapshot.accounts.map((account) => account.accountId),
  );
  duplicateResourceIds(
    "writer-lease",
    snapshot.writerLeases.map((lease) => lease.repositoryId),
  );
  resourceDiagnostics.sort((left, right) => compareCodepoints(left.code, right.code));
  const validation = {
    ...baseValidation,
    valid: baseValidation.valid && resourceDiagnostics.length === 0,
    topologicalOrder:
      resourceDiagnostics.length === 0
        ? baseValidation.topologicalOrder
        : ([] as readonly string[]),
    diagnostics: [...baseValidation.diagnostics, ...resourceDiagnostics],
  } as TaskWavePlan["validation"];
  const nodes = new Map(snapshot.dag.nodes.map((node) => [node.task.taskId, node]));
  const states = new Map(snapshot.tasks.map((state) => [state.taskId, state]));
  const profiles = new Map(snapshot.profiles.map((profile) => [profile.profileId, profile]));
  const accounts = new Map(snapshot.accounts.map((account) => [account.accountId, account]));
  const leases = new Map(snapshot.writerLeases.map((lease) => [lease.repositoryId, lease]));
  const accountRemaining = new Map(
    snapshot.accounts.map((account) => [
      account.accountId,
      Math.max(0, account.maxConcurrentRuns - account.activeRuns),
    ]),
  );
  let workerSlots = Math.max(0, snapshot.maxConcurrentWorkers - snapshot.activeWorkers);
  const decisions: Decision[] = [];
  const selectedTaskIds: string[] = [];
  const order = validation.valid
    ? validation.topologicalOrder
    : [...nodes.keys()].sort(compareCodepoints);

  for (const taskId of order) {
    const node = nodes.get(taskId);
    if (node === undefined) continue;
    const taskState = states.get(taskId);
    if (!validation.valid) {
      decisions.push({
        taskId,
        classification: "invalid",
        blockingReasons: [reason("graph_invalid")],
      } as Decision);
      continue;
    }
    if (taskState?.outcome !== "not_started") {
      decisions.push({
        taskId,
        classification: "settled",
        blockingReasons: [reason("task_not_pending", { sourceTaskId: taskId })],
      } as Decision);
      continue;
    }

    const blockers: Reason[] = [];
    if (snapshot.unresolvedGraphRevision) blockers.push(reason("graph_revision_pending"));
    blockers.push(...dependencyReasons(node, nodes, states));
    const profile = profiles.get(node.profileId);
    if (profile?.available !== true) {
      blockers.push(reason("profile_unavailable", { profileId: node.profileId }));
    }
    for (const repositoryId of [...node.task.writeSet].sort(compareCodepoints)) {
      const lease = leases.get(repositoryId);
      if (lease?.available !== true) {
        blockers.push(reason("writer_lease_unavailable", { repositoryId }));
      }
    }
    if (node.accountId !== null) {
      const account = accounts.get(node.accountId);
      if (account === undefined) {
        blockers.push(reason("account_capacity_unknown", { accountId: node.accountId }));
      } else if ((accountRemaining.get(node.accountId) ?? 0) <= 0) {
        blockers.push(reason("account_capacity_exhausted", { accountId: node.accountId }));
      }
    }
    if (workerSlots <= 0) blockers.push(reason("run_concurrency_exhausted"));

    const canonical = canonicalReasons(blockers);
    if (canonical.length > 0) {
      decisions.push({
        taskId,
        classification: "deferred",
        blockingReasons: canonical,
      } as Decision);
      continue;
    }
    selectedTaskIds.push(taskId);
    workerSlots -= 1;
    if (node.accountId !== null) {
      accountRemaining.set(node.accountId, (accountRemaining.get(node.accountId) ?? 0) - 1);
    }
    decisions.push({ taskId, classification: "selected", blockingReasons: [] } as Decision);
  }

  return {
    schemaVersion: 1,
    graphId: snapshot.dag.graphId,
    graphRevision: snapshot.dag.graphRevision,
    waveOrdinal: snapshot.waveOrdinal,
    validation,
    selectedTaskIds,
    decisions,
    plannedAt: snapshot.recordedAt,
  } as TaskWavePlan;
}
