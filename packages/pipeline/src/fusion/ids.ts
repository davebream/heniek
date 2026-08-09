/**
 * Deterministic identity derivation for fusion / continuation records.
 */

import { createHash } from "node:crypto";

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 32);
}

export function deriveSegmentId(input: {
  readonly runId: string;
  readonly profileId: string;
  readonly ordinal: number;
}): string {
  return `seg:${input.runId}:${digest([input.runId, input.profileId, String(input.ordinal)])}`;
}

export function deriveFusionDecisionId(input: {
  readonly runId: string;
  readonly fromStageId: string;
  readonly toStageId: string;
  readonly fromAttemptId?: string;
  readonly recordedAt: string;
}): string {
  return `fuse:${input.runId}:${digest([
    input.runId,
    input.fromStageId,
    input.toStageId,
    input.fromAttemptId ?? "",
    input.recordedAt,
  ])}`;
}

export function deriveCapsuleId(input: {
  readonly runId: string;
  readonly stageId: string;
  readonly attemptId: string;
  readonly segmentId: string;
  readonly segmentOrdinal: number;
}): string {
  return `cap:${input.runId}:${digest([
    input.runId,
    input.stageId,
    input.attemptId,
    input.segmentId,
    String(input.segmentOrdinal),
  ])}`;
}

export function deriveVerificationId(input: {
  readonly capsuleId: string;
  readonly recordedAt: string;
}): string {
  return `ver:${digest([input.capsuleId, input.recordedAt])}`;
}
