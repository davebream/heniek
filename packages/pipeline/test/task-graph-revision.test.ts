import { createDeterministicRandom, seed } from "@heniek/conformance";
import type {
  RunId,
  TaskDagV2,
  TaskGraphChange,
  TaskGraphRevisionProposal,
  TaskGraphRevisionRecord,
  TaskPlanningState,
  TaskRequirementMapping,
} from "@heniek/contracts";
import { describe, expect, it } from "vitest";
import {
  createInitialTaskGraphRevision,
  validateTaskGraphRevision,
} from "../src/task-graph/revise.js";

const NOW = "2026-08-12T12:00:00.000Z";
const LATER = "2026-08-12T12:01:00.000Z";
const HASH = "a".repeat(64);

function task(
  taskId: string,
  repositoryId: string,
  dependencies: readonly string[] = [],
): TaskDagV2["nodes"][number] {
  return {
    pipelineId: "careful",
    profileId: "builder",
    accountId: null,
    task: {
      schemaVersion: 1,
      taskId,
      revision: 1,
      revisionSha256: HASH,
      predecessorRevisionSha256: null,
      analysisPacketId: "analysis-1",
      analysisPacketSha256: HASH,
      objective: `Implement ${taskId}.`,
      rationale: "Required by the source.",
      primaryRepositoryId: repositoryId,
      readSet: [repositoryId],
      writeSet: [repositoryId],
      excludedRepositories: [],
      dependencies,
      artifacts: [],
      verification: [],
      createdAt: NOW,
    },
  } as unknown as TaskDagV2["nodes"][number];
}

function dag(revision: number, nodes: readonly ReturnType<typeof task>[]): TaskDagV2 {
  return {
    schemaVersion: 2,
    graphId: "graph-1",
    graphRevision: revision,
    nodes,
    createdAt: revision === 1 ? NOW : LATER,
  } as unknown as TaskDagV2;
}

function mapping(afterTaskIds: readonly string[]): TaskRequirementMapping {
  return {
    sourceWorkItemId: "source-1",
    requirementId: "R-1",
    beforeTaskIds: [],
    afterTaskIds,
    rationale: "Exact source coverage.",
  } as unknown as TaskRequirementMapping;
}

function state(taskId: string, outcome: TaskPlanningState["outcome"] = "not_started") {
  return {
    taskId,
    outcome,
    completionContract: "pending",
    integration: "pending",
    combinedVerification: "pending",
  } as TaskPlanningState;
}

function fixture(
  nodes: readonly ReturnType<typeof task>[],
  mapped: readonly string[] = nodes.map((node) => node.task.taskId),
) {
  const current = createInitialTaskGraphRevision({
    runId: "run-1" as RunId,
    dag: dag(1, nodes),
    requirementMappings: [mapping(mapped)],
    rationale: "Initial analysis.",
    evidenceArtifactIds: [
      "artifact-initial",
    ] as unknown as TaskGraphRevisionRecord["evidenceArtifactIds"],
    committedAt: NOW,
  });
  return { current, taskStates: nodes.map((node) => state(node.task.taskId)) };
}

function proposal(
  current: ReturnType<typeof fixture>["current"],
  nodes: readonly ReturnType<typeof task>[],
  change: TaskGraphChange,
  beforeTaskIds: readonly string[] = current.requirementMappings[0]?.afterTaskIds ?? [],
  afterTaskIds: readonly string[] = nodes.map((node) => node.task.taskId),
): TaskGraphRevisionProposal {
  return {
    schemaVersion: 1,
    runId: current.runId,
    graphId: current.graphId,
    expectedGraphRevision: current.graphRevision,
    expectedRevisionSha256: current.revisionSha256,
    proposedDag: dag(current.graphRevision + 1, nodes),
    changes: [change],
    requirementMappings: [
      {
        sourceWorkItemId: "source-1",
        requirementId: "R-1",
        beforeTaskIds,
        afterTaskIds,
        rationale: "Coverage is preserved.",
      },
    ],
    rationale: "Analysis found a safer graph.",
    evidenceArtifactIds: ["artifact-proposal"],
    proposedAt: LATER,
  } as unknown as TaskGraphRevisionProposal;
}

function validate(
  current: ReturnType<typeof fixture>["current"],
  taskStates: readonly TaskPlanningState[],
  candidate: TaskGraphRevisionProposal,
  maxGraphRevisions = 5,
) {
  return validateTaskGraphRevision(
    {
      current,
      taskStates,
      maxGraphRevisions,
      decisionId: "decision-1",
      decidedAt: LATER,
    },
    candidate,
  );
}

const evidence = ["artifact-change"] as TaskGraphChange["evidenceArtifactIds"];

describe("Q041 deterministic graph revision", () => {
  it.each([
    {
      name: "add",
      before: [task("a", "repo-a")],
      after: [task("a", "repo-a"), task("b", "repo-b", ["a"])],
      change: {
        kind: "add",
        beforeTaskIds: [],
        afterTaskIds: ["b"],
        rationale: "Add b.",
        evidenceArtifactIds: evidence,
      },
      mappedBefore: ["a"],
      mappedAfter: ["a", "b"],
    },
    {
      name: "split",
      before: [task("a", "repo-a")],
      after: [task("b", "repo-b"), task("c", "repo-c")],
      change: {
        kind: "split",
        beforeTaskIds: ["a"],
        afterTaskIds: ["b", "c"],
        rationale: "Split a.",
        evidenceArtifactIds: evidence,
      },
      mappedBefore: ["a"],
      mappedAfter: ["b", "c"],
    },
    {
      name: "merge",
      before: [task("a", "repo-a"), task("b", "repo-b")],
      after: [task("c", "repo-c")],
      change: {
        kind: "merge",
        beforeTaskIds: ["a", "b"],
        afterTaskIds: ["c"],
        rationale: "Merge duplicates.",
        evidenceArtifactIds: evidence,
      },
      mappedBefore: ["a", "b"],
      mappedAfter: ["c"],
    },
    {
      name: "supersede",
      before: [task("a", "repo-a")],
      after: [task("b", "repo-b")],
      change: {
        kind: "supersede",
        beforeTaskIds: ["a"],
        afterTaskIds: ["b"],
        rationale: "Replace a.",
        evidenceArtifactIds: evidence,
      },
      mappedBefore: ["a"],
      mappedAfter: ["b"],
    },
  ] as const)(
    "accepts a valid $name operation",
    ({ before, after, change, mappedBefore, mappedAfter }) => {
      const base = fixture(before, mappedBefore);
      const outcome = validate(
        base.current,
        base.taskStates,
        proposal(
          base.current,
          after,
          change as unknown as TaskGraphChange,
          mappedBefore,
          mappedAfter,
        ),
      );
      expect(outcome.decision.outcome, JSON.stringify(outcome.decision.diagnostics)).toBe(
        "accepted",
      );
      expect(outcome.record?.predecessorRevisionSha256).toBe(base.current.revisionSha256);
    },
  );

  it("accepts dependency reorder and reports affected structural waves", () => {
    const before = [task("a", "repo-a"), task("b", "repo-b")];
    const base = fixture(before, ["a"]);
    const revisedB = task("b", "repo-b", ["a"]);
    revisedB.task.revision = 2;
    revisedB.task.predecessorRevisionSha256 = HASH;
    revisedB.task.revisionSha256 = "b".repeat(64);
    const change = {
      kind: "reorder",
      beforeTaskIds: ["b"],
      afterTaskIds: ["b"],
      rationale: "Serialize b.",
      evidenceArtifactIds: evidence,
    } as unknown as TaskGraphChange;
    const outcome = validate(
      base.current,
      base.taskStates,
      proposal(
        base.current,
        [before[0] as ReturnType<typeof task>, revisedB],
        change,
        ["a"],
        ["a"],
      ),
    );
    expect(outcome.decision.outcome, JSON.stringify(outcome.decision.diagnostics)).toBe("accepted");
    expect(outcome.decision.affectedWaveOrdinals).toEqual([1, 2]);
  });

  it("rejects operation labels that do not match the derived mutation", () => {
    const original = task("a", "repo-a");
    const base = fixture([original]);
    const revised = task("a", "repo-a");
    revised.task.revision = 2;
    revised.task.predecessorRevisionSha256 = HASH;
    revised.task.revisionSha256 = "b".repeat(64);
    revised.task.objective = "Silently changed objective.";
    const malformed = proposal(
      base.current,
      [revised],
      {
        kind: "add",
        beforeTaskIds: [],
        afterTaskIds: ["a"],
        rationale: "Mislabel an in-place edit as an addition.",
        evidenceArtifactIds: evidence,
      } as unknown as TaskGraphChange,
      ["a"],
      ["a"],
    );
    expect(validate(base.current, base.taskStates, malformed).decision.diagnostics).toContainEqual(
      expect.objectContaining({ code: "task-graph-revision.invalid-change-semantics" }),
    );
  });

  it("allows reorder to change dependencies only", () => {
    const before = [task("a", "repo-a"), task("b", "repo-b")];
    const base = fixture(before, ["a"]);
    const revisedB = task("b", "repo-b", ["a"]);
    revisedB.task.revision = 2;
    revisedB.task.predecessorRevisionSha256 = HASH;
    revisedB.task.revisionSha256 = "b".repeat(64);
    revisedB.task.objective = "Narrowed while pretending to reorder.";
    const outcome = validate(
      base.current,
      base.taskStates,
      proposal(
        base.current,
        [before[0] as ReturnType<typeof task>, revisedB],
        {
          kind: "reorder",
          beforeTaskIds: ["b"],
          afterTaskIds: ["b"],
          rationale: "Invalid dependency-plus-objective edit.",
          evidenceArtifactIds: evidence,
        } as unknown as TaskGraphChange,
        ["a"],
        ["a"],
      ),
    );
    expect(outcome.decision.diagnostics).toContainEqual(
      expect.objectContaining({ code: "task-graph-revision.invalid-change-semantics" }),
    );
  });

  it("rejects stale, cyclic, commitment-losing, started-task, and policy-violating proposals", () => {
    const base = fixture([task("a", "repo-a")]);
    const added = task("b", "repo-b", ["a"]);
    const change = {
      kind: "add",
      beforeTaskIds: [],
      afterTaskIds: ["b"],
      rationale: "Add b.",
      evidenceArtifactIds: evidence,
    } as unknown as TaskGraphChange;
    const valid = proposal(base.current, [task("a", "repo-a"), added], change, ["a"], ["a", "b"]);

    const stale = validate(base.current, base.taskStates, { ...valid, expectedGraphRevision: 2 });
    expect(stale.decision.diagnostics.map((entry) => entry.code)).toContain(
      "task-graph-revision.stale",
    );

    const cyclicA = task("a", "repo-a", ["b"]);
    cyclicA.task.revision = 2;
    cyclicA.task.predecessorRevisionSha256 = HASH;
    cyclicA.task.revisionSha256 = "c".repeat(64);
    const cyclic = validate(
      base.current,
      base.taskStates,
      proposal(
        base.current,
        [cyclicA, task("b", "repo-b", ["a"])],
        {
          kind: "split",
          beforeTaskIds: ["a"],
          afterTaskIds: ["a", "b"],
          rationale: "Bad cycle.",
          evidenceArtifactIds: evidence,
        } as unknown as TaskGraphChange,
        ["a"],
        ["a", "b"],
      ),
    );
    expect(cyclic.decision.diagnostics.map((entry) => entry.code)).toContain("task-dag.cycle");

    const lost = validate(base.current, base.taskStates, {
      ...valid,
      requirementMappings: [],
    } as unknown as TaskGraphRevisionProposal);
    expect(lost.decision.diagnostics.map((entry) => entry.code)).toContain(
      "task-graph-revision.requirement-lost",
    );

    const started = validate(
      base.current,
      [state("a", "active")],
      proposal(
        base.current,
        [task("b", "repo-b")],
        {
          kind: "supersede",
          beforeTaskIds: ["a"],
          afterTaskIds: ["b"],
          rationale: "Unsafe.",
          evidenceArtifactIds: evidence,
        } as unknown as TaskGraphChange,
        ["a"],
        ["b"],
      ),
    );
    expect(started.decision.diagnostics.map((entry) => entry.code)).toContain(
      "task-graph-revision.started-task",
    );

    const limited = validate(base.current, base.taskStates, valid, 1);
    expect(limited.decision.diagnostics.map((entry) => entry.code)).toContain(
      "task-graph-revision.limit-exceeded",
    );
  });

  it("canonicalizes unordered set-like inputs to one revision hash", () => {
    const base = fixture([task("a", "repo-a")]);
    const change = {
      kind: "add",
      beforeTaskIds: [],
      afterTaskIds: ["b"],
      rationale: "Add b.",
      evidenceArtifactIds: evidence,
    } as unknown as TaskGraphChange;
    const first = proposal(
      base.current,
      [task("a", "repo-a"), task("b", "repo-b", ["a"])],
      change,
      ["a"],
      ["a", "b"],
    );
    const firstMapping = first.requirementMappings[0];
    if (firstMapping === undefined) throw new Error("fixture requirement mapping missing");
    const second = {
      ...first,
      proposedDag: { ...first.proposedDag, nodes: [...first.proposedDag.nodes].reverse() },
      requirementMappings: [{ ...firstMapping, beforeTaskIds: ["a"], afterTaskIds: ["b", "a"] }],
    } as unknown as TaskGraphRevisionProposal;
    expect(validate(base.current, base.taskStates, first).record?.revisionSha256).toBe(
      validate(base.current, base.taskStates, second).record?.revisionSha256,
    );
  });

  it("canonically orders tied diagnostics and rejected proposal hashes", () => {
    const base = fixture([task("a", "repo-a")]);
    const candidate = proposal(
      base.current,
      [task("a", "repo-a"), task("b", "repo-b", ["a"])],
      {
        kind: "add",
        beforeTaskIds: [],
        afterTaskIds: ["b"],
        rationale: "Add b.",
        evidenceArtifactIds: evidence,
      } as unknown as TaskGraphChange,
      ["a"],
      ["a", "b"],
    );
    const unknown = ["R-Z", "R-A"].map(
      (requirementId) =>
        ({
          sourceWorkItemId: "source-unknown",
          requirementId,
          beforeTaskIds: [],
          afterTaskIds: ["b"],
          rationale: requirementId,
        }) as unknown as TaskRequirementMapping,
    );
    const first = validate(base.current, base.taskStates, {
      ...candidate,
      requirementMappings: [...candidate.requirementMappings, ...unknown],
    });
    const second = validate(base.current, base.taskStates, {
      ...candidate,
      requirementMappings: [...unknown].reverse().concat(candidate.requirementMappings),
    });
    expect(first.decision.proposalSha256).toBe(second.decision.proposalSha256);
    expect(first.decision.diagnostics).toEqual(second.decision.diagnostics);
  });

  it("rejects commitment-narrowing supersession without active requirement coverage", () => {
    const base = fixture([task("a", "repo-a"), task("b", "repo-b")], ["a"]);
    const candidate = proposal(
      base.current,
      [task("b", "repo-b")],
      {
        kind: "supersede",
        beforeTaskIds: ["a"],
        afterTaskIds: [],
        rationale: "Drop a without replacement.",
        evidenceArtifactIds: evidence,
      } as unknown as TaskGraphChange,
      ["a"],
      [],
    );
    expect(validate(base.current, base.taskStates, candidate).decision.diagnostics).toContainEqual(
      expect.objectContaining({ code: "task-graph-revision.commitment-narrowing" }),
    );
  });

  for (const seedValue of [0x4100_0001, 0x4100_0002, 0x4100_0003]) {
    it(`seed ${seedValue.toString(16)}: every non-active expected version is rejected without a successor`, () => {
      const random = createDeterministicRandom(seed(seedValue));
      let current = fixture([task("task-0", "repo-0")]).current;
      let nodes = [task("task-0", "repo-0")];
      for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
        const nextId = `task-${ordinal}`;
        const nextNodes = [...nodes, task(nextId, `repo-${ordinal}`, [`task-${ordinal - 1}`])];
        const change = {
          kind: "add",
          beforeTaskIds: [],
          afterTaskIds: [nextId],
          rationale: `Add ${nextId}.`,
          evidenceArtifactIds: evidence,
        } as unknown as TaskGraphChange;
        const activeIds = nodes.map((node) => node.task.taskId);
        const candidate = proposal(current, nextNodes, change, activeIds, [...activeIds, nextId]);
        const taskStates = nodes.map((node) => state(node.task.taskId));
        const delta = current.graphRevision > 1 && random.nextInt(0, 2) === 0 ? -1 : 1;
        const stale = validate(current, taskStates, {
          ...candidate,
          expectedGraphRevision: current.graphRevision + delta,
        });
        expect(stale.decision.outcome).toBe("rejected");
        expect(stale.record).toBeNull();
        expect(stale.decision.diagnostics.map((entry) => entry.code)).toContain(
          "task-graph-revision.stale",
        );

        const accepted = validate(current, taskStates, candidate, 10);
        expect(accepted.record).not.toBeNull();
        current = accepted.record as TaskGraphRevisionRecord;
        nodes = nextNodes;
      }
    });
  }
});
