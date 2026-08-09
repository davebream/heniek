/**
 * Pure segment-fusion eligibility evaluator (§15.2).
 *
 * Permits only direct, serialized agent-stage transitions when profile
 * fingerprints, permissions, workspace/lease, and retry/session posture match;
 * the backend supports continuation; neither stage requires fresh review; and
 * context pressure is available below the soft threshold.
 */

import { deriveFusionDecisionId } from "./ids.js";
import {
  evaluateContextPressure,
  type PressureEvaluation,
  type PressureObservationInput,
  pressureAllowsFusion,
} from "./pressure.js";

export type FusionSplitReason =
  | "explicit_fresh"
  | "profile_mismatch"
  | "fingerprint_mismatch"
  | "permissions_mismatch"
  | "workspace_mismatch"
  | "lease_mismatch"
  | "backend_no_continuation"
  | "fresh_review_required"
  | "retry_requires_fresh"
  | "delegated_recovery"
  | "branching_ambiguity"
  | "pressure_unavailable"
  | "pressure_contradictory"
  | "pressure_soft_threshold"
  | "pressure_hard_threshold"
  | "capacity_exhausted"
  | "non_agent_stage"
  | "not_adjacent";

export interface FusionStageView {
  readonly stageId: string;
  readonly stageType: string;
  readonly profileId?: string;
  readonly profileFingerprint?: string;
  readonly roleId?: string;
  readonly sessionPolicy?: "fresh" | "resume";
  readonly permissionsDigest?: string;
}

export interface FusionWorkspaceView {
  readonly workspaceId?: string;
  readonly leaseId?: string;
}

export interface EvaluateFusionInput {
  readonly runId: string;
  readonly from: FusionStageView;
  readonly to: FusionStageView;
  readonly fromWorkspace: FusionWorkspaceView;
  readonly toWorkspace: FusionWorkspaceView;
  readonly adjacent: boolean;
  readonly successorCount: number;
  readonly backendSupportsContinuation: boolean;
  readonly retryMode?: "fresh" | "resume" | "delegate";
  readonly pressure?: PressureObservationInput;
  readonly fromAttemptId?: string;
  readonly toAttemptId?: string;
  readonly segmentId?: string;
  readonly now: string;
}

export interface PipelineFusionDecisionPlain {
  readonly schemaVersion: 1;
  readonly decisionId: string;
  readonly runId: string;
  readonly fromStageId: string;
  readonly toStageId: string;
  readonly fromAttemptId?: string;
  readonly toAttemptId?: string;
  readonly outcome: "fuse" | "split";
  readonly splitReason?: FusionSplitReason;
  readonly segmentId?: string;
  readonly pressure?: {
    readonly ratio?: number;
    readonly confidence: "exact" | "estimated" | "unavailable";
    readonly state: "measured" | "exhausted" | "unavailable";
    readonly softThreshold: number;
    readonly hardThreshold: number;
    readonly telemetryCursor?: string;
  };
  readonly detail?: string;
  readonly recordedAt: string;
}

export type EvaluateFusionResult =
  | {
      readonly outcome: "fuse";
      readonly decision: PipelineFusionDecisionPlain;
      readonly pressure: PressureEvaluation;
    }
  | {
      readonly outcome: "split";
      readonly decision: PipelineFusionDecisionPlain;
      readonly splitReason: FusionSplitReason;
      readonly pressure?: PressureEvaluation;
    };

const FRESH_REVIEW_ROLE_PATTERN = /(critic|reviewer|review)/i;

export function requiresFreshReview(stage: FusionStageView): boolean {
  if (stage.sessionPolicy === "fresh") {
    return true;
  }
  if (stage.roleId !== undefined && FRESH_REVIEW_ROLE_PATTERN.test(stage.roleId)) {
    return true;
  }
  return false;
}

function buildDecision(
  input: EvaluateFusionInput,
  fields: {
    readonly outcome: "fuse" | "split";
    readonly splitReason?: FusionSplitReason;
    readonly pressure?: PressureEvaluation;
    readonly detail?: string;
  },
): PipelineFusionDecisionPlain {
  const decision: PipelineFusionDecisionPlain = {
    schemaVersion: 1,
    decisionId: deriveFusionDecisionId({
      runId: input.runId,
      fromStageId: input.from.stageId,
      toStageId: input.to.stageId,
      ...(input.fromAttemptId === undefined ? {} : { fromAttemptId: input.fromAttemptId }),
      recordedAt: input.now,
    }),
    runId: input.runId,
    fromStageId: input.from.stageId,
    toStageId: input.to.stageId,
    outcome: fields.outcome,
    recordedAt: input.now,
  };
  if (input.fromAttemptId !== undefined) {
    (decision as { fromAttemptId?: string }).fromAttemptId = input.fromAttemptId;
  }
  if (input.toAttemptId !== undefined) {
    (decision as { toAttemptId?: string }).toAttemptId = input.toAttemptId;
  }
  if (fields.splitReason !== undefined) {
    (decision as { splitReason?: FusionSplitReason }).splitReason = fields.splitReason;
  }
  if (input.segmentId !== undefined && fields.outcome === "fuse") {
    (decision as { segmentId?: string }).segmentId = input.segmentId;
  }
  if (fields.pressure !== undefined) {
    (decision as { pressure?: PipelineFusionDecisionPlain["pressure"] }).pressure = {
      softThreshold: fields.pressure.softThreshold,
      hardThreshold: fields.pressure.hardThreshold,
      confidence: fields.pressure.confidence,
      state: fields.pressure.state,
      ...(fields.pressure.ratio === undefined ? {} : { ratio: fields.pressure.ratio }),
      ...(fields.pressure.telemetryCursor === undefined
        ? {}
        : { telemetryCursor: fields.pressure.telemetryCursor }),
    };
  }
  if (fields.detail !== undefined) {
    (decision as { detail?: string }).detail = fields.detail;
  }
  return decision;
}

function split(
  input: EvaluateFusionInput,
  splitReason: FusionSplitReason,
  extras?: { readonly pressure?: PressureEvaluation; readonly detail?: string },
): EvaluateFusionResult {
  return {
    outcome: "split",
    splitReason,
    decision: buildDecision(input, {
      outcome: "split",
      splitReason,
      ...(extras?.pressure === undefined ? {} : { pressure: extras.pressure }),
      ...(extras?.detail === undefined ? {} : { detail: extras.detail }),
    }),
    ...(extras?.pressure === undefined ? {} : { pressure: extras.pressure }),
  };
}

/**
 * Evaluate whether `to` may join the open segment that just finished `from`.
 */
export function evaluateFusion(input: EvaluateFusionInput): EvaluateFusionResult {
  if (input.from.stageType !== "agent" || input.to.stageType !== "agent") {
    return split(input, "non_agent_stage");
  }
  if (!input.adjacent) {
    return split(input, "not_adjacent");
  }
  if (input.successorCount !== 1) {
    return split(input, "branching_ambiguity", {
      detail: `successorCount=${input.successorCount}`,
    });
  }
  if (input.to.sessionPolicy === "fresh") {
    return split(input, "explicit_fresh");
  }
  if (requiresFreshReview(input.to) || requiresFreshReview(input.from)) {
    return split(input, "fresh_review_required");
  }
  if (input.retryMode === "fresh") {
    return split(input, "retry_requires_fresh");
  }
  if (input.retryMode === "delegate") {
    return split(input, "delegated_recovery");
  }
  if (!input.backendSupportsContinuation) {
    return split(input, "backend_no_continuation");
  }

  const fromProfile = input.from.profileId;
  const toProfile = input.to.profileId;
  if (fromProfile === undefined || toProfile === undefined || fromProfile !== toProfile) {
    return split(input, "profile_mismatch");
  }
  if (
    input.from.profileFingerprint !== undefined &&
    input.to.profileFingerprint !== undefined &&
    input.from.profileFingerprint !== input.to.profileFingerprint
  ) {
    return split(input, "fingerprint_mismatch");
  }
  if (
    input.from.permissionsDigest !== undefined &&
    input.to.permissionsDigest !== undefined &&
    input.from.permissionsDigest !== input.to.permissionsDigest
  ) {
    return split(input, "permissions_mismatch");
  }

  const fromWs = input.fromWorkspace.workspaceId;
  const toWs = input.toWorkspace.workspaceId;
  if (fromWs !== undefined && toWs !== undefined && fromWs !== toWs) {
    return split(input, "workspace_mismatch");
  }
  const fromLease = input.fromWorkspace.leaseId;
  const toLease = input.toWorkspace.leaseId;
  if (fromLease !== undefined && toLease !== undefined && fromLease !== toLease) {
    return split(input, "lease_mismatch");
  }

  const pressureInput: PressureObservationInput = input.pressure ?? {
    state: "unavailable",
    confidence: "unavailable",
  };
  const pressure = evaluateContextPressure(pressureInput);
  if (!pressureAllowsFusion(pressure)) {
    const reason = pressure.splitReason ?? "pressure_unavailable";
    return split(input, reason, { pressure });
  }

  return {
    outcome: "fuse",
    pressure,
    decision: buildDecision(input, {
      outcome: "fuse",
      pressure,
    }),
  };
}
