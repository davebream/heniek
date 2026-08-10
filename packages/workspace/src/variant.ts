import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  CompositeWorkspaceProvisioningManifest,
  IntegrationResultV1,
  RepositoryId,
  VariantIntegrationRequest,
  VariantIntegrationResult,
  VariantIntegrationTrace,
  WorkspaceId,
  WorkspaceVariantId,
  WorkspaceVariantManifest,
  WorkspaceWriterLease,
} from "@heniek/contracts";
import { WorkspaceError } from "./errors.js";
import { createLocalGitIntegrationAdapter, type GitIntegrationAdapter } from "./git-integration.js";
import {
  assertReadonlyWorkspaceUnchanged,
  captureWorkspaceGitState,
  type WorkspaceGitState,
} from "./safety.js";
import type { LeaseOwner, WorkspaceLeaseService } from "./types.js";

const execFileAsync = promisify(execFile);

export interface VariantTargetRef {
  readonly repositoryId: RepositoryId;
  readonly targetRef: string;
  readonly expectedSha: string;
}

export interface ProvisionWorkspaceVariantInput {
  readonly workspaceId: WorkspaceId;
  readonly variantId: WorkspaceVariantId;
  readonly composite: CompositeWorkspaceProvisioningManifest;
  readonly writeRepositoryIds: readonly RepositoryId[];
  readonly targets: readonly VariantTargetRef[];
  readonly strategy: WorkspaceVariantManifest["strategy"];
  readonly owner: LeaseOwner;
  readonly leaseTtlMilliseconds: number;
}

export interface VariantManifestStore {
  load(
    workspaceId: WorkspaceId,
    variantId: WorkspaceVariantId,
  ): Promise<WorkspaceVariantManifest | undefined>;
  record(manifest: WorkspaceVariantManifest): Promise<void>;
}

export interface VariantTraceStore {
  append(trace: VariantIntegrationTrace): Promise<void>;
  nextSequence?(workspaceId: WorkspaceId, variantId: WorkspaceVariantId): Promise<number>;
}

export interface CompositeWorkspaceVariantService {
  provision(input: ProvisionWorkspaceVariantInput): Promise<WorkspaceVariantManifest>;
  inspect(
    workspaceId: WorkspaceId,
    variantId: WorkspaceVariantId,
  ): Promise<WorkspaceVariantManifest>;
  prepareIntegration(request: VariantIntegrationRequest): Promise<WorkspaceVariantManifest>;
  publishIntegration(request: VariantIntegrationRequest): Promise<VariantIntegrationResult>;
}

export interface CreateCompositeWorkspaceVariantServiceInput {
  readonly workspacesDirectory: string;
  readonly clock: { nowIso(): string };
  readonly leases: WorkspaceLeaseService;
  readonly store?: VariantManifestStore;
  readonly traces?: VariantTraceStore;
  readonly git?: GitIntegrationAdapter;
}

function safeSegment(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value)) {
    throw new WorkspaceError("INVALID_PATH", `${label} is not a safe path segment.`);
  }
  return value;
}

async function git(checkout: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string };
    throw new WorkspaceError(
      "CHECKOUT_CHANGED",
      (failure.stderr?.trim() || failure.stdout?.trim() || "git operation failed").slice(0, 1024),
    );
  }
}

function createFileVariantManifestStore(workspacesDirectory: string): VariantManifestStore {
  const pathFor = (workspaceId: WorkspaceId, variantId: WorkspaceVariantId) =>
    join(workspacesDirectory, workspaceId, "variants", variantId, "variant.json");
  return {
    async load(workspaceId, variantId) {
      try {
        return JSON.parse(
          await readFile(pathFor(workspaceId, variantId), "utf8"),
        ) as WorkspaceVariantManifest;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async record(manifest) {
      const path = pathFor(manifest.workspaceId, manifest.variantId);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    },
  };
}

function createFileVariantTraceStore(workspacesDirectory: string): VariantTraceStore {
  const pathFor = (workspaceId: WorkspaceId, variantId: WorkspaceVariantId) =>
    join(workspacesDirectory, workspaceId, "variants", variantId, "integration-trace.jsonl");
  return {
    async append(trace) {
      const directory = join(workspacesDirectory, trace.workspaceId, "variants", trace.variantId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await appendFile(join(directory, "integration-trace.jsonl"), `${JSON.stringify(trace)}\n`, {
        mode: 0o600,
      });
    },
    async nextSequence(workspaceId, variantId) {
      try {
        const lines = (await readFile(pathFor(workspaceId, variantId), "utf8"))
          .split("\n")
          .filter((line) => line.length > 0);
        const last = lines.at(-1);
        return last === undefined ? 1 : (JSON.parse(last) as VariantIntegrationTrace).sequence + 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 1;
        throw error;
      }
    },
  };
}

export function createCompositeWorkspaceVariantService(
  deps: CreateCompositeWorkspaceVariantServiceInput,
): CompositeWorkspaceVariantService {
  const store = deps.store ?? createFileVariantManifestStore(deps.workspacesDirectory);
  const traces = deps.traces ?? createFileVariantTraceStore(deps.workspacesDirectory);
  const integrationGit = deps.git ?? createLocalGitIntegrationAdapter();
  const traceSequence = new Map<string, number>();

  async function record(manifest: WorkspaceVariantManifest): Promise<WorkspaceVariantManifest> {
    const next = { ...manifest, updatedAt: deps.clock.nowIso() };
    await store.record(next);
    return next;
  }

  async function trace(
    manifest: WorkspaceVariantManifest,
    phase: VariantIntegrationTrace["phase"],
    values: Partial<
      Pick<
        VariantIntegrationTrace,
        "repositoryId" | "expectedSha" | "observedSha" | "candidateSha" | "classification"
      >
    > = {},
  ): Promise<void> {
    const key = `${manifest.workspaceId}:${manifest.variantId}`;
    const previousSequence = traceSequence.get(key);
    const sequence =
      previousSequence !== undefined
        ? previousSequence + 1
        : await (traces.nextSequence?.(manifest.workspaceId, manifest.variantId) ??
            Promise.resolve(1));
    traceSequence.set(key, sequence);
    await traces.append({
      schemaVersion: 1,
      workspaceId: manifest.workspaceId,
      variantId: manifest.variantId,
      sequence,
      repositoryId: values.repositoryId ?? null,
      phase,
      expectedSha: values.expectedSha ?? null,
      observedSha: values.observedSha ?? null,
      candidateSha: values.candidateSha ?? null,
      classification: values.classification ?? null,
      recordedAt: deps.clock.nowIso(),
    });
  }

  async function requireManifest(workspaceId: WorkspaceId, variantId: WorkspaceVariantId) {
    const manifest = await store.load(workspaceId, variantId);
    if (manifest === undefined) {
      throw new WorkspaceError("WORKSPACE_NOT_FOUND", "Workspace variant was not found.");
    }
    return manifest;
  }

  async function releaseLease(repository: WorkspaceVariantManifest["repositories"][number]) {
    if (repository.leaseId === null) return;
    const current = deps.leases.current(repository.checkoutPath);
    if (
      current !== undefined &&
      current.state === "active" &&
      current.leaseId === repository.leaseId
    ) {
      deps.leases.release(current);
    }
  }

  return {
    async provision(input) {
      safeSegment(input.workspaceId, "workspace id");
      safeSegment(input.variantId, "variant id");
      if (
        input.composite.workspaceId !== input.workspaceId ||
        input.composite.lifecycle !== "ready"
      ) {
        throw new WorkspaceError(
          "WORKSPACE_CONFLICT",
          "Variant requires its ready composite workspace.",
        );
      }
      const writes = new Set(input.writeRepositoryIds);
      if (writes.size !== input.writeRepositoryIds.length || writes.size === 0) {
        throw new WorkspaceError(
          "INVALID_CONFIGURATION",
          "Variant write targets must be unique and non-empty.",
        );
      }
      const targets = new Map(input.targets.map((target) => [target.repositoryId, target]));
      const repositories = input.composite.repositories.toSorted((a, b) =>
        a.repositoryId.localeCompare(b.repositoryId),
      );
      if (
        [...writes].some((id) => !repositories.some((repository) => repository.repositoryId === id))
      ) {
        throw new WorkspaceError(
          "INVALID_CONFIGURATION",
          "Variant write target is not in the composite workspace.",
        );
      }
      if (repositories.some((repository) => !targets.has(repository.repositoryId))) {
        throw new WorkspaceError(
          "INVALID_CONFIGURATION",
          "Every variant repository requires a target ref and expected SHA.",
        );
      }
      const existing = await store.load(input.workspaceId, input.variantId);
      if (existing !== undefined) {
        if (existing.strategy !== input.strategy) {
          throw new WorkspaceError("WORKSPACE_CONFLICT", "Variant intent changed during replay.");
        }
        if (existing.lifecycle === "provisioning" || existing.lifecycle === "recovery-required") {
          throw new WorkspaceError(
            "RECOVERY_REQUIRED",
            "Variant provisioning outcome requires reconciliation.",
          );
        }
        return existing;
      }

      const variantRoot = join(
        deps.workspacesDirectory,
        input.workspaceId,
        "variants",
        input.variantId,
      );
      await mkdir(join(variantRoot, "checkouts"), { recursive: true, mode: 0o700 });
      const acquired: WorkspaceWriterLease[] = [];
      const planned = repositories.map((repository) => {
        if (repository.checkoutPath === null || repository.gitCommonDirectory === null) {
          throw new WorkspaceError(
            "WORKSPACE_CONFLICT",
            "Composite repository has no verified checkout identity.",
          );
        }
        const target = targets.get(repository.repositoryId);
        if (target === undefined) {
          throw new WorkspaceError("INVALID_CONFIGURATION", "Variant target is missing.");
        }
        if (target.expectedSha !== repository.checkoutHeadSha) {
          throw new WorkspaceError(
            "CHECKOUT_CHANGED",
            "Variant expected SHA differs from the composite checkout HEAD.",
          );
        }
        const sourceCheckoutPath = repository.checkoutPath;
        const gitCommonDirectory = repository.gitCommonDirectory;
        return {
          repository,
          target,
          sourceCheckoutPath,
          gitCommonDirectory,
          checkoutPath: join(
            variantRoot,
            "checkouts",
            safeSegment(repository.name, "repository name"),
          ),
        };
      });

      try {
        for (const item of planned.filter(({ repository }) =>
          writes.has(repository.repositoryId),
        )) {
          acquired.push(
            deps.leases.acquire({
              workspaceId: input.workspaceId,
              repositoryId: item.repository.repositoryId,
              checkoutPath: item.checkoutPath,
              expectedSha: item.target.expectedSha,
              ttlMilliseconds: input.leaseTtlMilliseconds,
              ...input.owner,
            }),
          );
        }
        const now = deps.clock.nowIso();
        let manifest: WorkspaceVariantManifest = {
          schemaVersion: 1,
          workspaceId: input.workspaceId,
          variantId: input.variantId,
          strategy: input.strategy,
          lifecycle: "provisioning",
          variantRoot,
          repositories: [],
          createdAt: now,
          updatedAt: now,
        };
        await store.record(manifest);
        for (const item of planned) {
          const managed = item.repository.strategy === "managed-worktree";
          if (managed) {
            await git(item.sourceCheckoutPath, [
              "--git-dir",
              item.gitCommonDirectory,
              "worktree",
              "add",
              "--detach",
              item.checkoutPath,
              item.target.expectedSha,
            ]);
          } else {
            await git(item.sourceCheckoutPath, [
              "clone",
              "--no-hardlinks",
              "--no-checkout",
              item.sourceCheckoutPath,
              item.checkoutPath,
            ]);
            await git(item.checkoutPath, ["checkout", "--detach", item.target.expectedSha]);
          }
          const observedHeadSha = await git(item.checkoutPath, ["rev-parse", "HEAD"]);
          if (observedHeadSha !== item.target.expectedSha) {
            throw new WorkspaceError(
              "CHECKOUT_CHANGED",
              "Materialized variant checkout has an unexpected HEAD.",
            );
          }
          const lease = acquired.find(
            (candidate) => candidate.repositoryId === item.repository.repositoryId,
          );
          const capturedBaseline = writes.has(item.repository.repositoryId)
            ? null
            : await captureWorkspaceGitState(item.checkoutPath);
          const readOnlyBaseline =
            capturedBaseline === null
              ? null
              : { ...capturedBaseline, untracked: [...capturedBaseline.untracked] };
          manifest = await record({
            ...manifest,
            repositories: [
              ...manifest.repositories,
              {
                repositoryId: item.repository.repositoryId,
                name: item.repository.name,
                access: writes.has(item.repository.repositoryId) ? "write" : "read-only",
                materialization: managed ? "worktree" : "clone",
                checkoutPath: item.checkoutPath,
                sourceCheckoutPath: item.sourceCheckoutPath,
                targetRef: item.target.targetRef,
                expectedTargetSha: item.target.expectedSha,
                observedHeadSha,
                leaseId: lease?.leaseId ?? null,
                readOnlyBaseline,
                phase: "ready",
                candidateSha: null,
                resultSha: null,
              },
            ],
          });
        }
        return await record({ ...manifest, lifecycle: "ready" });
      } catch (error) {
        for (const lease of acquired.toReversed()) {
          const current = deps.leases.current(lease.checkoutPath);
          if (current?.leaseId === lease.leaseId && current.state === "active")
            deps.leases.release(current);
        }
        throw error;
      }
    },

    async inspect(workspaceId, variantId) {
      return await requireManifest(workspaceId, variantId);
    },

    async prepareIntegration(request) {
      let manifest = await requireManifest(request.workspaceId, request.variantId);
      if (manifest.strategy !== request.strategy) {
        throw new WorkspaceError(
          "WORKSPACE_CONFLICT",
          "Integration strategy differs from variant provenance.",
        );
      }
      if (manifest.lifecycle === "prepared" || manifest.lifecycle === "integrated") return manifest;
      await trace(manifest, "intent-recorded");
      for (let index = 0; index < manifest.repositories.length; index += 1) {
        const repository = manifest.repositories[index];
        if (repository === undefined) {
          throw new WorkspaceError("RECOVERY_REQUIRED", "Variant repository inventory changed.");
        }
        const head = await integrationGit.readRefSha(repository.checkoutPath, "HEAD");
        await trace(manifest, "source-observed", {
          repositoryId: repository.repositoryId,
          observedSha: head,
        });
        if (repository.access === "read-only") {
          if (repository.readOnlyBaseline === null) {
            throw new WorkspaceError("RECOVERY_REQUIRED", "Read-only variant baseline is missing.");
          }
          assertReadonlyWorkspaceUnchanged(
            repository.readOnlyBaseline as WorkspaceGitState,
            await captureWorkspaceGitState(repository.checkoutPath),
          );
          continue;
        }
        const status = await git(repository.checkoutPath, ["status", "--porcelain=v1"]);
        if (status.length > 0)
          throw new WorkspaceError(
            "CHECKOUT_DIRTY",
            "Variant write checkout has uncommitted changes.",
          );
        const lease = deps.leases.current(repository.checkoutPath);
        if (lease === undefined || lease.leaseId !== repository.leaseId) {
          throw new WorkspaceError(
            "LEASE_NOT_CURRENT",
            "Variant writer lease is no longer current.",
          );
        }
        deps.leases.assertCurrent(lease, head);
        const target = await integrationGit.readRefSha(
          repository.sourceCheckoutPath,
          repository.targetRef,
        );
        await trace(manifest, "target-observed", {
          repositoryId: repository.repositoryId,
          expectedSha: repository.expectedTargetSha,
          observedSha: target,
        });
        if (target !== repository.expectedTargetSha) {
          manifest = await record({
            ...manifest,
            lifecycle: "conflict",
            repositories: manifest.repositories.with(index, {
              ...repository,
              phase: "stale",
              observedHeadSha: head,
            }),
          });
          await releaseLease(repository);
          return manifest;
        }
        await integrationGit.importCommit?.(
          repository.sourceCheckoutPath,
          repository.checkoutPath,
          head,
        );
        const prepared = await integrationGit.prepareMergeCandidate({
          checkoutPath: repository.sourceCheckoutPath,
          sourceSha: head,
          targetSha: repository.expectedTargetSha,
          message: `Integrate variant ${manifest.variantId} for ${repository.repositoryId}`,
        });
        if (prepared.status === "conflict") {
          manifest = await record({
            ...manifest,
            lifecycle: "conflict",
            repositories: manifest.repositories.with(index, {
              ...repository,
              phase: "conflict",
              observedHeadSha: head,
            }),
          });
          await releaseLease(repository);
          return manifest;
        }
        await trace(manifest, "merge-prepared", {
          repositoryId: repository.repositoryId,
          candidateSha: prepared.candidateSha,
          classification: prepared.status,
        });
        manifest = await record({
          ...manifest,
          repositories: manifest.repositories.with(index, {
            ...repository,
            observedHeadSha: head,
            candidateSha: prepared.candidateSha,
            phase: prepared.status === "already_applied" ? "already-applied" : "prepared",
          }),
        });
        await releaseLease(repository);
      }
      return await record({ ...manifest, lifecycle: "prepared" });
    },

    async publishIntegration(request) {
      let manifest = await this.prepareIntegration(request);
      const results: IntegrationResultV1[] = [];
      let moved = 0;
      let failure: VariantIntegrationResult["classification"] | undefined;
      for (let index = 0; index < manifest.repositories.length; index += 1) {
        const repository = manifest.repositories[index];
        if (repository === undefined) {
          throw new WorkspaceError("RECOVERY_REQUIRED", "Variant repository inventory changed.");
        }
        if (repository.access === "read-only") continue;
        if (repository.candidateSha === null) {
          failure = repository.phase === "stale" ? "stale-target" : "conflict";
          results.push({
            schemaVersion: 1,
            repositoryId: repository.repositoryId,
            sourceRef: "HEAD",
            targetRef: repository.targetRef,
            expectedSourceSha: repository.observedHeadSha,
            expectedTargetSha: repository.expectedTargetSha,
            classification: repository.phase === "stale" ? "stale_target" : "merge_conflict",
            targetMoved: false,
            finishedAt: deps.clock.nowIso(),
          });
          break;
        }
        const actual = await integrationGit.readRefSha(
          repository.sourceCheckoutPath,
          repository.targetRef,
        );
        if (actual === repository.candidateSha) {
          results.push({
            schemaVersion: 1,
            repositoryId: repository.repositoryId,
            sourceRef: "HEAD",
            targetRef: repository.targetRef,
            expectedSourceSha: repository.observedHeadSha,
            expectedTargetSha: repository.expectedTargetSha,
            candidateSha: repository.candidateSha,
            resultSha: actual,
            classification: "already_applied",
            targetMoved: false,
            finishedAt: deps.clock.nowIso(),
          });
          manifest = await record({
            ...manifest,
            repositories: manifest.repositories.with(index, {
              ...repository,
              phase: "already-applied",
              resultSha: actual,
            }),
          });
          continue;
        }
        if (actual !== repository.expectedTargetSha) {
          failure = moved > 0 ? "partial-progress" : "stale-target";
          results.push({
            schemaVersion: 1,
            repositoryId: repository.repositoryId,
            sourceRef: "HEAD",
            targetRef: repository.targetRef,
            expectedSourceSha: repository.observedHeadSha,
            expectedTargetSha: repository.expectedTargetSha,
            candidateSha: repository.candidateSha,
            classification: "stale_target",
            targetMoved: false,
            finishedAt: deps.clock.nowIso(),
            detail: `target moved to ${actual}`,
          });
          manifest = await record({
            ...manifest,
            lifecycle: moved > 0 ? "partial-progress" : "conflict",
            repositories: manifest.repositories.with(index, { ...repository, phase: "stale" }),
          });
          break;
        }
        await trace(manifest, "ref-update-attempted", {
          repositoryId: repository.repositoryId,
          expectedSha: repository.expectedTargetSha,
          candidateSha: repository.candidateSha,
        });
        const update = await integrationGit.updateRefCompareAndSwap({
          checkoutPath: repository.sourceCheckoutPath,
          ref: repository.targetRef,
          expectedSha: repository.expectedTargetSha,
          newSha: repository.candidateSha,
        });
        if (update.status === "stale") {
          failure = moved > 0 ? "partial-progress" : "stale-target";
          results.push({
            schemaVersion: 1,
            repositoryId: repository.repositoryId,
            sourceRef: "HEAD",
            targetRef: repository.targetRef,
            expectedSourceSha: repository.observedHeadSha,
            expectedTargetSha: repository.expectedTargetSha,
            candidateSha: repository.candidateSha,
            classification: "stale_target",
            targetMoved: false,
            finishedAt: deps.clock.nowIso(),
            detail: `target moved to ${update.actualSha}`,
          });
          manifest = await record({
            ...manifest,
            lifecycle: moved > 0 ? "partial-progress" : "conflict",
            repositories: manifest.repositories.with(index, { ...repository, phase: "stale" }),
          });
          break;
        }
        moved += 1;
        await trace(manifest, "ref-update-observed", {
          repositoryId: repository.repositoryId,
          observedSha: repository.candidateSha,
          classification: "integrated",
        });
        results.push({
          schemaVersion: 1,
          repositoryId: repository.repositoryId,
          sourceRef: "HEAD",
          targetRef: repository.targetRef,
          expectedSourceSha: repository.observedHeadSha,
          expectedTargetSha: repository.expectedTargetSha,
          candidateSha: repository.candidateSha,
          resultSha: repository.candidateSha,
          classification: "none",
          targetMoved: true,
          finishedAt: deps.clock.nowIso(),
        });
        manifest = await record({
          ...manifest,
          repositories: manifest.repositories.with(index, {
            ...repository,
            phase: "integrated",
            resultSha: repository.candidateSha,
          }),
        });
      }
      const classification = failure ?? (moved === 0 ? "already-applied" : "integrated");
      manifest = await record({
        ...manifest,
        lifecycle:
          classification === "integrated" || classification === "already-applied"
            ? "integrated"
            : classification === "partial-progress"
              ? "partial-progress"
              : "conflict",
      });
      await trace(manifest, "completed", { classification });
      return {
        schemaVersion: 1,
        workspaceId: manifest.workspaceId,
        variantId: manifest.variantId,
        strategy: manifest.strategy,
        classification,
        repositories: results,
        finishedAt: deps.clock.nowIso(),
      };
    },
  };
}
