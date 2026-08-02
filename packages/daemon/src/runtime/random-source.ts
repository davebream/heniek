/**
 * The real `RandomSource` adapter (design C5/C10, plan Task 5 Step 8).
 * `node:crypto.randomBytes` is a CSPRNG — every challenge, `keyId`,
 * `instanceId`, and scratch filename this package mints ultimately traces
 * back to this one function, confined to `src/runtime/**`
 * (`test/no-ambient-sources.test.ts`'s exemption allowlist) so the pure
 * cores that consume `RandomSource` stay deterministic under test.
 */

import { randomBytes } from "node:crypto";
import type { RandomSource } from "../ports.js";

export function createSystemRandomSource(): RandomSource {
  return {
    bytes(length: number): Uint8Array {
      return new Uint8Array(randomBytes(length));
    },
  };
}
