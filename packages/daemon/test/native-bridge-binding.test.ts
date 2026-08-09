/**
 * The native bridge service's binding, idempotency and fencing behaviour
 * (Q023, ADR 0021), at the layer `packages/state/test/native-bridge.test.ts`
 * cannot reach: through `createNativeBridgeService`, against a real git
 * worktree and a real published artifact, exercising the service's own
 * translation of store outcomes rather than the store's raw shapes. The
 * store-level suite already proves the fencing CAS and CR1-CR9 correctness
 * in isolation; this file proves that correctness still holds once real
 * filesystem/git I/O and artifact publishing sit in front of it — including
 * the CR1 regression, this time through a genuine second workspace
 * provisioned for the fresh attempt.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ResolvedProfileChainV1 } from "@heniek/contracts";
import {
  commitStateChange,
  openStateDatabase,
  readNativeStage,
  readNativeStageAttempts,
  readStageArtifacts,
  runMigrations,
} from "@heniek/state";
import {
  createWorkspaceService,
  createWorkspaceStateStore,
  type OwnerLiveness,
} from "@heniek/workspace";
import type { Static } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeBridgeService,
  type NativeBridgeService,
} from "../src/runtime/native-bridge-service.js";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

/** A settable clock — `advance` moves it forward, mirroring `@heniek/state`'s own test fake without a cross-package import. */
function createMutableClock(initialIso: string) {
  let currentMs = Date.parse(initialIso);
  return {
    nowIso: () => new Date(currentMs).toISOString(),
    advance: (ms: number): void => {
      currentMs += ms;
    },
  };
}

function nativeProfile(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    profileId: "opus-native",
    engine: "claude",
    model: "opus",
    effort: "high",
    executionMode: "native",
    questions: "parent-mediated",
    instructionsPath: "docs/instructions.md",
    artifactContract: "heniek://contract/ExternalStageResult/v1",
    permissions: { workspace: "read-write", identifiers: [] },
    fallbackProfileIds: [],
  };
}

function nativeChain(): Static<typeof ResolvedProfileChainV1> {
  return {
    schemaVersion: 1,
    primaryProfileId: "opus-native",
    primary: nativeProfile(),
    fallbacks: [],
  } as unknown as Static<typeof ResolvedProfileChainV1>;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "heniek-q023-binding-"));
  roots.push(root);
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  await mkdir(source);
  await git(root, "init", "--bare", remote);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Heniek Test");
  await git(source, "config", "user.email", "heniek@example.invalid");
  await writeFile(join(source, "README.md"), "fixture\n");
  await git(source, "add", "README.md");
  await git(source, "commit", "-m", "fixture");
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "-u", "origin", "main");
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");

  let sequence = 0;
  const ids = { next: (prefix: string) => `${prefix}-${++sequence}` };
  const clock = createMutableClock("2026-08-08T10:00:00.000Z");
  const db = openStateDatabase({ path: join(root, "state.sqlite"), clock, ids });
  runMigrations(db);
  commitStateChange(db, {
    type: "codebase.registration_committed",
    payload: {
      registration: {
        codebaseId: "codebase-q023",
        configurationSha256: "d".repeat(64),
        instructionSnapshot: {},
        name: "q023",
        repositories: [
          {
            defaultBranch: "main",
            defaultRemote: "origin",
            gitCommonDirectory: join(source, ".git"),
            name: "source",
            path: source,
            remotes: [],
            repositoryId: "repository-q023",
          },
        ],
        rootPath: source,
        topologySha256: "e".repeat(64),
      },
    },
  });
  const witness = { mode: "unknown" as "alive" | "dead" | "unknown" };
  const liveness: OwnerLiveness = {
    currentBootWitness: () => "boot-q023",
    witnessState: () => "dead",
  };
  const workspaceService = createWorkspaceService({
    state: createWorkspaceStateStore(db),
    workspacesDirectory: join(root, "workspaces"),
    logsDirectory: join(root, "logs"),
    clock,
    ids,
    liveness,
  });
  const service = createNativeBridgeService({
    db,
    workspaceService,
    instanceId: "daemon-q023-binding",
    artifactsDirectory: join(root, "artifacts"),
    ids,
    clock,
    resolveProfileChain: () => nativeChain(),
    pollMilliseconds: 60_000,
    witnessOf: (_bootWitness, _processWitness) => witness.mode,
  });
  return { root, source, db, ids, clock, witness, workspaceService, service };
}

async function startAndAttach(service: NativeBridgeService, source: string) {
  const started = await service.start({
    currentDirectory: source,
    prompt: "Do the thing.",
    artifactPath: "out/result.md",
    profileId: "opus-native",
  });
  const attached = service.attach({ codebaseId: "codebase-q023" });
  if (!attached.accepted) throw new Error("expected attach to be accepted");
  return { started, attached };
}

async function claimOne(service: NativeBridgeService, sessionId: string, sessionRevision: number) {
  const polled = await service.poll({
    sessionId,
    sessionRevision,
    codebaseId: "codebase-q023",
    maxDispatches: 4,
  });
  if (!polled.accepted) throw new Error("expected poll to be accepted");
  const dispatch = polled.claimed[0];
  if (dispatch === undefined) throw new Error("expected a claimed dispatch");
  return { polled, dispatch };
}

describe("Q023 native bridge service — binding, idempotency and fencing", () => {
  it("rejects poll, question and submit for a session that was never attached", async () => {
    const context = await fixture();
    const { started } = await startAndAttach(context.service, context.source);
    const service = context.service;

    const polled = await service.poll({
      sessionId: "session-never-attached",
      sessionRevision: 1,
      codebaseId: "codebase-q023",
      maxDispatches: 4,
    });
    expect(polled).toMatchObject({ accepted: false, rejectionCode: "session_not_attached" });

    const questioned = service.question({
      sessionId: "session-never-attached",
      sessionRevision: 1,
      dispatchId: "dispatch-does-not-exist",
      expectedDispatchRevision: 1,
      runId: started.runId,
      stageId: started.stageId,
      attemptId: "attempt-does-not-exist",
      interaction: {
        schemaVersion: 2,
        id: "question-never-attached" as never,
        questions: [
          { id: "q1" as never, prompt: "Which?", options: [{ label: "a" }], multiSelect: false },
        ],
        requestedAt: context.clock.nowIso(),
      },
    });
    expect(questioned).toMatchObject({ accepted: false, rejectionCode: "session_not_attached" });

    const submitted = await service.submit({
      sessionId: "session-never-attached",
      sessionRevision: 1,
      dispatchId: "dispatch-does-not-exist",
      expectedDispatchRevision: 1,
      runId: started.runId,
      stageId: started.stageId,
      attemptId: "attempt-does-not-exist",
      submissionId: "submission-1",
      submissionDigest: "digest-1",
      outcome: "failed",
    });
    expect(submitted).toMatchObject({ accepted: false, rejectionCode: "session_not_attached" });
  });

  it("keeps a second session's claimed dispatch invisible to poll and unreachable by submit", async () => {
    const context = await fixture();
    await startAndAttach(context.service, context.source);
    const first = context.service.attach({ codebaseId: "codebase-q023" });
    if (!first.accepted) throw new Error("expected first attach to be accepted");
    const { dispatch } = await claimOne(context.service, first.sessionId, first.sessionRevision);

    const second = context.service.attach({ codebaseId: "codebase-q023" });
    if (!second.accepted) throw new Error("expected second attach to be accepted");
    const secondPoll = await context.service.poll({
      sessionId: second.sessionId,
      sessionRevision: second.sessionRevision,
      codebaseId: "codebase-q023",
      maxDispatches: 4,
    });
    if (!secondPoll.accepted) throw new Error("expected second poll to be accepted");
    // Only one stage was ever started, and the first session already claimed
    // it — the second session's poll has nothing left to claim.
    expect(secondPoll.claimed).toHaveLength(0);

    const stolen = await context.service.submit({
      sessionId: second.sessionId,
      sessionRevision: secondPoll.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: dispatch.runId,
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-stolen",
      submissionDigest: "digest-stolen",
      outcome: "failed",
    });
    // Existence and ownership collapse into one code (D5) — the second
    // session cannot distinguish "not yours" from "does not exist".
    expect(stolen).toMatchObject({ accepted: false, rejectionCode: "unknown_dispatch" });
  });

  it("an identical resubmission is idempotent — exactly one artifact row is published", async () => {
    const context = await fixture();
    const { started, attached } = await startAndAttach(context.service, context.source);
    const { polled, dispatch } = await claimOne(
      context.service,
      attached.sessionId,
      attached.sessionRevision,
    );
    const workingDirectory = polled.workingDirectories.get(dispatch.dispatchId);
    if (workingDirectory === undefined) throw new Error("expected a provisioned worktree");
    await mkdir(join(workingDirectory, "out"), { recursive: true });
    await writeFile(join(workingDirectory, "out", "result.md"), "# Done\n");

    const submitInput = {
      sessionId: attached.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: started.runId,
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-once",
      submissionDigest: "digest-once",
      outcome: "succeeded" as const,
      declaredSummary: "Done.",
      declaredArtifactPath: "out/result.md",
    };

    const first = await context.service.submit(submitInput);
    expect(first).toMatchObject({ accepted: true, idempotentReplay: false, status: "succeeded" });
    const second = await context.service.submit(submitInput);
    expect(second).toMatchObject({ accepted: true, idempotentReplay: true, status: "succeeded" });

    expect(readStageArtifacts(context.db, started.runId)).toHaveLength(1);
  });

  it("a different submissionId against an already-settled dispatch is rejected as dispatch_already_settled", async () => {
    const context = await fixture();
    const { started, attached } = await startAndAttach(context.service, context.source);
    const { polled, dispatch } = await claimOne(
      context.service,
      attached.sessionId,
      attached.sessionRevision,
    );

    const settled = await context.service.submit({
      sessionId: attached.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: started.runId,
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-original",
      submissionDigest: "digest-original",
      outcome: "failed",
    });
    expect(settled).toMatchObject({ accepted: true });

    const resubmittedWithDifferentKey = await context.service.submit({
      sessionId: attached.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: started.runId,
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-different",
      submissionDigest: "digest-different",
      outcome: "failed",
    });
    expect(resubmittedWithDifferentKey).toMatchObject({
      accepted: false,
      rejectionCode: "dispatch_already_settled",
    });
  });

  it("the same submissionId with a changed payload is rejected as idempotency_key_reuse", async () => {
    const context = await fixture();
    const { started, attached } = await startAndAttach(context.service, context.source);
    const { polled, dispatch } = await claimOne(
      context.service,
      attached.sessionId,
      attached.sessionRevision,
    );

    const settled = await context.service.submit({
      sessionId: attached.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: started.runId,
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-reused",
      submissionDigest: "digest-original",
      outcome: "failed",
    });
    expect(settled).toMatchObject({ accepted: true });

    const replayedWithDifferentDigest = await context.service.submit({
      sessionId: attached.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: started.runId,
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-reused",
      submissionDigest: "digest-mutated",
      outcome: "failed",
    });
    expect(replayedWithDifferentDigest).toMatchObject({
      accepted: false,
      rejectionCode: "idempotency_key_reuse",
    });
  });

  it("rebind bumps the dispatch revision and invalidates a submit against the pre-rebind revision", async () => {
    const context = await fixture();
    const { started, attached } = await startAndAttach(context.service, context.source);
    const { polled, dispatch } = await claimOne(
      context.service,
      attached.sessionId,
      attached.sessionRevision,
    );

    const rebound = context.service.attach({
      codebaseId: "codebase-q023",
      previousSessionId: attached.sessionId,
      previousSessionRevision: polled.sessionRevision,
      resumeDispatchIds: [dispatch.dispatchId],
    });
    if (!rebound.accepted) throw new Error("expected rebind to be accepted");
    expect(rebound.resumedDispatchIds).toEqual([dispatch.dispatchId]);

    const staleSubmit = await context.service.submit({
      sessionId: rebound.sessionId,
      sessionRevision: rebound.sessionRevision,
      dispatchId: dispatch.dispatchId,
      // The pre-rebind revision — rebinding bumped it by one.
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: started.runId,
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-pre-rebind",
      submissionDigest: "digest-pre-rebind",
      outcome: "failed",
    });
    expect(staleSubmit).toMatchObject({
      accepted: false,
      rejectionCode: "stale_dispatch_revision",
    });

    const freshSubmit = await context.service.submit({
      sessionId: rebound.sessionId,
      sessionRevision: rebound.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision + 1,
      runId: started.runId,
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-post-rebind",
      submissionDigest: "digest-post-rebind",
      outcome: "failed",
    });
    expect(freshSubmit).toMatchObject({ accepted: true });
  });

  it("a submit with the wrong runId, stageId or attemptId is rejected as unknown_dispatch and leaves stored state unchanged", async () => {
    const context = await fixture();
    const { started, attached } = await startAndAttach(context.service, context.source);
    const { polled, dispatch } = await claimOne(
      context.service,
      attached.sessionId,
      attached.sessionRevision,
    );

    const snapshot = () =>
      JSON.stringify({
        stage: readNativeStage(context.db, started.runId),
        attempts: readNativeStageAttempts(context.db, started.runId),
      });
    const before = snapshot();

    const base = {
      sessionId: attached.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: started.runId,
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-tampered",
      submissionDigest: "digest-tampered",
      outcome: "failed" as const,
    };

    for (const tampered of [
      { ...base, runId: "run-does-not-exist" },
      { ...base, stageId: "stage-does-not-exist" },
      { ...base, attemptId: "attempt-does-not-exist" },
    ]) {
      const result = await context.service.submit(tampered);
      expect(result).toMatchObject({ accepted: false, rejectionCode: "unknown_dispatch" });
    }

    expect(snapshot()).toBe(before);
  });

  it("CR1: a session that sleeps past its lease cannot resurrect its abandoned dispatch after an operator resume, even through real workspace provisioning", async () => {
    const context = await fixture();
    const { started, attached: original } = await startAndAttach(context.service, context.source);
    const { polled: firstPolled, dispatch: firstDispatch } = await claimOne(
      context.service,
      original.sessionId,
      original.sessionRevision,
    );

    // T1: the parent's process goes away — sleep past the lease TTL.
    context.clock.advance(200_000);
    context.witness.mode = "dead";

    // The next mutating call reaps it inline (CR5), classifying it dead
    // (CR6) and abandoning the open dispatch as a side effect.
    const reapingPoll = await context.service.poll({
      sessionId: original.sessionId,
      sessionRevision: firstPolled.sessionRevision,
      codebaseId: "codebase-q023",
      maxDispatches: 4,
    });
    expect(reapingPoll.accepted).toBe(false);
    expect(context.service.status(started.runId)?.stage.state).toBe("recovery_required");

    // T2: operator resumes, and a fresh session claims a genuinely new
    // attempt — with its own, real, second workspace.
    context.witness.mode = "unknown";
    const resumed = context.service.resume(
      started.runId,
      context.service.status(started.runId)?.stage.runRevision ?? 1,
    );
    expect(resumed.status).toBe("waiting_for_parent_session");

    const second = context.service.attach({ codebaseId: "codebase-q023" });
    if (!second.accepted) throw new Error("expected second attach to be accepted");
    const { polled: secondPolled, dispatch: secondDispatch } = await claimOne(
      context.service,
      second.sessionId,
      second.sessionRevision,
    );
    expect(secondDispatch.attemptOrdinal).toBe(2);
    expect(secondDispatch.dispatchId).not.toBe(firstDispatch.dispatchId);
    const secondWorkingDirectory = secondPolled.workingDirectories.get(secondDispatch.dispatchId);
    if (secondWorkingDirectory === undefined)
      throw new Error("expected a second provisioned worktree");
    expect(secondWorkingDirectory).not.toBe("");

    // T3: the ORIGINAL, now-abandoned dispatch can never be submitted
    // against again, even carrying real would-be artifact content.
    await mkdir(join(secondWorkingDirectory, "out"), { recursive: true });
    await writeFile(join(secondWorkingDirectory, "out", "result.md"), "# Done for real\n");
    const staleSubmit = await context.service.submit({
      sessionId: original.sessionId,
      sessionRevision: original.sessionRevision,
      dispatchId: firstDispatch.dispatchId,
      expectedDispatchRevision: firstDispatch.dispatchRevision,
      runId: started.runId,
      stageId: firstDispatch.stageId,
      attemptId: firstDispatch.attemptId,
      submissionId: "submission-too-late",
      submissionDigest: "digest-too-late",
      outcome: "succeeded",
      declaredSummary: "Too late.",
      declaredArtifactPath: "out/result.md",
    });
    expect(staleSubmit.accepted).toBe(false);

    // The second, fresh attempt is unaffected and settles normally with a
    // real published artifact.
    const freshSubmit = await context.service.submit({
      sessionId: second.sessionId,
      sessionRevision: secondPolled.sessionRevision,
      dispatchId: secondDispatch.dispatchId,
      expectedDispatchRevision: secondDispatch.dispatchRevision,
      runId: started.runId,
      stageId: secondDispatch.stageId,
      attemptId: secondDispatch.attemptId,
      submissionId: "submission-second-attempt",
      submissionDigest: "digest-second-attempt",
      outcome: "succeeded",
      declaredSummary: "Done for real.",
      declaredArtifactPath: "out/result.md",
    });
    expect(freshSubmit).toMatchObject({ accepted: true, status: "succeeded" });
    const artifacts = readStageArtifacts(context.db, started.runId);
    expect(artifacts).toMatchObject([{ name: "out/result.md" }]);

    context.service.stop();
  });
});
