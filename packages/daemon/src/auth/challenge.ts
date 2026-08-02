/**
 * Per-connection challenge and replay window (design C6).
 *
 * Each accepted connection gets a fresh 32-byte challenge and its own
 * `lastSequence`, both living in the connection's state and dying with it.
 *
 * **The window deliberately does not survive restart**, and that is a property
 * rather than an omission. The secret is rotated on every process start
 * (STD-11), so a request captured against instance *N* cannot verify against
 * *N+1* under any sequence; and every connection gets a fresh challenge, so
 * replaying the same bytes on a new connection of the *same* instance fails
 * too. There is therefore no persistent anti-replay state to corrupt, to skew,
 * or to reconcile after a crash — and no clock anywhere in the auth path,
 * which is what lets the whole verifier stay pure and deterministic.
 */

import type { RandomSource } from "../ports.js";

/** Challenge width, matching `DaemonHelloResult/v1`'s 64-hex-character field. */
export const CHALLENGE_BYTES = 32;

export interface ConnectionAuth {
  readonly challenge: Uint8Array;
  /**
   * Highest sequence accepted **on this connection**. Starts at 0, and a
   * request must exceed it strictly, so a replay of an accepted request is
   * rejected even though its MAC is perfectly valid.
   */
  readonly lastSequence: number;
}

export function createConnectionAuth(randomSource: RandomSource): ConnectionAuth {
  return { challenge: randomSource.bytes(CHALLENGE_BYTES), lastSequence: 0 };
}

/** Lower-case hex, the encoding every hex-shaped contract field uses. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Inverse of `toHex`; returns `undefined` unless `text` is exactly `byteLength` lower-case hex bytes. */
export function fromHex(text: string, byteLength: number): Uint8Array | undefined {
  if (text.length !== byteLength * 2 || !/^[a-f0-9]+$/.test(text)) {
    return undefined;
  }
  const out = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i += 1) {
    out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
