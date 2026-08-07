/**
 * Semantics of the `FakeClaimFileHandle` positional-write surface.
 *
 * The publish path (design C1 step 8 / row R) rewrites the fixed-width `state`
 * field in place rather than `rename`ing a temp file over the claim, because a
 * rename would install a new inode and destroy the claim identity the guard
 * relies on. No production caller exists yet — that lands with the lifecycle
 * state machine — so these tests pin the fake's contract now, while the
 * behaviour is cheap to state, rather than letting a later phase build on an
 * unexercised test double.
 */

import { describe, expect, it } from "vitest";
import { FakeLockFileSystem } from "./fake-lock-filesystem.js";

const CLAIM = "/run/heniek/daemon.claim";

/** A handle over a claim whose content is `seed`. */
function handleOver(seed: string) {
  const fs = new FakeLockFileSystem();
  const handle = fs.createExclusive(CLAIM, 0o600);
  handle.write(seed);
  return { fs, handle };
}

describe("FakeClaimFileHandle.writeAt", () => {
  it("rewrites a fixed-width field in place without changing length", () => {
    const { fs, handle } = handleOver("heniek-daemon\t1\tclaiming\t4242\n");

    handle.writeAt("ready   ", "heniek-daemon\t1\t".length);

    expect(fs.readFile(CLAIM, 1024)).toBe("heniek-daemon\t1\tready   \t4242\n");
  });

  it("refuses a write that would extend the file, and leaves content untouched", () => {
    const { fs, handle } = handleOver("abcd");

    expect(() => handle.writeAt("xyz", 2)).toThrow(expect.objectContaining({ code: "EFBIG" }));
    expect(fs.readFile(CLAIM, 1024)).toBe("abcd");
  });

  it("allows a write that ends exactly at the last byte", () => {
    const { fs, handle } = handleOver("abcd");

    handle.writeAt("xy", 2);

    expect(fs.readFile(CLAIM, 1024)).toBe("abxy");
  });

  it("refuses a negative offset", () => {
    const { handle } = handleOver("abcd");

    expect(() => handle.writeAt("x", -1)).toThrow(expect.objectContaining({ code: "EFBIG" }));
  });

  it("measures offset and length in bytes, not UTF-16 code units", () => {
    // "é" is two UTF-8 bytes, so only two bytes remain after it in a 4-byte file.
    const { fs, handle } = handleOver("éab");

    handle.writeAt("xy", 2);

    expect(fs.readFile(CLAIM, 1024)).toBe("éxy");
  });

  it("records the operation so a test can count in-place publishes", () => {
    const { fs, handle } = handleOver("abcd");

    handle.writeAt("x", 0);
    expect(fs.countOperations("writeAt", "ok")).toBe(1);

    expect(() => handle.writeAt("toolong", 0)).toThrow();
    expect(fs.countOperations("writeAt", "EFBIG")).toBe(1);
  });
});

describe("FakeClaimFileHandle.sync", () => {
  it("records the call — the fake has no page cache to flush", () => {
    const { fs, handle } = handleOver("abcd");

    handle.sync();

    expect(fs.countOperations("sync", "ok")).toBe(1);
    expect(fs.readFile(CLAIM, 1024)).toBe("abcd");
  });
});

describe("FakeClaimFileHandle after close", () => {
  it("rejects writeAt and sync on a closed handle", () => {
    const { handle } = handleOver("abcd");

    handle.close();

    expect(() => handle.writeAt("x", 0)).toThrow(/closed claim handle/);
    expect(() => handle.sync()).toThrow(/closed claim handle/);
  });
});
