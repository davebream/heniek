import { createHash } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";
import type {
  WorkspaceConfiguration,
  WorkspaceProvisioningManifest,
  WorkspaceSynchronizationResult,
  WorkspaceWriterLease,
} from "@heniek/contracts";
import type { CodebaseRow, RepositoryRow } from "@heniek/state";
import { WorkspaceError } from "./errors.js";
import { createWorkspaceLeaseService, type LeaseClock, type LeaseIdSource } from "./lease.js";
import {
  createNodeOwnerLiveness,
  createSetupProcess,
  ensurePrivateParent,
  nodeFileSystem,
  readStableRegularFile,
  runCommand,
  scrubbedSetupEnvironment,
  sha256File,
  sha256Text,
} from "./runtime/node.js";
import type { WorkspaceStateStore } from "./state.js";
import type {
  OwnerLiveness,
  ProvisionWorkspaceInput,
  RecoverWorkspaceInput,
  SynchronizeWorkspaceInput,
  WorkspaceService,
} from "./types.js";

export const DEFAULT_LEASE_TTL_MILLISECONDS = 60_000;
export const DEFAULT_LEASE_RENEW_EVERY_MILLISECONDS = 20_000;

export interface CreateWorkspaceServiceInput {
  readonly state: WorkspaceStateStore;
  readonly workspacesDirectory: string;
  readonly logsDirectory: string;
  readonly clock: LeaseClock;
  readonly ids: LeaseIdSource;
  readonly liveness?: OwnerLiveness;
}

interface ResolvedBase {
  readonly remote: string;
  readonly branch: string;
  readonly sha: string;
  readonly fetchedAt: string;
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortedValue(entry)]),
  );
}

function configurationSha256(configuration: WorkspaceConfiguration): string {
  return sha256Text(JSON.stringify(sortedValue(configuration)));
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new WorkspaceError("INVALID_PATH", `${label} is not a safe path component.`);
  }
  return value;
}

function validateConfiguration(configuration: WorkspaceConfiguration): void {
  if (
    configuration.lease.ttlMilliseconds < 1 ||
    configuration.lease.renewEveryMilliseconds < 1 ||
    configuration.lease.renewEveryMilliseconds * 2 >= configuration.lease.ttlMilliseconds
  ) {
    throw new WorkspaceError(
      "INVALID_CONFIGURATION",
      "Lease renewal must be positive and less than half of the TTL.",
    );
  }
  for (const path of configuration.files.copy) {
    const canonical = normalize(path);
    if (
      isAbsolute(path) ||
      canonical === ".." ||
      canonical.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      canonical.includes("\0")
    ) {
      throw new WorkspaceError(
        "INVALID_PATH",
        "Copied files must be relative and remain in-repository.",
      );
    }
  }
}

async function assertDirectoryIfPresent(path: string): Promise<void> {
  const value = await nodeFileSystem.lstat(path).catch(() => undefined);
  if (value !== undefined && (!value.isDirectory() || value.isSymbolicLink())) {
    throw new WorkspaceError(
      "INVALID_PATH",
      "Workspace path contains a symlink or non-directory component.",
    );
  }
}

async function assertRegularFileParents(root: string, relativePath: string): Promise<void> {
  await assertDirectoryIfPresent(root);
  let current = root;
  for (const component of normalize(relativePath).split(/[\\/]/).slice(0, -1)) {
    current = join(current, component);
    await assertDirectoryIfPresent(current);
  }
}

async function git(cwd: string, args: readonly string[], code: string): Promise<string> {
  const result = await runCommand("git", args, cwd);
  if (result.exitCode !== 0) throw new WorkspaceError("WORKSPACE_CONFLICT", `${code}.`);
  return result.stdout;
}

async function resolveBranch(repositoryPath: string, remote: string, requested: string) {
  if (requested !== "auto") return requested;
  const head = await runCommand("git", ["ls-remote", "--symref", remote, "HEAD"], repositoryPath);
  if (head.exitCode === 0) {
    const match = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m.exec(head.stdout);
    if (match?.[1] !== undefined) return match[1];
  }
  for (const candidate of ["main", "master"]) {
    const probe = await runCommand(
      "git",
      ["ls-remote", "--exit-code", remote, `refs/heads/${candidate}`],
      repositoryPath,
    );
    if (probe.exitCode === 0) return candidate;
  }
  throw new WorkspaceError(
    "REMOTE_BRANCH_NOT_FOUND",
    "Remote HEAD, main, and master are unavailable.",
  );
}

async function resolveRemoteBase(
  repositoryPath: string,
  configuration: WorkspaceConfiguration,
  clock: LeaseClock,
): Promise<ResolvedBase> {
  const remote = configuration.base.remote;
  const remoteProbe = await runCommand("git", ["remote", "get-url", remote], repositoryPath);
  if (remoteProbe.exitCode !== 0)
    throw new WorkspaceError("REMOTE_NOT_FOUND", "Configured remote is unavailable.");
  const branch = await resolveBranch(repositoryPath, remote, configuration.base.branch);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fetch = await runCommand(
      "git",
      ["fetch", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
      repositoryPath,
    );
    if (fetch.exitCode !== 0) {
      throw new WorkspaceError(
        "REMOTE_BRANCH_NOT_FOUND",
        "Configured remote branch could not be fetched.",
      );
    }
    const fetched = await git(
      repositoryPath,
      ["rev-parse", "--verify", `refs/remotes/${remote}/${branch}^{commit}`],
      "fetched base could not be resolved",
    );
    const advertised = await runCommand(
      "git",
      ["ls-remote", "--exit-code", remote, `refs/heads/${branch}`],
      repositoryPath,
    );
    const advertisedSha = advertised.stdout.split(/\s+/)[0];
    if (advertised.exitCode === 0 && advertisedSha === fetched) {
      return { remote, branch, sha: fetched, fetchedAt: clock.nowIso() };
    }
  }
  throw new WorkspaceError(
    "REMOTE_MOVED_DURING_FETCH",
    "Remote branch changed during three consecutive verification attempts.",
    true,
  );
}

async function checkoutHead(checkoutPath: string): Promise<string> {
  return git(checkoutPath, ["rev-parse", "HEAD^{commit}"], "checkout HEAD could not be resolved");
}

async function cleanliness(checkoutPath: string) {
  const result = await runCommand(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
    checkoutPath,
  );
  if (result.exitCode !== 0)
    throw new WorkspaceError("WORKSPACE_CONFLICT", "Checkout status failed.");
  const entries = result.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => ({ status: entry.slice(0, 2), path: entry.slice(3) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const body = JSON.stringify(entries);
  return {
    state: entries.length === 0 ? ("clean" as const) : ("dirty" as const),
    entries,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

async function copyConfiguredFiles(
  repositoryPath: string,
  checkoutPath: string,
  paths: readonly string[],
  assertMutation: () => Promise<void>,
) {
  const copied: { path: string; sha256: string; byteLength: number }[] = [];
  for (const relativePath of [...paths].sort()) {
    const source = join(repositoryPath, relativePath);
    const target = join(checkoutPath, relativePath);
    await assertRegularFileParents(repositoryPath, relativePath);
    await assertRegularFileParents(checkoutPath, relativePath);
    const sourceSnapshot = await readStableRegularFile(source).catch(() => undefined);
    if (sourceSnapshot === undefined) {
      throw new WorkspaceError(
        "INVALID_PATH",
        `Copy source is not a regular file: ${relativePath}`,
      );
    }
    const targetStat = await nodeFileSystem.lstat(target).catch(() => undefined);
    if (targetStat !== undefined) {
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
        throw new WorkspaceError(
          "WORKSPACE_CONFLICT",
          `Copy target is not a regular file: ${relativePath}`,
        );
      }
      const targetDigest = await sha256File(target);
      if (targetDigest.sha256 !== sourceSnapshot.sha256) {
        throw new WorkspaceError(
          "WORKSPACE_CONFLICT",
          `Copy target differs on retry: ${relativePath}`,
        );
      }
    } else {
      await assertMutation();
      await ensurePrivateParent(target);
      await assertMutation();
      await nodeFileSystem.writeFile(target, sourceSnapshot.content, {
        flag: "wx",
        mode: (sourceSnapshot.mode & 0o100) | 0o600,
      });
      await assertMutation();
      await nodeFileSystem.chmod(target, (sourceSnapshot.mode & 0o100) | 0o600);
    }
    const currentSource = await readStableRegularFile(source).catch(() => undefined);
    if (
      currentSource === undefined ||
      currentSource.device !== sourceSnapshot.device ||
      currentSource.inode !== sourceSnapshot.inode ||
      currentSource.sha256 !== sourceSnapshot.sha256
    ) {
      throw new WorkspaceError("WORKSPACE_CONFLICT", `Copy source changed: ${relativePath}`);
    }
    copied.push({
      path: relativePath,
      sha256: sourceSnapshot.sha256,
      byteLength: sourceSnapshot.byteLength,
    });
  }
  return copied;
}

function stableEnvironment(
  manifest: WorkspaceProvisioningManifest,
  codebaseRoot: string,
): Record<string, string> {
  return scrubbedSetupEnvironment({
    HENIEK_WORKSPACE_ID: manifest.workspaceId,
    HENIEK_WORKSPACE_ROOT: manifest.workspaceRoot,
    HENIEK_CODEBASE_ROOT: codebaseRoot,
    HENIEK_REPOSITORY_PATH: manifest.checkoutPath,
    HENIEK_BASE_REMOTE: manifest.remoteBase.remote,
    HENIEK_BASE_BRANCH: manifest.remoteBase.branch,
    HENIEK_BASE_SHA: manifest.remoteBase.sha,
    HENIEK_INTEGRATION_BRANCH: manifest.integrationBranch,
  });
}

export function createWorkspaceService(deps: CreateWorkspaceServiceInput): WorkspaceService {
  const liveness = deps.liveness ?? createNodeOwnerLiveness();
  const leases = createWorkspaceLeaseService({
    state: deps.state,
    clock: deps.clock,
    ids: deps.ids,
    liveness,
  });

  function identities(codebaseId: string, repositoryId: string) {
    const codebase = deps.state.codebase(codebaseId as never) as CodebaseRow | undefined;
    const repository = deps.state.repository(repositoryId as never) as RepositoryRow | undefined;
    if (
      codebase?.rootPath === null ||
      codebase === undefined ||
      repository?.repositoryPath === null ||
      repository === undefined ||
      repository.codebaseId !== codebaseId
    ) {
      throw new WorkspaceError(
        "WORKSPACE_NOT_FOUND",
        "Registered Codebase/repository is unavailable.",
      );
    }
    return { codebase, repository };
  }

  async function runSetup(
    manifest: WorkspaceProvisioningManifest,
    configuration: WorkspaceConfiguration,
    codebaseRoot: string,
    initialLease: WorkspaceWriterLease,
  ): Promise<{ setup: WorkspaceProvisioningManifest["setup"]; lease: WorkspaceWriterLease }> {
    const command = configuration.scripts.setup;
    if (command === null) return { setup: manifest.setup, lease: initialLease };
    const startedAt = deps.clock.nowIso();
    const logPath = join(deps.logsDirectory, "workspaces", `${manifest.workspaceId}-setup.log`);
    leases.assertCurrent(initialLease, await checkoutHead(manifest.checkoutPath));
    await ensurePrivateParent(logPath);
    leases.assertCurrent(initialLease, await checkoutHead(manifest.checkoutPath));
    await nodeFileSystem.writeFile(logPath, "", { mode: 0o600 });
    const processHandle = await createSetupProcess();
    let lease = leases.renew(initialLease, configuration.lease.ttlMilliseconds, {
      ownerId: initialLease.ownerId,
      bootWitness: initialLease.bootWitness,
      processWitnesses: [
        ...initialLease.processWitnesses,
        { kind: "process-group", value: processHandle.processGroupId },
      ],
    });
    processHandle.start({
      command,
      cwd: manifest.checkoutPath,
      env: stableEnvironment(manifest, codebaseRoot),
      logPath,
    });
    let renewalFailure: unknown;
    let forcedTermination: NodeJS.Timeout | undefined;
    const renewal = setInterval(() => {
      try {
        lease = leases.renew(lease, configuration.lease.ttlMilliseconds);
      } catch (error) {
        if (renewalFailure !== undefined) return;
        renewalFailure = error;
        try {
          process.kill(-processHandle.processGroupId, "SIGTERM");
        } catch {
          // The group may already have exited.
        }
        forcedTermination = setTimeout(() => {
          try {
            process.kill(-processHandle.processGroupId, "SIGKILL");
          } catch {
            // The group may already have exited.
          }
        }, 5_000);
      }
    }, configuration.lease.renewEveryMilliseconds);
    const result = await processHandle.completed;
    clearInterval(renewal);
    if (forcedTermination !== undefined) clearTimeout(forcedTermination);
    const finishedAt = deps.clock.nowIso();
    const log = await sha256File(logPath);
    if (renewalFailure !== undefined) {
      lease = leases.markRecoveryRequired(lease);
      return {
        lease,
        setup: {
          state: "recovery-required",
          commandSha256: sha256Text(command),
          startedAt,
          finishedAt,
          exitCode: result.exitCode,
          logPath,
          logSha256: log.sha256,
        },
      };
    }
    return {
      lease,
      setup: {
        state: result.exitCode === 0 ? "succeeded" : "failed",
        commandSha256: sha256Text(command),
        startedAt,
        finishedAt,
        exitCode: result.exitCode,
        logPath,
        logSha256: log.sha256,
      },
    };
  }

  async function finishSetup(
    manifest: WorkspaceProvisioningManifest,
    configuration: WorkspaceConfiguration,
    repository: RepositoryRow,
    codebase: CodebaseRow,
    initialLease: WorkspaceWriterLease,
  ) {
    const copying = {
      ...manifest,
      phase: "files-copying" as const,
      updatedAt: deps.clock.nowIso(),
    };
    deps.state.recordManifest(copying);
    const copiedFiles = await copyConfiguredFiles(
      repository.repositoryPath as string,
      manifest.checkoutPath,
      configuration.files.copy,
      async () => {
        leases.assertCurrent(initialLease, await checkoutHead(manifest.checkoutPath));
      },
    );
    let current: WorkspaceProvisioningManifest = {
      ...copying,
      phase: "files-copied" as const,
      copiedFiles,
      updatedAt: deps.clock.nowIso(),
    };
    deps.state.recordManifest(current);
    if (configuration.scripts.setup !== null) {
      current = {
        ...current,
        phase: "setup-started" as const,
        setup: {
          state: "running" as const,
          commandSha256: sha256Text(configuration.scripts.setup),
          startedAt: deps.clock.nowIso(),
          finishedAt: null,
          exitCode: null,
          logPath: null,
          logSha256: null,
        },
        updatedAt: deps.clock.nowIso(),
      };
      deps.state.recordManifest(current);
    }
    const setupRun = await runSetup(
      current,
      configuration,
      codebase.rootPath as string,
      initialLease,
    );
    const head = await checkoutHead(manifest.checkoutPath);
    const checkoutCleanliness = await cleanliness(manifest.checkoutPath);
    const ready = setupRun.setup.state === "succeeded" || setupRun.setup.state === "skipped";
    const final: WorkspaceProvisioningManifest = {
      ...current,
      lifecycle: ready
        ? "ready"
        : setupRun.setup.state === "failed"
          ? "failed"
          : "recovery-required",
      phase: ready
        ? "completed"
        : setupRun.setup.state === "failed"
          ? "failed"
          : "recovery-required",
      checkoutHeadSha: head,
      cleanliness: checkoutCleanliness,
      copiedFiles,
      setup: setupRun.setup,
      updatedAt: deps.clock.nowIso(),
    };
    deps.state.recordManifest(final);
    return { manifest: final, lease: setupRun.lease };
  }

  return {
    leases,
    async provision(input: ProvisionWorkspaceInput) {
      validateConfiguration(input.configuration);
      safeSegment(input.workspaceId, "WorkspaceId");
      const { codebase, repository } = identities(input.codebaseId, input.repositoryId);
      const repositoryName = safeSegment(repository.name ?? input.repositoryId, "repository name");
      const branchCheck = await runCommand(
        "git",
        ["check-ref-format", "--branch", input.integrationBranch],
        repository.repositoryPath as string,
      );
      if (branchCheck.exitCode !== 0)
        throw new WorkspaceError("INVALID_BRANCH", "Integration branch is invalid.");
      const workspaceRoot = join(deps.workspacesDirectory, input.workspaceId);
      const checkoutPath = join(workspaceRoot, "checkouts", repositoryName);
      await assertDirectoryIfPresent(deps.workspacesDirectory);
      await assertDirectoryIfPresent(workspaceRoot);
      await assertDirectoryIfPresent(join(workspaceRoot, "checkouts"));
      const requestedConfigurationSha256 = configurationSha256(input.configuration);
      const existing = deps.state.manifest(input.workspaceId);
      if (
        existing !== undefined &&
        (existing.codebaseId !== input.codebaseId ||
          existing.repositoryId !== input.repositoryId ||
          existing.integrationBranch !== input.integrationBranch ||
          existing.checkoutPath !== checkoutPath ||
          existing.configurationSha256 !== requestedConfigurationSha256)
      ) {
        throw new WorkspaceError(
          "WORKSPACE_CONFLICT",
          "Existing workspace intent does not match this request.",
        );
      }
      if (
        existing?.phase === "setup-started" ||
        existing?.phase === "recovery-required" ||
        existing?.setup.state === "running"
      ) {
        throw new WorkspaceError(
          "RECOVERY_REQUIRED",
          "An uncertain setup attempt requires an explicit recovery decision.",
        );
      }
      if (existing?.phase === "completed" && existing.lifecycle === "ready") {
        const currentHead = await checkoutHead(existing.checkoutPath);
        if (currentHead !== existing.checkoutHeadSha) {
          throw new WorkspaceError(
            "CHECKOUT_CHANGED",
            "Completed workspace HEAD no longer matches its manifest.",
          );
        }
        return existing;
      }
      if (existing?.phase === "failed") {
        throw new WorkspaceError(
          "WORKSPACE_CONFLICT",
          "Workspace provisioning has already failed.",
        );
      }
      const resolvedBase = await resolveRemoteBase(
        repository.repositoryPath as string,
        input.configuration,
        deps.clock,
      );
      if (input.baseSha !== undefined && !/^[a-f0-9]{40}$/iu.test(input.baseSha)) {
        throw new WorkspaceError("INVALID_BASE", "Pinned workspace base SHA is invalid.");
      }
      if (input.baseSha !== undefined) {
        const exists = await runCommand(
          "git",
          ["cat-file", "-e", `${input.baseSha}^{commit}`],
          repository.repositoryPath as string,
        );
        if (exists.exitCode !== 0) {
          throw new WorkspaceError("INVALID_BASE", "Pinned workspace base commit does not exist.");
        }
      }
      const base =
        input.baseSha === undefined ? resolvedBase : { ...resolvedBase, sha: input.baseSha };
      if (existing !== undefined && existing.remoteBase.sha !== base.sha) {
        throw new WorkspaceError(
          "RECOVERY_REQUIRED",
          "The remote moved while an earlier provisioning attempt was incomplete.",
        );
      }
      const now = deps.clock.nowIso();
      let manifest: WorkspaceProvisioningManifest = existing ?? {
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        codebaseId: input.codebaseId,
        repositoryId: input.repositoryId,
        configurationSha256: requestedConfigurationSha256,
        strategy: "managed-worktree",
        lifecycle: "provisioning",
        phase: "base-resolved",
        workspaceRoot,
        checkoutPath,
        integrationBranch: input.integrationBranch,
        remoteBase: { ...base, observedSha: base.sha },
        checkoutHeadSha: null,
        cleanliness: null,
        copiedFiles: [],
        setup: {
          state: "skipped",
          commandSha256: null,
          startedAt: null,
          finishedAt: null,
          exitCode: null,
          logPath: null,
          logSha256: null,
        },
        createdAt: now,
        updatedAt: now,
      };
      deps.state.ensureWorkspace(input.workspaceId, input.codebaseId);
      let lease = leases.acquire({
        ...input.owner,
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId,
        checkoutPath,
        expectedSha: base.sha,
        ttlMilliseconds: input.configuration.lease.ttlMilliseconds,
      });
      try {
        if (existing === undefined) deps.state.recordManifest(manifest);
        leases.assertCurrent(lease, base.sha);
        if (
          manifest.phase !== "checkout-created" &&
          manifest.phase !== "files-copying" &&
          manifest.phase !== "files-copied"
        ) {
          manifest = { ...manifest, phase: "checkout-creating", updatedAt: deps.clock.nowIso() };
          deps.state.recordManifest(manifest);
          leases.assertCurrent(lease, base.sha);
          await nodeFileSystem.mkdir(join(workspaceRoot, "checkouts"), {
            recursive: true,
            mode: 0o700,
          });
          leases.assertCurrent(lease, base.sha);
          const add = await runCommand(
            "git",
            ["worktree", "add", "-b", input.integrationBranch, checkoutPath, base.sha],
            repository.repositoryPath as string,
          );
          if (add.exitCode !== 0) {
            throw new WorkspaceError(
              "WORKSPACE_CONFLICT",
              "Integration branch or worktree already exists.",
            );
          }
        }
        const head = await checkoutHead(checkoutPath);
        leases.assertCurrent(lease, head);
        manifest = {
          ...manifest,
          phase: "checkout-created",
          checkoutHeadSha: head,
          updatedAt: deps.clock.nowIso(),
        };
        deps.state.recordManifest(manifest);
        const finished = await finishSetup(
          manifest,
          input.configuration,
          repository,
          codebase,
          lease,
        );
        lease = finished.lease;
        if (lease.state === "active") leases.release(lease);
        return finished.manifest;
      } catch (error) {
        const failed: WorkspaceProvisioningManifest = {
          ...manifest,
          lifecycle: "failed",
          phase: "failed",
          updatedAt: deps.clock.nowIso(),
        };
        deps.state.recordManifest(failed);
        if (lease.state === "active") leases.release(lease);
        throw error;
      }
    },
    async synchronize(input: SynchronizeWorkspaceInput) {
      validateConfiguration(input.configuration);
      const manifest = deps.state.manifest(input.workspaceId);
      if (manifest === undefined)
        throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace is not registered.");
      if (configurationSha256(input.configuration) !== manifest.configurationSha256) {
        throw new WorkspaceError(
          "WORKSPACE_CONFLICT",
          "Synchronization configuration does not match the workspace manifest.",
        );
      }
      const { codebase, repository } = identities(manifest.codebaseId, manifest.repositoryId);
      const observed = await resolveRemoteBase(
        repository.repositoryPath as string,
        input.configuration,
        deps.clock,
      );
      const previousHead = await checkoutHead(manifest.checkoutPath);
      const before = await cleanliness(manifest.checkoutPath);
      const strategy = input.configuration.synchronization.strategy;
      if (observed.sha === manifest.remoteBase.sha) {
        return {
          schemaVersion: 1,
          workspaceId: input.workspaceId,
          strategy,
          outcome: "up-to-date",
          previousBaseSha: manifest.remoteBase.sha,
          observedBaseSha: observed.sha,
          previousHeadSha: previousHead,
          checkoutHeadSha: previousHead,
          cleanliness: before,
          reason: null,
          recordedAt: deps.clock.nowIso(),
        } satisfies WorkspaceSynchronizationResult;
      }
      if (strategy === "notify") {
        deps.state.recordManifest({
          ...manifest,
          remoteBase: { ...manifest.remoteBase, observedSha: observed.sha },
          cleanliness: before,
          updatedAt: deps.clock.nowIso(),
        });
        return {
          schemaVersion: 1,
          workspaceId: input.workspaceId,
          strategy,
          outcome: "notified",
          previousBaseSha: manifest.remoteBase.sha,
          observedBaseSha: observed.sha,
          previousHeadSha: previousHead,
          checkoutHeadSha: previousHead,
          cleanliness: before,
          reason: null,
          recordedAt: deps.clock.nowIso(),
        } satisfies WorkspaceSynchronizationResult;
      }
      if (before.state === "dirty")
        throw new WorkspaceError("CHECKOUT_DIRTY", "Dirty checkout cannot be synchronized.");
      let lease = leases.acquire({
        ...input.owner,
        workspaceId: manifest.workspaceId,
        repositoryId: manifest.repositoryId,
        checkoutPath: manifest.checkoutPath,
        expectedSha: previousHead,
        ttlMilliseconds: input.configuration.lease.ttlMilliseconds,
      });
      try {
        leases.assertCurrent(lease, await checkoutHead(manifest.checkoutPath));
        if (strategy === "rebase-before-build") {
          const ancestor = await runCommand(
            "git",
            ["merge-base", "--is-ancestor", manifest.remoteBase.sha, previousHead],
            manifest.checkoutPath,
          );
          if (ancestor.exitCode !== 0)
            throw new WorkspaceError(
              "CHECKOUT_CHANGED",
              "Recorded base is not an ancestor of HEAD.",
            );
          leases.assertCurrent(lease, await checkoutHead(manifest.checkoutPath));
          const rebase = await runCommand(
            "git",
            ["rebase", "--onto", observed.sha, manifest.remoteBase.sha, manifest.integrationBranch],
            manifest.checkoutPath,
          );
          if (rebase.exitCode !== 0) {
            await runCommand("git", ["rebase", "--abort"], manifest.checkoutPath);
            const restored = await checkoutHead(manifest.checkoutPath);
            if (restored !== previousHead) {
              lease = leases.markRecoveryRequired(lease);
              throw new WorkspaceError("RECOVERY_REQUIRED", "Rebase could not be restored.");
            }
            leases.release(lease);
            return {
              schemaVersion: 1,
              workspaceId: input.workspaceId,
              strategy,
              outcome: "blocked",
              previousBaseSha: manifest.remoteBase.sha,
              observedBaseSha: observed.sha,
              previousHeadSha: previousHead,
              checkoutHeadSha: restored,
              cleanliness: await cleanliness(manifest.checkoutPath),
              reason: "rebase-conflict",
              recordedAt: deps.clock.nowIso(),
            } satisfies WorkspaceSynchronizationResult;
          }
        } else {
          if (previousHead !== manifest.remoteBase.sha) {
            throw new WorkspaceError(
              "CHECKOUT_CHANGED",
              "Recreate refuses commits beyond the recorded base.",
            );
          }
          leases.assertCurrent(lease, await checkoutHead(manifest.checkoutPath));
          await git(
            repository.repositoryPath as string,
            ["worktree", "remove", manifest.checkoutPath],
            "worktree removal failed",
          );
          leases.assertCurrent(lease, previousHead);
          await git(
            repository.repositoryPath as string,
            ["branch", "-f", manifest.integrationBranch, observed.sha],
            "integration branch could not be advanced",
          );
          leases.assertCurrent(lease, previousHead);
          await git(
            repository.repositoryPath as string,
            ["worktree", "add", manifest.checkoutPath, manifest.integrationBranch],
            "worktree recreation failed",
          );
        }
        const nextHead = await checkoutHead(manifest.checkoutPath);
        lease = leases.advanceExpectedSha(lease, nextHead);
        const updatedManifest: WorkspaceProvisioningManifest = {
          ...manifest,
          lifecycle: "provisioning",
          phase: "checkout-created",
          remoteBase: { ...observed, observedSha: observed.sha },
          checkoutHeadSha: nextHead,
          updatedAt: deps.clock.nowIso(),
        };
        deps.state.recordManifest(updatedManifest);
        const finished = await finishSetup(
          updatedManifest,
          input.configuration,
          repository,
          codebase,
          lease,
        );
        lease = finished.lease;
        const finalCleanliness =
          finished.manifest.cleanliness ?? (await cleanliness(manifest.checkoutPath));
        if (lease.state === "active") leases.release(lease);
        return {
          schemaVersion: 1,
          workspaceId: input.workspaceId,
          strategy,
          outcome:
            finished.manifest.lifecycle === "ready"
              ? strategy === "rebase-before-build"
                ? "rebased"
                : "recreated"
              : finished.manifest.lifecycle === "recovery-required"
                ? "recovery-required"
                : "blocked",
          previousBaseSha: manifest.remoteBase.sha,
          observedBaseSha: observed.sha,
          previousHeadSha: previousHead,
          checkoutHeadSha: finished.manifest.checkoutHeadSha ?? nextHead,
          cleanliness: finalCleanliness,
          reason: finished.manifest.lifecycle === "ready" ? null : "setup-did-not-succeed",
          recordedAt: deps.clock.nowIso(),
        } satisfies WorkspaceSynchronizationResult;
      } catch (error) {
        if (lease.state === "active") leases.release(lease);
        throw error;
      }
    },
    async recover(input: RecoverWorkspaceInput) {
      validateConfiguration(input.configuration);
      const manifest = deps.state.manifest(input.workspaceId);
      if (manifest === undefined)
        throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace is not registered.");
      if (configurationSha256(input.configuration) !== manifest.configurationSha256) {
        throw new WorkspaceError(
          "WORKSPACE_CONFLICT",
          "Recovery configuration does not match the workspace manifest.",
        );
      }
      if (input.decision === "fail-workspace") {
        const currentLease = deps.state.lease(manifest.checkoutPath);
        if (currentLease !== undefined && currentLease.state !== "released") {
          const recoveryLease = leases.acquire({
            ...input.owner,
            workspaceId: manifest.workspaceId,
            repositoryId: manifest.repositoryId,
            checkoutPath: manifest.checkoutPath,
            expectedSha: currentLease.expectedSha,
            ttlMilliseconds: input.configuration.lease.ttlMilliseconds,
          });
          leases.release(recoveryLease);
        }
        const failed = {
          ...manifest,
          lifecycle: "failed" as const,
          phase: "failed" as const,
          updatedAt: deps.clock.nowIso(),
        };
        deps.state.recordManifest(failed);
        return failed;
      }
      if (manifest.phase !== "setup-started" && manifest.phase !== "recovery-required") {
        throw new WorkspaceError("RECOVERY_REQUIRED", "Workspace has no uncertain setup attempt.");
      }
      const { codebase, repository } = identities(manifest.codebaseId, manifest.repositoryId);
      const head = await checkoutHead(manifest.checkoutPath);
      let lease = leases.acquire({
        ...input.owner,
        workspaceId: manifest.workspaceId,
        repositoryId: manifest.repositoryId,
        checkoutPath: manifest.checkoutPath,
        expectedSha: head,
        ttlMilliseconds: input.configuration.lease.ttlMilliseconds,
      });
      const finished = await finishSetup(
        manifest,
        input.configuration,
        repository,
        codebase,
        lease,
      );
      lease = finished.lease;
      if (lease.state === "active") leases.release(lease);
      return finished.manifest;
    },
  };
}
