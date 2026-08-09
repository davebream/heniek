import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDecisionV1, ApprovalRequestV1 } from "@heniek/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createApprovalStageRunner } from "../src/index.js";
import type { PipelineGraphStage, StageRunnerPrepareInput } from "../src/types.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heniek-runner-approval-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function approvalStage(): PipelineGraphStage {
  return {
    id: "gate" as PipelineGraphStage["id"],
    type: "approval",
    mode: "hitl",
    optional: false,
    reads: [],
    writes: [],
    overridable: [],
  };
}

function approvalRequest(now = "2026-01-01T00:00:00.000Z"): ApprovalRequestV1 {
  return {
    schemaVersion: 1,
    prompt: "Ship this change?",
    options: [
      { label: "approve", description: "Continue" },
      { label: "reject", description: "Stop" },
    ],
    continuation: {
      schemaVersion: 1,
      runId: "run_1" as ApprovalRequestV1["continuation"]["runId"],
      stageId: "gate" as ApprovalRequestV1["continuation"]["stageId"],
      attemptId: "att_1" as ApprovalRequestV1["continuation"]["attemptId"],
      intentId: "intent_1" as ApprovalRequestV1["continuation"]["intentId"],
      interactionId: "ix_1",
    },
    requestedAt: now,
  };
}

function decision(overrides: Partial<ApprovalDecisionV1> = {}): ApprovalDecisionV1 {
  return {
    schemaVersion: 1,
    interactionId: "ix_1",
    expectedInteractionRevision: 1,
    decision: "approve",
    answeredByKeyId: "key_operator",
    answeredAt: "2026-01-01T00:01:00.000Z",
    selectedLabel: "approve",
    ...overrides,
  };
}

function basePrepare(
  runtimeDirectory: string,
  request: ApprovalRequestV1,
): StageRunnerPrepareInput {
  const stage = approvalStage();
  return {
    attemptId: "att_1",
    runId: "run_1",
    stageId: stage.id,
    intentId: "intent_1",
    graphRevision: 1,
    generation: 1,
    attemptOrdinal: 1,
    stage,
    runtimeDirectory,
    approvalRequest: request,
  };
}

describe("approval stage runner", () => {
  it("waits until answered and succeeds on approve", async () => {
    const runtime = await tempRoot();
    const runner = createApprovalStageRunner();
    await runner.prepare(basePrepare(runtime, approvalRequest()));
    await runner.start("att_1");
    expect(await runner.observe("att_1")).toEqual({ status: "waiting" });

    const answered = await runner.answer("att_1", decision());
    expect(answered).toEqual({ status: "recorded" });
    expect(await runner.observe("att_1")).toEqual({
      status: "terminal",
      backendStatus: "succeeded",
    });

    await runner.collect("att_1");
    const validation = await runner.validate("att_1");
    expect(validation.valid).toBe(true);
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.outcome).toBe("succeeded");
    expect(finalized.result.evidence.some((item) => item.kind === "verdict")).toBe(true);
  });

  it("rejects without auto-approve and classifies rejected", async () => {
    const runtime = await tempRoot();
    const runner = createApprovalStageRunner();
    await runner.prepare(basePrepare(runtime, approvalRequest()));
    await runner.start("att_1");
    await runner.answer("att_1", decision({ decision: "reject", selectedLabel: "reject" }));
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.outcome).toBe("failed");
    expect(finalized.result.failure?.classification).toBe("rejected");
    expect(finalized.result.failure?.retryable).toBe(false);
  });

  it("returns stale_revision on CAS mismatch", async () => {
    const runtime = await tempRoot();
    const runner = createApprovalStageRunner();
    await runner.prepare(basePrepare(runtime, approvalRequest()));
    await runner.start("att_1");
    const stale = await runner.answer("att_1", decision({ expectedInteractionRevision: 99 }));
    expect(stale).toEqual({ status: "stale_revision" });
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.failure?.classification).toBe("stale_revision");
  });

  it("cancels while waiting", async () => {
    const runtime = await tempRoot();
    const runner = createApprovalStageRunner();
    await runner.prepare(basePrepare(runtime, approvalRequest()));
    await runner.start("att_1");
    const cleanup = await runner.cancel("att_1");
    expect(cleanup.cleaned).toBe(true);
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.outcome).toBe("cancelled");
    expect(finalized.result.failure?.classification).toBe("cancelled");
  });

  it("does not require a checkout workspace", async () => {
    const runtime = await tempRoot();
    const runner = createApprovalStageRunner();
    const prepared = await runner.prepare(basePrepare(runtime, approvalRequest()));
    expect(prepared.checkoutPath).toBeUndefined();
  });
});
