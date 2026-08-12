import { createHash } from "node:crypto";
import type {
  TaskDagDiagnostic,
  TaskDagV2,
  TaskGraphChange,
  TaskGraphRevisionDecision,
  TaskGraphRevisionProposal,
  TaskGraphRevisionRecord,
  TaskPlanningState,
  TaskRequirementMapping,
  TaskStructuralWave,
} from "@heniek/contracts";
import { validateTaskDag } from "./validate.js";

const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const sorted = <T extends string>(values: readonly T[]): T[] => [...values].sort(compare);

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compare(left, right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function taskGraphRevisionSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalDag(dag: TaskDagV2): TaskDagV2 {
  return {
    ...dag,
    nodes: [...dag.nodes]
      .map((node) => ({
        ...node,
        task: {
          ...node.task,
          readSet: sorted(node.task.readSet),
          writeSet: sorted(node.task.writeSet),
          dependencies: sorted(node.task.dependencies),
          excludedRepositories: [...node.task.excludedRepositories].sort((a, b) =>
            compare(canonicalJson(a), canonicalJson(b)),
          ),
          artifacts: [...node.task.artifacts].sort((a, b) =>
            compare(canonicalJson(a), canonicalJson(b)),
          ),
          verification: [...node.task.verification].sort((a, b) =>
            compare(canonicalJson(a), canonicalJson(b)),
          ),
        },
      }))
      .sort((a, b) =>
        compare(`${a.task.taskId}\0${canonicalJson(a)}`, `${b.task.taskId}\0${canonicalJson(b)}`),
      ),
  };
}

function canonicalChange(change: TaskGraphChange): TaskGraphChange {
  return {
    ...change,
    beforeTaskIds: sorted(change.beforeTaskIds),
    afterTaskIds: sorted(change.afterTaskIds),
    evidenceArtifactIds: sorted(change.evidenceArtifactIds),
  };
}

function mappingKey(mapping: Pick<TaskRequirementMapping, "sourceWorkItemId" | "requirementId">) {
  return `${mapping.sourceWorkItemId}\0${mapping.requirementId}`;
}

function canonicalMapping(mapping: TaskRequirementMapping): TaskRequirementMapping {
  return {
    ...mapping,
    beforeTaskIds: sorted(mapping.beforeTaskIds),
    afterTaskIds: sorted(mapping.afterTaskIds),
  };
}

function canonicalProposal(proposal: TaskGraphRevisionProposal) {
  return {
    ...proposal,
    proposedDag: canonicalDag(proposal.proposedDag),
    changes: proposal.changes
      .map(canonicalChange)
      .sort((a, b) => compare(canonicalJson(a), canonicalJson(b))),
    requirementMappings: proposal.requirementMappings
      .map(canonicalMapping)
      .sort((a, b) =>
        compare(`${mappingKey(a)}\0${canonicalJson(a)}`, `${mappingKey(b)}\0${canonicalJson(b)}`),
      ),
    evidenceArtifactIds: sorted(proposal.evidenceArtifactIds),
  };
}

function diagnostic(code: string, message: string, taskIds: readonly string[] = []) {
  return { code, message, taskIds: sorted(taskIds) } as TaskDagDiagnostic;
}

function computeWaves(dag: TaskDagV2): readonly TaskStructuralWave[] {
  const validation = validateTaskDag(dag);
  if (!validation.valid) return [];
  const nodes = new Map(dag.nodes.map((node) => [node.task.taskId, node]));
  const ordinal = new Map<string, number>();
  for (const taskId of validation.topologicalOrder) {
    const dependencies = nodes.get(taskId)?.task.dependencies ?? [];
    ordinal.set(
      taskId,
      dependencies.reduce(
        (maximum, predecessor) => Math.max(maximum, ordinal.get(predecessor) ?? 0),
        0,
      ) + 1,
    );
  }
  const grouped = new Map<number, string[]>();
  for (const [taskId, wave] of ordinal) {
    const ids = grouped.get(wave) ?? [];
    ids.push(taskId);
    grouped.set(wave, ids);
  }
  return [...grouped]
    .sort(([left], [right]) => left - right)
    .map(([wave, taskIds]) => ({
      ordinal: wave,
      taskIds: sorted(taskIds),
    })) as TaskStructuralWave[];
}

function waveMembership(waves: readonly TaskStructuralWave[]) {
  return new Map(
    waves.flatMap((wave) => wave.taskIds.map((taskId) => [taskId, wave.ordinal] as const)),
  );
}

function operationShapeDiagnostic(change: TaskGraphChange): TaskDagDiagnostic | undefined {
  const before = change.beforeTaskIds.length;
  const after = change.afterTaskIds.length;
  const valid =
    (change.kind === "add" && before === 0 && after === 1) ||
    (change.kind === "split" && before === 1 && after >= 2) ||
    (change.kind === "merge" && before >= 2 && after === 1) ||
    (change.kind === "reorder" &&
      before === 1 &&
      after === 1 &&
      change.beforeTaskIds[0] === change.afterTaskIds[0]) ||
    (change.kind === "supersede" && before === 1 && after <= 1);
  return valid
    ? undefined
    : diagnostic(
        "task-graph-revision.invalid-change-shape",
        `Change kind "${change.kind}" has invalid before/after cardinality.`,
        [...change.beforeTaskIds, ...change.afterTaskIds],
      );
}

function changedTaskIds(before: TaskDagV2, after: TaskDagV2): readonly string[] {
  const left = new Map(before.nodes.map((node) => [node.task.taskId, node]));
  const right = new Map(after.nodes.map((node) => [node.task.taskId, node]));
  return sorted(
    [...new Set([...left.keys(), ...right.keys()])].filter(
      (taskId) => canonicalJson(left.get(taskId)) !== canonicalJson(right.get(taskId)),
    ),
  );
}

function reorderContent(node: TaskDagV2["nodes"][number]) {
  const {
    dependencies: _dependencies,
    revision: _revision,
    revisionSha256: _revisionSha256,
    predecessorRevisionSha256: _predecessorRevisionSha256,
    createdAt: _createdAt,
    ...task
  } = node.task;
  return { ...node, task };
}

function operationSemanticDiagnostics(
  change: TaskGraphChange,
  beforeNodes: ReadonlyMap<string, TaskDagV2["nodes"][number]>,
  afterNodes: ReadonlyMap<string, TaskDagV2["nodes"][number]>,
): readonly TaskDagDiagnostic[] {
  if (operationShapeDiagnostic(change) !== undefined) return [];
  const beforeExists = change.beforeTaskIds.every((taskId) => beforeNodes.has(taskId));
  const afterExists = change.afterTaskIds.every((taskId) => afterNodes.has(taskId));
  const beforeRemoved = change.beforeTaskIds.every((taskId) => !afterNodes.has(taskId));
  const afterNew = change.afterTaskIds.every((taskId) => !beforeNodes.has(taskId));
  let valid = beforeExists && afterExists;

  if (change.kind === "add") valid = valid && afterNew;
  if (change.kind === "split" || change.kind === "merge") {
    valid = valid && beforeRemoved && afterNew;
  }
  if (change.kind === "supersede") {
    const beforeTaskId = change.beforeTaskIds[0] ?? "";
    const afterTaskId = change.afterTaskIds[0];
    valid =
      valid &&
      (afterTaskId === undefined
        ? !afterNodes.has(beforeTaskId)
        : afterTaskId === beforeTaskId || (beforeRemoved && afterNew));
  }
  if (change.kind === "reorder") {
    const taskId = change.beforeTaskIds[0] ?? "";
    const before = beforeNodes.get(taskId);
    const after = afterNodes.get(taskId);
    valid =
      valid &&
      before !== undefined &&
      after !== undefined &&
      canonicalJson(before.task.dependencies) !== canonicalJson(after.task.dependencies) &&
      canonicalJson(reorderContent(before)) === canonicalJson(reorderContent(after));
  }

  return valid
    ? []
    : [
        diagnostic(
          "task-graph-revision.invalid-change-semantics",
          `Change kind "${change.kind}" does not match the derived graph mutation.`,
          [...change.beforeTaskIds, ...change.afterTaskIds],
        ),
      ];
}

export interface TaskGraphRevisionValidationContext {
  readonly current: TaskGraphRevisionRecord;
  readonly taskStates: readonly TaskPlanningState[];
  readonly maxGraphRevisions: number;
  readonly decisionId: string;
  readonly decidedAt: string;
}

export interface TaskGraphRevisionValidationOutcome {
  readonly decision: TaskGraphRevisionDecision;
  readonly record: TaskGraphRevisionRecord | null;
}

export function createInitialTaskGraphRevision(input: {
  readonly runId: TaskGraphRevisionRecord["runId"];
  readonly dag: TaskDagV2;
  readonly requirementMappings: readonly TaskRequirementMapping[];
  readonly rationale: string;
  readonly evidenceArtifactIds: TaskGraphRevisionRecord["evidenceArtifactIds"];
  readonly committedAt: string;
}): TaskGraphRevisionRecord {
  const dag = canonicalDag(input.dag);
  if (dag.graphRevision !== 1) throw new Error("initial task graph revision must be 1");
  const validation = validateTaskDag(dag);
  if (!validation.valid)
    throw new Error(
      `initial task graph is invalid: ${validation.diagnostics[0]?.code ?? "unknown"}`,
    );
  const mappings = input.requirementMappings
    .map(canonicalMapping)
    .sort((a, b) =>
      compare(`${mappingKey(a)}\0${canonicalJson(a)}`, `${mappingKey(b)}\0${canonicalJson(b)}`),
    );
  if (mappings.length === 0 || mappings.some((mapping) => mapping.beforeTaskIds.length > 0)) {
    throw new Error(
      "initial requirement mappings must cover requirements without predecessor tasks",
    );
  }
  const taskIds = new Set(dag.nodes.map((node) => node.task.taskId));
  if (mappings.some((mapping) => mapping.afterTaskIds.some((taskId) => !taskIds.has(taskId)))) {
    throw new Error("initial requirement mapping refers to an unknown task");
  }
  const core = {
    runId: input.runId,
    graphId: dag.graphId,
    graphRevision: 1,
    predecessorRevisionSha256: null,
    dag,
    changes: [],
    requirementMappings: mappings,
    rationale: input.rationale,
    evidenceArtifactIds: sorted(input.evidenceArtifactIds),
    decisionId: null,
    committedAt: input.committedAt,
  };
  return {
    schemaVersion: 1,
    ...core,
    revisionSha256: taskGraphRevisionSha256(core),
  } as unknown as TaskGraphRevisionRecord;
}

/** Deterministically validates a model proposal and, when accepted, constructs the immutable successor. */
export function validateTaskGraphRevision(
  context: TaskGraphRevisionValidationContext,
  proposalInput: TaskGraphRevisionProposal,
): TaskGraphRevisionValidationOutcome {
  const proposal = canonicalProposal(proposalInput);
  const current = context.current;
  const diagnostics: TaskDagDiagnostic[] = [];
  const beforeDag = canonicalDag(current.dag);
  const afterDag = proposal.proposedDag;
  const beforeNodes = new Map(beforeDag.nodes.map((node) => [node.task.taskId, node]));
  const afterNodes = new Map(afterDag.nodes.map((node) => [node.task.taskId, node]));
  const states = new Map(context.taskStates.map((state) => [state.taskId, state]));

  if (proposal.runId !== current.runId)
    diagnostics.push(
      diagnostic(
        "task-graph-revision.wrong-run",
        "Proposal run does not match the canonical graph.",
      ),
    );
  if (proposal.graphId !== current.graphId || afterDag.graphId !== current.graphId)
    diagnostics.push(
      diagnostic(
        "task-graph-revision.wrong-graph",
        "Proposal graph identity does not match the canonical graph.",
      ),
    );
  if (
    proposal.expectedGraphRevision !== current.graphRevision ||
    proposal.expectedRevisionSha256 !== current.revisionSha256
  )
    diagnostics.push(
      diagnostic(
        "task-graph-revision.stale",
        "Proposal does not cite the active graph revision and hash.",
      ),
    );
  if (afterDag.graphRevision !== current.graphRevision + 1)
    diagnostics.push(
      diagnostic(
        "task-graph-revision.non-sequential",
        "Proposed graph revision must advance by exactly one.",
      ),
    );
  if (afterDag.graphRevision > context.maxGraphRevisions)
    diagnostics.push(
      diagnostic(
        "task-graph-revision.limit-exceeded",
        "Proposed graph exceeds max_graph_revisions.",
      ),
    );

  const baselineValidation = validateTaskDag(beforeDag, context.taskStates);
  if (!baselineValidation.valid)
    diagnostics.push(
      diagnostic(
        "task-graph-revision.invalid-baseline",
        "Canonical graph or task-state snapshot is invalid.",
      ),
    );

  const proposedStates: TaskPlanningState[] = afterDag.nodes.map(
    (node) =>
      states.get(node.task.taskId) ?? {
        taskId: node.task.taskId,
        outcome: "not_started",
        completionContract: "pending",
        integration: "pending",
        combinedVerification: "pending",
      },
  );
  diagnostics.push(...validateTaskDag(afterDag, proposedStates).diagnostics);

  for (const [taskId, node] of beforeNodes) {
    const state = states.get(taskId);
    if (state === undefined) continue;
    if (state.outcome !== "not_started") {
      const successor = afterNodes.get(taskId);
      if (canonicalJson(node) !== canonicalJson(successor)) {
        diagnostics.push(
          diagnostic(
            "task-graph-revision.started-task",
            `Started or settled task "${taskId}" is immutable.`,
            [taskId],
          ),
        );
      }
    }
  }

  for (const [taskId, node] of afterNodes) {
    const predecessor = beforeNodes.get(taskId);
    if (predecessor === undefined) {
      if (node.task.revision !== 1 || node.task.predecessorRevisionSha256 !== null)
        diagnostics.push(
          diagnostic(
            "task-graph-revision.invalid-new-task-revision",
            `New task "${taskId}" must start at revision 1.`,
            [taskId],
          ),
        );
    } else if (canonicalJson(predecessor) !== canonicalJson(node)) {
      if (
        node.task.revision !== predecessor.task.revision + 1 ||
        node.task.predecessorRevisionSha256 !== predecessor.task.revisionSha256
      )
        diagnostics.push(
          diagnostic(
            "task-graph-revision.invalid-task-revision-chain",
            `Task "${taskId}" does not continue its exact revision chain.`,
            [taskId],
          ),
        );
    }
  }

  const actualChanged = changedTaskIds(beforeDag, afterDag);
  const accounted = new Map<string, number>();
  for (const change of proposal.changes) {
    const shape = operationShapeDiagnostic(change);
    if (shape) diagnostics.push(shape);
    diagnostics.push(...operationSemanticDiagnostics(change, beforeNodes, afterNodes));
    for (const taskId of new Set([...change.beforeTaskIds, ...change.afterTaskIds])) {
      accounted.set(taskId, (accounted.get(taskId) ?? 0) + 1);
      if (!actualChanged.includes(taskId))
        diagnostics.push(
          diagnostic(
            "task-graph-revision.unchanged-task-declared",
            `Change declares unchanged task "${taskId}".`,
            [taskId],
          ),
        );
    }
  }
  for (const taskId of actualChanged) {
    const count = accounted.get(taskId) ?? 0;
    if (count !== 1)
      diagnostics.push(
        diagnostic(
          "task-graph-revision.unaccounted-change",
          `Changed task "${taskId}" must be accounted for exactly once.`,
          [taskId],
        ),
      );
  }

  const currentMappings = new Map(
    current.requirementMappings.map((mapping) => [mappingKey(mapping), mapping]),
  );
  const proposedMappings = new Map<string, TaskRequirementMapping>();
  for (const mapping of proposal.requirementMappings) {
    const key = mappingKey(mapping);
    if (proposedMappings.has(key))
      diagnostics.push(
        diagnostic(
          "task-graph-revision.duplicate-requirement",
          `Requirement "${key}" appears more than once.`,
        ),
      );
    proposedMappings.set(key, mapping);
    const previous = currentMappings.get(key);
    if (previous === undefined)
      diagnostics.push(
        diagnostic(
          "task-graph-revision.unknown-requirement",
          `Requirement "${key}" is not in the frozen source catalog.`,
        ),
      );
    else if (
      JSON.stringify(sorted(previous.afterTaskIds)) !== JSON.stringify(mapping.beforeTaskIds)
    )
      diagnostics.push(
        diagnostic(
          "task-graph-revision.requirement-baseline-mismatch",
          `Requirement "${key}" does not cite its current task mapping.`,
        ),
      );
    for (const taskId of mapping.afterTaskIds) {
      if (!afterNodes.has(taskId))
        diagnostics.push(
          diagnostic(
            "task-graph-revision.requirement-target-missing",
            `Requirement "${key}" maps to missing task "${taskId}".`,
            [taskId],
          ),
        );
    }
  }
  for (const key of currentMappings.keys()) {
    if (!proposedMappings.has(key))
      diagnostics.push(
        diagnostic(
          "task-graph-revision.requirement-lost",
          `Requirement "${key}" disappeared from the proposal.`,
        ),
      );
  }

  for (const change of proposal.changes.filter((entry) => entry.kind === "supersede")) {
    const supersededTaskId = change.beforeTaskIds[0];
    if (supersededTaskId === undefined) continue;
    for (const [key, previous] of currentMappings) {
      if (!previous.afterTaskIds.includes(supersededTaskId)) continue;
      const proposed = proposedMappings.get(key);
      if (
        proposed === undefined ||
        proposed.afterTaskIds.every((taskId) => !afterNodes.has(taskId))
      )
        diagnostics.push(
          diagnostic(
            "task-graph-revision.commitment-narrowing",
            `Superseding task "${supersededTaskId}" removes active coverage for requirement "${key}".`,
            [supersededTaskId],
          ),
        );
    }
  }

  diagnostics.sort((a, b) =>
    compare(
      `${a.code}\0${a.taskIds.join("\0")}\0${a.message}`,
      `${b.code}\0${b.taskIds.join("\0")}\0${b.message}`,
    ),
  );
  const beforeWaves = computeWaves(beforeDag);
  const afterWaves = computeWaves(afterDag);
  const beforeMembership = waveMembership(beforeWaves);
  const afterMembership = waveMembership(afterWaves);
  const affectedTaskIds = sorted(
    [...new Set([...beforeMembership.keys(), ...afterMembership.keys()])].filter(
      (taskId) =>
        beforeMembership.get(taskId) !== afterMembership.get(taskId) ||
        actualChanged.includes(taskId),
    ),
  );
  const affectedWaveOrdinals = [
    ...new Set(
      affectedTaskIds
        .flatMap((taskId) => [beforeMembership.get(taskId), afterMembership.get(taskId)])
        .filter((value): value is number => value !== undefined),
    ),
  ].sort((a, b) => a - b);
  const proposalSha256 = taskGraphRevisionSha256(proposal);
  let record: TaskGraphRevisionRecord | null = null;
  let proposedRevisionSha256: string | null = null;
  if (diagnostics.length === 0) {
    const core = {
      runId: proposal.runId,
      graphId: proposal.graphId,
      graphRevision: afterDag.graphRevision,
      predecessorRevisionSha256: current.revisionSha256,
      dag: afterDag,
      changes: proposal.changes,
      requirementMappings: proposal.requirementMappings,
      rationale: proposal.rationale,
      evidenceArtifactIds: proposal.evidenceArtifactIds,
      decisionId: context.decisionId,
      committedAt: context.decidedAt,
    };
    proposedRevisionSha256 = taskGraphRevisionSha256(core);
    record = {
      schemaVersion: 1,
      ...core,
      revisionSha256: proposedRevisionSha256,
    } as TaskGraphRevisionRecord;
  }
  const decision = {
    schemaVersion: 1,
    decisionId: context.decisionId,
    runId: proposal.runId,
    graphId: proposal.graphId,
    proposal,
    proposalSha256,
    expectedGraphRevision: proposal.expectedGraphRevision,
    outcome: diagnostics.length === 0 ? "accepted" : "rejected",
    proposedRevisionSha256,
    diagnostics,
    beforeWaves,
    afterWaves,
    affectedTaskIds,
    affectedWaveOrdinals,
    taskStates: [...context.taskStates].sort((a, b) => compare(a.taskId, b.taskId)),
    maxGraphRevisions: context.maxGraphRevisions,
    decidedAt: context.decidedAt,
  } as TaskGraphRevisionDecision;
  return { decision, record };
}
