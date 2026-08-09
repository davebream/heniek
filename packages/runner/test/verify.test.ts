import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifyRequestV1 } from "@heniek/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifyStageRunner, type spawnCommand } from "../src/index.js";
import type { PipelineGraphStage, StageRunnerPrepareInput } from "../src/types.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heniek-runner-verify-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function verifyStage(): PipelineGraphStage {
  return {
    id: "verify" as PipelineGraphStage["id"],
    type: "verify",
    mode: "autonomous",
    optional: false,
    reads: [],
    writes: [],
    overridable: [],
  };
}

function request(checks: VerifyRequestV1["checks"]): VerifyRequestV1 {
  return { schemaVersion: 1, checks };
}

function basePrepare(
  checkoutPath: string,
  runtimeDirectory: string,
  verifyRequest: VerifyRequestV1,
): StageRunnerPrepareInput {
  const stage = verifyStage();
  return {
    attemptId: "att_1",
    runId: "run_1",
    stageId: stage.id,
    intentId: "intent_1",
    graphRevision: 1,
    generation: 1,
    attemptOrdinal: 1,
    stage,
    checkoutPath,
    runtimeDirectory,
    verifyRequest,
  };
}

async function drain(runner: ReturnType<typeof createVerifyStageRunner>): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const observed = await runner.observe("att_1");
    if (observed.status === "terminal" || observed.status === "timed_out") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("verify did not reach a terminal observe status");
}

describe("verify stage runner", () => {
  it("passes when every required check matches expectedExitCode", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const spawn = vi.fn(async (input: Parameters<typeof spawnCommand>[0]) => {
      expect(input.argv[0]).not.toBe("sh");
      return {
        pid: 11,
        processGroupId: 11,
        child: { pid: 11 } as never,
        exit: Promise.resolve({ code: 0, signal: null }),
      };
    });
    const runner = createVerifyStageRunner({ spawn });
    await runner.prepare(
      basePrepare(
        checkout,
        runtime,
        request([
          {
            schemaVersion: 1,
            checkId: "unit",
            argv: ["/bin/true"],
            expectedExitCode: 0,
            required: true,
          },
          {
            schemaVersion: 1,
            checkId: "lint",
            argv: ["/usr/bin/env", "true"],
            expectedExitCode: 0,
            required: true,
          },
        ]),
      ),
    );
    await runner.start("att_1");
    await drain(runner);
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.outcome).toBe("succeeded");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("fails when a required check mismatches expectedExitCode", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const spawn = vi.fn(async () => ({
      pid: 12,
      processGroupId: 12,
      child: { pid: 12 } as never,
      exit: Promise.resolve({ code: 2, signal: null }),
    }));
    const runner = createVerifyStageRunner({ spawn });
    await runner.prepare(
      basePrepare(
        checkout,
        runtime,
        request([
          {
            schemaVersion: 1,
            checkId: "unit",
            argv: ["/bin/false"],
            expectedExitCode: 0,
            required: true,
          },
        ]),
      ),
    );
    await runner.start("att_1");
    await drain(runner);
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.outcome).toBe("failed");
    expect(finalized.result.failure?.classification).toBe("process_failed");
  });

  it("classifies malformed contracts", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const runner = createVerifyStageRunner({
      spawn: vi.fn(async () => {
        throw new Error("should not spawn");
      }),
    });
    await runner.prepare(
      basePrepare(
        checkout,
        runtime,
        request([
          {
            schemaVersion: 1,
            checkId: "broken",
            argv: [""],
            expectedExitCode: 0,
            required: true,
          },
        ]),
      ),
    );
    await runner.start("att_1");
    await drain(runner);
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.failure?.classification).toBe("malformed_contract");
  });

  it("cancels mid-checks", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawn = vi.fn(async () => ({
      pid: 13,
      processGroupId: 13,
      child: { pid: 13 } as never,
      exit: gate.then(() => ({ code: 0, signal: null })),
    }));
    const terminate = vi.fn(async () => ({
      schemaVersion: 1 as const,
      attemptId: "att_1" as never,
      processGroupId: 13,
      signalSequence: ["SIGTERM" as const],
      descendantsRemaining: 0,
      gracePeriodMs: 20,
      cleaned: true,
      recordedAt: new Date().toISOString(),
    }));
    const runner = createVerifyStageRunner({ spawn, terminate, gracePeriodMs: 20 });
    await runner.prepare(
      basePrepare(
        checkout,
        runtime,
        request([
          {
            schemaVersion: 1,
            checkId: "slow",
            argv: ["/bin/sleep", "30"],
            expectedExitCode: 0,
            required: true,
          },
        ]),
      ),
    );
    await runner.start("att_1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const cleanup = await runner.cancel("att_1");
    expect(cleanup.cleaned).toBe(true);
    release();
    await drain(runner);
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.outcome).toBe("cancelled");
  });

  it("replays a collected result as terminal on observe", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const spawn = vi.fn(async () => ({
      pid: 14,
      processGroupId: 14,
      child: { pid: 14 } as never,
      exit: Promise.resolve({ code: 0, signal: null }),
    }));
    const runner = createVerifyStageRunner({ spawn });
    await runner.prepare(
      basePrepare(
        checkout,
        runtime,
        request([
          {
            schemaVersion: 1,
            checkId: "unit",
            argv: ["/bin/true"],
            expectedExitCode: 0,
            required: true,
          },
        ]),
      ),
    );
    await runner.start("att_1");
    await drain(runner);
    await runner.collect("att_1");
    expect(await runner.observe("att_1")).toEqual({
      status: "terminal",
      backendStatus: "succeeded",
    });
  });

  it("binds declared writes to the verify result value", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const spawn = vi.fn(async () => ({
      pid: 21,
      processGroupId: 21,
      child: { pid: 21 } as never,
      exit: Promise.resolve({ code: 0, signal: null }),
    }));
    const runner = createVerifyStageRunner({ spawn });
    const stage = {
      ...verifyStage(),
      writes: ["artifacts.verification"],
    };
    await runner.prepare({
      ...basePrepare(
        checkout,
        runtime,
        request([
          {
            schemaVersion: 1,
            checkId: "unit",
            argv: ["/bin/true"],
            expectedExitCode: 0,
            required: true,
          },
        ]),
      ),
      stage,
    });
    await runner.start("att_1");
    await drain(runner);
    await runner.collect("att_1");
    const validation = await runner.validate("att_1");
    expect(validation.valid).toBe(true);
    expect(validation.missingWrites).toEqual([]);
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.outcome).toBe("succeeded");
    expect(finalized.result.outputs.some((o) => o.reference === "artifacts.verification")).toBe(
      true,
    );
    expect(finalized.result.outputs.some((o) => o.reference === "verify.result")).toBe(false);
  });
});
