/**
 * Durable pipeline runner store — claim, update, finalize, cleanup health.
 */

import { rm } from "node:fs/promises";
import { initialStageSnapshots, tickScheduler } from "@heniek/pipeline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimRunnerDispatch,
  createPipelineSchedule,
  exportRunnerAttempt,
  finalizeRunnerAttempt,
  markPipelineSchedulerIntentDelivered,
  openStateDatabase,
  type PipelineGraph,
  readPendingPipelineSchedulerIntents,
  reportRunnerCleanupHealth,
  runMigrations,
  type StateDatabase,
  updateRunnerAttempt,
} from "../src/index.js";
import { applyPipelineSchedulerPlan } from "../src/pipeline/store.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const NOW = "2026-08-09T18:00:00.000Z";

function graph(): PipelineGraph {
  return {
    schemaVersion: 1,
    pipelineId: "cmd",
    mode: "autonomous",
    limits: {},
    context: {},
    stages: [
      {
        id: "build",
        type: "command",
        mode: "autonomous",
        optional: false,
        command: { argv: ["true"] },
        reads: [],
        writes: ["artifacts.build"],
        overridable: [],
        completion: {
          require: [{ kind: "result_envelope" }],
        },
      },
    ],
    edges: [],
  } as never;
}

let directory: string;
let db: StateDatabase;

beforeEach(async () => {
  const temp = await makeTempDbPath();
  directory = temp.directory;
  db = openStateDatabase({
    path: temp.path,
    clock: createFakeClock(Date.parse(NOW)),
    ids: createDeterministicIds(1),
  });
  runMigrations(db);
  createPipelineSchedule(db, {
    runId: "run-1",
    pipelineId: "cmd",
    graph: graph(),
    now: NOW,
  });
  const plan = tickScheduler({
    schemaVersion: 1,
    runId: "run-1",
    pipelineId: "cmd",
    graphRevision: 1,
    scheduleRevision: 1,
    graph: graph() as never,
    now: NOW,
    stages: initialStageSnapshots({
      runId: "run-1",
      graphRevision: 1,
      graph: graph() as never,
      now: NOW,
    }),
    observations: [],
    canonicalState: {},
    pendingEvaluatorEdgeKeys: [],
    evaluatorDecisions: [],
  });
  applyPipelineSchedulerPlan(db, plan);
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

describe("pipeline runner store", () => {
  it("claims a dispatch intent idempotently and finalizes with an observation", () => {
    const intents = readPendingPipelineSchedulerIntents(db, { runId: "run-1" });
    const dispatch = intents.find((intent) => intent.kind === "dispatch");
    expect(dispatch).toBeDefined();
    if (dispatch === undefined) {
      throw new Error("expected dispatch intent");
    }
    const payload = dispatch.payload as Record<string, unknown>;

    const first = claimRunnerDispatch(db, {
      attemptId: String(payload.attemptId),
      runId: "run-1",
      stageId: String(payload.stageId),
      stageType: "command",
      intentId: dispatch.intentId,
      graphRevision: 1,
      generation: Number(payload.generation),
      attemptOrdinal: Number(payload.attemptOrdinal),
      now: NOW,
    });
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed" && first.status !== "duplicate") {
      throw new Error("expected claimable dispatch");
    }

    const second = claimRunnerDispatch(db, {
      attemptId: String(payload.attemptId),
      runId: "run-1",
      stageId: String(payload.stageId),
      stageType: "command",
      intentId: dispatch.intentId,
      graphRevision: 1,
      generation: Number(payload.generation),
      attemptOrdinal: Number(payload.attemptOrdinal),
      now: NOW,
    });
    expect(second.status).toBe("duplicate");
    if (second.status !== "claimed" && second.status !== "duplicate") {
      throw new Error("expected duplicate claim");
    }

    let attempt = first.attempt;
    attempt = updateRunnerAttempt(db, {
      attemptId: attempt.attemptId,
      expectedRevision: attempt.revision,
      phase: "finalize",
      now: NOW,
    });

    const validation = {
      schemaVersion: 1 as const,
      attemptId: attempt.attemptId,
      valid: true,
      missingWrites: [],
      missingEvidence: [],
      envelopeValid: true,
      exitCodeAlone: false,
      recordedAt: NOW,
    };
    const result = {
      schemaVersion: 2 as const,
      attemptId: attempt.attemptId,
      outcome: "succeeded" as const,
      summary: "ok",
      artifactPath: "artifacts/build.md",
      outputs: [
        {
          schemaVersion: 1 as const,
          reference: "artifacts.build",
          kind: "value" as const,
          value: { ok: true },
        },
      ],
      evidence: [
        {
          schemaVersion: 1 as const,
          kind: "result_envelope" as const,
          satisfied: true,
          recordedAt: NOW,
        },
      ],
      finishedAt: NOW,
    };

    const finalized = finalizeRunnerAttempt(db, {
      attemptId: attempt.attemptId,
      expectedRevision: attempt.revision,
      observationId: "obs-1",
      observationKind: "attempt_succeeded",
      outputs: result.outputs,
      evidence: result.evidence,
      validation,
      result,
      phase: "succeeded",
      now: NOW,
    });
    expect(finalized.phase).toBe("succeeded");
    expect(readPendingPipelineSchedulerIntents(db, { runId: "run-1" })).toHaveLength(0);

    const exported = exportRunnerAttempt(db, attempt.attemptId);
    expect(exported.transitions.length).toBeGreaterThan(0);
    expect(exported.validation?.valid).toBe(true);
    expect(reportRunnerCleanupHealth(db).openAttempts).toBe(0);
  });

  it("marks intents delivered idempotently", () => {
    const intents = readPendingPipelineSchedulerIntents(db, { runId: "run-1" });
    const dispatch = intents[0];
    expect(dispatch).toBeDefined();
    if (dispatch === undefined) {
      throw new Error("expected pending intent");
    }
    markPipelineSchedulerIntentDelivered(db, dispatch.intentId, NOW);
    markPipelineSchedulerIntentDelivered(db, dispatch.intentId, NOW);
    expect(readPendingPipelineSchedulerIntents(db, { runId: "run-1" })).toHaveLength(0);
  });
});
