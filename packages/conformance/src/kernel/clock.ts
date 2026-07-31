/**
 * A fixed epoch, deliberately not the current wall-clock time — every fake
 * clock starts here unless a scenario overrides it, so timestamps in traces
 * and artifacts never depend on wall-clock time (C1).
 */
export const CONFORMANCE_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

/** A clock whose time only ever advances when explicitly told to. */
export interface FakeClock {
  /** Current time in epoch milliseconds. */
  nowMs(): number;
  /** Current time as an ISO-8601 date-time string with milliseconds. */
  nowIso(): string;
  /** Advances the clock by `ms` milliseconds. `ms` must be a non-negative integer. */
  advance(ms: number): void;
}

export function createFakeClock(startMs: number = CONFORMANCE_EPOCH_MS): FakeClock {
  let currentMs = startMs;

  return {
    nowMs: () => currentMs,
    nowIso: () => new Date(currentMs).toISOString(),
    advance: (ms: number) => {
      if (!Number.isInteger(ms) || ms < 0) {
        throw new RangeError(`FakeClock.advance requires a non-negative integer, received: ${ms}`);
      }
      currentMs += ms;
    },
  };
}
