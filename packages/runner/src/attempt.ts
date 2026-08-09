/**
 * Shared attempt bookkeeping helpers for command and agent runners.
 */

import type {
  RunnerClock,
  StageRunnerAttemptSnapshot,
  StageRunnerStoreCallbacks,
} from "./types.js";

export const systemClock: RunnerClock = {
  nowIso: () => new Date().toISOString(),
};

export async function notifyStore(
  store: StageRunnerStoreCallbacks | undefined,
  attempt: StageRunnerAttemptSnapshot,
): Promise<void> {
  await store?.onAttemptUpdate?.(attempt);
}

export function bump(attempt: StageRunnerAttemptSnapshot, clock: RunnerClock): void {
  attempt.revision += 1;
  attempt.updatedAt = clock.nowIso();
}
