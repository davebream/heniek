import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  CodebaseId,
  RepositoryId,
  WorkspaceConfiguration,
  WorkspaceId,
} from "@heniek/contracts";
import {
  commitStateChange,
  compareProjectionToReplay,
  openStateDatabase,
  runMigrations,
} from "@heniek/state";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceLeaseService } from "../src/lease.js";
import { createWorkspaceService } from "../src/service.js";
import { createWorkspaceStateStore } from "../src/state.js";
import type { OwnerLiveness } from "../src/types.js";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), "heniek-workspace-"));
  roots.push(root);
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  await mkdir(source);
  await git(root, "init", "--bare", remote);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "Heniek Test");
  await git(source, "config", "user.email", "heniek@example.invalid");
  await writeFile(join(source, ".gitignore"), ".env\n");
  await writeFile(join(source, "README.md"), "one\n");
  await writeFile(join(source, ".env"), "LOCAL=value\n", { mode: 0o600 });
  await git(source, "add", ".gitignore", "README.md");
  await git(source, "commit", "-m", "initial");
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "-u", "origin", "main");
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  return { root, source, remote, baseSha: await git(source, "rev-parse", "HEAD") };
}

function stateFixture(root: string, source: string) {
  let tick = 0;
  const clock = { nowIso: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString() };
  let id = 0;
  const ids = { next: (prefix: string) => `${prefix}_${++id}` };
  const database = openStateDatabase({ path: join(root, "state.sqlite"), clock, ids });
  runMigrations(database);
  const hash = "a".repeat(64);
  commitStateChange(database, {
    type: "codebase.registration_committed",
    payload: {
      registration: {
        codebaseId: "cb_test",
        configurationSha256: hash,
        instructionSnapshot: {},
        name: "test",
        repositories: [
          {
            defaultBranch: "main",
            defaultRemote: "origin",
            gitCommonDirectory: join(source, ".git"),
            name: "source",
            path: source,
            remotes: [],
            repositoryId: "repo_test",
          },
        ],
        rootPath: source,
        topologySha256: hash,
      },
    },
  });
  return { database, state: createWorkspaceStateStore(database), clock, ids };
}

function configuration(
  strategy: WorkspaceConfiguration["synchronization"]["strategy"] = "notify",
  setup: string | null = null,
): WorkspaceConfiguration {
  return {
    schemaVersion: 1,
    strategy: "managed-worktree",
    base: { remote: "origin", branch: "auto" },
    synchronization: { strategy },
    files: { copy: [".env"] },
    scripts: { setup },
    lease: { ttlMilliseconds: 60_000, renewEveryMilliseconds: 20_000 },
  };
}

function deadLiveness(): OwnerLiveness {
  return {
    currentBootWitness: () => "boot-1",
    witnessState: () => "dead",
  };
}

describe("managed single-repository workspace", () => {
  it("provisions from the verified remote SHA, copies files, and releases its lease", async () => {
    const fixture = await repositoryFixture();
    const state = stateFixture(fixture.root, fixture.source);
    const service = createWorkspaceService({
      state: state.state,
      workspacesDirectory: join(fixture.root, "workspaces"),
      logsDirectory: join(fixture.root, "logs"),
      clock: state.clock,
      ids: state.ids,
      liveness: deadLiveness(),
    });
    const manifest = await service.provision({
      workspaceId: "ws_test" as WorkspaceId,
      codebaseId: "cb_test" as CodebaseId,
      repositoryId: "repo_test" as RepositoryId,
      integrationBranch: "epic/test",
      owner: {
        ownerId: "operation-1",
        bootWitness: "boot-1",
        processWitnesses: [{ kind: "process", value: 999_999 }],
      },
      configuration: {
        ...configuration(),
        base: { remote: "origin", branch: "main" },
      },
    });
    expect(manifest.lifecycle).toBe("ready");
    expect(manifest.remoteBase.sha).toBe(fixture.baseSha);
    expect(manifest.checkoutHeadSha).toBe(fixture.baseSha);
    expect(await readFile(join(manifest.checkoutPath, ".env"), "utf8")).toBe("LOCAL=value\n");
    expect(state.state.lease(manifest.checkoutPath)?.state).toBe("released");
    expect(await git(manifest.checkoutPath, "branch", "--show-current")).toBe("epic/test");
    const replay = compareProjectionToReplay(state.database);
    expect(replay.status, JSON.stringify(replay.divergences, null, 2)).toBe("converged");
    state.database.close();
  });

  it("supervises setup, records a dirty checkout, and redacts credential-shaped output", async () => {
    const fixture = await repositoryFixture();
    const state = stateFixture(fixture.root, fixture.source);
    const service = createWorkspaceService({
      state: state.state,
      workspacesDirectory: join(fixture.root, "workspaces"),
      logsDirectory: join(fixture.root, "logs"),
      clock: state.clock,
      ids: state.ids,
      liveness: deadLiveness(),
    });
    const manifest = await service.provision({
      workspaceId: "ws_setup" as WorkspaceId,
      codebaseId: "cb_test" as CodebaseId,
      repositoryId: "repo_test" as RepositoryId,
      integrationBranch: "epic/setup",
      owner: {
        ownerId: "operation-setup",
        bootWitness: "boot-1",
        processWitnesses: [{ kind: "process", value: 999_999 }],
      },
      configuration: configuration(
        "notify",
        "printf 'to'; sleep 0.05; printf 'ken=do-not-store\\n'; printf 'generated\\n' > generated.txt",
      ),
    });
    expect(manifest.setup.state).toBe("succeeded");
    expect(manifest.cleanliness?.state).toBe("dirty");
    expect(manifest.setup.logPath).not.toBeNull();
    const log = await readFile(manifest.setup.logPath as string, "utf8");
    expect(log).toContain("token=[REDACTED]");
    expect(log).not.toContain("do-not-store");
    state.database.close();
  });

  it("notifies on remote advance without moving a dirty checkout", async () => {
    const fixture = await repositoryFixture();
    const state = stateFixture(fixture.root, fixture.source);
    const service = createWorkspaceService({
      state: state.state,
      workspacesDirectory: join(fixture.root, "workspaces"),
      logsDirectory: join(fixture.root, "logs"),
      clock: state.clock,
      ids: state.ids,
      liveness: deadLiveness(),
    });
    const input = {
      workspaceId: "ws_notify" as WorkspaceId,
      codebaseId: "cb_test" as CodebaseId,
      repositoryId: "repo_test" as RepositoryId,
      integrationBranch: "epic/notify",
      owner: {
        ownerId: "operation-1",
        bootWitness: "boot-1",
        processWitnesses: [{ kind: "process" as const, value: 999_999 }],
      },
      configuration: configuration(),
    };
    const manifest = await service.provision(input);
    await writeFile(join(manifest.checkoutPath, "dirty.txt"), "keep me\n");
    await writeFile(join(fixture.source, "README.md"), "two\n");
    await git(fixture.source, "add", "README.md");
    await git(fixture.source, "commit", "-m", "advance");
    await git(fixture.source, "push", "origin", "main");
    const result = await service.synchronize({
      workspaceId: input.workspaceId,
      owner: input.owner,
      configuration: configuration("notify"),
    });
    expect(result.outcome).toBe("notified");
    expect(result.cleanliness.state).toBe("dirty");
    expect(await readFile(join(manifest.checkoutPath, "dirty.txt"), "utf8")).toBe("keep me\n");
    expect(await git(manifest.checkoutPath, "rev-parse", "HEAD")).toBe(fixture.baseSha);
    state.database.close();
  });

  it("rebases local commits and recreates only pristine checkouts", async () => {
    const fixture = await repositoryFixture();
    const state = stateFixture(fixture.root, fixture.source);
    const service = createWorkspaceService({
      state: state.state,
      workspacesDirectory: join(fixture.root, "workspaces"),
      logsDirectory: join(fixture.root, "logs"),
      clock: state.clock,
      ids: state.ids,
      liveness: deadLiveness(),
    });
    const owner = {
      ownerId: "operation-sync",
      bootWitness: "boot-1",
      processWitnesses: [{ kind: "process" as const, value: 999_999 }],
    };
    const rebased = await service.provision({
      workspaceId: "ws_rebase" as WorkspaceId,
      codebaseId: "cb_test" as CodebaseId,
      repositoryId: "repo_test" as RepositoryId,
      integrationBranch: "epic/rebase",
      owner,
      configuration: configuration("rebase-before-build"),
    });
    await git(rebased.checkoutPath, "config", "user.name", "Heniek Test");
    await git(rebased.checkoutPath, "config", "user.email", "heniek@example.invalid");
    await writeFile(join(rebased.checkoutPath, "local.txt"), "local\n");
    await git(rebased.checkoutPath, "add", "local.txt");
    await git(rebased.checkoutPath, "commit", "-m", "local");
    await writeFile(join(fixture.source, "README.md"), "remote advance\n");
    await git(fixture.source, "add", "README.md");
    await git(fixture.source, "commit", "-m", "remote");
    await git(fixture.source, "push", "origin", "main");
    const rebaseResult = await service.synchronize({
      workspaceId: rebased.workspaceId,
      owner,
      configuration: configuration("rebase-before-build"),
    });
    expect(rebaseResult.outcome).toBe("rebased");
    expect(await readFile(join(rebased.checkoutPath, "local.txt"), "utf8")).toBe("local\n");

    const recreated = await service.provision({
      workspaceId: "ws_recreate" as WorkspaceId,
      codebaseId: "cb_test" as CodebaseId,
      repositoryId: "repo_test" as RepositoryId,
      integrationBranch: "epic/recreate",
      owner,
      configuration: configuration("recreate-before-build"),
    });
    await writeFile(join(fixture.source, "README.md"), "remote again\n");
    await git(fixture.source, "add", "README.md");
    await git(fixture.source, "commit", "-m", "remote again");
    await git(fixture.source, "push", "origin", "main");
    const recreateResult = await service.synchronize({
      workspaceId: recreated.workspaceId,
      owner,
      configuration: configuration("recreate-before-build"),
    });
    expect(recreateResult.outcome).toBe("recreated");
    expect(await readFile(join(recreated.checkoutPath, "README.md"), "utf8")).toBe(
      "remote again\n",
    );
    state.database.close();
  });
  it("returns a completed workspace idempotently without rerunning setup", async () => {
    const fixture = await repositoryFixture();
    const state = stateFixture(fixture.root, fixture.source);
    const service = createWorkspaceService({
      state: state.state,
      workspacesDirectory: join(fixture.root, "workspaces"),
      logsDirectory: join(fixture.root, "logs"),
      clock: state.clock,
      ids: state.ids,
      liveness: deadLiveness(),
    });
    const input = {
      workspaceId: "ws_idempotent" as WorkspaceId,
      codebaseId: "cb_test" as CodebaseId,
      repositoryId: "repo_test" as RepositoryId,
      integrationBranch: "epic/idempotent",
      owner: {
        ownerId: "operation-idempotent",
        bootWitness: "boot-1",
        processWitnesses: [{ kind: "process" as const, value: 999_999 }],
      },
      configuration: configuration("notify", "printf run >> setup-count.txt"),
    };
    const first = await service.provision(input);
    const second = await service.provision(input);
    expect(second).toEqual(first);
    expect(await readFile(join(first.checkoutPath, "setup-count.txt"), "utf8")).toBe("run");
    state.database.close();
  });

  it("records setup failure without storing output or command text and protects the log", async () => {
    const fixture = await repositoryFixture();
    const state = stateFixture(fixture.root, fixture.source);
    const service = createWorkspaceService({
      state: state.state,
      workspacesDirectory: join(fixture.root, "workspaces"),
      logsDirectory: join(fixture.root, "logs"),
      clock: state.clock,
      ids: state.ids,
      liveness: deadLiveness(),
    });
    const command = "printf 'password=hunter2\\n'; exit 7";
    const manifest = await service.provision({
      workspaceId: "ws_setup_failure" as WorkspaceId,
      codebaseId: "cb_test" as CodebaseId,
      repositoryId: "repo_test" as RepositoryId,
      integrationBranch: "epic/setup-failure",
      owner: {
        ownerId: "operation-setup-failure",
        bootWitness: "boot-1",
        processWitnesses: [{ kind: "process", value: 999_999 }],
      },
      configuration: configuration("notify", command),
    });
    expect(manifest.lifecycle).toBe("failed");
    expect(manifest.setup.exitCode).toBe(7);
    expect(JSON.stringify(manifest)).not.toContain(command);
    expect(JSON.stringify(manifest)).not.toContain("hunter2");
    const logPath = manifest.setup.logPath as string;
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(logPath, "utf8")).toContain("password=[REDACTED]");
    state.database.close();
  });

  it("rejects traversal before registering a workspace", async () => {
    const fixture = await repositoryFixture();
    const state = stateFixture(fixture.root, fixture.source);
    const service = createWorkspaceService({
      state: state.state,
      workspacesDirectory: join(fixture.root, "workspaces"),
      logsDirectory: join(fixture.root, "logs"),
      clock: state.clock,
      ids: state.ids,
      liveness: deadLiveness(),
    });
    const unsafe = {
      ...configuration(),
      files: { copy: ["../outside"] },
    } satisfies WorkspaceConfiguration;
    await expect(
      service.provision({
        workspaceId: "ws_traversal" as WorkspaceId,
        codebaseId: "cb_test" as CodebaseId,
        repositoryId: "repo_test" as RepositoryId,
        integrationBranch: "epic/traversal",
        owner: { ownerId: "operation-traversal", bootWitness: "boot-1", processWitnesses: [] },
        configuration: unsafe,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(state.state.manifest("ws_traversal" as WorkspaceId)).toBeUndefined();
    state.database.close();
  });

  it("rejects symlink copy sources without copying their targets", async () => {
    const fixture = await repositoryFixture();
    const state = stateFixture(fixture.root, fixture.source);
    const secretPath = join(fixture.root, "outside-secret");
    await writeFile(secretPath, "never-copy\n");
    await symlink(secretPath, join(fixture.source, "linked-secret"));
    const service = createWorkspaceService({
      state: state.state,
      workspacesDirectory: join(fixture.root, "workspaces"),
      logsDirectory: join(fixture.root, "logs"),
      clock: state.clock,
      ids: state.ids,
      liveness: deadLiveness(),
    });
    const symlinkConfiguration = {
      ...configuration(),
      files: { copy: ["linked-secret"] },
    } satisfies WorkspaceConfiguration;
    await expect(
      service.provision({
        workspaceId: "ws_symlink" as WorkspaceId,
        codebaseId: "cb_test" as CodebaseId,
        repositoryId: "repo_test" as RepositoryId,
        integrationBranch: "epic/symlink",
        owner: {
          ownerId: "operation-symlink",
          bootWitness: "boot-1",
          processWitnesses: [{ kind: "process", value: 999_999 }],
        },
        configuration: symlinkConfiguration,
      }),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
    const manifest = state.state.manifest("ws_symlink" as WorkspaceId);
    expect(manifest?.lifecycle).toBe("failed");
    await expect(
      readFile(join(manifest?.checkoutPath as string, "linked-secret")),
    ).rejects.toThrow();
    state.database.close();
  });

  it("refuses a conflicting integration branch without moving it", async () => {
    const fixture = await repositoryFixture();
    const state = stateFixture(fixture.root, fixture.source);
    await git(fixture.source, "branch", "epic/conflict", fixture.baseSha);
    const before = await git(fixture.source, "rev-parse", "epic/conflict");
    const service = createWorkspaceService({
      state: state.state,
      workspacesDirectory: join(fixture.root, "workspaces"),
      logsDirectory: join(fixture.root, "logs"),
      clock: state.clock,
      ids: state.ids,
      liveness: deadLiveness(),
    });
    await expect(
      service.provision({
        workspaceId: "ws_conflict" as WorkspaceId,
        codebaseId: "cb_test" as CodebaseId,
        repositoryId: "repo_test" as RepositoryId,
        integrationBranch: "epic/conflict",
        owner: { ownerId: "operation-conflict", bootWitness: "boot-1", processWitnesses: [] },
        configuration: configuration(),
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_CONFLICT" });
    expect(await git(fixture.source, "rev-parse", "epic/conflict")).toBe(before);
    state.database.close();
  });

  it("refuses recreate when local commits are ahead", async () => {
    const fixture = await repositoryFixture();
    const state = stateFixture(fixture.root, fixture.source);
    const service = createWorkspaceService({
      state: state.state,
      workspacesDirectory: join(fixture.root, "workspaces"),
      logsDirectory: join(fixture.root, "logs"),
      clock: state.clock,
      ids: state.ids,
      liveness: deadLiveness(),
    });
    const owner = {
      ownerId: "operation-ahead",
      bootWitness: "boot-1",
      processWitnesses: [{ kind: "process" as const, value: 999_999 }],
    };
    const manifest = await service.provision({
      workspaceId: "ws_ahead" as WorkspaceId,
      codebaseId: "cb_test" as CodebaseId,
      repositoryId: "repo_test" as RepositoryId,
      integrationBranch: "epic/ahead",
      owner,
      configuration: configuration("recreate-before-build"),
    });
    await git(manifest.checkoutPath, "config", "user.name", "Heniek Test");
    await git(manifest.checkoutPath, "config", "user.email", "heniek@example.invalid");
    await writeFile(join(manifest.checkoutPath, "ahead.txt"), "preserve\n");
    await git(manifest.checkoutPath, "add", "ahead.txt");
    await git(manifest.checkoutPath, "commit", "-m", "ahead");
    const aheadSha = await git(manifest.checkoutPath, "rev-parse", "HEAD");
    await writeFile(join(fixture.source, "README.md"), "advanced\n");
    await git(fixture.source, "add", "README.md");
    await git(fixture.source, "commit", "-m", "advance");
    await git(fixture.source, "push", "origin", "main");
    await expect(
      service.synchronize({
        workspaceId: manifest.workspaceId,
        owner,
        configuration: configuration("recreate-before-build"),
      }),
    ).rejects.toMatchObject({ code: "CHECKOUT_CHANGED" });
    expect(await git(manifest.checkoutPath, "rev-parse", "HEAD")).toBe(aheadSha);
    expect(await readFile(join(manifest.checkoutPath, "ahead.txt"), "utf8")).toBe("preserve\n");
    state.database.close();
  });

  it("requires an explicit recovery decision before retrying uncertain setup", async () => {
    const fixture = await repositoryFixture();
    const state = stateFixture(fixture.root, fixture.source);
    const service = createWorkspaceService({
      state: state.state,
      workspacesDirectory: join(fixture.root, "workspaces"),
      logsDirectory: join(fixture.root, "logs"),
      clock: state.clock,
      ids: state.ids,
      liveness: deadLiveness(),
    });
    const owner = {
      ownerId: "operation-recovery",
      bootWitness: "boot-1",
      processWitnesses: [{ kind: "process" as const, value: 999_999 }],
    };
    const recoveryConfiguration = configuration("notify", "printf retry >> recovery-count.txt");
    const input = {
      workspaceId: "ws_recovery" as WorkspaceId,
      codebaseId: "cb_test" as CodebaseId,
      repositoryId: "repo_test" as RepositoryId,
      integrationBranch: "epic/recovery",
      owner,
      configuration: recoveryConfiguration,
    };
    const completed = await service.provision(input);
    const uncertain = {
      ...completed,
      lifecycle: "provisioning" as const,
      phase: "setup-started" as const,
      setup: {
        ...completed.setup,
        state: "running" as const,
        finishedAt: null,
        exitCode: null,
        logPath: null,
        logSha256: null,
      },
      updatedAt: state.clock.nowIso(),
    };
    state.state.recordManifest(uncertain);
    const recoveryLease = service.leases.acquire({
      ...owner,
      workspaceId: uncertain.workspaceId,
      repositoryId: uncertain.repositoryId,
      checkoutPath: uncertain.checkoutPath,
      expectedSha: uncertain.checkoutHeadSha as string,
      ttlMilliseconds: recoveryConfiguration.lease.ttlMilliseconds,
    });
    service.leases.markRecoveryRequired(recoveryLease);
    await expect(service.provision(input)).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    const recovered = await service.recover({
      workspaceId: uncertain.workspaceId,
      owner,
      decision: "retry-setup",
      configuration: recoveryConfiguration,
    });
    expect(recovered.lifecycle).toBe("ready");
    expect(await readFile(join(recovered.checkoutPath, "recovery-count.txt"), "utf8")).toBe(
      "retryretry",
    );
    expect(state.state.lease(recovered.checkoutPath)?.state).toBe("released");
    state.database.close();
  });

  it("keeps the committed manifest and contention trace fixtures parseable", async () => {
    const fixtureDirectory = fileURLToPath(new URL("./fixtures/", import.meta.url));
    const manifest = JSON.parse(
      await readFile(join(fixtureDirectory, "workspace-provisioning-manifest.json"), "utf8"),
    ) as { schemaVersion: number; setup: { commandSha256: string }; copiedFiles: unknown[] };
    const trace = JSON.parse(
      await readFile(join(fixtureDirectory, "lease-contention-trace.json"), "utf8"),
    ) as { schemaVersion: number; events: { fencingRevision: number }[] };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.setup.commandSha256).toHaveLength(64);
    expect(manifest.copiedFiles).toHaveLength(1);
    expect(trace.schemaVersion).toBe(1);
    expect(trace.events.map((event) => event.fencingRevision)).toEqual([1, 1, 2, 1, 2]);
  });
});

describe("writer leases", () => {
  it("blocks live owners and increments the fence only after expiry and proven death", async () => {
    const fixture = await repositoryFixture();
    const state = stateFixture(fixture.root, fixture.source);
    const now = { value: Date.parse("2026-01-01T00:00:00.000Z") };
    const clock = { nowIso: () => new Date(now.value).toISOString() };
    let liveness: "alive" | "dead" | "unknown" = "alive";
    const service = createWorkspaceLeaseService({
      state: state.state,
      clock,
      ids: state.ids,
      liveness: {
        currentBootWitness: () => "boot-1",
        witnessState: () => liveness,
      },
    });
    const manifest = {
      schemaVersion: 1 as const,
      workspaceId: "ws_lease" as WorkspaceId,
      codebaseId: "cb_test" as CodebaseId,
      repositoryId: "repo_test" as RepositoryId,
      configurationSha256: "b".repeat(64),
      strategy: "managed-worktree" as const,
      lifecycle: "provisioning" as const,
      phase: "base-resolved" as const,
      workspaceRoot: join(fixture.root, "workspaces", "ws_lease"),
      checkoutPath: join(fixture.root, "workspaces", "ws_lease", "checkouts", "source"),
      integrationBranch: "epic/lease",
      remoteBase: {
        remote: "origin",
        branch: "main",
        sha: fixture.baseSha,
        observedSha: fixture.baseSha,
        fetchedAt: clock.nowIso(),
      },
      checkoutHeadSha: null,
      cleanliness: null,
      copiedFiles: [],
      setup: {
        state: "skipped" as const,
        commandSha256: null,
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        logPath: null,
        logSha256: null,
      },
      createdAt: clock.nowIso(),
      updatedAt: clock.nowIso(),
    };
    state.state.recordManifest(manifest);
    const first = service.acquire({
      workspaceId: manifest.workspaceId,
      repositoryId: manifest.repositoryId,
      checkoutPath: manifest.checkoutPath,
      expectedSha: fixture.baseSha,
      ownerId: "owner-a",
      bootWitness: "boot-1",
      processWitnesses: [{ kind: "process", value: 101 }],
      ttlMilliseconds: 1_000,
    });
    expect(
      service.acquire({
        workspaceId: manifest.workspaceId,
        repositoryId: manifest.repositoryId,
        checkoutPath: manifest.checkoutPath,
        expectedSha: fixture.baseSha,
        ownerId: "owner-a",
        bootWitness: "boot-1",
        processWitnesses: [{ kind: "process", value: 101 }],
        ttlMilliseconds: 1_000,
      }),
    ).toEqual(first);
    expect(() => service.assertCurrent(first, "f".repeat(40))).toThrow(/expected SHA/);
    expect(() =>
      service.acquire({
        workspaceId: manifest.workspaceId,
        repositoryId: manifest.repositoryId,
        checkoutPath: manifest.checkoutPath,
        expectedSha: fixture.baseSha,
        ownerId: "owner-b",
        bootWitness: "boot-1",
        processWitnesses: [{ kind: "process", value: 102 }],
        ttlMilliseconds: 1_000,
      }),
    ).toThrow(/live writer lease/);
    const stressOutcomes = Array.from({ length: 100 }, (_, index) => {
      try {
        service.acquire({
          workspaceId: manifest.workspaceId,
          repositoryId: manifest.repositoryId,
          checkoutPath: manifest.checkoutPath,
          expectedSha: fixture.baseSha,
          ownerId: `stress-owner-${index}`,
          bootWitness: "boot-1",
          processWitnesses: [{ kind: "process", value: 1_000 + index }],
          ttlMilliseconds: 1_000,
        });
        return "acquired";
      } catch {
        return "blocked";
      }
    });
    expect(stressOutcomes.filter((outcome) => outcome === "acquired")).toHaveLength(0);
    expect(stressOutcomes.filter((outcome) => outcome === "blocked")).toHaveLength(100);
    now.value += 2_000;
    expect(() =>
      service.acquire({
        workspaceId: manifest.workspaceId,
        repositoryId: manifest.repositoryId,
        checkoutPath: manifest.checkoutPath,
        expectedSha: fixture.baseSha,
        ownerId: "owner-b",
        bootWitness: "boot-1",
        processWitnesses: [{ kind: "process", value: 102 }],
        ttlMilliseconds: 1_000,
      }),
    ).toThrow(/still alive/);
    liveness = "unknown";
    expect(() =>
      service.acquire({
        workspaceId: manifest.workspaceId,
        repositoryId: manifest.repositoryId,
        checkoutPath: manifest.checkoutPath,
        expectedSha: fixture.baseSha,
        ownerId: "owner-b",
        bootWitness: "boot-1",
        processWitnesses: [{ kind: "process", value: 102 }],
        ttlMilliseconds: 1_000,
      }),
    ).toThrow(/cannot be proven/);
    liveness = "dead";
    const recovered = service.acquire({
      workspaceId: manifest.workspaceId,
      repositoryId: manifest.repositoryId,
      checkoutPath: manifest.checkoutPath,
      expectedSha: fixture.baseSha,
      ownerId: "owner-b",
      bootWitness: "boot-1",
      processWitnesses: [{ kind: "process", value: 102 }],
      ttlMilliseconds: 1_000,
    });
    expect(recovered.fencingRevision).toBe(first.fencingRevision + 1);
    expect(() => service.assertCurrent(first, fixture.baseSha)).toThrow(/no longer current/);
    state.database.close();
  });
});
