/**
 * Durable pipeline runner operation ledger — persist, CAS, inbox, reconstruct.
 */

import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internalHandle } from "../src/database/open.js";
import {
  appendRunnerExternalObservation,
  appendRunnerReconciliationTrace,
  claimRunnerDispatch,
  listPipelineApprovalInbox,
  openStateDatabase,
  persistRunnerOperationRequest,
  readRunnerAttempt,
  readRunnerOperationState,
  reconstructRunnerOperation,
  recordRunnerApprovalAnswer,
  runMigrations,
  type StateDatabase,
  updateRunnerAttempt,
  updateRunnerOperationState,
} from "../src/index.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { makeTempDbPath } from "./helpers/temp-db.js";

const NOW = "2026-08-09T22:00:00.000Z";

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
  const handle = internalHandle(db);
  handle
    .prepare(
      `INSERT INTO pipeline_graph_revision
         (run_id, graph_revision, pipeline_id, graph_json, created_at)
       VALUES ('run-1', 1, 'p', '{}', ?)`,
    )
    .run(NOW);
});

afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

function seedDispatch(input: {
  readonly attemptId: string;
  readonly intentId: string;
  readonly stageId: string;
  readonly stageType: string;
  readonly attemptOrdinal?: number;
}): void {
  const handle = internalHandle(db);
  handle
    .prepare(
      `INSERT INTO pipeline_scheduler_intent
         (intent_id, run_id, graph_revision, kind, payload_json, state, created_at, delivered_at)
       VALUES (?, 'run-1', 1, 'dispatch', '{}', 'pending', ?, NULL)`,
    )
    .run(input.intentId, NOW);
  handle
    .prepare(
      `INSERT INTO pipeline_stage_attempt
         (attempt_id, run_id, pipeline_id, stage_id, graph_revision, generation,
          attempt_ordinal, stage_type, created_at)
       VALUES (?, 'run-1', 'p', ?, 1, 1, ?, ?, ?)`,
    )
    .run(input.attemptId, input.stageId, input.attemptOrdinal ?? 1, input.stageType, NOW);
}

describe("pipeline runner operations store", () => {
  it("claims all six fixed stage types and rejects evaluator", () => {
    const stageTypes = [
      "agent",
      "command",
      "approval",
      "integration",
      "verify",
      "publish",
    ] as const;
    for (const [index, stageType] of stageTypes.entries()) {
      seedDispatch({
        attemptId: `pa:${stageType}`,
        intentId: `intent:${stageType}`,
        stageId: stageType,
        stageType,
        attemptOrdinal: index + 1,
      });
      const claimed = claimRunnerDispatch(db, {
        attemptId: `pa:${stageType}`,
        runId: "run-1",
        stageId: stageType,
        stageType,
        intentId: `intent:${stageType}`,
        graphRevision: 1,
        generation: 1,
        attemptOrdinal: index + 1,
        now: NOW,
      });
      expect(claimed.status).toBe("claimed");
      if (claimed.status === "claimed") {
        expect(claimed.attempt.schemaVersion).toBe(2);
        expect(claimed.attempt.stageType).toBe(stageType);
      }
    }
    expect(
      claimRunnerDispatch(db, {
        attemptId: "pa:eval",
        runId: "run-1",
        stageId: "eval",
        stageType: "evaluator",
        intentId: "intent:eval",
        graphRevision: 1,
        generation: 1,
        attemptOrdinal: 1,
        now: NOW,
      }),
    ).toEqual({ status: "unsupported", stageType: "evaluator" });
  });

  it("persists operation request, CAS state, approval answer, and inbox", () => {
    seedDispatch({
      attemptId: "pa:gate",
      intentId: "intent:gate",
      stageId: "gate",
      stageType: "approval",
    });
    const claimed = claimRunnerDispatch(db, {
      attemptId: "pa:gate",
      runId: "run-1",
      stageId: "gate",
      stageType: "approval",
      intentId: "intent:gate",
      graphRevision: 1,
      generation: 1,
      attemptOrdinal: 1,
      now: NOW,
    });
    expect(claimed.status).toBe("claimed");
    if (claimed.status !== "claimed") throw new Error("expected claim");

    const requestJson = {
      schemaVersion: 1,
      prompt: "Ship it?",
      options: [
        { label: "approve", description: "go" },
        { label: "reject", description: "stop" },
      ],
      continuation: {
        schemaVersion: 1,
        runId: "run-1",
        stageId: "gate",
        attemptId: "pa:gate",
        intentId: "intent:gate",
        interactionId: "ix:gate",
      },
      requestedAt: NOW,
    };

    const persisted = persistRunnerOperationRequest(db, {
      operationId: "op:1",
      attemptId: "pa:gate",
      stageType: "approval",
      request: requestJson,
      initialPhase: "waiting",
      now: NOW,
    });
    expect(persisted.state.phase).toBe("waiting");
    expect(persisted.attempt.operationId).toBe("op:1");
    expect(persisted.attempt.schemaVersion).toBe(2);

    const inbox = listPipelineApprovalInbox(db);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.interaction.purpose).toBe("approval");
    expect(inbox[0]?.interaction.questions[0]?.prompt).toBe("Ship it?");

    const answered = recordRunnerApprovalAnswer(db, {
      answerId: "ans:1",
      operationId: "op:1",
      attemptId: "pa:gate",
      interactionId: "ix:gate",
      expectedRevision: 1,
      decision: "approve",
      selectedLabel: "approve",
      answeredByKeyId: "key:operator",
      decisionJson: {
        schemaVersion: 1,
        interactionId: "ix:gate",
        expectedInteractionRevision: 1,
        decision: "approve",
        answeredByKeyId: "key:operator",
        answeredAt: NOW,
        selectedLabel: "approve",
      },
      answeredAt: NOW,
    });
    expect(answered.status).toBe("recorded");
    expect(listPipelineApprovalInbox(db)).toHaveLength(0);

    const duplicate = recordRunnerApprovalAnswer(db, {
      answerId: "ans:2",
      operationId: "op:1",
      attemptId: "pa:gate",
      interactionId: "ix:gate",
      expectedRevision: 2,
      decision: "reject",
      selectedLabel: "reject",
      answeredByKeyId: "key:operator",
      decisionJson: { schemaVersion: 1 },
      answeredAt: NOW,
    });
    expect(duplicate.status).toBe("duplicate");

    const state = updateRunnerOperationState(db, {
      operationId: "op:1",
      expectedRevision: 2,
      phase: "completed",
      result: { ok: true },
      now: NOW,
    });
    expect(state.phase).toBe("completed");
    expect(state.revision).toBe(3);

    expect(() =>
      updateRunnerOperationState(db, {
        operationId: "op:1",
        expectedRevision: 2,
        phase: "failed",
        now: NOW,
      }),
    ).toThrow(/revision conflict/);

    appendRunnerExternalObservation(db, {
      observationId: "obs:1",
      attemptId: "pa:gate",
      operationId: "op:1",
      kind: "forge_pr_listed",
      payload: { count: 0 },
      recordedAt: NOW,
    });
    appendRunnerReconciliationTrace(db, {
      traceId: "trace:1",
      attemptId: "pa:gate",
      operationId: "op:1",
      stageType: "publish",
      classification: "created",
      recordedAt: NOW,
    });

    const reconstructed = reconstructRunnerOperation(db, "pa:gate");
    expect(reconstructed?.request.operationId).toBe("op:1");
    expect(reconstructed?.answer?.decision).toBe("approve");
    expect(reconstructed?.observations).toHaveLength(1);
    expect(reconstructed?.traces).toHaveLength(1);
    expect(readRunnerOperationState(db, "op:1")?.phase).toBe("completed");
  });

  it("allows widened recovery values on attempt update", () => {
    seedDispatch({
      attemptId: "pa:integ",
      intentId: "intent:integ",
      stageId: "integ",
      stageType: "integration",
    });
    const claimed = claimRunnerDispatch(db, {
      attemptId: "pa:integ",
      runId: "run-1",
      stageId: "integ",
      stageType: "integration",
      intentId: "intent:integ",
      graphRevision: 1,
      generation: 1,
      attemptOrdinal: 1,
      now: NOW,
    });
    expect(claimed.status).toBe("claimed");
    if (claimed.status !== "claimed") throw new Error("expected claim");
    const updated = updateRunnerAttempt(db, {
      attemptId: claimed.attempt.attemptId,
      expectedRevision: 1,
      recovery: "reconcile_git",
      now: NOW,
    });
    expect(updated.recovery).toBe("reconcile_git");
    expect(readRunnerAttempt(db, claimed.attempt.attemptId)?.schemaVersion).toBe(2);
  });
});
