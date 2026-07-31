import type { Brand } from "@heniek/contracts";

/**
 * A 32-bit unsigned integer seed that fully determines every stream of
 * pseudo-randomness, id, and trace produced by this package (C1). Branded
 * with the contracts package's shared `Brand` helper rather than inventing a
 * second nominal-typing mechanism.
 */
export type Seed = Brand<number, "ConformanceSeed">;

const MAX_UINT32 = 0xffff_ffff;

/** Validates and brands a 32-bit unsigned integer seed. */
export function seed(value: number): Seed {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new RangeError(`Seed must be a 32-bit unsigned integer, received: ${value}`);
  }
  return value as Seed;
}

/** The default seed used whenever a case or scenario does not pin its own. */
export const DEFAULT_SEED: Seed = seed(0x00c0_ffee);

/**
 * FNV-1a 32-bit hash, used only to derive an independent stream seed from a
 * fork label — not a cryptographic hash.
 */
function fnv1a32(label: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A deterministic pseudo-random generator seeded once and forkable per label. */
export interface DeterministicRandom {
  /** Next raw 32-bit unsigned integer in the stream. */
  nextUint32(): number;
  /** Next integer in `[minInclusive, maxExclusive)`. */
  nextInt(minInclusive: number, maxExclusive: number): number;
  /** Picks one element of `values`, deterministically. Throws on an empty array. */
  pick<T>(values: readonly T[]): T;
  /**
   * Returns a new, independent generator derived from this one's seed and
   * `label`, so that unrelated cases/subjects never share a stream and
   * therefore never perturb each other's recorded trace.
   */
  fork(label: string): DeterministicRandom;
}

/**
 * splitmix32 — a small, fast, 32-bit-only generator with no BigInt
 * dependency, chosen so the exact same integer stream is produced on every
 * platform and JS engine (C1/RT1).
 */
export function createDeterministicRandom(value: Seed): DeterministicRandom {
  const baseSeed = value >>> 0;
  let state = baseSeed;

  function nextUint32(): number {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  }

  function nextInt(minInclusive: number, maxExclusive: number): number {
    if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive)) {
      throw new RangeError("nextInt bounds must be integers");
    }
    if (maxExclusive <= minInclusive) {
      throw new RangeError("nextInt requires maxExclusive > minInclusive");
    }
    const range = maxExclusive - minInclusive;
    // Rejection-free modulo: introduces a negligible bias for ranges that do
    // not evenly divide 2^32. Determinism, not statistical uniformity, is
    // the requirement here (see design §3 / plan Phase 2.1).
    return minInclusive + (nextUint32() % range);
  }

  function pick<T>(values: readonly T[]): T {
    if (values.length === 0) {
      throw new RangeError("pick requires a non-empty array");
    }
    const index = nextInt(0, values.length);
    const picked = values[index];
    if (picked === undefined && !(index in values)) {
      // Unreachable given the bounds check above; guards noUncheckedIndexedAccess.
      throw new RangeError("pick produced an out-of-range index");
    }
    return picked as T;
  }

  function fork(label: string): DeterministicRandom {
    const derived = seed((baseSeed ^ fnv1a32(label)) >>> 0);
    return createDeterministicRandom(derived);
  }

  return { nextUint32, nextInt, pick, fork };
}
