/**
 * Approval stage runner — durable HITL gate; never auto-answers.
 */

import type { ApprovalDecisionV1 } from "@heniek/contracts";
import { bump, notifyStore, systemClock } from "./attempt.js";
import { asAttemptId } from "./brands.js";
import { redactFailureMessage } from "./redact.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalStageRunnerDeps,
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

export interface ApprovalStageRunner extends StageRunner {
  answer(
    attemptId: string,
    decision: ApprovalDecision,
  ): Promise<{ status: "recorded" } | { status: "stale_revision" }>;
}

interface ApprovalAttemptState {
  readonly snapshot: StageRunnerAttemptSnapshot;
  readonly request: ApprovalRequest;
  readonly writes: readonly string[];
  readonly requirements: NonNullable<StageRunnerPrepareInput["stage"]["completion"]>["require"];
  interactionRevision: number;
  decision?: ApprovalDecision;
  answerStatus?: "recorded" | "stale_revision";
  started: boolean;
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
    detail: "approval stage has no process group",
  };
}

export function createApprovalStageRunner(deps: ApprovalStageRunnerDeps = {}): ApprovalStageRunner {
  const clock = deps.clock ?? systemClock;
  const attempts = new Map<string, ApprovalAttemptState>();

  function requireAttempt(attemptId: string): ApprovalAttemptState {
    const state = attempts.get(attemptId);
    if (state === undefined) {
      throw new Error(`unknown approval attempt: ${attemptId}`);
    }
    return state;
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
      if (input.stage.type !== "approval") {
        throw new Error("createApprovalStageRunner only accepts approval stages");
      }
      const request = input.approvalRequest;
      if (request === undefined) {
        throw new Error("approval stage requires approvalRequest");
      }

      const now = clock.nowIso();
      let deadlineAt = input.deadlineAt;
      if (request.timeoutAt !== undefined) {
        if (deadlineAt === undefined || request.timeoutAt < deadlineAt) {
          deadlineAt = request.timeoutAt;
        }
      }
      const maxDurationMs = input.stage.limits?.maxDurationMs;
      if (maxDurationMs !== undefined) {
        const fromLimits = new Date(Date.parse(now) + maxDurationMs).toISOString();
        if (deadlineAt === undefined || fromLimits < deadlineAt) deadlineAt = fromLimits;
      }

      const snapshot: StageRunnerAttemptSnapshot = {
        attemptId: input.attemptId,
        runId: input.runId,
        stageId: input.stageId,
        stageType: "approval",
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
        recovery: "await_approval",
        revision: 1,
        updatedAt: now,
        createdAt: now,
      };

      attempts.set(input.attemptId, {
        snapshot,
        request,
        writes: [...input.stage.writes],
        requirements: input.stage.completion?.require ?? [],
        interactionRevision: 1,
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
      state.started = true;
      state.snapshot.phase = "start";
      state.snapshot.startedAt = clock.nowIso();
      state.snapshot.recovery = "await_approval";
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);

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

      if (state.cancelled) {
        return { status: "terminal", backendStatus: "cancelled" };
      }

      if (state.answerStatus === "stale_revision") {
        return { status: "terminal", backendStatus: "failed" };
      }

      if (state.decision !== undefined) {
        return {
          status: "terminal",
          backendStatus: state.decision.decision === "approve" ? "succeeded" : "failed",
        };
      }

      const deadlineAt = state.snapshot.deadlineAt;
      if (!state.timedOut && deadlineAt !== undefined && clock.nowIso() >= deadlineAt) {
        state.timedOut = true;
        const cleanup = emptyCleanup(attemptId, clock.nowIso());
        state.cleanup = cleanup;
        state.snapshot.cleanup = cleanup;
        state.snapshot.recovery = "none";
        bump(state.snapshot, clock);
        await notifyStore(deps.store, state.snapshot);
        await deps.store?.onCleanup?.(cleanup);
        return { status: "timed_out", cleanup };
      }

      return { status: "waiting" };
    },

    async answer(
      attemptId: string,
      decision: ApprovalDecisionV1,
    ): Promise<{ status: "recorded" } | { status: "stale_revision" }> {
      const state = requireAttempt(attemptId);
      if (state.cancelled || state.timedOut) {
        throw new Error("cannot answer a cancelled or timed-out approval attempt");
      }
      if (state.decision !== undefined || state.answerStatus === "stale_revision") {
        state.answerStatus = "stale_revision";
        return { status: "stale_revision" };
      }
      if (decision.interactionId !== state.request.continuation.interactionId) {
        throw new Error("approval decision interactionId does not match the request");
      }
      if (decision.expectedInteractionRevision !== state.interactionRevision) {
        state.answerStatus = "stale_revision";
        state.snapshot.recovery = "none";
        bump(state.snapshot, clock);
        await notifyStore(deps.store, state.snapshot);
        return { status: "stale_revision" };
      }

      state.decision = decision;
      state.answerStatus = "recorded";
      state.interactionRevision += 1;
      state.snapshot.recovery = "none";
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
      return { status: "recorded" };
    },

    async cancel(attemptId: string): Promise<StageRunnerCleanupReport> {
      const state = requireAttempt(attemptId);
      state.cancelled = true;
      state.snapshot.phase = "cancel";
      state.snapshot.recovery = "none";
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
      const report = emptyCleanup(attemptId, clock.nowIso());
      state.cleanup = report;
      state.snapshot.cleanup = report;
      await deps.store?.onCleanup?.(report);
      return report;
    },

    async collect(attemptId: string): Promise<void> {
      const state = requireAttempt(attemptId);
      state.snapshot.phase = "collect";
      const now = clock.nowIso();
      const evidence = [...state.snapshot.evidence];
      const outputs = [...state.snapshot.outputs];

      if (state.decision !== undefined) {
        evidence.push({
          schemaVersion: 1,
          kind: "verdict",
          satisfied: state.decision.decision === "approve",
          recordedAt: now,
          requirement: "approval",
          detail: `approval ${state.decision.decision} by ${state.decision.answeredByKeyId}`,
          payload: state.decision,
        });
        outputs.push({
          schemaVersion: 1,
          reference: "approval.decision",
          kind: "value",
          value: state.decision,
        });
      } else if (state.answerStatus === "stale_revision") {
        evidence.push({
          schemaVersion: 1,
          kind: "verdict",
          satisfied: false,
          recordedAt: now,
          requirement: "approval",
          detail: "stale approval interaction revision",
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

      const approved =
        state.decision?.decision === "approve" &&
        state.answerStatus === "recorded" &&
        !state.cancelled &&
        !state.timedOut;
      const succeeded = approved && validation.valid;

      if (succeeded) {
        const result = {
          schemaVersion: 2 as const,
          attemptId: asAttemptId(attemptId),
          outcome: "succeeded" as const,
          outputs: state.snapshot.outputs,
          evidence: state.snapshot.evidence,
          finishedAt,
          summary: `approved:${state.decision!.selectedLabel}`,
        } as StageRunnerResult;
        state.snapshot.phase = "succeeded";
        state.snapshot.result = result;
        state.snapshot.finishedAt = finishedAt;
        bump(state.snapshot, clock);
        await notifyStore(deps.store, state.snapshot);
        return {
          result,
          validation,
          ...(state.cleanup === undefined ? {} : { cleanup: state.cleanup }),
        };
      }

      const classification = state.cancelled
        ? ("cancelled" as const)
        : state.timedOut
          ? ("timeout" as const)
          : state.answerStatus === "stale_revision"
            ? ("stale_revision" as const)
            : state.decision?.decision === "reject"
              ? ("rejected" as const)
              : ("validation_failed" as const);

      const failure = {
        schemaVersion: 2 as const,
        classification,
        phase: "finalize" as const,
        code: classification,
        message: redactFailureMessage(
          classification === "rejected"
            ? `approval rejected (${state.decision?.selectedLabel ?? "reject"})`
            : classification === "stale_revision"
              ? "approval decision expectedInteractionRevision did not match"
              : (validation.detail ?? "approval stage failed"),
        ),
        retryable: false,
        recovery: state.snapshot.recovery,
      };

      const outcome = state.cancelled ? ("cancelled" as const) : ("failed" as const);
      const result = {
        schemaVersion: 2 as const,
        attemptId: asAttemptId(attemptId),
        outcome,
        outputs: state.snapshot.outputs,
        evidence: state.snapshot.evidence,
        failure,
        finishedAt,
      } as StageRunnerResult;

      state.snapshot.phase = outcome === "cancelled" ? "cancelled" : "failed";
      state.snapshot.result = result;
      state.snapshot.failure = failure;
      state.snapshot.finishedAt = finishedAt;
      bump(state.snapshot, clock);
      await notifyStore(deps.store, state.snapshot);
      return {
        result,
        validation,
        ...(state.cleanup === undefined ? {} : { cleanup: state.cleanup }),
      };
    },
  };
}
