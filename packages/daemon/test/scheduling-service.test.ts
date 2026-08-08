import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExecutionBackendV7, ResolvedProfileChainV1 } from "@heniek/contracts";
import { createScopedSecretReader, SensitiveValue } from "@heniek/secrets";
import {
  commitStateChange,
  openStateDatabase,
  readExecutionAttempts,
  readStageArtifacts,
  runMigrations,
} from "@heniek/state";
import {
  createWorkspaceService,
  createWorkspaceStateStore,
  type OwnerLiveness,
} from "@heniek/workspace";
import type { Static } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  const root = await mkdtemp(join(tmpdir(), "heniek-q021-service-"));
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
  const databasePath = join(root, "state.sqlite");
  const db = openStateDatabase({ path: databasePath, clock, ids });
  runMigrations(db);
  commitStateChange(db, {
    type: "codebase.registration_committed",
    payload: {
      registration: {
        codebaseId: "codebase-q021",
        configurationSha256: "d".repeat(64),
        instructionSnapshot: {},
        name: "q021",
        repositories: [
          {
            defaultBranch: "main",
            defaultRemote: "origin",
            gitCommonDirectory: join(source, ".git"),
            name: "source",
            path: source,
            remotes: [],
            repositoryId: "repository-q021",
          },
        ],
        rootPath: source,
        topologySha256: "e".repeat(64),
      },
    },
  });
  const liveness: OwnerLiveness = {
    currentBootWitness: () => "boot-q021",
    witnessState: () => "dead",
  };
  return {
    root,
    source,
    databasePath,
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

function chain(): Static<typeof ResolvedProfileChainV1> {
  const primary = {
    schemaVersion: 2,
    profileId: "primary",
    engine: "claude",
    accountId: "account-a",
    model: "opus",
    effort: "high",
    executionMode: "external",
    maxDurationMs: 120_000,
    onCapacity: "queue",
    accountMaxConcurrentRuns: 1,
    permissions: { workspace: "read-only", identifiers: ["shared"] },
    fallbackProfileIds: [],
  };
  return {
    schemaVersion: 1,
    primaryProfileId: "primary",
    primary,
    fallbacks: [],
  } as unknown as Static<typeof ResolvedProfileChainV1>;
}

function fallbackChain(): Static<typeof ResolvedProfileChainV1> {
  const primary = (chain() as unknown as { primary: Record<string, unknown> }).primary;
  return {
    schemaVersion: 1,
    primaryProfileId: "primary",
    primary: { ...primary, fallbackProfileIds: ["fallback"] },
    fallbacks: [
      {
        ...primary,
        profileId: "fallback",
        accountId: "account-b",
        fallbackProfileIds: [],
        permissions: { workspace: "read-only", identifiers: ["shared"] },
      },
    ],
  } as unknown as Static<typeof ResolvedProfileChainV1>;
}

async function allFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("Q021 scheduling execution service", () => {
  it("pins the worktree and exposes only a scoped in-memory identifier reader", async () => {
    const context = await fixture();
    const sensitiveText = ["q021", "runtime", "only", "value"].join("-");
    const sensitive = SensitiveValue.from(sensitiveText);
    const backingRead = vi.fn(async () => sensitive);
    let deniedBeforeBackingStore = false;
    let startedHead = "";
    const backend: ExecutionBackendV7 = {
      async start(request, runtime) {
        expect(request.permissions).toEqual({
          schemaVersion: 1,
          workspace: "read-only",
          identifiers: ["shared"],
        });
        expect(await runtime.identifierReader.read("shared")).toBe(sensitive);
        try {
          await runtime.identifierReader.read("not-allowed");
        } catch {
          deniedBeforeBackingStore = true;
        }
        startedHead = await git(request.workingDirectory, "rev-parse", "HEAD");
        return { schemaVersion: 1, executionId: "backend-q021" as never };
      },
      async status() {
        return "running";
      },
      async interactions() {
        return [];
      },
      async answer() {},
      async resume() {},
      async result() {
        throw new Error("result is not available while running");
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
      artifactsDirectory: join(context.root, "artifacts"),
      instanceId: "daemon-q021",
      ids: context.ids,
      clock: context.clock,
      resolveProfileChain: () => chain(),
      createIdentifierReader: (identifiers) =>
        createScopedSecretReader({ read: backingRead }, identifiers),
      pollMilliseconds: 60_000,
    });
    const originalHead = await git(context.source, "rev-parse", "HEAD");
    const started = await service.start({
      currentDirectory: context.source,
      prompt: "Keep the value in memory.",
      artifactPath: "reports/result.md",
      profileId: "primary",
      requestedIdentifiers: ["shared"],
    });
    expect(startedHead).toBe(originalHead);
    expect(deniedBeforeBackingStore).toBe(true);
    expect(backingRead).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(service.status(started.runId))).not.toContain(sensitiveText);
    service.stop();
    context.db.close();

    const generated = join(dirname(fileURLToPath(import.meta.url)), "../../contracts/generated");
    for (const file of [...(await allFiles(context.root)), ...(await allFiles(generated))]) {
      expect((await readFile(file)).includes(Buffer.from(sensitiveText))).toBe(false);
    }
  });

  it("falls back only after a typed terminal failure and imports only the fresh winner", async () => {
    const context = await fixture();
    const bytes = new TextEncoder().encode("# fallback result\n");
    const paths: string[] = [];
    const heads: string[] = [];
    let starts = 0;
    const backend: ExecutionBackendV7 = {
      async start(request) {
        starts += 1;
        paths.push(request.workingDirectory);
        heads.push(await git(request.workingDirectory, "rev-parse", "HEAD"));
        if (starts === 1) {
          throw {
            failure: {
              schemaVersion: 1,
              classification: "provider_throttled",
              phase: "start",
              code: "provider_throttled",
              message: "Provider capacity is temporarily unavailable.",
              fallbackEligible: true,
            },
          };
        }
        return { schemaVersion: 1, executionId: "backend-fallback" as never };
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
        return {
          schemaVersion: 5,
          status: "succeeded",
          summary: "Fallback completed.",
          artifacts: [
            {
              schemaVersion: 1,
              id: "artifact-fallback" as never,
              path: "reports/result.md",
              byteLength: bytes.byteLength,
              mediaType: "text/markdown",
            },
          ],
          telemetry: {},
        } as never;
      },
      async cancel() {},
      async artifacts() {
        return [
          {
            schemaVersion: 1,
            id: "artifact-fallback" as never,
            path: "reports/result.md",
            byteLength: bytes.byteLength,
            mediaType: "text/markdown",
          },
        ];
      },
      async readArtifact() {
        return bytes;
      },
      async *events() {},
    };
    const service = createSchedulingExecutionService({
      db: context.db,
      backend,
      workspaceService: context.workspaceService,
      artifactsDirectory: join(context.root, "artifacts"),
      instanceId: "daemon-q021",
      ids: context.ids,
      clock: context.clock,
      resolveProfileChain: () => fallbackChain(),
      createIdentifierReader: (identifiers) =>
        createScopedSecretReader({ read: async () => undefined }, identifiers),
      pollMilliseconds: 60_000,
    });
    const originalHead = await git(context.source, "rev-parse", "HEAD");
    const started = await service.start({
      currentDirectory: context.source,
      prompt: "Produce a fallback artifact.",
      artifactPath: "reports/result.md",
      profileId: "primary",
      requestedIdentifiers: ["shared"],
    });
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    expect(heads).toEqual([originalHead, originalHead]);
    expect(readExecutionAttempts(context.db, started.runId)).toMatchObject([
      { candidateIndex: 0, status: "failed", workspaceId: expect.any(String) },
      { candidateIndex: 1, status: "running", workspaceId: expect.any(String) },
    ]);

    await service.reconcile();
    expect(readExecutionAttempts(context.db, started.runId)).toMatchObject([
      { candidateIndex: 0, status: "failed" },
      { candidateIndex: 1, status: "succeeded" },
    ]);
    expect(readStageArtifacts(context.db, started.runId)).toMatchObject([
      { name: "reports/result.md", byteLength: bytes.byteLength },
    ]);
    service.stop();
    context.db.close();
  });
});
