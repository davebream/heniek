/**
 * The real `MacProvider` adapter (design C6/C10, plan Task 5 Steps 2c and 8)
 * — the resolution to the C6/C10 tension recorded in the plan's Task 3 Step
 * 8 planner note: `src/auth/verify.ts` stays pure over an injected
 * `MacProvider`, and the cryptography built-in is quarantined here, the
 * package's single `node:crypto` HMAC/timing-safe-comparison site.
 *
 * `constantTimeEqual` length-checks **before** ever calling
 * `crypto.timingSafeEqual`, which throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`
 * on a length mismatch rather than returning `false` (plan Task 5 Step 2c(b)).
 * Without the guard, an unequal-length MAC would crash the dispatcher instead
 * of being rejected like any other forged MAC — turning an attacker-supplied
 * length into an availability bug. `src/auth/verify.ts` already shape-checks
 * `mac` as exactly 64 hex characters before this is ever reached, so the
 * unequal-length branch is defence in depth, not a path real traffic takes.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { MacProvider } from "../ports.js";

export function createHmacSha256MacProvider(): MacProvider {
  return {
    hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
      return new Uint8Array(createHmac("sha256", key).update(message).digest());
    },

    constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
      if (a.length !== b.length) {
        return false;
      }
      return timingSafeEqual(a, b);
    },
  };
}
