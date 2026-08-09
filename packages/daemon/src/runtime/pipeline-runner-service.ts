/**
 * Pipeline stage-runner coordinator (Q026, ADR 0024).
 *
 * Ticks the deterministic scheduler, idempotently claims pending
 * dispatch/cancel intents for `agent` and `command` stages, drives the
 * shared runner phases, and records observations only after validation.
 * Approval/integration/verify/publish and evaluator intents stay for Q027+.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArtifactId,
  ExecutionBackendV7,
  ExecutionPermissionEnvelopeV1,
  ResolvedProfileChainV1,
  ResolvedProfileSchemaV2,
  WorkspaceId,
} from "@heniek/contracts";
import { type SchedulerInput, tickScheduler } from "@heniek/pipeline";
import {
  createAgentStageRunner,
  createCommandStageRunner,
  type StageRunner,
  type StageRunnerPrepareInput,
} from "@heniek/runner";
import {
  applyPipelineSchedulerPlan,
  claimRunnerDispatch,
  commitStateChange,
  createArtifactStore,
  exportRunnerAttempt,
  finalizeRunnerAttempt,
  type JsonValue,
  loadPipelineSchedulerInputParts,
  markPipelineSchedulerIntentDelivered,
  readIdentity,
  readOpenRunnerAttempts,
  readPendingPipelineSchedulerIntents,
  readPipelineSchedule,
  readRunnerAttempt,
  recordPipelineObservation,
  reportRunnerCleanupHealth,
  type StateDatabase,
  updateRunnerAttempt,
} from "@heniek/state";
import { validateExecutionWorkspace, type WorkspaceService } from "@heniek/workspace";
import type { Static } from "@sinclair/typebox";
import { finalizeStageArtifact } from "./stage-completion.js";

type ProfileChain = Static<typeof ResolvedProfileChainV1>;
type ResolvedProfile = Static<typeof ResolvedProfileSchemaV2>;
type Permissions = Static<typeof ExecutionPermissionEnvelopeV1>;

export interface PipelineCodebaseContext {
  readonly codebaseId: string;
  readonly repositoryId: string;
  readonly defaultRemote: string;
  readonly defaultBranch: string;
}

export interface PipelineRunnerServiceOptions {
  readonly db: StateDatabase;
  readonly workspaceService: WorkspaceService;
  readonly backend: ExecutionBackendV7;
  readonly instanceId: string;
  readonly artifactsDirectory: string;
  readonly runtimeDirectory: string;
  readonly ids: { next(prefix: string): string };
  readonly clock: { nowIso(): string };
  readonly resolveProfileChain: (profileId: string) => Promise<ProfileChain> | ProfileChain;
  readonly createIdentifierReader: (allowedIdentifiers: readonly string[]) => {
    read(identifier: string): Promise<unknown>;
  };
  readonly resolveCodebaseContext: (runId: string) => PipelineCodebaseContext;
  readonly resolveAgentInvocation?: (input: {
    readonly runId: string;
    readonly stageId: string;
    readonly stage: StageRunnerPrepareInput["stage"];
  }) => Promise<{
    readonly prompt: string;
    readonly artifactPath: string;
    readonly inputArtifactRefs: readonly ArtifactId[];
  }>;
  readonly pollMilliseconds?: number;
  readonly commandGracePeriodMs?: number;
}

export interface PipelineRunnerService {
  tick(runId: string): Promise<void>;
  drainIntents(runId?: string): Promise<void>;
  reconcile(): Promise<void>;
  cleanupHealth(): ReturnType<typeof reportRunnerCleanupHealth>;
  exportAttempt(attemptId: string): ReturnType<typeof exportRunnerAttempt>;
  stop(): void;
}

function workspaceConfiguration(remote: string, branch: string) {
  return {
    schemaVersion: 1 as const,
    strategy: "managed-worktree" as const,
    base: { remote, branch },
    synchronization: { strategy: "notify" as const },
    files: { copy: [] },
    scripts: { setup: null },
    lease: { ttlMilliseconds: 300_000, renewEveryMilliseconds: 60_000 },
  };
}

function toSchedulerInput(db: StateDatabase, runId: string, now: string): SchedulerInput {
  const parts = loadPipelineSchedulerInputParts(db, runId);
  return {
    schemaVersion: 1,
    runId,
    pipelineId: parts.schedule.pipelineId,
    graphRevision: parts.schedule.graphRevision,
    scheduleRevision: parts.schedule.scheduleRevision,
    graph: parts.graph,
    now,
    ...(parts.schedule.deadlineAt ? { deadlineAt: parts.schedule.deadlineAt } : {}),
    stages: parts.stages.map((stage) => ({
      schemaVersion: 1 as const,
      runId: stage.runId,
      stageId: stage.stageId,
      graphRevision: stage.graphRevision,
      generation: stage.generation,
      state: stage.state as SchedulerInput["stages"][number]["state"],
      attemptOrdinal: stage.attemptOrdinal,
      selected: stage.selected,
      updatedAt: stage.updatedAt,
      ...(stage.currentAttemptId ? { currentAttemptId: stage.currentAttemptId } : {}),
      ...(stage.lastTransitionReason
        ? {
            lastTransitionReason: stage.lastTransitionReason as NonNullable<
              SchedulerInput["stages"][number]["lastTransitionReason"]
            >,
          }
        : {}),
      ...(stage.blockReason ? { blockReason: stage.blockReason } : {}),
    })),
    observations: parts.observations.map((row) => {
      const payload =
        typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload)
          ? (row.payload as Record<string, unknown>)
          : {};
      return {
        schemaVersion: 1 as const,
        observationId: row.observationId,
        kind: row.kind as SchedulerInput["observations"][number]["kind"],
        recordedAt: row.recordedAt,
        ...(typeof payload.stageId === "string" ? { stageId: payload.stageId } : {}),
        ...(typeof payload.attemptId === "string" ? { attemptId: payload.attemptId } : {}),
        ...(typeof payload.retryable === "boolean" ? { retryable: payload.retryable } : {}),
        ...(typeof payload.edgeKey === "string" ? { edgeKey: payload.edgeKey } : {}),
        ...(typeof payload.selected === "boolean" ? { selected: payload.selected } : {}),
      };
    }),
    canonicalState: {},
    pendingEvaluatorEdgeKeys: [...parts.pendingEvaluatorEdgeKeys],
    evaluatorDecisions: [...parts.evaluatorDecisions],
  };
}

function payloadRecord(payload: JsonValue): Record<string, unknown> {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}

function defaultAgentInvocation(stage: StageRunnerPrepareInput["stage"]): {
  readonly prompt: string;
  readonly artifactPath: string;
  readonly inputArtifactRefs: readonly ArtifactId[];
} {
  const artifactRequirement = stage.completion?.require.find(
    (requirement) => requirement.kind === "artifact",
  );
  const artifactPath =
    artifactRequirement !== undefined && artifactRequirement.kind === "artifact"
      ? `artifacts/${artifactRequirement.name}.md`
      : `artifacts/${stage.id}/result.md`;
  return {
    prompt: `Execute pipeline stage ${stage.id} (${stage.type}).`,
    artifactPath,
    inputArtifactRefs: [],
  };
}

export function createPipelineRunnerService(
  options: PipelineRunnerServiceOptions,
): PipelineRunnerService {
  const owner = {
    ownerId: options.instanceId,
    bootWitness: `daemon:${options.instanceId}`,
    processWitnesses: [] as const,
  };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const artifactStore = createArtifactStore({
    root: options.artifactsDirectory,
    clock: options.clock,
    ids: options.ids,
  });
  const activeRunners = new Map<string, StageRunner>();

  function schedulePoll(): void {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void reconcile().finally(schedulePoll);
    }, options.pollMilliseconds ?? 1_000);
    timer.unref?.();
  }

  async function tick(runId: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const input = toSchedulerInput(options.db, runId, options.clock.nowIso());
      const plan = tickScheduler(input);
      const applied = applyPipelineSchedulerPlan(options.db, plan);
      if (applied.status === "conflict") continue;
      return;
    }
    throw new Error(`pipeline scheduler tick could not apply for ${runId}`);
  }

  async function resolveProfile(profileId: string): Promise<ResolvedProfile> {
    const chain = await options.resolveProfileChain(profileId);
    return chain.primary;
  }

  async function resolvePermissions(profile: ResolvedProfile): Promise<Permissions> {
    return {
      schemaVersion: 1,
      workspace: profile.permissions.workspace,
      identifiers: [...profile.permissions.identifiers],
    };
  }

  async function provisionWorkspace(input: {
    readonly runId: string;
    readonly attemptId: string;
  }): Promise<{
    readonly workspaceId: string;
    readonly checkoutPath: string;
  }> {
    const context = options.resolveCodebaseContext(input.runId);
    const workspaceId = options.ids.next("workspace") as WorkspaceId;
    commitStateChange(options.db, {
      type: "workspace.registered",
      payload: { workspaceId, codebaseId: context.codebaseId },
    });
    const manifest = await options.workspaceService.provision({
      workspaceId,
      codebaseId: context.codebaseId as never,
      repositoryId: context.repositoryId as never,
      integrationBranch: `heniek-pipeline-${input.attemptId}`,
      owner,
      configuration: workspaceConfiguration(context.defaultRemote, context.defaultBranch),
    });
    if (manifest.lifecycle !== "ready") {
      throw new Error("managed workspace provisioning failed");
    }
    commitStateChange(options.db, {
      runId: input.runId,
      type: "run.workspace_assigned",
      payload: { runId: input.runId, workspaceId },
    });
    return {
      workspaceId,
      checkoutPath: manifest.checkoutPath,
    };
  }

  function createRunnerForStage(
    stageType: "agent" | "command",
    stage: StageRunnerPrepareInput["stage"],
    runId: string,
  ): StageRunner {
    if (stageType === "command") {
      return createCommandStageRunner({
        clock: options.clock,
        ...(options.commandGracePeriodMs === undefined
          ? {}
          : { gracePeriodMs: options.commandGracePeriodMs }),
      });
    }
    return createAgentStageRunner({
      backend: options.backend,
      clock: options.clock,
      resolveProfile,
      resolvePermissions,
      identifierReader: options.createIdentifierReader([]),
      resolveAgentInvocation: async () => {
        if (options.resolveAgentInvocation !== undefined) {
          return options.resolveAgentInvocation({ runId, stageId: stage.id, stage });
        }
        return defaultAgentInvocation(stage);
      },
    });
  }

  async function settleRunner(
    attemptId: string,
    runner: StageRunner,
    reason: "dispatch" | "cancel" | "reconcile",
  ): Promise<void> {
    let attempt = readRunnerAttempt(options.db, attemptId);
    if (attempt === undefined) throw new Error(`missing runner attempt ${attemptId}`);

    let observation = await runner.observe(attemptId);
    while (observation.status === "running" || observation.status === "waiting") {
      if (stopped) return;
      if (observation.status === "waiting") {
        attempt = updateRunnerAttempt(options.db, {
          attemptId,
          expectedRevision: attempt.revision,
          phase: "observe",
          transitionDetail: "waiting",
          now: options.clock.nowIso(),
        });
        recordPipelineObservation(options.db, {
          observationId: options.ids.next("obs"),
          runId: attempt.runId,
          kind: "attempt_waiting",
          payload: { stageId: attempt.stageId, attemptId },
          recordedAt: options.clock.nowIso(),
        });
        await tick(attempt.runId);
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollMilliseconds ?? 50));
      observation = await runner.observe(attemptId);
      attempt = readRunnerAttempt(options.db, attemptId) ?? attempt;
    }

    if (observation.status === "recovery_required") {
      updateRunnerAttempt(options.db, {
        attemptId,
        expectedRevision: attempt.revision,
        phase: "recovery_required",
        recovery: attempt.stageType === "agent" ? "observe_backend" : "reap_process",
        finishedAt: options.clock.nowIso(),
        transitionDetail: observation.reason,
        now: options.clock.nowIso(),
      });
      return;
    }

    if (observation.status === "timed_out") {
      attempt = updateRunnerAttempt(options.db, {
        attemptId,
        expectedRevision: attempt.revision,
        phase: "cancel",
        cleanup: observation.cleanup,
        transitionDetail: "timeout",
        now: options.clock.nowIso(),
      });
    }

    attempt = updateRunnerAttempt(options.db, {
      attemptId,
      expectedRevision: attempt.revision,
      phase: "collect",
      transitionDetail: reason,
      now: options.clock.nowIso(),
    });
    await runner.collect(attemptId);

    attempt = updateRunnerAttempt(options.db, {
      attemptId,
      expectedRevision: attempt.revision,
      phase: "validate",
      now: options.clock.nowIso(),
    });
    const validation = await runner.validate(attemptId);

    attempt = updateRunnerAttempt(options.db, {
      attemptId,
      expectedRevision: attempt.revision,
      phase: "finalize",
      validation,
      now: options.clock.nowIso(),
    });
    const finalized = await runner.finalize(attemptId);

    if (
      finalized.result.outcome === "succeeded" &&
      finalized.result.summary !== undefined &&
      finalized.result.artifactPath !== undefined &&
      attempt.checkoutPath !== undefined
    ) {
      try {
        const bytes = await readFile(join(attempt.checkoutPath, finalized.result.artifactPath));
        finalizeStageArtifact(options.db, artifactStore, {
          runId: attempt.runId,
          stageId: attempt.stageId,
          summary: finalized.result.summary,
          artifactPath: finalized.result.artifactPath,
          bytes,
          mediaType: "application/octet-stream",
          producer: `pipeline-runner:${attempt.stageType}`,
          sourceLineage: [`attempt:${attemptId}`],
        });
      } catch {
        // Validation already decided; missing bytes do not invent success.
      }
    }

    const observationKind =
      finalized.result.outcome === "succeeded"
        ? ("attempt_succeeded" as const)
        : finalized.result.outcome === "cancelled"
          ? ("cancellation_settled" as const)
          : ("attempt_failed" as const);

    finalizeRunnerAttempt(options.db, {
      attemptId,
      expectedRevision: attempt.revision,
      observationId: options.ids.next("obs"),
      observationKind,
      ...(finalized.result.failure?.retryable === undefined
        ? {}
        : { retryable: finalized.result.failure.retryable }),
      ...(finalized.result === undefined ? {} : { result: finalized.result }),
      ...(finalized.result.failure === undefined ? {} : { failure: finalized.result.failure }),
      outputs: finalized.result.outputs,
      evidence: finalized.result.evidence,
      validation: finalized.validation,
      ...(finalized.cleanup === undefined ? {} : { cleanup: finalized.cleanup }),
      phase:
        finalized.result.outcome === "succeeded"
          ? "succeeded"
          : finalized.result.outcome === "cancelled"
            ? "cancelled"
            : finalized.result.outcome === "recovery_required"
              ? "recovery_required"
              : "failed",
      recovery: finalized.result.failure?.recovery ?? "none",
      now: options.clock.nowIso(),
    });

    activeRunners.delete(attemptId);
    await tick(attempt.runId);
  }

  async function driveDispatch(intent: {
    readonly intentId: string;
    readonly runId: string;
    readonly graphRevision: number;
    readonly payload: JsonValue;
  }): Promise<void> {
    const payload = payloadRecord(intent.payload);
    const stageType = String(payload.stageType ?? "");
    if (stageType !== "agent" && stageType !== "command") {
      return;
    }
    const attemptId = String(payload.attemptId ?? "");
    const stageId = String(payload.stageId ?? "");
    const generation = Number(payload.generation);
    const attemptOrdinal = Number(payload.attemptOrdinal);
    if (
      attemptId.length === 0 ||
      stageId.length === 0 ||
      !Number.isFinite(generation) ||
      !Number.isFinite(attemptOrdinal)
    ) {
      throw new Error(`malformed dispatch intent ${intent.intentId}`);
    }

    const claim = claimRunnerDispatch(options.db, {
      attemptId,
      runId: intent.runId,
      stageId,
      stageType,
      intentId: intent.intentId,
      graphRevision: intent.graphRevision,
      generation,
      attemptOrdinal,
      now: options.clock.nowIso(),
    });
    if (claim.status === "unsupported") return;
    let attempt = claim.attempt;

    const parts = loadPipelineSchedulerInputParts(options.db, intent.runId);
    const stage = parts.graph.stages.find((candidate) => candidate.id === stageId);
    if (stage === undefined) throw new Error(`stage ${stageId} missing from graph`);

    const schedule = readPipelineSchedule(options.db, intent.runId);
    const runtimeDirectory = join(options.runtimeDirectory, "pipeline-attempts", attemptId);
    await mkdir(runtimeDirectory, { recursive: true });

    if (attempt.checkoutPath === undefined) {
      const provisioned = await provisionWorkspace({
        runId: intent.runId,
        attemptId,
      });
      attempt = updateRunnerAttempt(options.db, {
        attemptId,
        expectedRevision: attempt.revision,
        workspaceId: provisioned.workspaceId,
        checkoutPath: provisioned.checkoutPath,
        runtimeDirectory,
        deadlineAt: schedule?.deadlineAt ?? null,
        preparedAt: options.clock.nowIso(),
        transitionDetail: "workspace_provisioned",
        now: options.clock.nowIso(),
      });
    }

    const checkoutPath = attempt.checkoutPath;
    if (checkoutPath === undefined) {
      throw new Error(`runner attempt ${attemptId} missing checkout path`);
    }

    await validateExecutionWorkspace({
      assignedWorktree: checkoutPath,
      workingDirectory: checkoutPath,
      artifactPaths: [],
    });

    const runner = createRunnerForStage(stageType, stage, intent.runId);
    activeRunners.set(attemptId, runner);

    await runner.prepare({
      attemptId,
      runId: intent.runId,
      stageId,
      intentId: intent.intentId,
      graphRevision: intent.graphRevision,
      generation,
      attemptOrdinal,
      stage,
      checkoutPath,
      runtimeDirectory,
      ...(attempt.workspaceId === undefined ? {} : { workspaceId: attempt.workspaceId }),
      ...(attempt.leaseId === undefined ? {} : { leaseId: attempt.leaseId }),
      ...(schedule?.deadlineAt ? { deadlineAt: schedule.deadlineAt } : {}),
    });

    attempt = updateRunnerAttempt(options.db, {
      attemptId,
      expectedRevision: attempt.revision,
      phase: "start",
      transitionDetail: "prepare_complete",
      now: options.clock.nowIso(),
    });

    await runner.start(attemptId);
    attempt = updateRunnerAttempt(options.db, {
      attemptId,
      expectedRevision: attempt.revision,
      phase: "observe",
      startedAt: options.clock.nowIso(),
      transitionDetail: "started",
      now: options.clock.nowIso(),
    });

    recordPipelineObservation(options.db, {
      observationId: options.ids.next("obs"),
      runId: intent.runId,
      kind: "attempt_started",
      payload: { stageId, attemptId },
      recordedAt: options.clock.nowIso(),
    });
    await tick(intent.runId);
    await settleRunner(attemptId, runner, "dispatch");
  }

  async function driveCancel(intent: {
    readonly intentId: string;
    readonly runId: string;
    readonly payload: JsonValue;
  }): Promise<void> {
    const payload = payloadRecord(intent.payload);
    const attemptId = String(payload.attemptId ?? "");
    if (attemptId.length === 0) {
      markPipelineSchedulerIntentDelivered(options.db, intent.intentId, options.clock.nowIso());
      return;
    }
    const attempt = readRunnerAttempt(options.db, attemptId);
    if (attempt === undefined) {
      // Cancel for a stage we never claimed (Q027+) — leave pending unless empty.
      return;
    }
    const runner = activeRunners.get(attemptId);
    if (runner === undefined) {
      updateRunnerAttempt(options.db, {
        attemptId,
        expectedRevision: attempt.revision,
        phase: "recovery_required",
        recovery: attempt.stageType === "agent" ? "observe_backend" : "reap_process",
        finishedAt: options.clock.nowIso(),
        transitionDetail: "cancel_without_live_runner",
        now: options.clock.nowIso(),
      });
      markPipelineSchedulerIntentDelivered(options.db, intent.intentId, options.clock.nowIso());
      recordPipelineObservation(options.db, {
        observationId: options.ids.next("obs"),
        runId: attempt.runId,
        kind: "cancellation_settled",
        payload: { stageId: attempt.stageId, attemptId },
        recordedAt: options.clock.nowIso(),
      });
      await tick(attempt.runId);
      return;
    }
    await runner.cancel(attemptId);
    await settleRunner(attemptId, runner, "cancel");
    markPipelineSchedulerIntentDelivered(options.db, intent.intentId, options.clock.nowIso());
  }

  async function drainIntents(runId?: string): Promise<void> {
    const intents = readPendingPipelineSchedulerIntents(options.db, {
      ...(runId === undefined ? {} : { runId }),
      kinds: ["dispatch", "cancel"],
    });
    for (const intent of intents) {
      if (intent.kind === "dispatch") {
        await driveDispatch(intent);
      } else if (intent.kind === "cancel") {
        await driveCancel(intent);
      }
    }
    schedulePoll();
  }

  async function reconcile(): Promise<void> {
    const open = readOpenRunnerAttempts(options.db);
    for (const attempt of open) {
      if (attempt.phase === "recovery_required") continue;
      const runner = activeRunners.get(attempt.attemptId);
      if (runner === undefined) {
        updateRunnerAttempt(options.db, {
          attemptId: attempt.attemptId,
          expectedRevision: attempt.revision,
          phase: "recovery_required",
          recovery:
            attempt.backendExecutionId !== undefined
              ? "observe_backend"
              : attempt.processGroupId === undefined
                ? "manual"
                : "reap_process",
          finishedAt: options.clock.nowIso(),
          transitionDetail: "daemon_restart",
          now: options.clock.nowIso(),
        });
        continue;
      }
      await settleRunner(attempt.attemptId, runner, "reconcile");
    }
    await drainIntents();
  }

  return {
    tick,
    drainIntents,
    reconcile,
    cleanupHealth: () => reportRunnerCleanupHealth(options.db),
    exportAttempt: (attemptId) => exportRunnerAttempt(options.db, attemptId),
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Resolve codebase/repository context for a pipeline run from identity tables. */
export function resolvePipelineCodebaseContextFromRepository(
  db: StateDatabase,
  repositoryId: string,
): PipelineCodebaseContext {
  const repository = readIdentity(db, "repository", repositoryId);
  if (
    repository === undefined ||
    repository.defaultRemote === null ||
    repository.defaultBranch === null
  ) {
    throw new Error(`registered repository context unavailable for ${repositoryId}`);
  }
  return {
    codebaseId: repository.codebaseId,
    repositoryId,
    defaultRemote: repository.defaultRemote,
    defaultBranch: repository.defaultBranch,
  };
}
