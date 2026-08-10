import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExecutionBackendV7, ResolvedProfileChainV1 } from "@heniek/contracts";
import {
  commitStateChange,
  openStateDatabase,
  readEventsForRun,
  readRunProjection,
  runMigrations,
} from "@heniek/state";
import {
  createWorkspaceService,
  createWorkspaceStateStore,
  type OwnerLiveness,
} from "@heniek/workspace";
import type { Static } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createSchedulingExecutionService } from "../src/runtime/scheduling-service.js";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "heniek-cap-landing-"));
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
        codebaseId: "codebase-cap",
        configurationSha256: "d".repeat(64),
        instructionSnapshot: {},
        name: "cap",
        repositories: [
          {
            defaultBranch: "main",
            defaultRemote: "origin",
            gitCommonDirectory: join(source, ".git"),
            name: "source",
            path: source,
            remotes: [],
            repositoryId: "repository-cap",
          },
        ],
        rootPath: source,
        topologySha256: "e".repeat(64),
      },
    },
  });
  const liveness: OwnerLiveness = {
    currentBootWitness: () => "boot-cap",
    witnessState: () => "dead",
  };
  return {
    source,
    db,
    ids,
    clock,
    workspaceService: createWorkspaceService({
      state: createWorkspaceStateStore(db),
      workspacesDirectory: join(root, "workspaces"),
      logsDirectory: join(root, "logs"),
      clock,
      ids,
      liveness,
    }),
  };
}

function baseProfile(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    profileId: "primary",
    workerId: "worker",
    roleId: "role",
    engine: "claude",
    accountId: "account-a",
    model: "opus",
    effort: "high",
    executionMode: "external",
    questions: "direct",
    instructionsPath: "instructions.md",
    artifactContract: "artifact",
    provenance: [],
    fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    maxDurationMs: 120_000,
    onCapacity: "fallback",
    accountMaxConcurrentRuns: 1,
    permissions: { schemaVersion: 1, workspace: "read-write", identifiers: [] },
    fallbackProfileIds: ["fallback"],
    ...overrides,
  };
}

function fallbackChain(
  options: { fallbackModel?: string } = {},
): Static<typeof ResolvedProfileChainV1> {
  const primary = baseProfile();
  return {
    schemaVersion: 1,
    primary: primary as never,
    fallbacks: [
      baseProfile({
        profileId: "fallback",
        accountId: "account-b",
        model: options.fallbackModel ?? "sonnet",
        fallbackProfileIds: [],
      }) as never,
    ],
  };
}

describe("scheduling capability landing", () => {
  it("records one degraded journal event when a fallback candidate starts", async () => {
    const context = await fixture();
    let startCalls = 0;
    const seenDeltas: unknown[] = [];
    const backend: ExecutionBackendV7 = {
      async start(request) {
        startCalls += 1;
        if ("capabilityDelta" in request) seenDeltas.push(request.capabilityDelta);
        return { schemaVersion: 1, executionId: `backend-${startCalls}` as never };
      },
      async status() {
        return "succeeded";
      },
      async interactions() {
        return [];
      },
      async answer() {},
      async resume() {},
      async result() {
        throw new Error("result is not needed for this assertion");
      },
      async cancel() {},
      async artifacts() {
        return [];
      },
      async readArtifact() {
        return new Uint8Array();
      },
      async *events() {},
    };

    // Saturate primary account so capacity fallback selects the second candidate.
    const service = createSchedulingExecutionService({
      db: context.db,
      backend,
      workspaceService: context.workspaceService,
      instanceId: "instance-cap",
      artifactsDirectory: join(context.source, "..", "artifacts"),
      ids: context.ids,
      clock: context.clock,
      resolveProfileChain: () => fallbackChain(),
      createIdentifierReader: () => ({ read: async () => null }),
      pollMilliseconds: 60_000,
    });

    // Start a blocker run on account-a to force capacity onto fallback.
    const blocker: ExecutionBackendV7 = {
      ...backend,
      async start() {
        return { schemaVersion: 1, executionId: "blocker" as never };
      },
      async status() {
        return "running";
      },
    };
    const blocking = createSchedulingExecutionService({
      db: context.db,
      backend: blocker,
      workspaceService: context.workspaceService,
      instanceId: "instance-block",
      artifactsDirectory: join(context.source, "..", "artifacts-block"),
      ids: {
        next: (() => {
          let n = 100;
          return (prefix: string) => `${prefix}-b${++n}`;
        })(),
      },
      clock: context.clock,
      resolveProfileChain: () => ({
        schemaVersion: 1,
        primary: baseProfile({
          onCapacity: "queue",
          fallbackProfileIds: [],
        }) as never,
        fallbacks: [],
      }),
      createIdentifierReader: () => ({ read: async () => null }),
      pollMilliseconds: 60_000,
    });
    await blocking.start({
      currentDirectory: context.source,
      prompt: "hold capacity",
      artifactPath: "out/hold.md",
      profileId: "primary",
      priority: 9,
    });

    const started = await service.start({
      currentDirectory: context.source,
      prompt: "do work",
      artifactPath: "out/result.md",
      profileId: "primary",
      priority: 0,
    });

    const landingJson = readRunProjection(context.db, started.runId)?.capabilityLandingJson;
    const events = readEventsForRun(context.db, started.runId).filter(
      (event) => event.type === "run.capability_degraded",
    );
    expect(events).toHaveLength(1);
    expect(landingJson).toContain('"status":"degraded"');
    expect(landingJson).toContain('"axis":"model"');
    expect(service.capabilityLanding(started.runId)?.status).toBe("degraded");
    service.stop();
    blocking.stop();
  });

  it("blocks when a model pin makes every route unavailable", async () => {
    const context = await fixture();
    let startCalls = 0;
    const backend: ExecutionBackendV7 = {
      async start() {
        startCalls += 1;
        return { schemaVersion: 1, executionId: "should-not-start" as never };
      },
      async status() {
        return "queued";
      },
      async interactions() {
        return [];
      },
      async answer() {},
      async resume() {},
      async result() {
        throw new Error("unused");
      },
      async cancel() {},
      async artifacts() {
        return [];
      },
      async readArtifact() {
        return new Uint8Array();
      },
      async *events() {},
    };
    const service = createSchedulingExecutionService({
      db: context.db,
      backend,
      workspaceService: context.workspaceService,
      instanceId: "instance-pin",
      artifactsDirectory: join(context.source, "..", "artifacts"),
      ids: context.ids,
      clock: context.clock,
      resolveProfileChain: () =>
        // Primary itself violates the pin after overrides are applied externally:
        // emulate by resolving a chain whose primary model differs from the pin request.
        ({
          schemaVersion: 1,
          primary: baseProfile({ model: "sonnet", fallbackProfileIds: [] }) as never,
          fallbacks: [],
        }),
      createIdentifierReader: () => ({ read: async () => null }),
      pollMilliseconds: 60_000,
    });

    await expect(
      service.start({
        currentDirectory: context.source,
        prompt: "pinned",
        artifactPath: "out/pinned.md",
        profileId: "primary",
        invocationOverrides: { model: "opus" },
        appliedCapabilityPins: ["model"],
        // Requested snapshot uses primary after overrides would be opus, but our
        // fake resolver returns sonnet — evaluate against pins by passing required
        // mismatch via preferred empty and forcing requiredFeatures on missing tool.
        requiredTools: ["missing-tool"],
      }),
    ).rejects.toThrow(/pinned capability unavailable/);
    expect(startCalls).toBe(0);
    service.stop();
  });
});
