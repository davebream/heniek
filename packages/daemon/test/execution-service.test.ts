import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BackendArtifactId, ExecutionStatus } from "@heniek/contracts";
import { createClaudexorExecutionBackend } from "@heniek/execution-claudexor";
import {
  commitStateChange,
  executionCleanupCounts,
  openStateDatabase,
  readActiveStageExecutions,
  readArtifactRecord,
  readIdentity,
  readPendingExecutionOperations,
  readPendingInteractions,
  readRunProjection,
  readStageArtifacts,
  readStageExecution,
  runMigrations,
} from "@heniek/state";
import {
  createWorkspaceService,
  createWorkspaceStateStore,
  type OwnerLiveness,
} from "@heniek/workspace";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon as startClaudexorDaemon } from "../../conformance/src/smoke/claudexor/daemon-handle.js";
import {
  createExecutionService,
  type DurableExecutionBackend,
  ExecutionServiceCrashFault,
} from "../src/runtime/execution-service.js";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "heniek-q012-"));
  roots.push(root);
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  await mkdir(source);
  await git(root, "init", "--bare", remote);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Heniek Test");
  await git(source, "config", "user.email", "heniek@example.invalid");
  await writeFile(join(source, "README.md"), "fixture\n", "utf8");
  await git(source, "add", "README.md");
  await git(source, "commit", "-m", "fixture");
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "-u", "origin", "main");
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");

  let sequence = 0;
  const ids = { next: (prefix: string) => `${prefix}-${++sequence}` };
  const clock = { nowIso: () => "2026-08-06T10:00:00.000Z" };
  const databasePath = join(root, "state.sqlite");
  const open = () => {
    const db = openStateDatabase({ path: databasePath, clock, ids });
    runMigrations(db);
    return db;
  };
  const db = open();
  const hash = "a".repeat(64);
  commitStateChange(db, {
    type: "codebase.registration_committed",
    payload: {
      registration: {
        codebaseId: "codebase-q012",
        configurationSha256: hash,
        instructionSnapshot: {},
        name: "q012",
        repositories: [
          {
            defaultBranch: "main",
            defaultRemote: "origin",
            gitCommonDirectory: join(source, ".git"),
            name: "source",
            path: source,
            remotes: [],
            repositoryId: "repository-q012",
          },
        ],
        rootPath: source,
        topologySha256: hash,
      },
    },
  });
  const liveness: OwnerLiveness = {
    currentBootWitness: () => "boot-q012",
    witnessState: () => "dead",
  };
  const workspace = (database: typeof db) =>
    createWorkspaceService({
      state: createWorkspaceStateStore(database),
      workspacesDirectory: join(root, "workspaces"),
      logsDirectory: join(root, "logs"),
      clock,
      ids,
      liveness,
    });
  return { root, source, ids, open, db, workspace };
}

function fakeBackend() {
  const bytes = new TextEncoder().encode("# Completed report\n");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let status: ExecutionStatus = "waiting_on_user";
  let pending = true;
  let startCalls = 0;
  let answerCalls = 0;
  let answerEffects = 0;
  let resumeCalls = 0;
  let resumeEffects = 0;
  const resumeOperationIds: string[] = [];
  const appliedResumeOperations = new Set<string>();
  const seenHandles: string[] = [];
  const backend: DurableExecutionBackend = {
    async start() {
      startCalls += 1;
      return {
        schemaVersion: 1,
        executionId: (startCalls === 1 ? "thread-q012" : `thread-q012-${startCalls}`) as never,
      };
    },
    async status(executionId) {
      seenHandles.push(executionId);
      return status;
    },
    async interactions(executionId) {
      seenHandles.push(executionId);
      return pending
        ? [
            {
              schemaVersion: 2,
              id: "interaction-q012" as never,
              questions: [
                {
                  id: "question-q012" as never,
                  prompt: "Which title?",
                  options: [],
                  multiSelect: false,
                },
              ],
              requestedAt: "2026-08-06T10:00:00.000Z",
            },
          ]
        : [];
    },
    async answer(executionId, answer) {
      seenHandles.push(executionId);
      answerCalls += 1;
      expect(answer.interactionId).toBe("interaction-q012");
      if (pending) {
        answerEffects += 1;
        pending = false;
        status = "succeeded";
      }
    },
    async resume(request) {
      seenHandles.push(request.executionId);
      resumeCalls += 1;
      resumeOperationIds.push(request.operationId);
      if (!appliedResumeOperations.has(request.operationId)) {
        appliedResumeOperations.add(request.operationId);
        resumeEffects += 1;
        status = "running";
      }
    },
    async cancel(executionId) {
      seenHandles.push(executionId);
      status = "cancelled";
      pending = false;
    },
    async result(executionId) {
      seenHandles.push(executionId);
      if (status !== "succeeded" && status !== "cancelled" && status !== "failed") {
        throw new Error("not terminal");
      }
      return {
        schemaVersion: 2,
        status,
        summary: status === "succeeded" ? "Completed after one answer." : "Cancelled.",
        sessionId: "session-q012",
        artifacts:
          status === "succeeded"
            ? [
                {
                  schemaVersion: 1,
                  id: "backend-artifact-q012" as BackendArtifactId,
                  path: "artifacts/report.md",
                  byteLength: bytes.byteLength,
                  mediaType: "text/markdown",
                  sha256,
                },
              ]
            : [],
      };
    },
    async artifacts() {
      return [
        {
          schemaVersion: 1,
          id: "backend-artifact-q012" as BackendArtifactId,
          path: "artifacts/report.md",
          byteLength: bytes.byteLength,
          mediaType: "text/markdown",
          sha256,
        },
      ];
    },
    async readArtifact() {
      return bytes;
    },
  };
  return {
    backend,
    bytes,
    get startCalls() {
      return startCalls;
    },
    get resumeCalls() {
      return resumeCalls;
    },
    get answerCalls() {
      return answerCalls;
    },
    get answerEffects() {
      return answerEffects;
    },
    get resumeEffects() {
      return resumeEffects;
    },
    get resumeOperationIds() {
      return resumeOperationIds;
    },
    get seenHandles() {
      return seenHandles;
    },
    setStatus(next: ExecutionStatus) {
      status = next;
    },
  };
}

describe("Q012 durable execution service", () => {
  it("reconciles the same backend thread after daemon restart and finalizes one retrievable artifact", async () => {
    const setup = await fixture();
    const fake = fakeBackend();
    const first = createExecutionService({
      db: setup.db,
      backend: fake.backend,
      workspaceService: setup.workspace(setup.db),
      artifactsDirectory: join(setup.root, "artifacts"),
      instanceId: "daemon-first",
      ids: setup.ids,
      pollMilliseconds: 1_000_000,
    });
    const started = await first.start({
      currentDirectory: setup.source,
      prompt: "Create a report and ask which title to use.",
      artifactPath: "artifacts/report.md",
      limits: { maxTurns: 4, maxDurationMs: 60_000 },
    });
    expect(readStageExecution(setup.db, started.runId)).toMatchObject({
      backendExecutionId: "thread-q012",
      limits: { maxTurns: 4, maxDurationMs: 60_000 },
    });
    first.stop();
    setup.db.close();

    const restartedDb = setup.open();
    const restartedWorkspace = setup.workspace(restartedDb);
    const second = createExecutionService({
      db: restartedDb,
      backend: fake.backend,
      workspaceService: restartedWorkspace,
      artifactsDirectory: join(setup.root, "artifacts"),
      instanceId: "daemon-second",
      ids: setup.ids,
      pollMilliseconds: 1_000_000,
    });
    await second.observeAll();
    expect(fake.startCalls).toBe(1);
    expect(fake.seenHandles.every((handle) => handle === "thread-q012")).toBe(true);
    const answerResult = await second.answer(
      started.runId,
      {
        schemaVersion: 2,
        interactionId: "interaction-q012" as never,
        expectedInteractionRevision: 1,
        answers: [
          { questionId: "question-q012" as never, kind: "free_text", freeText: "Release notes" },
        ],
      },
      "test-key",
    );
    expect(answerResult).toMatchObject({ status: "succeeded", deliveryState: "delivered" });

    const execution = readStageExecution(restartedDb, started.runId);
    expect(execution).toMatchObject({
      status: "succeeded",
      finalized: true,
      summary: "Completed after one answer.",
      sessionId: "session-q012",
    });
    const artifacts = readStageArtifacts(restartedDb, started.runId);
    expect(artifacts).toHaveLength(1);
    const artifact = artifacts[0];
    expect(artifact).toMatchObject({
      name: "artifacts/report.md",
      byteLength: fake.bytes.byteLength,
    });
    const record = readArtifactRecord(restartedDb, artifact?.artifactId ?? "");
    expect(record).toEqual(artifact);
    expect(
      await readFile(join(setup.root, "artifacts", record?.relativePath ?? "missing")),
    ).toEqual(Buffer.from(fake.bytes));
    const workspace = readIdentity(restartedDb, "workspace", execution?.workspaceId ?? "");
    expect(restartedWorkspace.leases.current(workspace?.checkoutPath ?? "")?.state).toBe(
      "released",
    );

    await second.observeAll();
    expect(readStageArtifacts(restartedDb, started.runId)).toHaveLength(1);
    expect(fake.startCalls).toBe(1);
    second.stop();
    restartedDb.close();
  });

  it("continues and cancels on the persisted thread, then releases the workspace lease", async () => {
    const setup = await fixture();
    const fake = fakeBackend();
    const workspace = setup.workspace(setup.db);
    const service = createExecutionService({
      db: setup.db,
      backend: fake.backend,
      workspaceService: workspace,
      artifactsDirectory: join(setup.root, "artifacts"),
      instanceId: "daemon-cancel",
      ids: setup.ids,
      pollMilliseconds: 1_000_000,
    });
    const started = await service.start({
      currentDirectory: setup.source,
      prompt: "Create a report.",
      artifactPath: "artifacts/report.md",
    });
    fake.setStatus("recovery_required");
    await service.status(started.runId);
    await service.resume(
      started.runId,
      readRunProjection(setup.db, started.runId)?.revision ?? -1,
      [],
    );
    expect(fake.resumeCalls).toBe(1);
    await service.cancel(started.runId);
    expect(await service.result(started.runId)).toMatchObject({
      status: "cancelled",
      finalized: true,
    });
    const execution = readStageExecution(setup.db, started.runId);
    const identity = readIdentity(setup.db, "workspace", execution?.workspaceId ?? "");
    expect(workspace.leases.current(identity?.checkoutPath ?? "")?.state).toBe("released");
    service.stop();
    setup.db.close();
  });

  it("redacts provider-derived terminal summaries before durable persistence", async () => {
    const setup = await fixture();
    const fake = fakeBackend();
    const backend: DurableExecutionBackend = {
      ...fake.backend,
      async result(executionId) {
        return {
          ...(await fake.backend.result(executionId)),
          summary: "GET https://provider.example/v1/runs/1 Authorization: Bearer provider-secret",
        };
      },
    };
    const service = createExecutionService({
      db: setup.db,
      backend,
      workspaceService: setup.workspace(setup.db),
      artifactsDirectory: join(setup.root, "artifacts"),
      instanceId: "daemon-redaction",
      ids: setup.ids,
      pollMilliseconds: 1_000_000,
    });
    const started = await service.start({
      currentDirectory: setup.source,
      prompt: "Persist only redacted diagnostics.",
      artifactPath: "artifacts/report.md",
    });
    fake.setStatus("failed");

    await service.status(started.runId);
    const summary = readStageExecution(setup.db, started.runId)?.summary ?? "";
    expect(summary).not.toContain("provider.example");
    expect(summary).not.toContain("provider-secret");
    service.stop();
    setup.db.close();
  });

  it("recovers a crash-boundary start with no persisted handle and reports cleanup until reconciled", async () => {
    const setup = await fixture();
    const fake = fakeBackend();
    let attempts = 0;
    const backend: DurableExecutionBackend = {
      ...fake.backend,
      async start(input) {
        attempts += 1;
        if (attempts === 1) throw new Error("simulated crash after backend dispatch");
        return fake.backend.start(input);
      },
    };
    const workspace = setup.workspace(setup.db);
    const service = createExecutionService({
      db: setup.db,
      backend,
      workspaceService: workspace,
      artifactsDirectory: join(setup.root, "artifacts"),
      instanceId: "daemon-start-fault",
      ids: setup.ids,
      pollMilliseconds: 1_000_000,
    });
    await expect(
      service.start({
        currentDirectory: setup.source,
        prompt: "Create a report.",
        artifactPath: "artifacts/report.md",
      }),
    ).rejects.toThrow("simulated crash");
    const stranded = readActiveStageExecutions(setup.db);
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toMatchObject({ backendExecutionId: null, status: "queued" });
    await expect(service.doctor()).resolves.toMatchObject({
      health: "failed",
      checks: expect.arrayContaining([
        expect.objectContaining({ category: "cleanup", status: "fail" }),
      ]),
    });

    await service.observeAll();
    expect(attempts).toBe(2);
    expect(readStageExecution(setup.db, stranded[0]?.runId ?? "")).toMatchObject({
      backendExecutionId: "thread-q012",
      status: "waiting_on_user",
    });
    await expect(service.doctor()).resolves.toMatchObject({
      health: "degraded",
      checks: expect.arrayContaining([
        expect.objectContaining({ category: "cleanup", status: "pass" }),
      ]),
    });
    await service.cancel(stranded[0]?.runId ?? "");
    service.stop();
    setup.db.close();
  });

  it("repairs a partial artifact import after a crash following atomic completion", async () => {
    const setup = await fixture();
    const fake = fakeBackend();
    const first = createExecutionService({
      db: setup.db,
      backend: fake.backend,
      workspaceService: setup.workspace(setup.db),
      artifactsDirectory: join(setup.root, "artifacts"),
      instanceId: "daemon-import-fault",
      ids: setup.ids,
      pollMilliseconds: 1_000_000,
      faultInjection: {
        afterAtomicCompletion() {
          throw new ExecutionServiceCrashFault("simulated crash after atomic completion");
        },
      },
    });
    const started = await first.start({
      currentDirectory: setup.source,
      prompt: "Create a report.",
      artifactPath: "artifacts/report.md",
    });
    await first.observeAll();
    await expect(
      first.answer(
        started.runId,
        {
          schemaVersion: 2,
          interactionId: "interaction-q012" as never,
          expectedInteractionRevision: 1,
          answers: [
            {
              questionId: "question-q012" as never,
              kind: "free_text",
              freeText: "Recovery",
            },
          ],
        },
        "test-key",
      ),
    ).rejects.toThrow("simulated crash after atomic completion");
    expect(readStageArtifacts(setup.db, started.runId)).toHaveLength(1);
    expect(executionCleanupCounts(setup.db).partialImports).toBe(1);
    first.stop();
    setup.db.close();

    const restartedDb = setup.open();
    const restartedWorkspace = setup.workspace(restartedDb);
    const second = createExecutionService({
      db: restartedDb,
      backend: fake.backend,
      workspaceService: restartedWorkspace,
      artifactsDirectory: join(setup.root, "artifacts"),
      instanceId: "daemon-import-recovery",
      ids: setup.ids,
      pollMilliseconds: 1_000_000,
    });
    await second.observeAll();
    expect(executionCleanupCounts(restartedDb).partialImports).toBe(0);
    expect(readStageExecution(restartedDb, started.runId)).toMatchObject({
      status: "succeeded",
      finalized: true,
    });
    expect(readStageArtifacts(restartedDb, started.runId)).toHaveLength(1);
    const execution = readStageExecution(restartedDb, started.runId);
    const identity = readIdentity(restartedDb, "workspace", execution?.workspaceId ?? "");
    expect(restartedWorkspace.leases.current(identity?.checkoutPath ?? "")?.state).toBe("released");
    second.stop();
    restartedDb.close();
  });

  it("commits an answer before delivery and drains it once after a pre-delivery crash", async () => {
    const setup = await fixture();
    const fake = fakeBackend();
    const first = createExecutionService({
      db: setup.db,
      backend: fake.backend,
      workspaceService: setup.workspace(setup.db),
      artifactsDirectory: join(setup.root, "artifacts"),
      instanceId: "daemon-answer-before-delivery",
      ids: setup.ids,
      pollMilliseconds: 1_000_000,
      faultInjection: {
        afterOperationCommitted() {
          throw new ExecutionServiceCrashFault("simulated crash before answer delivery");
        },
      },
    });
    const started = await first.start({
      currentDirectory: setup.source,
      prompt: "Ask for a title.",
      artifactPath: "artifacts/report.md",
    });
    await first.observeAll();
    await expect(
      first.answer(
        started.runId,
        {
          schemaVersion: 2,
          interactionId: "interaction-q012" as never,
          expectedInteractionRevision: 1,
          answers: [
            { questionId: "question-q012" as never, kind: "free_text", freeText: "Durable" },
          ],
        },
        "key-before-delivery",
      ),
    ).rejects.toThrow("simulated crash before answer delivery");
    expect(fake.answerCalls).toBe(0);
    expect(readPendingExecutionOperations(setup.db)).toHaveLength(1);
    first.stop();
    setup.db.close();

    const restartedDb = setup.open();
    const second = createExecutionService({
      db: restartedDb,
      backend: fake.backend,
      workspaceService: setup.workspace(restartedDb),
      artifactsDirectory: join(setup.root, "artifacts"),
      instanceId: "daemon-answer-before-delivery-restart",
      ids: setup.ids,
      pollMilliseconds: 1_000_000,
    });
    await second.observeAll();
    expect(fake.answerCalls).toBe(1);
    expect(fake.answerEffects).toBe(1);
    expect(readPendingExecutionOperations(restartedDb)).toEqual([]);
    second.stop();
    restartedDb.close();
  });

  it("reuses answer and resume idempotency after an acknowledgement-boundary crash", async () => {
    const setup = await fixture();
    const fake = fakeBackend();
    let crashAfterAcknowledgement = true;
    const first = createExecutionService({
      db: setup.db,
      backend: fake.backend,
      workspaceService: setup.workspace(setup.db),
      artifactsDirectory: join(setup.root, "artifacts"),
      instanceId: "daemon-after-ack",
      ids: setup.ids,
      pollMilliseconds: 1_000_000,
      faultInjection: {
        afterBackendAcknowledged() {
          if (crashAfterAcknowledgement) {
            throw new ExecutionServiceCrashFault("simulated crash after backend acknowledgement");
          }
        },
      },
    });
    const answered = await first.start({
      currentDirectory: setup.source,
      prompt: "Ask for a title.",
      artifactPath: "artifacts/report.md",
    });
    await first.observeAll();
    await expect(
      first.answer(
        answered.runId,
        {
          schemaVersion: 2,
          interactionId: "interaction-q012" as never,
          expectedInteractionRevision: 1,
          answers: [
            { questionId: "question-q012" as never, kind: "free_text", freeText: "Exactly once" },
          ],
        },
        "key-after-ack",
      ),
    ).rejects.toThrow("simulated crash after backend acknowledgement");
    expect(fake.answerCalls).toBe(1);
    expect(fake.answerEffects).toBe(1);
    first.stop();
    setup.db.close();

    crashAfterAcknowledgement = false;
    const restartedDb = setup.open();
    const second = createExecutionService({
      db: restartedDb,
      backend: fake.backend,
      workspaceService: setup.workspace(restartedDb),
      artifactsDirectory: join(setup.root, "artifacts"),
      instanceId: "daemon-after-ack-restart",
      ids: setup.ids,
      pollMilliseconds: 1_000_000,
    });
    await second.observeAll();
    expect(fake.answerCalls).toBe(2);
    expect(fake.answerEffects).toBe(1);
    expect(readPendingExecutionOperations(restartedDb)).toEqual([]);

    fake.setStatus("recovery_required");
    const recoverable = await second.start({
      currentDirectory: setup.source,
      prompt: "Recover this run.",
      artifactPath: "artifacts/recovered.md",
    });
    await second.status(recoverable.runId);
    let crashResumeAfterAcknowledgement = true;
    second.stop();
    const third = createExecutionService({
      db: restartedDb,
      backend: fake.backend,
      workspaceService: setup.workspace(restartedDb),
      artifactsDirectory: join(setup.root, "artifacts"),
      instanceId: "daemon-resume-after-ack",
      ids: setup.ids,
      pollMilliseconds: 1_000_000,
      faultInjection: {
        afterBackendAcknowledged() {
          if (crashResumeAfterAcknowledgement) {
            throw new ExecutionServiceCrashFault("simulated crash after resume acknowledgement");
          }
        },
      },
    });
    await expect(
      third.resume(
        recoverable.runId,
        readRunProjection(restartedDb, recoverable.runId)?.revision ?? -1,
        [],
      ),
    ).rejects.toThrow("simulated crash after resume acknowledgement");
    const durableOperationId = fake.resumeOperationIds.at(-1);
    expect(fake.resumeEffects).toBe(1);
    third.stop();
    restartedDb.close();

    crashResumeAfterAcknowledgement = false;
    const finalDb = setup.open();
    const fourth = createExecutionService({
      db: finalDb,
      backend: fake.backend,
      workspaceService: setup.workspace(finalDb),
      artifactsDirectory: join(setup.root, "artifacts"),
      instanceId: "daemon-resume-after-ack-restart",
      ids: setup.ids,
      pollMilliseconds: 1_000_000,
    });
    await fourth.drainPendingOperations();
    expect(fake.resumeCalls).toBe(2);
    expect(fake.resumeEffects).toBe(1);
    expect(fake.resumeOperationIds).toEqual([durableOperationId, durableOperationId]);
    expect(readStageExecution(finalDb, recoverable.runId)).toMatchObject({ status: "running" });
    fourth.stop();
    finalDb.close();
  });
});

const realClaudeEnabled = process.env.HENIEK_Q012_REAL_CLAUDE === "1";
const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describe.skipIf(!realClaudeEnabled)("Q012 real Claude vertical [opt-in]", () => {
  it("preserves question/session/thread continuity across a Heniek-only restart and cancels", {
    timeout: 600_000,
  }, async () => {
    const runtimeRoot = process.env.HENIEK_CONFORMANCE_SMOKE_CLAUDEXOR_ROOT;
    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const claudeBinary = process.env.CLAUDEXOR_CLAUDE_BIN;
    if (
      runtimeRoot === undefined ||
      oauthToken === undefined ||
      oauthToken.length === 0 ||
      claudeBinary === undefined ||
      !claudeBinary.startsWith("/")
    ) {
      throw new Error(
        "HENIEK_Q012_REAL_CLAUDE=1 requires a prebuilt HENIEK_CONFORMANCE_SMOKE_CLAUDEXOR_ROOT, an absolute CLAUDEXOR_CLAUDE_BIN, and CLAUDE_CODE_OAUTH_TOKEN; API-key fallback is forbidden.",
      );
    }
    const isolatedEnvironment: NodeJS.ProcessEnv = {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      CLAUDEXOR_CLAUDE_BIN: claudeBinary,
      CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
      ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
      ...(process.env.LC_ALL === undefined ? {} : { LC_ALL: process.env.LC_ALL }),
      ...(process.env.TZ === undefined ? {} : { TZ: process.env.TZ }),
    };
    const upstream = await startClaudexorDaemon({
      claudexorRoot: runtimeRoot,
      environment: isolatedEnvironment,
    });
    const setup = await fixture();
    const backend = createClaudexorExecutionBackend({
      baseUrl: upstream.baseUrl,
      expectedEngine: {
        version: "3.1.2",
        buildSha: "bb5efee24132aa3d65e417040df201e08da44c8c",
      },
      token: upstream.token,
      runtimeEntryPath: join(runtimeRoot, "packages/cli/dist/claudexord.js"),
      environment: isolatedEnvironment,
    });
    let db = setup.db;
    let service = createExecutionService({
      db,
      backend,
      workspaceService: setup.workspace(db),
      artifactsDirectory: join(setup.root, "artifacts"),
      instanceId: "real-daemon-first",
      ids: setup.ids,
      pollMilliseconds: 1_000_000,
    });
    try {
      const started = await service.start({
        currentDirectory: setup.source,
        prompt:
          "Before doing any work, use AskUserQuestion to ask one free-text question titled Q012. " +
          "After the answer, use a tool to write artifacts/q012-real.txt containing the answer and the marker Q012_REAL_OK. " +
          "Verify that exact file exists before completing; do not finish until it does.",
        artifactPath: "artifacts/q012-real.txt",
        limits: { maxDurationMs: 360_000, maxTurns: 12 },
      });
      const waitDeadline = Date.now() + 180_000;
      let waiting = await service.status(started.runId);
      while (waiting.status !== "waiting_on_user" && Date.now() < waitDeadline) {
        if (["failed", "cancelled", "succeeded"].includes(waiting.status)) break;
        await sleep(2_000);
        waiting = await service.status(started.runId);
      }
      expect(
        waiting.status,
        waiting.error ?? waiting.summary ?? "the external stage did not request a question",
      ).toBe("waiting_on_user");
      const originalHandle = waiting.backendExecutionId;
      service.stop();
      db.close();

      db = setup.open();
      service = createExecutionService({
        db,
        backend,
        workspaceService: setup.workspace(db),
        artifactsDirectory: join(setup.root, "artifacts"),
        instanceId: "real-daemon-second",
        ids: setup.ids,
        pollMilliseconds: 1_000_000,
      });
      const reconciled = await service.status(started.runId);
      expect(reconciled.backendExecutionId).toBe(originalHandle);
      const interaction =
        reconciled.status === "waiting_on_user"
          ? readPendingInteractions(db, started.runId)[0]
          : undefined;
      expect(interaction).toBeDefined();
      await service.answer(
        started.runId,
        {
          schemaVersion: 2,
          interactionId: interaction?.id ?? ("missing" as never),
          expectedInteractionRevision: 1,
          answers:
            interaction?.questions.map((question) => ({
              questionId: question.id,
              ...(question.options[0] === undefined
                ? { kind: "free_text" as const, freeText: "Q012 continuity answer" }
                : {
                    kind: question.multiSelect
                      ? ("multiple_choice" as const)
                      : ("single_choice" as const),
                    selectedLabels: [question.options[0].label],
                  }),
            })) ?? [],
        },
        "test-key",
      );
      const finishDeadline = Date.now() + 240_000;
      let completed = await service.result(started.runId);
      while (completed.status !== "succeeded" && Date.now() < finishDeadline) {
        if (completed.status === "failed" || completed.status === "cancelled") break;
        await sleep(2_000);
        completed = await service.result(started.runId);
      }
      expect(
        completed,
        completed.error ?? completed.summary ?? "the external stage did not complete successfully",
      ).toMatchObject({
        status: "succeeded",
        backendExecutionId: originalHandle,
        finalized: true,
      });
      expect(completed.sessionId).toBeTruthy();
      const artifact = readStageArtifacts(db, started.runId)[0];
      const artifactBytes = await readFile(
        join(setup.root, "artifacts", artifact?.relativePath ?? "missing"),
        "utf8",
      );
      expect(artifactBytes).toContain("Q012_REAL_OK");

      const cancellable = await service.start({
        currentDirectory: setup.source,
        prompt: "Continue analyzing this repository until cancelled; do not finish early.",
        artifactPath: "artifacts/never.txt",
        limits: { maxDurationMs: 360_000, maxTurns: 50 },
      });
      await service.cancel(cancellable.runId);
      const cancelDeadline = Date.now() + 120_000;
      let cancelled = await service.result(cancellable.runId);
      while (cancelled.status !== "cancelled" && Date.now() < cancelDeadline) {
        await sleep(2_000);
        cancelled = await service.result(cancellable.runId);
      }
      expect(cancelled.status).toBe("cancelled");
    } finally {
      service.stop();
      db.close();
      upstream.stop();
    }
  });
});
