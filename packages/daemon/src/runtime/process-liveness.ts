/**
 * The real `ProcessLiveness` adapter (design C1 step 6/STD-6, plan Task 5
 * Steps 7 and 8). A corroborating signal only, never a primary one —
 * `isAlive` is consulted after a boot-witness match, never before, and this
 * module never signals a foreign process: signal `0` (`kill(pid, 0)`, the
 * `packages/conformance/src/smoke/claudexor/daemon-handle.ts:176-178`
 * idiom) is the only signal number this adapter ever sends. `pid` is
 * expected in `[1, 2^31)` per the claim-record grammar (design C3) — signal
 * 0 to pid `0` targets the whole process group, which is exactly the
 * mistake that range excludes upstream in `claim-record.ts`.
 *
 * **`EPERM` semantics (plan-review round 1, finding m2):** `process.kill(pid,
 * 0)` throws `ESRCH` for a dead pid and `EPERM` for a live pid this process
 * does not own. Mapping `EPERM` to `false` would classify a live
 * foreign-owned process's claim as orphaned and take it over, so `isAlive`
 * returns `true` on success **and** on `EPERM` (the process exists; it
 * merely is not ours), returns `false` only on `ESRCH`, and rethrows every
 * other errno.
 */

import type { ProcessLiveness } from "../ports.js";

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export function createSystemProcessLiveness(): ProcessLiveness {
  return {
    isAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (isErrnoCode(error, "ESRCH")) {
          return false;
        }
        if (isErrnoCode(error, "EPERM")) {
          return true;
        }
        throw error;
      }
    },

    uid(): number {
      // `process.getuid` is undefined on Windows (mirrors
      // `packages/state/src/database/open.ts:157,283`'s `process.getuid?.()`
      // idiom); `-1` is an unreachable POSIX uid, used only as an
      // unsupported-platform sentinel — this package's directory-ownership
      // checks are POSIX-only by design.
      return process.getuid?.() ?? -1;
    },
  };
}
