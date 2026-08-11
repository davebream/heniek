import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AnalysisPacketId,
  CodebaseId,
  CompositeWorkspaceProvisioningManifest,
  ExecutionTaskId,
  ExecutionTaskRevision,
  RepositoryId,
  TaskWorkspaceBinding,
  WorkspaceId,
  WorkspaceVariantId,
  WorkspaceWriterLease,
} from "@heniek/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeExecutionTaskRevisionSha256,
  createCompositeWorkspaceVariantService,
  createExecutionTaskWorkspaceService,
  type TaskBindingStore,
  type WorkspaceLeaseService,
} from "../src/index.js";

const exec = promisify(execFile);
const roots: string[] = [];
const now = "2026-08-12T10:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repositoryFixture(root: string, name: string) {
  const path = join(root, name);
  await exec("git", ["init", "-b", "main", path]);
  await exec("git", ["-C", path, "config", "user.name", "Heniek Test"]);
  await exec("git", ["-C", path, "config", "user.email", "heniek@example.invalid"]);
  await writeFile(join(path, "README.md"), `${name}\n`);
  await exec("git", ["-C", path, "add", "."]);
  await exec("git", ["-C", path, "commit", "-m", "initial"]);
  const sha = (await exec("git", ["-C", path, "rev-parse", "HEAD"])).stdout.trim();
  const common = (await exec("git", ["-C", path, "rev-parse", "--git-common-dir"])).stdout.trim();
  return {
    name,
    path,
    sha,
    common: join(path, common),
    repositoryId: `repo-${name}` as RepositoryId,
  };
}

function composite(
  root: string,
  workspaceId: WorkspaceId,
  repositories: Awaited<ReturnType<typeof repositoryFixture>>[],
): CompositeWorkspaceProvisioningManifest {
  return {
    schemaVersion: 1,
    workspaceId,
    codebaseId: "cb-test" as CodebaseId,
    configurationSha256: "a".repeat(64),
    lifecycle: "ready",
    workspaceRoot: join(root, "workspaces", workspaceId),
    repositories: repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
      name: repository.name,
      strategy: "managed-worktree",
      phase: "completed",
      checkoutPath: repository.path,
      gitCommonDirectory: repository.common,
      baseSha: repository.sha,
      checkoutHeadSha: repository.sha,
      materialization: {
        state: "succeeded",
        commandSha256: null,
        startedAt: now,
        finishedAt: now,
        exitCode: 0,
        signal: null,
        timedOut: false,
        logPath: null,
        logSha256: null,
        logTruncated: false,
      },
      setup: {
        state: "skipped",
        commandSha256: null,
        startedAt: null,
        finishedAt: now,
        exitCode: null,
        signal: null,
        timedOut: false,
        logPath: null,
        logSha256: null,
        logTruncated: false,
        blockedBy: [],
      },
      updatedAt: now,
    })),
    effectiveInstructions: null,
    createdAt: now,
    updatedAt: now,
  };
}

function leaseService(): WorkspaceLeaseService {
  const leases = new Map<string, WorkspaceWriterLease>();
  let sequence = 0;
  const current = (path: string) => leases.get(path);
  const required = (lease: WorkspaceWriterLease) => {
    const stored = current(lease.checkoutPath);
    if (stored?.leaseId !== lease.leaseId || stored.state !== "active") throw new Error("stale");
    return stored;
  };
  return {
    current,
    acquire(input) {
      const lease: WorkspaceWriterLease = {
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId,
        checkoutPath: input.checkoutPath,
        leaseId: `lease-${++sequence}`,
        ownerId: input.ownerId,
        bootWitness: input.bootWitness,
        processWitnesses: [...input.processWitnesses],
        expectedSha: input.expectedSha,
        fencingRevision: sequence,
        state: "active",
        acquiredAt: now,
        renewedAt: now,
        expiresAt: "2026-08-12T11:00:00.000Z",
        releasedAt: null,
      };
      leases.set(input.checkoutPath, lease);
      return lease;
    },
    renew: required,
    assertCurrent(lease, actualSha) {
      if (required(lease).expectedSha !== actualSha) throw new Error("unexpected HEAD");
    },
    advanceExpectedSha(lease, nextSha) {
      const next = { ...required(lease), expectedSha: nextSha };
      leases.set(lease.checkoutPath, next);
      return next;
    },
    release(lease) {
      const next = { ...required(lease), state: "released" as const, releasedAt: now };
      leases.set(lease.checkoutPath, next);
      return next;
    },
    markRecoveryRequired(lease) {
      const next = { ...required(lease), state: "recovery-required" as const };
      leases.set(lease.checkoutPath, next);
      return next;
    },
  };
}

function memoryBindings(): TaskBindingStore {
  const values = new Map<string, TaskWorkspaceBinding>();
  const key = (workspaceId: string, variantId: string) => `${workspaceId}:${variantId}`;
  return {
    async load(workspaceId, variantId) {
      return values.get(key(workspaceId, variantId));
    },
    async create(binding) {
      if (values.has(key(binding.workspaceId, binding.variantId)))
        throw new Error("duplicate binding");
      values.set(key(binding.workspaceId, binding.variantId), binding);
    },
  };
}

function task(input: {
  revision?: number;
  predecessor?: ExecutionTaskRevision;
  readSet: RepositoryId[];
  writeSet: RepositoryId[];
  excluded: RepositoryId[];
}): ExecutionTaskRevision {
  const value: Omit<ExecutionTaskRevision, "revisionSha256"> = {
    schemaVersion: 1,
    taskId: "task-identity" as ExecutionTaskId,
    revision: input.revision ?? 1,
    predecessorRevisionSha256: input.predecessor?.revisionSha256 ?? null,
    analysisPacketId: "analysis-test" as AnalysisPacketId,
    analysisPacketSha256: "b".repeat(64),
    objective: "Implement the identity feature across the actual repositories.",
    rationale: "The source API issue is a weak hint; identity is primary.",
    primaryRepositoryId: "repo-identity" as RepositoryId,
    readSet: input.readSet,
    writeSet: input.writeSet,
    excludedRepositories: input.excluded.map((repositoryId) => ({
      repositoryId,
      rationale: "No implementation change is required here.",
    })),
    dependencies: [],
    artifacts: [],
    verification: [],
    createdAt: now,
  };
  return { ...value, revisionSha256: computeExecutionTaskRevisionSha256(value) };
}

describe("Q037 execution-task workspace binding", () => {
  it("binds the wrong-issue-repository task and requires fresh leases after write-set expansion", async () => {
    const root = await mkdtemp(join(tmpdir(), "heniek-q037-task-"));
    roots.push(root);
    const api = await repositoryFixture(root, "api");
    const identity = await repositoryFixture(root, "identity");
    const web = await repositoryFixture(root, "web");
    const repositories = [api, identity, web];
    const workspaceId = "ws-task" as WorkspaceId;
    const leases = leaseService();
    const variants = createCompositeWorkspaceVariantService({
      workspacesDirectory: join(root, "workspaces"),
      clock: { nowIso: () => now },
      leases,
    });
    const service = createExecutionTaskWorkspaceService({
      variants,
      leases,
      bindings: memoryBindings(),
      clock: { nowIso: () => now },
    });
    const first = task({
      readSet: [api.repositoryId, identity.repositoryId],
      writeSet: [identity.repositoryId],
      excluded: [web.repositoryId],
    });
    const targets = repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
      targetRef: "refs/heads/main",
      expectedSha: repository.sha,
    }));
    const binding = await service.provision({
      workspaceId,
      variantId: "variant-first" as WorkspaceVariantId,
      composite: composite(root, workspaceId, repositories),
      targets,
      strategy: "manual",
      owner: {
        ownerId: "worker",
        bootWitness: "boot",
        processWitnesses: [{ kind: "process", value: 1 }],
      },
      leaseTtlMilliseconds: 60_000,
      task: first,
      codebaseRepositoryIds: repositories.map((repository) => repository.repositoryId),
    });
    expect(binding.repositories.map((repository) => repository.access)).toEqual([
      "read-only",
      "write",
    ]);
    expect(binding.repositories.find((repository) => repository.access === "write")?.leaseId).toBe(
      "lease-1",
    );

    const manifest = await variants.inspect(workspaceId, binding.variantId);
    const readOnly = manifest.repositories.find(
      (repository) => repository.repositoryId === api.repositoryId,
    );
    if (readOnly === undefined) throw new Error("read-only checkout missing");
    await writeFile(join(readOnly.checkoutPath, "undeclared.txt"), "unsafe\n");
    const inventory = await service.inventory(first, workspaceId, binding.variantId);
    expect(inventory).toMatchObject({
      classification: "replanning-required",
      undeclaredWriteRepositories: [api.repositoryId],
    });
    await expect(
      service.prepareIntegration(first, {
        schemaVersion: 1,
        workspaceId,
        variantId: binding.variantId,
        strategy: "manual",
        requestedAt: now,
      }),
    ).rejects.toMatchObject({ code: "UNDECLARED_WRITE" });

    const expanded = task({
      revision: 2,
      predecessor: first,
      readSet: [api.repositoryId, identity.repositoryId],
      writeSet: [api.repositoryId, identity.repositoryId],
      excluded: [web.repositoryId],
    });
    await expect(
      service.provision({
        workspaceId,
        variantId: binding.variantId,
        composite: composite(root, workspaceId, repositories),
        targets,
        strategy: "manual",
        owner: {
          ownerId: "worker",
          bootWitness: "boot",
          processWitnesses: [{ kind: "process", value: 1 }],
        },
        leaseTtlMilliseconds: 60_000,
        task: expanded,
        previousTaskRevision: first,
        codebaseRepositoryIds: repositories.map((repository) => repository.repositoryId),
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" });
    const expandedBinding = await service.provision({
      workspaceId,
      variantId: "variant-expanded" as WorkspaceVariantId,
      composite: composite(root, workspaceId, repositories),
      targets,
      strategy: "manual",
      owner: {
        ownerId: "worker",
        bootWitness: "boot",
        processWitnesses: [{ kind: "process", value: 1 }],
      },
      leaseTtlMilliseconds: 60_000,
      task: expanded,
      previousTaskRevision: first,
      codebaseRepositoryIds: repositories.map((repository) => repository.repositoryId),
    });
    expect(expandedBinding.repositories.map((repository) => repository.leaseId)).toEqual([
      "lease-2",
      "lease-3",
    ]);
  });

  it("rejects broken revision digests and incomplete exclusion coverage", () => {
    const api = "repo-api" as RepositoryId;
    const identity = "repo-identity" as RepositoryId;
    const invalid = task({ readSet: [identity], writeSet: [identity], excluded: [] });
    const leases = leaseService();
    const variants = {} as Parameters<typeof createExecutionTaskWorkspaceService>[0]["variants"];
    const service = createExecutionTaskWorkspaceService({
      variants,
      leases,
      bindings: memoryBindings(),
      clock: { nowIso: () => now },
    });
    expect(
      service.provision({
        workspaceId: "ws-invalid" as WorkspaceId,
        variantId: "variant-invalid" as WorkspaceVariantId,
        composite: {} as CompositeWorkspaceProvisioningManifest,
        targets: [],
        strategy: "manual",
        owner: {
          ownerId: "worker",
          bootWitness: null,
          processWitnesses: [{ kind: "process", value: 1 }],
        },
        leaseTtlMilliseconds: 60_000,
        task: { ...invalid, revisionSha256: "0".repeat(64) },
        codebaseRepositoryIds: [api, identity],
      }),
    ).rejects.toMatchObject({ code: "TASK_REVISION_INVALID" });
  });
});
