import { createHash } from "node:crypto";
import type {
  ArtifactId,
  DoctorReportV1,
  ExecutionBackendV2,
  InteractionAnswerSetV1,
  RunId,
  StageId,
  WorkspaceConfiguration,
  WorkspaceId,
} from "@heniek/contracts";
import { ExternalStageResultV1 } from "@heniek/contracts";
import type { IdGenerator } from "@heniek/state";
import {
  assignBackendExecution,
  commitStateChange,
  completePendingArtifactImports,
  completeStage,
  createArtifactStore,
  createStageExecution,
  executionCleanupCounts,
  findRegisteredExecutionContext,
  markArtifactImport,
  markExecutionFinalized,
  publishArtifact,
  readActiveStageExecutions,
  readArtifactRecord,
  readIdentity,
  readPendingInteractions,
  readStageArtifacts,
  readStageExecution,
  recordInteractionAnswer,
  replacePendingInteractions,
  type StageExecutionRow,
  type StateDatabase,
  updateStageExecutionStatus,
} from "@heniek/state";
import type { WorkspaceService } from "@heniek/workspace";
import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export interface ExecutionServiceOptions {
  readonly db: StateDatabase;
  readonly backend: ExecutionBackendV2;
  readonly workspaceService: WorkspaceService;
  readonly artifactsDirectory: string;
  readonly instanceId: string;
  readonly ids: IdGenerator;
  readonly pollMilliseconds?: number;
  readonly faultInjection?: {
    readonly afterAtomicCompletion?: () => void;
  };
}

export class ExecutionServiceCrashFault extends Error {
  override readonly name = "ExecutionServiceCrashFault";
}

export interface StartStageInput {
  readonly currentDirectory: string;
  readonly prompt: string;
  readonly artifactPath: string;
  readonly limits?: { readonly maxDurationMs?: number; readonly maxTurns?: number };
}

export interface ExecutionService {
  start(input: StartStageInput): Promise<{ readonly runId: string; readonly stageId: string }>;
  status(runId: string): Promise<StageExecutionRow>;
  answer(runId: string, answer: Static<typeof InteractionAnswerSetV1>): Promise<void>;
  resume(runId: string, inputArtifactRefs: ArtifactId[]): Promise<void>;
  cancel(runId: string): Promise<void>;
  result(runId: string): Promise<StageExecutionRow>;
  doctor(): Promise<Static<typeof DoctorReportV1>>;
  observeAll(): Promise<void>;
  stop(): void;
}

function safeDeclaredPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split("/").some((segment) => segment.length === 0 || segment === "..")
  );
}

function executionOrThrow(db: StateDatabase, runId: string): StageExecutionRow {
  const row = readStageExecution(db, runId);
  if (row === undefined) throw new Error(`stage execution does not exist: ${runId}`);
  return row;
}

export function createExecutionService(options: ExecutionServiceOptions): ExecutionService {
  const pollMilliseconds = options.pollMilliseconds ?? 500;
  const artifactStore = createArtifactStore({
    root: options.artifactsDirectory,
    clock: { nowIso: () => new Date().toISOString() },
    ids: options.ids,
  });
  const owner = {
    ownerId: options.instanceId,
    bootWitness: null,
    processWitnesses: [{ kind: "process" as const, value: process.pid }],
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observing = new Set<string>();

  function workspaceConfiguration(remote: string, branch: string): WorkspaceConfiguration {
    return {
      schemaVersion: 1,
      strategy: "managed-worktree",
      base: { remote, branch },
      synchronization: { strategy: "notify" },
      files: { copy: [] },
      scripts: { setup: null },
      lease: { ttlMilliseconds: 300_000, renewEveryMilliseconds: 60_000 },
    };
  }

  async function ensureBackendHandle(row: StageExecutionRow): Promise<StageExecutionRow> {
    if (row.backendExecutionId !== null) return row;
    const workspace = readIdentity(options.db, "workspace", row.workspaceId);
    if (workspace?.checkoutPath === null || workspace?.checkoutPath === undefined) {
      throw new Error(`workspace is not ready for run ${row.runId}`);
    }
    const handle = await options.backend.start({
      schemaVersion: 2,
      runId: row.runId,
      stageId: row.stageId as StageId,
      workspaceId: row.workspaceId as WorkspaceId,
      workingDirectory: workspace.checkoutPath,
      prompt: row.prompt,
      artifactPath: row.artifactPath,
      inputArtifactRefs: [],
      limits: row.limits,
    });
    assignBackendExecution(options.db, row.runId, handle.executionId);
    return executionOrThrow(options.db, row.runId);
  }

  function releaseLease(row: StageExecutionRow): void {
    const workspace = readIdentity(options.db, "workspace", row.workspaceId);
    const checkoutPath = workspace?.checkoutPath;
    if (checkoutPath === null || checkoutPath === undefined) return;
    const lease = options.workspaceService.leases.current(checkoutPath);
    if (lease?.state === "active") options.workspaceService.leases.release(lease);
  }

  async function finalizeSuccess(row: StageExecutionRow): Promise<void> {
    if (readStageArtifacts(options.db, row.runId).length > 0) {
      const result = await options.backend.result(row.backendExecutionId ?? "");
      completePendingArtifactImports(options.db, row.runId);
      markExecutionFinalized(options.db, row.runId, {
        status: "succeeded",
        summary: result.summary,
        ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
      });
      releaseLease(row);
      return;
    }
    const executionId = row.backendExecutionId;
    if (executionId === null) throw new Error(`run ${row.runId} has no backend handle`);
    const result = await options.backend.result(executionId);
    const listed = await options.backend.artifacts(executionId);
    const artifact = listed.find((entry) => entry.path === row.artifactPath);
    if (artifact === undefined) {
      throw new Error(`backend did not produce declared artifact ${row.artifactPath}`);
    }
    if (
      !Value.Check(ExternalStageResultV1, {
        schemaVersion: 1,
        summary: result.summary,
        artifactPath: artifact.path,
      })
    ) {
      throw new Error("backend terminal result does not satisfy ExternalStageResult/v1");
    }
    const bytes = await options.backend.readArtifact(executionId, artifact.id);
    if (bytes.byteLength !== artifact.byteLength) {
      throw new Error("backend artifact byte length changed between list and retrieval");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (artifact.sha256 !== undefined && artifact.sha256 !== digest) {
      throw new Error("backend artifact digest does not match its descriptor");
    }
    const receipt = publishArtifact(artifactStore, { bytes, expectedContentHash: digest });
    markArtifactImport(options.db, {
      runId: row.runId,
      backendArtifactId: artifact.id,
      contentHash: digest,
      byteLength: bytes.byteLength,
      state: "pending",
    });
    completeStage(options.db, artifactStore, {
      runId: row.runId,
      stageId: row.stageId,
      terminalRunStatus: "succeeded",
      artifacts: [
        {
          receipt,
          name: row.artifactPath,
          mediaType: artifact.mediaType,
          contentSchemaId: "heniek://contract/ExternalStageResult/v1",
          producer: "execution-backend",
          sourceLineage: [artifact.id],
        },
      ],
    });
    options.faultInjection?.afterAtomicCompletion?.();
    markArtifactImport(options.db, {
      runId: row.runId,
      backendArtifactId: artifact.id,
      artifactId: receipt.artifactId,
      contentHash: digest,
      byteLength: bytes.byteLength,
      state: "completed",
    });
    markExecutionFinalized(options.db, row.runId, {
      status: "succeeded",
      summary: result.summary,
      ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
    });
    releaseLease(row);
  }

  async function observe(runId: string): Promise<void> {
    if (observing.has(runId)) return;
    observing.add(runId);
    try {
      let row = executionOrThrow(options.db, runId);
      if (row.status === "succeeded" || row.status === "failed" || row.status === "cancelled") {
        return;
      }
      row = await ensureBackendHandle(row);
      const executionId = row.backendExecutionId;
      if (executionId === null) return;
      const status = await options.backend.status(executionId);
      const interactions = await options.backend.interactions(executionId);
      replacePendingInteractions(options.db, runId, interactions);
      if (status === "succeeded") {
        try {
          await finalizeSuccess(row);
        } catch (error) {
          if (error instanceof ExecutionServiceCrashFault) throw error;
          const message = error instanceof Error ? error.message : String(error);
          updateStageExecutionStatus(options.db, runId, "failed", { error: message });
          markExecutionFinalized(options.db, runId, {
            status: "failed",
            summary: "Artifact validation or import failed.",
            error: message,
          });
          releaseLease(row);
        }
      } else if (status === "failed" || status === "cancelled") {
        const result = await options.backend.result(executionId);
        updateStageExecutionStatus(options.db, runId, status, {
          summary: result.summary,
          ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
        });
        markExecutionFinalized(options.db, runId, {
          status,
          summary: result.summary,
          ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
        });
        releaseLease(row);
      } else {
        updateStageExecutionStatus(options.db, runId, status);
      }
    } finally {
      observing.delete(runId);
    }
  }

  async function observeAll(): Promise<void> {
    for (const row of readActiveStageExecutions(options.db)) {
      try {
        await observe(row.runId);
      } catch {
        if (row.backendExecutionId !== null) {
          updateStageExecutionStatus(options.db, row.runId, "recovery_required");
        }
      }
    }
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void observeAll().finally(schedule);
    }, pollMilliseconds);
    timer.unref?.();
  }
  schedule();

  return {
    async start(input) {
      if (!safeDeclaredPath(input.artifactPath)) {
        throw new Error("artifact path must be a safe relative path");
      }
      const context = findRegisteredExecutionContext(options.db, input.currentDirectory);
      if (context === undefined) {
        throw new Error("current directory is not inside a registered repository");
      }
      const runId = options.ids.next("run") as RunId;
      const stageId = options.ids.next("stage") as StageId;
      const workspaceId = options.ids.next("workspace") as WorkspaceId;
      commitStateChange(options.db, {
        runId,
        type: "run.created",
        payload: { runId, codebaseId: context.codebaseId },
      });
      commitStateChange(options.db, {
        type: "workspace.registered",
        payload: { workspaceId, codebaseId: context.codebaseId },
      });
      createStageExecution(options.db, {
        runId,
        stageId,
        codebaseId: context.codebaseId,
        repositoryId: context.repositoryId,
        workspaceId,
        backendKind: "claudexor-v2",
        prompt: input.prompt,
        artifactPath: input.artifactPath,
        limits: input.limits ?? {},
      });
      let manifest: Awaited<ReturnType<WorkspaceService["provision"]>>;
      try {
        manifest = await options.workspaceService.provision({
          workspaceId,
          codebaseId: context.codebaseId as never,
          repositoryId: context.repositoryId as never,
          integrationBranch: `heniek-${runId}`,
          owner,
          configuration: workspaceConfiguration(context.defaultRemote, context.defaultBranch),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "managed workspace provisioning failed";
        updateStageExecutionStatus(options.db, runId, "failed", { error: message });
        markExecutionFinalized(options.db, runId, {
          status: "failed",
          summary: "Managed workspace provisioning failed.",
          error: message,
        });
        releaseLease(executionOrThrow(options.db, runId));
        throw error;
      }
      if (manifest.lifecycle !== "ready") {
        updateStageExecutionStatus(options.db, runId, "failed", {
          error: "managed workspace provisioning failed",
        });
        markExecutionFinalized(options.db, runId, {
          status: "failed",
          summary: "Managed workspace provisioning failed.",
          error: "managed workspace provisioning failed",
        });
        releaseLease(executionOrThrow(options.db, runId));
        throw new Error("managed workspace provisioning failed");
      }
      commitStateChange(options.db, {
        runId,
        type: "run.workspace_assigned",
        payload: { runId, workspaceId },
      });
      const row = await ensureBackendHandle(executionOrThrow(options.db, runId));
      updateStageExecutionStatus(options.db, runId, "running");
      return { runId: row.runId, stageId: row.stageId };
    },

    async status(runId) {
      await observe(runId);
      return executionOrThrow(options.db, runId);
    },

    async answer(runId, answer) {
      const row = executionOrThrow(options.db, runId);
      if (row.backendExecutionId === null) throw new Error("backend handle is unavailable");
      const pending = readPendingInteractions(options.db, runId);
      if (!pending.some((entry) => entry.id === answer.interactionId)) {
        throw new Error(`pending interaction does not exist: ${answer.interactionId}`);
      }
      await options.backend.answer(row.backendExecutionId, answer);
      recordInteractionAnswer(options.db, runId, answer);
      await observe(runId);
    },

    async resume(runId, inputArtifactRefs) {
      const row = executionOrThrow(options.db, runId);
      if (row.backendExecutionId === null) throw new Error("backend handle is unavailable");
      if (row.status === "succeeded" || row.status === "failed" || row.status === "cancelled") {
        throw new Error("terminal runs cannot be resumed");
      }
      await options.backend.resume(row.backendExecutionId, inputArtifactRefs);
      updateStageExecutionStatus(options.db, runId, "running");
    },

    async cancel(runId) {
      const row = executionOrThrow(options.db, runId);
      if (row.backendExecutionId !== null) await options.backend.cancel(row.backendExecutionId);
      await observe(runId);
    },

    async result(runId) {
      await observe(runId);
      return executionOrThrow(options.db, runId);
    },

    async doctor() {
      const diagnosticBackend = options.backend as ExecutionBackendV2 & {
        diagnoseRuntime?: () => Promise<Static<typeof DoctorReportV1>["checks"][number]>;
        diagnoseAuthRoute?: () => Promise<Static<typeof DoctorReportV1>["checks"][number]>;
        diagnoseCompatibility?: () => Promise<
          readonly Static<typeof DoctorReportV1>["checks"][number][]
        >;
      };
      const checks: Static<typeof DoctorReportV1>["checks"] = [];
      checks.push(
        diagnosticBackend.diagnoseRuntime === undefined
          ? {
              category: "runtime",
              status: "warn",
              code: "RUNTIME_PROBE_UNAVAILABLE",
              message: "The injected backend does not expose a pinned-runtime probe.",
            }
          : await diagnosticBackend.diagnoseRuntime(),
      );
      if (diagnosticBackend.diagnoseAuthRoute === undefined) {
        checks.push({
          category: "auth-route",
          status: "warn",
          code: "AUTH_ROUTE_PROBE_UNAVAILABLE",
          message: "The injected backend does not expose a subscription-route attestation probe.",
        });
      } else {
        checks.push(await diagnosticBackend.diagnoseAuthRoute());
      }
      if (diagnosticBackend.diagnoseCompatibility === undefined) {
        checks.push({
          category: "compatibility",
          status: "warn",
          code: "COMPATIBILITY_PROBE_UNAVAILABLE",
          message: "The injected backend does not expose a Claudexor compatibility probe.",
        });
      } else {
        checks.push(...(await diagnosticBackend.diagnoseCompatibility()));
      }
      const cleanup = executionCleanupCounts(options.db);
      const dirty =
        cleanup.missingHandles +
        cleanup.partialImports +
        cleanup.terminalUnfinalized +
        cleanup.expiredActiveLeases +
        cleanup.terminalActiveLeases;
      checks.push(
        dirty === 0
          ? {
              category: "cleanup",
              status: "pass",
              code: "EXECUTION_STATE_CLEAN",
              message:
                "No stale process/lease witnesses, missing handles, partial imports, or unfinalized terminal executions were found.",
            }
          : {
              category: "cleanup",
              status: "fail",
              code: "EXECUTION_CLEANUP_REQUIRED",
              message: `${dirty} stale process/lease or execution cleanup issue(s) require reconciliation.`,
              remediation:
                "Restart the Heniek daemon to reconcile active handles and artifact imports.",
            },
      );
      const health = checks.some((check) => check.status === "fail")
        ? "failed"
        : checks.some((check) => check.status === "warn")
          ? "degraded"
          : "healthy";
      return { schemaVersion: 1, health, checks };
    },

    observeAll,

    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export function stageRunResult(db: StateDatabase, row: StageExecutionRow) {
  return {
    schemaVersion: 1 as const,
    runId: row.runId,
    stageId: row.stageId,
    status: row.status,
    ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.sessionId === null ? {} : { sessionId: row.sessionId }),
    artifacts: readStageArtifacts(db, row.runId).map((artifact) => ({
      name: artifact.name,
      artifactId: artifact.artifactId,
      mediaType: artifact.mediaType,
      byteLength: artifact.byteLength,
      sha256: artifact.contentHash,
    })),
    ...(row.error === null ? {} : { error: row.error }),
  };
}

export function artifactResult(db: StateDatabase, artifactId: string) {
  return readArtifactRecord(db, artifactId);
}
