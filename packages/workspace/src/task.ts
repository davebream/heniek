import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ExecutionTaskRevision,
  RepositoryId,
  TaskWorkspaceBinding,
  VariantIntegrationRequest,
  WorkspaceDiffInventory,
  WorkspaceVariantManifest,
} from "@heniek/contracts";
import { WorkspaceError } from "./errors.js";
import type { WorkspaceLeaseService } from "./types.js";
import type {
  CompositeWorkspaceVariantService,
  ProvisionWorkspaceVariantInput,
} from "./variant.js";

const DIFF_MAX_PATHS = 10_000;
const DIFF_MAX_BYTES = 1024 * 1024;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function computeExecutionTaskRevisionSha256(
  revision: Omit<ExecutionTaskRevision, "revisionSha256">,
): string {
  return createHash("sha256").update(canonical(revision)).digest("hex");
}

export function validateExecutionTaskRevision(input: {
  readonly candidate: ExecutionTaskRevision;
  readonly previous?: ExecutionTaskRevision;
  readonly repositoryIds: readonly RepositoryId[];
}): void {
  const { revisionSha256: _digest, ...digestInput } = input.candidate;
  if (computeExecutionTaskRevisionSha256(digestInput) !== input.candidate.revisionSha256) {
    throw new WorkspaceError(
      "TASK_REVISION_INVALID",
      "Task revision digest does not match its content.",
    );
  }
  if (input.previous === undefined) {
    if (input.candidate.revision !== 1 || input.candidate.predecessorRevisionSha256 !== null) {
      throw new WorkspaceError(
        "TASK_REVISION_INVALID",
        "Initial task revision must be revision 1 without a predecessor.",
      );
    }
  } else if (
    input.candidate.taskId !== input.previous.taskId ||
    input.candidate.revision !== input.previous.revision + 1 ||
    input.candidate.predecessorRevisionSha256 !== input.previous.revisionSha256
  ) {
    throw new WorkspaceError(
      "TASK_REVISION_INVALID",
      "Task revision must continue the exact predecessor chain.",
    );
  }

  const known = new Set(input.repositoryIds);
  const reads = new Set(input.candidate.readSet);
  const writes = new Set(input.candidate.writeSet);
  if (
    known.size !== input.repositoryIds.length ||
    reads.size !== input.candidate.readSet.length ||
    writes.size !== input.candidate.writeSet.length ||
    [...reads].some((id) => !known.has(id)) ||
    [...writes].some((id) => !reads.has(id)) ||
    !reads.has(input.candidate.primaryRepositoryId)
  ) {
    throw new WorkspaceError(
      "TASK_REVISION_INVALID",
      "Task repository sets are unknown, duplicated, or internally inconsistent.",
    );
  }
  if (input.candidate.writeSet.length === 0) {
    throw new WorkspaceError(
      "TASK_REVISION_INVALID",
      "An execution variant requires a write repository.",
    );
  }
  const excluded = new Map(
    input.candidate.excludedRepositories.map((entry) => [entry.repositoryId, entry.rationale]),
  );
  if (
    excluded.size !== input.candidate.excludedRepositories.length ||
    [...known].some((id) => reads.has(id) === excluded.has(id))
  ) {
    throw new WorkspaceError(
      "TASK_REVISION_INVALID",
      "Every repository outside the read set requires exactly one exclusion rationale.",
    );
  }
  if (
    input.candidate.dependencies.includes(input.candidate.taskId) ||
    new Set(input.candidate.dependencies).size !== input.candidate.dependencies.length ||
    input.candidate.verification.some((entry) => !reads.has(entry.repositoryId)) ||
    input.candidate.artifacts.some(
      (entry) => entry.repositoryId !== null && !reads.has(entry.repositoryId),
    )
  ) {
    throw new WorkspaceError(
      "TASK_REVISION_INVALID",
      "Task dependencies, artifacts, or verification references are invalid.",
    );
  }
}

export interface TaskBindingStore {
  load(workspaceId: string, variantId: string): Promise<TaskWorkspaceBinding | undefined>;
  create(binding: TaskWorkspaceBinding): Promise<void>;
}

export function createFileTaskBindingStore(workspacesDirectory: string): TaskBindingStore {
  const safe = (value: string) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)) {
      throw new WorkspaceError("INVALID_PATH", "Task binding identity is not a safe path segment.");
    }
    return value;
  };
  const pathFor = (workspaceId: string, variantId: string) =>
    join(workspacesDirectory, safe(workspaceId), "variants", safe(variantId), "task-binding.json");
  return {
    async load(workspaceId, variantId) {
      try {
        return JSON.parse(
          await readFile(pathFor(workspaceId, variantId), "utf8"),
        ) as TaskWorkspaceBinding;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async create(binding) {
      const path = pathFor(binding.workspaceId, binding.variantId);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try {
        await writeFile(path, `${JSON.stringify(binding, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new WorkspaceError(
            "WORKSPACE_CONFLICT",
            "A workspace variant cannot be rebound to another task revision.",
          );
        }
        throw error;
      }
    },
  };
}

type ChangeState =
  WorkspaceDiffInventory["repositories"][number]["changedPaths"][number]["states"][number];

async function collectGitPaths(
  checkoutPath: string,
  args: readonly string[],
  state: ChangeState,
  paths: Map<string, Set<ChangeState>>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["-C", checkoutPath, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let pending = Buffer.alloc(0);
    const consume = (path: string) => {
      const states = paths.get(path) ?? new Set<ChangeState>();
      states.add(state);
      paths.set(path, states);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      let separator = pending.indexOf(0);
      while (separator !== -1) {
        consume(pending.subarray(0, separator).toString("utf8"));
        pending = pending.subarray(separator + 1);
        separator = pending.indexOf(0);
      }
    });
    child.on("error", () => reject(new WorkspaceError("CHECKOUT_CHANGED", "Git diff failed.")));
    child.on("close", (code) => {
      if (code !== 0 || pending.length !== 0) {
        reject(new WorkspaceError("CHECKOUT_CHANGED", "Git diff inventory is incomplete."));
        return;
      }
      resolve();
    });
  });
}

async function headSha(checkoutPath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("git", ["-C", checkoutPath, "rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < 128) output += chunk.toString("utf8");
    });
    child.on("error", () =>
      reject(new WorkspaceError("CHECKOUT_CHANGED", "Git HEAD read failed.")),
    );
    child.on("close", (code) => {
      const value = output.trim();
      if (code !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value)) {
        reject(new WorkspaceError("CHECKOUT_CHANGED", "Git HEAD is invalid."));
        return;
      }
      resolve(value);
    });
  });
}

async function inventoryRepository(
  repository: WorkspaceVariantManifest["repositories"][number],
): Promise<WorkspaceDiffInventory["repositories"][number]> {
  const paths = new Map<string, Set<ChangeState>>();
  const head = await headSha(repository.checkoutPath);
  await collectGitPaths(
    repository.checkoutPath,
    ["diff", "--name-only", "-z", repository.expectedTargetSha, head],
    "committed",
    paths,
  );
  await collectGitPaths(
    repository.checkoutPath,
    ["diff", "--cached", "--name-only", "-z"],
    "staged",
    paths,
  );
  await collectGitPaths(repository.checkoutPath, ["diff", "--name-only", "-z"], "unstaged", paths);
  await collectGitPaths(
    repository.checkoutPath,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    "untracked",
    paths,
  );

  let emittedBytes = 0;
  const changedPaths: WorkspaceDiffInventory["repositories"][number]["changedPaths"] = [];
  for (const [path, states] of [...paths.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const entry = { path, states: [...states].toSorted() };
    const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (changedPaths.length >= DIFF_MAX_PATHS || emittedBytes + bytes > DIFF_MAX_BYTES) continue;
    changedPaths.push(entry);
    emittedBytes += bytes;
  }
  const undeclaredWrite = repository.access === "read-only" && paths.size > 0;
  return {
    repositoryId: repository.repositoryId,
    access: repository.access,
    baseSha: repository.expectedTargetSha,
    headSha: head,
    changedPaths,
    observedChangedPaths: paths.size,
    emittedBytes,
    truncated: changedPaths.length !== paths.size,
    undeclaredWrite,
  };
}

export interface ExecutionTaskWorkspaceService {
  provision(
    input: Omit<ProvisionWorkspaceVariantInput, "readRepositoryIds" | "writeRepositoryIds"> & {
      readonly task: ExecutionTaskRevision;
      readonly previousTaskRevision?: ExecutionTaskRevision;
      readonly codebaseRepositoryIds: readonly RepositoryId[];
    },
  ): Promise<TaskWorkspaceBinding>;
  inventory(
    task: ExecutionTaskRevision,
    workspaceId: string,
    variantId: string,
  ): Promise<WorkspaceDiffInventory>;
  prepareIntegration(
    task: ExecutionTaskRevision,
    request: VariantIntegrationRequest,
  ): Promise<WorkspaceVariantManifest>;
}

export function createExecutionTaskWorkspaceService(deps: {
  readonly variants: CompositeWorkspaceVariantService;
  readonly leases: WorkspaceLeaseService;
  readonly bindings: TaskBindingStore;
  readonly clock: { nowIso(): string };
}): ExecutionTaskWorkspaceService {
  async function requireBinding(
    task: ExecutionTaskRevision,
    workspaceId: string,
    variantId: string,
  ): Promise<TaskWorkspaceBinding> {
    const binding = await deps.bindings.load(workspaceId, variantId);
    if (
      binding === undefined ||
      binding.taskId !== task.taskId ||
      binding.taskRevision !== task.revision ||
      binding.taskRevisionSha256 !== task.revisionSha256
    ) {
      throw new WorkspaceError(
        "WORKSPACE_CONFLICT",
        "Workspace variant is not bound to this exact task revision.",
      );
    }
    return binding;
  }

  async function createInventory(
    task: ExecutionTaskRevision,
    binding: TaskWorkspaceBinding,
  ): Promise<WorkspaceDiffInventory> {
    const manifest = await deps.variants.inspect(binding.workspaceId, binding.variantId);
    const expectedAccess = new Map(
      binding.repositories.map((repository) => [repository.repositoryId, repository.access]),
    );
    if (
      manifest.repositories.length !== expectedAccess.size ||
      manifest.repositories.some(
        (repository) => expectedAccess.get(repository.repositoryId) !== repository.access,
      )
    ) {
      throw new WorkspaceError(
        "WORKSPACE_CONFLICT",
        "Variant access no longer matches its task binding.",
      );
    }
    const repositories: WorkspaceDiffInventory["repositories"] = [];
    for (const repository of manifest.repositories) {
      repositories.push(await inventoryRepository(repository));
    }
    const undeclaredWriteRepositories = repositories
      .filter((repository) => repository.undeclaredWrite)
      .map((repository) => repository.repositoryId);
    const hasChanges = repositories.some((repository) => repository.observedChangedPaths > 0);
    return {
      schemaVersion: 1,
      workspaceId: binding.workspaceId,
      variantId: binding.variantId,
      taskId: task.taskId,
      taskRevision: task.revision,
      taskRevisionSha256: task.revisionSha256,
      classification:
        undeclaredWriteRepositories.length > 0
          ? "replanning-required"
          : hasChanges
            ? "declared-changes"
            : "clean",
      repositories,
      undeclaredWriteRepositories,
      recordedAt: deps.clock.nowIso(),
    };
  }

  return {
    async provision(input) {
      validateExecutionTaskRevision({
        candidate: input.task,
        ...(input.previousTaskRevision === undefined
          ? {}
          : { previous: input.previousTaskRevision }),
        repositoryIds: input.codebaseRepositoryIds,
      });
      const existing = await deps.bindings.load(input.workspaceId, input.variantId);
      if (existing !== undefined) {
        if (
          existing.taskId === input.task.taskId &&
          existing.taskRevisionSha256 === input.task.revisionSha256
        ) {
          const manifest = await deps.variants.inspect(input.workspaceId, input.variantId);
          for (const repository of existing.repositories) {
            if (repository.access === "read-only") continue;
            const checkout = manifest.repositories.find(
              (candidate) => candidate.repositoryId === repository.repositoryId,
            );
            const lease =
              checkout === undefined ? undefined : deps.leases.current(checkout.checkoutPath);
            if (
              checkout === undefined ||
              lease === undefined ||
              lease.leaseId !== repository.leaseId ||
              lease.fencingRevision !== repository.fencingRevision
            ) {
              throw new WorkspaceError("LEASE_NOT_CURRENT", "Replayed task lease is not current.");
            }
            deps.leases.assertCurrent(lease, checkout.observedHeadSha);
          }
          return existing;
        }
        throw new WorkspaceError(
          "WORKSPACE_CONFLICT",
          "Write-set changes require a fresh variant and freshly validated leases.",
        );
      }
      const manifest = await deps.variants.provision({
        workspaceId: input.workspaceId,
        variantId: input.variantId,
        composite: input.composite,
        targets: input.targets,
        strategy: input.strategy,
        owner: input.owner,
        leaseTtlMilliseconds: input.leaseTtlMilliseconds,
        readRepositoryIds: input.task.readSet,
        writeRepositoryIds: input.task.writeSet,
      });
      const expected = new Set(input.task.readSet);
      if (
        manifest.repositories.length !== expected.size ||
        manifest.repositories.some(
          (repository) =>
            !expected.has(repository.repositoryId) ||
            repository.access !==
              (input.task.writeSet.includes(repository.repositoryId) ? "write" : "read-only"),
        )
      ) {
        throw new WorkspaceError("WORKSPACE_CONFLICT", "Variant does not match the task read set.");
      }
      const repositories: TaskWorkspaceBinding["repositories"] = [];
      for (const repository of manifest.repositories) {
        if (repository.access === "read-only") {
          repositories.push({
            repositoryId: repository.repositoryId,
            access: repository.access,
            expectedHeadSha: repository.observedHeadSha,
            leaseId: null,
            fencingRevision: null,
          });
          continue;
        }
        const lease = deps.leases.current(repository.checkoutPath);
        if (lease === undefined || lease.leaseId !== repository.leaseId) {
          throw new WorkspaceError("LEASE_NOT_CURRENT", "Task writer lease is not current.");
        }
        deps.leases.assertCurrent(lease, repository.observedHeadSha);
        repositories.push({
          repositoryId: repository.repositoryId,
          access: repository.access,
          expectedHeadSha: repository.observedHeadSha,
          leaseId: lease.leaseId,
          fencingRevision: lease.fencingRevision,
        });
      }
      const binding: TaskWorkspaceBinding = {
        schemaVersion: 1,
        workspaceId: manifest.workspaceId,
        variantId: manifest.variantId,
        taskId: input.task.taskId,
        taskRevision: input.task.revision,
        taskRevisionSha256: input.task.revisionSha256,
        repositories,
        boundAt: deps.clock.nowIso(),
      };
      await deps.bindings.create(binding);
      return binding;
    },
    async inventory(task, workspaceId, variantId) {
      const binding = await requireBinding(task, workspaceId, variantId);
      return await createInventory(task, binding);
    },
    async prepareIntegration(task, request) {
      const binding = await requireBinding(task, request.workspaceId, request.variantId);
      const inventory = await createInventory(task, binding);
      if (inventory.classification === "replanning-required") {
        throw new WorkspaceError(
          "UNDECLARED_WRITE",
          "Read-only repository changed; preserve this variant and replan into a fresh variant.",
        );
      }
      return await deps.variants.prepareIntegration(request);
    },
  };
}
