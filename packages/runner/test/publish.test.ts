import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CheckFailureV1,
  CheckStatusV1,
  CreatePullRequestInputV1,
  ForgeBackendV2,
  PublishRequestV1,
  PullRequestId,
  PullRequestV1,
  RepositoryId,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublishStageRunner } from "../src/index.js";
import type { PipelineGraphStage, StageRunnerPrepareInput } from "../src/types.js";

const roots: string[] = [];
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heniek-runner-publish-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function publishStage(): PipelineGraphStage {
  return {
    id: "publish" as PipelineGraphStage["id"],
    type: "publish",
    mode: "autonomous",
    optional: false,
    reads: [],
    writes: [],
    overridable: [],
  };
}

function pr(overrides: Partial<Static<typeof PullRequestV1>> = {}): Static<typeof PullRequestV1> {
  return {
    schemaVersion: 1,
    pullRequestId: "pr_1" as PullRequestId,
    repositoryId: "repo_test" as RepositoryId,
    number: 1,
    url: "https://example.test/pr/1",
    state: "open",
    draft: true,
    headSha: HEAD,
    ...overrides,
  };
}

function request(overrides: Partial<PublishRequestV1["pullRequest"]> = {}): PublishRequestV1 {
  return {
    schemaVersion: 1,
    publicationKey: "pub_feature_main",
    pullRequest: {
      schemaVersion: 1,
      repositoryId: "repo_test" as RepositoryId,
      sourceBranch: "feature",
      targetBranch: "main",
      title: "Ship feature",
      body: "details",
      expectedHeadSha: HEAD,
      draft: true,
      markReady: false,
      enableAutoMerge: false,
      ...overrides,
    },
  };
}

function basePrepare(
  runtimeDirectory: string,
  publishRequest: PublishRequestV1,
): StageRunnerPrepareInput {
  const stage = publishStage();
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
    publishRequest,
  };
}

function fakeForge(overrides: Partial<ForgeBackendV2> = {}): ForgeBackendV2 {
  return {
    findPullRequests: vi.fn(async () => []),
    createPullRequest: vi.fn(async (input: Static<typeof CreatePullRequestInputV1>) =>
      pr({ draft: input.draft, headSha: HEAD }),
    ),
    markReady: vi.fn(async () => undefined),
    enableAutoMerge: vi.fn(async () => undefined),
    getChecks: vi.fn(async () => [] as Static<typeof CheckStatusV1>[]),
    getFailedCheckLogs: vi.fn(async () => [] as Static<typeof CheckFailureV1>[]),
    ...overrides,
  };
}

async function drain(runner: ReturnType<typeof createPublishStageRunner>): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const observed = await runner.observe("att_1");
    if (observed.status === "terminal" || observed.status === "timed_out") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("publish did not reach a terminal observe status");
}

describe("publish stage runner", () => {
  it("creates a pull request when none exist", async () => {
    const runtime = await tempRoot();
    const forge = fakeForge();
    const runner = createPublishStageRunner({ forge });
    await runner.prepare(basePrepare(runtime, request()));
    await runner.start("att_1");
    await drain(runner);
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.outcome).toBe("succeeded");
    expect(forge.createPullRequest).toHaveBeenCalledOnce();
    expect(forge.markReady).not.toHaveBeenCalled();
  });

  it("adopts a unique matching PR after restart-style discovery", async () => {
    const runtime = await tempRoot();
    const forge = fakeForge({
      findPullRequests: vi.fn(async () => [pr()]),
    });
    const runner = createPublishStageRunner({ forge });
    await runner.prepare(basePrepare(runtime, request()));
    await runner.start("att_1");
    await drain(runner);
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.outcome).toBe("succeeded");
    expect(forge.createPullRequest).not.toHaveBeenCalled();
    const payload = finalized.result.outputs.find((o) => o.reference === "publish.result")
      ?.value as {
      outcome: string;
    };
    expect(payload.outcome).toBe("adopted");
  });

  it("requires reconciliation on mismatched head", async () => {
    const runtime = await tempRoot();
    const forge = fakeForge({
      findPullRequests: vi.fn(async () => [pr({ headSha: OTHER })]),
    });
    const runner = createPublishStageRunner({ forge });
    await runner.prepare(basePrepare(runtime, request()));
    await runner.start("att_1");
    await drain(runner);
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.outcome).toBe("recovery_required");
    expect(finalized.result.failure?.classification).toBe("reconciliation_required");
    expect(forge.createPullRequest).not.toHaveBeenCalled();
  });

  it("requires reconciliation when multiple PRs match", async () => {
    const runtime = await tempRoot();
    const forge = fakeForge({
      findPullRequests: vi.fn(async () => [
        pr({ pullRequestId: "pr_1" as PullRequestId, number: 1 }),
        pr({ pullRequestId: "pr_2" as PullRequestId, number: 2 }),
      ]),
    });
    const runner = createPublishStageRunner({ forge });
    await runner.prepare(basePrepare(runtime, request()));
    await runner.start("att_1");
    await drain(runner);
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.failure?.classification).toBe("reconciliation_required");
  });

  it("marks ready and enables auto-merge when requested", async () => {
    const runtime = await tempRoot();
    const forge = fakeForge();
    const runner = createPublishStageRunner({ forge });
    await runner.prepare(
      basePrepare(runtime, request({ markReady: true, enableAutoMerge: true, draft: true })),
    );
    await runner.start("att_1");
    await drain(runner);
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.outcome).toBe("succeeded");
    expect(forge.markReady).toHaveBeenCalledOnce();
    expect(forge.enableAutoMerge).toHaveBeenCalledOnce();
  });

  it("classifies forge failures", async () => {
    const runtime = await tempRoot();
    const forge = fakeForge({
      createPullRequest: vi.fn(async () => {
        throw new Error("forge unavailable");
      }),
    });
    const runner = createPublishStageRunner({ forge });
    await runner.prepare(basePrepare(runtime, request()));
    await runner.start("att_1");
    await drain(runner);
    await runner.collect("att_1");
    await runner.validate("att_1");
    const finalized = await runner.finalize("att_1");
    expect(finalized.result.failure?.classification).toBe("forge_failed");
  });

  it("binds declared writes to the publish result value", async () => {
    const runtime = await tempRoot();
    const forge = fakeForge();
    const runner = createPublishStageRunner({ forge });
    const stage = {
      ...publishStage(),
      writes: ["artifacts.publication"],
    };
    await runner.prepare({
      ...basePrepare(runtime, request()),
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
    expect(finalized.result.outputs.some((o) => o.reference === "artifacts.publication")).toBe(
      true,
    );
    expect(finalized.result.outputs.some((o) => o.reference === "publish.result")).toBe(false);
  });
});
