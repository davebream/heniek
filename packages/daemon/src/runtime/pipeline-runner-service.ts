/**
 * Pipeline stage-runner coordinator (Q026/Q027, ADR 0024/0025).
 *
 * Ticks the deterministic scheduler, idempotently claims pending
 * dispatch/cancel intents for all six fixed stage types, drives the
 * shared runner phases, and records observations only after validation.
 * Waiting stages return control so intent draining stays non-blocking;
 * reconcile polls live waiters and reconstructs durable fixed-stage
 * operations after restart. Evaluator intents stay ignored.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ApprovalDecisionV1,
  ApprovalRequestV1,
  ArtifactId,
  ExecutionBackendV7,
  ExecutionBackendV8,
  ExecutionPermissionEnvelopeV1,
  ForgeBackendV2,
  IntegrationRequestV1,
  PublishRequestV1,
  ResolvedProfileChainV1,
  ResolvedProfileSchemaV2,
  StructuredReviewReport,
  VerifyRequestV1,
  WorkspaceId,
} from "@heniek/contracts";
import {
  buildCanonicalConditionState,
  type SchedulerInput,
  tickScheduler,
  tickSchedulerV2,
} from "@heniek/pipeline";
import {
  type ApprovalStageRunner,
  contentSchemaIdForReviewReport,
  createAgentStageRunner,
  createApprovalStageRunner,
  createCommandStageRunner,
  createIntegrationStageRunner,
  createLocalGitIntegrationAdapter,
  createPublishStageRunner,
  createVerifyStageRunner,
  type GitIntegrationAdapter,
  isReviewReportSchemaName,
  type StageRunner,
  type StageRunnerPrepareInput,
  type StageRunnerRetryDirective,
  type StageRunnerSegmentDirective,
  type StageRunnerStoreCallbacks,
} from "@heniek/runner";
import {
  applyPipelineSchedulerPlan,
  claimRunnerDispatch,
  commitStateChange,
  createArtifactStore,
  exportRunnerAttempt,
  finalizeRunnerAttempt,
  type JsonValue,
  listPipelineApprovalInbox,
  loadPipelineSchedulerInputParts,
  markPipelineSchedulerIntentDelivered,
  persistRunnerOperationRequest,
  readIdentity,
  readOpenRunnerAttempts,
  readPendingPipelineSchedulerIntents,
  readPipelineSchedule,
  readPipelineStageProjections,
  readRetryDirective,
  readRunnerAttempt,
  readRunnerOperationState,
  reconstructRunnerOperation,
  recordFindingReport,
  recordPipelineObservation,
  recordRecoveryApproval,
  recordRunnerApprovalAnswer,
  reportRunnerCleanupHealth,
  type StateDatabase,
  toSchedulerObservations,
  updateRunnerAttempt,
  updateRunnerOperationState,
  upsertCanonicalRunState,
  validateFindingReportIngestion,
} from "@heniek/state";
import { validateExecutionWorkspace, type WorkspaceService } from "@heniek/workspace";
import type { Static } from "@sinclair/typebox";
import { buildClassifiedFailureObservation } from "./recovery-observation.js";
import { bindSegmentBackendExecution, planFusionDispatch } from "./segment-fusion.js";
import { finalizeStageArtifact } from "./stage-completion.js";

const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;

type ProfileChain = Static<typeof ResolvedProfileChainV1>;
type ResolvedProfile = Static<typeof ResolvedProfileSchemaV2>;
type Permissions = Static<typeof ExecutionPermissionEnvelopeV1>;
type ApprovalRequest = Static<typeof ApprovalRequestV1>;
type ApprovalDecision = Static<typeof ApprovalDecisionV1>;
type IntegrationRequest = Static<typeof IntegrationRequestV1>;
type VerifyRequest = Static<typeof VerifyRequestV1>;
type PublishRequest = Static<typeof PublishRequestV1>;

type FixedStageType = "agent" | "command" | "approval" | "integration" | "verify" | "publish";

type OperationStageType = "approval" | "integration" | "verify" | "publish";

const FIXED_STAGE_TYPES = new Set<string>([
  "agent",
  "command",
  "approval",
  "integration",
  "verify",
  "publish",
]);

const OPERATION_STAGE_TYPES = new Set<string>(["approval", "integration", "verify", "publish"]);

export interface PipelineCodebaseContext {
  readonly codebaseId: string;
  readonly repositoryId: string;
  readonly defaultRemote: string;
  readonly defaultBranch: string;
}

export interface PipelineRunnerServiceOptions {
  readonly db: StateDatabase;
  readonly workspaceService: WorkspaceService;
  readonly backend: ExecutionBackendV7 | ExecutionBackendV8;
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
  readonly forge?: ForgeBackendV2;
  readonly git?: GitIntegrationAdapter;
  readonly resolveAgentInvocation?: (input: {
    readonly runId: string;
    readonly stageId: string;
    readonly stage: StageRunnerPrepareInput["stage"];
  }) => Promise<{
    readonly prompt: string;
    readonly artifactPath: string;
    readonly inputArtifactRefs: readonly ArtifactId[];
  }>;
  readonly resolveApprovalRequest?: (input: {
    readonly runId: string;
    readonly stageId: string;
    readonly attemptId: string;
    readonly intentId: string;
    readonly stage: StageRunnerPrepareInput["stage"];
  }) => ApprovalRequest | Promise<ApprovalRequest>;
  readonly resolveIntegrationRequest?: (input: {
    readonly runId: string;
    readonly stageId: string;
    readonly attemptId: string;
    readonly intentId: string;
    readonly stage: StageRunnerPrepareInput["stage"];
    readonly payload: Record<string, unknown>;
  }) => IntegrationRequest | Promise<IntegrationRequest>;
  readonly resolveVerifyRequest?: (input: {
    readonly runId: string;
    readonly stageId: string;
    readonly attemptId: string;
    readonly intentId: string;
    readonly stage: StageRunnerPrepareInput["stage"];
    readonly payload: Record<string, unknown>;
  }) => VerifyRequest | Promise<VerifyRequest>;
  readonly resolvePublishRequest?: (input: {
    readonly runId: string;
    readonly stageId: string;
    readonly attemptId: string;
    readonly intentId: string;
    readonly stage: StageRunnerPrepareInput["stage"];
    readonly payload: Record<string, unknown>;
  }) => PublishRequest | Promise<PublishRequest>;
  readonly pollMilliseconds?: number;
  readonly commandGracePeriodMs?: number;
}

export interface PipelineRunnerService {
  tick(runId: string): Promise<void>;
  status(runId: string): PipelineRunLifecycle;
  cancel(runId: string): Promise<PipelineRunLifecycle>;
  drainIntents(runId?: string): Promise<void>;
  reconcile(): Promise<void>;
  cleanupHealth(): ReturnType<typeof reportRunnerCleanupHealth>;
  exportAttempt(attemptId: string): ReturnType<typeof exportRunnerAttempt>;
  listApprovalInbox(): ReturnType<typeof listPipelineApprovalInbox>;
  answerApproval(input: {
    readonly attemptId: string;
    readonly decision: ApprovalDecision;
  }): Promise<
    | {
        readonly status: "recorded";
        readonly attemptId: string;
        readonly operationId: string;
        readonly interactionRevision: number;
      }
    | {
        readonly status: "stale_revision";
        readonly attemptId: string;
        readonly currentRevision: number;
      }
  >;
  recordRecoveryApproval(input: {
    readonly runId: string;
    readonly stageId: string;
    readonly proposalId: string;
    readonly approved: boolean;
  }): ReturnType<typeof recordRecoveryApproval>;
  stop(): void;
}

export type PipelineRunLifecycle =
  | { readonly state: "missing" }
  | { readonly state: "running" }
  | { readonly state: "retrying"; readonly attemptOrdinal: number }
  | { readonly state: "recovery_required" }
  | { readonly state: "succeeded" | "failed" | "cancelled" };

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

function asRetryDirective(value: unknown): StageRunnerRetryDirective | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.mode !== "fresh" && record.mode !== "resume" && record.mode !== "delegate") {
    return undefined;
  }
  if (record.sessionPolicy !== "fresh" && record.sessionPolicy !== "resume") {
    return undefined;
  }
  return {
    mode: record.mode,
    sessionPolicy: record.sessionPolicy,
    ...(typeof record.priorAttemptId === "string" ? { priorAttemptId: record.priorAttemptId } : {}),
    ...(typeof record.priorBackendExecutionId === "string"
      ? { priorBackendExecutionId: record.priorBackendExecutionId }
      : {}),
    ...(typeof record.delegateTo === "string" ? { delegateTo: record.delegateTo } : {}),
    ...(typeof record.recoveryContextDigest === "string"
      ? { recoveryContextDigest: record.recoveryContextDigest }
      : {}),
  };
}

function toSchedulerInput(db: StateDatabase, runId: string, now: string): SchedulerInput {
  const parts = loadPipelineSchedulerInputParts(db, runId);
  const graphLimits = parts.graph.limits ?? {};
  const maxRepairFromGraph =
    typeof graphLimits.maxRepairAttempts === "number" ? graphLimits.maxRepairAttempts : undefined;
  const effectiveMaxRepair =
    maxRepairFromGraph === undefined
      ? DEFAULT_MAX_REPAIR_ATTEMPTS
      : Math.min(maxRepairFromGraph, DEFAULT_MAX_REPAIR_ATTEMPTS);

  const recoveryState = parts.recoveryState.map((row) => {
    const parsedDirective =
      row.pendingProposal === null ? undefined : asRetryDirective(row.pendingProposal);
    const pendingDirective =
      parsedDirective === undefined
        ? undefined
        : ({ schemaVersion: 1, ...parsedDirective } as const);
    return {
      stageId: row.stageId,
      generation: row.generation,
      repairsUsed: row.repairsUsed,
      identicalSignatureCount: row.identicalSignatureCount,
      ...(row.lastSignatureDigest === null ? {} : { lastSignatureDigest: row.lastSignatureDigest }),
      ...(row.pendingProposalId === null ? {} : { pendingProposalId: row.pendingProposalId }),
      ...(row.pendingProposal === null
        ? {}
        : {
            pendingProposalJson: row.pendingProposal,
            ...(pendingDirective === undefined ? {} : { pendingDirective }),
          }),
    };
  });

  const observations = toSchedulerObservations(parts.observations).map((observation) => {
    const { failure, signature, ...rest } = observation;
    return {
      ...rest,
      ...(failure !== undefined
        ? {
            failure: failure as NonNullable<SchedulerInput["observations"][number]["failure"]>,
          }
        : {}),
      ...(signature !== undefined
        ? {
            signature: signature as NonNullable<
              SchedulerInput["observations"][number]["signature"]
            >,
          }
        : {}),
    };
  });

  const useV2 =
    recoveryState.length > 0 ||
    observations.some(
      (observation) =>
        observation.failure !== undefined ||
        observation.kind === "recovery_approved" ||
        observation.kind === "recovery_rejected" ||
        observation.kind === "recovery_proposed",
    );

  return {
    schemaVersion: useV2 ? 2 : 1,
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
    observations,
    canonicalState: parts.canonicalState,
    pendingEvaluatorEdgeKeys: [...parts.pendingEvaluatorEdgeKeys],
    evaluatorDecisions: [...parts.evaluatorDecisions],
    ...(useV2
      ? {
          recoveryState,
          effectiveLimits: {
            maxRepairAttempts: effectiveMaxRepair,
            ...(typeof graphLimits.maxConcurrentWorkers === "number"
              ? { maxConcurrentWorkers: graphLimits.maxConcurrentWorkers }
              : {}),
            ...(typeof graphLimits.maxPipelineDurationMs === "number"
              ? { maxPipelineDurationMs: graphLimits.maxPipelineDurationMs }
              : {}),
            ...(typeof graphLimits.maxGraphRevisions === "number"
              ? { maxGraphRevisions: graphLimits.maxGraphRevisions }
              : {}),
          },
          executionMode: parts.graph.mode,
        }
      : {}),
  };
}

function payloadRecord(payload: JsonValue): Record<string, unknown> {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}

function requiresWorkspace(stageType: FixedStageType): boolean {
  return (
    stageType === "agent" ||
    stageType === "command" ||
    stageType === "integration" ||
    stageType === "verify"
  );
}

function isOperationStage(stageType: string): stageType is OperationStageType {
  return OPERATION_STAGE_TYPES.has(stageType);
}

function defaultAgentInvocation(stage: StageRunnerPrepareInput["stage"]): {
  readonly prompt: string;
  readonly artifactPath: string;
  readonly inputArtifactRefs: readonly ArtifactId[];
  readonly structuredSchemaName?: import("@heniek/contracts").ReviewReportSchemaName;
} {
  const artifactRequirement = stage.completion?.require.find(
    (requirement) => requirement.kind === "artifact",
  );
  const structuredRequirement = stage.completion?.require.find(
    (requirement) =>
      requirement.kind === "schema_check" &&
      (requirement.name === "review-report-v1" ||
        requirement.name === "repair-report-v1" ||
        requirement.name === "final-verification-report-v1"),
  );
  const artifactPath =
    artifactRequirement !== undefined && artifactRequirement.kind === "artifact"
      ? `artifacts/${artifactRequirement.name}.${structuredRequirement === undefined ? "md" : "json"}`
      : `artifacts/${stage.id}/result.md`;
  return {
    prompt:
      structuredRequirement === undefined || structuredRequirement.kind !== "schema_check"
        ? `Execute pipeline stage ${stage.id} (${stage.type}).`
        : `Execute pipeline stage ${stage.id} (${stage.type}). Write exactly one JSON artifact satisfying ${structuredRequirement.name}; include its human-readable Markdown in the contract's markdown field.`,
    artifactPath,
    inputArtifactRefs: [],
    ...(structuredRequirement === undefined || structuredRequirement.kind !== "schema_check"
      ? {}
      : {
          structuredSchemaName:
            structuredRequirement.name as import("@heniek/contracts").ReviewReportSchemaName,
        }),
  };
}

function defaultApprovalRequest(input: {
  readonly runId: string;
  readonly stageId: string;
  readonly attemptId: string;
  readonly intentId: string;
  readonly requestedAt: string;
}): ApprovalRequest {
  return {
    schemaVersion: 1,
    prompt: `Approve pipeline stage ${input.stageId}?`,
    options: [
      { label: "Approve", description: "Continue the pipeline" },
      { label: "Reject", description: "Stop the pipeline" },
    ],
    continuation: {
      schemaVersion: 1,
      runId: input.runId as ApprovalRequest["continuation"]["runId"],
      stageId: input.stageId as ApprovalRequest["continuation"]["stageId"],
      attemptId: input.attemptId as ApprovalRequest["continuation"]["attemptId"],
      intentId: input.intentId as ApprovalRequest["continuation"]["intentId"],
      interactionId: `ix:${input.attemptId}`,
    },
    requestedAt: input.requestedAt,
  };
}

function defaultVerifyRequest(stage: StageRunnerPrepareInput["stage"]): VerifyRequest {
  const checks = (stage.completion?.require ?? [])
    .filter(
      (requirement): requirement is Extract<typeof requirement, { kind: "command" }> =>
        requirement.kind === "command",
    )
    .map((requirement, index) => ({
      schemaVersion: 1 as const,
      checkId: `check-${index + 1}`,
      argv: [...requirement.argv],
      expectedExitCode: requirement.exitCode ?? 0,
      required: true,
    }));
  if (checks.length === 0) {
    throw new Error(`verify stage ${stage.id} has no command completion requirements`);
  }
  return { schemaVersion: 1, checks };
}

function asOperationRequest(value: unknown): JsonValue {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonValue;
  }
  throw new Error("operation request must be an object");
}

function recoveryForMissingHandle(
  attempt: NonNullable<ReturnType<typeof readRunnerAttempt>>,
): NonNullable<Parameters<typeof updateRunnerAttempt>[1]["recovery"]> {
  if (attempt.stageType === "agent" || attempt.backendExecutionId !== undefined) {
    return "observe_backend";
  }
  if (attempt.stageType === "command" || attempt.stageType === "verify") {
    return attempt.processGroupId === undefined ? "manual" : "reap_process";
  }
  if (attempt.stageType === "approval") return "await_approval";
  if (attempt.stageType === "integration") return "reconcile_git";
  if (attempt.stageType === "publish") return "reconcile_forge";
  return "manual";
}

function resolveRetryDirective(
  payload: Record<string, unknown>,
  attemptId: string,
  db: StateDatabase,
): StageRunnerRetryDirective | undefined {
  const fromPayload = asRetryDirective(payload.retryDirective);
  if (fromPayload !== undefined) {
    return fromPayload;
  }
  const stored = readRetryDirective(db, attemptId);
  return stored === undefined ? undefined : asRetryDirective(stored.directive);
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
  const git = options.git ?? createLocalGitIntegrationAdapter();
  const activeRunners = new Map<string, StageRunner>();
  const approvalRunners = new Map<string, ApprovalStageRunner>();
  const waitingAttempts = new Set<string>();
  const operationRequests = new Map<
    string,
    {
      readonly operationId: string;
      readonly stageType: OperationStageType;
      readonly request: JsonValue;
    }
  >();

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
      const plan =
        input.schemaVersion === 2 ||
        input.recoveryState !== undefined ||
        input.effectiveLimits !== undefined
          ? tickSchedulerV2({ ...input, schemaVersion: 2 })
          : tickScheduler(input);
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

  function createStoreCallbacks(attemptId: string): StageRunnerStoreCallbacks {
    return {
      onAttemptUpdate: (snapshot) => {
        const current = readRunnerAttempt(options.db, attemptId);
        if (current === undefined) return;
        const processGroupChanged =
          snapshot.processGroupId !== undefined &&
          snapshot.processGroupId !== current.processGroupId;
        const backendChanged =
          snapshot.backendExecutionId !== undefined &&
          snapshot.backendExecutionId !== current.backendExecutionId;
        const recoveryChanged = snapshot.recovery !== current.recovery;
        if (!processGroupChanged && !backendChanged && !recoveryChanged) {
          return;
        }
        try {
          updateRunnerAttempt(options.db, {
            attemptId,
            expectedRevision: current.revision,
            ...(processGroupChanged ? { processGroupId: snapshot.processGroupId } : {}),
            ...(backendChanged ? { backendExecutionId: snapshot.backendExecutionId } : {}),
            ...(recoveryChanged ? { recovery: snapshot.recovery } : {}),
            now: options.clock.nowIso(),
          });
        } catch {
          // Coordinator may have advanced the revision concurrently; reconcile
          // will pick up durable fields on the next poll.
        }
      },
      onCleanup: (report) => {
        const current = readRunnerAttempt(options.db, attemptId);
        if (current === undefined) return;
        try {
          updateRunnerAttempt(options.db, {
            attemptId,
            expectedRevision: current.revision,
            cleanup: report,
            now: options.clock.nowIso(),
          });
        } catch {
          // Best-effort; finalize persists cleanup again.
        }
      },
      onValidation: (report) => {
        const current = readRunnerAttempt(options.db, attemptId);
        if (current === undefined) return;
        try {
          updateRunnerAttempt(options.db, {
            attemptId,
            expectedRevision: current.revision,
            validation: report,
            now: options.clock.nowIso(),
          });
        } catch {
          // Best-effort; finalize persists validation again.
        }
      },
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

  function createAgentOrCommandRunner(
    stageType: "agent" | "command",
    stage: StageRunnerPrepareInput["stage"],
    runId: string,
    attemptId: string,
  ): StageRunner {
    const store = createStoreCallbacks(attemptId);
    if (stageType === "command") {
      return createCommandStageRunner({
        clock: options.clock,
        store,
        ...(options.commandGracePeriodMs === undefined
          ? {}
          : { gracePeriodMs: options.commandGracePeriodMs }),
      });
    }
    return createAgentStageRunner({
      backend: options.backend,
      clock: options.clock,
      store,
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

  function createOperationRunner(
    stageType: OperationStageType,
    attemptId: string,
  ): StageRunner | ApprovalStageRunner {
    const store = createStoreCallbacks(attemptId);
    switch (stageType) {
      case "approval": {
        const runner = createApprovalStageRunner({ clock: options.clock, store });
        approvalRunners.set(attemptId, runner);
        return runner;
      }
      case "integration":
        return createIntegrationStageRunner({ git, clock: options.clock, store });
      case "verify":
        return createVerifyStageRunner({
          clock: options.clock,
          store,
          ...(options.commandGracePeriodMs === undefined
            ? {}
            : { gracePeriodMs: options.commandGracePeriodMs }),
        });
      case "publish": {
        if (options.forge === undefined) {
          throw new Error("publish stage requires a ForgeBackendV2");
        }
        return createPublishStageRunner({
          forge: options.forge,
          clock: options.clock,
          store,
        });
      }
    }
  }

  async function markWaiting(
    attemptId: string,
    attempt: NonNullable<ReturnType<typeof readRunnerAttempt>>,
  ): Promise<void> {
    waitingAttempts.add(attemptId);
    const updated = updateRunnerAttempt(options.db, {
      attemptId,
      expectedRevision: attempt.revision,
      phase: "observe",
      transitionDetail: "waiting",
      now: options.clock.nowIso(),
    });
    recordPipelineObservation(options.db, {
      observationId: options.ids.next("obs"),
      runId: updated.runId,
      kind: "attempt_waiting",
      payload: { stageId: updated.stageId, attemptId },
      recordedAt: options.clock.nowIso(),
    });
    await tick(updated.runId);
  }

  async function settleRunner(
    attemptId: string,
    runner: StageRunner,
    reason: "dispatch" | "cancel" | "reconcile",
  ): Promise<void> {
    let attempt = readRunnerAttempt(options.db, attemptId);
    if (attempt === undefined) throw new Error(`missing runner attempt ${attemptId}`);

    let observation = await runner.observe(attemptId);

    if (observation.status === "waiting") {
      await markWaiting(attemptId, attempt);
      return;
    }

    while (observation.status === "running") {
      if (stopped) return;
      waitingAttempts.delete(attemptId);
      await new Promise((resolve) => setTimeout(resolve, options.pollMilliseconds ?? 50));
      observation = await runner.observe(attemptId);
      attempt = readRunnerAttempt(options.db, attemptId) ?? attempt;
      if (observation.status === "waiting") {
        await markWaiting(attemptId, attempt);
        return;
      }
    }

    waitingAttempts.delete(attemptId);

    if (observation.status === "recovery_required") {
      updateRunnerAttempt(options.db, {
        attemptId,
        expectedRevision: attempt.revision,
        phase: "recovery_required",
        recovery: recoveryForMissingHandle(attempt),
        finishedAt: options.clock.nowIso(),
        transitionDetail: observation.reason,
        now: options.clock.nowIso(),
      });
      activeRunners.delete(attemptId);
      approvalRunners.delete(attemptId);
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
    attempt = readRunnerAttempt(options.db, attemptId) ?? attempt;

    attempt = updateRunnerAttempt(options.db, {
      attemptId,
      expectedRevision: attempt.revision,
      phase: "validate",
      now: options.clock.nowIso(),
    });
    const validation = await runner.validate(attemptId);
    attempt = readRunnerAttempt(options.db, attemptId) ?? attempt;

    attempt = updateRunnerAttempt(options.db, {
      attemptId,
      expectedRevision: attempt.revision,
      phase: "finalize",
      validation,
      now: options.clock.nowIso(),
    });
    const finalized = await runner.finalize(attemptId);
    attempt = readRunnerAttempt(options.db, attemptId) ?? attempt;

    if (
      finalized.result.outcome === "succeeded" &&
      finalized.result.summary !== undefined &&
      finalized.result.artifactPath !== undefined &&
      attempt.checkoutPath !== undefined
    ) {
      try {
        const bytes = await readFile(join(attempt.checkoutPath, finalized.result.artifactPath));
        const schemaEvidence = finalized.result.evidence.find(
          (item) =>
            item.kind === "schema_check" && item.satisfied && item.requirement !== undefined,
        );
        const schemaName = schemaEvidence?.requirement?.replace(/^schema_check:/, "");
        const structuredSchemaName =
          schemaName !== undefined && isReviewReportSchemaName(schemaName) ? schemaName : undefined;
        const structuredReport =
          structuredSchemaName === undefined
            ? undefined
            : (JSON.parse(bytes.toString("utf8")) as StructuredReviewReport);
        if (structuredReport !== undefined) {
          validateFindingReportIngestion(options.db, {
            artifactId: `pending:${attemptId}`,
            contentHash: createHash("sha256").update(bytes).digest("hex"),
            report: structuredReport,
          });
        }
        finalizeStageArtifact(options.db, artifactStore, {
          runId: attempt.runId,
          stageId: attempt.stageId,
          summary: finalized.result.summary,
          artifactPath: finalized.result.artifactPath,
          bytes,
          mediaType:
            structuredSchemaName === undefined ? "application/octet-stream" : "application/json",
          ...(structuredSchemaName === undefined
            ? {}
            : { contentSchemaId: contentSchemaIdForReviewReport(structuredSchemaName) }),
          producer: `pipeline-runner:${attempt.stageType}`,
          sourceLineage: [`attempt:${attemptId}`],
          ...(structuredSchemaName === undefined
            ? {}
            : {
                onPublished: (receipt) => {
                  recordFindingReport(options.db, {
                    artifactId: receipt.artifactId,
                    contentHash: receipt.contentHash,
                    report: structuredReport as StructuredReviewReport,
                  });
                },
              }),
        });
      } catch (error) {
        if (
          finalized.result.evidence.some((item) => item.kind === "schema_check" && item.satisfied)
        ) {
          throw error;
        }
        // Validation already decided; missing bytes do not invent success.
      }
    }

    const operation = operationRequests.get(attemptId);
    if (operation !== undefined) {
      const state = readRunnerOperationState(options.db, operation.operationId);
      if (state !== undefined) {
        updateRunnerOperationState(options.db, {
          operationId: operation.operationId,
          expectedRevision: state.revision,
          phase:
            finalized.result.outcome === "succeeded"
              ? "completed"
              : finalized.result.outcome === "cancelled"
                ? "cancelled"
                : "failed",
          result: finalized.result as never,
          ...(finalized.result.failure === undefined
            ? {}
            : { failure: finalized.result.failure as never }),
          now: options.clock.nowIso(),
        });
      }
    }

    const observationKind =
      finalized.result.outcome === "succeeded"
        ? ("attempt_succeeded" as const)
        : finalized.result.outcome === "cancelled"
          ? ("cancellation_settled" as const)
          : ("attempt_failed" as const);

    const classified =
      observationKind === "attempt_failed" && finalized.result.failure !== undefined
        ? buildClassifiedFailureObservation({
            runnerFailure: finalized.result.failure,
            validation: finalized.validation,
          })
        : undefined;

    finalizeRunnerAttempt(options.db, {
      attemptId,
      expectedRevision: attempt.revision,
      observationId: options.ids.next("obs"),
      observationKind,
      ...(classified === undefined
        ? finalized.result.failure?.retryable === undefined
          ? {}
          : { retryable: finalized.result.failure.retryable }
        : {
            retryable: classified.retryable,
            classifiedFailure: classified.failure as never,
            failureSignature: classified.signature as never,
          }),
      ...(attempt.backendExecutionId === undefined
        ? {}
        : {
            priorBackendExecutionId: attempt.backendExecutionId,
            resumeAvailable: attempt.stageType === "agent",
          }),
      result: finalized.result as never,
      ...(finalized.result.failure === undefined
        ? {}
        : { failure: finalized.result.failure as never }),
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

    if (finalized.result.outcome === "succeeded" && finalized.validation.valid) {
      const parts = loadPipelineSchedulerInputParts(options.db, attempt.runId);
      const graphStage = parts.graph.stages.find((candidate) => candidate.id === attempt.stageId);
      const built = buildCanonicalConditionState({
        baseState: parts.canonicalState,
        finalizedOutputs: [
          {
            stageId: attempt.stageId,
            writes: graphStage?.writes ?? [],
            outputs: finalized.result.outputs.map((output) => ({
              reference: output.reference,
              kind: output.kind,
              ...(output.value === undefined ? {} : { value: output.value }),
            })),
            validationValid: true,
          },
        ],
      });
      upsertCanonicalRunState(options.db, {
        runId: attempt.runId,
        state: built.state as never,
        now: options.clock.nowIso(),
      });
    }

    activeRunners.delete(attemptId);
    approvalRunners.delete(attemptId);
    waitingAttempts.delete(attemptId);
    operationRequests.delete(attemptId);
    await tick(attempt.runId);
  }

  async function resolveOperationRequest(input: {
    readonly stageType: OperationStageType;
    readonly runId: string;
    readonly stageId: string;
    readonly attemptId: string;
    readonly intentId: string;
    readonly stage: StageRunnerPrepareInput["stage"];
    readonly payload: Record<string, unknown>;
  }): Promise<JsonValue> {
    switch (input.stageType) {
      case "approval": {
        if (options.resolveApprovalRequest !== undefined) {
          return asOperationRequest(
            await options.resolveApprovalRequest({
              runId: input.runId,
              stageId: input.stageId,
              attemptId: input.attemptId,
              intentId: input.intentId,
              stage: input.stage,
            }),
          );
        }
        return asOperationRequest(
          defaultApprovalRequest({
            runId: input.runId,
            stageId: input.stageId,
            attemptId: input.attemptId,
            intentId: input.intentId,
            requestedAt: options.clock.nowIso(),
          }),
        );
      }
      case "integration": {
        if (options.resolveIntegrationRequest !== undefined) {
          return asOperationRequest(
            await options.resolveIntegrationRequest({
              runId: input.runId,
              stageId: input.stageId,
              attemptId: input.attemptId,
              intentId: input.intentId,
              stage: input.stage,
              payload: input.payload,
            }),
          );
        }
        if (input.payload.integrationRequest !== undefined) {
          return asOperationRequest(input.payload.integrationRequest);
        }
        throw new Error(`integration request unresolved for ${input.attemptId}`);
      }
      case "verify": {
        if (options.resolveVerifyRequest !== undefined) {
          return asOperationRequest(
            await options.resolveVerifyRequest({
              runId: input.runId,
              stageId: input.stageId,
              attemptId: input.attemptId,
              intentId: input.intentId,
              stage: input.stage,
              payload: input.payload,
            }),
          );
        }
        if (input.payload.verifyRequest !== undefined) {
          return asOperationRequest(input.payload.verifyRequest);
        }
        return asOperationRequest(defaultVerifyRequest(input.stage));
      }
      case "publish": {
        if (options.resolvePublishRequest !== undefined) {
          return asOperationRequest(
            await options.resolvePublishRequest({
              runId: input.runId,
              stageId: input.stageId,
              attemptId: input.attemptId,
              intentId: input.intentId,
              stage: input.stage,
              payload: input.payload,
            }),
          );
        }
        if (input.payload.publishRequest !== undefined) {
          return asOperationRequest(input.payload.publishRequest);
        }
        throw new Error(`publish request unresolved for ${input.attemptId}`);
      }
    }
  }

  async function driveDispatch(intent: {
    readonly intentId: string;
    readonly runId: string;
    readonly graphRevision: number;
    readonly payload: JsonValue;
  }): Promise<void> {
    const payload = payloadRecord(intent.payload);
    const stageType = String(payload.stageType ?? "");
    if (!FIXED_STAGE_TYPES.has(stageType)) {
      return;
    }
    const typedStage = stageType as FixedStageType;
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
      stageType: typedStage,
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

    if (requiresWorkspace(typedStage) && attempt.checkoutPath === undefined) {
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
    } else if (attempt.runtimeDirectory === undefined) {
      attempt = updateRunnerAttempt(options.db, {
        attemptId,
        expectedRevision: attempt.revision,
        runtimeDirectory,
        deadlineAt: schedule?.deadlineAt ?? null,
        preparedAt: options.clock.nowIso(),
        transitionDetail: "runtime_prepared",
        now: options.clock.nowIso(),
      });
    }

    const checkoutPath = attempt.checkoutPath;
    if (requiresWorkspace(typedStage)) {
      if (checkoutPath === undefined) {
        throw new Error(`runner attempt ${attemptId} missing checkout path`);
      }
      await validateExecutionWorkspace({
        assignedWorktree: checkoutPath,
        workingDirectory: checkoutPath,
        artifactPaths: [],
      });
    }

    let approvalRequest: ApprovalRequest | undefined;
    let integrationRequest: IntegrationRequest | undefined;
    let verifyRequest: VerifyRequest | undefined;
    let publishRequest: PublishRequest | undefined;

    if (isOperationStage(typedStage)) {
      const requestJson = await resolveOperationRequest({
        stageType: typedStage,
        runId: intent.runId,
        stageId,
        attemptId,
        intentId: intent.intentId,
        stage,
        payload,
      });
      const persisted = persistRunnerOperationRequest(options.db, {
        operationId: options.ids.next("operation"),
        attemptId,
        stageType: typedStage,
        request: requestJson,
        initialPhase: typedStage === "approval" ? "waiting" : "pending",
        now: options.clock.nowIso(),
      });
      attempt = persisted.attempt;
      operationRequests.set(attemptId, {
        operationId: persisted.request.operationId,
        stageType: typedStage,
        request: requestJson,
      });
      if (typedStage === "approval") {
        approvalRequest = requestJson as ApprovalRequest;
      } else if (typedStage === "integration") {
        integrationRequest = requestJson as IntegrationRequest;
      } else if (typedStage === "verify") {
        verifyRequest = requestJson as VerifyRequest;
      } else {
        publishRequest = requestJson as PublishRequest;
      }
    }

    const runner =
      typedStage === "agent" || typedStage === "command"
        ? createAgentOrCommandRunner(typedStage, stage, intent.runId, attemptId)
        : createOperationRunner(typedStage, attemptId);
    activeRunners.set(attemptId, runner);

    const retryDirective = resolveRetryDirective(payload, attemptId, options.db);
    let segmentDirective: StageRunnerSegmentDirective | undefined;

    if (typedStage === "agent" && retryDirective === undefined) {
      const predecessors = parts.graph.edges
        .filter((edge) => edge.to === stageId)
        .map((edge) => edge.from);
      const adjacent = predecessors.length === 1;
      const predecessorId = adjacent ? predecessors[0] : undefined;
      const predecessorStage =
        predecessorId === undefined
          ? undefined
          : parts.graph.stages.find((candidate) => candidate.id === predecessorId);

      // Prior succeeded agent attempt identity may be supplied on the dispatch
      // payload when the scheduler/daemon attaches fusion hints.
      const priorBackendExecutionId =
        typeof payload.priorBackendExecutionId === "string"
          ? payload.priorBackendExecutionId
          : typeof payload.fusedBackendExecutionId === "string"
            ? payload.fusedBackendExecutionId
            : undefined;
      const priorWorkspaceId =
        typeof payload.fusedWorkspaceId === "string"
          ? payload.fusedWorkspaceId
          : attempt.workspaceId;
      const priorLeaseId =
        typeof payload.fusedLeaseId === "string" ? payload.fusedLeaseId : attempt.leaseId;
      const priorCheckout =
        typeof payload.fusedCheckoutPath === "string" ? payload.fusedCheckoutPath : checkoutPath;

      const soft = parts.graph.context.handoffSoftThreshold;
      const hard = parts.graph.context.handoffHardThreshold;
      const successors = parts.graph.edges.filter(
        (edge) => edge.from === (predecessorId ?? ""),
      ).length;

      const plan = planFusionDispatch(options.db, {
        runId: intent.runId,
        ...(predecessorStage === undefined
          ? {}
          : {
              fromStage: {
                stageId: predecessorStage.id,
                stageType: predecessorStage.type,
                ...(predecessorStage.profile === undefined
                  ? {}
                  : { profileId: predecessorStage.profile }),
                ...(predecessorStage.session?.policy === undefined
                  ? {}
                  : { sessionPolicy: predecessorStage.session.policy }),
              },
            }),
        toStage: {
          stageId: stage.id,
          stageType: stage.type,
          ...(stage.profile === undefined ? {} : { profileId: stage.profile }),
          ...(stage.session?.policy === undefined ? {} : { sessionPolicy: stage.session.policy }),
        },
        fromWorkspace: {
          ...(priorWorkspaceId === undefined ? {} : { workspaceId: priorWorkspaceId }),
          ...(priorLeaseId === undefined ? {} : { leaseId: priorLeaseId }),
        },
        toWorkspace: {
          ...(attempt.workspaceId === undefined ? {} : { workspaceId: attempt.workspaceId }),
          ...(attempt.leaseId === undefined ? {} : { leaseId: attempt.leaseId }),
        },
        adjacent,
        successorCount: adjacent ? Math.max(1, successors) : predecessors.length,
        backendSupportsContinuation: true,
        ...(priorBackendExecutionId === undefined ? {} : { priorBackendExecutionId }),
        ...(priorCheckout === undefined ? {} : { checkoutPath: priorCheckout }),
        ...(soft === undefined ? {} : { softThreshold: soft }),
        ...(hard === undefined ? {} : { hardThreshold: hard }),
        instruction: `Continue with logical stage ${stageId}.`,
        // Prefer available measured pressure from payload when present; else
        // unavailable forces a conservative split (ADR 0018).
        pressure:
          typeof payload.contextPressureRatio === "number"
            ? {
                state: "measured" as const,
                ratio: payload.contextPressureRatio,
                confidence:
                  payload.contextPressureConfidence === "estimated"
                    ? ("estimated" as const)
                    : ("exact" as const),
                ...(soft === undefined ? {} : { softThreshold: soft }),
                ...(hard === undefined ? {} : { hardThreshold: hard }),
              }
            : {
                state: "unavailable" as const,
                confidence: "unavailable" as const,
                ...(soft === undefined ? {} : { softThreshold: soft }),
                ...(hard === undefined ? {} : { hardThreshold: hard }),
              },
        now: options.clock.nowIso(),
      });
      segmentDirective = plan.segmentDirective;
      if (plan.reuseWorkspace?.checkoutPath !== undefined && checkoutPath === undefined) {
        // Reuse fused workspace without provisioning a second worktree.
        attempt = updateRunnerAttempt(options.db, {
          attemptId,
          expectedRevision: attempt.revision,
          workspaceId: plan.reuseWorkspace.workspaceId,
          checkoutPath: plan.reuseWorkspace.checkoutPath,
          ...(plan.reuseWorkspace.leaseId === undefined
            ? {}
            : { leaseId: plan.reuseWorkspace.leaseId }),
          transitionDetail: "segment_workspace_reused",
          now: options.clock.nowIso(),
        });
      }
    }

    const prepareStage =
      typedStage === "agent" &&
      retryDirective?.mode === "delegate" &&
      retryDirective.delegateTo !== undefined
        ? {
            ...stage,
            profile: retryDirective.delegateTo as NonNullable<typeof stage.profile>,
          }
        : stage;

    await runner.prepare({
      attemptId,
      runId: intent.runId,
      stageId,
      intentId: intent.intentId,
      graphRevision: intent.graphRevision,
      generation,
      attemptOrdinal,
      stage: prepareStage,
      runtimeDirectory,
      ...(checkoutPath === undefined && attempt.checkoutPath === undefined
        ? {}
        : { checkoutPath: checkoutPath ?? attempt.checkoutPath }),
      ...(attempt.workspaceId === undefined ? {} : { workspaceId: attempt.workspaceId }),
      ...(attempt.leaseId === undefined ? {} : { leaseId: attempt.leaseId }),
      ...(schedule?.deadlineAt ? { deadlineAt: schedule.deadlineAt } : {}),
      ...(approvalRequest === undefined ? {} : { approvalRequest }),
      ...(integrationRequest === undefined ? {} : { integrationRequest }),
      ...(verifyRequest === undefined ? {} : { verifyRequest }),
      ...(publishRequest === undefined ? {} : { publishRequest }),
      ...(retryDirective === undefined ? {} : { retryDirective }),
      ...(retryDirective?.priorBackendExecutionId === undefined
        ? {}
        : { priorBackendExecutionId: retryDirective.priorBackendExecutionId }),
      ...(segmentDirective === undefined ? {} : { segmentDirective }),
      ...(segmentDirective?.priorBackendExecutionId === undefined
        ? {}
        : { priorBackendExecutionId: segmentDirective.priorBackendExecutionId }),
    });
    attempt = readRunnerAttempt(options.db, attemptId) ?? attempt;

    if (isOperationStage(typedStage) && typedStage !== "approval") {
      const operation = operationRequests.get(attemptId);
      if (operation !== undefined) {
        const state = readRunnerOperationState(options.db, operation.operationId);
        if (state !== undefined && state.phase === "pending") {
          updateRunnerOperationState(options.db, {
            operationId: operation.operationId,
            expectedRevision: state.revision,
            phase: "executing",
            now: options.clock.nowIso(),
          });
        }
      }
    }

    attempt = updateRunnerAttempt(options.db, {
      attemptId,
      expectedRevision: attempt.revision,
      phase: "start",
      transitionDetail: "prepare_complete",
      now: options.clock.nowIso(),
    });

    await runner.start(attemptId);
    attempt = readRunnerAttempt(options.db, attemptId) ?? attempt;
    if (typedStage === "agent" && attempt.backendExecutionId !== undefined) {
      bindSegmentBackendExecution(options.db, intent.runId, attempt.backendExecutionId);
    }
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
      // Cancel for a stage we never claimed — leave pending.
      return;
    }
    const runner = activeRunners.get(attemptId);
    if (runner === undefined) {
      updateRunnerAttempt(options.db, {
        attemptId,
        expectedRevision: attempt.revision,
        phase: "recovery_required",
        recovery: recoveryForMissingHandle(attempt),
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

  async function reconstructLiveRunner(
    attempt: NonNullable<ReturnType<typeof readRunnerAttempt>>,
  ): Promise<StageRunner | undefined> {
    if (!isOperationStage(attempt.stageType)) {
      return undefined;
    }
    const reconstructed = reconstructRunnerOperation(options.db, attempt.attemptId);
    if (reconstructed === undefined) {
      return undefined;
    }

    const parts = loadPipelineSchedulerInputParts(options.db, attempt.runId);
    const stage = parts.graph.stages.find((candidate) => candidate.id === attempt.stageId);
    if (stage === undefined) {
      return undefined;
    }

    const runtimeDirectory =
      attempt.runtimeDirectory ??
      join(options.runtimeDirectory, "pipeline-attempts", attempt.attemptId);
    await mkdir(runtimeDirectory, { recursive: true });

    const requestJson = reconstructed.request.request;
    operationRequests.set(attempt.attemptId, {
      operationId: reconstructed.request.operationId,
      stageType: attempt.stageType,
      request: requestJson,
    });

    const runner = createOperationRunner(attempt.stageType, attempt.attemptId);
    activeRunners.set(attempt.attemptId, runner);

    const prepareInput: StageRunnerPrepareInput = {
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      stageId: attempt.stageId,
      intentId: attempt.intentId,
      graphRevision: attempt.graphRevision,
      generation: attempt.generation,
      attemptOrdinal: attempt.attemptOrdinal,
      stage,
      runtimeDirectory,
      ...(attempt.checkoutPath === undefined ? {} : { checkoutPath: attempt.checkoutPath }),
      ...(attempt.workspaceId === undefined ? {} : { workspaceId: attempt.workspaceId }),
      ...(attempt.leaseId === undefined ? {} : { leaseId: attempt.leaseId }),
      ...(attempt.deadlineAt === undefined ? {} : { deadlineAt: attempt.deadlineAt }),
      ...(attempt.stageType === "approval"
        ? { approvalRequest: requestJson as ApprovalRequest }
        : {}),
      ...(attempt.stageType === "integration"
        ? { integrationRequest: requestJson as IntegrationRequest }
        : {}),
      ...(attempt.stageType === "verify" ? { verifyRequest: requestJson as VerifyRequest } : {}),
      ...(attempt.stageType === "publish" ? { publishRequest: requestJson as PublishRequest } : {}),
    };

    await runner.prepare(prepareInput);
    await runner.start(attempt.attemptId);

    if (attempt.stageType === "approval" && reconstructed.answer !== undefined) {
      const approval = approvalRunners.get(attempt.attemptId);
      const decision = reconstructed.answer.decisionJson as ApprovalDecision;
      if (approval !== undefined) {
        await approval.answer(attempt.attemptId, decision);
      }
    }

    return runner;
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

      let runner = activeRunners.get(attempt.attemptId);
      if (runner === undefined && isOperationStage(attempt.stageType)) {
        runner = await reconstructLiveRunner(attempt);
        if (runner === undefined) {
          updateRunnerAttempt(options.db, {
            attemptId: attempt.attemptId,
            expectedRevision: attempt.revision,
            phase: "recovery_required",
            recovery: recoveryForMissingHandle(attempt),
            finishedAt: options.clock.nowIso(),
            transitionDetail: "reconstruction_impossible",
            now: options.clock.nowIso(),
          });
          continue;
        }
      }

      if (runner === undefined) {
        updateRunnerAttempt(options.db, {
          attemptId: attempt.attemptId,
          expectedRevision: attempt.revision,
          phase: "recovery_required",
          recovery: recoveryForMissingHandle(attempt),
          finishedAt: options.clock.nowIso(),
          transitionDetail: "daemon_restart",
          now: options.clock.nowIso(),
        });
        continue;
      }

      if (waitingAttempts.has(attempt.attemptId)) {
        const observation = await runner.observe(attempt.attemptId);
        if (observation.status === "waiting") {
          continue;
        }
      }

      await settleRunner(attempt.attemptId, runner, "reconcile");
    }
    await drainIntents();
  }

  async function answerApproval(input: {
    readonly attemptId: string;
    readonly decision: ApprovalDecision;
  }): Promise<
    | {
        readonly status: "recorded";
        readonly attemptId: string;
        readonly operationId: string;
        readonly interactionRevision: number;
      }
    | {
        readonly status: "stale_revision";
        readonly attemptId: string;
        readonly currentRevision: number;
      }
  > {
    const attempt = readRunnerAttempt(options.db, input.attemptId);
    if (attempt === undefined) {
      throw new Error(`unknown runner attempt ${input.attemptId}`);
    }
    if (attempt.stageType !== "approval") {
      throw new Error(`attempt ${input.attemptId} is not an approval stage`);
    }

    let operationId = attempt.operationId;
    let reconstructed = reconstructRunnerOperation(options.db, input.attemptId);
    if (operationId === undefined || operationId === null) {
      operationId = reconstructed?.request.operationId;
    }
    if (operationId === undefined) {
      throw new Error(`approval attempt ${input.attemptId} has no durable operation`);
    }

    const recorded = recordRunnerApprovalAnswer(options.db, {
      answerId: options.ids.next("answer"),
      operationId,
      attemptId: input.attemptId,
      interactionId: input.decision.interactionId,
      expectedRevision: input.decision.expectedInteractionRevision,
      decision: input.decision.decision,
      selectedLabel: input.decision.selectedLabel,
      answeredByKeyId: input.decision.answeredByKeyId,
      decisionJson: input.decision as never,
      answeredAt: input.decision.answeredAt,
    });
    if (recorded.status === "stale_revision") {
      return {
        status: "stale_revision",
        attemptId: input.attemptId,
        currentRevision: recorded.currentRevision,
      };
    }

    let runner = approvalRunners.get(input.attemptId);
    if (runner === undefined) {
      const live = await reconstructLiveRunner(attempt);
      runner = approvalRunners.get(input.attemptId);
      if (live !== undefined && runner === undefined) {
        throw new Error(`failed to reconstruct approval runner for ${input.attemptId}`);
      }
    }
    if (runner !== undefined) {
      const answered = await runner.answer(input.attemptId, input.decision);
      if (answered.status === "stale_revision") {
        const state = readRunnerOperationState(options.db, operationId);
        return {
          status: "stale_revision",
          attemptId: input.attemptId,
          currentRevision: state?.revision ?? input.decision.expectedInteractionRevision,
        };
      }
      waitingAttempts.delete(input.attemptId);
      await settleRunner(input.attemptId, runner, "reconcile");
    }

    reconstructed = reconstructRunnerOperation(options.db, input.attemptId);
    const interactionRevision =
      reconstructed?.state.revision ?? input.decision.expectedInteractionRevision + 1;
    return {
      status: "recorded",
      attemptId: input.attemptId,
      operationId,
      interactionRevision,
    };
  }

  function status(runId: string): PipelineRunLifecycle {
    const schedule = readPipelineSchedule(options.db, runId);
    if (schedule === undefined) return { state: "missing" };
    if (schedule.terminalOutcome !== undefined) {
      if (schedule.terminalOutcome === "succeeded") return { state: "succeeded" };
      if (schedule.terminalOutcome === "cancelled") return { state: "cancelled" };
      return { state: "failed" };
    }
    const attempts = readOpenRunnerAttempts(options.db).filter(
      (attempt) => attempt.runId === runId,
    );
    if (attempts.some((attempt) => attempt.phase === "recovery_required")) {
      return { state: "recovery_required" };
    }
    const retrying = readPipelineStageProjections(options.db, runId)
      .filter(
        (stage) =>
          stage.attemptOrdinal > 1 &&
          !["succeeded", "failed", "cancelled", "blocked"].includes(stage.state),
      )
      .sort((left, right) => right.attemptOrdinal - left.attemptOrdinal)[0];
    return retrying === undefined
      ? { state: "running" }
      : { state: "retrying", attemptOrdinal: retrying.attemptOrdinal };
  }

  async function cancel(runId: string): Promise<PipelineRunLifecycle> {
    const current = status(runId);
    if (["missing", "succeeded", "failed", "cancelled"].includes(current.state)) return current;
    recordPipelineObservation(options.db, {
      observationId: options.ids.next("obs"),
      runId,
      kind: "cancel_requested",
      payload: {},
      recordedAt: options.clock.nowIso(),
    });
    await tick(runId);
    await drainIntents(runId);
    return status(runId);
  }

  return {
    tick,
    status,
    cancel,
    drainIntents,
    reconcile,
    cleanupHealth: () => reportRunnerCleanupHealth(options.db),
    exportAttempt: (attemptId) => exportRunnerAttempt(options.db, attemptId),
    listApprovalInbox: () => listPipelineApprovalInbox(options.db),
    answerApproval,
    recordRecoveryApproval: (input) =>
      recordRecoveryApproval(options.db, {
        ...input,
        now: options.clock.nowIso(),
        observationId: options.ids.next("obs"),
      }),
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
