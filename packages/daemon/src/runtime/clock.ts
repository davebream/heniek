/**
 * The real `Clock` adapter (design C10, plan Task 5 Step 8). One of the
 * eleven ambient sources this package confines to `src/runtime/**` — see
 * `test/no-ambient-sources.test.ts`'s exemption allowlist.
 *
 * `@heniek/state` defines the `Clock` port itself (`src/ports.ts` re-exports
 * it rather than redeclaring it); this is the daemon's own implementation,
 * kept here rather than imported from `@heniek/state` because
 * `@heniek/state` ships no default adapter of its own (its own determinism
 * gate forbids one for the same reason this package's does).
 */

import type { Clock } from "../ports.js";

export function createSystemClock(): Clock {
  return {
    nowIso(): string {
      return new Date().toISOString();
    },
  };
}
