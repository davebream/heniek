/**
 * The native Claude bridge service (Q023, ADR 0021).
 *
 * The store (`@heniek/state`'s `native-bridge/store.ts`) owns every fencing,
 * idempotency and atomicity guarantee — CR1 through CR9 are all closed at
 * that layer, inside single SQLite transactions. This service exists only
 * for the two things the store structurally cannot do itself:
 *
 * 1. Filesystem/git work — provisioning a claimed dispatch's worktree and
 *    reading back a submitted artifact — exactly mirroring how
 *    `SchedulingExecutionService.provisionAndStart` sits beside
 *    `claimNextExecutionCandidate`.
 * 2. Calling `finalizeStageArtifact`, which only `@heniek/daemon` may import
 *    (see `stage-completion.ts`'s own header) and which itself opens a
 *    top-level transaction via `completeStage`/`commitStateChangeInternal` —
 *    it cannot be nested inside the store's own transactions, which is
 *    exactly why `settleNativeDispatch` stops at "marked submitted" for a
 *    succeeded outcome and returns `requiresArtifactCompletion: true`.
 *
 * `submit()`'s ordering is load-bearing (design review finding on CR3): the
 * artifact bytes are read from disk *before* calling `settleNativeDispatch`,
 * and nothing awaits between that read resolving and the store call — so
 * nothing can interleave in the gap a rebind would need to exploit. The
 * fencing CAS inside `settleNativeDispatch` is what actually closes the
 * race; this ordering is what guarantees it runs first.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ProfileInvocationOverrides } from "@heniek/config";
import type { ResolvedProfileChainV1 } from "@heniek/contracts";
import {
  type AnswerNativeQuestionInput,
  type AttachParentSessionInput,
  answerNativeQuestion,
  assignNativeAttemptWorkspace,
  attachParentSession,
  type ClaimedNativeStage,
  cancelNativeStage,
  completeNativeAttemptArtifactOutcome,
  createArtifactStore,
  createNativeStage,
  type DetachParentSessionInput,
  detachParentSession,
  downgradeNativeAttemptToFailed,
  findRegisteredExecutionContext,
  pollNativeBridge,
  type RaiseNativeQuestionInput,
  raiseNativeQuestion,
  readIdentity,
  readNativeStage,
  readNativeStageAttempts,
  readPendingNativeQuestions,
  readRunProjection,
  reapAllExpiredParentSessions,
  recordNativeAttemptReadonlyBaseline,
  recordNativeAttemptWorkspaceFailure,
  resumeNativeStage,
  type StateDatabase,
  settleNativeDispatch,
  type WitnessClassifier,
} from "@heniek/state";
import {
  assertReadonlyWorkspaceUnchanged,
  captureWorkspaceGitState,
  validateExecutionWorkspace,
  type WorkspaceService,
} from "@heniek/workspace";
import type { Static } from "@sinclair/typebox";
import { resolveAttemptLimits, resolveAttemptPermissions } from "../scheduling/policy.js";
import { finalizeStageArtifact, StageResultContractError } from "./stage-completion.js";

type ProfileChain = Static<typeof ResolvedProfileChainV1>;

/**
 * No wire witness channel exists yet — Q050 (not this issue) builds the
 * Claude Code plugin, and only a plugin could ever report a real process
 * witness for the parent session it runs inside. Every session therefore
 * carries a `null` witness, and this classifier answers `"unknown"` for all
 * of them — the fail-closed default §18.2 asks for when liveness cannot be
 * proven, not a stand-in for a check nobody wrote yet.
 */
export const UNPROVABLE_LIVENESS_WITNESS: WitnessClassifier = () => "unknown";

export interface StartNativeStageInput {
  readonly currentDirectory: string;
  readonly prompt: string;
  readonly artifactPath: string;
  readonly profileId: string;
  readonly requestedIdentifiers?: readonly string[];
  readonly limits?: { readonly maxDurationMs?: number; readonly maxTurns?: number };
  readonly invocationOverrides?: ProfileInvocationOverrides;
  readonly preferredFeatures?: readonly string[];
  readonly preferredTools?: readonly string[];
  readonly requiredFeatures?: readonly string[];
  readonly requiredTools?: readonly string[];
}

export interface SubmitNativeDispatchInput {
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly dispatchId: string;
  readonly expectedDispatchRevision: number;
  readonly runId: string;
  readonly stageId: string;
  readonly attemptId: string;
  readonly submissionId: string;
  readonly submissionDigest: string;
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly declaredSummary?: string;
  readonly declaredArtifactPath?: string;
  readonly failure?: {
    readonly schemaVersion: 1;
    readonly classification:
      | "account_unavailable"
      | "profile_unavailable"
      | "model_unavailable"
      | "engine_unavailable"
      | "provider_throttled"
      | "context_capacity_exhausted"
      | "authentication_failed"
      | "permission_denied"
      | "invalid_request"
      | "workspace_failed"
      | "artifact_failed"
      | "hard_limit_exceeded"
      | "cancelled"
      | "ambiguous"
      | "unknown";
    readonly phase: "admission" | "start" | "running" | "completion";
    readonly code: string;
    readonly message: string;
    readonly fallbackEligible: boolean;
  };
}

export type SubmitNativeDispatchOutcome =
  | {
      readonly accepted: true;
      readonly idempotentReplay: boolean;
      readonly status: string;
    }
  | { readonly accepted: false; readonly rejectionCode: string };

export interface NativeBridgeServiceOptions {
  readonly db: StateDatabase;
  readonly workspaceService: WorkspaceService;
  readonly instanceId: string;
  readonly artifactsDirectory: string;
  readonly ids: { next(prefix: string): string };
  readonly clock: { nowIso(): string };
  readonly resolveProfileChain: (
    profileId: string,
    options?: { readonly invocationOverrides?: ProfileInvocationOverrides },
  ) => Promise<ProfileChain> | ProfileChain;
  readonly witnessOf?: WitnessClassifier;
  readonly pollMilliseconds?: number;
  readonly sessionLeaseTtlMs?: number;
  readonly dispatchTtlMs?: number;
}

export interface NativeBridgeService {
  hasNativeStage(runId: string): boolean;
  status(runId: string): ReturnType<typeof nativeStatus>;
  start(input: StartNativeStageInput): Promise<{
    readonly runId: string;
    readonly stageId: string;
    readonly status: string;
  }>;
  attach(
    input: Omit<AttachParentSessionInput, "witnessOf" | "leaseTtlMs">,
  ): ReturnType<typeof attachParentSession>;
  detach(
    input: Omit<DetachParentSessionInput, "witnessOf">,
  ): ReturnType<typeof detachParentSession>;
  poll(input: {
    readonly sessionId: string;
    readonly sessionRevision: number;
    readonly codebaseId: string;
    readonly maxDispatches: number;
  }): Promise<
    ReturnType<typeof pollNativeBridge> & {
      readonly workingDirectories: ReadonlyMap<string, string>;
    }
  >;
  question(
    input: Omit<RaiseNativeQuestionInput, "witnessOf">,
  ): ReturnType<typeof raiseNativeQuestion>;
  answer(input: AnswerNativeQuestionInput): ReturnType<typeof answerNativeQuestion>;
  submit(input: SubmitNativeDispatchInput): Promise<SubmitNativeDispatchOutcome>;
  cancel(runId: string): ReturnType<typeof cancelNativeStage>;
  resume(runId: string, expectedRunRevision: number): ReturnType<typeof resumeNativeStage>;
  reconcile(): void;
  stop(): void;
}

const execFileAsync = promisify(execFile);

/** Mirrors `scheduling-service.ts`'s own `repositoryHead` byte-for-byte — too small to be worth sharing across a package boundary neither service otherwise has. */
async function repositoryHead(repositoryPath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repositoryPath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  const sha = stdout.trim();
  if (!/^[a-f0-9]{40}$/iu.test(sha)) throw new Error("repository HEAD is not a full commit SHA");
  return sha;
}

function safeArtifactPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split(/[\\/]/u).some((segment) => segment === ".." || segment === "")
  );
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

function nativeStatus(db: StateDatabase, runId: string) {
  const stage = readNativeStage(db, runId);
  if (stage === undefined) return undefined;
  return {
    stage,
    attempts: readNativeStageAttempts(db, runId),
    interactions: readPendingNativeQuestions(db, runId),
  };
}

export function createNativeBridgeService(
  options: NativeBridgeServiceOptions,
): NativeBridgeService {
  const owner = {
    ownerId: options.instanceId,
    bootWitness: `daemon:${options.instanceId}`,
    processWitnesses: [] as const,
  };
  const witnessOf = options.witnessOf ?? UNPROVABLE_LIVENESS_WITNESS;
  const sessionLeaseTtlMs = options.sessionLeaseTtlMs;
  const dispatchTtlMs = options.dispatchTtlMs;
  const artifactStore = createArtifactStore({
    root: options.artifactsDirectory,
    clock: options.clock,
    ids: options.ids,
  });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedulePoll(): void {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      reconcile();
      schedulePoll();
    }, options.pollMilliseconds ?? 5_000);
    timer.unref?.();
  }

  function reconcile(): void {
    reapAllExpiredParentSessions(options.db, witnessOf);
  }

  async function provisionClaimedDispatch(
    codebaseId: string,
    claim: ClaimedNativeStage,
  ): Promise<string | undefined> {
    const workspaceId = options.ids.next("workspace");
    const registered = findRegisteredExecutionContextForRepository(options.db, claim.repositoryId);
    try {
      const manifest = await options.workspaceService.provision({
        workspaceId: workspaceId as never,
        codebaseId: codebaseId as never,
        repositoryId: claim.repositoryId as never,
        integrationBranch: `heniek-${claim.runId}-native-${claim.attemptOrdinal}`,
        owner,
        configuration: workspaceConfiguration(registered.defaultRemote, registered.defaultBranch),
      });
      if (manifest.lifecycle !== "ready") throw new Error("managed workspace provisioning failed");
      await validateExecutionWorkspace({
        assignedWorktree: manifest.checkoutPath,
        workingDirectory: manifest.checkoutPath,
        artifactPaths: [claim.artifactPath],
      });
      assignNativeAttemptWorkspace(options.db, { attemptId: claim.attemptId, workspaceId });
      const permissions = JSON.parse(claim.permissionsJson) as { workspace?: string };
      if (permissions.workspace === "read-only") {
        const baseline = await captureWorkspaceGitState(manifest.checkoutPath);
        recordNativeAttemptReadonlyBaseline(options.db, {
          attemptId: claim.attemptId,
          baseline: baseline as never,
        });
      }
      return manifest.checkoutPath;
    } catch {
      recordNativeAttemptWorkspaceFailure(options.db, {
        attemptId: claim.attemptId,
        runId: claim.runId,
        stageId: claim.stageId,
        dispatchId: claim.dispatchId,
        reasonCode: "native_workspace_provisioning_failed",
      });
      return undefined;
    }
  }

  // Starts the background reap sweep immediately — there is no daemon
  // -initiated dispatch loop to piggyback on (poll is entirely client
  // -driven), so this is the only way a codebase nobody calls back into
  // still eventually surfaces as recovery_required.
  schedulePoll();

  return {
    hasNativeStage: (runId) => readNativeStage(options.db, runId) !== undefined,
    status: (runId) => nativeStatus(options.db, runId),

    async start(input) {
      if (!safeArtifactPath(input.artifactPath)) throw new Error("artifact path must be safe");
      const context = findRegisteredExecutionContext(options.db, input.currentDirectory);
      if (context === undefined) throw new Error("current directory is not registered");
      const chain = await options.resolveProfileChain(input.profileId, {
        ...(input.invocationOverrides === undefined
          ? {}
          : { invocationOverrides: input.invocationOverrides }),
      });
      if (chain.primary.executionMode !== "native") {
        throw new Error("profile is not configured for native execution");
      }
      if (chain.fallbacks.length > 0) {
        throw new Error("native-fallback-unsupported");
      }
      const requested = input.requestedIdentifiers ?? [];
      const permissionResult = resolveAttemptPermissions(chain.primary, chain.primary, requested);
      if (!permissionResult.ok) throw new Error("primary profile denies requested permissions");
      const baseSha = await repositoryHead(context.repositoryPath);
      const now = options.clock.nowIso();
      const hardDeadlineAt =
        input.limits?.maxDurationMs === undefined
          ? undefined
          : new Date(Date.parse(now) + input.limits.maxDurationMs).toISOString();
      const runId = options.ids.next("run");
      const stageId = options.ids.next("stage");
      const limits = resolveAttemptLimits({
        stage: input.limits ?? {},
        invocation: input.limits ?? {},
        ...(chain.primary.maxDurationMs === undefined
          ? {}
          : { profileMaxDurationMs: chain.primary.maxDurationMs }),
        ...(hardDeadlineAt === undefined ? {} : { hardDeadlineAt }),
        now,
      });
      createNativeStage(options.db, {
        runId,
        stageId,
        codebaseId: context.codebaseId,
        repositoryId: context.repositoryId,
        profileId: chain.primary.profileId,
        profile: chain.primary as never,
        permissions: permissionResult.permissions as never,
        limits: limits as never,
        prompt: input.prompt,
        artifactPath: input.artifactPath,
        instructionsPath: chain.primary.instructionsPath,
        artifactContract: chain.primary.artifactContract,
        model: chain.primary.model,
        effort: chain.primary.effort,
        ...(chain.primary.focus === undefined ? {} : { focus: chain.primary.focus }),
        questions: chain.primary.questions,
        baseSha,
        ...(hardDeadlineAt === undefined ? {} : { hardDeadlineAt }),
      });
      const projection = readRunProjection(options.db, runId);
      return { runId, stageId, status: projection?.status ?? "waiting_for_parent_session" };
    },

    attach: (input) =>
      attachParentSession(options.db, {
        ...input,
        ...(sessionLeaseTtlMs === undefined ? {} : { leaseTtlMs: sessionLeaseTtlMs }),
        witnessOf,
      }),

    detach: (input) => detachParentSession(options.db, { ...input, witnessOf }),

    async poll(input) {
      const outcome = pollNativeBridge(options.db, {
        ...input,
        ...(sessionLeaseTtlMs === undefined ? {} : { leaseTtlMs: sessionLeaseTtlMs }),
        ...(dispatchTtlMs === undefined ? {} : { dispatchTtlMs }),
        witnessOf,
      });
      const workingDirectories = new Map<string, string>();
      if (outcome.accepted) {
        for (const claim of outcome.claimed) {
          const checkoutPath = await provisionClaimedDispatch(input.codebaseId, claim);
          if (checkoutPath !== undefined) workingDirectories.set(claim.dispatchId, checkoutPath);
        }
      }
      return { ...outcome, workingDirectories };
    },

    question: (input) => raiseNativeQuestion(options.db, { ...input, witnessOf }),

    answer: (input) => answerNativeQuestion(options.db, input),

    async submit(input) {
      if (input.outcome !== "succeeded") {
        return settleNativeDispatch(options.db, { ...input, witnessOf });
      }
      const declaredArtifactPath = input.declaredArtifactPath ?? "";
      if (!safeArtifactPath(declaredArtifactPath)) {
        return { accepted: false, rejectionCode: "result_contract_violation" };
      }
      const attempts = readNativeStageAttempts(options.db, input.runId);
      const attempt = attempts.find((candidate) => candidate.attemptId === input.attemptId);
      if (attempt?.workspaceId === undefined || attempt.workspaceId === null) {
        return { accepted: false, rejectionCode: "artifact_missing" };
      }
      const workspace = readIdentity(options.db, "workspace", attempt.workspaceId);
      const checkoutPath = workspace?.checkoutPath;
      if (checkoutPath === null || checkoutPath === undefined) {
        return { accepted: false, rejectionCode: "artifact_missing" };
      }
      if (attempt.readonlyBaselineJson !== null) {
        try {
          const baseline = JSON.parse(attempt.readonlyBaselineJson) as Parameters<
            typeof assertReadonlyWorkspaceUnchanged
          >[0];
          assertReadonlyWorkspaceUnchanged(baseline, await captureWorkspaceGitState(checkoutPath));
        } catch {
          return { accepted: false, rejectionCode: "workspace_mutated" };
        }
      }
      let bytes: Uint8Array;
      try {
        bytes = await readFile(join(checkoutPath, declaredArtifactPath));
      } catch {
        return { accepted: false, rejectionCode: "artifact_missing" };
      }

      // Nothing awaits between this point and the fencing CAS below — see
      // this file's own header for why that ordering matters.
      const settled = settleNativeDispatch(options.db, { ...input, witnessOf });
      if (!settled.accepted) return settled;
      if (settled.idempotentReplay || !settled.requiresArtifactCompletion) {
        return {
          accepted: true,
          idempotentReplay: settled.idempotentReplay,
          status: settled.status,
        };
      }

      try {
        finalizeStageArtifact(options.db, artifactStore, {
          runId: input.runId,
          stageId: input.stageId,
          summary: input.declaredSummary ?? "",
          artifactPath: declaredArtifactPath,
          bytes,
          mediaType: "application/octet-stream",
          producer: "parent-session-bridge",
          sourceLineage: [input.dispatchId],
        });
        completeNativeAttemptArtifactOutcome(options.db, {
          attemptId: input.attemptId,
          runId: input.runId,
        });
        return { accepted: true, idempotentReplay: false, status: "succeeded" };
      } catch (error) {
        downgradeNativeAttemptToFailed(options.db, {
          attemptId: input.attemptId,
          runId: input.runId,
          reasonCode:
            error instanceof StageResultContractError
              ? "declared_artifact_invalid"
              : "artifact_completion_failed",
          message:
            error instanceof Error ? error.message : "Native stage artifact completion failed.",
        });
        return { accepted: true, idempotentReplay: false, status: "failed" };
      }
    },

    cancel: (runId) => cancelNativeStage(options.db, runId),
    resume: (runId, expectedRunRevision) =>
      resumeNativeStage(options.db, { runId, expectedRunRevision }),

    reconcile,
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/**
 * Mirrors `scheduling-service.ts`'s own private helper of the same name and
 * shape — duplicated rather than exported across the package for the same
 * reason `repositoryHead` is: it is eight lines, and neither service should
 * depend on the other's internals.
 */
function findRegisteredExecutionContextForRepository(
  db: StateDatabase,
  repositoryId: string,
): { readonly defaultRemote: string; readonly defaultBranch: string } {
  const repository = readIdentity(db, "repository", repositoryId);
  if (
    repository?.defaultRemote === null ||
    repository?.defaultRemote === undefined ||
    repository.defaultBranch === null
  ) {
    throw new Error("registered repository context is unavailable");
  }
  return { defaultRemote: repository.defaultRemote, defaultBranch: repository.defaultBranch };
}
