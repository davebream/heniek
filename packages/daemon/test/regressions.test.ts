/**
 * Named regression tests for defects found while implementing Q008 (OR-18).
 *
 * This file exists from the first phase that can find a defect, not from the
 * last: a defect surfaced in the claim, RPC, or reconciliation cores needs a
 * home the moment it is found, and a file created at the end of the issue
 * would have had none.
 *
 * House rule, mirroring `packages/state`: one `it` per real defect, named for
 * the defect and not for the fix, and written so it fails against the code as
 * it was when the defect existed. A test that would also pass against the
 * broken code is not a regression test.
 */

import { describe, expect, it } from "vitest";
import { parseClaimRecord, serialiseClaimRecord } from "../src/lifecycle/claim-record.js";
import { FakeLockFileSystem } from "./helpers/fake-lock-filesystem.js";

describe("Q008 regressions", () => {
  it("the lock-filesystem fake implements every ClaimFileHandle method, including writeAt and sync", () => {
    // Defect: `ClaimFileHandle` gained positional `writeAt` and `sync` when
    // the publish step moved to an in-place state flip, but
    // `FakeClaimFileHandle` was not extended to match. `FakeLockFileSystem`
    // silently stopped satisfying `LockFileSystem`, and `tsc --noEmit`
    // reported eight assignability errors across the guard tests. The
    // structural check below fails against the pre-fix fake.
    const fs = new FakeLockFileSystem({ currentUid: 1000 });
    fs.seedDirectory("/rt", { uid: 1000, mode: 0o700 });
    const handle = fs.createExclusive("/rt/daemon.pid", 0o600);

    expect(typeof handle.write).toBe("function");
    expect(typeof handle.writeAt).toBe("function");
    expect(typeof handle.sync).toBe("function");
    expect(typeof handle.stat).toBe("function");
    expect(typeof handle.close).toBe("function");
  });

  it("writeAt is positional and refuses to extend the record", () => {
    // Corollary of the same defect: a `writeAt` that appended would let the
    // claim line grow past the closed grammar's fixed field layout, so the
    // in-place `claiming → serving` flip could silently produce a record no
    // parser accepts. Refusing to extend turns that into an immediate error.
    const fs = new FakeLockFileSystem({ currentUid: 1000 });
    fs.seedDirectory("/rt", { uid: 1000, mode: 0o700 });
    const handle = fs.createExclusive("/rt/daemon.pid", 0o600);
    handle.write(
      serialiseClaimRecord({
        recordVersion: 1,
        state: "claiming",
        pid: 4242,
        bootWitness: "boot-a",
        instanceId: "deadbeefdeadbeefdeadbeefdeadbeef",
      }),
    );

    expect(() => handle.writeAt("x", 10_000)).toThrow();

    const parsed = parseClaimRecord(fs.readFile("/rt/daemon.pid", 1024));
    expect(parsed.kind).toBe("well-formed");
  });
});
