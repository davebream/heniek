/**
 * Deterministic identity helpers for scheduler decisions, attempts, and
 * outbox intents. IDs are pure functions of their coordinates so duplicate
 * ticks and restart reloads collide on uniqueness constraints instead of
 * minting a second side effect.
 */

export function edgeKey(fromStageId: string, toStageId: string): string {
  return `${fromStageId}->${toStageId}`;
}

export function deriveAttemptId(input: {
  readonly runId: string;
  readonly graphRevision: number;
  readonly stageId: string;
  readonly generation: number;
  readonly attemptOrdinal: number;
}): string {
  return `pa:${input.runId}:${input.graphRevision}:${input.stageId}:${input.generation}:${input.attemptOrdinal}`;
}

export function deriveDecisionId(input: {
  readonly runId: string;
  readonly graphRevision: number;
  readonly stageId: string;
  readonly generation: number;
  readonly attemptOrdinal: number;
  readonly action: string;
}): string {
  return `pd:${input.runId}:${input.graphRevision}:${input.stageId}:${input.generation}:${input.attemptOrdinal}:${input.action}`;
}

export function deriveIntentId(input: {
  readonly runId: string;
  readonly graphRevision: number;
  readonly kind: "dispatch" | "cancel" | "evaluator" | "recovery_dispatch";
  readonly key: string;
}): string {
  return `pi:${input.runId}:${input.graphRevision}:${input.kind}:${input.key}`;
}

export function deriveRecoveryDecisionId(input: {
  readonly runId: string;
  readonly graphRevision: number;
  readonly stageId: string;
  readonly generation: number;
  readonly attemptOrdinal: number;
  readonly action: string;
}): string {
  return `prd:${input.runId}:${input.graphRevision}:${input.stageId}:${input.generation}:${input.attemptOrdinal}:${input.action}`;
}
