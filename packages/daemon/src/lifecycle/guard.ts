/**
 * `ClaimGuard` — the `LockHandle` design C1 step 9 returns from
 * `acquireClaim` on the winning path (plan Task 2 Step 7).
 *
 * `assertStillHeld()` compares `claimHandle.stat()` (the identity captured
 * when the currently-adopted claim file handle was opened) against
 * `lockFileSystem.lstat(claimPath)` on `(dev, ino)` — catching an unlink or
 * replacement of the published record.
 *
 * `adoptIdentity` exists because publishing the `serving` record replaces
 * the very inode the guard was constructed against: `claimIdentity` at
 * construction time pins the **original** `claiming` record's inode (from
 * `acquire.ts`'s step-2 `createExclusive`), and a `renameSync` of a temp
 * file onto `daemonPidFile` (`acquire.ts`'s publish step) installs a
 * **different** inode at that path. From that instant
 * `fstat(claimFd).ino !== lstat(daemonPidFile).ino` *permanently*, unless
 * the guard is told to re-anchor. `adoptIdentity` atomically swaps the
 * guard's internal claim handle and claim identity to the caller-supplied
 * values and closes the old handle only *after* the swap — it must be
 * called by the publish step immediately after the `rename`, before the
 * first post-publish `assertStillHeld()`.
 *
 * `release()` unlinks only after confirming the path still carries the
 * **current** (post-`adoptIdentity`) claim identity — this is what makes a
 * clean shutdown actually remove the published record instead of either
 * wrongly no-op'ing (comparing against the stale `claiming` identity) or
 * wrongly refusing to unlink.
 *
 * Socket-identity comparison (design C1 step 9's second half — the
 * published record survives `unlink` of the socket path, so a same-uid
 * actor removing it and binding a new socket there must also be caught)
 * lands once `src/runtime/socket-server.ts` (Phase 5) gives this guard a
 * bound socket to compare against; this phase implements exactly the
 * six-method surface plan Task 2 Step 7 names — `instanceId`, `isHeld()`,
 * `assertStillHeld()`, `onLost(cb)`, `release()`, `adoptIdentity(newFd,
 * newIdentity)` — over the claim identity alone.
 */

import type { ClaimFileHandle, FileStat, LockFileSystem } from "../ports.js";
import { ClaimLostError } from "./errors.js";

/** The `(dev, ino)` pair a `ClaimGuard` compares against — a claim file's or, later, a socket's. */
export interface ClaimIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface LockHandle {
  readonly instanceId: string;
  isHeld(): boolean;
  /** Throws `ClaimLostError` (and fires every `onLost` callback) the moment the held identity no longer matches — including when the claim path has vanished entirely. */
  assertStillHeld(): void;
  onLost(callback: (error: ClaimLostError) => void): void;
  /** Unlinks the claim path, but only after confirming it still carries this guard's current identity; always closes the claim handle. Idempotent. */
  release(): void;
  /** Re-anchors the guard onto a freshly published claim file handle/identity (design C1 step 8 item 6). Closes the previously-held handle after the swap. */
  adoptIdentity(newHandle: ClaimFileHandle, newIdentity: ClaimIdentity): void;
}

export interface ClaimGuardOptions {
  readonly instanceId: string;
  readonly claimPath: string;
  readonly claimHandle: ClaimFileHandle;
  readonly claimIdentity: ClaimIdentity;
  readonly lockFileSystem: LockFileSystem;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function identityMatches(current: FileStat, expected: ClaimIdentity): boolean {
  return current.dev === expected.dev && current.ino === expected.ino;
}

export function createClaimGuard(options: ClaimGuardOptions): LockHandle {
  let claimHandle = options.claimHandle;
  let claimIdentity = options.claimIdentity;
  let held = true;
  const lostCallbacks: Array<(error: ClaimLostError) => void> = [];

  function fail(message: string): never {
    held = false;
    const error = new ClaimLostError(message);
    for (const callback of lostCallbacks) {
      callback(error);
    }
    throw error;
  }

  return {
    instanceId: options.instanceId,

    isHeld(): boolean {
      return held;
    },

    assertStillHeld(): void {
      if (!held) {
        fail(`the claim at ${options.claimPath} has already been released`);
      }
      let current: FileStat;
      try {
        current = options.lockFileSystem.lstat(options.claimPath);
      } catch (error) {
        if (isErrnoCode(error, "ENOENT")) {
          fail(`the claim record at ${options.claimPath} has been removed`);
        }
        throw error;
      }
      if (!identityMatches(current, claimIdentity)) {
        fail(
          `the claim record at ${options.claimPath} no longer matches the identity this process holds`,
        );
      }
    },

    onLost(callback: (error: ClaimLostError) => void): void {
      lostCallbacks.push(callback);
    },

    release(): void {
      if (!held) {
        return;
      }
      try {
        const current = options.lockFileSystem.lstat(options.claimPath);
        if (identityMatches(current, claimIdentity)) {
          options.lockFileSystem.unlink(options.claimPath);
        }
      } catch (error) {
        if (!isErrnoCode(error, "ENOENT")) {
          throw error;
        }
        // Already gone — nothing to unlink.
      }
      claimHandle.close();
      held = false;
    },

    adoptIdentity(newHandle: ClaimFileHandle, newIdentity: ClaimIdentity): void {
      const previousHandle = claimHandle;
      claimHandle = newHandle;
      claimIdentity = newIdentity;
      previousHandle.close();
    },
  };
}
