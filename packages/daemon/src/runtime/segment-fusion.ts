/**
 * Segment fusion orchestration helpers for the pipeline runner (Q029).
 *
 * Pure eligibility lives in `@heniek/pipeline`; this module applies decisions
 * against durable segment state and produces runner segment directives.
 */

import {
  DEFAULT_HANDOFF_HARD_THRESHOLD,
  DEFAULT_HANDOFF_SOFT_THRESHOLD,
  deriveSegmentId,
  type EvaluateFusionResult,
  evaluateContextPressure,
  evaluateFusion,
  type FusionStageView,
  type PressureObservationInput,
  requiresFreshReview,
} from "@heniek/pipeline";
import type { StageRunnerSegmentDirective } from "@heniek/runner";
import {
  insertExecutionSegment,
  insertFusionDecision,
  patchExecutionSegment,
  readOpenExecutionSegment,
  recordColdStartSession,
  recordFusedStage,
  type StateDatabase,
} from "@heniek/state";

export interface FusionDispatchContext {
  readonly runId: string;
  readonly fromStage?: FusionStageView;
  readonly toStage: FusionStageView;
  readonly fromWorkspace: { readonly workspaceId?: string; readonly leaseId?: string };
  readonly toWorkspace: { readonly workspaceId?: string; readonly leaseId?: string };
  readonly adjacent: boolean;
  readonly successorCount: number;
  readonly backendSupportsContinuation: boolean;
  readonly retryMode?: "fresh" | "resume" | "delegate";
  readonly pressure?: PressureObservationInput;
  readonly fromAttemptId?: string;
  readonly toAttemptId?: string;
  readonly priorBackendExecutionId?: string;
  readonly checkoutPath?: string;
  readonly softThreshold?: number;
  readonly hardThreshold?: number;
  readonly instruction: string;
  readonly now: string;
}

export interface FusionDispatchPlan {
  readonly decision: EvaluateFusionResult;
  readonly segmentDirective?: StageRunnerSegmentDirective;
  readonly reuseWorkspace?: {
    readonly workspaceId: string;
    readonly leaseId?: string;
    readonly checkoutPath?: string;
  };
  readonly openedSegmentId?: string;
}

function stageIdsJson(stageIds: readonly string[]): readonly string[] {
  return [...stageIds];
}

/**
 * Evaluate fusion for a successor agent stage and persist the decision.
 * When fuse: reuse open segment backend/workspace. When split: open a new
 * segment (cold start) after closing any open segment.
 */
export function planFusionDispatch(
  db: StateDatabase,
  context: FusionDispatchContext,
): FusionDispatchPlan {
  const open = readOpenExecutionSegment(db, context.runId);
  const soft = context.softThreshold ?? DEFAULT_HANDOFF_SOFT_THRESHOLD;
  const hard = context.hardThreshold ?? DEFAULT_HANDOFF_HARD_THRESHOLD;

  const fromStage: FusionStageView =
    context.fromStage ??
    ({
      stageId:
        open?.stageIds && Array.isArray(open.stageIds) ? String(open.stageIds.at(-1) ?? "") : "",
      stageType: "agent",
      ...(open?.profileId === undefined || open.profileId === null
        ? {}
        : { profileId: open.profileId }),
    } satisfies FusionStageView);

  const evaluation = evaluateFusion({
    runId: context.runId,
    from: fromStage,
    to: context.toStage,
    fromWorkspace: context.fromWorkspace,
    toWorkspace: context.toWorkspace,
    adjacent: context.adjacent,
    successorCount: context.successorCount,
    backendSupportsContinuation: context.backendSupportsContinuation,
    ...(context.retryMode === undefined ? {} : { retryMode: context.retryMode }),
    ...(context.pressure === undefined ? {} : { pressure: context.pressure }),
    ...(context.fromAttemptId === undefined ? {} : { fromAttemptId: context.fromAttemptId }),
    ...(context.toAttemptId === undefined ? {} : { toAttemptId: context.toAttemptId }),
    ...(open === undefined ? {} : { segmentId: open.segmentId }),
    now: context.now,
  });

  const canFuse =
    evaluation.outcome === "fuse" &&
    open !== undefined &&
    context.priorBackendExecutionId !== undefined &&
    open.backendExecutionId !== undefined;

  insertFusionDecision(db, {
    decisionId: evaluation.decision.decisionId,
    runId: context.runId,
    fromStageId: evaluation.decision.fromStageId,
    toStageId: evaluation.decision.toStageId,
    ...(evaluation.decision.fromAttemptId === undefined
      ? {}
      : { fromAttemptId: evaluation.decision.fromAttemptId }),
    ...(evaluation.decision.toAttemptId === undefined
      ? {}
      : { toAttemptId: evaluation.decision.toAttemptId }),
    outcome: canFuse ? "fuse" : "split",
    ...(canFuse
      ? {
          segmentId: evaluation.decision.segmentId ?? open.segmentId,
        }
      : {
          splitReason:
            evaluation.outcome === "split"
              ? (evaluation.splitReason ?? "backend_no_continuation")
              : "backend_no_continuation",
        }),
    decision: {
      ...evaluation.decision,
      outcome: canFuse ? "fuse" : "split",
      ...(canFuse
        ? {}
        : {
            splitReason:
              evaluation.outcome === "split" ? evaluation.splitReason : "backend_no_continuation",
          }),
    } as never,
    recordedAt: context.now,
  });

  if (canFuse && open !== undefined && context.priorBackendExecutionId !== undefined) {
    const priorStages = Array.isArray(open.stageIds)
      ? open.stageIds.map((entry) => String(entry))
      : [];
    const nextStages = [...priorStages, context.toStage.stageId];
    patchExecutionSegment(db, {
      segmentId: open.segmentId,
      stageIds: stageIdsJson(nextStages) as never,
      segment: {
        schemaVersion: 1,
        segmentId: open.segmentId,
        runId: context.runId,
        profileId: open.profileId,
        status: "open",
        softThreshold: soft,
        hardThreshold: hard,
        stageIds: nextStages,
        startedAt: open.startedAt,
        ...(open.backendExecutionId === undefined
          ? {}
          : { backendExecutionId: open.backendExecutionId }),
        ...(open.workspaceId === undefined ? {} : { workspaceId: open.workspaceId }),
      } as never,
    });
    recordFusedStage(db, context.runId, context.now);
    const workspaceId =
      open.workspaceId === null || open.workspaceId === undefined ? undefined : open.workspaceId;
    const leaseId = open.leaseId === null || open.leaseId === undefined ? undefined : open.leaseId;
    return {
      decision: evaluation,
      segmentDirective: {
        mode: "fuse_resume",
        segmentId: open.segmentId,
        priorBackendExecutionId: context.priorBackendExecutionId,
        instruction: context.instruction,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(leaseId === undefined ? {} : { leaseId }),
        ...(context.checkoutPath === undefined ? {} : { checkoutPath: context.checkoutPath }),
      },
      ...(workspaceId === undefined
        ? {}
        : {
            reuseWorkspace: {
              workspaceId,
              ...(leaseId === undefined ? {} : { leaseId }),
              ...(context.checkoutPath === undefined ? {} : { checkoutPath: context.checkoutPath }),
            },
          }),
    };
  }

  // Split / cold start: close any open segment, then open a fresh one.
  if (open !== undefined) {
    patchExecutionSegment(db, {
      segmentId: open.segmentId,
      status: "closed",
      closedAt: context.now,
    });
  }

  const ordinal = open === undefined ? 0 : 1;
  const profileId = context.toStage.profileId ?? "unknown";
  const segmentId = deriveSegmentId({
    runId: context.runId,
    profileId,
    ordinal,
  });
  const segment = {
    schemaVersion: 1 as const,
    segmentId,
    runId: context.runId,
    profileId,
    ...(context.toStage.profileFingerprint === undefined
      ? {}
      : { profileFingerprint: context.toStage.profileFingerprint }),
    ...(context.toWorkspace.workspaceId === undefined
      ? {}
      : { workspaceId: context.toWorkspace.workspaceId }),
    ...(context.toWorkspace.leaseId === undefined ? {} : { leaseId: context.toWorkspace.leaseId }),
    stageIds: [context.toStage.stageId],
    status: "open" as const,
    softThreshold: soft,
    hardThreshold: hard,
    startedAt: context.now,
  };
  insertExecutionSegment(db, {
    segmentId,
    runId: context.runId,
    profileId,
    ...(context.toStage.profileFingerprint === undefined
      ? {}
      : { profileFingerprint: context.toStage.profileFingerprint }),
    ...(context.toWorkspace.workspaceId === undefined
      ? {}
      : { workspaceId: context.toWorkspace.workspaceId }),
    ...(context.toWorkspace.leaseId === undefined ? {} : { leaseId: context.toWorkspace.leaseId }),
    stageIds: stageIdsJson([context.toStage.stageId]) as never,
    status: "open",
    softThreshold: soft,
    hardThreshold: hard,
    segment: segment as never,
    startedAt: context.now,
  });
  recordColdStartSession(db, context.runId, context.now);

  const continueFresh =
    evaluation.outcome === "split" &&
    (evaluation.splitReason === "pressure_soft_threshold" ||
      evaluation.splitReason === "pressure_hard_threshold" ||
      evaluation.splitReason === "capacity_exhausted");

  return {
    decision: evaluation,
    openedSegmentId: segmentId,
    ...(continueFresh
      ? {
          segmentDirective: {
            mode: "continue_fresh" as const,
            segmentId,
            instruction: context.instruction,
          },
        }
      : {}),
  };
}

/** Attach the live backend execution id to the run's open segment after start. */
export function bindSegmentBackendExecution(
  db: StateDatabase,
  runId: string,
  backendExecutionId: string,
): void {
  const open = readOpenExecutionSegment(db, runId);
  if (open === undefined) return;
  patchExecutionSegment(db, {
    segmentId: open.segmentId,
    backendExecutionId,
  });
}

export { evaluateContextPressure, evaluateFusion, requiresFreshReview };
