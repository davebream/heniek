import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntegrationRequestV1, IntegrationResultV1, RepositoryId } from "@heniek/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIntegrationStageRunner, type GitIntegrationAdapter } from "../src/index.js";
import type { PipelineGraphStage, StageRunnerPrepareInput } from "../src/types.js";

const roots: string[] = [];
const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_C = "cccccccccccccccccccccccccccccccccccccccc";
const SHA_D = "dddddddddddddddddddddddddddddddddddddddd";

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heniek-runner-integration-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function integrationStage(): PipelineGraphStage {
  return {
    id: "integrate" as PipelineGraphStage["id"],
    type: "integration",
    mode: "autonomous",
    optional: false,
    reads: [],
    writes: [],
    overridable: [],
  };
}

function request(overrides: Partial<IntegrationRequestV1> = {}): IntegrationRequestV1 {
  return {
    schemaVersion: 1,
    repositoryId: "repo_test" as RepositoryId,
    sourceRef: "refs/heads/feature",
    targetRef: "refs/heads/main",
    expectedSourceSha: SHA_A,
    expectedTargetSha: SHA_B,
    ...overrides,
  };
}

function basePrepare(
  checkoutPath: string,
  runtimeDirectory: string,
  integrationRequest: IntegrationRequestV1,
): StageRunnerPrepareInput {
  const stage = integrationStage();
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
    integrationRequest,
  };
}

async function drain(runner: ReturnType<typeof createIntegrationStageRunner>): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const observed = await runner.observe("att_1");
    if (observed.status === "terminal" || observed.status === "timed_out") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("integration did not reach a terminal observe status");
}

function fakeGit(overrides: Partial<GitIntegrationAdapter> = {}): GitIntegrationAdapter {
  return {
    readRefSha: vi.fn(async (_checkout, ref) => {
      if (ref.includes("feature")) return SHA_A;
      return SHA_B;
    }),
    prepareMergeCandidate: vi.fn(async () => ({
      status: "prepared" as const,
      candidateSha: SHA_C,
    })),
    updateRefCompareAndSwap: vi.fn(async () => ({ status: "updated" as const })),
    ...overrides,
  };
}

describe("integration stage runner", () => {
  it("updates the target ref on a clean merge", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const git = fakeGit();
    const runner = createIntegrationStageRunner({ git });
    await runner.prepare(basePrepare(checkout, runtime, request()));
    await runner.start("att_1");
    await drain(runner);
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.outcome).toBe("succeeded");
    expect(git.updateRefCompareAndSwap).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: "refs/heads/main",
        expectedSha: SHA_B,
        newSha: SHA_C,
      }),
    );
    const payload = finalized.result.outputs.find((o) => o.reference === "integration.result")
      ?.value as IntegrationResultV1;
    expect(payload.classification).toBe("none");
    expect(payload.targetMoved).toBe(true);
    expect(payload.resultSha).toBe(SHA_C);
  });

  it("classifies stale source without moving the target", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const git = fakeGit({
      readRefSha: vi.fn(async (_c, ref) => (ref.includes("feature") ? SHA_D : SHA_B)),
    });
    const runner = createIntegrationStageRunner({ git });
    await runner.prepare(basePrepare(checkout, runtime, request()));
    await runner.start("att_1");
    await drain(runner);
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.outcome).toBe("failed");
    expect(finalized.result.failure?.classification).toBe("stale_sha");
    expect(git.prepareMergeCandidate).not.toHaveBeenCalled();
    expect(git.updateRefCompareAndSwap).not.toHaveBeenCalled();
  });

  it("classifies merge conflict without moving the target", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const git = fakeGit({
      prepareMergeCandidate: vi.fn(async () => ({
        status: "conflict" as const,
        detail: "CONFLICT (content): merge conflict in README",
      })),
    });
    const runner = createIntegrationStageRunner({ git });
    await runner.prepare(basePrepare(checkout, runtime, request()));
    await runner.start("att_1");
    await drain(runner);
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.failure?.classification).toBe("merge_conflict");
    expect(git.updateRefCompareAndSwap).not.toHaveBeenCalled();
    const payload = finalized.result.outputs.find((o) => o.reference === "integration.result")
      ?.value as IntegrationResultV1;
    expect(payload.targetMoved).toBe(false);
  });

  it("succeeds on already_applied without update-ref", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const git = fakeGit({
      prepareMergeCandidate: vi.fn(async () => ({
        status: "already_applied" as const,
        candidateSha: SHA_B,
      })),
    });
    const runner = createIntegrationStageRunner({ git });
    await runner.prepare(basePrepare(checkout, runtime, request()));
    await runner.start("att_1");
    await drain(runner);
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.outcome).toBe("succeeded");
    expect(git.updateRefCompareAndSwap).not.toHaveBeenCalled();
    const payload = finalized.result.outputs.find((o) => o.reference === "integration.result")
      ?.value as IntegrationResultV1;
    expect(payload.classification).toBe("already_applied");
    expect(payload.targetMoved).toBe(false);
  });

  it("does not claim success when update-ref CAS is stale", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const git = fakeGit({
      updateRefCompareAndSwap: vi.fn(async () => ({
        status: "stale" as const,
        actualSha: SHA_D,
      })),
    });
    const runner = createIntegrationStageRunner({ git });
    await runner.prepare(basePrepare(checkout, runtime, request()));
    await runner.start("att_1");
    await drain(runner);
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.outcome).toBe("failed");
    expect(finalized.result.failure?.classification).toBe("stale_sha");
    const payload = finalized.result.outputs.find((o) => o.reference === "integration.result")
      ?.value as IntegrationResultV1;
    expect(payload.targetMoved).toBe(false);
  });
});
