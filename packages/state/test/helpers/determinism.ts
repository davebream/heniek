/**
 * Test-only determinism helpers (plan Task 1.8, design D14, D16). These
 * mirror `packages/conformance/src/kernel/{clock,ids,seed}.ts` byte-for-byte
 * in behaviour but are **copied**, not imported: importing would give
 * `@heniek/state` a devDependency edge on `@heniek/conformance` for what is
 * ultimately ~50 lines of pure, already-pinned arithmetic (plan P4 — the
 * round-1 orchestrator decision withdraws the earlier "or take the
 * dependency" contingency; local duplication with zero cross-package
 * coupling is the only sanctioned shape now). Never imported from `src/`.
 */

import type { Clock, IdGenerator } from "../../src/determinism.js";

/** A fixed epoch, deliberately not the current wall-clock time (mirrors `conformance/src/kernel/clock.ts:6`). */
export const STATE_TEST_EPOCH_MS: number = Date.UTC(2026, 0, 1, 0, 0, 0);

/** A `Clock` whose time only ever advances when explicitly told to — mirrors `conformance`'s `FakeClock`. */
export function createFakeClock(
  startMs: number = STATE_TEST_EPOCH_MS,
): Clock & { advance(ms: number): void } {
  let currentMs = startMs;

  return {
    nowIso: () => new Date(currentMs).toISOString(),
    advance: (ms: number) => {
      if (!Number.isInteger(ms) || ms < 0) {
        throw new RangeError(`advance requires a non-negative integer, received: ${ms}`);
      }
      currentMs += ms;
    },
  };
}

/** An `IdGenerator` with a single shared counter across every prefix — mirrors `conformance`'s `DeterministicIds`. */
export function createDeterministicIds(seedValue: number): IdGenerator {
  const seedHex = (seedValue >>> 0).toString(16).padStart(8, "0");
  let counter = 0;

  return {
    next(prefix: string): string {
      counter += 1;
      return `${prefix}-${seedHex}-${String(counter).padStart(4, "0")}`;
    },
  };
}

/** A deterministic pseudo-random generator seeded once and forkable per label — mirrors `conformance`'s `DeterministicRandom`. */
export interface DeterministicRandom {
  /** Next raw 32-bit unsigned integer in the stream. */
  nextUint32(): number;
  /** Next integer in `[minInclusive, maxExclusive)`. */
  nextInt(minInclusive: number, maxExclusive: number): number;
  /** Picks one element of `values`, deterministically. Throws on an empty array. */
  pick<T>(values: readonly T[]): T;
  /** Returns a new, independent generator derived from this one's seed and `label`. */
  fork(label: string): DeterministicRandom;
}

/**
 * FNV-1a 32-bit hash, used only to derive an independent stream seed from a
 * fork label — not a cryptographic hash. Byte-for-byte from
 * `packages/conformance/src/kernel/seed.ts`.
 */
function fnv1a32(label: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < label.length; index += 1) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * splitmix32 — a small, fast, 32-bit-only generator with no BigInt
 * dependency, so the exact same integer stream is produced on every
 * platform and JS engine. Byte-for-byte from
 * `packages/conformance/src/kernel/seed.ts:58-103`.
 */
export function createDeterministicRandom(seedValue: number): DeterministicRandom {
  const baseSeed = seedValue >>> 0;
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
    // the requirement here — mirrors the conformance original's rationale.
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
    return createDeterministicRandom((baseSeed ^ fnv1a32(label)) >>> 0);
  }

  return { nextUint32, nextInt, pick, fork };
}
