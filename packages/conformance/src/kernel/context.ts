import { createFakeClock, type FakeClock } from "./clock.js";
import { createDeterministicIds, type DeterministicIds } from "./ids.js";
import {
  createDeterministicRandom,
  DEFAULT_SEED,
  type DeterministicRandom,
  type Seed,
} from "./seed.js";
import { createTraceRecorder, type TraceRecorder } from "./trace.js";

/** Everything a conformance case or fake backend needs for determinism (C1). */
export interface ConformanceContext {
  readonly seed: Seed;
  readonly random: DeterministicRandom;
  readonly clock: FakeClock;
  readonly ids: DeterministicIds;
  readonly trace: TraceRecorder;
}

export function createConformanceContext(value: Seed = DEFAULT_SEED): ConformanceContext {
  return {
    seed: value,
    random: createDeterministicRandom(value),
    clock: createFakeClock(),
    ids: createDeterministicIds(value),
    trace: createTraceRecorder(value),
  };
}
