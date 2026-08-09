/**
 * Integration stage runner — expected-SHA merge into one repository ref.
 */

import type { IntegrationResultV1 } from "@heniek/contracts";
import { bump, notifyStore, systemClock } from "./attempt.js";
import { asAttemptId } from "./brands.js";
import { redactFailureMessage } from "./redact.js";
import type {
  IntegrationRequest,
  IntegrationStageRunnerDeps,
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

interface IntegrationAttemptState {
  readonly snapshot: StageRunnerAttemptSnapshot;
  readonly request: IntegrationRequest;
  readonly checkoutPath: string;
  readonly writes: readonly string[];
  readonly requirements: NonNullable<StageRunnerPrepareInput["stage"]["completion"]>["require"];
  started: boolean;
  work?: Promise<void>;
  integrationResult?: IntegrationResultV1;
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
    detail: "integration stage has no process group",
  };
}

function failureClassFor(
  classification: IntegrationResultV1["classification"],
): "stale_sha" | "merge_conflict" | "operation_failed" | "cancelled" {
  switch (classification) {
    case "stale_source":
    case "stale_target":
      return "stale_sha";
    case "merge_conflict":
      return "merge_conflict";
    case "already_applied":
    case "none":
      return "operation_failed";
    case "irreconcilable_external":
      return "operation_failed";
    default:
      return "operation_failed";
  }
}

export function createIntegrationStageRunner(deps: IntegrationStageRunnerDeps): StageRunner {
  const clock = deps.clock ?? systemClock;
  const attempts = new Map<string, IntegrationAttemptState>();

  function requireAttempt(attemptId: string): IntegrationAttemptState {
    const state = attempts.get(attemptId);
    if (state === undefined) {
      throw new Error(`unknown integration attempt: ${attemptId}`);
    }
    return state;
  }

  async function runIntegration(state: IntegrationAttemptState): Promise<void> {
    const now = clock.nowIso();
    const request = state.request;

    if (state.cancelled) {
      state.integrationResult = {
        schemaVersion: 1,
        repositoryId: request.repositoryId,
        sourceRef: request.sourceRef,
        targetRef: request.targetRef,
        expectedSourceSha: request.expectedSourceSha,
        expectedTargetSha: request.expectedTargetSha,
        classification: "irreconcilable_external",
        targetMoved: false,
        finishedAt: now,
        detail: "cancelled before integration side effects",
      };
      return;
    }

    let sourceSha: string;
    let targetSha: string;
    try {
      sourceSha = await deps.git.readRefSha(state.checkoutPath, request.sourceRef);
      targetSha = await deps.git.readRefSha(state.checkoutPath, request.targetRef);
    } catch (error) {
      state.integrationResult = {
        schemaVersion: 1,
        repositoryId: request.repositoryId,
        sourceRef: request.sourceRef,
        targetRef: request.targetRef,
        expectedSourceSha: request.expectedSourceSha,
        expectedTargetSha: request.expectedTargetSha,
        classification: "irreconcilable_external",
        targetMoved: false,
        finishedAt: clock.nowIso(),
        detail: redactFailureMessage(error instanceof Error ? error.message : "git read failed"),
      };
      return;
    }

    if (sourceSha !== request.expectedSourceSha) {
      state.integrationResult = {
        schemaVersion: 1,
        repositoryId: request.repositoryId,
        sourceRef: request.sourceRef,
        targetRef: request.targetRef,
        expectedSourceSha: request.expectedSourceSha,
        expectedTargetSha: request.expectedTargetSha,
        classification: "stale_source",
        targetMoved: false,
        finishedAt: clock.nowIso(),
        detail: `source sha ${sourceSha} != expected ${request.expectedSourceSha}`,
      };
      return;
    }

    if (targetSha !== request.expectedTargetSha) {
      state.integrationResult = {
        schemaVersion: 1,
        repositoryId: request.repositoryId,
        sourceRef: request.sourceRef,
        targetRef: request.targetRef,
        expectedSourceSha: request.expectedSourceSha,
        expectedTargetSha: request.expectedTargetSha,
        classification: "stale_target",
        targetMoved: false,
        finishedAt: clock.nowIso(),
        detail: `target sha ${targetSha} != expected ${request.expectedTargetSha}`,
      };
      return;
    }

    if (state.cancelled) {
      state.integrationResult = {
        schemaVersion: 1,
        repositoryId: request.repositoryId,
        sourceRef: request.sourceRef,
        targetRef: request.targetRef,
        expectedSourceSha: request.expectedSourceSha,
        expectedTargetSha: request.expectedTargetSha,
        classification: "irreconcilable_external",
        targetMoved: false,
        finishedAt: clock.nowIso(),
        detail: "cancelled before merge preparation",
      };
      return;
    }

    const prepared = await deps.git.prepareMergeCandidate({
      checkoutPath: state.checkoutPath,
      sourceSha: request.expectedSourceSha,
      targetSha: request.expectedTargetSha,
      ...(request.message === undefined ? {} : { message: request.message }),
    });

    if (prepared.status === "conflict") {
      state.integrationResult = {
        schemaVersion: 1,
        repositoryId: request.repositoryId,
        sourceRef: request.sourceRef,
        targetRef: request.targetRef,
        expectedSourceSha: request.expectedSourceSha,
        expectedTargetSha: request.expectedTargetSha,
        classification: "merge_conflict",
        targetMoved: false,
        finishedAt: clock.nowIso(),
        detail: prepared.detail.slice(0, 1024),
      };
      return;
    }

    if (prepared.status === "already_applied") {
      state.integrationResult = {
        schemaVersion: 1,
        repositoryId: request.repositoryId,
        sourceRef: request.sourceRef,
        targetRef: request.targetRef,
        expectedSourceSha: request.expectedSourceSha,
        expectedTargetSha: request.expectedTargetSha,
        candidateSha: prepared.candidateSha,
        resultSha: prepared.candidateSha,
        classification: "already_applied",
        targetMoved: false,
        finishedAt: clock.nowIso(),
      };
      return;
    }

    if (state.cancelled) {
      state.integrationResult = {
        schemaVersion: 1,
        repositoryId: request.repositoryId,
        sourceRef: request.sourceRef,
        targetRef: request.targetRef,
        expectedSourceSha: request.expectedSourceSha,
        expectedTargetSha: request.expectedTargetSha,
        candidateSha: prepared.candidateSha,
        classification: "irreconcilable_external",
        targetMoved: false,
        finishedAt: clock.nowIso(),
        detail: "cancelled before ref update",
      };
      return;
    }

    const swapped = await deps.git.updateRefCompareAndSwap({
      checkoutPath: state.checkoutPath,
      ref: request.targetRef,
      expectedSha: request.expectedTargetSha,
      newSha: prepared.candidateSha,
    });

    if (swapped.status === "stale") {
      state.integrationResult = {
        schemaVersion: 1,
        repositoryId: request.repositoryId,
        sourceRef: request.sourceRef,
        targetRef: request.targetRef,
        expectedSourceSha: request.expectedSourceSha,
        expectedTargetSha: request.expectedTargetSha,
        candidateSha: prepared.candidateSha,
        classification: "stale_target",
        targetMoved: false,
        finishedAt: clock.nowIso(),
        detail: `target moved to ${swapped.actualSha} before update-ref`,
      };
      return;
    }

    state.integrationResult = {
      schemaVersion: 1,
      repositoryId: request.repositoryId,
      sourceRef: request.sourceRef,
      targetRef: request.targetRef,
      expectedSourceSha: request.expectedSourceSha,
      expectedTargetSha: request.expectedTargetSha,
      candidateSha: prepared.candidateSha,
      resultSha: prepared.candidateSha,
      classification: "none",
      targetMoved: true,
      finishedAt: clock.nowIso(),
    };
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
      if (input.stage.type !== "integration") {
        throw new Error("createIntegrationStageRunner only accepts integration stages");
      }
      const request = input.integrationRequest;
      if (request === undefined) {
        throw new Error("integration stage requires integrationRequest");
      }
      if (input.checkoutPath === undefined) {
        throw new Error("integration stage requires checkoutPath");
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
        stageType: "integration",
        intentId: input.intentId,
        graphRevision: input.graphRevision,
        generation: input.generation,
        attemptOrdinal: input.attemptOrdinal,
        phase: "prepare",
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
        checkoutPath: input.checkoutPath,
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
        checkoutPath: input.checkoutPath,
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
        checkoutPath: input.checkoutPath,
        runtimeDirectory: input.runtimeDirectory,
      };
    },

    async start(attemptId: string): Promise<void> {
      const state = requireAttempt(attemptId);
      state.started = true;
      state.snapshot.phase = "start";
      state.snapshot.startedAt = clock.nowIso();
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);

      state.work = runIntegration(state).finally(async () => {
        state.snapshot.phase = "observe";
        bump(state.snapshot, clock);
        await notifyStore(deps.store, state.snapshot);
      });

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
        await Promise.race([
          state.work,
          new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
          }),
        ]);
      }

      if (state.integrationResult !== undefined) {
        const result = state.integrationResult;
        const success =
          (result.classification === "none" || result.classification === "already_applied") &&
          !state.cancelled;
        return {
          status: "terminal",
          backendStatus: state.cancelled ? "cancelled" : success ? "succeeded" : "failed",
        };
      }

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
      const result = state.integrationResult;
      const evidence = [...state.snapshot.evidence];
      const outputs = [...state.snapshot.outputs];

      if (result !== undefined) {
        const success =
          result.classification === "none" || result.classification === "already_applied";
        evidence.push({
          schemaVersion: 1,
          kind: "repository_state",
          satisfied: success && !state.cancelled,
          recordedAt: now,
          requirement: "integration",
          detail: result.classification,
          payload: result,
        });
        outputs.push({
          schemaVersion: 1,
          reference: "integration.result",
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
      const result = state.integrationResult;
      const successClassification =
        result !== undefined &&
        (result.classification === "none" || result.classification === "already_applied");
      const succeeded =
        successClassification && !state.cancelled && !state.timedOut && validation.valid;

      if (succeeded) {
        const terminal = {
          schemaVersion: 2 as const,
          attemptId: asAttemptId(attemptId),
          outcome: "succeeded" as const,
          outputs: state.snapshot.outputs,
          evidence: state.snapshot.evidence,
          finishedAt,
          summary: `integration:${result!.classification}:${result!.resultSha ?? result!.candidateSha ?? ""}`,
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
          : result !== undefined
            ? failureClassFor(result.classification)
            : ("operation_failed" as const);

      const failure = {
        schemaVersion: 2 as const,
        classification,
        phase: "finalize" as const,
        code: result?.classification ?? classification,
        message: redactFailureMessage(
          result?.detail ?? validation.detail ?? "integration stage failed",
        ),
        retryable: classification === "stale_sha" || classification === "timeout",
        recovery:
          classification === "stale_sha" || classification === "merge_conflict"
            ? ("reconcile_git" as const)
            : state.snapshot.recovery,
      };

      const outcome = state.cancelled ? ("cancelled" as const) : ("failed" as const);
      const terminal = {
        schemaVersion: 2 as const,
        attemptId: asAttemptId(attemptId),
        outcome,
        outputs: state.snapshot.outputs,
        evidence: state.snapshot.evidence,
        failure,
        finishedAt,
      } as StageRunnerResult;

      state.snapshot.phase = outcome === "cancelled" ? "cancelled" : "failed";
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
