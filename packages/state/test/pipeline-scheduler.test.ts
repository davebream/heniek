/**
 * Durable pipeline scheduler store — apply, CAS conflict, restart idempotency.
 */

import { rm } from "node:fs/promises";
import { initialStageSnapshots, type SchedulerInput, tickScheduler } from "@heniek/pipeline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPipelineSchedulerPlan,
  createPipelineSchedule,
  loadPipelineSchedulerInputParts,
  openStateDatabase,
  type PipelineGraph,
  readPipelineSchedulerDecisions,
  readPipelineSchedulerIntents,
  readPipelineStageProjections,
  recordPipelineObservation,
  runMigrations,
  type StateDatabase,
  toSchedulerObservations,
} from "../src/index.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const NOW = "2026-08-09T12:00:00.000Z";

function graph(): PipelineGraph {
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
        command: { argv: ["echo", "ok"], cwd: "." },
        reads: ["artifacts.design"],
        writes: ["artifacts.build"],
        overridable: [],
      },
    ],
    edges: [{ from: "design", to: "build" }],
  } as never;
}

function toInput(database: StateDatabase, now: string, canonicalState: unknown): SchedulerInput {
  const parts = loadPipelineSchedulerInputParts(database, "run-1");
  return {
    schemaVersion: 1,
    runId: "run-1",
    pipelineId: "linear",
    graphRevision: parts.schedule.graphRevision,
    scheduleRevision: parts.schedule.scheduleRevision,
    graph: parts.graph,
    now,
    ...(parts.schedule.deadlineAt ? { deadlineAt: parts.schedule.deadlineAt } : {}),
    stages: parts.stages.map((stage) => ({
      schemaVersion: 1 as const,
      runId: stage.runId,
      stageId: stage.stageId,
      graphRevision: stage.graphRevision,
      generation: stage.generation,
      state: stage.state,
      attemptOrdinal: stage.attemptOrdinal,
      selected: stage.selected,
      updatedAt: stage.updatedAt,
      ...(stage.currentAttemptId ? { currentAttemptId: stage.currentAttemptId } : {}),
      ...(stage.lastTransitionReason ? { lastTransitionReason: stage.lastTransitionReason } : {}),
      ...(stage.blockReason ? { blockReason: stage.blockReason } : {}),
    })),
    observations: toSchedulerObservations(parts.observations),
    canonicalState,
    pendingEvaluatorEdgeKeys: [...parts.pendingEvaluatorEdgeKeys],
    evaluatorDecisions: parts.evaluatorDecisions.map((entry) => ({
      edgeKey: entry.edgeKey,
      selected: entry.selected,
      recordedAt: entry.recordedAt,
    })),
  } as never;
}

let directory: string;
let path: string;
let db: StateDatabase;
let clock: ReturnType<typeof createFakeClock>;

beforeEach(async () => {
  const temp = await makeTempDbPath();
  directory = temp.directory;
  path = temp.path;
  clock = createFakeClock(Date.parse(NOW));
  db = openStateDatabase({
    path,
    clock,
    ids: createDeterministicIds(1),
  });
  runMigrations(db);
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function openAgain(): StateDatabase {
  return openStateDatabase({
    path,
    clock,
    ids: createDeterministicIds(100),
  });
}

describe("pipeline scheduler store", () => {
  it("creates a schedule and applies a tick plan with a dispatch intent", () => {
    createPipelineSchedule(db, {
      runId: "run-1",
      pipelineId: "linear",
      graph: graph(),
      now: NOW,
    });
    const plan = tickScheduler(toInput(db, NOW, { task: { current: "x" } }));
    const result = applyPipelineSchedulerPlan(db, plan);
    expect(result.status).toBe("applied");
    expect(readPipelineSchedulerIntents(db, "run-1")).toHaveLength(1);
    expect(readPipelineSchedulerIntents(db, "run-1")[0]?.kind).toBe("dispatch");
    expect(
      readPipelineStageProjections(db, "run-1").find((stage) => stage.stageId === "design")?.state,
    ).toBe("queued");
  });

  it("races two commits against the same revision and persists exactly one dispatch intent", () => {
    createPipelineSchedule(db, {
      runId: "run-1",
      pipelineId: "linear",
      graph: graph(),
      now: NOW,
    });
    const input = toInput(db, NOW, { task: { current: "x" } });
    const planA = tickScheduler(input);
    const planB = tickScheduler(input);
    expect(planA.intents[0]?.intentId).toBe(planB.intents[0]?.intentId);

    const first = applyPipelineSchedulerPlan(db, planA);
    const second = applyPipelineSchedulerPlan(db, planB);
    expect(first.status).toBe("applied");
    expect(second.status).toBe("conflict");
    expect(readPipelineSchedulerIntents(db, "run-1")).toHaveLength(1);
  });

  it("replays the same seeded sequence after reopen with byte-identical durable rows", () => {
    createPipelineSchedule(db, {
      runId: "run-1",
      pipelineId: "linear",
      graph: graph(),
      now: NOW,
    });

    const firstPlan = tickScheduler(toInput(db, NOW, { task: { current: "x" } }));
    expect(applyPipelineSchedulerPlan(db, firstPlan).status).toBe("applied");
    const intent = readPipelineSchedulerIntents(db, "run-1")[0];
    expect(intent).toBeDefined();
    if (intent === undefined) {
      throw new Error("expected dispatch intent");
    }
    const attemptId = (intent.payload as { attemptId: string }).attemptId;

    recordPipelineObservation(db, {
      observationId: "start-1",
      runId: "run-1",
      kind: "attempt_started",
      payload: { stageId: "design", attemptId },
      recordedAt: "2026-08-09T12:00:01.000Z",
    });
    recordPipelineObservation(db, {
      observationId: "ok-1",
      runId: "run-1",
      kind: "attempt_succeeded",
      payload: { stageId: "design", attemptId },
      recordedAt: "2026-08-09T12:00:02.000Z",
    });

    const secondPlan = tickScheduler(
      toInput(db, "2026-08-09T12:00:03.000Z", {
        task: { current: "x" },
        artifacts: { design: { ok: true } },
      }),
    );
    expect(applyPipelineSchedulerPlan(db, secondPlan).status).toBe("applied");

    const snapshot = {
      decisions: readPipelineSchedulerDecisions(db, "run-1"),
      intents: readPipelineSchedulerIntents(db, "run-1"),
      stages: readPipelineStageProjections(db, "run-1"),
    };

    db.close();
    db = openAgain();
    const again = {
      decisions: readPipelineSchedulerDecisions(db, "run-1"),
      intents: readPipelineSchedulerIntents(db, "run-1"),
      stages: readPipelineStageProjections(db, "run-1"),
    };
    expect(JSON.stringify(again)).toBe(JSON.stringify(snapshot));

    const before = readPipelineSchedulerIntents(db, "run-1").length;
    const idle = tickScheduler(
      toInput(db, "2026-08-09T12:00:04.000Z", {
        task: { current: "x" },
        artifacts: { design: { ok: true } },
      }),
    );
    applyPipelineSchedulerPlan(db, idle);
    expect(readPipelineSchedulerIntents(db, "run-1")).toHaveLength(before);
  });

  it("initialStageSnapshots matches createPipelineSchedule projections", () => {
    const g = graph();
    createPipelineSchedule(db, {
      runId: "run-1",
      pipelineId: "linear",
      graph: g,
      now: NOW,
    });
    const expected = initialStageSnapshots({
      runId: "run-1",
      graphRevision: 1,
      graph: g,
      now: NOW,
    });
    const actual = readPipelineStageProjections(db, "run-1");
    expect(actual.map((stage) => stage.stageId)).toEqual(expected.map((stage) => stage.stageId));
    expect(actual.every((stage) => stage.state === "pending")).toBe(true);
  });
});
