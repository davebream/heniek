/**
 * Strictest-wins limit resolution for repair budgets and related caps.
 */

export interface ResolveRepairBudgetInput {
  readonly pipelineMaxRepairAttempts?: number;
  readonly stageMaxRepairAttempts?: number;
  readonly validationMaxAttempts?: number;
  readonly effectiveMaxRepairAttempts?: number;
}

/**
 * Resolve the repair budget. Defined values are intersected by minimum; when
 * none are defined the pure scheduler returns 0 (daemon supplies defaults via
 * effectiveLimits).
 */
export function resolveRepairBudget(input: ResolveRepairBudgetInput): number {
  const candidates: number[] = [];
  if (input.effectiveMaxRepairAttempts !== undefined) {
    candidates.push(input.effectiveMaxRepairAttempts);
  }
  if (input.stageMaxRepairAttempts !== undefined) {
    candidates.push(input.stageMaxRepairAttempts);
  }
  if (input.pipelineMaxRepairAttempts !== undefined) {
    candidates.push(input.pipelineMaxRepairAttempts);
  }
  if (input.validationMaxAttempts !== undefined) {
    candidates.push(input.validationMaxAttempts);
  }
  if (candidates.length === 0) {
    return 0;
  }
  return Math.min(...candidates);
}

export interface ResolveEffectiveConcurrencyInput {
  readonly pipelineMaxConcurrentWorkers?: number;
  readonly effectiveMaxConcurrentWorkers?: number;
}

/** Strictest (minimum) concurrency cap; undefined when neither side sets one. */
export function resolveEffectiveConcurrency(
  input: ResolveEffectiveConcurrencyInput,
): number | undefined {
  const candidates: number[] = [];
  if (input.effectiveMaxConcurrentWorkers !== undefined) {
    candidates.push(input.effectiveMaxConcurrentWorkers);
  }
  if (input.pipelineMaxConcurrentWorkers !== undefined) {
    candidates.push(input.pipelineMaxConcurrentWorkers);
  }
  if (candidates.length === 0) {
    return undefined;
  }
  return Math.min(...candidates);
}
