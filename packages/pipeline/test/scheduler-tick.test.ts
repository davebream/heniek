/**
 * Deterministic scheduler tick behaviour for the six v1 stage types.
 */

import { describe, expect, it } from "vitest";
import type { PipelineGraph } from "../src/document.js";
import { parseConditionExpression } from "../src/expression/parse.js";
import {
  initialStageSnapshots,
  type SchedulerInput,
  tickScheduler,
} from "../src/scheduler/tick.js";

function expression(source: string) {
  const parsed = parseConditionExpression(source);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return { kind: "expression" as const, nodes: [...parsed.nodes], root: parsed.root } as never;
}

function linearGraph(): PipelineGraph {
  return {
    schemaVersion: 1,
    pipelineId: "linear",
    mode: "autonomous",
    limits: { maxRepairAttempts: 1 },
    context: {},
    stages: [
      {
        id: "design",
        type: "agent",
        mode: "autonomous",
        optional: false,
        profile: "designer",
        reads: ["task.current"],
        writes: ["artifacts.design"],
        overridable: [],
      },
      {
        id: "build",
        type: "command",
        mode: "autonomous",
        optional: false,
        command: { argv: ["echo", "build"], cwd: "." },
        reads: ["artifacts.design"],
        writes: ["artifacts.build"],
        overridable: [],
      },
    ],
    edges: [{ from: "design", to: "build" }],
  } as never;
}

function baseInput(graph: PipelineGraph, now = "2026-08-09T12:00:00.000Z"): SchedulerInput {
  return {
    schemaVersion: 1,
    runId: "run-1",
    pipelineId: graph.pipelineId,
    graphRevision: 1,
    scheduleRevision: 1,
    graph,
    now,
    stages: initialStageSnapshots({
      runId: "run-1",
      graphRevision: 1,
      graph,
      now,
    }),
    observations: [],
    canonicalState: { task: { current: "ship it" } },
    pendingEvaluatorEdgeKeys: [],
    evaluatorDecisions: [],
  } as never;
}

describe("tickScheduler", () => {
  it("releases roots and queues a dispatch intent in stage-id order", () => {
    const graph: PipelineGraph = {
      schemaVersion: 1,
      pipelineId: "fanout",
      mode: "autonomous",
      limits: {},
      context: {},
      stages: [
        {
          id: "a",
          type: "agent",
          mode: "autonomous",
          optional: false,
          profile: "p",
          reads: [],
          writes: ["artifacts.a"],
          overridable: [],
        },
        {
          id: "b",
          type: "agent",
          mode: "autonomous",
          optional: false,
          profile: "p",
          reads: [],
          writes: ["artifacts.b"],
          overridable: [],
        },
      ],
      edges: [],
    } as never;
    const plan = tickScheduler(baseInput(graph));
    expect(plan.intents.map((intent) => intent.kind)).toEqual(["dispatch", "dispatch"]);
    expect(plan.intents.map((intent) => (intent.payload as { stageId: string }).stageId)).toEqual([
      "a",
      "b",
    ]);
    expect(plan.stagePatches.map((stage) => `${stage.stageId}:${stage.state}`)).toEqual([
      "a:queued",
      "b:queued",
    ]);
  });

  it("requires fan-in before releasing a successor", () => {
    const graph = linearGraph();
    const first = tickScheduler(baseInput(graph));
    expect(first.stagePatches.find((stage) => stage.stageId === "design")?.state).toBe("queued");
    expect(first.stagePatches.find((stage) => stage.stageId === "build")?.state).toBe("pending");

    const afterStart: SchedulerInput = {
      ...baseInput(graph),
      scheduleRevision: 2,
      stages: first.stagePatches,
      observations: [
        {
          schemaVersion: 1,
          observationId: "obs-start",
          kind: "attempt_started",
          stageId: "design",
          attemptId: first.attempts[0]!.attemptId,
          recordedAt: "2026-08-09T12:00:01.000Z",
        },
        {
          schemaVersion: 1,
          observationId: "obs-ok",
          kind: "attempt_succeeded",
          stageId: "design",
          attemptId: first.attempts[0]!.attemptId,
          recordedAt: "2026-08-09T12:00:02.000Z",
        },
      ],
      canonicalState: {
        task: { current: "ship it" },
        artifacts: { design: { selected: true } },
      },
    };
    const second = tickScheduler(afterStart);
    expect(second.stagePatches.find((stage) => stage.stageId === "design")?.state).toBe(
      "succeeded",
    );
    expect(second.stagePatches.find((stage) => stage.stageId === "build")?.state).toBe("queued");
  });

  it("cancels unselected conditional branches", () => {
    const graph: PipelineGraph = {
      schemaVersion: 1,
      pipelineId: "cond",
      mode: "autonomous",
      limits: {},
      context: {},
      stages: [
        {
          id: "verify",
          type: "verify",
          mode: "autonomous",
          optional: false,
          profile: "v",
          reads: [],
          writes: ["verify.blockingFindings"],
          overridable: [],
        },
        {
          id: "repair",
          type: "agent",
          mode: "autonomous",
          optional: false,
          profile: "r",
          reads: ["verify.blockingFindings"],
          writes: ["artifacts.repair"],
          overridable: [],
        },
        {
          id: "publish",
          type: "publish",
          mode: "autonomous",
          optional: false,
          profile: "p",
          reads: [],
          writes: ["artifacts.publish"],
          overridable: [],
        },
      ],
      edges: [
        {
          from: "verify",
          to: "repair",
          condition: expression("verify.blockingFindings.length > 0"),
        },
        {
          from: "verify",
          to: "publish",
          condition: expression("verify.blockingFindings.length == 0"),
        },
      ],
    } as never;
    const queued = tickScheduler(baseInput(graph));
    const afterVerify = tickScheduler({
      ...baseInput(graph),
      scheduleRevision: 2,
      stages: queued.stagePatches,
      observations: [
        {
          schemaVersion: 1,
          observationId: "s",
          kind: "attempt_started",
          stageId: "verify",
          attemptId: queued.attempts[0]!.attemptId,
          recordedAt: "2026-08-09T12:00:01.000Z",
        },
        {
          schemaVersion: 1,
          observationId: "ok",
          kind: "attempt_succeeded",
          stageId: "verify",
          attemptId: queued.attempts[0]!.attemptId,
          recordedAt: "2026-08-09T12:00:02.000Z",
        },
      ],
      canonicalState: { verify: { blockingFindings: [] } },
    });
    expect(afterVerify.stagePatches.find((stage) => stage.stageId === "repair")?.state).toBe(
      "cancelled",
    );
    expect(
      afterVerify.stagePatches.find((stage) => stage.stageId === "repair")?.lastTransitionReason,
    ).toBe("condition_not_selected");
    expect(afterVerify.stagePatches.find((stage) => stage.stageId === "publish")?.state).toBe(
      "queued",
    );
  });

  it("moves retryable failures through running → retrying → ready on separate ticks", () => {
    const graph = linearGraph();
    const queued = tickScheduler(baseInput(graph));
    const failed = tickScheduler({
      ...baseInput(graph),
      scheduleRevision: 2,
      stages: queued.stagePatches,
      observations: [
        {
          schemaVersion: 1,
          observationId: "s",
          kind: "attempt_started",
          stageId: "design",
          attemptId: queued.attempts[0]!.attemptId,
          recordedAt: "2026-08-09T12:00:01.000Z",
        },
        {
          schemaVersion: 1,
          observationId: "f",
          kind: "attempt_failed",
          stageId: "design",
          attemptId: queued.attempts[0]!.attemptId,
          retryable: true,
          recordedAt: "2026-08-09T12:00:02.000Z",
        },
      ],
    });
    expect(failed.stagePatches.find((stage) => stage.stageId === "design")?.state).toBe("retrying");
    expect(failed.attempts).toHaveLength(0);

    const rearmed = tickScheduler({
      ...baseInput(graph),
      scheduleRevision: 3,
      stages: failed.stagePatches,
      observations: [],
    });
    expect(
      rearmed.transitions.some(
        (transition) => transition.from === "retrying" && transition.to === "ready",
      ),
    ).toBe(true);
    expect(rearmed.stagePatches.find((stage) => stage.stageId === "design")?.state).toBe("queued");
    expect(rearmed.attempts[0]!.attemptOrdinal).toBe(2);
  });

  it("arms retrying → ready only on a later tick", () => {
    const graph = linearGraph();
    const input = baseInput(graph);
    const stages = initialStageSnapshots({
      runId: input.runId,
      graphRevision: 1,
      graph,
      now: input.now,
    }).map((stage) =>
      stage.stageId === "design"
        ? {
            ...stage,
            state: "retrying" as const,
            attemptOrdinal: 1,
            currentAttemptId: "pa:run-1:1:design:1:1",
            lastTransitionReason: "retry_scheduled" as const,
          }
        : stage,
    ) as never;
    const plan = tickScheduler({ ...input, stages });
    // Rearm to ready then immediately queue the next attempt in the same tick
    // after retrying was already persisted — the running→retrying step was prior.
    expect(
      plan.transitions.some(
        (transition) => transition.from === "retrying" && transition.to === "ready",
      ),
    ).toBe(true);
    expect(plan.stagePatches.find((stage) => stage.stageId === "design")?.state).toBe("queued");
  });

  it("blocks when an expression path is missing", () => {
    const graph: PipelineGraph = {
      schemaVersion: 1,
      pipelineId: "blocked",
      mode: "autonomous",
      limits: {},
      context: {},
      stages: [
        {
          id: "a",
          type: "agent",
          mode: "autonomous",
          optional: false,
          profile: "p",
          reads: [],
          writes: ["artifacts.a"],
          overridable: [],
        },
        {
          id: "b",
          type: "agent",
          mode: "autonomous",
          optional: false,
          profile: "p",
          reads: [],
          writes: ["artifacts.b"],
          overridable: [],
        },
      ],
      edges: [{ from: "a", to: "b", condition: expression("artifacts.a.ok == true") }],
    } as never;
    const queued = tickScheduler(baseInput(graph));
    const after = tickScheduler({
      ...baseInput(graph),
      scheduleRevision: 2,
      stages: queued.stagePatches,
      observations: [
        {
          schemaVersion: 1,
          observationId: "s",
          kind: "attempt_started",
          stageId: "a",
          attemptId: queued.attempts[0]!.attemptId,
          recordedAt: "2026-08-09T12:00:01.000Z",
        },
        {
          schemaVersion: 1,
          observationId: "ok",
          kind: "attempt_succeeded",
          stageId: "a",
          attemptId: queued.attempts[0]!.attemptId,
          recordedAt: "2026-08-09T12:00:02.000Z",
        },
      ],
      canonicalState: {},
    });
    expect(after.stagePatches.find((stage) => stage.stageId === "b")?.state).toBe("blocked");
    expect(after.terminal?.outcome).toBe("blocked");
  });

  it("cancels inactive stages immediately and emits cancel intents for active ones", () => {
    const graph = linearGraph();
    const queued = tickScheduler(baseInput(graph));
    const cancelled = tickScheduler({
      ...baseInput(graph),
      scheduleRevision: 2,
      stages: queued.stagePatches,
      observations: [
        {
          schemaVersion: 1,
          observationId: "cancel",
          kind: "cancel_requested",
          recordedAt: "2026-08-09T12:00:01.000Z",
        },
      ],
    });
    expect(cancelled.stagePatches.find((stage) => stage.stageId === "design")?.state).toBe(
      "queued",
    );
    expect(cancelled.intents.some((intent) => intent.kind === "cancel")).toBe(true);
    expect(cancelled.stagePatches.find((stage) => stage.stageId === "build")?.state).toBe(
      "cancelled",
    );
  });

  it("produces byte-identical plans for identical inputs", () => {
    const input = baseInput(linearGraph());
    expect(JSON.stringify(tickScheduler(input))).toBe(JSON.stringify(tickScheduler(input)));
  });

  it("schedules validation repair_fresh with a retry directive on the next attempt", () => {
    const graph: PipelineGraph = {
      schemaVersion: 1,
      pipelineId: "repair",
      mode: "autonomous",
      limits: { maxRepairAttempts: 3 },
      context: {},
      stages: [
        {
          id: "design",
          type: "agent",
          mode: "autonomous",
          optional: false,
          profile: "designer",
          reads: ["task.current"],
          writes: ["artifacts.design"],
          overridable: [],
          onValidationFailure: { strategy: "repair_fresh" },
        },
      ],
      edges: [],
    } as never;
    const queued = tickScheduler(baseInput(graph));
    const failed = tickScheduler({
      ...baseInput(graph),
      scheduleRevision: 2,
      stages: queued.stagePatches,
      effectiveLimits: { maxRepairAttempts: 3 },
      observations: [
        {
          schemaVersion: 2,
          observationId: "s",
          kind: "attempt_started",
          stageId: "design",
          attemptId: queued.attempts[0]!.attemptId,
          recordedAt: "2026-08-09T12:00:01.000Z",
        },
        {
          schemaVersion: 2,
          observationId: "f",
          kind: "attempt_failed",
          stageId: "design",
          attemptId: queued.attempts[0]!.attemptId,
          retryable: true,
          classification: "validation_failed",
          phase: "validate",
          code: "schema",
          recordedAt: "2026-08-09T12:00:02.000Z",
        },
      ],
    });
    expect(failed.stagePatches.find((stage) => stage.stageId === "design")?.state).toBe("retrying");
    expect(failed.recoveryDecisions?.[0]?.outcome).toBe("repair_fresh");

    const rearmed = tickScheduler({
      ...baseInput(graph),
      scheduleRevision: 3,
      stages: failed.stagePatches,
      effectiveLimits: { maxRepairAttempts: 3 },
      ...(failed.recoveryState !== undefined ? { recoveryState: failed.recoveryState } : {}),
      observations: [],
    });
    expect(rearmed.attempts[0]?.attemptOrdinal).toBe(2);
    expect(rearmed.attempts[0]?.retryDirective?.mode).toBe("fresh");
    expect(rearmed.attempts[0]?.sessionPolicy).toBe("fresh");
  });

  it("fails with unchanged_failure_exhausted for repeated identical signatures", () => {
    const graph: PipelineGraph = {
      schemaVersion: 1,
      pipelineId: "unchanged",
      mode: "autonomous",
      limits: { maxRepairAttempts: 2 },
      context: {},
      stages: [
        {
          id: "design",
          type: "agent",
          mode: "autonomous",
          optional: false,
          profile: "designer",
          reads: ["task.current"],
          writes: ["artifacts.design"],
          overridable: [],
        },
      ],
      edges: [],
    } as never;
    const queued = tickScheduler(baseInput(graph));
    const firstFail = tickScheduler({
      ...baseInput(graph),
      scheduleRevision: 2,
      stages: queued.stagePatches,
      effectiveLimits: { maxRepairAttempts: 2 },
      observations: [
        {
          schemaVersion: 2,
          observationId: "s1",
          kind: "attempt_started",
          stageId: "design",
          attemptId: queued.attempts[0]!.attemptId,
          recordedAt: "2026-08-09T12:00:01.000Z",
        },
        {
          schemaVersion: 2,
          observationId: "f1",
          kind: "attempt_failed",
          stageId: "design",
          attemptId: queued.attempts[0]!.attemptId,
          retryable: true,
          classification: "timeout",
          phase: "running",
          code: "timeout",
          recordedAt: "2026-08-09T12:00:02.000Z",
        },
      ],
    });
    expect(firstFail.stagePatches.find((stage) => stage.stageId === "design")?.state).toBe(
      "retrying",
    );

    const rearmed = tickScheduler({
      ...baseInput(graph),
      scheduleRevision: 3,
      stages: firstFail.stagePatches,
      effectiveLimits: { maxRepairAttempts: 2 },
      ...(firstFail.recoveryState !== undefined ? { recoveryState: firstFail.recoveryState } : {}),
      observations: [],
    });
    const secondFail = tickScheduler({
      ...baseInput(graph),
      scheduleRevision: 4,
      stages: rearmed.stagePatches,
      effectiveLimits: { maxRepairAttempts: 2 },
      ...(rearmed.recoveryState !== undefined ? { recoveryState: rearmed.recoveryState } : {}),
      observations: [
        {
          schemaVersion: 2,
          observationId: "s2",
          kind: "attempt_started",
          stageId: "design",
          attemptId: rearmed.attempts[0]!.attemptId,
          recordedAt: "2026-08-09T12:00:03.000Z",
        },
        {
          schemaVersion: 2,
          observationId: "f2",
          kind: "attempt_failed",
          stageId: "design",
          attemptId: rearmed.attempts[0]!.attemptId,
          retryable: true,
          classification: "timeout",
          phase: "running",
          code: "timeout",
          recordedAt: "2026-08-09T12:00:04.000Z",
        },
      ],
    });
    expect(secondFail.stagePatches.find((stage) => stage.stageId === "design")?.state).toBe(
      "failed",
    );
    expect(
      secondFail.decisions.some((decision) => decision.reason === "unchanged_failure_exhausted"),
    ).toBe(true);
    expect(
      secondFail.recoveryDecisions?.some((decision) => decision.outcome === "unchanged_exhausted"),
    ).toBe(true);
  });
});
