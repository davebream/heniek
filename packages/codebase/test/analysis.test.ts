import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AnalysisPacketId,
  CodebaseId,
  CompositeWorkspaceProvisioningManifest,
  RepositoryId,
  ResolvedCodebaseSnapshotV2,
  WorkspaceId,
} from "@heniek/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNodeRepositoryIndexPort,
  createWholeCodebaseAnalysisService,
  type RepositoryIndexPort,
} from "../src/index.js";

const exec = promisify(execFile);
const roots: string[] = [];
const now = "2026-08-12T10:00:00.000Z";
const digest = "a".repeat(64);
const head = "b".repeat(40);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function snapshot(): ResolvedCodebaseSnapshotV2 {
  return {
    schemaVersion: 2,
    codebaseId: "cb-test" as CodebaseId,
    registrationSha256: digest,
    configurationSha256: "c".repeat(64),
    resolvedAt: now,
    repositories: ["api", "identity", "web"].map((name) => ({
      repositoryId: `repo-${name}` as RepositoryId,
      name,
      path: `/source/${name}`,
      provisioning: { strategy: "current-checkout" as const },
      setup: { command: null, dependsOn: [], timeoutMilliseconds: 900_000 },
      provenance: [],
    })),
    basePins: [],
  };
}

function composite(): CompositeWorkspaceProvisioningManifest {
  return {
    schemaVersion: 1,
    workspaceId: "ws-test" as WorkspaceId,
    codebaseId: "cb-test" as CodebaseId,
    configurationSha256: "c".repeat(64),
    lifecycle: "ready",
    workspaceRoot: "/workspaces/ws-test",
    repositories: ["api", "identity", "web"].map((name) => ({
      repositoryId: `repo-${name}` as RepositoryId,
      name,
      strategy: "current-checkout" as const,
      phase: "completed" as const,
      checkoutPath: `/workspaces/ws-test/${name}`,
      gitCommonDirectory: `/source/${name}/.git`,
      baseSha: head,
      checkoutHeadSha: head,
      materialization: {
        state: "succeeded" as const,
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
        state: "skipped" as const,
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
    effectiveInstructions: {
      schemaVersion: 1,
      provider: "codex",
      generatedAt: now,
      readiness: "ready",
      reportSha256: "d".repeat(64),
      effectiveContentSha256: "e".repeat(64),
      sources: [],
      unresolvedConflicts: [],
    },
    createdAt: now,
    updatedAt: now,
  };
}

function service(index: RepositoryIndexPort) {
  return createWholeCodebaseAnalysisService({
    clock: { nowIso: () => now },
    ids: { next: () => "analysis-test" as AnalysisPacketId },
    index,
  });
}

describe("Q037 whole-Codebase analysis", () => {
  it("includes every repository while preserving the wrong issue repository as provenance", async () => {
    const calls: string[] = [];
    const packet = await service({
      async index(path, _sha, limits) {
        calls.push(path);
        return {
          ...limits,
          observedEntries: 0,
          observedBytes: 0,
          emittedEntries: 0,
          emittedBytes: 0,
          truncated: false,
          entries: [],
        };
      },
    }).build({
      sourceRepositoryId: "repo-api" as RepositoryId,
      snapshot: snapshot(),
      composite: composite(),
    });

    expect(packet.sourceRepositoryId).toBe("repo-api");
    expect(packet.repositories.map((repository) => repository.repositoryId)).toEqual([
      "repo-api",
      "repo-identity",
      "repo-web",
    ]);
    expect(calls).toEqual([
      "/workspaces/ws-test/api",
      "/workspaces/ws-test/identity",
      "/workspaces/ws-test/web",
    ]);
  });

  it("rejects configuration, topology, and checkout drift", async () => {
    const index: RepositoryIndexPort = {
      async index() {
        throw new Error("must not index");
      },
    };
    await expect(
      service(index).build({
        sourceRepositoryId: "repo-api" as RepositoryId,
        snapshot: snapshot(),
        composite: { ...composite(), configurationSha256: "f".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "CONFIGURATION_CHANGED" });
    await expect(
      service(index).build({
        sourceRepositoryId: "repo-missing" as RepositoryId,
        snapshot: snapshot(),
        composite: composite(),
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_REPOSITORY" });
    await expect(
      service(index).build({
        sourceRepositoryId: "repo-api" as RepositoryId,
        snapshot: snapshot(),
        composite: { ...composite(), repositories: composite().repositories.slice(1) },
      }),
    ).rejects.toMatchObject({ code: "TOPOLOGY_CHANGED" });
    await expect(
      service(index).build({
        sourceRepositoryId: "repo-api" as RepositoryId,
        snapshot: snapshot(),
        composite: {
          ...composite(),
          repositories: composite().repositories.map((repository) =>
            repository.repositoryId === "repo-api"
              ? { ...repository, strategy: "custom" as const }
              : repository,
          ),
        },
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_MUTATED" });
    await expect(
      service(index).build({
        sourceRepositoryId: "repo-api" as RepositoryId,
        snapshot: snapshot(),
        composite: {
          ...composite(),
          repositories: composite().repositories.map((repository) =>
            repository.repositoryId === "repo-api"
              ? { ...repository, checkoutHeadSha: "e".repeat(40) }
              : repository,
          ),
        },
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_MUTATED" });
  });

  it("bounds the real Git index by both entry count and encoded bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "heniek-q037-index-"));
    roots.push(root);
    await exec("git", ["init", "-b", "main", root]);
    await exec("git", ["-C", root, "config", "user.name", "Heniek Test"]);
    await exec("git", ["-C", root, "config", "user.email", "heniek@example.invalid"]);
    for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(root, name), name);
    await exec("git", ["-C", root, "add", "."]);
    await exec("git", ["-C", root, "commit", "-m", "fixture"]);
    const sha = (await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
    const port = createNodeRepositoryIndexPort();

    const itemBound = await port.index(root, sha, { maxEntries: 2, maxBytes: 1_048_576 });
    expect(itemBound).toMatchObject({ observedEntries: 3, emittedEntries: 2, truncated: true });
    expect(itemBound.entries.map((entry) => entry.path)).toEqual(["a.txt", "b.txt"]);

    const byteBound = await port.index(root, sha, { maxEntries: 10, maxBytes: 1 });
    expect(byteBound).toMatchObject({ observedEntries: 3, emittedEntries: 0, truncated: true });
  });
});
