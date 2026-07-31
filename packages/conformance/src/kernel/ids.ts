import type { Seed } from "./seed.js";

/** Deterministic, collision-free, human-readable id generator. */
export interface DeterministicIds {
  /** Returns the next id for `prefix`. A single shared counter is used
   * across every prefix, so the emission order stays visible in traces. */
  next(prefix: string): string;
}

export function createDeterministicIds(value: Seed): DeterministicIds {
  const seedHex = (value >>> 0).toString(16).padStart(8, "0");
  let counter = 0;

  return {
    next(prefix: string): string {
      counter += 1;
      return `${prefix}-${seedHex}-${String(counter).padStart(4, "0")}`;
    },
  };
}
