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

describe("ClaimGuard.publishState — the in-place publish (design C1 step 8, plan round-2 override 3)", () => {
  function guardOver(fs: FakeLockFileSystem) {
    const { handle, identity } = claim(fs);
    return createClaimGuard({
      instanceId: "instance-1",
      claimPath: CLAIM_PATH,
      claimHandle: handle,
      claimIdentity: identity,
      lockFileSystem: fs,
    });
  }

  it("flips the state field to serving, leaving every other field and the length intact", () => {
    const fs = new FakeLockFileSystem();
    const guard = guardOver(fs);

    guard.publishState("serving");

    expect(fs.readFile(CLAIM_PATH, 1024)).toBe(
      "heniek-daemon\t1\tserving \t123\tboot-1\tinstance-1\n",
    );
  });

  it("keeps the claim identity — this is the regression that killed the daemon on its first client", () => {
    const fs = new FakeLockFileSystem();
    const guard = guardOver(fs);
    const before = fs.snapshot()[CLAIM_PATH];

    guard.publishState("serving");

    // A rename-based publish would install a different inode here, and every
    // later assertStillHeld() — one runs per accepted connection — would fail.
    expect(fs.snapshot()[CLAIM_PATH]?.ino).toBe(before?.ino);
    expect(() => guard.assertStillHeld()).not.toThrow();
    expect(guard.isHeld()).toBe(true);
  });

  it("never renames a new inode onto the claim path", () => {
    const fs = new FakeLockFileSystem();
    const guard = guardOver(fs);

    guard.publishState("serving");

    expect(fs.countOperations("rename")).toBe(0);
    expect(fs.countOperations("writeAt", "ok")).toBe(1);
  });

  it("flushes the record so a reader can never follow a published name to uncommitted bytes", () => {
    const fs = new FakeLockFileSystem();
    const guard = guardOver(fs);

    guard.publishState("serving");

    expect(fs.countOperations("sync", "ok")).toBe(1);
  });

  it("re-confirms the claim first, and refuses to write when it has been lost", () => {
    const fs = new FakeLockFileSystem();
    const guard = guardOver(fs);

    fs.unlink(CLAIM_PATH);

    expect(() => guard.publishState("serving")).toThrow(ClaimLostError);
    expect(fs.countOperations("writeAt")).toBe(0);
  });

  it("release() after publish still unlinks the record", () => {
    const fs = new FakeLockFileSystem();
    const guard = guardOver(fs);

    guard.publishState("serving");

    expect(fs.has(CLAIM_PATH)).toBe(true);
    guard.release();
    expect(fs.has(CLAIM_PATH)).toBe(false);
  });
});
