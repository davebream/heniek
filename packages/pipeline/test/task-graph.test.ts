import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { TaskDag, TaskWavePlan, TaskWavePlanningSnapshot } from "@heniek/contracts";
import { describe, expect, it } from "vitest";
import { planTaskWave, validateTaskDag } from "../src/task-graph/index.js";

const NOW = "2026-08-12T12:00:00.000Z";
const HASH = "a".repeat(64);

function task(
  taskId: string,
  dependencies: readonly string[] = [],
  writeSet: readonly string[] = [`repo-${taskId}`],
  profileId = "builder",
  accountId: string | null = "account-1",
): TaskDag["nodes"][number] {
  const repositories = [...new Set([...writeSet, `repo-${taskId}`])];
  return {
    profileId,
    accountId,
    task: {
      schemaVersion: 1,
      taskId,
      revision: 1,
      revisionSha256: HASH,
      predecessorRevisionSha256: null,
      analysisPacketId: "analysis-1",
      analysisPacketSha256: HASH,
      objective: `Implement ${taskId}.`,
      rationale: "Fixture task.",
      primaryRepositoryId: repositories[0] ?? `repo-${taskId}`,
      readSet: repositories,
      writeSet: [...writeSet],
      excludedRepositories: [],
      dependencies: [...dependencies],
      artifacts: [],
      verification: [],
      createdAt: NOW,
    },
  } as never;
}

function dag(nodes: readonly TaskDag["nodes"][number][]): TaskDag {
  return {
    schemaVersion: 1,
    graphId: "graph-1",
    graphRevision: 1,
    nodes: [...nodes],
    createdAt: NOW,
  } as TaskDag;
}

function planningSnapshot(
  graph: TaskDag,
  overrides: Record<string, unknown> = {},
): TaskWavePlanningSnapshot {
  const repositories = [...new Set(graph.nodes.flatMap((node) => node.task.writeSet))];
  const profiles = [...new Set(graph.nodes.map((node) => node.profileId))];
  const accounts = [
    ...new Set(graph.nodes.flatMap((node) => (node.accountId === null ? [] : [node.accountId]))),
  ];
  return {
    schemaVersion: 1,
    dag: graph,
    waveOrdinal: 1,
    unresolvedGraphRevision: false,
    tasks: graph.nodes.map((node) => ({
      taskId: node.task.taskId,
      outcome: "not_started",
      completionContract: "pending",
      integration: "pending",
      combinedVerification: "pending",
    })),
    profiles: profiles.map((profileId) => ({ profileId, available: true })),
    accounts: accounts.map((accountId) => ({
      accountId,
      activeRuns: 0,
      maxConcurrentRuns: 4,
    })),
    writerLeases: repositories.map((repositoryId) => ({
      repositoryId,
      available: true,
      holderTaskId: null,
    })),
    activeWorkers: 0,
    maxConcurrentWorkers: 4,
    recordedAt: NOW,
    ...overrides,
  } as TaskWavePlanningSnapshot;
}

function blockingCodes(plan: ReturnType<typeof planTaskWave>, taskId: string): readonly string[] {
  return (
    plan.decisions
      .find((decision) => decision.taskId === taskId)
      ?.blockingReasons.map((entry) => entry.code) ?? []
  );
}

describe("task DAG validation", () => {
  it("returns canonical topological order independent of input order", () => {
    const nodes = [task("task-c", ["task-a"]), task("task-b"), task("task-a")];
    expect(validateTaskDag(dag(nodes)).topologicalOrder).toEqual(["task-a", "task-b", "task-c"]);
    expect(validateTaskDag(dag([...nodes].reverse())).topologicalOrder).toEqual([
      "task-a",
      "task-b",
      "task-c",
    ]);
  });

  it.each([
    ["missing node", dag([task("task-a", ["missing"])]), "task-dag.missing-node"],
    ["self dependency", dag([task("task-a", ["task-a"])]), "task-dag.self-dependency"],
    ["cycle", dag([task("task-a", ["task-b"]), task("task-b", ["task-a"])]), "task-dag.cycle"],
  ])("rejects %s", (_label, graph, code) => {
    const result = validateTaskDag(graph);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((entry) => entry.code === code)).toBe(true);
  });

  it("rejects unordered writers and accepts dependency-serialized writers", () => {
    const invalid = validateTaskDag(
      dag([task("task-a", [], ["shared"]), task("task-b", [], ["shared"])]),
    );
    expect(invalid.diagnostics.map((entry) => entry.code)).toContain("task-dag.conflicting-writes");
    expect(
      validateTaskDag(dag([task("task-a", [], ["shared"]), task("task-b", ["task-a"], ["shared"])]))
        .valid,
    ).toBe(true);
  });

  it("rejects active state behind an unsettled terminal dependency", () => {
    const graph = dag([task("task-a"), task("task-b", ["task-a"])]);
    const snapshot = planningSnapshot(graph, {
      tasks: [
        {
          taskId: "task-a",
          outcome: "failed",
          completionContract: "failed",
          integration: "pending",
          combinedVerification: "pending",
        },
        {
          taskId: "task-b",
          outcome: "active",
          completionContract: "pending",
          integration: "pending",
          combinedVerification: "pending",
        },
      ],
    });
    expect(validateTaskDag(graph, snapshot.tasks).diagnostics.map((entry) => entry.code)).toContain(
      "task-dag.invalid-terminal-dependency",
    );
  });

  it("rejects missing, duplicate, and unknown task-state observations", () => {
    const graph = dag([task("task-a"), task("task-b")]);
    const state = {
      taskId: "task-a",
      outcome: "not_started" as const,
      completionContract: "pending" as const,
      integration: "pending" as const,
      combinedVerification: "pending" as const,
    };
    const result = validateTaskDag(graph, [state, state, { ...state, taskId: "unknown" }] as never);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "task-dag.duplicate-task-state",
        "task-dag.missing-task-state",
        "task-dag.unknown-task-state",
      ]),
    );
  });
});

describe("task wave planning", () => {
  it("keeps the committed Q040 DAG and eligibility trace evidence reproducible", async () => {
    const evidencePath = fileURLToPath(
      new URL("../../../docs/adr/evidence/0038-q040-dag-wave-plan.json", import.meta.url),
    );
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
      readonly snapshot: TaskWavePlanningSnapshot;
      readonly wavePlan: TaskWavePlan;
    };
    expect(planTaskWave(evidence.snapshot)).toEqual(evidence.wavePlan);
  });

  it("selects a deterministic capacity-bounded wave and explains every deferral", () => {
    const graph = dag([task("task-c"), task("task-a"), task("task-b")]);
    const snapshot = planningSnapshot(graph, {
      accounts: [{ accountId: "account-1", activeRuns: 0, maxConcurrentRuns: 2 }],
      maxConcurrentWorkers: 2,
    });
    const first = planTaskWave(snapshot);
    const second = planTaskWave({
      ...snapshot,
      dag: { ...graph, nodes: [...graph.nodes].reverse() },
      tasks: [...snapshot.tasks].reverse(),
      writerLeases: [...snapshot.writerLeases].reverse(),
    });
    expect(first).toEqual(second);
    expect(first.selectedTaskIds).toEqual(["task-a", "task-b"]);
    expect(blockingCodes(first, "task-c")).toEqual([
      "account_capacity_exhausted",
      "run_concurrency_exhausted",
    ]);
  });

  it("gates successors on completion, integration, and combined verification", () => {
    const graph = dag([task("task-a"), task("task-b", ["task-a"])]);
    const snapshot = planningSnapshot(graph, {
      tasks: [
        {
          taskId: "task-a",
          outcome: "succeeded",
          completionContract: "failed",
          integration: "reconciliation_required",
          combinedVerification: "failed",
        },
        {
          taskId: "task-b",
          outcome: "not_started",
          completionContract: "pending",
          integration: "pending",
          combinedVerification: "pending",
        },
      ],
    });
    expect(blockingCodes(planTaskWave(snapshot), "task-b")).toEqual([
      "combined_verification_failed",
      "completion_contract_failed",
      "integration_reconciliation_required",
    ]);
  });

  it("reports graph revision, profile, lease, account, and run gates", () => {
    const graph = dag([task("task-a")]);
    const snapshot = planningSnapshot(graph, {
      unresolvedGraphRevision: true,
      profiles: [{ profileId: "builder", available: false }],
      accounts: [{ accountId: "account-1", activeRuns: 1, maxConcurrentRuns: 1 }],
      writerLeases: [{ repositoryId: "repo-task-a", available: false, holderTaskId: null }],
      activeWorkers: 1,
      maxConcurrentWorkers: 1,
    });
    expect(blockingCodes(planTaskWave(snapshot), "task-a")).toEqual([
      "account_capacity_exhausted",
      "graph_revision_pending",
      "profile_unavailable",
      "run_concurrency_exhausted",
      "writer_lease_unavailable",
    ]);
  });

  it("fails closed on ambiguous duplicate resource observations", () => {
    const graph = dag([task("task-a")]);
    const snapshot = planningSnapshot(graph);
    const plan = planTaskWave({
      ...snapshot,
      accounts: [
        { accountId: "account-1", activeRuns: 0, maxConcurrentRuns: 1 },
        { accountId: "account-1", activeRuns: 1, maxConcurrentRuns: 1 },
      ],
    } as never);
    expect(plan.validation.valid).toBe(false);
    expect(plan.validation.diagnostics.map((entry) => entry.code)).toContain(
      "task-wave.duplicate-account-observation",
    );
    expect(plan.selectedTaskIds).toEqual([]);
  });

  it.each([
    ["failed", "predecessor_failed"],
    ["cancelled", "predecessor_cancelled"],
  ] as const)("propagates the originating %s prerequisite transitively", (outcome, code) => {
    const graph = dag([task("task-a"), task("task-b", ["task-a"]), task("task-c", ["task-b"])]);
    const snapshot = planningSnapshot(graph, {
      tasks: [
        {
          taskId: "task-a",
          outcome,
          completionContract: "failed",
          integration: "pending",
          combinedVerification: "pending",
        },
        {
          taskId: "task-b",
          outcome: "not_started",
          completionContract: "pending",
          integration: "pending",
          combinedVerification: "pending",
        },
        {
          taskId: "task-c",
          outcome: "not_started",
          completionContract: "pending",
          integration: "pending",
          combinedVerification: "pending",
        },
      ],
    });
    const decision = planTaskWave(snapshot).decisions.find((entry) => entry.taskId === "task-c");
    expect(decision?.blockingReasons).toEqual([
      {
        code,
        sourceTaskId: "task-a",
        repositoryId: null,
        profileId: null,
        accountId: null,
      },
    ]);
  });

  it("simulates deterministic waves that cover every task once", () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      let randomState = seed >>> 0;
      const random = (): number => {
        randomState = (randomState + 0x6d2b79f5) >>> 0;
        let value = randomState;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      };
      const count = 2 + (seed % 6);
      const nodes = Array.from({ length: count }, (_, index) => {
        const taskId = `task-${index}`;
        const dependencies =
          index === 0
            ? []
            : Array.from({ length: index }, (_, predecessor) => predecessor)
                .filter(() => random() < 0.35)
                .map((predecessor) => `task-${predecessor}`);
        return task(taskId, dependencies);
      });
      const graph = dag([...nodes].reverse());
      let snapshot = planningSnapshot(graph, {
        maxConcurrentWorkers: 2,
        accounts: [{ accountId: "account-1", activeRuns: 0, maxConcurrentRuns: 2 }],
      });
      const selected = new Set<string>();
      for (let wave = 1; wave <= count; wave += 1) {
        const plan = planTaskWave(snapshot);
        expect(plan.selectedTaskIds.length).toBeLessThanOrEqual(2);
        if (plan.selectedTaskIds.length === 0) break;
        for (const taskId of plan.selectedTaskIds) {
          expect(selected.has(taskId)).toBe(false);
          selected.add(taskId);
        }
        snapshot = {
          ...snapshot,
          waveOrdinal: wave + 1,
          tasks: snapshot.tasks.map((state) =>
            selected.has(state.taskId)
              ? {
                  ...state,
                  outcome: "succeeded" as const,
                  completionContract: "passed" as const,
                  integration: "passed" as const,
                  combinedVerification: "passed" as const,
                }
              : state,
          ),
        };
      }
      expect(selected.size).toBe(count);
      const order = validateTaskDag(graph).topologicalOrder;
      for (const node of graph.nodes) {
        for (const predecessor of node.task.dependencies) {
          expect(order.indexOf(predecessor)).toBeLessThan(order.indexOf(node.task.taskId));
        }
      }
    }
  });
});
