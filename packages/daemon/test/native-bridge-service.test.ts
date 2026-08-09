/**
 * The native bridge service (Q023, ADR 0021). Exercises the two things the
 * store-level test (`packages/state/test/native-bridge.test.ts`) cannot:
 * real workspace provisioning and the `finalizeStageArtifact` integration —
 * proving the wiring between the store's fencing and the filesystem/git
 * work this service alone performs actually works end to end.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ResolvedProfileChainV1 } from "@heniek/contracts";
import {
  commitStateChange,
  openStateDatabase,
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
import { createNativeBridgeService } from "../src/runtime/native-bridge-service.js";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "heniek-q023-service-"));
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
  const clock = { nowIso: () => "2026-08-08T10:00:00.000Z" };
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
    instanceId: "daemon-q023",
    artifactsDirectory: join(root, "artifacts"),
    ids,
    clock,
    resolveProfileChain: () => nativeChain(),
    pollMilliseconds: 60_000,
  });
  return { root, source, db, ids, clock, workspaceService, service };
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

function nativeChainWithFallback(): Static<typeof ResolvedProfileChainV1> {
  return {
    schemaVersion: 1,
    primaryProfileId: "opus-native",
    primary: { ...nativeProfile(), fallbackProfileIds: ["opus-native-fallback"] },
    fallbacks: [{ ...nativeProfile(), profileId: "opus-native-fallback" }],
  } as unknown as Static<typeof ResolvedProfileChainV1>;
}

describe("Q023 native bridge service", () => {
  it("runs start -> attach -> poll -> question -> answer -> poll -> submit end to end, with a real worktree and a real published artifact", async () => {
    const context = await fixture();
    const started = await context.service.start({
      currentDirectory: context.source,
      prompt: "Do the thing.",
      artifactPath: "out/result.md",
      profileId: "opus-native",
    });
    expect(started.status).toBe("waiting_for_parent_session");

    const attached = context.service.attach({ codebaseId: "codebase-q023" });
    if (!attached.accepted) throw new Error("expected attach to be accepted");

    const polled = await context.service.poll({
      sessionId: attached.sessionId,
      sessionRevision: attached.sessionRevision,
      codebaseId: "codebase-q023",
      maxDispatches: 4,
    });
    if (!polled.accepted) throw new Error("expected poll to be accepted");
    expect(polled.claimed).toHaveLength(1);
    const dispatch = polled.claimed[0];
    if (dispatch === undefined) throw new Error("expected a claimed dispatch");
    const workingDirectory = polled.workingDirectories.get(dispatch.dispatchId);
    if (workingDirectory === undefined) throw new Error("expected a provisioned worktree");

    // The claimed worktree is a real, usable git checkout.
    expect(await git(workingDirectory, "rev-parse", "--is-inside-work-tree")).toBe("true");

    const raised = context.service.question({
      sessionId: attached.sessionId,
      sessionRevision: polled.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision,
      runId: started.runId,
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      interaction: {
        schemaVersion: 2,
        id: "question-1" as never,
        questions: [
          {
            id: "q1" as never,
            prompt: "Which approach?",
            options: [{ label: "a" }, { label: "b" }],
            multiSelect: false,
          },
        ],
        requestedAt: "2026-08-08T10:00:00.000Z",
      },
    });
    expect(raised.accepted).toBe(true);

    const answered = context.service.answer({
      runId: started.runId,
      submission: {
        schemaVersion: 2,
        interactionId: "question-1" as never,
        expectedInteractionRevision: 1,
        answers: [{ questionId: "q1" as never, kind: "single_choice", selectedLabels: ["a"] }],
      },
      answeredByKeyId: "key-1",
    });
    expect(answered.status).toBe("running");

    const secondPoll = await context.service.poll({
      sessionId: attached.sessionId,
      sessionRevision: polled.sessionRevision,
      codebaseId: "codebase-q023",
      maxDispatches: 4,
    });
    if (!secondPoll.accepted) throw new Error("expected the second poll to be accepted");
    expect(secondPoll.resumes).toHaveLength(1);

    await mkdir(join(workingDirectory, "out"), { recursive: true });
    await writeFile(join(workingDirectory, "out", "result.md"), "# Done\n");

    const settled = await context.service.submit({
      sessionId: attached.sessionId,
      sessionRevision: secondPoll.sessionRevision,
      dispatchId: dispatch.dispatchId,
      expectedDispatchRevision: dispatch.dispatchRevision + 2,
      runId: started.runId,
      stageId: dispatch.stageId,
      attemptId: dispatch.attemptId,
      submissionId: "submission-1",
      submissionDigest: "digest-1",
      outcome: "succeeded",
      declaredSummary: "Done.",
      declaredArtifactPath: "out/result.md",
    });
    expect(settled).toMatchObject({ accepted: true, status: "succeeded" });

    const artifacts = readStageArtifacts(context.db, started.runId);
    expect(artifacts).toMatchObject([{ name: "out/result.md" }]);
    const published = await readFile(
      join(context.root, "artifacts", "blobs", "sha256", artifacts[0]?.contentHash ?? ""),
    );
    expect(published.toString("utf8")).toBe("# Done\n");

    context.service.stop();
  });

  it("rejects a native profile that declares a fallback chain", async () => {
    const context = await fixture();
    const service = createNativeBridgeService({
      db: context.db,
      workspaceService: context.workspaceService,
      instanceId: "daemon-q023-fallback",
      artifactsDirectory: join(context.root, "artifacts-2"),
      ids: context.ids,
      clock: context.clock,
      resolveProfileChain: () => nativeChainWithFallback(),
      pollMilliseconds: 60_000,
    });
    await expect(
      service.start({
        currentDirectory: context.source,
        prompt: "Do the thing.",
        artifactPath: "out/result.md",
        profileId: "opus-native",
      }),
    ).rejects.toThrow("native-fallback-unsupported");
    service.stop();
    context.service.stop();
  });
});
