import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  CodebaseId,
  CompositeWorkspaceProvisioningManifest,
  RepositoryId,
  VariantIntegrationTrace,
  WorkspaceId,
  WorkspaceVariantId,
  WorkspaceWriterLease,
} from "@heniek/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCompositeWorkspaceVariantService,
  type WorkspaceLeaseService,
} from "../src/index.js";

const exec = promisify(execFile);
const roots: string[] = [];

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is required`);
  return value;
}

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
    repositoryId: `repo_${name}` as RepositoryId,
  };
}

function composite(
  root: string,
  workspaceId: WorkspaceId,
  repositories: Awaited<ReturnType<typeof repositoryFixture>>[],
  strategy:
    | "managed-worktree"
    | "current-checkout"
    | "existing-checkout"
    | "custom" = "managed-worktree",
): CompositeWorkspaceProvisioningManifest {
  const now = "2026-08-10T12:00:00.000Z";
  return {
    schemaVersion: 1,
    workspaceId,
    codebaseId: "cb_test" as CodebaseId,
    configurationSha256: "a".repeat(64),
    lifecycle: "ready",
    workspaceRoot: join(root, "workspaces", workspaceId),
    repositories: repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
      name: repository.name,
      strategy,
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
  let next = 0;
  const current = (path: string) => leases.get(path);
  const assert = (lease: WorkspaceWriterLease) => {
    const stored = current(lease.checkoutPath);
    if (stored?.leaseId !== lease.leaseId || stored.state !== "active")
      throw new Error("stale lease");
    return stored;
  };
  return {
    current,
    acquire(input) {
      if (current(input.checkoutPath)?.state === "active") throw new Error("lease contended");
      const lease: WorkspaceWriterLease = {
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId,
        checkoutPath: input.checkoutPath,
        leaseId: `lease_${++next}`,
        ownerId: input.ownerId,
        bootWitness: input.bootWitness,
        processWitnesses: [...input.processWitnesses],
        expectedSha: input.expectedSha,
        fencingRevision: 1,
        state: "active",
        acquiredAt: "2026-08-10T12:00:00.000Z",
        renewedAt: "2026-08-10T12:00:00.000Z",
        expiresAt: "2026-08-10T13:00:00.000Z",
        releasedAt: null,
      };
      leases.set(input.checkoutPath, lease);
      return lease;
    },
    renew(lease) {
      return assert(lease);
    },
    assertCurrent(lease, actualSha) {
      if (assert(lease).expectedSha !== actualSha) throw new Error("unexpected sha");
    },
    advanceExpectedSha(lease, nextSha) {
      const advanced = { ...assert(lease), expectedSha: nextSha };
      leases.set(lease.checkoutPath, advanced);
      return advanced;
    },
    release(lease) {
      const released = {
        ...assert(lease),
        state: "released" as const,
        releasedAt: "2026-08-10T12:01:00.000Z",
      };
      leases.set(lease.checkoutPath, released);
      return released;
    },
    markRecoveryRequired(lease) {
      const marked = { ...assert(lease), state: "recovery-required" as const };
      leases.set(lease.checkoutPath, marked);
      return marked;
    },
  };
}

const owner = {
  ownerId: "test-owner",
  bootWitness: "boot-test",
  processWitnesses: [{ kind: "process" as const, value: process.pid }],
};

describe("Q036 composite workspace variants", () => {
  it.each(["current-checkout", "existing-checkout", "custom"] as const)(
    "isolates adopted %s repositories through local clones",
    async (strategy) => {
      const root = await mkdtemp(join(tmpdir(), `heniek-variant-${strategy}-`));
      roots.push(root);
      const repository = await repositoryFixture(root, "api");
      const workspaceId = `ws_${strategy}` as WorkspaceId;
      const service = createCompositeWorkspaceVariantService({
        workspacesDirectory: join(root, "workspaces"),
        clock: { nowIso: () => "2026-08-10T12:00:00.000Z" },
        leases: leaseService(),
      });
      const variant = await service.provision({
        workspaceId,
        variantId: `variant_${strategy}` as WorkspaceVariantId,
        composite: composite(root, workspaceId, [repository], strategy),
        writeRepositoryIds: [repository.repositoryId],
        targets: [
          {
            repositoryId: repository.repositoryId,
            targetRef: "refs/heads/main",
            expectedSha: repository.sha,
          },
        ],
        strategy: "manual",
        owner,
        leaseTtlMilliseconds: 60_000,
      });
      expect(variant.repositories[0]?.materialization).toBe("clone");
      expect(
        (
          await stat(join(required(variant.repositories[0], "repository").checkoutPath, ".git"))
        ).isDirectory(),
      ).toBe(true);
    },
  );

  it("creates isolated parallel variants and integrates through expected-SHA CAS", async () => {
    const root = await mkdtemp(join(tmpdir(), "heniek-variant-"));
    roots.push(root);
    const repository = await repositoryFixture(root, "api");
    const workspaceId = "ws_test" as WorkspaceId;
    const leases = leaseService();
    const traces: VariantIntegrationTrace[] = [];
    const service = createCompositeWorkspaceVariantService({
      workspacesDirectory: join(root, "workspaces"),
      clock: { nowIso: () => "2026-08-10T12:00:00.000Z" },
      leases,
      traces: { append: async (trace) => void traces.push(trace) },
    });
    const base = {
      workspaceId,
      composite: composite(root, workspaceId, [repository]),
      writeRepositoryIds: [repository.repositoryId],
      targets: [
        {
          repositoryId: repository.repositoryId,
          targetRef: "refs/heads/main",
          expectedSha: repository.sha,
        },
      ],
      strategy: "select-best" as const,
      owner,
      leaseTtlMilliseconds: 60_000,
    };
    const first = await service.provision({
      ...base,
      variantId: "variant_a" as WorkspaceVariantId,
    });
    const second = await service.provision({
      ...base,
      variantId: "variant_b" as WorkspaceVariantId,
    });
    const firstCheckout = required(first.repositories[0], "first repository").checkoutPath;
    const secondCheckout = required(second.repositories[0], "second repository").checkoutPath;
    await writeFile(join(firstCheckout, "feature.txt"), "first\n");
    await exec("git", ["-C", firstCheckout, "add", "."]);
    await exec("git", ["-C", firstCheckout, "commit", "-m", "feature"]);
    await expect(readFile(join(secondCheckout, "feature.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const candidate = (await exec("git", ["-C", firstCheckout, "rev-parse", "HEAD"])).stdout.trim();
    const currentLease = required(leases.current(firstCheckout), "first lease");
    leases.advanceExpectedSha(currentLease, candidate);
    const result = await service.publishIntegration({
      schemaVersion: 1,
      workspaceId,
      variantId: first.variantId,
      strategy: "select-best",
      requestedAt: "2026-08-10T12:00:00.000Z",
    });
    expect(result.classification).toBe("integrated");
    expect(
      (await exec("git", ["-C", repository.path, "rev-parse", "refs/heads/main"])).stdout.trim(),
    ).toBe(candidate);
    expect(traces.map((trace) => trace.phase)).toContain("ref-update-attempted");
  });

  it("detects read-only mutation before preparing any write integration", async () => {
    const root = await mkdtemp(join(tmpdir(), "heniek-variant-readonly-"));
    roots.push(root);
    const api = await repositoryFixture(root, "api");
    const web = await repositoryFixture(root, "web");
    const workspaceId = "ws_readonly" as WorkspaceId;
    const leases = leaseService();
    const service = createCompositeWorkspaceVariantService({
      workspacesDirectory: join(root, "workspaces"),
      clock: { nowIso: () => "2026-08-10T12:00:00.000Z" },
      leases,
    });
    const manifest = await service.provision({
      workspaceId,
      variantId: "variant_readonly" as WorkspaceVariantId,
      composite: composite(root, workspaceId, [api, web]),
      writeRepositoryIds: [api.repositoryId],
      targets: [api, web].map((repository) => ({
        repositoryId: repository.repositoryId,
        targetRef: "refs/heads/main",
        expectedSha: repository.sha,
      })),
      strategy: "manual",
      owner,
      leaseTtlMilliseconds: 60_000,
    });
    const readOnly = required(
      manifest.repositories.find((repository) => repository.repositoryId === web.repositoryId),
      "read-only repository",
    );
    await writeFile(join(readOnly.checkoutPath, "unexpected.txt"), "mutation\n");
    await expect(
      service.prepareIntegration({
        schemaVersion: 1,
        workspaceId,
        variantId: manifest.variantId,
        strategy: "manual",
        requestedAt: "2026-08-10T12:00:00.000Z",
      }),
    ).rejects.toThrow(/read-only execution mutated/);
  });

  it("reports truthful partial progress when a later repository target races", async () => {
    const root = await mkdtemp(join(tmpdir(), "heniek-variant-partial-"));
    roots.push(root);
    const api = await repositoryFixture(root, "api");
    const web = await repositoryFixture(root, "web");
    const workspaceId = "ws_partial" as WorkspaceId;
    const leases = leaseService();
    const service = createCompositeWorkspaceVariantService({
      workspacesDirectory: join(root, "workspaces"),
      clock: { nowIso: () => "2026-08-10T12:00:00.000Z" },
      leases,
    });
    const variant = await service.provision({
      workspaceId,
      variantId: "variant_partial" as WorkspaceVariantId,
      composite: composite(root, workspaceId, [api, web]),
      writeRepositoryIds: [api.repositoryId, web.repositoryId],
      targets: [api, web].map((repository) => ({
        repositoryId: repository.repositoryId,
        targetRef: "refs/heads/main",
        expectedSha: repository.sha,
      })),
      strategy: "synthesize",
      owner,
      leaseTtlMilliseconds: 60_000,
    });
    for (const repository of variant.repositories) {
      await writeFile(join(repository.checkoutPath, "feature.txt"), `${repository.name}\n`);
      await exec("git", ["-C", repository.checkoutPath, "add", "."]);
      await exec("git", [
        "-C",
        repository.checkoutPath,
        "commit",
        "-m",
        `feature ${repository.name}`,
      ]);
      const head = (
        await exec("git", ["-C", repository.checkoutPath, "rev-parse", "HEAD"])
      ).stdout.trim();
      leases.advanceExpectedSha(
        required(leases.current(repository.checkoutPath), "repository lease"),
        head,
      );
    }
    const request = {
      schemaVersion: 1 as const,
      workspaceId,
      variantId: variant.variantId,
      strategy: "synthesize" as const,
      requestedAt: "2026-08-10T12:00:00.000Z",
    };
    await service.prepareIntegration(request);
    await writeFile(join(web.path, "external.txt"), "external\n");
    await exec("git", ["-C", web.path, "add", "."]);
    await exec("git", ["-C", web.path, "commit", "-m", "external movement"]);
    const result = await service.publishIntegration(request);
    expect(result.classification).toBe("partial-progress");
    expect((await service.inspect(workspaceId, variant.variantId)).lifecycle).toBe(
      "partial-progress",
    );
    expect(
      (await exec("git", ["-C", api.path, "rev-parse", "refs/heads/main"])).stdout.trim(),
    ).not.toBe(api.sha);
  });
});
