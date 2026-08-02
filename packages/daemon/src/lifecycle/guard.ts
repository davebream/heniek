/**
 * `ClaimGuard` — the `LockHandle` design C1 step 9 returns from
 * `acquireClaim` on the winning path (plan Task 2 Step 7).
 *
 * `assertStillHeld()` compares the identity captured when the claim file
 * handle was opened against `lockFileSystem.lstat(claimPath)` on
 * `(dev, ino)` — catching an unlink or replacement of the published record.
 *
 * **The guard's identity never changes** (plan round-2 override 3). It is
 * fixed at construction and holds for the process lifetime, because publish
 * rewrites the record's fixed-width `state` field in place through the held
 * fd rather than installing a new inode at the claim path.
 *
 * An earlier revision published by `rename`ing a temp file onto
 * `daemonPidFile` and then re-anchoring the guard onto the new inode
 * (`adoptIdentity`). That is why this file no longer has such a method: a
 * rename makes `fstat(claimFd).ino !== lstat(daemonPidFile).ino`
 * *permanently*, so `assertStillHeld()` — which runs on every accepted
 * connection — would kill the daemon on its first client. Re-anchoring
 * papered over it but left a window in which the guard vouched for an inode
 * the process no longer held. Writing in place removes the failure mode
 * rather than compensating for it.
 *
 * `release()` unlinks only after confirming the path still carries this
 * guard's identity, so a clean shutdown removes the published record
 * instead of either wrongly no-op'ing or wrongly refusing to unlink.
 *
 * Socket-identity comparison (design C1 step 9's second half — the
 * published record survives `unlink` of the socket path, so a same-uid
 * actor removing it and binding a new socket there must also be caught)
 * lands once `src/runtime/socket-server.ts` (Phase 5) gives this guard a
 * bound socket to compare against; this phase implements exactly the
 * six-method surface plan Task 2 Step 7 names — `instanceId`, `isHeld()`,
 * `assertStillHeld()`, `onLost(cb)`, `release()`, `publishState(state)` —
 * over the claim identity alone.
 */

import type { ClaimFileHandle, FileStat, LockFileSystem } from "../ports.js";
import {
  CLAIM_RECORD_VERSION,
  type ClaimState,
  claimStateFieldOffset,
  serialiseClaimState,
} from "./claim-record.js";
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
  /**
   * Rewrites the record's fixed-width `state` field in place through the held
   * fd, after re-confirming the claim (design C1 step 8). The claim identity is
   * unchanged by construction — that is the whole point of writing in place.
   */
  publishState(state: ClaimState): void;
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
  // Both are fixed for the guard's lifetime: publish rewrites the record
  // through this fd rather than installing a new inode, so the identity this
  // guard vouches for never changes.
  const claimHandle = options.claimHandle;
  const claimIdentity = options.claimIdentity;
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

  function assertStillHeld(): void {
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
  }

  return {
    instanceId: options.instanceId,

    isHeld(): boolean {
      return held;
    },

    assertStillHeld,

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

    publishState(state: ClaimState): void {
      assertStillHeld();
      claimHandle.writeAt(serialiseClaimState(state), claimStateFieldOffset(CLAIM_RECORD_VERSION));
      claimHandle.sync();
    },
  };
}
