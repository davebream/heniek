import type {
  ArtifactId,
  DoctorReportV2,
  ExecutionBackendDiagnosticV1,
  ExecutionBackendV2,
  ExecutionResumeRequestV1,
  InteractionAnswerSetV1,
  InteractionAnswerSubmissionV2,
  RunId,
  StageId,
  WorkspaceConfiguration,
  WorkspaceId,
} from "@heniek/contracts";
import { redactText } from "@heniek/secrets";
import type { IdGenerator } from "@heniek/state";
import {
  type AcceptedInteractionAnswer,
  acceptInteractionAnswer,
  assignBackendExecution,
  commitStateChange,
  completePendingArtifactImports,
  createArtifactStore,
  createStageExecution,
  executionCleanupCounts,
  findRegisteredExecutionContext,
  markArtifactImport,
  markExecutionFinalized,
  markExecutionOperationDelivered,
  type RequestedRunResume,
  readActiveStageExecutions,
  readArtifactRecord,
  readIdentity,
  readPendingExecutionOperations,
  readRunInteractions,
  readRunProjection,
  readStageArtifacts,
  readStageExecution,
  recordExecutionOperationFailure,
  requestRunResume,
  type StageExecutionRow,
  type StateDatabase,
  synchronizePendingInteractions,
  updateStageExecutionStatus,
} from "@heniek/state";
import type { WorkspaceService } from "@heniek/workspace";
import type { Static } from "@sinclair/typebox";
import { doctorHealthFromChecks } from "../capability/doctor.js";
import { finalizeStageArtifact } from "./stage-completion.js";

export type DurableExecutionBackend = Omit<ExecutionBackendV2, "resume"> & {
  resume(request: Static<typeof ExecutionResumeRequestV1>): Promise<void>;
};

export interface ExecutionServiceOptions {
  readonly db: StateDatabase;
  readonly backend: DurableExecutionBackend;
  readonly workspaceService: WorkspaceService;
  readonly artifactsDirectory: string;
  readonly instanceId: string;
  readonly ids: IdGenerator;
  readonly pollMilliseconds?: number;
  readonly faultInjection?: {
    readonly afterAtomicCompletion?: () => void;
    readonly afterOperationCommitted?: () => void;
    readonly afterBackendAcknowledged?: () => void;
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
  answer(
    runId: string,
    answer: Static<typeof InteractionAnswerSubmissionV2>,
    answeredByKeyId: string,
  ): Promise<
    AcceptedInteractionAnswer & {
      readonly deliveryState: "pending" | "delivered";
      readonly interactionRevision: number;
    }
  >;
  resume(
    runId: string,
    expectedRunRevision: number,
    inputArtifactRefs: ArtifactId[],
  ): Promise<
    Omit<RequestedRunResume, "status"> & {
      readonly deliveryState: "pending" | "delivered";
      readonly status: "recovery_required" | "running";
    }
  >;
  cancel(runId: string): Promise<void>;
  result(runId: string): Promise<StageExecutionRow>;
  doctor(): Promise<Static<typeof DoctorReportV2>>;
  observeAll(): Promise<void>;
  drainPendingOperations(): Promise<void>;
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
  const delivering = new Set<string>();

  async function deliverOperation(
    operation: ReturnType<typeof readPendingExecutionOperations>[number],
  ): Promise<number | null> {
    if (delivering.has(operation.operationId)) return null;
    delivering.add(operation.operationId);
    try {
      if (operation.kind === "answer") {
        await options.backend.answer(
          operation.backendExecutionId,
          operation.payload as Static<typeof InteractionAnswerSetV1>,
        );
      } else {
        const payload = operation.payload as { readonly inputArtifactRefs: readonly string[] };
        await options.backend.resume({
          schemaVersion: 1,
          executionId: operation.backendExecutionId as never,
          operationId: operation.operationId,
          inputArtifactRefs: payload.inputArtifactRefs as ArtifactId[],
        });
      }
      options.faultInjection?.afterBackendAcknowledged?.();
      const revision = markExecutionOperationDelivered(options.db, operation.operationId);
      if (operation.kind === "resume") {
        updateStageExecutionStatus(options.db, operation.runId, "running");
        return executionOrThrow(options.db, operation.runId).status === "running"
          ? (readRunProjection(options.db, operation.runId)?.revision ?? revision)
          : revision;
      }
      return revision;
    } catch (error) {
      if (error instanceof ExecutionServiceCrashFault) throw error;
      recordExecutionOperationFailure(options.db, operation.operationId, "backend delivery failed");
      return null;
    } finally {
      delivering.delete(operation.operationId);
    }
  }

  async function drainPendingOperations(): Promise<void> {
    for (const operation of readPendingExecutionOperations(options.db)) {
      await deliverOperation(operation);
    }
  }

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
        summary: redactText(result.summary),
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
    const bytes = await options.backend.readArtifact(executionId, artifact.id);
    finalizeStageArtifact(options.db, artifactStore, {
      runId: row.runId,
      stageId: row.stageId,
      summary: result.summary,
      artifactPath: artifact.path,
      bytes,
      mediaType: artifact.mediaType,
      producer: "execution-backend",
      sourceLineage: [artifact.id],
      declaredByteLength: artifact.byteLength,
      ...(artifact.sha256 === undefined ? {} : { declaredSha256: artifact.sha256 }),
      onPublished: (_receipt, contentHash) => {
        markArtifactImport(options.db, {
          runId: row.runId,
          backendArtifactId: artifact.id,
          contentHash,
          byteLength: bytes.byteLength,
          state: "pending",
        });
      },
      onCompleted: (receipt, contentHash) => {
        options.faultInjection?.afterAtomicCompletion?.();
        markArtifactImport(options.db, {
          runId: row.runId,
          backendArtifactId: artifact.id,
          artifactId: receipt.artifactId,
          contentHash,
          byteLength: bytes.byteLength,
          state: "completed",
        });
      },
    });
    markExecutionFinalized(options.db, row.runId, {
      status: "succeeded",
      summary: redactText(result.summary),
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
      synchronizePendingInteractions(options.db, runId, interactions, "question", status);
      if (status === "succeeded") {
        try {
          await finalizeSuccess(row);
        } catch (error) {
          if (error instanceof ExecutionServiceCrashFault) throw error;
          const message = redactText(error instanceof Error ? error.message : String(error));
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
          summary: redactText(result.summary),
          ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
        });
        markExecutionFinalized(options.db, runId, {
          status,
          summary: redactText(result.summary),
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
    await drainPendingOperations();
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
        const message = redactText(
          error instanceof Error ? error.message : "managed workspace provisioning failed",
        );
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

    async answer(runId, answer, answeredByKeyId) {
      const accepted = acceptInteractionAnswer(options.db, runId, answer, answeredByKeyId);
      options.faultInjection?.afterOperationCommitted?.();
      const operation = readPendingExecutionOperations(options.db).find(
        (candidate) => candidate.operationId === accepted.operationId,
      );
      const deliveredRevision = operation === undefined ? null : await deliverOperation(operation);
      if (deliveredRevision !== null) await observe(runId);
      const interaction = readRunInteractions(options.db, runId).find(
        (candidate) => candidate.interactionId === answer.interactionId,
      );
      const current = executionOrThrow(options.db, runId);
      return {
        ...accepted,
        status: current.status,
        runRevision:
          readRunProjection(options.db, runId)?.revision ??
          deliveredRevision ??
          accepted.runRevision,
        interactionRevision: interaction?.revision ?? accepted.interactionRevision,
        deliveryState: deliveredRevision === null ? "pending" : "delivered",
      };
    },

    async resume(runId, expectedRunRevision, inputArtifactRefs) {
      const requested = requestRunResume(options.db, runId, expectedRunRevision, inputArtifactRefs);
      options.faultInjection?.afterOperationCommitted?.();
      const operation = readPendingExecutionOperations(options.db).find(
        (candidate) => candidate.operationId === requested.operationId,
      );
      const deliveredRevision = operation === undefined ? null : await deliverOperation(operation);
      return {
        ...requested,
        runRevision: deliveredRevision ?? requested.runRevision,
        deliveryState: deliveredRevision === null ? "pending" : "delivered",
        status: deliveredRevision === null ? "recovery_required" : "running",
      };
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
      const diagnosticBackend = options.backend as DurableExecutionBackend & {
        diagnoseRuntime?: () => Promise<Static<typeof ExecutionBackendDiagnosticV1>>;
        diagnoseAuthRoute?: () => Promise<Static<typeof ExecutionBackendDiagnosticV1>>;
        diagnoseCompatibility?: () => Promise<
          readonly Static<typeof ExecutionBackendDiagnosticV1>[]
        >;
      };
      const checks: Static<typeof ExecutionBackendDiagnosticV1>[] = [];
      checks.push(
        diagnosticBackend.diagnoseRuntime === undefined
          ? {
              category: "runtime",
              readState: "not-read",
              code: "RUNTIME_PROBE_UNAVAILABLE",
              message: "The injected backend does not expose a pinned-runtime probe.",
            }
          : await diagnosticBackend.diagnoseRuntime(),
      );
      if (diagnosticBackend.diagnoseAuthRoute === undefined) {
        checks.push({
          category: "auth-route",
          readState: "not-read",
          code: "AUTH_ROUTE_PROBE_UNAVAILABLE",
          message: "The injected backend does not expose a subscription-route attestation probe.",
        });
      } else {
        checks.push(await diagnosticBackend.diagnoseAuthRoute());
      }
      if (diagnosticBackend.diagnoseCompatibility === undefined) {
        checks.push({
          category: "compatibility",
          readState: "not-read",
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
              readState: "ok",
              verdict: "pass",
              code: "EXECUTION_STATE_CLEAN",
              message:
                "No stale process/lease witnesses, missing handles, partial imports, or unfinalized terminal executions were found.",
            }
          : {
              category: "cleanup",
              readState: "ok",
              verdict: "fail",
              code: "EXECUTION_CLEANUP_REQUIRED",
              message: `${dirty} stale process/lease or execution cleanup issue(s) require reconciliation.`,
              remediation:
                "Restart the Heniek daemon to reconcile active handles and artifact imports.",
            },
      );
      return { schemaVersion: 2 as const, health: doctorHealthFromChecks(checks), checks };
    },

    observeAll,
    drainPendingOperations,

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
