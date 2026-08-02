/**
 * Task 3.4 — `publishArtifact` (plan Phase 3, R4/S1/S2/S3 / design D3,
 * D14n). Every case here runs against the fake, fault-injectable
 * `ArtifactFileSystem` (`test/helpers/fake-artifact-file-system.ts`) so the
 * exact port-call sequence, the fd-balance, and each durability boundary's
 * failure behaviour can be asserted directly — a real-fs test could not
 * observe the ordering or inject a mid-sequence failure deterministically.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publishArtifact } from "../src/artifact/publish.js";
import { createArtifactStoreInternal } from "../src/artifact/store.js";
import {
  ArtifactDigestMismatchError,
  ArtifactQuarantinedError,
  ArtifactValidationError,
} from "../src/errors.js";
import { createDeterministicIds, createFakeClock } from "./helpers/determinism.js";
import { createFakeArtifactFileSystem } from "./helpers/fake-artifact-file-system.js";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeStore(root = "/store") {
  const fakeFs = createFakeArtifactFileSystem(1_000);
  const store = createArtifactStoreInternal(
    { root, clock: createFakeClock(), ids: createDeterministicIds(1) },
    fakeFs,
  );
  return { store, fakeFs };
}

describe("publishArtifact (Task 3.4, R4/D14n)", () => {
  it("computes the correct content hash, byte length and content-addressed relativePath", () => {
    const { store, fakeFs } = makeStore();
    const bytes = new TextEncoder().encode("the quick brown fox");
    const expectedHash = sha256Hex(bytes);

    const receipt = publishArtifact(store, { bytes });

    expect(receipt.contentHash).toBe(expectedHash);
    expect(receipt.relativePath).toBe(`blobs/sha256/${expectedHash}`);
    expect(receipt.byteLength).toBe(bytes.length);
    expect(receipt.artifactId).toBeTruthy();
    expect(fakeFs.fileExists(join(store.root, receipt.relativePath))).toBe(true);

    // The receipt's fd is the same fd the validated bytes were written
    // through (S1) — a positional read through it returns the same bytes.
    const readBack = new Uint8Array(bytes.length);
    fakeFs.readAt(receipt.fd, readBack, 0);
    expect(readBack).toEqual(bytes);
    fakeFs.close(receipt.fd);
  });

  it("uses link, never rename, to publish (D3) — the port has no rename method at all", () => {
    const { store, fakeFs } = makeStore();
    expect((fakeFs as unknown as Record<string, unknown>).rename).toBeUndefined();

    const receipt = publishArtifact(store, { bytes: new Uint8Array([1, 2, 3]) });
    const linkCalls = fakeFs.calls.filter((call) => call.method === "link");
    expect(linkCalls).toHaveLength(1);
    fakeFs.close(receipt.fd);
  });

  it("EEXIST idempotent adopt: republishing identical content adopts the existing blob", () => {
    const { store, fakeFs } = makeStore();
    const bytes = new TextEncoder().encode("duplicate content");

    const first = publishArtifact(store, { bytes });
    const second = publishArtifact(store, { bytes });

    expect(second.contentHash).toBe(first.contentHash);
    expect(second.relativePath).toBe(first.relativePath);
    expect(second.byteLength).toBe(first.byteLength);

    // Exactly one blob exists at the address — the adopt path never
    // overwrites it.
    expect(fakeFs.linkCountOf(join(store.root, first.relativePath))).toBeGreaterThanOrEqual(1);
    const blobEntries = fakeFs.readdir(store.blobsDir);
    expect(blobEntries).toEqual([first.contentHash]);

    fakeFs.close(first.fd);
    fakeFs.close(second.fd);
  });

  it("P1: receipt.adopted and fd mode are correct on both the normal-publish and the adopt path", () => {
    const { store, fakeFs } = makeStore();
    const bytes = new TextEncoder().encode("adopted flag content");

    const first = publishArtifact(store, { bytes });
    expect(first.adopted).toBe(false);
    // Normal-publish path: the receipt's fd is the same O_RDWR fd the bytes
    // were written through — a zero-length write through it must succeed
    // (proves the access mode without mutating the committed blob's bytes,
    // since it shares the linked blob's inode).
    expect(() => fakeFs.write(first.fd, new Uint8Array(0))).not.toThrow();
    fakeFs.close(first.fd);

    const second = publishArtifact(store, { bytes });
    expect(second.adopted).toBe(true);
    // Adopt path: the receipt's fd is an O_RDONLY re-open of the existing
    // blob — a write through it must fail EBADF, exactly as a real
    // O_RDONLY fd would.
    expect(() => fakeFs.write(second.fd, new Uint8Array(0))).toThrowError(
      expect.objectContaining({ code: "EBADF" }),
    );
    fakeFs.close(second.fd);
  });

  it("digest-mismatch quarantine: a corrupted committed blob is quarantined, never overwritten, and the address is not permanently poisoned", () => {
    const { store, fakeFs } = makeStore();
    const bytes = new TextEncoder().encode("original content");
    const first = publishArtifact(store, { bytes });
    fakeFs.close(first.fd);

    const finalPath = join(store.root, first.relativePath);
    fakeFs.corruptFile(finalPath, new TextEncoder().encode("TAMPERED BYTES, WRONG DIGEST"));

    // Republishing the same original content hits the corrupted address via
    // EEXIST, detects the mismatch, quarantines the corrupted blob, and
    // retries — succeeding, because quarantine vacates the address rather
    // than poisoning it permanently.
    const retry = publishArtifact(store, { bytes });
    expect(retry.contentHash).toBe(first.contentHash);
    expect(retry.relativePath).toBe(first.relativePath);

    const readBack = new Uint8Array(bytes.length);
    fakeFs.readAt(retry.fd, readBack, 0);
    expect(readBack).toEqual(bytes);
    fakeFs.close(retry.fd);

    // The corrupted blob is preserved in quarantine/ as an audit trail, never unlinked.
    const quarantineEntries = fakeFs.readdir(join(store.root, "quarantine"));
    expect(quarantineEntries).toHaveLength(1);
    expect(fakeFs.readFile(join(store.root, "quarantine", quarantineEntries[0] as string))).toEqual(
      new TextEncoder().encode("TAMPERED BYTES, WRONG DIGEST"),
    );
  });

  it("caller-supplied contentHash disagreement is refused (D8)", () => {
    const { store } = makeStore();
    const bytes = new TextEncoder().encode("some content");
    const wrongHash = "0".repeat(64);

    expect(() => publishArtifact(store, { bytes, expectedContentHash: wrongHash })).toThrowError(
      ArtifactDigestMismatchError,
    );

    try {
      publishArtifact(store, { bytes, expectedContentHash: wrongHash });
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactDigestMismatchError);
      const mismatch = error as ArtifactDigestMismatchError;
      expect(mismatch.expectedHash).toBe(wrongHash);
      expect(mismatch.actualHash).toBe(sha256Hex(bytes));
    }
  });

  it("a matching caller-supplied contentHash is accepted", () => {
    const { store } = makeStore();
    const bytes = new TextEncoder().encode("some content");
    const receipt = publishArtifact(store, { bytes, expectedContentHash: sha256Hex(bytes) });
    expect(receipt.contentHash).toBe(sha256Hex(bytes));
  });

  it("temp is left in place when write fails — never removed on that failure path", () => {
    const { store, fakeFs } = makeStore();
    fakeFs.armFaultAfter("write", Object.assign(new Error("EIO"), { code: "EIO" }));

    expect(() => publishArtifact(store, { bytes: new Uint8Array([1]) })).toThrowError(
      ArtifactValidationError,
    );

    const incomingEntries = fakeFs.readdir(store.incomingDir);
    expect(incomingEntries).toHaveLength(1);
  });

  it("temp is left in place when fsync fails — never removed on that failure path", () => {
    const { store, fakeFs } = makeStore();
    fakeFs.armFaultAfter("fsync", Object.assign(new Error("EIO"), { code: "EIO" }));

    expect(() => publishArtifact(store, { bytes: new Uint8Array([1]) })).toThrowError(
      ArtifactValidationError,
    );

    const incomingEntries = fakeFs.readdir(store.incomingDir);
    expect(incomingEntries).toHaveLength(1);
  });

  it("temp is removed only after the blobs directory fsync succeeds, on the success path", () => {
    const { store, fakeFs } = makeStore();
    const receipt = publishArtifact(store, { bytes: new Uint8Array([7, 8, 9]) });
    expect(fakeFs.readdir(store.incomingDir)).toHaveLength(0);
    fakeFs.close(receipt.fd);
  });

  it("R4 ordering: link precedes the blobs-directory fsync, which precedes unlink of the temp", () => {
    const { store, fakeFs } = makeStore();
    const receipt = publishArtifact(store, { bytes: new Uint8Array([4, 5, 6]) });

    const methodOrder = fakeFs.calls.map((call) => call.method);
    const linkIndex = methodOrder.indexOf("link");
    const lastFsyncIndex = methodOrder.lastIndexOf("fsync");
    const unlinkIndex = methodOrder.indexOf("unlink");

    expect(linkIndex).toBeGreaterThanOrEqual(0);
    expect(lastFsyncIndex).toBeGreaterThan(linkIndex);
    expect(unlinkIndex).toBeGreaterThan(lastFsyncIndex);

    // P5 (post-Phase-3 adversarial review, fix cycle 1): the previous
    // version of this test only compared call *indices* — it never checked
    // that the final fsync's *target* is the blobs-directory fd, which is
    // the actual durability guarantee for the link. Deleting the directory
    // fsync entirely would still satisfy the index-only assertions above
    // (the temp's own post-link fsync would become the "last" fsync).
    const blobsDirFd = fakeFs.lastFdOf("openDirectoryReadOnly");
    const fsyncCalls = fakeFs.calls.filter((call) => call.method === "fsync");
    const lastFsyncCall = fsyncCalls[fsyncCalls.length - 1];
    expect(lastFsyncCall?.args[0]).toBe(blobsDirFd);

    fakeFs.close(receipt.fd);
  });

  it("fd-balance: every open* call has a matching close call once the receipt's own fd is closed", () => {
    const { store, fakeFs } = makeStore();
    const receipt = publishArtifact(store, { bytes: new Uint8Array([1, 2]) });
    fakeFs.close(receipt.fd);

    const opens = fakeFs.calls.filter(
      (call) =>
        call.method === "openExclusive" ||
        call.method === "openReadOnly" ||
        call.method === "openDirectoryReadOnly",
    ).length;
    const closes = fakeFs.calls.filter((call) => call.method === "close").length;
    expect(closes).toBe(opens);
  });

  it("throws ArtifactQuarantinedError only if the quarantine retry itself fails to vacate the address", () => {
    const { store, fakeFs } = makeStore();
    const bytes = new TextEncoder().encode("content whose retry will also collide");
    const first = publishArtifact(store, { bytes });
    fakeFs.close(first.fd);

    const finalPath = join(store.root, first.relativePath);
    fakeFs.corruptFile(finalPath, new TextEncoder().encode("still wrong"));

    // `link` occurrence 1 was this test's first (uncontested) publish.
    // The second publishArtifact call's quarantine-and-retry sequence then
    // issues three more `link` calls: occurrence 2 is the initial attempt,
    // which hits the real EEXIST from the corrupted blob already occupying
    // the address; occurrence 3 is the audit-trail link into quarantine/;
    // occurrence 4 is the retry, after the corrupted blob is unlinked from
    // its original address. Only forcing occurrence 4 to also fail with
    // EEXIST exercises "the retry itself fails to vacate the address" —
    // the normal quarantine case (covered above) never reaches this branch.
    fakeFs.armFaultAtOccurrence(
      "link",
      4,
      "after",
      Object.assign(new Error("EEXIST"), { code: "EEXIST" }),
    );

    expect(() => publishArtifact(store, { bytes })).toThrowError(ArtifactQuarantinedError);
  });

  it("P2: existingFd is closed even when the adopt path's re-hash itself fails", () => {
    const { store, fakeFs } = makeStore();
    const bytes = new TextEncoder().encode("adopt re-hash failure content");

    const first = publishArtifact(store, { bytes });
    fakeFs.close(first.fd);

    // Each publishArtifact call's own temp-file validation
    // (hashAndValidate("write")) issues exactly two `fstat` calls (before
    // the readAt loop, and after). The first publish call above consumed
    // occurrences 1-2. The second call below consumes occurrences 3-4 for
    // its own temp validation, then hits EEXIST and enters the adopt path's
    // re-hash (hashAndValidate("link")), whose first `fstat` call is
    // occurrence 5 — targeting it "before" fires right after
    // `openReadOnly` has already produced `existingFd`, guaranteeing
    // `existingFd` is open at the moment of failure.
    fakeFs.armFaultAtOccurrence(
      "fstat",
      5,
      "before",
      Object.assign(new Error("EIO"), { code: "EIO" }),
    );

    expect(() => publishArtifact(store, { bytes })).toThrowError(ArtifactValidationError);

    const opens = fakeFs.calls.filter(
      (call) =>
        call.method === "openExclusive" ||
        call.method === "openReadOnly" ||
        call.method === "openDirectoryReadOnly",
    ).length;
    const closes = fakeFs.calls.filter((call) => call.method === "close").length;
    // Previously this was opens - 1 (existingFd leaked) — the existing
    // fd-balance test above only ever ran the happy path, which never
    // exercises this failure branch.
    expect(closes).toBe(opens);
  });

  it("P3: no ArtifactValidationError raised during publication ever names the store root", () => {
    const ROOT = "/store-with-a-root-that-must-never-leak";
    const eio = () => Object.assign(new Error("EIO"), { code: "EIO" });

    function expectNoRootLeak(
      triggerFailure: (fakeFs: ReturnType<typeof makeStore>["fakeFs"]) => void,
    ) {
      const { store, fakeFs } = makeStore(ROOT);
      triggerFailure(fakeFs);
      try {
        publishArtifact(store, { bytes: new TextEncoder().encode("root leak check content") });
        throw new Error("unreachable");
      } catch (error) {
        expect(error).toBeInstanceOf(ArtifactValidationError);
        const validationError = error as ArtifactValidationError;
        expect(validationError.relativePath).not.toContain(ROOT);
        expect(validationError.message).not.toContain(ROOT);
      }
    }

    // openTempExclusive's own two throw sites (publish.ts:76/81).
    expectNoRootLeak((fakeFs) => fakeFs.armFaultBefore("openExclusive", eio()));
    // writeAll (publish.ts:89).
    expectNoRootLeak((fakeFs) => fakeFs.armFaultAfter("write", eio()));
    // fsyncFile, reused by the first fsync boundary (publish.ts:98).
    expectNoRootLeak((fakeFs) => fakeFs.armFaultAfter("fsync", eio()));

    // The adopt path's own re-hash validation (hashAndValidate's "link"
    // call site, publish.ts:217→141) — the fifth site. Needs an
    // already-committed blob first, then the second publish's adopt-path
    // re-hash to fail; occurrence 5 is that re-hash's first `fstat` call
    // (see the P2 test above for the full occurrence-counting rationale).
    {
      const { store, fakeFs } = makeStore(ROOT);
      const bytes = new TextEncoder().encode("root leak adopt-path content");
      const first = publishArtifact(store, { bytes });
      fakeFs.close(first.fd);
      fakeFs.armFaultAtOccurrence("fstat", 5, "before", eio());
      try {
        publishArtifact(store, { bytes });
        throw new Error("unreachable");
      } catch (error) {
        expect(error).toBeInstanceOf(ArtifactValidationError);
        const validationError = error as ArtifactValidationError;
        expect(validationError.relativePath).not.toContain(ROOT);
        expect(validationError.message).not.toContain(ROOT);
      }
    }
  });

  it("P4: fchmod, the blobs-directory opener, and the quarantine mkdir surface as ArtifactValidationError, not a raw errno", () => {
    const eio = () => Object.assign(new Error("EIO"), { code: "EIO" });

    {
      const { store, fakeFs } = makeStore();
      fakeFs.armFaultBefore("fchmod", eio());
      expect(() => publishArtifact(store, { bytes: new Uint8Array([1]) })).toThrowError(
        ArtifactValidationError,
      );
    }

    {
      const { store, fakeFs } = makeStore();
      fakeFs.armFaultBefore("openDirectoryReadOnly", eio());
      expect(() => publishArtifact(store, { bytes: new Uint8Array([2]) })).toThrowError(
        ArtifactValidationError,
      );
    }

    {
      // The quarantine mkdir is only reachable via digest-mismatch adopt —
      // set that scenario up first, exactly as the existing quarantine
      // tests above do.
      const { store, fakeFs } = makeStore();
      const bytes = new TextEncoder().encode("quarantine mkdir fault content");
      const first = publishArtifact(store, { bytes });
      fakeFs.close(first.fd);
      const finalPath = join(store.root, first.relativePath);
      fakeFs.corruptFile(finalPath, new TextEncoder().encode("wrong digest bytes"));

      // Store construction issues two `mkdir` calls (incoming/, blobs/sha256/);
      // the quarantine-and-retry path's own `mkdir(quarantine/)` is the third.
      fakeFs.armFaultAtOccurrence("mkdir", 3, "before", eio());

      expect(() => publishArtifact(store, { bytes })).toThrowError(ArtifactValidationError);
    }
  });
});
