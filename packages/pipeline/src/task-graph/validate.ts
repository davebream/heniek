import type {
  TaskDagValidationResult,
  TaskDagVersioned,
  TaskWavePlanningSnapshot,
} from "@heniek/contracts";

type Diagnostic = TaskDagValidationResult["diagnostics"][number];
type TaskState = TaskWavePlanningSnapshot["tasks"][number];

function compareCodepoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function diagnostic(code: string, message: string, taskIds: readonly string[]): Diagnostic {
  return { code, message, taskIds: [...taskIds].sort(compareCodepoints) } as Diagnostic;
}

function insertSorted(values: string[], value: string): void {
  const index = values.findIndex((candidate) => compareCodepoints(value, candidate) < 0);
  if (index < 0) values.push(value);
  else values.splice(index, 0, value);
}

function buildTopologicalOrder(
  dag: TaskDagVersioned,
  nodes: ReadonlyMap<string, TaskDagVersioned["nodes"][number]>,
): { readonly order: readonly string[]; readonly cyclic: readonly string[] } {
  const indegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const taskId of nodes.keys()) {
    indegree.set(taskId, 0);
    successors.set(taskId, []);
  }
  for (const node of dag.nodes) {
    if (!nodes.has(node.task.taskId)) continue;
    for (const predecessor of node.task.dependencies) {
      if (!nodes.has(predecessor) || predecessor === node.task.taskId) continue;
      indegree.set(node.task.taskId, (indegree.get(node.task.taskId) ?? 0) + 1);
      successors.get(predecessor)?.push(node.task.taskId);
    }
  }
  for (const values of successors.values()) values.sort(compareCodepoints);
  const ready = [...indegree]
    .filter(([, count]) => count === 0)
    .map(([taskId]) => taskId)
    .sort(compareCodepoints);
  const order: string[] = [];
  while (ready.length > 0) {
    const taskId = ready.shift();
    if (taskId === undefined) break;
    order.push(taskId);
    for (const successor of successors.get(taskId) ?? []) {
      const next = (indegree.get(successor) ?? 0) - 1;
      indegree.set(successor, next);
      if (next === 0) insertSorted(ready, successor);
    }
  }
  return {
    order,
    cyclic: [...indegree]
      .filter(([, count]) => count > 0)
      .map(([taskId]) => taskId)
      .sort(compareCodepoints),
  };
}

function computeAncestors(
  order: readonly string[],
  nodes: ReadonlyMap<string, TaskDagVersioned["nodes"][number]>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const ancestors = new Map<string, ReadonlySet<string>>();
  for (const taskId of order) {
    const values = new Set<string>();
    for (const predecessor of nodes.get(taskId)?.task.dependencies ?? []) {
      values.add(predecessor);
      for (const ancestor of ancestors.get(predecessor) ?? []) values.add(ancestor);
    }
    ancestors.set(taskId, values);
  }
  return ancestors;
}

function validateTerminalDependencies(
  dag: TaskDagVersioned,
  nodes: ReadonlyMap<string, TaskDagVersioned["nodes"][number]>,
  states: readonly TaskState[],
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const byTask = new Map(states.map((state) => [state.taskId, state]));
  for (const node of dag.nodes) {
    const state = byTask.get(node.task.taskId);
    if (state?.outcome !== "active" && state?.outcome !== "succeeded") continue;
    for (const predecessorId of node.task.dependencies) {
      if (!nodes.has(predecessorId)) continue;
      const predecessor = byTask.get(predecessorId);
      if (
        predecessor === undefined ||
        predecessor.outcome !== "succeeded" ||
        predecessor.completionContract !== "passed" ||
        predecessor.integration !== "passed" ||
        predecessor.combinedVerification !== "passed"
      ) {
        diagnostics.push(
          diagnostic(
            "task-dag.invalid-terminal-dependency",
            `Task "${node.task.taskId}" is ${state.outcome} although prerequisite "${predecessorId}" is not fully settled and verified.`,
            [predecessorId, node.task.taskId],
          ),
        );
      }
    }
  }
  return diagnostics;
}

/** Validate a whole-task DAG and, optionally, the state used for a wave decision. */
export function validateTaskDag(
  dag: TaskDagVersioned,
  states?: readonly TaskState[],
): TaskDagValidationResult {
  const diagnostics: Diagnostic[] = [];
  const nodes = new Map<string, TaskDagVersioned["nodes"][number]>();
  if (dag.nodes.length === 0) {
    diagnostics.push(
      diagnostic("task-dag.empty", "Task graph must contain at least one task.", []),
    );
  }
  for (const node of dag.nodes) {
    if (nodes.has(node.task.taskId)) {
      diagnostics.push(
        diagnostic(
          "task-dag.duplicate-node",
          `Task "${node.task.taskId}" appears more than once.`,
          [node.task.taskId],
        ),
      );
    } else {
      nodes.set(node.task.taskId, node);
    }
  }

  for (const node of dag.nodes) {
    const seen = new Set<string>();
    for (const predecessor of node.task.dependencies) {
      if (predecessor === node.task.taskId) {
        diagnostics.push(
          diagnostic("task-dag.self-dependency", `Task "${node.task.taskId}" depends on itself.`, [
            node.task.taskId,
          ]),
        );
      } else if (!nodes.has(predecessor)) {
        diagnostics.push(
          diagnostic(
            "task-dag.missing-node",
            `Task "${node.task.taskId}" depends on missing task "${predecessor}".`,
            [predecessor, node.task.taskId],
          ),
        );
      }
      if (seen.has(predecessor)) {
        diagnostics.push(
          diagnostic(
            "task-dag.duplicate-dependency",
            `Task "${node.task.taskId}" repeats dependency "${predecessor}".`,
            [predecessor, node.task.taskId],
          ),
        );
      }
      seen.add(predecessor);
    }
  }

  const topology = buildTopologicalOrder(dag, nodes);
  if (topology.cyclic.length > 0) {
    diagnostics.push(
      diagnostic(
        "task-dag.cycle",
        `Task graph contains a cycle involving ${topology.cyclic.map((id) => `"${id}"`).join(", ")}.`,
        topology.cyclic,
      ),
    );
  }

  if (topology.order.length === nodes.size) {
    const ancestors = computeAncestors(topology.order, nodes);
    const writers = new Map<string, string[]>();
    for (const node of nodes.values()) {
      for (const repositoryId of node.task.writeSet) {
        const values = writers.get(repositoryId) ?? [];
        values.push(node.task.taskId);
        writers.set(repositoryId, values);
      }
    }
    for (const [repositoryId, taskIds] of [...writers].sort(([left], [right]) =>
      compareCodepoints(left, right),
    )) {
      const sorted = [...taskIds].sort(compareCodepoints);
      for (let outer = 0; outer < sorted.length; outer += 1) {
        for (let inner = outer + 1; inner < sorted.length; inner += 1) {
          const first = sorted[outer] ?? "";
          const second = sorted[inner] ?? "";
          const ordered =
            (ancestors.get(first)?.has(second) ?? false) ||
            (ancestors.get(second)?.has(first) ?? false);
          if (!ordered) {
            diagnostics.push(
              diagnostic(
                "task-dag.conflicting-writes",
                `Tasks "${first}" and "${second}" both write repository "${repositoryId}" without dependency ordering.`,
                [first, second],
              ),
            );
          }
        }
      }
    }
  }

  if (states !== undefined) {
    const stateIds = new Set<string>();
    for (const state of states) {
      if (stateIds.has(state.taskId)) {
        diagnostics.push(
          diagnostic(
            "task-dag.duplicate-task-state",
            `Task "${state.taskId}" has more than one planning-state observation.`,
            [state.taskId],
          ),
        );
      }
      stateIds.add(state.taskId);
      if (!nodes.has(state.taskId)) {
        diagnostics.push(
          diagnostic(
            "task-dag.unknown-task-state",
            `Planning state refers to unknown task "${state.taskId}".`,
            [state.taskId],
          ),
        );
      }
    }
    for (const taskId of nodes.keys()) {
      if (!stateIds.has(taskId)) {
        diagnostics.push(
          diagnostic(
            "task-dag.missing-task-state",
            `Task "${taskId}" has no planning-state observation.`,
            [taskId],
          ),
        );
      }
    }
    diagnostics.push(...validateTerminalDependencies(dag, nodes, states));
  }
  diagnostics.sort((left, right) => {
    const byCode = compareCodepoints(left.code, right.code);
    if (byCode !== 0) return byCode;
    return compareCodepoints(left.taskIds.join("\0"), right.taskIds.join("\0"));
  });
  return {
    schemaVersion: 1,
    graphId: dag.graphId,
    graphRevision: dag.graphRevision,
    valid: diagnostics.length === 0,
    topologicalOrder: diagnostics.length === 0 ? topology.order : [],
    diagnostics,
  } as TaskDagValidationResult;
}
