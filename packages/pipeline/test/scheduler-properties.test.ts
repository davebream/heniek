/**
 * Property tests for deterministic graph scheduling.
 */

import { describe, expect, it } from "vitest";
import type { PipelineGraph } from "../src/document.js";
import { initialStageSnapshots, tickScheduler } from "../src/scheduler/tick.js";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function randomAcyclicGraph(seed: number): PipelineGraph {
  const random = mulberry32(seed);
  const stageCount = 2 + Math.floor(random() * 5);
  const stages = Array.from({ length: stageCount }, (_, index) => {
    const id = `s${index}`;
    return {
      id,
      type: "agent" as const,
      mode: "autonomous" as const,
      optional: random() < 0.2,
      profile: "p",
      reads: index === 0 ? ([] as string[]) : [`artifacts.s${index - 1}`],
      writes: [`artifacts.${id}`],
      overridable: [] as string[],
    };
  });
  const edges: { from: string; to: string }[] = [];
  for (let index = 1; index < stageCount; index += 1) {
    // Always connect to at least one earlier stage so the graph stays reachable.
    const from = Math.floor(random() * index);
    edges.push({ from: `s${from}`, to: `s${index}` });
    if (random() < 0.3 && index > 1) {
      const other = Math.floor(random() * index);
      if (other !== from) {
        edges.push({ from: `s${other}`, to: `s${index}` });
      }
    }
  }
  edges.sort((left, right) =>
    left.from !== right.from ? (left.from < right.from ? -1 : 1) : left.to < right.to ? -1 : 1,
  );
  return {
    schemaVersion: 1,
    pipelineId: `g${seed}`,
    mode: "autonomous",
    limits: { maxRepairAttempts: 1, maxConcurrentWorkers: 2 },
    context: {},
    stages,
    edges,
  } as never;
}

describe("scheduler properties", () => {
  it("is deterministic for randomized acyclic graphs", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const graph = randomAcyclicGraph(seed);
      const input = {
        schemaVersion: 1 as const,
        runId: `run-${seed}`,
        pipelineId: graph.pipelineId,
        graphRevision: 1,
        scheduleRevision: 1,
        graph,
        now: "2026-08-09T12:00:00.000Z",
        stages: initialStageSnapshots({
          runId: `run-${seed}`,
          graphRevision: 1,
          graph,
          now: "2026-08-09T12:00:00.000Z",
        }),
        observations: [],
        canonicalState: {},
        pendingEvaluatorEdgeKeys: [],
        evaluatorDecisions: [],
      } as never;
      const first = tickScheduler(input);
      const second = tickScheduler(input);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first)); // input cast below
      // Decisions are sorted by stage id.
      const stageIds = first.decisions.map((decision) => decision.stageId ?? "");
      expect(stageIds).toEqual([...stageIds].sort());
      // Parallel roots/fan-out become eligible together up to concurrency.
      const queued = first.stagePatches.filter((stage) => stage.state === "queued");
      expect(queued.length).toBeGreaterThan(0);
      expect(queued.length).toBeLessThanOrEqual(2);
    }
  });

  it("optional failure does not fail an otherwise completed graph", () => {
    const graph: PipelineGraph = {
      schemaVersion: 1,
      pipelineId: "optional",
      mode: "autonomous",
      limits: {},
      context: {},
      stages: [
        {
          id: "required",
          type: "agent",
          mode: "autonomous",
          optional: false,
          profile: "p",
          reads: [],
          writes: ["artifacts.required"],
          overridable: [],
        },
        {
          id: "optional",
          type: "agent",
          mode: "autonomous",
          optional: true,
          profile: "p",
          reads: [],
          writes: ["artifacts.optional"],
          overridable: [],
        },
      ],
      edges: [],
    } as never;
    let stages = initialStageSnapshots({
      runId: "run-opt",
      graphRevision: 1,
      graph,
      now: "2026-08-09T12:00:00.000Z",
    });
    const queued = tickScheduler({
      schemaVersion: 1,
      runId: "run-opt",
      pipelineId: "optional",
      graphRevision: 1,
      scheduleRevision: 1,
      graph,
      now: "2026-08-09T12:00:00.000Z",
      stages,
      observations: [],
      canonicalState: {},
      pendingEvaluatorEdgeKeys: [],
      evaluatorDecisions: [],
    } as never);
    stages = queued.stagePatches;
    const requiredAttempt = queued.attempts.find((attempt) => attempt.stageId === "required")!;
    const optionalAttempt = queued.attempts.find((attempt) => attempt.stageId === "optional")!;
    const settled = tickScheduler({
      schemaVersion: 1,
      runId: "run-opt",
      pipelineId: "optional",
      graphRevision: 1,
      scheduleRevision: 2,
      graph,
      now: "2026-08-09T12:00:01.000Z",
      stages,
      observations: [
        {
          schemaVersion: 1,
          observationId: "r-s",
          kind: "attempt_started",
          stageId: "required",
          attemptId: requiredAttempt.attemptId,
          recordedAt: "2026-08-09T12:00:00.500Z",
        },
        {
          schemaVersion: 1,
          observationId: "r-ok",
          kind: "attempt_succeeded",
          stageId: "required",
          attemptId: requiredAttempt.attemptId,
          recordedAt: "2026-08-09T12:00:00.600Z",
        },
        {
          schemaVersion: 1,
          observationId: "o-s",
          kind: "attempt_started",
          stageId: "optional",
          attemptId: optionalAttempt.attemptId,
          recordedAt: "2026-08-09T12:00:00.700Z",
        },
        {
          schemaVersion: 1,
          observationId: "o-f",
          kind: "attempt_failed",
          stageId: "optional",
          attemptId: optionalAttempt.attemptId,
          retryable: false,
          recordedAt: "2026-08-09T12:00:00.800Z",
        },
      ],
      canonicalState: {},
      pendingEvaluatorEdgeKeys: [],
      evaluatorDecisions: [],
    } as never);
    expect(settled.terminal?.outcome).toBe("succeeded");
    expect(settled.stagePatches.find((stage) => stage.stageId === "optional")?.state).toBe(
      "failed",
    );
  });
});
