/**
 * Per-connection challenge and replay-sequence state (design C6, STD-12,
 * plan Task 3 Step 8).
 *
 * `mintConnectionAuthState` runs once per *accepted* connection — before
 * `daemon.hello` is ever called — so `daemon.hello`'s job is only to read
 * this state back and report it, never to mint it (plan Task 3 Step 3).
 *
 * The window this state protects dies with the connection by design: it
 * never needs to survive a restart, because the credential itself is
 * rotated on every daemon start (STD-11) and every connection gets a fresh
 * challenge, so a captured request can never verify against a different
 * instance or a different connection of the same instance. There is
 * therefore no persistent anti-replay state to corrupt, skew, or reconcile
 * after a crash, and no clock anywhere in the auth path.
 */

import type { RandomSource } from "../ports.js";

/** 32 bytes — 4x the corresponding STD-11 floor for the credential secret itself. */
export const CHALLENGE_BYTES = 32;

export interface ConnectionAuthState {
  readonly challenge: Uint8Array;
  /** Mutable: advances to `sequence` on every successfully authenticated request (design C6). */
  lastSequence: number;
  /** `daemon.hello` may be called at most once per connection (plan-review round 1, finding m5). */
  helloCalled: boolean;
}

export function mintConnectionAuthState(randomSource: RandomSource): ConnectionAuthState {
  return {
    challenge: randomSource.bytes(CHALLENGE_BYTES),
    lastSequence: 0,
    helloCalled: false,
  };
}
