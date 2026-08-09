import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BackendArtifactV1,
  BackendExecutionHandleV1,
  ExecutionBackendV7,
  ExecutionResultV5,
  ExecutionStatus,
  ExecutionTelemetryV1,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asBackendExecutionId, asProfileId, asRoleId, asWorkerId } from "../src/brands.js";
import { createAgentStageRunner } from "../src/index.js";
import type { PipelineGraphStage, ResolvedProfile, StageRunnerPrepareInput } from "../src/types.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heniek-runner-agent-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const unavailable = { availability: "unavailable" as const, reason: "not_reported" as const };

function emptyTelemetry(): Static<typeof ExecutionTelemetryV1> {
  return {
    schemaVersion: 1,
    engine: "claude",
    executionMode: "external",
    evidenceRefs: ["test:agent-runner"],
    session: { providerSessionId: unavailable },
    usage: {
      inputUnits: unavailable,
      outputUnits: unavailable,
      cachedInputUnits: unavailable,
      cacheReadUnits: unavailable,
      cacheWriteUnits: unavailable,
      totalUnits: unavailable,
      costUsd: unavailable,
    },
    timing: {
      wallDurationMs: unavailable,
      apiDurationMs: unavailable,
    },
    context: {
      usedUnits: unavailable,
      windowUnits: unavailable,
      utilization: unavailable,
      pressure: { state: "unavailable", reason: "not_reported" },
    },
  };
}

function profile(id = "builder"): ResolvedProfile {
  return {
    schemaVersion: 2,
    profileId: asProfileId(id),
    workerId: asWorkerId("worker-1"),
    roleId: asRoleId("builder"),
    engine: "claude",
    model: "opus",
    effort: "high",
    executionMode: "external",
    questions: "parent-mediated",
    instructionsPath: "instructions/builder.md",
    artifactContract: "heniek://contract/ExternalStageResult/v1",
    provenance: [],
    fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    fallbackProfileIds: [],
    onCapacity: "queue",
    permissions: {
      workspace: "read-write",
      identifiers: [],
    },
    maxDurationMs: 60_000,
  };
}

function agentStage(overrides: Partial<PipelineGraphStage> = {}): PipelineGraphStage {
  return {
    id: "design" as PipelineGraphStage["id"],
    type: "agent",
    mode: "autonomous",
    optional: false,
    profile: asProfileId("builder"),
    reads: [],
    writes: ["artifacts.design"],
    overridable: [],
    completion: { require: [{ kind: "result_envelope" }, { kind: "artifact", name: "design" }] },
    ...overrides,
  };
}

function prepareInput(
  checkoutPath: string,
  runtimeDirectory: string,
  stage: PipelineGraphStage,
): StageRunnerPrepareInput {
  return {
    attemptId: "att_agent_1",
    runId: "run_agent_1",
    stageId: stage.id,
    intentId: "intent_agent_1",
    graphRevision: 1,
    generation: 1,
    attemptOrdinal: 1,
    stage,
    checkoutPath,
    runtimeDirectory,
    workspaceId: "ws_1",
  };
}

type Artifact = Static<typeof BackendArtifactV1>;
type Handle = Static<typeof BackendExecutionHandleV1>;
type Result = Static<typeof ExecutionResultV5>;

function scriptedBackend(options: {
  readonly statuses?: ExecutionStatus[];
  readonly result?: Result;
  readonly artifacts?: Artifact[];
  readonly bytesById?: Record<string, Uint8Array>;
  readonly cancelStatuses?: ExecutionStatus[];
  readonly knownExecutionIds?: ReadonlySet<string>;
  readonly statusError?: Error;
}): ExecutionBackendV7 & {
  readonly startCalls: number;
  readonly cancelCalls: number;
  readonly resumeCalls: number;
  readonly lastResume?:
    | {
        readonly executionId: string;
        readonly operationId: string;
        readonly inputArtifactRefs: readonly string[];
      }
    | undefined;
} {
  let startCalls = 0;
  let cancelCalls = 0;
  let resumeCalls = 0;
  let lastResume:
    | {
        readonly executionId: string;
        readonly operationId: string;
        readonly inputArtifactRefs: readonly string[];
      }
    | undefined;
  let statusIndex = 0;
  let afterCancel = false;
  let cancelStatusIndex = 0;
  const statuses = options.statuses ?? ["succeeded"];
  const cancelStatuses = options.cancelStatuses ?? ["cancelled"];
  const artifacts = options.artifacts ?? [];
  const bytesById = options.bytesById ?? {};
  const knownExecutionIds = options.knownExecutionIds;
  const result =
    options.result ??
    ({
      schemaVersion: 5,
      status: "succeeded",
      summary: "done",
      artifacts,
      telemetry: emptyTelemetry(),
    } satisfies Result);

  return {
    get startCalls() {
      return startCalls;
    },
    get cancelCalls() {
      return cancelCalls;
    },
    get resumeCalls() {
      return resumeCalls;
    },
    get lastResume() {
      return lastResume;
    },
    async start() {
      startCalls += 1;
      return {
        schemaVersion: 1,
        executionId: asBackendExecutionId("exec_1"),
      } satisfies Handle;
    },
    async status(executionId) {
      if (options.statusError !== undefined) {
        throw options.statusError;
      }
      if (knownExecutionIds !== undefined && !knownExecutionIds.has(executionId)) {
        throw new Error(`unknown execution ${executionId}`);
      }
      if (afterCancel) {
        const status = cancelStatuses[Math.min(cancelStatusIndex, cancelStatuses.length - 1)];
        if (status === undefined) {
          throw new Error("missing cancel status");
        }
        cancelStatusIndex += 1;
        return status;
      }
      const status = statuses[Math.min(statusIndex, statuses.length - 1)];
      if (status === undefined) {
        throw new Error("missing status");
      }
      statusIndex += 1;
      return status;
    },
    async interactions() {
      return [];
    },
    async answer() {},
    async resume(request) {
      resumeCalls += 1;
      lastResume = {
        executionId: request.executionId,
        operationId: request.operationId,
        inputArtifactRefs: [...request.inputArtifactRefs],
      };
    },
    async result() {
      return result;
    },
    async cancel() {
      cancelCalls += 1;
      afterCancel = true;
    },
    async artifacts() {
      return artifacts;
    },
    async readArtifact(_executionId, artifactId) {
      return bytesById[artifactId] ?? new Uint8Array();
    },
    async *events() {},
  };
}

describe("createAgentStageRunner", () => {
  it("resolves one profile and calls backend.start once", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const resolveProfile = vi.fn(async (id: string) => profile(id));
    const backend = scriptedBackend({});
    const runner = createAgentStageRunner({
      backend,
      resolveProfile,
      resolvePermissions: async (p) => ({
        schemaVersion: 1,
        workspace: p.permissions.workspace,
        identifiers: [...p.permissions.identifiers],
      }),
      resolveAgentInvocation: async () => ({
        prompt: "design the thing",
        artifactPath: "artifacts/design.md",
        inputArtifactRefs: [],
      }),
      identifierReader: { read: async () => null },
      pollIntervalMs: 5,
      cancelObserveTimeoutMs: 200,
    });

    const prepared = await runner.prepare(prepareInput(checkout, runtime, agentStage()));
    expect(resolveProfile).toHaveBeenCalledWith("builder");
    expect(prepared.executionRequest?.profile.profileId).toBe("builder");
    expect(prepared.executionRequest?.schemaVersion).toBe(4);

    await runner.start("att_agent_1");
    expect(backend.startCalls).toBe(1);
    await expect(runner.start("att_agent_1")).rejects.toThrow(/exactly once/);
  });

  it("fails validate on a malformed result envelope", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const backend = scriptedBackend({
      result: {
        schemaVersion: 5,
        status: "succeeded",
        summary: "",
        artifacts: [],
        telemetry: emptyTelemetry(),
      },
    });
    const runner = createAgentStageRunner({
      backend,
      resolveProfile: async (id) => profile(id),
      resolvePermissions: async (p) => ({
        schemaVersion: 1,
        workspace: p.permissions.workspace,
        identifiers: [...p.permissions.identifiers],
      }),
      resolveAgentInvocation: async () => ({
        prompt: "x",
        artifactPath: "artifacts/design.md",
        inputArtifactRefs: [],
      }),
      identifierReader: { read: async () => null },
    });
    await runner.prepare(prepareInput(checkout, runtime, agentStage()));
    await runner.start("att_agent_1");
    await runner.observe("att_agent_1");
    await runner.collect("att_agent_1");
    const report = await runner.validate("att_agent_1");
    expect(report.valid).toBe(false);
    expect(report.envelopeValid).toBe(false);
  });

  it("cancels through the backend and observes until terminal", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const backend = scriptedBackend({
      statuses: ["running", "running"],
      cancelStatuses: ["running", "cancelled"],
    });
    const runner = createAgentStageRunner({
      backend,
      resolveProfile: async (id) => profile(id),
      resolvePermissions: async (p) => ({
        schemaVersion: 1,
        workspace: p.permissions.workspace,
        identifiers: [...p.permissions.identifiers],
      }),
      resolveAgentInvocation: async () => ({
        prompt: "x",
        artifactPath: "artifacts/design.md",
        inputArtifactRefs: [],
      }),
      identifierReader: { read: async () => null },
      pollIntervalMs: 5,
      cancelObserveTimeoutMs: 500,
    });
    await runner.prepare(prepareInput(checkout, runtime, agentStage()));
    await runner.start("att_agent_1");
    const cleanup = await runner.cancel("att_agent_1");
    expect(backend.cancelCalls).toBe(1);
    expect(cleanup.signalSequence).toEqual(["backend_cancel"]);
    expect(cleanup.cleaned).toBe(true);
  });

  it("fails validation on artifact digest mismatch", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const bytes = new TextEncoder().encode("hello artifact");
    const actual = createHash("sha256").update(bytes).digest("hex");
    const wrong = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(actual).not.toBe(wrong);

    const artifact: Artifact = {
      schemaVersion: 1,
      id: "art_1" as Artifact["id"],
      path: "artifacts/design.md",
      byteLength: bytes.byteLength,
      mediaType: "text/markdown",
      sha256: wrong,
    };
    const backend = scriptedBackend({
      artifacts: [artifact],
      bytesById: { art_1: bytes },
      result: {
        schemaVersion: 5,
        status: "succeeded",
        summary: "designed",
        artifacts: [artifact],
        telemetry: emptyTelemetry(),
      },
    });
    const runner = createAgentStageRunner({
      backend,
      resolveProfile: async (id) => profile(id),
      resolvePermissions: async (p) => ({
        schemaVersion: 1,
        workspace: p.permissions.workspace,
        identifiers: [...p.permissions.identifiers],
      }),
      resolveAgentInvocation: async () => ({
        prompt: "x",
        artifactPath: "artifacts/design.md",
        inputArtifactRefs: [],
      }),
      identifierReader: { read: async () => null },
    });
    await runner.prepare(prepareInput(checkout, runtime, agentStage()));
    await runner.start("att_agent_1");
    await runner.observe("att_agent_1");
    await runner.collect("att_agent_1");
    const report = await runner.validate("att_agent_1");
    expect(report.valid).toBe(false);
    expect(report.detail).toMatch(/digest mismatch/i);
    const finalized = await runner.finalize("att_agent_1");
    expect(finalized.result.outcome).toBe("failed");
  });

  it("resumes a prior backend execution instead of calling start", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const backend = scriptedBackend({
      knownExecutionIds: new Set(["exec_prior"]),
      statuses: ["succeeded"],
    });
    const runner = createAgentStageRunner({
      backend,
      resolveProfile: async (id) => profile(id),
      resolvePermissions: async (p) => ({
        schemaVersion: 1,
        workspace: p.permissions.workspace,
        identifiers: [...p.permissions.identifiers],
      }),
      resolveAgentInvocation: async () => ({
        prompt: "continue",
        artifactPath: "artifacts/design.md",
        inputArtifactRefs: [],
      }),
      identifierReader: { read: async () => null },
    });

    const input = {
      ...prepareInput(checkout, runtime, agentStage()),
      retryDirective: {
        mode: "resume" as const,
        sessionPolicy: "resume" as const,
        priorBackendExecutionId: "exec_prior",
        priorAttemptId: "att_prior",
      },
    };
    await runner.prepare(input);
    await runner.start("att_agent_1");
    expect(backend.startCalls).toBe(0);
    expect(backend.resumeCalls).toBe(1);
    expect(backend.lastResume).toEqual({
      executionId: "exec_prior",
      operationId: "resume:att_agent_1",
      inputArtifactRefs: [],
    });

    const observation = await runner.observe("att_agent_1");
    expect(observation).toEqual({ status: "terminal", backendStatus: "succeeded" });
  });

  it("does not silent-fresh when resume prior is missing", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const backend = scriptedBackend({
      knownExecutionIds: new Set(["exec_other"]),
    });
    const runner = createAgentStageRunner({
      backend,
      resolveProfile: async (id) => profile(id),
      resolvePermissions: async (p) => ({
        schemaVersion: 1,
        workspace: p.permissions.workspace,
        identifiers: [...p.permissions.identifiers],
      }),
      resolveAgentInvocation: async () => ({
        prompt: "continue",
        artifactPath: "artifacts/design.md",
        inputArtifactRefs: [],
      }),
      identifierReader: { read: async () => null },
    });

    await runner.prepare({
      ...prepareInput(checkout, runtime, agentStage()),
      retryDirective: {
        mode: "resume",
        sessionPolicy: "resume",
        priorBackendExecutionId: "exec_missing",
      },
    });
    await runner.start("att_agent_1");
    expect(backend.startCalls).toBe(0);
    expect(backend.resumeCalls).toBe(0);

    const observation = await runner.observe("att_agent_1");
    expect(observation).toEqual({ status: "terminal", backendStatus: "failed" });
    await runner.collect("att_agent_1");
    const finalized = await runner.finalize("att_agent_1");
    expect(finalized.result.outcome).toBe("failed");
    expect(finalized.result.failure?.code).toBe("resume_prior_missing");
    expect(finalized.result.failure?.retryable).toBe(false);
  });

  it("still calls start for fresh retry directives", async () => {
    const checkout = await tempRoot();
    const runtime = join(checkout, ".runtime");
    const backend = scriptedBackend({});
    const runner = createAgentStageRunner({
      backend,
      resolveProfile: async (id) => profile(id),
      resolvePermissions: async (p) => ({
        schemaVersion: 1,
        workspace: p.permissions.workspace,
        identifiers: [...p.permissions.identifiers],
      }),
      resolveAgentInvocation: async () => ({
        prompt: "retry fresh",
        artifactPath: "artifacts/design.md",
        inputArtifactRefs: [],
      }),
      identifierReader: { read: async () => null },
    });

    await runner.prepare({
      ...prepareInput(checkout, runtime, agentStage()),
      retryDirective: { mode: "fresh", sessionPolicy: "fresh" },
    });
    await runner.start("att_agent_1");
    expect(backend.startCalls).toBe(1);
    expect(backend.resumeCalls).toBe(0);
  });
});
