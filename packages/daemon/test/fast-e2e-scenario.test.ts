/**
 * Q030 deterministic fake-backend `fast` scenario.
 *
 * Covers (hermetic, no daemon socket):
 * 1. codebase onboard propose/apply with an injected analyzer
 * 2. bundled `fast.v1` load + tickScheduler with risk review selected
 * 3. agent build fails once on missing `non_empty_diff`, then repairs
 * 4. verify argv checks resolved from repository workspace policy
 * 5. publish through conformance fake forge
 * 6. export-shaped run summary with repair trace + publication result
 *
 * Does not spin the full daemon compose / pipeline-runner-service loop.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnalyzeRepository,
  applyCodebaseOnboarding,
  canonicalJson,
  createNodeFileSystem,
  createNodeHashPort,
  digestProposal,
  loadRepositoryPolicy,
  proposeCodebaseOnboarding,
  type RegisteredCodebase,
  type RepositoryOnboardingDraft,
  resolveVerifyChecksFromPolicy,
} from "@heniek/codebase";
import { createConformanceContext, createFakeForgeBackend, seed } from "@heniek/conformance";
import type {
  BackendArtifactV1,
  BackendExecutionHandleV1,
  ExecutionBackendV7,
  ExecutionResultV5,
  ExecutionStatus,
  ExecutionTelemetryV1,
  PublishRequestV1,
  RepositoryId,
} from "@heniek/contracts";
import {
  initialStageSnapshots,
  loadBundledPipeline,
  type PipelineGraph,
  tickScheduler,
} from "@heniek/pipeline";
import {
  createAgentStageRunner,
  createPublishStageRunner,
  createVerifyStageRunner,
  type PipelineGraphStage,
  type ResolvedProfile,
  type StageRunner,
  type StageRunnerPrepareInput,
} from "@heniek/runner";
import type { Static } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildClassifiedFailureObservation } from "../src/runtime/recovery-observation.js";

const roots: string[] = [];
const NOW = "2026-08-10T12:00:00.000Z";
const clock = { nowIso: () => NOW };
const hash = createNodeHashPort();
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "heniek-fast-e2e-"));
  roots.push(root);
  return root;
}

const unavailable = { availability: "unavailable" as const, reason: "not_reported" as const };

function emptyTelemetry(): Static<typeof ExecutionTelemetryV1> {
  return {
    schemaVersion: 1,
    engine: "claude",
    executionMode: "external",
    evidenceRefs: ["test:fast-e2e"],
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

function profile(id: string, roleId = "builder"): ResolvedProfile {
  return {
    schemaVersion: 2,
    profileId: id as ResolvedProfile["profileId"],
    workerId: "worker-1" as ResolvedProfile["workerId"],
    roleId: roleId as ResolvedProfile["roleId"],
    engine: "claude",
    model: "opus",
    effort: "high",
    executionMode: "external",
    questions: "parent-mediated",
    instructionsPath: `instructions/${id}.md`,
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

type Artifact = Static<typeof BackendArtifactV1>;
type Handle = Static<typeof BackendExecutionHandleV1>;
type Result = Static<typeof ExecutionResultV5>;

function artifact(
  name: string,
  body: string,
): {
  readonly artifact: Artifact;
  readonly bytes: Uint8Array;
} {
  const bytes = new TextEncoder().encode(body);
  const id = `art_${name}` as Artifact["id"];
  return {
    artifact: {
      schemaVersion: 1,
      id,
      path: `artifacts/${name}.md`,
      byteLength: bytes.byteLength,
      mediaType: "text/markdown",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    bytes,
  };
}

function scriptedBackend(options: {
  readonly statuses?: ExecutionStatus[];
  readonly result: Result | (() => Result);
  readonly artifacts: Artifact[];
  readonly bytesById: Record<string, Uint8Array>;
}): ExecutionBackendV7 & { readonly startCalls: number; readonly resumeCalls: number } {
  let startCalls = 0;
  let resumeCalls = 0;
  let statusIndex = 0;
  const statuses = options.statuses ?? ["succeeded"];
  return {
    get startCalls() {
      return startCalls;
    },
    get resumeCalls() {
      return resumeCalls;
    },
    async start() {
      startCalls += 1;
      return {
        schemaVersion: 1,
        executionId: `exec_${startCalls}` as Handle["executionId"],
      } satisfies Handle;
    },
    async status() {
      const status = statuses[Math.min(statusIndex, statuses.length - 1)];
      if (status === undefined) throw new Error("missing status");
      statusIndex += 1;
      return status;
    },
    async interactions() {
      return [];
    },
    async answer() {},
    async resume() {
      resumeCalls += 1;
    },
    async result() {
      return typeof options.result === "function" ? options.result() : options.result;
    },
    async cancel() {},
    async artifacts() {
      return options.artifacts;
    },
    async readArtifact(_executionId, artifactId) {
      return options.bytesById[artifactId] ?? new Uint8Array();
    },
    async *events() {},
  };
}

async function drain(runner: StageRunner, attemptId: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const observed = await runner.observe(attemptId);
    if (observed.status === "terminal" || observed.status === "timed_out") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`attempt ${attemptId} did not reach a terminal observe status`);
}

async function runAgentAttempt(input: {
  readonly attemptId: string;
  readonly stage: PipelineGraphStage;
  readonly checkoutPath: string;
  readonly runtimeDirectory: string;
  readonly backend: ExecutionBackendV7;
  readonly profileId: string;
  readonly roleId?: string;
  readonly retryDirective?: StageRunnerPrepareInput["retryDirective"];
  readonly priorBackendExecutionId?: string;
}): Promise<Awaited<ReturnType<StageRunner["finalize"]>>> {
  const runner = createAgentStageRunner({
    backend: input.backend,
    resolveProfile: async (id) => profile(id, input.roleId),
    resolvePermissions: async (p) => ({
      schemaVersion: 1,
      workspace: p.permissions.workspace,
      identifiers: [...p.permissions.identifiers],
    }),
    resolveAgentInvocation: async () => {
      const firstArtifact = input.stage.completion?.require.find((req) => req.kind === "artifact");
      const name =
        firstArtifact !== undefined && firstArtifact.kind === "artifact"
          ? firstArtifact.name
          : input.stage.id;
      return {
        prompt: `fast-e2e:${input.stage.id}`,
        artifactPath: `artifacts/${name}.md`,
        inputArtifactRefs: [],
      };
    },
    identifierReader: { read: async () => null },
    pollIntervalMs: 5,
    clock,
  });
  await runner.prepare({
    attemptId: input.attemptId,
    runId: "run_fast_e2e",
    stageId: input.stage.id,
    intentId: `intent_${input.attemptId}`,
    graphRevision: 1,
    generation: 1,
    attemptOrdinal: 1,
    stage: input.stage,
    checkoutPath: input.checkoutPath,
    runtimeDirectory: input.runtimeDirectory,
    workspaceId: "ws_fast_e2e",
    ...(input.retryDirective === undefined ? {} : { retryDirective: input.retryDirective }),
    ...(input.priorBackendExecutionId === undefined
      ? {}
      : { priorBackendExecutionId: input.priorBackendExecutionId }),
  });
  await runner.start(input.attemptId);
  await drain(runner, input.attemptId);
  await runner.collect(input.attemptId);
  await runner.validate(input.attemptId);
  return runner.finalize(input.attemptId);
}

function repository(
  repositoryId: string,
  path: string,
): RegisteredCodebase["repositories"][number] {
  return {
    repositoryId: repositoryId as RepositoryId,
    name: repositoryId,
    path,
    gitCommonDirectory: `${path}/.git`,
    remotes: [
      {
        name: "origin",
        fetchUrl: `https://example.com/${repositoryId}`,
        pushUrl: `https://example.com/${repositoryId}`,
        defaultBranch: "main",
      },
    ],
    defaultRemote: "origin",
    defaultBranch: "main",
  };
}

function registration(
  codebasesDirectory: string,
  codebaseId: string,
  repositories: RegisteredCodebase["repositories"],
): RegisteredCodebase {
  const withoutHash = {
    schemaVersion: 1 as const,
    codebaseId: codebaseId as RegisteredCodebase["codebaseId"],
    name: "fast-e2e-fixture",
    rootPath: codebasesDirectory,
    sourceRepositoryPath: null,
    topologySha256: "a".repeat(64),
    repositories,
    instructionSnapshot: {
      schemaVersion: 1 as const,
      snapshotSha256: "b".repeat(64),
      capturedAt: clock.nowIso(),
      readiness: "ready" as const,
      sources: [],
      diagnostics: [],
    },
    diagnostics: [],
    readiness: "ready" as const,
    registeredAt: clock.nowIso(),
  };
  return {
    ...withoutHash,
    configurationSha256: hash.sha256(canonicalJson(withoutHash)),
  };
}

async function writeRegistration(
  codebasesDirectory: string,
  value: RegisteredCodebase,
): Promise<void> {
  const directory = join(codebasesDirectory, value.codebaseId);
  await mkdir(directory, { recursive: true });
  // YAML 1.2 accepts JSON; avoid depending on `yaml` from the daemon package.
  await writeFile(join(directory, "codebase.yaml"), `${JSON.stringify(value, null, 2)}\n`);
}

function validDraft(repositoryId: string): RepositoryOnboardingDraft {
  return {
    files: { copy: [".env.example"] },
    scripts: {
      setup: "pnpm install --frozen-lockfile",
      verify: [
        {
          schemaVersion: 1,
          checkId: `${repositoryId}-check`,
          argv: ["pnpm", "check"],
          expectedExitCode: 0,
          required: true,
        },
      ],
    },
    rationale: `Detected pnpm workspace for ${repositoryId}.`,
    evidence: [
      {
        kind: "manifest",
        path: "package.json",
        detail: "packageManager pnpm",
      },
    ],
  };
}

function analyzerReturning(drafts: Record<string, RepositoryOnboardingDraft>): AnalyzeRepository {
  return async (input) => {
    const draft = drafts[input.repositoryId];
    if (draft === undefined) throw new Error(`missing draft for ${input.repositoryId}`);
    return draft;
  };
}

function succeedStage(
  base: Parameters<typeof tickScheduler>[0],
  stages: Parameters<typeof tickScheduler>[0]["stages"],
  scheduleRevision: number,
  stageId: string,
  attemptId: string,
  canonicalState: unknown,
  recoveryState?: Parameters<typeof tickScheduler>[0]["recoveryState"],
) {
  const afterStart = tickScheduler({
    ...base,
    scheduleRevision,
    stages,
    observations: [
      {
        schemaVersion: 2,
        observationId: `${stageId}-start-${scheduleRevision}`,
        kind: "attempt_started",
        stageId,
        attemptId,
        recordedAt: NOW,
      },
    ],
    canonicalState,
    ...(recoveryState === undefined ? {} : { recoveryState }),
  });
  return tickScheduler({
    ...base,
    scheduleRevision: scheduleRevision + 1,
    stages: afterStart.stagePatches,
    observations: [
      {
        schemaVersion: 2,
        observationId: `${stageId}-ok-${scheduleRevision}`,
        kind: "attempt_succeeded",
        stageId,
        attemptId,
        recordedAt: NOW,
      },
    ],
    canonicalState,
    ...(afterStart.recoveryState !== undefined
      ? { recoveryState: afterStart.recoveryState }
      : recoveryState === undefined
        ? {}
        : { recoveryState }),
  });
}

describe("Q030 fast e2e fake-backend scenario", () => {
  it("onboards, repairs build once, verifies from policy, and publishes", async () => {
    const root = await temporaryRoot();
    const codebasesDirectory = join(root, "codebases");
    const repoPath = join(root, "repo-fixture");
    const checkout = join(root, "checkout");
    const runtime = join(root, "runtime");
    await mkdir(repoPath, { recursive: true });
    await mkdir(checkout, { recursive: true });
    await mkdir(runtime, { recursive: true });

    const registered = registration(codebasesDirectory, "cb-fast", [
      repository("repo-fixture", repoPath),
    ]);
    await writeRegistration(codebasesDirectory, registered);

    let proposalCount = 0;
    const proposed = await proposeCodebaseOnboarding(
      {
        fs: createNodeFileSystem(),
        hash,
        clock,
        ids: {
          next: (prefix: "cb" | "repo" | "proposal") => {
            if (prefix === "proposal") {
              proposalCount += 1;
              return `proposal-${proposalCount}`;
            }
            return `${prefix}-x`;
          },
        },
        codebasesDirectory,
        analyzeRepository: analyzerReturning({
          "repo-fixture": validDraft("repo-fixture"),
        }),
      },
      { codebaseId: "cb-fast" },
    );
    expect(proposed.proposal.digest).toBe(digestProposal(hash, proposed.proposal));

    const applied = await applyCodebaseOnboarding(
      {
        fs: createNodeFileSystem(),
        hash,
        clock,
        codebasesDirectory,
      },
      {
        proposalId: proposed.proposal.proposalId,
        expectedSha256: proposed.proposal.digest,
      },
    );
    expect(applied.policies).toHaveLength(1);

    const policy = await loadRepositoryPolicy(
      { fs: createNodeFileSystem(), codebasesDirectory },
      "cb-fast",
      "repo-fixture",
    );
    expect(policy).toBeDefined();
    const verifyChecks = resolveVerifyChecksFromPolicy(policy!);
    expect(verifyChecks.map((check) => check.argv)).toEqual([["pnpm", "check"]]);

    const loaded = loadBundledPipeline("fast", 1);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const graph = loaded.graph as PipelineGraph;
    const stageById = Object.fromEntries(graph.stages.map((stage) => [stage.id, stage]));

    const base: Parameters<typeof tickScheduler>[0] = {
      schemaVersion: 2,
      runId: "run_fast_e2e",
      pipelineId: graph.pipelineId,
      graphRevision: 1,
      scheduleRevision: 1,
      now: NOW,
      graph,
      stages: initialStageSnapshots({
        runId: "run_fast_e2e",
        graphRevision: 1,
        graph,
        now: NOW,
      }),
      observations: [],
      evaluatorDecisions: [],
      pendingEvaluatorEdgeKeys: [],
      canonicalState: { risk: { requiresFreshReview: true } },
      effectiveLimits: { maxRepairAttempts: 2 },
      executionMode: "autonomous",
    };

    const first = tickScheduler(base);
    const deliberateAttempt = first.attempts.find((a) => a.stageId === "deliberate");
    expect(deliberateAttempt).toBeDefined();

    const understanding = artifact("understanding", "# understanding");
    const design = artifact("design", "# design");
    const plan = artifact("plan", "# plan");
    const deliberateFinal = await runAgentAttempt({
      attemptId: deliberateAttempt!.attemptId,
      stage: stageById.deliberate!,
      checkoutPath: checkout,
      runtimeDirectory: runtime,
      profileId: "task-owner",
      backend: scriptedBackend({
        artifacts: [understanding.artifact, design.artifact, plan.artifact],
        bytesById: {
          [understanding.artifact.id]: understanding.bytes,
          [design.artifact.id]: design.bytes,
          [plan.artifact.id]: plan.bytes,
        },
        result: {
          schemaVersion: 5,
          status: "succeeded",
          summary: "deliberated",
          artifacts: [understanding.artifact, design.artifact, plan.artifact],
          telemetry: emptyTelemetry(),
        },
      }),
    });
    expect(deliberateFinal.result.outcome).toBe("succeeded");

    const afterDeliberate = succeedStage(
      base,
      first.stagePatches,
      2,
      "deliberate",
      deliberateAttempt!.attemptId,
      {
        risk: { requiresFreshReview: true },
        artifacts: { understanding: true, design: true, plan: true },
      },
      first.recoveryState,
    );
    const buildAttempt1 = afterDeliberate.attempts.find((a) => a.stageId === "build");
    expect(buildAttempt1).toBeDefined();

    const implementationEmpty = artifact("implementation", "# empty");
    let buildResumeCalls = 0;
    const buildBackend = scriptedBackend({
      artifacts: [implementationEmpty.artifact],
      bytesById: { [implementationEmpty.artifact.id]: implementationEmpty.bytes },
      result: () => ({
        schemaVersion: 5 as const,
        status: "succeeded" as const,
        summary: buildResumeCalls > 0 ? "repaired implementation" : "no diff yet",
        artifacts: [implementationEmpty.artifact],
        telemetry: emptyTelemetry(),
        ...(buildResumeCalls > 0 ? { diff: { files: 1, additions: 3, deletions: 0 } } : {}),
      }),
    });
    const originalResume = buildBackend.resume.bind(buildBackend);
    buildBackend.resume = async (...args: Parameters<typeof originalResume>) => {
      buildResumeCalls += 1;
      return originalResume(...args);
    };

    const buildFailFinal = await runAgentAttempt({
      attemptId: buildAttempt1!.attemptId,
      stage: stageById.build!,
      checkoutPath: checkout,
      runtimeDirectory: runtime,
      profileId: "task-owner",
      backend: buildBackend,
    });
    expect(buildFailFinal.result.outcome).toBe("failed");
    expect(buildFailFinal.validation.valid).toBe(false);
    expect(buildFailFinal.validation.missingEvidence).toContain("non_empty_diff");
    expect(buildFailFinal.result.failure?.classification).toBe("validation_failed");
    expect(buildFailFinal.result.failure?.retryable).toBe(true);

    const classified = buildClassifiedFailureObservation({
      runnerFailure: buildFailFinal.result.failure!,
      validation: buildFailFinal.validation,
    });
    expect(classified.retryable).toBe(true);
    expect(classified.failure.validationFailures).toContain("missing_evidence:non_empty_diff");

    const afterBuildFail = tickScheduler({
      ...base,
      scheduleRevision: 4,
      stages: afterDeliberate.stagePatches,
      observations: [
        {
          schemaVersion: 2,
          observationId: "build-start-4",
          kind: "attempt_started",
          stageId: "build",
          attemptId: buildAttempt1!.attemptId,
          recordedAt: "2026-08-10T12:00:01.000Z",
        },
        {
          schemaVersion: 2,
          observationId: "build-fail-4",
          kind: "attempt_failed",
          stageId: "build",
          attemptId: buildAttempt1!.attemptId,
          retryable: classified.retryable,
          classification: classified.failure.classification,
          phase: classified.failure.phase,
          code: classified.failure.code,
          ...(classified.failure.validationFailures !== undefined
            ? { validationFailures: classified.failure.validationFailures }
            : {}),
          failure: classified.failure,
          signature: classified.signature,
          resumeAvailable: true,
          priorBackendExecutionId: "exec_1",
          recordedAt: "2026-08-10T12:00:02.000Z",
        },
      ],
      canonicalState: {
        risk: { requiresFreshReview: true },
        artifacts: { understanding: true, design: true, plan: true },
      },
      ...(afterDeliberate.recoveryState !== undefined
        ? { recoveryState: afterDeliberate.recoveryState }
        : {}),
    });
    expect(afterBuildFail.stagePatches.find((s) => s.stageId === "build")?.state).toBe("retrying");
    expect(afterBuildFail.recoveryDecisions?.[0]?.outcome).toBe("repair");

    const rearmed = tickScheduler({
      ...base,
      scheduleRevision: 5,
      stages: afterBuildFail.stagePatches,
      observations: [],
      canonicalState: {
        risk: { requiresFreshReview: true },
        artifacts: { understanding: true, design: true, plan: true },
      },
      ...(afterBuildFail.recoveryState !== undefined
        ? { recoveryState: afterBuildFail.recoveryState }
        : {}),
    });
    const buildAttempt2 = rearmed.attempts.find((a) => a.stageId === "build");
    expect(buildAttempt2).toBeDefined();
    expect(buildAttempt2!.attemptOrdinal).toBe(2);
    expect(buildAttempt2!.retryDirective?.mode).toBe("resume");
    expect(buildAttempt2!.retryDirective?.sessionPolicy).toBe("resume");

    const buildOkFinal = await runAgentAttempt({
      attemptId: buildAttempt2!.attemptId,
      stage: stageById.build!,
      checkoutPath: checkout,
      runtimeDirectory: runtime,
      profileId: "task-owner",
      backend: buildBackend,
      retryDirective: buildAttempt2!.retryDirective,
      priorBackendExecutionId: "exec_1",
    });
    expect(buildBackend.resumeCalls).toBe(1);
    expect(buildOkFinal.result.outcome).toBe("succeeded");
    expect(buildOkFinal.validation.missingEvidence).toEqual([]);

    const afterBuildOk = succeedStage(
      base,
      rearmed.stagePatches,
      6,
      "build",
      buildAttempt2!.attemptId,
      {
        risk: { requiresFreshReview: true },
        artifacts: {
          understanding: true,
          design: true,
          plan: true,
          implementation: true,
        },
      },
      rearmed.recoveryState,
    );
    expect(afterBuildOk.stagePatches.find((s) => s.stageId === "risk-review")?.state).toBe(
      "queued",
    );
    const riskAttempt = afterBuildOk.attempts.find((a) => a.stageId === "risk-review");
    expect(riskAttempt).toBeDefined();

    const riskReview = artifact("risk_review", "# risk ok");
    const riskFinal = await runAgentAttempt({
      attemptId: riskAttempt!.attemptId,
      stage: stageById["risk-review"]!,
      checkoutPath: checkout,
      runtimeDirectory: runtime,
      profileId: "reviewer",
      roleId: "code-reviewer",
      backend: scriptedBackend({
        artifacts: [riskReview.artifact],
        bytesById: { [riskReview.artifact.id]: riskReview.bytes },
        result: {
          schemaVersion: 5,
          status: "succeeded",
          summary: "risk reviewed",
          artifacts: [riskReview.artifact],
          telemetry: emptyTelemetry(),
        },
      }),
    });
    expect(riskFinal.result.outcome).toBe("succeeded");

    const afterRisk = succeedStage(
      base,
      afterBuildOk.stagePatches,
      8,
      "risk-review",
      riskAttempt!.attemptId,
      {
        risk: { requiresFreshReview: true },
        artifacts: {
          understanding: true,
          design: true,
          plan: true,
          implementation: true,
          risk_review: true,
        },
      },
      afterBuildOk.recoveryState,
    );
    expect(afterRisk.stagePatches.find((s) => s.stageId === "verify")?.state).toBe("queued");
    const verifyAttempt = afterRisk.attempts.find((a) => a.stageId === "verify");
    expect(verifyAttempt).toBeDefined();

    const spawn = vi.fn(async (input: { argv: readonly string[] }) => {
      expect(input.argv).toEqual(["pnpm", "check"]);
      return {
        pid: 42,
        processGroupId: 42,
        child: { pid: 42 } as never,
        exit: Promise.resolve({ code: 0, signal: null }),
      };
    });
    const verifyRunner = createVerifyStageRunner({ spawn, clock });
    await verifyRunner.prepare({
      attemptId: verifyAttempt!.attemptId,
      runId: "run_fast_e2e",
      stageId: "verify",
      intentId: `intent_${verifyAttempt!.attemptId}`,
      graphRevision: 1,
      generation: 1,
      attemptOrdinal: 1,
      stage: stageById.verify!,
      checkoutPath: checkout,
      runtimeDirectory: runtime,
      verifyRequest: { schemaVersion: 1, checks: verifyChecks },
    });
    await verifyRunner.start(verifyAttempt!.attemptId);
    await drain(verifyRunner, verifyAttempt!.attemptId);
    await verifyRunner.collect(verifyAttempt!.attemptId);
    const verifyValidation = await verifyRunner.validate(verifyAttempt!.attemptId);
    expect(verifyValidation.valid).toBe(true);
    const verifyFinal = await verifyRunner.finalize(verifyAttempt!.attemptId);
    expect(verifyFinal.result.outcome).toBe("succeeded");
    expect(
      verifyFinal.result.outputs.some((output) => output.reference === "artifacts.verification"),
    ).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();

    const afterVerify = succeedStage(
      base,
      afterRisk.stagePatches,
      10,
      "verify",
      verifyAttempt!.attemptId,
      {
        risk: { requiresFreshReview: true },
        artifacts: {
          understanding: true,
          design: true,
          plan: true,
          implementation: true,
          risk_review: true,
          verification: true,
        },
      },
      afterRisk.recoveryState,
    );
    expect(afterVerify.stagePatches.find((s) => s.stageId === "publish")?.state).toBe("queued");
    const publishAttempt = afterVerify.attempts.find((a) => a.stageId === "publish");
    expect(publishAttempt).toBeDefined();

    const forgeContext = createConformanceContext(seed(0xfa57e2e1));
    const fakeForge = createFakeForgeBackend(forgeContext);
    const publishRequest: PublishRequestV1 = {
      schemaVersion: 1,
      publicationKey: "pub_fast_e2e",
      pullRequest: {
        schemaVersion: 1,
        repositoryId: "repo-fixture" as RepositoryId,
        sourceBranch: "feature/fast-e2e",
        targetBranch: "main",
        title: "Fast e2e",
        body: "Q030 scenario",
        expectedHeadSha: HEAD,
        draft: true,
        markReady: false,
        enableAutoMerge: false,
      },
    };
    const publishRunner = createPublishStageRunner({ forge: fakeForge.backend, clock });
    await publishRunner.prepare({
      attemptId: publishAttempt!.attemptId,
      runId: "run_fast_e2e",
      stageId: "publish",
      intentId: `intent_${publishAttempt!.attemptId}`,
      graphRevision: 1,
      generation: 1,
      attemptOrdinal: 1,
      stage: stageById.publish!,
      runtimeDirectory: runtime,
      publishRequest,
    });
    await publishRunner.start(publishAttempt!.attemptId);
    await drain(publishRunner, publishAttempt!.attemptId);
    await publishRunner.collect(publishAttempt!.attemptId);
    const publishValidation = await publishRunner.validate(publishAttempt!.attemptId);
    expect(publishValidation.valid).toBe(true);
    const publishFinal = await publishRunner.finalize(publishAttempt!.attemptId);
    expect(publishFinal.result.outcome).toBe("succeeded");
    expect(
      publishFinal.result.outputs.some((output) => output.reference === "artifacts.publication"),
    ).toBe(true);

    const afterPublish = succeedStage(
      base,
      afterVerify.stagePatches,
      12,
      "publish",
      publishAttempt!.attemptId,
      {
        risk: { requiresFreshReview: true },
        artifacts: {
          understanding: true,
          design: true,
          plan: true,
          implementation: true,
          risk_review: true,
          verification: true,
          publication: true,
        },
      },
      afterVerify.recoveryState,
    );
    expect(afterPublish.stagePatches.find((s) => s.stageId === "publish")?.state).toBe("succeeded");

    const publication = publishFinal.result.outputs.find(
      (output) => output.reference === "artifacts.publication",
    )?.value;

    const exportSummary = {
      schemaVersion: 1,
      runId: "run_fast_e2e",
      pipeline: {
        id: "fast",
        version: 1,
        sourceSha256: loaded.entry.sourceSha256,
        normalizedGraphSha256: loaded.normalizedGraphSha256,
      },
      onboarding: {
        proposalId: proposed.proposal.proposalId,
        digest: proposed.proposal.digest,
        appliedPolicies: applied.policies.map((entry) => entry.repositoryId),
        verifyArgv: verifyChecks.map((check) => check.argv),
      },
      risk: { requiresFreshReview: true },
      stageTrace: [
        { stageId: "deliberate", outcome: "succeeded", attemptOrdinal: 1 },
        {
          stageId: "build",
          outcome: "failed",
          attemptOrdinal: 1,
          missingEvidence: buildFailFinal.validation.missingEvidence,
          recovery: afterBuildFail.recoveryDecisions?.[0],
        },
        {
          stageId: "build",
          outcome: "succeeded",
          attemptOrdinal: 2,
          retryDirective: buildAttempt2!.retryDirective,
        },
        { stageId: "risk-review", outcome: "succeeded", attemptOrdinal: 1 },
        { stageId: "verify", outcome: "succeeded", attemptOrdinal: 1 },
        { stageId: "publish", outcome: "succeeded", attemptOrdinal: 1 },
      ],
      publication,
    };

    expect(exportSummary.stageTrace).toHaveLength(6);
    expect(exportSummary.stageTrace[1]?.recovery?.outcome).toBe("repair");
    expect(exportSummary.publication).toMatchObject({
      schemaVersion: 1,
      publicationKey: "pub_fast_e2e",
      outcome: "created",
    });
    // Stable shape for ADR evidence capture.
    expect(Object.keys(exportSummary).sort()).toEqual([
      "onboarding",
      "pipeline",
      "publication",
      "risk",
      "runId",
      "schemaVersion",
      "stageTrace",
    ]);
  });
});
