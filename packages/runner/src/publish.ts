/**
 * Publish stage runner — ForgeBackend publication with adopt/reconcile.
 */

import type {
  ForgeBackendV2,
  PublishResultV1,
  PullRequestId,
  PullRequestV1,
} from "@heniek/contracts";
import type { Static } from "@sinclair/typebox";
import { bump, notifyStore, systemClock } from "./attempt.js";
import { asAttemptId } from "./brands.js";
import { redactFailureMessage } from "./redact.js";
import type {
  PublishRequest,
  PublishStageRunnerDeps,
  StageRunner,
  StageRunnerAttemptSnapshot,
  StageRunnerCleanupReport,
  StageRunnerFinalizeOutcome,
  StageRunnerObserveOutcome,
  StageRunnerPrepareInput,
  StageRunnerPrepareOutcome,
  StageRunnerResult,
  StageRunnerValidationReport,
} from "./types.js";
import { validateStageCompletion } from "./validate.js";

type PullRequest = Static<typeof PullRequestV1>;

interface PublishAttemptState {
  readonly snapshot: StageRunnerAttemptSnapshot;
  readonly request: PublishRequest;
  readonly writes: readonly string[];
  readonly requirements: NonNullable<StageRunnerPrepareInput["stage"]["completion"]>["require"];
  started: boolean;
  work?: Promise<void>;
  publishResult?: PublishResultV1;
  timedOut: boolean;
  cancelled: boolean;
  cleanup?: StageRunnerCleanupReport;
  validation?: StageRunnerValidationReport;
}

function emptyCleanup(attemptId: string, nowIso: string): StageRunnerCleanupReport {
  return {
    schemaVersion: 1,
    attemptId: asAttemptId(attemptId),
    signalSequence: [],
    descendantsRemaining: 0,
    gracePeriodMs: 0,
    cleaned: true,
    recordedAt: nowIso,
    detail: "publish stage has no process group",
  };
}

function prFields(
  pr: PullRequest,
): Pick<PublishResultV1, "pullRequestId" | "number" | "url" | "headSha" | "draft"> {
  return {
    pullRequestId: pr.pullRequestId,
    number: pr.number,
    url: pr.url,
    headSha: pr.headSha,
    draft: pr.draft,
  };
}

async function afterAdoptOrCreate(
  forge: ForgeBackendV2,
  request: PublishRequest,
  pr: PullRequest,
  outcome: "created" | "adopted",
  nowIso: string,
): Promise<PublishResultV1> {
  let current = pr;
  let autoMergeEnabled = false;
  const spec = request.pullRequest;

  if (spec.markReady && current.draft) {
    await forge.markReady(current.pullRequestId as PullRequestId);
    current = { ...current, draft: false };
  }
  if (spec.enableAutoMerge) {
    await forge.enableAutoMerge(current.pullRequestId as PullRequestId);
    autoMergeEnabled = true;
  }

  return {
    schemaVersion: 1,
    publicationKey: request.publicationKey,
    outcome,
    ...prFields(current),
    autoMergeEnabled,
    finishedAt: nowIso,
  };
}

export function createPublishStageRunner(deps: PublishStageRunnerDeps): StageRunner {
  const clock = deps.clock ?? systemClock;
  const attempts = new Map<string, PublishAttemptState>();

  function requireAttempt(attemptId: string): PublishAttemptState {
    const state = attempts.get(attemptId);
    if (state === undefined) {
      throw new Error(`unknown publish attempt: ${attemptId}`);
    }
    return state;
  }

  async function runPublish(state: PublishAttemptState): Promise<void> {
    const request = state.request;
    const spec = request.pullRequest;

    if (state.cancelled) {
      state.publishResult = {
        schemaVersion: 1,
        publicationKey: request.publicationKey,
        outcome: "cancelled",
        finishedAt: clock.nowIso(),
        detail: "cancelled before forge side effects",
      };
      return;
    }

    try {
      const existing = await deps.forge.findPullRequests(
        spec.repositoryId,
        spec.sourceBranch,
        spec.targetBranch,
      );

      if (state.cancelled) {
        state.publishResult = {
          schemaVersion: 1,
          publicationKey: request.publicationKey,
          outcome: "cancelled",
          finishedAt: clock.nowIso(),
          detail: "cancelled after forge discovery",
        };
        return;
      }

      if (existing.length > 1) {
        state.publishResult = {
          schemaVersion: 1,
          publicationKey: request.publicationKey,
          outcome: "ambiguous",
          finishedAt: clock.nowIso(),
          detail: `found ${existing.length} pull requests for ${spec.sourceBranch} → ${spec.targetBranch}`,
        };
        state.snapshot.recovery = "reconcile_forge";
        return;
      }

      if (existing.length === 1) {
        const match = existing[0]!;
        if (match.headSha !== spec.expectedHeadSha) {
          state.publishResult = {
            schemaVersion: 1,
            publicationKey: request.publicationKey,
            outcome: "mismatched_head",
            ...prFields(match),
            finishedAt: clock.nowIso(),
            detail: `existing head ${match.headSha} != expected ${spec.expectedHeadSha}`,
          };
          state.snapshot.recovery = "reconcile_forge";
          return;
        }
        state.publishResult = await afterAdoptOrCreate(
          deps.forge,
          request,
          match,
          "adopted",
          clock.nowIso(),
        );
        return;
      }

      const created = await deps.forge.createPullRequest({
        schemaVersion: 1,
        repositoryId: spec.repositoryId,
        sourceBranch: spec.sourceBranch,
        targetBranch: spec.targetBranch,
        title: spec.title,
        body: spec.body,
        draft: spec.draft,
      });

      if (state.cancelled) {
        state.publishResult = {
          schemaVersion: 1,
          publicationKey: request.publicationKey,
          outcome: "cancelled",
          ...prFields(created),
          finishedAt: clock.nowIso(),
          detail: "cancelled after createPullRequest",
        };
        return;
      }

      state.publishResult = await afterAdoptOrCreate(
        deps.forge,
        request,
        created,
        "created",
        clock.nowIso(),
      );
    } catch (error) {
      state.publishResult = {
        schemaVersion: 1,
        publicationKey: request.publicationKey,
        outcome: "forge_failed",
        finishedAt: clock.nowIso(),
        detail: redactFailureMessage(error instanceof Error ? error.message : "forge call failed"),
      };
      state.snapshot.recovery = "reconcile_forge";
    }
  }

  async function validateAttempt(attemptId: string): Promise<StageRunnerValidationReport> {
    const state = requireAttempt(attemptId);
    state.snapshot.phase = "validate";
    const report = validateStageCompletion({
      attemptId,
      writes: state.writes,
      requirements: state.requirements,
      outputs: state.snapshot.outputs,
      evidence: state.snapshot.evidence,
      resultEnvelope: state.snapshot.resultEnvelope,
      exitCode: undefined,
      recordedAt: clock.nowIso(),
    });
    state.validation = report;
    state.snapshot.validation = report;
    bump(state.snapshot, clock);
    await notifyStore(deps.store, state.snapshot);
    await deps.store?.onValidation?.(report);
    return report;
  }

  return {
    async prepare(input: StageRunnerPrepareInput): Promise<StageRunnerPrepareOutcome> {
      if (input.stage.type !== "publish") {
        throw new Error("createPublishStageRunner only accepts publish stages");
      }
      const request = input.publishRequest;
      if (request === undefined) {
        throw new Error("publish stage requires publishRequest");
      }

      const now = clock.nowIso();
      let deadlineAt = input.deadlineAt;
      const maxDurationMs = input.stage.limits?.maxDurationMs;
      if (maxDurationMs !== undefined) {
        const fromLimits = new Date(Date.parse(now) + maxDurationMs).toISOString();
        if (deadlineAt === undefined || fromLimits < deadlineAt) deadlineAt = fromLimits;
      }

      const snapshot: StageRunnerAttemptSnapshot = {
        attemptId: input.attemptId,
        runId: input.runId,
        stageId: input.stageId,
        stageType: "publish",
        intentId: input.intentId,
        graphRevision: input.graphRevision,
        generation: input.generation,
        attemptOrdinal: input.attemptOrdinal,
        phase: "prepare",
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
        ...(input.checkoutPath === undefined ? {} : { checkoutPath: input.checkoutPath }),
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        runtimeDirectory: input.runtimeDirectory,
        preparedAt: now,
        outputs: [],
        evidence: [],
        recovery: "none",
        revision: 1,
        updatedAt: now,
        createdAt: now,
      };

      attempts.set(input.attemptId, {
        snapshot,
        request,
        writes: [...input.stage.writes],
        requirements: input.stage.completion?.require ?? [],
        started: false,
        timedOut: false,
        cancelled: false,
      });
      await notifyStore(deps.store, snapshot);

      return {
        attemptId: input.attemptId,
        preparedAt: now,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        ...(input.checkoutPath === undefined ? {} : { checkoutPath: input.checkoutPath }),
        runtimeDirectory: input.runtimeDirectory,
      };
    },

    async start(attemptId: string): Promise<void> {
      const state = requireAttempt(attemptId);
      // Replay: if a prior collect already recorded a publish result, do not call forge again.
      if (state.publishResult !== undefined) {
        state.started = true;
        state.snapshot.phase = "observe";
        state.snapshot.startedAt = clock.nowIso();
        bump(state.snapshot, clock);
        await notifyStore(deps.store, state.snapshot);
        return;
      }

      state.started = true;
      state.snapshot.phase = "start";
      state.snapshot.startedAt = clock.nowIso();
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);

      state.work = runPublish(state);
      state.snapshot.phase = "observe";
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
    },

    async observe(attemptId: string): Promise<StageRunnerObserveOutcome> {
      const state = requireAttempt(attemptId);
      state.snapshot.phase = "observe";
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);

      if (state.snapshot.result !== undefined) {
        const outcome = state.snapshot.result.outcome;
        if (outcome === "succeeded") return { status: "terminal", backendStatus: "succeeded" };
        if (outcome === "cancelled") return { status: "terminal", backendStatus: "cancelled" };
        return { status: "terminal", backendStatus: "failed" };
      }

      if (state.work !== undefined) {
        const raced = await Promise.race([
          state.work.then(() => "done" as const),
          new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0)),
        ]);
        if (raced === "pending" && state.publishResult === undefined) {
          const deadlineAt = state.snapshot.deadlineAt;
          if (!state.timedOut && deadlineAt !== undefined && clock.nowIso() >= deadlineAt) {
            state.timedOut = true;
            state.cancelled = true;
            const cleanup = emptyCleanup(attemptId, clock.nowIso());
            state.cleanup = cleanup;
            state.snapshot.cleanup = cleanup;
            bump(state.snapshot, clock);
            await notifyStore(deps.store, state.snapshot);
            await deps.store?.onCleanup?.(cleanup);
            return { status: "timed_out", cleanup };
          }
          return { status: "running" };
        }
        await state.work.catch(() => undefined);
      }

      if (state.publishResult !== undefined) {
        const outcome = state.publishResult.outcome;
        if (outcome === "created" || outcome === "adopted") {
          return { status: "terminal", backendStatus: "succeeded" };
        }
        if (outcome === "cancelled") {
          return { status: "terminal", backendStatus: "cancelled" };
        }
        return { status: "terminal", backendStatus: "failed" };
      }

      return { status: "running" };
    },

    async cancel(attemptId: string): Promise<StageRunnerCleanupReport> {
      const state = requireAttempt(attemptId);
      state.cancelled = true;
      state.snapshot.phase = "cancel";
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
      if (state.work !== undefined) {
        await state.work.catch(() => undefined);
      }
      const report = emptyCleanup(attemptId, clock.nowIso());
      state.cleanup = report;
      state.snapshot.cleanup = report;
      await deps.store?.onCleanup?.(report);
      return report;
    },

    async collect(attemptId: string): Promise<void> {
      const state = requireAttempt(attemptId);
      state.snapshot.phase = "collect";
      if (state.work !== undefined) {
        await state.work.catch(() => undefined);
      }
      const now = clock.nowIso();
      const result = state.publishResult;
      const evidence = [...state.snapshot.evidence];
      const outputs = [...state.snapshot.outputs];

      if (result !== undefined) {
        const success = result.outcome === "created" || result.outcome === "adopted";
        evidence.push({
          schemaVersion: 1,
          kind: "verdict",
          satisfied: success,
          recordedAt: now,
          requirement: "publish",
          detail: result.outcome,
          payload: result,
        });
        outputs.push({
          schemaVersion: 1,
          reference: "publish.result",
          kind: "value",
          value: result,
        });
      }

      state.snapshot.evidence = evidence;
      state.snapshot.outputs = outputs;
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
    },

    async validate(attemptId: string): Promise<StageRunnerValidationReport> {
      return validateAttempt(attemptId);
    },

    async finalize(attemptId: string): Promise<StageRunnerFinalizeOutcome> {
      const state = requireAttempt(attemptId);
      state.snapshot.phase = "finalize";
      const validation = state.validation ?? (await validateAttempt(attemptId));
      const finishedAt = clock.nowIso();
      const result = state.publishResult;
      const successOutcome = result?.outcome === "created" || result?.outcome === "adopted";
      const succeeded = successOutcome && !state.cancelled && !state.timedOut && validation.valid;

      if (succeeded) {
        const terminal = {
          schemaVersion: 2 as const,
          attemptId: asAttemptId(attemptId),
          outcome: "succeeded" as const,
          outputs: state.snapshot.outputs,
          evidence: state.snapshot.evidence,
          finishedAt,
          summary: `publish:${result!.outcome}:${result!.pullRequestId ?? ""}`,
        } as StageRunnerResult;
        state.snapshot.phase = "succeeded";
        state.snapshot.result = terminal;
        state.snapshot.finishedAt = finishedAt;
        bump(state.snapshot, clock);
        await notifyStore(deps.store, state.snapshot);
        return {
          result: terminal,
          validation,
          ...(state.cleanup === undefined ? {} : { cleanup: state.cleanup }),
        };
      }

      const classification = state.cancelled
        ? ("cancelled" as const)
        : state.timedOut
          ? ("timeout" as const)
          : result?.outcome === "forge_failed"
            ? ("forge_failed" as const)
            : result?.outcome === "mismatched_head" || result?.outcome === "ambiguous"
              ? ("reconciliation_required" as const)
              : ("operation_failed" as const);

      const failure = {
        schemaVersion: 2 as const,
        classification,
        phase: "finalize" as const,
        code: result?.outcome ?? classification,
        message: redactFailureMessage(
          result?.detail ?? validation.detail ?? "publish stage failed",
        ),
        retryable: classification === "timeout" || classification === "forge_failed",
        recovery:
          classification === "reconciliation_required" || classification === "forge_failed"
            ? ("reconcile_forge" as const)
            : state.snapshot.recovery,
      };

      const outcome = state.cancelled
        ? ("cancelled" as const)
        : classification === "reconciliation_required"
          ? ("recovery_required" as const)
          : ("failed" as const);

      const terminal = {
        schemaVersion: 2 as const,
        attemptId: asAttemptId(attemptId),
        outcome,
        outputs: state.snapshot.outputs,
        evidence: state.snapshot.evidence,
        failure,
        finishedAt,
      } as StageRunnerResult;

      state.snapshot.phase =
        outcome === "cancelled"
          ? "cancelled"
          : outcome === "recovery_required"
            ? "recovery_required"
            : "failed";
      state.snapshot.result = terminal;
      state.snapshot.failure = failure;
      state.snapshot.finishedAt = finishedAt;
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
      return {
        result: terminal,
        validation,
        ...(state.cleanup === undefined ? {} : { cleanup: state.cleanup }),
      };
    },
  };
}
