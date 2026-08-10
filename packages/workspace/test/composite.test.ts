import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  CompositeWorkspaceProvisioningManifest,
  InstructionSnapshot,
  RegisteredCodebase,
  RepositoryId,
  ResolvedCodebaseSnapshotV2,
  WorkspaceId,
} from "@heniek/contracts";
import { describe, expect, it } from "vitest";
import {
  buildEffectiveInstructionReport,
  createCompositeWorkspaceService,
  validateCompositeSetupGraph,
} from "../src/composite.js";

const exec = promisify(execFile);
const NOW = "2026-08-10T12:00:00.000Z";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function repository(root: string, name: string) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await git(path, "init", "-b", "main");
  await git(path, "config", "user.email", "test@example.test");
  await git(path, "config", "user.name", "Test");
  await writeFile(join(path, "README.md"), `${name}\n`);
  await git(path, "add", ".");
  await git(path, "commit", "-m", "initial");
  return {
    path,
    head: await git(path, "rev-parse", "HEAD"),
    common: await realpath(join(path, ".git")),
  };
}

function instructions(sources: InstructionSnapshot["sources"] = []): InstructionSnapshot {
  return {
    schemaVersion: 1,
    snapshotSha256: "9".repeat(64),
    capturedAt: NOW,
    readiness: "ready",
    sources,
    diagnostics: [],
  };
}

describe("Q035 effective instruction merge", () => {
  it("filters providers, orders precedence, and detects changed content", () => {
    const content = { shared: "Shared.\n", codex: "Codex.\n", claude: "Claude.\n" };
    const source = (
      sourceId: keyof typeof content,
      kind: "shared" | "provider-native",
      provider: "codex" | "claude" | null,
      precedence: number,
    ): InstructionSnapshot["sources"][number] => ({
      sourceId,
      kind,
      provider,
      location: {
        kind: "repository",
        repositoryId: "repo-a" as RepositoryId,
        path: `${sourceId}.md`,
      },
      scope: "",
      precedence,
      contentSha256: digest(content[sourceId]),
    });
    const input = {
      snapshot: instructions([
        source("codex", "provider-native", "codex", 2),
        source("shared", "shared", null, 1),
        source("claude", "provider-native", "claude", 2),
      ]),
      provider: "codex" as const,
      contentBySourceId: content,
    };
    const report = buildEffectiveInstructionReport(input, NOW);
    expect(report.sources.map((entry) => entry.sourceId)).toEqual(["shared", "codex"]);
    expect(report.readiness).toBe("ready");
    expect(() =>
      buildEffectiveInstructionReport(
        { ...input, contentBySourceId: { ...content, shared: "changed" } },
        NOW,
      ),
    ).toThrow(/changed after discovery/);
  });

  it("blocks only conflicts whose sources apply to the selected provider", () => {
    const codex = "mode: safe\n";
    const shared = "mode: fast\n";
    const claude = "mode: careful\n";
    const source = (sourceId: string, provider: "codex" | "claude" | null, value: string) => ({
      sourceId,
      kind: provider === null ? ("shared" as const) : ("provider-native" as const),
      provider,
      location: {
        kind: "repository" as const,
        repositoryId: "repo-a" as RepositoryId,
        path: `${sourceId}.md`,
      },
      scope: "",
      precedence: provider === null ? 1 : 2,
      contentSha256: digest(value),
    });
    const snapshot = instructions([
      source("shared", null, shared),
      source("codex", "codex", codex),
      source("claude", "claude", claude),
    ]);
    snapshot.diagnostics.push({
      schemaVersion: 1,
      code: "INSTRUCTION_VALUE_CONFLICT",
      classification: "incompatible",
      message: "Material conflict.",
      topic: "mode",
      anchors: [
        { sourceId: "shared", startLine: 1, endLine: 1 },
        { sourceId: "codex", startLine: 1, endLine: 1 },
      ],
    });
    snapshot.diagnostics.push({
      schemaVersion: 1,
      code: "INSTRUCTION_VALUE_CONFLICT",
      classification: "incompatible",
      message: "Other provider conflict.",
      topic: "mode",
      anchors: [
        { sourceId: "shared", startLine: 1, endLine: 1 },
        { sourceId: "claude", startLine: 1, endLine: 1 },
      ],
    });
    const report = buildEffectiveInstructionReport(
      { snapshot, provider: "codex", contentBySourceId: { shared, codex, claude } },
      NOW,
    );
    expect(report.readiness).toBe("blocked");
    expect(report.unresolvedConflicts).toHaveLength(1);
    expect(report.unresolvedConflicts[0]?.anchors[1]?.sourceId).toBe("codex");
  });
});

function registration(
  root: string,
  rows: readonly { id: string; name: string; path: string; common: string }[],
): RegisteredCodebase {
  return {
    schemaVersion: 1,
    codebaseId: "cb-q035" as RegisteredCodebase["codebaseId"],
    name: "fixture",
    rootPath: root,
    sourceRepositoryPath: null,
    topologySha256: "1".repeat(64),
    repositories: rows.map((row) => ({
      repositoryId: row.id as RepositoryId,
      name: row.name,
      path: row.path,
      gitCommonDirectory: row.common,
      remotes: [],
      defaultRemote: null,
      defaultBranch: "main",
    })),
    instructionSnapshot: instructions(),
    diagnostics: [],
    readiness: "ready",
    registeredAt: NOW,
    configurationSha256: "2".repeat(64),
  };
}

describe("Q035 composite provisioning", () => {
  it("provisions all strategies, restarts, and isolates setup failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "heniek-q035-"));
    const managed = await repository(root, "managed-source");
    const current = await repository(root, "current-source");
    const existing = await repository(root, "existing-source");
    const custom = await repository(root, "custom-source");
    const existingCheckout = join(root, "existing-checkout");
    await git(existing.path, "worktree", "add", existingCheckout, existing.head);
    const order = join(root, "order.txt");
    const ids = ["repo-managed", "repo-current", "repo-existing", "repo-custom"] as const;
    const registered = registration(root, [
      { id: ids[0], name: "managed", ...managed },
      { id: ids[1], name: "current", ...current },
      { id: ids[2], name: "existing", ...existing },
      { id: ids[3], name: "custom", ...custom },
    ]);
    const customTarget = join(root, "workspaces", "ws-q035", "checkouts", "custom");
    const snapshot: ResolvedCodebaseSnapshotV2 = {
      schemaVersion: 2,
      codebaseId: registered.codebaseId,
      registrationSha256: "2".repeat(64),
      configurationSha256: "3".repeat(64),
      resolvedAt: NOW,
      repositories: [
        {
          repositoryId: ids[0] as RepositoryId,
          name: "managed",
          path: managed.path,
          provisioning: {
            strategy: "managed-worktree",
            remote: "origin",
            requestedRef: "main",
            synchronization: "notify",
          },
          setup: {
            command: `printf managed >> '${order}'`,
            dependsOn: [],
            timeoutMilliseconds: 5000,
          },
          provenance: [],
        },
        {
          repositoryId: ids[1] as RepositoryId,
          name: "current",
          path: current.path,
          provisioning: { strategy: "current-checkout" },
          setup: {
            command: "exit 7",
            dependsOn: [ids[0] as RepositoryId],
            timeoutMilliseconds: 5000,
          },
          provenance: [],
        },
        {
          repositoryId: ids[2] as RepositoryId,
          name: "existing",
          path: existing.path,
          provisioning: { strategy: "existing-checkout", checkoutPath: existingCheckout },
          setup: {
            command: `printf existing >> '${order}'`,
            dependsOn: [],
            timeoutMilliseconds: 5000,
          },
          provenance: [],
        },
        {
          repositoryId: ids[3] as RepositoryId,
          name: "custom",
          path: custom.path,
          provisioning: {
            strategy: "custom",
            command: `git -C '${custom.path}' worktree add '${customTarget}' '${custom.head}'`,
          },
          setup: {
            command: `printf custom >> '${order}'`,
            dependsOn: [ids[1] as RepositoryId],
            timeoutMilliseconds: 5000,
          },
          provenance: [],
        },
      ],
      basePins: [
        {
          schemaVersion: 1,
          repositoryId: ids[0] as RepositoryId,
          requestedRef: "main",
          resolvedRef: "refs/heads/main",
          remote: "origin",
          fetchedRemoteIdentity: "ssh://example.test/managed",
          commitSha: managed.head,
          resolvedAt: NOW,
          synchronization: "notify",
        },
      ],
    };
    const service = createCompositeWorkspaceService({
      workspacesDirectory: join(root, "workspaces"),
      logsDirectory: join(root, "logs"),
      clock: { nowIso: () => NOW },
    });
    const input = {
      workspaceId: "ws-q035" as WorkspaceId,
      snapshot,
      registration: registered,
      integrationBranches: { "repo-managed": "epic/q035" },
      instructions: { snapshot: instructions(), contentBySourceId: {}, provider: "codex" as const },
    };
    const manifest = await service.provision(input);
    expect(JSON.stringify(manifest)).not.toContain("git -C");
    expect(manifest.lifecycle).toBe("partial-failure");
    expect(manifest.repositories.find((entry) => entry.repositoryId === ids[1])?.setup.state).toBe(
      "failed",
    );
    expect(
      manifest.repositories.find((entry) => entry.repositoryId === ids[3])?.setup,
    ).toMatchObject({ state: "blocked", blockedBy: [ids[1]] });
    expect(manifest.repositories.find((entry) => entry.repositoryId === ids[2])?.setup.state).toBe(
      "succeeded",
    );
    expect((await service.provision(input)).repositories).toEqual(manifest.repositories);
  }, 30_000);

  it("bounds and redacts setup logs", async () => {
    const root = await mkdtemp(join(tmpdir(), "heniek-q035-log-"));
    const source = await repository(root, "source");
    const repositoryId = "repo-log" as RepositoryId;
    const registered = registration(root, [{ id: repositoryId, name: "log", ...source }]);
    const snapshot: ResolvedCodebaseSnapshotV2 = {
      schemaVersion: 2,
      codebaseId: registered.codebaseId,
      registrationSha256: "2".repeat(64),
      configurationSha256: "3".repeat(64),
      resolvedAt: NOW,
      repositories: [
        {
          repositoryId,
          name: "log",
          path: source.path,
          provisioning: { strategy: "current-checkout" },
          setup: {
            command: "printf 'token='; sleep 0.1; printf '%01000d\\n' 0; yes x | head -c 1100000",
            dependsOn: [],
            timeoutMilliseconds: 5000,
          },
          provenance: [],
        },
      ],
      basePins: [],
    };
    const service = createCompositeWorkspaceService({
      workspacesDirectory: join(root, "workspaces"),
      logsDirectory: join(root, "logs"),
      clock: { nowIso: () => NOW },
    });
    const manifest = await service.provision({
      workspaceId: "ws-log" as WorkspaceId,
      snapshot,
      registration: registered,
      integrationBranches: {},
      instructions: { snapshot: instructions(), contentBySourceId: {}, provider: "codex" },
    });
    const logPath = manifest.repositories[0]?.setup.logPath as string;
    const log = await readFile(logPath, "utf8");
    expect(log).not.toContain("00000000");
    expect(log).toContain("[REDACTED]");
    expect(log).toContain("output truncated");
    expect((await stat(logPath)).size).toBeLessThanOrEqual(1_048_576);
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
  }, 30_000);

  it("times out setup and records the isolated failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "heniek-q035-timeout-"));
    const source = await repository(root, "source");
    const repositoryId = "repo-timeout" as RepositoryId;
    const registered = registration(root, [{ id: repositoryId, name: "timeout", ...source }]);
    const snapshot: ResolvedCodebaseSnapshotV2 = {
      schemaVersion: 2,
      codebaseId: registered.codebaseId,
      registrationSha256: "2".repeat(64),
      configurationSha256: "3".repeat(64),
      resolvedAt: NOW,
      repositories: [
        {
          repositoryId,
          name: "timeout",
          path: source.path,
          provisioning: { strategy: "current-checkout" },
          setup: { command: "sleep 10", dependsOn: [], timeoutMilliseconds: 1000 },
          provenance: [],
        },
      ],
      basePins: [],
    };
    const service = createCompositeWorkspaceService({
      workspacesDirectory: join(root, "workspaces"),
      logsDirectory: join(root, "logs"),
      clock: { nowIso: () => NOW },
    });
    const manifest = await service.provision({
      workspaceId: "ws-timeout" as WorkspaceId,
      snapshot,
      registration: registered,
      integrationBranches: {},
      instructions: { snapshot: instructions(), contentBySourceId: {}, provider: "codex" },
    });
    expect(manifest.lifecycle).toBe("partial-failure");
    expect(manifest.repositories[0]?.setup).toMatchObject({ state: "timed-out", timedOut: true });
  }, 10_000);

  it("reconciles a managed worktree created before its phase was recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "heniek-q035-restart-"));
    const source = await repository(root, "source");
    const repositoryId = "repo-restart" as RepositoryId;
    const registered = registration(root, [{ id: repositoryId, name: "restart", ...source }]);
    const workspaceId = "ws-restart" as WorkspaceId;
    const workspaceRoot = join(root, "workspaces", workspaceId);
    const target = join(workspaceRoot, "checkouts", "restart");
    await mkdir(join(workspaceRoot, "checkouts"), { recursive: true });
    await git(source.path, "worktree", "add", "-b", "epic/restart", target, source.head);
    const snapshot: ResolvedCodebaseSnapshotV2 = {
      schemaVersion: 2,
      codebaseId: registered.codebaseId,
      registrationSha256: "2".repeat(64),
      configurationSha256: "3".repeat(64),
      resolvedAt: NOW,
      repositories: [
        {
          repositoryId,
          name: "restart",
          path: source.path,
          provisioning: {
            strategy: "managed-worktree",
            remote: "origin",
            requestedRef: "main",
            synchronization: "notify",
          },
          setup: { command: null, dependsOn: [], timeoutMilliseconds: 900000 },
          provenance: [],
        },
      ],
      basePins: [
        {
          schemaVersion: 1,
          repositoryId,
          requestedRef: "main",
          resolvedRef: "refs/heads/main",
          remote: "origin",
          fetchedRemoteIdentity: "ssh://example.test/restart",
          commitSha: source.head,
          resolvedAt: NOW,
          synchronization: "notify",
        },
      ],
    };
    let saved: CompositeWorkspaceProvisioningManifest = {
      schemaVersion: 1,
      workspaceId,
      codebaseId: registered.codebaseId,
      configurationSha256: snapshot.configurationSha256,
      lifecycle: "provisioning",
      workspaceRoot,
      repositories: [
        {
          repositoryId,
          name: "restart",
          strategy: snapshot.repositories[0]?.provisioning as never,
          phase: "materializing",
          checkoutPath: null,
          gitCommonDirectory: null,
          baseSha: source.head,
          checkoutHeadSha: null,
          materialization: {
            state: "running",
            commandSha256: null,
            startedAt: NOW,
            finishedAt: null,
            exitCode: null,
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
            finishedAt: null,
            exitCode: null,
            signal: null,
            timedOut: false,
            logPath: null,
            logSha256: null,
            logTruncated: false,
            blockedBy: [],
          },
          updatedAt: NOW,
        },
      ],
      effectiveInstructions: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const service = createCompositeWorkspaceService({
      workspacesDirectory: join(root, "workspaces"),
      logsDirectory: join(root, "logs"),
      clock: { nowIso: () => NOW },
      store: {
        load: async () => saved,
        record: async (manifest) => {
          saved = manifest;
        },
      },
    });
    const manifest = await service.provision({
      workspaceId,
      snapshot,
      registration: registered,
      integrationBranches: { [repositoryId]: "epic/restart" },
      instructions: { snapshot: instructions(), contentBySourceId: {}, provider: "codex" },
    });
    expect(manifest.lifecycle).toBe("ready");
    expect(manifest.repositories[0]).toMatchObject({
      phase: "completed",
      checkoutPath: target,
      checkoutHeadSha: source.head,
    });
  }, 15_000);

  it("rejects missing and cyclic setup dependencies", () => {
    const base = {
      schemaVersion: 2 as const,
      codebaseId: "cb-graph" as ResolvedCodebaseSnapshotV2["codebaseId"],
      registrationSha256: "1".repeat(64),
      configurationSha256: "2".repeat(64),
      resolvedAt: NOW,
      basePins: [],
    };
    const repo = (id: string, dependsOn: string[]) => ({
      repositoryId: id as RepositoryId,
      name: id,
      path: `/tmp/${id}`,
      provisioning: { strategy: "current-checkout" as const },
      setup: { command: null, dependsOn: dependsOn as RepositoryId[], timeoutMilliseconds: 900000 },
      provenance: [],
    });
    expect(() =>
      validateCompositeSetupGraph({ ...base, repositories: [repo("a", ["missing"])] }),
    ).toThrow(/not part/);
    expect(() =>
      validateCompositeSetupGraph({ ...base, repositories: [repo("a", ["b"]), repo("b", ["a"])] }),
    ).toThrow(/cycle/);
  });
});
