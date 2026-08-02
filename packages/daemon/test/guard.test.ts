/**
 * `ClaimGuard` / `LockHandle` (design C1 step 9, plan Task 2 Step 7).
 */

import { describe, expect, it } from "vitest";
import { ClaimLostError } from "../src/lifecycle/errors.js";
import { type ClaimIdentity, createClaimGuard } from "../src/lifecycle/guard.js";
import { FakeLockFileSystem } from "./helpers/fake-lock-filesystem.js";

const CLAIM_PATH = "/run/heniek/daemon.pid";

function claim(fs: FakeLockFileSystem) {
  const handle = fs.createExclusive(CLAIM_PATH, 0o600);
  handle.write("heniek-daemon\t1\tclaiming\t123\tboot-1\tinstance-1\n");
  const stat = handle.stat();
  const identity: ClaimIdentity = { dev: stat.dev, ino: stat.ino };
  return { handle, identity };
}

describe("ClaimGuard — basic identity comparison", () => {
  it("isHeld() is true and assertStillHeld() passes right after construction", () => {
    const fs = new FakeLockFileSystem();
    const { handle, identity } = claim(fs);
    const guard = createClaimGuard({
      instanceId: "instance-1",
      claimPath: CLAIM_PATH,
      claimHandle: handle,
      claimIdentity: identity,
      lockFileSystem: fs,
    });

    expect(guard.isHeld()).toBe(true);
    expect(() => guard.assertStillHeld()).not.toThrow();
  });

  it("assertStillHeld() throws ClaimLostError and fires onLost when the claim path is unlinked out from under it", () => {
    const fs = new FakeLockFileSystem();
    const { handle, identity } = claim(fs);
    const guard = createClaimGuard({
      instanceId: "instance-1",
      claimPath: CLAIM_PATH,
      claimHandle: handle,
      claimIdentity: identity,
      lockFileSystem: fs,
    });

    let lostError: ClaimLostError | undefined;
    guard.onLost((error) => {
      lostError = error;
    });

    fs.unlink(CLAIM_PATH);

    expect(() => guard.assertStillHeld()).toThrow(ClaimLostError);
    expect(lostError).toBeInstanceOf(ClaimLostError);
    expect(guard.isHeld()).toBe(false);
  });

  it("assertStillHeld() throws when a different inode now occupies the claim path (replacement, not just unlink)", () => {
    const fs = new FakeLockFileSystem();
    const { handle, identity } = claim(fs);
    const guard = createClaimGuard({
      instanceId: "instance-1",
      claimPath: CLAIM_PATH,
      claimHandle: handle,
      claimIdentity: identity,
      lockFileSystem: fs,
    });

    fs.unlink(CLAIM_PATH);
    fs.seedRegularFile(CLAIM_PATH, "someone else's content");

    expect(() => guard.assertStillHeld()).toThrow(ClaimLostError);
  });

  it("release() unlinks the claim path only after confirming the identity match, and closes the handle", () => {
    const fs = new FakeLockFileSystem();
    const { handle, identity } = claim(fs);
    const guard = createClaimGuard({
      instanceId: "instance-1",
      claimPath: CLAIM_PATH,
      claimHandle: handle,
      claimIdentity: identity,
      lockFileSystem: fs,
    });

    guard.release();

    expect(fs.has(CLAIM_PATH)).toBe(false);
    expect(guard.isHeld()).toBe(false);
    // Idempotent — a second release() call is a safe no-op, never throws.
    expect(() => guard.release()).not.toThrow();
  });

  it("release() does not unlink a path that no longer carries this guard's identity", () => {
    const fs = new FakeLockFileSystem();
    const { handle, identity } = claim(fs);
    const guard = createClaimGuard({
      instanceId: "instance-1",
      claimPath: CLAIM_PATH,
      claimHandle: handle,
      claimIdentity: identity,
      lockFileSystem: fs,
    });

    fs.unlink(CLAIM_PATH);
    fs.seedRegularFile(CLAIM_PATH, "a successor's own claim");

    guard.release();

    // The successor's claim survives — release() refused to touch an
    // identity it does not recognise.
    expect(fs.has(CLAIM_PATH)).toBe(true);
  });
});

describe("ClaimGuard.adoptIdentity — the publish re-anchor (design C1 step 8 item 6, plan finding C2)", () => {
  function publish(fs: FakeLockFileSystem) {
    const tempPath = "/run/heniek/.daemon.pid.abc123";
    const tempHandle = fs.createExclusive(tempPath, 0o600);
    tempHandle.write("heniek-daemon\t1\tserving\t123\tboot-1\tinstance-1\n");
    const tempStat = tempHandle.stat();
    const newIdentity: ClaimIdentity = { dev: tempStat.dev, ino: tempStat.ino };
    fs.rename(tempPath, CLAIM_PATH);
    return { tempHandle, newIdentity };
  }

  it("without adoptIdentity, a publish-by-rename makes assertStillHeld() fail (the inode it pins is now stale)", () => {
    const fs = new FakeLockFileSystem();
    const { handle, identity } = claim(fs);
    const guard = createClaimGuard({
      instanceId: "instance-1",
      claimPath: CLAIM_PATH,
      claimHandle: handle,
      claimIdentity: identity,
      lockFileSystem: fs,
    });

    publish(fs);

    // `claimIdentity` still pins the original `claiming` inode; `rename`
    // installed a different one at `CLAIM_PATH` — exactly the failure mode
    // `adoptIdentity` exists to fix.
    expect(() => guard.assertStillHeld()).toThrow(ClaimLostError);
  });

  it("assertStillHeld() passes immediately after adoptIdentity re-anchors the guard", () => {
    const fs = new FakeLockFileSystem();
    const { handle, identity } = claim(fs);
    const guard = createClaimGuard({
      instanceId: "instance-1",
      claimPath: CLAIM_PATH,
      claimHandle: handle,
      claimIdentity: identity,
      lockFileSystem: fs,
    });

    const { tempHandle, newIdentity } = publish(fs);
    guard.adoptIdentity(tempHandle, newIdentity);

    expect(() => guard.assertStillHeld()).not.toThrow();
    expect(guard.isHeld()).toBe(true);
  });

  it("release() after adoptIdentity actually unlinks the current (post-publish) path", () => {
    const fs = new FakeLockFileSystem();
    const { handle, identity } = claim(fs);
    const guard = createClaimGuard({
      instanceId: "instance-1",
      claimPath: CLAIM_PATH,
      claimHandle: handle,
      claimIdentity: identity,
      lockFileSystem: fs,
    });

    const { tempHandle, newIdentity } = publish(fs);
    guard.adoptIdentity(tempHandle, newIdentity);

    expect(fs.has(CLAIM_PATH)).toBe(true);
    guard.release();
    expect(fs.has(CLAIM_PATH)).toBe(false);
  });

  it("closes the previously-held handle only after the swap, never before", () => {
    const fs = new FakeLockFileSystem();
    const { handle, identity } = claim(fs);
    const guard = createClaimGuard({
      instanceId: "instance-1",
      claimPath: CLAIM_PATH,
      claimHandle: handle,
      claimIdentity: identity,
      lockFileSystem: fs,
    });

    const before = fs.countOperations("close");
    const { tempHandle, newIdentity } = publish(fs);
    guard.adoptIdentity(tempHandle, newIdentity);
    const after = fs.countOperations("close");

    expect(after).toBe(before + 1);
  });
});
