import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  CompositeWorkspaceProvisioningManifest,
  EffectiveInstructionReport,
  InstructionSnapshot,
  RegisteredCodebase,
  RepositoryId,
  ResolvedCodebaseSnapshot,
  ResolvedCodebaseSnapshotV2,
  WorkspaceId,
} from "@heniek/contracts";
import { WorkspaceError } from "./errors.js";
import { scrubbedSetupEnvironment } from "./runtime/node.js";

const DEFAULT_SETUP_TIMEOUT_MILLISECONDS = 900_000;
const MAX_SETUP_CONCURRENCY = 3;
const MAX_LOG_BYTES = 1_048_576;
const TRUNCATION_MARKER = "\n[heniek] output truncated at 1048576 bytes\n";

type ResolvedSnapshot = ResolvedCodebaseSnapshot | ResolvedCodebaseSnapshotV2;
type RepositoryManifest = CompositeWorkspaceProvisioningManifest["repositories"][number];

export interface CompositeInstructionInput {
  readonly snapshot: InstructionSnapshot;
  /** Current source text, keyed by sourceId. Text is never persisted in the report. */
  readonly contentBySourceId: Readonly<Record<string, string>>;
  readonly provider: EffectiveInstructionReport["provider"];
}

export interface ProvisionCompositeWorkspaceInput {
  readonly workspaceId: WorkspaceId;
  readonly snapshot: ResolvedSnapshot;
  readonly registration: RegisteredCodebase;
  readonly integrationBranches: Readonly<Record<string, string>>;
  readonly instructions: CompositeInstructionInput;
}

export interface RecoverCompositeWorkspaceInput extends ProvisionCompositeWorkspaceInput {
  readonly decision: "retry-uncertain" | "fail-workspace";
}

export interface CompositeManifestStore {
  load(workspaceId: WorkspaceId): Promise<CompositeWorkspaceProvisioningManifest | undefined>;
  record(manifest: CompositeWorkspaceProvisioningManifest): Promise<void>;
}

export interface CompositeWorkspaceService {
  provision(
    input: ProvisionCompositeWorkspaceInput,
  ): Promise<CompositeWorkspaceProvisioningManifest>;
  recover(input: RecoverCompositeWorkspaceInput): Promise<CompositeWorkspaceProvisioningManifest>;
}

export interface CreateCompositeWorkspaceServiceInput {
  readonly workspacesDirectory: string;
  readonly logsDirectory: string;
  readonly clock: { nowIso(): string };
  readonly store?: CompositeManifestStore;
}

interface SetupPolicy {
  readonly command: string | null;
  readonly dependsOn: readonly RepositoryId[];
  readonly timeoutMilliseconds: number;
}

interface CommandResult {
  readonly exitCode: number;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly logSha256: string;
  readonly logTruncated: boolean;
}

interface StreamRedactor {
  append(value: string): string;
  finish(): string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function safeSegment(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)) {
    throw new WorkspaceError("INVALID_PATH", `${label} is not a safe path segment.`);
  }
  return value;
}

function setupPolicy(repository: ResolvedSnapshot["repositories"][number]): SetupPolicy {
  if (typeof repository.setup === "object" && repository.setup !== null) {
    return repository.setup;
  }
  return {
    command: repository.setup,
    dependsOn: [],
    timeoutMilliseconds: DEFAULT_SETUP_TIMEOUT_MILLISECONDS,
  };
}

export function validateCompositeSetupGraph(snapshot: ResolvedSnapshot): void {
  const ids = new Set(snapshot.repositories.map((repository) => repository.repositoryId));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(
    snapshot.repositories.map((repository) => [repository.repositoryId, repository]),
  );
  const visit = (repositoryId: string): void => {
    if (visited.has(repositoryId)) return;
    if (visiting.has(repositoryId)) {
      throw new WorkspaceError(
        "INVALID_CONFIGURATION",
        "Repository setup dependencies contain a cycle.",
      );
    }
    visiting.add(repositoryId);
    const repository = byId.get(repositoryId as RepositoryId);
    if (repository === undefined) return;
    for (const dependency of setupPolicy(repository).dependsOn) {
      if (dependency === repositoryId || !ids.has(dependency)) {
        throw new WorkspaceError(
          "INVALID_CONFIGURATION",
          dependency === repositoryId
            ? "Repository setup cannot depend on itself."
            : "Repository setup dependency is not part of the resolved Codebase.",
        );
      }
      visit(dependency);
    }
    visiting.delete(repositoryId);
    visited.add(repositoryId);
  };
  for (const repositoryId of [...ids].sort()) visit(repositoryId);
}

function sourceSortKey(source: InstructionSnapshot["sources"][number]): string {
  const depth = source.scope === "" ? 0 : source.scope.split("/").length;
  return `${source.precedence.toString().padStart(2, "0")}:${depth
    .toString()
    .padStart(
      4,
      "0",
    )}:${source.location.repositoryId ?? ""}:${source.location.path}:${source.sourceId}`;
}

export function buildEffectiveInstructionReport(
  input: CompositeInstructionInput,
  generatedAt: string,
): EffectiveInstructionReport {
  const sources = input.snapshot.sources
    .filter((source) => source.kind !== "provider-native" || source.provider === input.provider)
    .sort((left, right) => sourceSortKey(left).localeCompare(sourceSortKey(right)));
  const selectedIds = new Set(sources.map((source) => source.sourceId));
  const contents: string[] = [];
  for (const source of sources) {
    const content = input.contentBySourceId[source.sourceId];
    if (content === undefined || sha256(content) !== source.contentSha256) {
      throw new WorkspaceError(
        "INSTRUCTION_CHANGED",
        `Instruction source changed after discovery: ${source.sourceId}`,
      );
    }
    contents.push(content);
  }
  const unresolvedConflicts = input.snapshot.diagnostics.filter(
    (diagnostic) =>
      diagnostic.classification !== "additive" &&
      diagnostic.anchors.every((anchor) => selectedIds.has(anchor.sourceId)),
  );
  const effectiveContentSha256 = sha256(contents.join("\n\n"));
  const body = {
    provider: input.provider,
    generatedAt,
    readiness: unresolvedConflicts.length === 0 ? ("ready" as const) : ("blocked" as const),
    effectiveContentSha256,
    sources,
    unresolvedConflicts,
  };
  return {
    schemaVersion: 1,
    ...body,
    reportSha256: sha256(JSON.stringify(canonical(body))),
  };
}

export function createFileCompositeManifestStore(
  workspacesDirectory: string,
): CompositeManifestStore {
  const pathFor = (workspaceId: WorkspaceId) =>
    join(workspacesDirectory, safeSegment(workspaceId, "WorkspaceId"), "composite-manifest.json");
  return {
    async load(workspaceId) {
      const text = await readFile(pathFor(workspaceId), "utf8").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      return text === undefined
        ? undefined
        : (JSON.parse(text) as CompositeWorkspaceProvisioningManifest);
    },
    async record(manifest) {
      const path = pathFor(manifest.workspaceId);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
      await chmod(path, 0o600);
    },
  };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return await new Promise((resolveOutput, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveOutput(stdout.trim());
      else reject(new WorkspaceError("WORKSPACE_CONFLICT", "Git workspace operation failed."));
    });
  });
}

async function checkoutIdentity(checkoutPath: string): Promise<{ common: string; head: string }> {
  const [commonRaw, head] = await Promise.all([
    git(checkoutPath, ["rev-parse", "--git-common-dir"]),
    git(checkoutPath, ["rev-parse", "HEAD"]),
  ]);
  const common = await realpath(resolve(checkoutPath, commonRaw));
  return { common, head };
}

async function pathExists(path: string): Promise<boolean> {
  return await stat(path)
    .then(() => true)
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
}

function createStreamRedactor(): StreamRedactor {
  const marker = /(password|secret|token|api[-_]?key|credential)(\s*[=:]\s*)/iu;
  const trailingKey = /(password|secret|token|api[-_]?key|credential)\s*$/iu;
  let pending = "";
  let redactingValue = false;

  const drain = (final: boolean): string => {
    let output = "";
    while (pending !== "") {
      if (redactingValue) {
        const boundary = pending.search(/\s/u);
        if (boundary < 0) {
          pending = "";
          return output;
        }
        output += pending[boundary];
        pending = pending.slice(boundary + 1);
        redactingValue = false;
        continue;
      }
      const match = marker.exec(pending);
      if (match !== null) {
        output += `${pending.slice(0, match.index)}${match[0]}[REDACTED]`;
        pending = pending.slice(match.index + match[0].length);
        redactingValue = true;
        continue;
      }
      if (final) {
        output += pending;
        pending = "";
        return output;
      }
      const suffix = trailingKey.exec(pending);
      if (suffix !== null && pending.length > 4096) {
        output += `${pending.slice(0, suffix.index)}${suffix[0]}[REDACTED]`;
        pending = "";
        redactingValue = true;
        continue;
      }
      const retainedLength =
        suffix === null ? Math.min(64, pending.length) : pending.length - suffix.index;
      const flushLength = pending.length - retainedLength;
      if (flushLength === 0) return output;
      output += pending.slice(0, flushLength);
      pending = pending.slice(flushLength);
    }
    return output;
  };

  return {
    append(value) {
      pending += value;
      return drain(false);
    },
    finish() {
      return drain(true);
    },
  };
}

async function runBoundedCommand(input: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  logPath: string;
  timeoutMilliseconds: number;
}): Promise<CommandResult> {
  await mkdir(dirname(input.logPath), { recursive: true, mode: 0o700 });
  let retained = "";
  let truncated = false;
  const stdoutRedactor = createStreamRedactor();
  const stderrRedactor = createStreamRedactor();
  const retain = (redacted: string): void => {
    const room = MAX_LOG_BYTES - Buffer.byteLength(retained);
    if (room <= 0) {
      truncated = true;
      return;
    }
    const bytes = Buffer.from(redacted);
    retained += bytes.subarray(0, room).toString("utf8");
    if (bytes.byteLength > room) truncated = true;
  };
  const append = (redactor: StreamRedactor, chunk: Buffer): void => {
    retain(redactor.append(chunk.toString("utf8")));
  };
  const result = await new Promise<{ exitCode: number; signal: string | null; timedOut: boolean }>(
    (resolveResult, reject) => {
      const child = spawn("/bin/sh", ["-lc", input.command], {
        cwd: input.cwd,
        env: input.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) {
          try {
            process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
            killTimer = setTimeout(() => {
              try {
                process.kill(
                  process.platform === "win32" ? (child.pid as number) : -(child.pid as number),
                  "SIGKILL",
                );
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
              }
            }, 2000);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      }, input.timeoutMilliseconds);
      child.stdout.on("data", (chunk: Buffer) => append(stdoutRedactor, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(stderrRedactor, chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolveResult({ exitCode: code ?? 1, signal, timedOut });
      });
    },
  );
  retain(stdoutRedactor.finish());
  retain(stderrRedactor.finish());
  if (truncated) {
    const markerBytes = Buffer.byteLength(TRUNCATION_MARKER);
    retained = `${Buffer.from(retained)
      .subarray(0, MAX_LOG_BYTES - markerBytes)
      .toString("utf8")}${TRUNCATION_MARKER}`;
  }
  await writeFile(input.logPath, retained, { mode: 0o600 });
  await chmod(input.logPath, 0o600);
  return { ...result, logSha256: sha256(retained), logTruncated: truncated };
}

function emptySetup(command: string | null): RepositoryManifest["setup"] {
  return {
    state: command === null ? "skipped" : "pending",
    commandSha256: command === null ? null : sha256(command),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    logPath: null,
    logSha256: null,
    logTruncated: false,
    blockedBy: [],
  };
}

function emptyMaterialization(
  provisioning: ResolvedSnapshot["repositories"][number]["provisioning"],
): RepositoryManifest["materialization"] {
  return {
    state: "pending",
    commandSha256: provisioning.strategy === "custom" ? sha256(provisioning.command) : null,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    logPath: null,
    logSha256: null,
    logTruncated: false,
  };
}

export function createCompositeWorkspaceService(
  deps: CreateCompositeWorkspaceServiceInput,
): CompositeWorkspaceService {
  const store = deps.store ?? createFileCompositeManifestStore(deps.workspacesDirectory);

  async function record(manifest: CompositeWorkspaceProvisioningManifest) {
    const next = { ...manifest, updatedAt: deps.clock.nowIso() };
    await store.record(next);
    return next;
  }

  async function provision(input: ProvisionCompositeWorkspaceInput) {
    validateCompositeSetupGraph(input.snapshot);
    safeSegment(input.workspaceId, "WorkspaceId");
    const workspaceRoot = join(deps.workspacesDirectory, input.workspaceId);
    const registered = new Map(
      input.registration.repositories.flatMap((repository) =>
        repository.repositoryId === null ? [] : [[repository.repositoryId, repository] as const],
      ),
    );
    let manifest = await store.load(input.workspaceId);
    if (
      manifest !== undefined &&
      (manifest.codebaseId !== input.snapshot.codebaseId ||
        manifest.configurationSha256 !== input.snapshot.configurationSha256)
    ) {
      throw new WorkspaceError(
        "WORKSPACE_CONFLICT",
        "Composite workspace intent changed during restart.",
      );
    }
    if (manifest?.lifecycle === "recovery-required") {
      throw new WorkspaceError(
        "RECOVERY_REQUIRED",
        "Composite workspace requires an explicit recovery decision.",
      );
    }
    if (
      manifest?.repositories.some(
        (repository) =>
          repository.phase === "setup-running" || repository.setup.state === "running",
      )
    ) {
      manifest = await record({
        ...manifest,
        lifecycle: "recovery-required",
        repositories: manifest.repositories.map((repository) =>
          repository.phase === "setup-running" || repository.setup.state === "running"
            ? {
                ...repository,
                phase: "recovery-required",
                setup: { ...repository.setup, state: "recovery-required" },
                updatedAt: deps.clock.nowIso(),
              }
            : repository,
        ),
      });
      throw new WorkspaceError("RECOVERY_REQUIRED", "A repository setup outcome is uncertain.");
    }
    if (manifest === undefined) {
      const now = deps.clock.nowIso();
      manifest = {
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        codebaseId: input.snapshot.codebaseId,
        configurationSha256: input.snapshot.configurationSha256,
        lifecycle: "provisioning",
        workspaceRoot,
        repositories: input.snapshot.repositories
          .map((repository) => ({
            repositoryId: repository.repositoryId,
            name: repository.name,
            strategy: repository.provisioning.strategy,
            phase: "pending" as const,
            checkoutPath: null,
            gitCommonDirectory: null,
            baseSha:
              input.snapshot.basePins.find((pin) => pin.repositoryId === repository.repositoryId)
                ?.commitSha ?? null,
            checkoutHeadSha: null,
            materialization: emptyMaterialization(repository.provisioning),
            setup: emptySetup(setupPolicy(repository).command),
            updatedAt: now,
          }))
          .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId)),
        effectiveInstructions: null,
        createdAt: now,
        updatedAt: now,
      };
      await store.record(manifest);
    }
    await mkdir(join(workspaceRoot, "checkouts"), { recursive: true, mode: 0o700 });

    for (const repository of input.snapshot.repositories.toSorted((a, b) =>
      a.repositoryId.localeCompare(b.repositoryId),
    )) {
      const index = manifest.repositories.findIndex(
        (candidate) => candidate.repositoryId === repository.repositoryId,
      );
      const current = manifest.repositories[index];
      const registration = registered.get(repository.repositoryId);
      if (current === undefined || registration === undefined) {
        throw new WorkspaceError("WORKSPACE_CONFLICT", "Resolved repository is not registered.");
      }
      if (
        ["materialized", "setup-running", "completed", "blocked", "failed"].includes(current.phase)
      ) {
        if (current.checkoutPath === null || current.gitCommonDirectory === null) {
          throw new WorkspaceError(
            "RECOVERY_REQUIRED",
            "Recorded checkout identity is incomplete.",
          );
        }
        const observed = await checkoutIdentity(current.checkoutPath);
        if (
          observed.common !== current.gitCommonDirectory ||
          observed.head !== current.checkoutHeadSha
        ) {
          throw new WorkspaceError(
            "CHECKOUT_CHANGED",
            "Composite checkout changed after it was recorded.",
          );
        }
        continue;
      }
      const target = join(
        workspaceRoot,
        "checkouts",
        safeSegment(repository.name, "repository name"),
      );
      if (current.phase === "materializing" && repository.provisioning.strategy === "custom") {
        manifest = await record({
          ...manifest,
          lifecycle: "recovery-required",
          repositories: manifest.repositories.with(index, {
            ...current,
            phase: "recovery-required",
            materialization: { ...current.materialization, state: "recovery-required" },
            updatedAt: deps.clock.nowIso(),
          }),
        });
        throw new WorkspaceError("RECOVERY_REQUIRED", "Custom provisioning outcome is uncertain.");
      }
      if (
        current.phase === "materializing" &&
        repository.provisioning.strategy === "managed-worktree" &&
        (await pathExists(target))
      ) {
        const observed = await checkoutIdentity(target);
        const expectedCommon = await realpath(registration.gitCommonDirectory);
        if (
          observed.common !== expectedCommon ||
          (current.baseSha !== null && observed.head !== current.baseSha)
        ) {
          throw new WorkspaceError(
            "RECOVERY_REQUIRED",
            "Interrupted checkout cannot be reconciled to its recorded identity.",
          );
        }
        manifest = await record({
          ...manifest,
          repositories: manifest.repositories.with(index, {
            ...current,
            phase: setupPolicy(repository).command === null ? "completed" : "materialized",
            checkoutPath: target,
            gitCommonDirectory: observed.common,
            checkoutHeadSha: observed.head,
            materialization: {
              ...current.materialization,
              state: "succeeded",
              finishedAt: deps.clock.nowIso(),
            },
            updatedAt: deps.clock.nowIso(),
          }),
        });
        continue;
      }
      manifest = await record({
        ...manifest,
        repositories: manifest.repositories.with(index, {
          ...current,
          phase: "materializing",
          materialization: {
            ...current.materialization,
            state: "running",
            startedAt: deps.clock.nowIso(),
          },
          updatedAt: deps.clock.nowIso(),
        }),
      });
      let checkoutPath: string;
      if (repository.provisioning.strategy === "managed-worktree") {
        const pin = input.snapshot.basePins.find(
          (candidate) => candidate.repositoryId === repository.repositoryId,
        );
        const branch = input.integrationBranches[repository.repositoryId];
        if (pin === undefined || branch === undefined) {
          throw new WorkspaceError(
            "INVALID_CONFIGURATION",
            "Managed repository lacks a pin or branch.",
          );
        }
        await git(repository.path, ["check-ref-format", "--branch", branch]);
        await git(repository.path, ["cat-file", "-e", `${pin.commitSha}^{commit}`]);
        try {
          await git(repository.path, ["worktree", "add", "-b", branch, target, pin.commitSha]);
        } catch (error) {
          const existingBranchSha = await git(repository.path, ["rev-parse", branch]).catch(
            () => null,
          );
          if (existingBranchSha !== pin.commitSha) throw error;
          await git(repository.path, ["worktree", "add", target, branch]);
        }
        checkoutPath = target;
      } else if (repository.provisioning.strategy === "current-checkout") {
        checkoutPath = repository.path;
      } else if (repository.provisioning.strategy === "existing-checkout") {
        checkoutPath = repository.provisioning.checkoutPath;
      } else {
        const logPath = join(
          deps.logsDirectory,
          "workspaces",
          `${input.workspaceId}-${repository.repositoryId}-provision.log`,
        );
        const result = await runBoundedCommand({
          command: repository.provisioning.command,
          cwd: workspaceRoot,
          env: scrubbedSetupEnvironment({
            HENIEK_WORKSPACE_ID: input.workspaceId,
            HENIEK_WORKSPACE_ROOT: workspaceRoot,
            HENIEK_REPOSITORY_ID: repository.repositoryId,
            HENIEK_REPOSITORY_PATH: target,
          }),
          logPath,
          timeoutMilliseconds: DEFAULT_SETUP_TIMEOUT_MILLISECONDS,
        });
        if (result.exitCode !== 0 || result.timedOut) {
          const failed = manifest.repositories[index];
          if (failed === undefined) {
            throw new WorkspaceError("WORKSPACE_CONFLICT", "Repository state disappeared.");
          }
          manifest = await record({
            ...manifest,
            repositories: manifest.repositories.with(index, {
              ...failed,
              phase: "failed",
              materialization: {
                ...failed.materialization,
                state: "failed",
                finishedAt: deps.clock.nowIso(),
                exitCode: result.exitCode,
                signal: result.signal,
                timedOut: result.timedOut,
                logPath,
                logSha256: result.logSha256,
                logTruncated: result.logTruncated,
              },
              setup: { ...failed.setup, state: "blocked" },
              updatedAt: deps.clock.nowIso(),
            }),
          });
          continue;
        }
        checkoutPath = target;
      }
      if (!isAbsolute(checkoutPath)) {
        throw new WorkspaceError("INVALID_PATH", "Repository checkout path must be absolute.");
      }
      const observed = await checkoutIdentity(checkoutPath);
      const expectedCommon = await realpath(registration.gitCommonDirectory);
      if (observed.common !== expectedCommon) {
        throw new WorkspaceError(
          "WORKSPACE_CONFLICT",
          "Checkout belongs to a different Git repository.",
        );
      }
      if (current.baseSha !== null && observed.head !== current.baseSha) {
        throw new WorkspaceError(
          "CHECKOUT_CHANGED",
          "Managed checkout does not match its immutable base pin.",
        );
      }
      const updated = manifest.repositories[index];
      if (updated === undefined)
        throw new WorkspaceError("WORKSPACE_CONFLICT", "Repository state disappeared.");
      manifest = await record({
        ...manifest,
        repositories: manifest.repositories.with(index, {
          ...updated,
          phase: setupPolicy(repository).command === null ? "completed" : "materialized",
          checkoutPath,
          gitCommonDirectory: observed.common,
          checkoutHeadSha: observed.head,
          materialization: {
            ...updated.materialization,
            state: "succeeded",
            finishedAt: deps.clock.nowIso(),
          },
          updatedAt: deps.clock.nowIso(),
        }),
      });
    }

    let schedulerManifest: CompositeWorkspaceProvisioningManifest = manifest;
    const byId = new Map(
      input.snapshot.repositories.map((repository) => [repository.repositoryId, repository]),
    );
    const pending = new Set(
      schedulerManifest.repositories
        .filter((repository) => repository.setup.state === "pending")
        .map((repository) => repository.repositoryId),
    );
    while (pending.size > 0) {
      const runnable = [...pending]
        .filter((repositoryId) => {
          const repository = byId.get(repositoryId);
          if (repository === undefined) return false;
          return setupPolicy(repository).dependsOn.every((dependency) => {
            const state = schedulerManifest.repositories.find(
              (entry) => entry.repositoryId === dependency,
            )?.setup.state;
            return state === "succeeded" || state === "skipped";
          });
        })
        .sort()
        .slice(0, MAX_SETUP_CONCURRENCY);
      if (runnable.length === 0) {
        for (const repositoryId of [...pending].sort()) {
          const repository = byId.get(repositoryId);
          const index = schedulerManifest.repositories.findIndex(
            (entry) => entry.repositoryId === repositoryId,
          );
          const current = schedulerManifest.repositories[index];
          if (repository === undefined || current === undefined) continue;
          const blockedBy = setupPolicy(repository).dependsOn.filter((dependency) => {
            const state = schedulerManifest.repositories.find(
              (entry) => entry.repositoryId === dependency,
            )?.setup.state;
            return state === "failed" || state === "timed-out" || state === "blocked";
          });
          schedulerManifest = await record({
            ...schedulerManifest,
            repositories: schedulerManifest.repositories.with(index, {
              ...current,
              phase: "blocked",
              setup: { ...current.setup, state: "blocked", blockedBy },
              updatedAt: deps.clock.nowIso(),
            }),
          });
          pending.delete(repositoryId);
        }
        break;
      }
      const startedAt = deps.clock.nowIso();
      for (const repositoryId of runnable) {
        const index = schedulerManifest.repositories.findIndex(
          (entry) => entry.repositoryId === repositoryId,
        );
        const current = schedulerManifest.repositories[index];
        if (current === undefined) continue;
        schedulerManifest = await record({
          ...schedulerManifest,
          repositories: schedulerManifest.repositories.with(index, {
            ...current,
            phase: "setup-running",
            setup: { ...current.setup, state: "running", startedAt },
            updatedAt: startedAt,
          }),
        });
      }
      const completed = await Promise.all(
        runnable.map(async (repositoryId) => {
          const repository = byId.get(repositoryId);
          const current = schedulerManifest.repositories.find(
            (entry) => entry.repositoryId === repositoryId,
          );
          if (repository === undefined || current?.checkoutPath === null || current === undefined)
            return;
          const policy = setupPolicy(repository);
          const logPath = join(
            deps.logsDirectory,
            "workspaces",
            `${input.workspaceId}-${repositoryId}-setup.log`,
          );
          const result = await runBoundedCommand({
            command: policy.command as string,
            cwd: current.checkoutPath,
            env: scrubbedSetupEnvironment({
              HENIEK_WORKSPACE_ID: input.workspaceId,
              HENIEK_WORKSPACE_ROOT: workspaceRoot,
              HENIEK_CODEBASE_ROOT: input.registration.rootPath,
              HENIEK_REPOSITORY_ID: repositoryId,
              HENIEK_REPOSITORY_PATH: current.checkoutPath,
              HENIEK_BASE_SHA: current.baseSha ?? current.checkoutHeadSha ?? "",
              HENIEK_INTEGRATION_BRANCH: input.integrationBranches[repositoryId] ?? "",
            }),
            logPath,
            timeoutMilliseconds: policy.timeoutMilliseconds,
          });
          return { repositoryId, result, logPath };
        }),
      );
      for (const completion of completed
        .filter((entry) => entry !== undefined)
        .sort((a, b) => a.repositoryId.localeCompare(b.repositoryId))) {
        const { repositoryId, result, logPath } = completion;
        const index = schedulerManifest.repositories.findIndex(
          (entry) => entry.repositoryId === repositoryId,
        );
        const current = schedulerManifest.repositories[index];
        if (current === undefined) continue;
        const succeeded = result.exitCode === 0 && !result.timedOut;
        const finishedAt = deps.clock.nowIso();
        schedulerManifest = await record({
          ...schedulerManifest,
          repositories: schedulerManifest.repositories.with(index, {
            ...current,
            phase: succeeded ? "completed" : "failed",
            setup: {
              ...current.setup,
              state: result.timedOut ? "timed-out" : succeeded ? "succeeded" : "failed",
              finishedAt,
              exitCode: result.exitCode,
              signal: result.signal,
              timedOut: result.timedOut,
              logPath,
              logSha256: result.logSha256,
              logTruncated: result.logTruncated,
            },
            updatedAt: finishedAt,
          }),
        });
        pending.delete(repositoryId);
      }
    }
    const instructions = buildEffectiveInstructionReport(input.instructions, deps.clock.nowIso());
    const states = schedulerManifest.repositories.map((repository) => repository.setup.state);
    const lifecycle =
      instructions.readiness === "blocked"
        ? "blocked"
        : states.some((state) => state === "failed" || state === "timed-out" || state === "blocked")
          ? "partial-failure"
          : "ready";
    schedulerManifest = await record({
      ...schedulerManifest,
      lifecycle,
      effectiveInstructions: instructions,
    });
    return schedulerManifest;
  }

  return {
    provision,
    async recover(input) {
      const manifest = await store.load(input.workspaceId);
      if (manifest === undefined) {
        throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Composite workspace is not registered.");
      }
      if (input.decision === "fail-workspace") {
        return await record({
          ...manifest,
          lifecycle: "partial-failure",
          repositories: manifest.repositories.map((repository) =>
            repository.phase === "recovery-required"
              ? {
                  ...repository,
                  phase: "failed",
                  materialization: { ...repository.materialization, state: "failed" },
                  setup: { ...repository.setup, state: "failed" },
                }
              : repository,
          ),
        });
      }
      await store.record({
        ...manifest,
        lifecycle: "provisioning",
        repositories: manifest.repositories.map((repository) =>
          repository.phase === "recovery-required"
            ? repository.checkoutPath === null
              ? {
                  ...repository,
                  phase: "pending",
                  checkoutPath: null,
                  gitCommonDirectory: null,
                  checkoutHeadSha: null,
                  materialization: {
                    ...repository.materialization,
                    state: "pending",
                    startedAt: null,
                    finishedAt: null,
                  },
                  setup: { ...repository.setup, state: "pending" },
                }
              : {
                  ...repository,
                  phase: "materialized",
                  setup: {
                    ...repository.setup,
                    state: repository.setup.commandSha256 === null ? "skipped" : "pending",
                    startedAt: null,
                    finishedAt: null,
                  },
                }
            : repository,
        ),
        updatedAt: deps.clock.nowIso(),
      });
      return await provision(input);
    },
  };
}
