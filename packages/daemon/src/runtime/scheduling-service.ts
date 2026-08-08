import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ExecutionBackendV7,
  ExecutionFailureV1,
  ExecutionResultV5,
  InteractionAnswerSubmissionV2,
  InteractionV2,
  ResolvedProfileChainV1,
  RunId,
  StageId,
  WorkspaceId,
} from "@heniek/contracts";
import {
  answerCapacityQuestion,
  assignAttemptWorkspace,
  cancelQueuedExecutionSchedule,
  claimNextExecutionCandidate,
  commitStateChange,
  completeExecutionAttempt,
  createArtifactStore,
  createExecutionSchedule,
  findRegisteredExecutionContext,
  type JsonValue,
  readCapacityQuestion,
  readExecutionAttempts,
  readExecutionSchedule,
  readIdentity,
  readRecoverableSchedulingAttempts,
  readSchedulingDecisions,
  recordAttemptReadonlyBaseline,
  renewAccountLease,
  restoreAccountLease,
  type StateDatabase,
  startExecutionAttempt,
  updateAttemptLimits,
} from "@heniek/state";
import {
  assertReadonlyWorkspaceUnchanged,
  captureWorkspaceGitState,
  validateExecutionWorkspace,
  type WorkspaceGitState,
  type WorkspaceService,
} from "@heniek/workspace";
import type { Static } from "@sinclair/typebox";
import {
  isFallbackEligibleFailure,
  resolveAttemptLimits,
  resolveAttemptPermissions,
} from "../scheduling/policy.js";
import { finalizeStageArtifact } from "./stage-completion.js";

const execFileAsync = promisify(execFile);
type ProfileChain = Static<typeof ResolvedProfileChainV1>;
type Failure = Static<typeof ExecutionFailureV1>;
type Result = Static<typeof ExecutionResultV5>;

export interface ScheduledStageInput {
  readonly currentDirectory: string;
  readonly prompt: string;
  readonly artifactPath: string;
  readonly profileId: string;
  readonly priority?: number;
  readonly requestedIdentifiers?: readonly string[];
  readonly limits?: { readonly maxDurationMs?: number; readonly maxTurns?: number };
}

export interface SchedulingExecutionServiceOptions {
  readonly db: StateDatabase;
  readonly backend: ExecutionBackendV7;
  readonly workspaceService: WorkspaceService;
  readonly instanceId: string;
  readonly artifactsDirectory: string;
  readonly ids: { next(prefix: string): string };
  readonly clock: { nowIso(): string };
  readonly resolveProfileChain: (profileId: string) => Promise<ProfileChain> | ProfileChain;
  readonly createIdentifierReader: (allowedIdentifiers: readonly string[]) => {
    read(identifier: string): Promise<unknown>;
  };
  readonly pollMilliseconds?: number;
}

export interface SchedulingExecutionService {
  start(input: ScheduledStageInput): Promise<{
    readonly runId: string;
    readonly stageId: string;
    readonly schedulingRevision: number;
  }>;
  dispatchAvailable(): Promise<void>;
  reconcile(): Promise<void>;
  status(runId: string): ReturnType<typeof schedulingStatus>;
  result(runId: string): Result | undefined;
  interactions(runId: string): readonly Static<typeof InteractionV2>[];
  answer(
    runId: string,
    answer: Static<typeof InteractionAnswerSubmissionV2>,
    answeredByKeyId: string,
  ): Promise<{
    readonly interactionId: string;
    readonly interactionRevision: number;
    readonly scheduleRevision: number;
    readonly operationId: string;
  }>;
  cancel(runId: string): Promise<void>;
  stop(): void;
}

function safeArtifactPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split(/[\\/]/u).some((segment) => segment === ".." || segment === "")
  );
}

async function repositoryHead(repositoryPath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repositoryPath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  const sha = stdout.trim();
  if (!/^[a-f0-9]{40}$/iu.test(sha)) throw new Error("repository HEAD is not a full commit SHA");
  return sha;
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

function failure(
  classification: Failure["classification"],
  phase: Failure["phase"],
  code: string,
  message: string,
  fallbackEligible: boolean,
): Failure {
  return { schemaVersion: 1, classification, phase, code, message, fallbackEligible };
}

function backendFailureFrom(error: unknown): Failure | undefined {
  if (typeof error !== "object" || error === null || !("failure" in error)) return undefined;
  const candidate = (error as { failure?: unknown }).failure;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const record = candidate as Partial<Failure>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.classification !== "string" ||
    typeof record.phase !== "string" ||
    typeof record.code !== "string" ||
    typeof record.message !== "string" ||
    typeof record.fallbackEligible !== "boolean"
  ) {
    return undefined;
  }
  return record as Failure;
}

function schedulingStatus(db: StateDatabase, runId: string) {
  const schedule = readExecutionSchedule(db, runId);
  if (schedule === undefined) return undefined;
  const attempts = readExecutionAttempts(db, runId);
  const last = attempts.at(-1);
  const status =
    schedule.state === "queued"
      ? "queued"
      : schedule.state === "waiting_on_user"
        ? "waiting_on_user"
        : schedule.state === "running"
          ? (last?.status ?? "queued")
          : (last?.status ?? "failed");
  return { schedule, attempts, decisions: readSchedulingDecisions(db, runId), status };
}

function schedulingInteractions(
  db: StateDatabase,
  runId: string,
): readonly Static<typeof InteractionV2>[] {
  const question = readCapacityQuestion(db, runId);
  if (question === undefined) return [];
  const interaction = question.interaction as Static<typeof InteractionV2>;
  if (question.state === "pending") return [interaction];
  const answer = question.answer as { answeredAt?: string } | null;
  return [
    {
      ...interaction,
      status: "answered",
      revision: question.revision,
      deliveryState: "not_applicable",
      ...(answer?.answeredAt === undefined ? {} : { resolvedAt: answer.answeredAt }),
    },
  ];
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

export function createSchedulingExecutionService(
  options: SchedulingExecutionServiceOptions,
): SchedulingExecutionService {
  const owner = {
    ownerId: options.instanceId,
    bootWitness: `daemon:${options.instanceId}`,
    processWitnesses: [] as const,
  };
  const leaseRevisions = new Map<string, number>();
  const leaseRenewedAt = new Map<string, number>();
  const readonlyBaselines = new Map<string, WorkspaceGitState>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const artifactStore = createArtifactStore({
    root: options.artifactsDirectory,
    clock: options.clock,
    ids: options.ids,
  });

  function schedulePoll(): void {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void reconcile().finally(schedulePoll);
    }, options.pollMilliseconds ?? 1_000);
    timer.unref?.();
  }

  async function provisionAndStart(
    claim: NonNullable<ReturnType<typeof claimNextExecutionCandidate>>,
  ) {
    const workspaceId = options.ids.next("workspace") as WorkspaceId;
    commitStateChange(options.db, {
      type: "workspace.registered",
      payload: { workspaceId, codebaseId: claim.codebaseId },
    });
    let backendStartAttempted = false;
    try {
      const schedule = readExecutionSchedule(options.db, claim.runId);
      if (schedule === undefined) throw new Error("execution schedule disappeared");
      const registered = findRegisteredExecutionContextForRepository(
        options.db,
        claim.repositoryId,
      );
      const manifest = await options.workspaceService.provision({
        workspaceId,
        codebaseId: claim.codebaseId as never,
        repositoryId: claim.repositoryId as never,
        integrationBranch: `heniek-${claim.runId}-attempt-${claim.candidateIndex + 1}`,
        baseSha: claim.baseSha,
        owner,
        configuration: workspaceConfiguration(registered.defaultRemote, registered.defaultBranch),
      });
      if (manifest.lifecycle !== "ready") throw new Error("managed workspace provisioning failed");
      await validateExecutionWorkspace({
        assignedWorktree: manifest.checkoutPath,
        workingDirectory: manifest.checkoutPath,
        artifactPaths: [claim.artifactPath],
      });
      assignAttemptWorkspace(options.db, claim.attemptId, workspaceId);
      commitStateChange(options.db, {
        runId: claim.runId,
        type: "run.workspace_assigned",
        payload: { runId: claim.runId, workspaceId },
      });
      const permissions = claim.permissions as Static<
        typeof import("@heniek/contracts").ExecutionPermissionEnvelopeV1
      >;
      const storedLimits = claim.limits as { maxDurationMs?: number; maxTurns?: number };
      const remainingMilliseconds =
        claim.hardDeadlineAt === undefined
          ? undefined
          : Math.max(0, Date.parse(claim.hardDeadlineAt) - Date.parse(options.clock.nowIso()));
      const effectiveLimits = {
        ...storedLimits,
        ...(remainingMilliseconds === undefined
          ? {}
          : {
              maxDurationMs:
                storedLimits.maxDurationMs === undefined
                  ? remainingMilliseconds
                  : Math.min(storedLimits.maxDurationMs, remainingMilliseconds),
            }),
      };
      updateAttemptLimits(options.db, claim.attemptId, asJson(effectiveLimits));
      if (effectiveLimits.maxDurationMs === 0) {
        const deadlineFailure = failure(
          "hard_limit_exceeded",
          "start",
          "hard_deadline_exhausted",
          "The run hard deadline was exhausted before this attempt could start.",
          false,
        );
        completeExecutionAttempt(options.db, {
          attemptId: claim.attemptId,
          status: "failed",
          failure: asJson(deadlineFailure),
          fallbackEligible: false,
        });
        return;
      }
      if (permissions.workspace === "read-only") {
        const baseline = await captureWorkspaceGitState(manifest.checkoutPath);
        readonlyBaselines.set(claim.attemptId, baseline);
        recordAttemptReadonlyBaseline(options.db, claim.attemptId, asJson(baseline));
      }
      backendStartAttempted = true;
      const handle = await options.backend.start(
        {
          schemaVersion: 4,
          runId: claim.runId,
          stageId: claim.stageId as StageId,
          workspaceId,
          workingDirectory: manifest.checkoutPath,
          prompt: claim.prompt,
          artifactPath: claim.artifactPath,
          inputArtifactRefs: [],
          limits: effectiveLimits,
          profile: claim.profile as Static<typeof import("@heniek/contracts").ResolvedProfileV2>,
          permissions,
        },
        { identifierReader: options.createIdentifierReader(permissions.identifiers) },
      );
      startExecutionAttempt(options.db, claim.attemptId, handle.executionId);
      leaseRevisions.set(claim.attemptId, claim.fencingRevision);
      leaseRenewedAt.set(claim.attemptId, Date.parse(options.clock.nowIso()));
    } catch (error) {
      const classified =
        (backendStartAttempted ? backendFailureFrom(error) : undefined) ??
        failure(
          backendStartAttempted ? "unknown" : "workspace_failed",
          "start",
          backendStartAttempted ? "backend_start_failed" : "attempt_setup_failed",
          backendStartAttempted
            ? "The provider backend failed to start the attempt."
            : "Attempt setup failed before provider execution.",
          false,
        );
      const fallbackEligible = isFallbackEligibleFailure(classified);
      completeExecutionAttempt(options.db, {
        attemptId: claim.attemptId,
        status: "failed",
        failure: asJson(classified),
        fallbackEligible,
      });
      if (fallbackEligible) return;
      throw error;
    }
  }

  async function dispatchAvailable(): Promise<void> {
    for (;;) {
      const claim = claimNextExecutionCandidate(options.db, { ownerId: options.instanceId });
      if (claim === undefined) break;
      await provisionAndStart(claim);
    }
    schedulePoll();
  }

  async function finishTerminal(attemptId: string, backendExecutionId: string): Promise<void> {
    const result = await options.backend.result(backendExecutionId);
    const attempt = readRecoverableSchedulingAttempts(options.db).find(
      (candidate) => candidate.attemptId === attemptId,
    );
    if (attempt === undefined) throw new Error("terminal attempt is not recoverable");
    if (attempt.permissions !== null) {
      const permissions = attempt.permissions as unknown as { workspace?: string };
      if (permissions.workspace === "read-only" && attempt.workspaceId !== null) {
        const schedule = readExecutionSchedule(options.db, attempt.runId);
        if (schedule === undefined) throw new Error("scheduled execution is missing its schedule");
        const registered = findRegisteredExecutionContextForRepository(
          options.db,
          schedule.repositoryId,
        );
        const workspace = readIdentity(options.db, "workspace", attempt.workspaceId);
        const checkout = workspace?.checkoutPath ?? registered.repositoryPath;
        const before =
          readonlyBaselines.get(attemptId) ??
          (attempt.readonlyBaseline as unknown as WorkspaceGitState);
        try {
          assertReadonlyWorkspaceUnchanged(before, await captureWorkspaceGitState(checkout));
        } catch {
          const mutationFailure = failure(
            "permission_denied",
            "completion",
            "readonly_workspace_mutated",
            "Read-only execution mutated its assigned worktree.",
            false,
          );
          completeExecutionAttempt(options.db, {
            attemptId,
            status: "failed",
            failure: asJson(mutationFailure),
            fallbackEligible: false,
          });
          leaseRevisions.delete(attemptId);
          leaseRenewedAt.delete(attemptId);
          return;
        }
      }
    }
    if (result.status === "succeeded") {
      const schedule = readExecutionSchedule(options.db, attempt.runId);
      if (schedule === undefined) throw new Error("successful attempt lost its schedule");
      try {
        const listed = await options.backend.artifacts(backendExecutionId);
        const declared = listed.find((artifact) => artifact.path === schedule.artifactPath);
        if (declared === undefined) throw new Error("declared artifact is missing");
        const bytes = await options.backend.readArtifact(backendExecutionId, declared.id);
        finalizeStageArtifact(options.db, artifactStore, {
          runId: attempt.runId,
          stageId: attempt.stageId,
          summary: result.summary,
          artifactPath: schedule.artifactPath,
          bytes,
          mediaType: declared.mediaType,
          producer: "execution-backend",
          sourceLineage: [declared.id],
          declaredByteLength: declared.byteLength,
          ...(declared.sha256 === undefined ? {} : { declaredSha256: declared.sha256 }),
        });
      } catch {
        const artifactFailure = failure(
          "artifact_failed",
          "completion",
          "declared_artifact_invalid",
          "The successful attempt did not provide a valid declared artifact.",
          false,
        );
        completeExecutionAttempt(options.db, {
          attemptId,
          status: "failed",
          failure: asJson(artifactFailure),
          fallbackEligible: false,
        });
        leaseRevisions.delete(attemptId);
        leaseRenewedAt.delete(attemptId);
        return;
      }
    }
    completeExecutionAttempt(options.db, {
      attemptId,
      status: result.status,
      result: asJson(result),
      ...(result.failure === undefined ? {} : { failure: asJson(result.failure) }),
      fallbackEligible:
        result.failure === undefined ? false : isFallbackEligibleFailure(result.failure),
    });
    leaseRevisions.delete(attemptId);
    leaseRenewedAt.delete(attemptId);
  }

  function fenceUnconfirmedAttempt(attemptId: string, reasonCode: string): void {
    const recovered = restoreAccountLease(options.db, {
      attemptId,
      ownerId: options.instanceId,
      recoveryReasonCode: reasonCode,
    });
    leaseRevisions.set(attemptId, recovered.fencingRevision);
    leaseRenewedAt.set(attemptId, Date.parse(options.clock.nowIso()));
  }

  async function reconcile(): Promise<void> {
    for (const attempt of readRecoverableSchedulingAttempts(options.db)) {
      if (attempt.backendExecutionId === null) continue;
      let status: Awaited<ReturnType<ExecutionBackendV7["status"]>>;
      try {
        status = await options.backend.status(attempt.backendExecutionId);
      } catch {
        fenceUnconfirmedAttempt(attempt.attemptId, "backend_status_unconfirmed");
        continue;
      }
      if (status === "succeeded" || status === "failed" || status === "cancelled") {
        await finishTerminal(attempt.attemptId, attempt.backendExecutionId);
      } else if (status === "recovery_required" && attempt.status !== "recovery_required") {
        fenceUnconfirmedAttempt(attempt.attemptId, "backend_recovery_required");
      } else {
        const revision = leaseRevisions.get(attempt.attemptId);
        if (revision === undefined) {
          const restored = restoreAccountLease(options.db, {
            attemptId: attempt.attemptId,
            ownerId: options.instanceId,
          });
          leaseRevisions.set(attempt.attemptId, restored.fencingRevision);
          leaseRenewedAt.set(attempt.attemptId, Date.parse(options.clock.nowIso()));
        } else {
          const now = Date.parse(options.clock.nowIso());
          const lastRenewed = leaseRenewedAt.get(attempt.attemptId) ?? 0;
          if (now - lastRenewed < 60_000) continue;
          const renewed = renewAccountLease(options.db, {
            attemptId: attempt.attemptId,
            ownerId: options.instanceId,
            fencingRevision: revision,
          });
          leaseRevisions.set(attempt.attemptId, renewed.fencingRevision);
          leaseRenewedAt.set(attempt.attemptId, now);
        }
      }
    }
    await dispatchAvailable();
  }

  return {
    async start(input) {
      if (!safeArtifactPath(input.artifactPath)) throw new Error("artifact path must be safe");
      const context = findRegisteredExecutionContext(options.db, input.currentDirectory);
      if (context === undefined) throw new Error("current directory is not registered");
      const chain = await options.resolveProfileChain(input.profileId);
      const requested = input.requestedIdentifiers ?? [];
      const profiles = [chain.primary, ...chain.fallbacks];
      const permissionResults = profiles.map((candidate) =>
        resolveAttemptPermissions(chain.primary, candidate, requested),
      );
      if (!permissionResults[0]?.ok)
        throw new Error("primary profile denies requested permissions");
      if (chain.primary.accountId === undefined)
        throw new Error("primary profile needs an account");
      const baseSha = await repositoryHead(context.repositoryPath);
      const now = options.clock.nowIso();
      const hardDeadlineAt =
        input.limits?.maxDurationMs === undefined
          ? undefined
          : new Date(Date.parse(now) + input.limits.maxDurationMs).toISOString();
      const runId = options.ids.next("run") as RunId;
      const stageId = options.ids.next("stage") as StageId;
      const candidates = profiles.map((candidate, index) => {
        const permissionResult = permissionResults[index];
        const compatible = permissionResult?.ok === true && candidate.accountId !== undefined;
        return {
          profileId: candidate.profileId,
          ...(candidate.accountId === undefined ? {} : { accountId: candidate.accountId }),
          engine: candidate.engine,
          maxConcurrentRuns: candidate.accountMaxConcurrentRuns ?? 1,
          profile: asJson(candidate),
          limits: asJson(
            resolveAttemptLimits({
              stage: input.limits ?? {},
              invocation: input.limits ?? {},
              ...(candidate.maxDurationMs === undefined
                ? {}
                : { profileMaxDurationMs: candidate.maxDurationMs }),
              ...(hardDeadlineAt === undefined ? {} : { hardDeadlineAt }),
              now,
            }),
          ),
          permissions: asJson(
            permissionResult?.ok === true
              ? permissionResult.permissions
              : {
                  schemaVersion: 1,
                  workspace: "read-only",
                  identifiers: [],
                },
          ),
          compatible,
          ...(compatible ? {} : { rejectionReason: "permission_or_account_incompatible" }),
        };
      });
      commitStateChange(options.db, {
        runId,
        type: "run.created",
        payload: { runId, codebaseId: context.codebaseId },
      });
      const schedule = createExecutionSchedule(options.db, {
        runId,
        stageId,
        codebaseId: context.codebaseId,
        repositoryId: context.repositoryId,
        prompt: input.prompt,
        artifactPath: input.artifactPath,
        baseSha,
        ...(hardDeadlineAt === undefined ? {} : { hardDeadlineAt }),
        capacityPolicy: chain.primary.onCapacity,
        requestedPriority: input.priority ?? 0,
        requestedIdentifiers: requested,
        chain: asJson(chain),
        candidates,
      });
      await dispatchAvailable();
      return {
        runId,
        stageId,
        schedulingRevision: readExecutionSchedule(options.db, runId)?.revision ?? schedule.revision,
      };
    },
    dispatchAvailable,
    reconcile,
    status: (runId) => schedulingStatus(options.db, runId),
    interactions: (runId) => schedulingInteractions(options.db, runId),
    async answer(runId, answer, answeredByKeyId) {
      const accepted = answerCapacityQuestion(options.db, {
        runId,
        interactionId: answer.interactionId,
        expectedInteractionRevision: answer.expectedInteractionRevision,
        answers: answer.answers,
        answeredByKeyId,
      });
      await dispatchAvailable();
      return accepted;
    },
    result(runId) {
      const succeeded = readExecutionAttempts(options.db, runId).find(
        (attempt) => attempt.status === "succeeded" && attempt.result !== null,
      );
      return succeeded?.result as Result | undefined;
    },
    async cancel(runId) {
      const snapshot = schedulingStatus(options.db, runId);
      if (snapshot === undefined) throw new Error("scheduled run does not exist");
      if (snapshot.schedule.state === "terminal") return;
      if (snapshot.schedule.state !== "running") {
        cancelQueuedExecutionSchedule(options.db, runId);
        return;
      }
      const attempt = snapshot.attempts.at(-1);
      if (attempt?.backendExecutionId === null || attempt?.backendExecutionId === undefined) {
        throw new Error("scheduled attempt has not reached a cancellable backend state");
      }
      await options.backend.cancel(attempt.backendExecutionId);
      let status: Awaited<ReturnType<ExecutionBackendV7["status"]>>;
      try {
        status = await options.backend.status(attempt.backendExecutionId);
      } catch {
        fenceUnconfirmedAttempt(attempt.attemptId, "cancel_status_unconfirmed");
        return;
      }
      if (status !== "cancelled" && status !== "failed" && status !== "succeeded") {
        return;
      }
      await finishTerminal(attempt.attemptId, attempt.backendExecutionId);
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function findRegisteredExecutionContextForRepository(db: StateDatabase, repositoryId: string) {
  const repository = readIdentity(db, "repository", repositoryId);
  if (
    repository?.repositoryPath === null ||
    repository?.repositoryPath === undefined ||
    repository.defaultRemote === null ||
    repository.defaultBranch === null
  ) {
    throw new Error("registered repository context is unavailable");
  }
  return {
    repositoryPath: repository.repositoryPath,
    defaultRemote: repository.defaultRemote,
    defaultBranch: repository.defaultBranch,
  };
}
